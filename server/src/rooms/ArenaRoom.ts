/**
 * ArenaRoom — the authoritative simulation for one arena (spec 5, 6, 7, 13).
 *
 * One room = one Rapier world. Clients send inputs (deduped, clamped and
 * buffered by Colyseus' defineInput); the room steps the shared physics world
 * on a fixed 60 Hz tick, applies gameplay (ghosts, boost gates, bumps,
 * respawn) and broadcasts state patches at 20 Hz.
 */

import { Room, type Client, type AuthContext, type StepContext } from "colyseus";
import RAPIER from "@dimforge/rapier3d-compat";
import type { EventQueue } from "@dimforge/rapier3d-compat";
import {
  ArenaState,
  CarPlayer,
  CarInput,
  CAR_COLOURS,
  DEFAULT_COLOUR,
  GHOST_SECONDS,
  KILL_Y,
  MESSAGES,
  stepCar,
  sanitiseName,
  isValidEmoteId,
  type CarSim,
  type GameplayConfig,
  type RoomsConfig,
  type BumpMessage,
  type GateBoostMessage,
  type EmoteMessage,
  type PingEcho,
  type DriveInput,
} from "@roadster-arena/shared";
import type { CarBody } from "../physics/world.js";
import { SimWorld } from "../physics/world.js";
import * as registry from "./registry.js";
import { ipAcquire, ipRelease } from "./ip-guard.js";
import { getEnv } from "../env.js";

interface CarEntry {
  /** authoritative per-car sim values (gas, boost timing, ghost, roll tap) */
  sim: CarSim;
  car: CarBody;
  ipAddress: string | undefined;
  lastRespawnRequestMs: number;
  lastGateMs: Map<number, number>;
}

export class ArenaRoom extends Room<{ state: ArenaState; input: CarInput }> {
  /** room capacity enforced natively by Colyseus matchmaking (spec 7.1) */
  maxClients = 20;
  /** spec 7.6: no empty rooms left running */
  autoDispose = true;
  /** 20 Hz state broadcast (spec 5.2) */
  patchRate = 1000 / 20;
  /** per-client flood protection on ordinary messages (spec 13) */
  maxMessagesPerSecond = 120;

  /**
   * Buffered, deduped, clamped input channel (spec 5.5, 13): the server never
   * trusts the wire — clamps run in place as frames decode; stale seq frames
   * are dropped.
   */
  inputs = this.defineInput(CarInput, {
    seqField: "seq",
    bufferMaxSize: 64,
    sanitize: {
      throttle: [-1, 1],
      steer: [-1, 1],
      pitch: [-1, 1],
      roll: [-1, 1],
      yaw: [-1, 1],
    },
    // hold the last stick state through packet gaps; idle frames never bump
    // the acknowledge cursor, so prediction replay stays exact (spec 5.3)
    idle: ({ latest }) => latest ?? true,
  });

  state = new ArenaState();
  cfg: GameplayConfig = getEnv().gameplay;
  roomsCfg: RoomsConfig = getEnv().rooms;

  private world!: SimWorld;
  private cars = new Map<string, CarEntry>();

  onCreate(options: { maxPlayers?: number } = {}): void {
    const env = getEnv();
    this.cfg = env.gameplay;
    this.roomsCfg = env.rooms;
    this.maxClients = options.maxPlayers ?? env.maxPlayers;
    this.patchRate = 1000 / env.rooms.stateBroadcastHz;
    this.maxMessagesPerSecond = env.rooms.inputRateHz + 30;

    // one authoritative Rapier world per room (spec 5.1)
    this.world = new SimWorld(RAPIER, this.cfg);

    this.setFixedTimestep((ctx) => this.tick(ctx), env.rooms.physicsTickHz);

    registry.registerRoom({
      roomId: this.roomId,
      players: 0,
      maxPlayers: this.maxClients,
      createdAt: Date.now(),
    });
  }

  /** Accept/reject the connection before join (spec 7.10, 13). */
  onAuth(client: Client, options: any, context: AuthContext): boolean {
    const allowed = this.roomsCfg.allowedOrigins;
    const origin = context.headers?.get?.("origin") ?? "";
    if (allowed.length > 0 && origin && !allowed.includes(origin)) {
      throw new Error("origin not allowed");
    }
    if (!ipAcquire(context.ip, this.roomsCfg.perIPConnectionLimit)) {
      throw new Error("too many connections from your network");
    }
    client.userData = {
      name: typeof options?.name === "string" ? options.name : "",
      colour: typeof options?.colour === "string" ? options.colour : "",
      ip: context.ip,
    };
    return true;
  }

  onJoin(client: Client): void {
    const userData = (client.userData ?? {}) as {
      name?: string;
      colour?: string;
      ip?: string;
    };

    // sanitise the display name; harmless fallback on bad input (spec 6.4, 13)
    let name = `Racer-${client.sessionId.slice(-4)}`;
    try {
      name = sanitiseName(userData.name);
    } catch {
      /* fallback name stays */
    }
    const colour = CAR_COLOURS.find((c) => c.id === userData.colour)?.id ?? DEFAULT_COLOUR;

    const spawn = this.world.pickSpawn();
    const carBody = this.world.createCar(client.sessionId, spawn.index);

    const now = this.clock.currentTime;
    const player = new CarPlayer({
      id: client.sessionId,
      name,
      colour,
      x: spawn.pos.x,
      y: spawn.pos.y,
      z: spawn.pos.z,
      qx: carBody.view.rotation.x,
      qy: carBody.view.rotation.y,
      qz: carBody.view.rotation.z,
      qw: carBody.view.rotation.w,
      vx: 0,
      vy: 0,
      vz: 0,
      mode: "ground",
      gas: this.cfg.gas.start,
      lastProcessedInput: 0,
      emoteId: "",
      emoteAt: 0,
      ghostUntil: now + GHOST_SECONDS * 1000,
    });
    this.state.players.set(client.sessionId, player);

    this.cars.set(client.sessionId, {
      sim: {
        body: carBody.view,
        gas: this.cfg.gas.start,
        mode: "ground",
        ghostUntilMs: player.ghostUntil,
        spawnIndex: spawn.index,
        boostUsedAtMs: Number.NEGATIVE_INFINITY,
        lastRollInput: 0,
        rollUntilMs: 0,
        rollDir: 0,
        lastProcessedInput: 0,
      },
      car: carBody,
      ipAddress: userData.ip,
      lastRespawnRequestMs: 0,
      lastGateMs: new Map(),
    });

    // spawn protection window (spec 6.3)
    this.world.setGhost(carBody, true);

    registry.setPlayerCount(this.roomId, this.cars.size);

    client.send(MESSAGES.welcome, {
      id: client.sessionId,
      roomId: this.roomId,
      playerCount: this.cars.size,
    });
    this.broadcast(MESSAGES.playerJoined, {
      id: client.sessionId,
      name,
      spawnIndex: spawn.index,
    });

    // full room: locked, hidden from matchmaking until a slot frees (spec 7.5)
    if (this.cars.size >= this.maxClients) this.lock();
  }

  /**
   * Connection blip: hold the seat ~15 s (configurable). The framework then
   * routes to onReconnect() or (on expiry) onLeave() (spec 7.7).
   */
  onDrop(client: Client, _code: number): void {
    this.allowReconnection(client, this.roomsCfg.reconnectHoldSeconds).catch(() => {
      /* the room may already be disposing */
    });
  }

  onReconnect(client: Client): void {
    const entry = this.cars.get(client.sessionId);
    if (entry) {
      // brief protection anyway: the player likely missed frames (spec 6.3)
      entry.sim.ghostUntilMs = this.clock.currentTime + GHOST_SECONDS * 1000;
      this.world.setGhost(entry.car, true);
      this.state.players.get(client.sessionId)!.ghostUntil = entry.sim.ghostUntilMs;
    }
    client.send(MESSAGES.welcome, {
      id: client.sessionId,
      roomId: this.roomId,
      playerCount: this.cars.size,
      reconnected: true,
    });
  }

  messages = {
    emote: (client: Client, payload: EmoteMessage) => {
      const entry = this.cars.get(client.sessionId);
      const player = this.state.players.get(client.sessionId);
      if (!entry || !player) return;
      if (!payload || !isValidEmoteId(payload.id)) return; // preset ids only
      const now = this.clock.currentTime;
      if (now - player.emoteAt < this.roomsCfg.emoteCooldownMs) return;
      player.emoteId = payload.id;
      player.emoteAt = now;
    },

    respawn: (client: Client) => {
      const entry = this.cars.get(client.sessionId);
      if (!entry) return;
      const now = this.clock.currentTime;
      if (now - entry.lastRespawnRequestMs < 500) return; // debounce
      entry.lastRespawnRequestMs = now;
      this.respawn(client.sessionId, "manual");
    },

    /** HUD ping indicator (spec 15): request/response round trip. */
    ping: (_client: Client, payload?: { t?: number }): PingEcho => {
      return { t: payload?.t ?? 0 };
    },
  };

  onLeave(client: Client, _code: number): void {
    const entry = this.cars.get(client.sessionId);
    this.cars.delete(client.sessionId);
    if (entry) {
      this.world?.destroyCar(entry.car);
      ipRelease(entry.ipAddress);
    }
    this.state?.players?.delete(client.sessionId);
    registry.setPlayerCount(this.roomId, this.cars.size);
    try {
      this.broadcast(MESSAGES.playerLeft, { id: client.sessionId });
    } catch {
      /* room may be mid-disposal */
    }

    // below capacity again: matchmaking can reuse the freed slot (spec 7.5)
    if (this.cars.size < this.maxClients) this.unlock();
  }

  onDispose(): void {
    this.cars.clear();
    this.world?.free();
    registry.unregisterRoom(this.roomId);
  }

  /* ------------------------------ simulation ------------------------------ */

  private tick(ctx: StepContext): void {
    const now = this.clock.currentTime;

    // 1) consume one buffered input per car per tick (spec 5.2: 60 Hz step,
    //    30 Hz input; idle frames hold the sticks without bumping the ack)
    for (const [sessionId, entry] of this.cars) {
      const accessor = this.inputs.get(sessionId);
      const input = accessor.next();
      if (!input) continue;
      entry.sim.lastProcessedInput = accessor.consumedCount;
      stepCar(entry.sim, input as unknown as DriveInput, {
        cfg: this.cfg,
        dt: ctx.dt,
        nowMs: now,
      });
    }

    // 2) solver step; contact/gate events come out of the queue
    this.processEvents(this.world.step());

    // 3) housekeeping: ghost expiry, death floor
    for (const [sessionId, entry] of this.cars) {
      if (entry.sim.ghostUntilMs > 0 && now >= entry.sim.ghostUntilMs) {
        entry.sim.ghostUntilMs = 0;
        this.world.setGhost(entry.car, false);
      }
      if (entry.car.body.translation().y < KILL_Y) {
        this.respawn(sessionId, "fell");
      }
    }

    // 4) write state back for the patcher (spec 5.4)
    for (const [sessionId, entry] of this.cars) {
      const player = this.state.players.get(sessionId);
      if (!player) continue;
      writeState(player, entry.sim, entry.car);
    }
  }

  private processEvents(queue: EventQueue): void {
    const now = this.clock.currentTime;
    queue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const s1 = this.world.carSessionOf(h1);
      const s2 = this.world.carSessionOf(h2);

      // ---- car ↔ car bump (spec 6.3: physical only, no damage) -----------
      if (s1 && s2) {
        const e1 = this.cars.get(s1);
        const e2 = this.cars.get(s2);
        if (!e1 || !e2) return;
        // spawn-ghosted cars make no bump noise
        if (e1.sim.ghostUntilMs > now || e2.sim.ghostUntilMs > now) return;
        const p1 = e1.car.body.translation();
        const p2 = e2.car.body.translation();
        const v1 = e1.car.body.linvel();
        const v2 = e2.car.body.linvel();
        const rel = Math.hypot(v1.x - v2.x, v1.y - v2.y, v1.z - v2.z);
        const strength = Math.max(0.08, Math.min(1, rel / 30));
        const msg: BumpMessage = {
          x: (p1.x + p2.x) / 2,
          y: (p1.y + p2.y) / 2,
          z: (p1.z + p2.z) / 2,
          strength,
        };
        this.broadcast(MESSAGES.bump, msg);
        return;
      }

      // ---- car ↔ gate sensor (spec 8: small boost flying through) ---------
      const carSession = s1 ?? s2;
      const k1 = this.world.kindOf(h1);
      const k2 = this.world.kindOf(h2);
      const gateKind = k1?.type === "gate" ? k1 : k2?.type === "gate" ? k2 : undefined;
      if (carSession && gateKind) {
        const entry = this.cars.get(carSession);
        if (!entry) return;
        const last = entry.lastGateMs.get(gateKind.gateIndex) ?? Number.NEGATIVE_INFINITY;
        if (now - last < this.cfg.gate.cooldownSeconds * 1000) return;
        const gate = this.world.def.gates[gateKind.gateIndex];
        const v = entry.car.body.linvel();
        const along =
          v.x * gate.forward.x + v.y * gate.forward.y + v.z * gate.forward.z;
        if (along < 3) return; // crossing the plane the wrong way: nothing
        entry.lastGateMs.set(gateKind.gateIndex, now);
        entry.car.body.setLinvel(
          {
            x: v.x + gate.forward.x * this.cfg.gate.boostImpulse,
            y: v.y + gate.forward.y * this.cfg.gate.boostImpulse,
            z: v.z + gate.forward.z * this.cfg.gate.boostImpulse,
          },
          true,
        );
        const msg: GateBoostMessage = { gateIndex: gateKind.gateIndex };
        this.broadcast(MESSAGES.gateBoost, msg);
      }
    });
  }

  /** Respawn at a random free slot; brief spawn ghost (spec 6.3). */
  private respawn(sessionId: string, _cause: "manual" | "fell"): void {
    const entry = this.cars.get(sessionId);
    const player = this.state.players.get(sessionId);
    if (!entry || !player) return;

    this.world.releaseSpawn(entry.sim.spawnIndex);
    const spawn = this.world.pickSpawn();
    this.world.claimSpawn(spawn.index);

    entry.sim.spawnIndex = spawn.index;
    entry.car.spawnIndex = spawn.index;
    entry.car.body.setTranslation(spawn.pos, false);
    entry.car.body.setRotation(
      this.world.def.spawnQuat[spawn.index] ?? { x: 0, y: 0, z: 0, w: 1 },
      false,
    );
    entry.car.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    entry.car.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    entry.sim.gas = this.cfg.gas.max;
    entry.sim.boostUsedAtMs = Number.NEGATIVE_INFINITY;
    entry.sim.mode = "ground";
    entry.sim.ghostUntilMs = this.clock.currentTime + GHOST_SECONDS * 1000;
    this.world.setGhost(entry.car, true);
    writeState(player, entry.sim, entry.car);
  }
}

/** Copy authoritative sim values into the network state (spec 5.4). */
function writeState(player: CarPlayer, sim: CarSim, car: CarBody): void {
  const b = car.body;
  const tr = b.translation();
  const rot = b.rotation();
  const vel = b.linvel();
  player.x = tr.x;
  player.y = tr.y;
  player.z = tr.z;
  player.qx = rot.x;
  player.qy = rot.y;
  player.qz = rot.z;
  player.qw = rot.w;
  player.vx = vel.x;
  player.vy = vel.y;
  player.vz = vel.z;
  player.mode = sim.mode;
  player.gas = sim.gas;
  player.lastProcessedInput = sim.lastProcessedInput;
  player.ghostUntil = sim.ghostUntilMs;
}
