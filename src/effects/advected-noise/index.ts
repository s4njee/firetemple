import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import shader from './scene.wgsl';

const Params = defineUniformStruct('Params', {
  resolution: 'vec2f',
  cells: 'vec2f',
  drift: 'f32',
  clock: 'f32',
  spin: 'f32',
  boil: 'f32',
  scale: 'f32',
  warp: 'f32',
  advection: 'f32',
  curl: 'f32',
  flow: 'f32',
  cycle: 'f32',
  falloff: 'f32',
  intensity: 'f32',
  dividerPx: 'f32',
  labelPx: 'f32',
  mode: 'i32',
  variant: 'i32',
});

/** Strip order in `compare`, and the `variant` index the shader switches on. */
const VARIANTS = ['scroll', 'warp', 'flow noise', 'curl', 'two-phase', 'curl + flow'] as const;
const MODES = ['compare', ...VARIANTS, 'split'] as const;

/**
 * The accumulators are wrapped so a tab left open for hours keeps its float precision, at the price
 * of one jump each time: the drift (in strip heights) every 43 minutes at the default speed, the
 * clocks about once an hour.
 */
const WRAP_DRIFT = 1024;
const WRAP_CLOCK = 4096;

export const effect = defineEffect({
  meta,
  params: {
    mode: { type: 'select', default: 'compare', options: MODES },
    split: {
      type: 'select',
      default: 'curl + flow',
      options: VARIANTS.slice(1),
      label: 'split: scroll against',
    },
    speed: { type: 'number', default: 0.4, min: 0, max: 2, step: 0.01, label: 'rise speed' },
    scale: { type: 'number', default: 4, min: 1, max: 12, step: 0.1 },
    evolve: { type: 'number', default: 1, min: 0, max: 3, step: 0.01, label: 'evolution rate' },
    boil: { type: 'number', default: 0, min: 0, max: 2, step: 0.01, label: 'scroll: evolution' },
    warp: { type: 'number', default: 0.4, min: 0, max: 1.5, step: 0.01, label: 'warp: strength' },
    rotation: { type: 'number', default: 2.7, min: 0, max: 6, step: 0.01, label: 'flow: rotation' },
    advection: {
      type: 'number',
      default: 0.12,
      min: 0,
      max: 0.5,
      step: 0.005,
      label: 'flow: advection',
    },
    curl: { type: 'number', default: 0.4, min: 0, max: 1.5, step: 0.01, label: 'curl: strength' },
    flow: {
      type: 'number',
      default: 0.5,
      min: 0,
      max: 1.5,
      step: 0.01,
      label: 'two-phase: flow speed',
    },
    cycle: { type: 'number', default: 2, min: 0.5, max: 6, step: 0.05, label: 'two-phase: cycle' },
    falloff: { type: 'number', default: 0.9, min: 0, max: 3, step: 0.01 },
    intensity: { type: 'number', default: 1, min: 0, max: 4, step: 0.01 },
    labels: { type: 'boolean', default: true },
    ...TAIL_PARAMS,
  },
  presets: {
    compare: { mode: 'compare' },
    'split against scroll': { mode: 'split', split: 'curl + flow' },
    // What each mechanism does on its own: nothing rises, so the scroll strip is a still image.
    'no rise': { mode: 'compare', speed: 0 },
    // Every amount past its useful range: smeared fibres, a net of creases, a folding blend.
    'too much': { mode: 'compare', warp: 1, curl: 1, advection: 0.4, flow: 1.5, cycle: 3 },
    backdrop: { mode: 'curl + flow', labels: false, scale: 3, falloff: 0.8, speed: 0.3 },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'advected-noise' });
    const uniforms = createUniformBuffer(device, Params, 'advected-noise params');
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const bindGroup = device.createBindGroup({
      label: 'advected-noise',
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniforms.buffer } }],
    });

    // Accumulated from time.delta rather than computed from time, so no rate slider makes the
    // pattern jump: how far the gas has risen (in strip heights) and three evolution clocks.
    let drift = 0;
    let clock = 0;
    let spin = 0;
    let boil = 0;
    let size: [number, number] = [1, 1];
    let pixelRatio = 1;

    return {
      resize(width, height, dpr) {
        tail.resize(width, height);
        size = [width, height];
        pixelRatio = dpr > 0 ? dpr : 1;
      },
      frame(time, encoder, target) {
        const evolved = time.delta * params.evolve;
        drift = (drift + time.delta * params.speed) % WRAP_DRIFT;
        clock = (clock + evolved) % WRAP_CLOCK;
        spin = (spin + evolved * params.rotation) % (4 * WRAP_CLOCK);
        boil = (boil + evolved * params.boil) % WRAP_CLOCK;

        // Strips side by side, or bands stacked when the frame is taller than it is wide.
        const variant = VARIANTS.indexOf(params.mode as (typeof VARIANTS)[number]);
        const strips =
          params.mode === 'compare' ? VARIANTS.length : params.mode === 'split' ? 2 : 1;
        const stacked = params.mode === 'compare' && size[1] > size[0];
        uniforms.set({
          resolution: size,
          cells: stacked ? [1, strips] : [strips, 1],
          drift,
          clock,
          spin,
          boil,
          scale: params.scale,
          warp: params.warp,
          advection: params.advection,
          curl: params.curl,
          flow: params.flow,
          cycle: params.cycle,
          falloff: params.falloff,
          intensity: params.intensity,
          dividerPx: Math.max(1, Math.round(pixelRatio)),
          labelPx: params.labels ? Math.max(1, Math.round(2 * pixelRatio)) : 0,
          mode: params.mode === 'compare' ? 0 : params.mode === 'split' ? 2 : 1,
          variant:
            params.mode === 'split'
              ? VARIANTS.indexOf(params.split as (typeof VARIANTS)[number])
              : Math.max(variant, 0),
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
