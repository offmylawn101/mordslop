/**
 * A Mover on Rapier's kinematic character controller (import 'mordslop/rapier'): walls, steps,
 * slopes, and pushing light dynamic bodies out of the way. Needs @dimforge/rapier3d-compat
 * (or any build of it with the same API), initialised and with a world of your colliders.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { HALF_HEIGHT, RADIUS } from './constants';
import type { Mover, PState } from './movement';

export class RapierMover implements Mover {
  readonly kcc: RAPIER.KinematicCharacterController;
  readonly collider: RAPIER.Collider;
  /** Colliders the last move touched. */
  readonly touched: RAPIER.Collider[] = [];

  /** filter: the collision groups the fighter moves against (Rapier's packed membership/filter u32; undefined: everything). */
  constructor(
    R: typeof RAPIER,
    world: RAPIER.World,
    opts: { pushBodies?: boolean; groups?: number; filter?: number } = {},
  ) {
    this.kcc = world.createCharacterController(0.02);
    // Steps up onto low things (a toppled chair, a kerb).
    this.kcc.enableAutostep(0.4, 0.12, true);
    this.kcc.enableSnapToGround(0.35);
    this.kcc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.kcc.setApplyImpulsesToDynamicBodies(opts.pushBodies ?? true);
    this.kcc.setCharacterMass(80);
    const desc = R.ColliderDesc.capsule(HALF_HEIGHT, RADIUS).setTranslation(0, -50, 0);
    if (opts.groups !== undefined) desc.setCollisionGroups(opts.groups);
    this.collider = world.createCollider(desc);
    this.filter = opts.filter;
  }

  private readonly filter?: number;

  /** Puts the capsule where the fighter stands (after you teleport them). */
  place(p: PState) {
    this.collider.setTranslation({ x: p.x, y: p.y + HALF_HEIGHT + RADIUS, z: p.z });
  }

  move(p: PState, dx: number, dy: number, dz: number) {
    this.place(p);
    this.kcc.computeColliderMovement(this.collider, { x: dx, y: dy, z: dz }, undefined, this.filter);
    const m = this.kcc.computedMovement();
    this.touched.length = 0;
    for (let i = 0, n = this.kcc.numComputedCollisions(); i < n; i++) {
      const col = this.kcc.computedCollision(i);
      if (col?.collider) this.touched.push(col.collider);
    }
    p.x += m.x;
    p.y += m.y;
    p.z += m.z;
    p.grounded = this.kcc.computedGrounded() ? 1 : 0;
    this.place(p);
    return m;
  }
}
