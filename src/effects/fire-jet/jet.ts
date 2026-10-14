// The geometry and timing of the directed jet, as pure functions so tests can check them without a
// GPU. Two spaces meet here: the fluid's canvas uv (0..1, top-left origin, y DOWN, velocities in image
// heights per second) and the particles' overlay space (canvas heights, bottom-left origin, y UP).

export const MODES = ['flamethrower', 'dragon breath'] as const;
export type Mode = (typeof MODES)[number];

/** A direction as an angle in overlay space: 0 is to the right, positive turns up (anticlockwise). */
export type Angle = number;

const DEG = Math.PI / 180;

interface ModeGeometry {
  /** The nozzle (or mouth), canvas uv. */
  nozzle: readonly [number, number];
  /** The aim when nobody points, and how far the idle sweep swings either side of it. */
  rest: Angle;
  swing: Angle;
  /** Seconds per idle sweep. */
  period: number;
  /** The aim is kept within this angle either side of `rest`. */
  reach: Angle;
}

const GEOMETRY: Readonly<Record<Mode, ModeGeometry>> = {
  flamethrower: {
    nozzle: [0.1, 0.72],
    rest: 12 * DEG,
    swing: 14 * DEG,
    period: 9,
    reach: 70 * DEG,
  },
  'dragon breath': {
    nozzle: [0.12, 0.36],
    rest: -28 * DEG,
    swing: 26 * DEG,
    period: 7,
    reach: 80 * DEG,
  },
};

export function modeGeometry(mode: string): ModeGeometry {
  return GEOMETRY[(MODES as readonly string[]).includes(mode) ? (mode as Mode) : 'flamethrower'];
}

/** Shortest signed difference a - b of two angles, in -pi..pi. */
export function angleDelta(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/**
 * Where the jet points. With a pointer over the canvas (uv `pointer`) it aims at it; otherwise it
 * sweeps slowly about its rest direction. Either way the aim stays within `reach` of `rest`, so the
 * nozzle never fires back into its own edge. `canvasAspect` is width / height.
 */
export function aimAngle(
  mode: string,
  canvasAspect: number,
  time: number,
  pointer?: readonly [number, number],
): Angle {
  const g = modeGeometry(mode);
  let angle = g.rest + g.swing * Math.sin((2 * Math.PI * time) / g.period);
  if (pointer) {
    const dx = (pointer[0] - g.nozzle[0]) * canvasAspect;
    const dy = g.nozzle[1] - pointer[1];
    if (Math.hypot(dx, dy) > 0.02) angle = Math.atan2(dy, dx);
  }
  const off = angleDelta(angle, g.rest);
  return g.rest + Math.max(-g.reach, Math.min(g.reach, off));
}

/** Unit direction in overlay space (y up) for an angle. */
export function overlayDirection(angle: Angle): [number, number] {
  return [Math.cos(angle), Math.sin(angle)];
}

/** The same direction as a uv-space vector (y down), e.g. a velocity for `fluid.addForce`. */
export function uvDirection(angle: Angle): [number, number] {
  return [Math.cos(angle), -Math.sin(angle)];
}

/**
 * A point `distance` canvas heights from uv `from` along an angle, in uv: x is divided by the aspect
 * because uv x runs over the canvas width.
 */
export function uvAlong(
  from: readonly [number, number],
  angle: Angle,
  distance: number,
  aspect: number,
): [number, number] {
  return [from[0] + (Math.cos(angle) * distance) / aspect, from[1] - Math.sin(angle) * distance];
}

/**
 * Dragon breath comes in breaths: a smooth 0..1 envelope, `on` seconds of fire then `off` seconds of
 * smoke, with half-second ramps so the whole frame never brightens or darkens quickly. A
 * flamethrower is held open (1).
 */
export function throttle(mode: string, time: number, on = 3.2, off = 1.8): number {
  if (mode !== 'dragon breath') return 1;
  const period = on + off;
  const t = ((time % period) + period) % period;
  const ramp = 0.5;
  const smooth = (x: number) => {
    const c = Math.min(1, Math.max(0, x));
    return c * c * (3 - 2 * c);
  };
  return smooth(t / ramp) * smooth((on - t) / ramp);
}

/**
 * The impulse added to the fluid over the first `length` canvas heights of the jet in one update that
 * ran `steps` steps of `dt`. Gas crosses that stretch in about length / speed seconds, so a push of
 * speed * (speed / length) per second of simulated time brings it up to about the jet speed by the
 * time it leaves, the same at any frame rate. Capped at the jet speed itself per update.
 */
export function jetImpulse(speed: number, steps: number, dt: number, length: number): number {
  const gain = Math.max(0, speed) / Math.max(length, 1e-3);
  return speed * Math.min(1, Math.max(0, steps) * dt * gain);
}

/** One stretch of the mean droplet path, for the mean-field two-way coupling. */
export interface PathSegment {
  /** Ends, in overlay space relative to the nozzle (canvas heights, y up). */
  from: [number, number];
  to: [number, number];
  /** Mean droplet velocity over the stretch, overlay space. */
  velocity: [number, number];
  /** Share of the droplets still alive (and burning) there, 0..1. */
  alive: number;
}

/**
 * The path of the mean droplet on the CPU: launched at `speed` along `angle`, dragged towards still
 * air at `coupling` (1/s) and pulled down by `gravity`, the same ODE the GPU integrates when the gas
 * is at rest (exact: v = g/k + (v0 - g/k) e^(-k t)). Lives are uniform in `life`, so the share alive
 * falls linearly between its ends. `segments` stretches of equal time over the longest life.
 */
export function meanDropletPath(
  angle: Angle,
  speed: number,
  coupling: number,
  gravity: number,
  life: readonly [number, number],
  segments: number,
): PathSegment[] {
  const k = Math.max(coupling, 1e-3);
  const v0 = [Math.cos(angle) * speed, Math.sin(angle) * speed];
  const terminal = [0, -gravity / k];
  const at = (t: number): [number, number] => {
    const e = (1 - Math.exp(-k * t)) / k;
    return [
      terminal[0]! * t + (v0[0]! - terminal[0]!) * e,
      terminal[1]! * t + (v0[1]! - terminal[1]!) * e,
    ];
  };
  const velocity = (t: number): [number, number] => {
    const e = Math.exp(-k * t);
    return [terminal[0]! + (v0[0]! - terminal[0]!) * e, terminal[1]! + (v0[1]! - terminal[1]!) * e];
  };
  const [l0, l1] = life;
  const alive = (t: number) => (t <= l0 ? 1 : t >= l1 ? 0 : (l1 - t) / Math.max(l1 - l0, 1e-6));
  const out: PathSegment[] = [];
  const n = Math.max(1, Math.floor(segments));
  for (let i = 0; i < n; i++) {
    const t0 = (i / n) * l1;
    const t1 = ((i + 1) / n) * l1;
    const mid = (t0 + t1) / 2;
    out.push({ from: at(t0), to: at(t1), velocity: velocity(mid), alive: alive(mid) });
  }
  return out;
}
