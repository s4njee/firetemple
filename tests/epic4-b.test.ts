import { describe, expect, it, vi } from 'vitest';
import {
  createDraught,
  MAX_LEAN,
  pointerWind,
  stepDraught,
  type DraughtPointer,
} from '../src/effects/candle/draught.ts';
import { candleLayout, toFlameSpace } from '../src/effects/candle/index.ts';
import { jetLayout } from '../src/effects/gas-jet/index.ts';
import { flameShare, MAX_FLAMES, torchLayout } from '../src/effects/torch/index.ts';
import { mountHeadless, sendPointer } from './headless.ts';

// Epic 4, second batch: the candle's draught, the torch grid and its loop, the gas jet's layout
// and shock diamonds. Numbers first; the pictures are checked with `npm run shot`.

vi.setConfig({ testTimeout: 120_000 });

const still = (x: number, y = 0): DraughtPointer => ({ x, y, vx: 0, vy: 0 });

/** Runs the spring for `seconds` at `fps` and returns the state. */
function settle(pointer: DraughtPointer | undefined, seconds = 3, fps = 60, strength = 1) {
  const state = createDraught();
  for (let frame = 0; frame < seconds * fps; frame++) {
    stepDraught(state, 0, pointer, strength, 1 / fps);
  }
  return state;
}

describe('candle draught', () => {
  it('leans away from a still pointer, the same amount on either side', () => {
    const fromLeft = settle(still(-0.4));
    const fromRight = settle(still(0.4));
    expect(fromLeft.lean).toBeGreaterThan(0.15);
    expect(fromRight.lean).toBeCloseTo(-fromLeft.lean, 6);
    // The tip has caught up with the base once the air is still.
    expect(fromLeft.tip).toBeCloseTo(fromLeft.lean, 3);
  });

  it('is pushed less by a distant pointer and not at all by one above the wick', () => {
    const near = settle(still(-0.4)).lean;
    const far = settle(still(-4)).lean;
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(0.15 * near);
    expect(Math.abs(settle(still(0, 1.5)).lean)).toBeLessThan(1e-9);
  });

  it('idles at the given sway when there is no pointer, or no draught', () => {
    expect(settle(undefined).lean).toBe(0);
    expect(settle(still(-0.4), 3, 60, 0).lean).toBe(0);
    const state = createDraught();
    for (let frame = 0; frame < 240; frame++) stepDraught(state, 0.2, undefined, 1, 1 / 60);
    expect(state.lean).toBeCloseTo(0.2, 3);
  });

  it('follows a pointer sweeping past, and the gust it raises dies away', () => {
    // Directly under the flame's middle, so position alone asks for nothing.
    const sweep = pointerWind({ x: 0, y: -0.3, vx: 3, vy: 0 }, 1);
    expect(sweep.lean).toBeGreaterThan(0.1);
    expect(pointerWind({ x: 0, y: -0.3, vx: -3, vy: 0 }, 1).lean).toBeCloseTo(-sweep.lean, 9);
    expect(sweep.gust).toBeGreaterThan(0.2);

    const state = createDraught();
    stepDraught(state, 0, { x: 0, y: -0.3, vx: 3, vy: 0 }, 1, 0.1);
    const gust = state.gust;
    expect(gust).toBeGreaterThan(0.2);
    for (let frame = 0; frame < 180; frame++) stepDraught(state, 0, undefined, 1, 1 / 60);
    expect(state.gust).toBeLessThan(0.02 * gust);
  });

  it('springs back past upright once and comes to rest', () => {
    const state = settle(still(-0.4));
    const pushed = state.lean;
    let lowest = pushed;
    let crossings = 0;
    let previous = state.lean;
    for (let frame = 0; frame < 300; frame++) {
      stepDraught(state, 0, undefined, 1, 1 / 60);
      lowest = Math.min(lowest, state.lean);
      if (Math.sign(state.lean) !== Math.sign(previous) && Math.abs(previous) > 1e-3) crossings++;
      previous = state.lean;
    }
    // Under-damped: it overshoots, by less than a third of the push, and then settles.
    expect(lowest).toBeLessThan(0);
    expect(-lowest).toBeLessThan(0.33 * pushed);
    expect(crossings).toBeGreaterThanOrEqual(1);
    expect(Math.abs(state.lean)).toBeLessThan(1e-3);
  });

  it('stays inside its limit and behaves the same at any frame rate', () => {
    const hard = settle({ x: -0.2, y: 0, vx: 50, vy: 0 }, 2, 60, 3);
    expect(hard.lean).toBeLessThanOrEqual(MAX_LEAN);
    expect(hard.tip).toBeLessThanOrEqual(MAX_LEAN);
    expect(hard.gust).toBeLessThanOrEqual(1);

    const at30 = settle(still(-0.4), 0.5, 30).lean;
    const at120 = settle(still(-0.4), 0.5, 120).lean;
    expect(at30).toBeCloseTo(at120, 2);

    // A tab that was in the background for a minute: one huge step must not throw the flame.
    const state = createDraught();
    stepDraught(state, 0, still(-0.4), 1, 60);
    expect(Number.isFinite(state.lean)).toBe(true);
    expect(Math.abs(state.lean)).toBeLessThanOrEqual(MAX_LEAN);
  });

  it('maps the canvas to flame space with the flame’s middle at the origin', () => {
    const size = { candleWidth: 0.12, candleHeight: 0.4, size: 0.3 };
    const wide = candleLayout(16 / 9, size);
    expect(wide.fit).toBe(1);
    // The middle of the flame is 0.49 flame heights above the wax.
    const middle = toFlameSpace(wide, 16 / 9, 0.5, 1 - (0.4 + 0.49 * 0.3));
    expect(middle.x).toBeCloseTo(0, 9);
    expect(middle.y).toBeCloseTo(0, 9);
    // One flame height to the right is 0.3 canvas heights, whatever the aspect.
    expect(toFlameSpace(wide, 16 / 9, 0.5 + 0.3 / (16 / 9), 0.5).x).toBeCloseTo(1, 9);
    // A narrow canvas zooms out, so the same share of its width is further in flame heights.
    const narrow = candleLayout(0.3, size);
    expect(narrow.fit).toBeCloseTo(0.5, 9);
    expect(toFlameSpace(narrow, 0.3, 1, 0.5).x).toBeCloseTo((0.5 * 0.3) / 0.5 / 0.3, 9);
  });
});

/** Brightness-weighted mean column of the rows `from`..`to` of an RGBA frame. */
function centroidX(rgba: Uint8Array, width: number, from: number, to: number): number {
  let sum = 0;
  let weight = 0;
  for (let y = from; y < to; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const value = rgba[i]! + rgba[i + 1]! + rgba[i + 2]!;
      sum += value * x;
      weight += value;
    }
  }
  return sum / weight;
}

describe('candle on the GPU', () => {
  const WIDTH = 320;
  const HEIGHT = 240;
  // No idle sway, no halo and no bloom: the only thing off-centre is the lean.
  const params = { sway: 0, flutter: 0, halo: 0, bloom: 0 };
  // The rows the flame is in: above the wax (0.4 of the height) and its wick.
  const rows = [Math.round(0.2 * HEIGHT), Math.round(0.55 * HEIGHT)] as const;

  async function leanWith(pointerX: number | undefined) {
    const mounted = await mountHeadless('candle', { width: WIDTH, height: HEIGHT, params });
    if (pointerX !== undefined) sendPointer(mounted.canvas, 'pointermove', pointerX, 0.45);
    await mounted.runTo(1.5);
    const x = centroidX(await mounted.read(), WIDTH, rows[0], rows[1]);
    mounted.destroy();
    return x - (WIDTH - 1) / 2;
  }

  it('stands upright with no pointer and leans away from one', async () => {
    const upright = await leanWith(undefined);
    const fromLeft = await leanWith(0.42);
    const fromRight = await leanWith(0.58);
    // The wick leans a pixel or so to one side; the flame itself is symmetric.
    expect(Math.abs(upright)).toBeLessThan(1.5);
    expect(fromLeft - upright).toBeGreaterThan(1.5);
    expect(fromRight - upright).toBeLessThan(-1.5);
    expect(fromLeft - upright).toBeCloseTo(-(fromRight - upright), 0);
  });

  it('covers the page with its wax and nothing else', async () => {
    const mounted = await mountHeadless('candle', { width: WIDTH, height: HEIGHT, params });
    await mounted.runTo(0.2);
    const rgba = await mounted.read();
    mounted.destroy();
    const alpha = (u: number, v: number) =>
      rgba[(Math.round(v * HEIGHT) * WIDTH + Math.round(u * WIDTH)) * 4 + 3]!;
    // Inside the wax: opaque. Beside it and in the far corner: untouched.
    expect(alpha(0.5, 0.9)).toBe(255);
    expect(alpha(0.3, 0.9)).toBe(0);
    expect(alpha(0.05, 0.05)).toBe(0);
  });
});

describe('torch grid', () => {
  it('lays out any count in the grid that draws the items largest', () => {
    expect(torchLayout(1, 16 / 9)).toMatchObject({ columns: 1, rows: 1, lastRow: 1 });
    expect(torchLayout(12, 16 / 9)).toMatchObject({ columns: 6, rows: 2, lastRow: 6 });
    // A tall strip stacks them; a wide one puts them in a row.
    expect(torchLayout(5, 0.2)).toMatchObject({ columns: 1, rows: 5 });
    expect(torchLayout(5, 8)).toMatchObject({ columns: 5, rows: 1 });
    for (let count = 1; count <= MAX_FLAMES; count++) {
      for (const aspect of [0.46, 1, 16 / 9, 5.5]) {
        const grid = torchLayout(count, aspect);
        expect(grid.columns * (grid.rows - 1) + grid.lastRow).toBe(count);
        expect(grid.lastRow).toBeGreaterThanOrEqual(1);
        expect(grid.lastRow).toBeLessThanOrEqual(grid.columns);
        // An item is never taller than its row or wider than its column.
        expect(grid.unit).toBeLessThanOrEqual(1 / grid.rows + 1e-9);
        expect(grid.unit * 0.62).toBeLessThanOrEqual(aspect / grid.columns + 1e-9);
      }
    }
  });

  it('fetches noise on a share of the canvas that does not grow with the count', () => {
    // The flames get smaller as they get more numerous. What a frame fetches depends on how well
    // the grid packs the canvas, not on the count: 48 flames cost what 12 do, and one flame
    // alone (which leaves most of a wide canvas empty) costs the least.
    const counts = [1, 2, 4, 12, 24, 48];
    const shares = counts.map((count) => flameShare(count, 16 / 9));
    for (const share of shares) {
      expect(share.fetched).toBeLessThan(share.box);
      expect(share.fetched).toBeGreaterThan(0.5 * share.box);
      expect(share.box).toBeLessThan(0.35);
    }
    const fetched = shares.map((share) => share.fetched);
    expect(fetched[5]).toBeCloseTo(fetched[3]!, 9);
    expect(Math.min(...fetched)).toBe(fetched[0]);
    expect(Math.max(...fetched) / Math.min(...fetched)).toBeLessThan(3);
    // The brazier's taper is only boxed.
    const brazier = flameShare(12, 16 / 9, 'brazier');
    expect(brazier.fetched).toBeCloseTo(brazier.box, 9);
  });

  const WIDTH = 480;
  const HEIGHT = 240;

  /** Mean absolute difference of two frames, in 8-bit steps. */
  function difference(a: Uint8Array, b: Uint8Array): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
    return sum / a.length;
  }

  it('closes its loop exactly', async () => {
    const loop = 3;
    const mounted = await mountHeadless('torch', {
      width: WIDTH,
      height: HEIGHT,
      params: { loop, bloom: 0 },
    });
    await mounted.runTo(0.5);
    const start = await mounted.read();
    await mounted.runTo(0.5 + loop / 2);
    const half = await mounted.read();
    await mounted.runTo(0.5 + loop);
    const end = await mounted.read();
    mounted.destroy();
    // Half a loop on, the flames are somewhere else; a whole loop on, only the dither differs.
    expect(difference(start, half)).toBeGreaterThan(1);
    expect(difference(start, end)).toBeLessThan(0.25);
  });

  /** The pixels of one cell of a 6 x 2 grid (80 x 120 pixels each at this size). */
  function cellOf(rgba: Uint8Array, column: number, row: number): Uint8Array {
    const out = new Uint8Array(80 * 120 * 4);
    for (let y = 0; y < 120; y++) {
      const from = ((row * 120 + y) * WIDTH + column * 80) * 4;
      out.set(rgba.subarray(from, from + 80 * 4), y * 80 * 4);
    }
    return out;
  }

  it('gives every flame its own motion, and one motion when variety is 0', async () => {
    const render = async (variety: number) => {
      const mounted = await mountHeadless('torch', {
        width: WIDTH,
        height: HEIGHT,
        params: { count: 12, variety, bloom: 0, size: 1 },
      });
      await mounted.runTo(0.7);
      const rgba = await mounted.read();
      mounted.destroy();
      return rgba;
    };
    const unison = await render(0);
    const varied = await render(1);
    expect(difference(cellOf(unison, 0, 0), cellOf(unison, 3, 1))).toBeLessThan(0.3);
    expect(difference(cellOf(varied, 0, 0), cellOf(varied, 3, 1))).toBeGreaterThan(2);
    expect(difference(cellOf(varied, 1, 0), cellOf(varied, 2, 0))).toBeGreaterThan(2);
  });

  it('draws exactly `count` flames and centres a short last row', async () => {
    // Five in a 6:5 canvas: three over two, the two centred, so the corners of row two are empty.
    const WIDTH = 360;
    const HEIGHT = 300;
    expect(torchLayout(5, WIDTH / HEIGHT)).toMatchObject({ columns: 3, rows: 2, lastRow: 2 });
    const mounted = await mountHeadless('torch', {
      width: WIDTH,
      height: HEIGHT,
      params: { count: 5, bloom: 0 },
    });
    await mounted.runTo(0.3);
    const rgba = await mounted.read();
    mounted.destroy();
    /** Sum of every byte in a box given in 0..1 canvas coordinates. */
    const light = (u0: number, u1: number, v0: number, v1: number) => {
      let sum = 0;
      for (let y = Math.round(v0 * HEIGHT); y < Math.round(v1 * HEIGHT); y++) {
        for (let x = Math.round(u0 * WIDTH); x < Math.round(u1 * WIDTH); x++) {
          const i = (y * WIDTH + x) * 4;
          sum += rgba[i]! + rgba[i + 1]! + rgba[i + 2]! + rgba[i + 3]!;
        }
      }
      return sum;
    };
    // Row one: three items at 1/6, 3/6, 5/6. Row two: two at 2/6 and 4/6.
    for (const u of [1 / 6, 3 / 6, 5 / 6])
      expect(light(u - 0.05, u + 0.05, 0, 0.5)).toBeGreaterThan(1000);
    for (const u of [2 / 6, 4 / 6]) expect(light(u - 0.05, u + 0.05, 0.5, 1)).toBeGreaterThan(1000);
    expect(light(0, 1 / 6 - 0.02, 0.5, 1)).toBe(0);
    expect(light(5 / 6 + 0.02, 1, 0.5, 1)).toBe(0);
  });
});

describe('gas jet', () => {
  const settings = {
    arrangement: 'single',
    count: 9,
    direction: 90,
    length: 0.8,
    width: 0.09,
    spacing: 0.12,
    radius: 0.17,
    nozzle: true,
  };

  it('points where `direction` says: 0 up, 90 right', () => {
    const right = jetLayout(16 / 9, settings);
    expect(right.axis[0]).toBeCloseTo(1, 9);
    expect(right.axis[1]).toBeCloseTo(0, 9);
    const up = jetLayout(16 / 9, { ...settings, direction: 0 });
    expect(up.axis[0]).toBeCloseTo(0, 9);
    expect(up.axis[1]).toBeCloseTo(1, 9);
    // Burner and flame together are centred: the mouth sits behind the centre along the axis.
    expect(right.origin[0]).toBeLessThan(0);
    expect(right.origin[1]).toBeCloseTo(0, 9);
    expect(right.origin[0]).toBeCloseTo(-0.5 * (settings.length - right.nozzle), 9);
  });

  it('zooms out until the arrangement fits the canvas', () => {
    expect(jetLayout(16 / 9, settings).fit).toBe(1);
    // The same horizontal jet in a portrait canvas has to shrink; pointing up it need not.
    const portrait = jetLayout(0.46, settings);
    expect(portrait.fit).toBeLessThan(0.5);
    expect((settings.length + portrait.nozzle) * portrait.fit).toBeLessThanOrEqual(0.46);
    expect(jetLayout(0.46, { ...settings, direction: 0, length: 0.5 }).fit).toBe(1);
    // A ring is as wide as it is tall, and a row is as wide as its jets.
    const ring = jetLayout(0.46, { ...settings, arrangement: 'ring', length: 0.17 });
    expect(2 * (0.17 + 0.17) * ring.fit).toBeLessThanOrEqual(0.46);
    const row = jetLayout(1, { ...settings, arrangement: 'row', direction: 0, count: 20 });
    expect(19 * settings.spacing * row.fit).toBeLessThanOrEqual(1);
    expect(jetLayout(1, { ...settings, arrangement: 'single', count: 20 }).count).toBe(1);
  });

  const WIDTH = 480;
  const HEIGHT = 270;

  /** Blue along the jet's axis: one value per pixel column of the middle rows. */
  async function axisProfile(params: Record<string, unknown>): Promise<Float32Array> {
    const mounted = await mountHeadless('gas-jet', {
      width: WIDTH,
      height: HEIGHT,
      params: { nozzle: false, roar: 0, bloom: 0, speed: 0, ...params },
    });
    await mounted.runTo(0.1);
    const rgba = await mounted.read();
    mounted.destroy();
    const profile = new Float32Array(WIDTH);
    for (let x = 0; x < WIDTH; x++) {
      for (let y = HEIGHT / 2 - 2; y < HEIGHT / 2 + 2; y++) {
        const i = (y * WIDTH + x) * 4;
        profile[x]! += (rgba[i]! + rgba[i + 1]! + rgba[i + 2]!) / (3 * 4 * 255);
      }
    }
    return profile;
  }

  it('burns from the nozzle outward, in the direction asked for', async () => {
    const right = await axisProfile({ direction: 90 });
    const left = await axisProfile({ direction: -90 });
    const layout = jetLayout(WIDTH / HEIGHT, { ...settings, nozzle: false });
    const column = (along: number, sign: number) =>
      Math.round(WIDTH / 2 + sign * (layout.origin[0] + along) * HEIGHT);
    // Lit a tenth of the way along, dark behind the nozzle and past the tip.
    expect(right[column(0.08, 1)]!).toBeGreaterThan(0.3);
    expect(right[column(-0.05, 1)]!).toBe(0);
    expect(right[column(0.85, 1)]!).toBe(0);
    // Pointing the other way is the mirror image.
    expect(left[column(0.08, -1)]!).toBeGreaterThan(0.3);
    expect(left[column(-0.05, -1)]!).toBe(0);
    expect(Math.abs(left[column(0.3, -1)]! - right[column(0.3, 1)]!)).toBeLessThan(0.03);
  });

  it('puts a shock diamond every `diamondSpacing` nozzle widths', async () => {
    const jet = { direction: 90, length: 1.2, width: 0.12, spread: 0.5, cone: 0.05 };
    const plain = await axisProfile({ ...jet, diamonds: 0 });
    const shocked = await axisProfile({ ...jet, diamonds: 1, diamondSpacing: 1.5 });
    const layout = jetLayout(WIDTH / HEIGHT, { ...settings, ...jet, nozzle: false });
    const column = (along: number) =>
      Math.round(WIDTH / 2 + (layout.origin[0] + along) * layout.fit * HEIGHT);
    const step = 1.5 * jet.width;
    for (let k = 0; k < 4; k++) {
      // Brighter at each diamond's centre (0.6 of a step from the nozzle, then every step)...
      const gain = shocked[column((0.6 + k) * step)]! - plain[column((0.6 + k) * step)]!;
      expect(gain, `diamond ${k}`).toBeGreaterThan(0.08);
      // ...and not between two of them.
      const between = shocked[column((1.1 + k) * step)]! - plain[column((1.1 + k) * step)]!;
      expect(between, `gap ${k}`).toBeLessThan(0.5 * gain);
    }
  });
});
