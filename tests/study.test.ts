import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { listEffects, loadEffect } from '../src/effects/registry.ts';
import { createFullscreenPipeline, renderFullscreen } from '../src/gpu/fullscreen.ts';
import { createHdrTail, TAIL_PARAMS } from '../src/gpu/post/index.ts';
import { libraryChunks } from '../src/gpu/shader.ts';
import fullscreen from '../src/wgsl/fullscreen.wgsl';
import { defaultParams } from '../src/effects/types.ts';
import { createBenchDevice, REPEATS, ROUNDS, WARMUP_FRAMES, type Measurement } from './bench.ts';
import { mountHeadless } from './headless.ts';
import { STUDY_SWEEPS, type StudyConfig } from './studies.ts';

// A cost study: every effect of one epic, at its defaults, each preset and any sweep listed in
// tests/studies.ts, at fixed resolutions. Opt-in (`npm run study -- --epic 3`): this is a
// measurement workload, never a timing assertion, and it is skipped in the normal test run.

const out = process.env.STUDY_OUT;
const epic = process.env.STUDY_EPIC ?? '';
const only = process.env.STUDY_EFFECTS?.split(',').filter(Boolean);
const sizes = (process.env.STUDY_SIZES ?? '1920x1080,960x540')
  .split(',')
  .map((size) => size.split('x').map(Number) as [number, number]);

vi.setConfig({ testTimeout: 3_600_000 });

interface Row extends Measurement {
  effect: string;
  config: string;
  width: number;
  height: number;
  params?: Readonly<Record<string, unknown>>;
  error?: string;
}

describe.skipIf(!out)('cost study', () => {
  it(`measures epic ${epic || '(selected effects)'}`, async () => {
    const bench = await createBenchDevice();
    const { device } = bench;
    const rows: Row[] = [];

    const metas = listEffects().filter((meta) =>
      only ? only.includes(meta.id) : meta.epic === epic,
    );
    expect(metas.length).toBeGreaterThan(0);

    const configs: StudyConfig[] = [];
    for (const meta of metas) {
      const effect = await loadEffect(meta.id);
      configs.push({ effect: meta.id, name: 'default' });
      for (const preset of Object.keys(effect.presets ?? {})) {
        configs.push({ effect: meta.id, name: `preset ${preset}`, preset });
      }
    }
    for (const sweep of STUDY_SWEEPS[epic] ?? []) {
      if (metas.some((meta) => meta.id === sweep.effect)) configs.push(sweep);
    }

    for (const [width, height] of sizes) {
      const target = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const view = target.createView();

      // Baselines, so every number in the report can be read against them: what the smallest
      // possible frame reads on this adapter, and what the HDR tail alone costs. Both draw a
      // triangle: a pass with no draw call gets unreliable timestamps (Metal may never start it).
      const fill = (format: GPUTextureFormat) =>
        createFullscreenPipeline(device, {
          fragment: {
            label: `study/fill-${format}.wgsl`,
            // Above the bloom threshold, so every level of the chain has work to do.
            code: '#include "fullscreen.wgsl"\n@fragment fn fs() -> @location(0) vec4f { return vec4f(4.0, 1.5, 0.2, 1.0); }',
            chunks: libraryChunks(fullscreen),
          },
          format,
        });
      const fillCanvas = fill('rgba8unorm');
      rows.push({
        effect: '(floor)',
        config: 'one constant-colour pass',
        width,
        height,
        ...(await bench.measure((encoder) =>
          renderFullscreen(encoder, view, fillCanvas, [], {
            timestampWrites: bench.profiler.pass('floor'),
          }),
        )),
      });

      const tail = createHdrTail(device, { format: 'rgba8unorm', label: 'study tail' });
      tail.resize(width, height);
      const fillScene = fill(tail.scene.format);
      const tailValues = defaultParams(TAIL_PARAMS);
      let frame = 0;
      rows.push({
        effect: '(tail)',
        config: 'constant scene + bloom + output',
        width,
        height,
        ...(await bench.measure((encoder) => {
          renderFullscreen(encoder, tail.scene.view, fillScene, [], {
            timestampWrites: bench.profiler.pass('scene'),
          });
          tail.encode(
            encoder,
            view,
            { time: frame / 60, delta: 1 / 60, frame: frame++ },
            tailValues,
            bench.profiler,
          );
        })),
      });
      tail.destroy();
      target.destroy();

      for (const config of configs) {
        const base = { effect: config.effect, config: config.name, width, height };
        device.pushErrorScope('validation');
        try {
          const mounted = await mountHeadless(config.effect, {
            width,
            height,
            preset: config.preset,
            params: config.params,
            device,
            profiler: bench.profiler,
          });
          const measurement = await bench.measure((encoder) => mounted.encode(encoder));
          mounted.destroy();
          const invalid = await device.popErrorScope();
          rows.push({
            ...base,
            params: config.params,
            ...measurement,
            ...(invalid ? { error: invalid.message } : {}),
          });
        } catch (error) {
          await device.popErrorScope();
          rows.push({
            ...base,
            spanMs: Number.NaN,
            slopeMs: Number.NaN,
            slopeMinMs: Number.NaN,
            slopeMaxMs: Number.NaN,
            passes: 0,
            metric: 'cpu-wall',
            error: String(error),
          });
        }
      }
    }

    const { info } = bench.adapter;
    const report = {
      epic: epic || null,
      measuredAt: new Date().toISOString(),
      device: process.env.STUDY_DEVICE || info.description || info.device || 'unknown adapter',
      deviceClass: process.env.STUDY_CLASS || 'unclassified',
      adapter: {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
      },
      runtime: 'Dawn (node webgpu bindings)',
      method: {
        metric: bench.timed
          ? 'GPU timestamps: frame span (first pass start to last pass end) and marginal cost per extra frame'
          : 'CPU wall time around submit (no timestamp-query on this adapter)',
        warmupFrames: WARMUP_FRAMES,
        rounds: ROUNDS,
        repeats: REPEATS,
      },
      note:
        'Only this adapter was measured. spanMs includes the timing floor (see the "(floor)" rows); ' +
        'slopeMs is the cost of one more frame of the same work and is the number to compare by. ' +
        'A slope at or below zero means the work is below what this method can resolve.',
      rows,
    };
    mkdirSync(dirname(out!), { recursive: true });
    writeFileSync(out!, `${JSON.stringify(report, null, 2)}\n`);
    bench.destroy();

    expect(rows.filter((row) => row.error).map((row) => `${row.effect}: ${row.error}`)).toEqual([]);
  });
});
