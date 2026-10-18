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
  /** friction override for this collider (defaults to the world's 0.85) */
  friction?: number;
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
  /** friction override (the loop strip uses low friction so steep walls
   *  can't friction-park a non-gripping car — spec complaint: stuck cars) */
  friction?: number;
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

  // Deterministic city blocks. These are shared with the client renderer, so
  // every visible building has an authoritative Rapier collider.
  for (let x = -ARENA_HALF + 36; x <= ARENA_HALF - 36; x += 72) {
    for (let z = -ARENA_HALF + 36; z <= ARENA_HALF - 36; z += 72) {
      if (Math.abs(x) < 32 || Math.abs(z) < 32) continue;
      const w = 18 + ((x * 13 + z * 7) % 8 + 8) % 8;
      const d = 18 + ((x * 5 - z * 3) % 8 + 8) % 8;
      const h = 8 + ((x * 3 + z * 11) % 22 + 22) % 22;
      colliders.push({
        kind: "block",
        pos: { x, y: h / 2, z },
        half: { x: w / 2, y: h / 2, z: d / 2 },
      });
    }
  }

  // Roadster showroom landmark: a dedicated collision volume matching the
  // visible glass-front building in the client scene.
  colliders.push({
    kind: "block",
    pos: { x: 210, y: 7, z: 35 },
    half: { x: 15, y: 7, z: 9 },
  });

  // --- ring gate boost impulse direction (stage direction of travel) ---------
  // three ring gates floating over the park (spec 8: "ring gates in the air")
  gates.push(
    { pos: { x: 61, y: 34, z: 78 }, forward: { x: -1, y: 0, z: 0 }, radius: 4.5 },
    { pos: { x: -150, y: 14, z: -40 }, forward: { x: 1, y: 0, z: 0 }, radius: 6 },
    { pos: { x: 40, y: 18, z: -140 }, forward: { x: 0.4, y: 0, z: 0.9 }, radius: 7 },
  );

  // --- compact stunt ramp: reference-style open vertical C ------------------
  // This is intentionally not a closed circle. The supplied reference shows a
  // narrow launch ramp that sweeps from the floor into a tall wall and curls
  // back toward the rider at the top. A Bezier spine gives the same silhouette
  // while keeping the surface tangent-continuous for the grip controller.
  {
    const rampZ = 78;
    const width = 7;
    const zA = rampZ - width / 2;
    const zB = rampZ + width / 2;
    const p0 = { x: 68, y: 0.08 };
    const p1 = { x: 91, y: 0.08 };
    const p2 = { x: 108, y: 16 };
    const p3 = { x: 101, y: 28 };
    const p4 = { x: 96, y: 39 };
    const p5 = { x: 73, y: 41 };
    const p6 = { x: 61, y: 34 };
    const stations: { x: number; y: number }[] = [];
    const point = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) =>
      ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const cubic = (a: typeof p0, b: typeof p0, c: typeof p0, d: typeof p0, t: number) => {
      const u = 1 - t;
      return {
        x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
        y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
      };
    };
    const addCubic = (a: typeof p0, b: typeof p0, c: typeof p0, d: typeof p0, count: number) => {
      for (let i = 0; i <= count; i++) stations.push(cubic(a, b, c, d, i / count));
    };
    addCubic(p0, p1, p2, p3, 64);
    addCubic(p3, p4, p5, p6, 64);

    const verts: number[] = [];
    const idx: number[] = [];
    for (const st of stations) {
      verts.push(st.x, st.y, zA, st.x, st.y, zB);
    }
    for (let s = 0; s < stations.length - 1; s++) {
      const o = s * 2;
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
    colliders.push({
      kind: "gripTrack",
      pos: { x: 0, y: 0, z: 0 },
      friction: 0.7,
      vertices: verts,
      indices: idx,
    });
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
