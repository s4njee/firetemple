import { describe, expect, it, vi } from 'vitest';
import {
  ALPHA_MODES,
  createOutputPass,
  OVERLAY_PARAMS,
  tailSettings,
  type OutputSettings,
} from '../src/gpu/post/index.ts';
import { expectValid, getTestDevice, readTexture } from './gpu.ts';
import { BACKDROPS, compositeOver, mountHeadless } from './headless.ts';

// Story 3.3: what the output pass writes to a see-through, premultiplied canvas. The browser shows
// `rgb + (1 - alpha) * page`, so these tests are about alpha, and about the composite it leads to.

vi.setConfig({ testTimeout: 30_000 });

const USAGE =
  GPUTextureUsage.RENDER_ATTACHMENT |
  GPUTextureUsage.TEXTURE_BINDING |
  GPUTextureUsage.COPY_SRC |
  GPUTextureUsage.COPY_DST;

type Rgba = readonly [number, number, number, number];
type Rgb = readonly [number, number, number];

function halfBits(value: number): number {
  if (value === 0) return 0;
  const bits = new Uint32Array(new Float32Array([value]).buffer)[0] ?? 0;
  return (
    ((bits >>> 16) & 0x8000) | ((((bits >>> 23) & 0xff) - 112) << 10) | ((bits >>> 13) & 0x3ff)
  );
}

/** A width x 1 rgba16float strip. */
function strip(device: GPUDevice, texels: readonly (Rgba | Rgb)[]): GPUTexture {
  const texture = device.createTexture({
    size: [texels.length, 1],
    format: 'rgba16float',
    usage: USAGE,
  });
  const bits = new Uint16Array(texels.length * 4);
  texels.forEach(([r, g, b, a = 0], x) => {
    bits.set([halfBits(r), halfBits(g), halfBits(b), halfBits(a)], x * 4);
  });
  device.queue.writeTexture({ texture }, bits, { bytesPerRow: texels.length * 8 }, [
    texels.length,
    1,
  ]);
  return texture;
}

/** Runs the output pass over a strip of scene texels (linear radiance + coverage) and optional bloom. */
async function output(
  scene: readonly Rgba[],
  settings: OutputSettings,
  bloom?: readonly Rgb[],
): Promise<Rgba[]> {
  const device = await getTestDevice();
  const sceneTexture = strip(device, scene);
  const bloomTexture = bloom ? strip(device, bloom) : undefined;
  const target = device.createTexture({
    size: [scene.length, 1],
    format: 'rgba8unorm',
    usage: USAGE,
  });
  const pass = createOutputPass(device, { format: 'rgba8unorm' });
  await expectValid(device, () => {
    const encoder = device.createCommandEncoder();
    pass.encode(
      encoder,
      target.createView(),
      sceneTexture.createView(),
      bloomTexture?.createView(),
      settings,
    );
    device.queue.submit([encoder.finish()]);
  });
  const bytes = await readTexture(device, target);
  pass.destroy();
  for (const texture of [sceneTexture, bloomTexture, target]) texture?.destroy();
  return scene.map((_, i) => [...bytes.subarray(i * 4, i * 4 + 4)] as unknown as Rgba);
}

/** Small deterministic PRNG (mulberry32). */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fire-like HDR texels from black to far above white, with no coverage unless `alpha` gives one. */
function randomScene(count: number, seed: number, alpha: (r: () => number) => number = () => 0) {
  const random = makeRandom(seed);
  return Array.from({ length: count }, (): Rgba => {
    const level = 10 ** (random() * 4 - 2.5); // 0.003 .. 30
    return [level, level * random(), level * random() * random(), alpha(random)];
  });
}

/** A scene whose texels span emission only, coverage only, both, and nothing. */
const MIXED: Rgba[] = [
  [0, 0, 0, 0],
  [8, 3, 0.4, 0],
  [0.02, 0.02, 0.02, 0.5],
  [0.3, 0.1, 0.02, 0.25],
  [0.004, 0.003, 0.003, 1],
  [40, 30, 20, 0.1],
  [0.05, 0.01, 0, 0],
];

const peak = (texel: Rgba) => Math.max(texel[0], texel[1], texel[2]);

describe('alpha modes of the output pass', () => {
  it('lists the modes the tail accepts, and defaults to opaque', async () => {
    expect([...ALPHA_MODES]).toEqual(['opaque', 'additive', 'coverage', 'luminance']);
    const plain = await output(MIXED, { dither: 0 });
    for (const texel of plain) expect(texel[3]).toBe(255);
    // Opaque ignores the underlay and the scene's alpha entirely.
    const withUnderlay = await output(
      MIXED,
      { dither: 0, underlay: 1 },
      MIXED.map(() => [2, 1, 0.5]),
    );
    for (const texel of withUnderlay) expect(texel[3]).toBe(255);
  });

  it('writes the same colour in every mode: only alpha differs', async () => {
    const opaque = await output(MIXED, { dither: 0 });
    for (const alpha of ['additive', 'coverage', 'luminance'] as const) {
      const out = await output(MIXED, { dither: 0, alpha });
      out.forEach((texel, i) => expect(texel.slice(0, 3)).toEqual(opaque[i]?.slice(0, 3)));
    }
  });

  describe('additive', () => {
    it('writes alpha 0 everywhere, whatever the scene alpha', async () => {
      const scene = randomScene(256, 1, (r) => r());
      const out = await output(scene, { alpha: 'additive', frame: 5 });
      for (const texel of out) expect(texel[3]).toBe(0);
      expect(Math.max(...out.map(peak))).toBe(255);
    });

    it('leaves fully dark pixels exactly (0, 0, 0, 0), dither included', async () => {
      const dark: Rgba[] = Array.from({ length: 512 }, (_, i) => [0, 0, 0, i % 2]);
      for (const frame of [0, 1, 17]) {
        const out = await output(dark, { alpha: 'additive', dither: 1, frame });
        for (const texel of out) expect([...texel]).toEqual([0, 0, 0, 0]);
      }
    });

    it('is invisible over white and plain addition over black', async () => {
      const scene = randomScene(128, 2);
      const out = await output(scene, { alpha: 'additive', dither: 0 });
      const bytes = Uint8Array.from(out.flat());
      expect([...compositeOver(bytes, BACKDROPS.white!)].every((v) => v === 255)).toBe(true);
      const overBlack = compositeOver(bytes, BACKDROPS.black!);
      out.forEach((texel, i) =>
        expect([...overBlack.subarray(i * 3, i * 3 + 3)]).toEqual(texel.slice(0, 3)),
      );
    });
  });

  describe('coverage', () => {
    it('passes the scene alpha through, clamped to 0..1', async () => {
      const alphas = [0, 0.1, 0.25, 0.5, 0.75, 1, 1.7, -0.3];
      const scene = alphas.map((a): Rgba => [0.02, 0.02, 0.02, a]);
      const out = await output(scene, { alpha: 'coverage', dither: 0 });
      alphas.forEach((a, i) => {
        const expected = Math.min(1, Math.max(0, a)) * 255;
        expect(Math.abs((out[i]?.[3] ?? -9) - expected)).toBeLessThanOrEqual(0.51);
      });
    });

    it('does not turn light into coverage: emission with no scene alpha stays at alpha 0', async () => {
      const out = await output(
        [
          [20, 8, 1, 0],
          [0.5, 0.2, 0.05, 0],
        ],
        { alpha: 'coverage', dither: 0 },
      );
      for (const texel of out) {
        expect(texel[3]).toBe(0);
        expect(peak(texel)).toBeGreaterThan(0);
      }
    });
  });

  describe('luminance', () => {
    it('is the brightest written channel at gain 1, so the colour is valid premultiplied', async () => {
      const scene = randomScene(512, 3);
      const out = await output(scene, { alpha: 'luminance', alphaGain: 1, dither: 0 });
      for (const texel of out) expect(texel[3]).toBe(peak(texel));
    });

    it.each([1, 1.5, 4])(
      'alpha >= every channel with gain %s, with the dither on',
      async (alphaGain) => {
        for (const frame of [0, 3, 40]) {
          const scene = randomScene(1024, 10 + frame, (r) => (r() < 0.3 ? r() : 0));
          const out = await output(scene, { alpha: 'luminance', alphaGain, dither: 1, frame });
          const invalid = out.filter((texel) => peak(texel) > texel[3]);
          expect(invalid).toEqual([]);
        }
      },
    );

    it('scales with the gain and never drops below the scene alpha', async () => {
      const dim: Rgba[] = [[0.02, 0.008, 0.001, 0]];
      const one = await output(dim, { alpha: 'luminance', alphaGain: 1, dither: 0 });
      const two = await output(dim, { alpha: 'luminance', alphaGain: 2, dither: 0 });
      const half = await output(dim, { alpha: 'luminance', alphaGain: 0.5, dither: 0 });
      const a = one[0]?.[3] ?? 0;
      expect(a).toBeGreaterThan(20);
      expect(a).toBeLessThan(120);
      expect(Math.abs((two[0]?.[3] ?? 0) - 2 * a)).toBeLessThanOrEqual(1);
      expect(Math.abs((half[0]?.[3] ?? 0) - a / 2)).toBeLessThanOrEqual(1);
      // A gain of 0 leaves only the coverage, which is what `coverage` writes.
      const none = await output(MIXED, { alpha: 'luminance', alphaGain: 0, dither: 0 });
      const coverage = await output(MIXED, { alpha: 'coverage', dither: 0 });
      expect(none).toEqual(coverage);

      // Dark smoke: far more coverage than light. The coverage wins.
      const smoke = await output([[0.002, 0.002, 0.002, 0.6]], { alpha: 'luminance', dither: 0 });
      expect(smoke[0]?.[3]).toBe(153);
      // Saturated light is fully opaque.
      const hot = await output([[30, 12, 2, 0]], { alpha: 'luminance', dither: 0 });
      expect(hot[0]?.[3]).toBe(255);
    });

    it('leaves fully dark, uncovered pixels exactly (0, 0, 0, 0)', async () => {
      const dark: Rgba[] = Array.from({ length: 256 }, () => [0, 0, 0, 0]);
      const out = await output(dark, { alpha: 'luminance', dither: 1, frame: 9 });
      for (const texel of out) expect([...texel]).toEqual([0, 0, 0, 0]);
    });

    it('looks like additive over a dark page and still shows over a white one', async () => {
      const scene = randomScene(512, 4);
      const settings: OutputSettings = { dither: 0 };
      const additive = Uint8Array.from(
        (await output(scene, { ...settings, alpha: 'additive' })).flat(),
      );
      const luminance = Uint8Array.from(
        (await output(scene, { ...settings, alpha: 'luminance' })).flat(),
      );
      // Over black the two are the same picture.
      expect([...compositeOver(luminance, BACKDROPS.black!)]).toEqual([
        ...compositeOver(additive, BACKDROPS.black!),
      ]);
      // Over the dark page luminance hides at most the page itself (14 steps of 255), never adds.
      const page = BACKDROPS.dark!;
      const a = compositeOver(additive, page);
      const l = compositeOver(luminance, page);
      const pageMax = Math.max(...page);
      a.forEach((value, i) => {
        expect(l[i]).toBeLessThanOrEqual(value);
        expect(value - (l[i] ?? 0)).toBeLessThanOrEqual(pageMax + 1);
      });
      // Over white additive is gone; luminance leaves the flame's colour: full red, less green
      // and blue than the page.
      const overWhite = compositeOver(luminance, BACKDROPS.white!);
      const visible = scene.filter((_, i) => 255 - (overWhite[i * 3 + 2] ?? 255) > 40).length;
      expect(visible).toBeGreaterThan(scene.length / 3);
      for (let i = 0; i < scene.length; i++) expect(overWhite[i * 3]).toBe(255);
    });
  });

  describe('underlay', () => {
    const glow: Rgb[] = [0, 0.002, 0.01, 0.05, 0.2, 1, 5, 50].map((v) => [v, v * 0.4, v * 0.1]);
    const empty: Rgba[] = glow.map(() => [0, 0, 0, 0]);

    it('is off at 0: identical output in every mode', async () => {
      for (const alpha of ['additive', 'coverage', 'luminance'] as const) {
        const without = await output(MIXED, { alpha, dither: 0 });
        const zero = await output(MIXED, { alpha, dither: 0, underlay: 0 });
        const withBloom = await output(
          MIXED,
          { alpha, dither: 0, underlay: 0 },
          MIXED.map(() => [0, 0, 0]),
        );
        expect(zero).toEqual(without);
        expect(withBloom).toEqual(without);
      }
    });

    it('does nothing without bloom to mask it', async () => {
      const out = await output(MIXED, { alpha: 'additive', dither: 0, underlay: 1 });
      for (const texel of out) expect(texel[3]).toBe(0);
    });

    it.each([0.25, 0.5, 1])(
      'is bounded by its setting (%s) and grows with the glow',
      async (underlay) => {
        const out = await output(empty, { alpha: 'additive', dither: 0, underlay }, glow);
        const alphas = out.map((texel) => texel[3]);
        expect(alphas[0]).toBe(0);
        for (let i = 1; i < alphas.length; i++) {
          expect(alphas[i]).toBeGreaterThanOrEqual(alphas[i - 1] ?? 0);
        }
        for (const a of alphas) expect(a).toBeLessThanOrEqual(Math.round(underlay * 255));
        // Under saturated glow the page is dimmed by exactly the setting.
        expect(alphas.at(-1)).toBe(Math.round(underlay * 255));
        // It reaches further than the light: more page hidden than the glow's own brightness.
        const faint = out[2]!;
        if (underlay === 1) expect(faint[3]).toBeGreaterThan(peak(faint));
      },
    );

    it('clamps settings outside 0..1', async () => {
      const over = await output(empty, { alpha: 'additive', dither: 0, underlay: 7 }, glow);
      const one = await output(empty, { alpha: 'additive', dither: 0, underlay: 1 }, glow);
      const under = await output(empty, { alpha: 'additive', dither: 0, underlay: -2 }, glow);
      const zero = await output(empty, { alpha: 'additive', dither: 0, underlay: 0 }, glow);
      expect(over).toEqual(one);
      expect(under).toEqual(zero);
    });

    it('multiplies with the mode alpha: it only ever hides more of the page', async () => {
      const bloom = MIXED.map((): Rgb => [0.05, 0.02, 0.005]);
      for (const alpha of ['coverage', 'luminance'] as const) {
        const without = await output(MIXED, { alpha, dither: 0 }, bloom);
        const withUnderlay = await output(MIXED, { alpha, dither: 0, underlay: 0.5 }, bloom);
        const veil =
          (
            await output([[0, 0, 0, 0]], { alpha: 'additive', dither: 0, underlay: 0.5 }, [
              bloom[0]!,
            ])
          )[0]![3] / 255;
        expect(veil).toBeGreaterThan(0.1);
        withUnderlay.forEach((texel, i) => {
          const base = (without[i]?.[3] ?? 0) / 255;
          expect(texel.slice(0, 3)).toEqual(without[i]?.slice(0, 3));
          expect(texel[3]).toBeGreaterThanOrEqual(without[i]?.[3] ?? 0);
          expect(Math.abs(texel[3] / 255 - (1 - (1 - base) * (1 - veil)))).toBeLessThan(2 / 255);
        });
      }
    });

    it('keeps luminance output valid premultiplied, and changes nothing over black', async () => {
      const scene = randomScene(256, 6);
      const bloom = scene.map(([r, g, b]): Rgb => [r * 0.2, g * 0.2, b * 0.2]);
      const settings: OutputSettings = { alpha: 'luminance', dither: 0 };
      const without = await output(scene, settings, bloom);
      const withUnderlay = await output(scene, { ...settings, underlay: 0.6 }, bloom);
      for (const texel of withUnderlay) expect(texel[3]).toBeGreaterThanOrEqual(peak(texel));
      const black = BACKDROPS.black!;
      expect([...compositeOver(Uint8Array.from(withUnderlay.flat()), black)]).toEqual([
        ...compositeOver(Uint8Array.from(without.flat()), black),
      ]);
      // Over white the glow is darker with the underlay than without it.
      const white = BACKDROPS.white!;
      const a = compositeOver(Uint8Array.from(without.flat()), white);
      const b = compositeOver(Uint8Array.from(withUnderlay.flat()), white);
      b.forEach((value, i) => expect(value).toBeLessThanOrEqual(a[i] ?? 0));
      expect(b.reduce((s, v) => s + v, 0)).toBeLessThan(a.reduce((s, v) => s + v, 0));
    });
  });
});

describe('overlay parameters', () => {
  const time = { time: 0, delta: 1 / 60, frame: 7 };
  const tail = { exposure: 1, bloom: 0.6, bloomThreshold: 1, bloomRadius: 0.7 };

  it('default to luminance alpha at gain 1 with a light underlay (docs/compositing-study.md)', () => {
    expect(OVERLAY_PARAMS.alpha.default).toBe('luminance');
    expect(OVERLAY_PARAMS.alpha.options).toBe(ALPHA_MODES);
    expect(OVERLAY_PARAMS.alphaGain.default).toBe(1);
    expect(OVERLAY_PARAMS.underlay.default).toBeGreaterThan(0);
    expect(OVERLAY_PARAMS.underlay.default).toBeLessThanOrEqual(0.5);
  });

  it('reach the output pass through the tail, and an effect without them stays opaque', () => {
    expect(tailSettings(tail, time).output).toMatchObject({ alpha: 'opaque', frame: 7 });
    const overlay = tailSettings(
      { ...tail, alpha: 'luminance', alphaGain: 2, underlay: 0.4 },
      time,
    );
    expect(overlay.output).toMatchObject({ alpha: 'luminance', alphaGain: 2, underlay: 0.4 });
    // A value that is not a mode (a stale URL, say) falls back to opaque instead of throwing.
    expect(tailSettings({ ...tail, alpha: 'nonsense' }, time).output?.alpha).toBe('opaque');
  });
});

describe('the compositing effect', () => {
  const render = async (preset: string) => {
    const mounted = await mountHeadless('compositing', { width: 96, height: 96, preset });
    await mounted.runTo(0.25);
    const rgba = await mounted.read();
    mounted.destroy();
    return rgba;
  };
  const effectDefaults = () =>
    Object.fromEntries(Object.entries(OVERLAY_PARAMS).map(([key, def]) => [key, def.default]));
  const texels = (rgba: Uint8Array) =>
    Array.from({ length: rgba.length / 4 }, (_, i) => rgba.subarray(i * 4, i * 4 + 4));

  it('additive preset: alpha 0 everywhere, and light somewhere', async () => {
    const out = texels(await render('additive'));
    expect(out.every((t) => t[3] === 0)).toBe(true);
    expect(out.some((t) => t[0]! > 200)).toBe(true);
  });

  it('recommended preset: valid premultiplied colour, opaque in the flame, clear at the corners', async () => {
    const rgba = await render('recommended');
    const out = texels(rgba);
    expect(effectDefaults()).toMatchObject({ alpha: 'luminance', alphaGain: 1, underlay: 0.3 });
    expect(out.filter((t) => Math.max(t[0]!, t[1]!, t[2]!) > t[3]!)).toEqual([]);
    expect(out.some((t) => t[3] === 255 && t[0]! > 240)).toBe(true);
    expect([...out[0]!]).toEqual([0, 0, 0, 0]);
    // It shows over white: some pixels end up clearly not white.
    const overWhite = compositeOver(rgba, BACKDROPS.white!);
    let changed = 0;
    for (let i = 0; i < overWhite.length; i += 3) if (overWhite[i + 2]! < 200) changed++;
    expect(changed).toBeGreaterThan(50);
  });

  it('coverage preset: the logs are opaque, the smoke partly covers, the flame adds', async () => {
    const out = texels(await render('coverage'));
    expect(out.some((t) => t[3] === 255)).toBe(true);
    expect(out.some((t) => t[3]! > 20 && t[3]! < 235)).toBe(true);
    // Flame pixels: bright and with no coverage, i.e. brighter than their alpha.
    expect(out.some((t) => t[0]! > 240 && t[3]! < 10)).toBe(true);
  });

  it('the underlay hides more of the page the higher it is set, and adds no light', async () => {
    const plain = texels(await render('no underlay'));
    const under = texels(await render('heavy underlay'));
    let more = 0;
    under.forEach((t, i) => {
      expect(t[3]).toBeGreaterThanOrEqual((plain[i]?.[3] ?? 0) - 1);
      // Same light either way, give or take the dither.
      for (let c = 0; c < 3; c++) expect(Math.abs(t[c]! - (plain[i]?.[c] ?? 0))).toBeLessThan(4);
      if (t[3]! > (plain[i]?.[3] ?? 0) + 8) more++;
    });
    expect(more).toBeGreaterThan(100);
  });
});
