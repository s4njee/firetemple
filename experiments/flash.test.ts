import { describe, it, vi } from 'vitest';
import { measureFlashes, SMALL_AREA_PX } from '../tests/flash.ts';

// Prints the flash analysis of chosen effects (tests/flash.ts):
//
//   FLASH_EFFECTS=fire-light,flicker FLASH_PARAMS='{"flicker":1}' FLASH_SECONDS=10 \
//     npx vitest run --silent=false --config experiments/vite.config.ts experiments/flash.test.ts

vi.setConfig({ testTimeout: 600_000 });

const ids = (process.env.FLASH_EFFECTS ?? '').split(',').filter(Boolean);

describe.skipIf(ids.length === 0)('flash report', () => {
  it.each(ids)('%s', async (id) => {
    const report = await measureFlashes(id, {
      seconds: Number(process.env.FLASH_SECONDS ?? 8),
      preset: process.env.FLASH_PRESET || undefined,
      params: JSON.parse(process.env.FLASH_PARAMS ?? '{}') as Record<string, unknown>,
    });
    console.log(`flash ${id}: ${JSON.stringify({ ...report, areaThresholdPx: SMALL_AREA_PX })}`);
  });
});
