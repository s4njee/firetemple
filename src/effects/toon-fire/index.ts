import { getNoiseTexture } from '../../gpu/emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct, uniformArray } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import { MAX_SPARKS, sparkPositions } from './sparks.ts';
import { createSteppedClock } from './stepped.ts';
import shader from './toon-fire.wgsl';

const Params = defineUniformStruct('Params', {
  colors: uniformArray('vec4f', 5),
  spark: uniformArray('vec4f', MAX_SPARKS),
  origin: 'vec2f',
  reach: 'vec4f',
  aspect: 'f32',
  pixel: 'f32',
  size: 'f32',
  time: 'f32',
  width: 'f32',
  spread: 'f32',
  sway: 'f32',
  lick: 'f32',
  outline: 'f32',
  bands: 'f32',
  logs: 'f32',
  sparks: 'f32',
});

type Rgb = readonly [number, number, number];

/**
 * A palette is five flat colours: the ink outline, then the bands from the outside in. They are
 * linear scene radiance (1.0 = paper white), chosen through the tail's tonemap: a channel above
 * about 3 displays as full, so the hue of a band is set by its smaller channels.
 */
const PALETTES: Readonly<Record<string, readonly [Rgb, Rgb, Rgb, Rgb, Rgb]>> = {
  fire: [
    [0.085, 0.012, 0.01],
    [1.9, 0.06, 0.004],
    [4.0, 0.2, 0.004],
    [5.0, 0.72, 0.03],
    [6.0, 2.6, 0.5],
  ],
  spirit: [
    [0.008, 0.016, 0.1],
    [0.012, 0.14, 1.7],
    [0.03, 0.55, 3.6],
    [0.3, 1.7, 5.0],
    [2.4, 4.2, 6.0],
  ],
  toxic: [
    [0.008, 0.06, 0.02],
    [0.02, 0.85, 0.07],
    [0.2, 2.6, 0.08],
    [1.1, 4.6, 0.25],
    [3.4, 6.0, 1.6],
  ],
};
const PALETTE_NAMES = Object.keys(PALETTES);

// The animation phase wraps here (seconds), to keep the noise coordinates small enough for f32
// over a long visit. The wrap is one drawing that does not follow from the last.
const PHASE_WRAP = 4096;

export const effect = defineEffect({
  meta,
  params: {
    palette: { type: 'select', default: 'fire', options: PALETTE_NAMES },
    size: { type: 'number', default: 0.6, min: 0.2, max: 0.95, step: 0.01 },
    width: { type: 'number', default: 0.25, min: 0.12, max: 0.42, step: 0.005 },
    spread: { type: 'number', default: 1, min: 0, max: 1.4, step: 0.01, label: 'side flames' },
    sway: { type: 'number', default: 0.6, min: 0, max: 1.5, step: 0.01 },
    licks: { type: 'number', default: 0.8, min: 0, max: 1.6, step: 0.01 },
    bands: { type: 'number', default: 4, min: 2, max: 4, step: 1 },
    outline: { type: 'number', default: 0.022, min: 0, max: 0.06, step: 0.001 },
    logs: { type: 'boolean', default: true },
    sparks: { type: 'number', default: 5, min: 0, max: MAX_SPARKS, step: 1 },
    speed: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    frameRate: {
      type: 'number',
      default: 10,
      min: 0,
      max: 30,
      step: 1,
      label: 'drawings per second (0 = smooth)',
    },
    ...TAIL_PARAMS,
    // Flat paint wants only a little glow, or the bands stop being flat.
    bloom: { ...TAIL_PARAMS.bloom, default: 0.3 },
    ...OVERLAY_PARAMS,
  },
  presets: {
    campfire: {
      palette: 'fire',
      size: 0.6,
      width: 0.25,
      spread: 1,
      sway: 0.6,
      licks: 0.8,
      bands: 4,
      outline: 0.022,
      logs: true,
      sparks: 5,
      frameRate: 10,
    },
    'flame icon': {
      palette: 'fire',
      size: 0.72,
      width: 0.3,
      spread: 0,
      sway: 0.35,
      licks: 0.45,
      bands: 3,
      outline: 0.034,
      logs: false,
      sparks: 0,
      frameRate: 8,
      bloom: 0.15,
    },
    'spirit fire': {
      palette: 'spirit',
      size: 0.74,
      width: 0.2,
      spread: 0.7,
      sway: 0.9,
      licks: 1.1,
      bands: 4,
      outline: 0.018,
      logs: false,
      sparks: 7,
      speed: 0.8,
      frameRate: 12,
    },
    'toxic torch': {
      palette: 'toxic',
      size: 0.7,
      width: 0.22,
      spread: 0.45,
      sway: 0.7,
      licks: 1,
      bands: 3,
      logs: false,
      sparks: 3,
      frameRate: 10,
    },
    smooth: { frameRate: 0 },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'toon-fire' });
    const uniforms = createUniformBuffer(device, Params, 'toon-fire params');
    const noise = getNoiseTexture(device);
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const bindGroup = device.createBindGroup({
      label: 'toon-fire',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniforms.buffer } },
        { binding: 1, resource: noise.view },
        { binding: 2, resource: noise.sampler },
      ],
    });

    const clock = createSteppedClock(PHASE_WRAP);
    let aspect = 1;

    return {
      resize(width, height) {
        tail.resize(width, height);
        aspect = width / height;
        uniforms.set({ aspect, pixel: 1 / height });
      },
      frame(time, encoder, target) {
        const shown = clock.advance(time.delta, params.speed, params.frameRate);
        const palette = PALETTES[params.palette] ?? PALETTES.fire!;
        const w = params.width;
        const logs = params.logs;
        // The figure, in flame heights. `slack` is how far sway, licks and outline can carry the
        // flame past its resting outline at the tip (the same bound as tf_near in the shader).
        const slack =
          (1.75 * params.sway + 1.05 * params.licks * 1.15 + 0.09) * w + params.outline + 0.02;
        const sparks = Math.min(Math.round(params.sparks), MAX_SPARKS);
        // The sparks are born in a strip this wide, and can drift this far.
        const sparkStrip = 0.8 * w * (1 + 0.6 * params.spread);
        const sparkReach = 1.7 * sparkStrip + 0.18 * w + 0.05;
        // The logs hang below the base; the sparks rise to 1.4, the licks past the tip.
        const below = logs ? 0.75 * w : params.outline;
        const top = Math.max(1 + slack, sparks > 0 ? 1.4 : 0);
        // What `size` frames: the flame at rest. Licks and sparks may leave it.
        const above = 1.04;
        // How far the picture can reach sideways: the tongues, the logs or the sparks.
        const tongues =
          Math.max(w, (0.92 * w + 0.3 * (0.68 + slack)) * params.spread + 0.66 * w) + slack;
        const reachX = Math.max(tongues, logs ? 2.6 * w : 0, sparks > 0 ? sparkReach : 0);
        // The box the flame is fitted into, which is narrower than everything it can reach.
        const fitX = Math.max(w * (1 + 1.2 * params.spread), logs ? 2.5 * w : 0) + params.outline;
        // Never taller than the canvas, and in a narrow box never wider than it either.
        const size = Math.min(params.size, 0.96 / (above + below), (0.96 * aspect) / (2 * fitX));
        uniforms.set({
          colors: palette.flatMap((color) => [...color, 1]),
          // Centred in the canvas as a whole figure, not by its base.
          origin: [0.5 * aspect, 0.5 + 0.5 * size * (below - above)],
          reach: [reachX, below + 0.06, top, sparkReach],
          spark: sparkPositions(shown, sparks, sparkStrip, 0.18 * w),
          size,
          time: shown,
          width: w,
          spread: params.spread,
          sway: params.sway,
          lick: params.licks,
          outline: params.outline,
          bands: Math.round(params.bands),
          logs: logs ? 1 : 0,
          sparks,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('toon'),
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
