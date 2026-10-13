import { getNoiseTexture } from '../../gpu/emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import coalShader from './coals.wgsl';
import shader from './embers.wgsl';
import { meta } from './meta.ts';

const Params = defineUniformStruct('Params', {
  drift_a: 'vec2f',
  drift_b: 'vec2f',
  aspect: 'f32',
  tilt: 'f32',
  time: 'f32',
  region_scale: 'f32',
  heat: 'f32',
  breath: 'f32',
  crack: 'f32',
  ash: 'f32',
  falloff: 'f32',
  temperature: 'f32',
  intensity: 'f32',
});

const CoalParams = defineUniformStruct('CoalParams', {
  aspect: 'f32',
  pixel: 'f32',
  scale: 'f32',
  tilt: 'f32',
});

// Distances and random numbers, read back texel for texel: 8 bits each is enough, and it is half
// the memory of a float target.
const COAL_FORMAT: GPUTextureFormat = 'rgba8unorm';
// The heat field is the shared noise tile, which repeats every 8 cells: a drift wrapped to that
// is seamless, and keeps the coordinates small for as long as the page stays open.
const NOISE_CELLS = 8;
// Seconds. Only the per-coal breathing reads the clock; a wrap is one frame of a slow sine.
const TIME_WRAP = 4096;

export const effect = defineEffect({
  meta,
  params: {
    heat: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01 },
    scale: { type: 'number', default: 9, min: 3, max: 16, step: 0.1, label: 'coals per height' },
    crack: {
      type: 'number',
      default: 0.12,
      min: 0.04,
      max: 0.3,
      step: 0.005,
      label: 'crack width',
    },
    drift: { type: 'number', default: 1, min: 0, max: 4, step: 0.01, label: 'heat drift' },
    breath: { type: 'number', default: 1, min: 0, max: 2, step: 0.01, label: 'breathing' },
    ash: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01 },
    tilt: { type: 'number', default: 0, min: 0, max: 1, step: 0.01 },
    falloff: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'edge falloff' },
    temperature: {
      type: 'number',
      default: 1500,
      min: 1000,
      max: 2200,
      step: 10,
      label: 'temperature (K)',
    },
    intensity: { type: 'number', default: 2.4, min: 0, max: 8, step: 0.05 },
    ...TAIL_PARAMS,
  },
  presets: {
    'glowing bed': { heat: 0.6, scale: 9, ash: 0.35, tilt: 0, temperature: 1500, intensity: 2.4 },
    'dying embers': {
      heat: 0.32,
      ash: 0.8,
      breath: 1.4,
      drift: 0.6,
      temperature: 1300,
      intensity: 2,
      falloff: 0.6,
    },
    forge: {
      heat: 0.9,
      scale: 9,
      ash: 0.1,
      crack: 0.16,
      drift: 1.6,
      temperature: 1850,
      intensity: 3,
      falloff: 0.2,
    },
    hearth: { heat: 0.62, scale: 9, tilt: 1, ash: 0.45, falloff: 0.5 },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'ember-bed' });
    const uniforms = createUniformBuffer(device, Params, 'ember-bed params');
    const coalUniforms = createUniformBuffer(device, CoalParams, 'ember-bed coals');
    const noise = getNoiseTexture(device);

    const coalPipeline = createFullscreenPipeline(device, {
      fragment: withChunks(coalShader, { 'coal-params.wgsl': CoalParams.wgsl }),
      format: COAL_FORMAT,
    });
    const coalBindGroup = device.createBindGroup({
      label: 'ember-bed coals',
      layout: coalPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: coalUniforms.buffer } }],
    });
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });

    let coals: GPUTexture | undefined;
    let coalView: GPUTextureView | undefined;
    let bindGroup: GPUBindGroup | undefined;
    let aspect = 1;
    let pixel = 1;
    // What the coal texture was drawn with; undefined until it has been drawn.
    let baked: string | undefined;

    // Accumulated, so the drift control changes how fast the heat moves and never where it is.
    const driftA: [number, number] = [0, 0];
    const driftB: [number, number] = [0, 0];
    let seconds = 0;

    return {
      resize(width, height) {
        tail.resize(width, height);
        aspect = width / height;
        pixel = 1 / height;
        coals?.destroy();
        coals = device.createTexture({
          label: 'ember-bed coal layout',
          size: [width, height],
          format: COAL_FORMAT,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        coalView = coals.createView({ label: 'ember-bed coal layout view' });
        bindGroup = device.createBindGroup({
          label: 'ember-bed',
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniforms.buffer } },
            { binding: 1, resource: coalView },
            { binding: 2, resource: noise.view },
            { binding: 3, resource: noise.sampler },
          ],
        });
        baked = undefined;
      },

      frame(time, encoder, target) {
        if (!coalView || !bindGroup) return;

        // The layout is drawn once, then again only when something it depends on changes.
        const layout = `${params.scale}|${params.tilt}`;
        if (layout !== baked) {
          coalUniforms.set({ aspect, pixel, scale: params.scale, tilt: params.tilt });
          coalUniforms.upload();
          renderFullscreen(encoder, coalView, coalPipeline, [coalBindGroup], {
            timestampWrites: profiler.pass('coal layout'),
          });
          baked = layout;
        }

        const step = time.delta * params.drift;
        driftA[0] = (driftA[0] + step * 0.021) % NOISE_CELLS;
        driftA[1] = (driftA[1] + step * 0.012) % NOISE_CELLS;
        driftB[0] = (driftB[0] - step * 0.034) % NOISE_CELLS;
        driftB[1] = (driftB[1] + step * 0.019) % NOISE_CELLS;
        seconds = (seconds + time.delta) % TIME_WRAP;

        uniforms.set({
          drift_a: driftA,
          drift_b: driftB,
          aspect,
          tilt: params.tilt,
          time: seconds,
          region_scale: 1.3,
          heat: params.heat,
          breath: params.breath,
          crack: params.crack,
          ash: params.ash,
          falloff: params.falloff,
          temperature: params.temperature,
          intensity: params.intensity,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('embers'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        coals?.destroy();
        uniforms.destroy();
        coalUniforms.destroy();
        tail.destroy();
      },
    };
  },
});
