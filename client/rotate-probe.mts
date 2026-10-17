/**
 * Rotation-reproduction probe: drives the real client-side controller over
 * the launch ramp, through hover down-up cycles and a bar-roll tap, logging
 * quaternions so we can see exactly where uncommanded spin appears.
 */

import { DEFAULT_GAMEPLAY, stepCar, buildArenaDef, rotateVec } from "@roadster-arena/shared";
import RAPIER, { ColliderDesc } from "@dimforge/rapier3d-compat";

const CFG = DEFAULT_GAMEPLAY;
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
for (const c of buildArenaDef(CFG).colliders) {
  const desc =
    "vertices" in c
      ? ColliderDesc.trimesh(new Float32Array(c.vertices), new Uint32Array(c.indices))
      : ColliderDesc.cuboid(c.half.x, c.half.y, c.half.z);
  desc.setTranslation(c.pos.x, c.pos.y, c.pos.z);
  if (!("vertices" in c) && c.axis && (c.angle ?? 0) !== 0) {
    const a = (c.angle ?? 0) / 2;
    desc.setRotation({
      x: c.axis === "x" ? Math.sin(a) : 0,
      y: c.axis === "y" ? Math.sin(a) : 0,
      z: c.axis === "z" ? Math.sin(a) : 0,
      w: Math.cos(a),
    });
  }
  world.createCollider(desc);
}
world.step(); // arm Rapier's query pipeline (rays are null on a never-stepped world)

// local sim with Rapier-query raycasts (same as the real client)
const local = {
  translation: { x: 0, y: 0.62, z: 0 },
  linvel: { x: 0, y: 0, z: 0 },
  angvel: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
};
const body = {
  get translation() { return local.translation; },
  get linvel() { return local.linvel; },
  get angvel() { return local.angvel; },
  get rotation() { return local.rotation; },
  setTranslation(v) { local.translation = { ...v }; },
  setLinvel(v) { local.linvel = { ...v }; },
  setAngvel(v) { local.angvel = { ...v }; },
  setRotation(q) { local.rotation = { ...q }; },
  applyImpulse() {},
  raycast(origin, dir, maxToi) {
    const r = new RAPIER.Ray(origin, dir);
    const hit = world.castRayAndGetNormal(r, maxToi, true);
    return hit ? { hit: true, toi: hit.timeOfImpact, normal: { ...hit.normal } } : null;
  },
};
const sim = {
  body, gas: 100, mode: "ground" as const, ghostUntilMs: 0, spawnIndex: 0,
  boostUsedAtMs: -Infinity, lastRollInput: 0, rollUntilMs: 0, rollDir: 0, lastProcessedInput: 0,
};

const integrate = () => {
  const t = local.translation, v = local.linvel;
  local.translation = { x: t.x + v.x / 60, y: t.y + v.y / 60, z: t.z + v.z / 60 };
  const w = local.angvel;
  const wm = Math.hypot(w.x, w.y, w.z);
  if (wm > 1e-6) {
    const h = (wm / 2) / 60;
    const half = { x: (w.x / wm) * Math.sin(h), y: (w.y / wm) * Math.sin(h), z: (w.z / wm) * Math.sin(h), w: Math.cos(h) };
    const q = local.rotation;
    local.rotation = {
      x: half.w * q.x + half.x * q.w + half.y * q.z - half.z * q.y,
      y: half.w * q.y - half.x * q.z + half.y * q.w + half.z * q.x,
      z: half.w * q.z + half.x * q.y - half.y * q.x + half.z * q.w,
      w: half.w * q.w - half.x * q.x - half.y * q.y - half.z * q.z,
    };
  }
};

const step = (input: import("@roadster-arena/shared").DriveInput, nowMs: number) => {
  stepCar(sim, input, { cfg: CFG, dt: 1 / 60, nowMs });
  integrate();
};

let now = 0;
const idle = { throttle: 0, steer: 0, pitch: 0, roll: 0, yaw: 0, hover: false, boost: false, grip: false } as import("@roadster-arena/shared").DriveInput;
const gas = { ...idle, throttle: 1 } as import("@roadster-arena/shared").DriveInput;
const hover = { ...idle, hover: true, throttle: 1 } as import("@roadster-arena/shared").DriveInput;
const rollInput = { ...idle, roll: 1, throttle: 0.3 } as import("@roadster-arena/shared").DriveInput;

const log = (tag: string, every = 30) => {
  if (!(stepCount % every === 0)) return;
  const fwd = rotateVec(local.rotation, { x: 0, y: 0, z: 1 });
  const up = rotateVec(local.rotation, { x: 0, y: 1, z: 0 });
  console.log(
    `${tag.padEnd(13)} t=${stepCount} pos=(${local.translation.x.toFixed(1)}, ${local.translation.y.toFixed(2)}, ${local.translation.z.toFixed(1)})`,
    `fwd=(${fwd.x.toFixed(2)}, ${fwd.y.toFixed(2)}, ${fwd.z.toFixed(2)}) up=(${up.x.toFixed(2)}, ${up.y.toFixed(2)}, ${up.z.toFixed(2)})`,
    `w=(${local.angvel.x.toFixed(2)}, ${local.angvel.y.toFixed(2)}, ${local.angvel.z.toFixed(2)}) mode=${sim.mode}`,
  );
};
let stepCount = 0;

// phase 1: drive flat 3 s (steady state — should not rotate)
for (let i = 0; i < 180; i++) { step(gas, now); now += 16.67; stepCount++; log("flat drive"); }

// phase 2: hover on for 2 s, then hover off (falls) 1 s — the suspect window
for (let i = 0; i < 120; i++) { step(hover, now); now += 16.67; stepCount++; log("hover"); }
for (let i = 0; i < 60; i++) { step(gas, now); now += 16.67; stepCount++; log("falling"); }

// phase 3: roll tap (1 tick of roll, then idle 1.5 s) → auto barrel roll
step(rollInput, now); now += 16.67; stepCount++;
for (let i = 0; i < 90; i++) { step(gas, now); now += 16.67; stepCount++; log("after roll tap"); }

// phase 4: drive UP the launch hump (arc centre x=-110, strip z 105..115)
// heading +x from just before the ramp foot at x≈-124
sim.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
sim.body.setTranslation({ x: -126, y: 0.62, z: 110 }, true);
sim.body.setRotation({ x: 0, y: 0.7071, z: 0, w: 0.7071 }, true);
for (let i = 0; i < 240; i++) { step(gas, now); now += 16.67; stepCount++; log("onto hump", 24); }

// phase 5: approach the loop (entry ramp x 91..113, strip z 115..125)
sim.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
sim.body.setTranslation({ x: 58, y: 0.62, z: 120 }, true);
sim.body.setRotation({ x: 0, y: 0.7071, z: 0, w: 0.7071 }, true);
for (let i = 0; i < 700; i++) { step(gas, now); now += 16.67; stepCount++; log("loop run", 30); }

