/** Compile-time constants (alphabetical, all units in the name). */

// Arena id — one map in v1 (spec 18).
export const ARENA_SIZE = 600;            // metres, square, centred at origin
export const ARENA_HALF = ARENA_SIZE / 2;
export const KILL_Y = -20;                // below this, respawn (spec 6.3)
export const GHOST_SECONDS = 1.5;         // spawn protection (spec 7)
export const SPAWN_RING_RADIUS = 14;      // metres from plaza centre
export const SPAWN_COUNT = 16;            // deterministic spawn ring

// Interpolation and prediction (spec 5.2, 5.3)
export const INTERP_DELAY_MS = 100;
export const RECONCILE_BLEND_MS = 100;

// Input send rate limits on the wire (spec 5.5, 13)
export const INPUT_SEND_HZ = 30;

// Colours offered in the picker (white default, spec 9)
export const CAR_COLOURS = [
  { id: "white",  hex: "#f2f2f0" },
  { id: "black",  hex: "#22262e" },
  { id: "red",    hex: "#c3222a" },
  { id: "blue",   hex: "#2d7dd2" },
  { id: "green",  hex: "#1f9d55" },
  { id: "orange", hex: "#f2801e" },
] as const;
export const DEFAULT_COLOUR = "white";

export const MAX_PLAYERS_PER_ROOM_DEFAULT = 20;

export const SEVERITY = {
  ok: 0, warn: 1, error: 2,
} as const;
