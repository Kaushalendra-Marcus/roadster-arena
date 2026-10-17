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
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      stepCar(this.sim, p.input, { cfg: this.cfg, dt: 1 / 60, nowMs: startMs + i * (1000 / 60) });
      this.integrate();
    }
    this.lastPatchAt = performance.now();
  }

  /** one fixed prediction step with fresh input (also queued for the server) */
  step(input: DriveInput, nowMs: number): void {
    stepCar(this.sim, input, { cfg: this.cfg, dt: 1 / 60, nowMs });
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
}
