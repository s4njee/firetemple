// Runs a cost study and files the results (story 1.8). One command for every epic:
//
//   npm run study -- --epic 3 [--device "Apple M1 Max"] [--class apple-silicon]
//                             [--sizes 1920x1080,960x540] [--effects a,b] [--no-build]
//
// 1. Builds the site and records what each effect costs to download (docs/studies/bundle-sizes.json).
// 2. Measures GPU time headlessly on Dawn (tests/study.test.ts, method in tests/bench.ts)
//    -> docs/studies/epic-<n>.json.
// 3. Writes docs/studies/epic-<n>.md from that JSON.
// 4. Updates src/effects/measured.json, which the Scorecard tab reads: the bundle size and the
//    1080p default-settings GPU time of each measured effect, per device.
//
// Run it with nothing else using the GPU. The numbers describe this machine only.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const epic = option('epic');
const effects = option('effects');
if (!epic && !effects) {
  console.error(
    'usage: npm run study -- --epic <n> [--device name] [--class c] [--sizes WxH,WxH] [--effects a,b] [--no-build]',
  );
  process.exit(1);
}
const name = epic ? `epic-${epic}` : 'selected';
const jsonPath = `docs/studies/${name}.json`;
const markdownPath = `docs/studies/${name}.md`;
const bundlePath = 'docs/studies/bundle-sizes.json';
const measuredPath = 'src/effects/measured.json';

function run(command, commandArgs, env = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!args.includes('--no-build')) {
  run('npx', ['vite', 'build']);
  run('node', ['scripts/check-bundle.mjs', '--json', bundlePath]);
}

run('npx', ['vitest', 'run', 'tests/study.test.ts', '--maxWorkers=1'], {
  STUDY_OUT: jsonPath,
  STUDY_EPIC: epic ?? '',
  ...(effects ? { STUDY_EFFECTS: effects } : {}),
  ...(option('sizes') ? { STUDY_SIZES: option('sizes') } : {}),
  ...(option('device') ? { STUDY_DEVICE: option('device') } : {}),
  ...(option('class') ? { STUDY_CLASS: option('class') } : {}),
});

const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
const bundles = existsSync(bundlePath) ? JSON.parse(readFileSync(bundlePath, 'utf8')) : undefined;

// --- Markdown report -----------------------------------------------------------------------------

const ms = (value) => (Number.isFinite(value) ? value.toFixed(2) : 'failed');
const sizesMeasured = [...new Set(report.rows.map((row) => `${row.width}x${row.height}`))];
const lines = [
  `# Cost study: ${epic ? `Epic ${epic}` : 'selected effects'}`,
  '',
  `Measured ${report.measuredAt.slice(0, 10)} on **${report.device}** (${report.deviceClass}), ${report.runtime}.`,
  '',
  `Method: ${report.method.metric}. ${report.method.warmupFrames} warm-up frames, then the median of ${report.method.rounds} rounds; each round encodes the frame once and ${report.method.repeats} times in one command buffer.`,
  '',
  '- **span** is one frame alone, first pass start to last pass end. It includes the timing floor of this adapter (the `(floor)` row).',
  '- **per frame** is the cost of one more frame of the same work (the slope). It is the number to compare effects by, and the one the Scorecard shows.',
  '- `(tail)` is the HDR tail alone at its default settings. Every effect below includes it.',
  '',
  report.note,
  '',
  "Two limits on reading these numbers. Repeated runs of a light effect differ by up to about half a millisecond (see the Range column), and a GPU's clock follows its load, so a light effect can read slower per unit of work than a heavy one: differences under about half a millisecond mean nothing. And the Tier A and B budgets are set for an integrated GPU; a time measured on a faster one can show an effect is over budget but cannot show that it fits.",
  '',
];
for (const size of sizesMeasured) {
  lines.push(`## ${size.replace('x', ' × ')}`, '');
  lines.push('| Effect | Configuration | Passes | Span (ms) | Per frame (ms) | Range (ms) |');
  lines.push('| --- | --- | ---: | ---: | ---: | --- |');
  for (const row of report.rows.filter((r) => `${r.width}x${r.height}` === size)) {
    const range = Number.isFinite(row.slopeMinMs)
      ? `${ms(row.slopeMinMs)} to ${ms(row.slopeMaxMs)}`
      : (row.error ?? '');
    lines.push(
      `| ${row.effect} | ${row.config} | ${row.passes} | ${ms(row.spanMs)} | ${ms(row.slopeMs)} | ${range} |`,
    );
  }
  lines.push('');
}
if (bundles) {
  const ids = [...new Set(report.rows.map((row) => row.effect))].filter(
    (id) => bundles.effects[id],
  );
  lines.push('## Download size', '');
  lines.push(
    `What the page fetches to show the effect, beyond the first-load bundle (${(bundles.eager.gzip / 1024).toFixed(1)} kB gzipped, no shaders).`,
    '',
  );
  lines.push(
    '| Effect | Chunks | Own chunk (kB gzip) | Total (kB gzip) |',
    '| --- | ---: | ---: | ---: |',
  );
  for (const id of ids) {
    const entry = bundles.effects[id];
    lines.push(
      `| ${id} | ${entry.chunks} | ${(entry.ownGzip / 1024).toFixed(1)} | ${(entry.gzip / 1024).toFixed(1)} |`,
    );
  }
  lines.push('');
}
writeFileSync(markdownPath, `${lines.join('\n')}`);
console.log(`wrote ${markdownPath}`);

// --- Scorecard numbers ---------------------------------------------------------------------------

const measured = existsSync(measuredPath) ? JSON.parse(readFileSync(measuredPath, 'utf8')) : {};
for (const row of report.rows) {
  if (row.config !== 'default' || row.width !== 1920 || row.height !== 1080) continue;
  if (!Number.isFinite(row.slopeMs) || row.metric !== 'gpu-timestamp') continue;
  const entry = (measured[row.effect] ??= {});
  const sample = {
    device: report.device,
    deviceClass: report.deviceClass,
    ms: Math.max(0.01, +row.slopeMs.toFixed(2)),
  };
  entry.gpuMs = [...(entry.gpuMs ?? []).filter((s) => s.device !== report.device), sample];
}
if (bundles) {
  for (const [id, entry] of Object.entries(bundles.effects)) {
    (measured[id] ??= {}).bundleKb = entry.gzipKb;
  }
}
const sorted = Object.fromEntries(Object.entries(measured).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(measuredPath, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`updated ${measuredPath}`);
