# Writing an effect

How to add an effect or a shared shader chunk to this site. `src/effects/hello/` is the smallest
working example; read it alongside this page.

## Files

```
src/effects/<id>/
  meta.ts      export const meta: EffectMeta    (bundled eagerly; keep it tiny, no imports but types)
  index.ts     export const effect = defineEffect({ meta, params, presets, create })
  *.wgsl       the effect's own shaders
  notes.md     the write-up; headings fixed by docs/effect-notes-template.md
```

`<id>` is the directory name, the `meta.id`, and the URL (`?effect=<id>`). The registry discovers the
directory; nothing else needs registering. `meta.epic` is the epic number in plan.md as a string.

## The contract

`create(ctx)` receives `{ device, format, hdr, canvas, params, profiler }` and returns
`{ resize(width, height, dpr), frame(time, encoder, target), destroy() }`.

- `params` is a live object. Read it every frame; never copy it at creation.
- `frame` encodes passes into the encoder it is given and must finish by drawing into `target`
  (a view of the canvas texture, in `format`). The shell submits.
- `resize` is called before the first frame and whenever the drawing buffer changes. Size-dependent
  targets are (re)created there.
- `destroy` releases every GPU object and listener the effect made.
- Give every pass `timestampWrites: profiler.pass('label')` so the HUD can time it.
- Use `time.delta` to advance your own phase (see hello) so a `speed` parameter never makes the
  picture jump. Simulations step with `createFixedStepper` from `src/gpu/loop.ts`.
- Colours in `params` are linear RGB.
- A `vec2f` / `vec3f` uniform field takes a tuple (`[number, number]`), not a `number[]`: type
  accumulators accordingly or strict typecheck fails.
- There is no DOM in the tests: guard any use of `window`, `document` or `matchMedia`, and take
  input only through the `canvas` you are given.

## Shaders

```ts
import shader from './flame.wgsl';                      // { label, code, chunks }
import { withChunks } from '../../gpu/shader.ts';

createFullscreenPipeline(device, {
  fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
  format: tail.scene.format,
});
```

- Import a `.wgsl` file without a query. The build (`vite-plugin-wgsl.ts`) turns it into a
  `ShaderSource` whose `chunks` already hold every file it `#include`s, transitively: files beside
  it first, then the shared library in `src/wgsl/`. Only those files reach the effect's bundle.
  **There is no global library at run time.** An include that is in neither place must be supplied
  with `withChunks`, as uniform structs generated from TypeScript are.
- A shader assembled as a string in TypeScript gets its includes the same way: import the library
  files it needs and pass `chunks: libraryChunks(noise, color)` (`src/gpu/shader.ts`).
- Always compile through `createShader` / `createFullscreenPipeline`, never
  `device.createShaderModule`: that is what gives errors their original file and line, and what the
  Source tab reads.
- `npm run build` fails if any shader text reaches the first page load
  (`scripts/check-bundle.mjs`). Never import a `.wgsl` file from the shell or from `meta.ts`.

## Light: the HDR tail

Fire is emissive and far brighter than the page. Every effect draws **linear radiance** into an
`rgba16float` scene target and ends with the tail, which blooms, tonemaps, sRGB-encodes and dithers:

```ts
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';

params: { ...own, ...TAIL_PARAMS },
// create
const tail = createHdrTail(device, { format, hdr, label: 'flame' });
// resize
tail.resize(width, height);
// frame: draw into tail.scene.view (format tail.scene.format), then
tail.encode(encoder, target, time, params, profiler);
```

- Units: 1.0 is SDR white, a paper-white page. Glowing embers are around 1 to 3, flame bodies 3 to
  15, cores 15 to 50. Bloom takes what is above its threshold (default 1.0), and its level count
  follows the canvas size, so the glow reaches the same share of the picture at any resolution. If nothing in the
  scene exceeds 1 the effect will look like orange paint; that is the bug, not the bloom settings.
- Do not tonemap or sRGB-encode in the effect. The tail does both, once.
- `tail.scene.view` changes on resize: read it every frame, and rebuild bind groups that hold it.
- The scene's alpha channel is yours. With the default opaque output it is ignored.

### Over the page

An effect that should sit on the page rather than fill its box also spreads `OVERLAY_PARAMS`, which
adds `alpha`, `alphaGain` and `underlay` and makes the tail write a see-through result for the
premultiplied canvas. The canvas shows `rgb + (1 - alpha) * page`, and the tail writes the same
`rgb` in every mode, so a mode is only a choice of how much page to hide
([docs/compositing-study.md](compositing-study.md) has the pictures and numbers):

- `luminance` (the default, with `underlay: 0.3`): alpha is at least the brightest output channel.
  Over a dark page it is within a few 8-bit steps of additive light; over a light page the flame
  still reads, by hue. It is always a valid premultiplied colour.
- `additive`: alpha 0. Invisible over a light page, and colour brighter than its alpha is
  something the WebGPU spec leaves undefined when displayed. Use it only knowingly.
- `coverage`: alpha is the scene's own alpha. For scenes drawn with real coverage (smoke, char,
  silhouettes). A flame has none, so on its own this shows smoke rising from nothing on a light
  page; `luminance` already takes the larger of scene alpha and brightness.
- `underlay` (0..1, with any mode): darkens the page around the light, using the bloom as the
  mask, so it needs bloom on and reaches only as far as the bloom does.

On a light page nothing can be brighter than the paper, so fire there is ink, not light. Check
every overlay effect over both pages (the "Page" control, or `&page=light`) and record the verdict
in `scorecard.lightPage`: `yes` for a saturated flame with a shape, `underlay` when the look needs
the core to be the brightest thing (underlay 0.5 or more, or a backplate), `no` for light with
little hue (sparks, steam), for effects that are mostly glow or that light the page, and for
anything pixel-thin.

## Flicker

Fire flickers, and flicker is a photosensitivity risk. WCAG 2.3.1 allows no more than three
flashes in any second over a large area, and treats saturated red as worse. Keep whole-frame
brightness changes slow (below about 3 Hz) and small (well under 10% of full white per swing),
let fast motion be local, and fill in `scorecard.flash`. For a wall of flame the thing that trips
the analyser is rise speed, through the saturated-red rim: about one noise cell a second was safe,
about two was not. `tests/flash.test.ts` measures every
effect at its defaults (`tests/flash.ts` explains how) and fails when an effect is flashier than
its scorecard says: `none` means no cell of the picture ever completes a flash, `low` means local
flicker under the threshold, `high` is over it. Every preset is measured too. Bring an
over-threshold preset under the limit if you can; if it cannot be what it is meant to be without
flashing, name it in `scorecard.flashPresets`, which makes the controls label it. Under `prefers-reduced-motion` the shell
holds a still frame; an effect must look right as one.

## Helpers (use these before writing your own)

| Need | Where |
|---|---|
| Fullscreen fragment pass | `src/gpu/fullscreen.ts` + `#include "fullscreen.wgsl"` (uv origin top-left) |
| Uniform structs that match WGSL | `src/gpu/uniforms.ts` (`defineUniformStruct`, inject `Struct.wgsl` as a chunk) |
| HDR scene target, bloom, tonemap | `src/gpu/post/` (`createHdrTail`; `createBloom`, `createOutputPass` on their own) |
| Render targets, ping-pong | `src/gpu/targets.ts` |
| Textures from data / images, mipmaps | `src/gpu/texture.ts`, `src/gpu/mipmap.ts`, `src/gpu/media.ts` |
| Blit, Gaussian blur, downsample | `src/gpu/passes/` |
| Pointer position and drags | `src/gpu/pointer.ts` |
| Scroll position, audio level | `src/gpu/scroll.ts`, `src/gpu/audio.ts` |
| Where DOM elements are, in canvas uv | `src/gpu/dom-rects.ts` |
| 2D and 3D grid fluids; fire as a fluid | `src/gpu/sim/fluid.ts`, `fluid3d.ts`, `fire-fluid.ts` (+ `obstacles.ts`, `obstacle-shapes.ts`) |
| Pointer and ambient ignition, scroll and audio drive (simulations) | `src/gpu/sim/ignition.ts` + `ignite.wgsl`, `src/gpu/sim/excitation.ts` |
| Camera, meshes, a forward pass | `src/gpu/scene/` |
| Noise, FBM, Voronoi, curl, SDF, colour, maths | `src/wgsl/*.wgsl`; each file's header lists its functions |
| Noise from a texture fetch (use this in Tier A) | `getNoiseTexture(device)` in `src/gpu/emission/noise-texture.ts` + `#include "noisetex.wgsl"` |
| Flame colour, shape, motion, flicker | `ramp.wgsl`, `blackbody.wgsl`, `flame.wgsl`, `advect.wgsl`, `flicker.wgsl` (+ `src/gpu/emission/`) |
| Heat haze, sprites, smoke, firelight, volumes | `haze.wgsl`, `sprite.wgsl` + `src/gpu/sprites.ts`, `smoke.wgsl`, `firelight.wgsl`, `volume.wgsl` + `src/gpu/volume/` |
| GPU particles: pool, emitters, forces, colliders, GPU spawning, sprites | `src/gpu/particles/` + `particles.wgsl` (see "Particles" below) |

## Shared WGSL chunks (`src/wgsl/`)

- Pure libraries: `const`, `fn`, and sparingly `struct`. No entry points, no bindings, no
  module-scope `var`. A chunk that needs a texture takes it as a function parameter.
- One flat namespace across all chunks: snake_case, a distinctive prefix per file, private helpers
  start with `_`. Each file starts with a header listing every public function, its meaning and
  ranges. `tests/wgsl-library.test.ts` enforces the header, compiles every chunk alone and all
  chunks together, so a name collision fails the suite.
- Each chunk `#include`s what it depends on.
- WGSL reserves many ordinary words as identifiers (`patch`, `crate`, `pass`, `filter`, `mod`,
  `target`, `layout`, `active`, `set`, `from`, `diagnostic`, …). An "unexpected token" on a plain variable name usually means it is one of them.
- Prove behaviour with numbers: `tests/wgsl-eval.ts` runs WGSL on the GPU from a test
  (`gpuF32`, `scalars`). Tests may include any library chunk; they pass the whole library
  (`tests/library.ts`), which application code never does.

## Budgets and limits

- Tier budgets (GPU time at 1080p, tail included): A ≤ 2 ms on an integrated GPU, B ≤ 6 ms,
  C ≤ 12 ms on a discrete or Apple Silicon GPU. Pick the tier the effect actually fits.
- Stay inside WebGPU core features and default limits. An optional feature is feature-detected
  (`device.features.has(...)`) and has a fallback path; say so in the scorecard.
- `rgba16float` is renderable, blendable and filterable everywhere. 32-bit float textures are not
  filterable without `float32-filterable`. See docs/support-matrix.md.
- No downloaded assets. Textures are procedural (generated in a shader or from typed-array data).

## Definition of done

1. Two or more presets, and parameters that are worth exposing (not every constant).
2. `meta.scorecard` filled in honestly, including `flash` and `lightPage`. Leave `gpuMs` and
   `bundleKb` out: they come from `npm run study` (per-frame cost on Dawn) and
   `npm run browser-check -- --device <name> --class <kind>` (one frame as Chrome reports it), not
   from a glance at the HUD. The tier is the lowest one whose budget neither number exceeds; an A
   or B label stays provisional until an integrated GPU has been measured.
3. `notes.md` follows the template. Put rough HUD readings in "Cost", labelled with the device,
   resolution and "indicative".
4. Works in the page contexts (`&layout=hero`, `cards`, `band`, `backdrop`) at their sizes, at
   phone width, and over both page tones. `npm run browser-check -- --effects <id>` (with the dev
   server running) loads all of them in headless Chrome, fails on a view that does not start,
   logs an error or draws nothing, and writes screenshots to `output/browser/<id>/`: look at them.
5. `npx vitest run` passes: `tests/effects.test.ts` runs every effect headlessly for three frames
   and fails on any validation error or a blank result; `tests/content.test.ts` checks the notes,
   scorecard and presets.
6. `npx tsc --noEmit -p tsconfig.json`, `npx eslint .`, `npx prettier --check` are clean.

## Simulations

For anything with persistent state:

- State lives in a `createPingPongTarget` (`src/gpu/targets.ts`); steps come from
  `createFixedStepper` (`src/gpu/loop.ts`). Shared simulation modules go in `src/gpu/sim/`.
- Heat comes in through the shared ignition layer (`src/gpu/sim/ignition.ts` + `ignite.wgsl`):
  `createPointerIgnition` (tap, drag, multi-touch) and `createAmbientIgnition` (stray embers, so a
  scene nobody touches is never dead), combined with `collectIgniters` and written with
  `writeIgniters`. Do not hand-roll pointer splats.
- An outside drive is a 0..1 level from `createExcitation('scroll' | 'audio' | 'none', canvas)`
  (`src/gpu/sim/excitation.ts`), exposed as a `drive` parameter. Feed it into fuel or ember rate
  as a share of the calm level, never into the simulation's clock.
- A cell that flips every step flickers at the step rate. Keep the step rate and the speed of a
  bright front low enough for the flash analyser, or blur the state before it is shown.
- Writing to an `rgba16float` target truncates toward zero on Apple GPUs instead of rounding, so
  a quantity that changes by less than half a step per write leaks away (Epic 5 lost 0.05 of a
  unit of fuel a second this way). Round stochastically in the shader to an exact half float
  (`combust_quantise` in `src/gpu/sim/combustion-step.wgsl` does it with an exact ulp), and do not
  count elapsed time in a half float: it stops resolving 1/60 s past about 32 s.
- Several steps encoded in one frame each need their own uniform buffer: `writeBuffer` calls
  before a submit all land before the first step runs, so they would share the last values.
- Randomness is a hash of (cell, step, seed), never per-frame `Math.random`, so runs repeat and the
  render and compute versions of a step agree. Tests of a probabilistic rule still check shapes and
  totals, never single cells: one last-digit difference between drivers diverges the whole run.
- Fluids: build on `src/gpu/sim/fluid.ts` (2D) or `fluid3d.ts` (3D), and for fire on
  `createFireFluid` in `src/gpu/sim/fire-fluid.ts`, which owns the solver's hooks and keeps
  temperature, fuel, soot and burn rate in the dye. Step through the fire module, never
  `fluid.update` directly. Burning gas expands, and a closed box cannot hold a net expansion: use
  `boundary: 'open'` with `closedEdges: ['bottom']` for a floor.
- Check every new force against open edges for several seconds, not three frames: the port found a
  multigrid that diverged and a vorticity sheet that ran away only after seconds. Keep vorticity
  confinement under about 14 x `velocityDissipation`. An open (Dirichlet) edge must put its ghost
  value at the face, not at the ghost cell's centre, or the V-cycle diverges.
- The solver applies queued splats to the next step only, so a warm-up that needs splats on every
  step needs one submit per step. `createObstacleShapes(...).attach()` takes the solver's only
  `hooks.forces` slot: chain it if a combustion layer needs that hook too.
- A front has to be about three cells thick to stay round and move at its physical speed; thinner
  ones pin to the grid. A rule that only reads axis neighbours grows diamonds: use all eight with
  weights, or an arrival-time update (`src/gpu/sim/burn.ts`).

- Keep the grid independent of the canvas size and step it with a fixed timestep, so it behaves
  the same at 60 Hz, 120 Hz and after the tab was in the background.
- Know the scheme's stability condition and clamp to it; a simulation that can explode will.
- State lives in `rgba16float`: it is renderable, filterable and a valid write-only storage format
  on every device. Ping-pong; never assume read-write storage textures.
- Expose a `generation` counter that bumps when textures are re-created, so consumers know to
  rebuild their bind groups.
- A render-pass solver can be ported to WebGL2 as a fallback; a compute solver cannot. Default to
  render passes unless compute is clearly needed, and set `scorecard.compute` accordingly.

## Particles

Particle effects build on the GPU particle framework in `src/gpu/particles/` (story 7.1; read the
header of `system.ts` first, and `src/effects/particle-system/` for every feature switched on one at
a time, `src/effects/embers/` for a shipped effect on it):

```ts
import {
  createParticleRenderer, createParticleSystem, overlayCamera, planeThrough,
} from '../../gpu/particles/index.ts';

const system = createParticleSystem({ device, capacity: 16384, dimension: 2, profiler, label: 'sparks' });
const tip = system.addEmitter({ shape: 'point', rate: 600, spread: 0.6, speed: [0.4, 0.9],
                                life: [0.4, 1], temperature: [2200, 2700], size: [0.002, 0.004] });
system.forces.gravity = [0, -1.5, 0];                   // forces, heat, colliders: live objects
system.colliders.push(planeThrough([0, 0.05, 0], [0, 1, 0]));
const renderer = createParticleRenderer(system, { camera: cameraBuffer, format: tail.scene.format });
// resize: setCameraUniform(camera, overlayCamera(width, height), width, height)
// frame:
tip.moveTo(point);                                      // swept: no gaps however fast it moves
system.advance(encoder, time.delta);                    // fixed steps, one compute pass
renderer.encode(encoder, time.delta);                   // sprite instances, written on the GPU
renderer.draw(encoder, { target: tail.scene.view, clear: { r: 0, g: 0, b: 0, a: 0 } });
```

- **Spaces.** A 2D overlay system uses `overlayCamera` (world units are canvas heights, origin at the
  bottom-left, y up; pointer and igniter uv go through `overlayPoint`). A 3D one passes the forward
  renderer's `view.camera.buffer` and a `depth` view to `draw` for soft particles.
- **Emitters** (`emitter.ts`): point, segment, box, sphere shell, disc/ring; `rate` per second with a
  fractional carry, `burst(n)`, `moveTo` for a moving emitter, at most eight per system. A rate-0
  emitter is a *template* for GPU-spawned children.
- **Forces and heat** (`forces.ts`): gravity, linear and quadratic drag towards `wind`, buoyancy per
  1000 K above ambient, curl turbulence (`'2d'`, `'3d'`), up to four attractors or vortices, an
  external velocity texture (`system.setField(fluid.fieldsView)` with `overlayFieldMapping(aspect)`
  for the Epic 6 fluid; modes `drag`, `accel`, `advect`), Newtonian or linear cooling and a death
  temperature.
- **Colliders** (`colliders.ts`): plane, sphere, box (solid or container) and an SDF from
  `hook_sdf`, tested on the segment a particle moved along, so nothing tunnels. Per collider:
  restitution, friction, `kill`, `cool`, `spawnCount` children from a template.
- **Hooks**: `createParticleSystem({ hooks: { code, chunks } })` splices WGSL into the kernels.
  Define any of `hook_force`, `hook_update`, `hook_collide`, `hook_die`, `hook_emit`, `hook_sdf`,
  `hook_sprite` (signatures in `kernels.wgsl`); the rest get empty defaults. Read the four
  `system.params.user` vec4s as `ps_step.user[i]` (and `renderer.style.user` as `ps_draw.user[i]`
  in `hook_sprite`). `userData: true` adds a free vec4 per particle (`p.user`).
- **GPU spawning**: from `hook_update`, `hook_collide` or `hook_die`, `ps_spawn(position, velocity,
  count, template, user)` appends a request with an atomic; the same step's emit pass gives its
  children priority over CPU emission. No CPU round trip. `hook_emit` sees `source.spawned` and the
  request's `user`.
- **Colour**: the renderer's default is `blackbody_radiance(T, style.tRef, style.gamma) * tint *
  intensity`, with per-particle twinkle capped at 4 Hz, a fade in and out, and a size-over-life
  curve. `sprites.settings` is the shared sprite renderer's (shape, stretch, pixel floor).
- **Start full**: `system.warmup(seconds)` simulates in its own submits; call it on the first frame
  after `resize`, so a reduced-motion still looks right.
- **Statistics**: `system.stats` (live count and running totals, a few frames late, for a HUD
  label); `await system.readStats()` and `await system.read()` are exact, for tests.

Pitfalls found building it:

- A buffer copied into an encoder that is not yet submitted must not be mapped: the submit then
  fails validation and the whole command buffer is dropped, silently unless you push an error
  scope. Read back with a small submit of your own.
- One dispatch cannot use a buffer both as writable storage and as indirect arguments: keep the
  arguments in their own buffer, written by a kernel dispatched directly.
- In a kernel that includes library chunks, never name a module-scope variable after a WGSL
  built-in function (`step`, `select`, `min`...): it shadows it for every chunk. `template` is a
  reserved word.
- Each step encoded before one submit needs its own uniform slot (the framework keeps a ring of 32):
  at most 32 steps per submit.
- A collider that spawns on contact will spawn again when the children land: filter by `kind` in
  `hook_collide`, or launch children away from the surface.
- Dawn quantises GPU timestamps (65 µs here); a benchmark unit of one particle step reads as no time
  at all. Measure several steps a unit (`PARTICLE_BENCH=1 npx vitest run tests/particles.test.ts -t cost`).
- Sub-pixel sprites need the sprite renderer's pixel floor (`minPixels`), and an orthographic camera
  needs the eye at a view distance of 1 for that floor to be right (`orthographicCamera` does it).

## Reading the HUD honestly

- The HUD's GPU figure is the time from the frame's first timed pass starting to its last one
  ending. Never add up the per-pass figures: on tile-based GPUs (Apple Silicon, most phones) the
  intervals overlap, and eight tiny passes can sum to six times the real total.
- There is a floor. On the Apple Silicon development machine a pass that draws almost nothing
  reads about 1.2 ms, so anything at or below roughly 1 ms means "too cheap to measure here",
  not "costs 1 ms".
- Readings move with whatever else the GPU is doing. Quote them as indicative, with the device and
  resolution, and leave scorecard numbers to the benchmark runs.
- An HDR (extended-range) canvas made the whole page drop from 120 fps to 35-50 fps on that same
  machine in Water Temple. It is opt-in per visit (`&hdr=1`) and never used for thumbnails.

## Keeping a fragment effect cheap

Rules of thumb for a Tier A effect, carried over from Water Temple's measurements:

- Per-pixel noise is the budget. Epic 3's full-canvas procedural-noise scenes read 2 to 5 ms for
  one frame in Chrome at 1080p on an M1 Max, over the Tier A budget even there. Read noise from
  the shared baked tile instead (`getNoiseTexture` + `noisetex.wgsl`: one fetch replaces a
  four-octave fractal sum), and keep whatever procedural noise is left to a couple of evaluations.
- A texture fetch is far cheaper than noise. Bake what does not need to change every frame: render
  it once into a target in `create` or `resize`.
- Skip work early for pixels that cannot show it (above the flame, outside a glow radius).
- Blur with mips or the downsample chain, not a wide kernel at full resolution. The tail's bloom
  already gives every effect a soft glow for free; do not compute a second one.

## Checking in the browser

`npm run shot -- <id> [--preset p] [--times 1,3] [--bg dark,light]` renders an effect without a
browser and writes PNGs to `output/shots/`, which is the quick way to look at a change.

`npm run dev`, then `?effect=<id>&hud=1`. The HUD shows per-pass GPU time against the tier budget.
Shader errors appear in an overlay with the original file and line; edits hot-reload without a
page refresh.
