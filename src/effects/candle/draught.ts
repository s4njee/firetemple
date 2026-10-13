// The candle's draught: how the flame leans in moving air. Pure functions, no DOM and no GPU, so
// the behaviour can be tested with numbers (tests/epic4-b.test.ts).
//
// Everything is in FLAME HEIGHTS: x to the right, y up, measured from the middle of the flame.
// `lean` is how far the tip stands to the side of the wick.

/** The tip never travels further than this to either side. `CANDLE_MAX_LEAN` in candle.wgsl. */
export const MAX_LEAN = 0.55;

/** Distance at which a pointer's push has fallen to half. */
const REACH = 1.1;
/** Lean a still pointer right beside the flame holds it at. */
const PUSH = 0.24;
/** Lean per flame height per second of pointer travel past the flame. */
const SWEEP = 0.07;
/** Largest lean a sweep alone can ask for. */
const SWEEP_LIMIT = 0.5;
/** Natural frequency (rad/s) and damping ratio of the flame's return: it overshoots once. */
const STIFFNESS = 11;
const DAMPING = 0.42;
/** Seconds by which the tip trails the base of the flame. */
const TIP_LAG = 0.11;
/** Seconds for disturbed air to settle. */
const GUST_DECAY = 0.6;
/** Longest step the spring is integrated with. */
const MAX_STEP = 1 / 120;

export interface DraughtPointer {
  /** Position relative to the middle of the flame. */
  x: number;
  y: number;
  /** Velocity, flame heights per second. */
  vx: number;
  vy: number;
}

export interface DraughtState {
  /** Where the lower flame leans to. */
  lean: number;
  velocity: number;
  /** Where the tip leans to: `lean`, a moment later. */
  tip: number;
  /** 0..1: how disturbed the air is. Drives the flutter of the flame's edge. */
  gust: number;
}

export function createDraught(lean = 0): DraughtState {
  return { lean, velocity: 0, tip: lean, gust: 0 };
}

/**
 * The lean a pointer asks of the flame and the gust it raises (0..1).
 *
 * Two parts. A pointer is a source of moving air, so the flame leans AWAY from it, more the nearer
 * it is; and a moving pointer drags air along, so the flame also leans the way the pointer travels.
 * Both fade with distance as 1 / (1 + (d / REACH)^2).
 */
export function pointerWind(
  pointer: DraughtPointer,
  strength: number,
): { lean: number; gust: number } {
  const near = 1 / (1 + (pointer.x * pointer.x + pointer.y * pointer.y) / (REACH * REACH));
  // A smooth sign: directly above or below the wick there is no side to lean to.
  const away = -pointer.x / Math.hypot(pointer.x, 0.12);
  const sweep = Math.min(Math.max(SWEEP * pointer.vx, -SWEEP_LIMIT), SWEEP_LIMIT);
  const speed = Math.hypot(pointer.vx, pointer.vy);
  return {
    lean: strength * near * (PUSH * away + sweep),
    gust: Math.min(1, strength * near * speed * 0.12),
  };
}

/**
 * Advances the flame by `dt` seconds toward `idle` (the sway it has in still air) plus whatever
 * the pointer asks for. A damped spring, integrated in steps of at most 1/120 s, so it behaves the
 * same at any frame rate and cannot blow up after a long pause.
 */
export function stepDraught(
  state: DraughtState,
  idle: number,
  pointer: DraughtPointer | undefined,
  strength: number,
  dt: number,
): void {
  const wind = pointer ? pointerWind(pointer, strength) : { lean: 0, gust: 0 };
  const aim = Math.min(Math.max(idle + wind.lean, -MAX_LEAN), MAX_LEAN);
  let left = Math.min(Math.max(dt, 0), 0.25);
  while (left > 1e-6) {
    const h = Math.min(left, MAX_STEP);
    left -= h;
    const pull =
      STIFFNESS * STIFFNESS * (aim - state.lean) - 2 * DAMPING * STIFFNESS * state.velocity;
    state.velocity += pull * h;
    state.lean += state.velocity * h;
    state.tip += (state.lean - state.tip) * (1 - Math.exp(-h / TIP_LAG));
    // A gust rises at once and dies away slowly.
    state.gust = Math.max(wind.gust, state.gust * Math.exp(-h / GUST_DECAY));
  }
  state.lean = Math.min(Math.max(state.lean, -MAX_LEAN), MAX_LEAN);
  state.tip = Math.min(Math.max(state.tip, -MAX_LEAN), MAX_LEAN);
}
