import { getNoiseTexture, NOISE_TEXTURE_CELLS } from '../../gpu/emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import shader from './jet.wgsl';
import { meta } from './meta.ts';

const Params = defineUniformStruct('Params', {
  aspect: 'f32',
  fit: 'f32',
  /** One pixel, in scene units. */
  pixel: 'f32',
  /** 0 one jet, 1 a row, 2 a ring. */
  mode: 'f32',
  count: 'f32',
  /** Distance between the jets of a row; radius of a ring; where the ring's first jet points. */
  spacing: 'f32',
  radius: 'f32',
  angle: 'f32',
  /** Where the jets leave the burner (the centre of a row or a ring), from the canvas centre. */
  origin: 'vec2f',
  /** Unit vector along the jet. */
  axis: 'vec2f',
  length: 'f32',
  half_width: 'f32',
  /** Tip width over nozzle width, and the inner cone's length over the jet's. */
  tip: 'f32',
  inner: 'f32',
  diamonds: 'f32',
  /** Distance between shock diamonds, in jet lengths. */
  diamond_step: 'f32',
  warmth: 'f32',
  roar: 'f32',
  intensity: 'f32',
  rise: 'f32',
  time: 'f32',
  /** Length of the tube or thickness of the pipe behind the jets; 0 draws no burner. */
  nozzle: 'f32',
});

const ARRANGEMENTS = ['single', 'row', 'ring'] as const;
type Arrangement = (typeof ARRANGEMENTS)[number];

/**
 * Noise cells a second past any point of a jet at `speed` 1, which is also the base frequency in
 * hertz of everything the noise moves. Kept under 3: a wide warm plume is bright enough for its
 * flicker to count as flashing (WCAG 2.3.1) once it changes more than three times a second.
 */
const RUSH = 2.4;

/** Share of the canvas the arrangement may fill; the rest is room for the glow. */
const FILL = 0.86;

export interface JetSettings {
  arrangement: string;
  count: number;
  /** Degrees clockwise from straight up. */
  direction: number;
  length: number;
  width: number;
  spacing: number;
  radius: number;
  nozzle: boolean;
}

export interface JetLayout {
  mode: number;
  count: number;
  fit: number;
  origin: [number, number];
  axis: [number, number];
  /** Radians, for the ring. */
  angle: number;
  nozzle: number;
}

/**
 * Where the jets go for a canvas of this aspect: the arrangement (burner and flames) is centred
 * and, if it is larger than the canvas, the scene zooms out until it fits. Scene units are canvas
 * heights divided by `fit`.
 */
export function jetLayout(aspect: number, s: JetSettings): JetLayout {
  const mode = Math.max(0, (ARRANGEMENTS as readonly string[]).indexOf(s.arrangement));
  const arrangement = ARRANGEMENTS[mode] as Arrangement;
  const count = arrangement === 'single' ? 1 : Math.min(Math.max(Math.round(s.count), 1), 64);
  const angle = (s.direction * Math.PI) / 180;
  const axis: [number, number] = [Math.sin(angle), Math.cos(angle)];
  if (arrangement === 'ring') {
    const reach = s.radius + s.length;
    return {
      mode,
      count,
      fit: Math.min(1, (FILL * Math.min(aspect, 1)) / (2 * reach)),
      origin: [0, 0],
      axis,
      angle,
      nozzle: s.nozzle ? 1 : 0,
    };
  }
  const nozzle = !s.nozzle
    ? 0
    : arrangement === 'single'
      ? Math.max(2.4 * s.width, 0.1)
      : Math.max(1.3 * s.width, 0.05);
  // Half extents along the jet and across it, then the box that holds them at this angle.
  const along = 0.5 * (s.length + nozzle);
  const across = 0.5 * (count - 1) * s.spacing + 0.75 * s.width;
  const halfX = Math.abs(axis[0]) * along + Math.abs(axis[1]) * across;
  const halfY = Math.abs(axis[1]) * along + Math.abs(axis[0]) * across;
  const centre = 0.5 * (s.length - nozzle);
  return {
    mode,
    count,
    fit: Math.min(1, (FILL * aspect) / (2 * halfX), FILL / (2 * halfY)),
    origin: [-axis[0] * centre, -axis[1] * centre],
    axis,
    angle,
    nozzle,
  };
}

export const effect = defineEffect({
  meta,
  params: {
    arrangement: { type: 'select', default: 'single', options: ARRANGEMENTS },
    count: { type: 'number', default: 9, min: 1, max: 32, step: 1, label: 'jets (row, ring)' },
    direction: {
      type: 'number',
      default: 90,
      min: -180,
      max: 180,
      step: 1,
      label: 'direction (°)',
    },
    length: { type: 'number', default: 0.8, min: 0.05, max: 1.6, step: 0.01 },
    width: { type: 'number', default: 0.09, min: 0.01, max: 0.4, step: 0.005 },
    spread: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.01, label: 'tip width' },
    cone: { type: 'number', default: 0.3, min: 0.05, max: 0.9, step: 0.01, label: 'inner cone' },
    spacing: {
      type: 'number',
      default: 0.12,
      min: 0.02,
      max: 0.5,
      step: 0.005,
      label: 'row spacing',
    },
    radius: {
      type: 'number',
      default: 0.17,
      min: 0.03,
      max: 0.4,
      step: 0.005,
      label: 'ring radius',
    },
    diamonds: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'shock diamonds' },
    diamondSpacing: {
      type: 'number',
      default: 1.3,
      min: 0.5,
      max: 3,
      step: 0.05,
      label: 'diamond spacing (widths)',
    },
    warmth: { type: 'number', default: 0, min: 0, max: 1, step: 0.01 },
    roar: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01 },
    nozzle: { type: 'boolean', default: true, label: 'burner' },
    intensity: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    // 1.25 x RUSH is three cells a second: the range ends where the flicker would pass 3 Hz.
    speed: { type: 'number', default: 1, min: 0, max: 1.25, step: 0.01 },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    blowtorch: { arrangement: 'single', direction: 90, length: 0.8, width: 0.09, roar: 0.3 },
    'stove burner': {
      arrangement: 'ring',
      count: 20,
      direction: 0,
      radius: 0.2,
      length: 0.17,
      width: 0.05,
      cone: 0.42,
      spread: 0.1,
      roar: 0.15,
    },
    'burner row': {
      arrangement: 'row',
      count: 9,
      direction: 0,
      spacing: 0.12,
      length: 0.28,
      width: 0.07,
      cone: 0.4,
      roar: 0.15,
    },
    afterburner: {
      arrangement: 'single',
      direction: 90,
      length: 1.25,
      width: 0.2,
      spread: 0.4,
      cone: 0.1,
      diamonds: 1,
      diamondSpacing: 1.25,
      warmth: 1,
      roar: 0.5,
    },
    bunsen: {
      arrangement: 'single',
      direction: 0,
      length: 0.62,
      width: 0.1,
      cone: 0.42,
      roar: 0.1,
    },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'gas-jet' });
    const uniforms = createUniformBuffer(device, Params, 'gas-jet params');
    const noise = getNoiseTexture(device);
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const bindGroup = device.createBindGroup({
      label: 'gas-jet',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniforms.buffer } },
        { binding: 1, resource: noise.view },
        { binding: 2, resource: noise.sampler },
      ],
    });

    let aspect = 1;
    let pixels = 1;
    // Accumulated, so changing `speed` never makes the picture jump; wrapped where it repeats.
    let rise = 0;
    let clock = 0;

    return {
      resize(width, height) {
        tail.resize(width, height);
        aspect = width / height;
        pixels = height;
      },
      frame(time, encoder, target) {
        rise = (rise + time.delta * params.speed * RUSH) % NOISE_TEXTURE_CELLS;
        clock = (clock + time.delta * Math.min(params.speed, 1)) % (2 * Math.PI * 100);
        const layout = jetLayout(aspect, params);
        uniforms.set({
          aspect,
          fit: layout.fit,
          pixel: 1 / (pixels * layout.fit),
          mode: layout.mode,
          count: layout.count,
          spacing: params.spacing,
          radius: params.radius,
          angle: layout.angle,
          origin: layout.origin,
          axis: layout.axis,
          length: params.length,
          half_width: 0.5 * params.width,
          tip: params.spread,
          inner: params.cone,
          diamonds: params.diamonds,
          diamond_step: (params.diamondSpacing * params.width) / params.length,
          warmth: params.warmth,
          roar: params.roar,
          intensity: params.intensity,
          rise,
          time: clock,
          nozzle: layout.nozzle,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('jets'),
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
