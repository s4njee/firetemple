import { FLICKER_PERIOD, flickerIntensity, flickerOffset } from '../../gpu/emission/flicker.ts';
import { getNoiseTexture, NOISE_TEXTURE_CELLS } from '../../gpu/emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { trackPointers } from '../../gpu/pointer.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import shader from './candle.wgsl';
import { createDraught, stepDraught, type DraughtPointer } from './draught.ts';
import { meta } from './meta.ts';

const Params = defineUniformStruct('Params', {
  aspect: 'f32',
  fit: 'f32',
  /** One pixel, in scene units. */
  pixel: 'f32',
  /** The flame's height this frame, and at rest. Scene units. */
  flame_h: 'f32',
  flame_rest: 'f32',
  /** Half width and height of the wax. */
  body: 'vec2f',
  /** Sideways travel of the lower flame and of its tip, in flame heights. */
  lean: 'f32',
  tip: 'f32',
  wobble: 'f32',
  wobble_phase: 'f32',
  level: 'f32',
  flutter: 'f32',
  rise: 'f32',
  halo: 'f32',
  halo_radius: 'f32',
  intensity: 'f32',
  ambient: 'f32',
  cup: 'f32',
  wax: 'vec3f',
});

/** Canvas aspect below which the scene zooms out, so the leaning flame stays inside. */
const FIT_ASPECT = 0.6;
/** Where the flame leaves the wick and where its middle is, in flame heights above the wax. */
const FOOT = 0.04; // CANDLE_FOOT in candle.wgsl
const MIDDLE = FOOT + 0.45;

export interface CandleLayout {
  /** Scene units are canvas heights divided by `fit`: x from the centre, y up from the bottom. */
  fit: number;
  halfWidth: number;
  /** Height of the wax, which is where the wick starts. */
  top: number;
  /** Flame height at rest. */
  flame: number;
}

/** Where the candle stands for a canvas of this aspect. `candle.wgsl` draws exactly this. */
export function candleLayout(
  aspect: number,
  size: { candleWidth: number; candleHeight: number; size: number },
): CandleLayout {
  return {
    fit: Math.min(1, aspect / FIT_ASPECT),
    halfWidth: 0.5 * size.candleWidth,
    top: size.candleHeight,
    flame: size.size,
  };
}

/** A point of the canvas (0..1, origin top-left) relative to the middle of the flame, in flame heights. */
export function toFlameSpace(
  layout: CandleLayout,
  aspect: number,
  u: number,
  v: number,
): { x: number; y: number } {
  return {
    x: ((u - 0.5) * aspect) / layout.fit / layout.flame,
    y: ((1 - v) / layout.fit - layout.top) / layout.flame - MIDDLE,
  };
}

export const effect = defineEffect({
  meta,
  params: {
    size: { type: 'number', default: 0.3, min: 0.12, max: 0.5, step: 0.01, label: 'flame height' },
    candleHeight: {
      type: 'number',
      default: 0.4,
      min: 0.04,
      max: 0.6,
      step: 0.01,
      label: 'candle height',
    },
    candleWidth: {
      type: 'number',
      default: 0.12,
      min: 0.03,
      max: 0.5,
      step: 0.005,
      label: 'candle width',
    },
    cup: { type: 'boolean', default: false, label: 'tea-light cup' },
    wax: { type: 'color', default: [0.87, 0.75, 0.51] },
    ambient: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'room light' },
    sway: { type: 'number', default: 0.5, min: 0, max: 1.5, step: 0.01 },
    flutter: { type: 'number', default: 0.12, min: 0, max: 1, step: 0.01 },
    draught: {
      type: 'number',
      default: 1,
      min: 0,
      max: 3,
      step: 0.05,
      label: 'draught (pointer)',
    },
    halo: { type: 'number', default: 0.16, min: 0, max: 1, step: 0.01 },
    intensity: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    speed: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    calm: { sway: 0.25, flutter: 0.04, halo: 0.2 },
    draughty: { sway: 1.3, flutter: 0.6, draught: 2, speed: 1.3 },
    'tea light': {
      size: 0.3,
      candleHeight: 0.12,
      candleWidth: 0.34,
      cup: true,
      wax: [0.9, 0.86, 0.78],
      sway: 0.35,
      flutter: 0.08,
    },
    'dinner candle': {
      size: 0.24,
      candleHeight: 0.55,
      candleWidth: 0.05,
      wax: [0.55, 0.06, 0.05],
      sway: 0.4,
    },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'candle' });
    const uniforms = createUniformBuffer(device, Params, 'candle params');
    const noise = getNoiseTexture(device);
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const bindGroup = device.createBindGroup({
      label: 'candle',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniforms.buffer } },
        { binding: 1, resource: noise.view },
        { binding: 2, resource: noise.sampler },
      ],
    });

    // Input is optional: with no pointer (or no DOM) the candle idles.
    const pointers = trackPointers(canvas);
    const draught = createDraught();
    let started = false;

    let aspect = 1;
    let pixels = 1;
    // Real seconds, wrapped to the flicker signal's period: `speed` can slow it but never push it
    // past real time, which is what keeps the flicker inside its caps.
    let clock = 0;
    let rise = 0;
    let wobblePhase = 0;

    return {
      resize(width, height) {
        tail.resize(width, height);
        aspect = width / height;
        pixels = height;
      },
      frame(time, encoder, target) {
        const layout = candleLayout(aspect, params);
        const real = time.delta * Math.min(params.speed, 1);
        clock = (clock + real) % FLICKER_PERIOD;
        rise = (rise + time.delta * params.speed * 2.2) % NOISE_TEXTURE_CELLS;
        wobblePhase = (wobblePhase + time.delta * params.speed * 9) % (2 * Math.PI);

        // Still air: a slow wander of the tip, wider and quicker as `sway` goes up.
        const wander = flickerOffset(clock, 11, {
          rate: 0.9 + 0.8 * Math.min(params.sway, 1.5),
          depth: 0,
          shimmer: 0,
          shimmerRate: 0,
        })[0];
        const idle = 0.3 * params.sway * wander;

        // The nearest pointer over the canvas is the draught.
        let wind: DraughtPointer | undefined;
        for (const pointer of pointers.poll()) {
          if (!pointer.inside) continue;
          const at = toFlameSpace(layout, aspect, pointer.x, pointer.y);
          const scale = 1 / layout.fit / layout.flame;
          const candidate = {
            x: at.x - 0.5 * draught.tip,
            y: at.y,
            vx: pointer.vx * aspect * scale,
            vy: -pointer.vy * scale,
          };
          if (!wind || Math.hypot(candidate.x, candidate.y) < Math.hypot(wind.x, wind.y)) {
            wind = candidate;
          }
        }
        if (!started) {
          // The first frame is also the still frame shown under reduced motion: start at rest.
          draught.lean = idle;
          draught.tip = idle;
          started = true;
        }
        stepDraught(draught, idle, wind, params.draught, real);

        const gust = draught.gust;
        const level = flickerIntensity(clock, 3, {
          rate: 2.4,
          depth: 0.1 + 0.2 * gust + 0.1 * params.flutter,
          shimmer: 0.02,
          shimmerRate: 12,
        });
        // A flame blown sideways is shorter, and it stretches a little as it brightens.
        const stretch = (0.9 + 0.1 * level) / Math.hypot(1, 1.2 * draught.tip);

        uniforms.set({
          aspect,
          fit: layout.fit,
          pixel: 1 / (pixels * layout.fit),
          flame_h: layout.flame * stretch,
          flame_rest: layout.flame,
          body: [layout.halfWidth, layout.top],
          lean: draught.lean,
          tip: draught.tip,
          wobble: 0.01 + 0.03 * params.flutter + 0.05 * gust,
          wobble_phase: wobblePhase,
          level,
          flutter: Math.min(params.flutter + 0.7 * gust, 1.2),
          rise,
          halo: params.halo,
          halo_radius: 1.6 * layout.flame,
          intensity: params.intensity,
          ambient: params.ambient,
          cup: params.cup ? 1 : 0,
          wax: params.wax,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('candle'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },
      destroy() {
        pointers.destroy();
        uniforms.destroy();
        tail.destroy();
      },
    };
  },
});
