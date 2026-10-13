import { getNoiseTexture, NOISE_TEXTURE_CELLS } from '../../gpu/emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import shader from './fire-ring.wgsl';
import { meta } from './meta.ts';

const Params = defineUniformStruct('Params', {
  to_ring: 'vec2f',
  rise: 'vec2f',
  rotation: 'vec2f',
  pixel: 'f32',
  radius: 'f32',
  reach: 'f32',
  thickness: 'f32',
  side: 'f32',
  repeats: 'f32',
  lean: 'f32',
  roughness: 'f32',
  intensity: 'f32',
  inner: 'f32',
  progress: 'f32',
  start: 'f32',
  taper: 'f32',
  track: 'f32',
  kind: 'i32',
});

/** The ramps of ramp.wgsl, in `ramp_select` order. */
const PALETTES = ['fire', 'gas', 'copper', 'sodium', 'potassium', 'lithium'] as const;
const DIRECTIONS = ['outward', 'inward', 'both'] as const;
/** The `side` uniform: +1 flames go outward, -1 inward, 0 both ways. */
const SIDE: Record<string, number> = { outward: 1, inward: -1, both: 0 };

// Noise cells the flames climb per second at speed 1, for the two noise layers.
const RISE = [1.4, 0.85] as const;
// The second layer turns more slowly than the first, so the pattern shears as it spins.
const SECOND_LAYER_SPIN = 0.6;
// Noise cells the flame tips trail behind the ring, per turn a second of spin.
const LEAN_CELLS = 1.5;
// The fastest the flame pattern itself is carried round, in noise cells a second. The lit arc may
// spin faster than this (a loader does): the fire then stays behind where it was lit while the
// head moves on, instead of whole tongues sweeping past every point of the ring many times a
// second, which is both what a real trail of fire does and what keeps a large ring from flashing.
const MAX_PATTERN_CELLS_PER_SECOND = 2.5;

export const effect = defineEffect({
  meta,
  params: {
    radius: { type: 'number', default: 0.52, min: 0.1, max: 0.95, step: 0.01 },
    length: {
      type: 'number',
      default: 0.34,
      min: 0.03,
      max: 0.8,
      step: 0.01,
      label: 'flame length',
    },
    thickness: { type: 'number', default: 0.022, min: 0.004, max: 0.1, step: 0.001 },
    direction: { type: 'select', default: 'outward', options: DIRECTIONS },
    progress: { type: 'number', default: 1, min: 0, max: 1, step: 0.01 },
    tongues: { type: 'number', default: 3, min: 1, max: 8, step: 1 },
    roughness: { type: 'number', default: 1.8, min: 0, max: 2.5, step: 0.01 },
    speed: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    spin: {
      type: 'number',
      default: 0.05,
      min: -1.5,
      max: 1.5,
      step: 0.01,
      label: 'spin (turns/s)',
    },
    taper: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'tail taper' },
    track: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'unlit track' },
    innerGlow: { type: 'number', default: 0.5, min: 0, max: 2, step: 0.01, label: 'inner glow' },
    palette: { type: 'select', default: 'fire', options: PALETTES },
    intensity: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    portal: {
      palette: 'potassium',
      radius: 0.56,
      length: 0.3,
      thickness: 0.03,
      direction: 'both',
      tongues: 4,
      spin: 0.18,
      innerGlow: 1.2,
      progress: 1,
      taper: 0,
      track: 0,
    },
    'avatar frame': {
      palette: 'fire',
      radius: 0.7,
      length: 0.3,
      thickness: 0.016,
      direction: 'outward',
      tongues: 5,
      roughness: 1.5,
      speed: 0.8,
      spin: 0.03,
      innerGlow: 0.15,
      progress: 1,
      taper: 0,
      track: 0,
    },
    loader: {
      palette: 'fire',
      radius: 0.42,
      length: 0.4,
      thickness: 0.02,
      direction: 'outward',
      tongues: 3,
      roughness: 1.3,
      progress: 0.4,
      spin: 0.7,
      taper: 0.7,
      track: 0.6,
      innerGlow: 0,
    },
    'progress 60%': {
      palette: 'fire',
      radius: 0.5,
      length: 0.22,
      direction: 'outward',
      progress: 0.6,
      spin: 0,
      taper: 0,
      track: 0.8,
      innerGlow: 0.2,
    },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'fire-ring' });
    const uniforms = createUniformBuffer(device, Params, 'fire-ring params');
    const noise = getNoiseTexture(device);
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const bindGroup = device.createBindGroup({
      label: 'fire-ring',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniforms.buffer } },
        { binding: 1, resource: noise.view },
        { binding: 2, resource: noise.sampler },
      ],
    });

    // Accumulated, so changing a speed never makes the picture jump. Each wraps where the noise
    // tile does (a whole number of cells, a whole turn), so the wrap is invisible.
    const rise: [number, number] = [0, 0];
    const rotation: [number, number] = [0, 0];
    // Where the lit arc starts, in turns.
    let arc = 0;

    return {
      resize(width, height) {
        tail.resize(width, height);
        const shorter = Math.min(width, height);
        // Ring units: 1 is half the shorter side, so the ring is round whatever the box is.
        uniforms.set({
          to_ring: [(2 * width) / shorter, (2 * height) / shorter],
          pixel: 2 / shorter,
        });
      },
      frame(time, encoder, target) {
        rise[0] = (rise[0] + time.delta * params.speed * RISE[0]) % NOISE_TEXTURE_CELLS;
        rise[1] = (rise[1] + time.delta * params.speed * RISE[1]) % NOISE_TEXTURE_CELLS;
        // A whole number of repeats of the noise tile round the ring: that is the seamless wrap.
        const repeats = Math.max(1, Math.round(params.tongues));
        const cap = MAX_PATTERN_CELLS_PER_SECOND / (NOISE_TEXTURE_CELLS * repeats);
        const carried = Math.min(Math.max(params.spin, -cap), cap);
        arc = (arc + time.delta * params.spin) % 1;
        rotation[0] = (rotation[0] + time.delta * carried) % 1;
        rotation[1] = (rotation[1] + time.delta * carried * SECOND_LAYER_SPIN) % 1;

        uniforms.set({
          rise,
          // The tile's u offset: `repeats` tiles per turn for layer one, one more for layer two.
          rotation: [-rotation[0] * repeats, -rotation[1] * (repeats + 1)],
          radius: params.radius,
          reach: Math.max(params.length, 1e-3),
          thickness: Math.max(params.thickness, 1e-3),
          side: SIDE[params.direction] ?? 1,
          repeats,
          // Flames trail behind the way the ring turns.
          lean: LEAN_CELLS * params.spin,
          roughness: params.roughness,
          intensity: params.intensity,
          inner: params.innerGlow,
          progress: params.progress,
          start: arc,
          taper: params.taper,
          track: params.track,
          kind: Math.max(0, (PALETTES as readonly string[]).indexOf(params.palette)),
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('ring'),
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
