/**
 * Shared car controller unit tests (spec 6.2). These run the exact function
 * the server uses, against a fake body view with a flat ground plane (y=0)
 * and an optional ceiling (y=10) for grip-mode checks.
 */

import { describe, it, expect } from "vitest";
import {
  stepCar,
  DEFAULT_GAMEPLAY,
  type CarSim,
  type DriveInput,
  type CarBodyView,
} from "../packages/shared/src/index.js";

const CFG = DEFAULT_GAMEPLAY;
const DT = 1 / 60;

const CEILING_Y = 10;

interface FakeOpts {
  y: number;
  /** quaternion as yaw/pitch applied to the initial orientation */
  pitch?: number;
}

function makeBody(opts: FakeOpts) {
  const state = {
    translation: { x: 0, y: opts.y, z: 0 },
    linvel: { x: 0, y: 0, z: 0 },
    angvel: { x: 0, y: 0, z: 0 },
    rotation: (() => {
      const a = (opts.pitch ?? 0) / 2;
      return { x: Math.sin(a), y: 0, z: 0, w: Math.cos(a) };
    })(),
  };
  const view: CarBodyView = {
    get translation() {
      return state.translation;
    },
    get linvel() {
      return state.linvel;
    },
    get angvel() {
      return state.angvel;
    },
    get rotation() {
      return state.rotation;
    },
    setTranslation(v) {
      state.translation = { ...v };
    },
    setLinvel(v) {
      state.linvel = { ...v };
    },
    setAngvel(v) {
      state.angvel = { ...v };
    },
    setRotation(q) {
      state.rotation = { ...q };
    },
    applyImpulse() {},
    raycast(origin, dir, maxToi) {
      // ground plane y=0 (normal up) and ceiling plane y=CEILING_Y (normal down)
      const planes = [
        { y: 0, n: { x: 0, y: 1, z: 0 } },
        { y: CEILING_Y, n: { x: 0, y: -1, z: 0 } },
      ];
      let best: { toi: number; normal: { x: number; y: number; z: number } } | null = null;
      for (const p of planes) {
        if (Math.abs(dir.y) < 1e-9) continue;
        const t = (p.y - origin.y) / dir.y;
        if (t <= 0.0001 || t > maxToi) continue;
        // normal must oppose the ray direction
        if (p.n.x * dir.x + p.n.y * dir.y + p.n.z * dir.z >= 0) continue;
        if (!best || t < best.toi) best = { toi: t, normal: p.n };
      }
      return best ? { hit: true, toi: best.toi, normal: best.normal } : null;
    },
  };
  return { state, view };
}

/** Rapier integrates velocities into positions between steps; the fake body
 *  must do the same or nothing ever moves. */
function integrate(sim: CarSim): void {
  const t = sim.body.translation;
  const v = sim.body.linvel;
  sim.body.setTranslation({ x: t.x + v.x * DT, y: t.y + v.y * DT, z: t.z + v.z * DT }, true);
}

function makeSim(view: CarBodyView, gas = 100): CarSim {
  return {
    body: view,
    gas,
    mode: "ground",
    ghostUntilMs: 0,
    spawnIndex: 0,
    boostUsedAtMs: Number.NEGATIVE_INFINITY,
    lastRollInput: 0,
    rollUntilMs: 0,
    rollDir: 0,
    lastProcessedInput: 0,
  };
}

const idle: DriveInput = {
  throttle: 0, steer: 0, pitch: 0, roll: 0, yaw: 0,
  hover: false, boost: false, grip: false,
};

function drive(sim: CarSim, input: DriveInput, steps: number, startMs = 0): void {
  for (let i = 0; i < steps; i++) {
    stepCar(sim, input, { cfg: CFG, dt: DT, nowMs: startMs + i * (DT * 1000) });
    integrate(sim);
  }
}

describe("stepCar (shared arcade controller)", () => {
  it("accelerates on the ground and clamps at top speed", () => {
    const { state, view } = makeBody({ y: 0.62 });
    const sim = makeSim(view);
    drive(sim, { ...idle, throttle: 1 }, 60 * 6); // 6 seconds
    const speed = Math.hypot(state.linvel.x, state.linvel.z);
    expect(speed).toBeGreaterThan(CFG.physics.topSpeed * 0.97);
    expect(speed).toBeLessThanOrEqual(CFG.physics.topSpeed + 0.5);
  });

  it("refuels while driving on the ground", () => {
    const { view } = makeBody({ y: 0.62 });
    const sim = makeSim(view, 40);
    drive(sim, { ...idle, throttle: 1 }, 60 * 4); // +20/s → full in 3 s, clamped at max
    expect(sim.gas).toBeCloseTo(CFG.gas.max, 0);
  });

  it("hover is unlimited: holds altitude with gas untouched", () => {
    const { state, view } = makeBody({ y: 0.62 });
    const sim = makeSim(view);
    // drains shipped as 0 → flight is unlimited and the meter never moves
    drive(sim, { ...idle, hover: true }, 60 * 3);
    expect(sim.mode).toBe("hover");
    expect(sim.gas).toBe(CFG.gas.max);
    expect(state.translation.y).toBeGreaterThan(2.5); // hoverTargetHeight 3
    expect(state.translation.y).toBeLessThan(5);
  });

  it("grip holds the car against a ceiling (spec 6.2 fan suction)", () => {
    // car just below the ceiling at y=10, flipped (up side down)
    const { state, view } = makeBody({ y: 9.2, pitch: Math.PI });
    const sim = makeSim(view);
    drive(sim, { ...idle, grip: true, throttle: 1 }, 60 * 2);
    expect(sim.mode).toBe("grip");
    // pinned a fixed clearance under the ceiling rather than falling
    expect(state.translation.y).toBeGreaterThan(9);
    // and moving along it
    expect(Math.hypot(state.linvel.x, state.linvel.z)).toBeGreaterThan(5);
  });

  it("boost bursts forward freely, then cools down", () => {
    const { state, view } = makeBody({ y: 0.62 });
    const sim = makeSim(view);
    drive(sim, { ...idle, throttle: 1, boost: true }, 3);
    // boost cost shipped as 0 → gas is unlimited; the cooldown is the gate
    expect(sim.gas).toBe(CFG.gas.max);
    const boosted = Math.hypot(state.linvel.x, state.linvel.z);
    // well above what base throttle gives in 3 ticks
    expect(boosted).toBeGreaterThan(6);
    // immediate second boost is refused (cooldown)
    const before = state.linvel.x;
    drive(sim, { ...idle, throttle: 1, boost: true }, 1, 100);
    expect(state.linvel.x).toBeLessThan(before + 2);
  });

  it("pushes cars back inside the soft boundary (spec 8)", () => {
    const { state, view } = makeBody({ y: 0.62 });
    const sim = makeSim(view);
    state.translation.x = CFG.arena.softWallRadius + 8;
    drive(sim, idle, 30);
    // velocity points back toward the centre
    expect(state.linvel.x).toBeLessThan(0);
  });

  it("is deterministic: identical inputs, identical positions", () => {
    const run = () => {
      const { state, view } = makeBody({ y: 0.62 });
      const sim = makeSim(view);
      drive(sim, { ...idle, throttle: 1, steer: 0.4 }, 120);
      return `${state.translation.x.toFixed(6)},${state.translation.z.toFixed(6)}`;
    };
    expect(run()).toBe(run());
  });
});
