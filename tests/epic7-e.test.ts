import { describe, expect, it, vi } from 'vitest';
import type { ParticleSnapshot, ParticleSystem } from '../src/gpu/particles/index.ts';
import {
  configureFireworks,
  createFireworksSystem,
  createLaunchSchedule,
  burstCount,
  CROSS_ARMS,
  decodeKind,
  fireShell,
  launchVelocity,
  ROLE,
  SHELL_TYPES,
  type FireworksSystem,
  type Shell,
} from '../src/effects/fireworks/show.ts';
import {
  createAccumulation,
  createRibbons,
  createTrailSystem,
  TRAIL_STEP,
  type Ribbons,
} from '../src/effects/particle-trails/trails.ts';
import { fromHalf } from '../src/gpu/emission/half-float.ts';
import { expectValid, getTestDevice, readTexture } from './gpu.ts';
import { mountHeadless, sendPointer } from './headless.ts';

// Epic 7, stories 7.5 (fireworks) and 7.7 (trails). The fireworks run their real hooks on the GPU
// with small pools and a few hundred steps; the trails check the history buffer and the
// accumulation decay with exact bookkeeping.

vi.setConfig({ testTimeout: 120_000 });

const DT = 1 / 60;

async function show(capacity = 4096): Promise<FireworksSystem> {
  const device = await getTestDevice();
  const made = createFireworksSystem(device, { capacity, queue: 2048 });
  configureFireworks(made.system, { gravity: 0.55, size: 1, trails: 0, haze: 0, glow: false });
  return made;
}

/** Runs `steps` steps (submits of at most 16) and waits for the GPU. */
async function run(system: ParticleSystem, steps: number): Promise<void> {
  for (let done = 0; done < steps;) {
    const n = Math.min(16, steps - done);
    const encoder = system.device.createCommandEncoder();
    system.step(encoder, n, DT);
    system.device.queue.submit([encoder.finish()]);
    done += n;
  }
  await system.device.queue.onSubmittedWorkDone();
}

interface Live {
  role: number;
  type: number;
  velocity: [number, number, number];
  position: [number, number, number];
}

function live(snapshot: ParticleSnapshot): Live[] {
  const bits = new Uint32Array(snapshot.attributes.buffer);
  return Array.from(snapshot.alive, (slot) => {
    const o = slot * 4;
    const { role, type } = decodeKind(bits[o + 3]!);
    const v = snapshot.velocities;
    const p = snapshot.positions;
    return {
      role,
      type,
      velocity: [v[o]!, v[o + 1]!, v[o + 2]!],
      position: [p[o]!, p[o + 1]!, p[o + 2]!],
    };
  });
}

const count = (particles: Live[], role: number) => particles.filter((p) => p.role === role).length;

/** Fires a shell straight up from (0.8, 0.3) with a short rise, so it breaks within a few steps. */
function launch(made: FireworksSystem, shell: Shell, rise = 0.1, x = 0.8): void {
  fireShell(made.launcher, shell, [x, 0.3], [0, rise, 0]);
}

/** Steps one at a time until the shell has broken; returns the snapshot of that very step. */
async function untilBreak(made: FireworksSystem): Promise<ParticleSnapshot> {
  for (let step = 0; step < 120; step++) {
    await run(made.system, 1);
    const snapshot = await made.system.read();
    if (live(snapshot).some((p) => p.role === ROLE.star)) return snapshot;
  }
  throw new Error('the shell never broke');
}

describe('fireworks', () => {
  it('launches a shell that peaks at the target point', () => {
    const { velocity, rise } = launchVelocity([0.3, -0.02], [0.9, 0.7], 0.55, DT);
    // Step the drag-free semi-implicit Euler the kernels use, up to the first non-rising step.
    let [x, y, vy] = [0.3, -0.02, velocity[1]];
    let steps = 0;
    while (vy > 0) {
      vy -= 0.55 * DT;
      x += velocity[0] * DT;
      y += vy * DT;
      steps++;
    }
    expect(Math.abs(y - 0.7)).toBeLessThan(0.01);
    expect(Math.abs(x - 0.9)).toBeLessThan(0.02);
    expect(Math.abs(steps * DT - rise)).toBeLessThan(2 * DT);
  });

  it('spaces breaks at least `spacing` apart and keeps their order', () => {
    const schedule = createLaunchSchedule<number>(0.5);
    const launches = [0, 1, 2, 3].map((k) => schedule.request(0, 1 + 0.1 * k, k));
    const breaks = launches.map((at, k) => at + 1 + 0.1 * k);
    for (let k = 1; k < breaks.length; k++) {
      expect(breaks[k]! - breaks[k - 1]!).toBeGreaterThanOrEqual(0.5 - 1e-9);
    }
    const order: number[] = [];
    for (let t = 0; t <= 3; t += 0.05) {
      for (let item = schedule.take(t); item !== undefined; item = schedule.take(t)) {
        order.push(item);
      }
    }
    expect(order.sort()).toEqual([0, 1, 2, 3]);
  });

  it('spawns exactly its burst count when a shell dies at its apogee', async () => {
    const made = await show();
    await expectValid(made.system.device, async () => {
      launch(made, { type: 'peony', salt: 'barium green', count: 37 });
      await run(made.system, 40);
      const particles = live(await made.system.read());
      expect(count(particles, ROLE.shell)).toBe(0);
      expect(count(particles, ROLE.star)).toBe(37);
      // A second shell of another size adds exactly its own.
      launch(made, { type: 'chrysanthemum', salt: 'strontium red', count: 81 });
      await run(made.system, 30);
      expect(count(live(await made.system.read()), ROLE.star)).toBe(37 + 81);
      const stats = await made.system.readStats();
      expect(stats.droppedSpawns).toBe(0);
      expect(stats.droppedEmits).toBe(0);
    });
    made.system.destroy();
  });

  it('splits each crossette star into four, once and only once', async () => {
    const made = await show();
    launch(made, { type: 'crossette', salt: 'sodium yellow', count: 16 });
    await untilBreak(made);
    const atBreak = await made.system.readStats();
    // Crossette stars live 0.54 to 0.66 s; their sub-stars 0.9 to 1.2 s.
    await run(made.system, 48);
    let particles = live(await made.system.read());
    expect(count(particles, ROLE.star) + count(particles, ROLE.sub) / CROSS_ARMS).toBe(16);
    await run(made.system, 30);
    particles = live(await made.system.read());
    expect(count(particles, ROLE.star)).toBe(0);
    expect(count(particles, ROLE.sub)).toBe(16 * CROSS_ARMS);
    const split = await made.system.readStats();
    expect(split.spawned - atBreak.spawned).toBe(16 * CROSS_ARMS);
    // The sub-stars die without children of their own.
    await run(made.system, 90);
    particles = live(await made.system.read());
    expect(count(particles, ROLE.sub)).toBe(0);
    const after = await made.system.readStats();
    expect(after.spawned).toBe(split.spawned);
    expect(after.alive).toBe(0);
    made.system.destroy();
  });

  it('breaks a peony into a sphere and a ring into a circle', async () => {
    // Peony: unit directions of a Fibonacci sphere under a random rotation.
    let made = await show();
    launch(made, { type: 'peony', salt: 'copper blue', count: 200 });
    let stars = live(await untilBreak(made)).filter((p) => p.role === ROLE.star);
    expect(stars).toHaveLength(200);
    const directions = stars.map((p) => {
      const s = Math.hypot(...p.velocity);
      return p.velocity.map((c) => c / s) as [number, number, number];
    });
    const mean = [0, 1, 2].map((k) => directions.reduce((sum, d) => sum + d[k]!, 0) / 200);
    // The shell's own velocity at its apogee is under one step of gravity: next to nothing.
    expect(Math.hypot(...mean)).toBeLessThan(0.05);
    for (let k = 0; k < 3; k++) {
      const second = directions.reduce((sum, d) => sum + d[k]! * d[k]!, 0) / 200;
      expect(Math.abs(second - 1 / 3)).toBeLessThan(0.04);
    }
    // Every octant of the sphere is used, about equally.
    const octants = new Array<number>(8).fill(0);
    for (const d of directions) {
      octants[(d[0] > 0 ? 1 : 0) + (d[1] > 0 ? 2 : 0) + (d[2] > 0 ? 4 : 0)]!++;
    }
    for (const n of octants) expect(n).toBeGreaterThan(200 / 8 / 2);
    made.system.destroy();

    // Ring: every star in one plane through the break, at one speed.
    made = await show();
    launch(made, { type: 'ring', salt: 'strontium red', count: 48 });
    stars = live(await untilBreak(made)).filter((p) => p.role === ROLE.star);
    expect(stars).toHaveLength(48);
    const centre = [0, 1, 2].map((k) => stars.reduce((sum, p) => sum + p.velocity[k]!, 0) / 48);
    const relative = stars.map((p) => p.velocity.map((c, k) => c - centre[k]!));
    const speeds = relative.map((v) => Math.hypot(...v));
    const speed = speeds.reduce((a, b) => a + b, 0) / 48;
    for (const s of speeds) expect(Math.abs(s / speed - 1)).toBeLessThan(1e-3);
    const [a, b] = [relative[0]!, relative[12]!];
    const axis = [
      a[1]! * b[2]! - a[2]! * b[1]!,
      a[2]! * b[0]! - a[0]! * b[2]!,
      a[0]! * b[1]! - a[1]! * b[0]!,
    ];
    const length = Math.hypot(...axis);
    for (const v of relative) {
      const out = (v[0]! * axis[0]! + v[1]! * axis[1]! + v[2]! * axis[2]!) / (length * speed);
      expect(Math.abs(out)).toBeLessThan(1e-3);
    }
    // The plane faces the viewer (within about 45 degrees of the view axis).
    expect(Math.abs(axis[2]!) / length).toBeGreaterThan(0.7);
    made.system.destroy();
  });

  it('sends a shell up to a press and breaks it there', async () => {
    const W = 320;
    const H = 180;
    const fireworks = await mountHeadless('fireworks', {
      width: W,
      height: H,
      params: { rate: 0, haze: 0, bloom: 0, glow: 0, shell: 'peony' },
    });
    fireworks.step(1);
    sendPointer(fireworks.canvas, 'pointerdown', 0.82, 0.3, 16);
    fireworks.step(1);
    sendPointer(fireworks.canvas, 'pointerup', 0.82, 0.3, 32);
    await fireworks.runTo(2.5);
    const pixels = await fireworks.read();
    // The warm-up shells broke in the middle and on the left; the right third is the press's.
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < W * H; i++) {
      const x = (i % W) / W;
      const y = Math.floor(i / W) / H;
      if (x > 0.62 && pixels[i * 4]! + pixels[i * 4 + 1]! + pixels[i * 4 + 2]! > 120) {
        n++;
        sx += x;
        sy += y;
      }
    }
    expect(n).toBeGreaterThan(30);
    expect(Math.abs(sx / n - 0.82)).toBeLessThan(0.06);
    expect(Math.abs(sy / n - 0.3)).toBeLessThan(0.1);
    fireworks.destroy();
  });

  it('leaks no particle through many shells of every type', async () => {
    const capacity = 6000;
    const made = await show(capacity);
    configureFireworks(made.system, { gravity: 0.55, size: 0.7, trails: 1, haze: 4, glow: true });
    const check = (snapshot: ParticleSnapshot) => {
      const { stats } = snapshot;
      expect(stats.alive + stats.dead).toBe(capacity);
      const all = [...snapshot.alive, ...snapshot.dead].sort((x, y) => x - y);
      expect(all).toEqual(Array.from({ length: capacity }, (_, i) => i));
    };
    await expectValid(made.system.device, async () => {
      for (const [k, type] of [...SHELL_TYPES, ...SHELL_TYPES].entries()) {
        launch(made, { type, salt: 'charcoal gold', count: 30 }, 0.15, 0.3 + 0.04 * k);
        await run(made.system, 12);
      }
      check(await made.system.read());
      // Long enough for the last willow ember and smoke puff to go.
      await run(made.system, 600);
      const end = await made.system.read();
      check(end);
      expect(end.stats.alive).toBe(0);
      expect(end.stats.emitted).toBe(end.stats.died);
      expect(end.stats.droppedSpawns).toBe(0);
    });
    made.system.destroy();
  });
});

// --- Trails ----------------------------------------------------------------------------------------

async function readBuffer(device: GPUDevice, buffer: GPUBuffer): Promise<ArrayBuffer> {
  const staging = device.createBuffer({
    size: buffer.size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const data = staging.getMappedRange().slice(0);
  staging.unmap();
  staging.destroy();
  return data;
}

/** One trail step: the particle step, then the ribbon record. */
async function trailSteps(system: ParticleSystem, ribbons: Ribbons, steps: number): Promise<void> {
  for (let k = 0; k < steps; k++) {
    const encoder = system.device.createCommandEncoder();
    system.step(encoder, 1);
    ribbons.record(encoder);
    system.device.queue.submit([encoder.finish()]);
  }
  await system.device.queue.onSubmittedWorkDone();
}

/** A slot's ribbon, newest point first: (x, y, temperature, age) per point. */
async function ribbonOf(ribbons: Ribbons, device: GPUDevice, slot: number): Promise<number[][]> {
  const heads = new Uint32Array(await readBuffer(device, ribbons.heads));
  const history = new Float32Array(await readBuffer(device, ribbons.history));
  const [head, count] = [heads[slot * 4]!, heads[slot * 4 + 1]!];
  const n = ribbons.points;
  return Array.from({ length: count }, (_, k) => {
    const at = (slot * n + ((head + n - k) % n)) * 4;
    return Array.from(history.subarray(at, at + 4));
  });
}

describe('particle trails', () => {
  it('fades the accumulation by the same amount over 1 s at 30, 60 and 144 Hz', async () => {
    const device = await getTestDevice();
    const tau = 0.4;
    const means: number[] = [];
    await expectValid(device, async () => {
      for (const hz of [30, 60, 144]) {
        const accumulation = createAccumulation(device);
        accumulation.resize(64, 32);
        let encoder = device.createCommandEncoder();
        encoder
          .beginRenderPass({
            colorAttachments: [
              {
                view: accumulation.view,
                loadOp: 'clear',
                clearValue: [1, 0.37, 0.05, 0],
                storeOp: 'store',
              },
            ],
          })
          .end();
        device.queue.submit([encoder.finish()]);
        let weights = 0;
        for (let frame = 0; frame < hz; frame++) {
          encoder = device.createCommandEncoder();
          weights += accumulation.decay(encoder, 1 / hz, tau);
          device.queue.submit([encoder.finish()]);
        }
        const halves = new Uint16Array(
          (await readTexture(device, accumulation.target.read.texture, 8)).buffer,
        );
        let red = 0;
        let green = 0;
        for (let i = 0; i < halves.length; i += 4) {
          red += fromHalf(halves[i]!);
          green += fromHalf(halves[i + 1]!);
        }
        const pixels = halves.length / 4;
        means.push(red / pixels);
        // Every channel fades by the same factor.
        expect(green / pixels / 0.37).toBeCloseTo(red / pixels, 2);
        // The deposit weights a frame rate hands out add up to the same light per second.
        expect(Math.abs(weights - hz * (1 - Math.exp(-1 / (hz * tau))))).toBeLessThan(1e-9);
        accumulation.destroy();
      }
    });
    const exact = Math.exp(-1 / tau);
    for (const mean of means) expect(Math.abs(mean / exact - 1)).toBeLessThan(0.01);
    expect(Math.abs(means[2]! / means[0]! - 1)).toBeLessThan(0.01);
  });

  it("keeps a ribbon's points as the particle's past positions, newest first", async () => {
    const device = await getTestDevice();
    const system = createTrailSystem(device, { capacity: 8 });
    system.forces.gravity = [0, -1.5, 0];
    const emitter = system.addEmitter({
      position: [0.2, 0.3, 0],
      direction: [0.6, 0.8, 0],
      speed: [0.5, 0.5],
      life: [10, 10],
      size: [0.01, 0.01],
    });
    const ribbons = createRibbons(system, { points: 8 });
    emitter.burst(1);
    const path: [number, number][] = [];
    let slot = -1;
    for (let k = 0; k < 13; k++) {
      await trailSteps(system, ribbons, 1);
      const snapshot = await system.read();
      expect(snapshot.alive).toHaveLength(1);
      slot = snapshot.alive[0]!;
      path.push([snapshot.positions[slot * 4]!, snapshot.positions[slot * 4 + 1]!]);
    }
    const ribbon = await ribbonOf(ribbons, device, slot);
    expect(ribbon).toHaveLength(8);
    ribbon.forEach((point, k) => {
      const [x, y] = path[path.length - 1 - k]!;
      expect(point[0]).toBeCloseTo(x, 5);
      expect(point[1]).toBeCloseTo(y, 5);
    });
    // Ages fall by one step per point, back in time.
    for (let k = 1; k < 8; k++)
      expect(ribbon[k - 1]![3]! - ribbon[k]![3]!).toBeCloseTo(TRAIL_STEP, 5);
    ribbons.destroy();
    system.destroy();

    // The same 13 steps in ONE compute pass, the points recorded by the system's after-step
    // callback, give the same ribbon.
    const again = createTrailSystem(device, { capacity: 8 });
    again.forces.gravity = [0, -1.5, 0];
    again
      .addEmitter({
        position: [0.2, 0.3, 0],
        direction: [0.6, 0.8, 0],
        speed: [0.5, 0.5],
        life: [10, 10],
        size: [0.01, 0.01],
      })
      .burst(1);
    const inline = createRibbons(again, { points: 8 });
    const encoder = device.createCommandEncoder();
    again.step(encoder, 13, undefined, inline.steps);
    device.queue.submit([encoder.finish()]);
    const [only] = (await again.read()).alive;
    const same = await ribbonOf(inline, device, only!);
    expect(same).toHaveLength(8);
    same.forEach((point, k) => {
      for (let c = 0; c < 4; c++) expect(point[c]).toBeCloseTo(ribbon[k]![c]!, 5);
    });
    inline.destroy();
    again.destroy();
  });

  it('drops a dead particle’s ribbon and never joins a recycled slot to the old path', async () => {
    const device = await getTestDevice();
    // One slot: every new particle is a recycled one.
    const system = createTrailSystem(device, { capacity: 1 });
    const speed = 1.2;
    const emitter = system.addEmitter({
      position: [0.5, 0.5, 0],
      spread: Math.PI,
      speed: [speed, speed],
      life: [0.1, 0.1],
      size: [0.02, 0.02],
    });
    const ribbons = createRibbons(system, { points: 16 });
    const W = 128;
    const target = device.createTexture({
      size: [W, W],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const lit = async (): Promise<number> => {
      const encoder = device.createCommandEncoder();
      encoder
        .beginRenderPass({
          colorAttachments: [
            {
              view: target.createView(),
              loadOp: 'clear',
              clearValue: [0, 0, 0, 0],
              storeOp: 'store',
            },
          ],
        })
        .end();
      ribbons.draw(encoder, {
        target: target.createView(),
        style: {
          pixel: 1 / W,
          view: [0.5, 0.5, 0.5, 0.5],
          width: 1,
          intensity: 1,
          minPixels: 1,
          taper: 0,
          tRef: 1800,
          gamma: 0.4,
        },
      });
      device.queue.submit([encoder.finish()]);
      const halves = new Uint16Array((await readTexture(device, target, 8)).buffer);
      let n = 0;
      for (let i = 0; i < halves.length; i += 4) if (fromHalf(halves[i]!) > 1e-3) n++;
      return n;
    };

    await expectValid(device, async () => {
      // A particle that lives six steps, then nothing: its ribbon is drawn, then gone.
      emitter.burst(1);
      await trailSteps(system, ribbons, 4);
      expect(await lit()).toBeGreaterThan(10);
      await trailSteps(system, ribbons, 6);
      expect((await system.readStats()).alive).toBe(0);
      expect(await lit()).toBe(0);

      // A stream of particles through the one slot, each born in the step the last one died.
      emitter.rate = 600;
      for (let round = 0; round < 6; round++) {
        await trailSteps(system, ribbons, 3 + round);
        const snapshot = await system.read();
        expect(snapshot.alive).toHaveLength(1);
        const ribbon = await ribbonOf(ribbons, device, 0);
        // At most the six records of one life, never the previous particle's.
        expect(ribbon.length).toBeLessThanOrEqual(7);
        expect(ribbon[0]![3]).toBeCloseTo(snapshot.positions[3]!, 5);
        for (let k = 1; k < ribbon.length; k++) {
          const step = Math.hypot(
            ribbon[k - 1]![0]! - ribbon[k]![0]!,
            ribbon[k - 1]![1]! - ribbon[k]![1]!,
          );
          expect(step).toBeLessThan(speed * TRAIL_STEP * 1.05);
          expect(ribbon[k - 1]![3]!).toBeGreaterThan(ribbon[k]![3]!);
        }
      }
      // The slot really was recycled several times (33 steps of six-step lives).
      expect((await system.readStats()).died).toBeGreaterThanOrEqual(5);
    });
    target.destroy();
    ribbons.destroy();
    system.destroy();
  });
});

// Live particles per shell type over its life, for the notes:
//   FIREWORKS_CENSUS=1 npx vitest run tests/epic7-e.test.ts -t census --silent=false
describe.skipIf(!process.env.FIREWORKS_CENSUS)('fireworks census', () => {
  it('counts the live particles of one shell of each type', async () => {
    for (const type of SHELL_TYPES) {
      const made = await show(65536);
      configureFireworks(made.system, { gravity: 0.55, size: 1, trails: 1, haze: 2.4, glow: true });
      launch(made, { type, salt: 'charcoal gold', count: burstCount(type, 1) }, 0.9);
      let peak = 0;
      let steps = 0;
      for (; steps < 600; steps += 10) {
        await run(made.system, 10);
        const { alive } = await made.system.readStats();
        peak = Math.max(peak, alive);
        if (alive === 0) break;
      }
      console.log(`census ${type}: peak ${peak} live, all gone after ${(steps / 60).toFixed(1)} s`);
      made.system.destroy();
    }
  });
});
