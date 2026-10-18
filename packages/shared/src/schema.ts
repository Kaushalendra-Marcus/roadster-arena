import { schema, t, type SchemaType } from "@colyseus/schema";

/**
 * Networked state (spec 5.4) — shared by the authoritative server and the
 * client SDK (type-only imports on the client), so both ends agree on the
 * wire format. Mirror plain-struct views live in types.ts.
 */

export const CarPlayer = schema(
  {
    /** identical to the MapSchema key (the Colyseus session id) */
    id: t.string(),
    name: t.string(),
    colour: t.string(),
    // position
    x: t.float32(),
    y: t.float32(),
    z: t.float32(),
    // rotation quaternion
    qx: t.float32(),
    qy: t.float32(),
    qz: t.float32(),
    qw: t.float32(),
    // linear velocity
    vx: t.float32(),
    vy: t.float32(),
    vz: t.float32(),
    /** ground | hover | grip | boost */
    mode: t.string(),
    /** 0..100 */
    gas: t.int16().default(100),
    /** race score: distance travelled plus gate bonuses */
    score: t.int32().default(0),
    /** sequence number of the last input the server processed */
    lastProcessedInput: t.int32().default(0),
    /** id from emotes.ts, empty string when none pending */
    emoteId: t.string().default(""),
    /** room clock ms when the emote started (client animates ~3 s) */
    emoteAt: t.number().default(0),
    /** room clock ms until spawn protection ends (0 = none) */
    ghostUntil: t.number().default(0),
  },
  "CarPlayer",
);
export type CarPlayer = SchemaType<typeof CarPlayer>;

export const ArenaState = schema(
  {
    players: t.map(CarPlayer),
  },
  "ArenaState",
);
export type ArenaState = SchemaType<typeof ArenaState>;

/**
 * One driving input frame (spec 5.5), sent over the buffered input channel
 * (Room#defineInput). The `sanitize` clamp config there enforces ranges at
 * decode; the server clamps again defensively (never trust the wire, spec 13).
 */
export const CarInput = schema(
  {
    seq: t.int32().default(0),
    throttle: t.float32().default(0),
    steer: t.float32().default(0),
    pitch: t.float32().default(0),
    roll: t.float32().default(0),
    yaw: t.float32().default(0),
    /** analog air-flip torque from the mouse's vertical delta */
    flip: t.float32().default(0),
    hover: t.boolean().default(false),
    boost: t.boolean().default(false),
    grip: t.boolean().default(false),
  },
  "CarInput",
);
export type CarInput = SchemaType<typeof CarInput>;
