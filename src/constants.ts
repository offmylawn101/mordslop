/** The sim's fixed tick: everything (timings in ticks, speeds per tick) assumes 60 Hz. */
export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
/** A fighter's capsule (m): radius and half the cylinder's height; feet at y, so its middle is at y + HALF_HEIGHT + RADIUS. */
export const RADIUS = 0.3;
export const HALF_HEIGHT = 0.6;
/** Eye height standing and crouched (m, from the feet). */
export const EYE = 1.62;
export const CROUCH_EYE = 1.3;
/** The shoulder pivot the weapon swings from, this far under the eye (m). */
export const PIVOT_DROP = 0.27;
