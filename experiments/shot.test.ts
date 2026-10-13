import { describe, it, vi } from 'vitest';
import { getTestDevice } from '../tests/gpu.ts';
import { BACKDROPS, compositeOver, mountHeadless, writePng } from '../tests/headless.ts';

// Screenshot tool: renders a registered effect headlessly and writes PNGs. Driven by
// scripts/shot.mjs (`npm run shot -- <effect> ...`), which sets the SHOT_* variables.

vi.setConfig({ testTimeout: 600_000 });

const env = process.env;

describe.skipIf(!env.SHOT_EFFECT)('shot', () => {
  it('renders', async () => {
    const id = env.SHOT_EFFECT!;
    const out = env.SHOT_OUT ?? 'output/shots';
    const [width, height] = (env.SHOT_SIZE ?? '960x540').split('x').map(Number) as [number, number];
    const times = (env.SHOT_TIMES ?? '1').split(',').map(Number);
    const pages = (env.SHOT_BG ?? 'dark').split(',');
    const preset = env.SHOT_PRESET || undefined;

    const params = JSON.parse(env.SHOT_PARAMS ?? '{}') as Record<string, unknown>;
    // Two renders of one preset with different parameters must not overwrite each other.
    const tag =
      env.SHOT_TAG ||
      (Object.keys(params).length > 0
        ? Object.entries(params)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(',')
            .replace(/[^\w.,=-]/g, '')
            .slice(0, 60)
        : undefined);

    // A shader that fails to compile still "renders" (an empty frame); make that a failure.
    const device = await getTestDevice();
    device.pushErrorScope('validation');
    const mounted = await mountHeadless(id, { width, height, preset, params });
    for (const seconds of times) {
      await mounted.runTo(seconds);
      const rgba = await mounted.read();
      for (const page of pages) {
        const backdrop = BACKDROPS[page];
        if (!backdrop) throw new Error(`Unknown backdrop "${page}" (${Object.keys(BACKDROPS)})`);
        const name = [id, preset, tag, `${seconds}s`, pages.length > 1 ? page : undefined]
          .filter(Boolean)
          .join('-');
        const path = `${out}/${name}.png`;
        writePng(path, width, height, compositeOver(rgba, backdrop));
        console.log(`shot: ${path}`);
      }
    }
    mounted.destroy();
    const invalid = await device.popErrorScope();
    if (invalid) throw new Error(`"${id}" raised a WebGPU validation error: ${invalid.message}`);
  });
});
