/**
 * An office worker's body as the game sees it, shared by the server (hit detection) and the
 * client (the drawn rig): one function poses the body from what the server knows (where they
 * stand and look, crouching, and where they are in a swing), so the body you see is the body you
 * hit. The client adds only small secondary motion on top (springy overshoot, a lean into
 * acceleration, a flinch when hit, feet stepping on their own).
 */
import { Matrix4, Vector3 } from 'three';
import { A, ATTACKS, comboAng, comboAtk, isCombo, S, type Combat } from './combat';
import { AIM, DRIVE, eyeHeight, newBasis, newPose, pivotAt, poseOf, swingFront, THROW_AT, toWorld, TP, viewBasis } from './swing';

const smooth = (k: number) => k * k * (3 - 2 * k);

/** Upper arm and forearm (shoulder to grip ~0.63 m). */
export const ARM_A = 0.32;
export const ARM_B = 0.31;

/** `hp`: their health, when known (a beaten-up body stoops). */
export type CombatState = Pick<Combat, 's' | 't' | 'dur' | 'atk' | 'ang' | 'hitP'> & { hp?: number; gl?: number };

/** Upper-body wind at tick t of a combat state: +1 cocked toward the attack side, -1 followed through. */
export function wind(c: CombatState, t: number): number {
  const p = Math.min(1, Math.max(0, t / (c.dur || 1)));
  switch (c.s) {
    case S.Windup:
      // Past the end of the windup is the start of the release: the body leads the hammer into it.
      return t > c.dur ? 1 - 2 * Math.min(1, (t - c.dur) / ATTACKS[c.atk].release) : 1 - Math.pow(1 - p, 2.4);
    case S.Release:
      return 1 - 2 * p;
    case S.Recovery:
      return -1 + smooth(p);
    case S.Rebound:
    case S.Parried:
      // Stopped where it struck or was blocked, then back to guard.
      return (1 - (2 * c.hitP) / 255) * (1 - smooth(Math.max(0, (p - 0.3) / 0.7)));
    case S.Feint:
    case S.Flinch:
      return (1 - Math.pow(1 - c.hitP / 255, 2.4)) * (1 - smooth(p));
    // A throw: arched back under the raised hammer, driven forward as it goes, then upright.
    case S.ThrowWindup:
      return 1 - Math.pow(1 - p, 2.4);
    case S.Throw:
      return 1 - 2 * THROW_AT * p;
    case S.ThrowRecover:
      return (1 - 2 * THROW_AT - 0.6 * Math.sin(Math.PI * Math.min(1, p * 1.5))) * (1 - smooth(p));
  }
  return 0;
}

/**
 * What the body does for a combat state: turn of the shoulders and hips (rad, left +), lean
 * forward and to the right (rad), hips forward and down (m), the lead foot striding in or both
 * stumbling back (m), the head's nod, the parry brace, and a kick's knee up and leg out (0..1).
 */
export interface CombatPose {
  twist: number;
  hipTwist: number;
  lean: number;
  roll: number;
  shift: number;
  drop: number;
  step: number;
  back: number;
  nod: number;
  guard: number;
  kickC: number;
  kickE: number;
}

const LUNGE_LEAN = 0.18;

/** How far into the lunge behind a swing the body is (0..1): all the way as the hands reach the front. */
export function lungeOf(c: CombatState): number {
  if (c.s !== S.Release && c.s !== S.Rebound && c.s !== S.Parried) return 0;
  const p = c.dur > 0 ? Math.min(1, Math.max(0, c.t / c.dur)) : 0;
  if (c.s === S.Release) return swingFront(c.atk, Math.min(1, (c.t + 3) / (c.dur || 1)));
  return swingFront(c.atk, c.hitP / 255) * (1 - smooth(Math.max(0, (p - 0.3) / 0.7)));
}

export function combatPose(c: CombatState): CombatPose {
  const p = c.dur > 0 ? Math.min(1, Math.max(0, c.t / c.dur)) : 0;
  const a = c.atk === A.Overhead ? 0 : (c.ang / 256) * Math.PI * 2;
  const up = Math.cos(a),
    side = Math.sin(a);
  // The chain leads the hammer: hips first, then the shoulders, then the hammer itself.
  const ch = wind(c, c.t + 3),
    hp = wind(c, c.t + 6);
  const o: CombatPose = { twist: 0, hipTwist: 0, lean: 0, roll: 0, shift: 0, drop: 0, step: 0, back: 0, nod: 0, guard: 0, kickC: 0, kickE: 0 };
  if (c.atk === A.Stab) {
    // Drawn back with the rear (left) shoulder, the end of the handle at the left hip, then driven
    // forward off the back foot.
    o.twist = ch > 0 ? 0.8 * ch : 0.25 * ch;
    o.hipTwist = hp > 0 ? 0.3 * hp : 0.1 * hp;
    o.lean = ch > 0 ? -0.1 * ch : -0.26 * ch;
    o.shift = hp > 0 ? -0.07 * hp : -0.16 * hp;
    o.drop = 0.04 * Math.abs(ch);
  } else {
    // Shoulders turned right round toward the side it comes from, hips less; high attacks arch
    // back on the windup and crunch over on the follow-through, low ones dip.
    o.twist = -side * (ch > 0 ? 1.05 : 0.8) * ch;
    o.hipTwist = -side * 0.4 * hp;
    o.lean = ch > 0 ? -0.16 * up * ch : -ch * (0.1 + 0.16 * Math.max(0, up));
    o.roll = side * 0.12 * ch;
    o.shift = hp > 0 ? -0.06 * hp : -0.12 * hp;
    o.drop = Math.max(0, -up) * 0.1 * Math.abs(ch) + (ch < 0 ? -0.05 * ch * Math.max(0, up) : 0);
  }
  // The lunge: leaning and driving in behind the hands as they reach the front, so the shoulders
  // come forward by the hands' DRIVE (0.47 m up the chest, plus the hips).
  const f = lungeOf(c);
  o.lean += LUNGE_LEAN * f;
  o.shift += (DRIVE - 0.47 * Math.sin(LUNGE_LEAN)) * f;
  // The lead foot strides in as the swing comes round.
  if ((c.s === S.Windup && p > 0.55) || c.s === S.Release || (c.s === S.Recovery && p < 0.4)) o.step = c.atk === A.Stab ? 0.34 : 0.26;
  switch (c.s) {
    case S.Parry:
      o.guard = 1;
      break;
    case S.ParryRecover:
      // No bracing once the parry's over: a little slumped, open, until it's back to guard.
      o.lean += 0.08 * (p < 0.75 ? 1 : 1 - smooth((p - 0.75) / 0.25));
      break;
    case S.Parried:
    case S.Stagger: {
      // Rocked back on the heels, head snapped up, stumbling a step, for the whole stun.
      const reel = Math.sin(Math.min(1, p * 1.4) * Math.PI);
      o.lean -= 0.42 * reel;
      o.shift -= 0.1 * reel;
      o.nod -= 0.3 * reel;
      if (p < 0.6) o.back = 0.22;
      break;
    }
    case S.Disarmed: {
      // The hammer knocked out of their hands: jolted back by the blow, then hunched over their
      // stinging hands, head down, knees gone a little, rooted there until it wears off.
      const jolt = Math.sin(Math.min(1, p * 5) * Math.PI);
      const hunch = smooth(Math.min(1, Math.max(0, (p - 0.1) / 0.25))) * (1 - smooth(Math.max(0, (p - 0.8) / 0.2)));
      o.lean += 0.3 * hunch - 0.3 * jolt;
      o.nod += 0.45 * hunch - 0.25 * jolt;
      o.drop += 0.07 * hunch;
      break;
    }
    case S.Flinch:
      o.lean -= 0.14 * Math.sin(Math.PI * p);
      o.drop += 0.04 * Math.sin(Math.PI * p);
      break;
    case S.Rebound:
      o.lean -= 0.1 * (1 - p);
      break;
    case S.KickWindup:
      o.kickC = smooth(p);
      o.lean -= 0.14 * o.kickC;
      break;
    case S.KickRelease:
      o.kickC = 1;
      o.kickE = smooth(p);
      o.lean -= 0.14 + 0.1 * o.kickE;
      break;
    case S.KickRecover: {
      const k = 1 - smooth(p);
      o.kickC = Math.min(1, k * 1.6);
      o.kickE = Math.max(0, k * 2 - 1);
      o.lean -= 0.24 * k;
      break;
    }
  }
  // Braced behind a parry.
  o.lean += 0.06 * o.guard;
  o.drop += 0.05 * o.guard;
  if (c.s === S.Windup && isCombo(c.hitP)) {
    // A combo: the body winds on from the last swing's follow-through instead of squaring up first.
    const from = combatPose({ s: S.Recovery, t: 0, dur: 1, atk: comboAtk(c.hitP), ang: comboAng(c.hitP), hitP: 0 });
    const k = 1 - Math.pow(1 - p, 2.4);
    for (const key of Object.keys(o) as (keyof CombatPose)[]) o[key] = from[key] + (o[key] - from[key]) * k;
  }
  // Beaten up (fully by 30 health left): stooped forward like they're spent, sagging at the knees,
  // head hanging. Part of the shared pose, so the body that gets hit stoops with the one you see.
  const hurt = c.hp === undefined ? 0 : Math.min(1, Math.max(0, (100 - c.hp) / 70));
  o.lean += 0.26 * hurt;
  o.drop += 0.07 * hurt;
  o.nod += 0.2 * hurt;
  return o;
}

const tv = new Vector3();
const tw = new Vector3();

/**
 * Elbow position for a two-bone chain from shoulder to hand, bending toward pole. Out of reach,
 * the arm goes straight and the limbs stretch: hands never leave the handle.
 */
export function elbow(shoulder: Vector3, hand: Vector3, a: number, b: number, pole: Vector3, out: Vector3): Vector3 {
  const d = tv.subVectors(hand, shoulder);
  let len = d.length();
  if (len >= a + b - 0.002) return out.copy(shoulder).addScaledVector(d, a / (a + b));
  len = Math.max(0.05, len);
  const cos = Math.max(-1, Math.min(1, (a * a + len * len - b * b) / (2 * a * len)));
  const dir = d.normalize();
  const side = tw.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (side.lengthSq() < 1e-6) side.set(0, -1, 0);
  side.normalize();
  return out
    .copy(shoulder)
    .addScaledVector(dir, a * cos)
    .addScaledVector(side, a * Math.sqrt(1 - cos * cos));
}

/** Shoulder joints on the chest (chest-local), just clear of its sides. */
const SHOULDER = [0.24, 0.47, -0.03];
/** Reaching out or across the body pulls the shoulder up to this far forward (the shoulder blade sliding round the ribs). */
const PROTRACT = 0.08;
const cx = new Vector3();
const cy = new Vector3();
const cz = new Vector3();

/**
 * An arm's joints for a hand where the hammer puts it: the shoulder on the chest (reaching drags it
 * forward a little), the elbow bent down and out from the body's own side (not the camera's, so a
 * turned torso never folds an arm into itself), flared out behind a parry. Returns the bend
 * direction it used (for the limbs' roll). Shared by the hitboxes and the drawn rig.
 */
export function armJoints(chest: Matrix4, right: boolean, hand: Vector3, guard: number, sh: Vector3, el: Vector3, pole: Vector3): Vector3 {
  sh.set(right ? SHOULDER[0] : -SHOULDER[0], SHOULDER[1], SHOULDER[2]).applyMatrix4(chest);
  chest.extractBasis(cx, cy, cz);
  const reach = ARM_A + ARM_B;
  const across = Math.max(0, (right ? -1 : 1) * (cx.x * (hand.x - sh.x) + cx.y * (hand.y - sh.y) + cx.z * (hand.z - sh.z)));
  const fwd = Math.min(PROTRACT, 0.18 * across);
  sh.addScaledVector(cz, -fwd);
  // What's left of the shoulder blade's travel goes toward a hand near the end of the arm's reach.
  const d = sh.distanceTo(hand);
  const left = PROTRACT - fwd;
  if (d > reach - left) sh.lerp(hand, Math.min(left, d - (reach - left)) / d);
  // Out from that side, down, and a little forward (front is -z): overhead, that's out and ahead.
  pole
    .copy(cx)
    .multiplyScalar((right ? 1 : -1) * (0.6 + 0.6 * guard))
    .addScaledVector(cy, -1 + 0.6 * guard)
    .addScaledVector(cz, -0.4);
  elbow(sh, hand, ARM_A, ARM_B, pole, el);
  return pole;
}

export interface BodyState extends CombatState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: number;
  /** Holding a hammer (the default); 0 once it's been thrown. */
  armed?: number;
  /** A VR player (vr.ts): their own hands (right then left, world), not the swing's; the body stands as it does at rest. */
  hands?: number[] | null;
}

const atRest = { s: S.Idle, t: 0, dur: 0, atk: 0, ang: 64, hitP: 0 };
/** What the body's doing: a VR player's swings are their arms', so the body just stands. */
export const bodyCombat = <T extends BodyState>(h: T): T => (h.hands ? Object.assign(Object.create(h), atRest) : h);

/**
 * How far an empty hand has gone from the hammer's line to hanging at its side (0..1): all the
 * way once the hammer's gone, easing down through the throw's follow-through.
 */
export function emptyHands(h: CombatState & { armed?: number }): number {
  if (h.armed ?? 1) return 0;
  const p = Math.min(1, Math.max(0, h.t / (h.dur || 1)));
  // Thrown: following through, then dropping. Disarmed: wrung in front of them (swing.ts), dropping at the end.
  return h.s === S.ThrowRecover ? smooth(p) : h.s === S.Disarmed ? smooth(Math.max(0, (p - 0.75) / 0.25)) : 1;
}

/** An empty hand hanging at the body's side (out: world). */
export function restHand(chest: Matrix4, right: boolean, out: Vector3): Vector3 {
  return out.set(right ? 0.27 : -0.27, -0.12, -0.08).applyMatrix4(chest);
}

/** A hit volume: a capsule a-b of radius r, and where on the body it counts (0 head, 1 torso and arms, 2 legs). */
export interface Capsule {
  a: Vector3;
  b: Vector3;
  r: number;
  loc: number;
}

export const newBody = (): Capsule[] => Array.from({ length: 11 }, (_, i) => ({ a: new Vector3(), b: new Vector3(), r: 0, loc: i === 0 ? 0 : i >= 7 ? 2 : 1 }));

const chest = new Matrix4();
const hips = new Matrix4();
const m1 = new Matrix4();
const basis = newBasis();
const pose = newPose();
const hand = new Vector3();
const pole = new Vector3();
const piv = new Vector3();

/**
 * Where the hips and chest are for a body state (forward is -z, as the drawn rig): the hips over
 * the feet, the chest pivoting on them. crouch may be fractional (the first-person view eases it).
 */
export function posture(h: BodyState, cp: CombatPose, hipsOut: Matrix4, chestOut: Matrix4) {
  const lean = cp.lean + 0.22 * h.crouch - h.pitch * AIM;
  const drop = cp.drop + 0.33 * h.crouch + 0.03;
  hipsOut.makeRotationY(h.yaw).setPosition(h.x, h.y, h.z);
  hipsOut.multiply(m1.makeTranslation(0, 0.95 - drop, -cp.shift));
  chestOut.makeRotationY(h.yaw + cp.twist);
  chestOut.multiply(m1.makeRotationX(-lean));
  chestOut.multiply(m1.makeRotationZ(-cp.roll));
  hipPos.setFromMatrixPosition(hipsOut);
  chestOut.setPosition(hipPos.x, hipPos.y + 0.1, hipPos.z);
}
const hipPos = new Vector3();

/**
 * The body's hit volumes, posed (out: from newBody()): head; torso and pelvis; both arms onto the
 * hammer the server sweeps; both legs to where the feet stand (a kick lifts the right one).
 */
export function bodyCapsules(h: BodyState, out: Capsule[]): Capsule[] {
  const vrHands = h.hands;
  h = bodyCombat(h);
  const cp = combatPose(h);
  const ck = h.crouch ? 1 : 0;
  posture(h, cp, hips, chest);
  const at = (m: Matrix4, x: number, y: number, z: number, v: Vector3) => v.set(x, y, z).applyMatrix4(m);
  // Head, torso, pelvis.
  at(chest, 0, 0.66, 0, out[0].a);
  out[0].b.copy(out[0].a);
  out[0].r = 0.125;
  at(chest, 0, 0.08, 0, out[1].a);
  at(chest, 0, 0.42, 0, out[1].b);
  out[1].r = 0.18;
  at(hips, -0.09, 0, 0, out[2].a);
  at(hips, 0.09, 0, 0, out[2].b);
  out[2].r = 0.12;
  // Arms: hands on the hammer, joints as the rig draws them.
  viewBasis(h.yaw, h.pitch, basis);
  poseOf(h, h.t, pose, TP, h.pitch);
  pivotAt(h.x, h.y + eyeHeight(h.crouch), h.z, basis, piv);
  for (let i = 0; i < 2; i++) {
    const right = i === 0;
    toWorld(pose.o, basis, hand).add(piv);
    toWorld(pose.d, basis, tw);
    hand.addScaledVector(tw, right ? pose.s + pose.l : pose.s);
    const empty = emptyHands(h);
    if (empty > 0) hand.lerp(restHand(chest, right, tv), empty);
    if (vrHands) hand.fromArray(vrHands, i * 3);
    const up = out[3 + i * 2],
      fore = out[4 + i * 2];
    armJoints(chest, right, hand, cp.guard, up.a, up.b, pole);
    up.r = 0.06;
    fore.a.copy(up.b);
    fore.b.copy(hand);
    fore.r = 0.05;
  }
  // Legs: hip joints down to the feet in the fighting stance (the right one up for a kick).
  const still = 0.9;
  const wide = 0.1 + 0.05 * still + 0.06 * ck;
  const feet: [number, number][] = [
    [wide, -0.12 * still * (1 + ck) - cp.back * 0.6],
    [-wide, 0.14 * still * (1 + ck) + cp.step - cp.back],
  ];
  const root = m1.makeRotationY(h.yaw).setPosition(h.x, h.y, h.z);
  for (let i = 0; i < 2; i++) {
    const leg = out[7 + i * 2],
      shin = out[8 + i * 2];
    at(hips, i === 0 ? 0.1 : -0.1, -0.06, 0, leg.a);
    at(root, feet[i][0], 0.08, -feet[i][1], shin.b);
    if (i === 0 && cp.kickC > 0) shin.b.lerp(at(root, 0.1, 0.5 + 0.3 * cp.kickE, -0.22 - 0.5 * cp.kickE, tw), cp.kickC);
    // The knee halfway, a little forward of the line (legs bend forward).
    leg.b.lerpVectors(leg.a, shin.b, 0.5).addScaledVector(tw.set(-Math.sin(h.yaw), 0, -Math.cos(h.yaw)), 0.05 + 0.1 * ck);
    shin.a.copy(leg.b);
    leg.r = 0.08;
    shin.r = 0.065;
  }
  return out;
}
