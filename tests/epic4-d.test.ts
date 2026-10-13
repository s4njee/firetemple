import { describe, expect, it, vi } from 'vitest';
import ringMath from '../src/effects/fire-ring/ring-math.wgsl?raw';
import { sparkPositions } from '../src/effects/toon-fire/sparks.ts';
import { createSteppedClock } from '../src/effects/toon-fire/stepped.ts';
import { mountHeadless } from './headless.ts';
import { gpuF32, lane, rowsOf } from './wgsl-eval.ts';

// Epic 4, the parts with logic worth pinning down in numbers: the fire ring's seamless wrap and
// its progress arc, the toon fire's stepped clock, and the haze overlay leaving cold air alone.

vi.setConfig({ testTimeout: 60_000 });

/** Runs a WGSL body that returns a vec4f from the input row `x`, with ring-math.wgsl in scope. */
const ring = (body: string, tuples: number[][]) =>
  gpuF32(`${ringMath}\nfn f(x: vec4f) -> vec4f { ${body} }`, rowsOf(tuples));

describe('fire ring geometry (ring-math.wgsl)', () => {
  it('measures turns clockwise from twelve o’clock', async () => {
    const out = lane(
      await ring('return vec4f(ring_turn(x.xy), 0.0, 0.0, 0.0);', [
        [0, 1],
        [1, 0],
        [-1, 0],
        [1, 1],
        [0.001, -1],
        [-0.001, -1],
      ]),
      0,
    );
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(0.25, 6);
    expect(out[2]).toBeCloseTo(-0.25, 6);
    expect(out[3]).toBeCloseTo(0.125, 6);
    // The jump is at six o'clock: just clockwise of it is +0.5, just past it -0.5.
    expect(out[4]).toBeCloseTo(0.5, 3);
    expect(out[5]).toBeCloseTo(-0.5, 3);
  });

  it('puts the two sides of the jump a whole number of noise tiles apart', async () => {
    // Points a hair either side of six o'clock, for every repeat count the effect allows and a
    // few rotations. A repeating sampler sees the same texel when u differs by an integer.
    const cases: number[][] = [];
    for (let repeats = 1; repeats <= 9; repeats++) {
      for (const rotation of [0, 0.37, -2.6]) cases.push([repeats, rotation, 0.3, 0]);
    }
    const out = await ring(
      `let before = ring_noise_uv(ring_turn(vec2f(1e-5, -1.0)), x.z, x.x, x.y);
       let after = ring_noise_uv(ring_turn(vec2f(-1e-5, -1.0)), x.z, x.x, x.y);
       return vec4f(before.x - after.x, before.y - after.y, 0.0, 0.0);`,
      cases,
    );
    const du = lane(out, 0);
    const dv = lane(out, 1);
    cases.forEach(([repeats], index) => {
      expect(du[index]! / repeats!).toBeCloseTo(1, 3);
      expect(Math.abs(du[index]! - Math.round(du[index]!))).toBeLessThan(1e-3);
      expect(dv[index]).toBe(0);
    });
  });

  it('lights exactly the arc that `progress` names', async () => {
    const lit = async (list: number[][]) =>
      lane(await ring('return vec4f(ring_lit(x.x, x.y, x.z, 0.03, x.w), 0.0, 0.0, 0.0);', list), 0);

    // (turn, start, progress, taper)
    const full: number[][] = [];
    const none: number[][] = [];
    for (let i = 0; i < 64; i++) {
      const turn = i / 64 - 0.5;
      for (const [start, taper] of [
        [0, 0],
        [0.3, 0.8],
        [-4.7, 1],
      ] as const) {
        full.push([turn, start, 1, taper]);
        none.push([turn, start, 0, taper]);
      }
    }
    // A whole ring has no ends, whatever the start or the taper: this is the other half of
    // "seamless", and a float just under 1 here would show as a dark notch at the start.
    for (const value of await lit(full)) expect(value).toBe(1);
    for (const value of await lit(none)) expect(value).toBe(0);

    // Half a ring from twelve o'clock: three o'clock is alight, nine o'clock is not.
    const half = await lit([
      [0.25, 0, 0.5, 0],
      [-0.25, 0, 0.5, 0],
      [0.25 + 3, 0, 0.5, 0],
      [0.35, 0.1, 0.5, 0],
      [0.55, 0.3, 0.5, 0],
    ]);
    expect(half[0]).toBe(1);
    expect(half[1]).toBe(0);
    // Periodic in the turn, and a later start carries the arc round with it.
    expect(half[2]).toBe(1);
    expect(half[3]).toBe(1);
    expect(half[4]).toBe(1);

    // The lit share of the ring grows with progress and is close to it.
    const samples = 400;
    let previous = -1;
    for (const progress of [0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const values = await lit(
        Array.from({ length: samples }, (_, i) => [(i + 0.5) / samples - 0.5, 0, progress, 0]),
      );
      const share = values.reduce((sum, v) => sum + v, 0) / samples;
      expect(share).toBeGreaterThan(previous);
      expect(Math.abs(share - progress)).toBeLessThan(0.04);
      previous = share;
    }
  });

  it('tapers the trailing end and not the leading one', async () => {
    const out = lane(
      await ring('return vec4f(ring_lit(x.x, 0.0, 0.4, 0.03, x.y), 0.0, 0.0, 0.0);', [
        [0.04, 1],
        [0.2, 1],
        [0.36, 1],
        [0.04, 0],
      ]),
      0,
    );
    expect(out[0]).toBeLessThan(out[1]!);
    expect(out[1]).toBeLessThan(out[2]!);
    expect(out[2]).toBeGreaterThan(0.95);
    // Without a taper the same point near the start is fully alight.
    expect(out[3]).toBe(1);
  });
});

describe('fire ring picture', () => {
  it('has no seam where the angle wraps', async () => {
    const size = 256;
    const mounted = await mountHeadless('fire-ring', {
      width: size,
      height: size,
      params: { innerGlow: 0, alpha: 'opaque', underlay: 0, bloom: 0 },
    });
    // The flame annulus of the default ring, in pixels from the centre.
    const radius = (mounted.params.radius as number) * (size / 2);
    const from = Math.round(radius + 3);
    const to = Math.round(radius + 0.3 * (mounted.params.length as number) * (size / 2));
    expect(to - from).toBeGreaterThan(6);

    let seam = 0;
    let elsewhere = 0;
    let lit = 0;
    for (const seconds of [0.5, 1.3, 2.1]) {
      await mounted.runTo(seconds);
      const rgba = await mounted.read();
      const at = (x: number, y: number, channel: number) => rgba[(y * size + x) * 4 + channel]!;
      for (let r = from; r <= to; r++) {
        for (let channel = 0; channel < 3; channel++) {
          // Six o'clock, where ring_turn jumps: the two columns either side of the centre line.
          const below = size / 2 + r;
          seam += Math.abs(at(size / 2 - 1, below, channel) - at(size / 2, below, channel));
          // Twelve, three and nine o'clock, where nothing wraps: the same pair of neighbours.
          const above = size / 2 - 1 - r;
          elsewhere += Math.abs(at(size / 2 - 1, above, channel) - at(size / 2, above, channel));
          elsewhere += Math.abs(at(below, size / 2 - 1, channel) - at(below, size / 2, channel));
          elsewhere += Math.abs(at(above, size / 2 - 1, channel) - at(above, size / 2, channel));
          lit += at(size / 2, below, channel);
        }
      }
    }
    mounted.destroy();
    const count = 3 * (to - from + 1) * 3;
    // There is flame there to have a seam in.
    expect(lit / count).toBeGreaterThan(40);
    // Neighbouring pixels across the wrap differ no more than neighbours anywhere else do. A
    // seam (two unrelated pieces of noise side by side) would be tens of 8-bit steps.
    expect(seam / count).toBeLessThan(Math.max(2 * (elsewhere / (3 * count)), 6));
  });
});

describe('stepped clock (toon fire)', () => {
  const run = (frames: number, fps: number, rate: number, speed = 1) => {
    const clock = createSteppedClock();
    const shown: number[] = [];
    const phase: number[] = [];
    for (let i = 0; i < frames; i++) {
      shown.push(clock.advance(1 / fps, speed, rate));
      phase.push(clock.phase);
    }
    return { clock, shown, phase };
  };

  /** Lengths of the runs of equal values. */
  const holds = (values: number[]) => {
    const runs: number[] = [];
    let length = 0;
    values.forEach((value, i) => {
      if (i > 0 && value !== values[i - 1]) {
        runs.push(length);
        length = 0;
      }
      length++;
    });
    runs.push(length);
    return runs;
  };

  it('holds each drawing for the same number of frames, at any display rate', () => {
    for (const [fps, rate, each] of [
      [60, 10, 6],
      [120, 10, 12],
      [60, 12, 5],
      [60, 8, 7.5],
    ] as const) {
      const { shown } = run(fps * 4, fps, rate);
      // Drop the first and last runs, which the start and the end of the test cut short.
      const runs = holds(shown).slice(1, -1);
      expect(runs.length).toBeGreaterThanOrEqual(rate * 4 - 2);
      for (const length of runs) {
        expect(length).toBeGreaterThanOrEqual(Math.floor(each));
        expect(length).toBeLessThanOrEqual(Math.ceil(each));
      }
      // Drawings per second, exactly: 60 Hz and 8 a second alternates 7 and 8 frames.
      expect(runs.reduce((sum, length) => sum + length, 0) / runs.length).toBeCloseTo(each, 1);
    }
  });

  it('draws from the smooth clock: never ahead of it, never backwards, level with it at a step', () => {
    const { shown, phase } = run(600, 60, 10, 1.7);
    shown.forEach((value, i) => {
      expect(value).toBeLessThanOrEqual(phase[i]!);
      // At most one step behind.
      expect(phase[i]! - value).toBeLessThan((1.7 / 10) * 1.01);
      if (i > 0) {
        expect(value).toBeGreaterThanOrEqual(shown[i - 1]!);
        if (value !== shown[i - 1]) expect(value).toBe(phase[i]);
      }
    });
  });

  it('does not let the step rate change where the animation is', () => {
    const stepped = run(333, 60, 10, 1.3);
    const smooth = run(333, 60, 0, 1.3);
    const fast = run(333, 60, 24, 1.3);
    expect(stepped.clock.phase).toBe(smooth.clock.phase);
    expect(fast.clock.phase).toBe(smooth.clock.phase);
    // A rate of zero is no stepping at all: every frame is a new drawing.
    smooth.shown.forEach((value, i) => expect(value).toBe(smooth.phase[i]));
    expect(smooth.clock.drawings).toBe(333);
  });

  it('keeps time when frames are uneven, and survives a change of rate or speed', () => {
    const clock = createSteppedClock();
    let seconds = 0;
    let state = 12345;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    while (seconds < 10) {
      const delta = 0.004 + 0.03 * random();
      clock.advance(delta, 1, 10);
      seconds += delta;
    }
    // Ten a second for ten seconds, give or take the one in progress.
    expect(Math.abs(clock.drawings - 100)).toBeLessThanOrEqual(1);

    const before = clock.shown;
    const next = clock.advance(1 / 60, 3, 4);
    // A new rate draws at once, from where the animation is now: no jump back, no leap forward.
    expect(next).toBe(clock.phase);
    expect(next - before).toBeLessThan(0.1 + 3 / 60 + 1e-9);
    expect(next).toBeGreaterThanOrEqual(before);
  });

  it('wraps the phase without stalling', () => {
    const clock = createSteppedClock(2);
    for (let i = 0; i < 600; i++) {
      const shown = clock.advance(1 / 60, 1, 10);
      expect(shown).toBeGreaterThanOrEqual(0);
      expect(shown).toBeLessThan(2);
    }
    expect(clock.drawings).toBeGreaterThan(95);
  });
});

describe('toon fire sparks', () => {
  it('stay inside the strip the shader looks for them in', () => {
    const strip = 0.32;
    const wobble = 0.045;
    // The shader only runs its spark loop for 0.36 < y < 1.4 and |x| < 1.7 strip + wobble + 0.05.
    for (let step = 0; step < 4000; step++) {
      const sparks = sparkPositions(step * 0.0371, 12, strip, wobble);
      expect(sparks).toHaveLength(48);
      for (let i = 0; i < 12; i++) {
        const [x, y, size] = sparks.slice(i * 4, i * 4 + 3) as [number, number, number];
        expect(size).toBeGreaterThanOrEqual(0);
        expect(size).toBeLessThanOrEqual(0.036);
        expect(y - size).toBeGreaterThanOrEqual(0.36);
        expect(y + size).toBeLessThan(1.4);
        expect(Math.abs(x) + size).toBeLessThan(1.7 * strip + wobble + 0.05);
      }
    }
  });

  it('are spread out, and each one rises and starts again', () => {
    const at = (time: number) => sparkPositions(time, 12, 0.3, 0);
    const first = at(0);
    const starts = new Set(Array.from({ length: 12 }, (_, i) => first[i * 4]!.toFixed(3)));
    expect(starts.size).toBeGreaterThan(9);
    let rises = 0;
    let restarts = 0;
    for (let step = 1; step < 600; step++) {
      const before = at((step - 1) * 0.05)[1]!;
      const after = at(step * 0.05)[1]!;
      if (after > before) rises++;
      else restarts++;
    }
    expect(restarts).toBeGreaterThan(5);
    expect(rises).toBeGreaterThan(550);
  });
});

describe('toon fire picture', () => {
  it('holds still between drawings and changes at each one', async () => {
    const width = 160;
    const height = 120;
    const mounted = await mountHeadless('toon-fire', { width, height, params: { frameRate: 10 } });
    await mounted.runTo(1);
    // Pixels that moved by more than the tail's dither between consecutive display frames.
    const changed: number[] = [];
    let previous = await mounted.read();
    for (let frame = 0; frame < 30; frame++) {
      mounted.step();
      const current = await mounted.read();
      let count = 0;
      for (let i = 0; i < current.length; i++) {
        if (Math.abs(current[i]! - previous[i]!) > 12) count++;
      }
      changed.push(count);
      previous = current;
    }
    mounted.destroy();
    const moving = changed.map((count, frame) => (count > 0 ? frame : -1)).filter((f) => f >= 0);
    // 30 frames at 60 Hz and ten drawings a second: five drawings, six frames apart.
    expect(moving.length).toBe(5);
    for (let i = 1; i < moving.length; i++) expect(moving[i]! - moving[i - 1]!).toBe(6);
  });
});

describe('haze overlay', () => {
  it('leaves the picture untouched where the air is cold, and moves it where it is hot', async () => {
    const width = 192;
    const height = 108;
    const render = async (params: Record<string, unknown>) => {
      const mounted = await mountHeadless('haze-overlay', { width, height, params });
      await mounted.runTo(0.5);
      const rgba = await mounted.read();
      mounted.destroy();
      return rgba;
    };
    // A band lying on a line 0.3 above the bottom edge, reaching 0.3 up and a third of that down.
    const band = { image: 'test grid', shape: 'band', position: 0.3, height: 0.3, strength: 1.2 };
    const hot = await render(band);
    const cold = await render({ ...band, strength: 0, chroma: 0, blur: 0 });

    const differing = (fromRow: number, toRow: number) => {
      let count = 0;
      for (let y = fromRow; y < toRow; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (hot[i] !== cold[i] || hot[i + 1] !== cold[i + 1] || hot[i + 2] !== cold[i + 2]) {
            count++;
          }
        }
      }
      return count;
    };
    // Above the band (more than 0.6 above the bottom edge) and below it: bit for bit the same.
    expect(differing(0, Math.floor(height * 0.39))).toBe(0);
    expect(differing(Math.ceil(height * 0.81), height)).toBe(0);
    // Inside it the picture has moved.
    const inside = differing(Math.ceil(height * 0.5), Math.floor(height * 0.7));
    expect(inside).toBeGreaterThan(0.1 * width * height * 0.2);
  });

  it('is the picture itself when every control is at zero', async () => {
    const width = 96;
    const height = 54;
    const render = async (params: Record<string, unknown>) => {
      const mounted = await mountHeadless('haze-overlay', { width, height, params });
      await mounted.runTo(0.2);
      const rgba = await mounted.read();
      mounted.destroy();
      return rgba;
    };
    const off = { strength: 0, chroma: 0, blur: 0, mirage: 0 };
    const whole = await render({ ...off, shape: 'whole frame' });
    const band = await render({ ...off, shape: 'band' });
    expect(Buffer.compare(Buffer.from(whole), Buffer.from(band))).toBe(0);
  });
});
