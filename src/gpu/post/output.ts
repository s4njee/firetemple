import { createFullscreenPipeline, renderFullscreen } from '../fullscreen.ts';
import { linearSampler, perDevice } from '../passes/common.ts';
import { withChunks } from '../shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../uniforms.ts';
import outputSource from './output.wgsl';

const OutputParams = defineUniformStruct('OutputParams', {
  exposure: 'f32',
  tonemap: 'u32',
  view: 'u32',
  hdr: 'u32',
  headroom: 'f32',
  dither_lsb: 'f32',
  frame: 'f32',
  alpha_mode: 'u32',
  alpha_gain: 'f32',
  underlay: 'f32',
});

/** The tonemappers of `color.wgsl`; `none` clamps to [0, 1] on an SDR canvas. */
export const TONEMAPPERS = ['aces', 'reinhard', 'none'] as const;
export type Tonemapper = (typeof TONEMAPPERS)[number];

/** What the output pass shows: the normal result, or one input on its own for debugging. */
export const POST_VIEWS = ['final', 'scene', 'bloom'] as const;
export type PostView = (typeof POST_VIEWS)[number];

/**
 * What the output writes to alpha, for a canvas composited over the page. The canvas is
 * premultiplied, so the browser shows `rgb + (1 - alpha) * page` (docs/compositing-study.md):
 *
 * - `opaque`: 1. The effect owns its rectangle.
 * - `additive`: 0. The colour is added to the page. Right over dark pages; invisible over white,
 *   which has nothing left to add to. The colour is brighter than its alpha, which the canvas
 *   spec does not define: prefer `luminance`, which looks the same over a dark page.
 * - `coverage`: the scene's own alpha, for effects that draw premultiplied colour with real
 *   coverage (smoke, char, solid shapes). Light with no coverage (flame, bloom) stays additive,
 *   so over a light page the smoke shows and the fire does not.
 * - `luminance`: the scene's alpha or the brightest written channel times `alphaGain`, whichever
 *   is larger, so bright pixels cover the page instead of adding to it. With a gain of 1 or more
 *   the result is always a valid premultiplied colour. Over a dark page it is within a few
 *   8-bit steps of `additive`; over a light page the fire reads as flame-coloured ink. This is
 *   the default for overlay effects (`OVERLAY_PARAMS`).
 */
export const ALPHA_MODES = ['opaque', 'additive', 'coverage', 'luminance'] as const;
export type AlphaMode = (typeof ALPHA_MODES)[number];

const TONEMAP_ID: Record<Tonemapper, number> = { none: 0, aces: 1, reinhard: 2 };
const ALPHA_ID: Record<AlphaMode, number> = { opaque: 0, additive: 1, coverage: 2, luminance: 3 };
const VIEW_ID: Record<PostView, number> = { final: 0, scene: 1, bloom: 2 };

export interface OutputSettings {
  /** Linear multiplier applied to scene + bloom before tonemapping. Default 1. */
  exposure?: number;
  /** Default 'aces'. */
  tonemap?: Tonemapper;
  /**
   * Strength of the dither in 8-bit steps (default 1; 0 turns it off). The noise is triangular
   * interleaved-gradient noise added after the sRGB encode and before the canvas quantises. On an
   * HDR canvas it is scaled to a 10-bit step instead.
   */
  dither?: number;
  /** Changes every frame when the caller passes the frame counter, so the pattern does not stick. */
  frame?: number;
  /**
   * Write extended-range values for a canvas configured with `toneMapping: { mode: 'extended' }`.
   * Content at or below scene white (1.0 after exposure) looks the same as in SDR; brighter content
   * keeps rising instead of clipping, rolling off towards `headroom`.
   */
  hdr?: boolean;
  /** Peak output in multiples of SDR white when `hdr` is on. Default 3; keep it modest (see notes). */
  headroom?: number;
  /** Show only the scene, or only the bloom. Both still get exposure and tonemapping. */
  view?: PostView;
  /** Default 'opaque'. */
  alpha?: AlphaMode;
  /**
   * `luminance` mode: alpha per unit of output brightness. Default 1. Above 1 the dim edges of
   * the glow turn into a dark fringe (more page hidden than light added); below 1 the colour is
   * brighter than its alpha again, as in `additive`.
   */
  alphaGain?: number;
  /**
   * 0..1, ignored when opaque: the most the page is dimmed around bright areas. The bloom is the
   * mask, widened so the dimming reaches past the visible glow, and it multiplies with the mode's
   * own alpha: `alpha = 1 - (1 - modeAlpha) * (1 - underlay * mask)`. Over a dark page it changes
   * nothing visible; over a light page it is what keeps the flame brighter than its surroundings.
   * 0 (default) is off. Needs bloom to be on.
   */
  underlay?: number;
}

export interface OutputPassOptions {
  /** Format of the target views passed to `encode` (the canvas format, e.g. bgra8unorm or rgba16float). */
  format: GPUTextureFormat;
  label?: string;
}

export interface OutputPass {
  /**
   * Draws `scene` (+ `bloom`) into `target`. `scene` and `bloom` may be different sizes: both are
   * sampled bilinearly. Without `bloom` a shared black texel stands in for it.
   */
  encode(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    scene: GPUTextureView,
    bloom: GPUTextureView | undefined,
    settings?: OutputSettings,
    timestampWrites?: GPURenderPassTimestampWrites,
  ): void;
  destroy(): void;
}

interface OutputState {
  layout: GPUBindGroupLayout;
  pipelines: Map<GPUTextureFormat, GPURenderPipeline>;
  black: GPUTexture;
  blackView: GPUTextureView;
}

const stateFor = perDevice((device): OutputState => {
  const black = device.createTexture({
    label: 'post black',
    size: [1, 1],
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  return {
    layout: device.createBindGroupLayout({
      label: 'post output layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    }),
    pipelines: new Map(),
    black,
    // A new texture is zero-filled, which is exactly "no bloom".
    blackView: black.createView(),
  };
});

export function createOutputPass(device: GPUDevice, options: OutputPassOptions): OutputPass {
  const label = options.label ?? 'post output';
  const state = stateFor(device);
  const uniforms = createUniformBuffer(device, OutputParams, `${label} params`);

  let pipeline = state.pipelines.get(options.format);
  if (!pipeline) {
    pipeline = createFullscreenPipeline(device, {
      label: `post output ${options.format}`,
      fragment: withChunks(outputSource, { 'output-params.wgsl': OutputParams.wgsl }),
      format: options.format,
      layout: [state.layout],
    });
    state.pipelines.set(options.format, pipeline);
  }

  let group: GPUBindGroup | undefined;
  let groupKey: [GPUTextureView, GPUTextureView] | undefined;

  return {
    encode(encoder, target, scene, bloom, settings = {}, timestampWrites) {
      const glow = bloom ?? state.blackView;
      if (!group || groupKey?.[0] !== scene || groupKey[1] !== glow) {
        group = device.createBindGroup({
          label,
          layout: state.layout,
          entries: [
            { binding: 0, resource: scene },
            { binding: 1, resource: glow },
            { binding: 2, resource: linearSampler(device) },
            { binding: 3, resource: { buffer: uniforms.buffer } },
          ],
        });
        groupKey = [scene, glow];
      }
      const hdr = settings.hdr === true;
      uniforms.set({
        exposure: Math.max(0, settings.exposure ?? 1),
        tonemap: TONEMAP_ID[settings.tonemap ?? 'aces'],
        view: VIEW_ID[settings.view ?? 'final'],
        hdr: hdr ? 1 : 0,
        headroom: Math.max(1, settings.headroom ?? 3),
        // One 8-bit step is 1/255; an HDR canvas is presented at 10 bits at best, so a quarter of it.
        dither_lsb: ((settings.dither ?? 1) / 255) * (hdr ? 0.25 : 1),
        frame: (settings.frame ?? 0) % 64,
        alpha_mode: ALPHA_ID[settings.alpha ?? 'opaque'],
        alpha_gain: Math.max(0, settings.alphaGain ?? 1),
        underlay: Math.min(1, Math.max(0, settings.underlay ?? 0)),
      });
      uniforms.upload();
      renderFullscreen(encoder, target, pipeline, [group], { label, timestampWrites });
    },
    destroy() {
      uniforms.destroy();
      group = undefined;
      groupKey = undefined;
    },
  };
}
