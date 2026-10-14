import { trackPointers, type MultiPointerTracker } from '../pointer.ts';
import { defineUniformStruct, uniformArray, type UniformBuffer } from '../uniforms.ts';

/*
 * Ignition: where a simulation step adds heat (stories 5.2 and 5.7).
 *
 * A simulation does not care whether heat came from a finger, a stray ember or a script. Each
 * source hands over a short list of igniters per step, the lists are combined, and one uniform
 * block carries them to the step shader, which reads it with ignite.wgsl:
 *
 *   const pointer = createPointerIgnition(canvas);                 // tap, drag, multi-touch
 *   const embers = createAmbientIgnition({ rate: 0.4 });           // keeps the scene alive
 *   const igniters = createUniformBuffer(device, IgnitersUniform, 'igniters');
 *   // each simulation step, of length dt seconds:
 *   writeIgniters(igniters, collectIgniters(dt, pointer, embers), width / height);
 *   igniters.upload();
 *   // step shader: `#include "ignite.wgsl"`, bind `igniters.buffer` as `var<uniform> ig: Igniters`
 *
 * Coordinates are canvas uv (0..1, top-left origin); radii are in canvas heights.
 */

/** Igniters one step can carry; `IGNITE_MAX` in ignite.wgsl. */
export const MAX_IGNITERS = 16;

/** One place heat is added: a point (`from` equals `to`) or the segment a drag covered. */
export interface Igniter {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** Reach, in canvas heights. */
  radius: number;
  /** Heat added on the segment itself; the shader fades it to 0 at `radius`. */
  strength: number;
}

export interface IgnitionSource {
  /** The igniters for the `dt` seconds since the previous call. May be empty. */
  collect(dt: number): Igniter[];
  destroy(): void;
}

/** The uniform block ignite.wgsl declares as `Igniters`; the two must match (it is tested). */
export const IgnitersUniform = defineUniformStruct('Igniters', {
  count: 'u32',
  aspect: 'f32',
  segments: uniformArray('vec4f', MAX_IGNITERS),
  shapes: uniformArray('vec4f', MAX_IGNITERS),
});

/** Concatenates what every source reports for this step, capped at `MAX_IGNITERS`. */
export function collectIgniters(dt: number, ...sources: readonly IgnitionSource[]): Igniter[] {
  const all: Igniter[] = [];
  for (const source of sources) all.push(...source.collect(dt));
  // Earlier sources win when there are too many: list the pointer before the ambient embers.
  return all.slice(0, MAX_IGNITERS);
}

/** Fills the uniform block. Call `upload()` on the buffer afterwards. */
export function writeIgniters(
  uniforms: UniformBuffer<typeof IgnitersUniform.fields>,
  igniters: readonly Igniter[],
  aspect: number,
): void {
  const count = Math.min(igniters.length, MAX_IGNITERS);
  const segments = new Float32Array(MAX_IGNITERS * 4);
  const shapes = new Float32Array(MAX_IGNITERS * 4);
  for (let i = 0; i < count; i++) {
    const igniter = igniters[i]!;
    segments.set([igniter.fromX, igniter.fromY, igniter.toX, igniter.toY], i * 4);
    shapes.set([Math.max(0, igniter.radius), igniter.strength, 0, 0], i * 4);
  }
  uniforms.set({ count, aspect: aspect > 0 ? aspect : 1, segments, shapes });
}

// --- Pointers (story 5.2) ------------------------------------------------------------------------

export interface PointerIgnitionOptions {
  /** Reach of a touch, in canvas heights. Default 0.035. */
  radius?: number;
  /** Heat added under a pressed pointer. Default 1. */
  strength?: number;
  /**
   * Heat added under a pointer that is only hovering, as a share of `strength`. Default 0: fire
   * is lit by a press, a drag or a touch, never by moving the mouse past.
   */
  hover?: number;
  /**
   * Keep a drag that leaves the canvas, and stop touch drags scrolling the page while they are on
   * it. Default true. Turn it off for a full-page background, where scrolling must win.
   */
  capture?: boolean;
}

export interface PointerIgnition extends IgnitionSource {
  /** Live settings: change them from the effect's parameters each frame. */
  radius: number;
  strength: number;
  hover: number;
  /** How many pointers are pressed right now. */
  readonly pressed: number;
}

/**
 * Turns the path one pointer covered into at most `budget` segments by dropping intermediate
 * points evenly; the first and last points are kept, so the stroke stays continuous.
 */
export function pathSegments(
  path: readonly { x: number; y: number }[],
  budget: number,
): [number, number, number, number][] {
  if (path.length === 0 || budget < 1) return [];
  if (path.length === 1) return [[path[0]!.x, path[0]!.y, path[0]!.x, path[0]!.y]];
  const steps = Math.min(budget, path.length - 1);
  const segments: [number, number, number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const a = path[Math.round((i * (path.length - 1)) / steps)]!;
    const b = path[Math.round(((i + 1) * (path.length - 1)) / steps)]!;
    segments.push([a.x, a.y, b.x, b.y]);
  }
  return segments;
}

/** Light on tap, draw fire on drag, several fingers at once. */
export function createPointerIgnition(
  canvas: HTMLCanvasElement,
  options: PointerIgnitionOptions = {},
): PointerIgnition {
  // There is no DOM in the tests and none on a server: the source is then simply silent.
  const tracker: MultiPointerTracker | undefined =
    typeof canvas.addEventListener === 'function'
      ? trackPointers(canvas, { capture: options.capture ?? true })
      : undefined;

  const source: PointerIgnition = {
    radius: options.radius ?? 0.035,
    strength: options.strength ?? 1,
    hover: options.hover ?? 0,
    get pressed() {
      return tracker?.pressedCount ?? 0;
    },
    collect() {
      const pointers = (tracker?.poll() ?? []).filter(
        (pointer) => pointer.down || pointer.justReleased || (source.hover > 0 && pointer.inside),
      );
      if (pointers.length === 0) return [];
      const budget = Math.max(1, Math.floor(MAX_IGNITERS / pointers.length));
      const igniters: Igniter[] = [];
      for (const pointer of pointers) {
        const pressed = pointer.down || pointer.justReleased;
        const strength = source.strength * (pressed ? 1 : source.hover);
        if (strength <= 0) continue;
        for (const [fromX, fromY, toX, toY] of pathSegments(pointer.path, budget)) {
          igniters.push({ fromX, fromY, toX, toY, radius: source.radius, strength });
        }
      }
      return igniters;
    },
    destroy() {
      tracker?.destroy();
    },
  };
  return source;
}

// --- Ambient embers (story 5.7) ------------------------------------------------------------------

export interface AmbientIgnitionOptions {
  /** Embers per second, on average. 0 turns it off. */
  rate: number;
  /** Reach of an ember, in canvas heights. Default 0.02. */
  radius?: number;
  /** Default 1. */
  strength?: number;
  /** Where embers may land, in uv: [x0, y0, x1, y1]. Default the whole canvas. */
  region?: readonly [number, number, number, number];
  /** The same seed gives the same embers at the same times. Default 1. */
  seed?: number;
}

export interface AmbientIgnition extends IgnitionSource {
  /** Live settings. */
  rate: number;
  radius: number;
  strength: number;
  region: readonly [number, number, number, number];
}

/**
 * Stray embers at random places, so a scene that has burnt out lights again and one nobody
 * touches is never dead. Embers arrive at an average `rate` per second, as a Poisson process
 * driven by the simulation's own clock (`dt`), so the pattern does not depend on the frame rate.
 * No more than four land in one step however long the step was.
 */
export function createAmbientIgnition(options: AmbientIgnitionOptions): AmbientIgnition {
  // mulberry32: small, fast, and good enough to scatter embers.
  let state = (options.seed ?? 1) >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Time until the next ember, in units of the mean interval (exponentially distributed).
  let wait = -Math.log(1 - random());

  const source: AmbientIgnition = {
    rate: options.rate,
    radius: options.radius ?? 0.02,
    strength: options.strength ?? 1,
    region: options.region ?? [0, 0, 1, 1],
    collect(dt) {
      if (!(source.rate > 0) || !(dt > 0)) return [];
      wait -= dt * source.rate;
      const igniters: Igniter[] = [];
      while (wait <= 0) {
        wait += -Math.log(1 - random());
        // Draw the position even when the ember is dropped, so the sequence stays the same.
        const [x0, y0, x1, y1] = source.region;
        const x = x0 + (x1 - x0) * random();
        const y = y0 + (y1 - y0) * random();
        if (igniters.length < 4) {
          igniters.push({
            fromX: x,
            fromY: y,
            toX: x,
            toY: y,
            radius: source.radius,
            strength: source.strength,
          });
        }
      }
      return igniters;
    },
    destroy() {},
  };
  return source;
}
