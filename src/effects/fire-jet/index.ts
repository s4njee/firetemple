import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createFixedStepper, type FixedStepper } from '../../gpu/loop.ts';
import {
  createParticleRenderer,
  createParticleSystem,
  overlayCamera,
  overlayFieldMapping,
  overlayPoint,
  type Collider,
  type Emitter,
  type ParticleRenderer,
  type ParticleSystem,
} from '../../gpu/particles/index.ts';
import { trackPointers, type MultiPointerTracker } from '../../gpu/pointer.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { CameraUniform, setCameraUniform } from '../../gpu/scene/camera.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createExcitation, EXCITATIONS, type Excitation } from '../../gpu/sim/excitation.ts';
import { createFireFluid, type FireFluid } from '../../gpu/sim/fire-fluid.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import hooks from './hooks.wgsl';
import {
  aimAngle,
  angleDelta,
  jetImpulse,
  meanDropletPath,
  modeGeometry,
  MODES,
  overlayDirection,
  throttle,
  uvAlong,
  uvDirection,
} from './jet.ts';
import { meta } from './meta.ts';
import scene from './scene.wgsl';
import shade from './shade.wgsl';

// Story 7.8: particles carried by the Epic 6 velocity field. A 2D fire fluid (createFireFluid on the
// stable-fluids solver) is driven by a nozzle: every step a fuel burner sits in the nozzle's mouth and
// a push of momentum along the aim is queued over the first stretch of the jet (fluid.addForce), so
// the gas leaves the nozzle at about the jet speed, burns as it goes, expands, slows, curls into
// eddies and rises. A GPU particle system reads the fluid's resolved velocity texture
// (`system.setField(fluid.fieldsView)` with `overlayFieldMapping`, mode 'drag'):
//   - burning droplets leave the nozzle faster than the gas, are dragged towards it slowly, fall
//     under gravity, shed embers, and splash into embers on a wall;
//   - flame sprites are dragged towards the gas hard (hook_force adds coupling), so they are the gas
//     made visible: they spread, curl, rise as it slows, grow and cool along the fire ramp;
//   - embers are spawned on the GPU (hook_update, hook_collide) and drift up on their own heat.
// The coupling is one way: the field moves the particles, the particles do not push the field. The
// fluid draws its own heat glow and its soot; the particles are added on top (`look` switches either
// off, for comparison).

const Params = defineUniformStruct('Params', {
  nozzle: 'vec4f',
  wall: 'vec4f',
  light_pos: 'vec2f',
  aspect: 'f32',
  nozzle_on: 'f32',
  light_colour: 'vec3f',
  kelvin_per_unit: 'f32',
  flame: 'f32',
  fluid_glow: 'f32',
  opacity: 'f32',
  soot_gain: 'f32',
});

const LOOKS = ['fluid + particles', 'particles', 'fluid'] as const;
const RESOLUTIONS = ['96', '128', '160'] as const;
const KIND = { droplet: 0, flame: 1, ember: 2 } as const;
/** How much of the calm fuel and emission a full drive level adds. */
const DRIVE_SHARE = 0.4;
/** The wall of the `wall splash` preset, in uv: [x0, y0, x1, y1]. */
const WALL: readonly [number, number, number, number] = [0.66, 0.1, 0.71, 1];
/** How far along the jet the push reaches, canvas heights. */
const PUSH_LENGTH = 0.07;
/** Its Gaussian radius, canvas heights. */
const PUSH_RADIUS = 0.022;
const DEG = Math.PI / 180;
/** Seconds the nozzle takes to turn most of the way to a new aim. */
const AIM_TIME = 0.12;
/** Share of the droplet stream's drag the air feels, with two-way coupling. */
const TWO_WAY_MOMENTUM = 0.25;

export const effect = defineEffect({
  meta,
  params: {
    mode: { type: 'select', default: 'flamethrower', options: MODES },
    look: { type: 'select', default: 'fluid + particles', options: LOOKS },
    speed: {
      type: 'number',
      default: 1.4,
      min: 0.3,
      max: 3,
      step: 0.01,
      label: 'jet speed (heights/s)',
    },
    spread: { type: 'number', default: 7, min: 0, max: 30, step: 0.5, label: 'spread (degrees)' },
    fuel: { type: 'number', default: 6, min: 0, max: 14, step: 0.1, label: 'fuel rate' },
    droplets: { type: 'number', default: 260, min: 0, max: 2000, step: 10, label: 'droplets / s' },
    flames: {
      type: 'number',
      default: 900,
      min: 0,
      max: 6000,
      step: 10,
      label: 'flame sprites / s',
    },
    coupling: {
      type: 'number',
      default: 2.2,
      min: 0.2,
      max: 10,
      step: 0.1,
      label: 'droplet drag (1/s)',
    },
    gravity: { type: 'number', default: 0.7, min: 0, max: 3, step: 0.01, label: 'droplet gravity' },
    shed: {
      type: 'number',
      default: 14,
      min: 0,
      max: 40,
      step: 0.5,
      label: 'flames / droplet / s',
    },
    embers: {
      type: 'number',
      default: 0.5,
      min: 0,
      max: 8,
      step: 0.05,
      label: 'embers / droplet / s',
    },
    buoyancy: { type: 'number', default: 0.9, min: 0, max: 3, step: 0.01 },
    soot: { type: 'number', default: 0.3, min: 0, max: 1.5, step: 0.01, label: 'soot yield' },
    wall: { type: 'boolean', default: false },
    twoWay: {
      type: 'boolean',
      default: false,
      label: 'two-way coupling (mean droplet stream)',
    },
    intensity: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    resolution: {
      type: 'select',
      default: '128',
      options: RESOLUTIONS,
      label: 'velocity cells (long side)',
    },
    drive: { type: 'select', default: 'none', options: EXCITATIONS },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    flamethrower: {},
    'dragon breath': {
      mode: 'dragon breath',
      speed: 1.3,
      spread: 14,
      fuel: 8,
      droplets: 60,
      flames: 1400,
      gravity: 0.2,
      soot: 0.45,
      embers: 3,
    },
    'wall splash': { wall: true, speed: 1.6, gravity: 0.4 },
    'two-way coupling': { twoWay: true, speed: 1, shed: 10 },
    'particles only': { look: 'particles' },
    'fluid only': { look: 'fluid' },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'fire-jet' });
    const camera = createUniformBuffer(device, CameraUniform, 'fire-jet camera');
    const uniforms = createUniformBuffer(device, Params, 'fire-jet params');
    const sampler = device.createSampler({
      label: 'fire-jet sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const layout = device.createBindGroupLayout({
      label: 'fire-jet scene layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(scene, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
      layout: [layout],
    });

    let width = Math.max(1, canvas.width || 16);
    let height = Math.max(1, canvas.height || 9);
    let simAspect = width / height;
    const cells = () => Number(params.resolution) || 128;
    const fire: FireFluid = createFireFluid({
      device,
      resolution: cells(),
      width,
      height,
      profiler,
      label: 'fire-jet',
    });
    let fluidStepper: FixedStepper | undefined;
    let fluidStepSeconds = 0;
    let wallShown: boolean | undefined;

    const system: ParticleSystem = createParticleSystem({
      device,
      capacity: 32768,
      dimension: 2,
      fixedStep: 1 / 60,
      maxSteps: 4,
      queueCapacity: 2048,
      hooks: { code: hooks.code, chunks: hooks.chunks },
      profiler,
      label: 'fire-jet particles',
      seed: 9,
    });
    const droplets: Emitter = system.addEmitter({ kind: KIND.droplet });
    const flames: Emitter = system.addEmitter({ kind: KIND.flame });
    // The ember template (third, `FJ_EMBER_TEMPLATE` in hooks.wgsl): born on the GPU.
    system.addEmitter({
      spread: Math.PI,
      speed: [0.03, 0.18],
      inherit: 0.35,
      life: [1.2, 2.6],
      temperature: [1800, 2300],
      size: [0.0016, 0.003],
      kind: KIND.ember,
    });
    // The flame template (fourth, `FJ_FLAME_TEMPLATE`): flame a burning droplet sheds as it flies.
    system.addEmitter({
      spread: Math.PI,
      speed: [0, 0.12],
      inherit: 0.55,
      life: [0.5, 1.1],
      temperature: [1900, 2200],
      size: [0.01, 0.017],
      kind: KIND.flame,
    });
    const renderer: ParticleRenderer = createParticleRenderer(system, {
      camera: camera.buffer,
      format: tail.scene.format,
      shade: { label: shade.label, code: shade.code, chunks: shade.chunks },
      profiler,
    });

    // Only for aiming: a pointer over the canvas, pressed or not. No capture, so a page with the jet
    // behind its content still scrolls by touch.
    const pointer: MultiPointerTracker | undefined =
      typeof canvas.addEventListener === 'function'
        ? trackPointers(canvas, { capture: false, maxPointers: 2 })
        : undefined;
    let drive: Excitation = createExcitation(params.drive, canvas);
    let clock = 0;
    let warm = false;
    let seededGeneration = -1;
    let groupKey = '';
    let group: GPUBindGroup | undefined;
    /** The latest aim, for tests and tools. */
    let aim = 0;

    function sceneGroup(): GPUBindGroup {
      const key = `${fire.generation}|${fire.dye.slot}`;
      if (!group || key !== groupKey) {
        groupKey = key;
        group = device.createBindGroup({
          label: 'fire-jet scene',
          layout,
          entries: [
            { binding: 0, resource: { buffer: uniforms.buffer } },
            { binding: 1, resource: fire.dye.view },
            { binding: 2, resource: sampler },
          ],
        });
      }
      return group;
    }

    /** Fluid parameters, from the effect's. */
    function syncFluid(level: number, open: number): void {
      const p = fire.params;
      p.fuelRate = params.fuel * open * (1 + DRIVE_SHARE * level);
      p.lumps = 0;
      p.lumpScale = 0.04;
      p.lumpRise = 0.8;
      p.bedTemperature = 1.3;
      p.ignition = 0.8;
      p.burnRate = 3.2;
      p.heat = 2.6;
      p.expansion = 0.3;
      p.buoyancy = params.buoyancy;
      p.cooling = 1.1;
      p.soot = params.soot;
      p.sootFade = 0.3;
      p.vorticity = 4;
      p.velocityDissipation = 0.7;
      p.turbulence = 3;
      p.turbulenceScale = 6;
      p.floor = false;
      fire.fluid.setResolution(cells(), Math.min(1024, cells() * 4));
      if (wallShown !== params.wall) {
        wallShown = params.wall;
        // Remembered in uv, so the mask is rasterised again whenever the grid is re-created.
        fire.fluid.obstacles.setRects(
          params.wall
            ? [{ x: WALL[0], y: WALL[1], width: WALL[2] - WALL[0], height: WALL[3] - WALL[1] }]
            : [],
        );
      }
    }

    /** Particle settings, from the effect's. */
    function syncParticles(level: number, open: number, angle: number, nozzle: [number, number]) {
      const aspect = width / height;
      const f = system.forces;
      f.field = 'drag';
      f.fieldCoupling = params.coupling;
      f.fieldMapping = overlayFieldMapping(aspect);
      f.gravity = [0, 0, 0];
      f.buoyancy = 0;
      f.dragLinear = 0;
      f.turbulence = 'none';
      system.heat.cooling = 'none';
      system.heat.ambient = 300;
      system.heat.deathTemperature = 0;
      system.setField(fire.fluid.fieldsView);
      system.params.user[0] = [params.gravity, 7, params.embers, 0.25];
      system.params.user[1] = [0.15, 1.1, 0.5, params.shed];
      system.params.user[2] = [2, 0, 0, 0];

      const mouth = overlayPoint(nozzle[0], nozzle[1], aspect);
      const direction = overlayDirection(angle);
      const share = open * (1 + DRIVE_SHARE * level);
      const spread = params.spread * DEG;
      droplets.moveTo(mouth);
      droplets.direction = [direction[0], direction[1], 0];
      droplets.spread = spread * 0.6;
      droplets.speed = [params.speed * 1.05, params.speed * 1.3];
      droplets.life = [0.9, 1.6];
      droplets.temperature = [2100, 2400];
      droplets.size = [0.005, 0.009];
      droplets.rate = params.droplets * share;

      flames.moveTo(mouth);
      flames.shape = 'sphere';
      flames.radius = 0.008;
      flames.direction = [direction[0], direction[1], 0];
      flames.spread = spread;
      flames.speed = [params.speed * 0.6, params.speed * 1.0];
      flames.life = [0.8, 1.5];
      flames.temperature = [1950, 2250];
      flames.size = [0.012, 0.02];
      flames.rate = params.flames * share;

      const colliders: Collider[] = [];
      if (params.wall) {
        const x0 = WALL[0] * aspect;
        const x1 = WALL[2] * aspect;
        colliders.push({
          type: 'box',
          center: [(x0 + x1) / 2, 1 - (WALL[1] + WALL[3]) / 2, 0],
          half: [(x1 - x0) / 2, (WALL[3] - WALL[1]) / 2, 1],
          restitution: 0.15,
          friction: 0.5,
        });
      }
      system.colliders.length = 0;
      system.colliders.push(...colliders);

      const both = params.look === 'fluid + particles';
      const style = renderer.style;
      style.color = 'tint';
      style.tint = [1, 1, 1];
      style.intensity = params.intensity;
      style.twinkle = 0.2;
      style.twinkleRate = 3;
      style.sizeCurve = [1, 1, 1, 0.5];
      style.fadeIn = 0.05;
      style.fadeOut = 0.4;
      style.user[0] = [2300, 800, both ? 0.5 : 0.9, 2.2];
      style.user[1] = [3, 0.35, 0, 0];
      // Flame sprites start small at the nozzle and billow to three times the size as they slow.
      style.user[2] = [0.5, 3, 2.2, 0.55];
      const sprites = renderer.sprites.settings;
      sprites.shape = 1;
      sprites.minPixels = 0.8;
      sprites.stretch = 1.6;
      sprites.maxStretch = 5;
      sprites.stretchDim = 0.5;
      sprites.trail = 0.6;
      sprites.depth = 'none';
    }

    /**
     * What the nozzle puts into the gas for `steps` steps: the push along the aim over the first
     * stretch of the jet; with two-way coupling, also the mean droplet stream's drag on the air and the
     * fuel vapour and heat it gives off, along the path the CPU predicts for the mean droplet.
     */
    function inject(
      steps: number,
      dt: number,
      nozzle: readonly [number, number],
      aspect: number,
      open: number,
    ): void {
      const tip = uvAlong(nozzle, aim, 0.012, aspect);
      const push = uvDirection(aim);
      const impulse = jetImpulse(params.speed * open, steps, dt, PUSH_LENGTH);
      fire.fluid.addForce(tip, uvAlong(nozzle, aim, PUSH_LENGTH, aspect), PUSH_RADIUS, [
        push[0] * impulse,
        push[1] * impulse,
      ]);
      if (!params.twoWay || params.droplets <= 0) return;
      const seconds = steps * dt;
      // The stream's strength: droplets per second relative to the default, and the throttle.
      const loading = (params.droplets / 260) * open;
      const path = meanDropletPath(
        aim,
        params.speed * 1.17,
        params.coupling,
        params.gravity,
        [0.9, 1.6],
        6,
      );
      const toUv = (p: readonly [number, number]): [number, number] => [
        nozzle[0] + p[0] / aspect,
        nozzle[1] - p[1],
      ];
      for (const s of path) {
        // Drag on still air: coupling * (droplet velocity) per second, scaled by the loading.
        const k = Math.min(1, params.coupling * seconds) * TWO_WAY_MOMENTUM * loading * s.alive;
        fire.fluid.addForce(toUv(s.from), toUv(s.to), 0.025, [
          s.velocity[0] * k,
          -s.velocity[1] * k,
        ]);
        // Burning droplets warm the air and leave fuel vapour behind them.
        const f = seconds * loading * s.alive;
        fire.fluid.addDye(toUv(s.from), toUv(s.to), 0.018, [0.5 * f, 2 * f, 0, 0]);
      }
    }

    return {
      /** The fire fluid, the particle system and the current aim (radians), for tests and tools. */
      get fire() {
        return fire;
      },
      get system() {
        return system;
      },
      get aim() {
        return aim;
      },
      resize(w, h) {
        width = Math.max(1, Math.round(w));
        height = Math.max(1, Math.round(h));
        tail.resize(width, height);
        setCameraUniform(camera, overlayCamera(width, height), width, height);
        camera.upload();
        const aspect = width / height;
        if (Math.abs(Math.log(aspect / simAspect)) > 0.06) {
          simAspect = aspect;
          fire.fluid.resize(width, height);
        }
      },

      frame(time, encoder, target) {
        const delta = Math.min(Math.max(time.delta, 0), 0.25);
        clock += delta;
        if (drive.kind !== params.drive) {
          drive.destroy();
          drive = createExcitation(params.drive, canvas);
        }
        const level = drive.update(delta);
        const aspect = width / height;
        const geometry = modeGeometry(params.mode);
        const nozzle: [number, number] = [geometry.nozzle[0], geometry.nozzle[1]];
        const over = pointer?.poll().find((p) => p.inside || p.down);
        const wanted = aimAngle(params.mode, aspect, clock, over ? [over.x, over.y] : undefined);
        // The nozzle turns quickly but not instantly (no jump when the pointer leaves).
        aim = warm ? aim + angleDelta(wanted, aim) * (1 - Math.exp(-delta / AIM_TIME)) : wanted;
        const open = throttle(params.mode, clock);

        syncFluid(level, open);
        if (seededGeneration !== fire.generation) {
          seededGeneration = fire.generation;
          fire.seed();
        }
        // The burner sits in the nozzle's mouth: fuel and a pilot's heat, no upward jet of its own.
        const tip = uvAlong(nozzle, aim, 0.012, aspect);
        const mouth = uvAlong(nozzle, aim, 0.03, aspect);
        fire.setSources([{ from: tip, to: mouth, radius: 0.016, fuel: 4 * params.speed, bed: 1 }]);

        const dt = fire.fluid.stepSeconds;
        if (!fluidStepper || Math.abs(fluidStepSeconds - dt) > dt * 1e-3) {
          fluidStepper = createFixedStepper(dt, { maxSteps: 3 });
          fluidStepSeconds = dt;
        }
        const runSteps = (encoder: GPUCommandEncoder, steps: number) => {
          if (steps > 0 && open > 0.01) inject(steps, dt, nozzle, aspect, open);
          fire.advance(encoder, steps);
        };
        if (!warm) {
          // Start mid-jet, also for a still frame: a second of flow, then particles riding it.
          warm = true;
          for (let k = 0; k < 4; k++) {
            const warmEncoder = device.createCommandEncoder({ label: 'fire-jet warm-up' });
            runSteps(warmEncoder, 15);
            device.queue.submit([warmEncoder.finish()]);
          }
          syncParticles(level, open, aim, nozzle);
          droplets.jumpTo(droplets.position);
          flames.jumpTo(flames.position);
          system.warmup(1.2);
        }
        runSteps(encoder, fluidStepper.advance(delta).steps);

        syncParticles(level, open, aim, nozzle);
        system.advance(encoder, time.delta);
        renderer.encode(encoder, time.delta);

        const grid = fire.grid;
        const back = uvAlong(nozzle, aim, -0.09, aspect);
        const light = uvAlong(nozzle, aim, 0.25, aspect);
        const look = params.look;
        uniforms.set({
          nozzle: [nozzle[0], nozzle[1], back[0], back[1]],
          wall: params.wall ? [...WALL] : [0, 0, 0, 0],
          light_pos: light,
          aspect: grid.aspect,
          nozzle_on: params.mode === 'flamethrower' ? 1 : 0,
          light_colour: [3.2, 1.3, 0.4],
          kelvin_per_unit: 520,
          flame: 7 * params.intensity,
          fluid_glow: look === 'particles' ? 0 : look === 'fluid' ? 1 : 0.7,
          opacity: 2.5,
          soot_gain: look === 'particles' ? 0 : 1,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [sceneGroup()], {
          timestampWrites: profiler.pass('fire-jet fluid'),
        });
        if (look !== 'fluid') {
          renderer.draw(encoder, {
            target: tail.scene.view,
            timestampWrites: profiler.pass('fire-jet sprites'),
          });
        }
        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        pointer?.destroy();
        drive.destroy();
        renderer.destroy();
        system.destroy();
        fire.destroy();
        uniforms.destroy();
        camera.destroy();
        tail.destroy();
      },
    };
  },
});
