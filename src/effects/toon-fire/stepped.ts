/*
 * A stepped clock: animation "on twos" (or threes, or fours) for a hand-drawn look.
 *
 * The animation itself runs on a smooth clock (`phase`, advanced by `delta * speed` every frame).
 * What the picture is drawn from is `shown`: a copy of `phase` that is only refreshed `rate`
 * times a second of real time and held in between. Every display frame is still rendered, from
 * the held value, so nothing is skipped or dropped: at 60 Hz and 10 steps a second each drawing
 * is simply on screen for six frames, as a cel is under a camera.
 *
 * Two clocks, deliberately:
 * - The hold is timed in REAL seconds, so `rate` is drawings per second whatever `speed` is. A
 *   faster fire moves further per drawing; it does not get more drawings.
 * - The value held is the SMOOTH phase, so changing `rate` or `speed` never makes the animation
 *   jump, and a rate of 0 turns the stepping off without changing where the animation is.
 */

export interface SteppedClock {
  /**
   * Advances by `delta` real seconds and returns the phase to draw from. `speed` scales the
   * animation; `rate` is the number of drawings per second (0 or less: no stepping).
   */
  advance(delta: number, speed: number, rate: number): number;
  /** The smooth animation phase, in seconds of animation. */
  readonly phase: number;
  /** The phase the picture is currently drawn from: `phase` as it was at the last step. */
  readonly shown: number;
  /** How many drawings there have been. */
  readonly drawings: number;
}

/** Guards the step boundary against float error: 6 frames of 1/60 s must make one step of 1/10 s. */
const EPSILON = 1e-6;

export function createSteppedClock(wrap = Infinity): SteppedClock {
  let phase = 0;
  let shown = 0;
  let real = 0;
  let step = 0;
  let drawings = 0;
  let stepRate = Number.NaN;

  return {
    advance(delta, speed, rate) {
      phase += Math.max(delta, 0) * speed;
      if (phase >= wrap) phase -= wrap;
      if (!(rate > 0)) {
        stepRate = Number.NaN;
        if (shown !== phase) drawings++;
        shown = phase;
        return shown;
      }
      if (rate !== stepRate) {
        // A new rate starts a new count, with a new drawing straight away.
        stepRate = rate;
        real = 0;
        step = -1;
      }
      real += Math.max(delta, 0);
      const now = Math.floor(real * rate + EPSILON);
      if (now !== step) {
        step = now;
        shown = phase;
        drawings++;
      }
      return shown;
    },
    get phase() {
      return phase;
    },
    get shown() {
      return shown;
    },
    get drawings() {
      return drawings;
    },
  };
}
