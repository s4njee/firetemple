import {
  createParticleSystem,
  type Emitter,
  type ParticleSystem,
} from '../../gpu/particles/index.ts';
import type { PassProfiler } from '../../gpu/profiler.ts';
import hooks from './hooks.wgsl';

// The firework show's simulation (story 7.5), apart from the drawing so tests can drive it: one
// particle system whose hooks (hooks.wgsl) turn a launched shell into its burst, trails, splits and
// pops on the GPU, plus the CPU side: what a shell is, how fast to launch it so it breaks at a
// point, and when to launch it so bursts never pile up.
//
// Space: the 2D overlay space (canvas heights, origin bottom-left, y up), with depth. The system is
// three-dimensional so a spherical burst is a real sphere seen from the front (bright at the rim,
// a ring is an ellipse); the orthographic overlay camera ignores z.

export const SHELL_TYPES = [
  'peony',
  'chrysanthemum',
  'willow',
  'ring',
  'palm',
  'crossette',
  'crackle',
  'glitter',
] as const;
export type ShellType = (typeof SHELL_TYPES)[number];

/** Star colours, by emitter (codes in hooks.wgsl `fw_salt`). */
export const SALTS = [
  'strontium red',
  'barium green',
  'copper blue',
  'sodium yellow',
  'magnesium white',
  'charcoal gold',
  'strontium-copper purple',
  'titanium silver',
] as const;
export type Salt = (typeof SALTS)[number];

/** Particle roles (the low four bits of `kind`; hooks.wgsl). */
export const ROLE = {
  shell: 0,
  tail: 1,
  star: 2,
  ember: 3,
  sub: 4,
  pop: 5,
  smoke: 6,
  glint: 7,
  glow: 8,
} as const;

/** Stars per shell at size 1. */
export const BASE_COUNT: Readonly<Record<ShellType, number>> = {
  peony: 140,
  chrysanthemum: 120,
  willow: 80,
  ring: 60,
  palm: 10,
  crossette: 16,
  crackle: 50,
  glitter: 70,
};

/** Children a crossette star splits into, and pops a crackle star ends in (hooks.wgsl). */
export const CROSS_ARMS = 4;
export const CRACKLE_POPS = 6;

/** Types whose stars are always charcoal gold, as real ones are. */
const GOLD_TYPES: ReadonlySet<ShellType> = new Set(['willow', 'palm', 'crackle']);

/** Emitter indices: the launcher, then the template every GPU-spawned child comes from. */
export const LAUNCHER = 0;
export const TEMPLATE = 1;

export interface Shell {
  type: ShellType;
  salt: Salt;
  /** Stars it breaks into. */
  count: number;
}

/** A shell's `kind`: role 0, its type, its salt, and its burst count in the top 16 bits. */
export function shellKind(shell: Shell): number {
  const type = SHELL_TYPES.indexOf(shell.type);
  const salt = SALTS.indexOf(shell.salt);
  const count = Math.max(1, Math.min(0xffff, Math.round(shell.count)));
  return (ROLE.shell | (type << 4) | (salt << 8) | (count << 16)) >>> 0;
}

export function decodeKind(kind: number): { role: number; type: number; salt: number } {
  return { role: kind & 15, type: (kind >>> 4) & 15, salt: (kind >>> 8) & 15 };
}

/** Stars for a type at a size (the size also scales the star speed, so the burst's reach). */
export function burstCount(type: ShellType, size: number): number {
  return Math.max(1, Math.round(BASE_COUNT[type] * (0.55 + 0.45 * size)));
}

export const PALETTES = ['salts', 'warm', 'cool', 'gold'] as const;
export type Palette = (typeof PALETTES)[number];
const PALETTE_SALTS: Readonly<Record<Palette, readonly Salt[]>> = {
  salts: [
    'strontium red',
    'barium green',
    'copper blue',
    'sodium yellow',
    'magnesium white',
    'strontium-copper purple',
  ],
  warm: ['strontium red', 'sodium yellow', 'charcoal gold', 'magnesium white'],
  cool: ['barium green', 'copper blue', 'strontium-copper purple', 'titanium silver'],
  gold: ['charcoal gold', 'charcoal gold', 'titanium silver'],
};

/** Weights of the types in a mixed show: mostly classic spheres, the special ones now and then. */
const MIX: readonly [ShellType, number][] = [
  ['peony', 3],
  ['chrysanthemum', 3],
  ['willow', 1.2],
  ['ring', 1.2],
  ['palm', 1],
  ['crossette', 1],
  ['crackle', 1],
  ['glitter', 1],
];

/** Picks a shell from `random()` in [0, 1): a mixed show when `type` is 'mix'. */
export function pickShell(
  type: ShellType | 'mix',
  palette: Palette,
  size: number,
  random: () => number,
): Shell {
  let chosen: ShellType = 'peony';
  if (type === 'mix') {
    const total = MIX.reduce((sum, [, w]) => sum + w, 0);
    let u = random() * total;
    for (const [candidate, w] of MIX) {
      chosen = candidate;
      if ((u -= w) < 0) break;
    }
  } else {
    chosen = type;
  }
  const salts = PALETTE_SALTS[palette];
  const salt = GOLD_TYPES.has(chosen)
    ? 'charcoal gold'
    : salts[Math.min(salts.length - 1, Math.floor(random() * salts.length))]!;
  return { type: chosen, salt, count: burstCount(chosen, size) };
}

/**
 * Launch velocity for a drag-free shell from `from` to break at `to` at its apogee, under gravity
 * `g` (canvas heights per second squared), stepped by semi-implicit Euler of `dt` (whose apogee is
 * v0 dt / 2 lower than the continuous one, corrected here). Returns the velocity and the rise time.
 */
export function launchVelocity(
  from: readonly [number, number],
  to: readonly [number, number],
  g: number,
  dt: number,
): { velocity: [number, number, number]; rise: number } {
  const height = Math.max(0.05, to[1] - from[1]);
  // v0^2 / (2 g) - v0 dt / 2 = height
  const vy = g * (dt / 2 + Math.sqrt((dt * dt) / 4 + (2 * height) / g));
  const rise = vy / g;
  return { velocity: [(to[0] - from[0]) / rise, vy, 0], rise };
}

/** Puts one shell on the launcher's next step. */
export function fireShell(
  launcher: Emitter,
  shell: Shell,
  from: readonly [number, number],
  velocity: readonly [number, number, number],
): void {
  const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
  launcher.jumpTo([from[0], from[1], 0]);
  launcher.direction = [velocity[0] / speed, velocity[1] / speed, velocity[2] / speed];
  launcher.speed = [speed, speed];
  launcher.spread = 0;
  launcher.kind = shellKind(shell);
  launcher.burst(1);
}

export interface FireworksSystem {
  system: ParticleSystem;
  launcher: Emitter;
}

export interface FireworksSettings {
  /** Canvas heights per second squared. */
  gravity: number;
  /** Multiplies star speeds (and so the burst's reach). */
  size: number;
  /** Multiplies how often trailing stars shed embers. */
  trails: number;
  /** Smoke puffs left by a burst. */
  haze: number;
  /** A soft glow where a shell breaks. */
  glow: boolean;
}

export function createFireworksSystem(
  device: GPUDevice,
  options: { capacity: number; seed?: number; profiler?: PassProfiler; queue?: number },
): FireworksSystem {
  const system = createParticleSystem({
    device,
    capacity: options.capacity,
    dimension: 3,
    fixedStep: 1 / 60,
    maxSteps: 4,
    queueCapacity: options.queue ?? 4096,
    userData: true,
    hooks: { code: hooks.code, chunks: hooks.chunks },
    seed: options.seed ?? 5,
    profiler: options.profiler,
    label: 'fireworks',
  });
  const launcher = system.addEmitter({ shape: 'point', rate: 0, kind: 0 });
  // The template: no speed of its own; hook_emit builds every child's velocity from the request's.
  system.addEmitter({ shape: 'point', rate: 0, speed: [0, 0], spread: 0 });
  return { system, launcher };
}

/** Applies the live settings: forces, cooling and the hooks' uniforms. */
export function configureFireworks(system: ParticleSystem, settings: FireworksSettings): void {
  const f = system.forces;
  f.gravity = [0, -settings.gravity, 0];
  f.dragLinear = 0;
  f.dragQuadratic = 0;
  f.buoyancy = 0;
  f.turbulence = 'none';
  // Cooling is per role, in hook_update.
  system.heat.cooling = 'none';
  system.heat.ambient = 300;
  system.heat.deathTemperature = 0;
  system.params.user[0] = [settings.size, settings.trails, settings.haze, settings.glow ? 1 : 0];
}

/**
 * When to launch: requested shells are delayed so their BREAKS are at least `spacing` seconds
 * apart, the main defence against bursts adding up to a flash. Breaks keep the order of requests.
 */
export interface LaunchSchedule<T> {
  spacing: number;
  /** Queues a shell that takes `rise` seconds to break; returns when it will launch. */
  request(now: number, rise: number, item: T): number;
  /** The next shell due at `now`, if any. */
  take(now: number): T | undefined;
  readonly pending: number;
  /** Time of the latest break planned. */
  readonly lastBreak: number;
  setLastBreak(time: number): void;
}

export function createLaunchSchedule<T>(spacing: number, maxPending = 6): LaunchSchedule<T> {
  const queue: { at: number; item: T }[] = [];
  let lastBreak = -Infinity;
  return {
    spacing,
    request(now, rise, item) {
      if (queue.length >= maxPending) return Infinity;
      const at = Math.max(now + rise, lastBreak + this.spacing);
      lastBreak = at;
      const launch = at - rise;
      queue.push({ at: launch, item });
      queue.sort((a, b) => a.at - b.at);
      return launch;
    },
    take(now) {
      if (queue.length === 0 || queue[0]!.at > now) return undefined;
      return queue.shift()!.item;
    },
    get pending() {
      return queue.length;
    },
    get lastBreak() {
      return lastBreak;
    },
    setLastBreak(time) {
      lastBreak = time;
    },
  };
}

/** mulberry32: a small seeded generator for the show's choices (types, salts, positions). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
