/**
 * Client-side physics queries (spec 5.3): a Rapier world holding ONLY the
 * static arena geometry, built from the same shared map definition the server
 * uses, so the predicted car's surface probes return what the server's probes
 * return (same colliders, deterministic). No dynamic bodies live here —
 * car-vs-car and car-vs-wall resolution stays server-authoritative.
 */

import RAPIER, { ColliderDesc } from "@dimforge/rapier3d-compat";
import { buildArenaDef, type GameplayConfig } from "@roadster-arena/shared";

export interface SurfaceHit {
  hit: true;
  toi: number;
  normal: { x: number; y: number; z: number };
}

export interface PhysQuery {
  castRay(
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxToi: number,
  ): SurfaceHit | null;
}

export async function initPhysQuery(cfg: GameplayConfig): Promise<PhysQuery> {
  await RAPIER.init();
  // zero gravity: nothing integrates here, only rays are cast (parity with
  // the server's SimWorld static setup)
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });

  const def = buildArenaDef(cfg);
  for (const collider of def.colliders) {
    const desc =
      "vertices" in collider
        ? ColliderDesc.trimesh(new Float32Array(collider.vertices), new Uint32Array(collider.indices))
        : ColliderDesc.cuboid(collider.half.x, collider.half.y, collider.half.z);
    desc.setTranslation(collider.pos.x, collider.pos.y, collider.pos.z);
    if (!("vertices" in collider) && collider.axis && (collider.angle ?? 0) !== 0) {
      const a = (collider.angle ?? 0) / 2;
      const ha = a;
      desc.setRotation({
        x: collider.axis === "x" ? Math.sin(ha) : 0,
        y: collider.axis === "y" ? Math.sin(ha) : 0,
        z: collider.axis === "z" ? Math.sin(ha) : 0,
        w: Math.cos(ha),
      });
    }
    // default interaction groups: the query world holds nothing but static
    // geometry, so every ray sees everything
    world.createCollider(desc);
  }

  return {
    castRay(origin, dir, maxToi) {
      const r = new RAPIER.Ray(origin, dir);
      const hit = world.castRayAndGetNormal(r, maxToi, true);
      if (!hit) return null;
      // Rapier orients the normal opposite the ray (toward the ray origin) —
      // exactly what the controller's pin spring expects.
      return { hit: true, toi: hit.timeOfImpact, normal: { ...hit.normal } };
    },
  };
}
