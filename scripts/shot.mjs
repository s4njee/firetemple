// Renders an effect without a browser and writes PNGs, so a change can be looked at from the
// command line (and by an agent, which can open the image).
//
//   npm run shot -- <effect> [--preset name] [--times 1,3] [--size 960x540]
//                            [--bg dark,light] [--params '{"speed":2}'] [--tag name]
//                            [--out output/shots]
//
// --bg composites the (premultiplied) result over a page colour: black, dark, light or white.
// Give several to check an overlay effect on each. Files are
// <out>/<effect>[-preset][-tag]-<t>s[-bg].png; the tag defaults to the --params given, so two
// renders with different parameters do not overwrite each other. A shader that fails to compile
// is an error, not an empty picture.

import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const effect =
  args.find(
    (arg) => !arg.startsWith('--') && args[args.indexOf(arg) - 1]?.startsWith('--') !== true,
  ) ?? args[0];
if (!effect || effect.startsWith('--')) {
  console.error(
    'usage: npm run shot -- <effect> [--preset p] [--times 1,3] [--size WxH] [--bg dark,light] [--params json] [--out dir]',
  );
  process.exit(1);
}
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const env = { ...process.env, SHOT_EFFECT: effect };
for (const name of ['preset', 'times', 'size', 'bg', 'params', 'out', 'tag']) {
  const value = option(name);
  if (value !== undefined) env[`SHOT_${name.toUpperCase()}`] = value;
}

const result = spawnSync(
  'npx',
  [
    'vitest',
    'run',
    '--silent=false',
    '--config',
    'experiments/vite.config.ts',
    'experiments/shot.test.ts',
  ],
  { env, encoding: 'utf8' },
);
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const shots = output.split('\n').filter((line) => line.includes('shot: '));
if (result.status !== 0 || shots.length === 0) {
  console.error(output);
  process.exit(result.status || 1);
}
for (const line of shots) console.log(line.slice(line.indexOf('shot: ') + 6));
