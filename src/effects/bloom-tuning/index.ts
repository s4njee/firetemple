import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import {
  bloomLevelsForSize,
  createHdrTail,
  DEFAULT_BLOOM,
  MAX_BLOOM_LEVELS,
  POST_VIEWS,
  TAIL_PARAMS,
  type HdrTail,
  type PostView,
} from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import shader from './scene.wgsl';

const Params = defineUniformStruct('Params', {
  resolution: 'vec2f',
  time: 'f32',
});

const isView = (value: string): value is PostView =>
  (POST_VIEWS as readonly string[]).includes(value);

export const effect = defineEffect({
  meta,
  params: {
    ...TAIL_PARAMS,
    knee: {
      type: 'number',
      default: DEFAULT_BLOOM.knee,
      min: 0,
      max: 2,
      step: 0.01,
      label: 'bloom knee',
    },
    // A positive value is a level count, which is what a cost sweep wants. 0 and below are relative
    // to the count the tail picks for this canvas size, so presets look the same at any size.
    levels: {
      type: 'number',
      default: 0,
      min: -2,
      max: MAX_BLOOM_LEVELS,
      step: 1,
      label: 'bloom levels (0 auto, -1 one fewer)',
    },
    fullResolution: { type: 'boolean', default: false, label: 'full-resolution bloom' },
    fireflyFilter: { type: 'boolean', default: true, label: 'firefly filter' },
    view: { type: 'select', default: 'final', options: POST_VIEWS },
    speed: { type: 'number', default: 1, min: 0, max: 4, step: 0.01 },
  },
  presets: {
    none: { bloom: 0 },
    // The least that still reads as heat: one level fewer than automatic, at half resolution.
    minimal: { bloom: 0.6, bloomThreshold: 1, bloomRadius: 0.7, knee: 0.5, levels: -1 },
    default: {
      bloom: TAIL_PARAMS.bloom.default,
      bloomThreshold: TAIL_PARAMS.bloomThreshold.default,
      bloomRadius: TAIL_PARAMS.bloomRadius.default,
      knee: DEFAULT_BLOOM.knee,
      levels: 0,
      fullResolution: false,
    },
    heavy: {
      bloom: 1.2,
      bloomThreshold: 0.8,
      bloomRadius: 0.85,
      knee: 0.8,
      levels: 0,
      fullResolution: false,
    },
  },

  async create({ device, format, hdr, params, profiler }) {
    // Half or full resolution is fixed when the bloom chain is built, so switching rebuilds the tail.
    let fullResolution = params.fullResolution;
    let size: [number, number] = [1, 1];
    const makeTail = (): HdrTail => {
      const made = createHdrTail(device, {
        format,
        hdr,
        bloomHalfResolution: !fullResolution,
        label: 'bloom-tuning',
      });
      made.resize(size[0], size[1]);
      return made;
    };
    let tail = makeTail();

    const uniforms = createUniformBuffer(device, Params, 'bloom-tuning params');
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const bindGroup = device.createBindGroup({
      label: 'bloom-tuning',
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniforms.buffer } }],
    });

    let phase = 0;

    return {
      resize(width, height) {
        size = [width, height];
        tail.resize(width, height);
        uniforms.set({ resolution: size });
      },
      frame(time, encoder, target) {
        if (params.fullResolution !== fullResolution) {
          fullResolution = params.fullResolution;
          tail.destroy();
          tail = makeTail();
        }
        phase += time.delta * params.speed;
        uniforms.set({ time: phase });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('chart'),
        });
        // The tail's shared controls cover intensity, threshold and radius; the rest of the bloom
        // settings are this effect's own and go in as overrides.
        tail.encode(encoder, target, time, params, profiler, {
          bloom: {
            knee: params.knee,
            levels:
              params.levels > 0
                ? params.levels
                : Math.max(1, bloomLevelsForSize(...size, !fullResolution) + params.levels),
            fireflyFilter: params.fireflyFilter,
          },
          output: { view: isView(params.view) ? params.view : 'final' },
        });
      },
      destroy() {
        uniforms.destroy();
        tail.destroy();
      },
    };
  },
});
