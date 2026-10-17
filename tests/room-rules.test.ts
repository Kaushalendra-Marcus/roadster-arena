/**
 * Room rules (spec 7) — the heart of the multiplayer design:
 *   1. capacity (20 default)          5. lock when full / unlock on leave
 *   2. joinOrCreate matchmaking       6. auto-dispose when last player leaves
 *   3. fill before creating           7. reconnection holds the seat 15 s
 *   4. prefer most-filled room        8. no user-visible error on last-slot races
 *
 * Bots connect through the real WebSocket transport of an in-process server.
 * The per-IP limit is raised for the test process (every bot connects from
 * 127.0.0.1); production keeps the configured value.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ColyseusTestServer, boot } from "@colyseus/testing";
import appConfig from "../server/src/index.js";
import { getEnv } from "../server/src/env.js";
import * as registry from "../server/src/rooms/registry.js";

type AnyRoom = { id?: string; sessionId: string; room?: unknown; leave: () => void; connection?: { close: () => void }; reconnectionToken?: string };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function until(cond: () => boolean, timeoutMs = 10000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

describe("Room rules (spec 7)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  const bots: AnyRoom[] = [];

  beforeAll(async () => {
    const env = getEnv();
    env.rooms.perIPConnectionLimit = 1000; // all bots share 127.0.0.1
    env.rooms.reconnectHoldSeconds = 4; // keep the reconnect test quick
    colyseus = await boot(appConfig);
  });

  afterAll(async () => {
    for (const bot of bots) {
      try {
        bot.leave();
      } catch {
        /* already gone */
      }
    }
    await sleep(300);
    await colyseus.shutdown();
  });

  async function join(name: string): Promise<any> {
    const room = await colyseus.sdk.joinOrCreate("arena", { name, colour: "red" });
    bots.push(room);
    return room;
  }

  it("fills a room to capacity before opening another (spec 7.2/7.3)", async () => {
    const joined: any[] = [];
    for (let i = 0; i < 18; i++) joined.push(await join(`Fill ${i}`));
    const ids = new Set(joined.map((r) => r.roomId));
    expect(ids.size).toBe(1); // 18 players, one room

    const n19 = await join("Fill 19");
    expect(n19.roomId).toBe(joined[0].roomId); // 19 fits the same room

    const n20 = await join("Fill 20");
    expect(n20.roomId).toBe(joined[0].roomId); // room now exactly full

    const n21 = await join("Fill 21");
    expect(n21.roomId).not.toBe(joined[0].roomId); // full room → new room opened
  }, 60000);

  it("45 bots end with rooms of 20, 20 and 5 (spec 16.5)", async () => {
    // 20 bots from the previous test (full room + the 21st in room #2).
    // Fill room #2 to 20, then open room #3 with 5 more → 45 total.
    for (let i = 0; i < 19; i++) await join(`Mass ${i}`);
    for (let i = 0; i < 5; i++) await join(`Mass tail ${i}`);

    const counts = new Map<string, number>();
    for (const bot of bots) counts.set(bot.roomId, (counts.get(bot.roomId) ?? 0) + 1);
    const sizes = [...counts.values()].sort((a, b) => b - a);
    expect(sizes).toEqual([20, 20, 5]);
  }, 60000);

  it("two bots racing for the last slot both get in, no user error (spec 7.8)", async () => {
    // bring the 5-room up to 19
    for (let i = 0; i < 14; i++) await join(`Race fill ${i}`);
    const counts = new Map<string, number>();
    for (const bot of bots) counts.set(bot.roomId, (counts.get(bot.roomId) ?? 0) + 1);
    const smallRoomId = [...counts.entries()].find(([, n]) => n === 19)?.[0];
    expect(smallRoomId).toBeDefined();

    // race two joins for the final slot
    const [a, b] = await Promise.all([
      colyseus.sdk.joinOrCreate("arena", { name: "Racer A", colour: "orange" }),
      colyseus.sdk.joinOrCreate("arena", { name: "Racer B", colour: "orange" }),
    ]);
    bots.push(a, b);

    // both connected; no room over capacity; the 19-room reached 20
    const after = new Map<string, number>();
    for (const bot of bots) after.set(bot.roomId, (after.get(bot.roomId) ?? 0) + 1);
    for (const size of after.values()) expect(size).toBeLessThanOrEqual(20);
    expect(after.get(smallRoomId!)).toBe(20);
  }, 60000);

  it("when every bot leaves, zero rooms remain (spec 7.6)", async () => {
    for (const bot of bots) {
      try {
        bot.leave();
      } catch {
        /* already gone */
      }
    }
    await until(() => registry.roomCount() === 0, 10000, "rooms to auto-dispose");
    expect(registry.roomCount()).toBe(0);
    expect(registry.playerTotal()).toBe(0);
  }, 30000);

  it("reconnection holds the seat (spec 7.7)", async () => {
    const room: any = await colyseus.sdk.joinOrCreate("arena", { name: "Reconnector", colour: "white" });
    const token = room.reconnectionToken;
    const sessionId = room.sessionId;
    expect(token).toBeTruthy();

    // hard drop (no graceful leave) → onDrop holds the seat
    room.connection.close();
    await sleep(300);

    // come back within the hold window: same session id, state intact
    const again: any = await colyseus.sdk.reconnect(token);
    expect(again.sessionId).toBe(sessionId);
    await sleep(200);
    again.leave();
  }, 30000);
});
