import {
  createParticleRenderer,
  createParticleSystem,
  type Emitter,
  type ParticleRenderer,
  type ParticleSystem,
} from '../../gpu/particles/index.ts';
import type { PassProfiler } from '../../gpu/profiler.ts';
import hooks from './hooks.wgsl';
import shade from './shade.wgsl';

// The sparkler's particle system, apart from the effect so tests can drive it directly: the tip
// emitter, the fork template, the hooks (hooks.wgsl) and the renderer's settings, from one plain
// settings object, plus the pure numbers behind them (the expected live count, the idle path).
// Space: the 2D overlay (canvas heights, origin bottom-left, y up).

/** Emitter indices: the tip, and the template forked children are sampled from. */
export const TIP = 0;
export const FORK = 1;

export interface SparklerSettings {
  /** Sparks per second from the tip (forked children come on top). */
  rate: number;
  /** Launch speed range, canvas heights per second. */
  speed: readonly [number, number];
  /** Seconds a spark from the tip lives. */
  life: readonly [number, number];
  /** Kelvin at launch. */
  temperature: readonly [number, number];
  /** Sprite half-width, canvas heights. */
  size: readonly [number, number];
  /** Radius of the burning tip the sparks leave from, canvas heights. */
  radius: number;
  /** Share of the tip's own velocity a spark keeps. */
  inherit: number;
  /** Canvas heights per second squared, downwards. */
  gravity: number;
  /** Linear drag, 1/s: what makes a sparkler's sparks short and curved. */
  drag: number;
  /** Newtonian cooling, 1/s. */
  cooling: number;
  /** Probability that a spark forks. */
  forkChance: number;
  /** Most forks in a spark's ancestry: generation `generations` never forks. */
  generations: number;
  /** When a spark forks, as a share of its life. */
  forkAt: readonly [number, number];
  /** A child's life as a share of what its parent had left (both below 1: shorter-lived). */
  childLife: readonly [number, number];
  /** Half-angle between the children, radians. */
  fan: number;
  /** Children's speed as a share of the parent's. */
  childSpeed: number;
  /** Share of forks with three children rather than two. */
  three: number;
}

export const DEFAULT_SPARKLER: SparklerSettings = {
  rate: 1800,
  speed: [0.35, 1.05],
  life: [0.1, 0.4],
  temperature: [2700, 3200],
  size: [0.0011, 0.0019],
  radius: 0.004,
  inherit: 0.15,
  gravity: 0.5,
  drag: 1.6,
  cooling: 1.2,
  forkChance: 0.55,
  generations: 2,
  forkAt: [0.35, 0.8],
  childLife: [0.6, 1],
  fan: 0.55,
  childSpeed: 1.15,
  three: 0.4,
};

export interface SparklerSim {
  system: ParticleSystem;
  tip: Emitter;
  fork: Emitter;
}

export interface SparklerSimOptions {
  capacity: number;
  profiler?: PassProfiler;
  seed?: number;
  /** Keep each particle's `user` (a child's is its parent's remaining and whole life): for tests. */
  userData?: boolean;
  /** Spawn requests a step can hold. Default 2048. */
  queueCapacity?: number;
  label?: string;
}

export function createSparklerSim(device: GPUDevice, options: SparklerSimOptions): SparklerSim {
  const system = createParticleSystem({
    device,
    capacity: options.capacity,
    dimension: 2,
    fixedStep: 1 / 60,
    maxSteps: 4,
    queueCapacity: options.queueCapacity ?? 2048,
    userData: options.userData ?? false,
    hooks: { code: hooks.code, chunks: hooks.chunks },
    profiler: options.profiler,
    seed: options.seed ?? 5,
    label: options.label ?? 'sparkler',
  });
  const tip = system.addEmitter({ shape: 'sphere', spread: Math.PI, kind: 0 });
  // Forked children: hook_emit turns the request's velocity (the parent's) into theirs.
  const fork = system.addEmitter({ shape: 'point', rate: 0 });
  return { system, tip, fork };
}

export function applySparkler(sim: SparklerSim, s: SparklerSettings): void {
  const { system, tip, fork } = sim;
  const f = system.forces;
  f.gravity = [0, -s.gravity, 0];
  f.dragLinear = s.drag;
  f.dragQuadratic = 0;
  f.wind = [0, 0, 0];
  f.buoyancy = 0;
  f.turbulence = 'none';
  system.heat.cooling = s.cooling > 0 ? 'newton' : 'none';
  system.heat.rate = s.cooling;
  system.heat.ambient = 300;
  system.heat.deathTemperature = 0;

  tip.shape = 'sphere';
  tip.radius = s.radius;
  tip.innerRadius = 0;
  tip.direction = [0, 1, 0];
  tip.spread = Math.PI;
  tip.speed = s.speed;
  tip.inherit = s.inherit;
  tip.life = s.life;
  tip.temperature = s.temperature;
  tip.size = s.size;
  tip.rate = s.rate;

  fork.speed = [0, 0];
  fork.inherit = 0;
  fork.life = s.life;
  fork.size = s.size;
  fork.temperature = s.temperature;
  fork.rate = 0;

  system.params.user[0] = [
    s.forkChance,
    Math.max(0, Math.round(s.generations)),
    s.fan,
    s.childSpeed,
  ];
  system.params.user[1] = [s.forkAt[0], s.forkAt[1], s.childLife[0], s.childLife[1]];
  system.params.user[2] = [s.three, 0, 0, 0];
}

/**
 * Particle-seconds one spark from the tip accounts for, its descendants included, in units of its
 * own life. A spark of generation g lives its whole life L if it does not fork; if it forks (chance
 * c) it lives f L (f is where in its life it forks) and leaves n children of generation g + 1, each
 * living a share h of the (1 - f) L it had left. Every factor is independent and the result is
 * linear in L, so k_g = c (E[f] + E[n] E[1 - f] E[h] k_{g+1}) + (1 - c), with k_G = 1.
 */
export function sparkLifeFactor(s: SparklerSettings): number {
  const c = Math.min(1, Math.max(0, s.forkChance));
  const f = (s.forkAt[0] + s.forkAt[1]) / 2;
  const h = (s.childLife[0] + s.childLife[1]) / 2;
  const n = 2 + Math.min(1, Math.max(0, s.three));
  let k = 1;
  for (let g = Math.max(0, Math.round(s.generations)) - 1; g >= 0; g--) {
    k = c * (f + n * (1 - f) * h * k) + (1 - c);
  }
  return k;
}

/** Sparks alive on average at the tip's rate (Little's law): rate x mean life x the fork factor. */
export function expectedSparklerAlive(s: SparklerSettings): number {
  return s.rate * ((s.life[0] + s.life[1]) / 2) * sparkLifeFactor(s);
}

/** The pool: room for the drive and a fast swing, a power of two. */
export function sparklerCapacity(s: SparklerSettings): number {
  return 2 ** Math.ceil(Math.log2(Math.max(2048, expectedSparklerAlive(s) * 2.5)));
}

/**
 * The idle path: a slow figure of eight (a 1:2 Lissajous curve) round `center`, `size` canvas
 * heights across, once every `period` seconds, so a sparkler nobody holds is never still.
 */
export function idlePath(
  t: number,
  center: readonly [number, number],
  size: readonly [number, number],
  period: number,
): [number, number] {
  const w = (2 * Math.PI) / Math.max(0.5, period);
  return [
    center[0] + (size[0] / 2) * Math.sin(w * t),
    center[1] + (size[1] / 2) * Math.sin(2 * w * t) * 0.9 + 0.012 * Math.sin(3 * w * t + 0.7),
  ];
}

export function createSparklerRenderer(
  sim: SparklerSim,
  camera: GPUBuffer,
  format: GPUTextureFormat,
  profiler?: PassProfiler,
): ParticleRenderer {
  return createParticleRenderer(sim.system, {
    camera,
    format,
    profiler,
    shade: { label: shade.label, code: shade.code, chunks: shade.chunks },
    label: 'sparkler sprites',
  });
}

export interface SparklerLook {
  intensity: number;
  /** Exposure, seconds: a streak is about speed times this long. */
  shutter: number;
  /** Mean sprite half-width the shutter is converted with. */
  size: number;
}

export function applySparklerLook(renderer: ParticleRenderer, look: SparklerLook): void {
  const style = renderer.style;
  style.color = 'blackbody';
  style.intensity = look.intensity;
  style.tRef = 2200;
  style.gamma = 0.4;
  style.twinkle = 0;
  style.sizeCurve = [1, 1, 0.6, 0.3];
  style.fadeIn = 0.01;
  style.fadeOut = 0.3;
  const sprites = renderer.sprites.settings;
  sprites.shape = 'gaussian';
  sprites.stretch = look.shutter / (2 * Math.max(look.size, 1e-5));
  sprites.maxStretch = 30;
  sprites.trail = 0.9;
  sprites.stretchDim = 1;
  sprites.minPixels = 0.6;
  sprites.depth = 'none';
}
