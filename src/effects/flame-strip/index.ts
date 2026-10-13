import { getNoiseTexture, NOISE_TEXTURE_CELLS } from '../../gpu/emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import shader from './strip.wgsl';

const Params = defineUniformStruct('Params', {
  rise: 'f32',
  rise_slow: 'f32',
  clock: 'f32',
  aspect: 'f32',
  flame: 'f32',
  count: 'f32',
  tiles: 'f32',
  tiles_warp: 'f32',
  gap: 'f32',
  bed: 'f32',
  uneven: 'f32',
  sway: 'f32',
  erosion: 'f32',
  intensity: 'f32',
});

/** Noise cells the pattern climbs per second at speed 1. */
const RISE_PER_SECOND = 1.1;
/** The second noise layer climbs at this share of the speed (as `noisetex_flame` does). */
const SLOW_SHARE = 0.6;
/** Noise cells across one flame height, before snapping to a whole number of tiles. */
const CELLS_PER_FLAME = 4;
/** Seconds after which every tongue's breathing repeats exactly. */
const BREATH_PERIOD = 64;
/**
 * A strip is never taller than this share of the canvas width, so in a tall canvas (a hero, a
 * phone in portrait) it stays a band along the bottom edge instead of becoming a wall.
 */
const MAX_HEIGHT_OF_WIDTH = 0.16;

/**
 * How the strip is laid out across a canvas of the given aspect (width / height): the flame
 * height in canvas heights, and the whole numbers that make it tile.
 */
export function stripLayout(aspect: number, height: number, density: number) {
  const flame = Math.max(0.01, Math.min(height, MAX_HEIGHT_OF_WIDTH * aspect));
  /** Canvas width in flame heights. */
  const span = aspect / flame;
  const tiles = Math.max(1, Math.round((span * CELLS_PER_FLAME) / NOISE_TEXTURE_CELLS));
  return {
    flame,
    /** Crests across the width. */
    count: Math.max(2, Math.round(span * density)),
    /** Repeats of the noise tile across the width. */
    tiles,
    /**
     * Repeats of the slower layer that displaces it: one fewer (a coarser layer), or two when
     * there is only one tile. Consecutive whole numbers share no factor, so the pair repeats
     * once per canvas width and not sooner.
     */
    warpTiles: tiles > 1 ? tiles - 1 : 2,
  };
}

export const effect = defineEffect({
  meta,
  params: {
    height: { type: 'number', default: 0.85, min: 0.1, max: 1, step: 0.01 },
    density: { type: 'number', default: 1, min: 0.3, max: 4, step: 0.05, label: 'crests' },
    uneven: { type: 'number', default: 0.3, min: 0, max: 0.8, step: 0.01 },
    gap: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.01 },
    bed: { type: 'number', default: 0.16, min: 0, max: 0.6, step: 0.01 },
    sway: { type: 'number', default: 0.8, min: 0, max: 1.5, step: 0.01 },
    erosion: { type: 'number', default: 1, min: 0, max: 2, step: 0.01 },
    speed: { type: 'number', default: 1, min: 0, max: 1.5, step: 0.01 },
    intensity: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    strip: {
      height: 0.85,
      density: 1,
      uneven: 0.3,
      gap: 0.25,
      bed: 0.16,
      sway: 0.8,
      erosion: 1,
      speed: 1,
      intensity: 1,
    },
    'ember line': {
      height: 0.35,
      density: 2.5,
      uneven: 0.5,
      gap: 0.5,
      bed: 0.35,
      sway: 0.5,
      erosion: 1.4,
      speed: 0.6,
      intensity: 0.4,
    },
    'fire wall': {
      height: 1,
      density: 0.7,
      uneven: 0.2,
      gap: 0.1,
      bed: 0.3,
      sway: 1,
      erosion: 0.85,
      speed: 1,
      intensity: 1.1,
    },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'flame-strip' });
    const noise = getNoiseTexture(device);
    const uniforms = createUniformBuffer(device, Params, 'flame-strip params');
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const bindGroup = device.createBindGroup({
      label: 'flame-strip',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniforms.buffer } },
        { binding: 1, resource: noise.view },
        { binding: 2, resource: noise.sampler },
      ],
    });

    let aspect = 1;
    // Accumulated, so changing speed never makes the flames jump, and wrapped on the tile's own
    // period, so the shader never sees a large number and the wrap cannot be seen.
    let rise = 0;
    let riseSlow = 0;
    let seconds = 0;

    return {
      resize(width, height) {
        tail.resize(width, height);
        aspect = width / height;
      },
      frame(time, encoder, target) {
        const climb = time.delta * params.speed * RISE_PER_SECOND;
        rise = (rise + climb) % NOISE_TEXTURE_CELLS;
        riseSlow = (riseSlow + climb * SLOW_SHARE) % NOISE_TEXTURE_CELLS;
        seconds = (seconds + time.delta * Math.min(params.speed, 1)) % BREATH_PERIOD;
        const layout = stripLayout(aspect, params.height, params.density);
        uniforms.set({
          rise,
          rise_slow: riseSlow,
          clock: seconds / BREATH_PERIOD,
          aspect,
          flame: layout.flame,
          count: layout.count,
          tiles: layout.tiles,
          tiles_warp: layout.warpTiles,
          gap: params.gap,
          bed: params.bed,
          uneven: params.uneven,
          sway: params.sway,
          erosion: params.erosion,
          intensity: params.intensity,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('strip'),
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
