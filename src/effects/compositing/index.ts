import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import shader from './scene.wgsl';

const Params = defineUniformStruct('Params', {
  time: 'f32',
  aspect: 'f32',
  pixel: 'f32',
  height: 'f32',
  intensity: 'f32',
  smoke: 'f32',
  logs: 'f32',
});

/** CSS `mix-blend-mode` values worth trying on the canvas element (see docs/compositing-study.md). */
const CSS_BLENDS = ['normal', 'screen', 'plus-lighter', 'lighten', 'multiply'] as const;

export const effect = defineEffect({
  meta,
  params: {
    speed: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    intensity: { type: 'number', default: 8, min: 0, max: 30, step: 0.1 },
    height: { type: 'number', default: 0.5, min: 0.2, max: 0.8, step: 0.01, label: 'flame height' },
    smoke: { type: 'number', default: 0.8, min: 0, max: 1, step: 0.01 },
    logs: { type: 'boolean', default: true },
    cssBlend: { type: 'select', default: 'normal', options: CSS_BLENDS, label: 'CSS blend mode' },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  // One preset per strategy of the study. `cssBlend` only does anything in a browser.
  presets: {
    recommended: { alpha: 'luminance', alphaGain: 1, underlay: 0.3, cssBlend: 'normal' },
    'no underlay': { alpha: 'luminance', alphaGain: 1, underlay: 0, cssBlend: 'normal' },
    'heavy underlay': { alpha: 'luminance', alphaGain: 1, underlay: 0.6, cssBlend: 'normal' },
    additive: { alpha: 'additive', underlay: 0, cssBlend: 'normal' },
    'additive + underlay': { alpha: 'additive', underlay: 0.6, cssBlend: 'normal' },
    coverage: { alpha: 'coverage', underlay: 0, cssBlend: 'normal' },
    'hard alpha': { alpha: 'luminance', alphaGain: 3, underlay: 0, cssBlend: 'normal' },
    opaque: { alpha: 'opaque', underlay: 0, cssBlend: 'normal' },
    'css screen': { alpha: 'opaque', underlay: 0, cssBlend: 'screen' },
    'css plus-lighter': { alpha: 'luminance', alphaGain: 1, underlay: 0, cssBlend: 'plus-lighter' },
    'css lighten': { alpha: 'opaque', underlay: 0, cssBlend: 'lighten' },
    'css multiply': { alpha: 'luminance', alphaGain: 1, underlay: 0, cssBlend: 'multiply' },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'compositing' });
    const uniforms = createUniformBuffer(device, Params, 'compositing params');
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const bindGroup = device.createBindGroup({
      label: 'compositing',
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniforms.buffer } }],
    });

    // The one place an effect touches the element it draws into: the CSS blend modes are part of
    // the comparison, and they are a property of the canvas, not of anything a shader can write.
    const style = canvas.style as Partial<CSSStyleDeclaration> | undefined;
    const blendBefore = style?.mixBlendMode ?? '';
    let blendApplied: string | undefined;
    const applyBlend = (mode: string) => {
      if (!style || mode === blendApplied) return;
      style.mixBlendMode = mode === 'normal' ? blendBefore : mode;
      blendApplied = mode;
    };

    let phase = 0;

    return {
      resize(width, height) {
        tail.resize(width, height);
        uniforms.set({ aspect: width / height, pixel: 1 / height });
      },
      frame(time, encoder, target) {
        phase += time.delta * params.speed;
        applyBlend(params.cssBlend);
        uniforms.set({
          time: phase,
          height: params.height,
          intensity: params.intensity,
          smoke: params.smoke,
          logs: params.logs ? 1 : 0,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('scene'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },
      destroy() {
        applyBlend('normal');
        uniforms.destroy();
        tail.destroy();
      },
    };
  },
});
