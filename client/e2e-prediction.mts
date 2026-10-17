/**
 * Headless end-to-end prediction probe: joins the LIVE server, drives with
 * the client's own Predictor + physics-query, and measures prediction drift
 * against authoritative snapshots.
 *
 * Run with the game server already listening:
 *   npx tsx client/e2e-prediction.mts
 */

import { Client } from "@colyseus/sdk";
import { DEFAULT_GAMEPLAY, type CarPlayer } from "@roadster-arena/shared";
import { initPhysQuery } from "./src/physics-query.js";
import { Predictor, type OwnCarSnapshot } from "./src/prediction.js";

const CFG = DEFAULT_GAMEPLAY;
const url = process.env.SERVER_URL ?? "ws://127.0.0.1:2567";

const sdk = new Client(url);
const room = await sdk.joinOrCreate("arena", { name: "Predict-E2E", colour: "red" });

const query = await initPhysQuery(CFG);
let predictor: Predictor | null = null;

const snap = (p: CarPlayer): OwnCarSnapshot => ({
  x: p.x, y: p.y, z: p.z,
  qx: p.qx, qy: p.qy, qz: p.qz, qw: p.qw,
  vx: p.vx, vy: p.vy, vz: p.vz,
  mode: p.mode, gas: p.gas,
  lastProcessedInput: p.lastProcessedInput,
  ghostUntil: p.ghostUntil,
});

const me = () => (room.state as { players: Map<string, CarPlayer> }).players.get(room.sessionId);

let driftMax = 0;
let driftSum = 0;
let driftN = 0;
let patches = 0;
let unackedMax = 0;

room.onStateChange(() => {
  const p = me();
  if (!p) return;
  if (!predictor) {
    predictor = new Predictor(query, CFG, { x: p.x, y: p.y, z: p.z }, { x: p.qx, y: p.qy, z: p.qz, w: p.qw }, p.ghostUntil);
    console.log("spawned at", p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1));
    return;
  }
  patches++;
  // prediction error BEFORE the rewind+replay fixes it
  const t = predictor.transform();
  const err = Math.hypot(t.pos.x - p.x, t.pos.y - p.y, t.pos.z - p.z);
  driftMax = Math.max(driftMax, err);
  driftSum += err;
  driftN++;
  predictor.reconcile(snap(p), performance.now());
  unackedMax = Math.max(unackedMax, predictor.unacked);
});

// drive straight, full throttle: send at 30 Hz, predict at 60 Hz
const SAMPLE = { throttle: 1, steer: 0, pitch: 0, roll: 0, yaw: 0, hover: false, boost: false, grip: false } as const;
const input = room.input() as unknown as { data: Record<string, unknown>; send(): number };
let seq = 0;

const sendLoop = setInterval(() => {
  if (!predictor) return;
  seq = predictor.push(SAMPLE);
  input.data.seq = seq;
  input.data.throttle = 1;
  input.send();
}, 1000 / 30);

const tickLoop = setInterval(() => {
  if (predictor) predictor.step(SAMPLE, performance.now());
}, 1000 / 60);

await new Promise((r) => setTimeout(r, 6000));
clearInterval(sendLoop);
clearInterval(tickLoop);

const t = predictor!.transform();
console.log(`patches: ${patches}  drift(avg): ${(driftSum / Math.max(1, driftN)).toFixed(3)} m  drift(max): ${driftMax.toFixed(3)} m  unacked(max): ${unackedMax}`);
console.log(`final pos: ${t.pos.x.toFixed(1)}, ${t.pos.y.toFixed(1)}, ${t.pos.z.toFixed(1)}  seq: ${seq}`);
room.leave();
process.exit(0);
