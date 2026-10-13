import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { generateMipmaps, mipLevelCount } from '../../gpu/mipmap.ts';
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import backdropShader from './backdrop.wgsl';
import shader from './heat-haze.wgsl';
import { meta } from './meta.ts';

const Params = defineUniformStruct('Params', {
  aspect: 'f32',
  rise: 'f32',
  boil: 'f32',
  fire_time: 'f32',
  strength: 'f32',
  scale: 'f32',
  extent: 'f32',
  plumes: 'f32',
  chroma: 'f32',
  blur: 'f32',
  fire: 'f32',
  view: 'u32',
});

const BackdropParams = defineUniformStruct('BackdropParams', {
  aspect: 'f32',
  pixel: 'f32',
  style: 'u32',
});

const BACKDROPS = ['dark page', 'light page', 'test chart'] as const;
const VIEWS = ['scene', 'heat mask', 'offset field'] as const;

// sRGB-encoded 8-bit: the backdrop is page content, never brighter than 1.0, and this is half the
// memory of a float target. Sampling returns linear values.
const BACKDROP_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb';

// Cells of churn per unit of rise: the air boils as fast as it climbs, and stops when it stops.
const BOIL_PER_RISE = 5;
// The phases wrap far apart so the noise coordinates stay small enough for f32 over a long visit.
// A wrap is a one-frame change of an already restless pattern.
const RISE_WRAP = 256;
const BOIL_WRAP = 4096;
const FIRE_WRAP = 3600;

export const effect = defineEffect({
  meta,
  params: {
    strength: {
      type: 'number',
      default: 0.3,
      min: 0,
      max: 1.5,
      step: 0.01,
      label: 'strength (% of height)',
    },
    scale: { type: 'number', default: 48, min: 8, max: 120, step: 1 },
    rise: { type: 'number', default: 0.4, min: 0, max: 2, step: 0.01, label: 'rise speed' },
    height: { type: 'number', default: 0.62, min: 0.05, max: 1, step: 0.01, label: 'heat height' },
    plumes: { type: 'number', default: 0.75, min: 0, max: 1, step: 0.01 },
    chroma: { type: 'number', default: 0.2, min: 0, max: 1, step: 0.01, label: 'colour split' },
    blur: { type: 'number', default: 0.6, min: 0, max: 3, step: 0.05 },
    fire: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    backdrop: { type: 'select', default: 'dark page', options: BACKDROPS },
    view: { type: 'select', default: 'scene', options: VIEWS },
    ...TAIL_PARAMS,
  },
  presets: {
    'hot road': { strength: 0.3, scale: 48, rise: 0.4, height: 0.62, chroma: 0.2, blur: 0.6 },
    furnace: {
      strength: 0.55,
      scale: 28,
      rise: 0.85,
      height: 0.95,
      plumes: 0.5,
      chroma: 0.4,
      blur: 1.2,
      fire: 1.6,
    },
    'light page': { backdrop: 'light page', fire: 1.3, bloomThreshold: 1.5 },
    off: { strength: 0, chroma: 0, blur: 0 },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'heat-haze' });
    const uniforms = createUniformBuffer(device, Params, 'heat-haze params');
    const backdropUniforms = createUniformBuffer(device, BackdropParams, 'heat-haze backdrop');

    const backdropPipeline = createFullscreenPipeline(device, {
      fragment: withChunks(backdropShader, { 'backdrop-params.wgsl': BackdropParams.wgsl }),
      format: BACKDROP_FORMAT,
    });
    const backdropBindGroup = device.createBindGroup({
      label: 'heat-haze backdrop',
      layout: backdropPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: backdropUniforms.buffer } }],
    });

    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    // Trilinear, so the softening can read between mip levels; clamped, so an offset at the edge
    // of the picture repeats the edge instead of wrapping to the other side.
    const sampler = device.createSampler({
      label: 'heat-haze backdrop sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    let backdrop: GPUTexture | undefined;
    let backdropLevel0: GPUTextureView | undefined;
    let bindGroup: GPUBindGroup | undefined;
    // What the backdrop texture currently holds; undefined until it has been drawn.
    let drawnStyle: number | undefined;

    // Accumulated rather than `time * speed`, so changing the speed never makes the pattern jump.
    let rise = 0;
    let boil = 0;
    let fireTime = 0;

    return {
      resize(width, height) {
        tail.resize(width, height);
        uniforms.set({ aspect: width / height });
        backdropUniforms.set({ aspect: width / height, pixel: 1 / height });

        backdrop?.destroy();
        backdrop = device.createTexture({
          label: 'heat-haze backdrop',
          size: [width, height],
          format: BACKDROP_FORMAT,
          mipLevelCount: mipLevelCount(width, height),
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        backdropLevel0 = backdrop.createView({
          label: 'heat-haze backdrop level 0',
          baseMipLevel: 0,
          mipLevelCount: 1,
        });
        bindGroup = device.createBindGroup({
          label: 'heat-haze',
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniforms.buffer } },
            { binding: 1, resource: backdrop.createView({ label: 'heat-haze backdrop mips' }) },
            { binding: 2, resource: sampler },
          ],
        });
        drawnStyle = undefined;
      },

      frame(time, encoder, target) {
        if (!backdrop || !backdropLevel0 || !bindGroup) return;

        // The backdrop is drawn once, then again only when its size or style changes.
        const style = Math.max(0, (BACKDROPS as readonly string[]).indexOf(params.backdrop));
        if (style !== drawnStyle) {
          backdropUniforms.set({ style });
          backdropUniforms.upload();
          renderFullscreen(encoder, backdropLevel0, backdropPipeline, [backdropBindGroup], {
            timestampWrites: profiler.pass('backdrop'),
          });
          generateMipmaps(device, backdrop, encoder);
          drawnStyle = style;
        }

        rise = (rise + time.delta * params.rise) % RISE_WRAP;
        boil = (boil + time.delta * params.rise * BOIL_PER_RISE) % BOIL_WRAP;
        fireTime = (fireTime + time.delta) % FIRE_WRAP;
        uniforms.set({
          rise,
          boil,
          fire_time: fireTime,
          strength: params.strength * 0.01,
          scale: params.scale,
          extent: params.height,
          plumes: params.plumes,
          chroma: params.chroma,
          blur: params.blur,
          fire: params.fire,
          view: Math.max(0, (VIEWS as readonly string[]).indexOf(params.view)),
        });
        uniforms.upload();

        renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('haze'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        backdrop?.destroy();
        uniforms.destroy();
        backdropUniforms.destroy();
        tail.destroy();
      },
    };
  },
});
