/**
 * Kit-wrap invariant: every themed building in a GLB-covered cell must have
 * its Rapier collider box fully inside the model's fitted shell, and the
 * uniform fit must be decided by the height clamp (the footprint is aspect-
 * matched) so no model is squashed or under-scaled into a hidden gray box.
 *
 * Guards the triangle of truth: maps.ts THEME_BUILDINGS ↔ client/src/city.ts
 * KIT_SLOTS ↔ the reference GLBs in client/public/assets.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import * as THREE from "three";
import { CITY_CELLS, THEME_BUILDINGS } from "@roadster-arena/shared";

const KIT_URL = new URL("../client/public/assets/reference/new_york_buildings.glb", import.meta.url);
const NIGHT_URL = new URL("../client/public/assets/reference/modern_night_building_game-ready.glb", import.meta.url);

// mirrors city.ts KIT_SLOTS (the kit model per footprint slot)
const KIT_SLOTS: Record<string, string[]> = {
  towers: ["emp_state", "woolworth", "christler", "new_york_times", "tower_one", "metlife"],
  offices: ["g2", "g5", "g6", "g4", "g3", "g1"],
  shops: ["b1", "b2", "b4", "b6"],
  civic: ["flatiron", "b3"],
  hospital: ["", "b5"], // slot 0 is the modern-night tower (own loader)
};

// ---------------------------------------------------------------- glb tools

interface Gltf {
  nodes: {
    name?: string;
    mesh?: number;
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    children?: number[];
  }[];
  meshes: { primitives: { attributes: { POSITION: number } }[] }[];
  accessors: { min?: number[]; max?: number[] }[];
  scenes: { nodes: number[] }[];
}

function gltfJson(url: URL): Gltf {
  const buf = fs.readFileSync(url);
  return JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8"));
}

function nodeMatrix(n: Gltf["nodes"][number]): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (n.matrix) return m.fromArray(n.matrix);
  return m.compose(
    new THREE.Vector3(...((n.translation ?? [0, 0, 0]) as [number, number, number])),
    new THREE.Quaternion(...((n.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])),
    new THREE.Vector3(...((n.scale ?? [1, 1, 1]) as [number, number, number])),
  );
}

/** world-space bbox of a node subtree (min/max accessors + node transforms) */
function subtreeBox(j: Gltf, idx: number, parent: THREE.Matrix4): THREE.Box3 | null {
  const n = j.nodes[idx];
  const world = parent.clone().multiply(nodeMatrix(n));
  if (n.mesh !== undefined) {
    const box = new THREE.Box3();
    for (const prim of j.meshes[n.mesh].primitives) {
      const acc = j.accessors[prim.attributes.POSITION];
      if (!acc?.min || !acc?.max) continue;
      const b = new THREE.Box3(new THREE.Vector3(...(acc.min as [number, number, number])), new THREE.Vector3(...(acc.max as [number, number, number])));
      for (const cx of [b.min.x, b.max.x])
        for (const cy of [b.min.y, b.max.y])
          for (const cz of [b.min.z, b.max.z]) box.expandByPoint(new THREE.Vector3(cx, cy, cz).applyMatrix4(world));
    }
    return box.isEmpty() ? null : box;
  }
  let out: THREE.Box3 | null = null;
  for (const c of n.children ?? []) {
    const b = subtreeBox(j, c, world);
    if (b) out = out ? out.union(b) : b;
  }
  return out;
}

/** whole-scene bbox size */
function wholeSize(url: URL): THREE.Vector3 {
  const j = gltfJson(url);
  let box: THREE.Box3 | null = null;
  for (const root of j.scenes[0].nodes) {
    const b = subtreeBox(j, root, new THREE.Matrix4());
    if (b) box = box ? box.union(b) : b;
  }
  return box!.getSize(new THREE.Vector3());
}

/** each child of GLTF_SceneRootNode as a named variant */
function variants(url: URL): Map<string, THREE.Vector3> {
  const j = gltfJson(url);
  const rootName = "GLTF_SceneRootNode";
  const rootIdx = j.nodes.findIndex((n) => n.name === rootName);
  // compose the ancestors of the kit root so the variants land in world space
  const chain: number[] = [];
  const findChain = (idx: number): boolean => {
    if (idx === rootIdx) return true;
    for (const c of j.nodes[idx].children ?? []) {
      if (findChain(c)) {
        chain.unshift(idx);
        return true;
      }
    }
    return false;
  };
  for (const r of j.scenes[0].nodes) if (findChain(r)) break;
  const base = new THREE.Matrix4();
  for (const ci of chain) base.multiply(nodeMatrix(j.nodes[ci]));
  base.multiply(nodeMatrix(j.nodes[rootIdx]));

  const out = new Map<string, THREE.Vector3>();
  for (const c of j.nodes[rootIdx].children ?? []) {
    const b = subtreeBox(j, c, base);
    if (b) out.set(j.nodes[c].name ?? `#${c}`, b.getSize(new THREE.Vector3()));
  }
  return out;
}

// ---------------------------------------------------------------- the checks

describe("city kit wrap", () => {
  const sizes = variants(KIT_URL);

  it("every KIT_SLOTS model exists in new_york_buildings.glb", () => {
    for (const slots of Object.values(KIT_SLOTS)) {
      for (const prefix of slots) {
        if (!prefix) continue; // the hospital's modern-night slot
        expect([...sizes.keys()].some((k) => k.startsWith(prefix)), `variant ${prefix}`).toBe(true);
      }
    }
  });

  it("the 19 kit buildings + modern night are all placed exactly once", () => {
    const placed = Object.values(KIT_SLOTS).flat().filter(Boolean).map((p) => [...sizes.keys()].find((k) => k.startsWith(p))!);
    expect(new Set(placed).size).toBe(sizes.size); // every variant used
    expect(placed.length).toBe(sizes.size); // and none twice
    const night = wholeSize(NIGHT_URL);
    expect(night.y).toBeGreaterThan(0);
  });

  it("kit shells wrap their colliders (aspect-matched footprints)", () => {
    const night = wholeSize(NIGHT_URL);
    for (const cell of CITY_CELLS) {
      const slots = KIT_SLOTS[cell.theme];
      THEME_BUILDINGS[cell.theme].forEach((b, i) => {
        // hospital slot 0 is the modern-night tower with its own loader
        const special = cell.theme === "hospital" && i === 0;
        const prefix = special ? "" : slots?.[i];
        if (!special && !prefix) return;
        const size = special ? night : sizes.get([...sizes.keys()].find((k) => k.startsWith(prefix!))!)!;
        // exactly city.ts buildingKits(): uniforms fit, +0.6 inflation on the
        // plan and 6 % + 0.5 m on the height
        const s = Math.min((b.hw * 2 + 0.6) / size.x, (b.hd * 2 + 0.6) / size.z, (b.h * 1.06 + 0.5) / size.y);
        const visual = size.clone().multiplyScalar(s);
        const label = `${cell.theme}[${i}] ${special ? "modern_night" : prefix}`;
        expect(visual.x, `${label} width`).toBeGreaterThanOrEqual(b.hw * 2);
        expect(visual.z, `${label} depth`).toBeGreaterThanOrEqual(b.hd * 2);
        expect(visual.y, `${label} height`).toBeGreaterThanOrEqual(b.h);
        // height clamp decides the scale (footprint aspect-matched, floored to
        // wrap): the plan clamp may only shave < 2 % off — no real squashing
        const allowY = (b.h * 1.06 + 0.5) / size.y;
        expect(Math.abs(s - allowY) / allowY, `${label} aspect`).toBeLessThan(0.02);
      });
    }
  });

  it("footprints never overlap inside a cell", () => {
    for (const cell of CITY_CELLS) {
      const list = THEME_BUILDINGS[cell.theme];
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const A = list[a];
          const B = list[b];
          const clash =
            Math.abs(A.dx - B.dx) < A.hw + B.hw && Math.abs(A.dz - B.dz) < A.hd + B.hd;
          expect(clash, `${cell.theme} ${a}~${b}`).toBe(false);
        }
      }
    }
  });

  it("kit footprints stay on their block plate", () => {
    for (const cell of CITY_CELLS) {
      const plate = cell.half - 4; // plate = half*2 − 8, centered
      THEME_BUILDINGS[cell.theme].forEach((b, i) => {
        expect(Math.abs(b.dx) + b.hw, `${cell.theme}[${i}] x`).toBeLessThanOrEqual(plate);
        expect(Math.abs(b.dz) + b.hd, `${cell.theme}[${i}] z`).toBeLessThanOrEqual(plate);
      });
    }
  });
});
