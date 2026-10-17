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

/** Ray down the car's -up axis; returns distance and surface normal. */
function probeSurface(body: CarBodyView, maxDist: number): RayResult {
  const p = body.translation;
  const up = rotateVec({ ...body.rotation }, { x: 0, y: 1, z: 0 });
  const dir = { x: -up.x, y: -up.y, z: -up.z };
  const hit = body.raycast({ x: p.x, y: p.y, z: p.z }, dir, maxDist);
  if (!hit || !hit.hit) {
    return { hit: false, distance: Infinity, normal: { x: 0, y: 1, z: 0 } };
  }
  const n = hit.normal;
  const hasNormal = Math.abs(n.x) + Math.abs(n.y) + Math.abs(n.z) > 1e-6;
  return {
    hit: true,
    distance: hit.toi,
    normal: hasNormal ? normVec({ ...n }) : { x: up.x, y: up.y, z: up.z },
  };
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
  // hover looks far ahead so the altitude servo keeps feedback at height
  const probeRange = gripWanted ? 6.0 : hoverWanted ? 30.0 : 2.6;
  const surf = probeSurface(body, probeRange);
  const grounded = surf.hit && surf.distance <= CAR_TARGET_CLEARANCE + 0.08;

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

  // ---------- 4. world-space velocity work ----------------------------------
  // 4a. pin spring — hold the target clearance above the surfac
  if (surf.hit && (grounded || mode === "grip")) {
    const err = surf.distance - CAR_TARGET_CLEARANCE;
    const spring = mode === "grip" ? 55 : 36;
    // negative err (too close / penetrating) pushes out along +normal,
    // positive err (too high) pulls in along -normal
    const corr = -err * spring;
    v.x += surf.normal.x * corr * dt;
    v.y += surf.normal.y * corr * dt;
    v.z += surf.normal.z * corr * dt;
  }

  // 4b. hover altitude servo — track hover height above the surface below.
  // A velocity servo (not an acceleration) so feedback stays stable no
  // matter how high the car already is.
  if (mode === "hover") {
    if (surf.hit) {
      const target = ph.hoverTargetHeight + CAR_TARGET_CLEARANCE;
      const err = target - surf.distance;
      const vDes = clamp(err * 1.2, -5, 9); // commanded climb speed, m/s
      const vN = dot(v, surf.normal);
      const dv = (vDes - vN) * Math.min(1, 5 * dt);
      v.x += surf.normal.x * dv;
      v.y += surf.normal.y * dv;
      v.z += surf.normal.z * dv;
    } else {
      // nothing below at all: settle gently instead of rocketing
      v.y += 2 * dt;
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
  if (surf.hit && (grounded || mode === "grip")) {
    const vAlongN = dot(v, surf.normal);
    if (vAlongN < 0) {
      const vn = -vAlongN;
      v.x += surf.normal.x * vn;
      v.y += surf.normal.y * vn;
      v.z += surf.normal.z * vn;
    }
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

  // ---------- 7. rotation in the air (flips / auto barrel roll) ---------------
  const airborne = !grounded && mode !== "grip" && mode !== "hover";
  if (airborne) {
    const upNow = rotateVec(q, { x: 0, y: 1, z: 0 });
    const rightNow = normVec(cross(upNow, fwd));
    const pitchRate = pitch * ph.airPitchTorque;
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

    // align the body to the surface normal while keeping the heading
    const upTarget: Vec =
      mode === "grip" && surf.hit
        ? normVec({ x: -surf.normal.x, y: -surf.normal.y, z: -surf.normal.z })
        : grounded && surf.hit
          ? normVec(surf.normal)
          : u0;
    if (dot(upTarget, u0) < 0.9995) {
      const alignRight = normVec(cross(upTarget, fwd));
      const alignFwd = normVec(cross(alignRight, upTarget));
      if (alignRight.x + alignRight.y + alignRight.z > 0) {
        const targetQ = basisToQuat(alignRight, upTarget, alignFwd);
        q = quatSlerp(q, targetQ, clamp(10 * dt, 0, 1));
      }
    }
  }

  // ---------- 8. gas meter (spec 6.2) ----------------------------------------
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
