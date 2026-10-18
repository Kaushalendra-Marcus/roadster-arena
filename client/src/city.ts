/**
 * City dressing (spec 8 companion): every visual that has no collider —
 * streets, lane dashes, crosswalks, sidewalks, per-cell plates, park and
 * basketball court, solar farm, pools, helipad, house roofs, trees, lamps,
 * parked cars, wind turbines, fountain — plus the GLB building kits and the
 * drifting hot-air balloons.
 *
 * Everything derives from the exported CITY tables in maps.ts (streets,
 * cells, themed footprints), so physics and visuals cannot drift apart.
 * Repeated props render through InstancedMesh; kits load async and only
 * wrap the footprints whose colliders are already authoritative.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  ARENA_HALF,
  CITY_CELLS,
  CITY_STREET_HALF,
  CITY_STREET_LINES,
  THEME_BUILDINGS,
  type CityCell,
} from "@roadster-arena/shared";

const STREET_LEN = ARENA_HALF * 2 - 24;

interface Item {
  x: number;
  y: number;
  z: number;
  rx?: number;
  ry?: number;
  rz?: number;
  s?: number;
  sy?: number;
  color?: number;
}

// deterministic little hash for variety without randomness
const hash = (a: number, b: number, m: number): number => {
  const v = Math.imul(a * 73856093 ^ b * 19349663, 0x27d4eb2d);
  return ((v >>> 8) % m + m) % m;
};

function instanced(
  scene: THREE.Scene,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  items: Item[],
  shadow = false,
): void {
  if (!items.length) return;
  const mesh = new THREE.InstancedMesh(geometry, material, items.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  let tinted = false;
  items.forEach((it, i) => {
    e.set(it.rx ?? 0, it.ry ?? 0, it.rz ?? 0);
    q.setFromEuler(e);
    p.set(it.x, it.y, it.z);
    s.set(it.s ?? 1, it.sy ?? it.s ?? 1, it.s ?? 1);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    if (it.color !== undefined) {
      c.setHex(it.color);
      mesh.setColorAt(i, c);
      tinted = true;
    }
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (tinted && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = shadow;
  mesh.receiveShadow = false;
  scene.add(mesh);
}

function addBox(
  scene: THREE.Scene,
  material: THREE.Material,
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number,
  ry = 0,
): void {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
  mesh.position.set(x, y, z);
  if (ry) mesh.rotation.y = ry;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// ============================== streets ====================================

function buildStreets(scene: THREE.Scene): void {
  const road = new THREE.MeshStandardMaterial({ color: 0x33383e, roughness: 0.95 });
  const sidewalk = new THREE.MeshStandardMaterial({ color: 0xa8afb3, roughness: 0.9 });
  const paint = new THREE.MeshBasicMaterial({ color: 0xf0efe9, transparent: true, opacity: 0.8 });

  for (const l of CITY_STREET_LINES) {
    addBox(scene, road, CITY_STREET_HALF * 2, 0.025, STREET_LEN, l, 0.03, 0);
    addBox(scene, road, STREET_LEN, 0.025, CITY_STREET_HALF * 2, 0, 0.032, l);
    for (const side of [1, -1]) {
      const off = (CITY_STREET_HALF + 2.2) * side;
      addBox(scene, sidewalk, 3.6, 0.02, STREET_LEN, l + off, 0.05, 0);
      addBox(scene, sidewalk, STREET_LEN, 0.02, 3.6, 0, 0.052, l + off);
    }
  }

  // centre dashes — every leg, skipping intersections
  const dashes: Item[] = [];
  for (const l of CITY_STREET_LINES) {
    for (let t = -ARENA_HALF + 22; t <= ARENA_HALF - 22; t += 12) {
      if (CITY_STREET_LINES.some((o) => Math.abs(t - o) < 22)) continue;
      dashes.push({ x: l, y: 0.062, z: t });
      dashes.push({ x: t, y: 0.064, z: l });
    }
  }
  instanced(scene, new THREE.BoxGeometry(0.3, 0.01, 5.2), paint, dashes);

  // zebra crossings at every avenue intersection
  const stripes: Item[] = [];
  for (const cx of [0, -144, 144]) {
    for (const cz of [0, -144, 144]) {
      for (let k = 0; k < 6; k++) {
        const across = -6.3 + k * 2.52;
        const depth = CITY_STREET_HALF + 2.4;
        stripes.push({ x: cx + across, y: 0.07, z: cz - depth });
        stripes.push({ x: cx + across, y: 0.07, z: cz + depth });
        stripes.push({ x: cx - depth, y: 0.07, z: cz + across, ry: Math.PI / 2 });
        stripes.push({ x: cx + depth, y: 0.07, z: cz + across, ry: Math.PI / 2 });
      }
    }
  }
  instanced(scene, new THREE.BoxGeometry(1.35, 0.012, 2.7), paint, stripes);
}

// ============================== cells ======================================

function buildCell(scene: THREE.Scene, cell: CityCell, cars: Item[]): void {
  const side = cell.half * 2 - 8; // keep street sidewalks visible around the block
  const plate = new THREE.MeshStandardMaterial({ color: 0x9ba3a8, roughness: 0.92 });
  addBox(scene, plate, side, 0.09, side, cell.x, 0.05, cell.z);

  switch (cell.theme) {
    case "park":
      buildPark(scene, cell);
      break;
    case "curlPark":
      addBox(scene, new THREE.MeshStandardMaterial({ color: 0x4e8f57, roughness: 0.95 }), side - 12, 0.05, side - 12, cell.x, 0.1, cell.z);
      break;
    case "homes":
      buildHomes(scene, cell);
      break;
    case "solar":
      buildSolar(scene, cell);
      break;
    case "hospital":
      buildHospitalDressing(scene, cell);
      break;
    case "civic":
      buildParkingLot(scene, cell, cars, 0x2f4a63);
      label(scene, "POLICE", "#1d3a5f", cell.x - 20, 13.2, cell.z - 11.15, 0.8);
      break;
    case "industry":
      label(scene, "STORAGE", "#7a4a12", cell.x - 20, 14.2, cell.z - 5.6, 0.8);
      break;
    case "shops":
      label(scene, "COFFEE HOUSE", "#7a3b1d", cell.x - 32, 10.2, cell.z - 27.4, 0.7);
      buildParkingLot(scene, cell, cars, 0x3a4450, 3);
      break;
    case "showroom":
      buildParkingLot(scene, cell, cars, 0x39414a);
      break;
    default:
      break; // towers / offices: the GLB kits carry the visuals
  }
}

function buildPark(scene: THREE.Scene, cell: CityCell): void {
  const grass = new THREE.MeshStandardMaterial({ color: 0x4e8f57, roughness: 0.95 });
  addBox(scene, grass, cell.half * 2 - 12, 0.05, cell.half * 2 - 12, cell.x, 0.1, cell.z);
  // court: red deck + white lines + two hoops
  const deck = new THREE.MeshStandardMaterial({ color: 0x9c4a44, roughness: 0.85 });
  addBox(scene, deck, 34, 0.06, 20, cell.x, 0.14, cell.z);
  const line = new THREE.MeshBasicMaterial({ color: 0xf4f2ea });
  addBox(scene, line, 34, 0.012, 0.35, cell.x, 0.17, cell.z - 10);
  addBox(scene, line, 34, 0.012, 0.35, cell.x, 0.17, cell.z + 10);
  addBox(scene, line, 0.35, 0.012, 20, cell.x - 17, 0.17, cell.z);
  addBox(scene, line, 0.35, 0.012, 20, cell.x + 17, 0.17, cell.z);
  addBox(scene, line, 0.3, 0.012, 20, cell.x, 0.17, cell.z);
  const circle = new THREE.Mesh(new THREE.RingGeometry(3.1, 3.4, 40), line);
  circle.rotation.x = -Math.PI / 2;
  circle.position.set(cell.x, 0.17, cell.z);
  scene.add(circle);
  const pole = new THREE.MeshStandardMaterial({ color: 0x4c5257, metalness: 0.5, roughness: 0.5 });
  for (const side of [-1, 1]) {
    const px = cell.x + side * 15.5;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 3.6, 8), pole);
    post.position.set(px, 1.8, cell.z);
    post.castShadow = true;
    scene.add(post);
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.15, 1.9), new THREE.MeshStandardMaterial({ color: 0xe8e6dd }));
    board.position.set(px - side * 0.45, 3.6, cell.z);
    board.castShadow = true;
    scene.add(board);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.06, 8, 20), new THREE.MeshStandardMaterial({ color: 0xd8571f }));
    ring.rotation.x = Math.PI / 2;
    ring.position.set(px - side * 1.15, 3.15, cell.z);
    scene.add(ring);
  }
}

function buildHomes(scene: THREE.Scene, cell: CityCell): void {
  const grass = new THREE.MeshStandardMaterial({ color: 0x55985c, roughness: 0.95 });
  addBox(scene, grass, cell.half * 2 - 12, 0.05, cell.half * 2 - 12, cell.x, 0.1, cell.z);
  const roofs = [0x5b6470, 0x8a5f4a, 0x6d4a4a, 0x4f5860];
  THEME_BUILDINGS.homes.forEach((b, i) => {
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(Math.hypot(b.hw, b.hd) * 1.24, 3.1, 4),
      new THREE.MeshStandardMaterial({ color: roofs[i % roofs.length], roughness: 0.9 }),
    );
    roof.rotation.y = Math.PI / 4;
    roof.position.set(cell.x + b.dx, b.h + 1.55, cell.z + b.dz);
    roof.castShadow = true;
    scene.add(roof);
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 2.1, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x37464f, roughness: 0.7 }),
    );
    door.position.set(cell.x + b.dx - b.hw * 0.4, 1.1, cell.z + b.dz + b.hd + 0.09);
    scene.add(door);
  });
}

function buildSolar(scene: THREE.Scene, cell: CityCell): void {
  const panel = new THREE.MeshStandardMaterial({ color: 0x18263d, metalness: 0.55, roughness: 0.35 });
  const rows: Item[] = [];
  for (let r = 0; r < 7; r++) {
    rows.push({ x: cell.x, y: 1.15, z: cell.z - 39 + r * 13, rx: -0.24 });
  }
  instanced(scene, new THREE.BoxGeometry(58, 0.24, 6.4), panel, rows, true);
}

function buildHospitalDressing(scene: THREE.Scene, cell: CityCell): void {
  // rooftop helipad lives in the kit loader (see buildingKits) where the
  // fitted tower height is known
  // pool + deck in the south-west corner
  const pxPool = cell.x - 30;
  const pzPool = cell.z + 34;
  addBox(scene, new THREE.MeshStandardMaterial({ color: 0xcfd6d8, roughness: 0.8 }), 13, 0.06, 9, pxPool, 0.12, pzPool);
  addBox(scene, new THREE.MeshStandardMaterial({ color: 0x3f9fd0, roughness: 0.25, metalness: 0.1 }), 11.4, 0.06, 7.4, pxPool, 0.16, pzPool);
  label(scene, "HOSPITAL +", "#b8443c", cell.x - 8, 12.2, cell.z + 0.45, 0.8);
}

function buildParkingLot(scene: THREE.Scene, cell: CityCell, cars: Item[], stallColor: number, rows = 4): void {
  void stallColor;
  const line = new THREE.MeshBasicMaterial({ color: 0xf0efe9, transparent: true, opacity: 0.65 });
  const stalls: Item[] = [];
  for (let r = 0; r < rows; r++) {
    const x = cell.x - 30 + r * 20;
    for (let k = 0; k < 5; k++) {
      stalls.push({ x, y: 0.11, z: cell.z - 24 + k * 11, ry: Math.PI / 2 });
    }
  }
  instanced(scene, new THREE.BoxGeometry(0.24, 0.01, 4.6), line, stalls);
  // cars keep clear of the cell's own buildings (paint may run under them,
  // actual cars may not)
  const boxes = THEME_BUILDINGS[cell.theme].map((b) => ({
    x0: cell.x + b.dx - b.hw - 1.6,
    x1: cell.x + b.dx + b.hw + 1.6,
    z0: cell.z + b.dz - b.hd - 2.6,
    z1: cell.z + b.dz + b.hd + 2.6,
  }));
  const palette = [0xd8d9d5, 0xf2c14e, 0x4a7fb5, 0x2e3742, 0xb4463f];
  for (let i = 0; i < rows; i++) {
    const rx = cell.x - 30 + i * 20;
    const rz = cell.z - 18.5 + hash(i, cell.x | 0, 3) * 22;
    if (boxes.some((b) => rx > b.x0 && rx < b.x1 && rz > b.z0 && rz < b.z1)) continue;
    cars.push({ x: rx, y: 0, z: rz, ry: Math.PI / 2, color: palette[hash(i, cell.z | 0, palette.length)] });
  }
}

// ============================== props ======================================

function buildProps(scene: THREE.Scene, cars: Item[]): void {
  // parked cars along every street (curb lanes), skipping intersections
  const palette = [0xd8d9d5, 0xf2c14e, 0x4a7fb5, 0x2e3742, 0xb4463f, 0x6f9e58];
  for (const l of CITY_STREET_LINES) {
    for (let t = -ARENA_HALF + 44; t <= ARENA_HALF - 44; t += 27) {
      if (CITY_STREET_LINES.some((o) => Math.abs(t - o) < 26)) continue;
      if (Math.abs(t) < 26 && Math.abs(l) < 26) continue; // plaza crossing
      const jitter = hash(l | 0, t | 0, 5);
      const colour = palette[hash(t | 0, l | 0, palette.length)];
      cars.push({ x: l - 6.9, y: 0, z: t + jitter, ry: jitter % 2 === 0 ? 0.02 : Math.PI - 0.02, color: colour });
      cars.push({ x: l + 6.9, y: 0, z: t - jitter, ry: jitter % 2 === 0 ? Math.PI + 0.02 : -0.02, color: palette[(hash(l | 0, (t + 7) | 0, palette.length))] });
      cars.push({ x: t + jitter, y: 0, z: l - 6.9, ry: Math.PI / 2 + 0.02, color: palette[hash((t + 3) | 0, l | 0, palette.length)] });
      cars.push({ x: t - jitter, y: 0, z: l + 6.9, ry: -Math.PI / 2 + 0.02, color: palette[hash((t + 11) | 0, (l + 5) | 0, palette.length)] });
    }
  }
  const body = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.78, 0.62, 3.9),
    new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.35 }),
    cars.length,
  );
  const glass = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.5, 0.5, 1.9),
    new THREE.MeshStandardMaterial({ color: 0x1b2730, roughness: 0.25, metalness: 0.4 }),
    cars.length,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  const c = new THREE.Color();
  cars.forEach((it, i) => {
    q.setFromEuler(new THREE.Euler(0, it.ry ?? 0, 0));
    p.set(it.x, 0.42, it.z);
    m.compose(p, q, s);
    body.setMatrixAt(i, m);
    c.setHex(it.color ?? 0xd8d9d5);
    body.setColorAt(i, c);
    p.set(it.x, 0.92, it.z);
    m.compose(p, q, s);
    glass.setMatrixAt(i, m);
  });
  body.instanceMatrix.needsUpdate = true;
  if (body.instanceColor) body.instanceColor.needsUpdate = true;
  glass.instanceMatrix.needsUpdate = true;
  body.castShadow = true;
  glass.castShadow = false;
  scene.add(body, glass);

  // street lamps along the avenues and the centre road
  const poles: Item[] = [];
  const heads: Item[] = [];
  for (const l of [0, -144, 144]) {
    for (const side of [1, -1]) {
      for (let t = -ARENA_HALF + 34; t <= ARENA_HALF - 34; t += 44) {
        const off = (CITY_STREET_HALF + 1.6) * side;
        poles.push({ x: l + off, y: 2.6, z: t });
        heads.push({ x: l + off - side * 0.55, y: 5.15, z: t, ry: side > 0 ? Math.PI : 0 });
        poles.push({ x: t, y: 2.6, z: l + off });
        heads.push({ x: t, y: 5.15, z: l + off - side * 0.55, ry: side > 0 ? -Math.PI / 2 : Math.PI / 2 });
      }
    }
  }
  instanced(scene, new THREE.CylinderGeometry(0.11, 0.15, 5.2, 7), new THREE.MeshStandardMaterial({ color: 0x565d63, metalness: 0.5, roughness: 0.5 }), poles);
  instanced(scene, new THREE.BoxGeometry(1.15, 0.16, 0.34), new THREE.MeshStandardMaterial({ color: 0x3d444a, metalness: 0.4, roughness: 0.5 }), heads);

  // trees: dense belt outside the ring + parks + homes + plaza corners
  const trees: Item[] = [];
  const greens = [0x63a84f, 0x4e9b45, 0x77b653, 0x3f8f3f];
  const addTree = (x: number, z: number, k: number) => {
    trees.push({ x, y: 1.5, z, color: greens[k % greens.length] });
  };
  for (let t = -285; t <= 285; t += 14) {
    for (const off of [-276, -290]) {
      addTree(t, off, hash(t | 0, 1, 4));
      addTree(t, -off, hash(t | 0, 2, 4));
      addTree(off, t, hash(t | 0, 3, 4));
      addTree(-off, t, hash(t | 0, 4, 4));
    }
  }
  for (const cell of CITY_CELLS) {
    if (cell.theme === "park") {
      for (let dx = -42; dx <= 42; dx += 21) {
        for (let dz = -42; dz <= 42; dz += 21) {
          if (Math.abs(dx) < 22 && Math.abs(dz) < 14) continue; // court
          addTree(cell.x + dx, cell.z + dz, hash(dx | 0, dz | 0, 4));
        }
      }
    } else if (cell.theme === "homes") {
      for (const [dx, dz] of [[-44, 40], [8, 44], [44, -40], [-8, -44]] as const) {
        addTree(cell.x + dx, cell.z + dz, hash(dx | 0, dz | 0, 4));
      }
    }
  }
  for (const [x, z] of [[20, 20], [-20, 20], [20, -20], [-20, -20]] as const) addTree(x, z, hash(x, z, 4));
  instanced(scene, new THREE.CylinderGeometry(0.3, 0.44, 3, 6), new THREE.MeshStandardMaterial({ color: 0x4b3022, roughness: 1 }), trees.map((t) => ({ x: t.x, y: 1.5, z: t.z })), true);
  instanced(scene, new THREE.IcosahedronGeometry(2.7, 0), new THREE.MeshStandardMaterial({ roughness: 0.9 }), trees.map((t) => ({ ...t, y: 4.6, sy: 1.25 })), true);

  // wind turbines along the northern belt
  const white = new THREE.MeshStandardMaterial({ color: 0xe8ecee, roughness: 0.6, metalness: 0.15 });
  for (const [tx, tz] of [[-250, -281], [-160, -283], [200, -282], [277, -238]] as const) {
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.15, 27, 10), white);
    tower.position.set(tx, 13.5, tz);
    tower.castShadow = true;
    scene.add(tower);
    const nacelle = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.5, 3.4), white);
    nacelle.position.set(tx, 27.3, tz);
    scene.add(nacelle);
    const hub = new THREE.Group();
    hub.position.set(tx, 27.3, tz + 1.9);
    const arms: THREE.Group[] = [];
    for (let b = 0; b < 3; b++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.55, 11, 0.14), white);
      blade.position.y = 5.5;
      const arm = new THREE.Group();
      arm.add(blade);
      arm.rotation.z = (b * Math.PI * 2) / 3;
      hub.add(arm);
      arms.push(arm);
    }
    // three only fires onBeforeRender for renderable meshes — a Group hook
    // never runs, so the spin is driven from the first blade and derives
    // from absolute time (idempotent, no per-tick integration to drift)
    (arms[0].children[0] as THREE.Mesh).onBeforeRender = () => {
      hub.rotation.z = (performance.now() / 1000) * 1.3;
    };
    scene.add(hub);
  }

  // roundabout fountain island (collider half 5 in maps.ts)
  const stone = new THREE.MeshStandardMaterial({ color: 0xb9c2c6, roughness: 0.75 });
  const water = new THREE.MeshStandardMaterial({ color: 0x4f9fc8, roughness: 0.2, metalness: 0.1 });
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(6.2, 6.4, 1.5, 28), stone);
  basin.position.set(0, 0.75, 0);
  basin.castShadow = true;
  basin.receiveShadow = true;
  scene.add(basin);
  const pool = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, 0.1, 28), water);
  pool.position.set(0, 1.52, 0);
  scene.add(pool);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.3, 2.6, 16), stone);
  column.position.set(0, 2.9, 0);
  column.castShadow = true;
  scene.add(column);
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 1.9, 0.55, 20), stone);
  bowl.position.set(0, 4.4, 0);
  bowl.castShadow = true;
  scene.add(bowl);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.08, 20), water);
  top.position.set(0, 4.7, 0);
  scene.add(top);
}

// small canvas label sign, matches the in-game signage style
function label(scene: THREE.Scene, text: string, colour: string, x: number, y: number, z: number, scale: number): void {
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 180;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.font = "700 62px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(10 * scale, 2 * scale),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), side: THREE.DoubleSide }),
  );
  sign.position.set(x, y, z);
  scene.add(sign);
}

// ============================== building kits ==============================

function buildingKits(scene: THREE.Scene): void {
  // kit model per footprint slot (footprints in maps.ts are sized to these
  // models' aspect ratios so the uniform fit wraps each collider exactly).
  // Every building in new_york_buildings.glb is placed: emp_state / woolworth
  // / christler / new_york_times / tower_one / metlife downtown, g1–g6 in the
  // office district, b1–b6 in the shops + civic rows, and the modern-night
  // tower as the hospital.
  const KIT_SLOTS: Partial<Record<string, string[]>> = {
    towers: ["emp_state", "woolworth", "christler", "new_york_times", "tower_one", "metlife"],
    offices: ["g2", "g5", "g6", "g4", "g3", "g1"],
    shops: ["b1", "b2", "b4", "b6"],
    civic: ["flatiron", "b3"],
    hospital: ["", "b5"], // slot 0 is the modern-night tower (own loader below)
  };
  const loader = new GLTFLoader();
  loader.load(
    "/assets/reference/new_york_buildings.glb",
    (gltf) => {
      // Sketchfab nesting: scene > Sketchfab_model > root > GLTF_SceneRootNode
      const kitRoot = gltf.scene.getObjectByName("GLTF_SceneRootNode") ?? gltf.scene;
      const variants = kitRoot.children
        .map((child) => ({
          name: child.name,
          child,
          size: new THREE.Box3().setFromObject(child).getSize(new THREE.Vector3()),
        }))
        // drop any flat ground/decor pieces: buildings are taller than thin
        .filter((v) => v.size.y > v.size.x * 0.2 && v.size.y > v.size.z * 0.2);
      if (!variants.length) return;
      for (const cell of CITY_CELLS) {
        const slots = KIT_SLOTS[cell.theme];
        if (!slots) continue;
        THEME_BUILDINGS[cell.theme].forEach((b, i) => {
          const prefix = slots[i];
          if (!prefix) return; // empty slot: another loader owns it (hospital tower)
          const v =
            variants.find((cand) => cand.name.startsWith(prefix)) ??
            variants[Math.floor(i + Math.abs(cell.x + cell.z) / 6) % variants.length];
          if (!v) return;
          const model = v.child.clone(true);
          // bake the source world transform onto the clone (up-axis fixes
          // live on the ancestors that clone(true) does not carry over)
          v.child.updateWorldMatrix(true, false);
          const q = new THREE.Quaternion();
          const s = new THREE.Vector3();
          v.child.matrixWorld.decompose(new THREE.Vector3(), q, s);
          model.quaternion.copy(q);
          model.scale.copy(s);
          const rotated = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
          // uniform fit onto the footprint, small inflation so the visual
          // shell wraps the authoritative collider instead of hiding in it
          const fitX = (b.hw * 2 + 0.6) / Math.max(0.001, rotated.x);
          const fitZ = (b.hd * 2 + 0.6) / Math.max(0.001, rotated.z);
          const allowY = (b.h * 1.06 + 0.5) / Math.max(0.001, rotated.y);
          model.scale.multiplyScalar(Math.min(fitX, fitZ, allowY));
          const fixed = new THREE.Box3().setFromObject(model);
          const ctr = fixed.getCenter(new THREE.Vector3());
          model.position.set(cell.x + b.dx - ctr.x, -fixed.min.y + 0.09, cell.z + b.dz - ctr.z);
          model.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
          });
          scene.add(model);
        });
      }
    },
    undefined,
    () => {
      /* kit is optional: the collider boxes stay visible as plain buildings */
    },
  );

  loader.load(
    "/assets/reference/modern_night_building_game-ready.glb",
    (gltf) => {
      const cell = CITY_CELLS.find((c) => c.theme === "hospital");
      if (!cell) return;
      const b = THEME_BUILDINGS.hospital[0];
      const model = gltf.scene;
      const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
      const fitX = (b.hw * 2 + 0.6) / Math.max(0.001, size.x);
      const fitZ = (b.hd * 2 + 0.6) / Math.max(0.001, size.z);
      const allowY = (b.h * 1.06 + 0.5) / Math.max(0.001, size.y);
      model.scale.setScalar(Math.min(fitX, fitZ, allowY));
      const fixed = new THREE.Box3().setFromObject(model);
      const ctr = fixed.getCenter(new THREE.Vector3());
      model.position.set(cell.x + b.dx - ctr.x, -fixed.min.y + 0.09, cell.z + b.dz - ctr.z);
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });
      scene.add(model);

      // rooftop helipad sized to the fitted roof, clear of the centre plant
      const fitted = fixed.getSize(new THREE.Vector3());
      const roofTop = 0.09 + fitted.y;
      const padX = cell.x + b.dx + 3.3;
      const padZ = cell.z + b.dz;
      const pad = new THREE.Mesh(
        new THREE.CircleGeometry(2.5, 32),
        new THREE.MeshStandardMaterial({ color: 0xe9ecec, roughness: 0.8 }),
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(padX, roofTop + 0.06, padZ);
      scene.add(pad);
      const hMark = new THREE.MeshBasicMaterial({ color: 0x2b4d7c });
      addBox(scene, hMark, 0.5, 0.02, 2.8, padX - 0.85, roofTop + 0.08, padZ);
      addBox(scene, hMark, 0.5, 0.02, 2.8, padX + 0.85, roofTop + 0.08, padZ);
      addBox(scene, hMark, 1.2, 0.02, 0.5, padX, roofTop + 0.08, padZ);
    },
    undefined,
    () => {
      /* optional */
    },
  );
}

// ============================== hot-air balloons ===========================

function buildBalloons(scene: THREE.Scene): void {
  // Decorative sky dressing — deliberately collider-free: the fantasy balloon
  // (≈ 11 m from basket floor to envelope crown in source units) drifts over
  // four districts, well clear of the ramp, the gates and the tallest roofs.
  const SPOTS = [
    { x: -102, y: 46, z: -202, s: 1.7 }, // over the park
    { x: 214, y: 36, z: 34, s: 1.45 }, // above the showroom forecourt
    { x: 26, y: 58, z: -26, s: 1.85 }, // high over the plaza
    { x: -216, y: 36, z: 168, s: 1.3 }, // over the south-west homes
  ];
  const TINTS = [0, 0.06, -0.07, 0.1]; // envelope hue shift per balloon
  const loader = new GLTFLoader();
  loader.load(
    "/assets/reference/fantasy_hot_air_balloon__free_3d_asset_glb.glb",
    (gltf) => {
      const source = gltf.scene;
      const raw = new THREE.Box3().setFromObject(source);
      const ctr = raw.getCenter(new THREE.Vector3());
      SPOTS.forEach((spot, i) => {
        const model = source.clone(true);
        // clone the envelope material before tinting so the hue shift stays
        // per-balloon (clone(true) shares materials between instances)
        const envelope = model.getObjectByName("Globo_0");
        const tint = TINTS[i % TINTS.length];
        if (envelope && tint !== 0) {
          envelope.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh || Array.isArray(mesh.material)) return;
            const std = mesh.material as THREE.MeshStandardMaterial;
            if (!("color" in std)) return;
            mesh.material = std.clone();
            (mesh.material as THREE.MeshStandardMaterial).color.offsetHSL(tint, 0, 0);
          });
        }
        model.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = false;
        });
        model.position.set(-ctr.x, -ctr.y, -ctr.z); // origin = balloon centre
        const group = new THREE.Group();
        group.add(model);
        group.position.set(spot.x, spot.y, spot.z);
        group.scale.setScalar(spot.s);
        // absolute-time drift — idempotent, so calling it once per rendered
        // balloon mesh per frame is safe (three fires mesh hooks, not group
        // hooks — same reason the turbines animate from a blade mesh)
        const phase = i * 2.1;
        const baseYaw = i * 1.7;
        const drift = () => {
          const t = performance.now() / 1000;
          group.position.set(
            spot.x + Math.sin(t * 0.16 + phase) * 6,
            spot.y + Math.sin(t * 0.5 + phase) * 1.6,
            spot.z + Math.cos(t * 0.12 + phase) * 6,
          );
          group.rotation.y = baseYaw + t * 0.05 + Math.sin(t * 0.23 + phase) * 0.12;
        };
        model.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) mesh.onBeforeRender = drift;
        });
        scene.add(group);
      });
    },
    undefined,
    () => {
      /* balloons are optional dressing: skip silently if the asset is absent */
    },
  );
}

// ============================== entry ======================================

export function buildCity(scene: THREE.Scene): void {
  buildStreets(scene);
  const cars: Item[] = [];
  for (const cell of CITY_CELLS) buildCell(scene, cell, cars);
  buildProps(scene, cars);
  buildingKits(scene);
  buildBalloons(scene);
}
