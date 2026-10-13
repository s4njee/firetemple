## How it works

Story 4.8 asks what many small flames cost. This effect draws up to 48 of them in **one canvas**, as a grid, each on a torch handle, in a brazier bowl or bare, so the answer can be read off one pass.

One fullscreen pass (`torches.wgsl`), then the HDR tail. The idea that makes it cheap: **every pixel belongs to at most one flame, and finds it with a `floor`.** Nothing loops over the flames.

1. `torchLayout` (in `index.ts`) picks the grid that draws the items largest for the canvas's aspect. The shader divides the canvas into those cells; a short last row is centred.
2. The pixel reads its flame's four numbers from a uniform array of 48 `vec4f`: flicker level, place in the loop, size, lean. They are computed on the CPU once per frame from a seeded generator, so each flame has its own character and a seed always gives the same set. `variety` 0 makes them all the same flame.
3. Inside the flame's reach it fetches the shared noise tile twice. The first fetch is a slice through the tile that time moves along, read lower for higher points, so a bend starts at the base and travels up; it gives the sway. The second is read where the swayed flame is and rises faster; it erodes the edge into tongues. Both go into `flame_heat_teardrop` (torch, bare) or `flame_heat_taper` (brazier) and then a ramp from `ramp.wgsl` (`fuel`).
4. The holder is a handful of distance functions with coverage 1, lit from the flame above: a tapered handle and a wrapped head, or an iron bowl of coals on three legs.

**The loop closes exactly.** Time enters only as a phase in 0..1. Each noise layer travels a whole number of tiles per loop (the tile repeats every 8 cells), and the flicker and lean are sines with a whole number of cycles per loop, so the frame at `t + loop` is the frame at `t`. `tests/epic4-b.test.ts` checks it: after one loop the mean difference is under 0.25 of an 8-bit step, which is the dither. One loop can therefore be baked into a sprite sheet for the fallback.

Small flames must not read the tile's finest level: the level of detail is set on the CPU from the flame's height in pixels.

## Cost

GPU time: not measured yet. The count question was answered by counting, and checked against rough readings.

**By count.** A pixel costs the same whatever the count: the cell lookup (about 15 arithmetic operations and one uniform-array read), then `flame_reach`. Only pixels that pass it, and for the teardrop a distance test that trims a further third, fetch noise (two fetches, about 50 more operations and four `pow`). So the scene pass follows the **share of the canvas inside some flame**, and that share depends on how well the grid packs the canvas, not on the count. For a 1920 × 1080 canvas at the default `size` and `turbulence` (`flameShare` in `index.ts`; the share is counted on a grid, every flame at full size):

| Flames | Grid   | Flame height | Fetched share, torch | Fetches per frame | Brazier | Bare  |
| ------ | ------ | ------------ | -------------------- | ----------------- | ------- | ----- |
| 1      | 1 × 1  | 631 px       | 7.8%                 | 0.33 M            | 16.8%   | 18.8% |
| 2      | 2 × 1  | 631 px       | 15.7%                | 0.65 M            | 33.7%   | 37.6% |
| 4      | 4 × 1  | 452 px       | 16.1%                | 0.67 M            | 34.6%   | 38.7% |
| 12     | 6 × 2  | 302 px       | 21.5%                | 0.89 M            | 46.2%   | 51.6% |
| 24     | 8 × 3  | 210 px       | 20.9%                | 0.87 M            | 44.9%   | 50.2% |
| 48     | 12 × 4 | 151 px       | 21.5%                | 0.89 M            | 46.2%   | 51.6% |

Forty-eight flames fetch exactly what twelve do. One flame alone fetches least, only because a single item leaves most of a wide canvas empty. The brazier is boxed only (its taper has no distance test) and the bare flame fills its cell, so those two fetch about twice as much as the torch.

**By reading.** Indicative HUD figures for the whole frame, headless Chrome on the Apple M1 Max at 1920 × 1080, three runs each, while other work was using the GPU:

| Flames      | GPU, whole frame (ms) |
| ----------- | --------------------- |
| 1           | 1.20, 0.97, 1.29      |
| 4           | 1.35, 1.51, 1.15      |
| 12          | 1.08, 1.40, 1.11      |
| 24          | 1.00, 1.11, 1.23      |
| 48          | 1.26, 1.14, 1.31      |
| 48, bare    | 1.33, 1.23, 1.12      |
| 12, brazier | 1.26, 1.28, 1.26      |

There is no trend with count: the spread between runs (about 0.4 ms) is larger than any difference between rows. Later readings of the default were 1.09, 1.60, 1.22, 1.23, 1.31 and 1.28 ms, and one of 2.40 ms in which every pass, the tail's included, read three times its usual figure: something else had the GPU. The tail alone reads 1.1 to 1.3 ms on this machine, so the flames' own pass is below what it can resolve. No integrated GPU or phone has been measured; Tier A is provisional, and on a slow GPU the brazier and bare styles are the ones to watch.

**Not measured: many canvases.** The alternative, one small canvas per flame, was not built or timed. Each canvas would run its own tail (a bloom chain and an output pass) and its own context, and the 1 ms floor seen here is per canvas, so it is expected to cost far more than one shared canvas; that is an expectation, not a measurement.

Other counts: one scene pass plus the tail; no procedural noise; CPU per frame is three sines per flame; texture memory at 1080p about 21.8 MB in 8 textures as the HUD reports it, nearly all of it the tail. Bundle size: not measured yet.

## Pitfalls

- **Red licks flash.** With the plain fire ramp, the licks at the tips are saturated red and come and go several times a second. At the defaults that measured 4 red flashes a second over 12 300 px² (the WCAG limit is 3, over 21 824 px²). Two changes brought it down: green is held at 0.3 of red, at most 0.2, so licks are orange (displayed red share about 0.77, under the 0.8 that counts as saturated), and the tongue layer rises at no more than 3 noise cells a second. The other fuels are not corrected: `lithium` is red on purpose and was not measured.
- **Big flames flicker more than small ones.** The flash analyser works per screen area, so one large flame is a harder case than 48 small ones. Measured over 8 s at 480 × 270 standing for 1080p: every preset is `low`, at most 2 or 3 flashes a second in a cell and no area over the limit. Faster tongues on large flames do go over in places: four braziers at `speed` 1.5 had 12 300 px² above three red flashes a second, still under the 21 824 px² threshold. That is why `loop` starts at 3 s and `speed` stops at 1.5; the combination was not measured beyond those ranges.
- The grid is the only layout. Real list markers sit where the list items are; that needs each flame placed at a DOM rectangle (`src/gpu/dom-rects.ts`), which this effect does not do.
- The loop is only as exact as the frame timing: it closes in phase, and a display that drops frames shows a different set of phases each time round. Bake from the headless renderer, not a screen capture.
- At icon size (flames about 40 pixels tall in the cards layout) a flame is a bright drop with one tongue, and the bloom carries much of the look. Lower `bloom` when the flames are tiny, as `list markers` does. Smaller than that was not looked at.
- Flames do not light each other or the page between them. Each holder is lit by its own flame only.
- The brazier's coals stay orange under a blue `fuel`.

## When to use it

When a page wants many small fires at once: bullets, status icons, a row of wall torches, a border. Tier A (provisional). Use one canvas over the whole group; the cost is then the tail plus a pass that does not grow with the number of flames.

For a single flame that should respond to the pointer, use `candle`. For a flame larger than about a third of the screen, use the scrolling-noise flame or the fireplace: this one has two layers of noise and looks soft when it is big. Where WebGPU is missing, a sprite sheet of one loop is a faithful replacement, which is the point of making the loop exact.

## References

- Inigo Quilez, [2D distance functions](https://iquilezles.org/articles/distfunctions2d/): the shapes behind `flame_sd_teardrop`, `flame_sd_taper` and the holders.
- Inigo Quilez, [Domain repetition](https://iquilezles.org/articles/sdfrepetition/): one evaluation per cell instead of a loop over instances.
- `src/wgsl/noisetex.wgsl` and `src/gpu/emission/noise-texture.ts`: the tileable noise that makes a closed loop possible.
- W3C, [WCAG 2.2, 2.3.1 Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html): the general and the red flash thresholds.
