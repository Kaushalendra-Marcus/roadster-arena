/**
 * Landing hero showroom: the Roadster GLB on a mirror floor with a studio
 * gradient — grab to spin, 360° arrows, wheel zoom, headline model cycler.
 * Everything visual is generated (gradients, SVG, three.js), so reference
 * photos can replace the hero later without touching this module.
 */
import * as THREE from "three";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const CAR_URL = "/assets/reference/tesla_roadster_-_low_poly.glb";

export function initShowroom(): void {
  const canvas = document.getElementById("hero-car") as HTMLCanvasElement | null;
  const landing = document.getElementById("landing");
  if (!canvas || !landing) return;

  // ============================== scene ==============================
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = null; // page gradient shows through (alpha canvas)

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 160);
  const CAM_BASE = new THREE.Vector3(12.4, 5.2, 3.2);
  // target sits above the car so the headline area stays clear and the car
  // rests in the lower half of the hero frame
  const TARGET = new THREE.Vector3(0, 2.1, 0);
  const CAM_DIR = CAM_BASE.clone().normalize();
  camera.position.copy(CAM_BASE);
  camera.lookAt(TARGET);

  // mirror floor with a darkening plane on top to fade with distance
  const reflector = new Reflector(new THREE.PlaneGeometry(60, 60), {
    textureWidth: 1024,
    textureHeight: 1024,
    color: 0x50606c,
  });
  reflector.rotation.x = -Math.PI / 2;
  scene.add(reflector);
  const dim = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshBasicMaterial({
      color: 0x16262f,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    }),
  );
  dim.rotation.x = -Math.PI / 2;
  dim.position.y = 0.002;
  scene.add(dim);

  // dashed turntable ring (flat segment ring under the car)
  const ringMat = new THREE.LineBasicMaterial({ color: 0xbfd9e4, transparent: true, opacity: 0.5 });
  const RING_R = 3.55;
  const ring = new THREE.Group();
  const SEGMENTS = 72;
  for (let i = 0; i < SEGMENTS; i++) {
    if (i % 3 === 2) continue; // dashes
    const a0 = (i / SEGMENTS) * Math.PI * 2;
    const a1 = a0 + ((Math.PI * 2) / SEGMENTS) / 2.7;
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(Math.cos(a0) * RING_R, 0.012, Math.sin(a0) * RING_R),
      new THREE.Vector3(Math.cos(a1) * RING_R, 0.012, Math.sin(a1) * RING_R),
    ]);
    ring.add(new THREE.LineSegments(g, ringMat));
  }
  scene.add(ring);

  // lights — cool studio with a warm kicker, high-key on the nose
  scene.add(new THREE.HemisphereLight(0xcfe6f2, 0x0d141a, 1.5));
  const key = new THREE.DirectionalLight(0xf4fbff, 3.4);
  key.position.set(5.5, 8, 7);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x7fa7c0, 1.6);
  fill.position.set(-7, 4, -6);
  scene.add(fill);
  const kicker = new THREE.PointLight(0xffc9a0, 60, 22, 2);
  kicker.position.set(-4.6, 1.1, 5.4);
  scene.add(kicker);

  // ============================== the car ============================
  const turntable = new THREE.Group(); // yaw spins this
  scene.add(turntable);
  const car = new THREE.Group();
  turntable.add(car);
  // soft round contact shadow (fake, cheap, reads like a studio floor)
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(2.9, 48),
    new THREE.MeshBasicMaterial({
      map: makeShadowTexture(),
      transparent: true,
      depthWrite: false,
    }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.004;
  turntable.add(blob);

  let modelReady = false;
  new GLTFLoader().load(
    CAR_URL,
    (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale = 4.35 / Math.max(size.x, size.z, size.y);
      model.scale.setScalar(scale);
      model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
      model.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const std of materials) {
          if (!std || !("color" in std)) continue;
          const s = std as THREE.MeshStandardMaterial;
          s.color.offsetHSL(0, -0.25, 0.22); // showroom silver
          s.metalness = Math.max(s.metalness, 0.55);
          s.roughness = Math.min(s.roughness, 0.28);
        }
      });
      const feet = new THREE.Box3().setFromObject(model);
      car.position.y = -feet.min.y; // sit exactly on the floor
      car.add(model);
      blob.position.y = 0.006;
      modelReady = true;
    },
    undefined,
    () => showFallback(),
  );

  function showFallback(): void {
    // reference side-view photo until the real hero asset lands
    const fb = document.getElementById("hero-fallback");
    if (fb) fb.classList.add("show");
    if (canvas) canvas.classList.add("hidden");
  }

  // ========================= interactions ============================
  let yaw = Math.PI * 0.5; // starts near the side view
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

  // headline model cycler (keeps the chevron — only #model-name swaps)
  const MODELS = ["Tesla Roadster <em>2026</em>", "Roadster <em>R-01</em>", "Skyline <em>Spec</em>"];
  let modelIdx = 0;
  const modelName = document.getElementById("model-name");
  document.getElementById("model-cycle")?.addEventListener("click", () => {
    modelIdx = (modelIdx + 1) % MODELS.length;
    if (modelName) modelName.innerHTML = MODELS[modelIdx];
  });

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

      if (modelReady) {
        // the car group already sits on the floor; bob the whole turntable
        turntable.position.y = Math.sin(t * 0.9) * 0.03;
      }
      camera.position.copy(CAM_BASE).addScaledVector(CAM_DIR, dolly);
      camera.lookAt(TARGET);
      ringMat.opacity = 0.5 + Math.sin(t * 1.7) * 0.08;
      renderer.render(scene, camera);
    }
    requestAnimationFrame(render);
  };
  render();
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
