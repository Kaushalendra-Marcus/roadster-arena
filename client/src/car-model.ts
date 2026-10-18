/**
 * Procedural low-poly car (spec 3.2 asset fallback). An ORIGINAL wedge-hypercar
 * silhouette inspired by the studio references in client/public/assets/
 * reference: low sharp nose blade, dark glass canopy sweeping into a tapered
 * KAMM tail, black rocker skirt, turbine-style wheels, full-width thruster
 * array — rebuilt from primitives, no manufacturer geometry or branding.
 *
 * Coordinate convention (matches shared car-physics): forward = +z, up = +y.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { CAR_TARGET_CLEARANCE } from "@roadster-arena/shared";

export interface CarVisual {
  root: THREE.Group;
  wheels: THREE.Object3D[];
  /** brake/reverse glow */
  setBrake(v: number): void;
  /** boost exhaust glow */
  setBoost(v: number): void;
  /** 0..1 how hard the lift/thruster array fires (hover, climb, boost) */
  setThrust(v: number): void;
  dispose(): void;
}

// Keep the authored Roadster close to the reference: silver/white paint,
// with variation limited to realistic neutral finishes.
const BODY_COLOURS = [0xf2f1ee, 0xd7dbe0, 0xb7bec7, 0xe7e3dc, 0xc4cbd2];

export function colourFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return BODY_COLOURS[Math.abs(h) % BODY_COLOURS.length];
}

type SectionProfile = [number, number][];

/**
 * Loft a symmetric body along z using multiple cross-sections.
 * Each profile point is [halfWidth, height] from bottom edge to roof.
 */
function loftStations(stations: { z: number; profile: SectionProfile }[]): THREE.BufferGeometry {
  if (stations.length < 2) throw new Error("loftStations requires at least 2 stations");
  const n = stations[0].profile.length;
  for (const s of stations) {
    if (s.profile.length !== n) throw new Error("all loft profiles must use the same point count");
  }

  const pos: number[] = [];
  const idx: number[] = [];
  const ringSize = n * 2;

  // Closed perimeter at every z station: left side bottom→top,
  // then right side top→bottom.
  for (const station of stations) {
    for (let i = 0; i < n; i++) {
      const [w, h] = station.profile[i];
      pos.push(-w, h, station.z);
    }
    for (let i = n - 1; i >= 0; i--) {
      const [w, h] = station.profile[i];
      pos.push(w, h, station.z);
    }
  }

  const vertex = (stationIndex: number, ringIndex: number) =>
    stationIndex * ringSize + (ringIndex + ringSize) % ringSize;

  for (let s = 0; s < stations.length - 1; s++) {
    for (let i = 0; i < ringSize; i++) {
      const next = (i + 1) % ringSize;
      idx.push(vertex(s, i), vertex(s + 1, i), vertex(s + 1, next));
      idx.push(vertex(s, i), vertex(s + 1, next), vertex(s, next));
    }
  }

  // Close both ends with triangle fans.
  for (const stationIndex of [0, stations.length - 1]) {
    const center = pos.length / 3;
    const z = stations[stationIndex].z;
    pos.push(0, stations[stationIndex].profile[0][1], z);
    for (let i = 0; i < ringSize; i++) {
      const next = (i + 1) % ringSize;
      if (stationIndex === 0) idx.push(center, vertex(stationIndex, next), vertex(stationIndex, i));
      else idx.push(center, vertex(stationIndex, i), vertex(stationIndex, next));
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function makeWheel(radius: number, width: number): THREE.Group {
  const g = new THREE.Group();

  const tyre = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, width, 32),
    new THREE.MeshStandardMaterial({ color: 0x121216, roughness: 0.9 }),
  );
  tyre.rotation.x = Math.PI / 2;
  tyre.rotation.z = Math.PI / 2;
  g.add(tyre);

  const rimMat = new THREE.MeshStandardMaterial({ color: 0x8f929a, roughness: 0.25, metalness: 0.85 });
  const spokeMat = new THREE.MeshStandardMaterial({ color: 0x111217, roughness: 0.4, metalness: 0.8 });
  for (const side of [-1, 1]) {
    const face = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.77, 24), rimMat);
    face.rotation.y = (side * Math.PI) / 2;
    face.position.x = side * (width / 2 + 0.001);
    g.add(face);

    for (let b = 0; b < 5; b++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, radius * 0.62, 0.09), spokeMat);
      const holder = new THREE.Group();
      holder.rotation.x = (b / 5) * Math.PI * 2;
      spoke.position.y = radius * 0.21;
      spoke.rotation.z = side * 0.26;
      holder.add(spoke);
      holder.position.x = side * (width / 2 + 0.01);
      g.add(holder);
    }

    const hub = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.14, 16), spokeMat);
    hub.rotation.y = (side * Math.PI) / 2;
    hub.position.x = side * (width / 2 + 0.012);
    g.add(hub);
  }
  return g;
}

export function createCarVisual(colour: number): CarVisual {
  const root = new THREE.Group();
  // The model is authored with y = 0 at ground contact (wheels kiss y = 0,
  // hull bottom at 0.08), but the root is placed at the physics body centre,
  // which the controller holds CAR_TARGET_CLEARANCE (0.62 m) above the
  // surface. This pivot hangs the authored model that far down along the
  // body's local up so wheels meet the road on ground, walls and ceilings.
  const car = new THREE.Group();
  car.position.y = -CAR_TARGET_CLEARANCE;
  root.add(car);
  const effects = new THREE.Group();
  car.add(effects);
  let loadedModel: THREE.Object3D | null = null;

  const paint = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.22, metalness: 0.62 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x111923,
    roughness: 0.12,
    metalness: 0.35,
    clearcoat: 0.8,
    clearcoatRoughness: 0.08,
  });
  const skirt = new THREE.MeshStandardMaterial({ color: 0x17171a, roughness: 0.85 });
  const lightbar = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.6 });
  const taillight = new THREE.MeshStandardMaterial({ color: 0xff2214, emissive: 0xff2214, emissiveIntensity: 1.4 });
  const nozzleMat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.5, metalness: 0.7 });

  // ---- hull: nose blade → rising hood → low canopy base → KAMM tail ----
  // Reference proportions: ~1/5 of the length is the razor nose, the roof
  // ridge sits just past mid-car at ~0.9 of total height, the tail is an
  // upright cut with a ducktail lip and the widest sections at the axles.
  const hull = new THREE.Mesh(loftStations([
    { z: -2.4, profile: [[0.05, 0.10], [0.94, 0.10], [1.08, 0.26], [1.06, 0.5], [0.8, 0.72], [0.2, 0.8]] },
    { z: -1.42, profile: [[0.06, 0.08], [0.99, 0.08], [1.15, 0.22], [1.16, 0.52], [0.92, 0.72], [0.18, 0.78]] },
    { z: -0.35, profile: [[0.06, 0.08], [0.82, 0.08], [1.11, 0.2], [1.12, 0.55], [0.95, 0.72], [0.16, 0.74]] },
    { z: 0.72, profile: [[0.05, 0.08], [0.78, 0.08], [1.07, 0.18], [1.08, 0.45], [0.83, 0.62], [0.14, 0.66]] },
    { z: 1.62, profile: [[0.04, 0.09], [0.62, 0.09], [0.9, 0.16], [0.92, 0.38], [0.62, 0.5], [0.08, 0.54]] },
    { z: 2.4, profile: [[0.02, 0.1], [0.46, 0.1], [0.8, 0.15], [0.82, 0.33], [0.52, 0.44], [0.05, 0.48]] },
  ]), paint);
  hull.castShadow = true;
  car.add(hull);

  // ---- glass: one thin jet canopy, very raked windshield, tapering fast ----
  const canopy = new THREE.Mesh(loftStations([
    { z: -1.5, profile: [[0.05, 0.64], [0.34, 0.64], [0.52, 0.72], [0.16, 0.76]] },
    { z: -0.7, profile: [[0.05, 0.7], [0.44, 0.7], [0.6, 0.9], [0.18, 0.94]] },
    { z: 0.1, profile: [[0.04, 0.7], [0.47, 0.7], [0.64, 0.93], [0.15, 0.97]] },
    { z: 0.55, profile: [[0.03, 0.68], [0.4, 0.68], [0.55, 0.86], [0.11, 0.9]] },
    { z: 0.92, profile: [[0.02, 0.64], [0.26, 0.64], [0.36, 0.74], [0.07, 0.78]] },
  ]), glass);
  canopy.castShadow = true;
  car.add(canopy);

  // ---- black rocker skirt running the full wheelbase ----
  const skirtMesh = new THREE.Mesh(new THREE.BoxGeometry(2.22, 0.1, 3.9), skirt);
  skirtMesh.position.set(0, 0.07, -0.12);
  car.add(skirtMesh);

  // ducktail lip on the deck edge
  const ducktail = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.05, 0.22), paint);
  ducktail.rotation.x = -0.28;
  ducktail.position.set(0, 0.83, -2.34);
  car.add(ducktail);

  // ---- front fascia: thin DRL bar over a dark bumper blade ----
  const frontBar = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.02, 0.03), lightbar);
  frontBar.position.set(0, 0.34, 2.41);
  car.add(frontBar);
  const intake = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.14, 0.18), skirt);
  intake.position.set(0, 0.12, 2.3);
  car.add(intake);

  // ---- rear: light bar + diffuser + thruster array ----
  const rearBar = new THREE.Mesh(new THREE.BoxGeometry(2.12, 0.035, 0.03), taillight);
  rearBar.position.set(0, 0.45, -2.42);
  car.add(rearBar);
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(2.04, 0.2, 0.44), skirt);
  diffuser.position.set(0, 0.12, -2.26);
  car.add(diffuser);

  // side markers behind the front wheels
  for (const side of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.16), lightbar);
    m.position.set(side * 1.09, 0.4, 0.9);
    car.add(m);
  }

  // ---- thruster array: directional, restrained exhaust --------------------
  // Cold-gas exhaust is mostly transparent. A small hot core and a soft,
  // rapidly fading expansion are enough; bright particles make it look like
  // fireworks instead of compressed air.
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xdaf4ff,
    transparent: true,
    opacity: 0.42,
    blending: THREE.NormalBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const exhaustMat = new THREE.MeshBasicMaterial({
    color: 0xb9dff2,
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0xe9f8ff,
    transparent: true,
    opacity: 0.12,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  type JetVisual = {
    group: THREE.Group;
    core: THREE.Mesh;
    expansion: THREE.Mesh;
    halo: THREE.Mesh;
    length: number;
    phase: number;
  };
  const jets: JetVisual[] = [];
  const axis = new THREE.Vector3(0, 1, 0);
  const addJet = (
    position: [number, number, number],
    direction: [number, number, number],
    radius: number,
    length: number,
    phase: number,
  ) => {
    const dir = new THREE.Vector3(...direction).normalize();
    const group = new THREE.Group();
    group.position.set(...position);
    group.quaternion.setFromUnitVectors(axis, dir);
    group.visible = false;
    effects.add(group);

    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.25, 0.06, 12), nozzleMat);
    group.add(nozzle);
    const core = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.42, length * 0.68, 16, 5, true), coreMat);
    core.position.y = length * 0.36;
    group.add(core);
    const expansion = new THREE.Mesh(new THREE.ConeGeometry(radius * 1.75, length, 20, 8, true), exhaustMat);
    expansion.position.y = length * 0.5;
    group.add(expansion);
    const halo = new THREE.Mesh(new THREE.ConeGeometry(radius * 2.6, length * 1.08, 20, 8, true), haloMat);
    halo.position.y = length * 0.54;
    group.add(halo);
    jets.push({ group, core, expansion, halo, length, phase });
  };
  // rear array streams backward, while the lift jets stream down.
  addJet([-0.72, 0.4, -2.46], [0, 0, -1], 0.09, 1.1, 0.2);
  addJet([0, 0.4, -2.5], [0, 0, -1], 0.12, 1.3, 1.7);
  addJet([0.72, 0.4, -2.46], [0, 0, -1], 0.09, 1.1, 3.1);
  addJet([-0.6, 0.1, 0.55], [0, -1, 0], 0.11, 0.9, 4.4);
  addJet([0.6, 0.1, 0.55], [0, -1, 0], 0.11, 0.9, 5.8);

  // ---- wheels ----
  const wheels: THREE.Object3D[] = [];
  const wheelR = 0.48;
  const positions: [number, number, number][] = [
    [-1.07, wheelR, 1.4], [1.07, wheelR, 1.4], // front
    [-1.1, wheelR, -1.44], [1.1, wheelR, -1.44], // rear
  ];
  for (const [x, y, z] of positions) {
    const w = makeWheel(wheelR, 0.3);
    w.position.set(x, y, z);
    car.add(w);
    wheels.push(w);
  }

  const loader = new GLTFLoader();
  loader.load(
    "/assets/reference/tesla_roadster_-_low_poly.glb",
    (gltf) => {
      const model = gltf.scene;
      model.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          if (material?.name === "Material.001" && "color" in material) {
            (material as THREE.MeshStandardMaterial).color.setHex(colour);
            (material as THREE.MeshStandardMaterial).metalness = 0.62;
            (material as THREE.MeshStandardMaterial).roughness = 0.22;
          }
        }
      });
      for (const child of [...car.children]) {
        if (child !== effects) car.remove(child);
      }
      car.add(model);
      loadedModel = model;
      // Preserve the authored GLB wheels exactly as exported. Their meshes do
      // not have safe independent pivots, so do not alter their transforms.
      wheels.length = 0;
    },
    undefined,
    (error) => console.error("Failed to load Roadster GLB; keeping procedural fallback.", error),
  );

  const brakeMats = [lightbar];

  return {
    root,
    wheels,
    setBrake(v: number) {
      for (const m of brakeMats) m.emissiveIntensity = 1.2 + v * 2.4;
    },
    setBoost(v: number) {
      taillight.emissiveIntensity = 1.2 + v * 2.8;
      loadedModel?.traverse((object) => {
        const mesh = object as THREE.Mesh;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          if (!material || !("emissiveIntensity" in material)) continue;
          (material as THREE.MeshStandardMaterial).emissiveIntensity = 0.6 + v * 2.4;
        }
      });
    },
    setThrust(v: number) {
      const level = Math.max(0, Math.min(1, v));
      const now = performance.now() * 0.008;
      for (const jet of jets) {
        const flicker = 0.82 + Math.sin(now * 1.9 + jet.phase) * 0.12 + Math.sin(now * 4.7 + jet.phase) * 0.06;
        const k = level * Math.max(0.55, flicker);
        jet.group.visible = level > 0.025;
        jet.core.scale.set(0.8 + k * 0.3, 0.55 + k * 1.05, 0.8 + k * 0.3);
        jet.expansion.scale.set(0.6 + k * 0.95, 0.35 + k * 1.15, 0.6 + k * 0.95);
        jet.halo.scale.set(0.5 + k * 1.15, 0.3 + k * 1.05, 0.5 + k * 1.15);
        jet.expansion.rotation.z = Math.sin(now * 1.35 + jet.phase) * 0.035;
        jet.halo.rotation.x = Math.cos(now * 1.1 + jet.phase) * 0.045;
        const coreMaterial = jet.core.material as THREE.MeshBasicMaterial;
        const expansionMaterial = jet.expansion.material as THREE.MeshBasicMaterial;
        coreMaterial.opacity = 0.22 + k * 0.3;
        expansionMaterial.opacity = 0.05 + k * 0.18;
        (jet.halo.material as THREE.MeshBasicMaterial).opacity = 0.035 + k * 0.13;
      }
    },
    dispose() {
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
    },
  };
}
