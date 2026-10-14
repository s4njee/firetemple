import {
  createParticleRenderer,
  createParticleSystem,
  MAX_COLLIDERS,
  planeThrough,
  type Collider,
  type Emitter,
  type ParticleRenderer,
  type ParticleSystem,
} from '../../gpu/particles/index.ts';
import type { PassProfiler } from '../../gpu/profiler.ts';
import type { ObstacleRect } from '../../gpu/dom-rects.ts';
import hooks from './hooks.wgsl';
import shade from './shade.wgsl';

// The spark shower's particle system, apart from the effect so tests can drive it directly: the
// emitters, the hooks (hooks.wgsl: split on impact, the anvil), the colliders and the renderer's
// settings, from one plain settings object. Space: the 2D overlay (canvas heights, origin
// bottom-left, y up).

/** Emitter indices: what hooks.wgsl and the colliders call templates. */
export const SOURCE = 0;
export const HAMMER = 1;
export const CHILD = 2;

/** Height of the floor plane above the bottom edge, canvas heights. */
export const FLOOR_Y = 0.03;
/** Boxes after the floor and the anvil. */
export const MAX_BOXES = MAX_COLLIDERS - 2;

export interface ShowerSettings {
  /** Sparks per second from the source. */
  rate: number;
  /** Launch speed range, canvas heights per second. */
  speed: readonly [number, number];
  /** Direction the source throws along, radians from +x, counter-clockwise. */
  aim: number;
  /** Half-angle of the fan, radians. */
  spread: number;
  /** Seconds. */
  life: readonly [number, number];
  /** Kelvin at launch. */
  temperature: readonly [number, number];
  /** Sprite half-width, canvas heights. */
  size: readonly [number, number];
  /** Canvas heights per second squared, downwards. */
  gravity: number;
  /** Linear drag, 1/s. */
  dragLinear: number;
  /** Quadratic drag, 1/(canvas height): fast sparks lose speed quickly, slow ones keep it. */
  dragQuadratic: number;
  /** Newtonian cooling towards 300 K, 1/s. */
  cooling: number;
  /** A spark dies when it cools below this (kelvin). */
  deathTemperature: number;
  /** Normal velocity kept at a bounce, 0..1. */
  restitution: number;
  /** Share of the tangential velocity lost at a bounce. */
  friction: number;
  /** Children per split (0 turns splitting off). */
  children: number;
  /** Probability that an impact fast enough splits the spark. */
  splitChance: number;
  /** Most splits in a spark's ancestry: generation `generations` never splits. */
  generations: number;
  /** Slowest impact (canvas heights per second into the surface) that can split a spark. */
  minImpact: number;
  /** Children's temperature as a share of the parent's at impact (< 1: cooler). */
  childHeat: number;
  /** Children's speed as a share of the parent's rebound speed (at most). */
  childSpeed: number;
  /** Half-angle of the children's fan round the rebound, radians. */
  childFan: number;
  /** Children's size as a share of the template's. */
  childSize: number;
  /** Hammer bursts: launch speed range, fan half-angle round straight up, temperature. */
  hammerSpeed: readonly [number, number];
  hammerSpread: number;
  hammerTemperature: readonly [number, number];
}

export const DEFAULT_SHOWER: ShowerSettings = {
  rate: 700,
  speed: [1.3, 2.3],
  aim: -0.2,
  spread: 0.16,
  life: [1.2, 2],
  temperature: [2600, 3000],
  size: [0.0016, 0.0026],
  gravity: 2.4,
  dragLinear: 0.2,
  dragQuadratic: 0.8,
  cooling: 0.75,
  deathTemperature: 950,
  restitution: 0.42,
  friction: 0.25,
  children: 3,
  splitChance: 0.7,
  generations: 2,
  minImpact: 0.35,
  childHeat: 0.82,
  childSpeed: 0.75,
  childFan: 0.75,
  childSize: 0.7,
  hammerSpeed: [0.6, 1.7],
  hammerSpread: 1.2,
  hammerTemperature: [2200, 2650],
};

export interface ShowerSim {
  system: ParticleSystem;
  source: Emitter;
  hammer: Emitter;
  child: Emitter;
}

export interface ShowerSimOptions {
  capacity: number;
  profiler?: PassProfiler;
  seed?: number;
  /** Spawn requests a step can hold. Default 1024. */
  queueCapacity?: number;
  label?: string;
}

export function createShowerSim(device: GPUDevice, options: ShowerSimOptions): ShowerSim {
  const system = createParticleSystem({
    device,
    capacity: options.capacity,
    dimension: 2,
    fixedStep: 1 / 60,
    maxSteps: 4,
    queueCapacity: options.queueCapacity ?? 1024,
    hooks: { code: hooks.code, chunks: hooks.chunks },
    profiler: options.profiler,
    seed: options.seed ?? 11,
    label: options.label ?? 'spark-shower',
  });
  const source = system.addEmitter({ shape: 'point', kind: 0 });
  const hammer = system.addEmitter({ shape: 'segment', kind: 0 });
  // The template split children are sampled from: hook_emit sets their velocity from the request's
  // (the parent's rebound); temperature and kind come from the request.
  const child = system.addEmitter({ shape: 'point', rate: 0 });
  return { system, source, hammer, child };
}

/** Sets forces, heat, emitters and the hooks' uniforms from `s`. */
export function applyShower(sim: ShowerSim, s: ShowerSettings): void {
  const { system, source, hammer, child } = sim;
  const f = system.forces;
  f.gravity = [0, -s.gravity, 0];
  f.dragLinear = s.dragLinear;
  f.dragQuadratic = s.dragQuadratic;
  f.wind = [0, 0, 0];
  f.buoyancy = 0;
  f.turbulence = 'none';
  system.heat.cooling = s.cooling > 0 ? 'newton' : 'none';
  system.heat.rate = s.cooling;
  system.heat.ambient = 300;
  system.heat.deathTemperature = s.deathTemperature;

  source.direction = [Math.cos(s.aim), Math.sin(s.aim), 0];
  source.spread = s.spread;
  source.speed = s.speed;
  source.life = s.life;
  source.temperature = s.temperature;
  source.size = s.size;
  source.rate = s.rate;
  source.inherit = 0.3;

  hammer.direction = [0, 1, 0];
  hammer.spread = s.hammerSpread;
  hammer.speed = s.hammerSpeed;
  hammer.life = s.life;
  hammer.temperature = s.hammerTemperature;
  hammer.size = [s.size[0] * 1.15, s.size[1] * 1.3];
  hammer.rate = 0;

  child.speed = [0, 0];
  child.inherit = 0;
  child.life = [s.life[0] * 0.35, s.life[1] * 0.5];
  child.size = s.size;
  child.temperature = s.temperature;
  child.rate = 0;

  system.params.user[0] = [
    Math.max(0, Math.round(s.children)),
    s.splitChance,
    Math.max(0, Math.round(s.generations)),
    s.minImpact,
  ];
  system.params.user[1] = [s.childHeat, s.childSpeed, s.childFan, s.childSize];
}

/** A rectangle in canvas uv (top-left origin) as a solid box in overlay space. */
export function boxFromRect(rect: ObstacleRect, aspect: number): Collider {
  return {
    type: 'box',
    center: [(rect.x + rect.width / 2) * aspect, 1 - (rect.y + rect.height / 2), 0],
    half: [(rect.width / 2) * aspect, rect.height / 2, 1],
  };
}

/** Does the overlay point `p` lie inside `rect` grown by `margin` (canvas heights)? */
export function rectContains(
  rect: ObstacleRect,
  aspect: number,
  p: readonly [number, number],
  margin = 0,
): boolean {
  const x0 = rect.x * aspect - margin;
  const x1 = (rect.x + rect.width) * aspect + margin;
  const y0 = 1 - (rect.y + rect.height) - margin;
  const y1 = 1 - rect.y + margin;
  return p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
}

export interface ShowerColliders {
  /** The floor plane, FLOOR_Y above the bottom edge. Default true. */
  floor?: boolean;
  /** The anvil (hook_sdf): where the top of its face is, and its scale, in overlay space. */
  anvil?: { x: number; y: number; scale: number };
  /** Solid boxes (page elements or their stand-ins), at most MAX_BOXES. */
  boxes?: readonly Collider[];
  restitution: number;
  friction: number;
}

/** Rebuilds the collider list. Every collider can split (hooks.wgsl decides). */
export function setShowerColliders(sim: ShowerSim, c: ShowerColliders): void {
  const { system } = sim;
  const contact = { restitution: c.restitution, friction: c.friction, skin: 2e-4 };
  system.colliders.length = 0;
  if (c.floor ?? true)
    system.colliders.push({ ...planeThrough([0, FLOOR_Y, 0], [0, 1, 0]), ...contact });
  if (c.anvil) {
    system.colliders.push({ type: 'sdf', ...contact });
    system.params.user[2] = [c.anvil.x, c.anvil.y, c.anvil.scale, 0];
  } else {
    system.params.user[2] = [0, -10, 1, 0];
  }
  for (const box of (c.boxes ?? []).slice(0, MAX_BOXES))
    system.colliders.push({ ...box, ...contact });
}

export interface ShowerLook {
  /** Radiance multiplier. */
  intensity: number;
  /** Exposure, seconds: a streak is about speed times this long. */
  shutter: number;
  /** Mean sprite half-width the shutter is converted with. */
  size: number;
}

export function createShowerRenderer(
  sim: ShowerSim,
  camera: GPUBuffer,
  format: GPUTextureFormat,
  profiler?: PassProfiler,
): ParticleRenderer {
  return createParticleRenderer(sim.system, {
    camera,
    format,
    profiler,
    shade: { label: shade.label, code: shade.code, chunks: shade.chunks },
    label: 'spark-shower sprites',
  });
}

/**
 * The streak: the sprite renderer stretches a quad to `size * (1 + stretch * speed)` half-length,
 * so a streak whose whole length is `speed * shutter` needs `stretch = shutter / (2 size)`.
 */
export function stretchFor(shutter: number, size: number): number {
  return shutter / (2 * Math.max(size, 1e-5));
}

export function applyShowerLook(renderer: ParticleRenderer, look: ShowerLook): void {
  const style = renderer.style;
  style.color = 'blackbody';
  style.intensity = look.intensity;
  style.tRef = 2000;
  style.gamma = 0.4;
  style.twinkle = 0.12;
  style.twinkleRate = 3;
  style.sizeCurve = [1, 1, 0.7, 0.2];
  style.fadeIn = 0.06;
  style.fadeOut = 0.12;
  const sprites = renderer.sprites.settings;
  sprites.shape = 'gaussian';
  sprites.stretch = stretchFor(look.shutter, look.size);
  sprites.maxStretch = 28;
  sprites.trail = 0.85;
  sprites.stretchDim = 1;
  sprites.minPixels = 0.7;
  sprites.depth = 'none';
}

/** Expected sparks alive at the calm rate (Little's law, children included), for sizing the pool. */
export function expectedShowerAlive(s: ShowerSettings, hammerPerSecond = 0): number {
  const life = (s.life[0] + s.life[1]) / 2;
  const childLife = (s.life[0] * 0.35 + s.life[1] * 0.5) / 2;
  let children = 0;
  let generation = 1;
  for (let g = 0; g < Math.round(s.generations); g++) {
    generation *= s.children * s.splitChance;
    children += generation;
  }
  return (s.rate + hammerPerSecond) * (life + children * childLife);
}

/**
 * The pool for settings `s` at their highest rate: half as much again as the expected count (an
 * upper bound already, since many sparks cool out before they split), a power of two.
 */
export function showerCapacity(s: ShowerSettings, hammerPerSecond = 0): number {
  const alive = expectedShowerAlive(s, hammerPerSecond);
  return 2 ** Math.ceil(Math.log2(Math.max(4096, alive * 1.5)));
}
