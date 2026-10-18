/**
 * Street cars: the parked fleet in the parking lots plus the moving traffic
 * that glides along the avenue lanes.
 *
 * Visual dressing only — exactly like every other prop, cars never become
 * colliders. The roads stay drivable straight through, and the player is
 * always free to lift off and cross the city in the air.
 *
 * Every car renders as five instanced parts (body / cabin / wheels / front
 * and rear lights), so a hundred-plus cars cost a handful of draw calls.
 * Traffic positions are a pure function of absolute time — nothing
 * integrates frame to frame, so a long frame or a backgrounded tab cannot
 * drift or accumulate error, and every same-lane car shares its lane's
 * speed so cars never overlap. Wrap points sit at the far street ends
 * behind the tree belt, far from anywhere the player actually drives.
 */
import * as THREE from "three";
import { ARENA_HALF, CITY_STREET_LINES } from "@roadster-arena/shared";

// ---- car proportions (metres, wheels kiss the road at y = 0) ----
const BODY = { w: 1.84, h: 0.52, l: 4.35, y: 0.47 };
const CABIN = { w: 1.58, h: 0.46, l: 2.05, y: 0.94, z: -0.25 };
const ROOF = { w: 1.42, h: 0.07, l: 1.7 };
const WHEEL = { r: 0.32, w: 0.22, x: 0.86, z: 1.42 };
const LIGHT = { w: 1.28, h: 0.11, y: 0.55, z: 2.19 };

const TRAFFIC_COLOURS = [
  0xd8d9d5, 0xf2c14e, 0x4a7fb5, 0x2e3742, 0xb4463f,
  0x6f9e58, 0xc7cdd2, 0x8a4a66, 0x3f6f6a, 0xd0d3cf,
];

// deterministic little hash for variety without randomness (mirrors city.ts)
const hash = (a: number, b: number, m: number): number => {
  const v = Math.imul(a * 73856093 ^ b * 19349663, 0x27d4eb2d);
  return ((v >>> 8) % m + m) % m;
};

export interface CarFleet {
  /** write one car's eight part instances; call commit() once after a run */
  place(i: number, x: number, z: number, ry: number, colour: number, scale: number): void;
  /** grow the drawn instance counts and mark the buffers for upload */
  commit(): void;
  /** run fn before the fleet is drawn (frame driver for moving fleets) */
  frameHook(fn: () => void): void;
}

export function createCarFleet(scene: THREE.Scene, capacity: number, cull = true): CarFleet {
  const body = new THREE.InstancedMesh(
    new THREE.BoxGeometry(BODY.w, BODY.h, BODY.l),
    new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.32 }),
    capacity,
  );
  const cabin = new THREE.InstancedMesh(
    new THREE.BoxGeometry(CABIN.w, CABIN.h, CABIN.l),
    new THREE.MeshStandardMaterial({ color: 0x1b2730, roughness: 0.18, metalness: 0.45 }),
    capacity,
  );
  const roof = new THREE.InstancedMesh(
    new THREE.BoxGeometry(ROOF.w, ROOF.h, ROOF.l),
    new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.32 }),
    capacity,
  );
  const wheel = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(WHEEL.r, WHEEL.r, WHEEL.w, 10),
    new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: 0.9 }),
    capacity * 4,
  );
  const lampGeo = new THREE.BoxGeometry(LIGHT.w, LIGHT.h, 0.06);
  const lightsF = new THREE.InstancedMesh(
    lampGeo,
    new THREE.MeshStandardMaterial({ color: 0x8d8d84, emissive: 0xfff2cf, emissiveIntensity: 0.85 }),
    capacity,
  );
  const lightsR = new THREE.InstancedMesh(
    lampGeo,
    new THREE.MeshStandardMaterial({ color: 0x5c1a14, emissive: 0xff301f, emissiveIntensity: 0.9 }),
    capacity,
  );
  body.castShadow = true;
  body.receiveShadow = true;
  cabin.castShadow = true;
  roof.castShadow = true;
  wheel.castShadow = true;
  const parts = [body, cabin, roof, wheel, lightsF, lightsR];
  for (const part of parts) {
    part.frustumCulled = cull;
    part.visible = false; // until the first commit() places something
    scene.add(part);
  }

  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  const qWheel = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const wheelSpots = [
    [-WHEEL.x, -WHEEL.z], [WHEEL.x, -WHEEL.z],
    [-WHEEL.x, WHEEL.z], [WHEEL.x, WHEEL.z],
  ] as const;
  let used = 0;

  const place = (i: number, x: number, z: number, ry: number, colour: number, scale: number): void => {
    const sn = Math.sin(ry);
    const cs = Math.cos(ry);
    // rotate a local (lx, lz) offset by the car's yaw, then scale it
    const ox = (lx: number, lz: number): number => (lx * cs + lz * sn) * scale;
    const oz = (lx: number, lz: number): number => (-lx * sn + lz * cs) * scale;
    e.set(0, ry, 0);
    s.set(scale, scale, scale);
    q.setFromEuler(e);
    p.set(x, BODY.y * scale, z);
    m.compose(p, q, s);
    body.setMatrixAt(i, m);
    c.setHex(colour);
    body.setColorAt(i, c);
    p.set(x + ox(0, CABIN.z), CABIN.y * scale, z + oz(0, CABIN.z));
    m.compose(p, q, s);
    cabin.setMatrixAt(i, m);
    p.set(x + ox(0, CABIN.z), (CABIN.y + CABIN.h / 2 + ROOF.h / 2) * scale, z + oz(0, CABIN.z));
    m.compose(p, q, s);
    roof.setMatrixAt(i, m);
    roof.setColorAt(i, c);
    for (let w = 0; w < 4; w++) {
      const [lx, lz] = wheelSpots[w];
      p.set(x + ox(lx, lz), WHEEL.r * scale, z + oz(lx, lz));
      q.setFromEuler(e).multiply(qWheel);
      m.compose(p, q, s);
      wheel.setMatrixAt(i * 4 + w, m);
    }
    q.setFromEuler(e);
    p.set(x + ox(0, LIGHT.z), LIGHT.y * scale, z + oz(0, LIGHT.z));
    m.compose(p, q, s);
    lightsF.setMatrixAt(i, m);
    p.set(x + ox(0, -LIGHT.z), LIGHT.y * scale, z + oz(0, -LIGHT.z));
    m.compose(p, q, s);
    lightsR.setMatrixAt(i, m);
    if (i + 1 > used) used = i + 1;
  };

  const commit = (): void => {
    body.count = used;
    cabin.count = used;
    roof.count = used;
    wheel.count = used * 4;
    lightsF.count = used;
    lightsR.count = used;
    if (!used) return;
    for (const part of parts) {
      part.visible = true;
      part.instanceMatrix.needsUpdate = true;
    }
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    if (roof.instanceColor) roof.instanceColor.needsUpdate = true;
  };

  return {
    place,
    commit,
    frameHook: (fn) => {
      body.onBeforeRender = () => fn();
    },
  };
}

// ---- parked fleet: the cars collected by the parking-lot builders ----

export function buildParkedCarFleet(
  scene: THREE.Scene,
  cars: readonly { x: number; z: number; ry?: number; color?: number }[],
): void {
  if (!cars.length) return;
  const fleet = createCarFleet(scene, cars.length);
  cars.forEach((car, i) => {
    fleet.place(i, car.x, car.z, car.ry ?? 0, car.color ?? 0xd8d9d5, 0.94 + ((i * 37) % 11) * 0.012);
  });
  fleet.commit();
}

// ---- moving traffic ----

interface TrafficLane {
  /** the axis the cars travel along; `fixed` is the other coordinate */
  axis: "x" | "z";
  fixed: number;
  dir: 1 | -1;
  speed: number;
}

interface TrafficCar {
  lane: TrafficLane;
  ry: number;
  start: number;
  scale: number;
  colour: number;
}

const LANE_OFFSET = 3.2; // right-hand lanes either side of the street centre
const TRAVEL = ARENA_HALF - 18; // half the driven span; wrap points hide in the belt

export function buildTraffic(scene: THREE.Scene): void {
  const lanes: TrafficLane[] = [];
  for (const line of CITY_STREET_LINES) {
    if (line === 0) continue; // the plaza crossing stays calm / pedestrian
    // right-hand traffic: keep to the right of the street centre while driving
    lanes.push({ axis: "z", fixed: line + LANE_OFFSET, dir: -1, speed: 14 + hash(line | 0, 1, 8) });
    lanes.push({ axis: "z", fixed: line - LANE_OFFSET, dir: 1, speed: 14 + hash(line | 0, 2, 8) });
    lanes.push({ axis: "x", fixed: line + LANE_OFFSET, dir: 1, speed: 14 + hash(line | 0, 3, 8) });
    lanes.push({ axis: "x", fixed: line - LANE_OFFSET, dir: -1, speed: 14 + hash(line | 0, 4, 8) });
  }

  const cars: TrafficCar[] = [];
  const span = TRAVEL * 2;
  for (const lane of lanes) {
    const line = lane.fixed | 0;
    const n = 8 + hash(line, lane.axis === "x" ? 11 : 17, 5); // 8-12 cars
    const gap = span / n;
    for (let i = 0; i < n; i++) {
      // even spacing + a small deterministic jitter keeps same-lane cars apart
      const start = (i + 0.125 + hash(i, line, 4) * 0.75) * gap;
      cars.push({
        lane,
        ry: lane.axis === "z" ? (lane.dir === 1 ? 0 : Math.PI) : (lane.dir === 1 ? Math.PI / 2 : -Math.PI / 2),
        start,
        scale: 0.92 + hash(i + 3, line, 9) * 0.02,
        colour: TRAFFIC_COLOURS[hash(i + 5, line + (lane.axis === "x" ? 1 : 0), TRAFFIC_COLOURS.length)],
      });
    }
  }

  const fleet = createCarFleet(scene, cars.length, false);
  const drive = (): void => {
    const t = performance.now() / 1000;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      const lane = car.lane;
      let u = (car.start + lane.speed * t) % span;
      if (u < 0) u += span;
      u -= TRAVEL;
      const coord = lane.dir === 1 ? u : -u;
      if (lane.axis === "z") fleet.place(i, lane.fixed, coord, car.ry, car.colour, car.scale);
      else fleet.place(i, coord, lane.fixed, car.ry, car.colour, car.scale);
    }
    fleet.commit();
  };
  fleet.frameHook(drive);
  drive(); // seed once so the first shadow pass sees real cars, not the origin
}
