/**
 * The demo: you against a sparring partner, on open ground. Everything fight-related comes from
 * the library; this file is only drawing, a fixed 60 Hz loop and a very simple opponent.
 */
import * as THREE from 'three';
import { A, B, Duel, emptyInput, eyeHeight, hammerPoints, S, STAM, TICK_HZ, turnCap, weaponPoints, type Capsule, type DuelEvent, type Fighter, type Input } from '../src/index';
import { Controls } from '../src/controls';

// ---------------------------------------------------------------- the scene
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1d22);
scene.fog = new THREE.Fog(0x1b1d22, 12, 40);
const camera = new THREE.PerspectiveCamera(85, 1, 0.05, 100);
scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x30302a, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(4, 8, 3);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x3a3f36, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
scene.add(new THREE.GridHelper(80, 80, 0x555a50, 0x464b42));
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- the fight
const duel = new Duel();
const me = duel.add({ x: 0, z: 0, yaw: 0 });
const foe = duel.add({ x: 0, z: -3, yaw: Math.PI });
const controls = new Controls(renderer.domElement);
controls.enabled = false;
const start = document.getElementById('start')!;
start.onclick = () => {
  start.hidden = true;
  controls.enabled = true;
  controls.lock();
};
controls.onUnlock = () => {
  controls.enabled = false;
  start.hidden = false;
};

/** The sparring partner: closes in, swings now and then from a random side, parries some of your blows a little late or early, ripostes when it can. */
const ai = { nextSwing: 90, parryAt: -1 };
function foeInput(): Input {
  const st = foe.st,
    you = me.st;
  const dx = you.x - st.x,
    dz = you.z - st.z;
  const d = Math.hypot(dx, dz);
  const inp: Input = { ...emptyInput(), yaw: Math.atan2(-dx, -dz), pitch: -0.05 };
  if (!you.alive) return inp;
  inp.mz = d > 2 ? 1 : d < 1.3 ? -0.6 : 0;
  // Your windup coming at it: maybe a parry, timed a few ticks either side of right.
  const c = you.c;
  if (c.s === S.Windup && d < 2.6 && ai.parryAt < 0 && c.t === 1) ai.parryAt = Math.random() < 0.55 ? duel.tick + (c.dur - c.t) - 3 + Math.round((Math.random() - 0.5) * 8) : -2;
  if (c.s !== S.Windup) ai.parryAt = -1;
  if (ai.parryAt >= 0 && duel.tick >= ai.parryAt) {
    ai.parryAt = -2;
    inp.buttons |= B.Parry;
    return inp;
  }
  // A riposte, the moment it's open; otherwise a swing every second or two, in reach.
  const ready = st.c.s === S.Idle || (st.c.s === S.Parry && st.c.riposte > 0);
  if (ready && d < 2.3 && (st.c.riposte > 0 || duel.tick >= ai.nextSwing)) {
    ai.nextSwing = duel.tick + 60 + Math.floor(Math.random() * 90);
    const r = Math.random();
    inp.buttons |= B.Attack;
    inp.atk = r < 0.2 ? A.Overhead : r < 0.4 ? A.Stab : A.Slash;
    inp.ang = inp.atk === A.Slash ? [32, 64, 96, 160, 192, 224][Math.floor(Math.random() * 6)] : 0;
  }
  return inp;
}

const log = document.getElementById('log')!;
const lines: string[] = [];
const NAMES = new Map([
  [me.id, 'You'],
  [foe.id, 'They'],
]);
function say(e: DuelEvent) {
  const n = (id: number) => NAMES.get(id) ?? '?';
  const t =
    e.type === 'hit' ? `${n(e.a)} hit ${n(e.v) === 'You' ? 'you' : 'them'} for ${Math.round(Math.min(e.dmg, 999))}${e.riposte ? ' (riposte)' : ''}` :
    e.type === 'parry' ? `${n(e.v)} parried${e.chain > 1 ? ` (${e.chain} in a row)` : ''}` :
    e.type === 'disarm' ? `${n(e.v)} parried on no stamina: disarmed` :
    e.type === 'clash' ? 'Clash!' :
    e.type === 'glance' ? 'The weapons glance off each other' :
    e.type === 'kick' ? `${n(e.a)} kicked` :
    e.type === 'feint' ? `${n(e.a)} feinted` :
    e.type === 'death' ? `${n(e.v)} ${n(e.v) === 'You' ? 'were' : 'was'} killed (${e.how})` : '';
  if (!t) return;
  lines.unshift(t);
  lines.length = Math.min(lines.length, 6);
  log.innerHTML = lines.join('<br>');
}

/** Down: back up two seconds later, a few metres apart. */
const downAt = new Map<Fighter, number>();
function respawns() {
  for (const f of [me, foe]) {
    if (f.st.alive) continue;
    if (!downAt.has(f)) downAt.set(f, duel.tick);
    else if (duel.tick - downAt.get(f)! > 2 * TICK_HZ) {
      downAt.delete(f);
      const o = f === me ? foe : me;
      duel.respawn(f, o.st.x, o.st.z + (f === me ? 3 : -3), f === me ? 0 : Math.PI);
      if (f === me) controls.yaw = 0;
    }
    // (A disarm's weapon: back in hand after a second and a half. Your game decides how it's picked up.)
  }
  for (const f of [me, foe]) if (!f.st.c.armed && duel.tick % 90 === 0) duel.rearm(f);
}

// ---------------------------------------------------------------- drawing
const steel = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.8, roughness: 0.35 });
const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.8 });
const skin = new THREE.MeshStandardMaterial({ color: 0xc08c6c, roughness: 0.9 });
const cloth = new THREE.MeshStandardMaterial({ color: 0x46607a, roughness: 0.9 });
/** A weapon: the handle and the head, as cylinders between its points. */
function makeWeapon() {
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1, 8), wood);
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 10), steel);
  scene.add(handle, head);
  return { handle, head, pts: hammerPoints() };
}
const up = new THREE.Vector3(0, 1, 0);
function between(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, extra = 0) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length() + extra;
  m.position.addVectors(a, b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(up, d.normalize());
  m.scale.set(1, len, 1);
}
function drawWeapon(w: ReturnType<typeof makeWeapon>, f: Fighter, firstPerson: boolean) {
  const shown = !!f.st.c.armed && !!f.st.alive;
  w.handle.visible = w.head.visible = shown;
  if (!shown) return;
  weaponPoints(f.st, w.pts, firstPerson);
  between(w.handle, w.pts[0], w.pts[7]);
  between(w.head, w.pts[6], w.pts[8], 0.14);
}
const myWeapon = makeWeapon();
const foeWeapon = makeWeapon();
/** The opponent's body: its hit capsules, drawn as they are (head, chest, pelvis, arms, legs). */
const parts = Array.from({ length: 11 }, (_, i) => {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(1, 1, 4, 10), i === 0 ? skin : cloth);
  scene.add(m);
  return m;
});
function drawBody(caps: Capsule[], alive: boolean) {
  caps.forEach((c, i) => {
    const m = parts[i];
    if (!m) return;
    m.visible = alive;
    const d = new THREE.Vector3().subVectors(c.b, c.a);
    const len = d.length();
    // (A capsule's geometry rebuilt only when its proportions change: radius and length are per part.)
    const key = `${c.r.toFixed(3)}:${len.toFixed(2)}`;
    if (m.userData.key !== key) {
      m.geometry.dispose();
      m.geometry = new THREE.CapsuleGeometry(c.r, Math.max(0.001, len), 4, 10);
      m.userData.key = key;
    }
    m.position.addVectors(c.a, c.b).multiplyScalar(0.5);
    if (len > 1e-4) m.quaternion.setFromUnitVectors(up, d.normalize());
  });
}

const STATE = Object.fromEntries(Object.entries(S).map(([k, v]) => [v, k]));
const bar = (id: string, f: number) => ((document.querySelector(`#${id} i`) as HTMLElement).style.width = `${Math.max(0, Math.min(1, f)) * 100}%`);
function hud() {
  bar('hp', me.st.hp / me.maxHp);
  bar('st', me.st.c.stam / STAM.max);
  bar('foeHp', foe.st.hp / foe.maxHp);
  document.getElementById('me')!.textContent = `${STATE[me.st.c.s]}${me.st.c.riposte > 0 ? ' · riposte!' : ''}`;
  document.getElementById('foeState')!.textContent = foe.st.alive ? `${STATE[foe.st.c.s]}${foe.st.c.s === S.Windup ? ` (${['slash', 'overhead', 'stab'][foe.st.c.atk]})` : ''}` : 'down';
}

// ---------------------------------------------------------------- the loop
let last = performance.now(),
  acc = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  controls.frame(dt, turnCap(me.st.c));
  acc += dt;
  while (acc >= 1 / TICK_HZ) {
    acc -= 1 / TICK_HZ;
    const inputs = new Map<number, Input>();
    inputs.set(me.id, controls.enabled ? controls.sample() : { ...emptyInput(), yaw: me.st.yaw, pitch: me.st.pitch });
    inputs.set(foe.id, foeInput());
    for (const e of duel.step(inputs)) say(e);
    respawns();
  }
  const st = me.st;
  camera.position.set(st.x, st.y + eyeHeight(st.crouch), st.z);
  camera.rotation.set(st.pitch, st.yaw, 0, 'YXZ');
  drawWeapon(myWeapon, me, true);
  drawWeapon(foeWeapon, foe, false);
  drawBody(duel.capsules(foe), !!foe.st.alive);
  hud();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
