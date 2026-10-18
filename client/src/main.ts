/**
 * Main entry (spec 3, 5, 9, 15): wires the landing page, the join flow, the
 * game loop (fixed 60 Hz prediction + rAF render), remote interpolation,
 * HUD, audio and touch.
 */

import {
  DEFAULT_GAMEPLAY,
  EMOTES,
  quatMul,
  type ArenaState,
  type CarPlayer,
} from "@roadster-arena/shared";
import * as THREE from "three";
import { createNet, pickColour, type Net } from "./net.js";
import { createInput } from "./input.js";
import { createHud, pickEmote } from "./hud.js";
import { createAudio, type GameAudio } from "./audio.js";
import { initPhysQuery, type PhysQuery } from "./physics-query.js";
import { Predictor, type OwnCarSnapshot } from "./prediction.js";
import { RemoteInterp } from "./remotes.js";
import { createArenaView, type ArenaView } from "./arena.js";
import { createCarVisual, colourFor, type CarVisual } from "./car-model.js";
import { initShowroom } from "./landing.js";

const CFG = DEFAULT_GAMEPLAY;

type Vec3Like = { x: number; y: number; z: number };
type QuatLike = { x: number; y: number; z: number; w: number };
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const hud = createHud();
let audio: GameAudio | null = null;
let net: Net | null = null;
let input: ReturnType<typeof createInput> | null = null;
let arena: ArenaView | null = null;
let query: PhysQuery | null = null;
let predictor: Predictor | null = null;
let ownVisual: CarVisual | null = null;

const remoteVisuals = new Map<string, CarVisual>();
const remoteInterps = new Map<string, RemoteInterp>();

let joined = false;
let loopRunning = false;
/* two independent fixed-rate accumulators: inputs at 30 Hz, prediction at 60 */
let inputAcc = 0;
let tickAcc = 0;
let lastFrameMs = 0;
let pingAt = 0;
let deathRespawnAt = 0;
let bannerTimer: ReturnType<typeof setTimeout> | undefined;
let drivingTestUntil = 0;
let drivingTestStartScore = 0;
let drivingTestGates = 0;
let drivingTestBest = 0;

const drivingTestButton = document.getElementById("driving-test") as HTMLButtonElement;
drivingTestButton.addEventListener("click", () => {
  const score = net?.room?.state?.players.get(net.sessionId)?.score ?? 0;
  drivingTestStartScore = score;
  drivingTestGates = 0;
  drivingTestUntil = performance.now() + 45_000;
  hud.testStatus("DRIVING TEST · 45s · PASS THROUGH GATES", true);
});

// camera state (chase spring)
let camYaw = 0;
const cam = {
  pos: { x: 0, y: 6, z: -12 } as Vec3Like,
  look: { x: 0, y: 1, z: 0 } as Vec3Like,
  tilt: 0,
};

// ============================== landing page ==============================

interface RoadsterContent {
  specs: { label: string; value: string }[];
  honesty: { note: string };
  reservations: { buttonLabel: string };
}

async function initFacts(): Promise<void> {
  const facts = (await import("../../content/roadster.json")).default as RoadsterContent;

  const grid = document.getElementById("fact-grid") as HTMLElement;
  const items: HTMLElement[] = [];
  for (const f of facts.specs.slice(0, 5)) {
    const div = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = f.label;
    const dd = document.createElement("dd");
    dd.textContent = f.value;
    div.append(dt, dd);
    items.push(div);
  }
  grid.replaceChildren(...items);

  (document.getElementById("legal-disclaimer") as HTMLElement).textContent = facts.honesty.note;
  const reserveBtn = document.getElementById("reserve-button") as HTMLAnchorElement;
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env ?? {};
  const reserveUrl = env.VITE_RESERVE_URL ?? "";
  if (reserveUrl) {
    reserveBtn.href = reserveUrl;
    (document.getElementById("reserve-note") as HTMLElement).textContent = `Opens the official ${facts.reservations.buttonLabel} page in a new tab.`;
  } else {
    // spec 3.3: no valid owner link yet → the button stays but reservation
    // simply isn't wired astray
    reserveBtn.classList.add("is-disabled");
    reserveBtn.removeAttribute("href");
  }
  (document.getElementById("foot-version") as HTMLElement).textContent = "revealed 2026";
}

function initLanding(): void {
  document.title = "Roadster Arena — drive it, then leave the ground";

  // hero CTA = the arena entry
  (document.getElementById("play-now") as HTMLButtonElement).addEventListener("click", () => {
    hud.showGame();
    hud.showJoinOverlay(true);
    (document.getElementById("join-name") as HTMLInputElement).focus();
  });
  (document.getElementById("join-back") as HTMLButtonElement).addEventListener("click", () => {
    hud.showJoinOverlay(false);
    hud.showLanding();
  });
  (document.getElementById("join-form") as HTMLFormElement).addEventListener("submit", (e) => {
    e.preventDefault();
    void startGame();
  });

  try {
    initShowroom();
  } catch (err) {
    console.error("showroom init failed", err);
  }
  void initFacts().catch((err) => {
    console.error("facts init failed", err);
  });
}

// ============================== game bootstrap ============================

async function startGame(): Promise<void> {
  if (joined) return;
  const nameField = document.getElementById("join-name") as HTMLInputElement;
  const name = nameField.value.trim();
  const err = document.getElementById("join-error") as HTMLElement;
  if (name.length < 2 || name.length > 16) {
    err.textContent = "Name must be 2–16 characters.";
    return;
  }
  err.textContent = "";
  joined = true;

  hud.showGame();
  hud.showJoinOverlay(false);
  hud.status("Connecting…");

  // user gesture side: audio may start here
  audio = audio ?? createAudio();
  input = input ?? createInput(document.getElementById("arena-canvas") as HTMLCanvasElement);

  net = createNet({
    onPhase: (phase, detail) => {
      if (phase === "connecting") hud.status("Connecting to arena…");
      else if (phase === "in-room") hud.clearStatus();
      else if (phase === "closed") {
        hud.status(`Disconnected${detail ? ` — ${detail}` : ""}`, "bad");
        void teardown();
      }
    },
    onState: (state) => onStatePatch(state),
    onWelcome: (msg) => {
      hud.welcome(msg.roomName, msg.playerCount);
      hud.clearStatus();
    },
    onBump: (_x, _y, _z, strength) => audio?.bump(strength),
    onGateBoost: (gateIndex) => {
      audio?.gate();
      arena?.setGateBoost(gateIndex);
      if (drivingTestUntil > performance.now()) drivingTestGates++;
      if (gateIndex === 0) {
        audio?.cheer();
        hud.testStatus("STUNT LOOP COMPLETE · CROWD CHEER · +500", true);
      }
    },
    onRejected: (reason, details) => hud.status(`Rejected: ${reason}${details ? ` — ${details}` : ""}`, "bad"),
  });

  try {
    query = await initPhysQuery(CFG);
    arena = createArenaView(document.getElementById("arena-canvas") as HTMLCanvasElement, CFG, query);
    await net.join(name, pickColour(name));
    // the loop starts once the predictor exists (first own-car state patch)
  } catch (e) {
    hud.status(e instanceof Error ? e.message : String(e), "bad");
    joined = false;
    return;
  }

  hud.touch(input.touchActive || matchMedia("(pointer: coarse)").matches);
  (document.getElementById("hud-leave") as HTMLButtonElement).addEventListener("click", () =>
    void teardown());
}

function teardown(): void {
  loopRunning = false;
  drivingTestUntil = 0;
  hud.testStatus("", false);
  net?.leave();
  for (const v of remoteVisuals.values()) v.dispose();
  remoteVisuals.clear();
  remoteInterps.clear();
  ownVisual?.dispose();
  ownVisual = null;
  predictor = null;
  arena?.dispose();
  arena = null;
  audio?.suspend();
  hud.showJoinOverlay(false);
  hud.showLanding();
  input?.dispose();
  input = null;
  query = null;
  joined = false;
}

// ============================== state patches =============================

function onStatePatch(state: ArenaState): void {
  if (!net || !arena) return;
  hud.players(state.players.size);

  const me = state.players.get(net.sessionId);
  if (!predictor && me) {
    // first own-car snapshot: seed the predictor at the server spawn
    spawnPredictor(me);
  }
  if (me && predictor) {
    predictor.reconcile(ownSnapshot(me), performance.now());
    hud.gas(me.gas, me.mode === "hover" || me.mode === "grip");
    hud.score(me.score);
    hud.mode(me.mode);
    // hard snap while the server says spawn protection is on = we respawned
    if (predictor.snapped && me.ghostUntil > 0) {
      hud.respawnBanner(true);
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => hud.respawnBanner(false), 1600);
    }
    if (me.emoteId) {
      const em = pickEmote(me.emoteId);
      if (em) hud.emote(em.name, em.glyph);
    }
  }

  // remotes: create/update/remove
  const seen = new Set<string>();
  for (const p of state.players.values()) {
    if (p.id === net.sessionId) continue;
    seen.add(p.id);
    let interp = remoteInterps.get(p.id);
    if (!interp) {
      interp = new RemoteInterp(p.id, 110);
      remoteInterps.set(p.id, interp);
    }
    interp.push(performance.now(), p);

    let visual = remoteVisuals.get(p.id);
    if (!visual) {
      visual = createCarVisual(colourFor(p.name));
      arena.scene.add(visual.root);
      remoteVisuals.set(p.id, visual);
    }
    if (p.emoteId) {
      const em = pickEmote(p.emoteId);
      if (em) hud.emote(`${p.name}: ${em.name}`, em.glyph);
    }
  }
  for (const [id, visual] of remoteVisuals) {
    if (!seen.has(id)) {
      arena.scene.remove(visual.root);
      visual.dispose();
      remoteVisuals.delete(id);
      remoteInterps.delete(id);
    }
  }
}

function spawnPredictor(me: CarPlayer): void {
  if (!query) return;
  predictor = new Predictor(
    query,
    CFG,
    { x: me.x, y: me.y, z: me.z },
    { x: me.qx, y: me.qy, z: me.qz, w: me.qw },
    me.ghostUntil,
  );
  if (ownVisual) {
    arena?.scene.remove(ownVisual.root);
    ownVisual.dispose();
  }
  ownVisual = createCarVisual(colourFor(me.name));
  arena?.scene.add(ownVisual.root);
  if (!loopRunning) {
    loopRunning = true;
    lastFrameMs = performance.now();
    inputAcc = 0;
    tickAcc = 0;
    requestAnimationFrame(frame);
  }
}

function ownSnapshot(p: CarPlayer): OwnCarSnapshot {
  return {
    x: p.x, y: p.y, z: p.z,
    qx: p.qx, qy: p.qy, qz: p.qz, qw: p.qw,
    vx: p.vx, vy: p.vy, vz: p.vz,
    mode: p.mode,
    gas: p.gas,
    lastProcessedInput: p.lastProcessedInput,
    ghostUntil: p.ghostUntil,
  };
}

// ============================== the game loop =============================

const INPUT_PERIOD_MS = 1000 / 30; // rooms.inputRateHz
const TICK_MS = 1000 / 60; // rooms.physicsTickHz

function frame(nowMs: number): void {
  if (!loopRunning) return;
  const dtMs = Math.min(120, nowMs - lastFrameMs);
  lastFrameMs = nowMs;

  const drive = input?.sample() ?? {
    throttle: 0, steer: 0, pitch: 0, roll: 0, yaw: 0,
    hover: false, boost: false, grip: false,
  };

  // respawn hot key → server
  if (input?.consumeRespawn() && net) net.requestRespawn();

  // ---- fixed-rate input send (30 Hz) ----
  inputAcc += dtMs;
  while (inputAcc >= INPUT_PERIOD_MS) {
    inputAcc -= INPUT_PERIOD_MS;
    if (predictor && net?.input) {
      const seq = predictor.push(drive);
      const handle = net.input;
      const d = handle.data as unknown as Record<string, unknown>;
      d.seq = seq;
      d.throttle = drive.throttle;
      d.steer = drive.steer;
      d.pitch = drive.pitch;
      d.roll = drive.roll;
      d.yaw = drive.yaw;
      d.hover = drive.hover;
      d.boost = drive.boost;
      d.grip = drive.grip;
      handle.send();
    }
    // emote hot keys 1–8
    const emoteKey = input?.consumeEmote() ?? "";
    if (emoteKey && net) {
      const em = EMOTES[Number(emoteKey) - 1];
      if (em) net.sendEmote(em.id);
    }
  }

  // ---- fixed-rate prediction (60 Hz) ----
  tickAcc += dtMs;
  let ticks = 0;
  while (tickAcc >= TICK_MS && ticks < 6) {
    tickAcc -= TICK_MS;
    ticks++;
    if (predictor) predictor.step(drive, nowMs);
  }

  // ---- own car transform ----
  if (!arena) return;
  const { pos, quat } = predictor
    ? predictor.transform()
    : { pos: cam.look, quat: { x: 0, y: 0, z: 0, w: 1 } };
  if (ownVisual && predictor) {
    ownVisual.root.position.set(pos.x, pos.y, pos.z);
    ownVisual.root.quaternion.set(quat.x, quat.y, quat.z, quat.w);

    // wheel spin from forward speed (wheels rotate about local x)
    const v = predictor.sim.body.linvel;
    const fwd = quatMul(quat, { x: 0, y: 0, z: 1, w: 0 }); // rotated z axis (vector part)
    const fwdSpeed = v.x * fwd.x + v.y * fwd.y + v.z * fwd.z;
    const spin = (fwdSpeed / 0.34) * (dtMs / 1000);
    for (const w of ownVisual.wheels) w.rotation.x += spin;

    // thruster array: boost = full burn; hover/grip fans hum at idle;
    // pitch thrust while airborne scales with the input
    const mode = predictor.sim.mode;
    const airish = mode === "hover" || mode === "grip" || pos.y > 1.5;
    const thrust =
      mode === "boost"
        ? 1
        : airish
          ? Math.max(0.22, Math.abs(drive.pitch))
          : 0;
    ownVisual.setThrust(thrust);
  }

  // ---- remotes ----
  for (const [id, interp] of remoteInterps) {
    const visual = remoteVisuals.get(id);
    if (!visual) continue;
    const r = interp.render(nowMs);
    if (!r.hasData) continue;
    visual.root.position.set(r.pos.x, r.pos.y, r.pos.z);
    visual.root.quaternion.set(r.quat.x, r.quat.y, r.quat.z, r.quat.w);
    const rvel = interpVelocity(id) ?? { x: 0, y: 0, z: 0 };
    const rspin = (Math.hypot(rvel.x, rvel.y, rvel.z) / 0.34) * (dtMs / 1000) * Math.sign(rvel.z || 1);
    for (const w of visual.wheels) w.rotation.x += rspin;
  }

  // ---- camera ----
  if (predictor) updateCamera(pos, quat, dtMs, drive);

  // ---- HUD ----
  const me = net?.room?.state?.players.get(net.sessionId);
  if (predictor) {
    const v = predictor.sim.body.linvel;
    hud.speed(Math.hypot(v.x, v.y, v.z) * 3.6, CFG.physics.topSpeed);
    const meMode = me?.mode ?? predictor.sim.mode;
    const simMode = predictor.sim.mode;
    // the gas ring reads white "air" while flying with power: hover/grip or
    // pitch-thrusting in the air (cold-gas climb / boost arc)
    const thrusting =
      (simMode === "ground" || simMode === "boost") && drive.pitch !== 0 && pos.y > 1.5;
    hud.gas(predictor.sim.gas, simMode === "hover" || simMode === "grip" || thrusting);
    // boost chip tracks the real cooldown window from the local sim's
    // boostUsedAtMs (deterministic mirror of the server's clock)
    const coolMs = Math.round(CFG.boost.cooldown * 1000);
    const sinceBoost = nowMs - predictor.sim.boostUsedAtMs;
    const cdFrac = Number.isFinite(sinceBoost) ? Math.min(1, sinceBoost / coolMs) : 1;
    hud.boost(
      meMode === "boost" ? "active" : sinceBoost < coolMs ? "cooldown" : "ready",
      cdFrac,
    );
    if (me) hud.score(me.score);
  }
  if (nowMs - pingAt > 2000 && net) {
    pingAt = nowMs;
    net.ping();
    hud.ping(net.lastRttMs);
  }
  if (drivingTestUntil > 0) {
    const remaining = Math.max(0, drivingTestUntil - nowMs);
    const scoreNow = me?.score ?? drivingTestStartScore;
    if (remaining <= 0) {
      const result = Math.max(0, scoreNow - drivingTestStartScore);
      drivingTestBest = Math.max(drivingTestBest, result);
      hud.testStatus(`TEST COMPLETE · ${result.toLocaleString()} pts · BEST ${drivingTestBest.toLocaleString()}`, true);
      drivingTestUntil = 0;
    } else {
      hud.testStatus(`DRIVING TEST · ${(remaining / 1000).toFixed(1)}s · ${drivingTestGates} GATES · +${Math.max(0, scoreNow - drivingTestStartScore).toLocaleString()}`, true);
    }
  }
  if (tabHeld && net?.room?.state) {
    hud.scoreboard(net.room.state as ArenaState, net.sessionId);
  }

  // fell out of the world (server also catches this at its next tick)
  if (pos.y < -16 && nowMs > deathRespawnAt && net) {
    deathRespawnAt = nowMs + 1000;
    net.requestRespawn();
  }

  arena.renderer.render(arena.scene, arena.camera);
  requestAnimationFrame(frame);
}

/** latest raw sample of a remote (for wheel spin) */
function interpVelocity(id: string): Vec3Like | null {
  const interp = remoteInterps.get(id);
  if (!interp) return null;
  return interp.latestVel();
}

// ============================== chase camera ==============================

function updateCamera(pos: Vec3Like, q: QuatLike, dtMs: number, drive: { steer: number; pitch: number; hover: boolean }): void {
  if (!arena) return;
  // car's yaw angle from the quaternion (stable chase basis)
  const sin = 2 * (q.w * q.y + q.z * q.x);
  const cos = 1 - 2 * (q.y * q.y + q.z * q.z);
  const yaw = atan2lerp(camYaw, Math.atan2(sin, cos), Math.min(1, dtMs / 200));
  camYaw = yaw;

  const dist = 8.2;
  const height = 3.05;
  const target = {
    x: pos.x - Math.sin(yaw) * dist,
    y: pos.y + height,
    z: pos.z - Math.cos(yaw) * dist,
  };
  const lookAt = {
    x: pos.x + Math.sin(yaw) * 10,
    y: pos.y + 0.72,
    z: pos.z + Math.cos(yaw) * 10,
  };
  const k = Math.min(1, dtMs / 85);
  cam.pos.x += (target.x - cam.pos.x) * k;
  cam.pos.y += (target.y - cam.pos.y) * k;
  cam.pos.z += (target.z - cam.pos.z) * k;
  const lk = Math.min(1, dtMs / 140);
  cam.look.x += (lookAt.x - cam.look.x) * lk;
  cam.look.y += (lookAt.y - cam.look.y) * lk;
  cam.look.z += (lookAt.z - cam.look.z) * lk;

  // slight roll (barrel feel) in the air, damped
  const rollTarget = drive.hover ? 0 : drive.pitch * 0.1;
  cam.tilt += (rollTarget - cam.tilt) * Math.min(1, dtMs / 300);

  arena.camera.position.set(cam.pos.x, cam.pos.y, cam.pos.z);
  arena.camera.lookAt(cam.look.x, cam.look.y, cam.look.z);
  // lookAt rebuilds the camera orientation each frame, so this applies a
  // single local roll without accumulating it across frames.
  arena.camera.rotateZ(cam.tilt);

  if (predictor && audio) {
    const v = predictor.sim.body.linvel;
    audio.setEngine(clamp(Math.hypot(v.x, v.y, v.z) / CFG.physics.topSpeed, 0, 1), predictor.sim.mode === "boost", predictor.sim.mode === "hover");
  }
}

function atan2lerp(from: number, to: number, t: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + d * t;
}

// ============================== keyboard extras ===========================

let tabHeld = false;
addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    tabHeld = true;
    e.preventDefault();
    hud.toggleScoreboard(true);
  }
});
addEventListener("keyup", (e) => {
  if (e.key === "Tab") {
    tabHeld = false;
    hud.toggleScoreboard(false);
  }
});

// ============================== boot ======================================

initLanding();
