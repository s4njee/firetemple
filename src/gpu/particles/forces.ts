import type { Vec3 } from './emitter.ts';

// Forces and heat: the live settings the update kernel (kernels.wgsl) applies every sub-step. All of
// them are plain objects on the system (`system.forces`, `system.heat`): change any field between
// frames. Units are the system's world units and seconds; temperatures are kelvin.
//
// ORDER IN A SUB-STEP of length h (semi-implicit Euler, so constant acceleration reproduces the
// discrete ballistic solution exactly):
//     a  = gravity + buoyancy + turbulence + point forces + field (accel mode) + hook_force
//     v += a h
//     v  = air + particle_drag(v - air, linear, quadratic, h)      air = wind (+ field, drag mode)
//     p1 = p + v h            -> colliders on the segment p .. p1
//     field 'advect' mode: v = field velocity, p1 = p + v h (replaces the above motion)
// then the temperature cools by h, the age grows by h. Drag is exact (stable at any step).
//
// BUOYANCY is `buoyancy * max(T - ambient, 0) / 1000` along `up`: hot particles rise, cold ones fall
// with gravity. TURBULENCE is a curl-noise acceleration, `strength * curl(p * frequency, time *
// evolve)`: divergence free, so it swirls particles without bunching them. '2d' uses `curl_2d_anim`
// (an fbm of `octaves` octaves animated through a third dimension), '3d' `curl_3d` with the time
// added along a fixed diagonal. Both are procedural and cost a few hundred ALU ops per particle per
// sub-step; `turbulenceEvery` > 1 reuses the value across sub-steps.
//
// EXTERNAL FIELD. A filterable 2D texture whose .xy is a velocity (the Epic 6 fluid's `fieldsView`:
// image heights per second, y down, uv top-left). `mapping` turns a particle position into uv and a
// texel's (x, y) into a velocity in particle space; `overlayFieldMapping` is the one for a 2D overlay
// system, `rectFieldMapping` for any axis-aligned rectangle. Modes: 'drag' (the field is the air the
// particle is dragged towards with `coupling`, 1/s: a = coupling (field - v)), 'accel' (the field is
// an acceleration times `coupling`), 'advect' (the particle moves exactly with the field, no inertia).
// Outside the texture the field fades to zero over 2% of its size.

export type TurbulenceMode = 'none' | '2d' | '3d';
export type FieldMode = 'none' | 'drag' | 'accel' | 'advect';
export type CoolingMode = 'none' | 'newton' | 'linear';

/** An affine map from particle space to texture uv, and from texel (x, y) to particle velocity. */
export interface FieldMapping {
  /** uv.x = dot(u, [p, 1]). */
  u: readonly [number, number, number, number];
  /** uv.y = dot(v, [p, 1]). */
  v: readonly [number, number, number, number];
  /** Particle velocity per unit of the texel's x. */
  x: Vec3;
  /** Particle velocity per unit of the texel's y. */
  y: Vec3;
}

export interface PointForce {
  position: Vec3;
  /** Acceleration towards the centre at distance `radius` and inside it (negative pushes). */
  attract: number;
  /** Tangential acceleration around `axis` (counter-clockwise seen from +axis). */
  swirl: number;
  /** Softening radius: the force is flat inside it and falls as 1/d^2 outside. */
  radius: number;
  /** Default +z (the axis of a 2D system's plane). */
  axis?: Vec3;
}

export interface Forces {
  gravity: [number, number, number];
  /** Air velocity the drag pulls towards. */
  wind: [number, number, number];
  /** Linear drag coefficient, 1/s. */
  dragLinear: number;
  /** Quadratic drag coefficient, 1/(world unit). */
  dragQuadratic: number;
  /** Acceleration per 1000 K above ambient, along `up`. */
  buoyancy: number;
  /** Unit vector buoyancy lifts along. */
  up: [number, number, number];
  turbulence: TurbulenceMode;
  /** Acceleration scale of the curl noise. */
  turbulenceStrength: number;
  /** Noise cells per world unit. */
  turbulenceFrequency: number;
  /** Noise cells per second the pattern evolves by. */
  turbulenceEvolve: number;
  /** '2d' only: fbm octaves, 1..4. */
  turbulenceOctaves: number;
  /** Evaluate the noise every this many sub-steps (1 = every one). */
  turbulenceEvery: number;
  /** Up to `MAX_POINT_FORCES` attractors / vortices. */
  points: PointForce[];
  field: FieldMode;
  /** 1/s for 'drag', a plain multiplier for 'accel'; ignored by 'advect'. */
  fieldCoupling: number;
  fieldMapping: FieldMapping;
}

export interface Heat {
  cooling: CoolingMode;
  /** 1/s for 'newton', kelvin per second for 'linear'. */
  rate: number;
  /** Temperature the particles cool towards (and buoyancy is measured from). */
  ambient: number;
  /** A particle dies when it cools below this. 0 disables. */
  deathTemperature: number;
}

export const MAX_POINT_FORCES = 4;

/** Identity-ish mapping (uv = p.xy), for a field nobody has set. */
export const IDENTITY_FIELD_MAPPING: FieldMapping = {
  u: [1, 0, 0, 0],
  v: [0, 1, 0, 0],
  x: [1, 0, 0],
  y: [0, 1, 0],
};

export function defaultForces(dimension: 2 | 3): Forces {
  return {
    gravity: [0, 0, 0],
    wind: [0, 0, 0],
    dragLinear: 0,
    dragQuadratic: 0,
    buoyancy: 0,
    up: [0, 1, 0],
    turbulence: 'none',
    turbulenceStrength: 0,
    turbulenceFrequency: 1,
    turbulenceEvolve: 0.2,
    turbulenceOctaves: dimension === 2 ? 2 : 1,
    turbulenceEvery: 1,
    points: [],
    field: 'none',
    fieldCoupling: 1,
    fieldMapping: IDENTITY_FIELD_MAPPING,
  };
}

export function defaultHeat(): Heat {
  return { cooling: 'none', rate: 0, ambient: 300, deathTemperature: 0 };
}

/**
 * The field mapping for a 2D overlay system (`overlayCamera`: x 0..aspect, y 0..1 up, in canvas
 * heights) reading a texture that covers the canvas with uv top-left and velocity in image heights
 * per second, y down: the Epic 6 fluid's `fieldsView` exactly.
 */
export function overlayFieldMapping(aspect: number): FieldMapping {
  return rectFieldMapping({ min: [0, 0], max: [aspect, 1], flipY: true, velocityScale: 1 });
}

/**
 * A texture stretched over the particle-space rectangle `min`..`max` in x and y. `flipY` puts uv row
 * 0 at `max[1]` (a texture whose v grows downwards over a y-up world) and negates the texel's y
 * velocity to match. `velocityScale` converts the texel's units to world units per second.
 */
export function rectFieldMapping(options: {
  min: readonly [number, number];
  max: readonly [number, number];
  flipY?: boolean;
  velocityScale?: number;
}): FieldMapping {
  const { min, max, flipY = false, velocityScale = 1 } = options;
  const sx = 1 / (max[0] - min[0]);
  const sy = 1 / (max[1] - min[1]);
  return {
    u: [sx, 0, 0, -min[0] * sx],
    v: flipY ? [0, -sy, 0, max[1] * sy] : [0, sy, 0, -min[1] * sy],
    x: [velocityScale, 0, 0],
    y: [0, flipY ? -velocityScale : velocityScale, 0],
  };
}
