import { FLICKER_PERIOD, flickerIntensity } from '../../gpu/emission/flicker.ts';
import { getNoiseTexture } from '../../gpu/emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import shader from './hearth.wgsl';
import { meta } from './meta.ts';

const Params = defineUniformStruct('Params', {
  warm: 'vec3f',
  aspect: 'f32',
  pixel: 'f32',
  fit: 'f32',
  ground: 'f32',
  time: 'f32',
  rise: 'f32',
  flame_height: 'f32',
  intensity: 'f32',
  coals: 'f32',
  ember_rise: 'f32',
  ember_wrap: 'f32',
  ember_fill: 'f32',
  ember_reach: 'f32',
});

// The flames read the shared noise tile, which repeats every 8 cells, at speeds that are
// multiples of 1/8 of `rise`: wrapping `rise` at 64 moves every lookup by whole tiles.
const RISE_WRAP = 64;
// Distance the embers have travelled; the shader keeps a whole number of slots per wrap.
const EMBER_WRAP = 64;
const EMBER_SLOT = 0.125; // FP_SLOT in hearth.wgsl
// Every sine in the shader that reads the clock has a rate that is a multiple of 0.1 rad/s, so
// the clock can wrap after a whole number of 20 pi seconds. (The embers' twinkle is the one
// exception: a wrap is a single frame of sparkle.)
const TIME_WRAP = 20 * Math.PI * 16;
// The canvas is this wide, in heights, before the scene has to zoom out to fit.
const FIT_ASPECT = 1.05;

// Firelight on the wall and floor: orange from flames, red from coals alone.
const FLAME_LIGHT = [1, 0.36, 0.09] as const;
const COAL_LIGHT = [1, 0.16, 0.03] as const;

export const effect = defineEffect({
  meta,
  params: {
    flame: { type: 'number', default: 0.55, min: 0, max: 1, step: 0.01, label: 'flame height' },
    speed: { type: 'number', default: 1, min: 0, max: 2.5, step: 0.01 },
    intensity: { type: 'number', default: 1, min: 0, max: 2, step: 0.01 },
    coals: { type: 'number', default: 1, min: 0, max: 1.6, step: 0.01, label: 'coal glow' },
    embers: { type: 'number', default: 1, min: 0, max: 3, step: 0.05 },
    glow: { type: 'number', default: 1, min: 0, max: 2.5, step: 0.01, label: 'firelight' },
    flicker: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'light flicker' },
    ...TAIL_PARAMS,
  },
  presets: {
    evening: { flame: 0.55, speed: 1, intensity: 1, coals: 1, embers: 1, glow: 1, flicker: 0.5 },
    roaring: {
      flame: 1,
      speed: 1.5,
      intensity: 1.15,
      coals: 1.2,
      embers: 2.6,
      glow: 1.5,
      flicker: 0.8,
    },
    'low fire': {
      flame: 0.25,
      speed: 0.75,
      intensity: 0.9,
      coals: 1.1,
      embers: 0.5,
      glow: 0.9,
      flicker: 0.4,
    },
    'dying embers': {
      flame: 0,
      speed: 0.5,
      intensity: 0.7,
      coals: 1.35,
      embers: 0.25,
      glow: 0.7,
      flicker: 0.15,
    },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'fireplace' });
    const uniforms = createUniformBuffer(device, Params, 'fireplace params');
    const noise = getNoiseTexture(device);
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const bindGroup = device.createBindGroup({
      label: 'fireplace',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniforms.buffer } },
        { binding: 1, resource: noise.view },
        { binding: 2, resource: noise.sampler },
      ],
    });

    // Accumulated, so the speed control never makes the flames or the embers jump.
    let rise = 0;
    let emberRise = 0;
    let seconds = 0;
    // The flicker of the firelight runs on real time: its safety argument is in real seconds.
    let clock = 0;

    return {
      resize(width, height) {
        tail.resize(width, height);
        const aspect = width / height;
        const fit = Math.min(1, aspect / FIT_ASPECT);
        // A tall canvas has room to spare: put some of it under the fire, as floor.
        uniforms.set({ aspect, pixel: 1 / height, fit, ground: 0.2 + 0.3 * (1 / fit - 1) });
      },
      frame(time, encoder, target) {
        const step = time.delta * params.speed;
        rise = (rise + step * 1.15) % RISE_WRAP;
        emberRise = (emberRise + step * (0.16 + 0.14 * params.flame)) % EMBER_WRAP;
        seconds = (seconds + step) % TIME_WRAP;
        clock = (clock + time.delta) % FLICKER_PERIOD;

        // How much light the fire gives the room: flames mostly, coals when there are none.
        const flameLight = params.intensity * Math.sqrt(Math.max(params.flame, 0));
        const coalLight = 0.22 * params.coals;
        const level =
          params.glow *
          (flameLight + coalLight) *
          flickerIntensity(clock, 7, {
            rate: 3,
            depth: 0.3 * params.flicker,
            shimmer: 0.03 * params.flicker,
            shimmerRate: 13,
          });
        const share = flameLight / Math.max(flameLight + coalLight, 1e-6);
        const mixLight = (channel: 0 | 1 | 2) =>
          level * (COAL_LIGHT[channel] + (FLAME_LIGHT[channel] - COAL_LIGHT[channel]) * share);
        uniforms.set({
          warm: [mixLight(0), mixLight(1), mixLight(2)],
          time: seconds,
          rise,
          // In the layer's own units; the back layer is 1.28 times this tall on screen.
          flame_height: 0.1 + 0.75 * params.flame,
          intensity: params.intensity,
          coals: params.coals,
          ember_rise: emberRise,
          ember_wrap: EMBER_WRAP / EMBER_SLOT,
          ember_fill: Math.min(0.3 * params.embers, 0.9),
          ember_reach: 0.35 + 0.5 * params.flame,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('hearth'),
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
