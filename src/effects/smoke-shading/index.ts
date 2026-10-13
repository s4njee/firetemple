import { flickerIntensity, type FlickerSettings } from '../../gpu/emission/flicker.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { linearSampler } from '../../gpu/passes/common.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createRenderTarget } from '../../gpu/targets.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import shader from './smoke-shading.wgsl';
import upsampleShader from './upsample.wgsl';

const Params = defineUniformStruct('Params', {
  time: 'f32',
  aspect: 'f32',
  density: 'f32',
  soot: 'f32',
  fire_light: 'f32',
  sky: 'f32',
  g: 'f32',
  flame: 'f32',
  steps: 'f32',
  shadowing: 'u32',
  frame: 'u32',
  exposure: 'f32',
  flicker: 'f32',
});

/** The fire's brightness wanders by a few percent: a flicker, not a flash (see flicker.wgsl). */
const FIRE_FLICKER: FlickerSettings = { rate: 3, depth: 0.25, shimmer: 0.02, shimmerRate: 13 };
const FIRE_FLICKER_MEAN = 1 - (FIRE_FLICKER.depth + FIRE_FLICKER.shimmer) / 2;

/**
 * The march never runs taller than this many pixels: on a larger canvas it renders into a smaller
 * target (down to a third of the size) and is stretched over the scene. Smoke is soft, and the march
 * is the whole cost of the effect, so this is the difference between 1080p and a quarter of it.
 */
const MARCH_HEIGHT = 540;
const MARCH_MIN_SCALE = 1 / 3;

/** Order matches the SHADOW_* constants in smoke-shading.wgsl. */
const SHADOWING = ['none', 'gradient', 'march'] as const;

export const effect = defineEffect({
  meta,
  params: {
    shadowing: { type: 'select', default: 'gradient', options: SHADOWING },
    soot: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.01 },
    density: { type: 'number', default: 1, min: 0.1, max: 3, step: 0.01 },
    fireLight: { type: 'number', default: 1.5, min: 0, max: 6, step: 0.05, label: 'fire light' },
    sky: { type: 'number', default: 0.7, min: 0, max: 3, step: 0.01, label: 'sky light' },
    g: { type: 'number', default: 0.4, min: -0.5, max: 0.8, step: 0.01, label: 'anisotropy g' },
    flame: { type: 'number', default: 1, min: 0, max: 1.5, step: 0.01 },
    steps: { type: 'number', default: 32, min: 16, max: 64, step: 1 },
    speed: { type: 'number', default: 1, min: 0, max: 2.5, step: 0.01 },
    ...TAIL_PARAMS,
    // Smoke hides what is behind it, so the scene writes real coverage into alpha. The shared
    // default, `luminance`, keeps that coverage and adds the flame's own; `coverage` shows the
    // scene's alpha alone.
    ...OVERLAY_PARAMS,
  },
  presets: {
    'wood-smoke': { soot: 0.05, density: 0.9, fireLight: 0.8, sky: 0.5, g: 0.45, flame: 1 },
    'oil-fire': { soot: 0.95, density: 1.7, fireLight: 3, sky: 1.2, g: 0.3, flame: 1.3 },
    smoulder: { soot: 0.3, density: 0.6, fireLight: 1, sky: 0.45, flame: 0.15, speed: 0.55 },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'smoke-shading' });
    const uniforms = createUniformBuffer(device, Params, 'smoke-shading params');
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const bindGroup = device.createBindGroup({
      label: 'smoke-shading',
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniforms.buffer } }],
    });

    // Only used when the canvas is taller than MARCH_HEIGHT; otherwise the march draws into the scene.
    const march = createRenderTarget(device, {
      label: 'smoke-shading march',
      format: tail.scene.format,
      width: 1,
      height: 1,
    });
    const upsample = createFullscreenPipeline(device, {
      fragment: upsampleShader,
      format: tail.scene.format,
    });
    let upsampleGroup: GPUBindGroup | undefined;
    let reduced = false;

    // Accumulated rather than `time * speed`, so changing speed never makes the plume jump.
    let phase = 0;
    // The flicker has its own clock, never faster than real time: the flash limit is in seconds.
    let flickerSeconds = 0;

    return {
      resize(width, height) {
        tail.resize(width, height);
        uniforms.set({ aspect: width / height });
        const scale = Math.min(1, Math.max(MARCH_MIN_SCALE, MARCH_HEIGHT / height));
        reduced = scale < 1;
        if (reduced && march.resize(width * scale, height * scale)) upsampleGroup = undefined;
      },
      frame(time, encoder, target) {
        phase += time.delta * params.speed;
        flickerSeconds += time.delta * Math.min(params.speed, 1);
        uniforms.set({
          time: phase,
          flicker: flickerIntensity(flickerSeconds, 1, FIRE_FLICKER) / FIRE_FLICKER_MEAN,
          density: params.density,
          soot: params.soot,
          fire_light: params.fireLight,
          sky: params.sky,
          g: params.g,
          flame: params.flame,
          steps: params.steps,
          shadowing: Math.max(0, SHADOWING.indexOf(params.shadowing as (typeof SHADOWING)[number])),
          frame: time.frame,
          exposure: params.exposure,
        });
        uniforms.upload();
        renderFullscreen(encoder, reduced ? march.view : tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('smoke march'),
        });
        if (reduced) {
          upsampleGroup ??= device.createBindGroup({
            label: 'smoke-shading upsample',
            layout: upsample.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: march.view },
              { binding: 1, resource: linearSampler(device) },
            ],
          });
          renderFullscreen(encoder, tail.scene.view, upsample, [upsampleGroup], {
            timestampWrites: profiler.pass('upsample'),
          });
        }
        tail.encode(encoder, target, time, params, profiler);
      },
      destroy() {
        uniforms.destroy();
        march.destroy();
        tail.destroy();
      },
    };
  },
});
