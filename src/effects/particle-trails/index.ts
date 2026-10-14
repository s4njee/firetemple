import { createFixedStepper } from '../../gpu/loop.ts';
import {
  ARGS,
  createParticleRenderer,
  orthographicCamera,
  overlayPoint,
  type Emitter,
  type ParticleRenderer,
  type ParticleSystem,
} from '../../gpu/particles/index.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { CameraUniform, setCameraUniform } from '../../gpu/scene/camera.ts';
import { createExcitation, EXCITATIONS, type Excitation } from '../../gpu/sim/excitation.ts';
import { createPointerIgnition } from '../../gpu/sim/ignition.ts';
import { createSpriteRenderer, type SpriteRenderer } from '../../gpu/sprites.ts';
import { createUniformBuffer } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import {
  createAccumulation,
  createRibbons,
  createTrailSystem,
  STEP_SLOTS_PER_SUBMIT,
  TRAIL_STEP,
  type Ribbons,
} from './trails.ts';

// Story 7.7: ribbon trails against an accumulation buffer, on the same particles (trails.ts has the
// two techniques). `method: split` draws ribbons on the left half and accumulation on the right;
// the particles' heads are the same sprites on both sides. Three scenes: comets on Kepler orbits
// round an attractor, a sparkler moving on a Lissajous path (or under the pointer), and embers
// swirling between two vortices.

const SCENES = ['comets', 'sparkler', 'vortex'] as const;
const METHODS = ['split', 'ribbons', 'accumulation'] as const;
type Scene = (typeof SCENES)[number];

const DRIVE_SHARE = 0.6;
/** Mean life per scene, seconds (the emission rate is count / life: Little's law). */
const LIFE: Readonly<Record<Scene, readonly [number, number]>> = {
  comets: [6, 10],
  sparkler: [0.25, 0.7],
  vortex: [5, 8],
};

export const effect = defineEffect({
  meta,
  params: {
    scene: { type: 'select', default: 'vortex', options: SCENES },
    method: { type: 'select', default: 'split', options: METHODS },
    count: {
      type: 'number',
      default: 1500,
      min: 100,
      max: 100000,
      step: 100,
      label: 'particles (average alive)',
    },
    history: { type: 'number', default: 24, min: 4, max: 64, step: 1, label: 'ribbon points' },
    decay: {
      type: 'number',
      default: 0.12,
      min: 0.02,
      max: 1,
      step: 0.01,
      label: 'accumulation tau (s)',
    },
    width: { type: 'number', default: 1.2, min: 0.3, max: 4, step: 0.05, label: 'ribbon width' },
    taper: { type: 'number', default: 1, min: 0, max: 1, step: 0.05, label: 'ribbon taper' },
    ribbon: {
      type: 'number',
      default: 0.5,
      min: 0,
      max: 2,
      step: 0.05,
      label: 'ribbon brightness',
    },
    gain: { type: 'number', default: 2.5, min: 0, max: 8, step: 0.05, label: 'trail gain' },
    intensity: { type: 'number', default: 2.2, min: 0, max: 12, step: 0.1 },
    size: { type: 'number', default: 1, min: 0.3, max: 4, step: 0.05 },
    motion: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'camera motion' },
    drive: { type: 'select', default: 'none', options: EXCITATIONS },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    'vortex embers': {},
    comets: {
      scene: 'comets',
      count: 200,
      history: 48,
      decay: 0.3,
      size: 1.4,
      intensity: 2,
      gain: 4,
    },
    sparkler: { scene: 'sparkler', count: 2500, history: 10, decay: 0.05, width: 1, gain: 2 },
    'camera motion': {
      scene: 'comets',
      count: 200,
      history: 48,
      decay: 0.3,
      motion: 1,
      size: 1.4,
      intensity: 2,
      gain: 4,
    },
    'ribbons only': { method: 'ribbons' },
    'accumulation only': { method: 'accumulation' },
    '100k vortex': { count: 100000, history: 16, size: 0.5, intensity: 1.2 },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'particle-trails' });
    const camera = createUniformBuffer(device, CameraUniform, 'particle-trails camera');
    const pointer = createPointerIgnition(canvas, { radius: 0.02 });
    const accumulation = createAccumulation(device, { format: tail.scene.format, profiler });
    let drive: Excitation = createExcitation(params.drive, canvas);
    const stepper = createFixedStepper(TRAIL_STEP, { maxSteps: 4 });

    interface Sim {
      capacity: number;
      system: ParticleSystem;
      renderer: ParticleRenderer;
      deposit: SpriteRenderer;
      main: Emitter;
      touch: Emitter;
    }
    let sim: Sim | undefined;
    let ribbons: Ribbons | undefined;
    let ribbonRequest = 0;
    let width = 1;
    let height = 1;
    let clock = 0;
    let scene = '';
    let accumulating = false;

    const aspect = () => width / height;

    function build(capacity: number): Sim {
      const system = createTrailSystem(device, { capacity, profiler });
      const main = system.addEmitter({});
      const touch = system.addEmitter({ shape: 'point', spread: Math.PI });
      const renderer = createParticleRenderer(system, {
        camera: camera.buffer,
        format: tail.scene.format,
        profiler,
      });
      // The same instances drawn into the accumulation target with their own settings.
      const deposit = createSpriteRenderer(device, {
        capacity,
        camera: camera.buffer,
        buffer: renderer.buffer,
        label: 'trails deposit',
      });
      return { capacity, system, renderer, deposit, main, touch };
    }

    /** The sparkler's path: a slow Lissajous figure round the middle. */
    const path = (t: number): [number, number, number] => [
      aspect() / 2 + 0.32 * Math.min(aspect(), 1.6) * Math.sin(0.9 * t),
      0.5 + 0.22 * Math.sin(1.7 * t + 0.6),
      0,
    ];

    function sync(s: Sim, level: number): void {
      const { system, main, touch } = s;
      const sceneName = params.scene as Scene;
      const cx = aspect() / 2;
      const f = system.forces;
      const life = LIFE[sceneName];
      const rate = ((params.count * 2) / (life[0] + life[1])) * (1 + DRIVE_SHARE * level);
      f.points = [];
      f.turbulence = 'none';
      f.buoyancy = 0;
      f.wind = [0, 0, 0];
      system.heat.ambient = 300;
      system.heat.deathTemperature = 0;
      main.life = life;
      main.rate = rate;
      main.inherit = 0;
      main.radial = 0;
      system.params.user[0] = [cx, 0.5, 0, 0];
      system.params.user[1] = [0, 0, 0, 0];
      if (sceneName === 'comets') {
        // Kepler orbits round a softened attractor: circular speed R sqrt(attract / d).
        const attract = 4;
        const radius = 0.1;
        f.gravity = [0, 0, 0];
        f.dragLinear = 0;
        f.points = [{ position: [cx, 0.5, 0], attract, swirl: 0, radius }];
        system.params.user[0] = [cx, 0.5, 1, radius * Math.sqrt(attract)];
        main.shape = 'disc';
        main.radius = 0.42;
        main.innerRadius = 0.18;
        main.jumpTo([cx, 0.5, 0]);
        main.speed = [0, 0];
        main.temperature = [2000, 2700];
        main.size = [0.0035 * params.size, 0.006 * params.size];
        system.heat.cooling = 'none';
      } else if (sceneName === 'sparkler') {
        f.gravity = [0, -0.6, 0];
        f.dragLinear = 1.5;
        main.shape = 'point';
        main.spread = Math.PI;
        main.speed = [0.25, 0.9];
        main.inherit = 0.2;
        main.temperature = [2500, 3200];
        main.size = [0.0012 * params.size, 0.0025 * params.size];
        system.heat.cooling = 'newton';
        system.heat.rate = 2.5;
      } else {
        // Embers in a row of vortices (the air is hook_force in trails.ts).
        f.gravity = [0, 0, 0];
        f.dragLinear = 0;
        f.turbulence = '2d';
        f.turbulenceStrength = 0.08;
        f.turbulenceFrequency = 3;
        f.turbulenceEvolve = 0.2;
        system.params.user[1] = [2, cx, Math.min(aspect(), 1.8) * 0.3, 0.24];
        // Born all through the band the vortices turn, so they circle rather than pass by.
        main.shape = 'box';
        main.jumpTo([cx, 0.55, 0]);
        main.extent = [Math.min(aspect(), 1.8) * 0.45, 0.32, 0];
        main.direction = [0, 1, 0];
        main.spread = Math.PI;
        main.speed = [0, 0.05];
        main.temperature = [1800, 2300];
        main.size = [0.0018 * params.size, 0.0035 * params.size];
        system.heat.cooling = 'newton';
        system.heat.rate = 0.12;
      }

      touch.speed = [0.2, 0.7];
      touch.life = [0.3, 0.8];
      touch.temperature = [2500, 3100];
      touch.size = [0.0015 * params.size, 0.003 * params.size];
      touch.inherit = 0.3;

      const style = s.renderer.style;
      style.color = 'blackbody';
      style.intensity = params.intensity;
      style.tRef = 1800;
      style.gamma = 0.4;
      style.twinkle = 0;
      style.fadeIn = 0.05;
      style.fadeOut = 0.15;
      // Heads only: velocity stretch would be a trail of its own.
      const sprites = s.renderer.sprites.settings;
      sprites.shape = 'gaussian';
      sprites.minPixels = 0.8;
      sprites.stretch = 0;
      sprites.depth = 'none';
    }

    function pan(): number {
      return params.motion * 0.12 * Math.sin((2 * Math.PI * clock) / 5);
    }

    function setCamera(): [number, number, number, number] {
      const cx = aspect() / 2 + pan();
      setCameraUniform(
        camera,
        orthographicCamera({ center: [cx, 0.5], halfHeight: 0.5, aspect: aspect() }),
        width,
        height,
      );
      camera.upload();
      return [cx, 0.5, aspect() / 2, 0.5];
    }

    /** Steps the simulation `steps` times, recording ribbon points after each when asked. */
    function stepTimes(encoder: GPUCommandEncoder, s: Sim, steps: number, record: boolean): void {
      for (let k = 0; k < steps; k++) {
        clock += TRAIL_STEP;
        if (params.scene === 'sparkler' && pointer.pressed === 0) s.main.moveTo(path(clock));
        s.system.step(encoder, 1);
        if (record) ribbons?.record(encoder);
      }
    }

    function warm(s: Sim): void {
      const seconds = params.scene === 'sparkler' ? 1 : params.scene === 'comets' ? 8 : 5;
      if (params.scene === 'sparkler') s.main.jumpTo(path(clock));
      let left = Math.round(seconds / TRAIL_STEP);
      while (left > 0) {
        const n = Math.min(left, STEP_SLOTS_PER_SUBMIT);
        const encoder = device.createCommandEncoder({ label: 'particle-trails warm-up' });
        stepTimes(encoder, s, n, true);
        device.queue.submit([encoder.finish()]);
        left -= n;
      }
    }

    return {
      resize(newWidth, newHeight) {
        width = newWidth;
        height = newHeight;
        tail.resize(width, height);
        // The accumulation lives in screen space: a resize starts it again, empty.
        accumulation.resize(width, height);
        accumulating = false;
        setCamera();
      },

      frame(time, encoder, target) {
        const delta = Math.min(Math.max(time.delta, 0), 0.25);
        if (drive.kind !== params.drive) {
          drive.destroy();
          drive = createExcitation(params.drive, canvas);
        }
        const level = drive.update(delta);
        const capacity = Math.max(1024, Math.ceil((params.count * 1.4) / 1024) * 1024);
        let fresh = false;
        if (!sim || sim.capacity !== capacity) {
          ribbons?.destroy();
          ribbons = undefined;
          sim?.deposit.destroy();
          sim?.renderer.destroy();
          sim?.system.destroy();
          sim = build(capacity);
          fresh = true;
        }
        const s = sim;
        // (The device may hold fewer points than asked for: compare with the request.)
        if (!ribbons || ribbonRequest !== Math.round(params.history)) {
          ribbons?.destroy();
          ribbonRequest = Math.round(params.history);
          ribbons = createRibbons(s.system, {
            points: ribbonRequest,
            format: tail.scene.format,
            profiler,
          });
        }
        sync(s, level);
        if (fresh || scene !== params.scene) {
          scene = params.scene;
          s.system.reset();
          warm(s);
        }

        const method = params.method;
        const useRibbons = method !== 'accumulation';
        const useAccumulation = method !== 'ribbons';

        // The pointer: sparks from wherever it is pressed (in the sparkler, it IS the sparkler).
        const igniters = pointer.collect(delta);
        const last = igniters[igniters.length - 1];
        const holder = params.scene === 'sparkler' ? s.main : s.touch;
        if (last) {
          holder.moveTo(overlayPoint(last.toX, last.toY, aspect()));
          if (holder === s.touch) s.touch.rate = 500 * params.size;
        } else {
          s.touch.rate = 0;
        }

        const steps = stepper.advance(delta).steps;
        stepTimes(encoder, s, steps, useRibbons);
        s.renderer.encode(encoder, delta);
        const view = setCamera();

        let split = 1e9;
        if (useAccumulation) {
          if (!accumulating) accumulation.clear(encoder);
          accumulating = true;
          const weight = accumulation.decay(encoder, delta, params.decay);
          const d = s.deposit.settings;
          d.shape = 'gaussian';
          d.minPixels = 0.8;
          d.depth = 'none';
          d.intensity = weight;
          // Stretch each deposit over the path its particle covers in this frame (trail: 1, behind
          // it) and keep its total light, so a fast particle leaves a line rather than a row of dots.
          const meanSize = (s.main.size[0] + s.main.size[1]) / 2;
          d.stretch = delta / (2 * Math.max(meanSize, 1e-4));
          d.maxStretch = 40;
          d.trail = 1;
          d.stretchDim = 1;
          s.deposit.draw(encoder, {
            target: accumulation.view,
            indirect: { buffer: s.system.args, offset: ARGS.indirect },
            label: 'trails deposit',
            timestampWrites: profiler.pass('trails deposit'),
          });
          split = method === 'split' ? width / 2 : 0;
        } else {
          accumulating = false;
        }
        accumulation.composite(encoder, tail.scene.view, params.gain, split);

        if (useRibbons) {
          ribbons.draw(encoder, {
            target: tail.scene.view,
            style: {
              pixel: 1 / height,
              view,
              width: params.width,
              intensity: params.intensity * params.ribbon,
              minPixels: 0.8,
              taper: params.taper,
              tRef: 1800,
              gamma: 0.4,
            },
            scissor: method === 'split' ? [0, 0, Math.floor(width / 2), height] : undefined,
            timestampWrites: profiler.pass('trails ribbons'),
          });
        }
        s.renderer.draw(encoder, {
          target: tail.scene.view,
          timestampWrites: profiler.pass('trails heads'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        ribbons?.destroy();
        sim?.deposit.destroy();
        sim?.renderer.destroy();
        sim?.system.destroy();
        accumulation.destroy();
        pointer.destroy();
        drive.destroy();
        camera.destroy();
        tail.destroy();
      },
    };
  },
});
