import { writeFileSync } from 'node:fs';
import { describe, it, vi } from 'vitest';
import { BACKDROPS, mountHeadless, writePng, type Backdrop } from '../tests/headless.ts';

// Story 3.3: what should an overlay fire effect write to a premultiplied canvas?
//
//   npx vitest run --silent=false --config experiments/vite.config.ts experiments/compositing.test.ts
//
// Renders the `compositing` effect once per canvas content (alpha mode, gain, underlay), composites
// each over the dark and the light page colour the way a browser does, writes side-by-side PNGs to
// docs/compositing/ and prints the contrast table that docs/compositing-study.md quotes.
//
// The CSS `mix-blend-mode` rows are SIMULATED from the W3C Compositing and Blending formulas: there
// is no browser here. They assume an opaque page behind the canvas and blending in encoded sRGB,
// which is what browsers do by default.

vi.setConfig({ testTimeout: 600_000 });

const WIDTH = 320;
const HEIGHT = 256;
const OUT = 'docs/compositing';
const PAGES = ['dark', 'light'] as const;

type Blend = 'normal' | 'screen' | 'lighten' | 'multiply' | 'plus-lighter';

interface Strategy {
  id: string;
  label: string;
  /** Parameters of the effect that decide what the canvas holds. */
  params: Record<string, unknown>;
  /** How the browser combines the canvas with the page. Anything but `normal` is simulated. */
  blend: Blend;
}

const STRATEGIES: Strategy[] = [
  {
    id: 'additive',
    label: 'additive (alpha 0)',
    params: { alpha: 'additive', underlay: 0 },
    blend: 'normal',
  },
  {
    id: 'coverage',
    label: 'coverage (scene alpha)',
    params: { alpha: 'coverage', underlay: 0 },
    blend: 'normal',
  },
  {
    id: 'luminance',
    label: 'luminance alpha, gain 1',
    params: { alpha: 'luminance', alphaGain: 1, underlay: 0 },
    blend: 'normal',
  },
  {
    id: 'luminance-gain3',
    label: 'luminance alpha, gain 3',
    params: { alpha: 'luminance', alphaGain: 3, underlay: 0 },
    blend: 'normal',
  },
  {
    id: 'underlay-0.3',
    label: 'luminance + underlay 0.3 (default)',
    params: { alpha: 'luminance', alphaGain: 1, underlay: 0.3 },
    blend: 'normal',
  },
  {
    id: 'underlay-0.6',
    label: 'luminance + underlay 0.6',
    params: { alpha: 'luminance', alphaGain: 1, underlay: 0.6 },
    blend: 'normal',
  },
  {
    id: 'additive-underlay',
    label: 'additive + underlay 0.6',
    params: { alpha: 'additive', underlay: 0.6 },
    blend: 'normal',
  },
  {
    id: 'css-screen',
    label: 'CSS screen, opaque canvas (simulated)',
    params: { alpha: 'opaque', underlay: 0 },
    blend: 'screen',
  },
  {
    id: 'css-plus-lighter',
    label: 'CSS plus-lighter, luminance canvas (simulated)',
    params: { alpha: 'luminance', alphaGain: 1, underlay: 0 },
    blend: 'plus-lighter',
  },
  {
    id: 'css-lighten',
    label: 'CSS lighten, opaque canvas (simulated)',
    params: { alpha: 'opaque', underlay: 0 },
    blend: 'lighten',
  },
  {
    id: 'css-multiply',
    label: 'CSS multiply, luminance canvas (simulated)',
    params: { alpha: 'luminance', alphaGain: 1, underlay: 0 },
    blend: 'multiply',
  },
  {
    id: 'css-multiply-opaque',
    label: 'CSS multiply, opaque canvas (simulated)',
    params: { alpha: 'opaque', underlay: 0 },
    blend: 'multiply',
  },
];

// --- Compositing ---------------------------------------------------------------------------------

/**
 * What the browser shows for a premultiplied canvas over an opaque page, in encoded sRGB 0..1.
 * `normal` is source-over. The separable blend modes follow the Compositing and Blending spec:
 * `(1 - as) * Cb + as * B(Cb, Cs)` with Cs the un-premultiplied colour. `plus-lighter` is the
 * Porter-Duff "plus" operator: premultiplied source plus backdrop, clamped.
 */
function composite(rgba: Uint8Array, page: Backdrop, blend: Blend): Uint8Array {
  const count = rgba.length / 4;
  const rgb = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = rgba[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) {
      const src = rgba[i * 4 + c]! / 255;
      const back = page[c]! / 255;
      let out: number;
      if (blend === 'normal') out = src + (1 - a) * back;
      else if (blend === 'plus-lighter') out = src + back;
      else {
        // A colour brighter than its alpha has no un-premultiplied form; clamp as a browser would.
        const straight = a > 0 ? Math.min(1, src / a) : 0;
        const mixed =
          blend === 'screen'
            ? back + straight - back * straight
            : blend === 'lighten'
              ? Math.max(back, straight)
              : back * straight;
        out = (1 - a) * back + a * mixed;
      }
      rgb[i * 3 + c] = Math.round(Math.min(1, Math.max(0, out)) * 255);
    }
  }
  return rgb;
}

// --- Colour measures -----------------------------------------------------------------------------

const toLinear = (byte: number) => {
  const v = byte / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** Relative luminance (WCAG / Rec.709) of an sRGB byte triple. */
const luminance = (r: number, g: number, b: number) =>
  0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

/** CIELAB (D65) of an sRGB byte triple. */
function lab(r: number, g: number, b: number): [number, number, number] {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** WCAG contrast ratio of two relative luminances, always >= 1. */
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

interface Regions {
  core: number[];
  body: number[];
  near: number[];
  smoke: number[];
}

/**
 * Pixel sets, from the scene itself rather than from any one strategy: `reference` is the opaque
 * render (the fire over black) and `coverage` holds the scene's own alpha.
 *
 * - core: the white-hot middle of the flame
 * - body: the rest of the visible flame
 * - near: the glow just outside it, which is what the core is seen against
 * - smoke: partly covered pixels above the flame with almost no light of their own
 */
function regions(reference: Uint8Array, coverage: Uint8Array): Regions {
  const out: Regions = { core: [], body: [], near: [], smoke: [] };
  for (let i = 0; i < reference.length / 4; i++) {
    const y = luminance(reference[i * 4]!, reference[i * 4 + 1]!, reference[i * 4 + 2]!);
    const cover = coverage[i * 4 + 3]! / 255;
    if (cover > 0.97) continue; // logs
    if (y > 0.7) out.core.push(i);
    else if (y > 0.12) out.body.push(i);
    else if (y > 0.012 && cover < 0.1) out.near.push(i);
    else if (y < 0.03 && cover > 0.25) out.smoke.push(i);
  }
  return out;
}

function meanLuminance(rgb: Uint8Array, pixels: number[]): number {
  let sum = 0;
  for (const i of pixels) sum += luminance(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!);
  return pixels.length > 0 ? sum / pixels.length : Number.NaN;
}

/** Mean CIE76 colour difference between the composited pixels and the bare page. */
function meanDeltaE(rgb: Uint8Array, pixels: number[], page: Backdrop): number {
  const [pl, pa, pb] = lab(page[0], page[1], page[2]);
  let sum = 0;
  for (const i of pixels) {
    const [l, a, b] = lab(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!);
    sum += Math.hypot(l - pl, a - pa, b - pb);
  }
  return pixels.length > 0 ? sum / pixels.length : Number.NaN;
}

interface Row {
  strategy: string;
  page: string;
  /** Mean colour difference of the flame (core + body) from the page; about 2.3 is just noticeable. */
  flameDeltaE: number;
  /** WCAG contrast ratio of the flame body's mean luminance against the page. */
  bodyContrast: number;
  /** Mean luminance of the core divided by that of the glow around the flame: above 1, the core is the brightest thing. */
  coreOverSurround: number;
  /** Mean colour difference of the smoke from the page. */
  smokeDeltaE: number;
  /** Mean colour difference of the glow just outside the flame from the page. */
  glowDeltaE: number;
}

function measure(rgb: Uint8Array, areas: Regions, page: Backdrop): Omit<Row, 'strategy' | 'page'> {
  const pageY = luminance(page[0], page[1], page[2]);
  return {
    flameDeltaE: meanDeltaE(rgb, [...areas.core, ...areas.body], page),
    bodyContrast: contrast(meanLuminance(rgb, areas.body), pageY),
    coreOverSurround: meanLuminance(rgb, areas.core) / meanLuminance(rgb, areas.near),
    smokeDeltaE: meanDeltaE(rgb, areas.smoke, page),
    glowDeltaE: meanDeltaE(rgb, areas.near, page),
  };
}

/** How far the canvas content is from a valid premultiplied colour (no channel above alpha). */
function validity(rgba: Uint8Array) {
  let invalid = 0;
  let drawn = 0;
  let worst = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const peak = Math.max(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
    if (peak === 0 && rgba[i + 3] === 0) continue;
    drawn++;
    if (peak > rgba[i + 3]!) {
      invalid++;
      worst = Math.max(worst, peak - rgba[i + 3]!);
    }
  }
  return { drawn, invalid, worst };
}

/** Two images of the same size side by side with a mid-grey gutter. */
function sideBySide(left: Uint8Array, right: Uint8Array, width: number, height: number) {
  const gutter = 4;
  const total = width * 2 + gutter;
  const out = new Uint8Array(total * height * 3).fill(128);
  for (let y = 0; y < height; y++) {
    out.set(left.subarray(y * width * 3, (y + 1) * width * 3), y * total * 3);
    out.set(right.subarray(y * width * 3, (y + 1) * width * 3), (y * total + width + gutter) * 3);
  }
  return { rgb: out, width: total, height };
}

const fixed = (value: number, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : '—');

describe('compositing study', () => {
  it('renders every strategy over a dark and a light page and measures it', async () => {
    const mounted = await mountHeadless('compositing', { width: WIDTH, height: HEIGHT });
    await mounted.runTo(2);
    // Freeze the flame so every strategy is measured on the same frame.
    mounted.params.speed = 0;

    const render = async (params: Record<string, unknown>) => {
      Object.assign(mounted.params, { cssBlend: 'normal', alphaGain: 1, underlay: 0 }, params);
      mounted.step();
      return mounted.read();
    };

    const reference = await render({ alpha: 'opaque' });
    const coverage = await render({ alpha: 'coverage' });
    const areas = regions(reference, coverage);
    console.log(
      `regions (pixels of ${WIDTH * HEIGHT}): core ${areas.core.length}, body ${areas.body.length}, ` +
        `near ${areas.near.length}, smoke ${areas.smoke.length}`,
    );

    const rows: Row[] = [];
    const contents = new Map<string, Uint8Array>();
    for (const strategy of STRATEGIES) {
      const rgba = await render(strategy.params);
      contents.set(strategy.id, rgba);
      const images = PAGES.map((page) => {
        const rgb = composite(rgba, BACKDROPS[page]!, strategy.blend);
        rows.push({
          strategy: strategy.label,
          page,
          ...measure(rgb, areas, BACKDROPS[page]!),
        });
        return rgb;
      });
      const sheet = sideBySide(images[0]!, images[1]!, WIDTH, HEIGHT);
      writePng(`${OUT}/${strategy.id}.png`, sheet.width, sheet.height, sheet.rgb);
    }

    console.log(
      '\n| Strategy | Page | Flame ΔE | Body contrast | Core / surround | Smoke ΔE | Glow ΔE |',
    );
    console.log('|---|---|---|---|---|---|---|');
    for (const row of rows) {
      console.log(
        `| ${row.strategy} | ${row.page} | ${fixed(row.flameDeltaE)} | ${fixed(row.bodyContrast, 2)} | ` +
          `${fixed(row.coreOverSurround, 2)} | ${fixed(row.smokeDeltaE)} | ${fixed(row.glowDeltaE)} |`,
      );
    }

    // How close is luminance alpha to additive over a dark page? Per channel, in 8-bit steps.
    const additive = contents.get('additive')!;
    const luminanceAlpha = contents.get('luminance')!;
    const defaults = contents.get('underlay-0.3')!;
    console.log('\n| Compared with additive | Page | Max difference | Mean difference |');
    console.log('|---|---|---|---|');
    for (const [name, rgba] of [
      ['luminance, gain 1', luminanceAlpha],
      ['luminance + underlay 0.3', defaults],
    ] as const) {
      for (const page of ['black', 'dark'] as const) {
        const a = composite(additive, BACKDROPS[page]!, 'normal');
        const b = composite(rgba, BACKDROPS[page]!, 'normal');
        let max = 0;
        let sum = 0;
        for (let i = 0; i < a.length; i++) {
          const d = Math.abs(a[i]! - b[i]!);
          max = Math.max(max, d);
          sum += d;
        }
        console.log(`| ${name} | ${page} | ${max} | ${fixed(sum / a.length, 2)} |`);
      }
    }

    console.log('\n| Canvas content | Drawn pixels | Brighter than alpha | Worst excess (8-bit) |');
    console.log('|---|---|---|---|');
    const validityRows: Record<string, ReturnType<typeof validity>> = {};
    for (const id of ['additive', 'coverage', 'luminance', 'luminance-gain3', 'underlay-0.3']) {
      const v = validity(contents.get(id)!);
      validityRows[id] = v;
      console.log(
        `| ${id} | ${v.drawn} | ${v.invalid} (${fixed((100 * v.invalid) / Math.max(1, v.drawn), 0)}%) | ${v.worst} |`,
      );
    }

    // What carries the picture over a light page? The same canvases with the colour taken out of
    // the light (every channel set to the brightest one): hue is all a white page leaves to see.
    console.log('\n| Neutral (white) light, light page | Flame ΔE | Core / surround | Glow ΔE |');
    console.log('|---|---|---|---|');
    const neutralRows: Record<string, Omit<Row, 'strategy' | 'page'>> = {};
    for (const id of ['luminance', 'underlay-0.3', 'underlay-0.6']) {
      const grey = contents.get(id)!.slice();
      for (let i = 0; i < grey.length; i += 4) {
        const peak = Math.max(grey[i]!, grey[i + 1]!, grey[i + 2]!);
        grey.fill(peak, i, i + 3);
      }
      const m = measure(composite(grey, BACKDROPS.light!, 'normal'), areas, BACKDROPS.light!);
      neutralRows[id] = m;
      console.log(
        `| ${id} | ${fixed(m.flameDeltaE)} | ${fixed(m.coreOverSurround, 2)} | ${fixed(m.glowDeltaE)} |`,
      );
    }

    // When is an effect dark-theme-only? The same flame at three brightnesses, with the default
    // strategy, over the light page: a dim glow has little to show, a white-hot one loses its core.
    console.log(
      '\n| Scene (default strategy, light page) | Flame ΔE | Core / surround | Glow ΔE |',
    );
    console.log('|---|---|---|---|');
    for (const [label, params] of [
      ['embers only: intensity 1.5', { intensity: 1.5 }],
      ['default flame: intensity 8', { intensity: 8 }],
      ['white-hot: intensity 30', { intensity: 30 }],
    ] as const) {
      const ref = await render({ alpha: 'opaque', ...params });
      const cov = await render({ alpha: 'coverage', ...params });
      const local = regions(ref, cov);
      const rgba = await render({ alpha: 'luminance', underlay: 0.3, ...params });
      const m = measure(composite(rgba, BACKDROPS.light!, 'normal'), local, BACKDROPS.light!);
      const none = measure(
        composite(
          await render({ alpha: 'luminance', underlay: 0, ...params }),
          BACKDROPS.light!,
          'normal',
        ),
        local,
        BACKDROPS.light!,
      );
      console.log(
        `| ${label} (core ${local.core.length} px, body ${local.body.length} px) | ${fixed(m.flameDeltaE)} | ` +
          `${fixed(m.coreOverSurround, 2)} (no underlay ${fixed(none.coreOverSurround, 2)}) | ${fixed(m.glowDeltaE)} |`,
      );
    }
    await render({ intensity: 8 });

    writeFileSync(
      `${OUT}/metrics.json`,
      `${JSON.stringify(
        {
          note: 'Written by experiments/compositing.test.ts. CSS blend rows are simulated.',
          size: [WIDTH, HEIGHT],
          pages: { dark: BACKDROPS.dark, light: BACKDROPS.light },
          regions: Object.fromEntries(Object.entries(areas).map(([k, v]) => [k, v.length])),
          rows,
          validity: validityRows,
          neutralLightOverLightPage: neutralRows,
        },
        (_key, value: unknown) =>
          typeof value === 'number' ? Math.round(value * 1000) / 1000 : value,
        2,
      )}\n`,
    );
    mounted.destroy();
  });
});
