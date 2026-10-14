// The numbers behind the particle flame, as pure functions so tests can check them without a GPU.
// Overlay space: world units are canvas heights, origin bottom-left, y up (overlayCamera).

/** The air (kelvin): what particles cool towards and buoyancy is measured from. */
export const AMBIENT = 300;
/** A flame particle has cooled to this (kelvin) when its life ends: a dim red. */
export const END_TEMPERATURE = 950;
/** Heat 0 of the colour ramp (kelvin): nothing glows below it. */
export const COLD_TEMPERATURE = 800;
/** Linear drag of flame particles towards the wind, 1/s: high, so they ride their own lift. */
export const DRAG = 3.2;
/** How much a full drive level adds to the emission, as a share of the calm rate. */
export const DRIVE_SHARE = 0.5;
/** Share of the flame's buoyancy an ember keeps: they drift up, slower than the flame. */
export const EMBER_LIFT = 0.18;

export const BASES = ['campfire', 'torch', 'candle', 'line'] as const;
export type Base = (typeof BASES)[number];

/** Where and how a base emits, before the parameters scale it. */
export interface BaseShape {
  shape: 'box' | 'disc';
  /** Centre, x as a share of the canvas width, y in canvas heights. */
  x: number;
  y: number;
  /** Half-width of the segment, or the disc radius, in canvas heights (before `width`). */
  half: number;
  /** Sprite half-width range at birth, canvas heights (before `size`). */
  size: [number, number];
  /** Mean life, seconds. */
  life: number;
  /** Flame height, canvas heights (before `height`). */
  height: number;
  /** Pull towards the base's axis, 1/s^2 (the taper). */
  converge: number;
  /**
   * 0: every particle is pulled towards the centre of the base (one tapered flame). 1: towards the
   * point it was born above (a row of independent tongues, for a line of fire).
   */
  local: number;
  /** Launch speed range, canvas heights per second. */
  speed: [number, number];
  /** Turbulence: acceleration scale and noise cells per canvas height. */
  turbulence: number;
  frequency: number;
  /** Width of the base in a canvas of this aspect is capped at this share of the width. */
  maxShare: number;
}

const SHAPES: Readonly<Record<Base, BaseShape>> = {
  campfire: {
    shape: 'box',
    x: 0.5,
    y: 0.05,
    half: 0.1,
    size: [0.0225, 0.0375],
    life: 1.05,
    height: 0.5,
    converge: 7,
    local: 0.5,
    speed: [0.05, 0.2],
    turbulence: 2.2,
    frequency: 6,
    maxShare: 0.8,
  },
  torch: {
    shape: 'disc',
    x: 0.5,
    y: 0.3,
    half: 0.03,
    size: [0.022, 0.034],
    life: 0.85,
    height: 0.55,
    converge: 9,
    local: 0,
    speed: [0.05, 0.2],
    turbulence: 1.4,
    frequency: 6,
    maxShare: 0.4,
  },
  candle: {
    shape: 'disc',
    x: 0.5,
    y: 0.32,
    half: 0.006,
    size: [0.009, 0.014],
    life: 0.6,
    height: 0.26,
    converge: 22,
    local: 0,
    speed: [0.02, 0.08],
    turbulence: 0.35,
    frequency: 8,
    maxShare: 0.2,
  },
  line: {
    shape: 'box',
    x: 0.5,
    y: 0.03,
    half: 0.75,
    size: [0.026, 0.045],
    life: 0.9,
    height: 0.36,
    converge: 7,
    local: 0.92,
    speed: [0.05, 0.2],
    turbulence: 1.8,
    frequency: 5,
    maxShare: 0.92,
  },
};

/** The base `kind` in a canvas of this aspect, with `width` scaling its half-width. */
export function baseShape(kind: string, aspect: number, width = 1): BaseShape {
  const base = SHAPES[(BASES as readonly string[]).includes(kind) ? (kind as Base) : 'campfire'];
  const half = Math.min(base.half * width, (base.maxShare * Math.max(aspect, 0.1)) / 2);
  return { ...base, half };
}

export interface FlameInputs {
  /** Average flame particles alive at the calm rate. */
  count: number;
  /** Mean life, seconds. */
  life: number;
  /** Flame height, canvas heights. */
  height: number;
  /** Mean birth temperature, kelvin. */
  temperature: number;
}

export interface FlamePhysics {
  /** Newtonian cooling of a flame particle, 1/s: the mean one ends its life at END_TEMPERATURE. */
  cooling: number;
  /** Acceleration per 1000 K above ambient (the framework's `forces.buoyancy`). */
  buoyancy: number;
  /** Emission, particles per second, at drive `level`. */
  rate: number;
}

/**
 * Cooling that takes the mean particle from `temperature` to END_TEMPERATURE in `life`; buoyancy
 * whose terminal speed against DRAG, averaged over that cooling, carries a particle `height` in its
 * life; and the rate that keeps `count` alive on average (Little's law), raised by at most
 * DRIVE_SHARE of itself by the drive `level` (0..1).
 */
export function flamePhysics(inputs: FlameInputs, level: number): FlamePhysics {
  const life = Math.max(0.05, inputs.life);
  const excess = Math.max(END_TEMPERATURE - AMBIENT + 1, inputs.temperature - AMBIENT);
  const kl = Math.log(excess / (END_TEMPERATURE - AMBIENT));
  const cooling = kl / life;
  // Mean of (T - ambient) over the life under exact Newtonian cooling.
  const meanExcess = (excess * (1 - Math.exp(-kl))) / kl;
  const buoyancy = (Math.max(0, inputs.height) * DRAG * 1000) / (life * meanExcess);
  const drive = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
  return {
    cooling,
    buoyancy,
    rate: (Math.max(0, inputs.count) / life) * (1 + DRIVE_SHARE * drive),
  };
}

/** The pool: room for the drive, the pointer fires and the embers, a power of two. */
export function flameCapacity(count: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(2048, count * 3)));
}

/**
 * A slow swell of the emission (the fire "breathing"), 1 +- amount, from two sines under 1 Hz, so
 * the whole-frame brightness never swings fast enough to count as a flash.
 */
export function breath(t: number, amount: number): number {
  const s = Math.sin(2 * Math.PI * 0.37 * t) + Math.sin(2 * Math.PI * 0.83 * t + 1.3);
  return 1 + amount * 0.5 * s;
}
