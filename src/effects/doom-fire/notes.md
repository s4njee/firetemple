## How it works

The fire from the PSX Doom title screen, as Fabien Sanglard took it apart: a grid of heat whose bottom row is held hot, where every other cell takes the heat of a cell in the row below it, picked a random few columns to one side, and on a coin toss loses a fixed amount. Heat climbs one row a step, wanders sideways, cools, and that is the whole fire. Nothing in the rule knows about flames; tongues, licks and flicker all come out of it.

**The grid** is its own size, not the canvas's: `resolution` cells along the canvas's shorter side (192 by default, so 344 x 192 on a 16:9 canvas) and square cells along the other, rounded to whole compute workgroups of 8 so dragging a window edge rarely changes it. It is two `rgba16float` textures that swap (`createPingPongTarget`), heat in the red channel. It is stepped at a fixed `rate` (45 steps a second) by `createFixedStepper`, so it behaves the same at 30, 60 or 120 frames a second; `tests/epic5-a.test.ts` checks that the state after 90 steps is bit for bit the same at all three. When the grid does change (a new `resolution`, a canvas of another shape) the fire is resampled onto the new grid rather than restarted, and the solver's `generation` bumps so the display rebuilds its bind groups. The first frame is already a burning fire: up to 480 steps are run at start-up, so a poster, a thumbnail or a reduced-motion still frame never shows a row of coals.

**The solver** is `src/gpu/sim/doom.ts` and `doom-kernel.wgsl`, outside the effect so later effects can reuse it. One function, `doom_next(cell)`, is the whole rule, and two backends call it for every cell:

- **render** (`doom-render.wgsl`): a fullscreen triangle over the next state, one fragment per cell, the previous state read with `textureLoad`.
- **compute** (`doom-compute.wgsl`): 8 x 8 cells per workgroup, the previous state read with `textureLoad` and the next written to a write-only `rgba16float` storage texture.

`backend` switches between them at any time without disturbing the fire.

**Done properly for the web.** Run in parallel on a GPU, the original's white noise looks wrong. The original updates its array in place, scattering each cell into the row above; a GPU step must gather, every cell reading from below at once. A gather that jitters sideways spreads heat across a little each row and never along it, and the picture turns into horizontal dashes (sparks and drawn dots flatten into streaks too). The kernel keeps the rule and changes where its random numbers come from:

- `sway` and `patchy`: a smooth "gust" field, value noise in space and time computed in integers, that neighbouring cells share. It leans the sideways pick (six gusts wide, so neighbours lean together and tongues bend into S shapes instead of being torn into threads) and raises or lowers the cooling (which opens gaps between tongues).
- `lift`: the chance of taking the heat from two rows below instead of one. It spreads heat along its path as the sideways pick spreads it across, so a spark stays round, and the fire climbs `1 + lift` rows a step.
- `grain`: how much of the cooling is the original's coin toss. At 1 a cell loses twice the mean or nothing; at 0 every cell loses the mean. Heat has 1024 levels here against the original's 37, so the coin is no longer needed as a dither, only as texture.
- `uneven`: the base row dips between lumps of fuel that come and go, ridged so the flames above them come to points. At 0 it is the original's flat row.

With `sway`, `patchy` and `lift` at 0, `grain` at 1, `spread` 3 and `uneven` 0 the kernel is exactly the original rule; the test "every cell is a cell of the row below, or that less the cooling" checks that, in both backends.

**Determinism.** Every decision about where heat goes and whether it cools is integer arithmetic on a PCG hash of (cell, step, seed), so the same seed gives the same fire on every device, in both backends and in every run. Heat is kept on a grid of 1/1024, which a half float holds exactly up to 2, so what is stored is exactly what was computed whatever way a driver rounds. Only the igniters and the lumps of fuel are float work.

**The display** (`display.wgsl`) is one fullscreen pass at canvas size: two bilinear fetches (the newest state and the one before it, blended by how far the frame is between two steps, which hides the step rate at any refresh rate), then a ramp into the HDR tail. `palette` picks `ramp_fire`, `ramp_gas`, or the original's 37 colours (`palette.ts`, from Sanglard's article) baked into a 37-texel ramp texture and scaled from 1.25 to 4 times their own brightness so the white end blooms. `pixelated` samples each cell at its centre: the classic blocky look, still blended in time. The pass writes emission only, scene alpha 0, and the effect spreads `OVERLAY_PARAMS`, so the canvas is see-through above and between the flames.

### Render pass or compute pass (story 5.1)

|                                          | render                                                                                                        | compute                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same result                              | yes                                                                                                           | yes: identical state after 150 scripted steps with taps, a drag, wind, gusts and lumps (largest difference 0 on Dawn/Metal; the test allows 1/1024) |
| Per cell per step                        | 1 `textureLoad`, 1 hash, the gust field (24 hashes, skipped when `sway` and `patchy` are 0), one colour write | the same, plus a bounds check; one storage write                                                                                                    |
| Step at 168 x 96 / 344 x 192 / 456 x 256 | 0.09 / 0.07 / 0.09 ms                                                                                         | 0.03 / 0.07 / 0.11 ms                                                                                                                               |
| Step at 1024 x 576 / 1920 x 1080         | 0.22 / 0.73 ms                                                                                                | 0.23 / 0.72 ms                                                                                                                                      |
| Code of its own                          | 5 lines of WGSL; about 18 lines of TypeScript (a layout, a pipeline, a pass)                                  | 10 lines of WGSL; about 37 lines (a layout with a storage texture, a pipeline layout, a pipeline, a dispatch, workgroup rounding)                   |
| Shared                                   | the 101-line kernel and the rest of `doom.ts`                                                                 | the same                                                                                                                                            |
| Ports to WebGL2                          | yes: `texelFetch` and a half-float colour buffer                                                              | no: WebGL2 has no compute shaders                                                                                                                   |

Step times are indicative single runs on Dawn on an Apple M1 Max while other work was using the GPU (`EPIC5A_BENCH=1 npx vitest run tests/epic5-a.test.ts -t cost`); the 168 x 96 row is at the timing floor and its spread (0.01 to 0.14 ms) is wider than the difference. At every size that can be told apart from the floor, the two cost the same.

**The default is the render pass.** It costs the same, it is half the code of its own, it needs no storage-texture support, and it is the one that can be ported to WebGL2 as a fallback (story 12.5). A cellular automaton that reads one neighbour and writes one cell has nothing to gain from compute: no shared memory, no scatter, no reduction. `scorecard.compute` is therefore false; the compute backend is there as the comparison and as a starting point for a solver that does need it.

### Pointer ignition (story 5.2)

`createPointerIgnition(canvas)` hands the step a list of igniters, and `ignite.wgsl` turns each into heat. A tap lights a round spot (`brush`, in canvas heights) that then rises and dies; a drag lights the segment the pointer covered since the last step, so a fast stroke is a continuous line of fire that climbs as a line and breaks into licks; several fingers each draw their own. An igniter raises a cell to its own heat rather than adding to it, so a finger held still is a source like the base row: a flame standing on the finger that tapers to a point, not a block piled up to the clamp. The `draw with the pointer` preset is a low bed of coals under a tall reach, so what is drawn climbs far above the bed. The pointer captures a drag that starts on the canvas, which also stops a touch drag there from scrolling the page.

### Fuel and stray embers (story 5.7)

The base row is the standing fuel. At `fuel` 0 the base goes dark at once and the fire lifts off it and burns out from the bottom up; given fuel again, it relights from the base and climbs back. The preset pair shows it: `burnt out` (no fuel, embers only), then `hearth`. Stray embers come from `createAmbientIgnition` at `embers` a second, landing anywhere in the band the fire can reach, so a scene with no fuel is never dead: each ember is a spark that climbs and goes out.

### Scroll and audio (story 5.8)

`drive` picks `createExcitation('scroll' | 'audio' | 'none')`, a 0..1 level. It raises the base fuel by up to half of its calm level (`baseFuel`): the fire grows taller and its base whiter while the visitor scrolls or while the music hits, and settles back after. It never touches the simulation's clock. `fed by scrolling` is a lower fire for it to feed. The audio drive listens to the site's built-in synthesised pattern: nothing is audible and the microphone is never asked for, but browsers keep audio suspended until a user gesture, so the visitor has to press the canvas once before the level moves (that press also lights a spot).

## Cost

GPU time: not measured yet. Leave the scorecard's numbers to the measured runs. What can be counted:

- Passes: one step pass per simulation step (0 or 1 a frame at 45 steps a second and 60 frames a second; at most 4 a frame after a stall), one display pass at canvas size, then the tail.
- The step: 66 048 cells at the default 192 on a 16:9 canvas (16 128 at 96, 116 736 at 256), each one texel fetch, one PCG hash, 24 more for the gust field (none for the classic rule), a segment distance per igniter in use, and two float value noises for the cells of the bottom row only. About three million cell updates a second at the defaults, independent of the canvas size.
- The display: per pixel, two bilinear fetches of a small texture and the `ramp_fire` polynomial (a third fetch with the original palette). Pixels where both states are cold return after the fetches.
- Memory: the state is 2 x 344 x 192 x 8 bytes = 1.1 MB at the defaults (1.9 MB at 256, at most 4.2 MB for a very wide band); four sets of step uniforms (80 + 528 bytes each); a 37-texel palette. The tail's scene target and bloom chain are on top (about 21.8 MB at 1080p).
- CPU: per step, the igniter list and two small uniform writes.

Indicative readings, Apple M1 Max, Dawn, while other agents were using the GPU: the whole effect at 1920 x 1080 read 0.48 ms a frame with the render backend, 0.50 ms with compute and 0.46 ms at `resolution` 256 and 60 steps a second, against 0.44 ms for `bloom-tuning` (the tail with no scene) in the same run; run-to-run spread is wider than any of those differences, so the fire cannot be told apart from the tail there. The per-step table above is from the same run. Chrome 155 on the same machine (`npm run browser-check`, `hud-1080p` view, median of three loads, GPU shared with other work): 1.05, 1.59 and 1.07 ms a frame in three runs with the render backend, and 0.99 ms with the compute backend; the tail alone reads about 1.0 to 1.3 ms there, and the bloom passes' own readings swung by a factor of two between those runs, so the backends cannot be ranked from them. The step pass read 0.09 to 0.44 ms and the display pass 0.16 to 0.43 ms (per-pass HUD figures, which overlap and have a floor). Nothing has been measured on an integrated GPU or a phone, so Tier A is a target, not a finding.

## Pitfalls

- **The original's speckle flashes.** The coin toss flips cells at the step rate, and in the dark-red top of the fire that is saturated red. The original rule (`grain` 1, 30 steps a second, 96 rows, flat fuel, original palette) measured 339 000 px² of red flashing against the 21 824 px² limit, fifteen times over. `grain` is what drives it, the rate only a little: 10 steps a second still measured 74 000 px², while `grain` 0.5 at 20 to 24 steps a second measured 6 200 px². The `classic doom` preset therefore runs at `grain` 0.4 and 24 steps a second, with a little gust (6 200 px², about a third of the limit), and still looks like the title screen. Do not raise `grain` and `rate` together on the original palette without measuring.
- **The defaults** measured no flashing area at all: at most two red flashes a second in any cell, over 8 seconds at 480 x 270 standing for 1080p. Every preset is under the limit. The fire's whole-frame brightness moves by at most 0.09 of full white.
- **The drive.** The headless analyser cannot scroll or play sound, so the drive was played by hand: the base fuel pumped by a beat through the audio drive's smoothing at 2.3, 3 and 4 beats a second. All three stayed under (no flashing area; the cells along the base reached three flashes a second at 2.3 beats, the limit but not over). A rise with a 0.35 s release cannot pump much faster than that.
- **Resolution changes speed and character, not only sharpness.** The fire climbs `rate x (1 + lift)` rows a second, so on a finer grid it climbs a smaller share of the canvas: keep `rate` in proportion to `resolution` (the defaults are 45 steps for 192 rows). The flame height is set as a share of the grid, so it does not change. Sideways wander shrinks relative to the flame as the grid grows (a random walk grows with the square root of its length), so fine grids give straighter tongues.
- **Heat is not conserved step by step.** A cell takes one whole neighbour or another, so a blob's total heat wobbles as it travels. It is invisible as fire; it matters only to a test that adds heat up.
- **One step, one set of uniforms.** A frame that runs several steps needs separate uniform buffers for each, because `writeBuffer` twice before one submit leaves only the second visible. The solver keeps four slots, which is why a frame carries at most four steps; after a long stall the fire drops the time rather than catching up.
- **The display is a step behind.** It shows the blend of the last two states, so what is drawn lags the newest state by up to one step (22 ms at 45 a second). A pointer stroke appears that much after the pointer.
- **Gusts and lumps are sized by the shorter side**, and the flames are never taller than 0.8 of the canvas width. Without that, a phone held upright got a few enormous gusts and a column of fire filling the screen.
- **Ridged fuel makes threads.** A perfectly sharp crest in the base feeds one column and rises as a thin bright thread; the crest is rounded off by a smooth absolute value.
- **The pointer captures touch drags** that start on the canvas, so a visitor cannot scroll the page by dragging on the fire. That is right for a demo to draw on; a full-page background should create the pointer source with `capture: false` (the shared option), which this effect does not expose.
- **Light page.** Over a light page the flames read as red and yellow ink with a shape, the pale core fading into the paper, as with `noise-flame`. Checked in headless composites at 1080p, in the footer band and on a phone-sized canvas.
- **The bottom edge is a cut.** The fuel row is the canvas's last row of cells; put the canvas flush with the bottom of its section.

## When to use it

A wall of fire along the bottom of a hero, a footer or a 404 page that visitors can play with: tap to light, drag to write in fire, scroll to feed it. It is the cheapest interactive fire on the site: a step over a few tens of thousands of cells and two fetches a pixel, Tier A as a target with the render backend. The `classic doom` preset is the retro look for pixel-art pages. It also makes a small reusable solver (`src/gpu/sim/doom.ts`) for anything that wants heat climbing a grid.

Reach for something else when the fire has to be a shape (a candle, a torch, a ring: Epic 4), when it has to flow around obstacles or be pushed by the pointer (the grid fluids of Epic 6), or when nobody will touch it: `noise-flame` draws a similar wall with no state at all, and a looping video does the same job where WebGPU is not available.

## References

- Fabien Sanglard, [How DOOM fire was done](https://fabiensanglard.net/doom_fire_psx/), 2018: the rule, the 37-colour palette and the original code.
- Mark Jarzynski and Marc Olano, [Hash Functions for GPU Rendering](https://jcgt.org/published/0009/03/02/), JCGT 2020: the PCG hashes in `hash.wgsl` that make every random choice.
- Glenn Fiedler, [Fix Your Timestep!](https://gafferongames.com/post/fix_your_timestep/): stepping at a fixed rate and drawing a blend of the last two states.
- [docs/compositing-study.md](../../../docs/compositing-study.md): why the fire is written as emission with luminance alpha.
- WCAG 2.2, [Success Criterion 2.3.1](https://www.w3.org/TR/WCAG22/#three-flashes-or-below-threshold), for the speckle and the drive.
