/**
 * HUD bindings (spec 15): speed, gas ring, boost, mode, players, ping,
 * scoreboard, emote pops, respawn banner. Plain DOM, zero dependencies.
 */

import { EMOTES, type ArenaState } from "@roadster-arena/shared";

export interface Hud {
  showGame(): void;
  showLanding(): void;
  showJoinOverlay(v: boolean): void;
  status(text: string, level?: "info" | "warn" | "bad"): void;
  clearStatus(): void;
  welcome(roomName: string, players: number): void;
  speed(kmh: number, topSpeedMps: number): void;
  /** percent 0..100; airborne=true while hover/grip — the ring reads full white */
  gas(percent: number, airborne?: boolean): void;
  /** cooldown frac 0..1 (1 = ready) drives the chip's dim/glow */
  boost(state: "ready" | "cooldown" | "active", frac?: number): void;
  mode(m: string): void;
  players(n: number): void;
  ping(ms: number): void;
  score(value: number): void;
  testStatus(text: string, active: boolean): void;
  respawnBanner(v: boolean): void;
  emote(name: string, glyph: string): void;
  scoreboard(state: ArenaState, meId: string): void;
  toggleScoreboard(v: boolean): void;
  touch(v: boolean): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const GAS_CIRCUMFERENCE = 2 * Math.PI * 26; // r=26 viewBox ring

export function createHud(): Hud {
  const landing = $("landing");
  const game = $("game");
  const joinOverlay = $("join-overlay") as HTMLElement;
  const connStatus = $("conn-status");
  const speedValue = $("speed-value");
  const speedBar = document.querySelector("#speed-bar i") as HTMLElement;
  const gasRing = $("gas-ring");
  const boostEl = $("hud-boost");
  const modeEl = $("hud-mode");
  const playersCount = $("players-count");
  const roomName = $("room-name");
  const pingValue = $("ping-value");
  const scoreValue = $("score-value");
  const testStatusEl = $("test-status");
  const respawnBanner = $("hud-respawn");
  const emotePop = $("emote-pop");
  const touchControls = $("touch-controls");
  const scoreboard = $("scoreboard");
  const scoreRows = $("score-rows");
  const hudRoot = $("hud");
  let respawnVisible = false;

  return {
    showGame() {
      landing.classList.add("hidden");
      game.classList.remove("hidden");
      hudRoot.classList.add("hidden");
    },
    showLanding() {
      landing.classList.remove("hidden");
      game.classList.add("hidden");
      hudRoot.classList.add("hidden");
      scoreboard.classList.add("hidden");
    },
    showJoinOverlay(v) {
      joinOverlay.classList.toggle("hidden", !v);
      if (v) hudRoot.classList.add("hidden");
    },
    status(text, level = "info") {
      connStatus.textContent = text;
      connStatus.classList.remove("warn", "bad");
      if (level === "warn") connStatus.classList.add("warn");
      if (level === "bad") connStatus.classList.add("bad");
      connStatus.classList.remove("hidden");
    },
    clearStatus() {
      connStatus.classList.add("hidden");
    },
    welcome(roomNameText, players) {
      roomName.textContent = `${roomNameText} · ${players}/20`;
      $("hud").classList.remove("hidden");
    },
    speed(kmh, topSpeedMps) {
      speedValue.textContent = String(Math.round(kmh));
      speedBar.style.width = `${Math.min(100, (kmh / (topSpeedMps * 3.6)) * 100)}%`;
    },
    gas(percent, airborne = false) {
      const frac = Math.max(0, Math.min(1, percent / 100));
      gasRing.style.strokeDashoffset = String(GAS_CIRCUMFERENCE * (1 - frac));
      // Unlimited flight: while flying (hover/grip) the meter reads full and
      // glows white instead of the ground-green fill; drain colours only
      // apply on the ground, so a future tuning change still degrades nicely.
      gasRing.classList.toggle("air", airborne);
      gasRing.classList.toggle("low", !airborne && percent < 40 && percent >= 15);
      gasRing.classList.toggle("critical", !airborne && percent < 15);
    },
    boost(state, frac = 1) {
      boostEl.classList.toggle("ready", state === "ready");
      boostEl.classList.toggle("active", state === "active");
      boostEl.style.setProperty("--cd", String(Math.max(0, Math.min(1, frac))));
      boostEl.querySelector("small")!.textContent =
        state === "active" ? "firing" : state === "ready" ? "ready" : "cooling";
    },
    mode(m) {
      modeEl.textContent = m.toUpperCase();
      modeEl.className = "";
      modeEl.id = "hud-mode";
      if (m !== "ground") modeEl.classList.add(m);
    },
    players(n) {
      playersCount.textContent = String(n);
    },
    ping(ms) {
      pingValue.textContent = String(ms);
      pingValue.className = ms < 80 ? "good" : ms < 180 ? "mid" : "bad";
    },
    score(value) {
      scoreValue.textContent = Math.max(0, Math.round(value)).toLocaleString();
    },
    testStatus(text, active) {
      testStatusEl.textContent = text;
      testStatusEl.classList.toggle("hidden", !active);
    },
    respawnBanner(v) {
      respawnVisible = v;
      respawnBanner.classList.toggle("hidden", !v);
    },
    emote(name, glyph) {
      if (respawnVisible) return;
      emotePop.textContent = glyph;
      emotePop.classList.remove("hidden");
      emotePop.style.animation = "none";
      void emotePop.offsetWidth; // restart the CSS animation
      emotePop.style.animation = "";
      emotePop.dataset.name = name;
      clearTimeout(Number(emotePop.dataset.timer));
      emotePop.dataset.timer = String(setTimeout(() => emotePop.classList.add("hidden"), 2800));
    },
    scoreboard(state, meId) {
      const rows: HTMLElement[] = [];
      let i = 1;
      for (const p of state.players.values()) {
        const tr = document.createElement("tr");
        if (p.id === meId) tr.className = "me";
        const speed = Math.round(Math.hypot(p.vx, p.vy, p.vz) * 3.6);
        tr.innerHTML = `<td>${i++}</td><td>${p.name}</td><td>${p.score.toLocaleString()}</td><td>${p.mode}</td><td>${speed}</td>`;
        rows.push(tr);
      }
      scoreRows.replaceChildren(...rows);
    },
    toggleScoreboard(v) {
      scoreboard.classList.toggle("hidden", !v);
    },
    touch(v) {
      touchControls.classList.toggle("hidden", !v);
    },
  };
}

/** label + glyph for a state emote id (used by main on patches) */
export function pickEmote(id: string): { name: string; glyph: string } | null {
  const emote = EMOTES.find((e) => e.id === id);
  return emote ? { name: emote.label, glyph: emote.glyph } : null;
}
