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
import { createPointerIgnition, type Igniter } from '../../gpu/sim/ignition.ts';
import { createUniformBuffer } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import {
  AMBIENT,
  baseShape,
  BASES,
  breath,
  COLD_TEMPERATURE,
  DRAG,
  EMBER_LIFT,
  flameCapacity,
  flamePhysics,
} from './flame.ts';
import hooks from './hooks.wgsl';
import { meta } from './meta.ts';
import shade from './shade.wgsl';

// Story 7.4: the particle-system fire of Reeves (1983) and every game since, on the GPU particle
// framework (src/gpu/particles/), in the 2D overlay space (canvas heights, origin bottom-left).
//
//   - A base (a log line, a torch head, a wick, a long line) emits large soft sprites, hot. Each is
//     lifted by buoyancy in proportion to how much hotter than the air it is, held back by drag
//     towards the wind, pushed about by 2D curl noise, and pulled towards the base's axis by a spring
//     (hook_force) so the flame tapers to a tip. The wind carries the axis with it, so the flame leans.
//   - Temperature cools exactly (Newton, hook_update) so the mean particle ends its life a dim red;
//     colour is ramp_fire of that temperature (or the black body), size shrinks over life, and the
//     overlapping additive sprites add up to the flame body: dense and white-yellow low down, thin and
//     orange-red at the tips.
//   - A flame particle that burns out sometimes throws off an ember (hook_die, ps_spawn: GPU spawning,
//     no CPU round trip), which keeps a little of the lift and cools slowly.
//   - The pointer is an igniter (createPointerIgnition): a press lights a fire there, a drag spreads it
//     along the stroke, and after release it dies down over a second.
//   - The drive (scroll or audio) adds up to half of the calm emission; the base breathes slowly
//     (two sines under 1 Hz, 10%), never faster.

/** Pointer fires burning at once (each takes an emitter). */
const POINTER_FIRES = 3;
/** Seconds a pointer fire takes to die down to 1/e after release. */
const POINTER_FADE = 0.6;
const KIND = { flame: 0, ember: 1, pointer: 2 } as const;
const PALETTES = ['fire ramp', 'black body'] as const;

/** Splits a list of igniters into at most `parts` runs of consecutive segments. */
function runs(igniters: readonly Igniter[], parts: number): Igniter[][] {
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
    base: { type: 'select', default: 'campfire', options: BASES },
    count: {
      type: 'number',
      default: 2500,
      min: 50,
      max: 40000,
      step: 50,
      label: 'flame particles (average alive)',
    },
    height: { type: 'number', default: 1, min: 0.3, max: 2, step: 0.01 },
    width: { type: 'number', default: 1, min: 0.2, max: 3, step: 0.01, label: 'base width' },
    size: { type: 'number', default: 1, min: 0.3, max: 3, step: 0.01, label: 'sprite size' },
    life: { type: 'number', default: 1, min: 0.4, max: 2, step: 0.01, label: 'life (x base)' },
    taper: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    turbulence: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    wind: { type: 'number', default: 0, min: -0.6, max: 0.6, step: 0.01 },
    temperature: {
      type: 'number',
      default: 1900,
      min: 1300,
      max: 2600,
      step: 10,
      label: 'birth temperature (K)',
    },
    palette: { type: 'select', default: 'fire ramp', options: PALETTES, label: 'colour' },
    intensity: { type: 'number', default: 1, min: 0, max: 4, step: 0.01 },
    stretch: {
      type: 'number',
      default: 0.8,
      min: 0,
      max: 3,
      step: 0.01,
      label: 'velocity stretch',
    },
    embers: { type: 'number', default: 6, min: 0, max: 60, step: 0.5, label: 'embers / s' },
    igniter: { type: 'number', default: 1, min: 0, max: 3, step: 0.01, label: 'pointer fire' },
    drive: { type: 'select', default: 'none', options: EXCITATIONS },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    campfire: {},
    torch: { base: 'torch', count: 900, embers: 3 },
    candle: {
      base: 'candle',
      count: 350,
      turbulence: 0.6,
      embers: 0,
      intensity: 1.2,
      stretch: 1.2,
      temperature: 2000,
    },
    'line of fire': { base: 'line', count: 5000, embers: 12 },
    'windy brazier': {
      base: 'campfire',
      width: 0.7,
      count: 1800,
      wind: 0.35,
      turbulence: 1.4,
      embers: 14,
    },
    'black body': { palette: 'black body', intensity: 1.6 },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'particle-flame' });
    const camera = createUniformBuffer(device, CameraUniform, 'particle-flame camera');
    const pointer = createPointerIgnition(canvas, { radius: 0.02, strength: 1 });
    let drive: Excitation = createExcitation(params.drive, canvas);

    interface Sim {
      capacity: number;
      system: ParticleSystem;
      renderer: ParticleRenderer;
      base: Emitter;
      fires: Emitter[];
      warm: boolean;
    }
    let sim: Sim | undefined;
    let width = 1;
    let height = 1;
    let clock = 0;
    /** How strongly each pointer fire burns, 1 while pressed, fading after. */
    const fireLevel = new Array<number>(POINTER_FIRES).fill(0);

    function build(capacity: number): Sim {
      const system = createParticleSystem({
        device,
        capacity,
        dimension: 2,
        fixedStep: 1 / 60,
        maxSteps: 4,
        userData: true,
        queueCapacity: 512,
        hooks: { code: hooks.code, chunks: hooks.chunks },
        profiler,
        label: 'particle-flame',
        seed: 5,
      });
      const base = system.addEmitter({ shape: 'segment', kind: KIND.flame });
      // The ember template (second, `PF_EMBER_TEMPLATE` in hooks.wgsl): rate 0, born from dying flame tips on the GPU.
      system.addEmitter({
        spread: Math.PI,
        speed: [0.04, 0.22],
        inherit: 0.7,
        life: [1.6, 3.2],
        temperature: [1900, 2300],
        size: [0.0016, 0.0032],
        kind: KIND.ember,
      });
      const fires = Array.from({ length: POINTER_FIRES }, () =>
        system.addEmitter({ shape: 'segment', kind: KIND.pointer, direction: [0, 1, 0] }),
      );
      const renderer = createParticleRenderer(system, {
        camera: camera.buffer,
        format: tail.scene.format,
        shade: { label: shade.label, code: shade.code, chunks: shade.chunks },
        profiler,
      });
      return { capacity, system, renderer, base, fires, warm: false };
    }

    /** Settings that follow the parameters; `level` is the drive. */
    function sync(s: Sim, level: number): void {
      const aspect = width / height;
      const shape = baseShape(params.base, aspect, params.width);
      const life = shape.life * params.life;
      const physics = flamePhysics(
        {
          count: params.count,
          life,
          height: shape.height * params.height,
          temperature: params.temperature,
        },
        level,
      );
      const { system } = s;
      system.heat.cooling = 'none';
      system.heat.ambient = AMBIENT;
      system.heat.deathTemperature = 0;
      const f = system.forces;
      f.buoyancy = physics.buoyancy;
      f.up = [0, 1, 0];
      f.gravity = [0, 0, 0];
      f.dragLinear = DRAG;
      f.wind = [params.wind, 0, 0];
      // Turbulence is the hooks' own rising curl noise (hook_force), not the framework's static one.
      f.turbulence = 'none';

      // Embers: params.embers a second out of `rate` flame particles a second dying.
      const emberChance = physics.rate > 0 ? Math.min(1, params.embers / physics.rate) : 0;
      system.params.user[0] = [shape.converge * params.taper, emberChance, physics.cooling, 0.45];
      const flameHeight = shape.height * params.height;
      system.params.user[1] = [EMBER_LIFT, shape.local, shape.half, 700];
      system.params.user[2] = [
        (0.8 * flameHeight) / life,
        shape.frequency,
        shape.turbulence * params.turbulence,
        flameHeight,
      ];
      system.params.user[3] = [0.6, 0, 0, 0];

      const t0 = params.temperature;
      const temperature: [number, number] = [t0 - 120, t0 + 120];
      const size: [number, number] = [shape.size[0] * params.size, shape.size[1] * params.size];
      const lifeRange: [number, number] = [life * 0.7, life * 1.3];
      const { base, fires } = s;
      base.shape = shape.shape;
      base.jumpTo([shape.x * aspect, shape.y, 0]);
      base.extent = [shape.half, 0.012, 0];
      base.radius = shape.half;
      base.innerRadius = 0;
      base.direction = [0, 1, 0];
      base.spread = 0.35;
      base.speed = shape.speed;
      base.life = lifeRange;
      base.size = size;
      base.temperature = temperature;
      base.rate = physics.rate * breath(clock, 0.1);

      for (const fire of fires) {
        fire.spread = 0.35;
        fire.speed = shape.speed;
        fire.inherit = 0.05;
        fire.life = [lifeRange[0] * 0.8, lifeRange[1] * 0.8];
        fire.size = [size[0] * 0.8, size[1] * 0.8];
        fire.temperature = temperature;
      }

      const style = s.renderer.style;
      style.color = 'tint';
      style.tint = [1, 1, 1];
      style.intensity = 1;
      style.twinkle = 0.25;
      style.twinkleRate = 3;
      // Grow a little after birth, then shrink to a third at the tip.
      style.sizeCurve = [0.75, 1, 0.3, 0.2];
      style.fadeIn = 0.12;
      style.fadeOut = 0.35;
      const palette = params.palette === 'black body' ? 1 : 0;
      // Sprites overlap more when they are many or large and the flame is small: keep the body's
      // brightness about the same whatever the count, size and height.
      const overlap = Math.sqrt(2500 / Math.max(50, params.count));
      style.user[0] = [t0 + 100, COLD_TEMPERATURE, palette, 0.55 * params.intensity * overlap];
      style.user[1] = [3.5 * params.intensity, 0, 0, 0];
      const sprites = s.renderer.sprites.settings;
      sprites.shape = 1;
      sprites.minPixels = 0.8;
      sprites.stretch = params.stretch;
      sprites.maxStretch = 3;
      sprites.stretchDim = 0.5;
      sprites.trail = 0.3;
      sprites.depth = 'none';
    }

    /** Pointer fires: each run of pressed segments becomes a segment emitter; released ones fade. */
    function ignite(s: Sim, igniters: readonly Igniter[], dt: number, rate: number): void {
      const aspect = width / height;
      const groups = params.igniter > 0 ? runs(igniters, POINTER_FIRES) : [];
      s.fires.forEach((fire, k) => {
        const run = groups[k];
        if (run && run.length > 0) {
          const first = run[0]!;
          const last = run[run.length - 1]!;
          const a = overlayPoint(first.fromX, first.fromY, aspect);
          const b = overlayPoint(last.toX, last.toY, aspect);
          if (fireLevel[k]! < 0.05) fire.jumpTo([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0]);
          else fire.moveTo([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0]);
          fire.extent = [(b[0] - a[0]) / 2, (b[1] - a[1]) / 2, 0];
          fireLevel[k] = 1;
        } else {
          fireLevel[k] = fireLevel[k]! * Math.exp(-dt / POINTER_FADE);
          fire.extent = [0, 0, 0];
        }
        const level = fireLevel[k]!;
        fire.rate = level > 0.02 ? rate * 0.45 * params.igniter * level : 0;
      });
    }

    return {
      /** The particle system, for tests and tools. */
      get system() {
        return sim?.system;
      },
      resize(newWidth, newHeight) {
        width = newWidth;
        height = newHeight;
        tail.resize(width, height);
        setCameraUniform(camera, overlayCamera(width, height), width, height);
        camera.upload();
      },

      frame(time, encoder, target) {
        const delta = Math.min(Math.max(time.delta, 0), 0.25);
        clock += delta;
        if (drive.kind !== params.drive) {
          drive.destroy();
          drive = createExcitation(params.drive, canvas);
        }
        const level = drive.update(delta);

        const capacity = flameCapacity(params.count);
        if (!sim || sim.capacity !== capacity) {
          sim?.renderer.destroy();
          sim?.system.destroy();
          sim = build(capacity);
        }
        sync(sim, level);
        if (!sim.warm) {
          // Start burning, also for a still frame (reduced motion): two lives and a bit.
          sim.warm = true;
          sim.system.warmup(2.5 * baseShape(params.base, width / height).life * params.life);
        }
        ignite(sim, pointer.collect(delta), delta, sim.base.rate);

        sim.system.advance(encoder, time.delta);
        sim.renderer.encode(encoder, time.delta);
        sim.renderer.draw(encoder, {
          target: tail.scene.view,
          clear: { r: 0, g: 0, b: 0, a: 0 },
          timestampWrites: profiler.pass('flame sprites'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        sim?.renderer.destroy();
        sim?.system.destroy();
        pointer.destroy();
        drive.destroy();
        camera.destroy();
        tail.destroy();
      },
    };
  },
});
