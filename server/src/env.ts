import { DEFAULT_GAMEPLAY, DEFAULT_ROOMS, type GameplayConfig, type RoomsConfig } from "@roadster-arena/shared";
import { loadGameplay, loadRooms } from "./config-loader.js";

export interface ServerEnvState {
  gameplay: GameplayConfig;
  rooms: RoomsConfig;
  maxPlayers: number;
  port: number;
  nodeEnv: string;
  isProduction: boolean;
}

let singleton: ServerEnvState | null = null;

/** Load (once) and return the process-level server env/config. */
export function getEnv(): ServerEnvState {
  if (singleton) return singleton;
  const rooms = loadRooms();
  const gameplay = loadGameplay();
  const rawMax = process.env.MAX_PLAYERS_PER_ROOM;
  const envMax = rawMax ? Number.parseInt(rawMax, 10) : 0;
  const maxPlayers =
    envMax > 0
      ? Math.max(rooms.minPlayersPerRoomOptions, Math.min(rooms.maxPlayersPerRoomOptions, envMax))
      : rooms.maxPlayersPerRoom;
  singleton = {
    gameplay,
    rooms,
    maxPlayers,
    port: Number.parseInt(process.env.PORT ?? "2567", 10) || 2567,
    nodeEnv: process.env.NODE_ENV ?? "development",
    isProduction: (process.env.NODE_ENV ?? "development") === "production",
  };
  return singleton;
}

export function resetEnvSingleton(): void {
  singleton = null;
}

export const fallbacks = { gameplay: DEFAULT_GAMEPLAY, rooms: DEFAULT_ROOMS };
