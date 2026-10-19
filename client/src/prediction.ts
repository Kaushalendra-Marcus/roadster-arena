/**
 * Client prediction (spec 5.3): the browser runs the exact shared `stepCar`
 * the server runs, at the exact 60 Hz fixed rate. Server snapshots (20 Hz)
 * carry the authoritative transform plus `lastProcessedInput` (the ack
 * cursor); on every patch we rewind our local sim to that authoritative
 * state and re-simulate every input the server hasn't consumed yet.
 *
 * Result: zero perceived input latency, small corrections only when server
 * physics (collisions, bumps) diverge from ours.
 */

import {
  stepCar,
  quatMul,
  quatNormalise,
  type CarSim,
  type CarBodyView,
  type DriveInput,
  type GameplayConfig,
  type Vec3,
} from "@roadster-arena/shared";
import type { PhysQuery } from "./physics-query.js";

type Quat = { x: number; y: number; z: number; w: number };

interface PendingInput {
  seq: number;
  input: DriveInput;
}

export interface OwnCarSnapshot {
  x: number; y: number; z: number;
  qx: number; qy: number; qz: number; qw: number;
  vx: number; vy: number; vz: number;
  mode: string;
  gas: number;
  lastProcessedInput: number;
  ghostUntil: number;
}

export class Predictor {
  readonly sim: CarSim;
  private pending: PendingInput[] = [];
  private seq = 0;
  private view: CarBodyView;
  private simNowMs = Number.NaN;
  /**
   * Pose before the most recent 60 Hz step. The sim runs on a fixed 60 Hz
   * grid while displays render at 45–144 Hz, so sampling the *latest* state
   * makes the car visibly step (a frame that catches two ticks jumps twice
   * as far — measured as per-frame yaw variance ≈ mean, i.e. judder).
   * renderTransform() samples between prev and the live state instead.
   */
  private prevPos: Vec3 = { x: 0, y: 0, z: 0 };
  private prevQuat: Quat = { x: 0, y: 0, z: 0, w: 1 };
  /** set when a correction exceeded the snap threshold this patch */
  snapped = false;
  /** ms timestamp of the last server patch (performance.now) */
  lastPatchAt = 0;

  constructor(
    private query: PhysQuery,
    private cfg: GameplayConfig,
    spawn: Vec3,
    spawnQuat: Quat,
    ghostUntil = 0,
  ) {
    const local = {
      translation: { ...spawn },
      linvel: { x: 0, y: 0, z: 0 },
      angvel: { x: 0, y: 0, z: 0 },
      rotation: { ...spawnQuat },
    };
    this.view = {
      get translation() {
        return local.translation;
      },
      set translation(v) {
        local.translation = { ...v };
      },
      get linvel() {
        return local.linvel;
      },
      set linvel(v) {
        local.linvel = { ...v };
      },
      get angvel() {
        return local.angvel;
      },
      set angvel(v) {
        local.angvel = { ...v };
      },
      get rotation() {
        return local.rotation;
      },
      set rotation(q) {
        local.rotation = { ...q };
      },
      setTranslation(v) {
        local.translation = { ...v };
      },
      setLinvel(v) {
        local.linvel = { ...v };
      },
      setAngvel(v) {
        local.angvel = { ...v };
      },
      setRotation(q, _wake) {
        local.rotation = { ...q };
      },
      applyImpulse() {},
      raycast: (origin, dir, maxToi) => query.castRay(origin, dir, maxToi),
    };
    this.sim = {
      body: this.view,
      gas: cfg.gas.start,
      mode: "ground",
      ghostUntilMs: ghostUntil,
      spawnIndex: 0,
      boostUsedAtMs: Number.NEGATIVE_INFINITY,
      lastRollInput: 0,
      rollUntilMs: 0,
      rollDir: 0,
      lastProcessedInput: 0,
    };
    this.prevPos = { ...spawn };
    this.prevQuat = { ...spawnQuat };
  }

  /** remember the pose before the next fixed step (render interpolation base) */
  private syncPrev(): void {
    const t = this.view.translation;
    const q = this.view.rotation;
    this.prevPos.x = t.x;
    this.prevPos.y = t.y;
    this.prevPos.z = t.z;
    this.prevQuat.x = q.x;
    this.prevQuat.y = q.y;
    this.prevQuat.z = q.z;
    this.prevQuat.w = q.w;
  }

  /** queue one input frame; returns its seq */
  push(input: DriveInput): number {
    const seq = ++this.seq;
    this.pending.push({ seq, input });
    // hard cap: drop the oldest if the buffer runs away (e.g. long lag spike)
    while (this.pending.length > 240) this.pending.shift();
    return seq;
  }

  /** inputs the server has not acknowledged yet */
  get unacked(): number {
    return this.pending.length;
  }

  /**
   * Reconcile with an authoritative snapshot (spec 5.3): reset local state,
   * replay everything newer than the ack. Called on each state patch.
   */
  reconcile(s: OwnCarSnapshot, renderNowMs: number): void {
    const pos = { x: s.x, y: s.y, z: s.z };
    const drift =
      Math.hypot(pos.x - this.view.translation.x, pos.y - this.view.translation.y, pos.z - this.view.translation.z);
    this.snapped = drift > 2.5;

    this.view.setTranslation(pos, true);
    this.view.setLinvel({ x: s.vx, y: s.vy, z: s.vz }, true);
    this.view.setRotation({ x: s.qx, y: s.qy, z: s.qz, w: s.qw }, true);
    this.sim.gas = s.gas;
    this.sim.mode = s.mode as CarSim["mode"];
    this.sim.ghostUntilMs = s.ghostUntil;

    // drop consumed inputs; replay the rest deterministically
    this.pending = this.pending.filter((p) => p.seq > s.lastProcessedInput);
    const startMs = renderNowMs - this.pending.length * (1000 / 60);
    this.simNowMs = startMs;
    this.syncPrev(); // empty replay → prev = curr = snapshot (no interpolation stretch)
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      this.syncPrev();
      this.simNowMs += 1000 / 60;
      stepCar(this.sim, p.input, { cfg: this.cfg, dt: 1 / 60, nowMs: this.simNowMs });
      this.integrate();
    }
    this.lastPatchAt = performance.now();
  }

  /** one fixed prediction step with fresh input (also queued for the server) */
  step(input: DriveInput, nowMs: number): void {
    if (!Number.isFinite(this.simNowMs)) this.simNowMs = nowMs;
    else this.simNowMs += 1000 / 60;
    this.syncPrev();
    stepCar(this.sim, input, { cfg: this.cfg, dt: 1 / 60, nowMs: this.simNowMs });
    this.integrate();
  }

  /** mirror Rapier's integration: positions + angular velocity → rotation */
  private integrate(): void {
    const t = this.view.translation;
    const v = this.view.linvel;
    this.view.setTranslation({ x: t.x + v.x / 60, y: t.y + v.y / 60, z: t.z + v.z / 60 }, true);

    const w = this.view.angvel;
    const wMag = Math.hypot(w.x, w.y, w.z);
    if (wMag > 1e-6) {
      const q = this.view.rotation;
      const half = (wMag / 2) / 60; // angle/2 per step
      const axis = { x: w.x / wMag, y: w.y / wMag, z: w.z / wMag };
      const dq: Quat = {
        x: axis.x * Math.sin(half),
        y: axis.y * Math.sin(half),
        z: axis.z * Math.sin(half),
        w: Math.cos(half),
      };
      this.view.setRotation(quatNormalise(quatMul(q, dq)), true);
    }
  }

  /** rendered transform: the local sim is the truth unless ghosted */
  transform(): { pos: Vec3; quat: Quat } {
    return { pos: { ...this.view.translation }, quat: { ...this.view.rotation } };
  }

  /**
   * Sub-tick render pose (fixed 60 Hz sim → display cadence): alpha ∈ [0,1]
   * blends the previous tick state into the live one, so the car glides at
   * 45–144 Hz instead of stepping 1–2 ticks per rendered frame.
   * Sampled one tick behind "now" — equivalent to render time = wall − 16.7 ms,
   * which is C0-continuous no matter how frame times bounce around.
   */
  renderTransform(alpha: number): { pos: Vec3; quat: Quat } {
    const a = alpha <= 0 ? 0 : alpha >= 1 ? 1 : alpha;
    const t = this.view.translation;
    const p = this.prevPos;
    const pos = {
      x: p.x + (t.x - p.x) * a,
      y: p.y + (t.y - p.y) * a,
      z: p.z + (t.z - p.z) * a,
    };
    return { pos, quat: quatSlerp(this.prevQuat, this.view.rotation, a) };
  }
}

/** shortest-arc slerp (same math as three's Quaternion.slerp, no dependency) */
function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (dot > 0.9995) {
    // nearly parallel: normalised lerp is stable and indistinguishable
    const x = a.x + (bx - a.x) * t;
    const y = a.y + (by - a.y) * t;
    const z = a.z + (bz - a.z) * t;
    const w = a.w + (bw - a.w) * t;
    const n = Math.hypot(x, y, z, w) || 1;
    return { x: x / n, y: y / n, z: z / n, w: w / n };
  }
  const theta0 = Math.acos(Math.min(1, dot));
  const theta = theta0 * t;
  const sinTheta0 = Math.sin(theta0);
  const s0 = Math.sin(theta0 - theta) / sinTheta0;
  const s1 = Math.sin(theta) / sinTheta0;
  return {
    x: a.x * s0 + bx * s1,
    y: a.y * s0 + by * s1,
    z: a.z * s0 + bz * s1,
    w: a.w * s0 + bw * s1,
  };
}
