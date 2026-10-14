# Fire Temple — WebGPU fire effects research site

A research site that implements, measures, and documents fire-looking WebGPU effects, judged by one question: **would you actually ship this on a website?** Every effect gets a live demo, readable source, a write-up, and a practicality scorecard. Sibling of [Water Temple](../watertemple/plan.md), and built on what that project learned.

## Goals

- Cover a wide range of fire techniques, from one-pass fragment shaders to compute-driven combustion and volumetric rendering.
- Show each effect in a realistic web context (hero, card, button, background), on both dark and light pages, not only on a bare black canvas.
- Record what each effect costs: GPU time, bundle size, device coverage, fallback story.
- Say plainly when a looped video or baked flipbook would do the job better than a live shader.
- Keep every effect a self-contained module that can be lifted into another project.

## Non-goals

- A general-purpose rendering engine. A published npm library is now planned; the cross-project plan is in the [holofx backlog](../holofx/backlog.md).
- Physically exact combustion. Plausible and cheap beats correct and slow.
- Full WebGL2 parity. WebGL2 ports are done only where the comparison is the research.
- A shared package with Water Temple in this plan's own milestones. The shared temple core is now planned as part of the holofx work; see story 3.5 in the [holofx backlog](../holofx/backlog.md).

## Decisions

Defaults chosen so work can start. Each is cheap to revisit before Epic 1 is finished.

| Decision            | Default                                                          | Why                                                                                                                             |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Foundation          | Copy Water Temple's GPU core, shell and test harness, then prune | It is already proven and tested. Copying keeps the two repos independent; a shared package is a non-goal for now.                |
| Build tooling       | Vite + TypeScript (strict)                                       | Same as Water Temple. Fast HMR suits shader iteration.                                                                          |
| Rendering API       | Raw WebGPU + WGSL, thin in-house helpers                         | The research subject is WebGPU itself. Smallest bundles, nothing hidden. Three.js/TSL ports are a comparison story (12.10).     |
| UI framework        | None: vanilla TS, lazy-loaded effect modules                     | Keeps effects framework-agnostic and copyable.                                                                                  |
| Shader loading      | `.wgsl?raw` imports, `#include` resolved per effect at build time | Water Temple's shared WGSL became one eager 70 kB chunk that every page paid for. Fix the packaging before there are 70 effects. |
| Colour pipeline     | Linear HDR `rgba16float` scene → bloom → tonemap → sRGB canvas   | Fire is emissive and far brighter than the page. Without HDR and bloom it reads as orange paint.                                |
| Canvas output       | SDR by default; extended-range canvas is opt-in                  | An HDR canvas more than halved frame rate on the Water Temple development machine.                                              |
| Controls            | Tweakpane, generated from each effect's param schema             | One schema drives the UI, docs table, and URL state.                                                                            |
| Math                | `wgpu-matrix`                                                    | Small, WebGPU conventions (0..1 depth).                                                                                         |
| Testing             | Vitest on Dawn's Node bindings                                   | Real WebGPU without a browser; every registered effect runs headlessly.                                                         |
| Measurement         | Benchmark harness built in Epic 1, one cost study per epic       | Water Temple left the harness to the end and grew a separate study script per epic.                                             |
| Hosting             | Static build on Cloudflare Pages (`firetemple`), direct upload   | No server needed.                                                                                                               |
| No-WebGPU behaviour | Poster image or captured video per effect                        | Honest fallback; mirrors what a production site would do.                                                                       |

## Carried over from Water Temple

Findings that shape this plan rather than being rediscovered.

- **Per-pass GPU timings are indicative only.** Passes overlap on tile-based GPUs and a trivial pass reads about 1.2 ms on Apple Silicon. Time a frame from first pass start to last pass end, repeat light workloads N times per frame and take the slope, and run with nothing else on the GPU.
- **Arbitrary live DOM capture is not a shipped path.** Re-rendered content and stable image/canvas/video uploads are. Heat haze over page content inherits this limit ([backdrop-capture-study.md](../watertemple/docs/backdrop-capture-study.md)).
- **Tier verdicts rested on one machine.** Only an M1 Max was measured. The device matrix (13.2) is scheduled earlier here, in M3.
- **CI never ran** because the repo had no remote. Story 1.10 is not done until a workflow has gone green. (It has now, and its first run found two tests that only passed on Metal.)
- **Scratch work needs a home.** Long sweeps and screenshot probes go in `experiments/`, excluded from test, typecheck and lint.

## Practicality tiers

Every effect is tagged with a tier. Budgets are starting targets to be validated in Epic 13.

| Tier            | Meaning                                             | Shape                                          | GPU budget @1080p                   |
| --------------- | --------------------------------------------------- | ---------------------------------------------- | ----------------------------------- |
| **A** Drop-in   | Safe as ambient decoration, including mobile        | One or two fragment passes, no compute         | ≤ 2 ms on integrated GPU            |
| **B** Feature   | Hero sections and interactive set pieces            | Multi-pass or a small compute sim              | ≤ 6 ms on integrated GPU            |
| **C** Showpiece | Dedicated page or landing experience, desktop-first | Heavy compute, volumetrics, or a full 3D scene | ≤ 12 ms on discrete / Apple Silicon |

Budgets include the HDR tail (bloom and tonemap), since no fire effect ships without it.

## Architecture sketch

```
firetemple/
  index.html
  vite.config.ts
  src/
    main.ts            bootstrap: one shared GPU session, mounts an effect
    gpu/               device, canvas sizing, frame loop, shaders, uniforms, targets, passes,
                       plus post/ (bloom, tonemap, flash limiter), scene/ (camera, meshes,
                       forward pass, fire lights), particles/ (emitters, integration,
                       billboards, trails), volume/ (ray-march kernel, upsampling) and
                       sim/ (cellular fire, burn front, combustion fluids 2D and 3D,
                       obstacle masks)
    wgsl/              shared include chunks: noise, sdf, colour, and the emission library
                       (blackbody, ramps, flicker, flame shape, flow noise, haze, soft
                       particles, smoke, glow)
    effects/<id>/      meta.ts (eager), index.ts + *.wgsl (lazy chunk), notes.md, poster.webp
    shell/             app frame, router, gallery, effect page and its panels, design tokens
    bench/             benchmark harness
  tests/               vitest on Dawn's Node bindings: real WebGPU, no browser
  experiments/         scratch sweeps and probes; not part of the test run
  docs/                research output: support matrix, cost studies
  public/              textures, fonts, flipbook atlases
```

Effect contract (every effect implements this; the shell knows nothing else about it). It is kept identical to Water Temple's so effects and shell code can move between the two repos.

```ts
// src/effects/<id>/index.ts exports `effect`; meta.ts exports `meta`.
export interface EffectModule<S extends ParamSchema> {
  meta: { id: string; title: string; epic: string; tier: 'A' | 'B' | 'C'; tags: string[] };
  params: S; // drives controls, docs table, URL state
  presets?: Record<string, Partial<ParamValues<S>>>;
  create(ctx: EffectContext<S>): Promise<EffectInstance>; // ctx: device, format, canvas, live params
}

export interface EffectInstance {
  resize(width: number, height: number, dpr: number): void;
  frame(time: FrameTime, encoder: GPUCommandEncoder, target: GPUTextureView): void;
  destroy(): void;
}
```

The full types live in `src/effects/types.ts`. `tests/effects.test.ts` runs every registered effect headlessly, so a new effect is covered as soon as its directory exists.

## Definition of done (per effect story)

1. Runs inside its tier budget on the reference devices, with numbers recorded. Until the device matrix exists (13.2) the only reference device is the development machine, an M1 Max: an effect is measured there twice, per frame on Dawn (`npm run study`) and as one frame in Chrome (`npm run browser-check`), and takes the lowest tier whose budget neither number exceeds. Because the A and B budgets are set for an integrated GPU, an A or B label is provisional until 13.2, and the scorecard says so.
2. Parameters exposed through the schema, with at least two presets.
3. Handles resize, DPR changes, device loss, offscreen pause, and `prefers-reduced-motion`.
4. Stays under the flash threshold (WCAG 2.3.1) at default settings, with the flash-risk field of the scorecard filled in.
5. Shown in at least one realistic web context, checked over both a dark and a light page: `npm run browser-check` loads it in the mock layouts, both page tones and a phone-sized viewport in Chrome, and its screenshots are looked at.
6. `notes.md` written: how it works, cost, pitfalls, when to use it, references.
7. Scorecard filled in and fallback poster captured.

## Milestones

| Milestone             | Scope                                        | Proves                                           |
| --------------------- | -------------------------------------------- | ------------------------------------------------ |
| **M0** Vertical slice | Epic 1, stories 2.1–2.3, 3.1–3.4, effect 4.1 | Full pipeline: tooling → HDR → effect → shell → deploy |
| **M1** Drop-in set    | Rest of Epic 3, Epic 4, stories 5.1–5.3      | Tier A library and the shared emission chunks    |
| **M2** Simulated fire | Rest of Epic 5, Epic 6, stories 7.1–7.4      | Where compute shaders pay off                    |
| **M3** Fire UI        | Epic 9, stories 12.1–12.4, 13.2              | Web-native usefulness, on more than one device   |
| **M4** Showpieces     | Rest of Epic 7, Epic 8                       | Upper bound of what the browser can do           |
| **M5** Findings       | Epics 10, 11, 13, rest of 12                 | Published conclusions                            |

Story format: `ID Title [tier] (size)`. Sizes: S ≈ a day or less, M ≈ a few days, L ≈ a week or more.

---

## Epic 1 — Foundation and tooling

Everything needed before the first effect can exist. Mostly a port, with three deliberate changes: per-effect shader packaging, HDR as the default tail, and the benchmark harness up front.

- [x] **1.1 Repo scaffold** (S) — `git init`, Vite `vanilla-ts`, strict TS, `@webgpu/types`, ESLint + Prettier, `dev` / `build` / `preview` / `typecheck` / `test` scripts, dependency versions matched to Water Temple.
- [x] **1.2 Port the GPU core** (M) — device and canvas setup, premultiplied-alpha configuration, frame loop with fixed-step accumulator, resize handling, uniform struct writer, targets and ping-pong, texture and mip helpers, pointer, scroll, audio, DOM rects, profiler, blit / blur / downsample passes, each with its tests. Leave the water-only modules behind (ocean, liquid-2d, fluid-surface, weather, ui). _Ported with their tests. `dom-rects.ts` now owns its `ObstacleRect` type, so nothing in the core depends on a simulation._
- [x] **1.3 WGSL pipeline with per-effect packaging** (M) — `?raw` imports, `#include` preprocessor, HMR that rebuilds pipelines without a reload, compile errors in an overlay with correct line mapping. Includes resolve at build time into each effect's lazy chunk; shaders assembled in TypeScript go through the same resolver. A test fails the build if any shared WGSL lands in the eager bundle. _Done as `vite-plugin-wgsl.ts`: a `.wgsl` import is a `ShaderSource` carrying only the files it includes, there is no global library at run time, and `scripts/check-bundle.mjs` (part of `npm run build`) fails if shader text reaches the first load. First load is 10.8 kB gzipped with thirteen effects registered, none of it shader text (5.4 kB with one effect; the rest is effect metadata, see 12.1). Hot reload was checked in the browser for an effect shader, a library chunk, and a new `#include` added to a library chunk._
- [x] **1.4 Effect contract and registry** (S) — the interface above, discovery through `import.meta.glob`, one lazy chunk per effect, a `hello` effect as the smallest example. _`hello` is rising warped noise through the tail._
- [x] **1.5 Shared WGSL base** (S) — port hash, value/simplex noise, FBM, Voronoi, curl noise, SDF primitives and smooth-min, colour-space functions, with the header-and-namespace test.
- [x] **1.6 HDR tail** (M) — `rgba16float` scene target, bloom, tonemap and sRGB encode as one reusable tail every effect ends with; cost measured so it can be subtracted from tier budgets; extended-range canvas kept as an opt-in spike. _`createHdrTail` with shared `TAIL_PARAMS`; the output pass gained see-through alpha modes (additive, coverage, luminance) and an underlay for story 3.3. The tail alone is a baseline row in every cost study. The extended-range canvas stays opt-in (`&hdr=1`) and was not re-measured here._
- [x] **1.7 Headless test harness** (S) — Vitest on Dawn's Node bindings, a WGSL evaluation helper for numeric shader tests, `effects.test.ts` over the registry, `experiments/` with its own config. _`tests/headless.ts` runs any effect without a browser; `npm run shot -- <effect>` writes PNGs from it and `npm run posters` captures fallback posters. `tests/flash.ts` is a WCAG 2.3.1 flash analyser that runs against every registered effect, so `scorecard.flash` cannot understate what is measured (the start of story 12.4). `npm run browser-check` drives a headless Chrome over every effect, layout and page tone and fails on a view that does not start, logs an error or draws nothing._
- [x] **1.8 Benchmark harness** (M) — scripted run per effect at fixed resolutions, frame time measured first-pass-start to last-pass-end, repeated-workload slope for light effects, JSON plus bundle sizes exported to `docs/`. One `study` command parameterised by epic, not one script per epic. _`npm run study -- --epic <n>` writes `docs/studies/epic-<n>.{json,md}` and `src/effects/measured.json`, which the Scorecard tab reads. Each run includes a floor row and a tail-only row. Measured on Dawn under Node, which has a far lower timing floor (about 0.1 ms) than the browser HUD._
- [x] **1.9 Failure handling** (S) — no-WebGPU screen with poster, `device.lost` recovery, uncaptured-error reporting. _Ported with its tests. `?nogpu` makes the site behave as a browser without WebGPU, which is how the poster-and-notice path was checked._
- [x] **1.10 Build and deploy** (S) — static build with configurable base path, git remote, CI running lint + format check + build + tests on software Vulkan, preview deploys. Done when a workflow run is green. _Done. The site is deployed to the Cloudflare Pages project `firetemple` (https://firetemple.pages.dev) by direct upload: `npm run deploy` builds, runs the bundle check and uploads `dist`. The repo is at https://github.com/s4njee/firetemple and the CI workflow is green there. Its first run failed, usefully: two tests assumed Metal's behaviour (a signed zero, and a bilinear tap that reads one half-float step below 1 on Mesa's software rasteriser). CI skips the per-effect flash sweep, which is too slow without a GPU, so that check only runs locally. There are no per-branch preview deploys; base path is `BASE_PATH`._
- [x] **1.11 Support matrix refresh** (S) — re-check Water Temple's [support-matrix.md](../watertemple/docs/support-matrix.md) against current browsers, adding what fire leans on: `rgba16float` rendering and blending, `float32-filterable`, `timestamp-query`, canvas tone-mapping modes, 3D storage textures. _Result: [docs/support-matrix.md](docs/support-matrix.md), re-checked in full on 2026-10-13 (every table re-read; what could not be confirmed from a written source is listed there with the reason), with a new section on what fire leans on. The finding that matters most: the spec leaves premultiplied colour brighter than its alpha undefined when displayed, which is exactly what additive fire over a page produces (see 3.3)._

## Epic 2 — Site shell and research UX

The frame the research is presented in. Ported, then adjusted for a subject that is bright, flickering and dark-page-biased.

- [x] **2.1 Gallery home** (M) — effect cards filterable by tier and tag; live thumbnails only while in view, all canvases sharing one `GPUDevice`.
- [x] **2.2 Effect page** (M) — canvas, generated controls, presets, shareable URL state, fullscreen toggle.
- [x] **2.3 Performance HUD** (M) — FPS, CPU frame time, per-pass GPU time through `timestamp-query` where available, resolution scale, estimated texture memory.
- [x] **2.4 Source viewer** (S) — highlighted WGSL (includes expanded) and TS for the effect, with a copyable minimal snippet.
- [x] **2.5 Write-up template** (S) — markdown rendered alongside each demo, same headings for every effect.
- [x] **2.6 Practicality scorecard** (S) — tier, GPU cost, bundle size, mobile-safe, needs compute, optional features required, fallback, best use cases, plus two fire-specific fields: flash risk and light-page suitability. _The measured rows (GPU time, bundle size) come from `measured.json`, not from hand-copied numbers in `meta.ts`._
- [x] **2.7 In-context mode** (M) — mock page layouts (hero, card grid, nav, footer) in dark and light variants that any effect can be mounted into. _The mock pages follow the site theme, and a "Page" control flips the stage alone to dark or light (`&page=light`)._
- [x] **2.8 Site visual design** (M) — a look that lets the effects carry the page. Dark-first, with a real light theme because it is the hard test for emissive effects. _Dark is the default theme; `auto` follows the system._
- [x] **2.9 Global motion controls** (S) — site-wide pause, an intensity cap, and reduced-motion behaviour that every thumbnail and demo obeys. _"Pause motion" follows `prefers-reduced-motion` until the visitor chooses, and an intensity cap dims every effect canvas to 70% or 40%._

## Epic 3 — Emission and shading building blocks

Shared WGSL that most later effects depend on. Each is proven in a small test scene.

- [x] **3.1 Blackbody colour** (S) — temperature to linear RGB; compare a Planck evaluation, a fitted approximation and a 1D lookup texture on cost and error. _`blackbody.wgsl`. Default for later effects: the polynomial fit (`blackbody_radiance`), within 1.7/255 of the Planck reference over 800–12000 K with no transcendentals; a 64-texel lookup is within 0.3/255. The Wyman–Sloan–Shirley colour-matching fit is biased in the far red, where fire lives, and needed two extra lobes. Raw T⁴ intensity is unusable, so intensity is physical luminance raised to 0.4._
- [x] **3.2 Flame colour ramps** (S) — authored gradients versus blackbody, chemically tinted flames (copper green, sodium yellow), polynomial versus texture lookup. _`ramp.wgsl`. Default: the authored polynomial `ramp_fire`. A blackbody over soot temperatures only runs red to orange and, under the per-channel tonemap, saturates to lemon yellow; `ramp_whiten` (per effect) or the tail's opt-in highlight burn fixes that. A 64-texel baked ramp is within 0.7/255._
- [x] **3.3 Emissive compositing over the page** (M) — pure additive, premultiplied "over" with luminance-derived alpha, a dark smoke underlay, and CSS blend modes, each checked over dark and light pages. Decides the default every overlay effect uses. _Result: [docs/compositing-study.md](docs/compositing-study.md). The default for every overlay effect is luminance alpha (alpha at least the brightest channel) with an underlay of 0.3: within a few 8-bit steps of additive over a dark page, still readable over a light one, and always a valid premultiplied colour. Pure additive and every lightening CSS blend mode are invisible on a light page. One browser check so far (the desktop app's Chromium pane): the default looked as predicted over both pages, and additive output, which the spec leaves undefined, showed nothing at all, even over dark. Safari, Firefox and the CSS blend rows, which are simulated, are unchecked._
- [x] **3.4 Bloom tuned for fire** (S) — threshold, radius and mip count against cost; how little bloom still sells heat. _The bloom level count now follows the canvas size, because a fixed count that looks right at 1080p floods a small card. The cheapest bloom that still reads as hot is half resolution with one level fewer than automatic. Measured, the level count is not what bloom costs: one to five levels all read within the run-to-run spread, and the whole tail is about 0.7 ms at 1080p on the M1 Max._
- [x] **3.5 Heat haze** (S) — noise-driven refraction offset masked by a temperature field, over a backdrop texture. _`haze.wgsl`: exactly zero offset where there is no heat, two noise evaluations and one to three taps. It distorts a texture the canvas owns; over real page content it would need the page's pixels._
- [x] **3.6 Flicker signals** (S) — band-limited noise for intensity and position, with a frequency and amplitude cap that keeps output under the flash threshold. Shared by flames and lights. _`flicker.wgsl` and a TypeScript twin (`src/gpu/emission/flicker.ts`) that agree to 2e-7. The caps (at most 4 knots a second, 4% shimmer) bound a light to three flashes a second by construction; the worst capped case found was two. `fire-light`, `volume-march` and `smoke-shading` use it. The time fed to it must be real seconds, so effects keep a flicker clock that `speed` cannot push past real time._
- [x] **3.7 Flame shaping** (S) — teardrop and taper SDFs, height falloff, turbulence growing with height, edge erosion. _`flame.wgsl`: exact teardrop and taper distance fields, heat always in 0..1, and `flame_reach`, which lets a shader skip 91% of the box around a default flame._
- [x] **3.8 Advected noise** (M) — upward scroll, domain warp, flow noise and curl-noise advection, compared on how well each hides the "scrolling texture" look. _`advect.wgsl`. Default: curl-displaced flow noise, the only variant that both moves features and lets them die. Plain scrolling keeps a correlation of 1.0 with itself after a second; flow noise drops to 0. The comparison table was tuned so the variants are comparable, and the notes say so. On the M1 Max the variants cost the same within the spread._
- [x] **3.9 Soft additive sprites** (S) — procedural sprite shapes, depth fade against scene geometry, velocity stretch. _`sprite.wgsl` and `src/gpu/sprites.ts` (instanced, additive, scene depth sampled in the fragment stage). The soft fade is relative to sprite size; a world-unit fade erased small sprites resting on surfaces._
- [x] **3.10 Smoke shading** (M) — Beer–Lambert absorption, cheap self-shadowing, and lighting from the fire below. _`smoke.wgsl`. Default self-shadowing: one gradient tap per light at the midpoint of the path, 4.3 ms against 6.6 ms for a five-tap march and 3.4 ms for none (1080p output, M1 Max; the march itself never runs taller than 540 px). Judged from stills against the march, not against ground truth._
- [x] **3.11 Fire as a light source** (M) — flickering point and area lights, 2D radial falloff with soft shadows from SDFs, normal-mapped receivers. _`firelight.wgsl`. Default: a closed-form soft shadow of a rounded rectangle on the light disc, which costs the same as no shadows (1.8 ms against 1.6 ms) and half of sphere tracing (3.3 ms), with a more accurate penumbra._
- [x] **3.12 Volume ray-march kernel** (M) — emission–absorption integration, blue-noise step jitter, early termination, reduced-resolution march with depth-aware upsampling. _`volume.wgsl` gained emission–absorption media, and `src/gpu/volume/` marches at reduced resolution with a depth-aware upsample. Defaults for later effects: half resolution, 64 steps, interleaved-gradient jitter, depth-aware upsample. Full, half and quarter resolution cost 19.4, 6.5 and 3.1 ms; the depth-aware filter costs nothing measurable over bilinear and keeps geometry edges. A blue-noise tile was built and compared, and did not beat the cheaper jitter._

Epic 3 completion: twelve test scenes (`blackbody`, `flame-ramps`, `compositing`, `bloom-tuning`, `heat-haze`, `flicker`, `flame-shape`, `advected-noise`, `soft-sprites`, `smoke-shading`, `fire-light`, `volume-march`), each with presets, notes, a scorecard and a fallback poster, and numeric tests for every chunk.

Checked in a browser: [docs/studies/browser-check.md](docs/studies/browser-check.md). In headless Chrome 155 every scene (and `hello`) started in all eight views (four mock layouts, dark and light page tones, a phone-sized viewport, a 1080p canvas) with no console errors, holds 60 fps at 1080p, and animates, except `blackbody`, which is a still chart. The contact sheets of the hero-over-light and phone views were looked at; `compositing` and `smoke-shading` read over a light page as the headless composites predicted.

Measured: [docs/studies/epic-3.md](docs/studies/epic-3.md) has the per-frame cost on Dawn (M1 Max; run-to-run spread about half a millisecond, so the light scenes cannot be ranked against each other). Chrome's own reading of one frame at 1080p is higher, 1.1 to 9.9 ms, because it includes the browser's timing floor and a GPU that idles between frames. By that reading six scenes first labelled Tier A are over 2 ms even on this GPU, so they are now Tier B (`advected-noise`, `compositing`, `fire-light`, `flame-ramps`, `flame-shape`, `heat-haze`), and `blackbody` and `hello` are Tier C. Only `bloom-tuning`, `flicker` and `soft-sprites` remain Tier A. These are full-canvas comparison scenes, not shippable effects; the chunks they demonstrate are cheaper used singly.

Not verified, and not verifiable on this machine: the A and B budgets on an integrated GPU, and anything on a phone (story 13.2). Safari and Firefox have not been run. How the scenes look in motion was confirmed only as "the picture changes", not by eye.

## Epic 4 — Shader-only 2D fire

No simulation state. The cheapest and most broadly usable group.

- [x] **4.1 Scrolling-noise flame** [A] (S) — the classic: FBM scrolled upward, shaped by a height gradient, mapped through a ramp. Compare value, simplex and Voronoi noise. _`noise-flame`. The comparison settles it: the baked noise texture gives the best-looking flame of the five sources for two fetches per pixel, and is the only one at the timing floor. On Dawn the texture source reads 0.5 ms a frame against 1.1 (gradient FBM), 1.2 (simplex), 1.4 (value) and 1.7 ms (Voronoi); in Chrome every procedural source with the warp read over 2 ms while other work was on the GPU. Built as a see-through overlay rather than an opaque scene. Rise speed is what trips the flash analyser, so the speed slider is capped._
- [x] **4.2 Candle flame** [A] (S) — teardrop SDF with a blue core, wick and halo; sways and leans away from the pointer. _`candle`. Laminar, so lean, tip lag and brightness are computed on the CPU (a damped spring away from the pointer) and the shader fetches noise at most once per pixel inside the flame. The pointer lean was checked numerically, not with a real mouse._
- [x] **4.3 Flame strip** [A] (S) — tileable band of flames for section breaks and footers. _`flame-strip`. Exactly periodic across any canvas width: a whole number of crests, and two noise layers that repeat `tiles` and `tiles ± 1` times. Its height is capped against the canvas width so it stays a band in a hero or on a phone._
- [x] **4.4 Fireplace** [A] (M) — layered flames behind log silhouettes, ground glow, fragment-shader embers. _`fireplace`. One pass: firelit brick and floor, three flame layers around log silhouettes, a coal mound and stateless embers. Each flame layer fetches noise only inside its own box, and pixels under the front log skip everything behind it._
- [x] **4.5 Heat-haze overlay** [A] (S) — shimmer over any image or video element. _`haze-overlay`. Shimmer over a procedural picture or a dropped image or video file (the drop path was exercised in Chrome with a synthetic event). The offset comes from two fetches of the baked tile rather than `haze.wgsl`'s procedural noise, and bloom is off by default, so it is the cheapest effect on the site: 0.39 ms a frame in Chrome._
- [x] **4.6 Ember bed** [A] (S) — Voronoi coals with breathing emissive cracks. _`ember-bed`. The coal layout is baked once into a texture (ten Voronoi searches a pixel, on resize only) and each frame is three fetches. Seen flat on it reads more like cracked lava than coals; the tilted `hearth` preset is the better picture._
- [x] **4.7 Stylised toon fire** [A] (M) — banded colour, hard edges, stepped animation. _`toon-fire`. Flat bands as inset copies of one distance field, an ink outline, and a clock that is sample-and-held in real seconds so the drawing steps without frames being skipped. It has real coverage, so it reads the same on light and dark pages. The stepped version measured calmer on the flash analyser than the smooth one._
- [x] **4.8 Torch and brazier** [A] (S) — small looping flame for icons and list markers; cost measured with many on one page. _`torch`. Up to 48 flames in one canvas, each pixel shading at most one, so cost does not grow with the count: 1, 12 and 48 flames read 0.6, 1.3 and 0.6 ms on Dawn, all inside the run-to-run spread. The loop is exact, so one cycle could be baked to a sprite sheet. Many separate canvases on one page (one tail each) were not built or timed._
- [x] **4.9 Stateless sparks** [A] (S) — hash-grid sparks rising and fading, no buffers. _`sparks`. A hash grid in a polar frame, no buffers; cost does not depend on density or on the number of depth layers. Honestly marked as not reading on a light page (the sparks become orange flecks). Two presets, `welding spray` and `grinder`, are over the flash threshold in every variant tried; they are declared in the scorecard and labelled in the controls._
- [x] **4.10 Fire ring** [A] (S) — polar-coordinate flame around a circle, for portals, avatars and loaders. _`fire-ring`. The noise tile wraps a whole number of times round the ring, with a second layer wrapping once more, so there is no seam and no visible symmetry; `progress` lights part of the ring for a loader. The loader preset first measured over the flash threshold because the pattern was carried round with the arc; its speed is now capped._
- [x] **4.11 Gas jet** [A] (S) — blue directional flame for burners and exhausts, with shock diamonds. _`gas-jet`. A taper mantle, a pale inner cone and repeated lozenges for shock diamonds; single, row and ring arrangements. The afterburner preset measured over the flash threshold until its noise was slowed from 8 to 2.4 cells a second and stretched along the jet to keep the look of speed. Blue jets cannot flash by luminance; the same motion in a warm plume can._
- [x] **4.12 Firelight background** [A] (S) — slow, warm domain-warped glow that reads as a fire just out of frame. _`firelight-background`. A warped noise field drawn at one eighth resolution and read with a single fetch per pixel, lit from a line beyond one edge. No cell of the picture completes a flash over twenty seconds. It is an opaque dark block, so on a light page it is a dark section, not light._

Epic 4 completion: twelve effects, each with presets, notes, a scorecard, a fallback poster and tests. All twelve started in all eight browser views (mock layouts, both page tones, phone, 1080p) in headless Chrome with no console errors and hold 60 fps ([docs/studies/browser-check.md](docs/studies/browser-check.md)); the screenshots and headless renders over dark and light pages were looked at.

Cost ([docs/studies/epic-4.md](docs/studies/epic-4.md)): on Dawn every effect is indistinguishable from the HDR tail alone, and in Chrome one frame at 1080p reads 0.39 to 1.79 ms (median of three loads each). That is inside the Tier A budget on the M1 Max by both measures, where six of Epic 3's full-canvas procedural-noise scenes were not. The difference is the shared baked noise texture (`getNoiseTexture` and `noisetex.wgsl`), added at the start of this epic, plus early-outs: no Epic 4 effect computes procedural noise per pixel at its defaults.

Flash: the analyser now sweeps every preset of every effect, and a preset over the threshold must be named in `scorecard.flashPresets`, which labels its button. It caught the gas jet's afterburner, the ring's loader and the torch's red licks, all since brought under; only two `sparks` presets remain declared as over.

Not verified: the Tier A budget on an integrated GPU or a phone (13.2), so the tiers are provisional; Safari and Firefox; motion by eye rather than as "the picture changes"; a real pointer on the candle and a real file drag on the haze overlay.

## Epic 5 — Cellular and stateful 2D fire

Fire as a spreading state on a grid: the first use of persistent GPU textures, and the cheapest way to make fire respond to the page.

- [ ] **5.1 Doom fire** [A] (S) — the PSX Doom heat-propagation automaton; implement as both a render pass and a compute pass and compare.
- [ ] **5.2 Pointer and touch ignition** [A] (S) — light on tap, drag to draw fire, multi-touch.
- [ ] **5.3 Burn front on a fuel map** [A] (M) — fuel, heat and char textures; ignition spreads, leaving a glowing edge and charred remains. The burning-paper effect.
- [ ] **5.4 DOM as fuel** [B] (M) — element rects rasterised into the fuel map so fire climbs cards and headings and stops at gaps.
- [ ] **5.5 Forest-fire automaton** [A] (S) — burn, spread, regrow, with wind bias.
- [ ] **5.6 Reaction–diffusion combustion** [B] (M) — a continuous fuel–temperature model with a travelling front, compared against 5.3.
- [ ] **5.7 Ambient ignition and regrowth** [A] (S) — stray embers and returning fuel so the scene neither dies nor burns out.
- [ ] **5.8 Scroll and audio excitation** [A] (S) — feed heat from scroll velocity or an audio analyser.
- [ ] **5.9 Cost study** [—] (S) — grid resolution against frame time; render pass versus compute.

## Epic 6 — Grid fluids with combustion (Eulerian, compute)

Velocity-field simulations with heat: the technique behind film fire, at web budgets.

- [ ] **6.1 Stable-fluids solver** [B] (M) — port Water Temple's compute solver (advection, divergence, Jacobi pressure, projection) and re-validate it.
- [ ] **6.2 Temperature and buoyancy** [B] (S) — an advected heat field that lifts the fluid and cools over time.
- [ ] **6.3 Fuel and combustion** [B] (M) — fuel field, ignition threshold, burn rate, heat release, and gas expansion as a divergence source.
- [ ] **6.4 Smoke** [B] (S) — soot produced where fuel burns, with its own dissipation.
- [ ] **6.5 Detail preservation** [B] (M) — vorticity confinement, MacCormack advection, and injected procedural turbulence, compared on cost and look.
- [ ] **6.6 Rendering the fields** [B] (M) — temperature through blackbody emission, smoke absorption above it, bloom.
- [ ] **6.7 Emitters** [B] (S) — pointer torch, line and shape burners, colour presets.
- [ ] **6.8 Obstacles** [B] (M) — solid boundaries from SDFs and DOM masks, so flames wrap around cards.
- [ ] **6.9 Fire as page distortion** [B] (M) — the temperature and velocity fields drive heat haze over imagery or text.
- [ ] **6.10 Solver cost study** [—] (M) — iterations versus resolution versus quality; low-resolution simulation with high-quality upsampling.
- [ ] **6.11 3D combustion** [C] (L) — stretch goal: volumetric solve rendered with the 3.12 kernel.

## Epic 7 — Particle fire (Lagrangian, compute)

Embers, sparks and fireworks: where fire is points of light rather than a volume.

- [ ] **7.1 GPU particle framework** [B] (M) — port storage buffers, compute integration and instanced billboards; add emitters, lifetimes and recycling.
- [ ] **7.2 Embers** [A] (S) — curl-noise drift, cooling along the blackbody curve, twinkle.
- [ ] **7.3 Sparks** [B] (M) — velocity-stretched streaks, gravity, bounce and split on colliders.
- [ ] **7.4 Particle flame** [B] (M) — the original particle-system fire in soft additive sprites; compare against 4.1 at equal cost.
- [ ] **7.5 Fireworks** [B] (M) — shells, bursts, trails, crackle and glitter as multi-stage emitters.
- [ ] **7.6 Sparkler** [B] (S) — dense short-lived sparks from a moving point.
- [ ] **7.7 Trails** [B] (M) — ribbon geometry versus a decaying accumulation buffer.
- [ ] **7.8 Directed jet** [C] (M) — particles advected by the Epic 6 velocity field: flamethrower, dragon breath.
- [ ] **7.9 Sorting and blending** [—] (M) — additive needs no sort, smoke does. Compare sorted alpha, weighted blended OIT, and additive-only.
- [ ] **7.10 Scale study** [—] (M) — particle count against frame time per device class.

## Epic 8 — Volumetric fire and 3D scenes

Fire with depth, and the scenes it lights.

- [ ] **8.1 Ray-marched procedural flame** [B] (M) — noise-displaced density marched with the 3.12 kernel; no simulation.
- [ ] **8.2 Fireball and explosion** [C] (L) — pyroclastic noise on an expanding sphere, timed from flash to fireball to smoke.
- [ ] **8.3 Simulated volumetric fire** [C] (L) — render 6.11 with self-shadowed smoke.
- [ ] **8.4 Campfire scene** [B] (L) — logs, flame, embers, and flickering light with shadows on the ground.
- [ ] **8.5 Torch-lit room** [B] (M) — several fire lights; compare no shadows, one flickering shadow map, and SDF soft shadows.
- [ ] **8.6 Flipbook baking** [—] (M) — bake a simulated flame to an atlas with motion-vector blending; compare size, cost and look against the live version.
- [ ] **8.7 Burning object** [C] (L) — fire emitted from a mesh surface, with the mesh charring.
- [ ] **8.8 Wildfire terrain** [C] (L) — a fire front crossing a heightfield under wind, with a smoke plume.
- [ ] **8.9 Volume resolution study** [—] (M) — half- and quarter-resolution marching, upsampling filters, temporal reprojection.

## Epic 9 — Fire UI and web-native motifs

Effects shaped like website components. The most directly applicable group.

- [ ] **9.1 Backdrop strategy** [—] (S) — adopt Water Temple's capture findings, re-probe the experimental HTML-in-Canvas APIs, and fix what haze and firelight effects may assume about page pixels.
- [ ] **9.2 Burning buttons** [A] (M) — flames licking the edge on hover, a flare on press.
- [ ] **9.3 Flame border** [A] (S) — rounded-rect SDF outlined in fire, for cards, inputs and focus states.
- [ ] **9.4 Burn-away transitions** [A] (M) — burn wipe, ember dissolve and paper burn between sections or routes.
- [ ] **9.5 Burning image hover** [A] (S) — a scorch that spreads from the pointer and heals.
- [ ] **9.6 Fire typography** [B] (L) — MSDF text that ignites, burns, glows as embers, or crumbles to ash.
- [ ] **9.7 Fuse and burn-down components** [A] (M) — progress bars, loaders and countdowns as a burning fuse or a shrinking candle.
- [ ] **9.8 Ember cursor trail** [A] (S) — sparks that fall and cool behind the pointer.
- [ ] **9.9 Torch cursor** [A] (M) — a dark page revealed by a flame the pointer carries.
- [ ] **9.10 Scroll-linked burn** [B] (M) — the page chars and burns away as you scroll.
- [ ] **9.11 Strike and extinguish** [A] (S) — strike a match to light, move fast or blow into the microphone to put out.
- [ ] **9.12 Firelight on the DOM** [B] (M) — real elements lit by a nearby flame: CSS custom properties driven from the flicker signal versus lighting re-rendered in canvas.
- [ ] **9.13 Celebration bursts** [A] (S) — sparks and small fireworks as click or success feedback.

## Epic 10 — Smoke, ash and aftermath

What fire leaves behind, often more usable on a page than the fire itself.

- [ ] **10.1 Smoke plume** [A] (M) — shader-only layered noise smoke with scroll parallax.
- [ ] **10.2 Ash fall** [A] (S) — instanced, depth-layered flakes with tumbling and wind.
- [ ] **10.3 Scorch marks** [A] (S) — persistent char decals accumulated in a texture.
- [ ] **10.4 Smouldering edge** [A] (S) — a slow glowing line with thin smoke, for dividers and borders.
- [ ] **10.5 Smoke-filled glass** [B] (M) — haze the pointer clears, which slowly drifts back.
- [ ] **10.6 Extinguish** [B] (M) — stretch goal: water meets fire, with steam. Borrows from Water Temple.

## Epic 11 — Other hot things

"Fire-looking" is wider than flames. Reuse existing simulations and shading with different parameters.

- [ ] **11.1 Lava** [B] (M) — emissive crust-and-glow shading with slow flow (left unbuilt as Water Temple 11.3).
- [ ] **11.2 Molten metal and forge glow** [B] (S) — incandescent surfaces cooling through the blackbody curve.
- [ ] **11.3 Coloured and magical flames** [—] (S) — ramp and motion presets for the Epic 4 and 6 effects.
- [ ] **11.4 Solar surface** [B] (M) — granulation, prominences and corona.
- [ ] **11.5 Plasma** [A] (S) — energy-ball and plasma-globe looks from the flame building blocks.
- [ ] **11.6 Meteor trail** [B] (M) — a re-entry streak with ablation sparks and a lingering glow.
- [ ] **11.7 Material comparison page** [—] (S) — one simulation, every material, side by side.

## Epic 12 — Production readiness

What it takes to move an effect from demo to real site.

- [ ] **12.1 Embed API** (M) — every effect usable as `mount(canvas, options)` from a standalone ES module; per-effect gzip size reported. Depends on 1.3 having kept shaders per effect. _Also due here: each effect's `meta.ts` is in the first load (about 0.3 kB gzipped each, 3.6 kB for thirteen effects, grouped into one chunk). Before there are a hundred, move the scorecard text out of `meta.ts` into a lazily loaded file._
- [ ] **12.2 Lifecycle hygiene** (S) — pause when offscreen or hidden, shared device across canvases, clean teardown.
- [ ] **12.3 Adaptive quality** (M) — dynamic resolution scaling toward a frame budget; simulation and march resolution tiers; `powerPreference`.
- [ ] **12.4 Accessibility** (M) — a flash analyser that measures luminance and saturated-red transitions per second over screen area and runs against every effect; reduced-motion behaviour; a visible pause control; text-contrast guidance over bright moving backgrounds.
- [ ] **12.5 Fallback ladder** (M) — WebGPU → WebGL2 port (selected Tier A effects) → flipbook or video → poster → CSS gradient. Decide and document per effect.
- [ ] **12.6 Compatibility notes** (M) — optional features and limits that bite in practice (float filtering and blending, storage formats, 3D textures, timestamp queries), and how to code around each.
- [ ] **12.7 Worker rendering** (M) — `OffscreenCanvas` rendering in a worker; measure main-thread benefit.
- [ ] **12.8 Framework recipes** (M) — React, Vue and Svelte wrappers; SSR-safe initialisation.
- [ ] **12.9 Layering recipes** (S) — canvas behind and in front of content, pointer-event passthrough, alpha compositing and blend modes, with the 3.3 light-page answer written up.
- [ ] **12.10 Three.js / TSL ports** (M) — port two or three effects and compare developer experience and bundle size.

## Epic 13 — Benchmarking and findings

Turn the demos into conclusions.

- [ ] **13.1 Cost studies** (M) — one study per effect epic from the 1.8 harness, with raw JSON and bundle sizes, collected into a single results page.
- [ ] **13.2 Device matrix** (M) — results from an integrated-GPU laptop, Apple Silicon, a mid-range Android phone and an iPhone. Scheduled in M3 so tier verdicts stop resting on one machine.
- [ ] **13.3 WebGPU versus WebGL2** (L) — Doom fire and the combustion fluid in both; compare performance and code complexity.
- [ ] **13.4 Thermal behaviour** (S) — frame-time drift over long mobile sessions.
- [ ] **13.5 Live versus baked** (M) — for each Tier A and B effect, the same shot as a looped video and as a flipbook: bytes, GPU cost, and what is lost.
- [ ] **13.6 Decision guide** (M) — "which effect for which job", with budgets and caveats.
- [ ] **13.7 Visual regression** (M) — screenshot tests with a deterministic time seed.
- [ ] **13.8 Bibliography** (S) — every reference, linked from the effects that use it.

---

## Risks and open questions

- **Light pages.** Fire is additive light, and a white page has no headroom to add to. Most flame effects will need a dark region, a smoke underlay or a blend mode to read at all. Story 3.3 settles the default early; some effects may honestly be dark-theme only.
- **Photosensitivity.** Flicker, explosions and fireworks sit close to the WCAG flash thresholds, and saturated red is called out specifically. The flicker cap (3.6) and flash analyser (12.4) are requirements, not polish.
- **The video alternative.** A looped video of real fire is cheap, convincing and well supported. Live shaders have to earn their place through interactivity, resolution independence, bundle size or integration with the page. Story 13.5 measures this directly.
- **Looking fake.** Fire is harder to fake than water: scrolled noise reads as a scrolling texture very quickly. Expect several Tier A stories to end with "works at small sizes only".
- **Measurement.** In the browser, per-pass GPU timestamps overlap on tile-based GPUs and have a floor of about 1 ms on the development machine, so HUD readings are indicative. The cost studies run on Dawn under Node, where the floor is about 0.1 ms, but repeated runs of a light effect still differ by about half a millisecond and the GPU's clock follows its load, so effects under about 2 ms cannot be ranked against each other. Only an M1 Max has been measured: it can show a Tier A or B effect is over its budget, never that it fits, because those budgets are set for an integrated GPU. It already showed eight of the first thirteen scenes over the budget they were first given, once Chrome's own frame time was read (`docs/studies/browser-check.md`): the Dawn numbers alone had flattered them.
- **HDR output.** True HDR canvas output would suit fire better than anything else on the web, but it was expensive on the one machine tested. It stays opt-in until understood on other browsers and displays.
- **Backdrop capture.** Heat haze over live page content needs page pixels in a texture, which is still not a stable capability. Haze effects ship over images, video and re-rendered content.
- **Volumetric cost.** Ray-marched and 3D-simulated fire may be desktop-only in practice. Epic 13 should say so plainly rather than tune indefinitely.
- **Divergence from Water Temple.** Copied code will drift. Revisit after M1 whether the shared core is worth extracting.
- **Scope.** There are over a hundred stories. M0–M3 form a complete, useful site; M4 and M5 can be trimmed without leaving holes.

## Starting references

- William Reeves, _Particle Systems — A Technique for Modeling a Class of Fuzzy Objects_ (1983) — the original particle fire.
- Ken Perlin and Eric Hoffert, _Hypertexture_ (SIGGRAPH 1989) — noise-shaped volumes, including fire.
- Jos Stam and Eugene Fiume, _Depicting Fire and Other Gaseous Phenomena Using Diffusion Processes_ (SIGGRAPH 1995).
- Jos Stam, _Stable Fluids_ (1999); Mark Harris, _Fast Fluid Dynamics Simulation on the GPU_ (GPU Gems, ch. 38).
- Fedkiw, Stam, Jensen, _Visual Simulation of Smoke_ (SIGGRAPH 2001) — vorticity confinement.
- Nguyen, Fedkiw, Jensen, _Physically Based Modeling and Animation of Fire_ (SIGGRAPH 2002) — combustion model and blackbody rendering.
- Crane, Llamas, Tariq, _Real-Time Simulation and Rendering of 3D Fluids_ (GPU Gems 3, ch. 30) — 3D smoke and fire on the GPU.
- Horvath and Geiger, _Directable, High-Resolution Simulation of Fire on the GPU_ (SIGGRAPH 2009).
- Fuller, Krishnan, Mahrous, Hamann, Joy, _Real-Time Procedural Volumetric Fire_ (I3D 2007).
- Perlin and Neyret, _Flow Noise_ (SIGGRAPH 2001); Bridson, Houriham, Nordenstam, _Curl-Noise for Procedural Fluid Flow_ (SIGGRAPH 2007).
- Wrenninge and Zafar, _Production Volume Rendering_ (SIGGRAPH 2011 course) — pyroclastic noise.
- Tristan Lorach, _Soft Particles_ (NVIDIA, 2007).
- Wyman, Sloan, Shirley, _Simple Analytic Approximations to the CIE XYZ Color Matching Functions_ (JCGT 2013); Mitchell Charity, _What color is a blackbody?_ — blackbody to RGB.
- Drossel and Schwabl, _Self-Organized Critical Forest-Fire Model_ (1992) — the fire-spread automaton.
- Fabien Sanglard, _How Doom Fire Was Done_ (2018).
- Simon Trümpler, _Stylized VFX in RiME_ (GDC 2018) — stylised fire and smoke.
- Pavel Dobryakov, _WebGL Fluid Simulation_ — a widely used web stable-fluids implementation.
- XT95, _Flame_ (Shadertoy) — compact ray-marched flame.
- WCAG 2.2, Success Criterion 2.3.1 _Three Flashes or Below Threshold_.
- Water Temple: [plan](../watertemple/plan.md), [effect authoring](../watertemple/docs/effect-authoring.md), [support matrix](../watertemple/docs/support-matrix.md), [backdrop capture study](../watertemple/docs/backdrop-capture-study.md).
- WebGPU and WGSL specifications; webgpufundamentals.org.
