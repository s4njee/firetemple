import { mat4, type Mat4 } from 'wgpu-matrix';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';
import {
  CameraUniform,
  computeCamera,
  createCameraMatrices,
  fitFovY,
  setCameraUniform,
  unprojectPoint,
} from '../../gpu/scene/camera.ts';
import { createDepthTarget } from '../../gpu/scene/depth.ts';
import { createForwardRenderer, type SceneObject } from '../../gpu/scene/forward.ts';
import { cylinderGeometry, planeGeometry, sphereGeometry } from '../../gpu/scene/geometry.ts';
import { createMesh } from '../../gpu/scene/mesh.ts';
import { createOrbitControl, createOrbitState, orbitEye } from '../../gpu/scene/orbit.ts';
import { createShader, withChunks } from '../../gpu/shader.ts';
import { createFire3d, type Fire3dSource } from '../../gpu/sim/fire3d.ts';
import { createExcitation, EXCITATIONS } from '../../gpu/sim/excitation.ts';
import { pointOnRay } from '../../gpu/sim/fluid3d.ts';
import {
  collectIgniters,
  createAmbientIgnition,
  createPointerIgnition,
} from '../../gpu/sim/ignition.ts';
import { createRenderTarget } from '../../gpu/targets.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { createReducedVolume, type VolumeDivisor } from '../../gpu/volume/index.ts';
import { defineEffect } from '../types.ts';
import lightingShader from './lighting.wgsl';
import marchShader from './march.wgsl';
import { meta } from './meta.ts';
import probeShader from './probe.wgsl';

/*
 * A fire burning in a small 3D scene: src/gpu/sim/fire3d.ts simulates it (a 3D stable-fluids solver
 * carrying temperature, fuel, smoke and burn rate, with combustion after every advection), and this
 * file draws it. One frame:
 *
 *   1. fire        the simulation's steps for this frame (compute)
 *   2. probe       the fire measured as one light: colour, strength and centre, eased (compute, 1 group)
 *   3. scene       ground, logs or burner, stones: albedo and depth (forward pass)
 *   4. lighting    the scene lit by that light, with ember glow read from the fields (fullscreen)
 *   5. march depth the depth buffer at the march resolution (src/gpu/volume/)
 *   6. march       the fields ray-marched as flame and smoke at half resolution (fullscreen)
 *   7. upsample    composited over the scene under the full-resolution depth (src/gpu/volume/)
 *   8. tail        bloom, tonemap, output
 */

const MarchParams = defineUniformStruct('MarchParams', {
  uv_scale: 'vec2f',
  step_length: 'f32',
  max_steps: 'i32',
  box_min: 'vec3f',
  early_out: 'f32',
  box_max: 'vec3f',
  brightness: 'f32',
  sky: 'vec3f',
  whiten: 'f32',
  soot: 'f32',
  flame_opacity: 'f32',
  blue: 'f32',
  smoke_extinction: 'f32',
  fire_surface: 'f32',
  fire_radius: 'f32',
});

const LightParams = defineUniformStruct('LightParams', {
  box_min: 'vec3f',
  time: 'f32',
  box_max: 'vec3f',
  fire_gain: 'f32',
  fire_soft: 'f32',
  ember_offset: 'f32',
  ember_height: 'f32',
  ember_gain: 'f32',
  ember_cap: 'f32',
});

const ProbeParams = defineUniformStruct('ProbeParams', {
  box_min: 'vec3f',
  blend: 'f32',
  box_max: 'vec3f',
  gain: 'f32',
  fallback: 'vec3f',
  reset: 'u32',
});

const SOURCES = ['logs', 'burner'] as const;
const GRIDS = ['32', '48', '64'] as const;
const STEP_RATES = ['30', '45', '60'] as const;
const RESOLUTIONS = ['1', '1/2', '1/4'] as const;
const DIVISOR: Record<string, VolumeDivisor> = { '1': 1, '1/2': 2, '1/4': 4 };
const DRAGS = ['orbit', 'fuel', 'heat'] as const;

/** Full drive (scroll or sound at its loudest) raises the fuel supply and ember rate by this share. */
const DRIVE_SHARE = 0.6;
/** World metres per solver length unit: the box is this tall. */
const WORLD_SCALE = 2.4;
/** Relative extents of the simulation box: a tall column over the fire. */
const BOX_SHAPE = [2 / 3, 1, 2 / 3] as const;
const NEAR = 0.1;
const FAR = 80;
/** The field grid is a third finer than the velocity grid, which is where the visible detail is. */
const SCALAR_PER_CELL = 4 / 3;

type Vec3 = [number, number, number];

/** A log: a capsule between two world points. */
interface Log {
  from: Vec3;
  to: Vec3;
  radius: number;
}

/** Five logs leaning into the middle, their inner ends raised on each other. */
const LOGS: Log[] = Array.from({ length: 5 }, (_, i) => {
  const angle = (i / 5) * Math.PI * 2 + 0.4;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const reach = 0.56 + 0.04 * Math.sin(i * 2.3);
  return {
    from: [c * reach, 0.07, s * reach],
    to: [c * 0.06, 0.23 + 0.02 * (i % 2), s * 0.06],
    radius: 0.065 + 0.008 * (i % 3),
  };
});

const BURNER_TOP = 0.32;
const BURNER_RADIUS = 0.2;

/** Model matrix of a unit cylinder (radius 0.5, y from -0.5 to 0.5) stretched between two points. */
function capsuleModel(from: Vec3, to: Vec3, radius: number): Mat4 {
  const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const length = Math.hypot(...d);
  const y: Vec3 = [d[0] / length, d[1] / length, d[2] / length];
  const ref: Vec3 = Math.abs(y[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let x: Vec3 = [
    y[1] * ref[2] - y[2] * ref[1],
    y[2] * ref[0] - y[0] * ref[2],
    y[0] * ref[1] - y[1] * ref[0],
  ];
  const xl = Math.hypot(...x);
  x = [x[0] / xl, x[1] / xl, x[2] / xl];
  const z: Vec3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const w = radius * 2;
  return mat4.create(
    x[0] * w,
    x[1] * w,
    x[2] * w,
    0,
    y[0] * length,
    y[1] * length,
    y[2] * length,
    0,
    z[0] * w,
    z[1] * w,
    z[2] * w,
    0,
    (from[0] + to[0]) / 2,
    (from[1] + to[1]) / 2,
    (from[2] + to[2]) / 2,
    1,
  );
}

function place(position: Vec3, scale: Vec3, rotateY = 0): Mat4 {
  const m = mat4.translation(position);
  mat4.rotateY(m, rotateY, m);
  mat4.scale(m, scale, m);
  return m;
}

/** View-space depth of the box corner farthest from the camera: beyond it there is no medium. */
function boxDepthLimit(view: Mat4, min: Vec3, max: Vec3): number {
  let limit = 0;
  for (let corner = 0; corner < 8; corner++) {
    const x = (corner & 1 ? max : min)[0];
    const y = (corner & 2 ? max : min)[1];
    const z = (corner & 4 ? max : min)[2];
    limit = Math.max(limit, -(view[2]! * x + view[6]! * y + view[10]! * z + view[14]!));
  }
  return limit;
}

export const effect = defineEffect({
  meta,
  params: {
    source: { type: 'select', default: 'logs', options: SOURCES },
    fuel: { type: 'number', default: 1, min: 0, max: 2.5, step: 0.01, label: 'fuel supply' },
    burn: { type: 'number', default: 7, min: 1, max: 20, step: 0.1, label: 'burn rate' },
    buoyancy: { type: 'number', default: 2.6, min: 0.5, max: 6, step: 0.05 },
    cooling: { type: 'number', default: 1, min: 0.2, max: 3, step: 0.01 },
    smoke: { type: 'number', default: 1, min: 0, max: 2.5, step: 0.01, label: 'smoke (soot)' },
    wind: { type: 'number', default: 0, min: -1, max: 1, step: 0.01 },
    vorticity: { type: 'number', default: 2.5, min: 0, max: 20, step: 0.1 },
    expansion: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01 },
    brightness: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    embers: { type: 'number', default: 0.6, min: 0, max: 4, step: 0.05, label: 'stray embers /s' },
    drive: { type: 'select', default: 'none', options: EXCITATIONS },
    grid: { type: 'select', default: '48', options: GRIDS, label: 'grid (cells tall)' },
    stepRate: { type: 'select', default: '60', options: STEP_RATES, label: 'steps / s' },
    steps: { type: 'number', default: 64, min: 16, max: 128, step: 1, label: 'march steps' },
    resolution: { type: 'select', default: '1/2', options: RESOLUTIONS, label: 'march resolution' },
    drag: { type: 'select', default: 'orbit', options: DRAGS, label: 'drag' },
    orbit: { type: 'number', default: 0.08, min: -0.5, max: 0.5, step: 0.01, label: 'auto orbit' },
    distance: { type: 'number', default: 3.4, min: 2, max: 9, step: 0.1 },
    ...TAIL_PARAMS,
  },
  presets: {
    campfire: { source: 'logs', fuel: 1, burn: 7, smoke: 1, wind: 0 },
    'gas flame': {
      source: 'burner',
      fuel: 2.2,
      burn: 4,
      buoyancy: 2,
      cooling: 0.6,
      smoke: 0.7,
      vorticity: 2,
      distance: 4.4,
    },
    smoulder: {
      source: 'logs',
      fuel: 0.5,
      burn: 2.2,
      cooling: 1.5,
      smoke: 2.2,
      brightness: 0.8,
      embers: 1.2,
    },
    windy: { source: 'logs', wind: 0.55, vorticity: 4 },
    budget: { grid: '32', steps: 40, resolution: '1/4' },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'fire-3d' });
    const volume = createReducedVolume(device, { label: 'fire-3d' });

    const gridCells = () => Number(params.grid) || 48;
    const fire = createFire3d({
      device,
      resolution: gridCells(),
      scalarResolution: Math.round(gridCells() * SCALAR_PER_CELL),
      size: BOX_SHAPE,
      profiler,
      label: 'fire-3d',
    });

    // --- World <-> solver -------------------------------------------------------------------------
    const box = () => {
      const [w, h, d] = fire.grid.size;
      const min: Vec3 = [(-w / 2) * WORLD_SCALE, 0, (-d / 2) * WORLD_SCALE];
      const max: Vec3 = [(w / 2) * WORLD_SCALE, h * WORLD_SCALE, (d / 2) * WORLD_SCALE];
      return { min, max };
    };
    const toSolver = (p: ArrayLike<number>): Vec3 => {
      const { min } = box();
      return [
        (p[0]! - min[0]) / WORLD_SCALE,
        (p[1]! - min[1]) / WORLD_SCALE,
        (p[2]! - min[2]) / WORLD_SCALE,
      ];
    };

    const sourcesFor = (kind: string): Fire3dSource[] => {
      if (kind === 'burner') {
        // A ring burner: four ports on a circle, each pushing gas up.
        return [0, 1, 2, 3].map((i) => {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          const b = a + Math.PI / 2;
          const r = BURNER_RADIUS * 0.7;
          return {
            from: toSolver([Math.cos(a) * r, BURNER_TOP + 0.02, Math.sin(a) * r]),
            to: toSolver([Math.cos(b) * r, BURNER_TOP + 0.02, Math.sin(b) * r]),
            radius: 0.07 / WORLD_SCALE,
            fuel: 1,
            jet: 0.25,
          };
        });
      }
      // Fuel comes off the inner, burning half of four of the logs, just above their surface.
      return LOGS.slice(0, 4).map((log) => {
        const along = (t: number): Vec3 => [
          log.to[0] + (log.from[0] - log.to[0]) * t,
          log.to[1] + (log.from[1] - log.to[1]) * t + log.radius * 0.6,
          log.to[2] + (log.from[2] - log.to[2]) * t,
        ];
        return {
          from: toSolver(along(0)),
          to: toSolver(along(0.5)),
          radius: 0.075 / WORLD_SCALE,
          fuel: 1,
        };
      });
    };
    let sourceKind = '';
    const applySource = () => {
      if (sourceKind === params.source) return;
      sourceKind = params.source;
      fire.setSources(sourcesFor(sourceKind));
    };
    applySource();
    fire.seed();

    // --- Input: drag to orbit, or to throw fuel or heat in; stray embers keep it alive -------------
    const pointer = createPointerIgnition(canvas, { radius: 0.03 });
    const embers = createAmbientIgnition({ rate: params.embers, seed: 11 });
    // Story 5.8: scrolling or sound feeds the fire, as a share of its calm fuel and ember rate.
    let drive = createExcitation(params.drive, canvas);

    // --- The opaque scene: albedo and depth, lit afterwards by lighting.wgsl ----------------------
    const albedo = createRenderTarget(device, {
      label: 'fire-3d albedo',
      format: 'rgba8unorm',
      width: 1,
      height: 1,
    });
    const depth = createDepthTarget(device, { label: 'fire-3d depth', width: 1, height: 1 });
    const forward = createForwardRenderer(device, {
      colorFormat: albedo.format,
      depthFormat: depth.format,
    });
    const view = forward.createView('fire-3d');
    const meshes = {
      ground: createMesh(device, planeGeometry({ width: 60, depth: 60 }), 'ground'),
      stone: createMesh(device, sphereGeometry({ widthSegments: 48, heightSegments: 24 }), 'stone'),
      log: createMesh(device, cylinderGeometry({ radialSegments: 32 }), 'log'),
    };
    const WOOD = [0.12, 0.08, 0.05] as const;
    const IRON = [0.08, 0.08, 0.085] as const;
    const common: SceneObject[] = [
      {
        mesh: meshes.ground,
        model: place([0, 0, 0], [1, 1, 1]),
        color: [0.2, 0.17, 0.14],
        emissive: 1,
      },
    ];
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2 + 0.2;
      const size = 0.16 + 0.05 * Math.sin(i * 5.3);
      const grey = 0.26 + 0.07 * Math.sin(i * 3.1);
      const reach = 0.86 + 0.04 * Math.sin(i * 1.7);
      common.push({
        mesh: meshes.stone,
        model: place(
          [Math.cos(angle) * reach, 0.03, Math.sin(angle) * reach],
          [size * 1.25, size * 0.75, size],
          -angle,
        ),
        color: [grey, grey * 0.97, grey * 0.93],
        emissive: 1,
      });
    }
    const logObjects: SceneObject[] = [
      ...common,
      ...LOGS.map((log) => ({
        mesh: meshes.log,
        model: capsuleModel(log.from, log.to, log.radius),
        color: WOOD,
        emissive: 1,
      })),
    ];
    const burnerObjects: SceneObject[] = [
      ...common,
      {
        mesh: meshes.log,
        model: place([0, BURNER_TOP / 2, 0], [BURNER_RADIUS * 2, BURNER_TOP, BURNER_RADIUS * 2]),
        color: IRON,
        emissive: 1,
      },
      {
        mesh: meshes.log,
        model: place([0, 0.02, 0], [0.5, 0.04, 0.5]),
        color: IRON,
        emissive: 1,
      },
    ];

    // --- Pipelines --------------------------------------------------------------------------------
    const sampler = device.createSampler({
      label: 'fire-3d fields',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });
    const lightBuffer = device.createBuffer({
      label: 'fire-3d light',
      size: 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Alpha -1 marks "never measured": the first probe takes its reading without easing.
    device.queue.writeBuffer(lightBuffer, 0, new Float32Array([0, 0.6, 0, 1, 0, 0, 0, -1]));

    const probeUniforms = createUniformBuffer(device, ProbeParams, 'fire-3d probe');
    const probePipeline = device.createComputePipeline({
      label: 'fire-3d probe',
      layout: 'auto',
      compute: {
        module: createShader(
          device,
          withChunks(probeShader, { 'probe-params.wgsl': ProbeParams.wgsl }),
        ),
        entryPoint: 'cs_probe',
      },
    });

    const lightUniforms = createUniformBuffer(device, LightParams, 'fire-3d lighting');
    const lightingPipeline = createFullscreenPipeline(device, {
      fragment: withChunks(lightingShader, { 'light-params.wgsl': LightParams.wgsl }),
      format: tail.scene.format,
    });

    const marchUniforms = createUniformBuffer(device, MarchParams, 'fire-3d march');
    const marchCamera = createUniformBuffer(device, CameraUniform, 'fire-3d march camera');
    const marchPipeline = createFullscreenPipeline(device, {
      fragment: withChunks(marchShader, { 'march-params.wgsl': MarchParams.wgsl }),
      format: volume.target.format,
    });

    // Bind groups that hold the fields change with its slot (every step) and generation.
    let groups = new Map<string, GPUBindGroup>();
    let groupKey = '';
    const groupFor = (name: string, make: () => GPUBindGroup) => {
      const key = `${fire.generation}|${volume.generation}`;
      if (key !== groupKey) {
        groups = new Map();
        groupKey = key;
      }
      const full = `${name}|${fire.fields.slot}`;
      let group = groups.get(full);
      if (!group) groups.set(full, (group = make()));
      return group;
    };

    let width = 1;
    let height = 1;
    let probeGeneration = fire.generation;

    const camera = createCameraMatrices();
    const orbitState = createOrbitState({
      yaw: 0.5,
      pitch: 0.22,
      distance: params.distance,
      target: [0, 0.62, 0],
      idleTime: 60,
    });
    const orbit = createOrbitControl(canvas, orbitState, {
      autoSpeed: 0,
      minPitch: 0.03,
      maxPitch: 1.2,
    });

    return {
      resize(w, h) {
        width = w;
        height = h;
        tail.resize(w, h);
        albedo.resize(w, h);
        depth.resize(w, h);
        volume.resize(w, h, DIVISOR[params.resolution] ?? 2);
        groups = new Map();
        groupKey = '';
      },

      frame(time, encoder, target) {
        const delta = Math.max(0, Math.min(time.delta, 0.1));

        // --- Simulation settings from the controls ------------------------------------------------
        const cells = gridCells();
        if (fire.setResolution(cells, Math.round(cells * SCALAR_PER_CELL))) {
          sourceKind = '';
          applySource();
          fire.seed();
        }
        applySource();
        const burner = params.source === 'burner';
        if (params.drive !== drive.kind) {
          drive.destroy();
          drive = createExcitation(params.drive, canvas);
        }
        const boost = 1 + DRIVE_SHARE * drive.update(delta);
        Object.assign(fire.params, {
          stepRate: Number(params.stepRate) || 30,
          fuelRate: 5 * params.fuel * boost,
          burn: params.burn,
          buoyancy: params.buoyancy,
          cooling: 0.5 * params.cooling,
          heightCooling: 3.5 * params.cooling,
          radiation: 0.35 * params.cooling,
          soot: 0.4 * params.smoke,
          wind: params.wind,
          vorticity: params.vorticity,
          expansion: params.expansion,
          bedTemperature: burner ? 0.55 : 0.7,
        });

        // --- Camera: drag to orbit (when dragging does not feed the fire); left alone it drifts --------
        const yaw = orbitState.yaw;
        const pitch = orbitState.pitch;
        orbit.update(delta, false);
        if (params.drag !== 'orbit') {
          orbitState.yaw = yaw;
          orbitState.pitch = pitch;
          orbitState.yawVelocity = 0;
          orbitState.pitchVelocity = 0;
          orbitState.idleTime += delta;
        }
        const settle = Math.min(Math.max((orbitState.idleTime - 1.5) / 2, 0), 1);
        orbitState.yaw += params.orbit * settle * settle * (3 - 2 * settle) * delta;
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

        // --- Igniters: the pointer (when it feeds the fire) and stray embers on the source ----------
        const { min: boxMin, max: boxMax } = box();
        const size = fire.grid.size;
        const sources = sourcesFor(params.source);
        embers.rate = params.embers * boost;
        const igniters = collectIgniters(delta, ...(params.drag === 'orbit' ? [] : [pointer]));
        for (const igniter of igniters) {
          const ends = [
            [igniter.fromX, igniter.fromY],
            [igniter.toX, igniter.toY],
          ].map(([u, v]) => {
            const near = unprojectPoint(camera.invViewProj, u!, v!, 0);
            const far = unprojectPoint(camera.invViewProj, u!, v!, 1);
            const origin = toSolver(near);
            const dir: Vec3 = [
              (far[0]! - near[0]!) / WORLD_SCALE,
              (far[1]! - near[1]!) / WORLD_SCALE,
              (far[2]! - near[2]!) / WORLD_SCALE,
            ];
            return pointOnRay(origin, dir, size, 0.5);
          });
          const [a, b] = ends;
          if (!a || !b) continue;
          const dose = igniter.strength * Math.min(1, delta * 30);
          if (params.drag === 'heat') fire.addHeat(a, b, 0.05, 1.2 * dose);
          else fire.addHeat(a, b, 0.06, 0.3 * dose, 1.5 * dose);
        }
        for (const ember of embers.collect(delta)) {
          // The ember's (x, y) in 0..1 picks a source and a place along it.
          const s = sources[Math.min(sources.length - 1, Math.floor(ember.fromY * sources.length))];
          if (!s) continue;
          const t = ember.fromX;
          const at: Vec3 = [
            s.from[0] + (s.to[0] - s.from[0]) * t,
            s.from[1] + (s.to[1] - s.from[1]) * t,
            s.from[2] + (s.to[2] - s.from[2]) * t,
          ];
          fire.addHeat(at, at, s.radius * 0.8, 1.1 * ember.strength);
        }

        // 1. The simulation.
        fire.update(encoder, delta);

        // 2. The fire as one light.
        probeUniforms.set({
          box_min: boxMin,
          box_max: boxMax,
          blend: 1 - Math.exp(-delta / 0.35),
          gain: 900,
          fallback: [0, 0.5, 0],
          reset: probeGeneration !== fire.generation ? 1 : 0,
        });
        probeGeneration = fire.generation;
        probeUniforms.upload();
        const probeGroup = groupFor('probe', () =>
          device.createBindGroup({
            label: 'fire-3d probe',
            layout: probePipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: probeUniforms.buffer } },
              { binding: 1, resource: fire.fields.view },
              { binding: 2, resource: sampler },
              { binding: 3, resource: { buffer: lightBuffer } },
            ],
          }),
        );
        const probePass = encoder.beginComputePass({
          label: 'fire-3d probe',
          timestampWrites: profiler.pass('probe') as GPUComputePassTimestampWrites | undefined,
        });
        probePass.setPipeline(probePipeline);
        probePass.setBindGroup(0, probeGroup);
        probePass.dispatchWorkgroups(1);
        probePass.end();

        // 3. Opaque scene: flat albedo and depth.
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
        forward.draw(
          encoder,
          forward.upload(params.source === 'burner' ? burnerObjects : logObjects),
          {
            view,
            color: albedo.view,
            depth: depth.view,
            label: 'fire-3d scene',
            timestampWrites: profiler.pass('scene'),
          },
        );

        // 4. Light it into the HDR scene target.
        lightUniforms.set({
          box_min: boxMin,
          box_max: boxMax,
          time: time.time,
          fire_gain: 2.5 * params.brightness,
          fire_soft: 0.15,
          ember_offset: 0.03,
          ember_height: 0.5,
          ember_gain: 40 * params.brightness,
          ember_cap: 0.85,
        });
        lightUniforms.upload();
        const lightingGroup = groupFor('lighting', () =>
          device.createBindGroup({
            label: 'fire-3d lighting',
            layout: lightingPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: view.camera.buffer } },
              { binding: 1, resource: { buffer: lightUniforms.buffer } },
              { binding: 2, resource: albedo.view },
              { binding: 3, resource: depth.view },
              { binding: 4, resource: fire.fields.view },
              { binding: 5, resource: sampler },
              { binding: 6, resource: { buffer: lightBuffer } },
            ],
          }),
        );
        renderFullscreen(encoder, tail.scene.view, lightingPipeline, [lightingGroup], {
          timestampWrites: profiler.pass('lighting'),
        });

        // 5. Scene depth at the march resolution.
        const divisor = DIVISOR[params.resolution] ?? 2;
        if (divisor !== volume.divisor) volume.resize(width, height, divisor);
        volume.encodeDepth(encoder, {
          sceneDepth: depth.view,
          near: NEAR,
          far: FAR,
          depthLimit: boxDepthLimit(camera.view, boxMin, boxMax),
          timestampWrites: profiler.pass('march depth'),
        });

        // 6. The march.
        const steps = Math.round(params.steps);
        // `steps` samples across the box's width: about one per field texel on a ray through the
        // flames; longer rays (up the plume, corner to corner) stretch the step to stay within `steps`.
        const across = boxMax[0] - boxMin[0];
        setCameraUniform(marchCamera, camera, width, height);
        marchCamera.upload();
        const soot = Math.min(1, 0.45 * params.smoke);
        marchUniforms.set({
          uv_scale: volume.uvScale as [number, number],
          step_length: across / steps,
          max_steps: steps,
          box_min: boxMin,
          box_max: boxMax,
          early_out: 0.02,
          brightness: 22 * params.brightness,
          sky: [0.03, 0.04, 0.07],
          whiten: 14,
          soot,
          flame_opacity: 0.6 + 4 * Math.min(params.smoke, 1.2),
          blue: 0.5 * params.brightness,
          smoke_extinction: 10,
          fire_surface: 9,
          fire_radius: 0.35,
        });
        marchUniforms.upload();
        const marchGroup = groupFor('march', () =>
          device.createBindGroup({
            label: 'fire-3d march',
            layout: marchPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: marchUniforms.buffer } },
              { binding: 1, resource: { buffer: marchCamera.buffer } },
              { binding: 2, resource: volume.depth.view },
              { binding: 3, resource: fire.fields.view },
              { binding: 4, resource: sampler },
              { binding: 5, resource: { buffer: lightBuffer } },
            ],
          }),
        );
        renderFullscreen(encoder, volume.target.view, marchPipeline, [marchGroup], {
          timestampWrites: profiler.pass('march'),
        });

        // 7. Upsample under the full-resolution depth and blend over the lit scene.
        volume.composite(encoder, {
          color: tail.scene,
          sceneDepth: depth.view,
          timestampWrites: profiler.pass('upsample'),
        });

        // 8. Bloom, tonemap, output.
        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        orbit.destroy();
        pointer.destroy();
        embers.destroy();
        drive.destroy();
        fire.destroy();
        for (const mesh of Object.values(meshes)) mesh.destroy();
        forward.destroy();
        albedo.destroy();
        depth.destroy();
        lightBuffer.destroy();
        probeUniforms.destroy();
        lightUniforms.destroy();
        marchUniforms.destroy();
        marchCamera.destroy();
        volume.destroy();
        tail.destroy();
      },
    };
  },
});
