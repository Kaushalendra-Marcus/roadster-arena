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

  // --- ring gate boost impulse direction (stage direction of travel) ---------
  // three ring gates floating over the park (spec 8: "ring gates in the air")
  gates.push(
    { pos: { x: -20, y: 10, z: 120 }, forward: { x: 0, y: 0, z: -1 }, radius: 6 },
    { pos: { x: -150, y: 14, z: -40 }, forward: { x: 1, y: 0, z: 0 }, radius: 6 },
    { pos: { x: 40, y: 18, z: -140 }, forward: { x: 0.4, y: 0, z: 0.9 }, radius: 7 },
  );

  // --- twin jump ramps (one runway x -127..-93, two 40° slopes) --------------
  // The controller rides slopes it can catch (~≤45°), so the launch feature is
  // a straight wedge: drive up, launch off the apex, land down the far side.
  {
    const z0 = 105;
    const z1 = 115;
    const x0 = -127;
    const x1 = -110; // apex
    const x2 = -93;
    const h = 14;
    const verts: number[] = [
      x0, 0.05, z0, x0, 0.05, z1, x1, h, z0, x1, h, z1, // up-slope quad
      x1, h, z0, x1, h, z1, x2, 0.05, z0, x2, 0.05, z1, // down-slope quad
    ];
    const idx = [0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6];
    colliders.push({
      kind: "ramp",
      pos: { x: 0, y: 0, z: 0 },
      vertices: verts,
      indices: idx,
    });
  }

  // --- full vertical loop as ONE continuous ride surface ----------------------
  // The ray-pin controller follows whatever surface its −up ray hits first, so
  // the ramp must BE the loop's bottom: an ease curve rises tangentially into
  // the ring's lowest point, and the ring's left branch stops high enough that
  // the arch never cuts through a car riding the ramp below it. Hold GRIP to
  // round the loop; riding off the left branch's end launches you back out.
  {
    const loopX = 130;
    const loopZ = 120;
    const R = 17;
    const cy = R + 7; // ring centre; bottom apex (loopX, 7)
    const width = 10; // across z
    const cx0 = 95; // approach start
    const apexY = 7; // cy - R
    const zA = loopZ - width / 2;
    const zB = loopZ + width / 2;

    // stations: ease ramp from (95, 0.05) to the apex (130, 7), then the ring
    // a from π (bottom) DOWN to π/2 (right side) and on to ≈ -2.55 rad
    // (150° past the top), stopped at y ≈ 9.5 so the dead end is ~2.5 m
    // above any car riding the ramp beneath it.
    const aEnd = Math.acos((9.5 - cy) / R) * -1; // ≈ -2.55 rad
    const stations: { x: number; y: number }[] = [];
    const rampSegs = 24;
    // Fine ring tessellation: the coarse 26-segment ring turned ~17° per
    // facet — at racing speed every facet lip was a drop the collider
    // crashed into. 176 segments ≈ 4° per facet keeps the ride smooth.
    const ringSegs = 176;
    // ease from a flush 0.05 lip to the apex; the lip is tiny enough that the
    // contact solver just nudges the car onto the surface (full burial made
    // the trimesh pierce the box from below and punch it into the sky)
    for (let s = 0; s <= rampSegs; s++) {
      const t = s / rampSegs;
      const x = cx0 + (loopX - cx0) * t;
      const y = 0.05 + (apexY - 0.05) * ((1 - Math.cos(Math.PI * t)) / 2);
      stations.push({ x, y });
    }
    for (let s = 1; s <= ringSegs; s++) {
      const a = Math.PI + ((aEnd - Math.PI) * s) / ringSegs;
      stations.push({ x: loopX + R * Math.sin(a), y: Math.max(0.05, cy + R * Math.cos(a)) });
    }

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
      // low friction: steep loop walls have no business holding a
      // non-gripping car (that parked cars mid-wall forever), and gentler
      // contact friction means the fast entry bites don't eat the whole ride
      friction: 0.45,
      vertices: verts,
      indices: idx,
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
