/**
 * The rules, checked by staging fights: two fighters 1.75 m apart, face to face, and scripted
 * inputs tick by tick. Run: npm test
 */
import assert from 'node:assert/strict';
import { A, ATTACKS, B, CLASH_TICKS, Duel, emptyInput, RIP_KILLS, S, STAM, T, type DuelEvent, type Fighter, type Input } from '../src/index';

let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
}

/** a at x 0 facing +x, b at x 1.75 facing -x (yaw 0 looks along -z). */
function stage(gap = 1.75) {
  const d = new Duel();
  const a = d.add({ x: 0, z: 0, yaw: -Math.PI / 2 });
  const b = d.add({ x: gap, z: 0, yaw: Math.PI / 2 });
  return { d, a, b };
}

type Script = (t: number) => [Fighter, Partial<Input>][] | void;
/** Steps the duel `ticks` times; each fighter's input is "stand still, look where you look" plus the script's. */
function run(d: Duel, ticks: number, script: Script = () => {}): DuelEvent[] {
  const all: DuelEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    const given = new Map(script(t) ?? []);
    const inputs = new Map<number, Input>();
    for (const f of d.fighters.values()) inputs.set(f.id, { ...emptyInput(), yaw: f.st.yaw, pitch: f.st.pitch, ...(given.get(f) ?? {}) });
    all.push(...d.step(inputs));
  }
  return all;
}
const count = (ev: DuelEvent[], type: DuelEvent['type']) => ev.filter((e) => e.type === type).length;
const slash = { buttons: B.Attack, atk: A.Slash, ang: 64 };
const W = ATTACKS[A.Slash].windup;

test('an undefended slash lands, hurts without killing, and the weapon rebounds', () => {
  const { d, a, b } = stage();
  let rebound = false;
  const ev = run(d, 90, (t) => {
    if (a.st.c.s === S.Rebound) rebound = true;
    if (t === 0) return [[a, { ...slash, ang: 96 }]];
  });
  assert.equal(count(ev, 'hit'), 1);
  assert.ok(b.st.hp < 100 && b.st.alive, `hp ${b.st.hp}`);
  assert.ok(rebound, 'rebounds off the body');
});

test('a timed parry blocks; the attacker is staggered', () => {
  const { d, a, b } = stage();
  let stunned = 0;
  const ev = run(d, 140, (t) => {
    if (a.st.c.s === S.Parried) stunned++;
    if (t === 0) return [[a, slash]];
    if (t === W - 2) return [[b, { buttons: B.Parry }]];
  });
  assert.equal(b.st.hp, 100);
  assert.equal(count(ev, 'parry'), 1);
  assert.ok(stunned > 0, 'staggered');
});

test('a parry far too early has expired', () => {
  const { d, a, b } = stage();
  run(d, 90, (t) => (t === 0 ? [[a, slash]] : t === 4 ? [[b, { buttons: B.Parry }]] : undefined));
  assert.ok(b.st.hp < 100);
});

test('the riposte after a parry lands, and ends the parries in a row', () => {
  const { d, a, b } = stage(1.5);
  let open = false;
  run(d, 170, (t) => {
    if (b.st.c.riposte > 0 && !open) {
      open = true;
      return [[b, slash]];
    }
    if (t === 0) return [[a, slash]];
    if (t === W - 2) return [[b, { buttons: B.Parry }]];
  });
  assert.ok(open && a.st.hp < 100, `hp ${a.st.hp}`);
  assert.ok(a.duel.streak === 0 && b.duel.streak === 0);
});

test('a feint is reported and its blow never comes', () => {
  const { d, a, b } = stage();
  const ev = run(d, 90, (t) => (t === 0 ? [[a, slash]] : t === 10 ? [[a, { buttons: B.Feint }]] : undefined));
  assert.equal(count(ev, 'feint'), 1);
  assert.equal(count(ev, 'hit'), 0);
  assert.equal(b.st.hp, 100);
  assert.ok(a.st.c.stam <= 100 - STAM.feint + 1, `a feint costs stamina (${a.st.c.stam})`);
});

test('no chambers: a slash into a slash is just two swings', () => {
  const { d, a, b } = stage();
  const ev = run(d, 120, (t) => (t === 0 ? [[a, slash]] : t === W - 4 ? [[b, slash]] : undefined));
  assert.equal(count(ev, 'parry'), 0);
  assert.ok(b.st.hp < 100);
});

test('released together, two swings clash: both stop, neither lands, both pay', () => {
  const { d, a, b } = stage();
  let at = null as { s: number[]; stam: number[] } | null;
  const ev = run(d, 90, (t) => {
    if (!at && d.tick && a.st.c.s === S.Rebound && b.st.c.s === S.Rebound) at = { s: [a.st.c.s, b.st.c.s], stam: [a.st.c.stam, b.st.c.stam] };
    if (t === 0) return [[a, slash], [b, { ...slash, ang: 192 }]];
  });
  assert.equal(count(ev, 'clash'), 1);
  assert.ok(at && at.stam.every((x: number) => x <= 100 - STAM.clash), `both pay (${at?.stam})`);
  assert.ok(a.st.hp === 100 && b.st.hp === 100);
});

test('a few ticks apart, they glance off each other and carry on', () => {
  const { d, a, b } = stage();
  const ev = run(d, 90, (t) => (t === 0 ? [[a, slash]] : t === CLASH_TICKS + 1 ? [[b, { ...slash, ang: 192 }]] : undefined));
  assert.equal(count(ev, 'glance'), 1);
  assert.equal(count(ev, 'parry'), 0);
});

test('parried on too little stamina: disarmed, and the swinger gets the riposte', () => {
  const { d, a, b } = stage();
  b.st.c.stam = 5;
  const ev = run(d, 60, (t) => (t === 0 ? [[a, slash]] : t === W - 2 ? [[b, { buttons: B.Parry }]] : undefined));
  assert.equal(count(ev, 'disarm'), 1);
  assert.equal(b.st.c.armed, 0);
  assert.equal(count(ev, 'parry'), 0);
});

test('a kick staggers and pushes back', () => {
  const { d, a, b } = stage(1.2);
  const x0 = b.st.x;
  const ev = run(d, 30, (t) => (t === 0 ? [[a, { buttons: B.Kick }]] : undefined));
  assert.equal(count(ev, 'kick'), 1);
  assert.ok(b.st.x > x0 + 0.3, `pushed (${(b.st.x - x0).toFixed(2)} m)`);
});

test('the steel to the head kills outright', () => {
  const { d, a, b } = stage(1.6);
  const ev = run(d, 120, (t) => (t === 0 ? [[a, { buttons: B.Attack, atk: A.Overhead, ang: 0 }]] : undefined));
  const death = ev.find((e) => e.type === 'death');
  assert.ok(!b.st.alive && death, `dead (hp ${b.st.hp}, ${ev.map((e) => e.type).join(' ')})`);
  assert.ok(a.st.c.stam > 100 - ATTACKS[A.Overhead].miss, 'a kill pays stamina back');
});

test(`a riposte at the end of ${RIP_KILLS} parries in a row kills`, () => {
  const { d, a, b } = stage(1.5);
  // Back and forth: each parries the other's riposte, until the chain's long enough.
  let turn = a,
    other = b,
    swungAt = 0,
    parried = 0;
  const ev = run(d, 900, (t) => {
    if (!a.st.alive || !b.st.alive) return;
    if (t === 0) return [[a, slash]];
    const c = turn.st.c;
    // The one swinging is in windup: the other parries just before it lands.
    if (c.s === S.Windup && c.t === c.dur - 2 && parried < RIP_KILLS) {
      parried++;
      return [[other, { buttons: B.Parry }]];
    }
    // The parrier's riposte window is open: they swing, and the roles turn.
    if (other.st.c.riposte > 0 && other.st.c.s === S.Parry && t > swungAt + 2) {
      swungAt = t;
      [turn, other] = [other, turn];
      return [[turn, slash]];
    }
  });
  assert.ok(count(ev, 'parry') >= RIP_KILLS - 1, `${count(ev, 'parry')} parries`);
  assert.ok(ev.some((e) => e.type === 'death' && e.how === 'riposte'), `a riposte ends it (${ev.map((e) => (e.type === 'death' ? 'death:' + e.how : e.type)).join(' ')})`);
});

test('teammates never hit each other', () => {
  const d = new Duel();
  const a = d.add({ x: 0, yaw: -Math.PI / 2, team: 1 });
  const b = d.add({ x: 1.75, yaw: Math.PI / 2, team: 1 });
  run(d, 90, (t) => (t === 0 ? [[a, slash]] : undefined));
  assert.equal(b.st.hp, 100);
});

test('movement: forward is -z at yaw 0, sprint is faster and costs stamina', () => {
  const d = new Duel();
  const w = d.add({ yaw: 0 });
  const s = d.add({ x: 10, yaw: 0 });
  run(d, 60, () => [
    [w, { mz: 1 }],
    [s, { mz: 1, buttons: B.Sprint }],
  ]);
  assert.ok(w.st.z < -3 && Math.abs(w.st.x) < 1e-6, `walked to z ${w.st.z.toFixed(2)}`);
  assert.ok(s.st.z < w.st.z - 1 && s.st.c.stam < 100, `sprinted to ${s.st.z.toFixed(2)}, stamina ${s.st.c.stam.toFixed(1)}`);
});

test('mid-swing, looking round is capped (the weapon drags)', () => {
  const { d, a } = stage();
  run(d, 5, (t) => (t === 0 ? [[a, slash]] : [[a, { yaw: a.st.yaw + Math.PI }]]));
  assert.ok(Math.abs(a.st.yaw + Math.PI / 2) < 1, `turned only ${(a.st.yaw + Math.PI / 2).toFixed(2)} rad in 4 ticks`);
  void T;
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
