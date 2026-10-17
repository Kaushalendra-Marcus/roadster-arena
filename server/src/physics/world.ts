/**
 * Rapier physics world for one arena room (spec 5.1, 6.3, 8).
 *
 * Static colliders come from the shared map definition, so the server world
 * and the client prediction world contain exactly the same geometry. Cars are
 * dynamic rigid bodies (gravity off — the shared controller owns gravity),
 * with collision groups that switch when a car is a spawn ghost.
 */

import RAPIER, { World, ColliderDesc, RigidBodyDesc, Collider } from "@dimforge/rapier3d-compat";
import type { ColliderHandle } from "@dimforge/rapier3d-compat";
import {
  buildArenaDef,
  CAR_TARGET_CLEARANCE,
  type ArenaDef,
  type GameplayConfig,
  type CarBodyView,
} from "@roadster-arena/shared";

/* ------------------------------ collision bits ---------------------------- */

export const GROUP_STATIC = 0x0001;
export const GROUP_CAR = 0x0002;
export const GROUP_GATE = 0x0008;

const GROUPS = {
  staticAll: { membership: GROUP_STATIC, filter: 0xffff },
  // cars collide with static geometry and with other cars
  carNormal: { membership: GROUP_CAR, filter: GROUP_STATIC | GROUP_CAR },
  // ghosts skip car-car collisions (spec 6.3)
  carGhost: { membership: GROUP_CAR, filter: GROUP_STATIC },
  gateSensor: { membership: GROUP_GATE, filter: GROUP_CAR },
} as const;

function packGroups(m: number, f: number): number {
  return ((m << 16) | f) >>> 0;
}

/* -------------------------------- physical car --------------------------- */

export const CAR_HALF = { x: 0.95, y: 0.55, z: 2.05 };
export const CAR_MASS = 700;

export interface CarBody {
  body: RAPIER.RigidBody;
  collider: Collider;
  view: CarBodyView;
  spawnIndex: number;
}

export function makeCarView(body: RAPIER.RigidBody, world: World): CarBodyView {
  const ray = (
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxToi: number,
  ) => {
    const r = new RAPIER.Ray(origin, dir);
    const hit = world.castRayAndGetNormal(r, maxToi, true, undefined, undefined, undefined, body);
    if (!hit) return null;
    return {
      hit: true,
      toi: hit.timeOfImpact,
      /** Rapier returns the normal oriented opposite the ray direction, i.e.
          pointing from the surface toward the ray origin — exactly what the
          controller wants for the pin spring. */
      normal: { ...hit.normal },
    };
  };
  return {
    get translation() {
      return body.translation();
    },
    get linvel() {
      return body.linvel();
    },
    get angvel() {
      return body.angvel();
    },
    get rotation() {
      return body.rotation();
    },
    setTranslation: (v, wake) => body.setTranslation(v, wake),
    setLinvel: (v, wake) => body.setLinvel(v, wake),
    setAngvel: (v, wake) => body.setAngvel(v, wake),
    setRotation: (q, wake) => body.setRotation(q, wake),
    applyImpulse: (v, wake) => body.applyImpulse(v, wake),
    raycast: ray,
  };
}

/* ------------------------------- the sim world --------------------------- */

export type HitKind =
  | { type: "car"; sessionId: string }
  | { type: "gate"; gateIndex: number }
  | { type: "static"; label?: string };

export class SimWorld {
  readonly world: World;
  readonly def: ArenaDef;
  readonly eventQueue: RAPIER.EventQueue;
  private handleKinds = new Map<ColliderHandle, HitKind>();
  private spawnTaken = new Set<number>();

  constructor(
    private readonly rapier: typeof RAPIER,
    private readonly cfg: GameplayConfig,
  ) {
    // Gravity lives in the car controller (gravityScale=0); arena bodies are
    // static, so a zero world gravity is right (spec 6.2).
    this.world = new rapier.World({ x: 0, y: 0, z: 0 });
    // Kill Rapier's speculative (soft-CCD) contacts: at car speeds the
    // predictor stops the body at up-to-~0.2 m from a surface and dumps the
    // full approach velocity as an impulse, which read as a wall slam at every
    // ramp lip. With it off the controller's own clearance servo handles the
    // entries and stable contacts still keep resting/crashing working.
    this.world.integrationParameters.normalizedPredictionDistance = 0;
    this.def = buildArenaDef(cfg);
    this.buildArena();
    // Arm Rapier's query pipeline: castRay returns null on a never-stepped
    // world, so without this the very first control ticks after room creation
    // would probe empty space (cars unpinned for a moment).
    this.world.step();
    this.eventQueue = new rapier.EventQueue(true);
  }

  private buildArena(): void {
    for (const collider of this.def.colliders) {
      const desc: ColliderDesc =
        "vertices" in collider
          ? ColliderDesc.trimesh(
              new Float32Array(collider.vertices),
              new Uint32Array(collider.indices),
            )
          : ColliderDesc.cuboid(collider.half.x, collider.half.y, collider.half.z);

      desc.setTranslation(collider.pos.x, collider.pos.y, collider.pos.z);
      if (!("vertices" in collider) && collider.axis && (collider.angle ?? 0) !== 0) {
        const a = collider.angle ?? 0;
        const ha = a / 2;
        desc.setRotation({
          x: collider.axis === "x" ? Math.sin(ha) : 0,
          y: collider.axis === "y" ? Math.sin(ha) : 0,
          z: collider.axis === "z" ? Math.sin(ha) : 0,
          w: Math.cos(ha),
        });
      }
      desc.setCollisionGroups(packGroups(GROUPS.staticAll.membership, GROUPS.staticAll.filter));
      desc.setRestitution(collider.restitution ?? 0.05);
      desc.setFriction(0.85);
      const c = this.world.createCollider(desc);
      this.handleKinds.set(c.handle, { type: "static", label: collider.kind });
    }

    // ring gate sensors (spec 8: ring gates give a small boost when flown
    // through). A ring of sensor boxes around each gate.
    for (const [gateIndex, gate] of this.def.gates.entries()) {
      const segments = 16;
      const boxHalf = 0.9;
      // plane basis: forward defines the boost direction; "right" spans the ring
      const fwdN = normalize(gate.forward);
      const right = normalize(cross({ x: 0, y: 1, z: 0 }, fwdN));
      const upAxis = normalize(cross(right, fwdN));
      for (let s = 0; s < segments; s++) {
        const a = (Math.PI * 2 * s) / segments;
        const rx = Math.cos(a) * gate.radius;
        const ry = Math.sin(a) * gate.radius;
        const desc = ColliderDesc.cuboid(boxHalf, boxHalf, boxHalf);
        desc.setTranslation(
          gate.pos.x + right.x * rx + upAxis.x * ry,
          gate.pos.y + right.y * rx + upAxis.y * ry,
          gate.pos.z + right.z * rx + upAxis.z * ry,
        );
        desc.setSensor(true);
        desc.setCollisionGroups(packGroups(GROUPS.gateSensor.membership, GROUPS.gateSensor.filter));
        desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
        const c = this.world.createCollider(desc);
        this.handleKinds.set(c.handle, { type: "gate", gateIndex });
      }
    }
  }

  createCar(sessionId: string, spawnIndex: number): CarBody {
    const spawn = this.def.spawnPoints[spawnIndex] ?? this.def.spawnPoints[0];
    const quat = this.def.spawnQuat[spawnIndex] ?? { x: 0, y: 0, z: 0, w: 1 };
    const rb = RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setLinvel(0, 0, 0)
      .setAngvel({ x: 0, y: 0, z: 0 })
      .setRotation(quat)
      .setCanSleep(false)
      // CCD off: at 60-68 m/s the swept box grazes every ramp lip and the CCD
      // parks the body dead at the surface front, killing the forward speed.
      // The soft-boundary force keeps cars from reaching the outer walls, so
      // tunneling there is not a real concern.
      .setCcdEnabled(false)
      .setGravityScale(0)
      .setLinearDamping(0.0)
      .setAngularDamping(0.35);
    const body = this.world.createRigidBody(rb);
    const colliderDesc = ColliderDesc.cuboid(CAR_HALF.x, CAR_HALF.y, CAR_HALF.z)
      .setCollisionGroups(packGroups(GROUPS.carNormal.membership, GROUPS.carNormal.filter))
      // 0.02 (was 0.3): restitution 0.3 made grazing ramp edges pop cars into
      // the sky through the solver's contact correction; the bump feel comes
      // from the controller and the bump sound instead
      .setRestitution(this.cfg.physics.restitution)
      .setFriction(0.05)
      .setMass(CAR_MASS)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = this.world.createCollider(colliderDesc, body);

    this.handleKinds.set(collider.handle, { type: "car", sessionId });
    this.spawnTaken.add(spawnIndex);
    const view = makeCarView(body, this.world);
    return { body, collider, view, spawnIndex };
  }

  destroyCar(car: CarBody): void {
    this.handleKinds.delete(car.collider.handle);
    this.releaseSpawn(car.spawnIndex);
    this.world.removeRigidBody(car.body);
  }

  /** Pick a free spawn slot round the plaza (spec 6.3: random free spawn). */
  pickSpawn(): { index: number; pos: { x: number; y: number; z: number } } {
    const free: number[] = [];
    for (let i = 0; i < this.def.spawnPoints.length; i++) {
      if (!this.spawnTaken.has(i)) free.push(i);
    }
    const pool = free.length > 0 ? free : [...Array(this.def.spawnPoints.length).keys()];
    const index = pool[Math.floor(Math.random() * pool.length)];
    return { index, pos: this.def.spawnPoints[index] };
  }

  claimSpawn(index: number): void {
    this.spawnTaken.add(index);
  }

  releaseSpawn(index: number): void {
    this.spawnTaken.delete(index);
  }

  setGhost(car: CarBody, ghost: boolean): void {
    car.collider.setCollisionGroups(
      packGroups(
        GROUPS.carNormal.membership,
        ghost ? GROUPS.carGhost.filter : GROUPS.carNormal.filter,
      ),
    );
  }

  spawnTrans(spawnIndex: number): { pos: { x: number; y: number; z: number }; quat: { x: number; y: number; z: number; w: number } } {
    const i = ((spawnIndex % this.def.spawnPoints.length) + this.def.spawnPoints.length) % this.def.spawnPoints.length;
    return { pos: this.def.spawnPoints[i], quat: this.def.spawnQuat[i] };
  }

  kindOf(handle: ColliderHandle): HitKind | undefined {
    return this.handleKinds.get(handle);
  }

  /** Extract the session id stored with a car collider handle. */
  carSessionOf(handle: ColliderHandle): string | undefined {
    const kind = this.handleKinds.get(handle);
    return kind?.type === "car" ? kind.sessionId : undefined;
  }

  step(): RAPIER.EventQueue {
    this.world.step(this.eventQueue);
    return this.eventQueue;
  }

  free(): void {
    this.world.free();
    this.eventQueue.free();
  }
}

/* basis helpers local to physics wiring */
function normalize(v: { x: number; y: number; z: number }) {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
function cross(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** clearance target surfaced from the shared controller (used in respawn resets) */
export const TARGET_CLEARANCE = CAR_TARGET_CLEARANCE;
