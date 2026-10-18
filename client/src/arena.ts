/**
 * three.js scene + arena construction from the shared map definition
 * (spec 3.2, 8): every collider in buildArenaDef gets a matching mesh here,
 * so what you see is exactly what the server collides with.
 */

import * as THREE from "three";
import { buildArenaDef, ARENA_HALF, type GameplayConfig } from "@roadster-arena/shared";
import type { PhysQuery } from "./physics-query.js";

export interface ArenaView {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  gateRings: THREE.Object3D[];
  setGateBoost(index: number): void;
  dispose(): void;
}

function makeTerrainMaterial(colour: number, roughness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: colour, roughness, metalness: 0.08 });
}

export function createArenaView(canvas: HTMLCanvasElement, cfg: GameplayConfig, _query: PhysQuery): ArenaView {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8db8d7);
  scene.fog = new THREE.Fog(0x8db8d7, 180, 620);

  const camera = new THREE.PerspectiveCamera(64, canvas.clientWidth / canvas.clientHeight, 0.1, 900);

  // ---- lights ----
  const hemi = new THREE.HemisphereLight(0xdceeff, 0x394047, 1.7);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2df, 1.7);
  sun.position.set(120, 190, -80);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -320;
  sun.shadow.camera.right = 320;
  sun.shadow.camera.top = 320;
  sun.shadow.camera.bottom = -320;
  sun.shadow.camera.far = 700;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x9fc5ff, 0.8);
  fill.position.set(-90, 45, -120);
  scene.add(fill);
  // warm rim from the "sunset" side
  const rim = new THREE.DirectionalLight(0xff8844, 0.5);
  rim.position.set(-180, 60, 240);
  scene.add(rim);

  // ---- sky dome: dusk gradient ----
  {
    const skyGeo = new THREE.SphereGeometry(760, 24, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {},
      vertexShader: `
        varying vec3 vP;
        void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: `
        varying vec3 vP;
        void main() {
          float h = normalize(vP).y;
          vec3 top = vec3(0.18, 0.38, 0.62);
          vec3 mid = vec3(0.45, 0.68, 0.84);
          vec3 glow = vec3(0.98, 0.76, 0.52);
          vec3 c = mix(mid, top, clamp(h * 1.6, 0.0, 1.0));
          float sunset = pow(clamp(1.0 - abs(h - 0.02) * 3.2, 0.0, 1.0), 2.0);
          c = mix(c, glow, sunset * 0.55);
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });
    scene.add(new THREE.Mesh(skyGeo, skyMat));

    // Soft volumetric-looking cloud banks: overlapping lit volumes, not black
    // billboards or stars, give the horizon a daytime atmosphere.
    const cloudMat = new THREE.MeshLambertMaterial({
      color: 0xf4f8fb,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      fog: false,
    });
    const clouds = [
      [-180, 72, -260, 1.4], [40, 94, -320, 1.8], [250, 66, -190, 1.2],
      [-300, 82, 40, 1.7], [280, 105, 120, 1.5], [-80, 118, 280, 2.0],
    ];
    for (const [x, y, z, scale] of clouds) {
      const cloud = new THREE.Group();
      for (let i = 0; i < 6; i++) {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(9 + (i % 3) * 3, 16, 10), cloudMat);
        puff.position.set((i - 2.5) * 9, Math.sin(i * 1.7) * 3, Math.cos(i * 1.3) * 5);
        puff.scale.set(1.35, 0.58 + (i % 2) * 0.16, 0.85);
        cloud.add(puff);
      }
      cloud.position.set(x, y, z);
      cloud.scale.setScalar(scale);
      scene.add(cloud);
    }
  }

  // ---- arena solids from the shared definition ----
  const def = buildArenaDef(cfg);
  const asphalt = makeTerrainMaterial(0x232529, 0.95);
  const concrete = makeTerrainMaterial(0x3a3d44, 0.85);
  const trackMat = new THREE.MeshStandardMaterial({ color: 0x2c2e34, roughness: 0.7, metalness: 0.2, emissive: 0x2a1e55, emissiveIntensity: 0.35 });

  for (const c of def.colliders) {
    if ("vertices" in c) {
      // trimesh (launch ramp / loop): render the raw triangles
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(c.vertices, 3));
      g.setIndex(c.indices);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, c.kind === "gripTrack" ? trackMat : concrete);
      m.position.set(c.pos.x, c.pos.y, c.pos.z);
      m.castShadow = true;
      m.receiveShadow = true;
      scene.add(m);
      continue;
    }

    const dims = new THREE.Vector3(c.half.x * 2, c.half.y * 2, c.half.z * 2);
    const g = new THREE.BoxGeometry(dims.x, dims.y, dims.z);
    const m = new THREE.Mesh(g, c.kind === "ground" ? asphalt : c.kind === "gripTrack" ? trackMat : concrete);
    m.position.set(c.pos.x, c.pos.y, c.pos.z);
    if (c.axis && c.angle) {
      m.rotation[c.axis] = c.angle;
    }
    // the containment walls are invisible force fields — hide them
    m.visible = c.kind !== "wall";
    m.receiveShadow = c.kind === "ground" || c.kind === "block";
    m.castShadow = c.kind === "block";
    scene.add(m);

    if (c.kind === "block" && c.half.y > 2.5) {
      const facade = new THREE.MeshStandardMaterial({
        color: 0x68717c,
        roughness: 0.72,
        metalness: 0.16,
      });
      m.material = facade;
      const glass = new THREE.MeshStandardMaterial({
        color: 0x9bd4e8,
        emissive: 0x244b64,
        emissiveIntensity: 0.45,
        roughness: 0.2,
        metalness: 0.5,
      });
      const frame = new THREE.MeshStandardMaterial({ color: 0x242b33, roughness: 0.55, metalness: 0.5 });
      const addWindow = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
        const window = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), glass);
        window.position.set(x, y, z);
        window.castShadow = false;
        scene.add(window);
      };
      const rows = Math.max(2, Math.floor((c.half.y * 2 - 2) / 3.2));
      const colsX = Math.max(2, Math.floor((c.half.x * 2 - 1.5) / 3.2));
      const colsZ = Math.max(2, Math.floor((c.half.z * 2 - 1.5) / 3.2));
      for (let row = 0; row < rows; row++) {
        const y = 1.7 + row * 3.2;
        if (y > c.half.y * 2 - 0.8) continue;
        for (let col = 0; col < colsX; col++) {
          const x = -c.half.x + 1.15 + col * ((c.half.x * 2 - 2.3) / Math.max(1, colsX - 1));
          addWindow(c.pos.x + x, y, c.pos.z - c.half.z - 0.035, 1.25, 1.45, 0.06);
          addWindow(c.pos.x + x, y, c.pos.z + c.half.z + 0.035, 1.25, 1.45, 0.06);
        }
        for (let col = 0; col < colsZ; col++) {
          const z = -c.half.z + 1.15 + col * ((c.half.z * 2 - 2.3) / Math.max(1, colsZ - 1));
          addWindow(c.pos.x - c.half.x - 0.035, y, c.pos.z + z, 0.06, 1.45, 1.25);
          addWindow(c.pos.x + c.half.x + 0.035, y, c.pos.z + z, 0.06, 1.45, 1.25);
        }
      }
      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(c.half.x * 1.72, 0.22, c.half.z * 1.72),
        frame,
      );
      roof.position.set(c.pos.x, c.pos.y + c.half.y + 0.12, c.pos.z);
      roof.castShadow = true;
      scene.add(roof);
      const plant = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.2, 1.2), frame);
      plant.position.set(c.pos.x, c.pos.y + c.half.y + 1.2, c.pos.z);
      plant.castShadow = true;
      scene.add(plant);
    }
  }

  // Visual road dressing is deliberately separate from the collision loop.
  {
    const grass = new THREE.MeshStandardMaterial({ color: 0x3f6b52, roughness: 1 });
    const road = new THREE.MeshStandardMaterial({ color: 0x30363b, roughness: 0.94 });
    const lane = new THREE.MeshBasicMaterial({ color: 0xf0d58d, transparent: true, opacity: 0.72 });
    const sidewalk = new THREE.MeshStandardMaterial({ color: 0x69727a, roughness: 0.88 });
    const addBox = (geometry: THREE.BoxGeometry, material: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.receiveShadow = true;
      scene.add(mesh);
    };
    addBox(new THREE.BoxGeometry(ARENA_HALF * 2 - 24, 0.02, ARENA_HALF * 2 - 24), grass, 0, 0.015, 0);
    for (const offset of [-144, 0, 144]) {
      addBox(new THREE.BoxGeometry(18, 0.025, ARENA_HALF * 2 - 24), road, offset, 0.03, 0);
      addBox(new THREE.BoxGeometry(ARENA_HALF * 2 - 24, 0.025, 18), road, 0, 0.035, offset);
      for (let z = -ARENA_HALF + 18; z < ARENA_HALF - 18; z += 12) {
        addBox(new THREE.BoxGeometry(0.28, 0.03, 5), lane, offset, 0.06, z);
      }
      for (let x = -ARENA_HALF + 18; x < ARENA_HALF - 18; x += 12) {
        addBox(new THREE.BoxGeometry(5, 0.03, 0.28), lane, x, 0.06, offset);
      }
      addBox(new THREE.BoxGeometry(2, 0.04, ARENA_HALF * 2 - 24), sidewalk, offset - 11, 0.05, 0);
      addBox(new THREE.BoxGeometry(2, 0.04, ARENA_HALF * 2 - 24), sidewalk, offset + 11, 0.05, 0);
    }

    // A real river corridor and pedestrian paths give the map a grounded
    // neighbourhood structure instead of an empty square plaza.
    const river = new THREE.Mesh(
      new THREE.PlaneGeometry(42, ARENA_HALF * 2 - 24),
      new THREE.MeshStandardMaterial({ color: 0x2c79a3, roughness: 0.18, metalness: 0.15 }),
    );
    river.rotation.x = -Math.PI / 2;
    river.position.set(-210, 0.055, 0);
    scene.add(river);
    for (const x of [-234, -186]) {
      addBox(new THREE.BoxGeometry(4, 0.08, ARENA_HALF * 2 - 24), sidewalk, x, 0.08, 0);
    }
    const path = new THREE.MeshBasicMaterial({ color: 0xc5b99b, transparent: true, opacity: 0.8 });
    addBox(new THREE.BoxGeometry(5, 0.035, ARENA_HALF * 2 - 24), path, -250, 0.08, 0);
    addBox(new THREE.BoxGeometry(5, 0.035, ARENA_HALF * 2 - 24), path, -170, 0.08, 0);

    const trunk = new THREE.MeshStandardMaterial({ color: 0x4b3022, roughness: 1 });
    const leaves = new THREE.MeshStandardMaterial({ color: 0x2f7c4c, roughness: 0.9 });
    for (let z = -252; z <= 252; z += 36) {
      for (const x of [-259, -161, -24, 24, 168, 264]) {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 3.2, 8), trunk);
        t.position.set(x, 1.6, z);
        t.castShadow = true;
        scene.add(t);
        const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(2.6, 1), leaves);
        crown.position.set(x, 4.4, z);
        crown.scale.y = 1.25;
        crown.castShadow = true;
        scene.add(crown);
      }
    }

    // Static traffic gives scale and makes the boulevard readable without
    // introducing extra networked physics bodies.
    const trafficBody = new THREE.MeshStandardMaterial({ color: 0xd8d9d5, roughness: 0.36, metalness: 0.45 });
    const trafficGlass = new THREE.MeshStandardMaterial({ color: 0x17232c, roughness: 0.2, metalness: 0.4 });
    for (const [x, z, rot] of [[-144, -70, 0], [-144, 74, Math.PI], [144, 42, Math.PI], [144, -98, 0]] as const) {
      const vehicle = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 3.7), trafficBody);
      body.position.y = 0.42;
      vehicle.add(body);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.42, 1.55), trafficGlass);
      roof.position.set(0, 0.82, -0.1);
      vehicle.add(roof);
      vehicle.position.set(x, 0, z);
      vehicle.rotation.y = rot;
      scene.add(vehicle);
    }

    const makeSign = (text: string, colour: string, x: number, y: number, z: number, scale: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = 900;
      canvas.height = 180;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff";
      ctx.font = "700 58px Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, canvas.width / 2, canvas.height / 2);
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(9 * scale, 1.8 * scale),
        new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), side: THREE.DoubleSide }),
      );
      sign.position.set(x, y, z);
      sign.rotation.y = Math.PI;
      scene.add(sign);
    };

    // Roadster showroom landmark: a glass-front destination building with a
    // covered forecourt and rooftop identity, matching the shared collider.
    {
      const showroom = new THREE.Group();
      const concrete = new THREE.MeshStandardMaterial({ color: 0x8e969d, roughness: 0.55, metalness: 0.25 });
      const glass = new THREE.MeshStandardMaterial({
        color: 0x8fc9df,
        emissive: 0x1d526b,
        emissiveIntensity: 0.55,
        roughness: 0.12,
        metalness: 0.45,
        transparent: true,
        opacity: 0.84,
      });
      const dark = new THREE.MeshStandardMaterial({ color: 0x17232d, roughness: 0.32, metalness: 0.7 });
      const red = new THREE.MeshStandardMaterial({ color: 0xd52f38, emissive: 0x4b080c, emissiveIntensity: 0.5 });
      const neon = new THREE.MeshBasicMaterial({ color: 0x78e7ff });
      const box = (geometry: THREE.BoxGeometry, material: THREE.Material, position: [number, number, number]) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(...position);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        showroom.add(mesh);
        return mesh;
      };
      box(new THREE.BoxGeometry(30, 14, 18), concrete, [0, 7, 0]);
      box(new THREE.BoxGeometry(24, 9, 0.18), glass, [0, 5.2, -9.12]);
      box(new THREE.BoxGeometry(24, 0.22, 1.8), dark, [0, 11.1, -9.7]);
      box(new THREE.BoxGeometry(24, 0.08, 0.12), neon, [0, 10.65, -9.62]);
      box(new THREE.BoxGeometry(30, 0.08, 0.12), neon, [0, 13.85, -8.9]);
      for (const x of [-13, -8, 8, 13]) box(new THREE.BoxGeometry(0.45, 10, 0.5), dark, [x, 5.2, -9.4]);
      box(new THREE.BoxGeometry(9, 0.12, 7), red, [0, 14.15, 0]);
      box(new THREE.BoxGeometry(2.2, 0.15, 6), dark, [-10.5, 14.2, 0]);
      box(new THREE.BoxGeometry(2.2, 0.15, 6), dark, [10.5, 14.2, 0]);
      // Covered forecourt facing the boulevard.
      box(new THREE.BoxGeometry(34, 0.18, 8), dark, [0, 0.16, -13]);
      for (const x of [-14, 14]) box(new THREE.BoxGeometry(0.5, 4, 0.5), concrete, [x, 2, -13]);
      showroom.position.set(210, 0, 35);
      scene.add(showroom);
      makeSign("ROADSTER SHOWROOM", "#172d40", 210, 17.4, 25.5, 1.35);
      makeSign("DRIVE THE FUTURE", "#c62832", 210, 15.2, 25.5, 0.72);
    }

    const signPole = new THREE.MeshStandardMaterial({ color: 0x777d80, metalness: 0.6, roughness: 0.45 });
    const stop = new THREE.MeshBasicMaterial({ color: 0xd92e2e });
    for (const [x, z] of [[-132, -15], [132, 15]] as const) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 8), signPole);
      pole.position.set(x, 1.2, z);
      scene.add(pole);
      const plate = new THREE.Mesh(new THREE.CircleGeometry(0.42, 8), stop);
      plate.position.set(x, 2.25, z);
      plate.rotation.y = Math.PI / 2;
      scene.add(plate);
    }

    makeSign("M  McDONALD'S", "#b51e2b", -252, 8, -35, 1.4);
    makeSign("DRIVING TEST  ·  PASS THE BLUE GATES", "#176d92", 252, 5, 35, 0.9);
    makeSign("STUNT LOOP  ·  COMPLETE THE CIRCLE", "#b51f35", 104, 18, 68, 1.15);
  }

  // plaza markings: launch strip + centre pad + soft-boundary ring
  {
    const stripMat = new THREE.MeshBasicMaterial({ color: 0xf2f1ee, transparent: true, opacity: 0.25 });
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(14, 210), stripMat);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(90, 0.02, -18);
    scene.add(strip);

    const ringMat = new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.35 });
    const ring = new THREE.Mesh(new THREE.RingGeometry(cfg.arena.softWallRadius - 1.1, cfg.arena.softWallRadius, 96), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    scene.add(ring);

    const pads = new THREE.Mesh(new THREE.RingGeometry(18, 19.2, 48), new THREE.MeshBasicMaterial({ color: 0x7ec8ff, transparent: true, opacity: 0.3, side: THREE.DoubleSide }));
    pads.rotation.x = -Math.PI / 2;
    pads.position.y = 0.03;
    scene.add(pads);
  }

  // ---- gates: glowing rings in the sky ----
  const gateRings: THREE.Object3D[] = [];
  const gateMats: THREE.MeshStandardMaterial[] = [];
  for (const gate of def.gates) {
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x7ec8ff, emissive: 0x2fa8ff, emissiveIntensity: 1.1, metalness: 0.4, roughness: 0.3 });
    gateMats.push(mat);
    const torus = new THREE.Mesh(new THREE.TorusGeometry(gate.radius, 0.45, 12, 40), mat);
    group.add(torus);
    // inner disc shimmer
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(gate.radius - 0.6, 32),
      new THREE.MeshBasicMaterial({ color: 0x7ec8ff, transparent: true, opacity: 0.1, side: THREE.DoubleSide }),
    );
    group.add(disc);
    group.position.set(gate.pos.x, gate.pos.y, gate.pos.z);
    // orient the ring so its axis matches the boost direction
    const fwd = new THREE.Vector3(gate.forward.x, gate.forward.y, gate.forward.z).normalize();
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), fwd);
    scene.add(group);
    gateRings.push(group);
  }

  function setGateBoost(index: number): void {
    const mat = gateMats[index];
    if (!mat) return;
    mat.emissiveIntensity = 3.5;
    mat.color.set(0xffb37e);
    setTimeout(() => {
      mat.emissiveIntensity = 1.1;
      mat.color.set(0x7ec8ff);
    }, 400);
  }

  const onResize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  onResize();
  addEventListener("resize", onResize);

  return {
    scene,
    camera,
    renderer,
    gateRings,
    setGateBoost,
    dispose() {
      removeEventListener("resize", onResize);
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
      renderer.dispose();
    },
  };
}

export { ARENA_HALF };
