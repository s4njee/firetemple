import { describe, expect, it, vi } from 'vitest';
import { fireLine } from '../src/effects/firelight-background/index.ts';
import { stripLayout } from '../src/effects/flame-strip/index.ts';
import sources from '../src/effects/noise-flame/sources.wgsl?raw';
import { mountHeadless } from './headless.ts';
import { gpuF32, lane } from './wgsl-eval.ts';

// Epic 4, first group: the scrolling-noise flame, the flame strip and the firelight background.
// What is checked here is what their notes claim: that the noise sources of 4.1 are comparable,
// that both flames do no work and draw nothing above their reach, that the strip tiles, and that
// the firelight background is as steady as a backdrop for text has to be.

vi.setConfig({ testTimeout: 60_000 });

const mean = (values: readonly number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
const deviation = (values: readonly number[]) => {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
};

/** Deterministic rows (x, y, rise, 0) spread over many noise cells. */
function noiseRows(count: number): Float32Array {
  const rows = new Float32Array(count * 4);
  let state = 12345;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < count; i++) {
    rows.set([random() * 200 - 100, random() * 200 - 100, random() * 50, 0], i * 4);
  }
  return rows;
}

/** Relative luminance (0..1) of each pixel of an RGBA8 frame, from its sRGB bytes. */
function luminances(pixels: Uint8Array): number[] {
  const linear = (byte: number) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const out: number[] = [];
  for (let i = 0; i < pixels.length; i += 4) {
    out.push(
      0.2126 * linear(pixels[i]!) +
        0.7152 * linear(pixels[i + 1]!) +
        0.0722 * linear(pixels[i + 2]!),
    );
  }
  return out;
}

describe('noise-flame: noise sources', () => {
  // NF_SPREAD in sources.wgsl: the standard deviation of noisetex_flame over the baked tile.
  const SPREAD = 0.214;
  const KINDS = [
    ['value', 1],
    ['simplex', 2],
    ['voronoi', 3],
    ['gradient', 4],
  ] as const;

  it.each(KINDS)(
    '%s noise is centred and has the spread of the baked texture at four octaves',
    async (_name, kind) => {
      const out = await gpuF32(
        `${sources}
         fn f(x: vec4f) -> vec4f {
           return vec4f(
             nf_fractal(${kind}, x.xy, x.z, 4),
             nf_flame(${kind}, x.xy, x.z, 4, true),
             nf_flame(${kind}, x.xy, x.z, 4, false),
             0.0,
           );
         }`,
        noiseRows(16384),
      );
      const plain = lane(out, 0);
      const warped = lane(out, 1);
      expect(Math.abs(mean(plain))).toBeLessThan(0.02);
      expect(deviation(plain)).toBeGreaterThan(SPREAD * 0.93);
      expect(deviation(plain)).toBeLessThan(SPREAD * 1.07);
      // The warp moves the lookup; it must not change how much flame there is.
      expect(Math.abs(mean(warped))).toBeLessThan(0.02);
      expect(deviation(warped)).toBeGreaterThan(SPREAD * 0.9);
      expect(deviation(warped)).toBeLessThan(SPREAD * 1.1);
      for (const value of [...plain, ...warped]) {
        expect(value).toBeGreaterThanOrEqual(-1);
        expect(value).toBeLessThanOrEqual(1);
      }
      // Without the warp nf_flame is nf_fractal.
      expect(lane(out, 2)).toEqual(plain);
    },
  );

  it('rises: the pattern at a point changes as the climb grows, and not without it', async () => {
    const out = await gpuF32(
      `${sources}
       fn f(x: vec4f) -> vec4f {
         return vec4f(
           nf_fractal(4, x.xy, 0.0, 4),
           nf_fractal(4, x.xy + vec2f(0.0, 0.37), 0.37, 1),
           nf_fractal(4, x.xy, 0.0, 1),
           nf_fractal(4, x.xy, 0.37, 4),
         );
       }`,
      noiseRows(2048),
    );
    // One octave is a rigid scroll: the value at p + rise after rising is the value at p before.
    lane(out, 1).forEach((value, i) => expect(value).toBeCloseTo(lane(out, 2)[i]!, 4));
    // Four octaves are not: finer octaves climb faster, so the sum changes.
    const moved = lane(out, 3).map((value, i) => Math.abs(value - lane(out, 0)[i]!));
    expect(mean(moved)).toBeGreaterThan(0.05);
  });
});

describe('noise-flame and flame-strip: nothing above the flames', () => {
  const WIDTH = 240;
  const HEIGHT = 120;

  /** Rows (from the top) that contain any non-zero byte. */
  async function litRows(id: string, params: Record<string, unknown>) {
    // Without bloom, so the only light is what the scene pass itself wrote.
    const mounted = await mountHeadless(id, {
      width: WIDTH,
      height: HEIGHT,
      params: { bloom: 0, ...params },
    });
    await mounted.runTo(1);
    const pixels = await mounted.read();
    mounted.destroy();
    const rows: number[] = [];
    for (let y = 0; y < HEIGHT; y++) {
      if (pixels.subarray(y * WIDTH * 4, (y + 1) * WIDTH * 4).some((v) => v !== 0)) rows.push(y);
    }
    return rows;
  }

  it.each(['texture', 'value', 'simplex', 'voronoi', 'gradient fbm'])(
    'noise-flame (%s) is transparent above its height and burning below it',
    async (noise) => {
      const rows = await litRows('noise-flame', { noise, height: 0.5 });
      // height 0.5: the top half of the canvas is the early-out.
      expect(Math.min(...rows)).toBeGreaterThanOrEqual(HEIGHT / 2);
      expect(rows.length).toBeGreaterThan(HEIGHT * 0.3);
      expect(Math.max(...rows)).toBe(HEIGHT - 1);
    },
  );

  it('flame-strip is transparent above its height and anchored to the bottom edge', async () => {
    const rows = await litRows('flame-strip', { height: 0.25 });
    expect(Math.min(...rows)).toBeGreaterThanOrEqual(HEIGHT * 0.75);
    expect(Math.max(...rows)).toBe(HEIGHT - 1);
  });
});

describe('flame-strip: layout and tiling', () => {
  it('lays out whole numbers of crests and noise tiles at any width', () => {
    for (const aspect of [0.3, 0.46, 1, 1.78, 2.4, 5.54, 12, 40]) {
      for (const height of [0.1, 0.35, 0.85, 1]) {
        for (const density of [0.3, 1, 2.5, 4]) {
          const layout = stripLayout(aspect, height, density);
          expect(Number.isInteger(layout.count)).toBe(true);
          expect(Number.isInteger(layout.tiles)).toBe(true);
          expect(layout.count).toBeGreaterThanOrEqual(2);
          expect(layout.tiles).toBeGreaterThanOrEqual(1);
          // The two noise layers repeat a consecutive number of times, so only together once.
          expect(Math.abs(layout.warpTiles - layout.tiles)).toBe(1);
          expect(layout.warpTiles).toBeGreaterThanOrEqual(1);
          expect(layout.flame).toBeLessThanOrEqual(height);
        }
      }
    }
  });

  it('keeps the strip a band: full height in a short canvas, capped by the width in a tall one', () => {
    // The "band" page layout, 886 x 160.
    expect(stripLayout(886 / 160, 0.85, 1).flame).toBeCloseTo(0.85, 6);
    // A phone in portrait: 16% of the width, however tall the canvas is.
    const phone = stripLayout(390 / 844, 0.85, 1);
    expect(phone.flame * 844).toBeCloseTo(0.16 * 390, 3);
  });

  it('is seamless: the last column continues into the first', async () => {
    const WIDTH = 443;
    const HEIGHT = 80;
    // Bloom is not periodic (it clamps at the canvas edge), so it is left out of this check.
    const mounted = await mountHeadless('flame-strip', {
      width: WIDTH,
      height: HEIGHT,
      params: { bloom: 0 },
    });
    await mounted.runTo(1.5);
    const pixels = await mounted.read();
    mounted.destroy();

    /** Mean absolute byte difference between two columns. */
    const between = (a: number, b: number) => {
      let sum = 0;
      for (let y = 0; y < HEIGHT; y++) {
        for (let c = 0; c < 4; c++) {
          sum += Math.abs(pixels[(y * WIDTH + a) * 4 + c]! - pixels[(y * WIDTH + b) * 4 + c]!);
        }
      }
      return sum / (HEIGHT * 4);
    };
    const inside: number[] = [];
    for (let x = 0; x < WIDTH - 1; x++) inside.push(between(x, x + 1));
    const seam = between(WIDTH - 1, 0);
    const sorted = [...inside].sort((a, b) => a - b);
    // The step across the seam is an ordinary step between neighbours (measured: 2.4 against a
    // median of 3.8)...
    expect(seam).toBeLessThanOrEqual(sorted[Math.floor(sorted.length / 2)]! * 2);
    // ...whereas two unrelated columns, a quarter of the width apart, differ far more (12.5).
    expect(between(0, Math.floor(WIDTH / 4))).toBeGreaterThan(seam * 3);
  });
});

describe('firelight-background', () => {
  it('puts the fire outside the frame on the chosen side', () => {
    const aspect = 16 / 9;
    const below = fireLine('below', aspect, 0.3, 0.3);
    expect(below.origin[0]).toBeCloseTo(aspect / 2, 6);
    expect(below.origin[1]).toBeCloseTo(-0.3, 6);
    expect(below.extent[0]).toBeCloseTo(0.15 * aspect, 6);
    expect(fireLine('left', aspect, 0.3, 0.3).origin[0]).toBeLessThan(0);
    expect(fireLine('right', aspect, 0.3, 0.3).origin[0]).toBeGreaterThan(aspect);
    const corner = fireLine('below right', aspect, 0.3, 0.3);
    expect(corner.origin[0]).toBeGreaterThan(aspect);
    expect(corner.origin[1]).toBeLessThan(0);
    expect(Math.hypot(corner.origin[0] - aspect, corner.origin[1])).toBeCloseTo(0.3, 6);
    expect(corner.extent).toEqual([0, 0]);
    // An unknown value falls back to the default side instead of producing NaN.
    expect(fireLine('nowhere', aspect, 0.3, 0.3)).toEqual(below);
  });

  it('is opaque, smooth and brightest on the side the fire is on', async () => {
    const WIDTH = 240;
    const HEIGHT = 135;
    const mounted = await mountHeadless('firelight-background', { width: WIDTH, height: HEIGHT });
    await mounted.runTo(1);
    const pixels = await mounted.read();
    mounted.destroy();

    let steepest = 0;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const i = (y * WIDTH + x) * 4;
        expect(pixels[i + 3]).toBe(255);
        if (x + 1 < WIDTH) steepest = Math.max(steepest, Math.abs(pixels[i]! - pixels[i + 4]!));
        if (y + 1 < HEIGHT) {
          steepest = Math.max(steepest, Math.abs(pixels[i]! - pixels[i + WIDTH * 4]!));
        }
      }
    }
    // No flames, no edges: neighbouring pixels differ by a few 8-bit steps at most (at this size
    // one pixel is 8 x 8 pixels of a 1080p canvas).
    expect(steepest).toBeLessThanOrEqual(8);

    const light = luminances(pixels);
    const rowMean = (y: number) => mean(light.slice(y * WIDTH, (y + 1) * WIDTH));
    expect(rowMean(HEIGHT - 1)).toBeGreaterThan(rowMean(Math.floor(HEIGHT / 2)) * 1.5);
    expect(rowMean(Math.floor(HEIGHT / 2))).toBeGreaterThan(rowMean(0) * 1.5);
    // A warm colour everywhere: red over green over blue.
    const middle = (Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2)) * 4;
    expect(pixels[middle]!).toBeGreaterThan(pixels[middle + 1]!);
    expect(pixels[middle + 1]!).toBeGreaterThan(pixels[middle + 2]!);
  });

  it('moves, but barely moves the brightness of the whole frame', async () => {
    const WIDTH = 160;
    const HEIGHT = 90;
    const mounted = await mountHeadless('firelight-background', { width: WIDTH, height: HEIGHT });
    await mounted.runTo(1);
    const first = await mounted.read();
    const levels: number[] = [];
    let last = first;
    // Twelve seconds, sampled ten times a second.
    for (let sample = 0; sample < 120; sample++) {
      mounted.step(6);
      last = await mounted.read();
      levels.push(mean(luminances(last)));
    }
    mounted.destroy();

    // The picture changes...
    let changed = 0;
    for (let i = 0; i < first.length; i += 4) if (first[i] !== last[i]) changed++;
    expect(changed).toBeGreaterThan((WIDTH * HEIGHT) / 4);
    // ...while the mean relative luminance of the frame stays within 3% of full white over the
    // whole run, and within 1.5% between any two samples a second apart. A WCAG flash needs 10%.
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(0.03);
    for (let i = 10; i < levels.length; i++) {
      expect(Math.abs(levels[i]! - levels[i - 10]!)).toBeLessThan(0.015);
    }
  });
});
