import {
  FLICKER_DEFAULT,
  FLICKER_PERIOD,
  FLICKER_RATE_LIMIT,
  flickerClamp,
  flickerIntensity,
  flickerIntensityUnsafe,
  type FlickerSettings,
} from '../../gpu/emission/flicker.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createRenderTarget } from '../../gpu/targets.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import sceneShader from './scene.wgsl';
import signalsShader from './signals.wgsl';

/** One candle and one trace per light. Seeds are consecutive, so the signals are independent. */
const LIGHTS = 3;

const Params = defineUniformStruct('Params', {
  /** rate, depth, shimmer, shimmer rate: as requested, before any clamping. */
  settings: 'vec4f',
  /** Each light's current intensity from the TypeScript twin, for the pen on its trace. */
  pen: 'vec4f',
  /** Cell width, candle column width and screen margin in cell heights; then one pixel. */
  cell: 'vec4f',
  /** Columns and rows of cells. */
  grid: 'vec2f',
  time: 'f32',
  span: 'f32',
  uncapped: 'f32',
  sway: 'f32',
  seed: 'f32',
  trace_width: 'f32',
});

/** Where the cells, candles and scope screens go for a canvas of this size. Mirrors scene.wgsl. */
function layout(width: number, height: number) {
  const aspect = width / height;
  // A column of rows; a row of columns once the canvas is a wide strip.
  const columns = aspect > 3 ? LIGHTS : 1;
  const rows = LIGHTS / columns;
  const cellHeight = height / rows;
  const cellWidth = width / columns / cellHeight;
  const margin = 0.09;
  const flameWidth = Math.min(Math.max(0.26 * cellWidth, Math.min(0.9, 0.45 * cellWidth)), 1.5);
  // The plot is the screen less the inset that leaves room for the pen (0.055 in scene.wgsl).
  const plotPixels = (cellWidth - margin - flameWidth - 0.055) * cellHeight;
  return {
    grid: [columns, rows] as const,
    cell: [cellWidth, flameWidth, margin, 1 / cellHeight] as const,
    // One trace sample per pixel column, within what any device can allocate.
    traceWidth: Math.min(Math.max(Math.round(plotPixels), 16), 2048),
  };
}

/** Knots of the slow swing per period, as the signal rounds them: its phase is time x this. */
const slowKnots = (rate: number) =>
  4 * Math.floor(Math.min(Math.max(rate, 0), FLICKER_RATE_LIMIT) * (FLICKER_PERIOD / 4) + 0.5);

export const effect = defineEffect({
  meta,
  params: {
    // The ranges run well past the safe caps (4, 1, 0.04, 24) on purpose: with `uncapped` off the
    // signal is clamped, and the trace shows the request (red) against what was delivered (amber).
    rate: {
      type: 'number',
      default: FLICKER_DEFAULT.rate,
      min: 0,
      max: 16,
      step: 0.05,
      label: 'rate (knots/s)',
    },
    depth: { type: 'number', default: FLICKER_DEFAULT.depth, min: 0, max: 1, step: 0.01 },
    shimmer: { type: 'number', default: FLICKER_DEFAULT.shimmer, min: 0, max: 0.5, step: 0.005 },
    shimmerRate: {
      type: 'number',
      default: FLICKER_DEFAULT.shimmerRate,
      min: 0,
      max: 60,
      step: 0.5,
      label: 'shimmer rate (knots/s)',
    },
    sway: { type: 'number', default: 0.6, min: 0, max: 1.5, step: 0.01 },
    seed: { type: 'number', default: 1, min: 0, max: 64, step: 1 },
    span: { type: 'number', default: 6, min: 2, max: 16, step: 0.5, label: 'trace span (s)' },
    // Off by default. On, the candles follow the unclamped request, which at high settings
    // flashes faster than WCAG 2.3.1 allows. No preset turns it on.
    uncapped: { type: 'boolean', default: false, label: 'uncapped (can flash)' },
    ...TAIL_PARAMS,
  },
  presets: {
    hearth: { rate: 1.2, depth: 0.55, shimmer: 0.015, shimmerRate: 8, sway: 0.9, span: 12 },
    'shimmer only': { rate: 0.5, depth: 0.08, shimmer: 0.04, shimmerRate: 24, sway: 0.3, span: 4 },
    // Far outside every cap, with the caps on: the red trace is what was asked for.
    clamped: { rate: 12, depth: 1, shimmer: 0.3, shimmerRate: 40, sway: 1, span: 6 },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'flicker' });
    const uniforms = createUniformBuffer(device, Params, 'flicker params');
    const chunks = { 'params.wgsl': Params.wgsl };

    // A few thousand texels of signal: the only place the noise is evaluated.
    const signals = createRenderTarget(device, {
      label: 'flicker signals',
      format: 'rgba16float',
      width: 16,
      height: LIGHTS,
    });
    const signalsPipeline = createFullscreenPipeline(device, {
      fragment: withChunks(signalsShader, chunks),
      format: signals.format,
    });
    const signalsBind = device.createBindGroup({
      label: 'flicker signals',
      layout: signalsPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniforms.buffer } }],
    });

    const scenePipeline = createFullscreenPipeline(device, {
      fragment: withChunks(sceneShader, chunks),
      format: tail.scene.format,
    });
    let sceneBind: GPUBindGroup | undefined;
    const bindScene = () =>
      device.createBindGroup({
        label: 'flicker scene',
        layout: scenePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms.buffer } },
          { binding: 1, resource: signals.view },
        ],
      });

    // Our own clock, in f64 and wrapped to the signal's period, so the f32 the shader gets
    // always has sub-millisecond resolution and the wrap is seamless.
    let clock = 0;
    let knots = -1;

    return {
      resize(width, height) {
        tail.resize(width, height);
        const { grid, cell, traceWidth } = layout(width, height);
        if (signals.resize(traceWidth, LIGHTS) || !sceneBind) sceneBind = bindScene();
        uniforms.set({ grid, cell, trace_width: traceWidth });
      },
      frame(time, encoder, target) {
        const requested: FlickerSettings = {
          rate: params.rate,
          depth: params.depth,
          shimmer: params.shimmer,
          shimmerRate: params.shimmerRate,
        };
        const live = params.uncapped ? requested : flickerClamp(requested);

        // The signal is a function of time x rate, so a new rate would land every candle on a
        // different part of its curve. Rescale the clock to keep the slow phase where it was;
        // when that would leave the period (after a large cut in rate) the jump is accepted.
        const nextKnots = slowKnots(live.rate);
        if (knots > 0 && nextKnots > 0 && nextKnots !== knots) {
          const rebased = (clock * knots) / nextKnots;
          if (rebased < FLICKER_PERIOD) clock = rebased;
        }
        knots = nextKnots;
        clock = (clock + time.delta) % FLICKER_PERIOD;

        const seed = Math.round(params.seed);
        const pen: [number, number, number, number] = [0, 0, 0, 0];
        for (let light = 0; light < LIGHTS; light++) {
          pen[light] = params.uncapped
            ? flickerIntensityUnsafe(clock, seed + light, requested)
            : flickerIntensity(clock, seed + light, requested);
        }

        uniforms.set({
          settings: [requested.rate, requested.depth, requested.shimmer, requested.shimmerRate],
          pen,
          time: clock,
          span: params.span,
          uncapped: params.uncapped ? 1 : 0,
          sway: params.sway,
          seed,
        });
        uniforms.upload();

        renderFullscreen(encoder, signals.view, signalsPipeline, [signalsBind], {
          timestampWrites: profiler.pass('signals'),
        });
        renderFullscreen(encoder, tail.scene.view, scenePipeline, sceneBind ? [sceneBind] : [], {
          timestampWrites: profiler.pass('scene'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },
      destroy() {
        signals.destroy();
        uniforms.destroy();
        tail.destroy();
      },
    };
  },
});
