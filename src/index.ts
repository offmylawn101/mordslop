/**
 * mordslop: first-person medieval melee for web games.
 *
 *   combat.ts    the rules: attack states and timings, parries, ripostes, feints, combos, stamina
 *   swing.ts     the weapon's path through every attack, and hit geometry (damage by where it lands)
 *   body.ts      the fighter's hit capsules, posed by what they're doing
 *   movement.ts  look and movement, through your engine's collision (a Mover)
 *   duel.ts      the authoritative fight: fighters stepped together, hits, parries, clashes, kicks
 *   controls.ts  (import 'mordslop/controls') mouse and keyboard to inputs, in a browser
 *   rapier.ts    (import 'mordslop/rapier') a Mover on Rapier's character controller
 */
export * from './constants';
export * from './combat';
export * from './swing';
export * from './body';
export * from './movement';
export * from './duel';
