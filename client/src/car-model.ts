/**
 * Procedural low-poly car (spec 3.2 asset fallback). An ORIGINAL wedge-hypercar
 * silhouette inspired by the studio references in client/public/assets/
 * reference: pointed nose ridge, dark glass canopy sweeping into a tapered
 * tail, black rocker skirt, turbine-style wheels — rebuilt from primitives,
 * no manufacturer geometry or branding.
 *
 * Coordinate convention (matches shared car-physics): forward = +z, up = +y.
 */

import * as THREE from "three";

export interface CarVisual {
  root: THREE.Group;
  wheels: THREE.Object3D[];
  /** adjusts brake/reverse glow etc. */
  setBrake(v: number): void;
  setBoost(v: number): void;
  dispose(): void;
}

const BODY_COLOURS = [0xf2f1ee, 0x8fd6ff, 0xffd479, 0xb7f7a8, 0xff9f9f, 0xc9a7ff, 0x7ef0d4, 0xffb37e, 0xf7a8ff, 0x9ef1ff];

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

  for (const station of stations) {
    for (let i = 0; i < n; i++) {
      const [w, h] = station.profile[i];
      pos.push(-w, h, station.z, w, h, station.z);
    }
  }

  const vertex = (side: 0 | 1, stationIndex: number, i: number) =>
    (stationIndex * n + i) * 2 + side;

  for (let s = 0; s < stations.length - 1; s++) {
    for (let i = 0; i < n - 1; i++) {
      // left surface
      idx.push(vertex(0, s, i), vertex(0, s + 1, i), vertex(0, s + 1, i + 1));
      idx.push(vertex(0, s, i), vertex(0, s + 1, i + 1), vertex(0, s, i + 1));
      // right surface
      idx.push(vertex(1, s, i + 1), vertex(1, s + 1, i), vertex(1, s + 1, i + 1));
      idx.push(vertex(1, s, i + 1), vertex(1, s, i), vertex(1, s + 1, i));
    }
  }

  // rear and front caps
  const rearS = 0;
  const frontS = stations.length - 1;
  for (let i = 1; i < n - 1; i++) {
    idx.push(vertex(0, rearS, 0), vertex(0, rearS, i), vertex(0, rearS, i + 1));
    idx.push(vertex(1, rearS, 0), vertex(1, rearS, i + 1), vertex(1, rearS, i));
    idx.push(vertex(0, frontS, 0), vertex(0, frontS, i + 1), vertex(0, frontS, i));
    idx.push(vertex(1, frontS, 0), vertex(1, frontS, i), vertex(1, frontS, i + 1));
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

  const paint = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.27, metalness: 0.72 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x080b12, roughness: 0.08, metalness: 0.95 });
  const skirt = new THREE.MeshStandardMaterial({ color: 0x17171a, roughness: 0.85 });
  const lightbar = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.6 });
  const taillight = new THREE.MeshStandardMaterial({ color: 0xff2214, emissive: 0xff2214, emissiveIntensity: 1.4 });
  const marker = new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff7a1a, emissiveIntensity: 1.2 });

  // Main body volume: longer and smoother, closer to the studio side profile.
  const profileTail: SectionProfile = [
    [0.06, 0.06], [0.52, 0.06], [0.93, 0.18], [1.08, 0.34], [1.08, 0.54], [0.95, 0.72], [0.58, 0.83], [0.15, 0.89],
  ];
  const profileRear: SectionProfile = [
    [0.08, 0.06], [0.62, 0.06], [1.02, 0.2], [1.16, 0.37], [1.17, 0.58], [1.04, 0.77], [0.64, 0.89], [0.18, 0.96],
  ];
  const profileMid: SectionProfile = [
    [0.09, 0.06], [0.69, 0.06], [1.08, 0.22], [1.2, 0.39], [1.2, 0.6], [1.06, 0.77], [0.66, 0.87], [0.2, 0.94],
  ];
  const profileFront: SectionProfile = [
    [0.06, 0.06], [0.58, 0.06], [0.99, 0.2], [1.09, 0.34], [1.04, 0.5], [0.84, 0.64], [0.41, 0.77], [0.11, 0.82],
  ];
  const profileNose: SectionProfile = [
    [0.03, 0.06], [0.44, 0.06], [0.86, 0.16], [0.99, 0.28], [0.96, 0.39], [0.72, 0.52], [0.29, 0.63], [0.02, 0.67],
  ];
  const hull = new THREE.Mesh(loftStations([
    { z: -2.35, profile: profileTail },
    { z: -1.35, profile: profileRear },
    { z: -0.1, profile: profileMid },
    { z: 1.1, profile: profileFront },
    { z: 2.35, profile: profileNose },
  ]), paint);
  hull.castShadow = true;
  root.add(hull);

  // Glasshouse: long, low teardrop with smooth taper.
  const canopy = new THREE.Mesh(loftStations([
    { z: -1.58, profile: [[0.1, 0.69], [0.43, 0.74], [0.56, 0.83], [0.18, 0.87]] },
    { z: -0.68, profile: [[0.09, 0.7], [0.46, 0.75], [0.62, 0.86], [0.2, 0.91]] },
    { z: 0.22, profile: [[0.08, 0.69], [0.42, 0.73], [0.54, 0.82], [0.16, 0.86]] },
    { z: 0.96, profile: [[0.06, 0.66], [0.31, 0.69], [0.39, 0.75], [0.11, 0.79]] },
  ]), glass);
  canopy.castShadow = true;
  root.add(canopy);

  // Lower rocker belt.
  const skirtGeo = new THREE.BoxGeometry(2.22, 0.1, 4.28);
  const skirtMesh = new THREE.Mesh(skirtGeo, skirt);
  skirtMesh.position.set(0, 0.07, -0.02);
  root.add(skirtMesh);

  // Wheel arches integrate the wheels into body mass.
  const arches: [number, number, number, number][] = [
    [-1.07, 0.42, 1.38, 0.47],
    [1.07, 0.42, 1.38, 0.47],
    [-1.09, 0.45, -1.42, 0.5],
    [1.09, 0.45, -1.42, 0.5],
  ];
  for (const [x, y, z, r] of arches) {
    const arch = new THREE.Mesh(
      new THREE.TorusGeometry(r, 0.08, 14, 24, Math.PI),
      paint,
    );
    arch.rotation.y = Math.PI / 2;
    arch.rotation.z = x > 0 ? Math.PI / 2 : -Math.PI / 2;
    arch.position.set(x, y, z);
    root.add(arch);
  }

  // Front fascia: thin light bar and dark intake.
  const frontBar = new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.02, 0.03), lightbar);
  frontBar.position.set(0, 0.34, 2.31);
  root.add(frontBar);
  const intake = new THREE.Mesh(new THREE.BoxGeometry(1.96, 0.12, 0.2), skirt);
  intake.position.set(0, 0.13, 2.18);
  root.add(intake);

  // Rear: wider light and cleaner tapered diffuser block.
  const rearBar = new THREE.Mesh(new THREE.BoxGeometry(2.06, 0.035, 0.03), taillight);
  rearBar.position.set(0, 0.5, -2.34);
  root.add(rearBar);
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.98, 0.22, 0.52), skirt);
  diffuser.position.set(0, 0.11, -2.18);
  root.add(diffuser);

  // ---- side markers (the little orange tick behind the front wheels) ----
  for (const side of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.16), marker);
    m.position.set(side * 1.1, 0.35, 0.9);
    root.add(m);
  }

  // ---- wheels ----
  const wheels: THREE.Object3D[] = [];
  const wheelR = 0.41;
  const positions: [number, number, number][] = [
    [-1.06, wheelR, 1.37], [1.06, wheelR, 1.37], // front
    [-1.08, wheelR, -1.42], [1.08, wheelR, -1.42], // rear
  ];
  for (const [x, y, z] of positions) {
    const w = makeWheel(wheelR, 0.3);
    w.position.set(x, y, z);
    root.add(w);
    wheels.push(w);
  }

  const brakeMats = [lightbar];

  return {
    root,
    wheels,
    setBrake(v: number) {
      for (const m of brakeMats) m.emissiveIntensity = 1.2 + v * 2.4;
    },
    setBoost(v: number) {
      taillight.emissiveIntensity = 1.2 + v * 2.8;
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
