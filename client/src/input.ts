/**
 * Input sampling (spec 9): keyboard (WASD + Space/Shift/G/R + Q/E), pointer
 * for in-air pitch/steer assist, and touch (stick + buttons). Sampled at the
 * fixed input rate by the game loop, not per key event.
 */

import type { DriveInput } from "@roadster-arena/shared";

export interface InputSource {
  sample(): DriveInput;
  /** true when a respawn key was pressed since the last consume() */
  consumeRespawn(): boolean;
  /** emote id pressed since the last consume(), "" when none */
  consumeEmote(): string;
  dispose(): void;
  /** true when a touch device is driving the axes */
  touchActive: boolean;
}

const DEAD = 0.16;

export function createInput(canvas: HTMLCanvasElement): InputSource {
  const keys = new Set<string>();
  let respawnQueued = false;
  let emoteQueued = "";
  let mouseDx = 0; // accumulated steering from pointer when pointer-locked
  let pointerLocked = false;

  // touch state
  let touchSteer = 0;
  let touchThrottle = 0;
  const touchModes = { hover: false, boost: false, grip: false };
  let touchActive = false;

  const onKey = (e: KeyboardEvent, down: boolean) => {
    const k = e.key.toLowerCase();
    if (down) {
      if (k === "r") respawnQueued = true;
      if (k >= "1" && k <= "8") emoteQueued = k;
    }
    // don't hijack keys when typing in an input field
    const el = document.activeElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
    if (["w", "a", "s", "d", " ", "shift", "g", "q", "e", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
      e.preventDefault();
    }
    if (down) keys.add(k);
    else keys.delete(k);
  };
  const kd = (e: KeyboardEvent) => onKey(e, true);
  const ku = (e: KeyboardEvent) => onKey(e, false);

  const onPointerLockChange = () => {
    pointerLocked = document.pointerLockElement === canvas;
    if (!pointerLocked) mouseDx = 0;
  };
  const onMouseMove = (e: MouseEvent) => {
    if (pointerLocked) mouseDx += e.movementX;
  };

  addEventListener("keydown", kd);
  addEventListener("keyup", ku);
  document.addEventListener("pointerlockchange", onPointerLockChange);
  addEventListener("mousemove", onMouseMove);

  // ----- touch wiring (the DOM elements live in index.html) -----
  const stick = document.getElementById("touch-stick");
  const stickKnob = stick?.querySelector("i");
  let stickId: number | null = null;
  let stickOrigin: { x: number; y: number } | null = null;

  const setKnob = (dx: number, dy: number) => {
    if (stickKnob) stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  };

  stick?.addEventListener("touchstart", (e) => {
    touchActive = true;
    const t = e.changedTouches[0];
    stickId = t.identifier;
    const r = stick.getBoundingClientRect();
    stickOrigin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    e.preventDefault();
  });
  stick?.addEventListener("touchmove", (e) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== stickId || !stickOrigin) continue;
      const dx = (t.clientX - stickOrigin.x) / 48; // 48px = full lock
      const dy = (t.clientY - stickOrigin.y) / 48;
      touchSteer = Math.max(-1, Math.min(1, dx));
      setKnob(Math.max(-1, Math.min(1, dx)) * 38, Math.max(-1, Math.min(1, dy)) * 38);
      touchThrottle = Math.max(-1, Math.min(1, -dy)); // pull back = brake
    }
    e.preventDefault();
  });
  const stickEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== stickId) continue;
      stickId = null;
      stickOrigin = null;
      touchSteer = 0;
      touchThrottle = 0;
      setKnob(0, 0);
    }
  };
  stick?.addEventListener("touchend", stickEnd);
  stick?.addEventListener("touchcancel", stickEnd);

  const bindHold = (name: keyof typeof touchModes | "throttle" | "brake") => {
    const el = document.querySelector<HTMLButtonElement>(`#touch-controls [data-touch="${name}"]`);
    if (!el) return;
    const on = (e: Event) => {
      touchActive = true;
      if (name === "throttle") touchThrottle = 1;
      else if (name === "brake") touchThrottle = -1;
      else touchModes[name as keyof typeof touchModes] = true;
      el.classList.add("down");
      e.preventDefault();
    };
    const off = () => {
      if (name === "throttle") touchThrottle = 0;
      else if (name === "brake") touchThrottle = 0;
      else touchModes[name as keyof typeof touchModes] = false;
      el.classList.remove("down");
    };
    el.addEventListener("touchstart", on);
    el.addEventListener("touchend", off);
    el.addEventListener("touchcancel", off);
  };
  bindHold("throttle");
  bindHold("brake");
  bindHold("hover");
  bindHold("boost");
  bindHold("grip");

  const axis = (neg: string[], pos: string[]): number => {
    const n = neg.some((k) => keys.has(k));
    const p = pos.some((k) => keys.has(k));
    if (n === p) return 0;
    return n ? -1 : 1;
  };

  return {
    sample(): DriveInput {
      let throttle = axis(["s", "arrowdown"], ["w", "arrowup"]);
      let steer = axis(["a", "arrowleft"], ["d", "arrowright"]);
      if (touchActive) {
        if (Math.abs(touchThrottle) > 0.05) throttle = touchThrottle;
        if (Math.abs(touchSteer) > DEAD) steer = touchSteer;
      }
      // pointer steering assist: mouse dx nudges steer like a wheel
      if (pointerLocked && Math.abs(mouseDx) > 2) {
        steer = Math.max(-1, Math.min(1, steer + mouseDx / 260));
        mouseDx *= 0.82; // decays — the wheel recentres
      } else if (pointerLocked) {
        mouseDx = 0;
      }
      const applyDead = (v: number) => (Math.abs(v) < DEAD ? 0 : v);
      steer = applyDead(steer);
      return {
        throttle: applyDead(throttle),
        steer,
        pitch: applyDead(axis(["arrowdown"], ["arrowup"])),
        roll: applyDead(axis(["q"], ["e"])),
        yaw: 0,
        hover: keys.has(" ") || touchModes.hover,
        boost: keys.has("shift") || touchModes.boost,
        grip: keys.has("g") || touchModes.grip,
      };
    },
    consumeRespawn(): boolean {
      const r = respawnQueued;
      respawnQueued = false;
      return r;
    },
    consumeEmote(): string {
      const e = emoteQueued;
      emoteQueued = "";
      return e;
    },
    dispose() {
      removeEventListener("keydown", kd);
      removeEventListener("keyup", ku);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      removeEventListener("mousemove", onMouseMove);
    },
    get touchActive() {
      return touchActive;
    },
  };
}