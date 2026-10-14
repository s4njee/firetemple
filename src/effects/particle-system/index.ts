import { mat4, type Mat4 } from 'wgpu-matrix';
import { toHalf } from '../../gpu/emission/half-float.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import {
  createParticleRenderer,
  createParticleSystem,
  EMITTER_SHAPES,
  overlayCamera,
  overlayFieldMapping,
  planeThrough,
  rectFieldMapping,
  type Collider,
  type Emitter,
  type EmitterShape,
  type ParticleRenderer,
  type ParticleSystem,
} from '../../gpu/particles/index.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import {
  CameraUniform,
  computeCamera,
  createCameraMatrices,
  fitFovY,
  setCameraUniform,
} from '../../gpu/scene/camera.ts';
import { createDepthTarget } from '../../gpu/scene/depth.ts';
import {
  createForwardRenderer,
  type SceneLight,
  type SceneObject,
} from '../../gpu/scene/forward.ts';
import { boxGeometry, planeGeometry, sphereGeometry } from '../../gpu/scene/geometry.ts';
import { createMesh } from '../../gpu/scene/mesh.ts';
import {
  createOrbitControl,
  createOrbitState,
  orbitEye,
  type OrbitControl,
} from '../../gpu/scene/orbit.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import outlineShader from './outline.wgsl';

// Story 7.1's validation scene: everything the particle framework (src/gpu/particles/) does, one
// switch at a time, honestly rather than prettily. A main emitter of any shape (optionally swept
// round a circle fast, to show the swept emission), bursts from a second one, a template emitter for
// GPU-spawned children (on death and on impact, through hooks), every force, every collider. `count`
// is the pool's capacity, 1 024 to 1 048 576, and the emission rate follows it so the pool stays
// about `fill` full: the particle scale study (7.10) sweeps it. The live count, read back from the
// GPU a few frames late, is a row of its own in the HUD (`stats()`).
//
// 2D is the overlay space (canvas heights, origin bottom-left, `overlayCamera`); 3D is a world with
// the same numbers, drawn with the forward renderer's camera and soft depth against its meshes.

const SPACES = ['2d', '3d'] as const;
const SHAPES = [...EMITTER_SHAPES, 'ring'] as const;
const TURBULENCE = ['none', '2d', '3d'] as const;
const POINTS = ['none', 'attract', 'vortex'] as const;
const FIELDS = ['none', 'drag', 'accel', 'advect'] as const;
const COLLIDERS = ['none', 'plane', 'sphere', 'box', 'sdf'] as const;
const ON_HIT = ['bounce', 'kill', 'split', 'cool'] as const;

const FLOOR = 0.06;
const EMITTER_Y = 0.3;
const OBSTACLE_Y = 0.62;
const FIELD_SIZE = 64;
const DEGREES = Math.PI / 180;

// Hooks compiled into the kernels. hook_sdf is the 'sdf' collider: a wavy floor, scaled by 0.87 so
// it never overstates the distance (its slope reaches 0.54). hook_die splits burst particles into
// `ps_step.user[0].x` children of template 2; hook_collide splits anything but a child on impact
// when `ps_step.user[0].y` is set. Both spawn on the GPU through the spawn queue.
const HOOKS = `fn hook_sdf(q: vec3f) -> f32 {
  return (q.y - (0.1 + 0.03 * sin(q.x * 18.0))) * 0.87;
}

fn hook_die(p: Particle) {
  let children = u32(ps_step.user[0].x);
  if (p.kind == 1u && children > 0u) {
    ps_spawn(p.position, p.velocity, children, 2u, vec4f(0.0));
  }
}

fn hook_collide(p: ptr<function, Particle>, hit: ParticleHit) {
  if (ps_step.user[0].y > 0.0 && (*p).kind != 2u) {
    ps_spawn(hit.position + hit.normal * 0.002, (*p).velocity, 3u, 2u, vec4f(0.0));
    (*p).alive = false;
  }
}
`;

const OutlineParams = defineUniformStruct('Params', {
  a: 'vec4f',
  b: 'vec4f',
  point: 'vec4f',
  aspect: 'f32',
  pixel: 'f32',
  level: 'f32',
  collider: 'u32',
});

// A dim night: the particles are the light.
const LIGHT: SceneLight = {
  sunDirection: [-0.4, 0.8, 0.45],
  sunColor: [0.5, 0.62, 1],
  sunIntensity: 0.45,
  skyColor: [0.12, 0.15, 0.25],
  groundColor: [0.3, 0.14, 0.06],
  horizonColor: [0.006, 0.008, 0.014],
  ambient: 0.3,
  fogDensity: 0.02,
};

const place = (position: readonly [number, number, number], scale: readonly number[]): Mat4 => {
  const model = mat4.translation(position);
  return mat4.scale(model, scale, model);
};

/** Two counter-rotating vortices over a gentle updraft, in image heights per second, y down. */
function bakeField(device: GPUDevice): GPUTexture {
  const texture = device.createTexture({
    label: 'particle-system field',
    size: [FIELD_SIZE, FIELD_SIZE],
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const data = new Uint16Array(FIELD_SIZE * FIELD_SIZE * 4);
  for (let y = 0; y < FIELD_SIZE; y++) {
    for (let x = 0; x < FIELD_SIZE; x++) {
      const u = (x + 0.5) / FIELD_SIZE;
      const v = (y + 0.5) / FIELD_SIZE;
      let vx = 0;
      let vy = -0.15;
      for (const [cx, spin] of [
        [0.35, 1],
        [0.65, -1],
      ] as const) {
        const dx = u - cx;
        const dy = v - 0.45;
        const falloff = Math.exp(-(dx * dx + dy * dy) / (0.16 * 0.16));
        vx += -dy * spin * 4 * falloff;
        vy += dx * spin * 4 * falloff;
      }
      data.set([toHalf(vx), toHalf(vy), 0, 0], (y * FIELD_SIZE + x) * 4);
    }
  }
  device.queue.writeTexture({ texture }, data, { bytesPerRow: FIELD_SIZE * 8 }, [
    FIELD_SIZE,
    FIELD_SIZE,
  ]);
  return texture;
}

export const effect = defineEffect({
  meta,
  params: {
    space: { type: 'select', default: '2d', options: SPACES },
    count: {
      type: 'number',
      default: 65536,
      min: 1024,
      max: 1048576,
      step: 1024,
      label: 'count (capacity)',
    },
    fill: { type: 'number', default: 0.8, min: 0.05, max: 1, step: 0.01, label: 'target fill' },
    shape: { type: 'select', default: 'disc', options: SHAPES },
    moving: { type: 'boolean', default: false, label: 'moving emitter' },
    speed: { type: 'number', default: 0.8, min: 0, max: 3, step: 0.01 },
    spread: { type: 'number', default: 20, min: 0, max: 180, step: 1, label: 'spread (degrees)' },
    life: { type: 'number', default: 3, min: 0.2, max: 8, step: 0.1, label: 'life (s)' },
    burst: { type: 'number', default: 0, min: 0, max: 20000, step: 100, label: 'burst every 1 s' },
    split: {
      type: 'number',
      default: 0,
      min: 0,
      max: 16,
      step: 1,
      label: 'children per burst particle',
    },
    gravity: { type: 'number', default: 0.9, min: 0, max: 4, step: 0.01 },
    drag: { type: 'number', default: 0.3, min: 0, max: 5, step: 0.01, label: 'drag (1/s)' },
    buoyancy: { type: 'number', default: 0.15, min: 0, max: 3, step: 0.01 },
    turbulence: { type: 'select', default: '2d', options: TURBULENCE },
    turbulenceStrength: {
      type: 'number',
      default: 0.6,
      min: 0,
      max: 4,
      step: 0.01,
      label: 'turbulence strength',
    },
    turbulenceFrequency: {
      type: 'number',
      default: 3,
      min: 0.5,
      max: 12,
      step: 0.1,
      label: 'turbulence frequency',
    },
    point: { type: 'select', default: 'none', options: POINTS, label: 'point force' },
    pointStrength: {
      type: 'number',
      default: 1,
      min: 0,
      max: 4,
      step: 0.01,
      label: 'point force strength',
    },
    field: { type: 'select', default: 'none', options: FIELDS, label: 'velocity field' },
    collider: { type: 'select', default: 'plane', options: COLLIDERS },
    onHit: { type: 'select', default: 'bounce', options: ON_HIT, label: 'on hit' },
    restitution: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    friction: { type: 'number', default: 0.1, min: 0, max: 1, step: 0.01 },
    cooling: { type: 'number', default: 0.6, min: 0, max: 4, step: 0.01, label: 'cooling (1/s)' },
    size: { type: 'number', default: 0.7, min: 0.25, max: 4, step: 0.05 },
    intensity: { type: 'number', default: 1, min: 0, max: 12, step: 0.1 },
    stretch: { type: 'number', default: 0.5, min: 0, max: 8, step: 0.1 },
    outlines: { type: 'boolean', default: true, label: 'show colliders' },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    fountain: { shape: 'disc', collider: 'plane', onHit: 'bounce', turbulence: '2d' },
    collisions: {
      shape: 'point',
      speed: 1.2,
      spread: 30,
      gravity: 1.2,
      drag: 0.1,
      buoyancy: 0,
      turbulence: 'none',
      collider: 'sphere',
      restitution: 0.7,
      cooling: 0.3,
      count: 32768,
    },
    'split on impact': {
      shape: 'segment',
      speed: 0.9,
      spread: 10,
      gravity: 0.2,
      buoyancy: 0.2,
      collider: 'box',
      onHit: 'split',
      count: 32768,
      fill: 0.5,
    },
    'bursts and children': {
      shape: 'point',
      fill: 0.2,
      burst: 3000,
      split: 4,
      speed: 0.3,
      gravity: 0.5,
      collider: 'sdf',
      count: 131072,
    },
    'swept emitter': {
      shape: 'point',
      moving: true,
      life: 0.8,
      speed: 0.15,
      spread: 180,
      gravity: 0,
      buoyancy: 0.3,
      turbulence: 'none',
      collider: 'none',
      stretch: 1,
    },
    'vortex field': {
      shape: 'segment',
      field: 'advect',
      turbulence: 'none',
      collider: 'none',
      life: 5,
      speed: 0.2,
      count: 131072,
    },
    attractor: {
      shape: 'ring',
      point: 'vortex',
      pointStrength: 2,
      gravity: 0,
      buoyancy: 0,
      turbulence: 'none',
      collider: 'none',
      drag: 0.6,
      speed: 0.3,
      life: 4,
    },
    '3d scene': {
      space: '3d',
      shape: 'disc',
      collider: 'sphere',
      turbulence: '3d',
      speed: 0.9,
      spread: 20,
      gravity: 0.6,
    },
    million: { count: 1048576, fill: 0.95, life: 3, size: 0.4, intensity: 0.25, stretch: 0 },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'particle-system' });
    const camera2d = createUniformBuffer(device, CameraUniform, 'particle-system 2d camera');
    const depth = createDepthTarget(device, {
      label: 'particle-system depth',
      width: 1,
      height: 1,
    });
    const forward = createForwardRenderer(device, {
      colorFormat: tail.scene.format,
      depthFormat: depth.format,
      maxObjects: 8,
    });
    const view = forward.createView('particle-system');
    const meshes = {
      ground: createMesh(device, planeGeometry({ width: 8, depth: 8 }), 'ground'),
      box: createMesh(device, boxGeometry(), 'box'),
      sphere: createMesh(
        device,
        sphereGeometry({ widthSegments: 40, heightSegments: 24 }),
        'sphere',
      ),
    };
    const field = bakeField(device);
    const fieldView = field.createView();
    const outlines = createUniformBuffer(device, OutlineParams, 'particle-system outlines');
    const outlinePipeline = createFullscreenPipeline(device, {
      fragment: withChunks(outlineShader, { 'params.wgsl': OutlineParams.wgsl }),
      format: tail.scene.format,
      blend: {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
      },
    });
    const outlineGroup = device.createBindGroup({
      label: 'particle-system outlines',
      layout: outlinePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: outlines.buffer } }],
    });
    const camera3d = createCameraMatrices();

    interface Sim {
      key: string;
      system: ParticleSystem;
      renderer: ParticleRenderer;
      main: Emitter;
      bursts: Emitter;
    }
    let sim: Sim | undefined;
    let orbit: OrbitControl | undefined;
    let width = 1;
    let height = 1;
    let angle = 0;
    let burstClock = 0;

    const centerX = () => (params.space === '3d' ? 0 : width / height / 2);

    function build(): Sim {
      const space3d = params.space === '3d';
      const capacity = Math.round(params.count);
      const system = createParticleSystem({
        device,
        capacity,
        dimension: space3d ? 3 : 2,
        fixedStep: 1 / 60,
        maxSteps: 4,
        queueCapacity: 1024,
        hooks: { code: HOOKS },
        field: fieldView,
        profiler,
        label: 'particles',
      });
      const main = system.addEmitter({ kind: 0 });
      const bursts = system.addEmitter({
        shape: 'sphere',
        radius: 0.02,
        spread: Math.PI,
        speed: [0.3, 0.6],
        life: [0.8, 1.4],
        temperature: [2400, 2900],
        kind: 1,
      });
      // The template GPU-spawned children are sampled from: small, quick, thrown outwards.
      system.addEmitter({
        spread: Math.PI,
        speed: [0.1, 0.35],
        inherit: 0.4,
        life: [0.25, 0.6],
        temperature: [2500, 3000],
        size: [0.0015, 0.003],
        kind: 2,
      });
      const renderer = createParticleRenderer(system, {
        camera: space3d ? view.camera.buffer : camera2d.buffer,
        format: tail.scene.format,
        profiler,
      });
      return { key: `${capacity}|${params.space}`, system, renderer, main, bursts };
    }

    function sync(s: Sim): void {
      const { system, main, bursts, renderer } = s;
      const space3d = params.space === '3d';
      const cx = centerX();
      const f = system.forces;
      f.gravity = [0, -params.gravity, 0];
      f.dragLinear = params.drag;
      f.buoyancy = params.buoyancy;
      f.turbulence = params.turbulence as (typeof TURBULENCE)[number];
      f.turbulenceStrength = params.turbulenceStrength;
      f.turbulenceFrequency = params.turbulenceFrequency;
      f.turbulenceEvolve = 0.3;
      f.points =
        params.point === 'none'
          ? []
          : [
              {
                position: [cx, OBSTACLE_Y, 0],
                radius: 0.08,
                attract:
                  params.point === 'attract' ? params.pointStrength : 0.15 * params.pointStrength,
                swirl: params.point === 'vortex' ? params.pointStrength : 0,
                axis: space3d ? [0, 1, 0] : [0, 0, 1],
              },
            ];
      f.field = params.field as (typeof FIELDS)[number];
      f.fieldCoupling = params.field === 'drag' ? 3 : 1;
      f.fieldMapping = space3d
        ? rectFieldMapping({ min: [-0.9, 0], max: [0.9, 1.2], flipY: true })
        : overlayFieldMapping(width / height);

      system.heat.cooling = params.cooling > 0 ? 'newton' : 'none';
      system.heat.rate = params.cooling;
      system.heat.ambient = 300;
      system.heat.deathTemperature = 0;

      const ring = params.shape === 'ring';
      const shape = (ring ? 'disc' : params.shape) as EmitterShape;
      main.shape = shape;
      main.radius = shape === 'sphere' ? 0.08 : 0.12;
      main.innerRadius = ring ? 0.12 : 0;
      main.extent = shape === 'box' ? [0.15, 0.03, 0.15] : [0.2, 0, 0];
      main.axis = [0, 1, 0];
      main.direction = [0, 1, 0];
      main.spread = params.spread * DEGREES;
      main.speed = [params.speed * 0.7, params.speed * 1.3];
      main.inherit = 0.3;
      main.life = [params.life * 0.6, params.life * 1.4];
      main.temperature = [1900, 2600];
      main.size = [0.003 * params.size, 0.006 * params.size];
      // Keep the pool about `fill` full: rate = fill * capacity / mean life.
      main.rate = (params.fill * system.capacity) / params.life;
      const home: [number, number, number] = [cx, EMITTER_Y, 0];
      if (params.moving) {
        const r = 0.22;
        main.moveTo(
          space3d
            ? [home[0] + r * Math.cos(angle), home[1] + 0.15, r * Math.sin(angle)]
            : [home[0] + r * Math.cos(angle), home[1] + 0.15 + r * Math.sin(angle), 0],
        );
      } else {
        main.moveTo(home);
      }
      bursts.size = [0.003 * params.size, 0.005 * params.size];
      bursts.jumpTo([cx, OBSTACLE_Y + 0.15, 0]);

      const hit = {
        restitution: params.restitution,
        friction: params.friction,
        kill: params.onHit === 'kill',
        cool: params.onHit === 'cool' ? 0.75 : 1,
      };
      let collider: Collider | undefined;
      if (params.collider === 'plane')
        collider = { ...planeThrough([0, FLOOR, 0], [0, 1, 0]), ...hit };
      else if (params.collider === 'sphere') {
        collider = { type: 'sphere', center: [cx, OBSTACLE_Y, 0], radius: 0.1, ...hit };
      } else if (params.collider === 'box') {
        collider = { type: 'box', center: [cx, OBSTACLE_Y, 0], half: [0.18, 0.025, 0.18], ...hit };
      } else if (params.collider === 'sdf') collider = { type: 'sdf', ...hit };
      system.colliders.length = 0;
      if (collider) system.colliders.push(collider);
      // The 3D scene has a ground the particles land on whatever else is chosen.
      if (space3d && params.collider !== 'plane') {
        system.colliders.push({
          ...planeThrough([0, 0, 0], [0, 1, 0]),
          restitution: 0.3,
          friction: 0.4,
        });
      }
      system.params.user[0] = [params.split, params.onHit === 'split' ? 1 : 0, 0, 0];

      const style = renderer.style;
      style.intensity = params.intensity;
      style.tRef = 1800;
      style.twinkle = 0;
      style.fadeIn = 0.05;
      style.fadeOut = 0.15;
      const sprites = renderer.sprites.settings;
      sprites.shape = 'gaussian';
      sprites.stretch = params.stretch;
      sprites.maxStretch = 8;
      sprites.stretchDim = 0.5;
      sprites.minPixels = 0.75;
      sprites.depth = 'soft';
      sprites.fadeScale = 2;
    }

    function sceneObjects(): SceneObject[] {
      const stone: [number, number, number] = [0.55, 0.52, 0.48];
      const objects: SceneObject[] = [
        {
          mesh: meshes.ground,
          model: place([0, params.collider === 'plane' ? FLOOR : 0, 0], [1, 1, 1]),
          color: [0.05, 0.048, 0.045],
        },
      ];
      if (params.collider === 'sphere') {
        objects.push({
          mesh: meshes.sphere,
          model: place([0, OBSTACLE_Y, 0], [0.1, 0.1, 0.1]),
          color: stone,
        });
      } else if (params.collider === 'box') {
        objects.push({
          mesh: meshes.box,
          model: place([0, OBSTACLE_Y, 0], [0.36, 0.05, 0.36]),
          color: stone,
        });
      }
      return objects;
    }

    return {
      resize(newWidth, newHeight) {
        width = newWidth;
        height = newHeight;
        tail.resize(width, height);
        depth.resize(width, height);
        setCameraUniform(camera2d, overlayCamera(width, height), width, height);
        camera2d.upload();
      },

      frame(time, encoder, target) {
        const key = `${Math.round(params.count)}|${params.space}`;
        if (!sim || sim.key !== key) {
          if (sim) {
            sim.renderer.destroy();
            sim.system.destroy();
          }
          sim = build();
          sync(sim);
          sim.main.jumpTo(sim.main.position);
          sim.system.warmup(Math.min(3, params.life * 1.2));
        }
        const space3d = params.space === '3d';
        if (space3d && !orbit) {
          orbit = createOrbitControl(
            canvas,
            createOrbitState({ yaw: 0.5, pitch: 0.28, distance: 2.1, target: [0, 0.42, 0] }),
            { minPitch: 0.03, maxPitch: 1.3, autoSpeed: 0.08 },
          );
        } else if (!space3d && orbit) {
          orbit.destroy();
          orbit = undefined;
        }

        const delta = Math.min(time.delta, 0.1);
        angle = (angle + delta * 3) % (Math.PI * 2);
        sync(sim);
        burstClock += delta;
        if (burstClock >= 1) {
          burstClock %= 1;
          if (params.burst > 0) sim.bursts.burst(params.burst);
        }

        const { system, renderer } = sim;
        system.advance(encoder, time.delta);
        renderer.encode(encoder, time.delta);

        if (space3d && orbit) {
          const state = orbit.update(time.delta);
          const aspect = width / height;
          computeCamera(
            {
              position: orbitEye(state),
              target: state.target,
              fovY: fitFovY(0.8, aspect, 0.9),
              aspect,
              near: 0.05,
              far: 40,
            },
            camera3d,
          );
          view.update(camera3d, width, height, LIGHT);
          forward.draw(encoder, forward.upload(sceneObjects()), {
            view,
            color: tail.scene.view,
            depth: depth.view,
            clearColor: { r: 0.006, g: 0.008, b: 0.014, a: 1 },
            label: 'particle-system scene',
            timestampWrites: profiler.pass('scene'),
          });
          renderer.draw(encoder, {
            target: tail.scene.view,
            depth: depth.view,
            timestampWrites: profiler.pass('sprites'),
          });
        } else {
          renderer.draw(encoder, {
            target: tail.scene.view,
            clear: { r: 0, g: 0, b: 0, a: 0 },
            timestampWrites: profiler.pass('sprites'),
          });
          const cx = centerX();
          outlines.set({
            a:
              params.collider === 'plane'
                ? [0, FLOOR, 0, 0]
                : [cx, OBSTACLE_Y, 0, params.collider === 'sphere' ? 0.1 : 0],
            b: [0.18, 0.025, 0, 0],
            point: params.point === 'none' ? [0, 0, 0, 0] : [cx, OBSTACLE_Y, 0, 0.08],
            aspect: width / height,
            pixel: 1 / height,
            level: params.outlines ? 1 : 0,
            collider: COLLIDERS.indexOf(params.collider as (typeof COLLIDERS)[number]),
          });
          outlines.upload();
          if (params.outlines) {
            renderFullscreen(encoder, tail.scene.view, outlinePipeline, [outlineGroup], {
              load: true,
              label: 'particle-system outlines',
              timestampWrites: profiler.pass('outlines'),
            });
          }
        }
        tail.encode(encoder, target, time, params, profiler);
      },

      stats() {
        // Read back from the GPU a few frames late, in the HUD's own rows.
        const stats = sim?.system.stats;
        return {
          'live particles': stats?.alive ?? 0,
          pool: sim?.system.capacity ?? 0,
          'spawned (total)': stats?.spawned ?? 0,
          'dropped births': (stats?.droppedEmits ?? 0) + (stats?.droppedSpawns ?? 0),
        };
      },

      destroy() {
        sim?.renderer.destroy();
        sim?.system.destroy();
        orbit?.destroy();
        for (const mesh of Object.values(meshes)) mesh.destroy();
        forward.destroy();
        depth.destroy();
        field.destroy();
        outlines.destroy();
        camera2d.destroy();
        tail.destroy();
      },
    };
  },
});
