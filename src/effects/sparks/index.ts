import { getNoiseTexture } from '../../gpu/emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { sparkGrid } from './grid.ts';
import { meta } from './meta.ts';
import shader from './sparks.wgsl';

const Params = defineUniformStruct('Params', {
  origin: 'vec2f',
  axis: 'vec2f',
  drift: 'vec2f',
  aspect: 'f32',
  pixel: 'f32',
  time: 'f32',
  rise: 'f32',
  focal: 'f32',
  spread: 'f32',
  droop: 'f32',
  turbulence: 'f32',
  lane_width: 'f32',
  slot_len: 'f32',
  wrap_slots: 'f32',
  fill: 'f32',
  size: 'f32',
  streak: 'f32',
  reach: 'f32',
  temperature: 'f32',
  intensity: 'f32',
  glow: 'f32',
  layers: 'u32',
  seed: 'u32',
});

// `rise` (distance travelled, in canvas heights) wraps here so f32 keeps sub-pixel precision.
// The shader rounds every lane's speed to a whole number of slots per wrap, so nothing jumps.
const RISE_WRAP = 256;
// Seconds; only the twinkle reads the clock, and a wrap is one frame of a sparkle.
const TIME_WRAP = 1024;
// The turbulence field is the shared noise tile, which repeats every 8 cells.
const NOISE_CELLS = 8;

const DEGREES = Math.PI / 180;

export const effect = defineEffect({
  meta,
  params: {
    density: { type: 'number', default: 1, min: 0.1, max: 4, step: 0.05 },
    speed: {
      type: 'number',
      default: 0.22,
      min: 0,
      max: 4,
      step: 0.01,
      label: 'speed (heights/s)',
    },
    size: { type: 'number', default: 1, min: 0.3, max: 3, step: 0.05 },
    streak: {
      type: 'number',
      default: 0.008,
      min: 0,
      max: 0.3,
      step: 0.002,
      label: 'streak length',
    },
    reach: { type: 'number', default: 0.85, min: 0.1, max: 1.5, step: 0.01 },
    spread: { type: 'number', default: 12, min: 1, max: 180, step: 1, label: 'spread (degrees)' },
    source: { type: 'number', default: 0.55, min: 0, max: 1, step: 0.01, label: 'source width' },
    originX: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'origin x' },
    originY: { type: 'number', default: -0.03, min: -0.2, max: 1, step: 0.01, label: 'origin y' },
    direction: {
      type: 'number',
      default: 0,
      min: -180,
      max: 180,
      step: 1,
      label: 'direction (degrees from up)',
    },
    gravity: { type: 'number', default: 0, min: 0, max: 2, step: 0.01 },
    turbulence: { type: 'number', default: 0.5, min: 0, max: 1.5, step: 0.01 },
    temperature: {
      type: 'number',
      default: 1750,
      min: 1100,
      max: 3200,
      step: 10,
      label: 'temperature (K)',
    },
    intensity: { type: 'number', default: 9, min: 0, max: 30, step: 0.1 },
    glow: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'source glow' },
    layers: { type: 'number', default: 3, min: 1, max: 4, step: 1, label: 'depth layers' },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    'campfire drift': {
      density: 1,
      speed: 0.22,
      size: 1,
      streak: 0.008,
      reach: 0.85,
      spread: 12,
      source: 0.55,
      originX: 0.5,
      originY: -0.03,
      direction: 0,
      gravity: 0,
      turbulence: 0.5,
      temperature: 1750,
      intensity: 9,
      glow: 0,
    },
    'welding spray': {
      density: 2.4,
      speed: 2.2,
      size: 0.6,
      streak: 0.13,
      reach: 0.8,
      spread: 62,
      source: 0,
      originX: 0.5,
      originY: 0.2,
      direction: 0,
      gravity: 0.9,
      turbulence: 0.04,
      temperature: 2700,
      intensity: 7,
      glow: 1,
    },
    grinder: {
      density: 3,
      speed: 3,
      size: 0.5,
      streak: 0.2,
      reach: 1.3,
      spread: 9,
      source: 0,
      originX: 0.14,
      originY: 0.6,
      direction: 72,
      gravity: 0.5,
      turbulence: 0.03,
      temperature: 2300,
      intensity: 8,
      glow: 0.5,
    },
    'bonfire gust': {
      density: 2.2,
      speed: 0.45,
      size: 0.8,
      streak: 0.035,
      reach: 1.2,
      spread: 22,
      source: 0.35,
      originX: 0.4,
      originY: -0.03,
      direction: 12,
      gravity: 0,
      turbulence: 1,
      temperature: 1900,
      intensity: 10,
      glow: 0,
    },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'sparks' });
    const uniforms = createUniformBuffer(device, Params, 'sparks params');
    const noise = getNoiseTexture(device);
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const bindGroup = device.createBindGroup({
      label: 'sparks',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniforms.buffer } },
        { binding: 1, resource: noise.view },
        { binding: 2, resource: noise.sampler },
      ],
    });

    let aspect = 1;
    let pixel = 0;
    // Distance travelled by a spark of average speed, and the clock for twinkle and turbulence.
    let rise = 0;
    let seconds = 0;

    return {
      resize(width, height) {
        tail.resize(width, height);
        aspect = width / height;
        pixel = 1 / height;
        uniforms.set({ aspect, pixel });
      },
      frame(time, encoder, target) {
        rise = (rise + time.delta * params.speed) % RISE_WRAP;
        seconds = (seconds + time.delta) % TIME_WRAP;

        const grid = sparkGrid({
          density: params.density,
          size: params.size,
          streak: params.streak,
          source: params.source,
          spread: params.spread * DEGREES,
          aspect,
          pixel,
        });
        const direction = params.direction * DEGREES;
        uniforms.set({
          origin: [(params.originX - 0.5) * aspect, params.originY],
          axis: [Math.sin(direction), Math.cos(direction)],
          // The air drifts sideways and up, slower than the sparks, so they move through it.
          // Each rate times its clock's wrap is a whole number of tiles, so a wrap cannot be seen.
          drift: [
            (seconds * (3 / 64)) % NOISE_CELLS,
            (-(rise * (11 / 32)) % NOISE_CELLS) - ((seconds * (3 / 128)) % NOISE_CELLS),
          ],
          time: seconds,
          rise,
          focal: grid.focal,
          spread: grid.spread,
          droop: params.gravity,
          turbulence: params.turbulence * 0.12,
          lane_width: grid.laneWidth,
          slot_len: grid.slotLength,
          wrap_slots: RISE_WRAP / grid.slotLength,
          fill: grid.fill,
          size: grid.size,
          streak: params.streak,
          reach: params.reach,
          temperature: params.temperature,
          intensity: params.intensity,
          glow: params.glow,
          layers: Math.round(params.layers),
          seed: 1,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('sparks'),
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
