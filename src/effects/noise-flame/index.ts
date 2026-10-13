import { getNoiseTexture } from '../../gpu/emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import shader from './scene.wgsl';

const Params = defineUniformStruct('Params', {
  rise: 'f32',
  aspect: 'f32',
  height: 'f32',
  scale: 'f32',
  ragged: 'f32',
  intensity: 'f32',
  noise_kind: 'f32',
  octaves: 'f32',
  warp: 'f32',
});

/**
 * Where the noise comes from; the index is `NF_*` in sources.wgsl. `texture` is the shared baked
 * tile (two fetches). The others are computed at every flame pixel: three fractal sums of
 * `octaves` evaluations each, or one with the warp off.
 */
const NOISES = ['texture', 'value', 'simplex', 'voronoi', 'gradient fbm'] as const;

/** Noise cells the pattern climbs per second at speed 1. */
const RISE_PER_SECOND = 1.1;
/**
 * The climb wraps here so the shader never sees a large number. A multiple of 40 cells, the
 * exact period of `noisetex_flame` in its rise (the tile is 8 cells and its second layer climbs
 * at 0.6 of the speed), so the default source wraps without a seam.
 */
const RISE_PERIOD = 4000;

export const effect = defineEffect({
  meta,
  params: {
    noise: { type: 'select', default: 'texture', options: NOISES },
    octaves: { type: 'number', default: 4, min: 1, max: 6, step: 1 },
    warp: { type: 'boolean', default: true, label: 'domain warp' },
    height: { type: 'number', default: 0.62, min: 0.15, max: 1.4, step: 0.01 },
    scale: { type: 'number', default: 3.2, min: 1, max: 8, step: 0.1, label: 'tongues' },
    ragged: { type: 'number', default: 1.5, min: 0, max: 3, step: 0.01 },
    speed: { type: 'number', default: 1, min: 0, max: 1.5, step: 0.01 },
    intensity: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    wall: { height: 0.62, scale: 3.2, ragged: 1.5, speed: 1, intensity: 1 },
    'low burn': { height: 0.3, scale: 3.6, ragged: 1.1, speed: 0.8, intensity: 0.8 },
    inferno: { height: 1.15, scale: 2.6, ragged: 1.9, speed: 0.7, intensity: 1.2 },
    // The comparison of story 4.1: the same flame from each noise source.
    'value noise': { noise: 'value' },
    simplex: { noise: 'simplex' },
    voronoi: { noise: 'voronoi' },
    'gradient fbm': { noise: 'gradient fbm' },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'noise-flame' });
    const noise = getNoiseTexture(device);
    const uniforms = createUniformBuffer(device, Params, 'noise-flame params');
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const bindGroup = device.createBindGroup({
      label: 'noise-flame',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniforms.buffer } },
        { binding: 1, resource: noise.view },
        { binding: 2, resource: noise.sampler },
      ],
    });

    // Accumulated rather than `time * speed`, so changing speed never makes the flames jump.
    let rise = 0;

    return {
      resize(width, height) {
        tail.resize(width, height);
        uniforms.set({ aspect: width / height });
      },
      frame(time, encoder, target) {
        rise = (rise + time.delta * params.speed * RISE_PER_SECOND) % RISE_PERIOD;
        uniforms.set({
          rise,
          height: Math.max(params.height, 0.01),
          scale: params.scale,
          ragged: params.ragged,
          intensity: params.intensity,
          noise_kind: Math.max(0, NOISES.indexOf(params.noise as (typeof NOISES)[number])),
          octaves: params.octaves,
          warp: params.warp ? 1 : 0,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('flame'),
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
