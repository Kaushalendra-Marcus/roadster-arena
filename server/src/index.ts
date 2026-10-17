/**
 * Colyseus bootstrap (spec 14: server/src/index.ts).
 *
 * One process hosts many arena rooms joined via joinOrCreate (spec 7).
 * Also mounts /health, a dev-only rooms debug endpoint, and (in dev) the
 * Colyseus monitor/playground panels.
 */

import { type Request, type Response } from "express";
import { defineServer, defineRoom, monitor, playground } from "colyseus";
import RAPIER from "@dimforge/rapier3d-compat";
import { ArenaRoom } from "./rooms/ArenaRoom.js";
import * as registry from "./rooms/registry.js";
import { getEnv } from "./env.js";

const ENV = getEnv();

/** WebAssembly must be ready before any room builds its physics world. */
await RAPIER.init();

const server = defineServer({
  rooms: {
    [ENV.rooms.roomType]: defineRoom(ArenaRoom),
  },

  express: (app: import("express").Application) => {
    app.get("/health", (_req: Request, res: Response) => {
      res.json({
        status: "ok",
        rooms: registry.roomCount(),
        players: registry.playerTotal(),
        uptimeS: Math.round(process.uptime()),
        version: "1.0.0",
      });
    });

    if (!ENV.isProduction) {
      // bots/CI run against real matchmaking; this endpoint peeks at counts
      app.get("/debug/rooms", (_req: Request, res: Response) => {
        const list = registry.snapshot().map((r) => ({
          roomId: r.roomId,
          players: r.players,
          maxPlayers: r.maxPlayers,
        }));
        res.json({
          rooms: list,
          roomCount: registry.roomCount(),
          playerTotal: registry.playerTotal(),
        });
      });
      // dev panels (spec: monitor if exposed in production requires protection)
      app.use("/monitor", monitor());
      app.use("/playground", playground());
    }
  },
});

export default server;

/** Start the server when run directly (npm start → tsx src/index.ts). */
if (process.argv[1]?.indexOf("index") >= 0) {
  server.listen(ENV.port);
}
