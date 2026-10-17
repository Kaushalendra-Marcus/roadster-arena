/**
 * Real-physics ramp probe: drives an actual Rapier dynamic body (SimWorld,
 * exactly like the server room does) up the launch hump and the loop entry
 * ramp, printing y/heading so we can see whether the controller rides these
 * surfaces, launches off them, or smashes into them.
 */

import { DEFAULT_GAMEPLAY, stepCar } from "@roadster-arena/shared";
import RAPIER from "@dimforge/rapier3d-compat";
import { SimWorld } from "./src/physics/world.js";

const CFG = DEFAULT_GAMEPLAY;
await RAPIER.init();
const world = new SimWorld(RAPIER, CFG);
const car = world.createCar("probe", 0);
const sim = {
  body: car.view,
  gas: CFG.gas.start,
  mode: "ground" as const,
  ghostUntilMs: 0,
  spawnIndex: 0,
  boostUsedAtMs: Number.NEGATIVE_INFINITY,
  lastRollInput: 0,
  rollUntilMs: 0,
  rollDir: 0,
  lastProcessedInput: 0,
};

let nowMs = 0;
const idle = { throttle: 0, steer: 0, pitch: 0, roll: 0, yaw: 0, hover: false, boost: false, grip: false };
const gas = { ...idle, throttle: 1 };

const place = (x: number, z: number, yaw: number) => {
  car.body.setTranslation({ x, y: 0.62, z }, false);
  car.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, false);
  car.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
  car.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
};

const log = (tag: string) => {
  const t = car.body.translation();
  const v = car.body.linvel();
  const rot = car.body.rotation();
  const up = {
    x: 2 * (rot.x * rot.y - rot.w * rot.z),
    y: 1 - 2 * (rot.x * rot.x + rot.z * rot.z),
    z: 2 * (rot.y * rot.z + rot.w * rot.x),
  };
  console.log(
    `${tag.padEnd(9)} t=${Math.round(nowMs)}`,
    `pos=(${t.x.toFixed(1)}, ${t.y.toFixed(2)}, ${t.z.toFixed(1)})`,
    `|v|=${Math.hypot(v.x, v.y, v.z).toFixed(1)} up=(${up.x.toFixed(2)}, ${up.y.toFixed(2)}, ${up.z.toFixed(2)})`,
    `mode=${sim.mode}`,
  );
};

const run = (label: string, ticks: number, phase: string) => {
  for (let i = 0; i < ticks; i++) {
    stepCar(sim, gas, { cfg: CFG, dt: 1 / 60, nowMs });
    world.step();
    nowMs += 1000 / 60;
    if (i % 12 === 0) log(`${label} · ${phase}`);
  }
};

// ---- hump run: 3 s build-up on the runway, then over the crest -------------
place(-180, 110, Math.PI / 2); // yaw +90° = forward +x
run("hump", 240, "approach");
run("hump", 150, "on/after");

// ---- loop run: grip held, bottom-tangent entry -----------------------------
place(30, 120, Math.PI / 2);
const gripGas = { ...idle, throttle: 1, grip: true };
const gripRun = (label: string, ticks: number, at: number) => {
  place(30, 120, Math.PI / 2);
  for (let i = 0; i < ticks; i++) {
    stepCar(sim, gripGas, { cfg: CFG, dt: 1 / 60, nowMs });
    world.step();
    nowMs += 1000 / 60;
    if (i % at === 0) log(label);
  }
};
gripRun("grip-in", 80, 20);
// fine trace around the stall zone
place(30, 120, Math.PI / 2);
for (let i = 0; i < 300; i++) {
  stepCar(sim, gripGas, { cfg: CFG, dt: 1 / 60, nowMs });
  const events = world.step();
  if (i >= 124 && i <= 132) {
    const tr = car.body.translation();
    const rot = car.body.rotation();
    const up = {
      x: 2 * (rot.x * rot.y - rot.w * rot.z),
      y: 1 - 2 * (rot.x * rot.x + rot.z * rot.z),
      z: 2 * (rot.y * rot.z + rot.w * rot.x),
    };
    const r = new RAPIER.Ray(
      { x: tr.x, y: tr.y, z: tr.z },
      { x: -up.x, y: -up.y, z: -up.z },
    );
    const hit = world.world.castRayAndGetNormal(r, 6, true, undefined, undefined, undefined, car.body);
    console.log(
      `   ray i=${i} from (${tr.x.toFixed(2)}, ${tr.y.toFixed(2)}) dir=(${-up.x.toFixed(2)}, ${-up.y.toFixed(2)}, ${-up.z.toFixed(2)})`,
      hit ? `toi=${hit.timeOfImpact.toFixed(3)} n=(${hit.normal.x.toFixed(2)}, ${hit.normal.y.toFixed(2)}, ${hit.normal.z.toFixed(2)}) at (${(tr.x - up.x * hit.timeOfImpact).toFixed(1)}, ${(tr.y - up.y * hit.timeOfImpact).toFixed(2)})` : "null",
    );
    events.drainCollisionEvents((h1: number, h2: number, started: boolean) => {
      const k1 = world.kindOf(h1);
      const k2 = world.kindOf(h2);
      console.log(`   evt i=${i} ${started ? "start" : "end "} ${JSON.stringify(k1)} × ${JSON.stringify(k2)}`);
    });
  }
  nowMs += 1000 / 60;
  if (i >= 96 && i <= 210) {
    const t = car.body.translation();
    const v = car.body.linvel();
    const w = car.body.angvel();
    console.log(
      `i=${i} x=${t.x.toFixed(2)} y=${t.y.toFixed(3)} z=${t.z.toFixed(2)}`,
      `v=(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}) w=(${w.x.toFixed(1)}, ${w.y.toFixed(1)}, ${w.z.toFixed(1)})`,
      `gas=${sim.gas.toFixed(0)}`,
    );
    if (i >= 127 && i <= 132) {
      let pairCount = 0;
      world.world.contactPairsWith(car.collider, (other) => {
        pairCount += 1;
        world.world.contactPair(car.collider, other, (manifold) => {
          const n = manifold.normal();
          const p1 = [...manifold.contacts()][0];
          const p = p1 ? p1.localP1 : { x: 0, y: 0, z: 0 };
          console.log(
            `   cf i=${i} n=(${n.x.toFixed(2)}, ${n.y.toFixed(2)}, ${n.z.toFixed(2)}) p1=(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`,
          );
        });
      });
      if (pairCount === 0) console.log(`   cf i=${i} NO-PAIRS`);
    }
  }
}

// ---- how hard is the hump face when hit slow? ------------------------------
place(-130, 110, Math.PI / 2);
run("slow-hit", 90, "creep-up");

world.free();
