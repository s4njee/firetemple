// Emitters: where particles appear, how fast they leave, how long they live and how hot and big they
// start. An emitter is a live object: change any field between frames. The system turns it into one
// GPU record per step (`packEmitter`), and the emit kernel (kernels.wgsl) samples every new particle
// from that record with a hash, so no particle costs the CPU anything.
//
// RATE. `rate` is particles per second. Each step adds `rate * dt` to a carry and emits its whole
// part, so the count over any stretch of time is right to within one particle at any frame rate
// (tests/particles.test.ts checks it). `burst(n)` adds n particles to the next step, all born at the
// step's end. A rate-0 emitter is a TEMPLATE: GPU events (`ps_spawn` in a hook, or a collider's
// `spawn`) name it by index and borrow its shape, speeds, life, temperature, size and kind.
//
// MOVING EMITTERS. `moveTo(p)` once a frame. The steps of that frame sweep the emitter from where the
// previous step left it to `p`, and a particle born at fraction u of a step is placed at that
// fraction of the sweep and moved on for the rest of the step, so a sparkler swung fast leaves a
// continuous line instead of a row of clumps. `inherit` passes on a share of the sweep velocity.
//
// SHAPES (src/wgsl/particles.wgsl, `particle_shape_offset`): point; segment (half-vector `extent`);
// box (half-size `extent`); sphere (shell between `innerRadius` and `radius`, a disc in 2D); disc
// (annulus between `innerRadius` and `radius` normal to `axis`; a ring when they are equal).

export type Vec3 = readonly [number, number, number];

export const EMITTER_SHAPES = ['point', 'segment', 'box', 'sphere', 'disc'] as const;
export type EmitterShape = (typeof EMITTER_SHAPES)[number];

/** The u32 codes of `particle_shape_offset`; keep in step with src/wgsl/particles.wgsl. */
export const EMITTER_SHAPE_CODE: Readonly<Record<EmitterShape, number>> = {
  point: 0,
  segment: 1,
  box: 2,
  sphere: 3,
  disc: 4,
};

/** Floats per emitter record in the step uniform (nine vec4f). Keep in step with kernels.wgsl. */
export const EMITTER_FLOATS = 36;

export interface EmitterOptions {
  shape?: EmitterShape;
  /** Where the emitter is. Default the origin. */
  position?: Vec3;
  /** segment: half-vector from the centre to one end; box: half-size. Default 0. */
  extent?: Vec3;
  /** sphere / disc: outer radius. Default 0. */
  radius?: number;
  /** sphere / disc: inner radius (a shell, an annulus, a ring). Default 0. */
  innerRadius?: number;
  /** disc: the normal of its plane (3D only). Default +y. */
  axis?: Vec3;
  /** Unit direction the particles leave along. Default +y. */
  direction?: Vec3;
  /** Half-angle of the cone (a fan in 2D) around `direction`, radians. Default 0. */
  spread?: number;
  /** Launch speed range, world units per second. Default [0, 0]. */
  speed?: readonly [number, number];
  /** Extra speed straight away from the emitter centre (explosions, sphere bursts). Default 0. */
  radial?: number;
  /** Share of the emitter's own velocity (moving emitters; spawn requests) passed on. Default 0. */
  inherit?: number;
  /** Seconds, uniform in the range. Default [1, 1]. */
  life?: readonly [number, number];
  /** Initial temperature range, kelvin. Default [1800, 1800]. */
  temperature?: readonly [number, number];
  /** Initial size range (sprite half-width), world units. Default [0.01, 0.01]. */
  size?: readonly [number, number];
  /** Free tag copied to every particle (`Particle.kind`), for hooks. Default 0. */
  kind?: number;
  /** Particles per second. Default 0 (a template, or bursts only). */
  rate?: number;
  /** Stops emission without losing the settings. Default true. */
  enabled?: boolean;
}

export interface Emitter extends Required<Omit<EmitterOptions, 'position'>> {
  /** Index in the system's emitter list: what `ps_spawn` and colliders call a template. */
  readonly index: number;
  /** Where the emitter is now (after the latest `moveTo`). */
  readonly position: Vec3;
  /** Adds `n` particles to the next step, born together at its end. */
  burst(n: number): void;
  /** Moves the emitter; the next steps sweep from the old position to this one. */
  moveTo(position: Vec3): void;
  /** Teleports: the next steps start here, with no sweep and no inherited velocity. */
  jumpTo(position: Vec3): void;
}

/** The CPU side of one emitter: its live settings plus the rate carry and the sweep. */
export interface EmitterState extends Emitter {
  /** Particles owed to the next steps (whole and fractional), in particles. */
  carry: number;
  pendingBurst: number;
  /** Where the last step ended. */
  stepPosition: [number, number, number];
  target: [number, number, number];
}

export function createEmitterState(index: number, options: EmitterOptions): EmitterState {
  const start: [number, number, number] = [...(options.position ?? [0, 0, 0])] as [
    number,
    number,
    number,
  ];
  const state: EmitterState = {
    index,
    shape: options.shape ?? 'point',
    extent: options.extent ?? [0, 0, 0],
    radius: options.radius ?? 0,
    innerRadius: options.innerRadius ?? 0,
    axis: options.axis ?? [0, 1, 0],
    direction: options.direction ?? [0, 1, 0],
    spread: options.spread ?? 0,
    speed: options.speed ?? [0, 0],
    radial: options.radial ?? 0,
    inherit: options.inherit ?? 0,
    life: options.life ?? [1, 1],
    temperature: options.temperature ?? [1800, 1800],
    size: options.size ?? [0.01, 0.01],
    kind: options.kind ?? 0,
    rate: options.rate ?? 0,
    enabled: options.enabled ?? true,
    carry: 0,
    pendingBurst: 0,
    stepPosition: [...start],
    target: [...start],
    get position() {
      return state.target;
    },
    burst(n) {
      if (n > 0) state.pendingBurst += Math.floor(n);
    },
    moveTo(position) {
      state.target[0] = position[0];
      state.target[1] = position[1];
      state.target[2] = position[2];
    },
    jumpTo(position) {
      state.moveTo(position);
      state.stepPosition[0] = position[0];
      state.stepPosition[1] = position[1];
      state.stepPosition[2] = position[2];
    },
  };
  return state;
}

const normalize = (v: Vec3): [number, number, number] => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 1, 0];
};

/** What one step of one emitter emits: the counts this step consumes from the carry. */
export interface EmitterStep {
  rateCount: number;
  burstCount: number;
}

/**
 * Advances the carry by one step of `dt` seconds and returns what to emit. Bursts are taken whole on
 * the first step that runs after `burst` was called.
 */
export function takeEmitterStep(emitter: EmitterState, dt: number): EmitterStep {
  if (!emitter.enabled) {
    emitter.carry = 0;
    emitter.pendingBurst = 0;
    return { rateCount: 0, burstCount: 0 };
  }
  emitter.carry += Math.max(0, emitter.rate) * dt;
  // The epsilon lets 60 steps of 1/60 s at 60 per second add up to 60, not 59.
  const rateCount = Math.max(0, Math.floor(emitter.carry + 1e-9));
  emitter.carry = Math.max(0, emitter.carry - rateCount);
  const burstCount = emitter.pendingBurst;
  emitter.pendingBurst = 0;
  return { rateCount, burstCount };
}

/**
 * Writes the GPU record of one emitter for one step into `f32` / `u32` views of the same memory,
 * starting at float `at`. `from` and `to` are the ends of this step's sweep; `first` is where this
 * emitter's particles start among the step's CPU-emitted ones; `velocity` is the sweep velocity.
 */
export function packEmitter(
  f32: Float32Array,
  u32: Uint32Array,
  at: number,
  emitter: EmitterState,
  step: EmitterStep,
  from: Vec3,
  to: Vec3,
  first: number,
  velocity: Vec3,
  seed: number,
): void {
  const direction = normalize(emitter.direction);
  const axis = normalize(emitter.axis);
  const shape = emitter.shape;
  const extent: Vec3 =
    shape === 'sphere' || shape === 'disc'
      ? [emitter.radius, emitter.radius, emitter.radius]
      : emitter.extent;
  // e0: from, shape
  f32.set(from, at);
  u32[at + 3] = EMITTER_SHAPE_CODE[shape];
  // e1: to, count
  f32.set(to, at + 4);
  u32[at + 7] = step.rateCount + step.burstCount;
  // e2: extent, inner radius
  f32.set(extent, at + 8);
  f32[at + 11] = shape === 'sphere' || shape === 'disc' ? emitter.innerRadius : 0;
  // e3: axis, first
  f32.set(axis, at + 12);
  u32[at + 15] = first;
  // e4: direction, spread
  f32.set(direction, at + 16);
  f32[at + 19] = emitter.spread;
  // e5: speed range, radial, inherit
  f32[at + 20] = emitter.speed[0];
  f32[at + 21] = Math.max(emitter.speed[0], emitter.speed[1]);
  f32[at + 22] = emitter.radial;
  f32[at + 23] = emitter.inherit;
  // e6: life range, temperature range
  f32[at + 24] = emitter.life[0];
  f32[at + 25] = Math.max(emitter.life[0], emitter.life[1]);
  f32[at + 26] = emitter.temperature[0];
  f32[at + 27] = Math.max(emitter.temperature[0], emitter.temperature[1]);
  // e7: size range, kind, burst count
  f32[at + 28] = emitter.size[0];
  f32[at + 29] = Math.max(emitter.size[0], emitter.size[1]);
  u32[at + 30] = emitter.kind >>> 0;
  u32[at + 31] = step.burstCount;
  // e8: sweep velocity, seed
  f32.set(velocity, at + 32);
  u32[at + 35] = seed >>> 0;
}
