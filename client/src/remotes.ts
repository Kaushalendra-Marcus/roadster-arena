/**
 * Remote players (spec 5.4): each state patch appends a snapshot with its
 * arrival time. Rendering samples the buffer `delayMs` in the past and
 * interpolates, so remotes glide instead of teleporting at 20 Hz.
 */

import type { Vec3 } from "@roadster-arena/shared";

type Quat = { x: number; y: number; z: number; w: number };

interface RemoteSample {
  arrivedAt: number; // performance.now() of the patch
  pos: Vec3;
  quat: Quat;
  vel: Vec3;
  mode: string;
}

export class RemoteInterp {
  private samples: RemoteSample[] = [];
  private readonly maxSamples = 12;

  constructor(
    public readonly id: string,
    private delayMs: number,
  ) {}

  /** how far the remote buffer trails behind live time */
  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  push(arrivedAt: number, s: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; vx: number; vy: number; vz: number; mode: string }): void {
    this.samples.push({
      arrivedAt,
      pos: { x: s.x, y: s.y, z: s.z },
      quat: { x: s.qx, y: s.qy, z: s.qz, w: s.qw },
      vel: { x: s.vx, y: s.vy, z: s.vz },
      mode: s.mode,
    });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  clear(): void {
    this.samples.length = 0;
  }

  /** newest raw sample (velocity used for remote wheel spin) */
  latestVel(): Vec3 | null {
    const last = this.samples[this.samples.length - 1];
    return last ? last.vel : null;
  }

  /** sample position/quaternion for rendering right now */
  render(nowMs: number): { pos: Vec3; quat: Quat; mode: string; hasData: boolean } {
    if (this.samples.length === 0) {
      return { pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 }, mode: "ground", hasData: false };
    }
    if (this.samples.length === 1) {
      const s = this.samples[0];
      return this.extrapolate(s, s, 0, 0);
    }
    const target = nowMs - this.delayMs;
    // find the pair surrounding `target`; newest-last order
    let a = this.samples[0];
    let b = this.samples[this.samples.length - 1];
    for (let i = 0; i < this.samples.length - 1; i++) {
      if (this.samples[i].arrivedAt <= target && this.samples[i + 1].arrivedAt >= target) {
        a = this.samples[i];
        b = this.samples[i + 1];
        break;
      }
    }
    const span = b.arrivedAt - a.arrivedAt;
    const t = span > 0 ? Math.min(1, Math.max(0, (target - a.arrivedAt) / span)) : 1;

    // underrun: target is past the newest sample — dead reckon forward
    if (target > b.arrivedAt) {
      const over = Math.min(250, target - b.arrivedAt); // hard cap 250 ms
      return this.extrapolate(b, b, 1, over);
    }
    return this.extrapolate(a, b, t, 0);
  }

  private extrapolate(a: RemoteSample, b: RemoteSample, t: number, extraMs: number): { pos: Vec3; quat: Quat; mode: string; hasData: boolean } {
    const pos: Vec3 = {
      x: a.pos.x + (b.pos.x - a.pos.x) * t,
      y: a.pos.y + (b.pos.y - a.pos.y) * t,
      z: a.pos.z + (b.pos.z - a.pos.z) * t,
    };
    // slerp via nlerp (quats stay near-identical small deltas)
    let qa = a.quat;
    const qb = b.quat;
    if (qa.x * qb.x + qa.y * qb.y + qa.z * qb.z + qa.w * qb.w < 0) {
      qa = { x: -qa.x, y: -qa.y, z: -qa.z, w: -qa.w };
    }
    const quat: Quat = {
      x: qa.x + (qb.x - qa.x) * t,
      y: qa.y + (qb.y - qa.y) * t,
      z: qa.z + (qb.z - qa.z) * t,
      w: qa.w + (qb.w - qa.w) * t,
    };
    const l = Math.hypot(quat.x, quat.y, quat.z, quat.w) || 1;
    quat.x /= l;
    quat.y /= l;
    quat.z /= l;
    quat.w /= l;
    if (extraMs > 0) {
      const s = extraMs / 1000;
      pos.x += b.vel.x * s;
      pos.y += b.vel.y * s;
      pos.z += b.vel.z * s;
    }
    return { pos, quat, mode: b.mode, hasData: true };
  }
}
