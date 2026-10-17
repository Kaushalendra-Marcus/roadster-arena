/** find the phantom surface near the loop ramp foot (x≈98.6) */
import RAPIER from "@dimforge/rapier3d-compat";
import { DEFAULT_GAMEPLAY } from "@roadster-arena/shared";
import { SimWorld } from "./src/physics/world.js";

await RAPIER.init();
const cfg = DEFAULT_GAMEPLAY;
const world = new SimWorld(RAPIER, cfg);
for (const y of [3.5, 3.0, 2.5, 2.0, 1.5, 1.2, 1.0, 0.9, 0.8, 0.7]) {
  const r = new RAPIER.Ray({ x: 98.6, y, z: 120 }, { x: 0, y: -1, z: 0 });
  const hit = world.world.castRayAndGetNormal(r, 0.4, true);
  if (hit)
    console.log(
      `from y=${y} -> toi ${hit.timeOfImpact.toFixed(3)} surface y=${(y - hit.timeOfImpact).toFixed(3)} n=(${hit.normal.x.toFixed(2)}, ${hit.normal.y.toFixed(2)}, ${hit.normal.z.toFixed(2)})`,
    );
  else console.log(`from y=${y} -> null`);
}
world.free();
