import { mat4, type Mat4 } from 'wgpu-matrix';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';
import {
  CameraUniform,
  computeCamera,
  createCameraMatrices,
  fitFovY,
  setCameraUniform,
} from '../../gpu/scene/camera.ts';
import { createDepthTarget } from '../../gpu/scene/depth.ts';
import { createForwardRenderer, type SceneObject } from '../../gpu/scene/forward.ts';
import { cylinderGeometry, planeGeometry, sphereGeometry } from '../../gpu/scene/geometry.ts';
import { createMesh } from '../../gpu/scene/mesh.ts';
import { createOrbitControl, createOrbitState, orbitEye } from '../../gpu/scene/orbit.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createRenderTarget } from '../../gpu/targets.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import {
  createBlueNoiseTexture,
  createReducedVolume,
  UPSAMPLE_FILTERS,
  type UpsampleFilter,
  type VolumeDivisor,
} from '../../gpu/volume/index.ts';
import { defineEffect } from '../types.ts';
import lightingShader from './lighting.wgsl';
import marchShader from './march.wgsl';
import { meta } from './meta.ts';

const MarchParams = defineUniformStruct('MarchParams', {
  uv_scale: 'vec2f',
  time: 'f32',
  step_length: 'f32',
  max_steps: 'i32',
  jitter_mode: 'u32',
  frame: 'u32',
  early_out: 'f32',
  flame: 'f32',
  smoke: 'f32',
  intensity: 'f32',
  wind: 'f32',
  flicker: 'f32',
});

const LightParams = defineUniformStruct('LightParams', {
  fire_position: 'vec3f',
  fire_intensity: 'f32',
  fire_color: 'vec3f',
  time: 'f32',
  post_x: 'f32',
  post_height: 'f32',
  post_radius: 'f32',
});

const RESOLUTIONS = ['1', '1/2', '1/4'] as const;
const DIVISOR: Record<string, VolumeDivisor> = { '1': 1, '1/2': 2, '1/4': 4 };
/** Order matters: the index is `jitter_mode` in march.wgsl. */
const JITTERS = ['none', 'white', 'ign', 'r2', 'blue'] as const;

/** The longest path a ray can take through the plume's box, which the step count is spread over. */
const MARCH_REACH = 5.5;
const NEAR = 0.3;
const FAR = 120;
const POST_X = 1.35;
const POST_HEIGHT = 2.05;
const POST_RADIUS = 0.045;

/** The plume's box; the same numbers as BOX_MIN and BOX_MAX in march.wgsl. */
const BOX = { min: [-2, 0, -2], max: [2, 4.6, 2] } as const;

/** View-space depth of the box corner farthest from the camera: beyond it there is no medium. */
function boxDepthLimit(view: Mat4): number {
  let limit = 0;
  for (let corner = 0; corner < 8; corner++) {
    const x = (corner & 1 ? BOX.max : BOX.min)[0];
    const y = (corner & 2 ? BOX.max : BOX.min)[1];
    const z = (corner & 4 ? BOX.max : BOX.min)[2];
    // Row 2 of the view matrix gives view-space z, which is minus the depth.
    limit = Math.max(limit, -(view[2]! * x + view[6]! * y + view[10]! * z + view[14]!));
  }
  return limit;
}

/** translate * rotateY * rotateZ * scale, the only transform this scene needs. */
function place(
  position: readonly [number, number, number],
  scale: readonly [number, number, number] = [1, 1, 1],
  rotateZ = 0,
  rotateY = 0,
): Mat4 {
  const m = mat4.translation(position);
  mat4.rotateY(m, rotateY, m);
  mat4.rotateZ(m, rotateZ, m);
  mat4.scale(m, scale, m);
  return m;
}

export const effect = defineEffect({
  meta,
  params: {
    steps: { type: 'number', default: 64, min: 8, max: 128, step: 1, label: 'max steps' },
    resolution: { type: 'select', default: '1/2', options: RESOLUTIONS },
    jitter: { type: 'select', default: 'ign', options: JITTERS },
    animateJitter: { type: 'boolean', default: false, label: 'animate jitter' },
    upsample: { type: 'select', default: 'depth-aware', options: UPSAMPLE_FILTERS },
    earlyOut: { type: 'number', default: 0.02, min: 0, max: 0.25, step: 0.005, label: 'early out' },
    flame: { type: 'number', default: 1, min: 0.4, max: 1.6, step: 0.01 },
    smoke: { type: 'number', default: 1, min: 0, max: 2.5, step: 0.01 },
    intensity: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    wind: { type: 'number', default: 0.2, min: -1, max: 1, step: 0.01 },
    speed: { type: 'number', default: 1, min: 0, max: 2.5, step: 0.01 },
    distance: { type: 'number', default: 5.6, min: 2.2, max: 14, step: 0.1 },
    orbit: { type: 'number', default: 0.06, min: -0.5, max: 0.5, step: 0.01, label: 'auto orbit' },
    ...TAIL_PARAMS,
  },
  presets: {
    reference: { steps: 128, resolution: '1', earlyOut: 0.005 },
    budget: { steps: 32, resolution: '1/4' },
    'no-jitter': { steps: 24, resolution: '1', jitter: 'none' },
    'edge-closeup': { distance: 2.6, resolution: '1/4', upsample: 'bilinear', orbit: 0 },
    smoulder: { flame: 0.55, smoke: 2, intensity: 0.7, wind: 0.5 },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'volume-march' });
    const volume = createReducedVolume(device, { label: 'volume-march' });
    // The blue-noise tile takes about 30 ms to generate, so it is only made when that jitter is
    // chosen; until then a single texel stands in for it.
    let blueNoise = device.createTexture({
      label: 'volume-march blue noise stand-in',
      size: [1, 1],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    let hasBlueNoise = false;

    // --- The opaque scene: albedo and depth, lit afterwards by lighting.wgsl -------------------
    const albedo = createRenderTarget(device, {
      label: 'volume-march albedo',
      format: 'rgba8unorm',
      width: 1,
      height: 1,
    });
    const depth = createDepthTarget(device, { label: 'volume-march depth', width: 1, height: 1 });
    const forward = createForwardRenderer(device, {
      colorFormat: albedo.format,
      depthFormat: depth.format,
    });
    const view = forward.createView('volume-march');

    const meshes = {
      ground: createMesh(device, planeGeometry({ width: 90, depth: 90 }), 'ground'),
      sphere: createMesh(
        device,
        sphereGeometry({ widthSegments: 128, heightSegments: 64 }),
        'ball',
      ),
      rod: createMesh(device, cylinderGeometry({ radialSegments: 32 }), 'rod'),
    };
    const IRON = [0.09, 0.09, 0.1] as const;
    const WOOD = [0.11, 0.075, 0.05] as const;
    const objects: SceneObject[] = [
      { mesh: meshes.ground, model: place([0, 0, 0]), color: [0.21, 0.18, 0.15], emissive: 1 },
      // A spit: two posts, a bar across the flame and a pot hanging in it.
      {
        mesh: meshes.rod,
        model: place([POST_X, POST_HEIGHT / 2, 0], [POST_RADIUS * 2, POST_HEIGHT, POST_RADIUS * 2]),
        color: IRON,
        emissive: 1,
      },
      {
        mesh: meshes.rod,
        model: place(
          [-POST_X, POST_HEIGHT / 2, 0],
          [POST_RADIUS * 2, POST_HEIGHT, POST_RADIUS * 2],
        ),
        color: IRON,
        emissive: 1,
      },
      {
        mesh: meshes.rod,
        model: place([0, 1.98, 0], [0.06, POST_X * 2 + 0.3, 0.06], Math.PI / 2),
        color: IRON,
        emissive: 1,
      },
      {
        mesh: meshes.rod,
        model: place([0, 1.86, 0], [0.024, 0.24, 0.024]),
        color: IRON,
        emissive: 1,
      },
      {
        mesh: meshes.sphere,
        model: place([0, 1.5, 0], [0.62, 0.54, 0.62]),
        color: IRON,
        emissive: 1,
      },
    ];
    // Logs leaning into the fire, and a ring of stones around it.
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + 0.3;
      const reach = 0.36 + 0.05 * Math.sin(i * 2.4);
      objects.push({
        mesh: meshes.rod,
        model: mat4.multiply(
          mat4.rotationY(angle),
          place([reach, 0.24, 0], [0.15 + 0.02 * (i % 3), 0.95, 0.15], Math.PI / 2 - 0.42),
        ),
        color: WOOD,
        emissive: 1,
      });
    }
    for (let i = 0; i < 11; i++) {
      const angle = (i / 11) * Math.PI * 2;
      const size = 0.3 + 0.09 * Math.sin(i * 5.3);
      const grey = 0.27 + 0.07 * Math.sin(i * 3.1);
      objects.push({
        mesh: meshes.sphere,
        model: mat4.multiply(
          mat4.rotationY(angle),
          place([0.98 + 0.05 * Math.sin(i * 1.7), 0.05, 0], [size * 1.2, size * 0.75, size], 0, i),
        ),
        color: [grey, grey * 0.97, grey * 0.93],
        emissive: 1,
      });
    }

    // --- Lighting pass --------------------------------------------------------------------------
    const lightUniforms = createUniformBuffer(device, LightParams, 'volume-march light');
    lightUniforms.set({ post_x: POST_X, post_height: POST_HEIGHT, post_radius: POST_RADIUS });
    const lightingPipeline = createFullscreenPipeline(device, {
      fragment: withChunks(lightingShader, { 'light-params.wgsl': LightParams.wgsl }),
      format: tail.scene.format,
    });

    // --- March pass -----------------------------------------------------------------------------
    const marchUniforms = createUniformBuffer(device, MarchParams, 'volume-march params');
    const marchCamera = createUniformBuffer(device, CameraUniform, 'volume-march camera');
    const marchPipeline = createFullscreenPipeline(device, {
      fragment: withChunks(marchShader, { 'march-params.wgsl': MarchParams.wgsl }),
      format: volume.target.format,
    });

    let lightingGroup: GPUBindGroup | undefined;
    let marchGroup: GPUBindGroup | undefined;
    let marchGeneration = -1;
    let width = 1;
    let height = 1;

    const camera = createCameraMatrices();
    const orbitState = createOrbitState({
      yaw: 0.62,
      pitch: 0.15,
      distance: params.distance,
      target: [0, 1.55, 0],
      // Start as if the visitor had been still for a while, so the slow orbit runs from the start.
      idleTime: 60,
    });
    const orbit = createOrbitControl(canvas, orbitState, {
      autoSpeed: 0,
      minPitch: 0.04,
      maxPitch: 1.25,
    });

    // Accumulated rather than `time * speed`, so changing speed never makes the plume jump.
    let phase = 0;
    let flickerPhase = 0;

    return {
      resize(w, h) {
        width = w;
        height = h;
        tail.resize(w, h);
        albedo.resize(w, h);
        depth.resize(w, h);
        volume.resize(w, h, DIVISOR[params.resolution] ?? 2);
        lightingGroup = undefined;
      },

      frame(time, encoder, target) {
        phase += time.delta * params.speed;

        // Camera: drag to orbit; left alone, it drifts round the fire.
        orbit.update(time.delta, false);
        const settle = Math.min(Math.max((orbitState.idleTime - 1.5) / 2, 0), 1);
        orbitState.yaw += params.orbit * settle * settle * (3 - 2 * settle) * time.delta;
        orbitState.distance = params.distance;
        const aspect = width / height;
        computeCamera(
          {
            position: orbitEye(orbitState),
            target: orbitState.target,
            fovY: fitFovY(0.72, aspect, 0.62),
            aspect,
            near: NEAR,
            far: FAR,
          },
          camera,
        );

        // A slow, small swell of the whole fire: two sines, +-6% together. Its clock is capped so
        // that no `speed` setting takes it past 2.7 Hz (WCAG 2.3.1 allows three flashes a second).
        // TODO(flicker.wgsl): replace with the shared band-limited flicker signal (story 3.6).
        flickerPhase += time.delta * Math.min(params.speed, 1.5);
        const flicker =
          1 + 0.035 * Math.sin(flickerPhase * 7.1) + 0.025 * Math.sin(flickerPhase * 11.3 + 1.7);

        // 1. Opaque scene: flat albedo and depth.
        view.update(camera, width, height, {
          sunDirection: [0, 1, 0],
          sunColor: [0, 0, 0],
          sunIntensity: 0,
          skyColor: [0, 0, 0],
          groundColor: [0, 0, 0],
          horizonColor: [0, 0, 0],
          ambient: 0,
          fogDensity: 0,
        });
        forward.draw(encoder, forward.upload(objects), {
          view,
          color: albedo.view,
          depth: depth.view,
          label: 'volume-march scene',
          timestampWrites: profiler.pass('scene'),
        });

        // 2. Light it into the HDR scene target.
        lightUniforms.set({
          fire_position: [0, 0.55, 0],
          fire_intensity: 3 * params.intensity * params.flame * flicker,
          fire_color: [1, 0.5, 0.2],
          time: phase,
        });
        lightUniforms.upload();
        lightingGroup ??= device.createBindGroup({
          label: 'volume-march lighting',
          layout: lightingPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: view.camera.buffer } },
            { binding: 1, resource: { buffer: lightUniforms.buffer } },
            { binding: 2, resource: albedo.view },
            { binding: 3, resource: depth.view },
          ],
        });
        renderFullscreen(encoder, tail.scene.view, lightingPipeline, [lightingGroup], {
          timestampWrites: profiler.pass('lighting'),
        });

        // 3. Scene depth at the march resolution.
        const divisor = DIVISOR[params.resolution] ?? 2;
        if (divisor !== volume.divisor) volume.resize(width, height, divisor);
        const filter = params.upsample as UpsampleFilter;
        volume.encodeDepth(encoder, {
          sceneDepth: depth.view,
          near: NEAR,
          far: FAR,
          depthLimit: boxDepthLimit(camera.view),
          filter,
          timestampWrites: profiler.pass('march depth'),
        });

        // 4. The march, at reduced resolution.
        const steps = Math.round(params.steps);
        setCameraUniform(marchCamera, camera, width, height);
        marchCamera.upload();
        marchUniforms.set({
          uv_scale: volume.uvScale,
          time: phase,
          step_length: MARCH_REACH / steps,
          max_steps: steps,
          jitter_mode: Math.max(0, JITTERS.indexOf(params.jitter as (typeof JITTERS)[number])),
          frame: params.animateJitter ? time.frame : 0,
          early_out: params.earlyOut,
          flame: params.flame,
          smoke: params.smoke,
          intensity: params.intensity,
          wind: params.wind,
          flicker,
        });
        marchUniforms.upload();
        if (params.jitter === 'blue' && !hasBlueNoise) {
          blueNoise.destroy();
          blueNoise = createBlueNoiseTexture(device);
          hasBlueNoise = true;
          marchGroup = undefined;
        }
        if (!marchGroup || marchGeneration !== volume.generation) {
          marchGeneration = volume.generation;
          marchGroup = device.createBindGroup({
            label: 'volume-march march',
            layout: marchPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: marchUniforms.buffer } },
              { binding: 1, resource: { buffer: marchCamera.buffer } },
              { binding: 2, resource: volume.depth.view },
              { binding: 3, resource: blueNoise.createView() },
            ],
          });
        }
        renderFullscreen(encoder, volume.target.view, marchPipeline, [marchGroup], {
          timestampWrites: profiler.pass('march'),
        });

        // 5. Upsample under the full-resolution depth buffer and blend over the lit scene.
        volume.composite(encoder, {
          color: tail.scene,
          sceneDepth: depth.view,
          filter,
          timestampWrites: profiler.pass('upsample'),
        });

        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        orbit.destroy();
        for (const mesh of Object.values(meshes)) mesh.destroy();
        forward.destroy();
        albedo.destroy();
        depth.destroy();
        lightUniforms.destroy();
        marchUniforms.destroy();
        marchCamera.destroy();
        blueNoise.destroy();
        volume.destroy();
        tail.destroy();
      },
    };
  },
});
