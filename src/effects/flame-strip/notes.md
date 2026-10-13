## How it works

A band of fire for section breaks and footers: one fullscreen pass (`strip.wgsl`) that draws flames along the bottom edge of the canvas and leaves everything above them untouched and see-through. It is the recipe of `noise-flame` (a height gradient, minus rising noise that bites harder with height, through `ramp_fire`) with two additions.

**A silhouette.** The height the fire reaches is not one level. A whole number of crests is spread across the canvas, each with its own hashed height that also breathes on a slow clock of its own (4.5 to 11 seconds a cycle). `strip_crest` joins neighbouring crests smoothly and dips between them by `gap`; `uneven` sets how much shorter a crest may be. The column the gradient is measured in leans sideways with the slow noise layer, more toward the top (`flame_tip_weight` from `flame.wgsl`), so crests sway. Below everything is a `bed` of fire whose top follows the noise, so the band never opens down to the edge.

**Exact tiling.** Everything repeats once per canvas width, at any width:

- the number of crests is a whole number (`density` crests per flame height, rounded);
- the noise is two fetches of the shared baked tile (`getNoiseTexture`), and each layer covers the width a whole number of times. The second, slower layer displaces the first and repeats one time fewer. Consecutive whole numbers share no factor, so the pair repeats only once across the canvas and no copy of a flame shows up inside the strip.

`stripLayout` in `index.ts` works these numbers out from the canvas shape. The last pixel column continues into the first: `tests/epic4-a.test.ts` measures the step across the seam at 2.4 (mean byte difference) against a median of 3.8 between neighbouring columns and 12.5 between unrelated ones.

**Size.** `height` is the strip's height as a share of the canvas height, for the wide, short canvas it is meant for (the "band" layout is 886 x 160). It is capped at 16% of the canvas width, so in a tall canvas (a hero, a phone in portrait) it stays a band along the bottom edge instead of growing into a wall. The shader returns before reading any noise for pixels above the strip.

The pass writes emission only (scene alpha 0), and the effect spreads `OVERLAY_PARAMS`: the page shows above and through the flames. Presets: `strip`, `ember line` (a low, dim, finely toothed line) and `fire wall` (full height, crests merged).

## Cost

GPU time, measured on a quiet GPU (Apple M1 Max, 1920 × 1080, default settings, tail included): 0.5 ms per frame on Dawn, where the tail alone reads 0.5 ms and repeated runs differ by about half a millisecond, so this effect cannot be told apart from the tail; and 1.08 ms for one frame in Chrome 155 at 60 fps (median of 3 loads, 0.98 to 1.18), which includes the browser's timing floor. Both are inside the Tier A budget of 2 ms on this machine. The budget is set for an integrated GPU, and no integrated GPU or phone has been measured, so the tier is provisional. Tables: `docs/studies/epic-4.md` and `docs/studies/browser-check.md`. What can be counted:

- Passes: one scene pass at canvas size, then the tail (bloom and output).
- Per pixel inside the strip: 2 texture fetches, 2 integer hashes (the two nearest crests), 3 `sin`, 1 `pow`, no procedural noise, a few dozen arithmetic operations including the ramp. Above the strip: one comparison.
- Texture memory: the `rgba16float` scene target and bloom chain at canvas size, plus the shared noise tile (0.7 MB, one per device). In the band layout the scene target is 886 x 160, about 1.1 MB.

Indicative readings, Apple M1 Max, taken while other work was using the GPU. In Chrome at 1920 x 1080 the HUD read 1.1 ms for one frame, the same as the tail alone (1.1 to 1.3 ms); in a canvas that tall the strip covers only the bottom 28%. On the Dawn harness: 1.0 and 1.1 ms per frame at 1080p, against 0.5 to 1.0 ms for the `bloom-tuning` scene, which computes no noise, in the same runs, and 0.2 ms at 886 x 160, the size it is meant for. Nothing has been measured on an integrated GPU or a phone.

## Pitfalls

- **Bloom does not tile.** The scene is periodic; the tail's bloom clamps at the canvas edge. One canvas across the full width of a page has no seam. Two canvases placed side by side would join exactly in the flames and may show a slightly weaker glow at the join. Not measured.
- **A resize re-lays the strip.** The crest count and the noise tile counts are rounded from the canvas shape, so they change in steps as the canvas is resized, and the picture jumps when they do. A canvas narrower than three flame heights gets one tile across, and its noise is then as fine as one tile makes it: finer than intended in a very narrow canvas, because the tile count cannot go below one.
- **The cap hides the height control.** In a canvas taller than about a fifth of its width, `height` above the cap does nothing. That is deliberate, but it is surprising on the bare effect page, where the canvas is 16:9 and the strip is the bottom 28%.
- **Flames come from below the canvas.** The bottom edge is a cut through the fire. Put the canvas flush against the element below it (the footer, the next section).
- **Flash.** At the defaults and for each preset, no part of the picture went over three flashes a second in the flash analyser at 480 x 270 standing for 1080p; the same held for the defaults and `fire wall` at 886 x 160 shown at one pixel per CSS pixel, and at the top of the speed slider (1.5). The slider stops there for the reason given in the `noise-flame` notes: the red rim of faster flames does go over.
- **Light page.** Reads as flame-coloured ink over a light page (checked in headless Chrome in the light band layout): the red rim and the orange body carry it, the pale core fades into the paper. With `ember line` the flames are under 30 px tall at band size and mostly rim.
- The picture is the same on every load: crest heights are hashed from their index, not from a seed.
- Under reduced motion the shell holds one frame; any frame is a complete strip.

## When to use it

A section break, the top edge of a footer, the bottom edge of a hero or a card: anywhere a short, wide band of fire should sit on the page, in a canvas a few flame heights tall at most. Tier A, provisionally: it reads at the tail's own cost on the M1 Max and no integrated GPU has been measured. At band size it is a fifteenth of the pixels of a 1080p canvas.

For a tall wall of fire use `noise-flame`, which is the same fire without the tiling and the cap. If the band never changes size and nothing about it is interactive, one period captured as a horizontally repeating animated image does the same job with no GPU at all; the shader earns its place when the width is fluid, the page colour varies, or the height and mood are driven by the page.

## References

- The `noise-flame` notes in this site: the recipe, and the comparison of noise sources that led to the baked tile.
- Inigo Quilez, [Domain warping](https://iquilezles.org/articles/warp/): the displaced lookup.
- Ken Perlin, [An Image Synthesizer](https://dl.acm.org/doi/10.1145/325165.325247), SIGGRAPH 1985: turbulence and the first noise fire.
- [docs/compositing-study.md](../../../docs/compositing-study.md): luminance alpha and what reads over a light page.
- WCAG 2.2, [Success Criterion 2.3.1](https://www.w3.org/TR/WCAG22/#three-flashes-or-below-threshold).
