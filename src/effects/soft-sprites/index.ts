import { mat4, type Mat4 } from 'wgpu-matrix';
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { computeCamera, createCameraMatrices, fitFovY } from '../../gpu/scene/camera.ts';
import { createDepthTarget } from '../../gpu/scene/depth.ts';
import {
  createForwardRenderer,
  type SceneLight,
  type SceneObject,
} from '../../gpu/scene/forward.ts';
import {
  boxGeometry,
  cylinderGeometry,
  planeGeometry,
  sphereGeometry,
} from '../../gpu/scene/geometry.ts';
import { createMesh } from '../../gpu/scene/mesh.ts';
import { createOrbitControl, createOrbitState, orbitEye } from '../../gpu/scene/orbit.ts';
import {
  createSpriteRenderer,
  SPRITE_FLOATS,
  SPRITE_SHAPES,
  type SpriteDepthMode,
  type SpriteRenderer,
} from '../../gpu/sprites.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import {
  COALS_RADIUS,
  COALS_Y,
  MAX_SPARKS_AND_EMBERS,
  MAX_SPRITES,
  simulate,
} from './particles.ts';
import shade from './shade.wgsl';

const INTERSECTIONS = ['soft', 'hard', 'split', 'off'] as const;
// 'auto' draws embers as embers and flying sparks as streaks; the rest force one shape on both.
const SHAPES = ['auto', ...SPRITE_SHAPES] as const;

// A night courtyard: cool, dim moonlight, so the sprites are the only warm light in the picture.
const LIGHT: SceneLight = {
  sunDirection: [-0.45, 0.8, 0.4],
  sunColor: [0.55, 0.68, 1],
  sunIntensity: 0.22,
  skyColor: [0.16, 0.2, 0.34],
  // The ground bounce is where a little of the fire's colour is allowed into the lighting.
  groundColor: [0.5, 0.2, 0.07],
  horizonColor: [0.008, 0.01, 0.018],
  ambient: 0.32,
  fogDensity: 0.045,
};

const STONE: readonly [number, number, number] = [0.3, 0.29, 0.28];
const DARK_STONE: readonly [number, number, number] = [0.2, 0.19, 0.19];
const IRON: readonly [number, number, number] = [0.07, 0.06, 0.055];

const place = (
  position: readonly [number, number, number],
  scale: readonly [number, number, number] = [1, 1, 1],
  yaw = 0,
): Mat4 => {
  const model = mat4.translation(position);
  mat4.rotateY(model, yaw, model);
  return mat4.scale(model, scale, model);
};

export const effect = defineEffect({
  meta,
  params: {
    intersection: { type: 'select', default: 'soft', options: INTERSECTIONS },
    fadeDistance: {
      type: 'number',
      default: 1,
      min: 0.05,
      max: 4,
      step: 0.05,
      label: 'fade distance (× sprite size)',
    },
    fadeContrast: { type: 'number', default: 2, min: 1, max: 4, step: 0.1, label: 'fade contrast' },
    stretch: { type: 'number', default: 1, min: 0, max: 6, step: 0.05, label: 'velocity stretch' },
    size: { type: 'number', default: 1, min: 0.25, max: 5, step: 0.05, label: 'sprite size' },
    count: { type: 'number', default: 1400, min: 0, max: MAX_SPARKS_AND_EMBERS, step: 50 },
    sparks: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'sparks share' },
    shape: { type: 'select', default: 'auto', options: SHAPES },
    intensity: { type: 'number', default: 1, min: 0, max: 4, step: 0.05 },
    puffs: { type: 'number', default: 1, min: 0, max: 4, step: 0.05, label: 'glow puffs' },
    speed: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    ...TAIL_PARAMS,
  },
  presets: {
    // Hard on the left, soft on the right, with sprites large enough that every cut shows.
    compare: {
      intersection: 'split',
      size: 1.8,
      puffs: 4,
      count: 500,
      sparks: 0.35,
      stretch: 0.5,
      intensity: 0.7,
      bloom: 0.25,
    },
    // Mostly sparks, thrown fast and stretched long.
    sparks: {
      sparks: 0.85,
      count: 2200,
      stretch: 3.5,
      speed: 1.3,
      size: 0.9,
      puffs: 0.7,
      bloom: 0.8,
    },
    // A quiet fire: few sparks, slow drifting embers.
    embers: { sparks: 0.06, count: 900, stretch: 0.4, speed: 0.6, size: 1.2, bloom: 0.75 },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'soft-sprites' });
    const depth = createDepthTarget(device, { label: 'soft-sprites depth', width: 1, height: 1 });
    const forward = createForwardRenderer(device, {
      colorFormat: tail.scene.format,
      depthFormat: depth.format,
      maxObjects: 32,
    });
    const view = forward.createView('soft-sprites');

    // --- The scene: a brazier in a ring of pillars, with a few blocks for sprites to run into ---
    const meshes = {
      ground: createMesh(device, planeGeometry({ width: 80, depth: 80 }), 'ground'),
      box: createMesh(device, boxGeometry(), 'box'),
      column: createMesh(device, cylinderGeometry({ radialSegments: 28 }), 'column'),
      bowl: createMesh(
        device,
        cylinderGeometry({ radiusTop: 0.5, radiusBottom: 0.32, radialSegments: 32 }),
        'bowl',
      ),
      sphere: createMesh(
        device,
        sphereGeometry({ widthSegments: 32, heightSegments: 20 }),
        'sphere',
      ),
    };
    const objects: SceneObject[] = [
      { mesh: meshes.ground, model: mat4.identity(), color: DARK_STONE },
      // Brazier: a foot, a bowl, and a bed of coals bright enough to bloom.
      { mesh: meshes.column, model: place([0, 0.06, 0], [0.9, 0.12, 0.9]), color: IRON },
      { mesh: meshes.bowl, model: place([0, 0.3, 0], [1.2, 0.4, 1.2]), color: IRON },
      {
        mesh: meshes.column,
        model: place([0, COALS_Y - 0.03, 0], [COALS_RADIUS * 2.1, 0.06, COALS_RADIUS * 2.1]),
        color: [5, 0.9, 0.1],
        emissive: 1,
      },
      // Things downwind and around the fire for the sprites to meet.
      { mesh: meshes.box, model: place([2.1, 0.3, 1.35], [1.9, 0.6, 0.9], 0.35), color: STONE },
      { mesh: meshes.box, model: place([2.45, 0.85, 1.25], [0.8, 0.5, 0.7], -0.2), color: STONE },
      { mesh: meshes.box, model: place([-1.95, 0.45, 1.1], [0.9, 0.9, 0.9], 0.6), color: STONE },
      { mesh: meshes.sphere, model: place([-0.85, 0.42, 2.0], [0.84, 0.84, 0.84]), color: STONE },
      { mesh: meshes.box, model: place([0.2, 0.09, -3.9], [9.5, 0.18, 2.2]), color: DARK_STONE },
    ];
    for (const [x, z] of [
      [-3.3, -1.0],
      [-1.5, -3.2],
      [1.5, -3.2],
      [3.3, -1.0],
    ] as const) {
      objects.push(
        { mesh: meshes.box, model: place([x, 0.2, z], [1, 0.4, 1]), color: STONE },
        { mesh: meshes.column, model: place([x, 2.3, z], [0.62, 3.8, 0.62]), color: STONE },
        { mesh: meshes.box, model: place([x, 4.35, z], [1, 0.3, 1]), color: STONE },
      );
    }
    // Nothing in the scene moves, so the object buffer is written once.
    const batch = forward.upload(objects);

    // --- Sprites ---
    const data = new Float32Array(MAX_SPRITES * SPRITE_FLOATS);
    const sprites = createSpriteRenderer(device, {
      capacity: MAX_SPRITES,
      camera: view.camera.buffer,
      format: tail.scene.format,
      shade,
      label: 'soft-sprites',
    });
    // The split view draws the same instances a second way in the same frame; a renderer has one
    // settings block, so that takes a second renderer sharing the first one's buffer.
    const spritesHard = createSpriteRenderer(device, {
      capacity: MAX_SPRITES,
      camera: view.camera.buffer,
      format: tail.scene.format,
      buffer: sprites.buffer,
      shade,
      label: 'soft-sprites-hard',
    });

    const orbit = createOrbitControl(
      canvas,
      createOrbitState({ yaw: 0.42, pitch: 0.2, distance: 8.6, target: [0.25, 1.55, -0.2] }),
      { minPitch: 0.04, maxPitch: 1.2, autoSpeed: 0.05 },
    );
    const camera = createCameraMatrices();

    let width = 1;
    let height = 1;
    // Starts well into the clock so the first frame already has sprites of every age in the air.
    let clock = 40;

    const configure = (renderer: SpriteRenderer, mode: SpriteDepthMode) => {
      const s = renderer.settings;
      s.depth = mode;
      // Relative to each sprite's size: one number has to serve a 3 cm spark and a 1 m puff.
      s.fadeDistance = 0;
      s.fadeScale = params.fadeDistance;
      s.fadeContrast = params.fadeContrast;
      s.stretch = params.stretch;
      s.maxStretch = 24;
      // Trail behind: a stretched spark is a comet whose head is where the spark is.
      s.trail = 1;
      s.stretchDim = 0.5;
      s.intensity = params.intensity;
      s.nearFade = [0.3, 1.2];
      s.minPixels = 1;
      const shape = SPRITE_SHAPES.indexOf(params.shape as (typeof SPRITE_SHAPES)[number]);
      s.shape = shape < 0 ? SPRITE_SHAPES.length : shape;
    };

    return {
      resize(newWidth, newHeight) {
        width = newWidth;
        height = newHeight;
        tail.resize(width, height);
        depth.resize(width, height);
      },

      frame(time, encoder, target) {
        // A long stall (a background tab) must not fling the clock forward.
        clock += Math.min(time.delta, 0.1) * params.speed;
        const state = orbit.update(time.delta);
        const aspect = width / height;
        computeCamera(
          {
            position: orbitEye(state),
            target: state.target,
            fovY: fitFovY(0.72, aspect, 0.8),
            aspect,
            near: 0.1,
            far: 90,
          },
          camera,
        );
        view.update(camera, width, height, LIGHT);

        const count = simulate(data, clock, {
          count: params.count,
          sparks: params.sparks,
          size: params.size,
          puffs: params.puffs,
        });
        sprites.update(data, count);

        forward.draw(encoder, batch, {
          view,
          color: tail.scene.view,
          depth: depth.view,
          clearColor: {
            r: LIGHT.horizonColor[0],
            g: LIGHT.horizonColor[1],
            b: LIGHT.horizonColor[2],
            a: 1,
          },
          label: 'soft-sprites scene',
          timestampWrites: profiler.pass('scene'),
        });

        const targets = { target: tail.scene.view, depth: depth.view };
        // Too narrow to split: the two scissor rectangles would not fit.
        if (params.intersection === 'split' && width >= 4) {
          // Hard on the left, soft on the right, two pixels apart so the seam can be found.
          const middle = Math.floor(width / 2);
          configure(spritesHard, 'hard');
          configure(sprites, 'soft');
          spritesHard.draw(encoder, {
            ...targets,
            count,
            scissor: [0, 0, middle - 1, height],
            label: 'soft-sprites hard half',
            timestampWrites: profiler.pass('sprites (hard)'),
          });
          sprites.draw(encoder, {
            ...targets,
            scissor: [middle + 1, 0, width - middle - 1, height],
            label: 'soft-sprites soft half',
            timestampWrites: profiler.pass('sprites (soft)'),
          });
        } else {
          const mode: SpriteDepthMode =
            params.intersection === 'hard'
              ? 'hard'
              : params.intersection === 'off'
                ? 'none'
                : 'soft';
          configure(sprites, mode);
          sprites.draw(encoder, {
            ...targets,
            label: 'soft-sprites sprites',
            timestampWrites: profiler.pass('sprites'),
          });
        }

        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        orbit.destroy();
        spritesHard.destroy();
        sprites.destroy();
        for (const mesh of Object.values(meshes)) mesh.destroy();
        forward.destroy();
        depth.destroy();
        tail.destroy();
      },
    };
  },
});
