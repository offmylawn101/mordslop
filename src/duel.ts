/**
 * The fight itself: fighters stepped together at 60 Hz, and what happens when their weapons meet
 * each other or a body. This is the authoritative part (run it on your server, or locally for
 * single player); combat.ts, swing.ts and body.ts are the rules and the geometry it uses.
 *
 * What it does each tick, for every fighter:
 *  - steps look, combat and movement (movement.ts stepFighter, through your Mover);
 *  - tracks a released swing's weapon from tick to tick (swing.ts hammerWorld);
 *  - two swings meeting glance off each other, or clash if released together;
 *  - a swing sweeping a body: parried if the defender faces it with a parry up (stamina permitting:
 *    short of it, they're disarmed and the blow carries on), otherwise damage by where it lands and
 *    with which part of the weapon, ripostes harder and a long parry chain's riposte a kill;
 *  - kicks.
 * What it leaves to you: drawing, sound, the world's walls (your Mover), objects a swing smashes,
 * a disarmed or thrown weapon in flight (events tell you when), respawning, netcode.
 */
import { Vector3 } from 'three';
import { bodyCapsules, newBody, type BodyState, type Capsule } from './body';
import {
  A,
  ATTACKS,
  CLASH_PUSH,
  CLASH_TICKS,
  DUEL_SECS,
  EV,
  GLANCE,
  KICK,
  KILL_HEAL,
  RIP_KILLS,
  S,
  STAM,
  T,
  emptyInput,
  gain,
  kill,
  onBlock,
  onHurt,
  onKicked,
  onParried,
  onRebound,
  revive,
  ripPower,
  spend,
  swingCost,
  type Input,
} from './combat';
import { TICK_HZ } from './constants';
import { FlatMover, newPState, stepFighter, type Mover, type PState } from './movement';
import { bodyHit, CRUSHABLE, CRUSH_SPEED, eyeHeight, FP, HEAD_K, hammerPoints, hammerWorld, newBasis, newPose, parryCovers, POINT_RADIUS, poseOf, SHAFT_K, swingDamage, TP, viewBasis, type BodyHit } from './swing';

/** A released swing in flight: which attack, from which side, how far through it. */
interface Swing {
  atk: number;
  ang: number;
  dur: number;
  t: number;
  /** A riposte: the parry chain that opened it (ripPower), and its parries in a row (RIP_KILLS). */
  rip: number;
  ripK: number;
  glanced?: boolean;
}

export interface Fighter {
  id: number;
  st: PState;
  mover: Mover;
  /** Fighters on the same team (non-zero) don't hit each other. */
  team: number;
  /** Health they start and respawn with. */
  maxHp: number;
  /** The swing in flight, its weapon's points last tick, and who it has already hit. */
  swing: Swing | null;
  prev: Vector3[];
  hit: Set<number>;
  /** The parry exchange they're in: with whom, how many parries, since their last landed blow, in a row. */
  duel: { foe: number; n: number; since: number; streak: number; at: number };
}

export type DuelEvent =
  | { type: 'swing'; a: number; atk: number }
  | { type: 'release'; a: number; atk: number; ang: number }
  | { type: 'feint'; a: number }
  | { type: 'miss'; a: number }
  | { type: 'hit'; a: number; v: number; dmg: number; loc: number; part: number; point: Vector3; dir: Vector3; riposte: boolean }
  | { type: 'parry'; a: number; v: number; point: Vector3; chain: number }
  | { type: 'disarm'; a: number; v: number; point: Vector3; dir: Vector3; speed: number }
  | { type: 'glance'; a: number; v: number; point: Vector3 }
  | { type: 'clash'; a: number; v: number; point: Vector3 }
  | { type: 'kick'; a: number; v: number }
  | { type: 'throw'; a: number }
  | { type: 'pickup'; a: number }
  | { type: 'death'; v: number; by: number; how: 'headshot' | 'crushed' | 'riposte' | 'slash' | 'overhead' | 'stab' | 'kick' };

/** A swing can only hit what's within 60 degrees of where its swinger faces: a slash coming round from behind passes by someone at their side. */
const inView = (x: number, z: number, yaw: number, px: number, pz: number) => {
  const dx = px - x,
    dz = pz - z;
  const d = Math.hypot(dx, dz);
  return d < 0.3 || (-Math.sin(yaw) * dx - Math.cos(yaw) * dz) / d >= 0.5;
};

const basis = newBasis();
const pose = newPose();
const cur = hammerPoints();
const other = hammerPoints();
const dir = new Vector3();
const gp = new Vector3();
const gm = new Vector3();
const gn = new Vector3();

/** When in a tick (0..1) two weapons moving this tick (points pa to ca, pb to cb) first touch, or -1; the contact in gp, the two heads then in gm, gn. */
function meet(pa: Vector3[], ca: Vector3[], pb: Vector3[], cb: Vector3[]): number {
  for (let s = 1; s <= 8; s++) {
    const f = s / 8;
    for (let i = 0; i < ca.length; i++) {
      gm.lerpVectors(pa[i], ca[i], f);
      for (let j = 0; j < cb.length; j++) {
        gn.lerpVectors(pb[j], cb[j], f);
        const r = POINT_RADIUS[i] + POINT_RADIUS[j];
        if (gm.distanceToSquared(gn) >= r * r) continue;
        gp.addVectors(gm, gn).multiplyScalar(0.5);
        gm.lerpVectors(pa[HEAD_K], ca[HEAD_K], f);
        gn.lerpVectors(pb[HEAD_K], cb[HEAD_K], f);
        return f;
      }
    }
  }
  return -1;
}

const drawBasis = newBasis();
const drawPose = newPose();
/**
 * For drawing: the weapon's points (handle end first, head last: swing.ts HAMMER_PTS) as the fighter
 * holds it now, in any state. firstPerson: as its own player sees it (carried lower and closer).
 * Make out with hammerPoints().
 */
export function weaponPoints(st: PState, out: Vector3[], firstPerson = false): Vector3[] {
  const c = st.c;
  viewBasis(st.yaw, st.pitch, drawBasis);
  poseOf({ s: c.s, t: c.t, dur: c.dur, atk: c.atk, ang: c.ang, hitP: c.hitP, gl: c.gl }, c.t, drawPose, firstPerson ? FP : TP, st.pitch);
  hammerWorld(st.x, st.y, st.z, st.crouch, drawBasis, drawPose, out, c);
  return out;
}

/** Hold a swing up in what it's sunk into for n ticks (a body it killed: it carries on after). */
const bite = (f: Fighter, n: number) => {
  if (f.st.c.s === S.Release) f.st.c.hold = Math.min(5, f.st.c.hold + n);
};

export class Duel {
  readonly fighters = new Map<number, Fighter>();
  tick = 0;
  private nextId = 1;
  private events: DuelEvent[] = [];
  private posed: Capsule[] = newBody();

  /** A fighter at (x, z) facing yaw (0: looking along -z). Movement through `mover` (default: open flat ground at y 0). */
  add(opts: { x?: number; y?: number; z?: number; yaw?: number; hp?: number; team?: number; mover?: Mover } = {}): Fighter {
    const st = newPState();
    st.x = opts.x ?? 0;
    st.y = opts.y ?? 0;
    st.z = opts.z ?? 0;
    st.yaw = opts.yaw ?? 0;
    st.hp = opts.hp ?? 100;
    const f: Fighter = { id: this.nextId++, st, mover: opts.mover ?? new FlatMover(st.y), team: opts.team ?? 0, maxHp: st.hp, swing: null, prev: hammerPoints(), hit: new Set(), duel: { foe: -1, n: 0, since: 0, streak: 0, at: 0 } };
    this.fighters.set(f.id, f);
    return f;
  }

  remove(f: Fighter) {
    this.fighters.delete(f.id);
  }

  /** Back on their feet, full health and stamina, weapon in hand. */
  respawn(f: Fighter, x = f.st.x, z = f.st.z, yaw = f.st.yaw) {
    Object.assign(f.st, { x, z, yaw, vx: 0, vy: 0, vz: 0, knock: 0, hp: f.maxHp, alive: 1 });
    revive(f.st.c);
    f.swing = null;
  }

  /** Their weapon back in their hands (after a disarm or a throw: you decide when they've picked one up). */
  rearm(f: Fighter) {
    f.st.c.armed = 1;
  }

  /** One 60 Hz tick: each fighter's input (missing: standing still), and everything that happened. */
  step(inputs: ReadonlyMap<number, Input> = new Map()): DuelEvent[] {
    this.events = [];
    this.tick++;
    for (const f of this.fighters.values()) {
      const st = f.st;
      if (!st.alive) continue;
      const inp = inputs.get(f.id) ?? { ...emptyInput(), yaw: st.yaw, pitch: st.pitch };
      const held = st.c.hold > 0;
      const ev = stepFighter(st, inp, f.mover);
      if (ev & EV.Attack) this.events.push({ type: 'swing', a: f.id, atk: st.c.atk });
      if (ev & EV.Feint) this.events.push({ type: 'feint', a: f.id });
      if (ev & EV.Miss) this.events.push({ type: 'miss', a: f.id });
      if (ev & EV.Release) {
        const c = st.c;
        f.swing = { atk: c.atk, ang: c.ang, dur: c.dur, t: 0, rip: c.rip ? (c.ripN ?? 1) : 0, ripK: c.rip ? (c.ripK ?? 1) : 0 };
        f.hit.clear();
        this.weaponAt(f, f.prev, 0);
        this.events.push({ type: 'release', a: f.id, atk: c.atk, ang: c.ang });
      } else if (f.swing) {
        const s = st.c.s;
        if (s === S.Release || s === S.Recovery || s === S.Windup) f.swing.t += held ? 0 : 1;
        else f.swing = null;
      }
      if (ev & EV.Kick) this.kick(f);
      if (ev & EV.Thrown) this.events.push({ type: 'throw', a: f.id });
      if (ev & EV.Pickup) this.events.push({ type: 'pickup', a: f.id });
    }
    const swinging = [...this.fighters.values()].filter((f) => f.swing && f.st.alive);
    this.glances(swinging);
    for (const f of swinging) if (f.swing) this.sweep(f);
    return this.events;
  }

  /** The weapon's points (handle to head) for f's swing at tick t of it. */
  private weaponAt(f: Fighter, out: Vector3[], t = f.swing!.t) {
    const st = f.st,
      s = f.swing!;
    viewBasis(st.yaw, st.pitch, basis);
    poseOf({ s: S.Release, t, dur: s.dur, atk: s.atk, ang: s.ang, hitP: 0, gl: st.c.gl }, t, pose);
    hammerWorld(st.x, st.y, st.z, st.crouch, basis, pose, out, { s: S.Release, atk: s.atk, ang: s.ang });
  }

  private friendly(a: Fighter, b: Fighter) {
    return a.team !== 0 && a.team === b.team;
  }

  /** The body's capsules as it stands now (head, chest, pelvis, arms, legs). */
  capsules(f: Fighter): Capsule[] {
    const st = f.st,
      c = st.c;
    const h: BodyState = { x: st.x, y: st.y, z: st.z, yaw: st.yaw, pitch: st.pitch, crouch: st.crouch, armed: c.armed, s: c.s, t: c.t, dur: c.dur, atk: c.atk, ang: c.ang, hitP: c.hitP, gl: c.gl };
    return bodyCapsules(h, this.posed);
  }

  /**
   * Two swings whose weapons meet this tick glance off each other: the higher rides up, the lower
   * dips under, both carry on, and it costs each some stamina (once a swing). Released together,
   * to within CLASH_TICKS, they clash instead: both stop dead and they're pushed apart.
   */
  private glances(swinging: Fighter[]) {
    for (let i = 0; i < swinging.length; i++)
      for (let j = i + 1; j < swinging.length; j++) {
        const a = swinging[i],
          b = swinging[j];
        if (!a.swing || !b.swing || a.swing.glanced || b.swing.glanced || a.swing.t > a.swing.dur || b.swing.t > b.swing.dur || this.friendly(a, b)) continue;
        if (Math.hypot(a.st.x - b.st.x, a.st.z - b.st.z) > 4) continue;
        this.weaponAt(a, cur);
        this.weaponAt(b, other);
        const f = meet(a.prev, cur, b.prev, other);
        if (f < 0) continue;
        if (Math.abs(a.swing.t - b.swing.t) <= CLASH_TICKS) {
          const d = Math.hypot(a.st.x - b.st.x, a.st.z - b.st.z) || 1;
          for (const p of [a, b]) {
            onRebound(p.st.c, (p.swing!.t - 1 + f) / p.swing!.dur, T.clash);
            swingCost(p.st.c, STAM.clash);
            p.swing = null;
            const s = ((p === a ? 1 : -1) * CLASH_PUSH.speed) / d;
            p.st.vx = (a.st.x - b.st.x) * s;
            p.st.vz = (a.st.z - b.st.z) * s;
            p.st.knock = Math.max(p.st.knock, CLASH_PUSH.ticks);
          }
          this.events.push({ type: 'clash', a: a.id, v: b.id, point: gp.clone() });
          continue;
        }
        a.swing.glanced = b.swing.glanced = true;
        const [up, down] = gm.y >= gn.y ? [a, b] : [b, a];
        up.st.c.gl = GLANCE;
        down.st.c.gl = -GLANCE;
        for (const p of [a, b]) {
          bite(p, T.glance);
          swingCost(p.st.c, STAM.glance);
        }
        this.events.push({ type: 'glance', a: up.id, v: down.id, point: gp.clone() });
      }
  }

  /** f's weapon this tick: the bodies it sweeps through, nearest first, each met once a swing. */
  private sweep(f: Fighter) {
    const st = f.st,
      s = f.swing!;
    if (s.t > s.dur) {
      f.swing = null;
      return;
    }
    this.weaponAt(f, cur);
    dir.subVectors(cur[HEAD_K], f.prev[HEAD_K]);
    if (dir.lengthSq() < 1e-8) dir.set(-Math.sin(st.yaw), 0, -Math.cos(st.yaw));
    dir.normalize();
    const bodies: { v: Fighter; hit: BodyHit }[] = [];
    for (const v of this.fighters.values()) {
      if (v === f || !v.st.alive || f.hit.has(v.id) || this.friendly(f, v)) continue;
      const hit = bodyHit(f.prev, cur, this.capsules(v));
      if (hit && inView(st.x, st.z, st.yaw, hit.point.x, hit.point.z)) bodies.push({ v, hit: { ...hit, point: hit.point.clone() } });
    }
    bodies.sort((x, y) => x.hit.f - y.hit.f);
    for (const { v, hit } of bodies) {
      f.hit.add(v.id);
      if (this.resolve(f, v, hit, (s.t - 1 + hit.f) / s.dur)) return;
      // A killing blow carries on through the body, after a beat in it.
      bite(f, 2);
    }
    for (let k = 0; k < cur.length; k++) f.prev[k].copy(cur[k]);
  }

  /** Is v facing a's blow at point as a parry needs (swing.ts parryCovers)? */
  private facing(v: Fighter, a: Fighter, point: Vector3) {
    const at = (p: PState) => ({ x: p.x, y: p.y + eyeHeight(p.crouch), z: p.z });
    return parryCovers(v.st.yaw, v.st.pitch, at(v.st), at(a.st), point.x, point.z, true);
  }

  /** The parries between a and v in the exchange they're still in (0: none, or it's lapsed). */
  private chain(a: Fighter, v: Fighter) {
    return a.duel.foe === v.id && v.duel.foe === a.id && this.tick - a.duel.at <= DUEL_SECS * TICK_HZ ? a.duel.n : 0;
  }

  /** a's swing meets v's body at p (0..1 through the swing). True: the swing stops here. */
  private resolve(a: Fighter, v: Fighter, hit: BodyHit, p: number): boolean {
    const s = a.swing!,
      ac = a.st.c,
      dc = v.st.c;
    const { loc, k, point } = hit;
    const speed = cur[k].distanceTo(a.prev[k]) * TICK_HZ;
    if (dc.s === S.Parry && this.facing(v, a, point)) return this.block(a, v, point, p, s.atk, speed);
    // The steel to the head kills outright; the steel square on the chest at full speed caves it in
    // (as lethal as a head hit, not quite: the attack's head damage); a riposte after RIP_KILLS
    // parries in a row kills. Otherwise damage by where it lands and with which part (swing.ts).
    const smash = loc === 0 && k >= SHAFT_K;
    const crush = s.atk !== A.Stab && CRUSHABLE.has(hit.part) && k >= SHAFT_K && speed >= CRUSH_SPEED;
    const finisher = s.ripK >= RIP_KILLS;
    const dmg = smash || finisher ? Math.max(1000, v.st.hp * 2) : (crush ? ATTACKS[s.atk].head : swingDamage(s.atk, loc, k)) * ripPower(s.rip);
    v.st.hp -= dmg;
    // (The exchange's parries are spent: the next riposte counts from here.)
    if (a.duel.foe === v.id) {
      a.duel.since = a.duel.streak = 0;
      if (v.duel.foe === a.id) v.duel.streak = 0;
    }
    ac.hitAny = 1;
    // Hurt mid-attack: interrupted.
    if (onHurt(dc)) v.swing = null;
    gain(ac, STAM.hit);
    this.events.push({ type: 'hit', a: a.id, v: v.id, dmg, loc, part: hit.part, point: point.clone(), dir: dir.clone(), riposte: s.rip > 0 });
    if (v.st.hp <= 0) {
      this.die(v, a, smash ? 'headshot' : finisher ? 'riposte' : crush ? 'crushed' : s.atk === A.Stab ? 'stab' : s.atk === A.Overhead ? 'overhead' : 'slash');
      return false;
    }
    // It lands and stops in them: they reel back along the blow, the weapon rebounds (a hit-stop
    // weapon, held a beat in the body). A riposte that lands makes the next swing as quick.
    const hl = Math.hypot(dir.x, dir.z) || 1;
    v.st.vx += (dir.x / hl) * ATTACKS[s.atk].knock;
    v.st.vz += (dir.z / hl) * ATTACKS[s.atk].knock;
    v.st.knock = 10;
    onRebound(ac, p);
    if (s.rip) ac.follow = T.rebound + T.riposte;
    a.swing = null;
    return true;
  }

  /** v's parry stops a's swing; or, short of stamina, v's weapon is knocked away and the swing carries on (false). */
  private block(a: Fighter, v: Fighter, point: Vector3, p: number, atk: number, speed: number): boolean {
    const on = this.chain(a, v) > 0;
    const n = on ? a.duel.n + 1 : 1;
    const streak = (on ? a.duel.streak : 0) + 1;
    a.duel = { foe: v.id, n, since: (on ? a.duel.since : 0) + 1, streak, at: this.tick };
    v.duel = { foe: a.id, n, since: (on ? v.duel.since : 0) + 1, streak, at: this.tick };
    // (Whichever of them gets the riposte out of it carries the chain: ripostes quicker and harder down it.)
    a.st.c.ripN = v.st.c.ripN = n;
    a.st.c.ripK = v.st.c.ripK = streak;
    if (!onBlock(v.st.c, ATTACKS[atk].drain)) {
      // Parried on too little stamina: disarmed. The blow does no harm itself and the swinger gets the riposte.
      v.st.c.armed = 0;
      const ac = a.st.c;
      ac.hitAny = 1;
      ac.riposte = T.riposte;
      gain(ac, STAM.hit);
      this.events.push({ type: 'disarm', a: a.id, v: v.id, point: point.clone(), dir: dir.clone(), speed });
      return false;
    }
    onParried(a.st.c, p, n);
    // Knocked back half a step: still in reach of the riposte.
    a.st.vx -= -Math.sin(a.st.yaw) * 0.9;
    a.st.vz -= -Math.cos(a.st.yaw) * 0.9;
    a.st.knock = Math.max(a.st.knock, 12);
    a.swing = null;
    this.events.push({ type: 'parry', a: a.id, v: v.id, point: point.clone(), chain: n });
    return true;
  }

  /** A kick: the nearest in front, in reach, staggered and pushed back; nobody there, it costs stamina. */
  private kick(a: Fighter) {
    const st = a.st;
    const fx = -Math.sin(st.yaw),
      fz = -Math.cos(st.yaw);
    let target: Fighter | null = null;
    let best = KICK.range;
    for (const v of this.fighters.values()) {
      if (v === a || !v.st.alive || this.friendly(a, v)) continue;
      const dx = v.st.x - st.x,
        dz = v.st.z - st.z;
      const d = Math.hypot(dx, dz);
      if (d > best || Math.abs(v.st.y - st.y) > 1.2 || (dx * fx + dz * fz) / (d || 1) < Math.cos(KICK.cone)) continue;
      best = d;
      target = v;
    }
    if (!target) return spend(st.c, STAM.kickMiss);
    const v = target;
    onKicked(v.st.c);
    gain(st.c, STAM.kickHit);
    v.st.vx = fx * KICK.push;
    v.st.vz = fz * KICK.push;
    v.st.vy = Math.max(v.st.vy, 1.6);
    v.st.knock = 26;
    v.st.hp -= KICK.damage;
    this.events.push({ type: 'kick', a: a.id, v: v.id });
    if (v.st.hp <= 0) this.die(v, a, 'kick');
  }

  private die(v: Fighter, by: Fighter, how: Extract<DuelEvent, { type: 'death' }>['how']) {
    v.st.hp = 0;
    v.st.alive = 0;
    v.swing = null;
    kill(v.st.c);
    // A kill pays the killer health and stamina back.
    by.st.hp = Math.min(by.maxHp, by.st.hp + KILL_HEAL);
    gain(by.st.c, STAM.kill);
    this.events.push({ type: 'death', v: v.id, by: by.id, how });
  }
}
