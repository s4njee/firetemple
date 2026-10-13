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
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import shader from './haze-overlay.wgsl';
import { meta } from './meta.ts';
import pictureShader from './picture.wgsl';

const Params = defineUniformStruct('Params', {
  fit: 'vec2f',
  rise: 'vec2f',
  aspect: 'f32',
  strength: 'f32',
  scale: 'f32',
  extent: 'f32',
  position: 'f32',
  centre: 'f32',
  width: 'f32',
  chroma: 'f32',
  blur: 'f32',
  mirage: 'f32',
  media_lod: 'f32',
  noise_lod: 'f32',
  shape: 'u32',
  view: 'u32',
});

const PictureParams = defineUniformStruct('PictureParams', {
  aspect: 'f32',
  pixel: 'f32',
  style: 'u32',
});

/** The stand-in pictures of picture.wgsl, in its `style` order. */
const PICTURES = ['desert road', 'city at dusk', 'test grid'] as const;
const SHAPES = ['band', 'plume', 'whole frame'] as const;
const FITS = ['cover', 'contain'] as const;
const VIEWS = ['picture', 'heat mask'] as const;

// sRGB-encoded 8-bit, like an uploaded photo: sampling returns linear light.
const PICTURE_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb';

// Must match HO_STRETCH and HO_FINE in haze-overlay.wgsl.
const STRETCH = 3;
const FINE = 1.83;
// The fine layer climbs this much faster than the coarse one, so the two never lock together.
const FINE_RISE = 1.37;
// Texels of the noise tile per noise cell.
const NOISE_TEXELS_PER_CELL = 32;
// The coarsest level the offset is read from: the tile's finest octaves would only add jitter.
const NOISE_MIN_LOD = 2;

const indexOf = (list: readonly string[], value: string) => Math.max(0, list.indexOf(value));

export const effect = defineEffect({
  meta,
  params: {
    image: { type: 'select', default: 'desert road', options: PICTURES, label: 'stand-in image' },
    fit: { type: 'select', default: 'cover', options: FITS },
    shape: { type: 'select', default: 'band', options: SHAPES },
    strength: {
      type: 'number',
      default: 0.3,
      min: 0,
      max: 1.5,
      step: 0.01,
      label: 'strength (% of height)',
    },
    scale: { type: 'number', default: 36, min: 8, max: 120, step: 1 },
    speed: { type: 'number', default: 0.35, min: 0, max: 2, step: 0.01, label: 'rise speed' },
    height: { type: 'number', default: 0.3, min: 0.03, max: 1, step: 0.01, label: 'haze height' },
    position: { type: 'number', default: 0.44, min: 0, max: 1, step: 0.01, label: 'source height' },
    centre: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'plume centre' },
    width: { type: 'number', default: 0.1, min: 0.02, max: 0.6, step: 0.01, label: 'plume width' },
    chroma: { type: 'number', default: 0.15, min: 0, max: 1, step: 0.01, label: 'colour split' },
    blur: { type: 'number', default: 0.5, min: 0, max: 3, step: 0.05 },
    mirage: { type: 'number', default: 0, min: 0, max: 1, step: 0.01 },
    view: { type: 'select', default: 'picture', options: VIEWS },
    ...TAIL_PARAMS,
    // Nothing here is brighter than paper white, so there is nothing for bloom to do; at any
    // setting above zero it would only fog the bright parts of the picture.
    bloom: { ...TAIL_PARAMS.bloom, default: 0 },
  },
  presets: {
    'hot road': {
      image: 'desert road',
      shape: 'band',
      position: 0.44,
      height: 0.3,
      strength: 0.3,
      scale: 36,
      speed: 0.35,
      chroma: 0.15,
      blur: 0.5,
      mirage: 0,
    },
    mirage: {
      image: 'desert road',
      shape: 'band',
      position: 0.44,
      height: 0.2,
      strength: 0.4,
      scale: 30,
      speed: 0.2,
      chroma: 0.1,
      blur: 0.8,
      mirage: 0.85,
    },
    'engine exhaust': {
      image: 'city at dusk',
      shape: 'plume',
      position: 0.3,
      centre: 0.3,
      width: 0.09,
      height: 0.6,
      strength: 0.6,
      scale: 34,
      speed: 0.9,
      chroma: 0.25,
      blur: 0.9,
      mirage: 0,
    },
    'heat wave': {
      shape: 'whole frame',
      strength: 0.2,
      scale: 36,
      speed: 0.25,
      chroma: 0.1,
      blur: 0.3,
      mirage: 0,
    },
    'test grid': { image: 'test grid', shape: 'band', position: 0.3, height: 0.5, mirage: 0 },
    off: { strength: 0, chroma: 0, blur: 0, mirage: 0 },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'haze-overlay' });
    const uniforms = createUniformBuffer(device, Params, 'haze-overlay params');
    const pictureUniforms = createUniformBuffer(device, PictureParams, 'haze-overlay picture');
    const noise = getNoiseTexture(device);

    const picturePipeline = createFullscreenPipeline(device, {
      fragment: withChunks(pictureShader, { 'picture-params.wgsl': PictureParams.wgsl }),
      format: PICTURE_FORMAT,
    });
    const pictureBindGroup = device.createBindGroup({
      label: 'haze-overlay picture',
      layout: picturePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: pictureUniforms.buffer } }],
    });
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    // Trilinear, so the softening can read between mip levels; clamped, so an offset at the edge
    // of the picture repeats the edge instead of wrapping to the other side.
    const sampler = device.createSampler({
      label: 'haze-overlay media sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    let width = 1;
    let height = 1;
    // The stand-in picture, drawn by picture.wgsl at canvas size.
    let picture: MediaTexture | undefined;
    let pictureLevel0: GPUTextureView | undefined;
    let drawnStyle: number | undefined;
    // The visitor's own image or video, once they have dropped one. It replaces the stand-in until
    // the `image` parameter is changed.
    let dropped: MediaTexture | undefined;
    let droppedOver: string | undefined;
    let bindGroup: GPUBindGroup | undefined;
    let boundView: GPUTextureView | undefined;
    let destroyed = false;
    let loading = 0;

    async function load(file: File) {
      const ticket = ++loading;
      try {
        // A video's mips would have to be rebuilt for every frame: leave them out, and the
        // softening (which reads them) is simply off for video.
        const media = await createMediaFromFile(device, file, {
          label: 'haze-overlay dropped media',
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
        console.warn('haze-overlay: could not use that file.', error);
      }
    }

    // Drag and drop on the canvas is the one way in that needs no markup of its own. Without the
    // dragover handler the browser would navigate to the file instead.
    const onDragOver = (event: Event) => event.preventDefault();
    const onDrop = (event: Event) => {
      event.preventDefault();
      const file = (event as DragEvent).dataTransfer?.files?.[0];
      if (file) void load(file);
    };
    canvas.addEventListener('dragover', onDragOver);
    canvas.addEventListener('drop', onDrop);

    // Accumulated in noise cells and wrapped where the tile repeats, so neither a change of speed
    // or scale nor the wrap itself makes the pattern jump.
    const rise: [number, number] = [0, 0];

    return {
      resize(w, h) {
        width = w;
        height = h;
        tail.resize(w, h);
        pictureUniforms.set({ aspect: w / h, pixel: 1 / h });

        picture?.destroy();
        const texture = device.createTexture({
          label: 'haze-overlay picture',
          size: [w, h],
          format: PICTURE_FORMAT,
          mipLevelCount: mipLevelCount(w, h),
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        picture = mediaFromTexture(texture);
        pictureLevel0 = texture.createView({
          label: 'haze-overlay picture level 0',
          baseMipLevel: 0,
          mipLevelCount: 1,
        });
        drawnStyle = undefined;
      },

      frame(time, encoder, target) {
        if (!picture || !pictureLevel0) return;

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
        if (media.view !== boundView) {
          boundView = media.view;
          bindGroup = device.createBindGroup({
            label: 'haze-overlay',
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniforms.buffer } },
              { binding: 1, resource: media.view },
              { binding: 2, resource: sampler },
              { binding: 3, resource: noise.view },
              { binding: 4, resource: noise.sampler },
            ],
          });
        }
        if (!bindGroup) return;

        const cellsPerSecond = (params.speed * params.scale) / STRETCH;
        rise[0] = (rise[0] + time.delta * cellsPerSecond) % NOISE_TEXTURE_CELLS;
        rise[1] = (rise[1] + time.delta * cellsPerSecond * FINE * FINE_RISE) % NOISE_TEXTURE_CELLS;

        const fit = fitScale(width / height, media.aspect, params.fit as MediaFit);
        // Media texels under one canvas pixel: a large photo in a small canvas reads a coarser
        // level instead of aliasing.
        const texels = Math.max((media.width * fit[0]) / width, (media.height * fit[1]) / height);
        const mediaLod = Math.min(Math.max(Math.log2(texels), 0), media.mipLevelCount - 1);
        // Noise texels under one canvas pixel, across the streaks.
        const noiseTexels = (NOISE_TEXELS_PER_CELL * params.scale) / height;

        uniforms.set({
          fit,
          rise,
          aspect: width / height,
          strength: params.strength * 0.01,
          scale: params.scale,
          extent: params.height,
          position: params.position,
          centre: params.centre,
          width: params.width,
          chroma: params.chroma,
          // Without a mip chain there is nothing softer to read.
          blur: Math.min(params.blur, media.mipLevelCount - 1 - mediaLod),
          mirage: params.mirage,
          media_lod: mediaLod,
          noise_lod: Math.max(Math.log2(noiseTexels), NOISE_MIN_LOD),
          shape: indexOf(SHAPES, params.shape),
          view: indexOf(VIEWS, params.view),
        });
        uniforms.upload();

        renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('haze'),
        });
        // The picture is display-referred already: a photo must come out as it went in, so the
        // tail only encodes and dithers it (and applies `exposure`), with no tonemap curve.
        tail.encode(encoder, target, time, params, profiler, { output: { tonemap: 'none' } });
      },

      destroy() {
        destroyed = true;
        canvas.removeEventListener('dragover', onDragOver);
        canvas.removeEventListener('drop', onDrop);
        picture?.destroy();
        dropped?.destroy();
        uniforms.destroy();
        pictureUniforms.destroy();
        tail.destroy();
      },
    };
  },
});
