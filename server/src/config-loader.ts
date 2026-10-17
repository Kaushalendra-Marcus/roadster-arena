/**
 * Server-only config loading (node:fs). Reads /config/*.json at process start;
 * fresh values reach the client through its own Vite import of the same files.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_GAMEPLAY,
  DEFAULT_ROOMS,
  type GameplayConfig,
  type RoomsConfig,
} from "@roadster-arena/shared";

export interface ServerEnv {
  port: number;
  maxPlayersPerRoom: number;
  allowedOrigins: string[];
  serverUrl: string;
  reserveUrl: string;
  referralUrl: string;
  nodeEnv: string;
  monitorPassword: string | undefined;
}

/** this file sits at server/src/ → up 2 levels = repo root */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read config at ${path}: ${(err as Error).message}`);
  }
}

export function loadGameplay(): GameplayConfig {
  const base = readJson(`${ROOT}config/gameplay.json`) as Partial<GameplayConfig>;
  // shallow-merge each section over the defaults; fail loudly on nonsense
  const cfg: GameplayConfig = {
    ...DEFAULT_GAMEPLAY,
    ...base,
    physics: { ...DEFAULT_GAMEPLAY.physics, ...base.physics },
    gas: { ...DEFAULT_GAMEPLAY.gas, ...base.gas },
    boost: { ...DEFAULT_GAMEPLAY.boost, ...base.boost },
    respawn: { ...DEFAULT_GAMEPLAY.respawn, ...base.respawn },
    arena: { ...DEFAULT_GAMEPLAY.arena, ...base.arena },
    gate: { ...DEFAULT_GAMEPLAY.gate, ...base.gate },
  };
  if (cfg.physics.topSpeed <= 0 || cfg.arena.halfSize < 100) {
    throw new Error("gameplay.json has obviously invalid values");
  }
  return cfg;
}

export function loadRooms(): RoomsConfig {
  const base = readJson(`${ROOT}config/rooms.json`) as Partial<RoomsConfig>;
  const cfg: RoomsConfig = { ...DEFAULT_ROOMS, ...base };
  if (cfg.maxPlayersPerRoom < 1 || cfg.maxPlayersPerRoom > 100) {
    throw new Error("rooms.json maxPlayersPerRoom out of range");
  }
  return cfg;
}

export function loadEnv(): ServerEnv {
  const raw = (k: string, fallback = "") => process.env[k] ?? fallback;
  const port = Number.parseInt(raw("PORT", "2567"), 10) || 2567;
  const serverUrl = raw("SERVER_URL") || `ws://localhost:${port}`;
  const allowedOrigins = raw("ALLOWED_ORIGINS")
    ? raw("ALLOWED_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  return {
    port,
    serverUrl,
    allowedOrigins,
    maxPlayersPerRoom:
      Number.parseInt(raw("MAX_PLAYERS_PER_ROOM", "0"), 10) || 0,
    reserveUrl: raw("RESERVE_URL"),
    referralUrl: raw("REFERRAL_URL"),
    nodeEnv: raw("NODE_ENV", "development"),
    monitorPassword: raw("MONITOR_PASSWORD") || undefined,
  };
}
