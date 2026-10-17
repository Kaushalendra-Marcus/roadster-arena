/**
 * Message names + payload types (spec 5.5). The input stream itself rides the
 * dedicated buffered input channel (Room#defineInput) instead of a message.
 */

export const MESSAGES = {
  /** client → server */
  emote: "emote",
  respawn: "respawn",
  ping: "ping",

  /** server → client */
  welcome: "welcome",
  playerJoined: "playerJoined",
  playerLeft: "playerLeft",
  bump: "bump",
  gateBoost: "gateBoost",
  rejected: "rejected",
} as const;

export interface EmoteMessage { id: string }
export interface WelcomeMessage {
  id: string;
  roomId: string;
  playerCount: number;
  roomName: string;
  serverVersion: string;
}
export interface PlayerJoinedMessage { id: string; name: string; spawnIndex: number }
export interface PlayerLeftMessage { id: string }
export interface BumpMessage {
  /** world position of the contact */
  x: number; y: number; z: number;
  /** scaled strength 0..1+, for sound/particle amplitude */
  strength: number;
}
export interface GateBoostMessage { gateIndex: number }
export interface RejectionMessage { reason: string; details?: string }

/** request/response round trip for the HUD ping indicator (spec 15) */
export interface PingEcho { t: number }
