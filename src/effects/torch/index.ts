import {
  getNoiseTexture,
  NOISE_TEXTURE_CELLS,
  NOISE_TEXTURE_SIZE,
} from '../../gpu/emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct, uniformArray } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import shader from './torches.wgsl';

/** Most flames one canvas draws: the length of the uniform array. */
export const MAX_FLAMES = 48;

const Params = defineUniformStruct('Params', {
  /** Columns and rows of cells. */
  grid: 'vec2f',
  /** One cell, in canvas heights. */
  cell: 'vec2f',
  /** Flame half width, tip half width (0 = a teardrop), erosion, how soft the base is. */
  shape: 'vec4f',
  /** Height of the flame's base in the item, and the flame's height. Item heights. */
  base: 'vec2f',
  /** Whole tiles the sway and the tongue layers travel per loop. */
  cycles: 'vec2f',
  /** One item, in canvas heights; the gap under it; one pixel, in item heights. */
  unit: 'f32',
  foot: 'f32',
  pixel: 'f32',
  /** Flames in the last row. */
  last_row: 'f32',
  style: 'f32',
  kind: 'f32',
  phase: 'f32',
  variety: 'f32',
  turbulence: 'f32',
  intensity: 'f32',
  ambient: 'f32',
  lod: 'f32',
  /** Per flame: flicker level, place in the loop (0..1), size, lean (-1..1). */
  flames: uniformArray('vec4f', MAX_FLAMES),
});

const STYLES = ['torch', 'brazier', 'bare'] as const;
type Style = (typeof STYLES)[number];
/** The ramps of ramp.wgsl, in the order of its RAMP_* constants. */
const FUELS = ['fire', 'gas', 'copper', 'sodium', 'potassium', 'lithium'] as const;

/** Width of one item's box over its height. */
const ITEM_ASPECT = 0.62;

interface Shape {
  /** Height of the flame's base in the item and the flame's height, in item heights. */
  base: number;
  height: number;
  /** In flame heights. `tip` 0 is a teardrop, otherwise a taper with an open base. */
  halfWidth: number;
  tip: number;
  erosion: number;
  baseSoft: number;
}

const SHAPES: Record<Style, Shape> = {
  torch: { base: 0.365, height: 0.635, halfWidth: 0.24, tip: 0, erosion: 0.8, baseSoft: 0.6 },
  brazier: { base: 0.335, height: 0.665, halfWidth: 0.32, tip: 0.05, erosion: 0.95, baseSoft: 0.2 },
  bare: { base: 0.04, height: 0.96, halfWidth: 0.25, tip: 0, erosion: 0.8, baseSoft: 0.7 },
};

export interface TorchLayout {
  columns: number;
  rows: number;
  /** Flames in the last row, which is centred. */
  lastRow: number;
  /** Height of one item, in canvas heights, before `size`. */
  unit: number;
}

/** The grid that draws `count` items largest in a canvas of this aspect. */
export function torchLayout(count: number, aspect: number): TorchLayout {
  let best: TorchLayout = { columns: 1, rows: count, lastRow: 1, unit: 0 };
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const unit = Math.min(1 / rows, aspect / columns / ITEM_ASPECT);
    if (unit > best.unit + 1e-9) {
      best = { columns, rows, lastRow: count - columns * (rows - 1), unit };
    }
  }
  return best;
}

/** `flame_sd_teardrop` of flame.wgsl, for a flame of height 1. */
function teardropDistance(x: number, y: number, r: number): number {
  const qx = Math.abs(x);
  const qy = y - r;
  const rise = 1 - r;
  const sin = r / rise;
  const cos = Math.sqrt(Math.max(1 - sin * sin, 0));
  const along = -qx * sin + qy * cos;
  if (along < 0) return Math.hypot(qx, qy) - r;
  if (along > cos * rise) return Math.hypot(qx, qy - rise);
  return qx * cos + qy * sin - r;
}

/**
 * Share of the canvas on which the shader fetches noise (twice per pixel), for this count, aspect
 * and settings: the number the cost of the scene pass follows. `box` is the share inside some
 * flame's bounding box (`flame_reach`), `fetched` the part of it that survives the distance test
 * in `torch_heat`, counted on a grid; the brazier's taper has no such test, so both are the box.
 */
export function flameShare(
  count: number,
  aspect: number,
  style: Style = 'torch',
  size = 0.92,
  turbulence = 0.6,
): { box: number; fetched: number } {
  const shape = SHAPES[style];
  const unit = torchLayout(count, aspect).unit * size;
  // Flame space, height 1. flame_reach: |x| < half_width * (1 + turbulence * t^1.4), 0 < t < 1.
  const travel = turbulence * shape.halfWidth;
  const reach = (t: number) => shape.halfWidth + travel * t ** 1.4;
  const STEPS = 200;
  let box = 0;
  let fetched = 0;
  for (let j = 0; j < STEPS; j++) {
    const t = (j + 0.5) / STEPS;
    const width = reach(t);
    box += (2 * width) / STEPS;
    for (let i = 0; i < STEPS; i++) {
      const x = ((i + 0.5) / STEPS) * width;
      const lit = shape.tip > 0 || teardropDistance(x, t, shape.halfWidth) <= travel * t ** 1.4;
      if (lit) fetched += (2 * width) / STEPS / STEPS;
    }
  }
  // From flame heights squared to a share of the canvas. Every flame is counted at full size;
  // with `variety` 1 they average 0.91 of it, so this is an upper bound.
  const scale = (count * (shape.height * unit) ** 2) / aspect;
  return { box: box * scale, fetched: fetched * scale };
}

/** mulberry32: a small seeded generator, so a seed always gives the same set of flames. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What makes each flame itself: fixed for a seed. All in 0..1. */
interface Character {
  place: number;
  size: number;
  a: number;
  b: number;
  c: number;
}

function characters(seed: number): Character[] {
  const next = random(Math.round(seed) * 7919 + 17);
  return Array.from({ length: MAX_FLAMES }, () => ({
    place: next(),
    size: next(),
    a: next(),
    b: next(),
    c: next(),
  }));
}

const TAU = 2 * Math.PI;

export const effect = defineEffect({
  meta,
  params: {
    count: { type: 'number', default: 12, min: 1, max: MAX_FLAMES, step: 1 },
    style: { type: 'select', default: 'torch', options: STYLES },
    fuel: { type: 'select', default: 'fire', options: FUELS },
    size: { type: 'number', default: 0.92, min: 0.4, max: 1, step: 0.01 },
    variety: { type: 'number', default: 1, min: 0, max: 1, step: 0.01 },
    turbulence: { type: 'number', default: 0.6, min: 0, max: 1.2, step: 0.01 },
    loop: { type: 'number', default: 3, min: 3, max: 8, step: 0.5, label: 'loop (s)' },
    speed: { type: 'number', default: 1, min: 0, max: 1.5, step: 0.01 },
    seed: { type: 'number', default: 1, min: 0, max: 99, step: 1 },
    intensity: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    holder: { type: 'number', default: 1, min: 0, max: 4, step: 0.05, label: 'holder light' },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    'wall torches': { count: 6, style: 'torch' },
    braziers: { count: 4, style: 'brazier', turbulence: 0.5, loop: 4 },
    'list markers': { count: 36, style: 'bare', size: 0.8, bloom: 0.4 },
    'blue fire': { count: 8, style: 'brazier', fuel: 'gas', turbulence: 0.35 },
    'one torch': { count: 1, style: 'torch' },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'torch' });
    const uniforms = createUniformBuffer(device, Params, 'torch params');
    const noise = getNoiseTexture(device);
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const bindGroup = device.createBindGroup({
      label: 'torch',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniforms.buffer } },
        { binding: 1, resource: noise.view },
        { binding: 2, resource: noise.sampler },
      ],
    });

    const flames = new Float32Array(MAX_FLAMES * 4);
    let seed = Number.NaN;
    let cast: Character[] = [];
    let aspect = 1;
    let pixels = 1;
    // Place in the loop, 0..1. Everything that moves is a function of this alone.
    let phase = 0;

    return {
      resize(width, height) {
        tail.resize(width, height);
        aspect = width / height;
        pixels = height;
      },
      frame(time, encoder, target) {
        const period = Math.max(params.loop, 3);
        phase = (phase + (time.delta * params.speed) / period) % 1;
        if (params.seed !== seed) {
          seed = params.seed;
          cast = characters(seed);
        }

        const count = Math.min(Math.max(Math.round(params.count), 1), MAX_FLAMES);
        const style = (STYLES as readonly string[]).includes(params.style)
          ? (params.style as Style)
          : 'torch';
        const shape = SHAPES[style];
        const grid = torchLayout(count, aspect);
        const unit = grid.unit * params.size;
        const cell: [number, number] = [aspect / grid.columns, 1 / grid.rows];

        // Whole cycles per loop, so the loop closes: flicker near 0.7 and 1.3 Hz, lean near 0.35.
        const slow = Math.max(1, Math.round(0.35 * period));
        const mid = Math.max(1, Math.round(0.7 * period));
        const quick = Math.max(2, Math.round(1.3 * period));
        const variety = params.variety;
        for (let i = 0; i < count; i++) {
          const who = cast[i]!;
          const at = phase + variety * who.place;
          // With no variety every flame is the same flame: same place in the loop, same phases.
          const swing =
            0.6 * Math.sin(TAU * (mid * at + variety * who.a)) +
            0.4 * Math.sin(TAU * (quick * at + variety * who.b));
          flames[i * 4] = 1 - 0.06 * (1 - swing);
          flames[i * 4 + 1] = variety * who.place;
          flames[i * 4 + 2] = 1 - 0.18 * variety * who.size;
          flames[i * 4 + 3] = Math.sin(TAU * (slow * at + variety * who.c));
        }

        // Texels of the noise tile per pixel along the flame, for the tongue layer (1.5 cells per
        // flame height): above one, read a coarser mip.
        const flamePixels = shape.height * unit * pixels;
        const texels = (1.5 * NOISE_TEXTURE_SIZE) / NOISE_TEXTURE_CELLS / Math.max(flamePixels, 1);

        uniforms.set({
          grid: [grid.columns, grid.rows],
          cell,
          shape: [shape.halfWidth, shape.tip, shape.erosion, shape.baseSoft],
          base: [shape.base, shape.height],
          // Whole tiles per loop, as many as keep the sway under 2.2 and the tongues under 3 noise
          // cells a second (one tile at least: 2.7 cells a second at the shortest loop). Faster
          // tongues on a large flame start to count as flashes; see the notes.
          cycles: [
            Math.max(1, Math.floor((2.2 * period) / NOISE_TEXTURE_CELLS)),
            Math.max(1, Math.floor((3 * period) / NOISE_TEXTURE_CELLS)),
          ],
          unit,
          foot: 0.5 * (cell[1] - unit),
          pixel: 1 / (pixels * unit),
          last_row: grid.lastRow,
          style: STYLES.indexOf(style),
          kind: Math.max(0, (FUELS as readonly string[]).indexOf(params.fuel)),
          phase,
          variety,
          turbulence: params.turbulence,
          intensity: params.intensity,
          ambient: params.holder,
          lod: Math.max(0, Math.log2(texels)),
          flames,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('flames'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },
      destroy() {
        uniforms.destroy();
        tail.destroy();
      },
    };
  },
});
