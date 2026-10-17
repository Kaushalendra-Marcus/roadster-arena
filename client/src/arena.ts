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
  scene.background = new THREE.Color(0x0b0d12);
  scene.fog = new THREE.Fog(0x0b0d12, 160, 620);

  const camera = new THREE.PerspectiveCamera(64, canvas.clientWidth / canvas.clientHeight, 0.1, 900);

  // ---- lights ----
  const hemi = new THREE.HemisphereLight(0xdce7ff, 0x252936, 1.15);
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
          vec3 top = vec3(0.02, 0.03, 0.06);
          vec3 mid = vec3(0.07, 0.09, 0.14);
          vec3 glow = vec3(0.55, 0.28, 0.12);
          vec3 c = mix(mid, top, clamp(h * 1.6, 0.0, 1.0));
          float sunset = pow(clamp(1.0 - abs(h - 0.02) * 3.2, 0.0, 1.0), 2.0);
          c = mix(c, glow, sunset * 0.55);
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });
    scene.add(new THREE.Mesh(skyGeo, skyMat));

    // stars
    const starCount = 700;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.8); // upper hemisphere bias
      const r = 720;
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.cos(phi) + 40;
      starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x9fb4dd, size: 1.6, sizeAttenuation: false, fog: false })));
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
