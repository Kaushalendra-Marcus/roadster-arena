/**
 * Arena geometry (spec 8) — one map, ~600×600 m, described once here as plain
 * data so the server (Rapier colliders), the client (three.js meshes) and the
 * automated tests derive their views from the exact same primitives.
 *
 * The function has no randomness and no environment access: build it on both
 * sides and you get bit-identical spawn points, gate positions and colliders.
 */

import { ARENA_HALF, SPAWN_RING_RADIUS, SPAWN_COUNT } from "./constants.js";
import type { GameplayConfig } from "./config.js";

export type Vec3 = { x: number; y: number; z: number };

export interface BoxDef {
  kind: "wall" | "ground" | "block" | "ramp" | "gripTrack";
  pos: Vec3;
  /** half extents */
  half: Vec3;
  /** rotation as axis-angle (single axis is enough for our primitives) */
  axis?: "x" | "y" | "z";
  angle?: number;
  /** restitution override for this collider */
  restitution?: number;
}

export interface TrimeshDef {
  kind: "ramp" | "loop" | "gripTrack";
  pos: Vec3;
  vertices: number[]; // flat xyz
  indices: number[];
  restitution?: number;
}

export interface GateDef {
  pos: Vec3;
  forward: Vec3; // flight direction when passing through
  radius: number;
}

export type ColliderDef = BoxDef | TrimeshDef;

export interface ArenaDef {
  colliders: ColliderDef[];
  gates: GateDef[];
  spawnPoints: Vec3[];
  spawnQuat: { x: number; y: number; z: number; w: number }[];
}

const TAU = Math.PI * 2;

/** Build the full arena primitive list. Deterministic. */
export function buildArenaDef(cfg: GameplayConfig): ArenaDef {
  const colliders: ColliderDef[] = [];
  const gates: GateDef[] = [];

  // --- ground: single big plaza-level slab so cars rarely fall off ------------
  colliders.push({
    kind: "ground",
    pos: { x: 0, y: -0.5, z: 0 },
    half: { x: ARENA_HALF, y: 0.5, z: ARENA_HALF },
  });

  // --- invisible containment walls (soft inner force is applied in physics) --
  const wallH = 18;
  for (const [i, rotY] of [0, Math.PI / 2, Math.PI, Math.PI * 1.5].entries()) {
    const dx = i === 1 ? ARENA_HALF + 1 : i === 3 ? -(ARENA_HALF + 1) : 0;
    const dz = i === 0 ? ARENA_HALF + 1 : i === 2 ? -(ARENA_HALF + 1) : 0;
    colliders.push({
      kind: "wall",
      pos: { x: dx, y: wallH / 2, z: dz },
      half:
        i % 2 === 0
          ? { x: ARENA_HALF + 40, y: wallH / 2, z: 1 }
          : { x: 1, y: wallH / 2, z: ARENA_HALF + 40 },
      angle: rotY,
      restitution: cfg.arena.wallRestitution,
    });
  }

  // --- stacked blocks near the plaza (truck-jump homage) ---------------------
  const blockSpecs: { pos: Vec3; half: Vec3; angle?: number }[] = [
    { pos: { x: 64, y: 1, z: -18 }, half: { x: 9, y: 1, z: 4.5 } },
    { pos: { x: 78, y: 2.4, z: -18 }, half: { x: 9, y: 2.4, z: 4.5 } },
    { pos: { x: 92, y: 3.8, z: -18 }, half: { x: 9, y: 3.8, z: 4.5 } },
  ];
  for (const b of blockSpecs) colliders.push({ kind: "block", ...b });

  // --- ring gate boost impulse direction (stage direction of travel) ---------
  // three ring gates floating over the park (spec 8: "ring gates in the air")
  gates.push(
    { pos: { x: -20, y: 10, z: 120 }, forward: { x: 0, y: 0, z: -1 }, radius: 6 },
    { pos: { x: -150, y: 14, z: -40 }, forward: { x: 1, y: 0, z: 0 }, radius: 6 },
    { pos: { x: 40, y: 18, z: -140 }, forward: { x: 0.4, y: 0, z: 0.9 }, radius: 7 },
  );

  // --- curved launch ramp (quarter-pipe, rise to 12 m) ------------------------
  // approximated as a trimesh strip
  {
    const arcCX = -110;
    const arcCZ = 110;
    const R = 14;
    const width = 10; // across the runway → z
    const segs = 24;
    const verts: number[] = [];
    const idx: number[] = [];
    // walk the arc from angle 250° down to -20° (quarter-ish sweep)
    const a0 = Math.PI * 0.95;
    const a1 = Math.PI * 0.0;
    for (let s = 0; s <= segs; s++) {
      const a = a0 + ((a1 - a0) * s) / segs;
      // arc centre at (0,0) local; points on arc x = cx + R cos a, y = cy + R sin a
      const px = R * Math.cos(a);
      const py = Math.max(0.05, R + R * Math.sin(a));
      verts.push(arcCX + px, py, arcCZ - width / 2);
      verts.push(arcCX + px, py, arcCZ + width / 2);
    }
    for (let s = 0; s < segs; s++) {
      const o = s * 2;
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
    colliders.push({
      kind: "ramp",
      pos: { x: 0, y: 0, z: 0 },
      vertices: verts,
      indices: idx,
    });
  }

  // --- full loop (vertical circular track you drive around the inside) -------
  {
    const loopX = 130;
    const loopZ = 120;
    const R = 17;
    const width = 10;
    const rampLen = 22; // straight-ish entry that lifts you to the loop start
    const segs = 36;
    const verts: number[] = [];
    const idx: number[] = [];
    for (let s = 0; s <= segs; s++) {
      const a = (TAU * s) / segs;
      const cx = loopX;
      const cy = R + 2;
      const px = cx + R * Math.sin(a);
      const py = Math.max(0.05, cy + R * Math.cos(a));
      verts.push(px, py, loopZ - width / 2);
      verts.push(px, py, loopZ + width / 2);
    }
    for (let s = 0; s < segs; s++) {
      const o = s * 2;
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
    // entry ramp
    const entryVerts: number[] = [
      loopX - R - rampLen, 0.05, loopZ - width / 2,
      loopX - R - rampLen, 0.05, loopZ + width / 2,
      loopX - R, R * 0.62, loopZ - width / 2,
      loopX - R, R * 0.62, loopZ + width / 2,
    ];
    const entryIdx = [0, 1, 2, 1, 3, 2];
    colliders.push({
      kind: "loop",
      pos: { x: 0, y: 0, z: 0 },
      vertices: [...verts, ...entryVerts],
      indices: [...idx, ...entryIdx.map((i) => i + 2 * (segs + 1))],
    });
  }

  // --- upside-down grip tube (a tunnel whose ceiling you drive along) --------
  {
    const ux = -60;
    const uz = -110;
    const len = 56;
    const halfW = 5;
    const rise = 11; // tunnel ceiling height
    colliders.push(
      // tunnel floor
      {
        kind: "gripTrack",
        pos: { x: ux, y: 0.05, z: uz },
        half: { x: len / 2, y: 0.05, z: halfW },
      },
      // side walls
      {
        kind: "gripTrack",
        pos: { x: ux, y: 4, z: uz - halfW - 0.15 },
        half: { x: len / 2, y: 4, z: 0.15 },
      },
      {
        kind: "gripTrack",
        pos: { x: ux, y: 4, z: uz + halfW + 0.15 },
        half: { x: len / 2, y: 4, z: 0.15 },
      },
      // upside-down driving surface (the ceiling)
      {
        kind: "gripTrack",
        pos: { x: ux, y: rise, z: uz },
        half: { x: len / 2, y: 0.15, z: halfW },
        angle: undefined,
      },
    );
  }

  // --- deterministic spawn ring on the plaza ---------------------------------
  const spawnPoints: Vec3[] = [];
  const spawnQuat: { x: number; y: number; z: number; w: number }[] = [];
  for (let i = 0; i < SPAWN_COUNT; i++) {
    const a = (TAU * i) / SPAWN_COUNT;
    spawnPoints.push({
      x: Math.cos(a) * SPAWN_RING_RADIUS,
      y: 0.62,
      z: Math.sin(a) * SPAWN_RING_RADIUS,
    });
    // face outward from plaza centre
    const yaw = a + Math.PI / 2;
    spawnQuat.push({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
  }

  return { colliders, gates, spawnPoints, spawnQuat };
}
