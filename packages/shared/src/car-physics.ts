/**
 * Shared arcade car controller (spec 6.2).
 *
 * Pure function of (car view, input, config, dt, clock). The host supplies a
 * `CarBodyView` (a Rapier rigid body plus a raycast against that host's own
 * physics world), so the identical code runs authoritatively on the server
 * and locally on the client for prediction (spec 5.3).
 *
 * Pipeline per step (fixed order — order IS the algorithm):
 *   1. probe the surface under the car (ray along the car's -up axis)
 *   2. resolve the physics mode (ground | hover | grip | boost)
 *   3. apply world-space velocity corrections:
 *        - pin spring holding the target clearance above the surface
 *        - hover lift toward the hover height
 *        - gravity (world −Y); on a surface the normal component is removed,
 *          so cars slide tangentially without sinking into it
 *        - inward-velocity guard so nothing sinks through
 *   4. transform velocity into the car basis (forward / right / up) and apply
 *      mode control: throttle, lateral tyre grip, steering yaw
 *   5. boost burst, speed clamps, gas meter, soft arena boundary
 *   6. write velocity back; rotation:
 *        - on a surface: yaw heading + slerp-align to the surface normal
 *        - in the air: pitch/roll/yaw set the angular velocity; Rapier
 *          integrates it (flips and the automatic barrel roll)
 *
 * No clock reads, no randomness, no I/O: deterministic given equal inputs,
 * which is what prediction replay (spec 5.3) requires.
 */

import type { CarSim, CarBodyView, DriveInput, CarMode } from "./types.js";
import type { GameplayConfig } from "./config.js";

type Vec = { x: number; y: number; z: number };
type Quat = { x: number; y: number; z: number; w: number };

export interface RayResult {
  hit: boolean;
  distance: number;
  normal: Vec;
  /** normal of a second, farther look-ahead ray (grip probing only) */
  aheadNormal?: Vec;
}

/* ---------------------------------- math --------------------------------- */

export function quatMul(q: Quat, r: Quat): Quat {
  return {
    x: q.w * r.x + q.x * r.w + q.y * r.z - q.z * r.y,
    y: q.w * r.y - q.x * r.z + q.y * r.w + q.z * r.x,
    z: q.w * r.z + q.x * r.y - q.y * r.x + q.z * r.w,
    w: q.w * r.w - q.x * r.x - q.y * r.y - q.z * r.z,
  };
}

export function quatRotateAxis(axis: Vec, angle: number): Quat {
  const l = Math.hypot(axis.x, axis.y, axis.z) || 1;
  const s = Math.sin(angle / 2);
  return { x: (axis.x / l) * s, y: (axis.y / l) * s, z: (axis.z / l) * s, w: Math.cos(angle / 2) };
}

export function quatNormalise(q: Quat): Quat {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

/** Rotate a vector by a quaternion (v' = q · v · q*). */
export function rotateVec(q: Quat, v: Vec): Vec {
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const tx = 2 * (qy * v.z - qz * v.y);
  const ty = 2 * (qz * v.x - qx * v.z);
  const tz = 2 * (qx * v.y - qy * v.x);
  return {
    x: v.x + qw * tx + (qy * tz - qz * ty),
    y: v.y + qw * ty + (qz * tx - qx * tz),
    z: v.z + qw * tz + (qx * ty - qy * tx),
  };
}

const cross = (a: Vec, b: Vec): Vec => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function normVec(v: Vec): Vec {
  const l = Math.hypot(v.x, v.y, v.z);
  if (l < 1e-9) return { x: 0, y: 0, z: 0 };
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/** Build a quaternion whose local axes are (right, up, forward). */
export function basisToQuat(right: Vec, up: Vec, forward: Vec): Quat {
  const r = right, u = up, f = forward;
  const m00 = r.x, m01 = u.x, m02 = f.x;
  const m10 = r.y, m11 = u.y, m12 = f.y;
  const m20 = r.z, m21 = u.z, m22 = f.z;
  const trace = m00 + m11 + m22;
  let x = 0,
    y = 0,
    z = 0,
    w = 1;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m12 - m21) / s;
    y = (m20 - m02) / s;
    z = (m01 - m10) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m12 - m21) / s;
    x = 0.25 * s;
    y = (m10 + m01) / s;
    z = (m20 + m02) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m20 - m02) / s;
    x = (m10 + m01) / s;
    y = 0.25 * s;
    z = (m21 + m12) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m01 - m10) / s;
    x = (m20 + m02) / s;
    y = (m21 + m12) / s;
    z = 0.25 * s;
  }
  return quatNormalise({ x, y, z, w });
}

/** Shortest-path quaternion slerp; `t` in [0,1]. */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (d < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
    d = -d;
  }
  if (d > 0.9995) {
    return quatNormalise({
      x: a.x + (bx - a.x) * t,
      y: a.y + (by - a.y) * t,
      z: a.z + (bz - a.z) * t,
      w: a.w + (bw - a.w) * t,
    });
  }
  const theta = Math.acos(clamp(d, -1, 1));
  const sinT = Math.sin(theta) || 1;
  const wa = Math.sin((1 - t) * theta) / sinT;
  const wb = Math.sin(t * theta) / sinT;
  return {
    x: a.x * wa + bx * wb,
    y: a.y * wa + by * wb,
    z: a.z * wa + bz * wb,
    w: a.w * wa + bw * wb,
  };
}

/** Ray down the car's −up axis; returns distance and surface normal.
 *  `ahead` shifts the ray origin forward along the car's fwd past the nose
 *  and `tall` raises it by `tall` metres along −dir, both compensated out of
 *  the reported distance — so the probe reads the surface profile that is
 *  still ahead of the centre instead of reacting after the body hits it. */
function probeSurface(
  body: CarBodyView,
  maxDist: number,
  ahead = 0,
  tall = 0,
): RayResult {
  const p = body.translation;
  const rot = body.rotation;
  const up = rotateVec(rot, { x: 0, y: 1, z: 0 });
  const fwd = rotateVec(rot, { x: 0, y: 0, z: 1 });
  const dir = { x: -up.x, y: -up.y, z: -up.z };
  const origin = {
    x: p.x + fwd.x * ahead + up.x * tall,
    y: p.y + fwd.y * ahead + up.y * tall,
    z: p.z + fwd.z * ahead + up.z * tall,
  };
  const hit = body.raycast(origin, dir, maxDist + tall);
  if (!hit || !hit.hit) {
    return { hit: false, distance: Infinity, normal: { x: 0, y: 1, z: 0 } };
  }
  const n = hit.normal;
  const hasNormal = Math.abs(n.x) + Math.abs(n.y) + Math.abs(n.z) > 1e-6;
  // Column distance: the hit must lie within the car's −up column (plus the
  // deliberate look-ahead lean), not just anywhere the leaned ray lands. On
  // curved venues the tall ray used to latch wall segments 4–6 m ahead that
  // were NEVER beneath the car — those fed false distances to the servos and
  // formed the mid-air parking attractors.
  // Column distance: the hit must lie within the car's −up column (plus the
  // deliberate look-ahead lean), not just anywhere the leaned ray lands. On
  // curved venues the tall ray used to latch wall segments 4–6 m ahead that
  // were NEVER beneath the car — those fed false distances to the servos and
  // formed the mid-air parking attractors.
  const hitPoint = {
    x: origin.x + dir.x * hit.toi,
    y: origin.y + dir.y * hit.toi,
    z: origin.z + dir.z * hit.toi,
  };
  const wAhead = (hitPoint.x - p.x) * fwd.x + (hitPoint.y - p.y) * fwd.y + (hitPoint.z - p.z) * fwd.z;
  if (wAhead > ahead + 1.5) {
    return { hit: false, distance: Infinity, normal: { x: 0, y: 1, z: 0 } };
  }
  const faceDot = hasNormal ? n.x * up.x + n.y * up.y + n.z * up.z : 1;
  if (faceDot < 0.25) return { hit: false, distance: Infinity, normal: { x: 0, y: 1, z: 0 } };
  const result: RayResult = {
    hit: true,
    distance: Math.max(0.02, hit.toi - tall),
    normal: hasNormal ? normVec({ ...n }) : { x: up.x, y: up.y, z: up.z },
  };
  // reference look-ahead (grip probe only): where the surface will be in a
  // few metres — its normal relative to the first tells the grip controller
  // whether a hard curve is coming (loop entry). Same face-cone keeps the
  // look-ahead sane.
  if (maxDist >= 6 && ahead > 0) {
    const o2 = {
      x: p.x + fwd.x * (ahead + 4.2) + up.x * tall,
      y: p.y + fwd.y * (ahead + 4.2) + up.y * tall,
      z: p.z + fwd.z * (ahead + 4.2) + up.z * tall,
    };
    const h2 = body.raycast(o2, dir, maxDist + tall + 4.2);
    if (h2 && h2.hit) {
      const n2 = normVec({ ...h2.normal });
      if (n2.x * up.x + n2.y * up.y + n2.z * up.z >= 0.25) result.aheadNormal = n2;
    }
  }
  return result;
}

export interface StepContext {
  cfg: GameplayConfig;
  dt: number;
  /** authoritative clock (server time on the server, local clock on client) */
  nowMs: number;
}

/** Distance from body centre to the driving clearance target (car box half
 *  height is 0.55 → resting gap ≈ 0.62 m keeps tyres visually on the ground). */
export const CAR_TARGET_CLEARANCE = 0.62;
/** Ray/search range when grip is held (can latch onto walls and ceilings). */
export const GRIP_RANGE = 5.2;

/**
 * Advance one car by one physics step. Returns the resolved mode
 * (also stored on `sim.mode`).
 */
export function stepCar(
  sim: CarSim,
  input: DriveInput,
  ctx: StepContext,
): CarMode {
  const body = sim.body;
  const { dt, nowMs } = ctx;
  const ph = ctx.cfg.physics;

  // ---------- 1. read state -------------------------------------------------
  const p = body.translation;
  const v: Vec = { ...body.linvel };
  let q: Quat = quatNormalise({ ...body.rotation });

  // input shaping (digital throttle, dead-zoned analog sticks)
  const throttle: -1 | 0 | 1 = input.throttle > 0.06 ? 1 : input.throttle < -0.06 ? -1 : 0;
  const active = (x: number) => (Math.abs(x) >= 0.06 ? clamp(x, -1, 1) : 0);
  const steer = active(input.steer);
  const pitch = active(input.pitch);
  const rollRaw = active(input.roll);

  const f0 = rotateVec(q, { x: 0, y: 0, z: 1 });
  const u0 = rotateVec(q, { x: 0, y: 1, z: 0 });

  // ---------- 2. barrel-roll tap detection (spec 6.2) ------------------------
  const rollingNow = sim.rollUntilMs > nowMs;
  if (rollRaw !== 0 && sim.lastRollInput === 0 && !rollingNow) {
    sim.rollUntilMs = nowMs + 600;
    sim.rollDir = Math.sign(rollRaw) || 1;
  }
  sim.lastRollInput = rollRaw;

  // ---------- 3. probe + mode ----------------------------------------------
  const gripWanted = input.grip === true && sim.gas > 0.5;
  const hoverWanted = input.hover === true && sim.gas > 0.5;
  // hover looks far ahead so the altitude servo keeps feedback at height;
  // ground/grip probes lean forward (1.5 m) and tall (3.2 m) so the servo
  // sees an upcoming slope before the body can plough into it (tall rays
  // reach over surfaces that would otherwise sit above the ray origin)
  const probeRange = gripWanted ? 6.0 : hoverWanted ? 30.0 : 2.6;
  const ahead = hoverWanted ? 0 : 2.1; // past the nose (half-length 2.05)
  const tall = hoverWanted ? 0 : 3.2;
  let surf = probeSurface(body, probeRange, ahead, tall);

  const boostWindowMs = Math.round(ctx.cfg.boost.duration * 1000);
  const boosting = boostWindowMs > 0 && nowMs - sim.boostUsedAtMs < boostWindowMs;
  const canBoost =
    input.boost === true &&
    !boosting &&
    nowMs - sim.boostUsedAtMs >= Math.round(ctx.cfg.boost.cooldown * 1000) &&
    sim.gas >= ctx.cfg.gas.boostCost;

  let mode: CarMode;
  if (boosting) {
    mode = "boost";
  } else if (gripWanted && surf.hit && surf.distance <= GRIP_RANGE) {
    mode = "grip";
  } else if (hoverWanted) {
    mode = "hover";
  } else {
    mode = "ground";
  }

  // Terrain pitch limit for un-fanned rides: past maxTerrainPitchAlign the
  // only support is grip. A ground/boost car that still sees steep terrain
  // (the loop's steep band seen through the hollow) is falling, not standing
  // — drop the surface so no servo, guard or align can pin it mid-wall.
  if (
    surf.hit &&
    mode !== "grip" &&
    mode !== "hover" &&
    (Math.acos(clamp(surf.normal.y, -1, 1)) * 180) / Math.PI > ph.maxTerrainPitchAlign
  ) {
    surf = { hit: false, distance: Infinity, normal: surf.normal };
  }
  const grounded = surf.hit && surf.distance <= CAR_TARGET_CLEARANCE + 0.08;

  // ---------- 4. world-space velocity work ----------------------------------
  // 4a. pin spring — hold the target clearance above the surface (ground and
  // boost only; grip uses the fastener servo in 4e, hover its own servo in 4b).
  // maxTerrainPitchAlign caps WHERE the pin may act: past ~40° the true ride is
  // fan-suction territory, and a standing pin on the ring's steep band kept
  // non-gripping cars parked mid-wall forever (the stuck-strip complaint). The
  // cosine-ease ramp maxes at ~17°, so every drive surface keeps the pin.
  if (surf.hit && grounded && (mode === "ground" || mode === "boost")) {
    const pitchDeg = (Math.acos(clamp(surf.normal.y, -1, 1)) * 180) / Math.PI;
    if (pitchDeg <= ph.maxTerrainPitchAlign) {
      const err = surf.distance - CAR_TARGET_CLEARANCE;
      // One stiff spring for both modes: heavier springs shrink the
      // slope-following lag (lag ≈ slope·speed/spring), so the clearance
      // survives ramp entries without the surface reaching the body.
      const spring = 140;
      const corr = -err * spring;
      v.x += surf.normal.x * corr * dt;
      v.y += surf.normal.y * corr * dt;
      v.z += surf.normal.z * corr * dt;
    }
  }

  // 4b. hover altitude servo — track hover height above the surface below.
  // A velocity servo (not an acceleration) so feedback stays stable no
  // matter how high the car already is. Pitch takes the altitude over:
  // hold pitch up to climb (no height cap — the sky is the limit), pitch
  // down to sink; release and the servo glides back to the hover target.
  if (mode === "hover") {
    if (surf.hit) {
      const target = ph.hoverTargetHeight + CAR_TARGET_CLEARANCE;
      const err = target - surf.distance;
      const vDes =
        pitch !== 0
          ? pitch * (pitch > 0 ? ph.hoverClimbSpeed : ph.hoverSinkSpeed)
          : clamp(err * 1.2, -5, 9); // commanded climb speed, m/s
      const vN = dot(v, surf.normal);
      const dv = (vDes - vN) * Math.min(1, 5 * dt);
      v.x += surf.normal.x * dv;
      v.y += surf.normal.y * dv;
      v.z += surf.normal.z * dv;
    } else {
      // nothing below at all: pitch still flies, else settle gently
      v.y += (pitch !== 0
        ? pitch * (pitch > 0 ? ph.hoverClimbSpeed : ph.hoverSinkSpeed)
        : 2) * dt;
    }
  }

  // 4c. gravity — world −Y (halved while hovering, ~third while gripping)
  const g = ph.gravity * (mode === "hover" ? ph.hoverGravityFactor : mode === "grip" ? 0.3 : 1);
  let gVec: Vec = { x: 0, y: -g, z: 0 };
  if (surf.hit && (grounded || mode === "grip")) {
    // on a surface, gravity only slides tangentially (no sinking)
    const gAlongN = dot(gVec, surf.normal);
    gVec = {
      x: gVec.x - surf.normal.x * gAlongN,
      y: gVec.y - surf.normal.y * gAlongN,
      z: gVec.z - surf.normal.z * gAlongN,
    };
  }
  v.x += gVec.x * dt;
  v.y += gVec.y * dt;
  v.z += gVec.z * dt;

  // 4d. inward guard — on a surface, velocity toward the surface gets removed
  // (ground/boost/hover landings). Grip mode skips this — the fastener in
  // 4e manages approach velocity itself, and this guard used to cancel the
  // fastener's pull-in, parking cars mid-air off loop walls.
  if (surf.hit && grounded && mode !== "grip") {
    const vAlongN = dot(v, surf.normal);
    if (vAlongN < 0) {
      const vn = -vAlongN;
      v.x += surf.normal.x * vn;
      v.y += surf.normal.y * vn;
      v.z += surf.normal.z * vn;
    }
  }

  // 4f. grip curve-shed — when the surface curves hard just ahead (the
  // loop's entry) and we're still lapping at racing speed, bleed speed fast
  // enough that the ride align can follow the turn. Only grip rides see the
  // look-ahead normal, so wedge-ramp launches are untouched.
  if (surf.hit && mode === "grip" && surf.aheadNormal) {
    const aN = normVec(surf.aheadNormal);
    const curve = aN.x * surf.normal.x + aN.y * surf.normal.y + aN.z * surf.normal.z;
    const sp = Math.hypot(v.x, v.y, v.z);
    // floor at 40 m/s: rounding a 17 m ring needs ≈ √(2·g·2R) ≈ 37 m/s of
    // energy left at the bottom, so shedding below that stalls the climb
    if (curve < 0.92 && sp > 40) {
      const shed = Math.exp(-3.5 * dt);
      v.x *= shed; v.y *= shed; v.z *= shed;
    }
  }

  // 4e. grip fastener — replaces the pin spring + inward guard while gripping.
  // A damped PD servo on the gap: the proportional term contracts to the
  // clearance offset (and supplies the centripetal load of fast lap rides),
  // the derivative term damps the approach so latch-ins glide instead of
  // slamming (a deadbeat velocity servo vibrated against the contact solver
  // and eaten the climb). The 320 cap bounds a solver hiccup's worst case.
  if (surf.hit && mode === "grip") {
    const err = surf.distance - CAR_TARGET_CLEARANCE;
    const vN = dot(v, surf.normal);
    const aN = clamp(-err * 30 - vN * 12, -320, 320);
    v.x += surf.normal.x * aN * dt;
    v.y += surf.normal.y * aN * dt;
    v.z += surf.normal.z * aN * dt;
  }

  // ---------- 5. basis control ----------------------------------------------
  // record world vertical velocity against gravity & pin above:
  const vert0 = dot(v, u0); // not used for rebuild, debug aid
  void vert0;

  const right0 = normVec(cross(u0, f0));
  const fwd = normVec(cross(right0, u0));

  const long = dot(v, fwd);
  const lat = dot(v, right0);
  const vert = dot(v, u0);

  let newLong = long;
  let newLat = lat;
  let newVert = vert;

  if (mode === "ground" || mode === "grip" || mode === "boost") {
    if (throttle !== 0) {
      const accel = throttle > 0 ? ph.groundAccel : ph.groundBrakeAccel;
      newLong += throttle * accel * dt;
    }
    // tyres eat sideways velocity, a touch looser mid-boost
    const lateralGrip = ph.grip_Lateral * (mode === "boost" ? 0.7 : 1);
    newLat *= Math.exp(-lateralGrip * dt);
    if (grounded || mode === "grip") newVert *= Math.exp(-4.0 * dt);

    const speedFactor = Math.min(1, Math.abs(newLong) / 8 + 0.2);
    const yawAngle = -ph.turnRate * steer * speedFactor * dt;
    // yaw around the car's up; while gripping that up points away from the swface
    q = quatMul(q, quatRotateAxis(u0, yawAngle));
  } else if (mode === "hover") {
    // hovering: slower drift; throttle nudges forward
    if (throttle !== 0) newLong += throttle * ph.hoverLateralAccel * dt;
    newLat += steer * ph.hoverLateralAccel * dt;
    newLat *= Math.exp(-0.8 * dt);
    newVert *= Math.exp(-2.2 * dt);
    const yawAngle = -ph.hoverTurnRate * steer * 0.7 * dt;
    q = quatMul(q, quatRotateAxis(u0, yawAngle));
  }

  // ---------- 6. boost burst -------------------------------------------------
  if (canBoost) {
    sim.gas = Math.max(0, sim.gas - ctx.cfg.gas.boostCost);
    sim.boostUsedAtMs = nowMs;
    mode = "boost";
    // instant kick: the burst you feel the moment you press the button
    newLong += ctx.cfg.boost.impulse;
  }
  if (mode === "boost") {
    // sustained thrust during the window keeps the burst alive
    newLong += ph.groundAccel * 0.55 * dt;
  }

  const topSpeed = mode === "boost" ? ph.boostTopSpeed : ph.topSpeed;
  newLong = clamp(newLong, -16, topSpeed);

  // ---------- 6b. cold-gas thrusters (airborne pitch thrust) -----------------
  // Pitching in the air fires the thruster array along the car's own up:
  // nose up powers a climb toward the sky (no height cap), nose down dives.
  const airborne = !grounded && mode !== "grip" && mode !== "hover";
  if (airborne && pitch !== 0) {
    newVert += pitch * ph.airThrustAccel * dt;
  }

  // ---------- 7. rotation in the air (flips / auto barrel roll) ---------------
  if (airborne) {
    const upNow = rotateVec(q, { x: 0, y: 1, z: 0 });
    const rightNow = normVec(cross(upNow, fwd));
    // Arrow Up/Down controls vertical thrust only. Continuous pitch torque
    // made holding Arrow Up produce an unintended endless front flip.
    const pitchRate = 0;
    let rollRate = 0;
    if (sim.rollUntilMs > nowMs) rollRate = sim.rollDir * ph.airTorqueSnapRoll;
    else if (rollRaw !== 0) rollRate = rollRaw * ph.airRollTorque;
    const yawRate = -input.yaw * ph.airTurnRate * 0.5;

    const w: Vec = {
      x: rightNow.x * pitchRate + fwd.x * rollRate + upNow.x * yawRate,
      y: rightNow.y * pitchRate + fwd.y * rollRate + upNow.y * yawRate,
      z: rightNow.z * pitchRate + fwd.z * rollRate + upNow.z * yawRate,
    };
    const wMag = Math.hypot(w.x, w.y, w.z);
    if (wMag > ph.maxW) {
      const s = ph.maxW / wMag;
      w.x *= s; w.y *= s; w.z *= s;
    }
    body.setAngvel(w, true);
  } else if (grounded || mode === "grip" || mode === "hover") {
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);

    if (mode === "grip" && surf.hit) {
      // ---------- grip ride align (wall/loop/ceiling drives) ----------
      // Rotate the car's up toward the probe normal (Rapier orients the hit
      // normal toward the ray origin — the car's up side — for floor,
      // ceiling, wall and the inside of the vertical loop alike; never
      // negate it). Axis-angle with a rate cap: rotating about
      // cross(u0, target) by the signed angle maps up → target exactly,
      // which the old basisToQuat-to-target + slerp chain did not manage
      // (it built a pitch-down target and slammed the box's nose into
      // ramp toes at speed). 2.2 rad/s ≈ a 90° wall entry in ~0.7 s.
      const upTarget = normVec(surf.normal);
      const crUp = cross(u0, upTarget);
      const crMag = Math.hypot(crUp.x, crUp.y, crUp.z);
      const faceDot = dot(upTarget, u0);
      // Align only in the wall/loop regime: the surface substantially
      // disagrees with the car's up (>~30°). On gentle ramps the flat-kept
      // box slides the mesh's facet lips safely at full speed — a pitched
      // box instead lances its nose corner into every lip and the solver
      // eats the ride (probed: 60 m/s rides die when this gate is open too
      // wide). Once past the gate the axis-angle rotation turns up AND
      // heading onto the surface, giving the loop / wall / ceiling drive.
      if (crMag > 0.02 && faceDot < 0.86 && faceDot > -0.2) {
        const ang = Math.acos(clamp(faceDot, -1, 1));
        if (ang > 0.01 && ang < 2.5) {
          const axis: Vec = { x: crUp.x / crMag, y: crUp.y / crMag, z: crUp.z / crMag };
          q = quatMul(q, quatRotateAxis(axis, Math.min(ang, 2.2 * dt)));
        }
        // heading curve: rotate the heading toward the tangential motion
        // direction while latched to a tilted surface (nose points where
        // the ride goes); NOT on gentle rides (noise-steering amplifies
        // lateral drift off the strip's side edge).
        const vnG = v.x * upTarget.x + v.y * upTarget.y + v.z * upTarget.z;
        const tang: Vec = {
          x: v.x - upTarget.x * vnG,
          y: v.y - upTarget.y * vnG,
          z: v.z - upTarget.z * vnG,
        };
        const tSpeed = Math.hypot(tang.x, tang.y, tang.z);
        if (tSpeed > 8) {
          const tDir: Vec = { x: tang.x / tSpeed, y: tang.y / tSpeed, z: tang.z / tSpeed };
          const fDot = dot(fwd, tDir);
          const crF = cross(fwd, tDir);
          const crFMag = Math.hypot(crF.x, crF.y, crF.z);
          if (crFMag > 0.02 && fDot > -0.2) {
            const fAng = Math.acos(clamp(fDot, -1, 1));
            if (fAng > 0.02) {
              const axisF: Vec = { x: crF.x / crFMag, y: crF.y / crFMag, z: crF.z / crFMag };
              q = quatMul(q, quatRotateAxis(axisF, Math.min(fAng, 2.2 * dt)));
            }
          }
        }
      }
    } else {
      // ---------- ground/hover align (legacy, unchanged) ----------
      // Rapier already orients the hit normal toward the ray origin (the
      // car's up side); never negate it (that made latch flips on flat).
      const upTarget: Vec = grounded && surf.hit ? normVec(surf.normal) : u0;
      if (dot(upTarget, u0) < 0.9995) {
        const alignRight = normVec(cross(upTarget, fwd));
        const alignFwd = normVec(cross(alignRight, upTarget));
        if (alignRight.x + alignRight.y + alignRight.z > 0) {
          const targetQ = basisToQuat(alignRight, upTarget, alignFwd);
          q = quatSlerp(q, targetQ, clamp(10 * dt, 0, 1));
        }
      }
    }
  }

  // ---------- 8. gas meter (spec 6.2, updated: flight is unlimited) ---------
  // With the shipped tuning the drains and boost cost are 0, so gas never
  // leaves the start value (unlimited hover/grip/boost). The meter stays
  // config-driven: enabling a drain here immediately makes the resource live.
  if (mode === "hover") sim.gas = Math.max(0, sim.gas - ctx.cfg.gas.hoverDrainPerSecond * dt);
  else if (mode === "grip") sim.gas = Math.max(0, sim.gas - ctx.cfg.gas.gripDrainPerSecond * dt);
  else if (grounded && mode === "ground" && input.grip !== true) {
    sim.gas = Math.min(ctx.cfg.gas.max, sim.gas + ctx.cfg.gas.rechargePerSecond * dt);
  }

  // ---------- 9. rebuild world velocity + soft boundary -----------------------
  let targetV: Vec = {
    x: newLong * fwd.x + newLat * right0.x + newVert * u0.x,
    y: newLong * fwd.y + newLat * right0.y + newVert * u0.y,
    z: newLong * fwd.z + newLat * right0.z + newVert * u0.z,
  };

  const softR = ctx.cfg.arena.softWallRadius;
  const r2 = p.x * p.x + p.z * p.z;
  if (r2 > softR * softR) {
    const r = Math.sqrt(r2) || 1;
    const push = ctx.cfg.arena.softWallForce * dt;
    targetV = {
      x: targetV.x - (p.x / r) * push,
      y: targetV.y,
      z: targetV.z - (p.z / r) * push,
    };
  }

  // ---------- 9b. rail ride (grip): velocity hugs the surface ascent ---------
  // Fan-suction abstraction — while latched, motion stays ON the surface
  // rail (the planar ascent direction), so the loop's turn happens in the
  // velocity field instead of the collider hammering each facet lip.
  // Speed is preserved, only the direction snaps toward the rail; this also
  // kills lateral drift off the strip's side edge (v_z is railless).
  if (mode === "grip" && surf.hit) {
    const n = normVec(surf.normal);
    // rail = forward projected onto the surface plane when the nose is
    // mostly along the ride (ceiling/tunnel drives keep their true heading,
    // ground steering keeps working); when the nose dives INTO the surface
    // (loop wall entry) fall back to the arena's planar ascent direction.
    const fN = dot(fwd, n);
    const proj: Vec = { x: fwd.x - n.x * fN, y: fwd.y - n.y * fN, z: fwd.z - n.z * fN };
    const projMag = Math.hypot(proj.x, proj.y, proj.z);
    let rail: Vec;
    if (projMag > 0.4) {
      rail = { x: proj.x / projMag, y: proj.y / projMag, z: proj.z / projMag };
    } else {
      const crossRail: Vec = { x: -n.y, y: n.x, z: 0 };
      rail = crossRail.x * fwd.x + crossRail.y * fwd.y + crossRail.z * fwd.z < 0
        ? { x: -crossRail.x, y: -crossRail.y, z: 0 }
        : crossRail;
    }
    // Curved surfaces (the ring's inside) extrude along ±z: any z velocity
    // slides the car across the tube and dumps it off the strip's side, so
    // their rails are planar. Flat venues (tunnel ceiling, plaza ground)
    // agree with their look-ahead normal and keep full 3D rails — the
    // tunnel's drive direction stays free.
    if (surf.aheadNormal) {
      const aN = normVec(surf.aheadNormal);
      if (aN.x * n.x + aN.y * n.y + aN.z * n.z < 0.98) {
        const mag = Math.hypot(rail.x, rail.y) || 1;
        rail = { x: rail.x / mag, y: rail.y / mag, z: 0 };
      }
    }
    const along = targetV.x * rail.x + targetV.y * rail.y + targetV.z * rail.z;
    const railSnap = Math.min(1, 20 * dt);
    targetV = {
      x: targetV.x + (rail.x * along - targetV.x) * railSnap,
      y: targetV.y + (rail.y * along - targetV.y) * railSnap,
      z: targetV.z + (rail.z * along - targetV.z) * railSnap,
    };
  }

  body.setLinvel(targetV, true);
  body.setRotation(quatNormalise(q), true);
  sim.mode = mode;
  return mode;
}

/** Heading quaternion for a yaw angle around world-up (spawns). */
export function headingQuat(yaw: number): Quat {
  const fwd = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
  return basisToQuat(
    normVec(cross({ x: 0, y: 1, z: 0 }, fwd)),
    { x: 0, y: 1, z: 0 },
    fwd,
  );
}
