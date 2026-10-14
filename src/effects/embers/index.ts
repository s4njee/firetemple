import {
  createParticleRenderer,
  createParticleSystem,
  overlayCamera,
  overlayPoint,
  type Emitter,
  type ParticleRenderer,
  type ParticleSystem,
} from '../../gpu/particles/index.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { CameraUniform, setCameraUniform } from '../../gpu/scene/camera.ts';
import { createExcitation, EXCITATIONS, type Excitation } from '../../gpu/sim/excitation.ts';
import {
  createAmbientIgnition,
  createPointerIgnition,
  type Igniter,
} from '../../gpu/sim/ignition.ts';
import { createUniformBuffer } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import {
  AMBIENT,
  DEATH_TEMPERATURE,
  DRAG,
  DRIVE_SHARE,
  emberCapacity,
  emberPhysics,
} from './physics.ts';

// Story 7.2: flying embers on the particle framework (src/gpu/particles/). Everything is in the 2D
// overlay space (canvas heights, origin bottom-left), so the picture is the same at any canvas size.
//
//   - A hidden fire line just below the bottom edge emits embers at a steady rate; ambient "pops"
//     (createAmbientIgnition, a Poisson process on the simulation clock) throw a handful at once
//     from a random place along it, and the pointer is a torch (createPointerIgnition): each
//     segment a press or drag covered becomes a segment emitter whose burst is proportional to its
//     length, so a fast stroke leaves an even trail.
//   - Embers are lifted by buoyancy in proportion to how much hotter than the air they are, held
//     back by drag towards the wind, and pushed about by 2D curl noise. As they cool they slow and
//     drift instead of rising.
//   - Temperature cools exactly (Newton) from about 1900 K; colour is blackbody_radiance(T), so the
//     cooling alone carries an ember from yellow-orange through deep red to nothing. An ember dies
//     when it reaches 650 K, by which time it gives off well under 1% of its first light.
//   - Twinkle is particle_twinkle: per ember, at most 4 Hz, so it is local flicker only.
//   - The drive (scroll or audio) raises the emission rate by up to 60% of the calm rate. It never
//     touches the clock.

/** Most torch segments per frame (each takes an emitter). */
const TORCH_EMITTERS = 3;

/** Splits a list of igniters into at most `parts` runs of consecutive segments. */
function chunks(igniters: readonly Igniter[], parts: number): Igniter[][] {
  const n = igniters.length;
  const m = Math.min(parts, n);
  const out: Igniter[][] = [];
  for (let k = 0; k < m; k++) {
    out.push(igniters.slice(Math.floor((k * n) / m), Math.floor(((k + 1) * n) / m)));
  }
  return out;
}

export const effect = defineEffect({
  meta,
  params: {
    count: {
      type: 'number',
      default: 2500,
      min: 200,
      max: 200000,
      step: 100,
      label: 'embers (average alive)',
    },
    lifetime: {
      type: 'number',
      default: 5,
      min: 1.5,
      max: 10,
      step: 0.1,
      label: 'glow time (s)',
    },
    rise: {
      type: 'number',
      default: 0.27,
      min: 0.03,
      max: 1,
      step: 0.01,
      label: 'rise (heights/s)',
    },
    source: { type: 'number', default: 0.8, min: 0.05, max: 1, step: 0.01, label: 'source width' },
    wind: { type: 'number', default: 0.03, min: -0.5, max: 0.5, step: 0.01 },
    turbulence: { type: 'number', default: 0.6, min: 0, max: 2, step: 0.01 },
    temperature: {
      type: 'number',
      default: 1900,
      min: 1300,
      max: 2800,
      step: 10,
      label: 'temperature (K)',
    },
    size: { type: 'number', default: 1, min: 0.3, max: 4, step: 0.05 },
    stretch: { type: 'number', default: 1, min: 0, max: 4, step: 0.05, label: 'velocity stretch' },
    twinkle: { type: 'number', default: 0.45, min: 0, max: 1, step: 0.01 },
    intensity: { type: 'number', default: 4, min: 0, max: 16, step: 0.1 },
    pops: { type: 'number', default: 0.5, min: 0, max: 4, step: 0.05, label: 'pops / s' },
    torch: { type: 'number', default: 1, min: 0, max: 4, step: 0.05 },
    hover: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'torch on hover' },
    drive: { type: 'select', default: 'none', options: EXCITATIONS },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    campfire: {},
    'bonfire gust': {
      count: 7000,
      rise: 0.4,
      wind: 0.22,
      turbulence: 0.9,
      temperature: 2100,
      lifetime: 3.5,
      stretch: 1.6,
      pops: 1.5,
    },
    'quiet hearth': {
      count: 600,
      rise: 0.12,
      wind: 0,
      turbulence: 0.4,
      temperature: 1650,
      lifetime: 6,
      size: 1.3,
      pops: 0.2,
      source: 0.5,
    },
    'torch trail': {
      count: 400,
      source: 0.3,
      pops: 0,
      torch: 2.5,
      hover: 0.35,
      rise: 0.15,
      turbulence: 0.8,
    },
    'ember storm': {
      count: 40000,
      rise: 0.3,
      wind: 0.35,
      turbulence: 1.4,
      size: 0.8,
      intensity: 3,
      lifetime: 5,
      pops: 2,
    },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'embers' });
    const camera = createUniformBuffer(device, CameraUniform, 'embers camera');
    const pointer = createPointerIgnition(canvas, { radius: 0.02, strength: 1 });
    const pops = createAmbientIgnition({ rate: params.pops, region: [0.1, 0.92, 0.9, 1], seed: 7 });
    let drive: Excitation = createExcitation(params.drive, canvas);

    interface Sim {
      capacity: number;
      system: ParticleSystem;
      renderer: ParticleRenderer;
      line: Emitter;
      pop: Emitter;
      torches: Emitter[];
      warm: boolean;
    }
    let sim: Sim | undefined;
    let width = 1;
    let height = 1;
    // Fractions of an ember the torch owes, per torch emitter, so a slow stroke still sheds some.
    const torchCarry: number[] = [];

    function build(capacity: number): Sim {
      const system = createParticleSystem({
        device,
        capacity,
        dimension: 2,
        fixedStep: 1 / 60,
        maxSteps: 4,
        profiler,
        label: 'embers',
        seed: 3,
      });
      const line = system.addEmitter({ shape: 'segment', direction: [0, 1, 0] });
      const pop = system.addEmitter({ direction: [0, 1, 0], spread: 0.9 });
      const torches = Array.from({ length: TORCH_EMITTERS }, () =>
        system.addEmitter({ shape: 'segment', direction: [0, 1, 0], spread: Math.PI }),
      );
      const renderer = createParticleRenderer(system, {
        camera: camera.buffer,
        format: tail.scene.format,
        profiler,
      });
      return { capacity, system, renderer, line, pop, torches, warm: false };
    }

    /** Settings that follow the parameters; `level` is the drive. */
    function sync(s: Sim, level: number): void {
      const aspect = width / height;
      const t0 = params.temperature;
      const physics = emberPhysics(params, level);
      const { system } = s;
      system.heat.cooling = 'newton';
      system.heat.rate = physics.cooling;
      system.heat.ambient = AMBIENT;
      system.heat.deathTemperature = DEATH_TEMPERATURE;
      const f = system.forces;
      f.buoyancy = physics.buoyancy;
      f.up = [0, 1, 0];
      f.gravity = [0, -0.02, 0];
      f.dragLinear = DRAG;
      f.wind = [params.wind, 0, 0];
      f.turbulence = params.turbulence > 0 ? '2d' : 'none';
      f.turbulenceStrength = params.turbulence * 0.45;
      f.turbulenceFrequency = 2.2;
      f.turbulenceEvolve = 0.25;
      f.turbulenceOctaves = 2;

      const life: [number, number] = [params.lifetime * 1.6, params.lifetime * 2];
      const size: [number, number] = [0.0011 * params.size, 0.0026 * params.size];
      const temperature: [number, number] = [t0 - 250, t0 + 250];
      const { line, pop, torches } = s;
      line.jumpTo([aspect / 2, -0.02, 0]);
      line.extent = [(params.source * aspect) / 2, 0, 0];
      line.spread = 0.5;
      line.speed = [params.rise * 0.5, params.rise * 1.5];
      line.life = life;
      line.size = size;
      line.temperature = temperature;
      line.rate = physics.rate;

      pop.speed = [params.rise * 1.5, params.rise * 4];
      pop.life = life;
      pop.size = [size[0] * 1.1, size[1] * 1.3];
      pop.temperature = [t0 + 100, t0 + 450];

      for (const torch of torches) {
        torch.speed = [0.02, 0.12];
        torch.inherit = 0.1;
        torch.life = life;
        torch.size = size;
        torch.temperature = [t0 + 150, t0 + 500];
      }

      const style = s.renderer.style;
      style.color = 'blackbody';
      style.intensity = params.intensity;
      style.tRef = 1800;
      style.gamma = 0.4;
      style.twinkle = params.twinkle;
      style.twinkleRate = 2.5;
      style.sizeCurve = [1, 1, 0.65, 0.25];
      style.fadeIn = 0.15;
      style.fadeOut = 0.1;
      const sprites = s.renderer.sprites.settings;
      sprites.shape = 'gaussian';
      sprites.minPixels = 0.8;
      sprites.stretch = params.stretch * 3;
      sprites.maxStretch = 4;
      sprites.stretchDim = 0.5;
      sprites.trail = 0.5;
      sprites.depth = 'none';
    }

    /** The torch: each run of drag segments becomes one segment emitter, burst by its length. */
    function torch(s: Sim, igniters: readonly Igniter[], dt: number): void {
      const aspect = width / height;
      const runs = chunks(igniters, TORCH_EMITTERS);
      runs.forEach((run, k) => {
        const emitter = s.torches[k]!;
        const first = run[0]!;
        const last = run[run.length - 1]!;
        const a = overlayPoint(first.fromX, first.fromY, aspect);
        const b = overlayPoint(last.toX, last.toY, aspect);
        let length = 0;
        let strength = 0;
        for (const seg of run) {
          length += Math.hypot((seg.toX - seg.fromX) * aspect, seg.toY - seg.fromY);
          strength = Math.max(strength, seg.strength);
        }
        emitter.jumpTo([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0]);
        emitter.extent = [(b[0] - a[0]) / 2, (b[1] - a[1]) / 2, 0];
        // About 30 a second for a held press, 260 per canvas height of stroke.
        const owed =
          (torchCarry[k] ?? 0) + params.torch * strength * ((30 * dt) / runs.length + 260 * length);
        const whole = Math.floor(owed);
        torchCarry[k] = owed - whole;
        emitter.burst(whole);
      });
    }

    return {
      resize(newWidth, newHeight) {
        width = newWidth;
        height = newHeight;
        tail.resize(width, height);
        setCameraUniform(camera, overlayCamera(width, height), width, height);
        camera.upload();
      },

      frame(time, encoder, target) {
        const delta = Math.min(Math.max(time.delta, 0), 0.25);
        if (drive.kind !== params.drive) {
          drive.destroy();
          drive = createExcitation(params.drive, canvas);
        }
        const level = drive.update(delta);

        // Room for the drive, the torch and the pops on top of the calm average.
        const capacity = emberCapacity(params.count);
        if (!sim || sim.capacity !== capacity) {
          sim?.renderer.destroy();
          sim?.system.destroy();
          sim = build(capacity);
        }
        sync(sim, level);
        if (!sim.warm) {
          // Start with a sky full of embers of every age, also for a still frame (reduced motion).
          sim.warm = true;
          sim.system.warmup(params.lifetime * 1.5);
        }

        pointer.hover = params.hover;
        const igniters = pointer.collect(delta);
        if (igniters.length > 0 && params.torch > 0) torch(sim, igniters, delta);
        pops.rate = params.pops * (1 + DRIVE_SHARE * level);
        pops.region = [0.5 - params.source / 2, 0.97, 0.5 + params.source / 2, 1];
        const [first] = pops.collect(delta);
        if (first) {
          sim.pop.jumpTo(overlayPoint(first.fromX, first.fromY, width / height));
          sim.pop.burst(12 + (Math.floor(first.fromX * 997) % 20));
        }

        sim.system.advance(encoder, time.delta);
        sim.renderer.encode(encoder, time.delta);
        sim.renderer.draw(encoder, {
          target: tail.scene.view,
          clear: { r: 0, g: 0, b: 0, a: 0 },
          timestampWrites: profiler.pass('embers sprites'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        sim?.renderer.destroy();
        sim?.system.destroy();
        pointer.destroy();
        pops.destroy();
        drive.destroy();
        camera.destroy();
        tail.destroy();
      },
    };
  },
});
