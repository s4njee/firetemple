import { createFullscreenPipeline, renderFullscreen } from '../fullscreen.ts';
import { generateMipmaps, mipLevelCount } from '../mipmap.ts';
import { perDevice } from '../passes/common.ts';
import bakeShader from './noise-bake.wgsl';

/*
 * The shared noise texture: four tileable noise fields baked once per device, so an effect can
 * read noise with a texture fetch instead of computing it at every pixel. Epic 3 measured why
 * this matters: full-canvas procedural noise is what put its scenes over the Tier A budget.
 *
 *   const noise = getNoiseTexture(device);
 *   // bind noise.view and noise.sampler, then in WGSL:
 *   //   #include "noisetex.wgsl"
 *   //   let n = noisetex_flame(noise_tex, noise_smp, p, time * speed);
 *
 * It belongs to the device, not to the effect: do not destroy it. Thumbnails and the effect page
 * share one copy (about 0.7 MB with its mips).
 */

export const NOISE_TEXTURE_SIZE = 256;
/** Noise cells of the coarsest octave across the tile; `NOISETEX_CELLS` in noisetex.wgsl. */
export const NOISE_TEXTURE_CELLS = 8;
export const NOISE_TEXTURE_FORMAT: GPUTextureFormat = 'rgba16float';

export interface NoiseTexture {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  /** Repeating, trilinear: the tile is seamless and mipmapped. */
  readonly sampler: GPUSampler;
  readonly size: number;
}

function bake(device: GPUDevice): NoiseTexture {
  const size = NOISE_TEXTURE_SIZE;
  const texture = device.createTexture({
    label: 'shared noise',
    size: [size, size],
    format: NOISE_TEXTURE_FORMAT,
    mipLevelCount: mipLevelCount(size, size),
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      // Lets tests and tools read it back; costs nothing.
      GPUTextureUsage.COPY_SRC,
  });
  const pipeline = createFullscreenPipeline(device, {
    fragment: bakeShader,
    format: NOISE_TEXTURE_FORMAT,
  });
  const encoder = device.createCommandEncoder({ label: 'bake shared noise' });
  renderFullscreen(encoder, texture.createView({ baseMipLevel: 0, mipLevelCount: 1 }), pipeline);
  generateMipmaps(device, texture, encoder);
  device.queue.submit([encoder.finish()]);

  return {
    texture,
    view: texture.createView({ label: 'shared noise view' }),
    sampler: device.createSampler({
      label: 'shared noise sampler',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    }),
    size,
  };
}

/** The noise texture of `device`, baked on first use (a few milliseconds of GPU time, once). */
export const getNoiseTexture = perDevice(bake);
