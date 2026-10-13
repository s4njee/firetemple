import type { ObstacleRect } from '../../gpu/dom-rects.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { trackPointer } from '../../gpu/pointer.ts';
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createRenderTarget } from '../../gpu/targets.ts';
import { createUniformBuffer, defineUniformStruct, uniformArray } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import shader from './fire-light.wgsl';
import groundShader from './ground.wgsl';
import { meta } from './meta.ts';

/** FIRELIGHT_MAX_OCCLUDERS in firelight.wgsl. */
const MAX_OCCLUDERS = 8;
const MAX_LIGHTS = 2;

/** Order matters: the index is the FIRELIGHT_SHADOW_* constant in firelight.wgsl. */
const SHADOW_MODES = ['none', 'hard', 'soft', 'traced', 'traced-classic'] as const;

const Params = defineUniformStruct('Params', {
  aspect: 'f32',
  /** One pixel in page units. */
  texel: 'f32',
  /** Scale of the scene's details: 1 on a landscape canvas, the aspect ratio on a narrow one. */
  unit: 'f32',
  time: 'f32',
  flicker_time: 'f32',
  radius: 'f32',
  source: 'f32',
  height: 'f32',
  shadow_length: 'f32',
  relief: 'f32',
  flicker: 'f32',
  ambient: 'f32',
  intensity: 'f32',
  warmth: 'f32',
  shadow_mode: 'i32',
  light_count: 'i32',
  occluder_count: 'i32',
  /** xy: position in page space, z: random seed, w: phase offset of the flame's animation. */
  lights: uniformArray('vec4f', MAX_LIGHTS),
  /** centre.xy, half_size.xy in page space. */
  rects: uniformArray('vec4f', MAX_OCCLUDERS),
  /** x: corner radius. */
  corners: uniformArray('vec4f', MAX_OCCLUDERS),
});

const GroundParams = defineUniformStruct('GroundParams', {
  aspect: 'f32',
  /** One pixel in page units. */
  texel: 'f32',
  unit: 'f32',
});

// --- The page: cards and the paths the lights wander ---------------------------------------------
//
// Cards are `ObstacleRect`s, the shape `trackDomRects` reports for real DOM elements (canvas uv,
// corner radius in image heights), so swapping this mock layout for the page's own cards is a
// change of data source only.

interface Wander {
  /** Centre and amplitude of the path, canvas uv. */
  centre: readonly [number, number];
  amplitude: readonly [number, number];
  /** Radians per second of phase, and starting angle, per axis. */
  rate: readonly [number, number];
  start: readonly [number, number];
}

interface Layout {
  cards: readonly ObstacleRect[];
  /** One per light; each stays in a gutter between cards. */
  paths: readonly [Wander, Wander];
}

const LANDSCAPE: Layout = {
  cards: [
    { x: 0.06, y: 0.1, width: 0.36, height: 0.34, radius: 0.034 },
    { x: 0.56, y: 0.08, width: 0.2, height: 0.32, radius: 0.034 },
    { x: 0.62, y: 0.56, width: 0.32, height: 0.34, radius: 0.034 },
    { x: 0.1, y: 0.6, width: 0.3, height: 0.28, radius: 0.034 },
    { x: 0.81, y: 0.17, width: 0.13, height: 0.1, radius: 0.05 },
  ],
  paths: [
    { centre: [0.49, 0.5], amplitude: [0.03, 0.33], rate: [0.37, 0.23], start: [1.3, 0.45] },
    { centre: [0.5, 0.525], amplitude: [0.4, 0.02], rate: [0.19, 0.41], start: [2.5, 2.1] },
  ],
};

const PORTRAIT: Layout = {
  cards: [
    { x: 0.1, y: 0.06, width: 0.8, height: 0.21, radius: 0.02 },
    { x: 0.1, y: 0.38, width: 0.35, height: 0.2, radius: 0.02 },
    { x: 0.55, y: 0.38, width: 0.35, height: 0.2, radius: 0.02 },
    { x: 0.1, y: 0.69, width: 0.8, height: 0.23, radius: 0.02 },
  ],
  paths: [
    { centre: [0.5, 0.325], amplitude: [0.36, 0.012], rate: [0.23, 0.37], start: [0.45, 1.3] },
    { centre: [0.5, 0.635], amplitude: [0.36, 0.012], rate: [0.19, 0.41], start: [2.5, 2.1] },
  ],
};

const layoutFor = (aspect: number): Layout => (aspect < 0.9 ? PORTRAIT : LANDSCAPE);

/** A card as firelight.wgsl wants it: centre and half size in page space (uv.x times aspect). */
function toOccluder(card: ObstacleRect, aspect: number) {
  return {
    cx: (card.x + card.width / 2) * aspect,
    cy: card.y + card.height / 2,
    hx: (card.width / 2) * aspect,
    hy: card.height / 2,
    radius: card.radius ?? 0,
  };
}

type Occluder = ReturnType<typeof toOccluder>;

/**
 * Moves a page-space point out of every card, to at least `margin` from its edge, along the
 * card's outward direction. A flame sits on the page between the cards; it never climbs one.
 */
function pushOut(point: [number, number], occluders: readonly Occluder[], margin: number): void {
  for (const o of occluders) {
    const r = Math.min(o.radius, o.hx, o.hy);
    const qx = point[0] - o.cx;
    const qy = point[1] - o.cy;
    const wx = Math.abs(qx) - (o.hx - r);
    const wy = Math.abs(qy) - (o.hy - r);
    const outside = Math.hypot(Math.max(wx, 0), Math.max(wy, 0));
    const distance = outside + Math.min(Math.max(wx, wy), 0) - r;
    if (distance >= margin) continue;
    const sx = qx < 0 ? -1 : 1;
    const sy = qy < 0 ? -1 : 1;
    let nx = 0;
    let ny = 0;
    if (wx > 0 && wy > 0) {
      nx = (wx / outside) * sx;
      ny = (wy / outside) * sy;
    } else if (wx > wy) {
      nx = sx;
    } else {
      ny = sy;
    }
    point[0] += nx * (margin - distance);
    point[1] += ny * (margin - distance);
  }
}

export const effect = defineEffect({
  meta,
  params: {
    shadows: { type: 'select', default: 'soft', options: SHADOW_MODES },
    lights: { type: 'number', default: 2, min: 1, max: MAX_LIGHTS, step: 1 },
    intensity: { type: 'number', default: 4, min: 0, max: 16, step: 0.1 },
    warmth: { type: 'number', default: 0.32, min: 0, max: 1, step: 0.01 },
    radius: { type: 'number', default: 1.1, min: 0.15, max: 2.5, step: 0.01 },
    height: { type: 'number', default: 0.24, min: 0.03, max: 0.6, step: 0.005 },
    softness: { type: 'number', default: 0.035, min: 0.004, max: 0.15, step: 0.001 },
    shadowLength: {
      type: 'number',
      default: 0.6,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'shadow length',
    },
    relief: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    ambient: { type: 'number', default: 0.02, min: 0, max: 0.3, step: 0.005 },
    flicker: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    speed: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    ...TAIL_PARAMS,
  },
  presets: {
    candle: {
      lights: 1,
      intensity: 8,
      warmth: 0.3,
      radius: 1,
      height: 0.13,
      softness: 0.018,
      shadowLength: 1,
      ambient: 0.03,
      flicker: 0.8,
    },
    hearth: {
      lights: 1,
      intensity: 6,
      warmth: 0.2,
      radius: 1.8,
      height: 0.34,
      softness: 0.1,
      shadowLength: 0.5,
      flicker: 0.35,
    },
    twin: { lights: 2, intensity: 3.5, warmth: 0.56, softness: 0.03, shadowLength: 0.8 },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'fire-light' });
    const uniforms = createUniformBuffer(device, Params, 'fire-light params');
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });

    // The ground is static, so it is baked into a texture instead of being evaluated per frame.
    const ground = createRenderTarget(device, {
      label: 'fire-light ground',
      format: 'rgba16float',
      width: 1,
      height: 1,
    });
    const groundUniforms = createUniformBuffer(device, GroundParams, 'fire-light ground params');
    const groundPipeline = createFullscreenPipeline(device, {
      fragment: withChunks(groundShader, { 'ground_params.wgsl': GroundParams.wgsl }),
      format: ground.format,
    });
    const groundBindGroup = device.createBindGroup({
      label: 'fire-light ground',
      layout: groundPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: groundUniforms.buffer } }],
    });
    let bindGroup: GPUBindGroup | undefined;
    let groundStale = true;

    let aspect = 1;
    // Lengths in the controls are in image heights. On a narrow canvas that would make the
    // flames and their pools of light as wide as the page, so everything scales with the width.
    let unit = 1;
    let layout = LANDSCAPE;
    let occluders: Occluder[] = [];

    // Input is optional: without a pointer (or a DOM) the lights just wander.
    const pointer = trackPointer(canvas);
    let follow = 0;
    const held: [number, number] = [0, 0];

    // Accumulated, so changing speed never makes a light jump. The flicker runs on its own
    // clock, which never goes faster than real time: `speed` must not push it past 3 Hz.
    let phase = 0;
    let flickerSeconds = 0;
    const lights = new Float32Array(MAX_LIGHTS * 4);

    return {
      resize(width, height) {
        tail.resize(width, height);
        aspect = width / height;
        unit = Math.min(1, aspect);
        layout = layoutFor(aspect);
        occluders = layout.cards.slice(0, MAX_OCCLUDERS).map((card) => toOccluder(card, aspect));
        uniforms.set({
          aspect,
          texel: 1 / height,
          unit,
          occluder_count: occluders.length,
          rects: occluders.flatMap((o) => [o.cx, o.cy, o.hx, o.hy]),
          corners: occluders.flatMap((o) => [o.radius, 0, 0, 0]),
        });
        if (ground.resize(width, height) || !bindGroup) {
          bindGroup = device.createBindGroup({
            label: 'fire-light',
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniforms.buffer } },
              { binding: 1, resource: ground.view },
            ],
          });
        }
        groundUniforms.set({ aspect, texel: 1 / height, unit });
        groundStale = true;
      },

      frame(time, encoder, target) {
        phase += time.delta * params.speed;
        flickerSeconds += time.delta * Math.min(params.speed, 1);

        // The first light eases towards the pointer while it is over the canvas, and back to
        // its path when it leaves.
        const ease = 1 - Math.exp(-time.delta * 5);
        follow += ((pointer.state.inside ? 1 : 0) - follow) * ease;
        const count = Math.round(Math.min(Math.max(params.lights, 1), MAX_LIGHTS));
        for (let i = 0; i < MAX_LIGHTS; i++) {
          const path = layout.paths[i === 0 ? 0 : 1];
          const point: [number, number] = [
            path.centre[0] +
              path.amplitude[0] * Math.sin(phase * path.rate[0] + path.start[0]) +
              path.amplitude[0] * 0.12 * Math.sin(phase * path.rate[0] * 2.7 + 0.6),
            path.centre[1] +
              path.amplitude[1] * Math.sin(phase * path.rate[1] + path.start[1]) +
              path.amplitude[1] * 0.12 * Math.sin(phase * path.rate[1] * 3.1 + 1.9),
          ];
          if (i === 0 && follow > 1e-3) {
            if (pointer.state.inside) {
              held[0] = pointer.state.x;
              held[1] = pointer.state.y;
            }
            point[0] += (held[0] - point[0]) * follow;
            point[1] += (held[1] - point[1]) * follow;
          }
          point[0] *= aspect;
          pushOut(point, occluders, 0.02 * unit);
          lights.set([point[0], point[1], 3.7 + i * 12.9, i * 4.3], i * 4);
        }

        uniforms.set({
          time: phase,
          flicker_time: flickerSeconds,
          radius: params.radius * unit,
          source: params.softness * unit,
          height: params.height * unit,
          shadow_length: params.shadowLength,
          relief: params.relief,
          flicker: params.flicker,
          ambient: params.ambient,
          intensity: params.intensity,
          warmth: params.warmth,
          shadow_mode: Math.max(0, (SHADOW_MODES as readonly string[]).indexOf(params.shadows)),
          light_count: count,
          lights,
        });
        uniforms.upload();

        if (groundStale) {
          groundUniforms.upload();
          renderFullscreen(encoder, ground.view, groundPipeline, [groundBindGroup], {
            timestampWrites: profiler.pass('bake ground'),
          });
          groundStale = false;
        }
        if (bindGroup) {
          renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
            timestampWrites: profiler.pass('light'),
          });
        }
        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        pointer.destroy();
        uniforms.destroy();
        groundUniforms.destroy();
        ground.destroy();
        tail.destroy();
      },
    };
  },
});
