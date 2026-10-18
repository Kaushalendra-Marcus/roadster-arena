/**
 * Board-level types. Structural copies of the network state shape live in
 * schema.ts (Colyseus schema classes); these plain interfaces let the physics
 * code run against plain objects on the client and schema instances on the
 * server (spec 5.4).
 */

export type CarMode = "ground" | "hover" | "grip" | "boost";

export interface CarBodyView {
  /** current state (clones) */
  readonly translation: { x: number; y: number; z: number };
  readonly linvel: { x: number; y: number; z: number };
  readonly angvel: { x: number; y: number; z: number };
  /** unit quaternion, w first */
  readonly rotation: { x: number; y: number; z: number; w: number };

  setTranslation(v: { x: number; y: number; z: number }, wake: boolean): void;
  setLinvel(v: { x: number; y: number; z: number }, wake: boolean): void;
  setAngvel(v: { x: number; y: number; z: number }, wake: boolean): void;
  setRotation(q: { x: number; y: number; z: number; w: number }, wake: boolean): void;
  applyImpulse(v: { x: number; y: number; z: number }, wake: boolean): void;

  /**
   * Ray against the hosting physics world. Positions/lengths in metres.
   * Returns the closest hit or null.
   */
  raycast(
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxToi: number,
  ): { hit: boolean; toi: number; normal: { x: number; y: number; z: number } } | null;
}

export interface CarSim {
  body: CarBodyView;
  gas: number;
  mode: CarMode;
  /** milliseconds (server clock) until collisions ignore this car again */
  ghostUntilMs: number;
  spawnIndex: number;
  /** server clock ms when boost last fired (cooldown timer) */
  boostUsedAtMs: number;
  /** last-tick roll axis input, for barrel-roll tap detection */
  lastRollInput: number;
  /** clock ms while the automatic barrel roll is playing */
  rollUntilMs: number;
  rollDir: number;
  /** clock ms the slope un-stick timer was last armed (0 = not arming) */
  desickAtMs?: number;
  /** grip-through memory: ms clock until the crest probe gap reseats */
  gripHoldUntilMs?: number;
  /** remembered rail while the crest probe gap is open */
  gripHoldRail?: { x: number; y: number; z: number };
  /** acknowledge cursor: seq of the last input the server consumed */
  lastProcessedInput: number;
}

export interface DriveInput {
  throttle: number;
  steer: number;
  pitch: number;
  roll: number;
  yaw: number;
  /** −1..1 analog air-flip torque (mouse vertical); undefined on old inputs */
  flip?: number;
  hover: boolean;
  boost: boolean;
  grip: boolean;
}
