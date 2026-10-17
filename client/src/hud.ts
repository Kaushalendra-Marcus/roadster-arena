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
  gas(percent: number): void;
  boost(state: "ready" | "cooldown" | "active"): void;
  mode(m: string): void;
  players(n: number): void;
  ping(ms: number): void;
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
  const respawnBanner = $("hud-respawn");
  const emotePop = $("emote-pop");
  const touchControls = $("touch-controls");
  const scoreboard = $("scoreboard");
  const scoreRows = $("score-rows");
  let respawnVisible = false;

  return {
    showGame() {
      landing.classList.add("hidden");
      game.classList.remove("hidden");
    },
    showLanding() {
      landing.classList.remove("hidden");
      game.classList.add("hidden");
      scoreboard.classList.add("hidden");
    },
    showJoinOverlay(v) {
      joinOverlay.classList.toggle("hidden", !v);
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
    gas(percent) {
      const frac = Math.max(0, Math.min(1, percent / 100));
      gasRing.style.strokeDashoffset = String(GAS_CIRCUMFERENCE * (1 - frac));
      gasRing.classList.toggle("low", percent < 40 && percent >= 15);
      gasRing.classList.toggle("critical", percent < 15);
    },
    boost(state) {
      boostEl.classList.toggle("ready", state === "ready");
      boostEl.classList.toggle("active", state === "active");
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
        tr.innerHTML = `<td>${i++}</td><td>${p.name}</td><td>${p.mode}</td><td>${speed}</td>`;
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
