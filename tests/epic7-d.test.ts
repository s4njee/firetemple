import { describe, expect, it, vi } from 'vitest';
import {
  aimAngle,
  angleDelta,
  jetImpulse,
  modeGeometry,
  throttle,
  uvAlong,
} from '../src/effects/fire-jet/jet.ts';
import jetHooks from '../src/effects/fire-jet/hooks.wgsl';
import {
  AMBIENT,
  baseShape,
  breath,
  DRAG,
  DRIVE_SHARE,
  END_TEMPERATURE,
  flameCapacity,
  flamePhysics,
} from '../src/effects/particle-flame/flame.ts';
import { toHalf } from '../src/gpu/emission/half-float.ts';
import {
  createParticleSystem,
  overlayFieldMapping,
  type ParticleSnapshot,
  type ParticleSystem,
} from '../src/gpu/particles/index.ts';
import type { FireFluid } from '../src/gpu/sim/fire-fluid.ts';
import { halfToFloat } from '../src/gpu/sim/fluid.ts';
import { expectValid, getTestDevice, readTexture } from './gpu.ts';
import { mountHeadless, sendPointer, type HeadlessEffect } from './headless.ts';

// Stories 7.4 (particle flame) and 7.8 (directed jet), on the particle framework of 7.1. Small
// canvases, small pools and a few seconds of simulation, so it runs on a software rasteriser.

vi.setConfig({ testTimeout: 120_000 });

interface Live {
  position: [number, number];
  velocity: [number, number];
  age: number;
  life: number;
  temperature: number;
  kind: number;
  slot: number;
}

function live(snapshot: ParticleSnapshot): Live[] {
  const kinds = new Uint32Array(snapshot.attributes.buffer);
  return Array.from(snapshot.alive, (slot) => {
    const o = slot * 4;
    return {
      slot,
      position: [snapshot.positions[o]!, snapshot.positions[o + 1]!],
      velocity: [snapshot.velocities[o]!, snapshot.velocities[o + 1]!],
      age: snapshot.positions[o + 3]!,
      life: snapshot.velocities[o + 3]!,
      temperature: snapshot.attributes[o]!,
      kind: kinds[o + 3]!,
    };
  });
}

const mean = (values: readonly number[]) =>
  values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);

/** The effect's own particle system (the instance exposes it for tests). */
const systemOf = (h: HeadlessEffect) =>
  (h.instance as unknown as { system: ParticleSystem | undefined }).system!;

// --- 7.4 Particle flame ----------------------------------------------------------------------------

describe('particle flame numbers', () => {
  it('cools the mean particle to the end temperature in its life, lifts it the flame height, and drives as a share', () => {
    const inputs = { count: 2000, life: 1, height: 0.5, temperature: 1900 };
    const calm = flamePhysics(inputs, 0);
    const end = AMBIENT + (1900 - AMBIENT) * Math.exp(-calm.cooling * 1);
    expect(end).toBeCloseTo(END_TEMPERATURE, 6);
    // Terminal speed averaged over the cooling, times the life, is the height.
    const k = calm.cooling;
    const meanExcess = ((1900 - AMBIENT) * (1 - Math.exp(-k))) / k;
    expect((calm.buoyancy * meanExcess) / 1000 / DRAG).toBeCloseTo(0.5, 9);
    expect(calm.rate).toBeCloseTo(2000, 9);
    expect(flamePhysics(inputs, 1).rate).toBeCloseTo(2000 * (1 + DRIVE_SHARE), 9);
    expect(flamePhysics(inputs, Number.NaN).rate).toBe(calm.rate);
    expect(flameCapacity(2500)).toBe(8192);
    expect(flameCapacity(10)).toBe(2048);
    // A line of fire never runs off a narrow canvas; a campfire keeps its width on a wide one.
    expect(baseShape('line', 0.5).half).toBeCloseTo((0.92 * 0.5) / 2, 9);
    expect(baseShape('campfire', 16 / 9).half).toBeCloseTo(0.1, 9);
    expect(baseShape('nonsense', 1).shape).toBe(baseShape('campfire', 1).shape);
    // The breath stays within its amount and is slow.
    for (let t = 0; t < 10; t += 0.05) {
      expect(Math.abs(breath(t, 0.1) - 1)).toBeLessThanOrEqual(0.1 + 1e-9);
    }
  });
});

describe('particle flame effect', () => {
  const quiet = { count: 400, embers: 0, bloom: 0, wind: 0 };

  it('rises with age, cools monotonically, and holds a steady count after warm-up', async () => {
    const h = await mountHeadless('particle-flame', { width: 160, height: 90, params: quiet });
    h.step(1);
    await h.device.queue.onSubmittedWorkDone();
    const system = systemOf(h);
    const counts: number[] = [];
    for (const t of [0.5, 1, 1.5, 2]) {
      await h.runTo(t);
      counts.push((await system.readStats()).alive);
    }
    // Little's law: about `count` alive, and steady.
    const average = mean(counts);
    expect(average).toBeGreaterThan(400 * 0.75);
    expect(average).toBeLessThan(400 * 1.25);
    for (const c of counts) expect(Math.abs(c - average) / average).toBeLessThan(0.15);

    const before = live(await system.read()).filter((p) => p.kind === 0);
    // Mean height and mean temperature by age: rising, cooling.
    const bins = [0, 0.25, 0.5, 0.75, 1].map((x) => x * 1.2);
    const height: number[] = [];
    const heat: number[] = [];
    for (let b = 0; b + 1 < bins.length; b++) {
      const inside = before.filter((p) => p.age >= bins[b]! && p.age < bins[b + 1]!);
      expect(inside.length).toBeGreaterThan(10);
      height.push(mean(inside.map((p) => p.position[1])));
      heat.push(mean(inside.map((p) => p.temperature)));
    }
    for (let b = 1; b < height.length; b++) {
      expect(height[b]!).toBeGreaterThan(height[b - 1]!);
      expect(heat[b]!).toBeLessThan(heat[b - 1]!);
    }

    // Each particle that is still alive a few frames later is cooler than it was.
    h.step(6);
    const after = new Map(live(await system.read()).map((p) => [p.slot, p]));
    let checked = 0;
    for (const p of before) {
      const q = after.get(p.slot);
      // The same particle: same slot, a little older (a recycled slot would be younger).
      if (!q || q.age <= p.age) continue;
      expect(q.temperature).toBeLessThan(p.temperature);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
    h.destroy();
  });

  it('lights a fire where the pointer is pressed, and throws embers off the tips', async () => {
    const h = await mountHeadless('particle-flame', {
      width: 160,
      height: 90,
      params: { ...quiet, embers: 30 },
    });
    h.step(1);
    // Press well away from the campfire, at the upper left.
    sendPointer(h.canvas, 'pointerdown', 0.2, 0.4, 0);
    for (let k = 1; k <= 30; k++) {
      sendPointer(h.canvas, 'pointermove', 0.2, 0.4, k * 16);
      h.step(1);
    }
    await h.device.queue.onSubmittedWorkDone();
    const particles = live(await systemOf(h).read());
    const aspect = 160 / 90;
    const fire = particles.filter((p) => p.kind === 2);
    expect(fire.length).toBeGreaterThan(30);
    // Born at the press (x 0.2, y 0.6 up from the bottom), and above it.
    expect(mean(fire.map((p) => p.position[0]))).toBeCloseTo(0.2 * aspect, 1);
    for (const p of fire) expect(p.position[1]).toBeGreaterThan(0.6 - 0.05);
    // Embers come from dying flame particles, spawned on the GPU.
    expect(particles.filter((p) => p.kind === 1).length).toBeGreaterThan(0);
    sendPointer(h.canvas, 'pointerup', 0.2, 0.4, 600);
    // After release the pointer fire dies down.
    await h.runTo(h.time.time + 4);
    expect(live(await systemOf(h).read()).filter((p) => p.kind === 2).length).toBe(0);
    h.destroy();
  });
});

// --- 7.8 Directed jet ------------------------------------------------------------------------------

describe('directed jet geometry', () => {
  it('aims at the pointer within its reach, sweeps when idle, breathes in smooth breaths', () => {
    const aspect = 16 / 9;
    const g = modeGeometry('flamethrower');
    // Straight right of the nozzle, then straight above it.
    expect(aimAngle('flamethrower', aspect, 0, [0.9, g.nozzle[1]])).toBeCloseTo(0, 9);
    expect(aimAngle('flamethrower', aspect, 0, [g.nozzle[0], 0.1])).toBeCloseTo(
      g.rest + g.reach,
      9,
    );
    // Behind the nozzle is out of reach: clamped to the edge of the cone.
    const back = aimAngle('flamethrower', aspect, 0, [0, g.nozzle[1] + 0.01]);
    expect(Math.abs(angleDelta(back, g.rest))).toBeCloseTo(g.reach, 9);
    for (let t = 0; t < 20; t += 0.1) {
      const idle = aimAngle('flamethrower', aspect, t);
      expect(Math.abs(angleDelta(idle, g.rest))).toBeLessThanOrEqual(g.swing + 1e-9);
    }
    // A point along the aim is that far away in canvas heights.
    const p = uvAlong([0.2, 0.5], 0.5, 0.3, aspect);
    expect(Math.hypot((p[0] - 0.2) * aspect, p[1] - 0.5)).toBeCloseTo(0.3, 9);
    expect(p[1]).toBeLessThan(0.5); // up the canvas is down in uv
    // Breaths: 0 and 1 with half-second ramps, never a step.
    expect(throttle('flamethrower', 3)).toBe(1);
    let last = throttle('dragon breath', 0);
    for (let t = 0; t < 10; t += 1 / 60) {
      const now = throttle('dragon breath', t);
      expect(Math.abs(now - last)).toBeLessThan(0.06);
      last = now;
    }
    // The push is proportional to the time simulated, and capped.
    expect(jetImpulse(1.6, 1, 1 / 60, 0.08)).toBeCloseTo((1.6 * 1.6) / 0.08 / 60, 9);
    expect(jetImpulse(1.6, 100, 1 / 60, 0.08)).toBeCloseTo(1.6, 9);
  });
});

/** A W x H rgba16float texture of velocities (texel x, y; image heights per second, y down). */
function velocityTexture(
  device: GPUDevice,
  w: number,
  h: number,
  at: (u: number, v: number) => [number, number],
): GPUTexture {
  const texture = device.createTexture({
    size: [w, h],
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const data = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [vx, vy] = at((x + 0.5) / w, (y + 0.5) / h);
      data.set([toHalf(vx), toHalf(vy), 0, 0], (y * w + x) * 4);
    }
  }
  device.queue.writeTexture({ texture }, data, { bytesPerRow: w * 8 }, [w, h]);
  return texture;
}

async function run(system: ParticleSystem, steps: number): Promise<void> {
  for (let done = 0; done < steps; done += 16) {
    const encoder = system.device.createCommandEncoder();
    system.step(encoder, Math.min(16, steps - done));
    system.device.queue.submit([encoder.finish()]);
  }
  await system.device.queue.onSubmittedWorkDone();
}

describe('particles in a velocity field', () => {
  const aspect = 2;

  it('follows a vortex as sampled, through the overlay mapping (y flipped)', async () => {
    const device = await getTestDevice();
    // Solid rotation, anticlockwise on screen (y up), omega 2 rad/s about the canvas centre. As a
    // texture: uv top-left, y down, so the texel's y velocity is minus the screen's.
    const omega = 2;
    const cx = aspect / 2;
    const cy = 0.5;
    const texture = velocityTexture(device, 32, 16, (u, v) => {
      const x = u * aspect;
      const y = 1 - v;
      return [-omega * (y - cy), -(omega * (x - cx))];
    });
    const system = createParticleSystem({
      device,
      capacity: 8,
      dimension: 2,
      field: texture.createView(),
    });
    system.forces.field = 'advect';
    system.forces.fieldMapping = overlayFieldMapping(aspect);
    system.addEmitter({ position: [cx + 0.25, cy, 0], life: [100, 100] }).burst(1);
    const steps = 30;
    await expectValid(device, () => run(system, steps));
    const [p] = live(await system.read());
    // A linear field is reproduced exactly by bilinear filtering, so the tracer follows the discrete
    // (forward Euler) rotation: each step turns by atan(omega h) and grows the radius by
    // sqrt(1 + (omega h)^2). The burst particle is born at the end of the first step.
    const h = 1 / 60;
    const n = steps - 1;
    const angle = n * Math.atan(omega * h);
    const radius = 0.25 * Math.pow(1 + (omega * h) ** 2, n / 2);
    expect(p!.position[0]).toBeCloseTo(cx + radius * Math.cos(angle), 2);
    expect(p!.position[1]).toBeCloseTo(cy + radius * Math.sin(angle), 2);
    // Anticlockwise on screen: it went up from the right of the centre.
    expect(p!.position[1]).toBeGreaterThan(cy + 0.1);
    system.destroy();
    texture.destroy();
  });

  it("drags the jet's flame sprites onto a uniform stream, faster than its droplets", async () => {
    const device = await getTestDevice();
    // A stream to the right and up the screen: texel (0.6, -0.3), y down.
    const texture = velocityTexture(device, 8, 4, () => [0.6, -0.3]);
    const system = createParticleSystem({
      device,
      capacity: 8,
      dimension: 2,
      field: texture.createView(),
      hooks: { code: jetHooks.code, chunks: jetHooks.chunks },
    });
    system.forces.field = 'drag';
    system.forces.fieldCoupling = 2.2;
    system.forces.fieldMapping = overlayFieldMapping(aspect);
    // No droplet gravity, flames coupled 7 / s on top, no shedding, no lift.
    system.params.user[0] = [0, 7, 0, 0];
    system.params.user[1] = [0, 0, 0, 0];
    system.params.user[2] = [0, 0, 0, 0];
    system.addEmitter({ position: [0.5, 0.5, 0], life: [100, 100], kind: 0 }).burst(1);
    system.addEmitter({ position: [1.5, 0.5, 0], life: [100, 100], kind: 1 }).burst(1);
    await expectValid(device, () => run(system, 30));
    const [droplet, flame] = live(await system.read()).sort((a, b) => a.kind - b.kind);
    // Both head for (0.6, 0.3) on screen; the flame is nearly there, the droplet a share of the way.
    expect(flame!.velocity[0]).toBeCloseTo(0.6, 1);
    expect(flame!.velocity[1]).toBeCloseTo(0.3, 1);
    const t = 29 / 60;
    expect(droplet!.velocity[0]).toBeCloseTo(0.6 * (1 - Math.exp(-2.2 * t)), 2);
    expect(droplet!.velocity[0]).toBeLessThan(flame!.velocity[0] * 0.75);
    system.destroy();
    texture.destroy();
  });
});

/** The velocity (overlay space: y up) of the fluid's resolved fields at uv. */
async function fluidVelocity(device: GPUDevice, fire: FireFluid, uv: readonly [number, number]) {
  const texture = fire.fluid.fields;
  const bytes = await readTexture(device, texture, 8);
  const half = new Uint16Array(bytes.buffer, bytes.byteOffset, texture.width * texture.height * 4);
  const x = Math.min(texture.width - 1, Math.floor(uv[0] * texture.width));
  const y = Math.min(texture.height - 1, Math.floor(uv[1] * texture.height));
  const o = (y * texture.width + x) * 4;
  return [halfToFloat(half[o]!), -halfToFloat(half[o + 1]!)] as const;
}

describe('directed jet effect', () => {
  const small = { resolution: '96', bloom: 0, droplets: 200, flames: 300, shed: 4 };

  it('blows the gas along the aim at the nozzle, and launches droplets along it before they slow', async () => {
    const h = await mountHeadless('fire-jet', { width: 192, height: 108, params: small });
    await h.runTo(1.5);
    const instance = h.instance as unknown as { fire: FireFluid; aim: number };
    const aim = instance.aim;
    const direction = [Math.cos(aim), Math.sin(aim)] as const;
    const aspect = 192 / 108;
    const nozzle = modeGeometry('flamethrower').nozzle;

    // The fluid just past the mouth moves along the aim at a good share of the jet speed.
    const v = await fluidVelocity(h.device, instance.fire, uvAlong(nozzle, aim, 0.06, aspect));
    const speed = Math.hypot(v[0], v[1]);
    expect(speed).toBeGreaterThan(0.5 * 1.4);
    expect((v[0] * direction[0] + v[1] * direction[1]) / speed).toBeGreaterThan(0.9);

    const particles = live(await systemOf(h).read());
    const mouth = [nozzle[0] * aspect, 1 - nozzle[1]] as const;
    const young = particles.filter((p) => p.kind === 0 && p.age < 0.15);
    const old = particles.filter((p) => p.kind === 0 && p.age > 0.7);
    expect(young.length).toBeGreaterThan(5);
    expect(old.length).toBeGreaterThan(5);
    for (const p of young) {
      const s = Math.hypot(p.velocity[0], p.velocity[1]);
      expect((p.velocity[0] * direction[0] + p.velocity[1] * direction[1]) / s).toBeGreaterThan(
        0.97,
      );
      // Out of the mouth and down the barrel, not to the side.
      const dx = p.position[0] - mouth[0];
      const dy = p.position[1] - mouth[1];
      expect(dx * direction[0] + dy * direction[1]).toBeGreaterThan(0);
      expect(Math.abs(dx * direction[1] - dy * direction[0])).toBeLessThan(0.03);
    }
    // Further on they have slowed: dragged towards gas that slows down as it spreads.
    const speedOf = (ps: Live[]) => mean(ps.map((p) => Math.hypot(p.velocity[0], p.velocity[1])));
    expect(speedOf(old)).toBeLessThan(0.75 * speedOf(young));
    h.destroy();
  });

  it('turns the nozzle towards the pointer', async () => {
    const h = await mountHeadless('fire-jet', { width: 192, height: 108, params: small });
    h.step(2);
    const nozzle = modeGeometry('flamethrower').nozzle;
    // Up and to the right of the nozzle, 45 degrees on screen.
    const target: [number, number] = [nozzle[0] + 0.3 / (192 / 108), nozzle[1] - 0.3];
    for (let k = 0; k < 40; k++) {
      sendPointer(h.canvas, 'pointermove', target[0], target[1], k * 16);
      h.step(1);
    }
    const aim = (h.instance as unknown as { aim: number }).aim;
    expect(aim).toBeCloseTo(Math.PI / 4, 2);
    await h.device.queue.onSubmittedWorkDone();
    h.destroy();
  });
});
