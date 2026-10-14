## How it works

A map seen from above: forest that grows, burns and grows back for as long as the page is open. It is the forest-fire automaton of Drossel and Schwabl (1992), the classic model of self-organised criticality, made smooth enough to look at and given wind.

**The classic rule.** Each cell of a grid is empty, a tree, or burning. A burning cell becomes empty; a tree catches if a neighbour burns, or by itself with a small probability `f` (lightning); an empty cell grows a tree with probability `p`. Nobody tunes it to an interesting state: growth fills the map until it is connected enough to carry fire, lightning burns whatever cluster it lands in, and the map settles into a patchwork of young and old growth with fires of every size.

**The rule here** (`src/gpu/sim/forest-step.wgsl`, one render pass per step over a ping-pong pair of `rgba16float` textures). Each cell holds four numbers rather than three states: fuel (tree density, 0..1), how hard it burns, fresh scorch, and smoke. Per step:

- _Burning is a pulse, not a flip._ A burning cell eats `1.5 × fuel × burning` of its fuel; burning gains what was eaten and loses a quarter of itself. So intensity climbs for three or four steps while there is fuel, then decays geometrically and is set to exactly zero below 0.012: about fifteen steps in all, brighter where there was more fuel. Fuel under 0.17 cannot keep a fire going at all.
- _Catching._ Each burning neighbour is an independent chance, `spread × weight × its burning`, and a cell catches if a die (a hash of the cell, the step number and the seed) comes in under the chance that at least one succeeds, times how flammable its fuel is (nothing below 0.6, everything above 0.95). Thin regrowth is therefore a firebreak, which is what makes the patchwork.
- _Round fires from a square grid._ Edge neighbours weigh 1 and diagonal ones 0.42. Edge neighbours alone make a diamond, all eight equal make a square; at 0.42, measured rather than derived, a windless fire on even fuel is round to within 2 to 3% in every direction (16 wedges, averaged over six seeds), at spread 0.6, 1 and 1.5.
- _Wind._ With `along` the cosine between the wind and the direction fire would travel from a neighbour, the weight is multiplied by `exp(2.2 w (along³ - 0.4 (1 - along²)))` for wind `w` in 0..1: up to nine times more likely from straight upwind, nine times less from downwind, a little less across the wind so the flanks do not fan out. Above wind 0.2 embers also jump two cells, in a narrow cone straight downwind (`along¹⁶`): spotting, which is what lets a strong wind cross a narrow break.
- _Growth._ A cell that is not burning gains a tenth of full fuel with chance `10 p` per step, up to what its soil can carry, so neighbours differ and a regrowing patch is mottled rather than flat. Scorch fades at `1.5 p` a step, and nothing grows while it is above 0.3.
- _Smoke_ is carried downwind by a backward lookup (four bilinear taps half a cell apart, which also spreads it), wobbled by a slowly drifting noise field so plumes meander, fed by burning cells and thinned by 3.5% a step.
- _Land_ (`forest-land.wgsl`) is not state: lakes and thin soil come from one fetch of the shared noise tile, so the step and the display agree on them without a texture.

Lightning is `createAmbientIgnition` at `f` strikes a second, each a disc 1.6 cells across; taps and drags are `createPointerIgnition`. Both only catch where there is fuel above 0.6. `drive` (scroll or audio, through `createExcitation`) adds up to its own calm value to the lightning rate and 35% to the wind, never to the clock. `growth` is per second, so `rate` (steps a second) changes how fast fire moves and nothing else.

**Drawing it** (`landscape.wgsl`). A pass at grid size (`between.wgsl`) blends the last two steps by how far the frame is past the newer one, so nothing changes at the step rate. The full-size pass reads that as a quadratic B-spline (four bilinear taps half a cell apart, smooth in value and slope, so a front one cell wide is a line and not a string of diamonds), nudged up to 0.6 of a cell by the noise grain so no edge runs along the grid. Ground runs from bare earth through grass to dark forest with fuel, scorch is black fading through ash grey, and burning goes through `ramp_fire` (or `ramp_blackbody` for the `embers` palette) with a peak of 16 in the cores. The landscape itself stays under about 0.1 of paper white; only fire and the smoke it lights go above. `pixelated` shows the cells as they are.

**What the two rates do.** In the classic model the mean fire size is about `p / f` trees per strike: grow faster or strike less often and fuel piles up between fires, so each one is larger. Here, over 300 to 400 seconds on a 320 × 180 grid (`FOREST_STUDY=regime npx vitest run tests/epic5-d.test.ts`):

| growth `p` /s                   | lightning `f` /s | mean fire, cells | largest fire, share of map | burnt per minute | no fire on the map |
| ------------------------------- | ---------------- | ---------------- | -------------------------- | ---------------- | ------------------ |
| 0.005                           | 0.8              | 470              | 0.20                       | 0.22             | never              |
| 0.015                           | 3                | 440              | 0.47                       | 0.64             | never              |
| 0.015                           | 0.8              | 710              | 0.92                       | 0.29             | never              |
| 0.015                           | 0.2              | 4500             | 2.2                        | 0.82             | 3% of the time     |
| 0.01 (`living forest`)          | 1                | 620              | 0.39                       | 0.63             | never              |
| 0.004 (`quiet valley`)          | 0.12             | 1780             | 0.27                       | 0.24             | 34%                |
| 0.008 (`windy day`)             | 0.25             | 1990             | 0.53                       | 0.45             | 15%                |
| 0.006 (`all sizes`, 30 steps/s) | 1.6              | 250              | 0.20                       | 0.43             | 3%                 |

The first two rows have nearly the same `p / f` and nearly the same mean fire, as the classic model says. In `living forest` fire sizes spread over four decades, from single cells to about 22 000 (a log₂ histogram of 74, 45, 35, 25, 19, 10, 6, 8, 7, 6, 8, 6, 4, 3, 3), and something is always burning. A "largest fire" above 1 is a fire that never went out: when regrowth is fast compared with the time a front takes to cross the map, the front comes back round to land that has regrown and the model turns into an excitable medium, fronts circling for minutes like the spirals of a Belousov–Zhabotinsky reaction. Drossel and Schwabl assume the opposite: fires infinitely fast next to growth. Raising `rate` restores that separation: `all sizes` runs at 30 steps a second with frequent lightning, and its 439 fires fall off steadily over four decades of size (95, 62, 50, 42, 38, 25, 35, 12, 26, 20, 21, 10, 1, 2), the nearest thing here to the model's power law. The table's runs are each one realisation, so treat the larger numbers as rough.

**How wind shapes a front.** From one tap on even fuel, 60 steps (cells reached: downwind, upwind, each flank; the ratio is length over width):

| wind | downwind | upwind | flanks | length / width |
| ---- | -------- | ------ | ------ | -------------- |
| 0    | 29       | 31     | 29, 30 | 1.0            |
| 0.25 | 45       | 26     | 28, 28 | 1.25           |
| 0.5  | 71       | 22     | 30, 30 | 1.55           |
| 0.75 | 85       | 18     | 33, 31 | 1.64           |
| 1    | 100      | 16     | 34, 32 | 1.75           |

The head runs at up to 1.7 cells a step (the two-cell jump caps it near 2), the back slows to half of its windless speed, and the flanks stay close to the windless speed, so the burnt area is an egg-shaped ellipse with the ignition near its upwind end, as wildfire perimeters are. Real fires reach length-to-breadth ratios of 3 to 6 in strong wind; this one stops near 1.8 because the grid reaches only two cells.

## Cost

GPU time, measured on a quiet GPU (Apple M1 Max, 1920 × 1080, default settings, simulation and tail included): 1.1 ms per frame on Dawn, where the tail alone reads 0.7 ms and repeated runs differ by about half a millisecond, so the simulation cannot be told apart from the tail; and 1.51 ms for one frame in Chrome 155 at 60 fps (median of 3 loads, 1.12 to 1.52), which includes the browser's timing floor. Both are inside the Tier A budget on this machine. The budget is set for an integrated GPU, and no integrated GPU or phone has been measured, so the tier is provisional. How the cost moves with grid size is in `docs/studies/epic-5.md` (story 5.9): within the sizes a page would use, it does not measurably move.

What can be counted, at the defaults on a 1920 × 1080 canvas (a 320 × 180 grid, 15 steps a second): per step, per cell, at most 9 state reads (25 when the wind is strong enough to spot), one noise fetch for the land, one for the smoke wobble and four bilinear smoke taps, over 57 600 cells, about once every four frames. Per frame, a grid-size pass of two reads per cell, then per pixel four bilinear reads of that small texture and two of the noise tile, no procedural noise, no loop, one `pow` and the fire ramp. The grid does not grow with the canvas, so the full-size pass is the only part that scales with resolution.

Readings in headless Chrome on an Apple M1 Max at 1920 × 1080 with other agents using the GPU (indicative): one frame read 1.28, 1.39 and 1.51 ms over three loads in one run and 1.13, 1.31 and 1.33 ms in another, of which the step pass read 0.16 ms, the grid-size blend 0.10 ms and the landscape 0.41 ms; the HDR tail alone reads about 1.0 to 1.3 ms there. Before the blend moved to its own grid-size pass (the landscape then read both state textures, eight taps), the same check read 1.90 to 2.05 ms.

Texture memory at the defaults: the state pair (two 320 × 180 `rgba16float`, 0.9 MB) and the blended copy (0.46 MB), on top of the tail's targets and the shared noise tile.

## Pitfalls

- **A cell that flips flashes.** The classic three-state rule turns a cell from tree to fire to ash in two steps: at 15 steps a second that is a flicker at the step rate. Burning here rises over three or four steps and dies over ten, the display blends between steps, and the B-spline spreads a cell over a few pixels. The flash analyser reads `low` (at most two flashes per screen cell per second, no area over the threshold) at the defaults, for every preset, after 90 seconds of organising, with `pixelated` on, and with everything at its fastest (40 steps a second, spread 2, wind 1, lightning 4).
- **Several steps per frame need several uniform buffers.** A uniform write lands before the submit, so steps encoded together would all see the last step's number and roll the same dice. `forest.ts` keeps four (`FOREST_STEPS_PER_SUBMIT`) and the stepper never asks for more.
- **Repeatable on one device, not across devices.** Randomness is a hash of cell, step and seed, but each die is compared with a probability computed in floating point; a last-digit difference between drivers can flip one comparison, and the run diverges from there. The tests compare shapes and totals, never two devices cell by cell.
- **Fronts and grid scale.** Fire moves in cells per step, so a finer `resolution` makes fronts slower across the screen and a higher `rate` makes them faster. On a canvas too small to show two pixels per cell the grid is reduced; a resize across that size restarts the map (`generation` bumps).
- **Fast regrowth turns it into something else.** See the table above: with `growth` near 0.04 a second fronts circle forever. That is a fine effect, but it is not the forest-fire model any more.
- **Rough fronts in young growth.** When lightning is frequent the forest burns as soon as it can carry fire at all, so fires creep through marginal fuel as broken chains of embers rather than lines. Rarer lightning (`windy day`) lets fuel build until fronts are continuous and bright.
- **The start is staged.** The first state is a mosaic of patches of different ages with three fires already going, so a poster or a reduced-motion still has fire in it. It takes about a minute for the system's own patchwork to replace it.
- `layout` is a reserved word in WGSL, so the seed uniform's field is called `start`.

## When to use it

A background that is alive on a long timescale: a hero or a section that rewards being left open for a minute, where the visitor can start a fire with a tap and watch the wind take it. It is also the clearest way to show self-organised criticality or wildfire spread with something that runs. It is an opaque dark map, so on a light page it sits in its own box like an image.

Tier A, provisional: the simulation is a few thousand cells and costs almost nothing, and the picture is six fetches a pixel; it has not been measured on an integrated GPU.

Rule-based spread is the right tool when the interesting thing is the _pattern of fires over time_: which places burn, how big fires get, what the wind does to their shape, how regrowth and firebreaks shape the next fire. It is cheap, stable at any step, needs no clamp to a stability condition, and its parameters are probabilities with a direct meaning. It is the wrong tool for the look of a single front up close: a continuous reaction–diffusion model (`combustion-front`) gives a smooth front of a definite width and speed set by diffusion and reaction rates, where this one's fronts are as ragged as its dice and its speed is quantised to the grid. For flames, use a fluid (Epic 6).

## References

- B. Drossel and F. Schwabl, "Self-organized critical forest-fire model", _Physical Review Letters_ 69, 1629 (1992): the rule and the `p / f` fire size.
- P. Bak, K. Chen and C. Tang, "A forest-fire model and some thoughts on turbulence", _Physics Letters A_ 147, 297 (1990): the deterministic predecessor, whose fronts circle as spirals.
- J. M. Greenberg and S. P. Hastings, "Spatial patterns for discrete models of diffusion in excitable media", _SIAM Journal on Applied Mathematics_ 34, 515 (1978): the excitable-medium automaton the model turns into when regrowth is fast.
- H. E. Anderson, "Predicting wind-driven wild land fire size and shape", USDA Forest Service Research Paper INT-305 (1983): elliptical fire perimeters and their length-to-breadth ratios.
- M. Jarzynski and M. Olano, ["Hash Functions for GPU Rendering"](https://jcgt.org/published/0009/03/02/), _JCGT_ 9(3), 2020: the `pcg_3d` hash behind every die (`hash.wgsl`).
- W3C, [Understanding SC 2.3.1: Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html).
