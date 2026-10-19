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
import { createNet, pickColour, type Net } from "./net.js";
import { createInput } from "./input.js";
import { createHud, pickEmote } from "./hud.js";
import { createAudio, type GameAudio } from "./audio.js";
import { initPhysQuery, type PhysQuery } from "./physics-query.js";
import { Predictor, type OwnCarSnapshot } from "./prediction.js";
import { RemoteInterp } from "./remotes.js";
import { createArenaView, type ArenaView } from "./arena.js";
import { createCarVisual, colourFor, type CarVisual } from "./car-model.js";
import { initGarage, initShowroom } from "./landing.js";

const CFG = DEFAULT_GAMEPLAY;

type Vec3Like = { x: number; y: number; z: number };
type QuatLike = { x: number; y: number; z: number; w: number };

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

interface RoadsterSpec {
  id: string;
  label: string;
  value: string;
  note?: string;
  claimed?: boolean;
}
interface RoadsterHotspot {
  id: string;
  label: string;
  value: string;
  anchor?: { x?: number; y?: number; z?: number };
  tagY?: number;
}
interface RoadsterTrim {
  id: string;
  name: string;
  roadLegal: boolean;
  roadLegalNote?: string;
  seats: number;
  highlights: string[];
  deposit: string | null;
  depositNote?: string;
}
interface RoadsterContent {
  sources?: { label: string; url: string }[];
  reveal: {
    displayDate: string;
    location: string;
    summary: string;
    delayNote?: string;
    quote: { text: string; attribution: string };
    footage?: { src: string; label: string };
  };
  heroStats: { id?: string; value?: string; label: string }[];
  specs: RoadsterSpec[];
  garage?: { hotspots?: RoadsterHotspot[] };
  ticker?: string[];
  trims: RoadsterTrim[];
  timeline: { year: string; title: string; text: string }[];
  heritage?: { year: string; title: string; text: string }[];
  honesty: { note: string };
  reservations: { buttonLabel: string };
}

const $id = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

/**
 * Fill the gaming landing from content/roadster.json (spec 10.2). Every node
 * is optional — missing markup or missing data simply skips that block.
 */
function renderLanding(facts: RoadsterContent): void {
  // hero stat bar — official reveal figures with short labels
  const heroStats = $id("hero-stats");
  if (heroStats) {
    const byId = new Map(facts.specs.map((s) => [s.id, s]));
    const cells: HTMLElement[] = [];
    for (const stat of facts.heroStats ?? []) {
      const value = stat.value ?? (stat.id ? (byId.get(stat.id)?.value ?? "") : "");
      if (!value) continue;
      const cell = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = value;
      const span = document.createElement("span");
      span.textContent = stat.label;
      cell.append(b, span);
      cells.push(cell);
    }
    heroStats.replaceChildren(...cells);
  }

  // ticker — the strip is rendered twice so the −50% loop is seamless
  const track = $id("ticker-track");
  if (track) {
    const doubled = [...(facts.ticker ?? []), ...(facts.ticker ?? [])];
    track.replaceChildren(
      ...doubled.map((text) => {
        const span = document.createElement("span");
        span.textContent = text;
        return span;
      }),
    );
  }

  // garage figure grid — the full official spec list
  const grid = $id("garage-grid");
  if (grid) {
    const cells: HTMLElement[] = [];
    for (const spec of facts.specs ?? []) {
      const div = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = spec.label;
      const dd = document.createElement("dd");
      dd.textContent = spec.value;
      if (spec.note) {
        const small = document.createElement("small");
        small.textContent = spec.note;
        dd.append(small);
      }
      div.append(dt, dd);
      cells.push(div);
    }
    grid.replaceChildren(...cells);
  }

  // reveal — lede, quote, fan footage tag
  const lede = $id("reveal-lede");
  if (lede) {
    const parts = [facts.reveal.summary];
    if (facts.reveal.delayNote) parts.push(`${facts.reveal.delayNote}.`);
    lede.textContent = parts.join(" ");
  }
  const quote = $id("reveal-quote");
  if (quote && facts.reveal.quote) {
    const bq = document.createElement("blockquote");
    bq.textContent = facts.reveal.quote.text;
    const fig = document.createElement("figcaption");
    fig.textContent = facts.reveal.quote.attribution;
    quote.replaceChildren(bq, fig);
  }
  const footage = facts.reveal.footage;
  const reelTag = $id("reel-tag");
  if (reelTag && footage) reelTag.textContent = footage.label;
  const video = $id("reveal-video") as HTMLVideoElement | null;
  if (video && footage?.src && video.getAttribute("src") !== footage.src) {
    video.setAttribute("src", footage.src);
  }

  // timeline — the road to the reveal
  const timeline = $id("timeline");
  if (timeline) {
    const items: HTMLElement[] = [];
    for (const step of facts.timeline ?? []) {
      const li = document.createElement("li");
      const year = document.createElement("span");
      year.className = "year";
      year.textContent = step.year;
      const title = document.createElement("b");
      title.className = "t";
      title.textContent = step.title;
      const p = document.createElement("p");
      p.textContent = step.text;
      li.append(year, title, p);
      items.push(li);
    }
    timeline.replaceChildren(...items);
  }

  // heritage — Starman, and the SpaceX tech coming home
  const heritage = $id("heritage");
  if (heritage) {
    const cards: HTMLElement[] = [];
    for (const item of facts.heritage ?? []) {
      const article = document.createElement("article");
      const year = document.createElement("span");
      year.className = "year";
      year.textContent = item.year;
      const b = document.createElement("b");
      b.textContent = item.title;
      const p = document.createElement("p");
      p.textContent = item.text;
      article.append(year, b, p);
      cards.push(article);
    }
    heritage.replaceChildren(...cards);
  }

  // editions — trims as a character-select screen
  const editions = $id("editions");
  if (editions) {
    const cards: HTMLElement[] = [];
    for (const trim of facts.trims ?? []) {
      const article = document.createElement("article");
      if (!trim.roadLegal) article.classList.add("invite");

      const badge = document.createElement("span");
      badge.className = `badge ${trim.roadLegal ? "legal" : "no"}`;
      badge.textContent = trim.roadLegal ? "Road-legal" : (trim.roadLegalNote ?? "Not road-legal");

      const name = document.createElement("h3");
      name.className = "name";
      name.textContent = trim.name;
      const sub = document.createElement("span");
      sub.textContent = `${trim.roadLegal ? "Road-legal" : "Invite only"} · ${trim.seats} ${
        trim.seats === 1 ? "seat" : "seats"
      }`;
      name.append(sub);

      const list = document.createElement("ul");
      for (const point of trim.highlights ?? []) {
        const li = document.createElement("li");
        li.textContent = point;
        list.append(li);
      }

      const deposit = document.createElement("div");
      deposit.className = "deposit";
      const amount = document.createElement("b");
      amount.textContent = trim.deposit ?? "Invite only";
      const label = document.createElement("span");
      label.textContent = trim.deposit ? "refundable deposit" : "no public deposit";
      deposit.append(amount, label);

      article.append(badge, name, list, deposit);
      if (trim.depositNote) {
        const note = document.createElement("p");
        note.className = "fine";
        note.textContent = trim.depositNote;
        article.append(note);
      }
      cards.push(article);
    }
    editions.replaceChildren(...cards);
  }

  // honesty note + reserve wiring (spec 3.3: no owner link → button disabled)
  const disclaimer = $id("legal-disclaimer");
  if (disclaimer) disclaimer.textContent = facts.honesty.note;

  const reserveBtn = $id("reserve-button") as HTMLAnchorElement | null;
  const reserveNote = $id("reserve-note");
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env ?? {};
  const reserveUrl = env.VITE_RESERVE_URL ?? "";
  if (reserveBtn) {
    if (reserveUrl) {
      reserveBtn.href = reserveUrl;
      if (reserveNote) {
        reserveNote.textContent = `Opens the official ${facts.reservations.buttonLabel} page in a new tab. Deposits are per Tesla's reservation terms.`;
      }
    } else {
      reserveBtn.classList.add("is-disabled");
      reserveBtn.removeAttribute("href");
      if (reserveNote) reserveNote.textContent = facts.honesty.note;
    }
  }

  // footer — sources + version stamp
  const sourcesEl = $id("foot-sources");
  const sources = facts.sources ?? [];
  if (sourcesEl && sources.length) {
    const nodes: (Node | string)[] = ["Sources: "];
    sources.forEach((source, index) => {
      const a = document.createElement("a");
      a.href = source.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = source.label;
      nodes.push(a);
      if (index < sources.length - 1) nodes.push(" · ");
    });
    sourcesEl.replaceChildren(...nodes);
  }
  const footVersion = $id("foot-version");
  if (footVersion) footVersion.textContent = "revealed 2026";
}

function initLanding(): void {
  document.title = "Roadster Arena — drive it, then leave the ground";

  // hero CTA (topbar + hero) = the arena entry
  const enterArena = () => {
    hud.showGame();
    hud.showJoinOverlay(true);
    (document.getElementById("join-name") as HTMLInputElement | null)?.focus();
  };
  document.getElementById("play-now")?.addEventListener("click", enterArena);
  document.getElementById("play-now-top")?.addEventListener("click", enterArena);
  document.getElementById("join-back")?.addEventListener("click", () => {
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

  void (async () => {
    try {
      const facts = (await import("../../content/roadster.json")).default as RoadsterContent;
      renderLanding(facts);
      initGarage(facts.garage?.hotspots ?? []);
    } catch (err) {
      console.error("landing content failed", err);
      try {
        initGarage([]);
      } catch (garageErr) {
        console.error("garage init failed", garageErr);
      }
    }
  })();
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

const INPUT_PERIOD_MS = 1000 / 60; // rooms.inputRateHz — one input per physics
// tick: the server consumes exactly one buffered input per tick, so the client
// must record one per tick too or reconcile replays fall short of the sim's
// real timeline (each pending input used to cover two ticks, pulling the yaw
// back a few degrees on every patch — a visible wobble while turning).
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
  // sub-tick interpolation: the 60 Hz sim is sampled at the display's cadence
  // (alpha = how far into the next tick wall time already is), so the car
  // glides instead of stepping 1–2 physics ticks per rendered frame
  const { pos, quat } = predictor
    ? predictor.renderTransform(tickAcc / TICK_MS)
    : { pos: cam.look, quat: { x: 0, y: 0, z: 0, w: 1 } };
  if (ownVisual && predictor) {
    ownVisual.root.position.set(pos.x, pos.y, pos.z);
    ownVisual.root.quaternion.set(quat.x, quat.y, quat.z, quat.w);

    // wheel spin from forward speed (wheels rotate about local x); the rate is
    // capped because raw spin (60 m/s → 176 rad/s ≈ 10× per frame) aliases into
    // a strobing wobble on a 45–60 Hz display — racers blur the rim instead
    const v = predictor.sim.body.linvel;
    const fwd = quatMul(quat, { x: 0, y: 0, z: 1, w: 0 }); // rotated z axis (vector part)
    const fwdSpeed = v.x * fwd.x + v.y * fwd.y + v.z * fwd.z;
    const spin = Math.max(-38, Math.min(38, fwdSpeed / 0.34)) * (dtMs / 1000);
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
    const rspeed = Math.max(-38, Math.min(38, Math.hypot(rvel.x, rvel.y, rvel.z) / 0.34));
    const rspin = rspeed * (dtMs / 1000) * Math.sign(rvel.z || 1);
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
  // car's yaw angle from the (already sub-tick interpolated) quaternion: the
  // input pose is smooth, so ONE yaw filter is all the rig needs
  const sin = 2 * (q.w * q.y + q.z * q.x);
  const cos = 1 - 2 * (q.y * q.y + q.z * q.z);
  const yaw = atan2lerp(camYaw, Math.atan2(sin, cos), Math.min(1, dtMs / 40));
  camYaw = yaw;

  // speed opens the chase distance and pushes the look point out (racing feel)
  const v = predictor?.sim.body.linvel;
  const speed = v ? Math.hypot(v.x, v.y, v.z) : 0;
  const k = Math.min(1, speed / 60);
  const dist = 8.2 + k * 1.8;
  const target = {
    x: pos.x - Math.sin(yaw) * dist,
    y: pos.y + 3.05,
    z: pos.z - Math.cos(yaw) * dist,
  };
  const lookAt = {
    x: pos.x + Math.sin(yaw) * (10 + k * 6),
    y: pos.y + 0.72,
    z: pos.z + Math.cos(yaw) * (10 + k * 6),
  };
  // rigid horizontal boom: position and look derive from the single filtered
  // yaw. The old chain (yaw 90 ms + position 65 ms + look 110 ms) compounded
  // three lags into ~12–16° of visible trail and a subtle orbit wobble mid-turn.
  // Vertical stays softly sprung so kerbs/landings read as suspension, not jitter.
  const ky = Math.min(1, dtMs / 55);
  cam.pos.x = target.x;
  cam.pos.z = target.z;
  cam.pos.y += (target.y - cam.pos.y) * ky;
  cam.look.x = lookAt.x;
  cam.look.z = lookAt.z;
  cam.look.y += (lookAt.y - cam.look.y) * ky;

  // slight roll (barrel feel) in the air, damped
  const rollTarget = drive.hover ? 0 : drive.pitch * 0.1;
  cam.tilt += (rollTarget - cam.tilt) * Math.min(1, dtMs / 300);

  arena.camera.position.set(cam.pos.x, cam.pos.y, cam.pos.z);
  arena.camera.lookAt(cam.look.x, cam.look.y, cam.look.z);
  // lookAt rebuilds the camera orientation each frame, so this applies a
  // single local roll without accumulating it across frames.
  arena.camera.rotateZ(cam.tilt);

  if (predictor && audio) {
    audio.setEngine(predictor.sim.mode === "boost", predictor.sim.mode === "hover");
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
