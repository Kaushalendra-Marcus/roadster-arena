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
  /** client hint: a GLB kit model wraps this footprint, so the client skips
   *  its procedural facade/window dressing (the shell replaces it) */
  kit?: boolean;
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

// ============================== city layout ================================
// Single source of truth for the whole city: the server turns THEME_BUILDINGS
// into Rapier colliders, the client renders streets, props and building kits
// from these same tables. All values are metres, deterministic, no randomness.

/** street centrelines on both axes (ring + two avenues + centre road) */
export const CITY_STREET_LINES = [-260, -144, 0, 144, 260] as const;
/** half width of every street (18 m carriageway) */
export const CITY_STREET_HALF = 9;

export type CityTheme =
  | "towers"
  | "offices"
  | "civic"
  | "hospital"
  | "shops"
  | "homes"
  | "industry"
  | "solar"
  | "park"
  | "curlPark"
  | "showroom";

export interface CityCell {
  x: number;
  z: number;
  /** half extent of the block (edge-to-edge of the street sidewalks) */
  half: number;
  theme: CityTheme;
}

export interface CityBuilding {
  dx: number;
  dz: number;
  /** half extents + height (y is in the builder) */
  hw: number;
  hd: number;
  h: number;
}

/** inner cells sit between the centre road and the avenues (band 126 wide),
 *  outer cells between the avenues and the ring road (band 98 wide) */
export const CITY_CELLS: CityCell[] = [
  // north row (z = -202 / -72)
  { x: -202, z: -202, half: 49, theme: "solar" },
  { x: -72, z: -202, half: 49, theme: "park" },
  { x: 72, z: -202, half: 49, theme: "civic" },
  { x: 202, z: -202, half: 49, theme: "hospital" },
  { x: -202, z: -72, half: 49, theme: "shops" },
  { x: -72, z: -72, half: 63, theme: "towers" },
  { x: 72, z: -72, half: 63, theme: "offices" },
  { x: 202, z: -72, half: 49, theme: "industry" },
  // south row (z = 72 / 202)
  { x: -202, z: 72, half: 49, theme: "towers" },
  { x: -72, z: 72, half: 63, theme: "homes" },
  { x: 72, z: 72, half: 63, theme: "curlPark" },
  { x: 202, z: 72, half: 49, theme: "showroom" },
  { x: -202, z: 202, half: 49, theme: "industry" },
  { x: -72, z: 202, half: 49, theme: "homes" },
  { x: 72, z: 202, half: 49, theme: "shops" },
  { x: 202, z: 202, half: 49, theme: "homes" },
];

/** building footprints per theme (offsets relative to the cell centre) */
export const THEME_BUILDINGS: Record<CityTheme, CityBuilding[]> = {
  // kit-covered cells: every footprint below is sized to its source model's
  // aspect ratio (matches KIT_SLOTS in client/src/city.ts) so the uniform
  // fit lands 1:1 and the visible shell wraps the collider exactly. All 19
  // buildings of new_york_buildings.glb are placed somewhere in the city.
  towers: [
    { dx: -30, dz: 0, hw: 3.64, hd: 3.64, h: 48 }, // Empire State
    { dx: 24, dz: -26, hw: 3.32, hd: 3.32, h: 42 }, // Woolworth
    { dx: 26, dz: 27, hw: 3.11, hd: 3.21, h: 46 }, // Chrysler
    { dx: -6, dz: -30, hw: 2.27, hd: 4.11, h: 44 }, // New York Times
    { dx: 2, dz: 12, hw: 3.24, hd: 12.13, h: 44 }, // tower one (slab)
    { dx: -34, dz: 34, hw: 4.2, hd: 10.49, h: 30 }, // MetLife
  ],
  offices: [
    { dx: -24, dz: -24, hw: 2.64, hd: 2.71, h: 40 }, // g2 glass tower
    { dx: 22, dz: 0, hw: 5.15, hd: 3.28, h: 32 }, // g5 glass slab
    { dx: -22, dz: 26, hw: 2.66, hd: 2.92, h: 34 }, // g6 glass tower
    { dx: 0, dz: -34, hw: 3.94, hd: 3.94, h: 20 }, // g4 mid-rise
    { dx: 40, dz: 24, hw: 3.16, hd: 3.16, h: 38 }, // g3 glass tower
    { dx: -40, dz: 0, hw: 3.06, hd: 3.06, h: 36 }, // g1 tower
  ],
  civic: [
    { dx: -20, dz: -20, hw: 3.86, hd: 8.37, h: 14 }, // Flatiron (police HQ)
    { dx: 26, dz: 24, hw: 1.82, hd: 3.0, h: 11 }, // precinct annex
  ],
  hospital: [
    { dx: -8, dz: -6, hw: 5.74, hd: 5.74, h: 26 }, // modern night tower
    { dx: 22, dz: 14, hw: 2.48, hd: 7.46, h: 12 }, // ward wing
  ],
  shops: [
    { dx: -32, dz: -30, hw: 1.77, hd: 1.77, h: 13 }, // b1 brownstone
    { dx: 30, dz: -32, hw: 2.93, hd: 5.28, h: 11 }, // b2
    { dx: 33, dz: 30, hw: 1.8, hd: 3.95, h: 14 }, // b4
    { dx: -30, dz: 32, hw: 2.29, hd: 3.39, h: 11 }, // b6
  ],
  homes: [
    { dx: -30, dz: -28, hw: 4.5, hd: 3.5, h: 6.5 },
    { dx: -16, dz: -31, hw: 4.5, hd: 3.5, h: 6 },
    { dx: -32, dz: -8, hw: 4.5, hd: 3.5, h: 7 },
    { dx: 6, dz: -20, hw: 5, hd: 4, h: 7.5 },
    { dx: -14, dz: 6, hw: 4.5, hd: 3.5, h: 6 },
    { dx: 16, dz: -4, hw: 5, hd: 4, h: 6.5 },
    { dx: 28, dz: -24, hw: 4.5, hd: 3.5, h: 6 },
    { dx: 30, dz: 12, hw: 4.5, hd: 3.5, h: 6.5 },
  ],
  industry: [
    { dx: -20, dz: -18, hw: 17, hd: 12, h: 13 },
    { dx: 16, dz: 16, hw: 14, hd: 10, h: 10 },
    { dx: -34, dz: 14, hw: 3.5, hd: 2.2, h: 1.3 },
    { dx: 26, dz: 2, hw: 3.5, hd: 2.2, h: 1.3 },
    { dx: 32, dz: -12, hw: 3.5, hd: 2.2, h: 1.3 },
  ],
  showroom: [{ dx: -30, dz: 34, hw: 6, hd: 5, h: 7 }],
  solar: [],
  park: [],
  curlPark: [],
};

/** themes whose buildings are wrapped by a GLB kit model on the client */
const KIT_THEMES: ReadonlySet<CityTheme> = new Set(["towers", "offices", "civic", "hospital", "shops"]);

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

  // --- authored city grid: 16 thematic cells around the central roundabout --
  // Every themed building below gets an authoritative Rapier collider; the
  // client renders the same table (plus streets, trees and props) from the
  // exported constants above, so physics and visuals can never drift apart.
  // Kit themes get a GLB shell on the client; the flag tells it to skip the
  // procedural facade dressing that those shells would otherwise hide.
  for (const cell of CITY_CELLS) {
    const kit = KIT_THEMES.has(cell.theme);
    for (const b of THEME_BUILDINGS[cell.theme]) {
      colliders.push({
        kind: "block",
        pos: { x: cell.x + b.dx, y: b.h / 2, z: cell.z + b.dz },
        half: { x: b.hw, y: b.h / 2, z: b.hd },
        kit,
      });
    }
  }

  // roundabout fountain island on the spawn plaza
  colliders.push({
    kind: "block",
    pos: { x: 0, y: 1.3, z: 0 },
    half: { x: 5, y: 1.3, z: 5 },
  });

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
