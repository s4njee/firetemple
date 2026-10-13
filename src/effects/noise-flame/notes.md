## How it works

The oldest fire shader there is, and still the one most sites should start from. One fullscreen pass (`scene.wgsl`) does three things per pixel:

1. **A height gradient.** `t` runs from 0 on the bottom edge of the canvas to 1 at the `height` parameter. The gradient is `1 - t`.
2. **Noise scrolled upward.** A noise value `n` in 0..1 is read at the pixel's position minus a climb that grows with time. The noise is subtracted from the gradient, and it bites harder the higher up it is: `depth = (1 - t) - (1 - n) * (0.16 + ragged * t)`. Low down almost nothing is removed, so the foot of the wall is solid. Near the top the noise decides everything, which is what breaks the edge into tongues and pinches off licks.
3. **A ramp.** `depth` becomes heat with a steep rise at the surface (`1 - (1 - depth)^3`, so the red rim is thin) that levels off at a body heat of `0.46 + 0.36 * n`, and heat goes through `ramp_fire` from `ramp.wgsl`. The body sits in the orange-to-yellow part of the ramp and only the middles of tongues reach the pale core.

Because the noise only ever removes heat, no flame can exist above `t = 1`. The shader returns there before reading any noise, so the part of the canvas above the flames costs one comparison per pixel.

The pass writes emission only (scene alpha 0). The effect spreads `OVERLAY_PARAMS`, so the tail writes a see-through canvas and the page shows above and through the flames.

### The noise sources (story 4.1)

The `noise` parameter swaps where `n` comes from. All five build the same flame: a pattern displaced by a second, slower layer (rising at 0.6 of the speed), which is what makes tongues lean and shear instead of sliding up as one sheet.

- **texture** (the default): `noisetex_flame` from `noisetex.wgsl`, two bilinear fetches of the shared baked tile (`getNoiseTexture`). The tile holds four-octave gradient noise, so this is the "gradient fbm" source with the arithmetic done once at start-up.
- **value**, **simplex**, **voronoi**, **gradient fbm**: computed at every flame pixel by `nf_flame` in `sources.wgsl`. Three fractal sums (one for the pattern, two for the displacement), each `octaves` evaluations, so 12 noise evaluations per pixel at the default four octaves. With `domain warp` off it is one fractal sum, 4 evaluations: the plain classic.

Each procedural source is scaled to the spread of the texture's noise (standard deviation 0.214 at four octaves; `tests/epic4-a.test.ts` checks it within 7%), so switching source changes the character of the flame, not how much of it there is.

| Source                   | Per flame pixel               | Look                                                                                                     | Chrome, one frame at 1080p | Dawn, 8.3 Mpx of flame |
| ------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------- |
| texture                  | 2 fetches                     | Leaning tongues, detached licks, medium detail. Goes soft when one noise cell is wider than about 300 px | 0.9 to 1.2 ms              | 0.9 to 1.3 ms          |
| gradient fbm             | 12 evaluations, 4 hashes each | The same character as the texture, a little smoother and sharper at any size                             | 2.4 ms                     | 5.2 ms                 |
| value                    | 12 evaluations, 4 hashes each | Softest: round blobs, few tongues, large flat hot patches                                                | 4.2 ms                     | 4.5 ms                 |
| simplex                  | 12 evaluations, 3 hashes each | Finest and busiest: thin wisps and many detached specks                                                  | 2.9 ms                     | 5.2 ms                 |
| voronoi                  | 12 evaluations, 9 hashes each | Cellular: pointed crests with creases between them, the least like fire                                  | 3.9 ms                     | 9.9 ms                 |
| any procedural, warp off | 4 evaluations                 | Flatter: rolling hills with a ragged edge where the warp makes tongues                                   | 1.8 to 4.0 ms              | 2.2 to 4.1 ms          |

Both timing columns are indicative single runs on an Apple M1 Max while other work was using the GPU. The Chrome column is the HUD's whole-frame reading with the default settings (the flames cover about 62% of the canvas), tail included; the tail alone reads 1.1 to 1.3 ms there, so the texture source is at the floor. The Dawn column is the marginal cost per frame at 3840 x 2160 with `height` 1.4, so that all 8.3 million pixels are flame; the `bloom-tuning` scene, which computes no noise, reads 1.2 to 1.3 ms at that size in the same run.

**Which one a site should use: the texture.** It is the best-looking of the five here and the only one whose cost could not be told apart from the tail's. Every procedural source read over the 2 ms Tier A budget in Chrome on this GPU, which is several times faster than the integrated GPUs the budget is set for. Reach for procedural gradient noise only when the flames are so large that the baked tile turns soft, and then turn the warp off or lower `octaves` first. Simplex is the pick if you want a wispier, drier flame and can pay for it. Value noise and Voronoi are not worth their cost for fire.

## Cost

GPU time, measured on a quiet GPU (Apple M1 Max, 1920 × 1080, default settings, tail included): 0.5 ms per frame on Dawn, where the tail alone reads 0.5 ms and repeated runs differ by about half a millisecond, so this effect cannot be told apart from the tail; and 1.01 ms for one frame in Chrome 155 at 60 fps (median of 3 loads, 0.99 to 1.09), which includes the browser's timing floor. Both are inside the Tier A budget of 2 ms on this machine. The budget is set for an integrated GPU, and no integrated GPU or phone has been measured, so the tier is provisional. Tables: `docs/studies/epic-4.md` and `docs/studies/browser-check.md`. What can be counted:

- Passes: one scene pass at canvas size, then the tail (bloom and output).
- Per pixel below the flames' reach, with the default source: 2 texture fetches, no procedural noise, no `pow`, about 30 arithmetic operations including the ramp. Above the reach: one comparison.
- With a procedural source: 3 x `octaves` noise evaluations (12 by default), or `octaves` with the warp off.
- Texture memory: the `rgba16float` scene target and the bloom chain (the HUD reports about 21.8 MB at 1080p), plus the shared noise tile (0.7 MB, one per device, shared with every other effect).

Indicative readings, Apple M1 Max, 1920 x 1080, default settings, taken while other work was using the GPU: Chrome's HUD read 0.9 to 1.2 ms for one frame (the tail alone reads 1.1 to 1.3 ms, so the scene pass is below what the HUD can resolve), and the Dawn harness read 0.8 ms per frame against 0.5 to 1.0 ms for the `bloom-tuning` scene, which computes no noise, in the same runs. Neither says anything about an integrated GPU or a phone.

Cost scales with the canvas area below `height`. The `inferno` preset fills the canvas, `low burn` a third of it.

## Pitfalls

- **Speed is the flash risk.** The thin saturated-red rim is what the WCAG red-flash test picks up. At the default speed no part of the picture goes over three flashes a second (flash analyser, 480 x 270 standing for 1080p, 8 seconds). At speed 1.7 it measured `high`: 24 700 px² of red flashing against the 21 824 px² limit. The slider stops at 1.5, where the default flame measured 12 300 px². Taller flames have less room: with `height` 1.15 and `scale` 2.6, speed 1.5 measured `high` (67 900 px²) and speed 0.7 measured nothing over the limit, which is why `inferno` runs at 0.7. Do not ship a wall of this fire faster than the defaults without measuring it.
- **A canvas full of fire moves the whole frame.** With `inferno` the mean luminance of the frame ranged over 0.11 of full white in 8 seconds (0.04 at the defaults). It never completed a whole-frame flash, but it is not a calm background.
- **The baked tile is 256 texels for 8 cells.** One noise cell is 32 texels wide, so tongues wider than about 300 px are magnified texture and look soft (`inferno` at 1080p is at that edge). The tile also repeats every 8 cells; the second layer is at a different scale, so the repeat does not show as a copy, but a very wide wall of very fine flames will show a rhythm.
- **The climb wraps.** It is kept below 4000 cells so the shader never sees a large number. That is a whole number of periods for the texture source, which wraps without a seam. The procedural sources are not periodic and jump once at the wrap, about once an hour at the default speed.
- **The bottom edge is a cut.** The flames come from below the canvas. Put the canvas flush with the bottom of its section, or cover the edge.
- **Light page.** Over a light page the flame reads as flame-coloured ink: the red rim and orange body carry it, and the pale core fades into the paper. Checked in headless Chrome over the light hero and band layouts and in headless composites; it holds up, but it is a picture of fire there, not light.
- **Procedural sources at other octave counts.** The gains that match the sources to each other are for four octaves. Fewer octaves have a wider spread, so the flames get a little taller and more ragged.
- Under reduced motion the shell holds one frame; any frame is a complete flame.

## When to use it

A wall of fire along the bottom of a hero, a full-bleed section or a dark landing page, sitting on the page with content above it. Tier A with the default texture source, provisionally: it reads at the tail's own cost on the M1 Max, and no integrated GPU has been measured.

It is also the recipe to copy for any other 2D flame: gradient, minus rising noise that grows with height, through a ramp.

Reach for something else when the fire has to have a shape of its own (a candle, a torch, a ring: start from `flame.wgsl`), when it has to respond to the page (the cellular and fluid effects of Epics 5 and 6), or when a short, exactly tiling band is wanted (`flame-strip`). A looping video would do this job at any size the flames are not interactive; the shader's advantages are resolution independence, a see-through canvas over any page colour, and 40.2 kB of gzipped code and shaders instead of a video file.

## References

- Ken Perlin, [An Image Synthesizer](https://dl.acm.org/doi/10.1145/325165.325247), SIGGRAPH 1985: turbulence as a sum of noise octaves, and fire as its first example.
- Ken Perlin, [Improving Noise](https://mrl.cs.nyu.edu/~perlin/paper445.pdf), SIGGRAPH 2002: the gradient noise in `noise.wgsl`.
- Stefan Gustavson, [Simplex noise demystified](https://weber.itn.liu.se/~stegu/simplexnoise/simplexnoise.pdf), 2005.
- Steven Worley, [A Cellular Texture Basis Function](https://dl.acm.org/doi/10.1145/237170.237267), SIGGRAPH 1996: Voronoi noise.
- Inigo Quilez, [Domain warping](https://iquilezles.org/articles/warp/): the displaced lookup that turns hills into tongues.
- [docs/compositing-study.md](../../../docs/compositing-study.md): why the flame is written as emission with luminance alpha.
- WCAG 2.2, [Success Criterion 2.3.1](https://www.w3.org/TR/WCAG22/#three-flashes-or-below-threshold), for the speed limit.
