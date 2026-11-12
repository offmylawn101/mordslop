# mordslop

First-person medieval melee for web games, in TypeScript: directional swings, stabs and overheads,
parries, ripostes, feints, combos, stamina, disarms, kicks, weapons that glance off or clash with
each other, and per-limb hitboxes. The rules are the kind Mordhau-style melee games use: every
attack has a readable windup, a parry has to face the blow and be timed, and stamina decides who
runs out of options first.

It's the combat from [Open Floor Plan](https://smash.offmylawn.com), pulled out on its own.

- **Engine-agnostic.** The sim is plain TypeScript at a fixed 60 Hz and deterministic. It uses
  three.js only for its vector maths. Drawing, sound and your world's collision stay yours.
- **Authoritative.** `Duel` steps every fighter together and decides every hit, parry and clash:
  run it on a server for multiplayer, or in the page for single player.
- **Tested.** `npm test` stages fights tick by tick (parry timing, ripostes, clashes, disarms...).

## Try it

```sh
npm install
npm run demo     # you against a sparring partner, in the browser
npm test
```

## Use it

```ts
import { Duel, hammerPoints, turnCap, weaponPoints } from 'mordslop';
import { Controls } from 'mordslop/controls';

const duel = new Duel();
const me = duel.add({ x: 0, z: 0, yaw: 0 });          // yaw 0 looks along -z
const them = duel.add({ x: 0, z: -3, yaw: Math.PI });
const controls = new Controls(canvas);                   // mouse, wheel, keys

// 60 times a second:
const events = duel.step(new Map([
  [me.id, controls.sample()],
  [them.id, yourAiOrNetworkInput()],
]));
for (const e of events) {
  // 'hit' | 'parry' | 'disarm' | 'clash' | 'glance' | 'kick' | 'feint' | 'miss' | 'death' | ...
  // play a sound, spawn sparks, update a scoreboard
}

// Every frame, to draw:
controls.frame(dt, turnCap(me.st.c));                    // look, capped mid-swing
const pts = weaponPoints(them.st, hammerPoints());       // the weapon: handle (0..5), head (6..8)
const capsules = duel.capsules(them);                    // the body: head, chest, pelvis, arms, legs
```

`me.st` has everything about a fighter: position, look, health, and `me.st.c`, its combat state
(`S.Windup`, `S.Release`, `S.Parry`, ...), stamina and timers.

### Your world

Fighters move through a `Mover`. The default, `FlatMover`, is open flat ground. For walls and
steps, use Rapier's character controller:

```ts
import RAPIER from '@dimforge/rapier3d-compat';
import { RapierMover } from 'mordslop/rapier';
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
// ...your level's colliders...
duel.add({ mover: new RapierMover(RAPIER, world) });
```

Or implement `Mover` on your own engine's collision: one `move(state, dx, dy, dz)` method.

### What's yours to do

- **Drawing and animation.** `weaponPoints` and `capsules` tell you where the weapon and the body
  are; how they look is up to you.
- **What happens on a disarm or a throw.** `Duel` reports it. You put a weapon in the world and call
  `duel.rearm(fighter)` when it's picked up.
- **Swings hitting the world.** The sweep only checks bodies. To have walls stop a swing, cast
  `weaponPoints` against your level.
- **Netcode.** `Input` is small and the sim is deterministic: send inputs, run `Duel` on the server.

## How the fight works

| | |
|---|---|
| **Attacks** | Slash (any side: `ang` 0..255, 0 above, 64 right, 192 left), overhead, stab. Each has a windup (0.73 s for the slash), a release that sweeps, and a recovery. |
| **Feint / morph** | Back out of a windup (Q) for a little stamina, or switch to another attack mid-windup. |
| **Combo** | Attack again during your release: the next swing flows on from where this one ends, with a slightly longer windup. Not out of a hit. |
| **Parry** | Up for a third of a second; it has to face the blow. Missing it leaves you open for half a second. |
| **Riposte** | A parry opens a quicker swing. Parries back and forth make each riposte quicker and harder, and one after three in a row kills. |
| **Stamina** | Whiffs, feints and taking blows on a parry drain it; landing hits pays it back. Parry on too little and you're disarmed. |
| **Damage** | By where it lands (head, torso, legs) and with what (the steel or the handle). The steel to the head kills; a full-speed blow to the chest caves it in. |
| **Clash / glance** | Two swings meeting glance off each other; released at the same moment, they clash and both stop. |
| **Kick** | Staggers and pushes back whoever is in front. |

Every number is in `combat.ts` (`ATTACKS`, `T`, `STAM`, `KICK`) to tune.

## Files

| | |
|---|---|
| `src/combat.ts` | The rules: states, timings, stamina, parry and riposte logic |
| `src/swing.ts` | The weapon's path through every attack, and hit geometry |
| `src/body.ts` | The fighter's hit capsules, posed by what they're doing |
| `src/movement.ts` | Look and movement through a `Mover` |
| `src/duel.ts` | The authoritative fight |
| `src/controls.ts` | Browser mouse, wheel, trackpad and keyboard controls |
| `src/rapier.ts` | A `Mover` on Rapier |
| `demo/` | A playable demo |
| `test/` | The rules, checked |

## Licence

MIT. Mordhau is a trademark of its owners; this project isn't affiliated with or endorsed by them.
