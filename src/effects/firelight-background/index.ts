import { FLICKER_PERIOD, flickerIntensity } from '../../gpu/emission/flicker.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { linearSampler } from '../../gpu/passes/common.ts';
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createRenderTarget } from '../../gpu/targets.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import fieldShader from './field.wgsl';
import glowShader from './glow.wgsl';
import { meta } from './meta.ts';

const FieldParams = defineUniformStruct('FieldParams', {
  drift: 'vec2f',
  time: 'f32',
  aspect: 'f32',
  scale: 'f32',
  warp: 'f32',
});

const Params = defineUniformStruct('Params', {
  origin: 'vec2f',
  extent: 'vec2f',
  aspect: 'f32',
  reach: 'f32',
  tint: 'vec3f',
  level: 'f32',
  movement: 'f32',
  redden: 'f32',
});

/** The moving field is drawn at this fraction of the canvas, each way. */
const FIELD_SCALE = 1 / 8;
const FIELD_MIN = 16;
const FIELD_FORMAT: GPUTextureFormat = 'rgba16float';

/** Radiance right at the fire at intensity 1 (1.0 is paper white). */
const PEAK = 1.6;

/** Which edge the fire is beyond. */
const SIDES = ['below', 'left', 'right', 'below left', 'below right'] as const;
type Side = (typeof SIDES)[number];

/** Noise cells the pattern drifts away from the fire per second, and its change per second. */
const DRIFT_PER_SECOND = 0.035;
const EVOLVE_PER_SECOND = 0.09;
/** The drift wraps here, far beyond a session, so the shader never sees a large number. */
const DRIFT_PERIOD = 4096;
/**
 * The whole-frame flicker at `flicker` = 1: the deepest swing as a fraction of the picture's own
 * brightness, and how many times a second it picks a new level. Both are far inside the safe
 * range of flicker.ts (depth 1, rate 4).
 */
const FLICKER_DEPTH = 0.12;
const FLICKER_RATE = 2;

/**
 * Where the fire is, in canvas heights (y up, the frame is `aspect` wide and 1 tall): the middle
 * of it, and half of its extent along the edge it is beyond. `width` is the fire's size as a
 * fraction of that edge; in a corner it is a point.
 */
export function fireLine(
  side: string,
  aspect: number,
  distance: number,
  width: number,
): { origin: [number, number]; extent: [number, number] } {
  const diagonal = distance * Math.SQRT1_2;
  switch (side as Side) {
    case 'left':
      return { origin: [-distance, 0.3], extent: [0, width / 2] };
    case 'right':
      return { origin: [aspect + distance, 0.3], extent: [0, width / 2] };
    case 'below left':
      return { origin: [-diagonal, -diagonal], extent: [0, 0] };
    case 'below right':
      return { origin: [aspect + diagonal, -diagonal], extent: [0, 0] };
    default:
      return { origin: [aspect / 2, -distance], extent: [(aspect * width) / 2, 0] };
  }
}

export const effect = defineEffect({
  meta,
  params: {
    side: { type: 'select', default: 'below', options: SIDES, label: 'fire is' },
    distance: { type: 'number', default: 0.3, min: 0.05, max: 1, step: 0.01 },
    width: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'fire width' },
    reach: { type: 'number', default: 0.55, min: 0.2, max: 2, step: 0.01 },
    intensity: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    tint: { type: 'color', default: [1, 0.36, 0.09] },
    redden: { type: 'number', default: 0.7, min: 0, max: 1, step: 0.01 },
    movement: { type: 'number', default: 0.5, min: 0, max: 0.9, step: 0.01 },
    scale: { type: 'number', default: 1.6, min: 0.5, max: 4, step: 0.05, label: 'patch size' },
    speed: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    flicker: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.01 },
    ...TAIL_PARAMS,
  },
  presets: {
    hearth: {
      side: 'below',
      distance: 0.3,
      reach: 0.55,
      intensity: 1,
      tint: [1, 0.36, 0.09],
      redden: 0.7,
      movement: 0.5,
      speed: 1,
      flicker: 0.25,
    },
    'campfire to the left': {
      side: 'below left',
      distance: 0.35,
      reach: 0.8,
      intensity: 0.9,
      tint: [1, 0.4, 0.1],
      redden: 0.7,
      movement: 0.55,
      speed: 1,
      flicker: 0.3,
    },
    embers: {
      side: 'below',
      distance: 0.2,
      reach: 0.4,
      intensity: 0.7,
      tint: [1, 0.2, 0.04],
      redden: 0.85,
      movement: 0.35,
      speed: 0.5,
      flicker: 0.1,
    },
  },

  async create({ device, format, hdr, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'firelight-background' });
    const field = createRenderTarget(device, {
      label: 'firelight-background field',
      format: FIELD_FORMAT,
      width: FIELD_MIN,
      height: FIELD_MIN,
    });
    const fieldUniforms = createUniformBuffer(device, FieldParams, 'firelight-background field');
    const uniforms = createUniformBuffer(device, Params, 'firelight-background params');
    const fieldPipeline = createFullscreenPipeline(device, {
      fragment: withChunks(fieldShader, { 'field-params.wgsl': FieldParams.wgsl }),
      format: FIELD_FORMAT,
    });
    const glowPipeline = createFullscreenPipeline(device, {
      fragment: withChunks(glowShader, { 'glow-params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const fieldBindGroup = device.createBindGroup({
      label: 'firelight-background field',
      layout: fieldPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: fieldUniforms.buffer } }],
    });
    let glowBindGroup: GPUBindGroup | undefined;

    let aspect = 1;
    // Accumulated, so changing speed never makes the light jump.
    const drift: [number, number] = [0, 0];
    let evolve = 0;
    // The flicker runs on its own clock, which `speed` cannot push past real time: the safety
    // argument of flicker.ts is about real seconds.
    let flickerSeconds = 0;

    return {
      resize(width, height) {
        tail.resize(width, height);
        aspect = width / height;
        const resized = field.resize(
          Math.max(FIELD_MIN, Math.ceil(width * FIELD_SCALE)),
          Math.max(FIELD_MIN, Math.ceil(height * FIELD_SCALE)),
        );
        if (resized || !glowBindGroup) {
          glowBindGroup = device.createBindGroup({
            label: 'firelight-background glow',
            layout: glowPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniforms.buffer } },
              { binding: 1, resource: field.view },
              { binding: 2, resource: linearSampler(device) },
            ],
          });
        }
      },
      frame(time, encoder, target) {
        const { origin, extent } = fireLine(params.side, aspect, params.distance, params.width);
        // The patches drift away from the fire: along the line from it to the middle of the frame.
        const away: [number, number] = [aspect / 2 - origin[0], 0.5 - origin[1]];
        const length = Math.hypot(away[0], away[1]) || 1;
        const step = time.delta * params.speed * DRIFT_PER_SECOND * params.scale;
        drift[0] = (drift[0] + (away[0] / length) * step) % DRIFT_PERIOD;
        drift[1] = (drift[1] + (away[1] / length) * step) % DRIFT_PERIOD;
        evolve = (evolve + time.delta * params.speed * EVOLVE_PER_SECOND) % DRIFT_PERIOD;
        flickerSeconds = (flickerSeconds + time.delta * Math.min(params.speed, 1)) % FLICKER_PERIOD;

        const depth = params.flicker * FLICKER_DEPTH;
        const flicker =
          flickerIntensity(flickerSeconds, 11, {
            rate: FLICKER_RATE,
            depth,
            shimmer: 0,
            shimmerRate: 0,
          }) +
          // Centred on 1, so turning the flicker up does not dim the picture.
          depth / 2;

        fieldUniforms.set({
          drift,
          time: evolve,
          aspect,
          scale: params.scale,
          warp: 0.6,
        });
        fieldUniforms.upload();
        uniforms.set({
          origin,
          extent,
          aspect,
          reach: Math.max(params.reach, 0.01),
          tint: params.tint,
          level: params.intensity * PEAK * flicker,
          movement: params.movement,
          redden: params.redden,
        });
        uniforms.upload();

        renderFullscreen(encoder, field.view, fieldPipeline, [fieldBindGroup], {
          timestampWrites: profiler.pass('field'),
        });
        if (glowBindGroup) {
          renderFullscreen(encoder, tail.scene.view, glowPipeline, [glowBindGroup], {
            timestampWrites: profiler.pass('glow'),
          });
        }
        tail.encode(encoder, target, time, params, profiler);
      },
      destroy() {
        field.destroy();
        fieldUniforms.destroy();
        uniforms.destroy();
        tail.destroy();
      },
    };
  },
});
