import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import shader from './scene.wgsl';

const Params = defineUniformStruct('Params', {
  time: 'f32',
  aspect: 'f32',
  pixel: 'f32',
  view: 'f32',
  shape: 'f32',
  width: 'f32',
  height: 'f32',
  turbulence: 'f32',
  erosion: 'f32',
  falloff: 'f32',
  intensity: 'f32',
});

/** `stages` is the three panels; the others show one stage over the whole frame. */
const VIEWS = ['stages', 'shape', 'heat', 'flame'] as const;
const SHAPES = ['teardrop', 'taper'] as const;

export const effect = defineEffect({
  meta,
  params: {
    view: { type: 'select', default: 'stages', options: VIEWS },
    shape: { type: 'select', default: 'teardrop', options: SHAPES },
    width: { type: 'number', default: 0.19, min: 0.06, max: 0.45, step: 0.005 },
    height: { type: 'number', default: 0.8, min: 0.3, max: 0.92, step: 0.01 },
    turbulence: { type: 'number', default: 0.6, min: 0, max: 1.5, step: 0.01 },
    erosion: { type: 'number', default: 0.85, min: 0, max: 1.5, step: 0.01 },
    falloff: { type: 'number', default: 0.45, min: 0.1, max: 2, step: 0.01 },
    speed: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    intensity: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    ...TAIL_PARAMS,
  },
  presets: {
    candle: {
      shape: 'teardrop',
      width: 0.15,
      turbulence: 0.35,
      erosion: 0.3,
      falloff: 0.3,
      speed: 0.5,
    },
    campfire: {
      shape: 'taper',
      width: 0.26,
      turbulence: 0.5,
      erosion: 1,
      falloff: 0.5,
      speed: 1.3,
    },
    jet: {
      shape: 'taper',
      width: 0.1,
      height: 0.86,
      turbulence: 0.35,
      erosion: 0.6,
      falloff: 0.35,
      speed: 2.4,
    },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'flame-shape' });
    const uniforms = createUniformBuffer(device, Params, 'flame-shape params');
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const bindGroup = device.createBindGroup({
      label: 'flame-shape',
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniforms.buffer } }],
    });

    // Accumulated rather than `time * speed`, so changing speed never makes the flame jump.
    let phase = 0;

    return {
      resize(width, height) {
        tail.resize(width, height);
        uniforms.set({ aspect: width / height, pixel: 1 / height });
      },
      frame(time, encoder, target) {
        phase += time.delta * params.speed;
        uniforms.set({
          time: phase,
          view: Math.max(0, VIEWS.indexOf(params.view as (typeof VIEWS)[number])),
          shape: params.shape === 'taper' ? 1 : 0,
          width: params.width,
          height: params.height,
          turbulence: params.turbulence,
          erosion: params.erosion,
          falloff: params.falloff,
          intensity: params.intensity,
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
