import { describe, expect, it, vi } from 'vitest';
import { toHalf } from '../src/gpu/emission/half-float.ts';
import {
  createParticleRenderer,
  createParticleSystem,
  MAX_EMITTERS,
  overlayCamera,
  planeThrough,
  rectFieldMapping,
  type ParticleSnapshot,
  type ParticleStepInfo,
  type ParticleSystem,
  type ParticleSystemOptions,
} from '../src/gpu/particles/index.ts';
import { CameraUniform, setCameraUniform } from '../src/gpu/scene/camera.ts';
import { createUniformBuffer } from '../src/gpu/uniforms.ts';
import { expectValid, getTestDevice, readTexture } from './gpu.ts';
import { scalars } from './wgsl-eval.ts';

// Story 7.1: the GPU particle framework. Every check runs the real kernels on the GPU with small
// pools and tens of steps, and compares against closed forms or exact bookkeeping.

vi.setConfig({ testTimeout: 60_000 });

async function rig(options: Omit<ParticleSystemOptions, 'device'>): Promise<ParticleSystem> {
  const device = await getTestDevice();
  return createParticleSystem({ device, ...options });
}

/** Runs `steps` steps (in submits of at most 16) and waits for the GPU. */
async function run(system: ParticleSystem, steps: number, dt?: number): Promise<void> {
  const { device } = system;
  for (let done = 0; done < steps;) {
    const n = Math.min(16, steps - done);
    const encoder = device.createCommandEncoder();
    system.step(encoder, n, dt);
    device.queue.submit([encoder.finish()]);
    done += n;
  }
  await device.queue.onSubmittedWorkDone();
}

interface Live {
  slot: number;
  position: [number, number, number];
  age: number;
  velocity: [number, number, number];
  life: number;
  temperature: number;
  size: number;
  kind: number;
  seed: number;
  user?: [number, number, number, number];
}

/** The live particles of a snapshot, in alive-list order. */
function live(snapshot: ParticleSnapshot): Live[] {
  const bits = new Uint32Array(snapshot.attributes.buffer);
  return Array.from(snapshot.alive, (slot) => {
    const p = snapshot.positions;
    const v = snapshot.velocities;
    const a = snapshot.attributes;
    const o = slot * 4;
    return {
      slot,
      position: [p[o]!, p[o + 1]!, p[o + 2]!],
      age: p[o + 3]!,
      velocity: [v[o]!, v[o + 1]!, v[o + 2]!],
      life: v[o + 3]!,
      temperature: a[o]!,
      size: a[o + 1]!,
      kind: bits[o + 3]!,
      seed: bits[o + 2]!,
      user: snapshot.user
        ? [snapshot.user[o]!, snapshot.user[o + 1]!, snapshot.user[o + 2]!, snapshot.user[o + 3]!]
        : undefined,
    };
  });
}

// --- Pool and recycling --------------------------------------------------------------------------

describe('particle pool', () => {
  it('never loses or duplicates a slot through thousands of births and deaths', async () => {
    const capacity = 200;
    const system = await rig({ capacity, dimension: 2, fixedStep: 1 / 60 });
    const steady = system.addEmitter({ rate: 2400, life: [0.02, 0.4], speed: [0, 1], spread: 3 });
    const bursts = system.addEmitter({ shape: 'sphere', radius: 1, life: [0.05, 0.2] });
    // A floor that kills, so some particles die early and out of order.
    system.forces.gravity = [0, -20, 0];
    system.colliders.push({ ...planeThrough([0, -0.3, 0], [0, 1, 0]), kill: true });
    let checks = 0;
    await expectValid(system.device, async () => {
      for (let round = 0; round < 12; round++) {
        bursts.burst(150);
        steady.rate = round % 3 === 0 ? 0 : 2400;
        await run(system, 25);
        const snapshot = await system.read();
        const { stats } = snapshot;
        expect(stats.alive + stats.dead).toBe(capacity);
        expect(snapshot.alive.length).toBe(stats.alive);
        // Every slot is in exactly one of the two lists.
        const all = [...snapshot.alive, ...snapshot.dead].sort((a, b) => a - b);
        expect(all).toEqual(Array.from({ length: capacity }, (_, i) => i));
        expect(stats.emitted - stats.died).toBe(stats.alive);
        checks++;
      }
    });
    const stats = await system.readStats();
    expect(checks).toBe(12);
    // The pool really was cycled: far more births than slots, and some births had to wait.
    expect(stats.emitted).toBeGreaterThan(capacity * 10);
    expect(stats.droppedEmits).toBeGreaterThan(0);
    expect(stats.steps).toBe(12 * 25);
    system.destroy();
  });

  it('emits at the requested rate, to within one particle, at any frame rate', async () => {
    const rate = 37.3;
    for (const deltas of [[1 / 60], [1 / 144], [1 / 30, 1 / 90, 1 / 47]]) {
      const system = await rig({ capacity: 4096, fixedStep: 1 / 60, maxSteps: 8 });
      system.addEmitter({ rate, life: [100, 100] });
      let seconds = 0;
      let steps = 0;
      const { device } = system;
      for (let frame = 0; seconds < 3.7; frame++) {
        const delta = deltas[frame % deltas.length]!;
        seconds += delta;
        const encoder = device.createCommandEncoder();
        steps += system.advance(encoder, delta);
        device.queue.submit([encoder.finish()]);
      }
      const stats = await system.readStats();
      expect(stats.steps).toBe(steps);
      const simulated = steps / 60;
      expect(Math.abs(seconds - simulated)).toBeLessThan(1 / 60);
      expect(Math.abs(stats.emitted - rate * simulated)).toBeLessThan(1);
      expect(stats.alive).toBe(stats.emitted);
      system.destroy();
    }
  });

  it('moves the same at 60 Hz and 144 Hz, and skips the backlog of a stalled tab', async () => {
    const results: number[][] = [];
    for (const hz of [60, 144]) {
      const system = await rig({ capacity: 64, fixedStep: 1 / 120, maxSteps: 4 });
      const e = system.addEmitter({ speed: [1, 3], spread: 1, life: [10, 10] });
      system.forces.gravity = [0, -9.81, 0];
      system.forces.dragLinear = 0.5;
      e.burst(20);
      const { device } = system;
      let steps = 0;
      for (let frame = 0; frame < hz; frame++) {
        const encoder = device.createCommandEncoder();
        steps += system.advance(encoder, 1 / hz);
        device.queue.submit([encoder.finish()]);
      }
      expect(steps).toBe(120);
      // A stall of two seconds runs at most maxSteps.
      const encoder = device.createCommandEncoder();
      expect(system.advance(encoder, 2)).toBe(4);
      device.queue.submit([encoder.finish()]);
      const particles = live(await system.read());
      results.push(particles.map((p) => p.position[1]).sort((a, b) => a - b));
      system.destroy();
    }
    expect(results[0]!.length).toBe(20);
    results[0]!.forEach((y, i) => expect(results[1]![i]).toBeCloseTo(y, 5));
  });
});

// --- Emitters ------------------------------------------------------------------------------------

describe('emitters', () => {
  it('samples every shape inside its volume, in 2D and 3D', async () => {
    for (const dimension of [2, 3] as const) {
      const system = await rig({ capacity: 6000, dimension });
      const center: [number, number, number] = [1, 2, 3];
      const shapes = [
        system.addEmitter({ shape: 'point', position: center, kind: 0 }),
        system.addEmitter({ shape: 'segment', position: center, extent: [1, 0.5, 0], kind: 1 }),
        system.addEmitter({ shape: 'box', position: center, extent: [0.5, 1, 2], kind: 2 }),
        system.addEmitter({
          shape: 'sphere',
          position: center,
          radius: 2,
          innerRadius: 1,
          kind: 3,
        }),
        system.addEmitter({ shape: 'disc', position: center, radius: 1.5, kind: 4 }),
        system.addEmitter({
          shape: 'disc',
          position: center,
          radius: 1,
          innerRadius: 1,
          axis: [1, 0, 0],
          kind: 5,
        }),
      ];
      for (const e of shapes) {
        e.life = [10, 10];
        e.burst(800);
      }
      await run(system, 1);
      const particles = live(await system.read());
      expect(particles.length).toBe(4800);
      const z0 = dimension === 2 ? 0 : 3;
      for (const p of particles) {
        const [x, y, z] = [p.position[0] - 1, p.position[1] - 2, p.position[2] - z0];
        if (dimension === 2) expect(Math.abs(p.position[2])).toBe(0);
        const r = Math.hypot(x, y, z);
        switch (p.kind) {
          case 0:
            expect(r).toBeLessThan(1e-5);
            break;
          case 1:
            // On the segment from centre - extent to centre + extent.
            expect(Math.abs(x * 0.5 - y * 1)).toBeLessThan(1e-5);
            expect(Math.abs(x)).toBeLessThanOrEqual(1 + 1e-5);
            break;
          case 2:
            expect(Math.abs(x)).toBeLessThanOrEqual(0.5 + 1e-5);
            expect(Math.abs(y)).toBeLessThanOrEqual(1 + 1e-5);
            if (dimension === 3) expect(Math.abs(z)).toBeLessThanOrEqual(2 + 1e-5);
            break;
          case 3:
            expect(r).toBeGreaterThanOrEqual(1 - 1e-4);
            expect(r).toBeLessThanOrEqual(2 + 1e-4);
            break;
          case 4:
            expect(r).toBeLessThanOrEqual(1.5 + 1e-4);
            // 3D: in the plane normal to +y.
            if (dimension === 3) expect(Math.abs(y)).toBeLessThan(1e-5);
            break;
          case 5:
            // A ring of radius 1; in 3D it lies in the plane normal to +x.
            expect(r).toBeCloseTo(1, 4);
            if (dimension === 3) expect(Math.abs(x)).toBeLessThan(1e-5);
            break;
        }
      }
      system.destroy();
    }
  });

  it('launches inside the cone with speeds, lives, temperatures and sizes in their ranges', async () => {
    const system = await rig({ capacity: 3000 });
    const e = system.addEmitter({
      direction: [0, 0, 1],
      spread: 0.3,
      speed: [2, 4],
      life: [1, 2],
      temperature: [1500, 2500],
      size: [0.01, 0.03],
    });
    e.burst(3000);
    await run(system, 1);
    const particles = live(await system.read());
    expect(particles.length).toBe(3000);
    let wide = 0;
    for (const p of particles) {
      const speed = Math.hypot(...p.velocity);
      expect(speed).toBeGreaterThanOrEqual(2 - 1e-4);
      expect(speed).toBeLessThanOrEqual(4 + 1e-4);
      const angle = Math.acos(p.velocity[2] / speed);
      expect(angle).toBeLessThanOrEqual(0.3 + 1e-3);
      if (angle > 0.15) wide++;
      expect(p.life).toBeGreaterThanOrEqual(1);
      expect(p.life).toBeLessThanOrEqual(2);
      expect(p.temperature).toBeGreaterThanOrEqual(1500 - 1e-2);
      expect(p.temperature).toBeLessThanOrEqual(2500 + 1e-2);
      expect(p.size).toBeGreaterThanOrEqual(0.01 - 1e-6);
      expect(p.size).toBeLessThanOrEqual(0.03 + 1e-6);
    }
    // Uniform over the cap: the outer half of the angle holds about three quarters of the area.
    expect(wide / 3000).toBeGreaterThan(0.7);
    expect(wide / 3000).toBeLessThan(0.8);
    system.destroy();
  });

  it('spreads a fast-moving emitter along its whole path: no gaps', async () => {
    const system = await rig({ capacity: 4096, dimension: 2, fixedStep: 1 / 60 });
    const tip = system.addEmitter({ rate: 6000, life: [10, 10] });
    const { device } = system;
    // One frame of four steps sweeps the emitter from x = 0 to x = 1: 400 particles.
    tip.jumpTo([0, 0, 0]);
    tip.moveTo([1, 0, 0]);
    const encoder = device.createCommandEncoder();
    system.step(encoder, 4);
    device.queue.submit([encoder.finish()]);
    const xs = live(await system.read())
      .map((p) => p.position[0])
      .sort((a, b) => a - b);
    expect(xs.length).toBe(400);
    expect(xs[0]!).toBeLessThan(0.01);
    expect(xs.at(-1)!).toBeGreaterThan(0.99);
    let gap = 0;
    for (let i = 1; i < xs.length; i++) gap = Math.max(gap, xs[i]! - xs[i - 1]!);
    // Stratified along the path: no gap wider than two spacings.
    expect(gap).toBeLessThan(2 / 400);
    system.destroy();
  });

  it('refuses a ninth emitter', async () => {
    const system = await rig({ capacity: 8 });
    for (let i = 0; i < MAX_EMITTERS; i++) system.addEmitter({});
    expect(() => system.addEmitter({})).toThrow(/at most/);
    system.destroy();
  });
});

// --- Motion --------------------------------------------------------------------------------------

describe('integration', () => {
  it('reproduces the discrete ballistic solution of semi-implicit Euler exactly', async () => {
    const system = await rig({ capacity: 16, fixedStep: 1 / 240 });
    const g: [number, number, number] = [0, -9.81, 0.5];
    system.forces.gravity = g;
    const starts = [
      { p: [0, 10, 0], v: [1, 2, -1] },
      { p: [1, 10, 0], v: [1, 3, -1] },
      { p: [2, 10, 0], v: [-2, 4, 0.5] },
    ];
    starts.forEach((s, kind) => {
      const speed = Math.hypot(...s.v);
      const e = system.addEmitter({
        position: s.p as [number, number, number],
        direction: s.v.map((c) => c / speed) as [number, number, number],
        speed: [speed, speed],
        life: [100, 100],
        kind,
      });
      e.burst(1);
    });
    const steps = 181;
    await expectValid(system.device, () => run(system, steps));
    const particles = live(await system.read());
    expect(particles.length).toBe(3);
    const dt = 1 / 240;
    // Born at the end of the first step, then integrated n times.
    const n = steps - 1;
    for (const particle of particles) {
      const { p, v } = starts[particle.kind]!;
      for (let axis = 0; axis < 3; axis++) {
        const vn = v[axis]! + n * g[axis]! * dt;
        const pn = p[axis]! + n * v[axis]! * dt + (g[axis]! * dt * dt * n * (n + 1)) / 2;
        expect(particle.velocity[axis]).toBeCloseTo(vn, 3);
        expect(particle.position[axis]).toBeCloseTo(pn, 3);
      }
      expect(particle.age).toBeCloseTo(n * dt, 4);
    }
    system.destroy();
  });

  it('applies linear and quadratic drag exactly, towards the wind', async () => {
    const system = await rig({ capacity: 4, fixedStep: 1 / 50 });
    system.forces.dragLinear = 2;
    system.forces.dragQuadratic = 0.5;
    system.forces.wind = [1, 0, 0];
    system.addEmitter({ direction: [1, 0, 0], speed: [5, 5], life: [100, 100] }).burst(1);
    await run(system, 51); // born, then one second
    const [p] = live(await system.read());
    // Relative speed s0 = 4; ds/dt = -a s - b s^2 has s(t) = a s0 e / (a + b s0 (1 - e)).
    const e = Math.exp(-2);
    const s = (2 * 4 * e) / (2 + 0.5 * 4 * (1 - e));
    expect(p!.velocity[0]).toBeCloseTo(1 + s, 4);
    system.destroy();
  });

  it('cools along Newton and linear curves, and kills at the death temperature', async () => {
    const dt = 1 / 60;
    const newton = await rig({ capacity: 4, fixedStep: dt });
    newton.heat.cooling = 'newton';
    newton.heat.rate = 0.7;
    newton.heat.ambient = 300;
    newton.addEmitter({ temperature: [2000, 2000], life: [100, 100] }).burst(1);
    await run(newton, 61);
    const [hot] = live(await newton.read());
    expect(hot!.temperature).toBeCloseTo(300 + 1700 * Math.exp(-0.7), 2);
    newton.destroy();

    const linear = await rig({ capacity: 4, fixedStep: dt });
    linear.heat.cooling = 'linear';
    linear.heat.rate = 500;
    linear.heat.ambient = 300;
    linear.heat.deathTemperature = 1000;
    linear.addEmitter({ temperature: [2000, 2000], life: [100, 100] }).burst(1);
    await run(linear, 61);
    const [warm] = live(await linear.read());
    expect(warm!.temperature).toBeCloseTo(1500, 2);
    // 2000 K falls under 1000 K after 2 s: alive at 1.98 s of cooling, dead at 2.02 s.
    await run(linear, 58);
    expect((await linear.readStats()).alive).toBe(1);
    await run(linear, 3);
    expect((await linear.readStats()).alive).toBe(0);
    linear.destroy();
  });

  it('lifts hot particles in proportion to temperature and swirls them with curl noise', async () => {
    const system = await rig({ capacity: 64, dimension: 2, fixedStep: 1 / 60 });
    system.forces.buoyancy = 2;
    system.heat.ambient = 300;
    system.addEmitter({ temperature: [1300, 1300], life: [100, 100], kind: 0 }).burst(1);
    system.addEmitter({ temperature: [2300, 2300], life: [100, 100], kind: 1 }).burst(1);
    await run(system, 61);
    const particles = live(await system.read()).sort((a, b) => a.kind - b.kind);
    // a = buoyancy * (T - ambient) / 1000 along +y: 2 and 4 units/s^2, for 1 s.
    expect(particles[0]!.velocity[1]).toBeCloseTo(2, 4);
    expect(particles[1]!.velocity[1]).toBeCloseTo(4, 4);

    const swirl = await rig({ capacity: 256, dimension: 3, fixedStep: 1 / 60 });
    swirl.forces.turbulence = '3d';
    swirl.forces.turbulenceStrength = 3;
    swirl.addEmitter({ shape: 'box', extent: [2, 2, 2], life: [100, 100] }).burst(256);
    await run(swirl, 31);
    const moved = live(await swirl.read());
    const speeds = moved.map((p) => Math.hypot(...p.velocity));
    // Every particle is pushed, in many directions.
    expect(Math.min(...speeds)).toBeGreaterThan(0);
    const mean = moved.reduce((m, p) => m + p.velocity[0], 0) / moved.length;
    expect(Math.abs(mean)).toBeLessThan(Math.max(...speeds) / 2);
    system.destroy();
    swirl.destroy();
  });
});

// --- Colliders -----------------------------------------------------------------------------------

describe('colliders', () => {
  it('are never passed through, however fast the particle', async () => {
    const system = await rig({ capacity: 2048, fixedStep: 1 / 60 });
    // Solid floor, a thin solid wall, and a hollow ball the particles are trapped in.
    system.colliders.push({ ...planeThrough([0, 0, 0], [0, 1, 0]), restitution: 0.8 });
    system.colliders.push({ type: 'box', center: [10, 5, 0], half: [0.01, 10, 10] });
    system.colliders.push({ type: 'sphere', center: [-20, 5, 0], radius: 2, inside: true });
    system.forces.gravity = [0, -30, 0];
    // At the floor, straight down at 600 units/s (10 units a step).
    system
      .addEmitter({
        shape: 'box',
        position: [0, 3, 0],
        extent: [2, 1, 2],
        direction: [0, -1, 0],
        spread: 0.5,
        speed: [100, 600],
        life: [100, 100],
        kind: 0,
      })
      .burst(600);
    // At the thin wall, along +x at up to 900 units/s.
    system
      .addEmitter({
        position: [5, 5, 0],
        direction: [1, 0, 0],
        spread: 0.3,
        speed: [300, 900],
        life: [100, 100],
        kind: 1,
      })
      .burst(600);
    // Inside the ball, in every direction at up to 800 units/s.
    system
      .addEmitter({
        position: [-20, 5, 0],
        direction: [0, 1, 0],
        spread: Math.PI,
        speed: [100, 800],
        life: [100, 100],
        kind: 2,
      })
      .burst(600);
    for (let round = 0; round < 6; round++) {
      await run(system, 10);
      const particles = live(await system.read());
      expect(particles.length).toBe(1800);
      for (const p of particles) {
        const [x, y, z] = p.position;
        expect(y).toBeGreaterThanOrEqual(-1e-3);
        if (p.kind === 1) expect(x).toBeLessThanOrEqual(10 - 0.01 + 1e-3);
        if (p.kind === 2) expect(Math.hypot(x + 20, y - 5, z)).toBeLessThanOrEqual(2 + 1e-3);
      }
    }
    expect((await system.readStats()).hits).toBeGreaterThan(1800);
    system.destroy();
  });

  it('stop at the first collider that kills: no second spawn where two overlap', async () => {
    // Two identical floors: a particle that dies on the first must never reach the second.
    for (const via of ['flags', 'hook'] as const) {
      const system = await rig({
        capacity: 1024,
        fixedStep: 1 / 60,
        hooks:
          via === 'hook'
            ? {
                code: `fn hook_collide(p: ptr<function, Particle>, hit: ParticleHit) {
  if ((*p).kind == 0u) {
    ps_spawn(hit.position + hit.normal * 0.01, vec3f(0.0), 3u, 1u, vec4f(0.0));
    (*p).alive = false;
  }
}`,
              }
            : {},
      });
      const floor =
        via === 'flags'
          ? { ...planeThrough([0, 0, 0], [0, 1, 0]), kill: true, spawnCount: 3, spawnTemplate: 1 }
          : planeThrough([0, 0, 0], [0, 1, 0]);
      system.colliders.push(floor, { ...floor });
      system.forces.gravity = [0, -10, 0];
      system
        .addEmitter({ shape: 'box', position: [0, 1, 0], extent: [1, 0.5, 1], life: [100, 100] })
        .burst(50);
      // The children leave upwards fast enough never to come back within the test.
      system.addEmitter({ direction: [0, 1, 0], speed: [30, 30], life: [100, 100], kind: 1 });
      await run(system, 40);
      const stats = await system.readStats();
      expect(stats.hits).toBe(50);
      expect(stats.spawned).toBe(150);
      expect(stats.alive).toBe(150);
      system.destroy();
    }
  });

  it('bounces with restitution and friction, and supports an SDF from a hook', async () => {
    const system = await rig({
      capacity: 64,
      fixedStep: 1 / 120,
      hooks: { code: 'fn hook_sdf(q: vec3f) -> f32 {\n  return q.y + 1.0;\n}' },
    });
    system.colliders.push({ type: 'sdf', restitution: 0.5, friction: 0.25 });
    system
      .addEmitter({
        position: [0, -0.5, 0],
        direction: [3, -4, 0],
        speed: [5, 5],
        life: [100, 100],
      })
      .burst(1);
    // Reaches y = -1 after 0.5 / 4 = 0.125 s = 15 steps.
    await run(system, 20);
    const [p] = live(await system.read());
    expect(p!.position[1]).toBeGreaterThanOrEqual(-1);
    expect(p!.velocity[1]).toBeCloseTo(2, 3); // -4 reversed, times 0.5
    expect(p!.velocity[0]).toBeCloseTo(2.25, 3); // 3 times 1 - 0.25
    system.destroy();
  });
});

// --- GPU spawning --------------------------------------------------------------------------------

describe('GPU spawn queue', () => {
  it('turns each dying parent into exactly the requested children, with no CPU round trip', async () => {
    const system = await rig({
      capacity: 512,
      userData: true,
      hooks: {
        code: `fn hook_die(p: Particle) {
  if (p.kind == 0u) {
    ps_spawn(p.position, p.velocity, 7u, 1u, vec4f(p.position, 1.0));
  }
}
fn hook_emit(p: ptr<function, Particle>, source: ParticleSource) {
  if (source.spawned) {
    (*p).user = vec4f(source.user.xyz, f32(source.index));
  }
}`,
      },
    });
    const parents = system.addEmitter({
      shape: 'box',
      extent: [3, 3, 3],
      life: [0.05, 0.25],
      kind: 0,
    });
    // The template: rate 0, long-lived children of kind 1, thrown out of the parent.
    system.addEmitter({
      direction: [0, 1, 0],
      spread: Math.PI,
      speed: [1, 2],
      life: [100, 100],
      kind: 1,
    });
    parents.burst(30);
    await expectValid(system.device, () => run(system, 30));
    const stats = await system.readStats();
    const particles = live(await system.read());
    const children = particles.filter((p) => p.kind === 1);
    expect(particles.filter((p) => p.kind === 0)).toEqual([]);
    expect(children.length).toBe(210);
    expect(stats.spawned).toBe(210);
    expect(stats.droppedSpawns).toBe(0);
    // Each child was born where its parent died, numbered 0..6 within its request.
    const byParent = new Map<string, number[]>();
    for (const c of children) {
      const key = c
        .user!.slice(0, 3)
        .map((x) => x.toFixed(4))
        .join(',');
      byParent.set(key, [...(byParent.get(key) ?? []), c.user![3]!]);
      const toParent = Math.hypot(...[0, 1, 2].map((k) => c.position[k]! - c.user![k]!));
      expect(toParent).toBeLessThanOrEqual(2 * c.age + 1e-3);
    }
    expect(byParent.size).toBe(30);
    for (const indices of byParent.values()) {
      expect(indices.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
    system.destroy();
  });

  it('spawns from collider contacts, and counts what the queue cannot hold', async () => {
    const system = await rig({ capacity: 4096, queueCapacity: 16, fixedStep: 1 / 60 });
    system.colliders.push({
      ...planeThrough([0, 0, 0], [0, 1, 0]),
      kill: true,
      spawnCount: 3,
      spawnTemplate: 1,
    });
    system.forces.gravity = [0, -10, 0];
    system
      .addEmitter({ shape: 'box', position: [0, 1, 0], extent: [1, 0.5, 1], life: [100, 100] })
      .burst(40);
    // Children leave fast enough upwards not to come back within the test.
    system.addEmitter({
      direction: [0, 1, 0],
      spread: 1,
      speed: [20, 20],
      life: [100, 100],
      kind: 1,
    });
    await run(system, 40);
    const stats = await system.readStats();
    // Every contact kills a parent and asks for three children; the queue takes 16 a step.
    expect(stats.hits).toBe(40);
    expect(stats.spawned + 3 * stats.droppedSpawns).toBe(120);
    const particles = live(await system.read());
    expect(particles.length).toBe(stats.spawned);
    for (const p of particles) {
      expect(p.kind).toBe(1);
      expect(p.position[1]).toBeGreaterThanOrEqual(0);
    }
    system.destroy();
  });

  // 1 500 parents die in one step, each asking for 1 to 4 children: far more requests than one
  // thread of the plan's workgroup walks, so the prefix sum is exercised across all 256 runs.
  const MANY = `fn hook_die(p: Particle) {
  if (p.kind == 0u) {
    let n = 1u + (p.seed & 3u);
    ps_spawn(p.position, p.velocity, n, 1u, vec4f(7.0));
  }
}
fn hook_emit(p: ptr<function, Particle>, source: ParticleSource) {
  if (source.spawned) {
    (*p).user = vec4f(source.position.x, source.velocity.y, f32(source.index), f32(source.count));
  }
}`;
  const manyParents = (system: ParticleSystem) => {
    // Parents rise straight up, so x never changes; they die in their second step.
    const parents = system.addEmitter({
      shape: 'segment',
      extent: [1, 0, 0],
      speed: [1, 2],
      life: [0.02, 0.02],
      kind: 0,
    });
    system.addEmitter({ life: [100, 100], kind: 1 });
    const cpu = system.addEmitter({ life: [100, 100], kind: 2 });
    return { parents, cpu };
  };
  const childCount = (p: Live) => 1 + (p.seed & 3);
  // A request is known by its parent's x and vertical speed (each alone could repeat; the speed
  // may move by an ulp in the parent's last step).
  const requestKey = (x: number, vy: number) => `${x},${vy.toFixed(4)}`;

  it('plans thousands of requests exactly: every child, numbered within its request', async () => {
    const system = await rig({
      capacity: 8192,
      queueCapacity: 2048,
      userData: true,
      hooks: { code: MANY },
    });
    const { parents } = manyParents(system);
    parents.burst(1500);
    await run(system, 2);
    const before = live(await system.read());
    expect(before.length).toBe(1500);
    const expected = new Map(
      before.map((p) => [requestKey(p.position[0], p.velocity[1]), childCount(p)]),
    );
    expect(expected.size).toBe(1500);
    const total = [...expected.values()].reduce((sum, n) => sum + n, 0);
    await expectValid(system.device, () => run(system, 1));
    const stats = await system.readStats();
    expect(stats.spawned).toBe(total);
    expect(stats.droppedEmits).toBe(0);
    const children = live(await system.read());
    expect(children.length).toBe(total);
    // hook_emit saw each request's position and velocity (the parent's) and its count.
    const byRequest = new Map<string, number[]>();
    for (const c of children) {
      const [x, vy, index, count] = c.user!;
      const key = requestKey(x, vy);
      expect(count).toBe(expected.get(key));
      byRequest.set(key, [...(byRequest.get(key) ?? []), index]);
    }
    expect(byRequest.size).toBe(1500);
    for (const [key, indices] of byRequest) {
      expect(indices.sort((a, b) => a - b)).toEqual(
        Array.from({ length: expected.get(key)! }, (_, i) => i),
      );
    }
    system.destroy();
  });

  it('gives children priority over CPU emission and never exceeds the dead stack', async () => {
    const capacity = 2000;
    const system = await rig({
      capacity,
      queueCapacity: 2048,
      userData: true,
      hooks: { code: MANY },
    });
    const { parents, cpu } = manyParents(system);
    parents.burst(1500);
    await run(system, 2);
    const total = live(await system.read()).reduce((sum, p) => sum + childCount(p), 0);
    expect(total).toBeGreaterThan(capacity);
    // The parents all die in the next step and 100 CPU particles are due in it too.
    cpu.burst(100);
    await run(system, 1);
    const snapshot = await system.read();
    const { stats } = snapshot;
    expect(stats.alive).toBe(capacity);
    expect(stats.dead).toBe(0);
    expect(stats.spawned).toBe(capacity);
    expect(stats.droppedEmits).toBe(total + 100 - capacity);
    const all = [...snapshot.alive, ...snapshot.dead].sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: capacity }, (_, i) => i));
    expect(live(snapshot).filter((p) => p.kind !== 1)).toEqual([]);
    system.destroy();
  });

  it('hands a burst its user value, one value a step, in order', async () => {
    const system = await rig({ capacity: 64, userData: true });
    const e = system.addEmitter({ life: [100, 100], rate: 60 });
    e.burst(3, [1, 2, 3, 4]);
    e.burst(2, [5, 6, 7, 8]);
    e.burst(1, [5, 6, 7, 8]);
    e.burst(4, [1, 2, 3, 4]);
    const users: string[][] = [];
    for (let k = 0; k < 4; k++) {
      await run(system, 1);
      const snapshot = await system.read();
      users.push(
        live(snapshot)
          .filter((p) => p.age === 0)
          .map((p) => p.user!.join(','))
          .sort(),
      );
    }
    // Step 1: the first value's three; step 2: the other value's three; step 3: the first value's
    // four. Rate particles (one a step, born before the step's end) are not counted by age 0.
    expect(users[0]).toEqual(['1,2,3,4', '1,2,3,4', '1,2,3,4']);
    expect(users[1]).toEqual(['5,6,7,8', '5,6,7,8', '5,6,7,8']);
    expect(users[2]).toEqual(Array(4).fill('1,2,3,4'));
    expect(users[3]).toEqual([]);
    const rate = live(await system.read()).filter((p) => p.user!.every((u) => u === 0));
    expect(rate.length).toBe(4);
    system.destroy();
  });
});

// --- Determinism ---------------------------------------------------------------------------------

describe('determinism', () => {
  it('replays the same particles from the same seed, whatever order the threads ran in', async () => {
    const hooks = {
      code: `fn hook_die(p: Particle) {
  if (p.kind == 0u) {
    ps_spawn(p.position, p.velocity, 2u + (p.seed & 3u), 1u, vec4f(1.0, 0.0, 0.0, 0.0));
    ps_spawn(p.position, -p.velocity, 1u, 1u, vec4f(2.0, 0.0, 0.0, 0.0));
  }
}
fn hook_collide(p: ptr<function, Particle>, hit: ParticleHit) {
  if ((*p).kind == 0u && hit.impact > 0.5) {
    ps_spawn(hit.position + hit.normal * 0.01, (*p).velocity, 3u, 1u, vec4f(3.0, 0.0, 0.0, 0.0));
    (*p).alive = false;
  }
}
fn hook_emit(p: ptr<function, Particle>, source: ParticleSource) {
  if (source.spawned) {
    (*p).user = vec4f(source.user.x, f32(source.index), f32(source.count), 0.0);
  }
}`,
    };
    const once = async () => {
      const system = await rig({
        capacity: 8192,
        queueCapacity: 1024,
        dimension: 2,
        userData: true,
        hooks,
        seed: 21,
      });
      system.forces.gravity = [0, -3, 0];
      system.forces.turbulence = '2d';
      system.forces.turbulenceStrength = 0.5;
      system.heat.cooling = 'newton';
      system.heat.rate = 0.5;
      system.colliders.push({ ...planeThrough([0, -0.4, 0], [0, 1, 0]), restitution: 0.5 });
      system.addEmitter({
        shape: 'box',
        extent: [0.5, 0.2, 0],
        spread: 1,
        speed: [0.2, 1],
        life: [0.1, 0.6],
        temperature: [1500, 2500],
        rate: 600,
        kind: 0,
      });
      system.addEmitter({ spread: Math.PI, speed: [0.5, 1], life: [0.2, 0.5], kind: 1 });
      const bursts = system.addEmitter({ shape: 'sphere', radius: 0.2, life: [0.3, 0.9], kind: 0 });
      for (let round = 0; round < 10; round++) {
        bursts.burst(40, [round, 0, 0, 0]);
        await run(system, 20);
      }
      const snapshot = await system.read();
      const bits = new Uint32Array(snapshot.attributes.buffer);
      const f = (x: number) => x.toFixed(5).replace(/^-(0\.0+)$/, '$1');
      const states = live(snapshot)
        .map((p) =>
          [...p.position, p.age, ...p.velocity, p.life, p.temperature, p.size, ...p.user!]
            .map(f)
            .concat([String(p.kind), String(bits[p.slot * 4 + 2])])
            .join(' '),
        )
        .sort();
      const stats = snapshot.stats;
      system.destroy();
      return { states, stats };
    };
    const a = await once();
    const b = await once();
    // A real run: births, deaths, collisions and children from both hooks.
    expect(a.stats.steps).toBe(200);
    expect(a.stats.spawned).toBeGreaterThan(500);
    expect(a.stats.died).toBeGreaterThan(1000);
    expect(a.stats.hits).toBeGreaterThan(0);
    expect(a.stats.droppedEmits + a.stats.droppedSpawns).toBe(0);
    expect(b.stats).toEqual(a.stats);
    expect(b.states).toEqual(a.states);
  });
});

// --- Steps ---------------------------------------------------------------------------------------

describe('after-step callback', () => {
  it('runs once per step in the same pass, with that step’s list and uniform slot', async () => {
    const system = await rig({ capacity: 64, fixedStep: 1 / 60, maxSteps: 8 });
    system.addEmitter({ rate: 600, life: [10, 10] });
    const { device } = system;
    const seen: { index: number; steps: number; list: number; offset: number; time: number }[] = [];
    const afterStep = (_pass: GPUComputePassEncoder, s: ParticleStepInfo) => {
      seen.push({
        index: s.index,
        steps: s.steps,
        list: s.list,
        offset: s.uniform.offset ?? 0,
        time: s.time,
      });
    };
    let encoder = device.createCommandEncoder();
    system.step(encoder, 5, undefined, { afterStep });
    device.queue.submit([encoder.finish()]);
    expect(seen.map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
    expect(seen.every((s) => s.steps === 5)).toBe(true);
    // The list alternates, and the last one is where the particles are now.
    for (let k = 1; k < 5; k++) expect(seen[k]!.list).toBe(1 - seen[k - 1]!.list);
    expect(seen[4]!.list).toBe(system.list);
    expect(new Set(seen.map((s) => s.offset)).size).toBe(5);
    expect(seen[4]!.time).toBeCloseTo(5 / 60, 9);
    seen.length = 0;
    encoder = device.createCommandEncoder();
    const steps = system.advance(encoder, 3.5 / 60, { afterStep });
    device.queue.submit([encoder.finish()]);
    expect(steps).toBe(3);
    expect(seen.length).toBe(3);
    expect((await system.readStats()).steps).toBe(8);
    system.destroy();
  });
});

// --- External velocity field ---------------------------------------------------------------------

describe('external velocity field', () => {
  function fieldTexture(device: GPUDevice, vx: number, vy: number): GPUTexture {
    const texture = device.createTexture({
      size: [4, 4],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const data = new Uint16Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) data.set([toHalf(vx), toHalf(vy), 0, 0], i * 4);
    device.queue.writeTexture({ texture }, data, { bytesPerRow: 32 }, [4, 4]);
    return texture;
  }

  it('advects particles exactly as sampled, through the mapping, and not outside the texture', async () => {
    const device = await getTestDevice();
    const texture = fieldTexture(device, 0.5, -0.25);
    const system = await rig({
      capacity: 8,
      dimension: 2,
      fixedStep: 1 / 60,
      field: texture.createView(),
    });
    system.forces.field = 'advect';
    // The texture covers x 0..2, y 0..1 with v growing upwards; texel velocity times 2.
    system.forces.fieldMapping = rectFieldMapping({ min: [0, 0], max: [2, 1], velocityScale: 2 });
    system.addEmitter({ position: [0.6, 0.6, 0], life: [100, 100], kind: 0 }).burst(1);
    system.addEmitter({ position: [5, 0.5, 0], life: [100, 100], kind: 1 }).burst(1);
    await expectValid(device, () => run(system, 31)); // half a second of motion
    const particles = live(await system.read()).sort((a, b) => a.kind - b.kind);
    expect(particles[0]!.velocity[0]).toBeCloseTo(1, 4);
    expect(particles[0]!.velocity[1]).toBeCloseTo(-0.5, 4);
    expect(particles[0]!.position[0]).toBeCloseTo(0.6 + 0.5, 4);
    expect(particles[0]!.position[1]).toBeCloseTo(0.6 - 0.25, 4);
    // Far outside the texture the field is zero.
    expect(particles[1]!.position[0]).toBeCloseTo(5, 5);
    system.destroy();
    texture.destroy();
  });

  it('drags particles towards the field velocity, flipping y for a top-left texture', async () => {
    const device = await getTestDevice();
    const texture = fieldTexture(device, 0.25, 0.5);
    const system = await rig({
      capacity: 8,
      dimension: 2,
      fixedStep: 1 / 60,
      field: texture.createView(),
    });
    system.forces.field = 'drag';
    system.forces.fieldCoupling = 6;
    system.forces.fieldMapping = rectFieldMapping({ min: [0, 0], max: [1, 1], flipY: true });
    system.addEmitter({ position: [0.5, 0.5, 0], life: [100, 100] }).burst(1);
    await run(system, 61);
    const [p] = live(await system.read());
    // v -> field exponentially: (0.25, -0.5) * (1 - e^-6). y is flipped (texture y grows down).
    const k = 1 - Math.exp(-6);
    expect(p!.velocity[0]).toBeCloseTo(0.25 * k, 3);
    expect(p!.velocity[1]).toBeCloseTo(-0.5 * k, 3);
    system.destroy();
    texture.destroy();
  });
});

// --- Drawing -------------------------------------------------------------------------------------

describe('particle renderer', () => {
  it('writes one sprite per live particle and draws them indirectly where the camera says', async () => {
    const device = await getTestDevice();
    const system = createParticleSystem({ device, capacity: 64, dimension: 2 });
    // Overlay space: x 0..2, y 0..1 on a 64 x 32 canvas. One particle at (1.5, 0.75).
    system.addEmitter({ position: [1.5, 0.75, 0], life: [100, 100], size: [0.06, 0.06] }).burst(1);
    const camera = createUniformBuffer(device, CameraUniform, 'test camera');
    setCameraUniform(camera, overlayCamera(64, 32), 64, 32);
    camera.upload();
    const renderer = createParticleRenderer(system, { camera: camera.buffer });
    renderer.style.color = 'tint';
    renderer.style.tint = [1, 1, 1];
    renderer.style.intensity = 1;
    renderer.style.fadeIn = 0;
    renderer.sprites.settings.shape = 'disc';
    const target = device.createTexture({
      size: [64, 32],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    await expectValid(device, async () => {
      const encoder = device.createCommandEncoder();
      system.step(encoder, 2);
      renderer.encode(encoder, 1 / 60);
      renderer.draw(encoder, { target: target.createView(), clear: { r: 0, g: 0, b: 0, a: 0 } });
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
    });
    const pixels = new Uint16Array((await readTexture(device, target, 8)).buffer);
    // Half-float bits without the sign: -0 and +0 are both no light.
    const red = (x: number, y: number) => pixels[(y * 64 + x) * 4]! & 0x7fff;
    // (1.5, 0.75) is pixel (48, 8); 0.06 heights is a radius of about 2 pixels.
    expect(red(48, 8)).not.toBe(0);
    expect(red(40, 8)).toBe(0);
    expect(red(16, 24)).toBe(0);
    renderer.destroy();
    camera.destroy();
    target.destroy();
    system.destroy();
  });
});

// --- particles.wgsl ------------------------------------------------------------------------------

describe('particles.wgsl', () => {
  const include = '#include "particles.wgsl"';

  it('drags exactly, cools exactly, and keeps twinkle inside its range', async () => {
    const values = await scalars(include, [
      'particle_drag(vec3f(4.0, 0.0, 0.0), 2.0, 0.5, 1.0).x',
      'particle_drag(vec3f(4.0, 0.0, 0.0), 0.0, 0.5, 1.0).x',
      'particle_drag(vec3f(0.0, 0.0, 0.0), 2.0, 0.5, 1.0).x',
      'particle_cool_newton(2000.0, 300.0, 0.5, 2.0)',
      'particle_cool_linear(2000.0, 300.0, 500.0, 2.0)',
      'particle_cool_linear(2000.0, 300.0, 500.0, 10.0)',
      'particle_size_over_life(0.0, vec4f(0.5, 2.0, 0.0, 0.3))',
      'particle_size_over_life(0.3, vec4f(0.5, 2.0, 0.0, 0.3))',
      'particle_size_over_life(1.0, vec4f(0.5, 2.0, 0.0, 0.3))',
    ]);
    const e = Math.exp(-2);
    expect(values[0]).toBeCloseTo((2 * 4 * e) / (2 + 0.5 * 4 * (1 - e)), 5);
    expect(values[1]).toBeCloseTo(4 / (1 + 0.5 * 4), 5);
    expect(Math.abs(values[2]!)).toBe(0);
    expect(values[3]).toBeCloseTo(300 + 1700 * Math.exp(-1), 2);
    expect(values[4]).toBeCloseTo(1000, 3);
    expect(values[5]).toBeCloseTo(300, 3);
    expect(values[6]).toBeCloseTo(0.5, 5);
    expect(values[7]).toBeCloseTo(2, 5);
    expect(values[8]).toBeCloseTo(0, 5);

    const twinkles = await scalars(
      include,
      Array.from(
        { length: 64 },
        (_, i) => `particle_twinkle(${i * 7919}u, ${(i * 0.37).toFixed(2)}, 0.4, 100.0)`,
      ),
    );
    for (const t of twinkles) {
      expect(t).toBeGreaterThanOrEqual(0.6 - 1e-5);
      expect(t).toBeLessThanOrEqual(1 + 1e-5);
    }
  });

  it('finds the first contact on a segment, from outside and from inside', async () => {
    const v = await scalars(include, [
      // Plane y = 0 crossed halfway.
      'particle_hit_plane(vec3f(0.0, 1.0, 0.0), vec3f(0.0, -1.0, 0.0), vec4f(0.0, 1.0, 0.0, 0.0)).w',
      // Missed.
      'particle_hit_plane(vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.5, 0.0), vec4f(0.0, 1.0, 0.0, 0.0)).w',
      // A ball of radius 1 entered at x = -1 on a segment from -3 to 3.
      'particle_hit_sphere(vec3f(-3.0, 0.0, 0.0), vec3f(3.0, 0.0, 0.0), vec3f(0.0), 1.0, false).w',
      'particle_hit_sphere(vec3f(-3.0, 0.0, 0.0), vec3f(3.0, 0.0, 0.0), vec3f(0.0), 1.0, false).x',
      // A container of radius 2 left at x = 2 on a segment from 0 to 4.
      'particle_hit_sphere(vec3f(0.0), vec3f(4.0, 0.0, 0.0), vec3f(0.0), 2.0, true).w',
      'particle_hit_sphere(vec3f(0.0), vec3f(4.0, 0.0, 0.0), vec3f(0.0), 2.0, true).x',
      // A thin box crossed entirely within the segment.
      'particle_hit_box(vec3f(-1.0, 0.0, 0.0), vec3f(3.0, 0.0, 0.0), vec3f(1.0, 0.0, 0.0), vec3f(0.01, 1.0, 1.0), false).w',
      'particle_hit_box(vec3f(-1.0, 0.0, 0.0), vec3f(3.0, 0.0, 0.0), vec3f(1.0, 0.0, 0.0), vec3f(0.01, 1.0, 1.0), false).x',
      // Starting inside a solid ball: t = 0.
      'particle_hit_sphere(vec3f(0.5, 0.0, 0.0), vec3f(0.6, 0.0, 0.0), vec3f(0.0), 1.0, false).w',
      // Bounce: (3, -4) on a floor with restitution 0.5 and friction 0.25.
      'particle_respond(vec3f(3.0, -4.0, 0.0), vec3f(0.0, 1.0, 0.0), 0.5, 0.25).x',
      'particle_respond(vec3f(3.0, -4.0, 0.0), vec3f(0.0, 1.0, 0.0), 0.5, 0.25).y',
      // Point force: at the softening radius the attraction is half its strength.
      'particle_point_force(vec3f(1.0, 0.0, 0.0), vec3f(0.0), vec3f(0.0, 0.0, 1.0), 2.0, 0.0, 1.0).x',
      'particle_point_force(vec3f(1.0, 0.0, 0.0), vec3f(0.0), vec3f(0.0, 0.0, 1.0), 0.0, 2.0, 1.0).y',
    ]);
    expect(v[0]).toBeCloseTo(0.5, 5);
    expect(v[1]!).toBeLessThan(0);
    expect(v[2]).toBeCloseTo(2 / 6, 5);
    expect(v[3]).toBeCloseTo(-1, 5);
    expect(v[4]).toBeCloseTo(0.5, 5);
    expect(v[5]).toBeCloseTo(-1, 5);
    expect(v[6]).toBeCloseTo(1.99 / 4, 4);
    expect(v[7]).toBeCloseTo(-1, 5);
    expect(Math.abs(v[8]!)).toBe(0);
    expect(v[9]).toBeCloseTo(2.25, 5);
    expect(v[10]).toBeCloseTo(2, 5);
    expect(v[11]).toBeCloseTo(-1, 5);
    expect(v[12]).toBeCloseTo(1, 5);
  });
});

// --- Cost (opt-in) -------------------------------------------------------------------------------
//
// PARTICLE_BENCH=1 npx vitest run tests/particles.test.ts -t "cost"
// One unit is eight simulation steps plus the sprite-writing kernel, measured as the slope of one
// more unit in the same command buffer (tests/bench.ts). Prints a table; asserts nothing.

describe.runIf(process.env.PARTICLE_BENCH)('cost', () => {
  it('follows the live count, not the capacity', { timeout: 600_000 }, async () => {
    const { createBenchDevice } = await import('./bench.ts');
    const bench = await createBenchDevice();
    const rows: string[] = [];
    const cases: [number, number][] = [
      [65536, 50000],
      [262144, 50000],
      [1048576, 50000],
      [262144, 250000],
      [1048576, 250000],
      [1048576, 1000000],
    ];
    for (const turbulence of ['none', '2d'] as const) {
      for (const [capacity, target] of cases) {
        const system = createParticleSystem({
          device: bench.device,
          capacity,
          dimension: 2,
          profiler: bench.profiler,
        });
        const life = 1;
        system.addEmitter({
          shape: 'box',
          extent: [1, 0.5, 0],
          speed: [0.1, 0.3],
          spread: 1,
          life: [life, life],
          rate: target / life,
        });
        system.forces.gravity = [0, -0.5, 0];
        system.forces.turbulence = turbulence;
        system.forces.turbulenceStrength = 0.5;
        const camera = createUniformBuffer(bench.device, CameraUniform, 'bench camera');
        const renderer = createParticleRenderer(system, {
          camera: camera.buffer,
          profiler: bench.profiler,
        });
        system.warmup(1.5, 1 / 60);
        // Eight steps and one sprite write per unit: Dawn quantises timestamps (65 us steps here),
        // so a unit must be long enough for the slope to mean something. Reported per step.
        const steps = 8;
        const result = await bench.measure((encoder) => {
          system.step(encoder, steps);
          renderer.encode(encoder, 1 / 60);
        });
        const live = (await system.readStats()).alive;
        rows.push(
          `${turbulence.padEnd(5)} capacity ${String(capacity).padStart(8)}  live ${String(live).padStart(8)}  ` +
            `${(result.slopeMs / steps).toFixed(3)} ms per step (unit ${result.slopeMinMs.toFixed(2)}..${result.slopeMaxMs.toFixed(2)} ms, ${result.metric})`,
        );
        renderer.destroy();
        camera.destroy();
        system.destroy();
      }
    }
    console.log(`particle step (+ 1/8 of a sprite write):\n${rows.join('\n')}`);
    bench.destroy();
  });

  // Thousands of spawn requests a step: the sparkler forking at 200 000 sparks a second and the
  // spark shower splitting at 20 000, each against itself with the GPU events off. What the
  // difference costs is the spawn planning (and the emit kernel's search of the requests).
  it('plans thousands of spawn requests a step', { timeout: 600_000 }, async () => {
    const { createBenchDevice } = await import('./bench.ts');
    const sparkler = await import('../src/effects/sparkler/sparkler.ts');
    const shower = await import('../src/effects/spark-shower/shower.ts');
    const bench = await createBenchDevice();
    const rows: string[] = [];
    const measure = async (name: string, system: ParticleSystem) => {
      system.warmup(1.5, 1 / 60);
      const steps = 8;
      const result = await bench.measure((encoder) => system.step(encoder, steps));
      const stats = await system.readStats();
      rows.push(
        `${name.padEnd(28)} live ${String(stats.alive).padStart(7)}  ` +
          `${(result.slopeMs / steps).toFixed(3)} ms per step  ` +
          `(${((result.slopeMs / steps / Math.max(stats.alive, 1)) * 1e6).toFixed(2)} ns a particle, ` +
          `dropped spawns ${stats.droppedSpawns}, ${result.metric})`,
      );
      system.destroy();
    };
    for (const forks of [false, true]) {
      const sim = sparkler.createSparklerSim(bench.device, {
        capacity: 131072,
        queueCapacity: 16384,
        profiler: bench.profiler,
      });
      sparkler.applySparkler(sim, {
        ...sparkler.DEFAULT_SPARKLER,
        rate: 200000,
        forkChance: forks ? sparkler.DEFAULT_SPARKLER.forkChance : 0,
      });
      sim.tip.jumpTo([0.8, 0.5, 0]);
      await measure(`sparkler 200k/s, forks ${forks ? 'on' : 'off'}`, sim.system);
    }
    for (const split of [false, true]) {
      const sim = shower.createShowerSim(bench.device, {
        capacity: 131072,
        queueCapacity: 4096,
        profiler: bench.profiler,
      });
      const settings = { ...shower.DEFAULT_SHOWER, rate: 20000, children: split ? 3 : 0 };
      shower.applyShower(sim, settings);
      sim.source.jumpTo([0.3, 0.6, 0]);
      shower.setShowerColliders(sim, {
        boxes: [0.4, 0.8, 1.2].map((x) => ({
          type: 'box' as const,
          center: [x, 0.3, 0] as const,
          half: [0.12, 0.05, 1] as const,
        })),
        restitution: settings.restitution,
        friction: settings.friction,
      });
      await measure(`spark-shower 20k/s, split ${split ? 'on' : 'off'}`, sim.system);
    }
    console.log(`spawn planning (one step):\n${rows.join('\n')}`);
    bench.destroy();
  });
});
