import { describe, expect, it, vi } from 'vitest';
import {
  overlayCamera,
  type ParticleSnapshot,
  type ParticleSystem,
} from '../src/gpu/particles/index.ts';
import { CameraUniform, setCameraUniform } from '../src/gpu/scene/camera.ts';
import { createUniformBuffer } from '../src/gpu/uniforms.ts';
import {
  applyShower,
  applyShowerLook,
  boxFromRect,
  createShowerRenderer,
  createShowerSim,
  DEFAULT_SHOWER,
  FLOOR_Y,
  setShowerColliders,
  type ShowerSettings,
} from '../src/effects/spark-shower/shower.ts';
import {
  applySparkler,
  createSparklerSim,
  DEFAULT_SPARKLER,
  expectedSparklerAlive,
  idlePath,
  sparkLifeFactor,
  type SparklerSettings,
} from '../src/effects/sparkler/sparkler.ts';
import { expectValid, getTestDevice, readTexture } from './gpu.ts';
import { mountHeadless, sendPointer } from './headless.ts';

// Stories 7.3 (spark shower) and 7.6 (sparkler) on the particle framework. The particle systems are
// the effects' own (shower.ts, sparkler.ts, with their hooks), driven directly with small pools and
// tens of steps: a bounce keeps the restitution's share of the speed and never ends below the floor,
// a split makes exactly the configured cooler children and cannot cascade, streaks grow with speed;
// a fast sparkler leaves no gaps, its sparks fork into shorter-lived children, and the live count
// follows Little's law.

vi.setConfig({ testTimeout: 60_000 });

interface Live {
  position: [number, number];
  velocity: [number, number];
  age: number;
  life: number;
  temperature: number;
  size: number;
  kind: number;
  user?: [number, number, number, number];
}

function live(snapshot: ParticleSnapshot): Live[] {
  const bits = new Uint32Array(snapshot.attributes.buffer);
  return Array.from(snapshot.alive, (slot) => {
    const o = slot * 4;
    const p = snapshot.positions;
    const v = snapshot.velocities;
    const a = snapshot.attributes;
    const u = snapshot.user;
    return {
      position: [p[o]!, p[o + 1]!],
      velocity: [v[o]!, v[o + 1]!],
      age: p[o + 3]!,
      life: v[o + 3]!,
      temperature: a[o]!,
      size: a[o + 1]!,
      kind: bits[o + 3]!,
      user: u ? [u[o]!, u[o + 1]!, u[o + 2]!, u[o + 3]!] : undefined,
    };
  });
}

/** Lit pixels (red over `threshold`) of a W x H frame inside the uv box [x0, x1] x [y0, y1]. */
function litIn(
  pixels: Uint8Array,
  W: number,
  H: number,
  box: readonly [number, number, number, number],
  threshold = 60,
): number {
  let n = 0;
  for (let y = Math.floor(box[2] * H); y < Math.ceil(box[3] * H); y++) {
    for (let x = Math.floor(box[0] * W); x < Math.ceil(box[1] * W); x++) {
      if (pixels[(y * W + x) * 4]! > threshold) n++;
    }
  }
  return n;
}

/** Runs `steps` fixed steps in submits of at most 16 and waits for the GPU. */
async function run(system: ParticleSystem, steps: number): Promise<void> {
  for (let done = 0; done < steps;) {
    const n = Math.min(16, steps - done);
    const encoder = system.device.createCommandEncoder();
    system.step(encoder, n);
    system.device.queue.submit([encoder.finish()]);
    done += n;
  }
  await system.device.queue.onSubmittedWorkDone();
}

/** A shower with no source, no drag and no cooling: one controlled drop at a time. */
function calm(overrides: Partial<ShowerSettings>): ShowerSettings {
  return {
    ...DEFAULT_SHOWER,
    rate: 0,
    dragLinear: 0,
    dragQuadratic: 0,
    cooling: 0,
    deathTemperature: 0,
    life: [20, 20],
    temperature: [2800, 2800],
    spread: 0,
    ...overrides,
  };
}

describe('spark shower', () => {
  it('bounces off the floor and a card with the restitution’s share of the speed, never below them', async () => {
    const device = await getTestDevice();
    const sim = createShowerSim(device, { capacity: 64 });
    const s = calm({ gravity: 2.4, generations: 0, speed: [0.8, 0.8], aim: -Math.PI / 2 });
    applyShower(sim, s);
    // A card (canvas uv) whose top is at y = 0.3 in overlay space, under the second spark.
    const card = boxFromRect({ x: 0.5, y: 0.7, width: 0.2, height: 0.1 }, 1);
    setShowerColliders(sim, { boxes: [card], restitution: s.restitution, friction: 0 });
    sim.source.jumpTo([0.2, 0.5, 0]);
    sim.source.burst(1);
    sim.hammer.direction = [0, -1, 0];
    sim.hammer.spread = 0;
    sim.hammer.speed = [0.8, 0.8];
    sim.hammer.jumpTo([0.6, 0.5, 0]);
    sim.hammer.burst(1);

    const dt = sim.system.params.fixedStep;
    const tracks: Live[][] = [];
    await expectValid(device, async () => {
      for (let k = 0; k < 90; k++) {
        await run(sim.system, 1);
        const particles = live(await sim.system.read());
        tracks.push(particles.sort((a, b) => a.position[0] - b.position[0]));
      }
    });
    const ratios: number[][] = [[], []];
    for (let k = 1; k < tracks.length; k++) {
      for (const which of [0, 1]) {
        const before = tracks[k - 1]![which]!;
        const after = tracks[k]![which]!;
        const ground = which === 0 ? FLOOR_Y : 0.3;
        // Never below the surface, at any step.
        expect(after.position[1]).toBeGreaterThanOrEqual(ground - 1e-6);
        // A bounce: falling before, rising after. Gravity acts first in the step, then the contact.
        if (before.velocity[1] < 0 && after.velocity[1] > 0) {
          ratios[which]!.push(after.velocity[1] / -(before.velocity[1] - s.gravity * dt));
        }
      }
    }
    for (const list of ratios) {
      expect(list.length).toBeGreaterThanOrEqual(2);
      for (const ratio of list) expect(ratio).toBeCloseTo(s.restitution, 4);
    }
    sim.system.destroy();
  });

  it('splits into exactly the configured cooler, smaller children, and never cascades', async () => {
    const device = await getTestDevice();
    const parents = 20;
    const children = 3;
    const t0 = 2800;
    const drop = async (generations: number) => {
      const sim = createShowerSim(device, { capacity: 4096, queueCapacity: 256 });
      const s = calm({
        gravity: 2.4,
        speed: [0.6, 0.6],
        aim: -Math.PI / 2,
        children,
        splitChance: 1,
        generations,
        minImpact: 0.2,
      });
      applyShower(sim, s);
      setShowerColliders(sim, { restitution: s.restitution, friction: s.friction });
      // Twenty sparks along a segment, falling straight down onto the floor together.
      sim.hammer.direction = [0, -1, 0];
      sim.hammer.spread = 0;
      sim.hammer.speed = [0.6, 0.6];
      sim.hammer.temperature = [t0, t0];
      sim.hammer.jumpTo([0.8, 0.4, 0]);
      sim.hammer.extent = [0.5, 0, 0];
      sim.hammer.burst(parents);
      return { sim, s };
    };

    // One generation: exactly parents x children, then nothing more however long it runs.
    const one = await drop(1);
    await expectValid(device, () => run(one.sim.system, 40));
    const after = live(await one.sim.system.read());
    expect(after.filter((p) => p.kind === 0)).toEqual([]);
    const kids = after.filter((p) => p.kind === 1);
    expect(kids.length).toBe(parents * children);
    expect((await one.sim.system.readStats()).spawned).toBe(parents * children);
    for (const kid of kids) {
      expect(kid.temperature).toBeCloseTo(t0 * one.s.childHeat, 1);
      expect(kid.temperature).toBeLessThan(t0);
      expect(kid.size).toBeLessThanOrEqual(one.s.size[1] * one.s.childSize + 1e-7);
      expect(kid.position[1]).toBeGreaterThanOrEqual(FLOOR_Y - 1e-6);
    }
    await run(one.sim.system, 240);
    expect((await one.sim.system.readStats()).spawned).toBe(parents * children);
    one.sim.system.destroy();

    // Two generations: bounded by parents x (children + children^2), and it stops growing.
    const two = await drop(2);
    await run(two.sim.system, 200);
    const settled = (await two.sim.system.readStats()).spawned;
    expect(settled).toBeGreaterThan(parents * children);
    expect(settled).toBeLessThanOrEqual(parents * (children + children * children));
    await run(two.sim.system, 300);
    const stats = await two.sim.system.readStats();
    expect(stats.spawned).toBe(settled);
    expect(stats.droppedSpawns).toBe(0);
    for (const p of live(await two.sim.system.read())) expect(p.kind).toBeLessThanOrEqual(2);
    two.sim.system.destroy();
  });

  it('draws a longer streak for a faster spark', async () => {
    const device = await getTestDevice();
    const W = 480;
    const H = 360;
    const camera = createUniformBuffer(device, CameraUniform, 'test camera');
    setCameraUniform(camera, overlayCamera(W, H), W, H);
    camera.upload();
    const streak = async (speed: number) => {
      const sim = createShowerSim(device, { capacity: 16 });
      applyShower(sim, calm({ gravity: 0, generations: 0, speed: [speed, speed], aim: 0 }));
      setShowerColliders(sim, { floor: false, restitution: 0.4, friction: 0 });
      sim.source.jumpTo([0.4, 0.5, 0]);
      sim.source.burst(1);
      await run(sim.system, 2);
      const renderer = createShowerRenderer(sim, camera.buffer, 'rgba8unorm');
      applyShowerLook(renderer, { intensity: 40, shutter: 0.045, size: 0.0021 });
      renderer.style.extrapolate = false;
      const target = device.createTexture({
        size: [W, H],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      const encoder = device.createCommandEncoder();
      renderer.encode(encoder, 0);
      renderer.draw(encoder, { target: target.createView(), clear: { r: 0, g: 0, b: 0, a: 0 } });
      device.queue.submit([encoder.finish()]);
      const pixels = await readTexture(device, target);
      let x0 = W;
      let x1 = -1;
      for (let i = 0; i < W * H; i++) {
        if (pixels[i * 4]! > 12) {
          x0 = Math.min(x0, i % W);
          x1 = Math.max(x1, i % W);
        }
      }
      target.destroy();
      renderer.destroy();
      sim.system.destroy();
      return x1 - x0 + 1;
    };
    const slow = await streak(0.4);
    const middle = await streak(1);
    const fast = await streak(2.4);
    expect(slow).toBeGreaterThanOrEqual(3);
    expect(middle).toBeGreaterThan(slow);
    expect(fast).toBeGreaterThan(middle);
    expect(fast).toBeGreaterThan(2.5 * slow);
    camera.destroy();
  });

  it('runs as an effect, and the grinder follows the pointer', async () => {
    const W = 320;
    const H = 180;
    const shower = await mountHeadless('spark-shower', { width: W, height: H });
    shower.step(2);
    // Started mid-shower: sparks from the default source (upper left) on the first frames.
    const before = await shower.read();
    expect(litIn(before, W, H, [0, 1, 0, 1])).toBeGreaterThan(150);
    // The pointer hovers in the upper right: the hot spot and the sparks' origin move there.
    const box = [0.72, 0.86, 0.08, 0.3] as const;
    const quiet = litIn(before, W, H, box);
    for (let k = 0; k < 20; k++) {
      sendPointer(shower.canvas, 'pointermove', 0.75, 0.15, k * 16);
      shower.step(1);
    }
    const after = await shower.read();
    expect(litIn(after, W, H, box)).toBeGreaterThan(quiet + 20);
    shower.destroy();
  });
});

describe('sparkler', () => {
  /** A sparkler whose sparks stand still where they were born and live long: a record of emission. */
  function still(overrides: Partial<SparklerSettings>): SparklerSettings {
    return {
      ...DEFAULT_SPARKLER,
      speed: [0, 0],
      radius: 0,
      inherit: 0,
      gravity: 0,
      drag: 0,
      cooling: 0,
      life: [20, 20],
      forkChance: 0,
      ...overrides,
    };
  }

  it('emits continuously along a fast path, with no gaps wider than the spark spacing', async () => {
    const device = await getTestDevice();
    const sim = createSparklerSim(device, { capacity: 4096 });
    const rate = 3000;
    const speed = 3; // canvas heights per second: 0.05 a step, 0.1 a frame at 30 fps
    applySparkler(sim, still({ rate }));
    const x0 = 0.2;
    sim.tip.jumpTo([x0, 0.5, 0]);
    const frames = 14;
    await expectValid(device, async () => {
      for (let f = 1; f <= frames; f++) {
        sim.tip.moveTo([x0 + (speed * f) / 30, 0.5, 0]);
        const encoder = device.createCommandEncoder();
        sim.system.advance(encoder, 1 / 30);
        device.queue.submit([encoder.finish()]);
      }
      await device.queue.onSubmittedWorkDone();
    });
    const xs = live(await sim.system.read())
      .map((p) => p.position[0])
      .sort((a, b) => a - b);
    const length = (speed * frames) / 30;
    const spacing = speed / rate;
    expect(xs.length).toBeGreaterThan(0.95 * rate * (frames / 30));
    expect(xs[0]!).toBeLessThan(x0 + 3 * spacing);
    expect(xs[xs.length - 1]!).toBeGreaterThan(x0 + length - 3 * spacing);
    let gap = 0;
    for (let k = 1; k < xs.length; k++) gap = Math.max(gap, xs[k]! - xs[k - 1]!);
    // Stratified births along the sweep: at most two spacings apart, nowhere near a step (0.05).
    expect(gap).toBeLessThanOrEqual(2.5 * spacing);
    expect(gap).toBeLessThan(speed / 60 / 10);
    sim.system.destroy();
  });

  it('forks sparks into two or three shorter-lived children, generation by generation', async () => {
    const device = await getTestDevice();
    const sim = createSparklerSim(device, { capacity: 8192, userData: true });
    const s: SparklerSettings = { ...DEFAULT_SPARKLER, rate: 1500, forkChance: 0.8 };
    applySparkler(sim, s);
    sim.tip.jumpTo([0.8, 0.5, 0]);
    await expectValid(device, () => run(sim.system, 45));
    const stats = await sim.system.readStats();
    const particles = live(await sim.system.read());
    const roots = particles.filter((p) => p.kind === 0);
    const kids = particles.filter((p) => p.kind > 0);
    expect(stats.spawned).toBeGreaterThan(200);
    expect(stats.droppedSpawns).toBe(0);
    expect(kids.length).toBeGreaterThan(50);
    for (const kid of kids) {
      expect(kid.kind).toBeLessThanOrEqual(s.generations);
      const [remaining, parentLife] = kid.user!;
      // Shorter-lived than its parent, and than what the parent had left.
      expect(kid.life).toBeLessThan(parentLife!);
      expect(kid.life).toBeLessThanOrEqual(remaining! * s.childLife[1] + 1e-5);
    }
    const mean = (list: Live[]) => list.reduce((sum, p) => sum + p.life, 0) / list.length;
    expect(mean(kids)).toBeLessThan(0.6 * mean(roots));
    sim.system.destroy();
  });

  it('keeps rate x mean life alive on average, with and without forks', async () => {
    const device = await getTestDevice();
    const average = async (s: SparklerSettings) => {
      const sim = createSparklerSim(device, { capacity: 8192 });
      applySparkler(sim, s);
      sim.tip.jumpTo([0.8, 0.5, 0]);
      await run(sim.system, 60);
      let sum = 0;
      const samples = 40;
      for (let k = 0; k < samples; k++) {
        await run(sim.system, 2);
        sum += (await sim.system.readStats()).alive;
      }
      sim.system.destroy();
      return sum / samples;
    };
    const plain: SparklerSettings = { ...DEFAULT_SPARKLER, rate: 2000, forkChance: 0 };
    expect(expectedSparklerAlive(plain)).toBeCloseTo(2000 * 0.25, 6);
    const measuredPlain = await average(plain);
    expect(Math.abs(measuredPlain / expectedSparklerAlive(plain) - 1)).toBeLessThan(0.05);

    const forked: SparklerSettings = { ...DEFAULT_SPARKLER, rate: 2000 };
    expect(sparkLifeFactor(forked)).toBeGreaterThan(1);
    const measuredForked = await average(forked);
    expect(Math.abs(measuredForked / expectedSparklerAlive(forked) - 1)).toBeLessThan(0.08);
  });

  it('traces a figure of eight when idle, and follows the pointer as an effect', async () => {
    const a = idlePath(0, [1, 0.5], [0.8, 0.4], 6);
    const b = idlePath(6, [1, 0.5], [0.8, 0.4], 6);
    expect(a[0]).toBeCloseTo(b[0], 5);
    expect(a[1]).toBeCloseTo(b[1], 5);
    const quarter = idlePath(1.5, [1, 0.5], [0.8, 0.4], 6);
    expect(quarter[0]).toBeCloseTo(1.4, 5);

    const W = 320;
    const H = 180;
    const sparkler = await mountHeadless('sparkler', { width: W, height: H });
    sparkler.step(2);
    expect(litIn(await sparkler.read(), W, H, [0, 1, 0, 1])).toBeGreaterThan(80);
    // The pointer is the hand: the burning tip goes where it is.
    const box = [0.08, 0.22, 0.65, 0.95] as const;
    const quiet = litIn(await sparkler.read(), W, H, box);
    for (let k = 0; k < 20; k++) {
      sendPointer(sparkler.canvas, 'pointermove', 0.15, 0.8, k * 16);
      sparkler.step(1);
    }
    expect(litIn(await sparkler.read(), W, H, box)).toBeGreaterThan(quiet + 40);
    sparkler.destroy();
  });
});
