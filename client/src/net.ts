/**
 * Network layer (spec 5): Colyseus join, the buffered input channel, state
 * patches, messages and reconnect. The rest of the game only sees callbacks.
 */

import { ColyseusSDK } from "@colyseus/sdk";
import type { Room } from "@colyseus/sdk";
import { MESSAGES, type ArenaState, type WelcomeMessage, type PingEcho } from "@roadster-arena/shared";

export type ConnPhase = "idle" | "connecting" | "in-room" | "reconnecting" | "closed";

export interface NetCallbacks {
  onPhase(phase: ConnPhase, detail?: string): void;
  onState(state: ArenaState): void;
  onWelcome(msg: WelcomeMessage): void;
  onBump(x: number, y: number, z: number, strength: number): void;
  onGateBoost(gateIndex: number): void;
  onRejected(reason: string, details?: string): void;
}

export interface Net {
  /** the joined room, null until connected */
  room: Room<ArenaState> | null;
  sessionId: string;
  /** staged input handle — mutate .data, then .send() */
  input: { data: Record<string, unknown>; send(): number; stepMs?: number; patchRate?: number } | null;
  join(name: string, colour: string): Promise<void>;
  sendEmote(id: string): void;
  requestRespawn(): void;
  ping(): void;
  leave(): void;
  /** latest server echo time in ms (for HUD), 0 when unknown */
  lastRttMs: number;
}

/** ws endpoint of the game server. Same host as the page in production,
 *  fixed port in dev (vite on 5173, server on 2567). */
function serverUrl(): string {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env ?? {};
  if (env.VITE_GAME_SERVER) return env.VITE_GAME_SERVER;
  if (location.port === "5173" || location.port === "4173") return `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:2567`;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

const PLAYER_COLOURS = [
  "#f2f1ee", "#8fd6ff", "#ffd479", "#b7f7a8", "#ff9f9f",
  "#c9a7ff", "#7ef0d4", "#ffb37e", "#f7a8ff", "#9ef1ff",
];

export function pickColour(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return PLAYER_COLOURS[Math.abs(h) % PLAYER_COLOURS.length];
}

export function createNet(cb: NetCallbacks): Net {
  const sdk = new ColyseusSDK(serverUrl());
  let room: Room<ArenaState> | null = null;
  let inputHandle: { data: Record<string, unknown>; send(): number; stepMs?: number; patchRate?: number } | null = null;
  let pingSeq = 0;
  const pendingPings = new Map<number, number>();
  const net: Net = {
    room: null,
    sessionId: "",
    input: null,
    lastRttMs: 0,

    async join(name: string, colour: string) {
      cb.onPhase("connecting");
      try {
        room = await sdk.joinOrCreate("arena", { name, colour });
      } catch (err) {
        cb.onPhase("closed", err instanceof Error ? err.message : String(err));
        throw err;
      }
      net.room = room;
      net.sessionId = room.sessionId;

      // server → client messages
      room.onMessage(MESSAGES.welcome, (msg: WelcomeMessage) => cb.onWelcome(msg));
      room.onMessage(MESSAGES.bump, (msg: { x: number; y: number; z: number; strength: number }) =>
        cb.onBump(msg.x, msg.y, msg.z, msg.strength));
      room.onMessage(MESSAGES.gateBoost, (msg: { gateIndex: number }) => cb.onGateBoost(msg.gateIndex));
      room.onMessage(MESSAGES.rejected, (msg: { reason: string; details?: string }) =>
        cb.onRejected(msg.reason, msg.details));
      room.onMessage(MESSAGES.ping, (msg: PingEcho) => {
        const sent = pendingPings.get(msg.t);
        if (sent !== undefined) {
          net.lastRttMs = Math.round(performance.now() - sent);
          pendingPings.delete(msg.t);
        }
      });

      room.onStateChange((state) => cb.onState(state as ArenaState));

      // buffered input channel (schema arrives via the join handshake)
      inputHandle = room.input() as unknown as typeof inputHandle;
      net.input = inputHandle;

      room.onLeave((code) => {
        // code 1000 = clean leave; anything else may allow reconnect (spec 7.7)
        inputHandle = null;
        net.input = null;
        net.room = null;
        cb.onPhase("closed", `code ${code}`);
      });

      cb.onPhase("in-room");
    },

    sendEmote(id: string) {
      room?.send(MESSAGES.emote, { id });
    },

    requestRespawn() {
      room?.send(MESSAGES.respawn, {});
    },

    ping() {
      const seq = ++pingSeq;
      pendingPings.set(seq, performance.now());
      room?.send(MESSAGES.ping, { t: seq });
      // prune unanswered pings older than 10 s
      const cutoff = performance.now() - 10000;
      for (const [t, sent] of pendingPings) if (sent < cutoff) pendingPings.delete(t);
    },

    leave() {
      room?.leave();
      room = null;
      net.room = null;
      net.input = null;
    },
  };
  return net;
}
