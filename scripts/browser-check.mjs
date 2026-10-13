// Looks at every effect in a real browser, without anyone having to click through them.
//
//   npm run browser-check -- [--base http://localhost:5373] [--effects a,b] [--out output/browser]
//                            [--report docs/studies/browser-check.md] [--query "preset=name"]
//                            [--views hud-1080p] [--hud-runs 3]
//                            [--device "Apple M1 Max" --class apple-silicon]
//                            [--chrome "/path/to/Google Chrome"]
//
// Start the site first (`npm run dev`, or `npm run preview` after a build) and point --base at it.
// The script drives a headless Chrome with a throwaway profile over the DevTools protocol and, for
// each effect, loads it in the page contexts the definition of done names: the mock layouts over
// a dark and a light page, a phone-sized viewport, and a 1920 x 1080 canvas with the HUD on. For
// every view it records:
//
//   - whether the effect started (a canvas, no fallback notice) and how long that took,
//   - console errors and uncaught exceptions (shader compile errors arrive here),
//   - whether the picture changes between two captures a second apart (it animates),
//   - whether the stage is more than one flat colour (something was drawn),
//   - for the HUD view, the frame rate and GPU time the HUD reports.
//
// Screenshots of the stage go to <out>/<effect>/<view>.png and the findings to <out>/report.json.
// It exits non-zero if any view failed to start, logged an error, or drew nothing.
//
// What it cannot tell you: whether the effect looks good. Open the screenshots.

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const base = option('base', 'http://localhost:5373').replace(/\/$/, '');
const out = option('out', 'output/browser');
const chromePath = option('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const hudRuns = Math.max(1, Number(option('hud-runs', '3')));
// Extra query for every view, e.g. --query "preset=roaring" or --query "p.noise=voronoi".
const extraQuery = option('query', '');
const effects = (
  option('effects', undefined)?.split(',') ??
  readdirSync('src/effects').filter((name) => existsSync(join('src/effects', name, 'index.ts')))
).sort();

/** The views every effect is looked at in. `query` is added to `?effect=<id>`. */
const VIEWS = [
  { name: 'hero-light', query: 'layout=hero&page=light', width: 1280, height: 900, dpr: 1 },
  { name: 'hero-dark', query: 'layout=hero&page=dark', width: 1280, height: 900, dpr: 1 },
  { name: 'cards-dark', query: 'layout=cards&page=dark', width: 1280, height: 900, dpr: 1 },
  { name: 'band-light', query: 'layout=band&page=light', width: 1280, height: 900, dpr: 1 },
  { name: 'backdrop-dark', query: 'layout=backdrop&page=dark', width: 1280, height: 900, dpr: 1 },
  { name: 'phone-light', query: 'layout=hero&page=light', width: 390, height: 844, dpr: 2 },
  { name: 'phone-dark', query: 'page=dark', width: 390, height: 844, dpr: 2 },
  // A canvas of exactly 1920 x 1080 device pixels, for a HUD reading comparable with the studies.
  { name: 'hud-1080p', query: 'hud=1', width: 1920, height: 1080, dpr: 1, fullscreenStage: true },
];

// --views a,b restricts the run, e.g. --views hud-1080p to re-measure without the screenshots.
const wantedViews = option('views', undefined)?.split(',');
const views = wantedViews ? VIEWS.filter((view) => wantedViews.includes(view.name)) : VIEWS;

if (!existsSync(chromePath)) {
  console.error(`browser-check: no Chrome at ${chromePath} (pass --chrome).`);
  process.exit(1);
}

// --- A minimal PNG reader (8-bit RGB or RGBA, as Chrome writes them) ------------------------------

function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = body[9] === 2 ? 3 : 4;
    } else if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + x] = (row[x] + predictor) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** Share of pixels whose colour differs by more than a dither step or two between two captures. */
function changedShare(a, b) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0;
  const count = a.width * a.height;
  for (let i = 0; i < count; i++) {
    let delta = 0;
    for (let c = 0; c < 3; c++) {
      delta = Math.max(
        delta,
        Math.abs(a.pixels[i * a.channels + c] - b.pixels[i * b.channels + c]),
      );
    }
    if (delta > 6) changed++;
  }
  return changed / count;
}

/** Number of distinct colours (quantised to 16 levels a channel), capped: 1 means a flat fill. */
function distinctColours(image) {
  const seen = new Set();
  const count = image.width * image.height;
  for (let i = 0; i < count && seen.size < 64; i += 7) {
    const o = i * image.channels;
    seen.add(
      (image.pixels[o] >> 4) |
        ((image.pixels[o + 1] >> 4) << 4) |
        ((image.pixels[o + 2] >> 4) << 8),
    );
  }
  return seen.size;
}

// --- Chrome over the DevTools protocol ------------------------------------------------------------

const profile = mkdtempSync(join(tmpdir(), 'firetemple-chrome-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--enable-unsafe-webgpu',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const cleanup = () => {
  chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
};

const endpoint = await new Promise((resolve, reject) => {
  let stderr = '';
  const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${stderr}`)), 20_000);
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk;
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
    if (match) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  });
});

const socket = new WebSocket(endpoint);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let nextId = 1;
const pending = new Map();
const listeners = new Set();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result);
  } else for (const listener of listeners) listener(message);
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const page = (method, params) => send(method, params, sessionId);
await page('Page.enable');
await page('Runtime.enable');
await page('Log.enable');

let errors = [];
listeners.add((message) => {
  if (message.sessionId !== sessionId) return;
  if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params.exceptionDetails.exception?.description ?? 'uncaught exception');
  } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    errors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
  } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    errors.push(message.params.entry.text);
  }
});

const evaluate = async (expression) => {
  const result = await page('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result?.value;
};

/** Screenshot of the effect's stage, or of the whole viewport when the stage is not found. */
async function capture() {
  const rect = await evaluate(`(() => {
    const stage = document.querySelector('.ft-effect__stage');
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, innerHeight - r.y) };
  })()`);
  const { data } = await page('Page.captureScreenshot', {
    format: 'png',
    ...(rect && rect.width > 0 && rect.height > 0 ? { clip: { ...rect, scale: 1 } } : {}),
  });
  return Buffer.from(data, 'base64');
}

const hudGpu = (hud) => {
  const value = /GPU \| ([\d.]+) ms/.exec(hud ?? '')?.[1];
  return value === undefined ? undefined : Number(value);
};

/** Loads the 1080p HUD view again and returns the HUD's text once it has settled. */
async function loadHud(effect, view) {
  const started = Date.now();
  await page('Page.navigate', {
    url: `${base}/?effect=${effect}&${view.query}${extraQuery ? `&${extraQuery}` : ''}`,
  });
  while (Date.now() - started < 30_000) {
    await sleep(200);
    const ready = await evaluate(`(() => {
      const canvas = document.querySelector('.ft-host__canvas');
      return Boolean(canvas && canvas.width > 1 && canvas.height > 1);
    })()`).catch(() => false);
    if (ready) break;
  }
  await evaluate(`(() => {
    const stage = document.querySelector('.ft-effect__stage');
    if (stage) Object.assign(stage.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: '100', border: '0', borderRadius: '0' });
  })()`);
  await sleep(4000);
  return evaluate(
    `document.querySelector('.ft-effect__hud')?.innerText.replace(/\\n+/g, ' | ').slice(0, 400) ?? null`,
  );
}

const report = [];
let failures = 0;
try {
  for (const effect of effects) {
    mkdirSync(join(out, effect), { recursive: true });
    for (const view of views) {
      errors = [];
      await page('Emulation.setDeviceMetricsOverride', {
        width: view.width,
        height: view.height,
        deviceScaleFactor: view.dpr,
        mobile: view.width < 768,
      });
      const started = Date.now();
      await page('Page.navigate', {
        url: `${base}/?effect=${effect}&${view.query}${extraQuery ? `&${extraQuery}` : ''}`,
      });

      // The effect is up once its canvas has a real drawing buffer, or a fallback notice shows.
      let state = 'timeout';
      while (Date.now() - started < 30_000) {
        await sleep(200);
        const now = await evaluate(`(() => {
          if (document.querySelector('.ft-fallback')) return 'fallback';
          const canvas = document.querySelector('.ft-host__canvas');
          return canvas && canvas.width > 1 && canvas.height > 1 ? 'running' : 'loading';
        })()`).catch(() => 'loading');
        if (now !== 'loading') {
          state = now;
          break;
        }
      }
      const loadMs = Date.now() - started;

      if (view.fullscreenStage && state === 'running') {
        // Make the stage exactly the viewport, so the canvas is 1920 x 1080 device pixels.
        await evaluate(`(() => {
          const stage = document.querySelector('.ft-effect__stage');
          Object.assign(stage.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: '100', border: '0', borderRadius: '0' });
        })()`);
      }

      await sleep(view.fullscreenStage ? 4000 : 1500);
      const first = await capture();
      await sleep(1000);
      const second = await capture();
      writeFileSync(join(out, effect, `${view.name}.png`), second);

      const a = decodePng(first);
      const b = decodePng(second);
      const info = await evaluate(`(() => {
        const canvas = document.querySelector('.ft-host__canvas');
        const hud = document.querySelector('.ft-effect__hud');
        return {
          canvas: canvas ? [canvas.width, canvas.height] : null,
          hud: hud ? hud.innerText.replace(/\\n+/g, ' | ').slice(0, 400) : null,
        };
      })()`);
      const entry = {
        effect,
        view: view.name,
        state,
        loadMs,
        canvas: info?.canvas ?? null,
        animates: changedShare(a, b) > 0.0005,
        changedShare: +changedShare(a, b).toFixed(4),
        colours: distinctColours(b),
        errors: [...new Set(errors)].slice(0, 5),
        ...(view.fullscreenStage ? { hud: info?.hud ?? null } : {}),
      };
      if (view.fullscreenStage && state === 'running') {
        // One HUD reading is not enough: a light effect lets the GPU idle, and the same page then
        // reads either near the timing floor or about twice that, load by load. Load it a few
        // more times and keep the median.
        const readings = [hudGpu(info?.hud)];
        for (let run = 1; run < hudRuns; run++) {
          await page('Page.navigate', { url: 'about:blank' });
          readings.push(hudGpu(await loadHud(effect, view)));
        }
        const usable = readings.filter((value) => value !== undefined).sort((a, b) => a - b);
        entry.hudGpuRuns = usable;
        entry.hudGpuMs = usable.length > 0 ? usable[Math.floor(usable.length / 2)] : null;
      }
      const bad = state !== 'running' || entry.errors.length > 0 || entry.colours < 3;
      if (bad) failures++;
      report.push(entry);
      console.log(
        `${bad ? 'FAIL' : 'ok  '} ${effect.padEnd(16)} ${view.name.padEnd(14)} ${state.padEnd(8)} ` +
          `${String(loadMs).padStart(5)} ms  canvas ${String(entry.canvas).padEnd(11)} ` +
          `${entry.animates ? 'animates' : 'still   '} ${entry.errors[0]?.slice(0, 90) ?? ''}`,
      );
    }
  }
} finally {
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'report.json'),
    `${JSON.stringify({ base, checkedAt: new Date().toISOString(), views: report }, null, 2)}\n`,
  );
  socket.close();
  cleanup();
}

// --- Markdown summary (optional) -----------------------------------------------------------------

const markdownPath = option('report', undefined);
if (markdownPath) {
  const version = spawnSync(chromePath, ['--version'], { encoding: 'utf8' }).stdout.trim();
  const lines = [
    '# Browser check',
    '',
    `Every registered effect, loaded in ${version || 'Chrome'} (headless, this machine's GPU) on ${new Date().toISOString().slice(0, 10)} by \`npm run browser-check\`.`,
    '',
    `Views per effect: ${VIEWS.map((view) => `\`${view.name}\` (${view.width} × ${view.height}${view.dpr > 1 ? ` at ${view.dpr}x` : ''})`).join(', ')}. The layouts are the mock pages of the effect page; "light" and "dark" are the page tone of the stage.`,
    '',
    '- **Started** counts the views in which the effect got a canvas and drew more than a flat fill, with no fallback notice and no console error.',
    '- **Animates** means two captures a second apart differ by more than dither in at least one view.',
    '- **HUD** is what the performance HUD showed on a 1920 × 1080 canvas: frames per second, and the GPU time of one frame as the browser reports it (first pass start to last pass end), as the median of several page loads with the range beside it. The range is wide for the lightest effects: when there is little to draw the GPU idles, and the same page reads either near the timing floor or about twice that from one load to the next.',
    '',
    "The HUD time is not the number the cost studies report. It is one frame measured alone, through Chrome's coarse timestamps, on a GPU that idles between frames, so it carries a floor and reads higher than the per-frame cost in `docs/studies/epic-*.md`. It is here because it is what a visitor's browser actually does. This check says nothing about how an effect looks: the screenshots do.",
    '',
    '| Effect | Started | Animates | HUD at 1080p |',
    '| --- | ---: | --- | --- |',
  ];
  for (const effect of effects) {
    const views = report.filter((entry) => entry.effect === effect);
    const started = views.filter(
      (entry) => entry.state === 'running' && entry.errors.length === 0 && entry.colours >= 3,
    ).length;
    const hudEntry = views.find((entry) => entry.hud);
    const fps = /(\d+) fps/.exec(hudEntry?.hud ?? '')?.[1];
    const runs = hudEntry?.hudGpuRuns ?? [];
    const gpu =
      hudEntry?.hudGpuMs == null
        ? undefined
        : `${hudEntry.hudGpuMs.toFixed(2)} ms${runs.length > 1 ? ` (${runs[0].toFixed(2)} to ${runs.at(-1).toFixed(2)} over ${runs.length} loads)` : ''}`;
    lines.push(
      `| ${effect} | ${started} of ${views.length} | ${views.some((entry) => entry.animates) ? 'yes' : 'no (a still picture)'} | ${fps ? `${fps} fps` : 'no reading'}${gpu ? `, ${gpu}` : ''} |`,
    );
  }
  const errored = report.filter((entry) => entry.errors.length > 0);
  lines.push(
    '',
    errored.length === 0 ? 'No view logged a console error.' : '## Console errors',
    '',
  );
  for (const entry of errored) lines.push(`- ${entry.effect} / ${entry.view}: ${entry.errors[0]}`);
  writeFileSync(markdownPath, `${lines.join('\n').trimEnd()}\n`);
  console.log(`wrote ${markdownPath}`);
}

// --- Scorecard numbers (optional) ----------------------------------------------------------------

// With --device (and --class), the HUD reading of each effect goes into src/effects/measured.json
// beside the study's number, labelled as what it is: one frame, as the browser reports it.
const deviceName = option('device', undefined);
if (deviceName) {
  const measuredPath = 'src/effects/measured.json';
  const measured = existsSync(measuredPath) ? JSON.parse(readFileSync(measuredPath, 'utf8')) : {};
  for (const entry of report) {
    const gpu = entry.hudGpuMs;
    if (gpu == null) continue;
    const target = (measured[entry.effect] ??= {});
    target.gpuMs = [
      ...(target.gpuMs ?? []).filter(
        (sample) => sample.device !== deviceName || sample.method !== 'browser-span',
      ),
      {
        device: deviceName,
        deviceClass: option('class', 'unclassified'),
        method: 'browser-span',
        ms: +Number(gpu).toFixed(2),
      },
    ];
  }
  const sorted = Object.fromEntries(
    Object.entries(measured).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(measuredPath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`updated ${measuredPath}`);
}

console.log(
  `\n${report.length} views, ${failures} failed. Screenshots and report.json are in ${out}/`,
);
process.exit(failures > 0 ? 1 : 0);
