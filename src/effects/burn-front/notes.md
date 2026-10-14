## How it works

Burning paper. A sheet with real coverage sits over the page; a tap, a drag or a stray ember lights it; a thin glowing line crosses it, the paper browns and blackens behind the line, the char crumbles away and the page shows through the hole. When everything has burnt the sheet waits `regrow` seconds, fades back in, and the next ember lights it again, so it loops for ever with nobody there.

The fire is a shared solver, `src/gpu/sim/burn.ts`, which `dom-fuel` uses too. Its state is one `rgba16float` texel per cell (`resolution` cells on the shorter side of the canvas, never finer than two pixels a cell), stepped by one fullscreen render pass per fixed step of 1/60 s:

- **fuel** (r): 1 untouched, 0 burnt through. A lit cell loses it at `1 / burnTime` a second, times a burn-rate noise.
- **heat** (g): eases towards `4 fuel (1 - fuel)` while the cell burns, so it peaks where the cell is half burnt, which is the line between paper and char; then cools.
- **char** (b): gains exactly what the fuel lost, then falls away linearly over `crumble` seconds once the fuel is gone (unevenly, by a third noise field). `leave ash` stops it falling.
- **clock** (a): for an unlit cell, the seconds until the front arrives; for a lit one, minus its age; for a burnt-out one, a code holding when it burnt out.

**The front is not diffused heat.** Each step, every unlit cell works out when the fire will reach it from the clocks of its eight neighbours and the time to cross one cell (`cell / speed`), by solving the eikonal equation `|grad T| = 1 / speed` with the upwind update of the fast marching method. It does this on the axis neighbours and again on the diagonal ones (the multistencil variant of Hassouna and Farag) and takes the earlier answer. That is Huygens' principle on a grid: the front moves at the speed it is given in every direction alike, and a speed field bends it the way uneven paper does. A cell lights when its clock reaches zero. Clocks are recomputed from the neighbours every step, never from the cell's own old value, so changing the speed takes effect at once. A lit cell can light its neighbours for a short window (long enough for the slowest crossing allowed), after which it is ash and lights nothing.

**Irregular, without grid axes.** On even fuel the front from a point is round to within 2 percent along the axes, the diagonals and the knight's-move direction (`tests/epic5-b.test.ts`). The irregularity is a fixed noise field baked into a second texture, the fuel map, from two layers of the shared noise tile at unrelated scales: it multiplies the local speed (by 0.3 to 2.2, `irregular` sets how much) and the burn time. The front bulges through fast patches and pinches where two lobes meet, as a real burn does. `climb` makes it faster upwards and as much slower downwards (the `from below` preset), for a sheet that hangs.

**Display** (`scene.wgsl`): three fetches per pixel. The shared noise tile once, which pushes the state lookup by up to 1.6 cells so the edge has detail finer than the grid and grains the paper; the state, bilinear, so the line moves smoothly between cells; and the fuel map, whose signed distance draws the sheet's own edge (with a `margin`) sharp at any resolution. Paper is the `paper` colour with fibre and an optional printed or ruled pattern. What is left (fuel plus char) leaves along a noisy threshold, which tears the edge. The glow is `ramp_fire(heat^2)`: squaring keeps it a line with an orange core and a red fringe instead of a white band. Scene alpha is the coverage of paper and char, so on a light page the sheet, the scorch and the hole all read; the output pass's default `luminance` mode keeps that coverage and adds the light.

**Regrowth of the whole sheet** needs to know that nothing is left. A pyramid of small passes takes the maximum of a "live" flag over 4 x 4 blocks down to one texel, ten times a second, and that texel counts the seconds since nothing was live (whole seconds and the fraction in two channels: a half float cannot count sixtieths past 32). When the count reaches `regrow`, every cell fades back in over 1.5 s. Nothing is read back to the CPU.

**Inputs.** Taps and drags come from `createPointerIgnition`, stray embers from `createAmbientIgnition` (`embers` a second, landing where `origin` says), plus one opening spark 0.3 s after start so the first frames are never a blank sheet for long. `drive` (`scroll` or `audio`, through `createExcitation`) raises the ember rate by up to its calm level and the speed by up to half of it; it never touches the simulation clock.

## Cost

GPU time: not measured yet. Chrome's HUD in the browser check (Apple M1 Max, 1920 x 1080, default settings, while other agents were using the GPU, indicative only) read 0.68 to 1.43 ms for one frame, median 1.42 ms of three loads; the HDR tail alone reads about 1.0 to 1.3 ms there. Two earlier versions read more: 2.9 to 3.8 ms when the "anything left?" reduction was one 16 x 16 loop per thread (1.7 ms on its own), and 1.79 to 1.84 ms with the 4 x 4 pyramid run every frame instead of ten times a second.

What can be counted, at the defaults on a 1920 x 1080 canvas:

- Grid: 455 x 256 = 116 000 cells.
- Per step (usually one a frame at 60 Hz, two at 30 Hz): one pass over the grid, 10 texel loads per cell (state, map, the regrowth texel, eight neighbours' clocks) and the igniter loop (usually empty).
- Ten times a second: the reduction pyramid, 116 000 cells read twice into 29 000 texels, then 1 800, 120, 8 texels, then a one-texel pass.
- Per pixel: one fullscreen pass with 3 fetches (noise tile, state, map) and no procedural noise; then the tail.
- When the sheet or the grid changes (rarely): one pass draws the fuel map.
- Texture memory beyond the tail: state 2 x 0.93 MB, map 0.93 MB, the pyramid about 0.25 MB.

Cost grows with the canvas area (the display pass) and with `resolution` squared (the step), and does not depend on how much is burning.

## Pitfalls

- **Half floats count badly.** The state is `rgba16float`, the one format that is renderable, filterable and storable everywhere. Its values near 1 are 1/2048 apart, so a slow crumble or a long burn takes steps of a few of those: rounded to nearest, a smooth rate becomes a staircase, which drew contour rings in the char. Fuel and char are rounded at random in proportion (a per-cell hash), which is unbiased. Ages past 32 s cannot be counted in sixtieths at all, which is why a burnt-out cell stores _when_ it burnt out (a phase of a 128 s period, kept to an eighth of a second) and the whole-sheet regrowth timer keeps whole seconds and the fraction apart. An early version compared the stored phase with `fract` and treated a value rounded a hair past "now" as a whole period ago: cells regrew the moment they burnt out and the front stalled. Tests now cover regrowth past 32 s.
- **The front cannot outrun the grid.** A cell hears of the fire only from its neighbours, once a step, so the front is capped at 0.85 of a cell a step: 51 cells a second, 0.2 canvas heights a second at the default 256 cells. The `flash paper` preset sits at that limit; faster settings are quietly capped.
- **It is a front, not a field.** Two fronts meeting simply stop; there is no heat to add up, so a fire cannot grow by itself where nothing lit it, and a cell between two fronts lights from whichever is first. That is the model, and it is why the speed is exact; `reaction-diffusion` style behaviour (fronts that strengthen, flare, die out) is story 5.6.
- **Speed is in canvas heights per second.** It does not change with `resolution`, but a tall phone canvas takes as many seconds to cross vertically as a landscape one, and longer horizontally.
- **Flash.** The analyser (480 x 270 for 1080p, 24 s at the defaults) found no cell completing more than one flash in a second and no flashing area at all (`low`, from the line itself being a moving bright edge). A bright line sweeping a large area is the risk; keep `glow` and the speed near the presets. The regrowing sheet fades in over 1.5 s, which is one transition, not a flash. Over a whole burn the frame's mean luminance over a dark page moves by up to 0.65 of full white (the sheet going), slowly enough that it never completes a flash; it is still not a calm background while it burns. Every preset is swept by `tests/flash.test.ts` and none is over the threshold.
- **Light page.** The paper, its scorch and the char are real coverage and the hole shows the page, so the effect reads on a light page as well as a dark one (checked in headless renders and in Chrome over the light hero and band layouts). The line reads as orange ink there, not light. The default paper colour is a darker kraft so the sheet stays visible against a white page.
- Under reduced motion the shell holds one frame: a whole sheet, or a half-burnt one, both complete pictures.

## When to use it

A cover that burns away: over a hero image, a spoiler, a "next section" reveal, or as a route transition lit from where the visitor clicked. Tier A, provisionally: its Chrome reading is under 2 ms on the M1 Max, but only just, and no integrated GPU has been measured. Lower `resolution` to 160 to buy margin; the front stays smooth because the state is filtered and the edge is pushed by the noise tile.

For a one-off transition a video with alpha is simpler, but cannot start where the visitor clicked. For fire that spreads over the page's own elements use `dom-fuel`, which runs the same solver. For a burning edge without spread (a border, a fuse) a stateless shader is cheaper.

## References

- J. A. Sethian, [A fast marching level set method for monotonically advancing fronts](https://www.pnas.org/doi/10.1073/pnas.93.4.1591), PNAS 1996: the upwind update used for the arrival times.
- M. S. Hassouna and A. A. Farag, [Multistencils Fast Marching Methods](https://ieeexplore.ieee.org/document/4250465), IEEE TPAMI 2007: the diagonal stencil that takes out the grid bias.
- Huygens' principle as used in wildfire spread models, e.g. M. A. Finney, [FARSITE: Fire Area Simulator](https://www.fs.usda.gov/rm/pubs/rmrs_rp004.pdf), USDA 1998.
- Inigo Quilez, [2D distance functions](https://iquilezles.org/articles/distfunctions2d/): the rounded box of the fuel map.
- WCAG 2.2, [Success Criterion 2.3.1](https://www.w3.org/TR/WCAG22/#three-flashes-or-below-threshold).
