import {
  createRampTexture,
  rampBlackbody,
  rampFromStops,
  RAMPS,
  type RampFn,
} from '../../gpu/emission/ramp-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import shader from './ramps.wgsl';

const Params = defineUniformStruct('Params', {
  resolution: 'vec2f',
  time: 'f32',
  intensity: 'f32',
  t_cold: 'f32',
  t_hot: 'f32',
  whiten_knee: 'f32',
  source: 'u32',
  view: 'u32',
});

/**
 * A ramp no formula gives: four flat bands with hard edges, for cel-shaded fire. Authored as
 * colour stops (two stops at the same heat make the step) and only ever sampled from the texture.
 */
const TOON = rampFromStops([
  { at: 0, color: [0, 0, 0] },
  { at: 0.16, color: [0, 0, 0] },
  { at: 0.16, color: [1.1, 0.04, 0.0] },
  { at: 0.4, color: [1.1, 0.04, 0.0] },
  { at: 0.4, color: [4.5, 0.8, 0.02] },
  { at: 0.64, color: [4.5, 0.8, 0.02] },
  { at: 0.64, color: [10, 5.5, 0.3] },
  { at: 0.86, color: [10, 5.5, 0.3] },
  { at: 0.86, color: [16, 14, 9] },
  { at: 1, color: [16, 14, 9] },
]);

// The panels, left to right; also the rows of the ramp texture. ramps.wgsl relies on the order.
const PANELS = [
  'blackbody',
  'fire',
  'toon',
  'gas',
  'copper',
  'sodium',
  'potassium',
  'lithium',
] as const;
const VIEWS = ['all', ...PANELS] as const;
const SOURCES = ['formula', 'texture', 'split'] as const;
const WIDTHS = ['4', '8', '16', '64', '256'] as const;

// The scroll and evolution rates differ, so this is only a rare one-frame change of a restless
// pattern; it keeps the noise coordinates small enough for f32 over a long visit.
const TIME_WRAP = 4096;

export const effect = defineEffect({
  meta,
  params: {
    view: { type: 'select', default: 'all', options: VIEWS },
    source: { type: 'select', default: 'formula', options: SOURCES },
    textureWidth: { type: 'select', default: '64', options: WIDTHS, label: 'texture texels' },
    intensity: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    speed: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    tCold: {
      type: 'number',
      default: 1000,
      min: 500,
      max: 1500,
      step: 10,
      label: 'blackbody cold K',
    },
    tHot: {
      type: 'number',
      default: 2000,
      min: 1200,
      max: 4000,
      step: 10,
      label: 'blackbody hot K',
    },
    whiten: { type: 'boolean', default: true, label: 'whiten blackbody highlights' },
    whitenKnee: { type: 'number', default: 6, min: 1, max: 40, step: 0.5, label: 'whiten knee' },
    ...TAIL_PARAMS,
  },
  presets: {
    'all ramps': { view: 'all', source: 'formula' },
    campfire: { view: 'fire', bloom: 0.8 },
    'gas burner': { view: 'gas', speed: 1.4 },
    'copper green': { view: 'copper' },
    'blackbody, physical': { view: 'blackbody', whiten: false },
    'tiny texture': { source: 'split', textureWidth: '8' },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'flame-ramps' });
    const uniforms = createUniformBuffer(device, Params, 'flame-ramps params');
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const sampler = device.createSampler({
      label: 'flame-ramps sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    let texture: GPUTexture | undefined;
    let bindGroup: GPUBindGroup | undefined;
    let baked = '';

    // Eight rows of at most 256 half-float texels: re-baking when a control moves costs nothing.
    const ensureTexture = () => {
      const key = `${params.textureWidth}/${params.tCold}/${params.tHot}`;
      if (texture && key === baked) return;
      baked = key;
      texture?.destroy();
      const rows: RampFn[] = [
        rampBlackbody(params.tCold, params.tHot),
        RAMPS.fire,
        TOON,
        RAMPS.gas,
        RAMPS.copper,
        RAMPS.sodium,
        RAMPS.potassium,
        RAMPS.lithium,
      ];
      texture = createRampTexture(device, rows, {
        width: Number(params.textureWidth),
        label: 'flame-ramps texture',
      });
      bindGroup = device.createBindGroup({
        label: 'flame-ramps',
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms.buffer } },
          { binding: 1, resource: texture.createView() },
          { binding: 2, resource: sampler },
        ],
      });
    };

    // Accumulated rather than `time * speed`, so changing speed never makes the flame jump.
    let phase = 0;

    return {
      resize(width, height) {
        tail.resize(width, height);
        uniforms.set({ resolution: [width, height] });
      },
      frame(time, encoder, target) {
        ensureTexture();
        phase = (phase + time.delta * params.speed) % TIME_WRAP;
        uniforms.set({
          time: phase,
          intensity: params.intensity,
          t_cold: params.tCold,
          t_hot: params.tHot,
          whiten_knee: params.whiten ? params.whitenKnee : 0,
          source: Math.max(0, SOURCES.indexOf(params.source as (typeof SOURCES)[number])),
          view: Math.max(0, VIEWS.indexOf(params.view as (typeof VIEWS)[number])),
        });
        uniforms.upload();
        if (bindGroup) {
          renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
            timestampWrites: profiler.pass('flames'),
          });
        }
        tail.encode(encoder, target, time, params, profiler);
      },
      destroy() {
        texture?.destroy();
        uniforms.destroy();
        tail.destroy();
      },
    };
  },
});
