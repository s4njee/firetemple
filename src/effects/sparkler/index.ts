import { overlayCamera } from '../../gpu/particles/index.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { CameraUniform, setCameraUniform } from '../../gpu/scene/camera.ts';
import { createExcitation, EXCITATIONS, type Excitation } from '../../gpu/sim/excitation.ts';
import { createPointerIgnition } from '../../gpu/sim/ignition.ts';
import { createSpriteRenderer, SPRITE_FLOATS, writeSprite } from '../../gpu/sprites.ts';
import { createUniformBuffer } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import {
  applySparkler,
  applySparklerLook,
  createSparklerRenderer,
  createSparklerSim,
  DEFAULT_SPARKLER,
  idlePath,
  sparklerCapacity,
  type SparklerSettings,
  type SparklerSim,
} from './sparkler.ts';

// Story 7.6: a hand-held sparkler on the particle framework (src/gpu/particles/). A very bright core
// at the tip throws hundreds to thousands of tiny sparks a second that live a tenth to four tenths of
// a second and fork mid-flight into two or three (hook_update + ps_spawn, hooks.wgsl), the branching
// look. The tip is a swept emitter (`moveTo`), so a fast swing leaves no gaps; the pointer is the
// hand, and when nobody holds it the tip traces a slow figure of eight. The core, its halo and an
// afterimage of the tip's path (light painting) are a handful of CPU-written sprites.

const DEGREES = Math.PI / 180;
/** Full drive (scroll or sound) raises the rate by this share of the calm rate. */
const DRIVE_SHARE = 0.6;
/** Seconds a pointer is held after it was last seen, then a second to drift back to the path. */
const POINTER_HOLD = 0.8;
const RETURN_SECONDS = 1.2;
/** Afterimage dots at most, and their spacing along the path (canvas heights). */
const TRAIL_MAX = 480;
const TRAIL_SPACING = 0.0018;

interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

export const effect = defineEffect({
  meta,
  params: {
    rate: { type: 'number', default: 1800, min: 0, max: 8000, step: 50, label: 'sparks / s' },
    speed: { type: 'number', default: 1, min: 0.1, max: 2, step: 0.01, label: 'speed (heights/s)' },
    life: { type: 'number', default: 0.25, min: 0.05, max: 1, step: 0.01, label: 'life (s)' },
    forks: { type: 'number', default: 0.55, min: 0, max: 1, step: 0.01, label: 'fork chance' },
    generations: { type: 'number', default: 2, min: 0, max: 3, step: 1 },
    fan: { type: 'number', default: 36, min: 5, max: 80, step: 1, label: 'fork angle (degrees)' },
    gravity: { type: 'number', default: 0.5, min: 0, max: 3, step: 0.01 },
    drag: { type: 'number', default: 1.6, min: 0, max: 8, step: 0.05, label: 'drag (1/s)' },
    temperature: {
      type: 'number',
      default: 3100,
      min: 1800,
      max: 3600,
      step: 10,
      label: 'temperature (K)',
    },
    size: { type: 'number', default: 1, min: 0.3, max: 4, step: 0.05 },
    shutter: {
      type: 'number',
      default: 60,
      min: 0,
      max: 120,
      step: 1,
      label: 'streak (exposure ms)',
    },
    intensity: { type: 'number', default: 3, min: 0, max: 20, step: 0.1 },
    core: { type: 'number', default: 1, min: 0, max: 3, step: 0.01, label: 'core brightness' },
    afterimage: { type: 'number', default: 0.7, min: 0, max: 2, step: 0.01 },
    trail: { type: 'number', default: 0.6, min: 0.05, max: 2, step: 0.05, label: 'afterimage (s)' },
    pathSize: {
      type: 'number',
      default: 0.55,
      min: 0.1,
      max: 0.95,
      step: 0.01,
      label: 'idle figure size',
    },
    period: { type: 'number', default: 7, min: 2, max: 20, step: 0.1, label: 'idle figure (s)' },
    follow: { type: 'boolean', default: true, label: 'follow pointer' },
    drive: { type: 'select', default: 'none', options: EXCITATIONS },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    'hand-held': {},
    'light painting': {
      rate: 1100,
      afterimage: 0.9,
      trail: 1.6,
      period: 4.5,
      pathSize: 0.7,
      core: 0.8,
    },
    'golden shower': {
      rate: 4500,
      speed: 0.55,
      life: 0.32,
      forks: 0.35,
      generations: 1,
      gravity: 1.2,
      temperature: 2600,
      intensity: 2.6,
      afterimage: 0.2,
    },
    'branching stars': {
      rate: 500,
      speed: 1.1,
      life: 0.35,
      forks: 0.95,
      generations: 3,
      fan: 45,
      drag: 3,
      intensity: 5,
      afterimage: 0.25,
    },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'sparkler' });
    const camera = createUniformBuffer(device, CameraUniform, 'sparkler camera');
    // The core, its halo and the afterimage: a few hundred sprites written on the CPU.
    const glow = createSpriteRenderer(device, {
      capacity: TRAIL_MAX + 2,
      camera: camera.buffer,
      format: tail.scene.format,
      label: 'sparkler core',
    });
    glow.settings.shape = 'gaussian';
    glow.settings.depth = 'none';
    glow.settings.minPixels = 0.8;
    const glowData = new Float32Array((TRAIL_MAX + 2) * SPRITE_FLOATS);

    // The hand: hovering moves it, a press or a touch drag too. No capture: a page must scroll.
    const pointer = createPointerIgnition(canvas, { hover: 1, capture: false, radius: 0.02 });
    let drive: Excitation = createExcitation(params.drive, canvas);

    interface Sim {
      capacity: number;
      sim: SparklerSim;
      renderer: ReturnType<typeof createSparklerRenderer>;
      warm: boolean;
    }
    let current: Sim | undefined;
    let width = 1;
    let height = 1;
    let clock = 0;
    let pointerAt: [number, number] | undefined;
    let pointerAge = Infinity;
    const history: TrailPoint[] = [];

    function settings(level: number): SparklerSettings {
      const t = params.temperature;
      return {
        ...DEFAULT_SPARKLER,
        rate: params.rate * (1 + DRIVE_SHARE * level),
        speed: [params.speed * 0.5, params.speed * 1.5],
        life: [params.life * 0.4, params.life * 1.6],
        temperature: [t - 300, t + 200],
        size: [0.0011 * params.size, 0.0019 * params.size],
        radius: 0.004 * Math.sqrt(params.size),
        gravity: params.gravity,
        drag: params.drag,
        forkChance: params.forks,
        generations: params.generations,
        fan: params.fan * DEGREES,
      };
    }

    /** The tip: the pointer while it is here, then back along a blend to the idle figure. */
    function tipPosition(): [number, number] {
      const aspect = width / height;
      // Across most of a wide band, within a portrait canvas, never taller than it.
      const size: [number, number] = [params.pathSize * aspect * 0.7, params.pathSize * 0.6];
      const path = idlePath(clock, [aspect / 2, 0.52], size, params.period);
      if (!params.follow || !pointerAt) return path;
      const w = Math.min(1, Math.max(0, (pointerAge - POINTER_HOLD) / RETURN_SECONDS));
      const s = w * w * (3 - 2 * w);
      return [
        pointerAt[0] + (path[0] - pointerAt[0]) * s,
        pointerAt[1] + (path[1] - pointerAt[1]) * s,
      ];
    }

    /** Core, halo and afterimage dots, newest first; returns the sprite count. */
    function writeGlow(tip: [number, number]): number {
      const level = params.core;
      writeSprite(glowData, 0, {
        position: [tip[0], tip[1], 0],
        size: 0.0055 * Math.sqrt(params.size),
        color: [34 * level, 30 * level, 24 * level],
      });
      writeSprite(glowData, 1, {
        position: [tip[0], tip[1], 0],
        size: 0.03 * Math.sqrt(params.size),
        color: [0.9 * level, 0.55 * level, 0.22 * level],
      });
      let count = 2;
      const strength = params.afterimage;
      if (strength <= 0 || history.length < 2) return count;
      // Walk the path from the tip backwards, a dot every TRAIL_SPACING (wider if it is long).
      let total = 0;
      for (let k = history.length - 1; k > 0; k--) {
        total += Math.hypot(history[k]!.x - history[k - 1]!.x, history[k]!.y - history[k - 1]!.y);
      }
      const spacing = Math.max(TRAIL_SPACING, total / TRAIL_MAX);
      const dim = TRAIL_SPACING / spacing;
      let carry = spacing;
      for (let k = history.length - 1; k > 0 && count < TRAIL_MAX + 2; k--) {
        const a = history[k]!;
        const b = history[k - 1]!;
        const length = Math.hypot(a.x - b.x, a.y - b.y);
        while (carry <= length && count < TRAIL_MAX + 2) {
          const u = length > 0 ? carry / length : 0;
          const x = a.x + (b.x - a.x) * u;
          const y = a.y + (b.y - a.y) * u;
          const age = clock - (a.t + (b.t - a.t) * u);
          const fade = Math.max(0, 1 - age / params.trail);
          const w = strength * fade * Math.sqrt(fade) * dim;
          writeSprite(glowData, count++, {
            position: [x, y, 0],
            size: 0.0024 * Math.sqrt(params.size) * (1 + 0.6 * (1 - fade)),
            color: [2.4 * w, 1.25 * w, 0.42 * w],
          });
          carry += spacing;
        }
        carry -= length;
      }
      return count;
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
        clock += delta;
        if (drive.kind !== params.drive) {
          drive.destroy();
          drive = createExcitation(params.drive, canvas);
        }
        const level = drive.update(delta);
        const aspect = width / height;

        const igniters = pointer.collect(delta);
        const last = igniters[igniters.length - 1];
        pointerAge += delta;
        if (last) {
          pointerAt = [last.toX * aspect, 1 - last.toY];
          pointerAge = 0;
        }

        const s = settings(level);
        // Sized for the highest drive, so a loud song never rebuilds the pool mid-swing.
        const capacity = sparklerCapacity({ ...s, rate: params.rate * (1 + DRIVE_SHARE) });
        if (!current || current.capacity !== capacity) {
          current?.renderer.destroy();
          current?.sim.system.destroy();
          const sim = createSparklerSim(device, { capacity, profiler });
          const renderer = createSparklerRenderer(sim, camera.buffer, tail.scene.format, profiler);
          current = { capacity, sim, renderer, warm: false };
        }
        const { sim, renderer } = current;
        applySparkler(sim, s);
        applySparklerLook(renderer, {
          intensity: params.intensity,
          shutter: params.shutter / 1000,
          size: 0.0015 * params.size,
        });

        const tip = tipPosition();
        if (!current.warm) {
          // Burning from the first frame, also for a still frame under reduced motion.
          current.warm = true;
          sim.tip.jumpTo([tip[0], tip[1], 0]);
          sim.system.warmup(0.5);
          history.length = 0;
        }
        sim.tip.moveTo([tip[0], tip[1], 0]);
        history.push({ x: tip[0], y: tip[1], t: clock });
        while (history.length > 2 && clock - history[1]!.t > params.trail) history.shift();

        sim.system.advance(encoder, time.delta);
        renderer.encode(encoder, time.delta);
        renderer.draw(encoder, {
          target: tail.scene.view,
          clear: { r: 0, g: 0, b: 0, a: 0 },
          timestampWrites: profiler.pass('sparkler sparks'),
        });
        const count = writeGlow(tip);
        glow.update(glowData, count);
        glow.draw(encoder, {
          target: tail.scene.view,
          label: 'sparkler core',
          timestampWrites: profiler.pass('sparkler core'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        current?.renderer.destroy();
        current?.sim.system.destroy();
        glow.destroy();
        pointer.destroy();
        drive.destroy();
        camera.destroy();
        tail.destroy();
      },
    };
  },
});
