# Fire Temple

A research gallery of fire-looking **WebGPU** effects, judged by one question:
**would you actually ship this on a website?** Every effect gets a live demo,
readable source, a write-up and a practicality scorecard (tier, bundle size, flash
rating and device coverage).

![Fire Temple effects](docs/media/hero.webp)

Part of the [holofx collection](https://github.com/s4njee/holofx) alongside
[hologpu](https://github.com/s4njee/hologpu),
[watertemple](https://github.com/s4njee/watertemple) and
[lighttemple](https://github.com/s4njee/lighttemple).

## Run

```sh
npm install
npm run dev            # http://localhost:5173
npm run build          # typecheck, static build, bundle check
npm test               # vitest on headless Dawn
npm run browser-check  # headless Chrome over every effect and layout
```

Requires a WebGPU-capable browser (Chrome/Edge 113+, Safari 26+, Firefox 141+ on
Windows). Without WebGPU each demo shows its fallback poster and the page stays
readable.

## Use one effect

Every effect is a self-contained ES module with a declared contract: metadata, a
parameter schema, presets, and a `create` that returns `{ resize, frame, destroy }`.
The gallery shell owns the `GPUDevice`, the command encoder and the target view:

```ts
import candle from './src/effects/candle/index.ts';

const effect = await candle.create({ device, format, canvas, params, profiler });
effect.resize(width, height, dpr);
// each frame:
effect.frame({ time, delta }, encoder, target);
// on teardown:
effect.destroy();
```

A public library entry point is being added as part of the
[holofx](https://github.com/s4njee/holofx) work (story 3.3); today the mounting code
lives in `src/shell`. See the per-effect `notes.md` for technique, cost and
fallbacks.

The deployed site uses `npm run deploy`, which uploads to a fixed Cloudflare Pages
project. That command is **maintainer-only**; it is not part of the build, test or
release path.

## Layout

```
src/effects/     one folder per effect: index.ts, shader(s), meta, notes, poster
src/gpu/         device/context, targets, passes, simulations, shared WGSL
src/shell/       gallery host, controls, scorecard, fallbacks
docs/            studies, effect-authoring guide, support matrix
tests/           headless Dawn tests, the flash analyser, browser checks
```

See [plan.md](plan.md) for the roadmap and the
[holofx backlog](https://github.com/s4njee/holofx/blob/main/backlog.md) for the
cross-repo (superproject) workflow.

## Licence

MIT. See [LICENSE](LICENSE) and [CREDITS.md](CREDITS.md).
