import { getNoiseTexture, NOISE_TEXTURE_CELLS } from '../../gpu/emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import {
  classifyFile,
  createMediaFromFile,
  fitScale,
  mediaFromTexture,
  type MediaFit,
  type MediaTexture,
} from '../../gpu/media.ts';
import { generateMipmaps, mipLevelCount } from '../../gpu/mipmap.ts';
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createExcitation, EXCITATIONS } from '../../gpu/sim/excitation.ts';
import { createFluid, type Fluid } from '../../gpu/sim/fluid.ts';
import { createAmbientIgnition, createPointerIgnition } from '../../gpu/sim/ignition.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect, type EffectInstance } from '../types.ts';
import { meta } from './meta.ts';
import pictureShader from './picture.wgsl';
import shader from './shimmer.wgsl';

// Story 6.9: the temperature and velocity fields of the stable-fluids solver (src/gpu/sim/fluid.ts)
// drive heat haze over a picture. A heat source below the frame (and the pointer, as a torch) puts
// lumpy heat into the fluid's dye; buoyancy lifts it, confinement curls it, and the display pass
// (shimmer.wgsl) bends the picture along minus the temperature gradient, plus a fine noise pattern
// that the gas carries with it (a flow map over the fluid's own velocity). Where the gas has cooled
// the picture is untouched to the bit. Compared with the noise-driven `haze-overlay` (Epic 4): there
// the shimmer is a texture scrolling upward at one speed inside a mask; here it is the gas itself.

const Params = defineUniformStruct('Params', {
  fit: 'vec2f',
  dye_texel: 'vec2f',
  flow: 'vec4f',
  seeds: 'vec4f',
  aspect: 'f32',
  strength: 'f32',
  gain: 'f32',
  detail: 'f32',
  scale: 'f32',
  cold: 'f32',
  full: 'f32',
  chroma: 'f32',
  blur: 'f32',
  media_lod: 'f32',
  noise_lod: 'f32',
  glow: 'f32',
  glow_scale: 'f32',
  view: 'u32',
});

const PictureParams = defineUniformStruct('PictureParams', {
  aspect: 'f32',
  pixel: 'f32',
  style: 'u32',
});

/** The stand-in pictures of picture.wgsl, in its `style` order. */
const PICTURES = ['page', 'brick wall', 'test grid'] as const;
const FITS = ['cover', 'contain'] as const;
export const VIEWS = ['picture', 'temperature', 'displacement'] as const;
const RESOLUTIONS = ['96', '128', '160'] as const;

// sRGB-encoded 8-bit, like an uploaded photo: sampling returns linear light.
const PICTURE_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb';

/** Bend per unit of temperature gradient (temperature per image height) before saturation. */
export const HAZE_GAIN = 0.015;
/** Below this temperature the air counts as cold: the displacement is exactly zero. */
export const HAZE_COLD = 0.02;
/** Temperature that counts as fully hot, for the detail, the softening and the glow. */
const HAZE_FULL = 1;
/** Noise cells per image height of the carried detail, and how long one flow-map layer lives. */
const DETAIL_SCALE = 30;
const FLOW_PERIOD = 0.8;
// Texels of the noise tile per noise cell, and the coarsest level the detail is read from.
const NOISE_TEXELS_PER_CELL = 32;
const NOISE_MIN_LOD = 1;

/** The source line, in uv: at the bottom edge, half in view. */
export const SOURCE_Y = 0.995;
/** Peak heat of one lump of the source, at level 1 and 60 frames a second. */
const SOURCE_LUMP = 0.3;
/** Peak heat of one lump of the torch. */
const TORCH_LUMP = 0.35;
/** Full drive raises the source and the ember rate by these shares. */
export const DRIVE_HEAT = 0.6;
export const DRIVE_EMBERS = 1;
/** Seconds of heating run before the first frame, so a still frame already shimmers. */
export const WARM_UP_SECONDS = 2;

const indexOf = (list: readonly string[], value: string) => Math.max(0, list.indexOf(value));

/** The running effect, with its solver exposed for tests. */
export interface FireHazeInstance extends EffectInstance {
  readonly fluid: Fluid;
}

/** mulberry32: small, fast, repeatable. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A repeatable offset (noise cells) for the flow-map layer that starts in cycle `n`. */
function layerSeed(n: number): [number, number] {
  const r = random(n * 7919 + 13);
  return [r() * NOISE_TEXTURE_CELLS, r() * NOISE_TEXTURE_CELLS];
}

export const effect = defineEffect({
  meta,
  params: {
    image: { type: 'select', default: 'page', options: PICTURES, label: 'stand-in image' },
    fit: { type: 'select', default: 'cover', options: FITS },
    strength: {
      type: 'number',
      default: 0.8,
      min: 0,
      max: 2,
      step: 0.01,
      label: 'strength (% of height)',
    },
    detail: {
      type: 'number',
      default: 0.5,
      min: 0,
      max: 1.5,
      step: 0.01,
      label: 'carried detail',
    },
    heat: { type: 'number', default: 1, min: 0, max: 2.5, step: 0.01, label: 'source heat' },
    sourceWidth: {
      type: 'number',
      default: 0.4,
      min: 0.05,
      max: 1,
      step: 0.01,
      label: 'source width',
    },
    sourceX: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'source centre' },
    torch: {
      type: 'number',
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'torch when hovering',
    },
    embers: { type: 'number', default: 0.5, min: 0, max: 4, step: 0.05, label: 'wisps / s' },
    buoyancy: { type: 'number', default: 2, min: 0, max: 4, step: 0.01 },
    cooling: {
      type: 'number',
      default: 0.7,
      min: 0.1,
      max: 4,
      step: 0.01,
      label: 'cooling (1 / s)',
    },
    vorticity: {
      type: 'number',
      default: 6,
      min: 0,
      max: 20,
      step: 0.5,
      label: 'vorticity confinement (1 / s)',
    },
    chroma: { type: 'number', default: 0.12, min: 0, max: 1, step: 0.01, label: 'colour split' },
    blur: { type: 'number', default: 0.4, min: 0, max: 2, step: 0.05 },
    glow: { type: 'number', default: 0.12, min: 0, max: 1, step: 0.01, label: 'source glow' },
    view: { type: 'select', default: 'picture', options: VIEWS },
    resolution: {
      type: 'select',
      default: '128',
      options: RESOLUTIONS,
      label: 'velocity cells (long side)',
    },
    drive: { type: 'select', default: 'none', options: EXCITATIONS },
    ...TAIL_PARAMS,
    // The picture is no brighter than paper white, so bloom would only fog it.
    bloom: { ...TAIL_PARAMS.bloom, default: 0 },
  },
  presets: {
    'hot plate': {},
    // A narrow, strong source under a wall: a chimney's or an exhaust's column of hot air.
    chimney: {
      image: 'brick wall',
      heat: 1.8,
      sourceWidth: 0.08,
      sourceX: 0.68,
      strength: 0.8,
      vorticity: 9,
      cooling: 0.5,
      glow: 0,
    },
    // No source: the pointer is the only heat (and a few stray wisps), as a torch over the page.
    'torch only': { heat: 0, torch: 1, embers: 0.4, glow: 0.35 },
    // The gradient of the temperature alone, no carried noise: the fluid's own lens.
    'gradient only': { detail: 0 },
    'test grid': { image: 'test grid', sourceWidth: 0.6, strength: 0.7 },
  },

  async create({ device, format, hdr, canvas, params, profiler }): Promise<FireHazeInstance> {
    const tail = createHdrTail(device, { format, hdr, label: 'fire-haze' });
    const uniforms = createUniformBuffer(device, Params, 'fire-haze params');
    const pictureUniforms = createUniformBuffer(device, PictureParams, 'fire-haze picture');
    const noise = getNoiseTexture(device);

    const picturePipeline = createFullscreenPipeline(device, {
      fragment: withChunks(pictureShader, { 'picture-params.wgsl': PictureParams.wgsl }),
      format: PICTURE_FORMAT,
    });
    const pictureBindGroup = device.createBindGroup({
      label: 'fire-haze picture',
      layout: picturePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: pictureUniforms.buffer } }],
    });
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    // Trilinear, so the softening reads between mip levels; clamped, so an offset at the edge of the
    // picture repeats the edge instead of wrapping to the other side.
    const mediaSampler = device.createSampler({
      label: 'fire-haze media sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const fieldSampler = device.createSampler({
      label: 'fire-haze field sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    let width = Math.max(1, canvas.width || 16);
    let height = Math.max(1, canvas.height || 9);
    let simAspect = width / height;
    const cells = () => Number(params.resolution) || 128;
    const fluid: Fluid = createFluid({
      device,
      resolution: cells(),
      dyeResolution: Math.min(1024, cells() * 4),
      width,
      height,
      params: { boundary: 'open', buoyancyWeights: [1, 0, 0, 0] },
      profiler,
      label: 'fire-haze',
    });

    const pointer = createPointerIgnition(canvas, { radius: 0.03, hover: params.torch });
    const embers = createAmbientIgnition({
      rate: params.embers,
      radius: 0.02,
      region: [0.05, 0.45, 0.95, 0.98],
      seed: 29,
    });
    let drive = createExcitation(params.drive, canvas);
    const rand = random(1234);

    // The stand-in picture, drawn by picture.wgsl at canvas size.
    let picture: MediaTexture | undefined;
    let pictureLevel0: GPUTextureView | undefined;
    let drawnStyle: number | undefined;
    // The visitor's own image or video, once they have dropped one. It replaces the stand-in until
    // the `image` parameter is changed.
    let dropped: MediaTexture | undefined;
    let droppedOver: string | undefined;
    let destroyed = false;
    let loading = 0;

    async function load(file: File) {
      const ticket = ++loading;
      try {
        // A video's mips would have to be rebuilt for every frame: leave them out, and the
        // softening (which reads them) is simply off for video.
        const media = await createMediaFromFile(device, file, {
          label: 'fire-haze dropped media',
          mipmaps: classifyFile(file) !== 'video',
        });
        if (destroyed || ticket !== loading) {
          media.destroy();
          return;
        }
        dropped?.destroy();
        dropped = media;
        droppedOver = params.image;
      } catch (error) {
        console.warn('fire-haze: could not use that file.', error);
      }
    }

    // Drag and drop on the canvas. Without the dragover handler the browser would open the file.
    const onDragOver = (event: Event) => event.preventDefault();
    const onDrop = (event: Event) => {
      event.preventDefault();
      const file = (event as DragEvent).dataTransfer?.files?.[0];
      if (file) void load(file);
    };
    const listening = typeof canvas.addEventListener === 'function';
    if (listening) {
      canvas.addEventListener('dragover', onDragOver);
      canvas.addEventListener('drop', onDrop);
    }

    function sync() {
      const p = fluid.params;
      p.vorticity = params.vorticity;
      p.velocityDissipation = 0.5;
      p.buoyancy = params.buoyancy;
      p.buoyancyWeights = [1, 0, 0, 0];
      p.dyeDissipation = [params.cooling, 0, 0, 0];
      fluid.setResolution(cells(), Math.min(1024, cells() * 4));
    }

    /** Lumps of heat at random places along a segment (uv), each `lump` hot at its centre. */
    function lumps(
      from: readonly [number, number],
      to: readonly [number, number],
      spread: number,
      count: number,
      lump: number,
    ) {
      const aspect = fluid.grid.aspect;
      for (let i = 0; i < count; i++) {
        const t = rand();
        const angle = rand() * Math.PI * 2;
        const reach = spread * Math.sqrt(rand());
        const x = from[0] + (to[0] - from[0]) * t + (Math.cos(angle) * reach) / aspect;
        const y = from[1] + (to[1] - from[1]) * t + Math.sin(angle) * reach;
        const radius = 0.007 + 0.011 * rand();
        const at: [number, number] = [x, y];
        fluid.addDye(at, at, radius, [lump * (0.3 + 1.4 * rand()), 0, 0, 0]);
      }
    }

    /** The source below the frame: lumpy heat along a line, and a gentle upward push. */
    function feed(delta: number, level: number) {
      const strength = Math.max(0, params.heat) * (1 + DRIVE_HEAT * level);
      if (strength <= 0 || delta <= 0) return;
      const aspect = fluid.grid.aspect;
      const span = Math.min(1, Math.max(0.02, params.sourceWidth));
      const centre = params.sourceX;
      const from: [number, number] = [centre - span / 2, SOURCE_Y];
      const to: [number, number] = [centre + span / 2, SOURCE_Y];
      // About one lump per 0.02 image heights of source a frame, whatever its width.
      const count = Math.max(2, Math.min(40, Math.round((span * aspect) / 0.02)));
      lumps(from, to, 0.008, count, SOURCE_LUMP * strength * delta * 60);
      fluid.addForce(from, to, 0.03, [0, -0.6 * strength * delta], 0.02);
    }

    /** The torch (pointer heat: a rate) and stray wisps (a puff each). */
    function ignite(delta: number, level: number) {
      pointer.hover = Math.max(0, params.torch);
      embers.rate = Math.max(0, params.embers) * (1 + DRIVE_EMBERS * level);
      for (const ig of pointer.collect(delta)) {
        lumps(
          [ig.fromX, ig.fromY],
          [ig.toX, ig.toY],
          ig.radius,
          4,
          TORCH_LUMP * ig.strength * delta * 60,
        );
      }
      for (const ig of embers.collect(delta)) {
        lumps([ig.fromX, ig.fromY], [ig.fromX, ig.fromY], ig.radius, 5, 0.45 * ig.strength);
      }
    }

    let warmed = -1;
    /** Heats up before the first frame, one step per command buffer (splats share one buffer). */
    function warmUp() {
      const steps = Math.round(WARM_UP_SECONDS / fluid.stepSeconds);
      for (let k = 0; k < steps; k++) {
        const encoder = device.createCommandEncoder({ label: 'fire-haze warm-up' });
        feed(fluid.stepSeconds, 0);
        fluid.advance(encoder, 1);
        device.queue.submit([encoder.finish()]);
      }
    }

    const groups = new Map<string, GPUBindGroup>();
    let groupGeneration = -1;
    function displayGroup(media: MediaTexture): GPUBindGroup {
      if (groupGeneration !== fluid.generation) {
        groups.clear();
        groupGeneration = fluid.generation;
      }
      const key = `${fluid.dye.slot}`;
      let group = groups.get(key);
      if (group && groupMedia === media.view) return group;
      if (groupMedia !== media.view) groups.clear();
      groupMedia = media.view;
      group = device.createBindGroup({
        label: 'fire-haze display',
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms.buffer } },
          { binding: 1, resource: media.view },
          { binding: 2, resource: mediaSampler },
          { binding: 3, resource: fluid.dye.view },
          { binding: 4, resource: fieldSampler },
          { binding: 5, resource: fluid.fieldsView },
          { binding: 6, resource: noise.view },
          { binding: 7, resource: noise.sampler },
        ],
      });
      groups.set(key, group);
      return group;
    }
    let groupMedia: GPUTextureView | undefined;

    let flowClock = 0;

    return {
      get fluid() {
        return fluid;
      },
      resize(w, h) {
        width = Math.max(1, Math.round(w));
        height = Math.max(1, Math.round(h));
        tail.resize(width, height);
        pictureUniforms.set({ aspect: width / height, pixel: 1 / height });

        picture?.destroy();
        const texture = device.createTexture({
          label: 'fire-haze picture',
          size: [width, height],
          format: PICTURE_FORMAT,
          mipLevelCount: mipLevelCount(width, height),
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        picture = mediaFromTexture(texture);
        pictureLevel0 = texture.createView({
          label: 'fire-haze picture level 0',
          baseMipLevel: 0,
          mipLevelCount: 1,
        });
        drawnStyle = undefined;
        groups.clear();
        groupMedia = undefined;

        const aspect = width / height;
        if (Math.abs(Math.log(aspect / simAspect)) > 0.06) {
          simAspect = aspect;
          fluid.resize(width, height);
        }
      },

      frame(time, encoder, target) {
        if (!picture || !pictureLevel0) return;
        const delta = Math.min(Math.max(time.delta, 0), 0.25);
        sync();
        if (warmed !== fluid.generation) {
          warmed = fluid.generation;
          warmUp();
        }

        // Choosing a stand-in again puts the dropped file away.
        if (dropped && params.image !== droppedOver) {
          dropped.destroy();
          dropped = undefined;
        }
        const style = indexOf(PICTURES, params.image);
        if (!dropped && style !== drawnStyle) {
          pictureUniforms.set({ style });
          pictureUniforms.upload();
          renderFullscreen(encoder, pictureLevel0, picturePipeline, [pictureBindGroup], {
            timestampWrites: profiler.pass('picture'),
          });
          generateMipmaps(device, picture.texture, encoder);
          drawnStyle = style;
        }
        const media = dropped ?? picture;
        // A video uploads its new frame here, when it has one.
        media.update(encoder);

        if (params.drive !== drive.kind) {
          drive.destroy();
          drive = createExcitation(params.drive, canvas);
        }
        const level = drive.update(delta);
        ignite(delta, level);
        feed(delta, level);
        fluid.update(encoder, delta);

        // The flow map: two layers, each restarted every FLOW_PERIOD seconds, half a period apart.
        flowClock = (flowClock + delta) % (FLOW_PERIOD * 4096);
        const cycle = flowClock / FLOW_PERIOD;
        const phase = cycle - Math.floor(cycle);
        const phaseB = (phase + 0.5) % 1;
        const seedA = layerSeed(Math.floor(cycle));
        const seedB = layerSeed(Math.floor(cycle + 0.5) + 100000);

        const aspect = width / height;
        const fit = fitScale(aspect, media.aspect, params.fit as MediaFit);
        // Media texels under one canvas pixel: a large photo in a small canvas reads a coarser level.
        const texels = Math.max((media.width * fit[0]) / width, (media.height * fit[1]) / height);
        const mediaLod = Math.min(Math.max(Math.log2(texels), 0), media.mipLevelCount - 1);
        const noiseTexels = (NOISE_TEXELS_PER_CELL * DETAIL_SCALE) / height;
        const grid = fluid.grid;
        const view = indexOf(VIEWS, params.view);
        uniforms.set({
          fit,
          dye_texel: [1 / grid.dyeWidth, 1 / grid.dyeHeight],
          flow: [phase * FLOW_PERIOD, phaseB * FLOW_PERIOD, 1 - Math.abs(2 * phase - 1), 0],
          seeds: [seedA[0], seedA[1], seedB[0], seedB[1]],
          aspect,
          strength: Math.max(0, params.strength) * 0.01,
          gain: HAZE_GAIN,
          detail: Math.max(0, params.detail),
          scale: DETAIL_SCALE,
          cold: HAZE_COLD,
          full: HAZE_FULL,
          chroma: params.chroma,
          // Without a mip chain there is nothing softer to read.
          blur: Math.min(params.blur, media.mipLevelCount - 1 - mediaLod),
          media_lod: mediaLod,
          noise_lod: Math.max(Math.log2(noiseTexels), NOISE_MIN_LOD),
          glow: params.glow,
          glow_scale: 0.35,
          view,
        });
        uniforms.upload();

        renderFullscreen(encoder, tail.scene.view, pipeline, [displayGroup(media)], {
          timestampWrites: profiler.pass('haze'),
        });
        // The picture is display-referred already: a photo must come out as it went in, so the tail
        // only encodes and dithers it (and applies `exposure`), with no tonemap curve. The
        // diagnostic views are numbers, so they are not dithered either.
        tail.encode(encoder, target, time, params, profiler, {
          output: { tonemap: 'none', dither: view === 0 ? 1 : 0 },
        });
      },

      destroy() {
        destroyed = true;
        if (listening) {
          canvas.removeEventListener('dragover', onDragOver);
          canvas.removeEventListener('drop', onDrop);
        }
        pointer.destroy();
        embers.destroy();
        drive.destroy();
        picture?.destroy();
        dropped?.destroy();
        fluid.destroy();
        uniforms.destroy();
        pictureUniforms.destroy();
        tail.destroy();
      },
    };
  },
});
