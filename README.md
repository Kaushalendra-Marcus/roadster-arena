# Roadster Arena

A free, casual, multiplayer browser game: you drive a futuristic electric
roadster that boosts, hovers, and grips along walls and ceilings. Twenty
players per arena, one map, no moderators, no microtransactions.

> **Unofficial fan project.** Inspired by that famous flying-roadster teaser
> everyone has seen. No manufacturer trademarks, logos, or 3D assets are
> used — the in-game car is an original low-poly creation. Facts on the
> landing page come from publicly published data; see *Disclaimer* below.

---

## The pitch

| | |
| --- | --- |
| **Drive** | Arcade physics: throttle, drift-free steering, hard braking. |
| **Boost** | Burns 40 gas for an instant kick + 1 s of extra thrust. 5 s cooldown. |
| **Hover** | Lifts you three metres above whatever you were driving on. Gas drains fast. |
| **Grip** | Suction mode: drive on walls, through the loop, and upside-down along the tunnel ceiling. |
| **Bumps** | Car-vs-car is physical only — shove people around, no damage. |
| **Gates** | Three glowing rings in the sky: fly through for a free 18 m/s launch. |

Spawn protection (1.5 s ghost) after respawns, soft arena boundary, and a
deterministic 60 Hz authoritative simulation with client prediction — it
feels local even when the server is authoritative.

## Do some quick damage — how to play locally

```bash
# prereqs: Node 22+, npm
npm install

# dev servers (Colyseus on :2567, vite on :5173)
npm run dev
# → open http://localhost:5173, type a name, Enter the Arena
```

Controls: **W/S** throttle · **A/D** steer · **Shift** boost · **Space**
hover · **G** grip · **Q/E** barrel roll · **1–8** emotes · **mouse**
in-air pitch assist (click to lock pointer) · **Tab** scoreboard · **R**
respawn. Touch controls appear on mobile.

## Tests

```bash
npm test           # vitest: room rules + physics + smoke
npm run typecheck  # tsc over every workspace
npm run lint       # eslint
npm run build      # client production bundle
```

The room-rules suite is the acceptance test for the multiplayer design:
45 bots join and land in rooms of exactly **20/20/5**, racing joins never
over-fill a room, and the floor returns to zero rooms once everyone
disconnects.

## Repository layout

```
packages/shared   types, schema, map, gas/boost constants, THE car controller
server            Colyseus rooms, Rapier sim, matchmaking (authoritative)
client            vite + three.js game, prediction, HUD, landing page
config            gameplay.json + rooms.json (all server tunables live here)
content           roadster.json — landing facts, reveal figures, sources
tests             vitest suites (room rules, physics, smoke)
```

### Where the numbers live

Every gameplay tunable is in **config/gameplay.json** (car speeds, gas,
boost, arena radius, gates, respawn) and **config/rooms.json** (capacity,
rate limits, reconnect hold, tick rates). The shared physics module reads
these — no magic numbers in gameplay code.

### The landing page

`content/roadster.json` is the single source for every figure on the landing
page: hero stats, the spec sheet, trims, timeline, reveal quote and source
links. The page renders itself from that file at runtime, so changing a claim
never means editing markup. Two live three.js stages (`client/src/landing.ts`)
use the showroom roadster GLB: the hero turntable and the car inspector,
whose spec hotspots are pinned to fractions of the model's bounding box.

## How the netcode works

1. Clients send **only inputs** (30 Hz, buffered, clamped, sequence-numbered).
2. The server runs the **same shared `stepCar` function at 60 Hz** inside
   Rapier; nothing else is trusted.
3. State broadcasts at 20 Hz carry every player's transform **plus the last
   processed input sequence** (the ack cursor).
4. Each client predicts its own car with the identical shared code, then
   **rewinds to the authoritative snapshot and replays inputs the server
   hasn't consumed yet**. Measured drift over a 6 s throttling run:
   **avg 0.39 m, max 2.0 m**.
5. Remote players are snapshot-interpolated 110 ms behind live time.

## Deployment

Single-container, single-port: the Colyseus server serves both the game
socket and the built client.

```bash
docker build -t roadster-arena .
docker run -p 8080:8080 -e NODE_ENV=production roadster-arena

# or on Fly.io:
fly launch --copy-config   # fly.toml is checked in
fly deploy
```

Health endpoint: `GET /health` → `{"status":"ok","rooms":N,"players":N,…}`.

**Environment variables** (all optional):

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `2567` | HTTP + websocket port |
| `MAX_PLAYERS_PER_ROOM` | `20` | room capacity (matchmaking fills to this) |
| `ALLOWED_ORIGINS` | localhost trio | browser origins the ws handshake accepts |
| `RESERVE_URL` | — | the real reservation link once you have one (also `VITE_RESERVE_URL` for the client build) |

## Disclaimer

Roadster Arena is an unaffiliated fan project. All product names are used
descriptively; no endorsement is implied. The depicted vehicle is a
fictional, stylised interpretation. Build targets/number specs shown on the
landing page summarise publicly published information and are provided
*"as is"* without warranty. If you represent a rights holder and have a
concern, open an issue.

---

Built with three.js, Rapier, Colyseus, TypeScript, Vite — and too much
auditing of every number that felt right.

*Kaushalendra Marcus — project lead.*
