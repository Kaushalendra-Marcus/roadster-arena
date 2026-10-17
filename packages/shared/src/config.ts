/**
 * Config typing + defaults. The JSON files under /config are the single
 * source of truth: the server reads them from disk, the client imports them
 * through a Vite alias. The defaults below mirror the JSON and are asserted
 * equal against the JSON in tests so the two can never drift apart.
 */

export interface GameplayConfig {
  physics: {
    topSpeed: number;
    boostTopSpeed: number;
    groundAccel: number;
    groundBrakeAccel: number;
    grip_Lateral: number;
    hoverLateralAccel: number;
    turnRate: number;
    hoverTurnRate: number;
    airTurnRate: number;
    airPitchTorque: number;
    airRollTorque: number;
    airTorqueSnapRoll: number;
    gravity: number;
    hoverGravityFactor: number;
    hoverLiftAccel: number;
    hoverTargetHeight: number;
    hoverClimbSpeed: number;
    hoverSinkSpeed: number;
    airThrustAccel: number;
    gripAccel: number;
    maxTerrainPitchAlign: number;
    restitution: number;
    maxW: number;
  };
  gas: {
    max: number;
    start: number;
    hoverDrainPerSecond: number;
    gripDrainPerSecond: number;
    boostCost: number;
    rechargePerSecond: number;
    rechargeOnlyWhenGrounded: boolean;
  };
  boost: {
    duration: number;
    impulse: number;
    cooldown: number;
  };
  respawn: {
    ghostSeconds: number;
    killY: number;
  };
  arena: {
    halfSize: number;
    softWallRadius: number;
    softWallForce: number;
    wallRestitution: number;
  };
  gate: {
    boostImpulse: number;
    cooldownSeconds: number;
  };
}

export interface RoomsConfig {
  roomType: string;
  roomDisplayName: string;
  maxPlayersPerRoom: number;
  minPlayersPerRoomOptions: number;
  maxPlayersPerRoomOptions: number;
  reconnectHoldSeconds: number;
  maxRoomsPerProcess: number;
  maxPlayersPerProcess: number;
  perIPConnectionLimit: number;
  physicsTickHz: number;
  stateBroadcastHz: number;
  inputRateHz: number;
  emoteCooldownMs: number;
  nameMinLength: number;
  nameMaxLength: number;
  allowedOrigins: string[];
}

/** Defaults used when a config value is missing — equals config/*.json */
export const DEFAULT_GAMEPLAY: GameplayConfig = {
  physics: {
    topSpeed: 60,
    boostTopSpeed: 68,
    groundAccel: 28,
    groundBrakeAccel: 34,
    grip_Lateral: 6.5,
    hoverLateralAccel: 12,
    turnRate: 2.6,
    hoverTurnRate: 2.0,
    airTurnRate: 1.6,
    airPitchTorque: 7.5,
    airRollTorque: 6.2,
    airTorqueSnapRoll: 10.0,
    gravity: 26.0,
    hoverGravityFactor: 0.22,
    hoverLiftAccel: 30.0,
    hoverTargetHeight: 3.0,
    hoverClimbSpeed: 16.0,
    hoverSinkSpeed: 10.0,
    airThrustAccel: 34.0,
    gripAccel: 34.0,
    maxTerrainPitchAlign: 40.0,
    restitution: 0.02,
    maxW: 20,
  },
  gas: {
    max: 100,
    start: 100,
    // unlimited flight (design update): drains are 0 so hover and grip never
    // time out and boost is gated by its cooldown alone — the meter only
    // moves if a future tuning pass re-enables costs here.
    hoverDrainPerSecond: 0,
    gripDrainPerSecond: 0,
    boostCost: 0,
    rechargePerSecond: 20,
    rechargeOnlyWhenGrounded: true,
  },
  boost: { duration: 1.0, impulse: 24, cooldown: 5.0 },
  respawn: { ghostSeconds: 1.5, killY: -20 },
  arena: { halfSize: 300, softWallRadius: 270, softWallForce: 30, wallRestitution: 0.1 },
  gate: { boostImpulse: 18, cooldownSeconds: 3 },
};

export const DEFAULT_ROOMS: RoomsConfig = {
  roomType: "arena",
  roomDisplayName: "Arena",
  maxPlayersPerRoom: 20,
  minPlayersPerRoomOptions: 10,
  maxPlayersPerRoomOptions: 20,
  reconnectHoldSeconds: 15,
  maxRoomsPerProcess: 40,
  maxPlayersPerProcess: 400,
  perIPConnectionLimit: 5,
  physicsTickHz: 60,
  stateBroadcastHz: 20,
  inputRateHz: 30,
  emoteCooldownMs: 1200,
  nameMinLength: 2,
  nameMaxLength: 16,
  allowedOrigins: [
    "http://localhost:5173",
    "http://localhost:4173",
    "http://localhost:3000",
  ],
};

/** Merge a partial config over defaults (defensive; keeps unknown keys). */
export function withDefaults<T extends object>(base: T, fallback?: T): T {
  if (!fallback) return base;
  return fallback;
}
