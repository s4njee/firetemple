import { createBlackbodyLut } from '../../gpu/emission/blackbody-lut.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct, uniformArray } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import shader from './chart.wgsl';
import { meta } from './meta.ts';

const MAX_TICKS = 8;

const Params = defineUniformStruct('Params', {
  resolution: 'vec2f',
  t_lo: 'f32',
  t_hi: 'f32',
  t_ref: 'f32',
  gamma: 'f32',
  intensity: 'f32',
  error_gain: 'f32',
  view: 'u32',
  tick_count: 'u32',
  ticks: uniformArray('vec4f', MAX_TICKS),
});

const VIEWS = ['compare', 'colour', 'radiance', 'error', 'intensity'] as const;
const LUT_WIDTHS = ['8', '16', '32', '64', '256'] as const;

/** Temperature span of the horizontal axis, and where its labels go: [kelvin, alignment]. */
const RANGES = {
  '800-12000 K': {
    lo: 800,
    hi: 12000,
    ticks: [
      [800, -1],
      [1000, 0],
      [1200, 0],
      [1500, 0],
      [2000, 0],
      [3000, 0],
      [5000, 0],
      [12000, 1],
    ],
  },
  '800-2400 K': {
    lo: 800,
    hi: 2400,
    ticks: [
      [800, -1],
      [900, 0],
      [1000, 0],
      [1200, 0],
      [1500, 0],
      [1800, 0],
      [2100, 0],
      [2400, 1],
    ],
  },
} as const;
type RangeName = keyof typeof RANGES;
const RANGE_NAMES = Object.keys(RANGES) as RangeName[];

export const effect = defineEffect({
  meta,
  params: {
    view: { type: 'select', default: 'compare', options: VIEWS },
    range: { type: 'select', default: '800-2400 K', options: RANGE_NAMES },
    lutWidth: { type: 'select', default: '64', options: LUT_WIDTHS, label: 'lookup texels' },
    tRef: { type: 'number', default: 2000, min: 1000, max: 6500, step: 50, label: 'reference K' },
    gamma: { type: 'number', default: 0.4, min: 0.05, max: 1, step: 0.01 },
    intensity: {
      type: 'number',
      default: 2,
      min: 0,
      max: 20,
      step: 0.1,
      label: 'radiance at reference',
    },
    errorGain: { type: 'number', default: 32, min: 1, max: 256, step: 1, label: 'error gain' },
    ...TAIL_PARAMS,
  },
  presets: {
    'fire range': { range: '800-2400 K', tRef: 2000, intensity: 2, gamma: 0.4 },
    'full range': { range: '800-12000 K', tRef: 3000, intensity: 1 },
    'tiny lookup': { range: '800-12000 K', tRef: 3000, lutWidth: '8', errorGain: 8 },
    physical: { gamma: 1, tRef: 2400, intensity: 12 },
    'intensity curves': { view: 'intensity' },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'blackbody' });
    const uniforms = createUniformBuffer(device, Params, 'blackbody params');
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const sampler = device.createSampler({
      label: 'blackbody lut sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    let lut: GPUTexture | undefined;
    let lutWidth = '';
    let bindGroup: GPUBindGroup | undefined;

    // The table is 512 bytes at the default width, so re-baking when the control moves is free.
    const ensureLut = () => {
      if (lut && lutWidth === params.lutWidth) return;
      lut?.destroy();
      lutWidth = params.lutWidth;
      lut = createBlackbodyLut(device, { width: Number(lutWidth), label: 'blackbody lut' });
      bindGroup = device.createBindGroup({
        label: 'blackbody',
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms.buffer } },
          { binding: 1, resource: lut.createView() },
          { binding: 2, resource: sampler },
        ],
      });
    };

    return {
      resize(width, height) {
        tail.resize(width, height);
        uniforms.set({ resolution: [width, height] });
      },
      frame(time, encoder, target) {
        ensureLut();
        const range = RANGES[params.range as RangeName] ?? RANGES['800-2400 K'];
        uniforms.set({
          t_lo: range.lo,
          t_hi: range.hi,
          t_ref: params.tRef,
          gamma: params.gamma,
          intensity: params.intensity,
          error_gain: params.errorGain,
          view: Math.max(0, VIEWS.indexOf(params.view as (typeof VIEWS)[number])),
          tick_count: range.ticks.length,
          ticks: range.ticks.flatMap(([kelvin, align]) => [kelvin, align, 0, 0]),
        });
        uniforms.upload();
        if (bindGroup) {
          renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
            timestampWrites: profiler.pass('chart'),
          });
        }
        tail.encode(encoder, target, time, params, profiler);
      },
      destroy() {
        lut?.destroy();
        uniforms.destroy();
        tail.destroy();
      },
    };
  },
});
