import {
  createParticleRenderer,
  overlayCamera,
  overlayPoint,
  type ParticleRenderer,
} from '../../gpu/particles/index.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { CameraUniform, setCameraUniform } from '../../gpu/scene/camera.ts';
import { createExcitation, EXCITATIONS, type Excitation } from '../../gpu/sim/excitation.ts';
import { createAmbientIgnition, createPointerIgnition } from '../../gpu/sim/ignition.ts';
import { createUniformBuffer } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import {
  configureFireworks,
  createFireworksSystem,
  createLaunchSchedule,
  fireShell,
  launchVelocity,
  PALETTES,
  pickShell,
  seededRandom,
  SHELL_TYPES,
  type FireworksSystem,
  type Palette,
  type Shell,
  type ShellType,
} from './show.ts';

// Story 7.5: a firework show on the particle framework. The CPU only decides WHEN and WHERE a shell
// goes up (show.ts); everything after the launch (the tail, the break at the apogee, every star's
// direction, trails, crossette splits, crackle pops, glitter) happens on the GPU in hooks.wgsl.
//
//   - Ambient shows: createAmbientIgnition (a Poisson process on the simulation clock) picks break
//     points in the sky; each becomes a shell launched from below the bottom edge so it peaks there.
//   - The pointer (createPointerIgnition): a press launches a shell towards the pointer, and holding
//     it launches another every 0.8 s.
//   - Flash: every launch goes through a schedule that keeps breaks `spacing` seconds apart, stars
//     ramp up over `ramp` seconds instead of appearing at full brightness, and the break glow is
//     soft and small. notes.md has the measurements.
//   - The drive (scroll or audio) adds up to 60% more shells than the calm rate. Never speed.

const SHELLS = ['mix', ...SHELL_TYPES] as const;
const DRIVE_SHARE = 0.6;
const HOLD_REPEAT = 0.8;
const CAPACITY = 65536;
/** Where shells leave from: just below the bottom edge. */
const GROUND = -0.02;

export const effect = defineEffect({
  meta,
  params: {
    shell: { type: 'select', default: 'mix', options: SHELLS },
    palette: { type: 'select', default: 'salts', options: PALETTES },
    rate: { type: 'number', default: 0.6, min: 0, max: 4, step: 0.05, label: 'shells / s' },
    spacing: {
      type: 'number',
      default: 0.45,
      min: 0.1,
      max: 2,
      step: 0.05,
      label: 'min. seconds between breaks',
    },
    size: { type: 'number', default: 1, min: 0.5, max: 1.8, step: 0.05, label: 'burst size' },
    height: { type: 'number', default: 0.7, min: 0.4, max: 0.9, step: 0.01, label: 'break height' },
    gravity: { type: 'number', default: 0.55, min: 0.2, max: 1.2, step: 0.01 },
    trails: { type: 'number', default: 1, min: 0, max: 1, step: 0.05, label: 'trail density' },
    brightness: { type: 'number', default: 5, min: 0.5, max: 12, step: 0.1 },
    ramp: { type: 'number', default: 0.12, min: 0, max: 0.4, step: 0.01, label: 'ramp-up (s)' },
    glow: { type: 'number', default: 0.4, min: 0, max: 3, step: 0.05, label: 'break glow' },
    whiteness: {
      type: 'number',
      default: 0.05,
      min: 0,
      max: 0.6,
      step: 0.01,
      label: 'incandescent white',
    },
    haze: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.05, label: 'smoke haze' },
    stretch: { type: 'number', default: 1, min: 0, max: 3, step: 0.05, label: 'motion stretch' },
    drive: { type: 'select', default: 'none', options: EXCITATIONS },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    'evening show': {},
    'peonies and chrysanthemums': { shell: 'chrysanthemum', rate: 0.8, palette: 'salts' },
    'willow gold': { shell: 'willow', rate: 0.5, palette: 'gold', haze: 0.5, size: 1.2 },
    crossettes: { shell: 'crossette', rate: 0.7, palette: 'warm' },
    'crackle and glitter': { shell: 'crackle', rate: 0.7, palette: 'gold' },
    'rings and palms': { shell: 'ring', rate: 0.6, palette: 'cool' },
    finale: { rate: 3, spacing: 0.18, size: 1.1, haze: 0.6 },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'fireworks' });
    const camera = createUniformBuffer(device, CameraUniform, 'fireworks camera');
    const pointer = createPointerIgnition(canvas, { radius: 0.02 });
    // Break points: x across the middle 76%, y from 15% to 45% down the canvas (uv, top-left).
    const ambient = createAmbientIgnition({ rate: params.rate, seed: 11 });
    let drive: Excitation = createExcitation(params.drive, canvas);
    const random = seededRandom(1234);
    const schedule = createLaunchSchedule<{
      shell: Shell;
      from: [number, number];
      velocity: [number, number, number];
    }>(params.spacing);

    let sim: (FireworksSystem & { renderer: ParticleRenderer }) | undefined;
    let width = 1;
    let height = 1;
    let clock = 0;
    let warm = false;
    let inFlight = false;
    let wasPressed = false;
    let holdClock = 0;

    const aspect = () => width / height;

    function build(): FireworksSystem & { renderer: ParticleRenderer } {
      const made = createFireworksSystem(device, { capacity: CAPACITY, profiler });
      const renderer = createParticleRenderer(made.system, {
        camera: camera.buffer,
        format: tail.scene.format,
        profiler,
      });
      return { ...made, renderer };
    }

    function sync(s: FireworksSystem & { renderer: ParticleRenderer }): void {
      configureFireworks(s.system, {
        gravity: params.gravity,
        size: params.size,
        trails: params.trails,
        haze: params.haze * 8,
        glow: params.glow > 0,
      });
      const style = s.renderer.style;
      style.color = 'tint';
      style.tint = [1, 1, 1];
      style.intensity = 1;
      style.twinkle = 0;
      style.sizeCurve = [1, 1, 1, 0.5];
      style.fadeIn = 0;
      style.fadeOut = 0;
      style.user[0] = [params.brightness, params.ramp, params.brightness * 0.45, params.brightness];
      style.user[1] = [params.whiteness, params.glow, 0.04 * params.haze, 0];
      const sprites = s.renderer.sprites.settings;
      sprites.shape = 'gaussian';
      sprites.minPixels = 0.8;
      sprites.stretch = 9 * params.stretch;
      sprites.maxStretch = 7;
      sprites.stretchDim = 0.5;
      sprites.trail = 0.7;
      sprites.depth = 'none';
    }

    /** Plans a shell from below `x` (plus a little) to break at the overlay point `to`. */
    function plan(to: [number, number], type: ShellType | 'mix'): void {
      const shell = pickShell(type, params.palette as Palette, params.size, random);
      const from: [number, number] = [to[0] + (random() - 0.5) * 0.25, GROUND];
      const { velocity, rise } = launchVelocity(from, to, params.gravity, 1 / 60);
      schedule.request(clock, rise, { shell, from, velocity });
    }

    function warmStart(s: FireworksSystem & { renderer: ParticleRenderer }): void {
      // One shell already broken half a second ago, so the first frame (and a reduced-motion still)
      // shows a burst.
      const type = params.shell === 'mix' ? 'chrysanthemum' : (params.shell as ShellType);
      const shell = pickShell(type, params.palette as Palette, params.size, random);
      const to: [number, number] = [aspect() * 0.5, params.height];
      const from: [number, number] = [aspect() * 0.48, GROUND];
      const { velocity, rise } = launchVelocity(from, to, params.gravity, 1 / 60);
      fireShell(s.launcher, shell, from, velocity);
      s.system.warmup(rise + 0.5, 1 / 60);
      schedule.setLastBreak(clock - 0.5);
      // And the next one already on its way up.
      plan([aspect() * 0.3, params.height - 0.05], params.shell as ShellType | 'mix');
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
        if (!sim) sim = build();
        sync(sim);
        if (!warm) {
          warm = true;
          warmStart(sim);
        }
        clock += delta;
        schedule.spacing = params.spacing;

        // Ambient shells: each igniter is a break point.
        const h = params.height;
        ambient.rate = params.rate * (1 + DRIVE_SHARE * level);
        ambient.region = [0.12, 1 - Math.min(0.95, h + 0.15), 0.88, 1 - Math.max(0.3, h - 0.2)];
        for (const igniter of ambient.collect(delta)) {
          plan(
            overlayPoint(igniter.fromX, igniter.fromY, aspect()).slice(0, 2) as [number, number],
            params.shell as ShellType | 'mix',
          );
        }

        // The pointer: a press launches towards it, holding repeats.
        const igniters = pointer.collect(delta);
        const pressed = pointer.pressed > 0 || igniters.length > 0;
        const last = igniters[igniters.length - 1];
        if (last) {
          holdClock += delta;
          if (!wasPressed || holdClock >= HOLD_REPEAT) {
            holdClock = 0;
            const point = overlayPoint(last.toX, last.toY, aspect());
            plan([point[0], Math.max(0.15, point[1])], params.shell as ShellType | 'mix');
          }
        } else if (!pressed) {
          holdClock = 0;
        }
        wasPressed = pressed;

        // One launch per stepping frame: the launcher holds a burst until a step takes it.
        if (!inFlight) {
          const next = schedule.take(clock);
          if (next) {
            fireShell(sim.launcher, next.shell, next.from, next.velocity);
            inFlight = true;
          }
        }
        if (sim.system.advance(encoder, time.delta) > 0) inFlight = false;

        sim.renderer.encode(encoder, time.delta);
        sim.renderer.draw(encoder, {
          target: tail.scene.view,
          clear: { r: 0, g: 0, b: 0, a: 0 },
          timestampWrites: profiler.pass('fireworks sprites'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        sim?.renderer.destroy();
        sim?.system.destroy();
        pointer.destroy();
        ambient.destroy();
        drive.destroy();
        camera.destroy();
        tail.destroy();
      },
    };
  },
});
