/**
 * Where the sledgehammer is. A pose is a line in view space (x right, y up, z forward) starting
 * at the shoulder pivot plus an offset. Held right-handed, as in Mordhau: the left hand holds the
 * end of the handle at distance s along dir, the right hand l further up it, the head sits at the
 * far end. The release poses are
 * the hitboxes: the server sweeps them for hits and every client draws the same thing.
 */
import { Vector3 } from 'three';
import { A, ATTACKS, comboAng, comboAtk, FOLLOW, isCombo, ROLL, S, T, type Combat } from './combat';
import type { Capsule } from './body';
import { CROUCH_EYE, EYE, PIVOT_DROP } from './constants';

export const HANDLE = 0.98;
/** How much of the view's pitch the upper body bends with, from the waist (WAIST below the pivot). */
export const AIM = 0.5;
/**
 * The hammer exactly as it's drawn, as the points the server sweeps: the handle (2 cm, from just
 * below the left hand up to the head) as small balls along it, and the steel head (24 cm long,
 * 10 cm across) as three balls along its own axis. Distances are from the left hand, at the end.
 */
const HAMMER_PTS = [
  ...[-0.06, 0.1, 0.26, 0.42, 0.58, 0.74].map((along) => ({ along, across: 0, r: 0.025 })),
  ...[-0.07, 0, 0.07].map((across) => ({ along: 0.95, across, r: 0.05 })),
];
export const HIT_POINTS = HAMMER_PTS.map((p) => p.along);
export const POINT_RADIUS = HAMMER_PTS.map((p) => p.r);
/** The middle of the head. */
export const HEAD_K = HAMMER_PTS.length - 2;
/** Points from here on are the head (a full blow); below it, the handle (a glancing one). */
export const SHAFT_K = HAMMER_PTS.length - 3;
export const hammerPoints = () => HAMMER_PTS.map(() => new Vector3());

export interface Pose {
  o: Vector3;
  d: Vector3;
  s: number;
  /** How far up the handle from the left hand (at the end) the right one is. */
  l: number;
}

export const newPose = (): Pose => ({ o: new Vector3(), d: new Vector3(0, 1, 0), s: 0, l: CARRY });

/** Hands apart on the handle for carrying and blocking; together (the left slid down) to swing. */
const CARRY = 0.32;
const SWING = 0.1;

const pose = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, s: number, l = CARRY): Pose => ({
  o: new Vector3(ox, oy, oz),
  d: new Vector3(dx, dy, dz).normalize(),
  s,
  l,
});

// Ready stance, as Mordhau holds its maul in first person: carried low and close across the chest,
// the end of the handle in the left hand just left of centre, the right hand along it, the shaft
// running out to the right and a little up, head level at the right of the view. Only hands and
// forearms show, coming up from the bottom of the screen; the crosshair stays clear.
export const IDLE = pose(-0.08, -0.05, 0.32, 0.72, 0.32, 0.6, 0.0, 0.3);
// What everyone else sees: the classic two-handed ready carry. Left hand at the end of the
// handle by the left hip, right hand up the handle at the chest, the head up by the right shoulder.
const IDLE_TP = pose(-0.15, -0.4, 0.24, 0.72, 0.68, 0.1, 0.0);
const PARRY = pose(-0.38, 0.12, 0.45, 1, 0.32, 0.05, 0.0);
// Seen from across the room, the parry throws the shaft up in a high guard across the face, hands
// spread wide on it, the head up over the right shoulder. No windup puts the hammer there, so a
// block can't be mistaken for an attack.
const PARRY_TP = pose(-0.34, 0.16, 0.42, 0.78, 0.6, 0.06, 0.0, 0.46);

/**
 * Rest and parry poses per viewpoint: first person keeps the crosshair clear, third person reads at
 * a distance. Seen from outside, a worker looking down doesn't fold the hammer into their hips: the
 * rest poses undo `level` of the view's pitch (the arms carry it, not the eyes). Swings never do.
 */
export interface Stance {
  idle: Pose;
  parry: Pose;
  /** A parry that caught nothing: the guard dropped, the hammer sagging low and open (T.parryRecover). */
  open: Pose;
  /** First person only: a parry that caught one, cocked to riposte (T.riposte). */
  ready?: Pose;
  level: number;
}
// Ready to riposte: off the block, the hammer cocked up at the right shoulder, the hands slid
// together at the end of the handle to swing, the head high in the top right of the view (any
// further back and it left the screen). Nothing else holds it there, so a riposte reads as open
// the moment it is.
const READY = pose(0.12, 0.0, 0.38, 0.52, 0.76, 0.38, 0.0, SWING);
// Open: the head dropped low out in front, nothing like the guard (or any windup), so whoever's
// facing it can see the parry's gone and swing. In
// first person the shaft droops from the hands, the head sagging a quarter of the view below
// where it's carried, at the bottom right; all of it well in shot.
const OPEN = pose(-0.04, 0.01, 0.42, 0.72, -0.26, 0.65, 0.0, 0.3);
const OPEN_TP = pose(-0.12, -0.45, 0.28, 0.6, -0.5, 0.6, 0.0);
export const FP: Stance = { idle: IDLE, parry: PARRY, open: OPEN, ready: READY, level: 0 };
export const TP: Stance = { idle: IDLE_TP, parry: PARRY_TP, open: OPEN_TP, level: 1 - AIM };

const lvIdle = newPose();
const lvParry = newPose();
const lvOpen = newPose();
const lvReady = newPose();
/** A view-space pose turned to look up by a (rad) about the view's right axis. */
function pitchUp(src: Pose, a: number, out: Pose): Pose {
  const c = Math.cos(a),
    s = Math.sin(a);
  out.o.set(src.o.x, src.o.y * c + src.o.z * s, -src.o.y * s + src.o.z * c);
  out.d.set(src.d.x, src.d.y * c + src.d.z * s, -src.d.y * s + src.d.z * c);
  out.s = src.s;
  out.l = src.l;
  return out;
}
const STAGGER = pose(-0.25, -0.45, 0.3, 0.1, 0.55, 0.6, 0.05);
/** Disarmed: empty hands (the hammer's gone, so only where they are matters) wrung together low in front of the chest. */
const DISARMED = pose(-0.12, -0.17, 0.3, 1, 0.2, -0.1, 0, 0.2);

// Arc angles (radians from straight ahead toward the side the swing comes from). Windups end
// well behind the attacking side so the direction reads at a glance.
const SLASH_FROM = 2.1;
const SLASH_TO = -1.4;
const OVER_FROM = 2.35;
const OVER_TO = -0.95;

function sideDir(ang: number, al: number, out: Vector3): Vector3 {
  const a = (ang / 256) * Math.PI * 2;
  const sa = Math.sin(al);
  return out.set(sa * Math.sin(a), sa * Math.cos(a), Math.cos(al));
}

/**
 * A real sledgehammer swing: slow out of the windup, fastest as it comes through in front (where
 * it hits), slowing into the follow-through (a sine ease, so it's about 1.6x the average speed
 * through the middle).
 */
const swingEase = (p: number) => (1 - Math.cos(Math.PI * p)) / 2;

/** Hands' angle round the arc as a fraction of the head's: cocked, the wrists hinge the head back past them. */
const HAND_LAG = 0.45;
const HAND_NEAR = 0.4;
const HAND_FAR = 0.52;
/** How far past a radian a slash's cocked hands keep turning after the head (the windup's), in radians. */
const COCK = 0.25;
/** How far the body drives in behind the hands at the strike (the lunge; body.ts leans into it). */
export const DRIVE = 0.16;

/** How square to the front a swing is at tick t (1 straight ahead, 0 side on or behind): the lunge. */
export function swingFront(atk: number, p: number): number {
  if (atk === A.Stab) return stabK(p);
  const from = atk === A.Overhead ? OVER_FROM : SLASH_FROM;
  const to = atk === A.Overhead ? OVER_TO : SLASH_TO;
  return Math.max(0, Math.cos(from + (to - from) * swingEase(p)));
}

function arcPose(atk: number, ang: number, p: number, out: Pose): Pose {
  const from = atk === A.Overhead ? OVER_FROM : SLASH_FROM;
  const to = atk === A.Overhead ? OVER_TO : SLASH_TO;
  const al = from + (to - from) * swingEase(p);
  sideDir(ang, al, out.d);
  // The hands ride a tighter arc than the head, always out in front of the body: cocked, up by
  // the attacking shoulder with the head hinged back behind them; at the strike, at full stretch
  // in front with the body driven in behind them; through, wrapped round as the head rolls past.
  const front = Math.max(0, Math.cos(al));
  // Cocked for a slash (the head more than a radian back), the hands stay out in front and up, in
  // sight, easing off smoothly
  // (no kink in their speed); through the front, where it hits, the swing is as it was.
  const cock = atk === A.Slash && al > 1;
  const handAl = cock ? HAND_LAG * (1 + COCK * (1 - Math.exp(-(al - 1) / COCK))) : al * HAND_LAG;
  sideDir(ang, handAl, out.o).multiplyScalar(HAND_NEAR + (HAND_FAR - HAND_NEAR) * front);
  if (cock) out.o.y += (Math.max(out.o.y, -0.06) - out.o.y) * Math.min(1, (al - 1) / 0.3);
  out.o.z += DRIVE * front;
  out.s = 0;
  out.l = SWING;
  return out;
}

const stabK = (p: number) => 1 - Math.pow(1 - Math.min(1, p / 0.5), 2);

function stabPose(p: number, out: Pose): Pose {
  // Drawn back with the end of the handle at the left hip, the right hand up it and the head
  // level ahead; then driven straight out, the left hand sliding up to the right.
  const k = stabK(p);
  out.d.set(0.06 - 0.04 * k, 0.06 - 0.04 * k, 1).normalize();
  out.o.set(-0.2 + 0.17 * k, -0.27 + 0.2 * k, 0.1 + (0.38 + DRIVE) * k);
  out.s = 0;
  out.l = CARRY + (SWING - CARRY) * k;
  return out;
}

/** How far round an overhead's arc the hammer is let go of when thrown (release progress). */
export const THROW_AT = 0.48;

/** The pose a release ends in (and a combo out of it starts from). */
const swingEnd = (atk: number, ang: number, out: Pose): Pose => (atk === A.Stab ? stabPose(1, out) : arcPose(atk, ang, 1, out));

/** The pose a windup ends in (and its release starts from). */
function readyPose(atk: number, ang: number, out: Pose): Pose {
  return atk === A.Stab ? stabPose(0, out) : arcPose(atk, ang, 0, out);
}

/** Slerp between unit directions, so big turns (overhead windups) don't collapse through the pivot. */
function slerpDir(a: Vector3, b: Vector3, k: number, out: Vector3): Vector3 {
  const th = Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
  const sn = Math.sin(th);
  if (sn < 1e-3) out.lerpVectors(a, b, k).normalize();
  else out.set(0, 0, 0).addScaledVector(a, Math.sin((1 - k) * th) / sn).addScaledVector(b, Math.sin(k * th) / sn).normalize();
  if (!(out.lengthSq() > 1e-8)) out.copy(k < 0.5 ? a : b);
  return out;
}

const FWD = new Vector3(0, 0, 1);
const midD = new Vector3();

const smooth = (k: number) => k * k * (3 - 2 * k);

export function blendPose(a: Pose, b: Pose, k: number, out: Pose): Pose {
  out.o.lerpVectors(a.o, b.o, k);
  // A wide turn (a carry to a low windup) goes round the front, never back through the body, eased
  // in from -0.2 to -0.5 (a hard switch at -0.2 popped the hammer round when the ends of a blend
  // drifted across it, as a riposte's do). Each leg gets its share of the time by its angle, so the
  // hammer keeps its speed round the corner (half each, it lurched there).
  const round = smooth(Math.min(1, Math.max(0, (-0.2 - a.d.dot(b.d)) / 0.3)));
  if (round > 0) {
    midD.addVectors(a.d, b.d).addScaledVector(FWD, 1.5 * round).normalize();
    const t1 = Math.acos(Math.min(1, a.d.dot(midD))),
      t2 = Math.acos(Math.max(-1, Math.min(1, midD.dot(b.d))));
    const k1 = Math.min(0.95, Math.max(0.05, t1 / (t1 + t2 || 1)));
    if (k < k1) slerpDir(a.d, midD, k / k1, out.d);
    else slerpDir(midD, b.d, (k - k1) / (1 - k1), out.d);
  } else slerpDir(a.d, b.d, k, out.d);
  out.s = a.s + (b.s - a.s) * k;
  out.l = a.l + (b.l - a.l) * k;
  return out;
}
const tmpA = newPose();
const tmpB = newPose();

/**
 * What a pose needs of a combat state. Where the stance has a `ready` pose (first person): the
 * riposte window, and for a riposte's windup, how far into the window it began (riposteAt; the
 * server doesn't say, client/viewmodel.ts keeps it).
 */
type PoseState = Pick<Combat, 's' | 't' | 'dur' | 'atk' | 'ang' | 'hitP'> & Partial<Pick<Combat, 'gl' | 'riposte'>> & { ripFrom?: number };

/** How far through the riposte window (0..1) an Idle state is at time t into it. */
export const riposteAt = (c: { t: number; riposte?: number }, t: number) => Math.min(1, (T.riposte - (c.riposte ?? 0) + t - c.t) / T.riposte);

/**
 * The riposte pose q of the way through its window: the hammer comes up off the block, rocked back
 * toward you by the blow, and cocks (the first 35%, 175 ms), holds, then sinks back to guard over
 * the last 30% as the window closes. The pose is the window.
 */
function riposted(q: number, parry: Pose, ready: Pose, idle: Pose, out: Pose): Pose {
  if (q >= RIP_UP) return blendPose(ready, idle, q < 0.7 ? 0 : smooth((q - 0.7) / 0.3), out);
  // The guard holds a beat on the blow it caught, then comes up fast.
  const k = Math.max(0, (q - RIP_HOLD) / (RIP_UP - RIP_HOLD));
  blendPose(parry, ready, 1 - Math.pow(1 - k, 2), out);
  out.o.z -= 0.05 * Math.sin(Math.PI * k);
  return out;
}
const rollTop = newPose();
const rollEnd = newPose();
const rollA = newPose();
const rollB = newPose();
/**
 * A riposte's windup, and a follow-up's: rolled out of the guard (a follow-up's out of rest) over the top,
 * the head swung up over the hands and on round into the swing, one unbroken whip (a curve through
 * the top, never stopping there), not a windup squared up from guard. It ends where any windup of
 * the attack does: the swing itself is unchanged (it's the hitbox).
 */
function rolled(from: Pose, atk: number, ang: number, p: number, out: Pose): Pose {
  const end = readyPose(atk, ang, rollEnd);
  // The top of it: the hands up between where they were and the windup's, the head straight up over them, tipped back.
  rollTop.o.lerpVectors(from.o, end.o, 0.5);
  rollTop.o.y += 0.1;
  rollTop.d.set(end.d.x * 0.4, 1.4, end.d.z * 0.4 - 0.35).normalize();
  rollTop.s = 0;
  rollTop.l = SWING;
  const k = smooth(p);
  blendPose(from, rollTop, k, rollA);
  blendPose(rollTop, end, k, rollB);
  return blendPose(rollA, rollB, k, out);
}
/** The riposte pose (riposted): the guard held this far through the window, up and cocked by this far. */
const RIP_HOLD = 0.15;
const RIP_UP = 0.45;
/** How far through being parried (T.parried) they can parry again: the hammer's back at rest by then. */
const PARRIED_OPEN = T.parriedStun / T.parried;

/** Hammer pose for a combat state. t may be fractional (render interpolation). */
/** Where the hammer is (in the view's frame) for this combat state, at time t into it. */
export function poseOf(c: PoseState, t: number, out: Pose, stance: Stance = FP, pitch = 0): Pose {
  basePose(c, t, out, stance, pitch);
  if (c.gl) {
    // Glanced off another hammer: knocked up (or down) off its line, the arms going with it.
    const k = c.gl / 100;
    out.d.y += k;
    out.d.normalize();
    out.o.y += k * 0.1;
  }
  return out;
}

function basePose(c: PoseState, t: number, out: Pose, stance: Stance, pitch: number): Pose {
  const lv = -pitch * stance.level;
  const idle = lv ? pitchUp(stance.idle, lv, lvIdle) : stance.idle;
  const parry = lv ? pitchUp(stance.parry, lv, lvParry) : stance.parry;
  const p = c.dur > 0 ? Math.min(1, Math.max(0, t / c.dur)) : 1;
  // A parry just caught one and the riposte's open (Combat.riposte), the parry's window still running or over.
  if ((c.s === S.Parry || c.s === S.Idle) && c.riposte && stance.ready) return riposted(riposteAt(c, t), parry, lv ? pitchUp(stance.ready, lv, lvReady) : stance.ready, idle, out);
  switch (c.s) {
    case S.Windup: {
      // Front-loaded: the hammer is most of the way to its side early in the windup. A combo
      // flows on from where the last swing finished; a riposte (a follow-up too) rolls out of the
      // guard (a follow-up out of rest, where its hit's rebound left it), in first person from wherever
      // the riposte pose had got to (a stab's just goes); anything else starts from guard.
      const rip = c.ripFrom !== undefined && stance.ready;
      if (c.hitP === FOLLOW && c.atk !== A.Stab) return rolled(idle, c.atk, c.ang, p, out);
      if (c.hitP === ROLL && c.atk !== A.Stab) return rolled(rip ? riposted(c.ripFrom!, parry, lv ? pitchUp(stance.ready!, lv, lvReady) : stance.ready!, idle, tmpA) : parry, c.atk, c.ang, p, out);
      const from = isCombo(c.hitP) ? swingEnd(comboAtk(c.hitP), comboAng(c.hitP), tmpA) : rip ? riposted(c.ripFrom!, parry, lv ? pitchUp(stance.ready!, lv, lvReady) : stance.ready!, idle, tmpA) : idle;
      return blendPose(from, readyPose(c.atk, c.ang, tmpB), 1 - Math.pow(1 - p, 2.4), out);
    }
    case S.Release:
      return c.atk === A.Stab ? stabPose(p, out) : arcPose(c.atk, c.ang, p, out);
    case S.Recovery: {
      const end = c.atk === A.Stab ? stabPose(1, tmpA) : arcPose(c.atk, c.ang, 1, tmpA);
      return blendPose(end, idle, smooth(p), out);
    }
    // Exactly as long as it's up (T.parry), the guard shows (rig.ts PoseBlend snaps to it and off it).
    case S.Parry:
      return blendPose(idle, parry, 1, out);
    case S.ParryRecover: {
      // Caught nothing: the guard sinks open under the hammer's weight, keeps settling a little lower while
      // it's open (held dead still, it looked stuck), then comes back to guard over the last 30%.
      const open = lv ? pitchUp(stance.open, lv, lvOpen) : stance.open;
      if (p < 0.35) blendPose(parry, open, smooth(p / 0.35), out);
      else blendPose(open, idle, p < 0.7 ? 0 : smooth((p - 0.7) / 0.3), out);
      const sag = 0.03 * Math.sin(Math.PI * Math.min(1, Math.max(0, (p - 0.15) / 0.85)));
      out.o.y -= sag;
      out.d.y -= sag;
      out.d.normalize();
      return out;
    }
    case S.Parried: {
      // Deflected hard: flung back along the arc from where it was stopped and knocked up high
      // off the block (nothing else points it at the ceiling), hanging there, then back to guard.
      const hit = c.hitP / 255;
      const fling = Math.sin(Math.min(1, p / 0.12) * Math.PI * 0.5);
      // Reeling: the hammer wobbles where it was knocked to before it comes back.
      const wobble = Math.sin(p * 30) * 0.04 * (1 - p);
      const at = c.atk === A.Stab ? stabPose(Math.max(0, hit - 0.6 * fling), tmpA) : arcPose(c.atk, c.ang, Math.max(0, hit - 0.32 * fling + wobble), tmpA);
      at.d.y += 1.3 * fling * (1 - 0.4 * smooth(Math.min(1, p / 0.6)));
      at.d.normalize();
      at.o.y += 0.12 * fling - 0.1 * smooth(Math.min(1, p / 0.5));
      at.o.z -= 0.08 * fling;
      // Back at rest by the time they can parry again (T.parriedStun), so it shows.
      return blendPose(at, idle, smooth(Math.min(1, Math.max(0, (p - 0.25) / (PARRIED_OPEN - 0.25)))), out);
    }
    case S.Feint: {
      // Pulled out of the windup from wherever it had got to.
      const from = blendPose(idle, readyPose(c.atk, c.ang, tmpA), 1 - Math.pow(1 - c.hitP / 255, 2.4), tmpB);
      return blendPose(from, idle, smooth(p), out);
    }
    case S.Flinch: {
      // Windup knocked out of their hands' line, jolted down, back to guard.
      const from = blendPose(idle, readyPose(c.atk, c.ang, tmpA), 1 - Math.pow(1 - c.hitP / 255, 2.4), tmpB);
      blendPose(from, idle, smooth(p), out);
      out.o.y -= Math.sin(Math.min(1, p * 1.6) * Math.PI) * 0.12;
      return out;
    }
    case S.Stagger:
      return blendPose(STAGGER, idle, p < 0.7 ? 0 : smooth((p - 0.7) / 0.3), out);
    case S.Disarmed: {
      // Torn out of the guard they were holding, the hands come together in front of them and
      // shake, less as it wears off (body.ts emptyHands drops them to their sides at the end).
      blendPose(parry, DISARMED, smooth(Math.min(1, p / 0.3)), out);
      const shake = 0.012 * (1 - p) * Math.min(1, p * 6);
      out.o.x += Math.sin(t * 1.9) * shake;
      out.o.y += Math.sin(t * 2.7 + 1) * shake;
      return out;
    }
    case S.ThrowWindup: {
      // Up overhead in both hands, as for an overhead, then drawn on back behind the head (the
      // tell: nothing else reaches that far back).
      blendPose(idle, readyPose(A.Overhead, 0, tmpB), 1 - Math.pow(1 - Math.min(1, p / 0.65), 2.4), out);
      const back = smooth(Math.max(0, (p - 0.45) / 0.55));
      out.d.z -= 0.55 * back;
      out.d.normalize();
      out.o.y += 0.06 * back;
      out.o.z -= 0.08 * back;
      return out;
    }
    case S.Throw:
      // Brought over the top and let go of at the end, about 45 degrees past upright.
      return arcPose(A.Overhead, 0, THROW_AT * p, out);
    case S.ThrowRecover:
      // Empty hands following through, then dropping (the body's rest takes them, body.ts).
      return blendPose(arcPose(A.Overhead, 0, THROW_AT + 0.2, tmpA), idle, smooth(p), out);
    case S.Rebound: {
      // Stopped dead where it struck. In a body, Mordhau's Maul is a hitstop weapon: it stays
      // buried there a beat (the first quarter, 100 ms), pressing in, before it's pulled back out;
      // off a wall (a clank) it bounces straight back. Then back to guard.
      const hit = c.hitP / 255;
      const hold = c.dur === T.clank ? 0 : 0.25;
      const q = Math.max(0, (p - hold) / 0.3);
      const dig = p < hold ? 0.025 * Math.sin((p / hold) * Math.PI * 0.5) : 0.025 * (1 - Math.min(1, q));
      // Out of a body it's pulled (easing out, not snatched: it went from pressing in to full speed
      // back in a frame); off a wall it bounces, at full speed at once.
      const back = (hold ? smooth(Math.min(1, q)) : Math.sin(Math.min(1, q) * Math.PI * 0.5)) * 0.14 - (hold ? dig : 0);
      const at = c.atk === A.Stab ? stabPose(Math.max(0, hit - back * 1.5), tmpA) : arcPose(c.atk, c.ang, Math.max(0, hit - back), tmpA);
      return blendPose(at, idle, p < hold + 0.35 ? 0 : smooth((p - hold - 0.35) / (0.65 - hold)), out);
    }
  }
  out.o.copy(idle.o);
  out.d.copy(idle.d);
  out.s = idle.s;
  out.l = idle.l;
  return out;
}

export interface Basis {
  f: Vector3;
  r: Vector3;
  u: Vector3;
}

export const newBasis = (): Basis => ({ f: new Vector3(), r: new Vector3(), u: new Vector3() });

/** yaw 0 looks down -z (three.js convention). */
export function viewBasis(yaw: number, pitch: number, b: Basis): Basis {
  const cp = Math.cos(pitch);
  b.f.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  b.r.set(Math.cos(yaw), 0, -Math.sin(yaw));
  b.u.crossVectors(b.r, b.f);
  return b;
}

/** View-space vector to world. */
export function toWorld(v: Vector3, b: Basis, out: Vector3): Vector3 {
  return out.set(
    b.r.x * v.x + b.u.x * v.y + b.f.x * v.z,
    b.r.y * v.x + b.u.y * v.y + b.f.y * v.z,
    b.r.z * v.x + b.u.z * v.y + b.f.z * v.z,
  );
}

export const eyeHeight = (crouch: number) => (crouch ? CROUCH_EYE : EYE);

const WAIST = 0.33;

/**
 * The swing's pivot (between the shoulders) for an eye at (x, eyeY, z) looking along b: it rides
 * the upper body as it bends from the waist toward where you look, so looking down brings the whole
 * swing, and the arms holding it, forward and down with the chest instead of into the hips.
 */
export function pivotAt(x: number, eyeY: number, z: number, b: Basis, out: Vector3): Vector3 {
  return onSpine(x, eyeY, z, b, WAIST, -PIVOT_DROP, out);
}

/**
 * Where the eyes are on that bending body, for the first-person camera: looking down, the head goes
 * forward and down with the chest, so your shoulders stay below and behind your eyes and the arms
 * always come into shot from off-screen. Kept inside the body's radius, so it never pokes through a
 * wall you're standing against.
 */
export function headAt(x: number, eyeY: number, z: number, b: Basis, out: Vector3): Vector3 {
  return onSpine(x, eyeY, z, b, WAIST + PIVOT_DROP, 0, out, 0.2);
}

/** A point `up` above the waist on the upper body bent toward the view (eyeY + drop when straight). */
function onSpine(x: number, eyeY: number, z: number, b: Basis, up: number, drop: number, out: Vector3, maxF = Infinity): Vector3 {
  const lean = -Math.asin(Math.max(-1, Math.min(1, b.f.y))) * AIM;
  const f = Math.max(-maxF, Math.min(maxF, up * Math.sin(lean)));
  // Level forward is (r.z, -r.x).
  return out.set(x + b.r.z * f, eyeY + drop - up * (1 - Math.cos(lean)), z - b.r.x * f);
}

const wo = new Vector3();
const wd = new Vector3();

/**
 * World positions of the hammer's sample points (HIT_POINTS order) and its grip, for a player
 * whose feet are at (x, y, z).
 */
const ACROSS = HAMMER_PTS.map((p) => p.across);
const ax = new Vector3();
const hv = new Vector3();
const hw = new Vector3();

/** The head's axis (the way its two faces point): along the swing's travel, so a face leads; ahead at rest and in a stab. */
export function headAxis(c: Pick<Combat, 's' | 'atk' | 'ang'>, b: Basis, dir: Vector3, out: Vector3) {
  const swinging = c.s === S.Windup || c.s === S.Release || c.s === S.Recovery || c.s === S.Parried || c.s === S.Feint || c.s === S.ThrowWindup || c.s === S.Throw;
  if (!swinging || c.atk === A.Stab) {
    out.copy(b.f).addScaledVector(dir, -b.f.dot(dir));
    if (out.lengthSq() < 1e-6) out.copy(b.u);
    return out.normalize();
  }
  const a = (c.ang / 256) * Math.PI * 2;
  // Side the swing comes from, then the swing plane's normal.
  hv.set(0, 0, 0).addScaledVector(b.u, Math.cos(a)).addScaledVector(b.r, Math.sin(a));
  hw.crossVectors(b.f, hv);
  out.crossVectors(hw, dir);
  if (out.lengthSq() < 1e-6) out.copy(b.r);
  return out.normalize();
}

/**
 * World positions of the hammer's sample points (HIT_POINTS order), for a player whose feet are
 * at (x, y, z): along the handle, and across the head on its own axis.
 */
const pv = new Vector3();

export function hammerWorld(x: number, y: number, z: number, crouch: number, b: Basis, ps: Pose, points: Vector3[], c: Pick<Combat, 's' | 'atk' | 'ang'>) {
  pivotAt(x, y + eyeHeight(crouch), z, b, pv);
  toWorld(ps.o, b, wo);
  toWorld(ps.d, b, wd);
  headAxis(c, b, wd, ax);
  for (let i = 0; i < HIT_POINTS.length; i++) {
    const k = ps.s + HIT_POINTS[i];
    points[i].set(pv.x + wo.x + wd.x * k + ax.x * ACROSS[i], pv.y + wo.y + wd.y * k + ax.y * ACROSS[i], pv.z + wo.z + wd.z * k + ax.z * ACROSS[i]);
  }
}

/**
 * The same sample points (HIT_POINTS order) on a hammer that's loose or flying: `center` is the
 * middle of its handle (the physics object's origin, 0.435 m up from the end hand), `y` up the
 * handle toward the head, `x` along the head.
 */
export function looseHammerPoints(center: Vector3, y: Vector3, x: Vector3, out: Vector3[]): Vector3[] {
  for (let i = 0; i < HIT_POINTS.length; i++) out[i].copy(center).addScaledVector(y, HIT_POINTS[i] - 0.435).addScaledVector(x, ACROSS[i]);
  return out;
}

const PARRY_LOOK = Math.cos((80 * Math.PI) / 180);
/**
 * A player's parry reaches further round: the attacker anywhere within 110 degrees of the way
 * they face, a little behind the shoulder, so long as their look isn't more than 60 degrees above
 * or below them. Bots keep the narrower cone, so going round one still works.
 */
const PARRY_SIDE = Math.cos((110 * Math.PI) / 180);
const PARRY_TILT = (60 * Math.PI) / 180;
// Wider round the sides than Mordhau's.
const PARRY_WEAPON = Math.cos((125 * Math.PI) / 180);

/**
 * Whether a parry covers this hit, Mordhau-style: the defender has to be looking at
 * the attacker (full 3D view, so staring at your feet or the ceiling fails), and the hammer must
 * not have been dragged round to their back.
 */
export function parryCovers(
  defYaw: number,
  defPitch: number,
  eye: { x: number; y: number; z: number },
  attEye: { x: number; y: number; z: number },
  px: number,
  pz: number,
  wide = false,
): boolean {
  const cp = Math.cos(defPitch);
  const fx = -Math.sin(defYaw) * cp,
    fy = Math.sin(defPitch),
    fz = -Math.cos(defYaw) * cp;
  let tx = attEye.x - eye.x,
    ty = attEye.y - eye.y,
    tz = attEye.z - eye.z;
  let l = Math.hypot(tx, ty, tz);
  if (wide) {
    const ah = Math.hypot(tx, tz);
    if (ah > 1e-3 && (-tx * Math.sin(defYaw) - tz * Math.cos(defYaw)) / ah < PARRY_SIDE) return false;
    if (Math.abs(defPitch - Math.atan2(ty, ah)) > PARRY_TILT) return false;
  } else if (l > 1e-3 && (tx * fx + ty * fy + tz * fz) / l < PARRY_LOOK) return false;
  // Weapon side: horizontal only, against the horizontal facing, from the shoulder blades (15 cm
  // behind the eyes), so a blow landing on the side of the body still counts as in front; only
  // one that's come round onto the back doesn't.
  const hl = Math.hypot(fx, fz) || 1;
  tx = px - (eye.x - (fx / hl) * 0.15);
  tz = pz - (eye.z - (fz / hl) * 0.15);
  l = Math.hypot(tx, tz);
  return l < 0.05 || (tx * fx + tz * fz) / (l * hl) >= PARRY_WEAPON;
}

/** Damage of a hammer hit: by attack, where it landed, and whether it was the handle (k < SHAFT_K). */
export function swingDamage(atk: number, loc: number, k: number): number {
  const spec = ATTACKS[atk];
  // A glancing blow with the handle hurts less.
  return (loc === 0 ? spec.head : loc === 1 ? spec.torso : spec.legs) * (k < SHAFT_K ? 0.75 : 1);
}

/** What a hammer contact does to an object: the head hits full, the handle half. */
export function objectDamage(atk: number, k: number): number {
  return ATTACKS[atk].smash * (k >= SHAFT_K ? 1 : 0.5);
}

export interface BodyHit {
  /** Fraction along this tick's sweep where it first touches. */
  f: number;
  /** 0 head, 1 torso (and arms), 2 legs. */
  loc: number;
  /** Which hammer sample point (handle < SHAFT_K <= head). */
  k: number;
  /** Which of the body's capsules (bodyCapsules order: 0 head, 1 chest, 2 pelvis, 3-6 arms, 7-10 legs). */
  part: number;
  point: Vector3;
}

/**
 * Where a full-speed blow with the steel caves the chest in (bodyCapsules order): the chest itself
 * and the upper arms lying against the ribs (a sledgehammer doesn't stop at an arm).
 */
export const CRUSHABLE = new Set([1, 3, 5]);
/** Head speed (m/s) a swing has through the fast middle of its arc: struck square there, it crushes a chest. */
export const CRUSH_SPEED = 12;

const hc1 = new Vector3();
const hc2 = new Vector3();
const hc3 = new Vector3();

/** The closest point to p on the segment a-b. */
function onSegment(a: Vector3, b: Vector3, p: Vector3, out: Vector3): Vector3 {
  hc3.subVectors(b, a);
  const l = hc3.lengthSq();
  const t = l > 1e-9 ? Math.max(0, Math.min(1, hc3.dot(out.subVectors(p, a)) / l)) : 0;
  return out.copy(a).addScaledVector(hc3, t);
}

/**
 * First contact between the hammer's sweep this tick (prev -> cur sample points) and a posed body
 * (bodyCapsules): which part it meets first, where, and with which bit of the hammer. Approximates
 * time of contact by sub-stepping each point's segment.
 */
export function bodyHit(prev: Vector3[], cur: Vector3[], body: Capsule[]): BodyHit | null {
  let best: BodyHit | null = null;
  for (let k = 0; k < prev.length; k++) {
    const r = POINT_RADIUS[k];
    for (let part = 0; part < body.length; part++) {
      const cap = body[part];
      const reach = (cap.r + r) ** 2;
      if (segSegDist2(prev[k], cur[k], cap.a, cap.b, hc1, hc2) > reach) continue;
      // Walk the segment to find where contact starts (8 steps is ~4 cm at swing speed).
      let f = 1;
      for (let i = 0; i <= 8; i++) {
        hc1.lerpVectors(prev[k], cur[k], i / 8);
        if (hc1.distanceToSquared(onSegment(cap.a, cap.b, hc1, hc2)) <= reach) {
          f = i / 8;
          break;
        }
      }
      if (!best || f < best.f || (f === best.f && cap.loc < best.loc)) {
        hc1.lerpVectors(prev[k], cur[k], f);
        onSegment(cap.a, cap.b, hc1, hc2);
        // Contact point on the body's surface, toward the hammer.
        const d = hc1.distanceTo(hc2) || 1;
        best = { f, loc: cap.loc, k, part, point: hc2.clone().addScaledVector(hc1.sub(hc2), cap.r / d) };
      }
    }
  }
  return best;
}

/** Ticks into a release at which the swing is roughly straight ahead (for bots and tests). */
export function releaseCenterTick(atk: number): number {
  if (atk === A.Stab) return Math.round(ATTACKS[atk].release * 0.45);
  const from = atk === A.Overhead ? OVER_FROM : SLASH_FROM;
  const to = atk === A.Overhead ? OVER_TO : SLASH_TO;
  // Where the eased arc points straight ahead.
  return Math.round((Math.acos(1 - (2 * from) / (from - to)) / Math.PI) * ATTACKS[atk].release);
}

export const PARRY_TICKS = T.parry;

/** Squared distance between segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection 5.1.9). */
export function segSegDist2(
  p1: Vector3,
  q1: Vector3,
  p2: Vector3,
  q2: Vector3,
  c1: Vector3,
  c2: Vector3,
): number {
  const d1x = q1.x - p1.x,
    d1y = q1.y - p1.y,
    d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x,
    d2y = q2.y - p2.y,
    d2z = q2.z - p2.z;
  const rx = p1.x - p2.x,
    ry = p1.y - p2.y,
    rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s: number, t: number;
  if (a <= 1e-9 && e <= 1e-9) {
    s = t = 0;
  } else if (a <= 1e-9) {
    s = 0;
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-9) {
      t = 0;
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const bb = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - bb * bb;
      s = denom !== 0 ? Math.min(1, Math.max(0, (bb * f - c * e) / denom)) : 0;
      t = (bb * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (bb - c) / a));
      }
    }
  }
  c1.set(p1.x + d1x * s, p1.y + d1y * s, p1.z + d1z * s);
  c2.set(p2.x + d2x * t, p2.y + d2y * t, p2.z + d2z * t);
  return c1.distanceToSquared(c2);
}
