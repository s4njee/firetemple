import { SPRITE_FLOATS } from '../../gpu/sprites.ts';

/*
 * The scene's sprites, animated on the CPU. Every sprite is a closed-form function of one clock:
 * its age is `clock / life + offset` wrapped to one life, and everything random about it comes
 * from an integer hash of (sprite, life number, channel). Nothing is integrated and nothing is
 * stored, so the system is full from the first frame, runs the same at any frame rate, and a
 * headless render at a given clock always produces the same picture. No `Math.random()`.
 *
 * Kinds, written into each instance's `param` as kind + heat (see shade.wgsl):
 *   0 ember  drifts up from the brazier on a swaying path and cools
 *   1 spark  thrown out ballistically, lands on the ground and dies there as a glowing dot
 *   2 puff   large and dim: the flame body over the coals, and a glow that creeps over the floor
 */

export const MAX_SPARKS_AND_EMBERS = 4000;
export const FLAME_PUFFS = 18;
export const FLOOR_PUFFS = 30;
export const MAX_SPRITES = MAX_SPARKS_AND_EMBERS + FLAME_PUFFS + FLOOR_PUFFS;

/** Height of the coal bed the sprites leave from, and its radius. */
export const COALS_Y = 0.52;
export const COALS_RADIUS = 0.46;

const TAU = Math.PI * 2;
const GRAVITY = 6.5;
// Wind direction (x, z): to the right and a little away from the default camera.
const WIND_X = 0.9;
const WIND_Z = -0.42;
/** Heat is stored in the fraction of `param`, so it must stay below 1. */
const MAX_HEAT = 0.995;

/** A float in [0, 1) from three integers; a finaliser in the style of murmur3 / lowbias32. */
function random(sprite: number, life: number, channel: number): number {
  let h =
    Math.imul(sprite + 1, 0x9e3779b1) ^
    Math.imul(life + 0x632be5ab, 0x85ebca6b) ^
    Math.imul(channel + 1, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

export interface ParticleOptions {
  /** Embers plus sparks, at most `MAX_SPARKS_AND_EMBERS`. */
  count: number;
  /** Fraction of `count` that are sparks. */
  sparks: number;
  /** Multiplies the size of embers and sparks (the puffs keep theirs). */
  size: number;
  /** Brightness of the large puffs; 0 leaves them out. */
  puffs: number;
}

const scratch = new Float32Array(3);

/** Where an ember with the given per-life constants is at `age`, with the wind as it is at `clock`. */
function emberPosition(id: number, life: number, age: number, clock: number): Float32Array {
  const angle = TAU * random(id, life, 2);
  const radius = COALS_RADIUS * Math.sqrt(random(id, life, 3));
  const rise = 0.4 + 0.8 * random(id, life, 4);
  const sway = 0.07 + 0.2 * random(id, life, 5);
  const w1 = 0.7 + 1.4 * random(id, life, 6);
  const w2 = 0.7 + 1.4 * random(id, life, 7);
  const p1 = TAU * random(id, life, 8);
  const p2 = TAU * random(id, life, 9);

  const y = COALS_Y + rise * age + 0.035 * age * age;
  // The wind's push builds up with time in the air, and gusts roll through as a slow wave.
  const gust = 1 + 0.45 * Math.sin(0.35 * clock - 0.6 * y) + 0.2 * Math.sin(0.83 * clock + 1.3);
  const lean = 0.05 * age * age * gust;
  const spread = radius * (1 + 0.25 * age);
  const amplitude = sway * age;
  scratch[0] =
    Math.cos(angle) * spread + WIND_X * lean + amplitude * (Math.sin(w1 * age + p1) - Math.sin(p1));
  scratch[1] = y;
  scratch[2] =
    Math.sin(angle) * spread + WIND_Z * lean + amplitude * (Math.cos(w2 * age + p2) - Math.cos(p2));
  return scratch;
}

/**
 * Fills `data` with the sprites as they are at `clock` seconds and returns how many were written.
 * `data` needs room for `MAX_SPRITES`.
 */
export function simulate(data: Float32Array, clock: number, options: ParticleOptions): number {
  const total = Math.max(0, Math.min(MAX_SPARKS_AND_EMBERS, Math.round(options.count)));
  const sparks = Math.round(total * Math.min(1, Math.max(0, options.sparks)));
  const embers = total - sparks;
  const scale = options.size;
  let n = 0;

  const write = (
    x: number,
    y: number,
    z: number,
    size: number,
    vx: number,
    vy: number,
    vz: number,
    kind: number,
    heat: number,
    tint: number,
    radiance: number,
  ) => {
    const o = n * SPRITE_FLOATS;
    data[o] = x;
    data[o + 1] = y;
    data[o + 2] = z;
    data[o + 3] = size;
    data[o + 4] = vx;
    data[o + 5] = vy;
    data[o + 6] = vz;
    data[o + 7] = kind + Math.min(MAX_HEAT, Math.max(0, heat));
    // The tint leans a sprite a little towards yellow or towards red, so they are not all one hue.
    data[o + 8] = 1;
    data[o + 9] = 0.8 + 0.4 * tint;
    data[o + 10] = 0.6 + 0.8 * tint;
    data[o + 11] = radiance;
    n++;
  };

  // --- Embers ---
  const STEP = 1 / 120;
  for (let i = 0; i < embers; i++) {
    const life = 3.5 + 5 * random(i, 0, 0);
    const turns = clock / life + random(i, 0, 1);
    const lifeNumber = Math.floor(turns);
    const age = (turns - lifeNumber) * life;

    const here = emberPosition(i, lifeNumber, age, clock);
    const x = here[0]!;
    const y = here[1]!;
    const z = here[2]!;
    // Velocity by a forward difference along the same path; the path is smooth, so this is exact
    // enough to orient and stretch a sprite.
    const next = emberPosition(i, lifeNumber, age + STEP, clock + STEP);
    const vx = (next[0]! - x) / STEP;
    const vy = (next[1]! - y) / STEP;
    const vz = (next[2]! - z) / STEP;

    const t = age / life;
    const heat = Math.pow(1 - t, 1.2);
    // Each ember breathes at its own rate; the changes are local and never in step.
    const twinkle =
      0.78 +
      0.22 * Math.sin(age * (5 + 9 * random(i, lifeNumber, 10)) + TAU * random(i, lifeNumber, 11));
    const size = (0.03 + 0.045 * random(i, lifeNumber, 12)) * (0.55 + 0.45 * heat) * scale;
    const radiance = 16 * smooth(age / 0.25) * smooth((1 - t) / 0.12) * twinkle;
    write(x, y, z, size, vx, vy, vz, 0, heat, random(i, lifeNumber, 13), radiance);
  }

  // --- Sparks ---
  for (let i = 0; i < sparks; i++) {
    const id = i + 0x10000;
    const life = 2.2 + 1.8 * random(id, 0, 0);
    const turns = clock / life + random(id, 0, 1);
    const lifeNumber = Math.floor(turns);
    const age = (turns - lifeNumber) * life;

    const angle = TAU * random(id, lifeNumber, 2);
    const radius = 0.3 * Math.sqrt(random(id, lifeNumber, 3));
    const lateral = 0.5 + 2.8 * Math.pow(random(id, lifeNumber, 4), 1.4);
    const up = 2 + 3.6 * random(id, lifeNumber, 5);
    const size = (0.02 + 0.016 * random(id, lifeNumber, 6)) * scale;
    const cx = Math.cos(angle);
    const cz = Math.sin(angle);

    // Ballistic until it meets the ground, then it lies where it fell.
    const drop = COALS_Y + 0.05 - size;
    const landing = (up + Math.sqrt(up * up + 2 * GRAVITY * Math.max(drop, 0))) / GRAVITY;
    const flight = Math.min(age, landing);
    const reach = radius + lateral * flight;
    const y = COALS_Y + 0.05 + up * flight - 0.5 * GRAVITY * flight * flight;
    const flying = age < landing;

    const t = age / life;
    let heat = Math.pow(1 - t, 0.6);
    if (!flying) heat *= Math.exp(-(age - landing) * 1.1);
    const radiance = 30 * smooth(age / 0.12) * smooth((1 - t) / 0.2);
    write(
      cx * reach,
      Math.max(y, size),
      cz * reach,
      size,
      flying ? cx * lateral : 0,
      flying ? up - GRAVITY * flight : 0,
      flying ? cz * lateral : 0,
      1,
      heat,
      random(id, lifeNumber, 7),
      radiance,
    );
  }

  if (options.puffs <= 0) return n;

  // --- Flame puffs: the fire's body, tapering as it rises ---
  for (let i = 0; i < FLAME_PUFFS; i++) {
    const id = i + 0x20000;
    const life = 1.1 + 0.7 * random(id, 0, 0);
    const turns = clock / life + random(id, 0, 1);
    const lifeNumber = Math.floor(turns);
    const t = turns - lifeNumber;
    const age = t * life;

    const angle = TAU * random(id, lifeNumber, 2);
    const radius = 0.3 * Math.sqrt(random(id, lifeNumber, 3));
    const pull = 1 - 0.75 * t;
    const sway = 0.1 * Math.sin(age * 3.1 + TAU * random(id, lifeNumber, 4)) * t;
    const x = Math.cos(angle) * radius * pull + sway + WIND_X * 0.12 * t * t;
    const z = Math.sin(angle) * radius * pull + WIND_Z * 0.12 * t * t;
    const y = COALS_Y + 0.08 + (0.95 + 0.5 * random(id, lifeNumber, 5)) * age;
    const size = 0.36 - 0.2 * t;
    const envelope = smooth(t / 0.18) * smooth((1 - t) / 0.55);
    write(x, y, z, size, 0, 0, 0, 2, 0.86 - 0.5 * t, 0.5, 2.4 * envelope * options.puffs);
  }

  // --- Floor puffs: firelight in the haze, creeping outwards over the ground ---
  for (let i = 0; i < FLOOR_PUFFS; i++) {
    const id = i + 0x30000;
    const life = 8 + 5 * random(id, 0, 0);
    const turns = clock / life + random(id, 0, 1);
    const lifeNumber = Math.floor(turns);
    const t = turns - lifeNumber;

    const angle = TAU * random(id, lifeNumber, 2) + 0.25 * t;
    const reach = 0.5 + (2.4 + 2.2 * random(id, lifeNumber, 3)) * Math.pow(t, 0.8);
    const y = 0.22 + 0.3 * random(id, lifeNumber, 4) + 0.1 * Math.sin(TAU * t + i);
    const size = 0.6 + 0.75 * t;
    const envelope = smooth(t / 0.15) * smooth((1 - t) / 0.4);
    // Dimmer the further the light has travelled from the fire.
    const radiance = (0.9 * envelope * options.puffs) / (1 + 0.5 * reach * reach);
    write(
      Math.cos(angle) * reach + WIND_X * 0.3 * t,
      y,
      Math.sin(angle) * reach + WIND_Z * 0.3 * t,
      size,
      0,
      0,
      0,
      2,
      0.5,
      0.35,
      radiance,
    );
  }

  return n;
}
