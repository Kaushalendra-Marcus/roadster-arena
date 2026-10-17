import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ColyseusTestServer, boot } from "@colyseus/testing";
import appConfig from "../server/src/index.js";
import { ArenaState } from "@roadster-arena/shared";

describe("ArenaRoom smoke", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  beforeAll(async () => {
    colyseus = await boot(appConfig);
  });

  afterAll(async () => {
    await colyseus.shutdown();
  });

  it("creates a room and joins a client", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", {});
    expect(room).toBeTruthy();
    const client = await colyseus.connectTo(room);
    expect(client.sessionId).toBeTruthy();
    const player = room.state.players.get(client.sessionId);
    expect(player).toBeTruthy();
    expect(player!.name).toBeTruthy();
  });
});
