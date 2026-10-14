// Run after `vite build`. Three jobs:
//
//   1. Fail if any WGSL reached the first page load. Shaders belong to the effect that uses them
//      (see vite-plugin-wgsl.ts); Water Temple's shared library grew into one 70 kB eager chunk.
//   2. Report what each effect costs to download: its own lazy chunk plus every chunk it pulls in
//      that the page had not already loaded. `--json <file>` writes the table for the cost studies.
//   3. Enforce the committed gzip budget (`bundle-budget.json`) for the eager bundle and each
//      effect. `--update-budget` rewrites it from the current build (M4 story 4.8).
//
//   node scripts/check-bundle.mjs [--dist dist] [--json docs/bundle-sizes.json] [--update-budget]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const dist = option('--dist', 'dist');
const jsonPath = option('--json', undefined);
const budgetPath = option('--budget', 'bundle-budget.json');
const updateBudget = args.includes('--update-budget');
// Headroom absorbs small cross-environment differences (Vite/rolldown versions, Node gzip).
const BUDGET_HEADROOM = 1536;

const manifestPath = join(dist, '.vite', 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`check-bundle: ${manifestPath} not found. Run \`vite build\` first.`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

/** Manifest keys reachable from `key` through static imports, `key` included. */
function staticClosure(key, seen = new Set()) {
  if (seen.has(key) || !manifest[key]) return seen;
  seen.add(key);
  for (const next of manifest[key].imports ?? []) staticClosure(next, seen);
  return seen;
}

const sizes = new Map();
function sizeOf(key) {
  let size = sizes.get(key);
  if (!size) {
    const bytes = readFileSync(join(dist, manifest[key].file));
    size = { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
    sizes.set(key, size);
  }
  return size;
}
const total = (keys) =>
  [...keys].reduce(
    (sum, key) => {
      const size = sizeOf(key);
      return { raw: sum.raw + size.raw, gzip: sum.gzip + size.gzip };
    },
    { raw: 0, gzip: 0 },
  );
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

// --- 1. No shader text in the eager bundle -------------------------------------------------------

// Things only shader source contains. Checked against minified JS, where WGSL survives verbatim
// inside string literals.
const WGSL_MARKERS = [
  /@(?:fragment|vertex|compute)\b/,
  /#include\s+\\?"/,
  /->\s*vec[234][fiu]\b/,
  /@group\(\d+\)\s*@binding\(\d+\)/,
];

const entries = Object.keys(manifest).filter((key) => manifest[key].isEntry);
const eager = new Set();
for (const entry of entries) staticClosure(entry, eager);

const offenders = [];
for (const key of eager) {
  const text = readFileSync(join(dist, manifest[key].file), 'utf8');
  const marker = WGSL_MARKERS.find((pattern) => pattern.test(text));
  if (marker) offenders.push(`${manifest[key].file} (matches ${marker})`);
}

const eagerSize = total(eager);
console.log(
  `eager bundle: ${eager.size} chunks, ${kb(eagerSize.raw)} (${kb(eagerSize.gzip)} gzip)`,
);

// --- 2. Per-effect download cost -----------------------------------------------------------------

const EFFECT = /^src\/effects\/([^/]+)\/index\.ts$/;
const effects = [];
for (const key of Object.keys(manifest).sort()) {
  const id = EFFECT.exec(key)?.[1];
  if (!id) continue;
  const closure = [...staticClosure(key)].filter((member) => !eager.has(member));
  const own = sizeOf(key);
  const all = total(closure);
  effects.push({
    id,
    chunks: closure.length,
    ownGzip: own.gzip,
    gzip: all.gzip,
    raw: all.raw,
    files: closure.map((member) => manifest[member].file).sort(),
  });
}

const width = Math.max(6, ...effects.map((effect) => effect.id.length));
console.log(`\n${'effect'.padEnd(width)}  chunks   own gzip   total gzip`);
for (const effect of effects) {
  console.log(
    `${effect.id.padEnd(width)}  ${String(effect.chunks).padStart(6)}  ${kb(effect.ownGzip).padStart(9)}  ${kb(effect.gzip).padStart(11)}`,
  );
}

if (jsonPath) {
  const report = {
    eager: { chunks: eager.size, raw: eagerSize.raw, gzip: eagerSize.gzip },
    effects: Object.fromEntries(
      effects.map(({ id, ...rest }) => [id, { ...rest, gzipKb: +(rest.gzip / 1024).toFixed(1) }]),
    ),
  };
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${jsonPath}`);
}

// --- 3. Bundle budgets ---------------------------------------------------------------------------

const currentEager = eagerSize.gzip;

if (updateBudget) {
  writeFileSync(
    budgetPath,
    `${JSON.stringify(
      {
        $comment:
          'Eager and per-effect gzip ceilings from scripts/check-bundle.mjs. Regenerate with `node scripts/check-bundle.mjs --update-budget` after `vite build`.',
        eager: currentEager + BUDGET_HEADROOM,
        effects: Object.fromEntries(
          effects.map((effect) => [effect.id, effect.gzip + BUDGET_HEADROOM]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nwrote ${budgetPath}`);
} else if (existsSync(budgetPath)) {
  const budget = JSON.parse(readFileSync(budgetPath, 'utf8'));
  const over = [];
  if (typeof budget.eager === 'number' && currentEager > budget.eager)
    over.push(`eager: ${kb(currentEager)} > ${kb(budget.eager)}`);
  for (const effect of effects) {
    const limit = budget.effects?.[effect.id];
    // A new effect with no ceiling is allowed until the budget is regenerated; an existing
    // ceiling is enforced.
    if (limit && effect.gzip > limit) over.push(`${effect.id}: ${kb(effect.gzip)} > ${kb(limit)}`);
  }
  if (over.length > 0) {
    console.error(
      `\ncheck-bundle: over the bundle budget:\n  ${over.join('\n  ')}\n` +
        'Shrink the effect, or raise its ceiling in bundle-budget.json if the growth is intended.',
    );
    process.exit(1);
  }
  console.log(`\nbundle budgets pass (eager + ${effects.length} effects)`);
}

if (offenders.length > 0) {
  console.error(
    `\ncheck-bundle: shader source is in the eager bundle:\n  ${offenders.join('\n  ')}\n` +
      'Something on the first-load path imports a .wgsl file. Import it from the effect, or load it lazily.',
  );
  process.exit(1);
}
