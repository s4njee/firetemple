import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import shader from './hello.wgsl';
import { meta } from './meta.ts';

const Params = defineUniformStruct('Params', {
  time: 'f32',
  aspect: 'f32',
  scale: 'f32',
  warp: 'f32',
  falloff: 'f32',
  intensity: 'f32',
  tint: 'vec3f',
});

export const effect = defineEffect({
  meta,
  // Lets a visitor try an extended-range canvas (`&hdr=1`); the tail then writes above SDR white.
  hdr: true,
  params: {
    speed: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    scale: { type: 'number', default: 3, min: 1, max: 12, step: 0.1 },
    warp: { type: 'number', default: 0.5, min: 0, max: 1.5, step: 0.01 },
    falloff: { type: 'number', default: 1.1, min: 0, max: 3, step: 0.01 },
    intensity: { type: 'number', default: 6, min: 0, max: 30, step: 0.1 },
    tint: { type: 'color', default: [1, 0.25, 0.03] },
    ...TAIL_PARAMS,
  },
  presets: {
    embers: { speed: 0.3, falloff: 1.8, intensity: 3, bloom: 0.9 },
    furnace: { speed: 1.6, scale: 5, warp: 0.9, falloff: 0.4, intensity: 14 },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'hello' });
    const uniforms = createUniformBuffer(device, Params, 'hello params');
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const bindGroup = device.createBindGroup({
      label: 'hello',
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniforms.buffer } }],
    });

    // Accumulated rather than `time * speed`, so changing speed never makes the pattern jump.
    let phase = 0;

    return {
      resize(width, height) {
        tail.resize(width, height);
        uniforms.set({ aspect: width / height });
      },
      frame(time, encoder, target) {
        phase += time.delta * params.speed;
        uniforms.set({
          time: phase,
          scale: params.scale,
          warp: params.warp,
          falloff: params.falloff,
          intensity: params.intensity,
          tint: params.tint,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('noise'),
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
