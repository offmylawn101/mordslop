/**
 * Melee combat modeled on Mordhau's maul: every attack has a windup (feintable and morphable),
 * a release (the hammer is live) and a recovery. Parry is a short timed window that covers what
 * you are looking at, every blow in it (each paid for); a successful parry opens a riposte (faster
 * windup). No chambers. Hits during windup flinch;
 * hits during release trade.
 * The release swing is defined in view space, so turning while it is live drags or accelerates it.
 *
 * Pure and deterministic: the server runs it authoritatively, the client runs it to predict.
 */
import { DT } from './constants';

export const S = {
  Idle: 0,
  Windup: 1,
  Release: 2,
  Recovery: 3,
  Parry: 4,
  ParryRecover: 5,
  Parried: 6,
  Feint: 7,
  Flinch: 8,
  Stagger: 9,
  KickWindup: 10,
  KickRelease: 11,
  KickRecover: 12,
  Dead: 13,
  /** The hammer slammed into a body (or a wall) and is bouncing back off it. */
  Rebound: 14,
  /** Hammer raised overhead in both hands to throw it, */
  ThrowWindup: 15,
  /** brought over and let go of at the end, */
  Throw: 16,
  /** arms following through, empty. */
  ThrowRecover: 17,
  /** Hammer knocked out of their hands (onBlock): stunned and rooted to the spot. */
  Disarmed: 18,
  /** An emote (shared/emotes.ts, which one in atk): empty-handed, standing, till anything else. */
  Emote: 19,
} as const;

export const A = { Slash: 0, Overhead: 1, Stab: 2 } as const;

export interface AttackSpec {
  windup: number;
  /** Windup when chained straight out of a previous swing's release. */
  combo: number;
  release: number;
  recovery: number;
  head: number;
  torso: number;
  legs: number;
  /** Mordhau's stamina drain: what a parry of this costs, less the parrying weapon's negation. */
  drain: number;
  /** Stamina it costs to swing this and hit nothing. */
  miss: number;
  /** Knockback speed given to whoever it hits (m/s): Mordhau's Maul stat, 135 / 125 (cm/s, Unreal units). */
  knock: number;
  /** Damage the head does to objects: one swing takes out most of the office. */
  smash: number;
}

/**
 * Ticks at 60 Hz, Mordhau's Maul timings (wiki): strikes 725 ms windup, 825 ms combo windup,
 * 475 ms release, 700 ms recovery; the stab 650 / 925 / 350 ms.
 */
// Damage is Mordhau's Maul against no armour (office shirts): strikes 100 head (a kill), 85
// torso, 75 legs; the stab 49 / 40 / 35. Out of 100 health, with 25 back for a kill.
// Stamina goes by how much the blow carries: the stab is Mordhau's cheaper one; the overhead,
// which smashes hardest and is the one that goes through floors, costs a quarter more than a
// slash to whiff or have parried, and drains a parry harder (not Mordhau, which prices it as a
// strike).
export const ATTACKS: AttackSpec[] = [
  { windup: 44, combo: 50, release: 29, recovery: 42, head: 100, torso: 85, legs: 75, drain: 24, miss: 13, knock: 1.35, smash: 150 },
  { windup: 44, combo: 50, release: 29, recovery: 42, head: 100, torso: 85, legs: 75, drain: 30, miss: 16, knock: 1.35, smash: 180 },
  { windup: 39, combo: 56, release: 21, recovery: 42, head: 49, torso: 40, legs: 35, drain: 19, miss: 11, knock: 1.25, smash: 110 },
];
/**
 * Two hammers meeting mid-swing glance off each other: both swings carry on, one knocked up over the other and the other down under it, by this
 * much (Combat.gl, 100 = about 45 degrees), easing back onto their line by GLANCE_EASE a tick. Each
 * swinger pays STAM.glance.
 */
export const GLANCE = 60;
export const GLANCE_EASE = 3;
/**
 * Unless the timing is perfect, both released within this many ticks of each other: then they
 * clash. Both stop dead where they met (T.clash), it costs each STAM.clash, and the
 * shock of it blows the loose debris round them away (CLASH_BLAST: radius m, speed m/s at the middle).
 */
export const CLASH_TICKS = 2;
export const CLASH_BLAST = { radius: 4, speed: 9 };
/** And it pushes the two apart, each a couple of feet back: m/s, for this many ticks (about 0.7 m in all). */
export const CLASH_PUSH = { speed: 3.5, ticks: 15 };
/** Health a kill gives back (Mordhau). */
export const KILL_HEAL = 25;

export const T = {
  /**
   * Mordhau's parry: up for a third of a second. One that catches nothing leaves you open for half a
   * second (no parry, no swing) before you can try again, so spamming it gets you hit.
   */
  parry: 20,
  parryRecover: 30,
  /**
   * Being parried staggers you for a second and a quarter: no attacking, slowed. Like Mordhau, you
   * can parry the riposte, but only from two thirds of a second in; a parry pressed before then goes up as soon as it can.
   */
  parried: 75,
  parriedStun: 40,
  feint: 8,
  flinch: 14,
  stagger: 34,
  /** Disarmed: stunned as long as a parried swing is. */
  disarmed: 75,
  kickWindup: 10,
  kickRelease: 6,
  kickRecover: 22,
  riposte: 30,
  rebound: 24,
  /** Two hammers that meet mid-swing grind against each other this long before they slide off. */
  glance: 3,
  /** Two that meet dead on, both at the same point in their swing (a clash), stop there this long. */
  clash: 40,
  clank: 30,
  buffer: 9,
  /** A throw winds up and lets go slower than a swing, so you can see it coming. */
  throwWindup: 48,
  throw: 12,
  throwRecover: 24,
};

/**
 * Stamina, ported from Mordhau with the Maul's numbers (Mordhau wiki: Combat, Maul, Parrying).
 * 100 points. A swing that hits nothing costs the attack's miss cost (13, an overhead 16, a stab
 * 11), a feint 10, a morph 7, a jump 10, a kick that finds nobody 10. Landing a hit gives 10 back
 * and a kill 25; a landed kick gives 10 and takes 10 from whoever it lands on. A parry needs the
 * attack's drain (24 slashes, 30 overheads, 19 stabs) less the Maul's parry negation (13), and at
 * least STAM.disarm: made on less, it's knocked aside with the hammer and you're disarmed
 * (Game.disarm). Not Mordhau: a parry that holds costs nothing, and nor does the
 * riposte out of it, whatever it meets; stamina only starts coming back 1.5 s after you last swung,
 * parried, kicked, feinted or were knocked about (anything but standing or walking), or sprinted,
 * so a fight wears you down; an empty bar doesn't stop you swinging, it slows you, more the lower
 * it gets from half down, up to 1.75x as slow at zero; a swing that's parried costs its miss cost
 *; two swings
 * that glance off each other cost each swinger 10, and two that clash 30.
 */
// shortcut: regen is 7/s, Mordhau's own rate isn't published; measure it in-game to match.
export const STAM = { glance: 10, clash: 30, low: 50, max: 100, regen: 7, delay: 90, disarm: 20, feint: 10, morph: 7, jump: 10, kickMiss: 10, kickHit: 10, kicked: 10, hit: 10, kill: 25, negation: 13, sprint: 8 };

/** Turn caps (rad/s): heavy weapons can't be whipped around mid-swing. */
export const TURN = { windup: 9.4, release: 4.2, kick: 5.2, stagger: 3.5 };

export const KICK = { range: 1.75, cone: 0.8, damage: 8, push: 5.5, propDamage: 18 };

/** Input buttons. Attack/Parry/Feint/Kick are edges (set on the tick they were pressed). */
/** Use (E): throw the hammer, or pick one up when your hands are empty. */
export const B = { Jump: 1, Sprint: 2, Crouch: 4, Attack: 8, Parry: 16, Feint: 32, Kick: 64, Use: 128, Emote: 256 };

/** What stepCombat reports back. */
export const EV = { Attack: 1, Release: 2, Feint: 4, Morph: 8, Parry: 16, Kick: 32, Miss: 64, Thrown: 128, Pickup: 256, Emote: 512 };

export interface Input {
  /** Yours to use (input sequence numbers for netcode); the sim ignores them. */
  seq: number;
  viewTick: number;
  yaw: number;
  pitch: number;
  mx: number;
  mz: number;
  buttons: number;
  atk: number;
  /** Side a slash comes from, 0..255: 0 above, 64 right, 128 below, 192 left. */
  ang: number;
}

export const emptyInput = (): Input => ({ seq: 0, viewTick: 0, yaw: 0, pitch: 0, mx: 0, mz: 0, buttons: 0, atk: 0, ang: 64 });

export interface Combat {
  s: number;
  t: number;
  dur: number;
  atk: number;
  ang: number;
  riposte: number;
  combo: number;
  cAtk: number;
  cAng: number;
  morphed: number;
  stam: number;
  stamDelay: number;
  swing: number;
  /** The release has landed on someone, been parried or smashed through the office: it isn't a miss. */
  hitAny: number;
  bKind: number;
  bAtk: number;
  bAng: number;
  bTtl: number;
  /** Release progress (0..255) where the hammer struck, for the rebound pose. */
  hitP: number;
  /** Ticks the swing is held up, biting into something it's smashing through (the clock stops). */
  hold: number;
  /** Holding a hammer (1), or empty-handed after throwing it (0): no attacking, parrying or kicking. */
  armed: number;
  /** Knocked off its line by another hammer (a glance): up (+) or down (-), easing back to 0. */
  gl: number;
  /** Server only (upgrades): how long swings take (1: as usual) and how fast stamina comes back. */
  tempo?: number;
  stamRegen?: number;
  /** Server only: rage: landing hits, parries and kills fill it, swings quicker the fuller (Game.rage). */
  rage?: number;
  /** Server only: this windup is a riposte (its blow carries the parry chain: Game.resolveHit). */
  rip?: number;
  /** Server only: how long the parry chain was that opened the riposte (Game.block). */
  ripN?: number;
  /** Server only: and how many of those parries in a row (no blow landed between): RIP_KILLS and it kills. */
  ripK?: number;
  /** Server only: ticks left in which a swing winds up as fast as a riposte, a person's riposte having landed without killing. */
  follow?: number;
  /** The side the last slash came from, and ticks left in which the next comes back from the other (SWING_BACK; a feint ends it). */
  back?: number;
  backT?: number;
}

export const newCombat = (): Combat => ({
  s: S.Idle,
  t: 0,
  dur: 0,
  atk: 0,
  ang: 64,
  riposte: 0,
  combo: 0,
  cAtk: 0,
  cAng: 64,
  morphed: 0,
  stam: STAM.max,
  stamDelay: 0,
  swing: 0,
  hitAny: 0,
  bKind: 0,
  bAtk: 0,
  bAng: 64,
  bTtl: 0,
  hitP: 0,
  hold: 0,
  gl: 0,
  armed: 1,
});

const BUF_ATTACK = 1;
const BUF_PARRY = 2;
const BUF_KICK = 3;
const BUF_THROW = 4;

function enter(c: Combat, s: number, dur: number) {
  c.s = s;
  c.t = 0;
  c.dur = dur;
  c.hold = 0;
}

export function spend(c: Combat, n: number) {
  c.stam = Math.max(0, c.stam - n);
  c.stamDelay = STAM.delay;
}

/** What a swing costs that didn't land (a miss, parried, glanced, clashed): nothing for a riposte. */
export function swingCost(c: Combat, n: number) {
  if (!c.rip) spend(c, n);
}

/** Stamina back (a hit, a kill, a landed kick): doesn't hold up regen. */
export function gain(c: Combat, n: number) {
  c.stam = Math.min(STAM.max, c.stam + n);
}

/** A jump's cost: it keeps regen from starting, but doesn't stop it once it has. */
export function spendJump(c: Combat) {
  c.stam = Math.max(0, c.stam - STAM.jump);
  if (c.stamDelay > 0) c.stamDelay = STAM.delay;
}

/** How much slower a tired fighter swings: from full speed at STAM.low down to 1.75x as slow at zero. */
const tired = (c: Combat) => 1 + 0.75 * Math.max(0, 1 - c.stam / STAM.low);
/** Swings this much quicker at full rage. */
export const RAGE_FAST = 0.3;
/** How long a swing's states take, all told: tired slower, upgrades and rage quicker. */
const pace = (c: Combat) => tired(c) * (c.tempo ?? 1) * (1 - RAGE_FAST * (c.rage ?? 0));

/**
 * A combo's windup carries the swing it flows on from (in hitP, as 1 + attack * 64 + angle / 4),
 * so it starts where that one finished, the way Mordhau chains read as one continuous swing.
 */
export const comboCode = (atk: number, ang: number) => 1 + atk * 64 + (ang >> 2);
/** A riposte's windup carries this instead: it rolls out of the guard (swing.ts rolled). */
export const ROLL = 255;
/** A follow-up's (a person's riposte having landed): it rolls the same, out of rest, where the hammer's back to by then. */
export const FOLLOW = 254;
/** A windup flowing on from the last swing (a combo: comboCode), not a roll. */
export const isCombo = (hitP: number) => hitP > 0 && hitP < FOLLOW;
export const comboAtk = (code: number) => (code - 1) >> 6;
export const comboAng = (code: number) => ((code - 1) & 63) << 2;

/** How long after a slash the next still swings back from where it ended (ticks at rest or busy with anything but the swing itself). */
export const SWING_BACK = 150;

/** Which side a swing at this angle comes from (1, -1), or 0: straight down or up. */
const sideOf = (ang: number) => (ang & 127 ? (ang < 128 ? 1 : -1) : 0);

function startAttack(c: Combat, atk: number, ang: number, riposte: boolean, combo = false): number {
  const from = combo ? comboCode(c.atk, c.ang) : 0;
  // A slash soon after another goes back from the other side, as a hammer swings: left to right,
  // then right to left. A combo's, a quick follow-up, or the swing back after they've parried and
  // had theirs. At the height it's aimed: aimed from the side it last came from, the same aim from the other side.
  if (atk === A.Slash && c.backT) {
    const other = (256 - c.back!) & 255;
    ang = !sideOf(ang) ? other : sideOf(ang) === sideOf(other) ? ang : (256 - ang) & 255;
  }
  // A riposte winds up faster. A stab's own windup is quick enough that, swung the moment the parry
  // caught one, it lands just as the one it's on can parry again (T.parriedStun): any sooner and it's
  // a free hit. So it only gets as quick as lands no sooner than that, the strikes' pace once a third
  // of a second's gone by. One chained on from a swing that disarmed
  // someone is a riposte too, at a riposte's pace.
  const w = ATTACKS[atk].windup;
  const rip = atk === A.Stab ? Math.max(w * 0.6, w - (T.riposte - c.riposte)) : w * 0.6;
  // (A riposte's windup as its chain has it, rage or not: each is tuned to be just parryable.)
  enter(c, S.Windup, Math.round((combo && !riposte ? ATTACKS[atk].combo : riposte ? rip * ripPace(c.ripN ?? 1) : c.follow ? w * 0.6 : w) * (riposte ? tired(c) * (c.tempo ?? 1) : pace(c))));
  c.rip = riposte ? 1 : 0;
  c.hitP = from || (riposte ? ROLL : c.follow ? FOLLOW : 0);
  c.atk = atk;
  c.ang = atk === A.Overhead ? 0 : ang;
  c.back = c.ang;
  c.backT = atk === A.Slash ? SWING_BACK : 0;
  c.morphed = 0;
  c.combo = 0;
  c.riposte = 0;
  c.follow = 0;
  c.hitAny = 0;
  c.swing = (c.swing + 1) & 255;
  return EV.Attack;
}

function startParry(c: Combat): number {
  enter(c, S.Parry, T.parry);
  c.combo = 0;
  // Parrying again gives up a riposte still open (a parry ends easy only if it catches something itself).
  c.riposte = 0;
  c.follow = 0;
  return EV.Parry;
}

export function stepCombat(c: Combat, inp: Input): number {
  if (c.s === S.Dead) return 0;
  let ev = 0;
  // Empty-handed: nothing to swing or block with, but you can still kick.
  const b = c.armed ? inp.buttons : inp.buttons & ~(B.Attack | B.Parry | B.Feint);
  // Fighting (anything but standing or walking) and sprinting hold regen off; it picks up the
  // usual delay after you stop.
  if ((c.s !== S.Idle && c.s !== S.Flinch) || (b & B.Sprint && (inp.mx !== 0 || inp.mz !== 0))) c.stamDelay = STAM.delay;
  else if (c.stamDelay > 0) c.stamDelay--;
  else c.stam = Math.min(STAM.max, c.stam + STAM.regen * (c.stamRegen ?? 1) * DT);
  // (A disarming swing's riposte waits for the swing to be over: Release case.)
  if (c.riposte > 0 && c.s !== S.Release) c.riposte--;
  if (c.follow) c.follow--;

  // An emote's over the moment they do anything else: move, jump, crouch (or press anything, below).
  if (c.s === S.Emote && (Math.abs(inp.mx) + Math.abs(inp.mz) > 0.2 || inp.buttons & (B.Jump | B.Crouch))) enter(c, S.Idle, 0);

  if (b & B.Attack) {
    c.bKind = BUF_ATTACK;
    c.bAtk = inp.atk;
    c.bAng = inp.ang;
    c.bTtl = T.buffer;
  } else if (b & B.Parry) {
    c.bKind = BUF_PARRY;
    c.bTtl = T.buffer;
  } else if (b & B.Kick) {
    c.bKind = BUF_KICK;
    c.bTtl = T.buffer;
  } else if (b & B.Use) {
    // E throws the hammer you're holding, or (empty-handed) asks to pick one up.
    if (c.armed) {
      c.bKind = BUF_THROW;
      c.bTtl = T.buffer;
    } else if (c.s !== S.Disarmed) ev |= EV.Pickup;
  } else if (b & B.Emote) ev |= EV.Emote;

  if (c.hold > 0) c.hold--;
  else if (c.t < 60000) c.t++;
  if (c.backT && c.s !== S.Windup && c.s !== S.Release) c.backT--;
  if (c.gl) c.gl -= Math.sign(c.gl) * Math.min(Math.abs(c.gl), GLANCE_EASE);
  switch (c.s) {
    case S.Windup:
      if (b & B.Feint || c.bKind === BUF_PARRY) {
        // Q feints; parrying mid-windup feints straight into a parry. Not in the last 50 ms.
        if (c.t < c.dur - 3) {
          spend(c, STAM.feint);
          ev |= EV.Feint;
          c.backT = 0;
          c.hitP = Math.round(Math.min(1, c.t / c.dur) * 255);
          if (c.bKind === BUF_PARRY) {
            c.bKind = 0;
            ev |= startParry(c);
          } else enter(c, S.Feint, T.feint);
          break;
        }
      }
      if (c.bKind === BUF_ATTACK && c.bAtk !== c.atk && !c.morphed && c.t < c.dur * 0.6) {
        c.atk = c.bAtk;
        c.ang = c.atk === A.Overhead ? 0 : c.bAng;
        c.morphed = 1;
        // Never sooner than the new one asked for outright (a combo's, if it's one): a morph hides
        // what's coming, it doesn't speed it up (into a stab, it would have).
        const k = pace(c);
        c.dur = Math.max(c.t + Math.round(ATTACKS[c.atk].windup * 0.75 * k), Math.round((isCombo(c.hitP) ? ATTACKS[c.atk].combo : ATTACKS[c.atk].windup) * k));
        c.bKind = 0;
        spend(c, STAM.morph);
        ev |= EV.Morph;
      }
      if (c.t >= c.dur) {
        enter(c, S.Release, Math.round(ATTACKS[c.atk].release * pace(c)));
        c.hitAny = 0;
        ev |= EV.Release;
      }
      break;
    case S.Release:
      if (c.bKind === BUF_ATTACK) {
        c.combo = 1;
        c.cAtk = c.bAtk;
        c.cAng = c.bAng;
        c.bKind = 0;
      }
      if (c.t >= c.dur) {
        if (!c.hitAny) {
          swingCost(c, ATTACKS[c.atk].miss);
          ev |= EV.Miss;
        }
        // A swing that disarmed someone opened a riposte (Game.disarm; nothing else does mid-swing):
        // chained on, or from standing, with no recovery to sit out first.
        if (c.combo) ev |= startAttack(c, c.cAtk, c.cAng, c.riposte > 0, true);
        else if (c.riposte > 0) enter(c, S.Idle, 0);
        else enter(c, S.Recovery, Math.round(ATTACKS[c.atk].recovery * pace(c)));
      }
      break;
    case S.Recovery:
      if (c.bKind === BUF_PARRY && c.t >= c.dur * 0.4) {
        c.bKind = 0;
        ev |= startParry(c);
      } else if (c.t >= c.dur) enter(c, S.Idle, 0);
      break;
    case S.Rebound:
      // Stopped on impact, and like Mordhau's Maul it can't combo out of a hit: parry, or wait.
      if (c.bKind === BUF_PARRY && c.t >= 6) {
        c.bKind = 0;
        ev |= startParry(c);
      } else if (c.t >= c.dur) enter(c, S.Idle, 0);
      break;
    case S.Parry:
      // One parry takes every blow in its window, each paid for. Once it's
      // caught one, swinging out of it is the riposte, and it ends in nothing worse than standing:
      // only a parry that caught nothing leaves you open.
      if (c.riposte > 0 && c.bKind === BUF_ATTACK) {
        c.bKind = 0;
        ev |= startAttack(c, c.bAtk, c.bAng, true);
      } else if (c.t >= c.dur) {
        if (c.riposte > 0) enter(c, S.Idle, 0);
        else enter(c, S.ParryRecover, T.parryRecover);
      }
      break;
    case S.Parried: {
      // Parried, a parry goes up the moment it's pressed, and stays up till the riposte could land
      // (T.parriedStun in) and its usual window after.
      // (A stun cut short by a parry chain: that much sooner, onParried.)
      const stunLeft = Math.max(0, Math.ceil((T.parriedStun * c.dur) / T.parried - c.t));
      if (c.bKind === BUF_PARRY) {
        c.bKind = 0;
        ev |= startParry(c);
        c.dur = T.parry + stunLeft;
      } else if (c.t >= c.dur) enter(c, S.Idle, 0);
      break;
    }
    case S.Feint:
      if (c.bKind === BUF_PARRY) {
        c.bKind = 0;
        ev |= startParry(c);
      } else if (c.t >= c.dur) enter(c, S.Idle, 0);
      break;
    case S.Flinch:
      if (c.bKind === BUF_PARRY && c.t >= 6) {
        c.bKind = 0;
        ev |= startParry(c);
      } else if (c.t >= c.dur) enter(c, S.Idle, 0);
      break;
    case S.KickWindup:
      if (c.t >= c.dur) {
        enter(c, S.KickRelease, T.kickRelease);
        ev |= EV.Kick;
      }
      break;
    case S.KickRelease:
      if (c.t >= c.dur) enter(c, S.KickRecover, T.kickRecover);
      break;
    case S.ThrowWindup:
      if (c.t >= c.dur) enter(c, S.Throw, T.throw);
      break;
    case S.Throw:
      if (c.t >= c.dur) {
        // Let go: the server turns it into a hammer in flight.
        c.armed = 0;
        ev |= EV.Thrown;
        enter(c, S.ThrowRecover, T.throwRecover);
      }
      break;
    case S.ParryRecover:
    case S.Stagger:
    case S.Disarmed:
    case S.KickRecover:
    case S.ThrowRecover:
      if (c.t >= c.dur) enter(c, S.Idle, 0);
      break;
    case S.Emote:
      // Run its course, or cut short by a swing, a parry or a kick asked for (it goes at once, below).
      if (c.t >= c.dur || c.bKind) enter(c, S.Idle, 0);
      break;
  }

  if (c.s === S.Idle && c.bKind) {
    if (c.bKind === BUF_ATTACK) ev |= startAttack(c, c.bAtk, c.bAng, c.riposte > 0);
    else if (c.bKind === BUF_PARRY) ev |= startParry(c);
    else if (c.bKind === BUF_THROW) {
      // Up overhead in both hands, like an overhead (so a hit mid-windup flinches it the same way).
      enter(c, S.ThrowWindup, Math.round(T.throwWindup * tired(c)));
      c.atk = A.Overhead;
      c.ang = 0;
      c.hitP = 0;
      c.combo = 0;
      c.swing = (c.swing + 1) & 255;
    } else enter(c, S.KickWindup, T.kickWindup);
    c.bKind = 0;
  }
  if (c.bKind && --c.bTtl <= 0) c.bKind = 0;
  return ev;
}

/**
 * A parry chain n long: each parry in it after the first makes the riposte out of it
 * RIP_FASTER quicker to wind up, to RIP_FASTEST, and RIP_HARDER harder. The stun it answers is as
 * much shorter (onParried), so it never lands before they can parry it: the rally just quickens
 * (a slash's lands a tick after they can, at any pace). After RIP_KILLS parries in a row (no blow
 * landed between them), the riposte that lands kills (Game.resolveHit).
 */
//
export const RIP_FASTER = 0.1;
export const RIP_FASTEST = 0.5;
export const RIP_HARDER = 0.2;
export const RIP_KILLS = 3;
/** Two still in a fight: a parry between them within this long (s) of the last (Game.chain; the hammer's heat, main.ts). */
export const DUEL_SECS = 3;
export const ripPace = (n: number) => Math.max(RIP_FASTEST, 1 - RIP_FASTER * Math.max(0, n - 1));
export const ripPower = (n: number) => 1 + RIP_HARDER * Math.max(0, n - 1);

/** The stamina it takes to parry an attack with this drain (every weapon here is a Maul): less, and it disarms you. */
export const parryCost = (drain: number) => Math.max(0, drain - STAM.negation);

/**
 * Defender parried in time, which costs nothing. Returns false when they hadn't the stamina
 * for it: the blow knocks the hammer out of their hands (Game.disarm) and staggers them, a boss's too.
 */
export function onBlock(def: Combat, drain: number): boolean {
  if (def.stam < STAM.disarm || def.stam < parryCost(drain)) {
    def.stam = 0;
    def.stamDelay = STAM.delay;
    enter(def, S.Disarmed, T.disarmed);
    return false;
  }
  // A parry stays up for the rest of its window (the next blow in it is parried too); a VR guard
  // (no parry state) stands down.
  if (def.s !== S.Parry) enter(def, S.Idle, 0);
  def.riposte = T.riposte;
  return true;
}

/**
 * The attack was parried at release progress p, the parry chain now n long (its stun as much
 * shorter as the riposte it answers: ripPace). It found nobody, so it costs what a miss does (and
 * nothing comes back while stunned).
 */
export function onParried(att: Combat, p: number, n = 1) {
  swingCost(att, ATTACKS[att.atk].miss);
  enter(att, S.Parried, Math.round(T.parried * ripPace(n)));
  att.hitP = Math.max(0, Math.min(255, Math.round(p * 255)));
  att.combo = 0;
  att.hitAny = 1;
}

/**
 * Took a hit: any swing's stopped: a windup (attack, kick or throw) flinches, a swing already coming is knocked
 * back where it was. True if a swing on its way was stopped (Game: it hits nothing more).
 */
export function onHurt(c: Combat): boolean {
  if (c.s === S.Emote) enter(c, S.Idle, 0);
  if (c.s === S.Release) {
    onRebound(c, Math.min(1, c.t / Math.max(1, c.dur)), T.flinch);
    return true;
  }
  if (c.s === S.Windup || c.s === S.KickWindup || c.s === S.ThrowWindup) {
    c.hitP = c.s !== S.KickWindup ? Math.round(Math.min(1, c.t / Math.max(1, c.dur)) * 255) : 0;
    enter(c, S.Flinch, T.flinch);
    c.combo = 0;
  }
  return false;
}

/** Into emote k (shared/emotes.ts) for secs seconds. */
export function startEmote(c: Combat, k: number, secs: number) {
  enter(c, S.Emote, Math.round(secs * 60));
  c.atk = k;
  c.ang = 0;
  c.combo = 0;
  c.bKind = 0;
}

/** Frozen solid (single player's Cold Call): held where they are, guard down, nothing waiting to go. */
export function onFrozen(c: Combat) {
  if (c.s === S.Parry || c.s === S.ParryRecover) enter(c, S.Idle, 0);
  c.bKind = 0;
  c.combo = 0;
}

export function onKicked(c: Combat) {
  // (A kick doesn't cut a disarmed stun short.)
  if (c.s !== S.Release && c.s !== S.Disarmed) enter(c, S.Stagger, T.stagger);
  c.combo = 0;
  spend(c, STAM.kicked);
}

/** The hammer stopped against a body at release progress p (0..1): it bounces back. */
export function onRebound(c: Combat, p: number, dur = T.rebound) {
  enter(c, S.Rebound, dur);
  c.hitP = Math.max(0, Math.min(255, Math.round(p * 255)));
  c.combo = 0;
  c.hitAny = 1;
}

/**
 * The hammer bounced off something it couldn't break: a longer rebound, no combo out of it. It
 * found nobody, so it costs what a miss does.
 */
/** Bounced off something that held: the building costs what a miss does; anything it dented doesn't (it hit something). */
export function onClank(c: Combat, p: number, atk: number, building = true) {
  onRebound(c, p, T.clank);
  c.bKind = 0;
  if (building) swingCost(c, ATTACKS[atk].miss);
}

export function kill(c: Combat) {
  enter(c, S.Dead, 0);
  c.bKind = 0;
}

export function revive(c: Combat) {
  Object.assign(c, newCombat(), { swing: c.swing, tempo: c.tempo, stamRegen: c.stamRegen });
}

export function turnCap(c: Combat): number {
  switch (c.s) {
    // Hoisting a throw is a windup, and letting go a release: just as hard to whip round.
    case S.Windup:
    case S.ThrowWindup:
      return TURN.windup;
    case S.Release:
    case S.Throw:
      return TURN.release;
    case S.KickWindup:
    case S.KickRelease:
      return TURN.kick;
    case S.Stagger:
    case S.Parried:
    case S.Disarmed:
      return TURN.stagger;
  }
  return Infinity;
}

export function speedScale(c: Combat): number {
  switch (c.s) {
    case S.Windup:
    case S.Release:
    case S.ThrowWindup:
    case S.Throw:
      return 0.62;
    case S.Recovery:
    case S.Flinch:
    case S.Rebound:
      return 0.8;
    case S.Parry:
    case S.ParryRecover:
      return 0.85;
    case S.Parried:
      return 0.55;
    case S.Stagger:
      return 0.35;
    case S.Disarmed:
      // Hammer knocked away: on your feet, slowly.
      return 0.5;
    case S.KickWindup:
    case S.KickRelease:
    case S.KickRecover:
      return 0.5;
  }
  return 1;
}

/**
 * Slash side from a mouse motion vector (screen x right, y up): the swing travels the way the mouse
 * moved. 0 (straight down, from above) is the overhead.
 */
export function angleFromMotion(dx: number, dy: number): number {
  // The swing comes from the opposite side of the motion. 0 = from above, clockwise.
  let a = Math.atan2(-dx, -dy);
  if (a < 0) a += Math.PI * 2;
  let q = Math.round((a / (Math.PI * 2)) * 8) % 8;
  // Pure upward motion: there's no swing from straight below, so pick the nearer lower diagonal.
  if (q === 4) q = dx >= 0 ? 5 : 3;
  return q * 32;
}
