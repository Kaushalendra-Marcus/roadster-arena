/**
 * Landing 3D stages (spec 10.2) — both driven by the real Roadster asset:
 *  - `initShowroom()`: the hero. The GLB on a mirror floor under the arena
 *    glow — drag to spin, 360° arrows, wheel zoom, idle turntable.
 *  - `initGarage()`: the car section. The same model under a lab grid with
 *    spec hotspots pinned to model-space anchors (fractions of its bounding
 *    box, so re-exporting the asset cannot unhook them).
 *
 * The model is loaded once and cloned per stage (materials intentionally
 * shared). Source space: front = −Z, length ≈ 4.84, so both stages rotate a
 * yaw turntable instead of touching the mesh. Reference photography stands in
 * if the asset cannot load; stages pause when off-screen.
 */
import * as THREE from "three";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const CAR_URL = "/assets/reference/tesla_roadster_-_low_poly.glb";
/** length of the car on stage (metres) — the source is 4.84 long */
const CAR_LENGTH = 4.35;

export interface HotspotSpec {
  id: string;
  label: string;
  value: string;
  /** fractions (0–1) of the car's bounding box in client space */
  anchor?: { x?: number; y?: number; z?: number };
  /** vertical label nudge in px, to keep two nearby tags from stacking */
  tagY?: number;
}

/* ------------------------------ shared bits ------------------------------- */

let carPromise: Promise<THREE.Object3D> | null = null;

/** load the Roadster once; stages clone it */
function loadCar(): Promise<THREE.Object3D> {
  carPromise ??= new Promise((resolve, reject) => {
    new GLTFLoader().load(CAR_URL, (gltf) => resolve(gltf.scene), undefined, reject);
  });
  return carPromise;
}

/** studio reflections: a procedural room env makes PBR paint read properly */
function applyRoomEnv(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
}

/**
 * Showroom skin. The source asset is a red low-poly car with grey running
 * gear; these overrides turn it into the reveal car's spec — Ano White paint,
 * gold-tinted canopy glass, a red tail bar, a warm light blade and dark
 * wheels. Unknown materials keep whatever the asset authored.
 */
const SKIN: Record<
  string,
  { color: number; metalness?: number; roughness?: number; emissive?: number; emissiveIntensity?: number }
> = {
  "Material.001": { color: 0xe9e5dc, metalness: 0.22, roughness: 0.3 }, // body paint
  "Material.002": { color: 0xcf1b1b, metalness: 0.2, roughness: 0.28, emissive: 0xff2a1f, emissiveIntensity: 0.7 }, // tail bar
  "Material.003": { color: 0xfff1dc, metalness: 0.1, roughness: 0.3, emissive: 0xffe7c4, emissiveIntensity: 0.4 }, // light blade
  "Material.004": { color: 0x101114, metalness: 0.35, roughness: 0.55 }, // lower intake
  "Material.005": { color: 0xd6d8dc, metalness: 0.5, roughness: 0.4 }, // plate
  "Material.006": { color: 0x15171b, metalness: 0.55, roughness: 0.16 }, // glazing band
  "Material.007": { color: 0x15171b, metalness: 0.55, roughness: 0.16 }, // targa glass
  "Material.008": { color: 0x1c1811, metalness: 0.5, roughness: 0.12 }, // gold-tinted windshield
  CarParts_Mat: { color: 0x2a2c31, metalness: 0.55, roughness: 0.42 }, // wheels + interior
  Tesla_Mat: { color: 0x1b1c20, metalness: 0.45, roughness: 0.5 }, // rear trim
};

/**
 * Normalise a freshly loaded car: sit it on the floor, centre it, scale to
 * CAR_LENGTH and apply the showroom <see SKIN>. Materials are cloned per
 * stage, so the hero and the garage can share one parsed asset safely.
 */
function fitCar(model: THREE.Object3D): THREE.Group {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = CAR_LENGTH / Math.max(size.x, size.z, size.y);
  model.scale.setScalar(scale);
  model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    // clone materials per stage: the hero and the garage share one loaded
    // asset, and the skin must only apply once per material
    const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const treated = source.map((material) => {
      if (!material || !("color" in material)) return material;
      const s = material.clone() as THREE.MeshStandardMaterial;
      const skin = SKIN[s.name];
      if (skin) {
        s.color.setHex(skin.color);
        if (s.isMeshStandardMaterial) {
          s.metalness = skin.metalness ?? s.metalness;
          s.roughness = skin.roughness ?? s.roughness;
          s.envMapIntensity = 1.05;
          if (skin.emissive !== undefined) {
            s.emissive.setHex(skin.emissive);
            s.emissiveIntensity = skin.emissiveIntensity ?? 1;
          }
        }
      }
      return s;
    });
    mesh.material = Array.isArray(mesh.material) ? treated : treated[0];
  });
  const group = new THREE.Group();
  group.add(model);
  return group;
}

function makeShadowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
  g.addColorStop(0, "rgba(4, 10, 15, 0.65)");
  g.addColorStop(0.55, "rgba(4, 10, 15, 0.28)");
  g.addColorStop(1, "rgba(4, 10, 15, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGlowTexture(rgb: string): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 128, 8, 128, 128, 128);
  g.addColorStop(0, `rgba(${rgb}, 0.55)`);
  g.addColorStop(0.5, `rgba(${rgb}, 0.16)`);
  g.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ----------------------------- hero showroom ------------------------------ */

export function initShowroom(): void {
  const canvas = document.getElementById("hero-car") as HTMLCanvasElement | null;
  const landing = document.getElementById("landing");
  if (!canvas || !landing) return;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;

  const scene = new THREE.Scene();
  scene.background = null; // page gradient shows through (alpha canvas)
  applyRoomEnv(renderer, scene);

  const camera = new THREE.PerspectiveCamera(29, 1, 0.1, 160);
  const CAM_BASE = new THREE.Vector3(12.6, 4.6, 4.2);
  // target sits above the car so the headline area stays clear and the car
  // rests in the lower half of the hero frame
  const TARGET = new THREE.Vector3(0, 2.0, 0);
  const CAM_DIR = CAM_BASE.clone().normalize();
  camera.position.copy(CAM_BASE);
  camera.lookAt(TARGET);

  // mirror floor with a darkening plane on top to fade with distance
  const reflector = new Reflector(new THREE.PlaneGeometry(60, 60), {
    textureWidth: 1024,
    textureHeight: 1024,
    color: 0x46545e,
  });
  reflector.rotation.x = -Math.PI / 2;
  scene.add(reflector);
  const dim = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshBasicMaterial({ color: 0x101c24, transparent: true, opacity: 0.5, depthWrite: false }),
  );
  dim.rotation.x = -Math.PI / 2;
  dim.position.y = 0.002;
  scene.add(dim);

  // dashed turntable rings — neutral + accent
  const ringMat = new THREE.LineBasicMaterial({ color: 0xbfd9e4, transparent: true, opacity: 0.5 });
  const accentMat = new THREE.LineBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.4 });
  const makeRing = (radius: number, mat: THREE.LineBasicMaterial, inset: number) => {
    const ring = new THREE.Group();
    const SEGMENTS = 72;
    for (let i = 0; i < SEGMENTS; i++) {
      if (i % 3 === 2) continue; // dashes
      const a0 = (i / SEGMENTS) * Math.PI * 2;
      const a1 = a0 + ((Math.PI * 2) / SEGMENTS) / 2.7;
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(Math.cos(a0) * radius, inset, Math.sin(a0) * radius),
        new THREE.Vector3(Math.cos(a1) * radius, inset, Math.sin(a1) * radius),
      ]);
      ring.add(new THREE.LineSegments(g, mat));
    }
    scene.add(ring);
    return ring;
  };
  const ring = makeRing(3.55, ringMat, 0.012);
  const ringOuter = makeRing(4.45, accentMat, 0.01);

  // lights — cool studio, warm arena kicker, cyan rim for the game palette
  scene.add(new THREE.HemisphereLight(0xcfe6f2, 0x0d141a, 1.15));
  const key = new THREE.DirectionalLight(0xfff3e6, 3.2);
  key.position.set(5.5, 8, 7);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x7fa7c0, 1.4);
  fill.position.set(-7, 4, -6);
  scene.add(fill);
  const kicker = new THREE.PointLight(0xff7a1a, 110, 26, 2);
  kicker.position.set(-5.4, 1.4, -4.6);
  scene.add(kicker);
  const rimCyan = new THREE.PointLight(0x37d6ff, 70, 26, 2);
  rimCyan.position.set(6.2, 3.2, -5.2);
  scene.add(rimCyan);

  // ============================== the car ============================
  const turntable = new THREE.Group(); // yaw spins this
  scene.add(turntable);
  // soft round contact shadow (fake, cheap, reads like a studio floor)
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(2.9, 48),
    new THREE.MeshBasicMaterial({ map: makeShadowTexture(), transparent: true, depthWrite: false }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.004;
  turntable.add(blob);

  let modelReady = false;
  void loadCar().then(
    (source) => {
      turntable.add(fitCar(source.clone(true)));
      blob.position.y = 0.006;
      modelReady = true;
    },
    () => showFallback(),
  );

  function showFallback(): void {
    const fb = document.getElementById("hero-fallback");
    if (fb) fb.classList.add("show");
    document.getElementById("hero-car")?.classList.add("hidden");
  }

  // ========================= interactions ============================
  let yaw = -2.35; // front-left three-quarter, the reveal-photo angle
  let targetYaw = yaw;
  let dragVel = 0;
  let dragging = false;
  let lastX = 0;
  let dolly = 0; // camera distance offset from CAM_BASE
  const DOLLY_MIN = -3.6;
  const DOLLY_MAX = 6;

  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* some browsers race captures */
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    targetYaw -= dx * 0.008;
    dragVel = -dx * 0.008;
  };
  const onPointerUp = () => {
    dragging = false;
  };
  const onWheel = (e: WheelEvent) => {
    // wheel over the car zooms the studio camera; once the dolly can't go
    // any further in this direction the gesture falls through and the page
    // scrolls instead (zoom exhausts before scroll takes over)
    const next = Math.max(DOLLY_MIN, Math.min(DOLLY_MAX, dolly + e.deltaY * 0.008));
    if (next === dolly) return;
    e.preventDefault();
    dolly = next;
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  const nudge = (dYaw: number) => {
    targetYaw += dYaw;
    dragVel = dYaw * 0.12;
  };
  document.getElementById("spin-left")?.addEventListener("click", () => nudge(Math.PI / 6));
  document.getElementById("spin-right")?.addEventListener("click", () => nudge(-Math.PI / 6));

  const resize = () => {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  addEventListener("resize", resize);
  resize();

  // ============================ render loop ==========================
  const startedAt = performance.now();
  const render = () => {
    const t = (performance.now() - startedAt) / 1000;
    if (!document.hidden && !landing.classList.contains("hidden")) {
      // auto-spin unless the user is actively dragging; released drag glides
      if (!dragging) {
        dragVel *= 0.94;
        targetYaw += dragVel * 0.016 + 0.0011; // gentle idle turntable
      }
      yaw += (targetYaw - yaw) * Math.min(1, 8 * 0.016);
      turntable.rotation.y = yaw;
      ring.rotation.y = yaw * 0.55;
      ringOuter.rotation.y = -yaw * 0.32;
      ringMat.opacity = 0.5 + Math.sin(t * 1.7) * 0.08;
      accentMat.opacity = 0.32 + Math.sin(t * 1.7 + 1.3) * 0.1;

      if (modelReady) {
        // the car group already sits on the floor; bob the whole turntable
        turntable.position.y = Math.sin(t * 0.9) * 0.03;
      }
      camera.position.copy(CAM_BASE).addScaledVector(CAM_DIR, dolly);
      camera.lookAt(TARGET);
      renderer.render(scene, camera);
    }
    requestAnimationFrame(render);
  };
  render();
}

/* ----------------------------- garage stage ------------------------------- */

export function initGarage(hotspots: HotspotSpec[] = []): void {
  const canvas = document.getElementById("garage-car") as HTMLCanvasElement | null;
  const stage = document.getElementById("garage-stage");
  const layer = document.getElementById("hotspot-layer");
  if (!canvas || !stage || !layer) return;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.04;

  const scene = new THREE.Scene();
  scene.background = null;
  applyRoomEnv(renderer, scene);

  const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 80);
  const CAM_BASE = new THREE.Vector3(5.1, 2.25, 5.0);
  const TARGET = new THREE.Vector3(0, 0.48, 0);
  camera.position.copy(CAM_BASE);
  camera.lookAt(TARGET);

  // lab floor: dark slab, grid lines, warm pool under the car
  const slab = new THREE.Mesh(
    new THREE.CircleGeometry(16, 64),
    new THREE.MeshBasicMaterial({ color: 0x080b10 }),
  );
  slab.rotation.x = -Math.PI / 2;
  scene.add(slab);
  const grid = new THREE.GridHelper(40, 40, 0x2b3b48, 0x151d25);
  grid.position.y = 0.01;
  scene.add(grid);
  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(4.6, 48),
    new THREE.MeshBasicMaterial({ map: makeGlowTexture("255, 122, 26"), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.02;
  scene.add(pool);
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(2.7, 48),
    new THREE.MeshBasicMaterial({ map: makeShadowTexture(), transparent: true, depthWrite: false }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.03;
  scene.add(blob);

  // lights — neutral key, orange + cyan rim exactly like the HUD palette
  scene.add(new THREE.HemisphereLight(0xbcd6e6, 0x0a0e13, 0.85));
  const key = new THREE.DirectionalLight(0xfff4e8, 2.6);
  key.position.set(4.5, 6.5, 5.5);
  scene.add(key);
  const rimOrange = new THREE.PointLight(0xff7a1a, 85, 22, 2);
  rimOrange.position.set(-4.6, 1.5, -3.2);
  scene.add(rimOrange);
  const rimCyan = new THREE.PointLight(0x37d6ff, 60, 22, 2);
  rimCyan.position.set(4.8, 2.6, -3.8);
  scene.add(rimCyan);

  // ============================== the car ============================
  const carGroup = new THREE.Group();
  carGroup.rotation.y = -2.9; // front-left three-quarter
  scene.add(carGroup);

  let carReady = false;
  const anchors: { el: HTMLElement; pos: THREE.Vector3 }[] = [];
  void loadCar().then(
    (source) => {
      const placed = fitCar(source.clone(true));
      // measure in the car's own space — measuring after the stage yaw would
      // inflate the box with the rotated silhouette and push anchors off-body
      const box = new THREE.Box3().setFromObject(placed);
      const size = box.getSize(new THREE.Vector3());
      carGroup.add(placed);
      for (const h of hotspots) {
        const el = document.createElement("div");
        el.className = "hotspot";
        el.title = `${h.label} — ${h.value}`;
        if (typeof h.tagY === "number") el.style.setProperty("--tag-y", `${h.tagY}px`);
        el.innerHTML = `<i class="dot"></i><span class="tag"><b></b></span>`;
        (el.querySelector(".tag b") as HTMLElement).textContent = h.label;
        layer.append(el);
        const fx = clamp01(h.anchor?.x ?? 0.5);
        const fy = clamp01(h.anchor?.y ?? 0.5);
        const fz = clamp01(h.anchor?.z ?? 0.5);
        const pos = new THREE.Vector3(
          box.min.x + size.x * fx,
          box.min.y + size.y * fy,
          box.min.z + size.z * fz,
        );
        // pos is already in carGroup space (the box was measured pre-yaw)
        anchors.push({ el, pos });
      }
      carReady = true;
    },
    () => {
      document.getElementById("garage-fallback")?.classList.add("show");
      canvas.classList.add("hidden");
      layer.classList.add("hidden");
    },
  );

  // ========================= interactions ============================
  let yaw = -2.9;
  let targetYaw = yaw;
  let dragVel = 0;
  let dragging = false;
  let lastX = 0;

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* fine */
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    targetYaw -= dx * 0.009;
    dragVel = -dx * 0.009;
  });
  canvas.addEventListener("pointerup", () => (dragging = false));
  canvas.addEventListener("pointercancel", () => (dragging = false));

  const resize = () => {
    const w = canvas.clientWidth || 640;
    const h = canvas.clientHeight || 420;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // wider lens on a portrait stage: the car is viewed at 3/4, so its long
    // side needs the extra horizontal field
    camera.fov = camera.aspect < 0.95 ? 35 : 31;
    camera.updateProjectionMatrix();
  };
  addEventListener("resize", resize);
  resize();

  // pause when the stage is scrolled away
  let onScreen = false;
  const io = new IntersectionObserver(
    (entries) => (onScreen = entries.some((e) => e.isIntersecting)),
    { rootMargin: "140px" },
  );
  io.observe(stage);

  // ============================ render loop ==========================
  const tmp = new THREE.Vector3();
  const worldPos = new THREE.Vector3();
  const carCenter = new THREE.Vector3();
  const viewDir = new THREE.Vector3();
  const render = () => {
    if (!document.hidden && onScreen) {
      if (!dragging) {
        dragVel *= 0.94;
        targetYaw += dragVel * 0.016 + 0.0016; // idle turntable
      }
      yaw += (targetYaw - yaw) * Math.min(1, 8 * 0.016);
      carGroup.rotation.y = yaw;
      camera.position.copy(CAM_BASE);
      camera.lookAt(TARGET);
      renderer.render(scene, camera); // rebuilds matrices for the labels

      if (carReady) {
        const w = canvas.clientWidth || 1;
        const h = canvas.clientHeight || 1;
        // hide anchors on the far side of the body: they would otherwise
        // float over the car and crowd the labels on the near side
        carCenter.setFromMatrixPosition(carGroup.matrixWorld);
        viewDir.copy(camera.position).sub(carCenter).normalize();
        for (const { el, pos } of anchors) {
          worldPos.copy(pos).applyMatrix4(carGroup.matrixWorld);
          const nearSide = tmp.subVectors(worldPos, carCenter).dot(viewDir) > -0.35;
          tmp.copy(worldPos).project(camera);
          const inView =
            nearSide && tmp.z > -1 && tmp.z < 1 && Math.abs(tmp.x) < 1.25 && Math.abs(tmp.y) < 1.25;
          el.classList.toggle("on", inView);
          if (!inView) continue;
          const x = (tmp.x * 0.5 + 0.5) * w;
          const y = (-tmp.y * 0.5 + 0.5) * h;
          el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
          el.classList.toggle("flip", x > w * 0.62);
        }
      }
    }
    requestAnimationFrame(render);
  };
  render();
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
}
