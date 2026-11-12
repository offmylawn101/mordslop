/**
 * Browser controls (import 'mordslop/controls'): mouse, wheel, trackpad and keyboard to an Input
 * for each tick.
 *
 *   Left click      slash, from the side the mouse was moving (straight down: an overhead)
 *   Wheel up / down stab / overhead       (a sideways trackpad swipe slashes that way)
 *   Right click     parry                 (R or F too)
 *   Q               feint (back out of a windup)
 *   Middle click    kick
 *   E               use (throw / pick up: what that does is yours, Duel reports it)
 *   WASD, Space, Shift, C   move, jump, sprint, crouch
 *
 * Look is applied every frame (frame), capped by the weapon's turn rate mid-swing (pass turnCap
 * of the fighter's combat state). Touch screens can drive the same through look, press, hold,
 * swingToward and stick.
 */
import { A, angleFromMotion, B, type Input } from './combat';

export class Controls {
  yaw = 0;
  pitch = 0;
  /** Off: nothing's read (a menu's up). */
  enabled = true;
  locked = false;
  lockFailed = false;
  /** Mouse sensitivity, and inverted look. */
  sens = 1;
  invert = false;
  /** Touch: the thumbstick, x right and y forward, each -1..1. */
  stick = { x: 0, y: 0 };
  /** Likely on a trackpad: a sideways or small-step wheel. */
  trackpad = /CrOS|Macintosh/.test(navigator.userAgent);
  /** The mouse let go mid-fight (Esc, a tab away): pause, say. */
  onUnlock: () => void = () => {};

  private relocked = false;
  private keys = new Set<string>();
  private edges = 0;
  private held = 0;
  private atk: number = A.Slash;
  private ang = 64;
  private lastAng = 64;
  private dx = 0;
  private dy = 0;
  private mx = 0;
  private my = 0;
  private wheel = { x: 0, y: 0, at: 0, done: false };
  private seq = 0;

  constructor(private el: HTMLElement) {
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === el;
      if (this.locked) {
        this.lockFailed = false;
        this.relocked = true;
      } else if (this.enabled) this.onUnlock();
    });
    document.addEventListener('pointerlockerror', () => (this.lockFailed = true));
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled || (!this.locked && !this.lockFailed)) return;
      // The first move after a lock can carry a jump to the window's middle: dropped, and any one
      // move further than a third of the window (no hand turns that far in one).
      const jump = Math.abs(e.movementX) > innerWidth / 3 || Math.abs(e.movementY) > innerHeight / 3;
      if (this.locked && (this.relocked || jump)) return void (this.relocked = false);
      this.dx += e.movementX;
      this.dy += e.movementY;
      this.mx += e.movementX;
      this.my -= e.movementY;
    });
    el.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.locked) {
        this.lock();
        if (!this.lockFailed) return;
      }
      if (e.button === 0) this.attack(A.Slash);
      else if (e.button === 2) this.edges |= B.Parry;
      else if (e.button === 1) this.edges |= B.Kick;
      e.preventDefault();
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // (A mouse's notch is one event of 50 or more, or lines, and never sideways.)
    window.addEventListener('wheel', (e) => (this.trackpad ||= (!!e.deltaX && !e.shiftKey) || (!e.deltaMode && !!e.deltaY && Math.abs(e.deltaY) < 30)), { passive: true });
    el.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        // Shift (sprint) turns a mouse wheel sideways in most browsers: read it as the wheel it is.
        const k = e.deltaMode ? 40 : 1;
        const x = e.shiftKey ? 0 : e.deltaX * k;
        const y = (e.shiftKey ? e.deltaY || e.deltaX : e.deltaY) * k;
        // One swing per flick of the wheel or swipe, its glide included: the next after a pause or on turning back.
        const w = this.wheel;
        if (e.timeStamp - w.at > 150 || x * w.x + y * w.y < 0) Object.assign(w, { x: 0, y: 0, done: false });
        w.at = e.timeStamp;
        w.x += x;
        w.y += y;
        if (w.done || Math.hypot(w.x, w.y) < 4) return;
        w.done = true;
        // Sideways slashes the way the fingers went (natural scrolling moves the page with them).
        if (Math.abs(w.x) > Math.abs(w.y)) this.swingToward(-w.x, 0);
        else this.attack(w.y < 0 ? A.Stab : A.Overhead);
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyQ') this.edges |= B.Feint;
      else if (e.code === 'KeyE') this.edges |= B.Use;
      else if (e.code === 'KeyR' || e.code === 'KeyF') this.edges |= B.Parry;
      else if (e.code === 'KeyV') this.attack(A.Slash);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Locks the mouse (call from a click: browsers only allow it then). */
  lock() {
    try {
      const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => (this.lockFailed = true));
    } catch {
      this.lockFailed = true;
    }
  }

  private attack(atk: number) {
    this.atk = atk;
    if (atk === A.Slash) {
      if (Math.hypot(this.mx, this.my) > 3) this.lastAng = angleFromMotion(this.mx, this.my);
      this.ang = this.lastAng;
      // Swung straight down: the overhead.
      if (this.ang === 0) this.atk = A.Overhead;
    } else this.ang = 0;
    this.edges |= B.Attack;
  }

  /** The side the next slash would come from (0..255: 0 above, 64 right, 128 below, 192 left), for a crosshair hint. */
  get nextAngle(): number {
    return Math.hypot(this.mx, this.my) > 3 ? angleFromMotion(this.mx, this.my) : this.lastAng;
  }

  /** Touch: look as the mouse would, moved this far (pixels). */
  look(dx: number, dy: number) {
    this.dx += dx;
    this.dy += dy;
  }

  /** Touch: a button tapped (B, one tick). */
  press(b: number) {
    this.edges |= b;
  }

  /** Touch: a button held down or let go (B). */
  hold(b: number, on: boolean) {
    this.held = on ? this.held | b : this.held & ~b;
  }

  /** Swing the way a swipe went (x right, y up): down is the overhead, anything upward the stab. */
  swingToward(x: number, y: number) {
    const l = Math.hypot(x, y) || 1;
    if (y / l > Math.cos((67.5 * Math.PI) / 180)) return this.attack(A.Stab);
    this.mx = (x / l) * 10;
    this.my = (y / l) * 10;
    this.attack(A.Slash);
  }

  /** Each frame: turn by what the mouse did (dt in seconds; cap: the fighter's turnCap(c), rad/s). */
  frame(dt: number, cap = Infinity) {
    // Recent motion fades over ~0.1 s: that's what picks the slash direction.
    const k = Math.exp(-dt / 0.1);
    this.mx *= k;
    this.my *= k;
    const s = 0.0022 * this.sens;
    let dyaw = -this.dx * s;
    let dpitch = -this.dy * s * (this.invert ? -1 : 1);
    this.dx = this.dy = 0;
    if (this.keys.has('ArrowLeft')) dyaw += 2.4 * dt;
    if (this.keys.has('ArrowRight')) dyaw -= 2.4 * dt;
    if (this.keys.has('ArrowUp')) dpitch += 1.6 * dt;
    if (this.keys.has('ArrowDown')) dpitch -= 1.6 * dt;
    if (isFinite(cap)) {
      const lim = cap * dt;
      dyaw = Math.max(-lim, Math.min(lim, dyaw));
      dpitch = Math.max(-lim, Math.min(lim, dpitch));
    }
    this.yaw += dyaw;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dpitch));
  }

  /** This tick's input (once per 60 Hz tick): taps since the last one, and what's held. */
  sample(): Input {
    const k = this.keys;
    let buttons = this.edges | this.held;
    this.edges = 0;
    if (k.has('Space')) buttons |= B.Jump;
    if (k.has('ShiftLeft') || k.has('ShiftRight')) buttons |= B.Sprint;
    if (k.has('KeyC')) buttons |= B.Crouch;
    const st = this.stick;
    return {
      seq: ++this.seq,
      viewTick: 0,
      yaw: this.yaw,
      pitch: this.pitch,
      mx: Math.max(-1, Math.min(1, (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0) + st.x)),
      mz: Math.max(-1, Math.min(1, (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0) + st.y)),
      buttons,
      atk: this.atk,
      ang: this.ang,
    };
  }
}
