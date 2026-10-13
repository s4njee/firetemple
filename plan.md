# Fire Temple — WebGPU fire effects research site

A research site that implements, measures, and documents fire-looking WebGPU effects, judged by one question: **would you actually ship this on a website?** Every effect gets a live demo, readable source, a write-up, and a practicality scorecard. Sibling of [Water Temple](../watertemple/plan.md), and built on what that project learned.

## Goals

- Cover a wide range of fire techniques, from one-pass fragment shaders to compute-driven combustion and volumetric rendering.
- Show each effect in a realistic web context (hero, card, button, background), on both dark and light pages, not only on a bare black canvas.
- Record what each effect costs: GPU time, bundle size, device coverage, fallback story.
- Say plainly when a looped video or baked flipbook would do the job better than a live shader.
- Keep every effect a self-contained module that can be lifted into another project.

## Non-goals

- A general-purpose rendering engine or a published npm library (extraction may come later).
- Physically exact combustion. Plausible and cheap beats correct and slow.
- Full WebGL2 parity. WebGL2 ports are done only where the comparison is the research.
- A shared package with Water Temple. Code is copied across and allowed to diverge; extraction is a later question.

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
| Hosting             | Static build, any static host                                    | No server needed.                                                                                                               |
| No-WebGPU behaviour | Poster image or captured video per effect                        | Honest fallback; mirrors what a production site would do.                                                                       |

## Carried over from Water Temple

Findings that shape this plan rather than being rediscovered.

- **Per-pass GPU timings are indicative only.** Passes overlap on tile-based GPUs and a trivial pass reads about 1.2 ms on Apple Silicon. Time a frame from first pass start to last pass end, repeat light workloads N times per frame and take the slope, and run with nothing else on the GPU.
- **Arbitrary live DOM capture is not a shipped path.** Re-rendered content and stable image/canvas/video uploads are. Heat haze over page content inherits this limit ([backdrop-capture-study.md](../watertemple/docs/backdrop-capture-study.md)).
- **Tier verdicts rested on one machine.** Only an M1 Max was measured. The device matrix (13.2) is scheduled earlier here, in M3.
- **CI never ran** because the repo had no remote. Story 1.10 is not done until a workflow has gone green.
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

1. Runs inside its tier budget on the reference devices, with numbers recorded.
2. Parameters exposed through the schema, with at least two presets.
3. Handles resize, DPR changes, device loss, offscreen pause, and `prefers-reduced-motion`.
4. Stays under the flash threshold (WCAG 2.3.1) at default settings, with the flash-risk field of the scorecard filled in.
5. Shown in at least one realistic web context, checked over both a dark and a light page.
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

- [ ] **1.1 Repo scaffold** (S) — `git init`, Vite `vanilla-ts`, strict TS, `@webgpu/types`, ESLint + Prettier, `dev` / `build` / `preview` / `typecheck` / `test` scripts, dependency versions matched to Water Temple.
- [ ] **1.2 Port the GPU core** (M) — device and canvas setup, premultiplied-alpha configuration, frame loop with fixed-step accumulator, resize handling, uniform struct writer, targets and ping-pong, texture and mip helpers, pointer, scroll, audio, DOM rects, profiler, blit / blur / downsample passes, each with its tests. Leave the water-only modules behind (ocean, liquid-2d, fluid-surface, weather, ui).
- [ ] **1.3 WGSL pipeline with per-effect packaging** (M) — `?raw` imports, `#include` preprocessor, HMR that rebuilds pipelines without a reload, compile errors in an overlay with correct line mapping. Includes resolve at build time into each effect's lazy chunk; shaders assembled in TypeScript go through the same resolver. A test fails the build if any shared WGSL lands in the eager bundle.
- [ ] **1.4 Effect contract and registry** (S) — the interface above, discovery through `import.meta.glob`, one lazy chunk per effect, a `hello` effect as the smallest example.
- [ ] **1.5 Shared WGSL base** (S) — port hash, value/simplex noise, FBM, Voronoi, curl noise, SDF primitives and smooth-min, colour-space functions, with the header-and-namespace test.
- [ ] **1.6 HDR tail** (M) — `rgba16float` scene target, bloom, tonemap and sRGB encode as one reusable tail every effect ends with; cost measured so it can be subtracted from tier budgets; extended-range canvas kept as an opt-in spike.
- [ ] **1.7 Headless test harness** (S) — Vitest on Dawn's Node bindings, a WGSL evaluation helper for numeric shader tests, `effects.test.ts` over the registry, `experiments/` with its own config.
- [ ] **1.8 Benchmark harness** (M) — scripted run per effect at fixed resolutions, frame time measured first-pass-start to last-pass-end, repeated-workload slope for light effects, JSON plus bundle sizes exported to `docs/`. One `study` command parameterised by epic, not one script per epic.
- [ ] **1.9 Failure handling** (S) — no-WebGPU screen with poster, `device.lost` recovery, uncaptured-error reporting.
- [ ] **1.10 Build and deploy** (S) — static build with configurable base path, git remote, CI running lint + format check + build + tests on software Vulkan, preview deploys. Done when a workflow run is green.
- [ ] **1.11 Support matrix refresh** (S) — re-check Water Temple's [support-matrix.md](../watertemple/docs/support-matrix.md) against current browsers, adding what fire leans on: `rgba16float` rendering and blending, `float32-filterable`, `timestamp-query`, canvas tone-mapping modes, 3D storage textures.

## Epic 2 — Site shell and research UX

The frame the research is presented in. Ported, then adjusted for a subject that is bright, flickering and dark-page-biased.

- [ ] **2.1 Gallery home** (M) — effect cards filterable by tier and tag; live thumbnails only while in view, all canvases sharing one `GPUDevice`.
- [ ] **2.2 Effect page** (M) — canvas, generated controls, presets, shareable URL state, fullscreen toggle.
- [ ] **2.3 Performance HUD** (M) — FPS, CPU frame time, per-pass GPU time through `timestamp-query` where available, resolution scale, estimated texture memory.
- [ ] **2.4 Source viewer** (S) — highlighted WGSL (includes expanded) and TS for the effect, with a copyable minimal snippet.
- [ ] **2.5 Write-up template** (S) — markdown rendered alongside each demo, same headings for every effect.
- [ ] **2.6 Practicality scorecard** (S) — tier, GPU cost, bundle size, mobile-safe, needs compute, optional features required, fallback, best use cases, plus two fire-specific fields: flash risk and light-page suitability.
- [ ] **2.7 In-context mode** (M) — mock page layouts (hero, card grid, nav, footer) in dark and light variants that any effect can be mounted into.
- [ ] **2.8 Site visual design** (M) — a look that lets the effects carry the page. Dark-first, with a real light theme because it is the hard test for emissive effects.
- [ ] **2.9 Global motion controls** (S) — site-wide pause, an intensity cap, and reduced-motion behaviour that every thumbnail and demo obeys.

## Epic 3 — Emission and shading building blocks

Shared WGSL that most later effects depend on. Each is proven in a small test scene.

- [ ] **3.1 Blackbody colour** (S) — temperature to linear RGB; compare a Planck evaluation, a fitted approximation and a 1D lookup texture on cost and error.
- [ ] **3.2 Flame colour ramps** (S) — authored gradients versus blackbody, chemically tinted flames (copper green, sodium yellow), polynomial versus texture lookup.
- [ ] **3.3 Emissive compositing over the page** (M) — pure additive, premultiplied "over" with luminance-derived alpha, a dark smoke underlay, and CSS blend modes, each checked over dark and light pages. Decides the default every overlay effect uses.
- [ ] **3.4 Bloom tuned for fire** (S) — threshold, radius and mip count against cost; how little bloom still sells heat.
- [ ] **3.5 Heat haze** (S) — noise-driven refraction offset masked by a temperature field, over a backdrop texture.
- [ ] **3.6 Flicker signals** (S) — band-limited noise for intensity and position, with a frequency and amplitude cap that keeps output under the flash threshold. Shared by flames and lights.
- [ ] **3.7 Flame shaping** (S) — teardrop and taper SDFs, height falloff, turbulence growing with height, edge erosion.
- [ ] **3.8 Advected noise** (M) — upward scroll, domain warp, flow noise and curl-noise advection, compared on how well each hides the "scrolling texture" look.
- [ ] **3.9 Soft additive sprites** (S) — procedural sprite shapes, depth fade against scene geometry, velocity stretch.
- [ ] **3.10 Smoke shading** (M) — Beer–Lambert absorption, cheap self-shadowing, and lighting from the fire below.
- [ ] **3.11 Fire as a light source** (M) — flickering point and area lights, 2D radial falloff with soft shadows from SDFs, normal-mapped receivers.
- [ ] **3.12 Volume ray-march kernel** (M) — emission–absorption integration, blue-noise step jitter, early termination, reduced-resolution march with depth-aware upsampling.

## Epic 4 — Shader-only 2D fire

No simulation state. The cheapest and most broadly usable group.

- [ ] **4.1 Scrolling-noise flame** [A] (S) — the classic: FBM scrolled upward, shaped by a height gradient, mapped through a ramp. Compare value, simplex and Voronoi noise.
- [ ] **4.2 Candle flame** [A] (S) — teardrop SDF with a blue core, wick and halo; sways and leans away from the pointer.
- [ ] **4.3 Flame strip** [A] (S) — tileable band of flames for section breaks and footers.
- [ ] **4.4 Fireplace** [A] (M) — layered flames behind log silhouettes, ground glow, fragment-shader embers.
- [ ] **4.5 Heat-haze overlay** [A] (S) — shimmer over any image or video element.
- [ ] **4.6 Ember bed** [A] (S) — Voronoi coals with breathing emissive cracks.
- [ ] **4.7 Stylised toon fire** [A] (M) — banded colour, hard edges, stepped animation.
- [ ] **4.8 Torch and brazier** [A] (S) — small looping flame for icons and list markers; cost measured with many on one page.
- [ ] **4.9 Stateless sparks** [A] (S) — hash-grid sparks rising and fading, no buffers.
- [ ] **4.10 Fire ring** [A] (S) — polar-coordinate flame around a circle, for portals, avatars and loaders.
- [ ] **4.11 Gas jet** [A] (S) — blue directional flame for burners and exhausts, with shock diamonds.
- [ ] **4.12 Firelight background** [A] (S) — slow, warm domain-warped glow that reads as a fire just out of frame.

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

- [ ] **12.1 Embed API** (M) — every effect usable as `mount(canvas, options)` from a standalone ES module; per-effect gzip size reported. Depends on 1.3 having kept shaders per effect.
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
- **Measurement.** Per-pass GPU timestamps overlap on tile-based GPUs and have a floor of about 1 ms on the development machine, so HUD readings are indicative and light effects cannot be ranked by them.
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
