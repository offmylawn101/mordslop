/**
 * A fighter's state and its movement step: look, combat and moving, one fixed 60 Hz tick at a time.
 * Collision is yours: hand stepFighter a Mover (FlatMover for open ground, RapierMover in rapier.ts,
 * or your own engine's character controller).
 */
import { B, newCombat, S, speedScale, spendJump, STAM, stepCombat, turnCap, type Combat, type Input } from './combat';
import { DT } from './constants';

export interface PState {
  /** How fast they move (1: as usual). */
  move?: number;
  /** Gravity's share where they are (1: as usual). */
  grav?: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  crouch: number;
  grounded: number;
  /** Ticks of reduced control after a kick or a clash knocked them back. */
  knock: number;
  hp: number;
  alive: number;
  c: Combat;
}

export const newPState = (): PState => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, crouch: 0, grounded: 1, knock: 0, hp: 100, alive: 1, c: newCombat() });

/** Walking and sprinting speeds (m/s). */
export const RUN = 4.4;
export const SPRINT = 6.6;
const GRAVITY = 22;
const JUMP = 6.2;
/** Room overhead (m) a jump tops out under. */
const JUMP_ROOM = 1.1;
const MAX_PITCH = 1.45;

/**
 * Moves a fighter's capsule (feet at p.x, p.y, p.z) by up to (dx, dy, dz) through your world:
 * update p.x/y/z and p.grounded, and return how far it really went.
 */
export interface Mover {
  move(p: PState, dx: number, dy: number, dz: number): { x: number; y: number; z: number };
}

/** Open, flat ground at y = floor: no walls. Enough for a duel, a test, or a server that trusts its clients' positions. */
export class FlatMover implements Mover {
  constructor(readonly floor = 0) {}
  move(p: PState, dx: number, dy: number, dz: number) {
    const y = Math.max(this.floor, p.y + dy);
    const m = { x: dx, y: y - p.y, z: dz };
    p.x += dx;
    p.y = y;
    p.z += dz;
    p.grounded = p.y <= this.floor + 1e-4 ? 1 : 0;
    return m;
  }
}

function clampTurn(from: number, to: number, cap: number): number {
  if (!isFinite(cap)) return to;
  let d = to - from;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const lim = cap * DT * 1.05;
  return from + Math.max(-lim, Math.min(lim, d));
}

/**
 * One 60 Hz tick of look, combat and movement for a fighter. Returns the combat EV flags (a swing
 * started, released, feinted, a parry raised...). Look turns no faster than the weapon allows mid-swing.
 */
export function stepFighter(p: PState, inp: Input, mover: Mover): number {
  const c = p.c;
  if (!p.alive) return 0;
  const cap = turnCap(c);
  p.yaw = clampTurn(p.yaw, inp.yaw, cap);
  p.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, clampTurn(p.pitch, inp.pitch, cap)));
  const ev = stepCombat(c, inp);
  moveStep(p, inp, mover);
  return ev;
}

/** A tick of movement alone: walk, sprint (costs stamina), crouch, jump, knockback. */
export function moveStep(p: PState, inp: Input, mover: Mover) {
  const c = p.c;
  p.crouch = inp.buttons & B.Crouch ? 1 : 0;
  let mx = Math.max(-1, Math.min(1, inp.mx));
  let mz = Math.max(-1, Math.min(1, inp.mz));
  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }
  // Sprinting costs stamina (STAM.sprint a second), so there's none to sprint on with an empty
  // bar; and out of it altogether you're down to half a walk till it starts coming back.
  const sprinting = inp.buttons & B.Sprint && mz > 0.5 && !p.crouch && (c.s === S.Idle || c.s === S.Recovery) && c.stam > 0;
  if (sprinting) c.stam = Math.max(0, c.stam - STAM.sprint * DT);
  let speed = (sprinting ? SPRINT : c.stam < 1 ? RUN * 0.5 : RUN) * speedScale(c) * (p.crouch ? 0.55 : 1) * (p.move ?? 1);
  if (mz < -0.1) speed *= 0.78;
  const sy = Math.sin(p.yaw),
    cy = Math.cos(p.yaw);
  // Forward is -z at yaw 0; right is +x.
  const wx = mx * cy - mz * sy;
  const wz = -mx * sy - mz * cy;
  let accel = p.grounded ? 48 : 9;
  if (p.knock > 0) {
    accel *= 0.12;
    p.knock--;
  }
  const tx = wx * speed,
    tz = wz * speed;
  const ex = tx - p.vx,
    ez = tz - p.vz;
  const el = Math.hypot(ex, ez);
  const step = accel * DT;
  if (el <= step) {
    p.vx = tx;
    p.vz = tz;
  } else {
    p.vx += (ex / el) * step;
    p.vz += (ez / el) * step;
  }
  if (p.grounded && inp.buttons & B.Jump && c.stam > STAM.jump && c.s !== S.Stagger && c.s !== S.Disarmed) {
    p.vy = Math.min(JUMP, Math.sqrt(2 * GRAVITY * (p.grav ?? 1) * JUMP_ROOM));
    p.grounded = 0;
    spendJump(c);
  }
  p.vy -= GRAVITY * (p.grav ?? 1) * DT;
  const dx = p.vx * DT,
    dy = p.vy * DT,
    dz = p.vz * DT;
  // On the ground, move along it (a character controller's snap-to-ground holds it down): pushing
  // gravity into the floor every tick makes some controllers now and then cancel the whole step.
  const m = mover.move(p, dx, p.grounded && dy < 0 ? 0 : dy, dz);
  if (p.grounded && p.vy < 0) p.vy = 0;
  if (p.vy > 0 && m.y < dy * 0.5) p.vy = 0;
  // Ran into a wall: lose the velocity that went into it so knockback doesn't stick.
  if (Math.abs(dx) > 1e-5 && Math.abs(m.x) < Math.abs(dx) * 0.5) p.vx = m.x / DT;
  if (Math.abs(dz) > 1e-5 && Math.abs(m.z) < Math.abs(dz) * 0.5) p.vz = m.z / DT;
}
