// Captures the fallback poster of each effect: the image a visitor without WebGPU sees.
//
//   npm run posters -- [effect ...] [--time 2] [--size 960x540] [--force]
//
// Renders the effect headlessly at its default settings (scripts/shot.mjs), composites it over
// the dark page colour and writes src/effects/<id>/poster.webp. With no effect named it does
// every effect that has no poster yet (`--force` redoes them all). Needs `cwebp` on the PATH
// (`brew install webp`); posters are committed, so only whoever adds an effect needs it.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const valueFlags = new Set(['--time', '--size']);
const named = args.filter(
  (arg, index) => !arg.startsWith('--') && !valueFlags.has(args[index - 1]),
);
const force = args.includes('--force');
const time = option('time', '2');
const size = option('size', '960x540');

if (spawnSync('cwebp', ['-version']).status !== 0) {
  console.error('posters: cwebp not found. Install it (brew install webp) and run again.');
  process.exit(1);
}

const root = 'src/effects';
const all = readdirSync(root).filter((name) => existsSync(join(root, name, 'index.ts')));
const ids =
  named.length > 0
    ? named
    : all.filter((id) => force || !existsSync(join(root, id, 'poster.webp')));
if (ids.length === 0) console.log('posters: every effect already has one (use --force to redo).');

const scratch = mkdtempSync(join(tmpdir(), 'firetemple-posters-'));
let failed = 0;
for (const id of ids) {
  const shot = spawnSync(
    'node',
    ['scripts/shot.mjs', id, '--times', time, '--size', size, '--bg', 'dark', '--out', scratch],
    { encoding: 'utf8' },
  );
  const png = shot.stdout.trim().split('\n').at(-1);
  if (shot.status !== 0 || !png || !existsSync(png)) {
    console.error(`posters: ${id} failed to render\n${shot.stdout}${shot.stderr}`);
    failed++;
    continue;
  }
  const out = join(root, id, 'poster.webp');
  const encode = spawnSync('cwebp', ['-quiet', '-q', '78', '-m', '6', png, '-o', out]);
  if (encode.status !== 0) {
    console.error(`posters: cwebp failed for ${id}`);
    failed++;
    continue;
  }
  console.log(`${out}  ${(statSync(out).size / 1024).toFixed(1)} kB`);
}
rmSync(scratch, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
