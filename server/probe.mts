/** Quick join probe: one client, sends an input, reads state. */
import { Client } from "@colyseus/sdk";
// importing the shared schemas registers the definitions with the client
// decoder (state classes must be known on both ends)
import { ArenaState } from "@roadster-arena/shared";

const url = process.env.SERVER_URL ?? "ws://127.0.0.1:2567";
const client = new Client(url);
const room = await client.joinOrCreate("arena", { name: "Probe-1", colour: "red" });
console.log("joined", room.id, room.sessionId);

let patches = 0;
room.onStateChange((state: ArenaState) => {
  void state;
  patches++;
});

// the first patch creates the state locally (0.18 lazy state)
await new Promise<void>((resolve) => room.onStateChange.once(() => resolve()));

const me = () => {
  const p = (room.state as ArenaState).players.get(room.sessionId);
  return p ? `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} mode=${p.mode} gas=${p.gas} lpi=${p.lastProcessedInput}` : "?";
};
console.log("initial:", me());

// drive forward for 2 seconds at 30 Hz
let seq = 0;
const timer = setInterval(() => {
  const input = (room as any).input();
  input.data.seq = ++seq;
  input.data.throttle = 1;
  input.send();
}, 33);

await new Promise((r) => setTimeout(r, 2000));
console.log("after 2s:", me());
clearInterval(timer);

const respawnResult = await (room as unknown as { request: (n: string) => Promise<unknown> }).request?.("ping", { t: 42 }).catch((e: Error) => `ping err: ${e.message}`);
console.log("ping echo:", respawnResult);

room.leave();
process.exit(0);
