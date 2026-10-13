## How it works

One fullscreen pass (`candle.wgsl`) draws a candle for a see-through canvas, then the HDR tail blooms and encodes it. Four things are drawn, back to front:

1. **Halo.** A warm radial glow with no coverage, zero at its radius (1.6 flame heights) and faded out at the canvas edge so the rectangle never shows.
2. **Flame.** `flame_sd_teardrop` from `flame.wgsl`, with two changes made in the scene: the upper flame is drawn up to 2.1 times wider, because a candle's sides are convex and the teardrop's are straight, and the outline is rounded by 0.03 flame heights. Heat goes through `ramp_fire`. A dark zone around the wick and a blue cup at the foot are added by hand; the blue does not flicker.
3. **Wax.** A rounded box standing on the bottom edge of the canvas, with coverage 1. It is lit from the top down (`exp(-depth / 0.5 flame heights)`), as translucent wax is, plus the `ambient` room light. With `cup` on, the lower 84% becomes a tea light's metal cup.
4. **Wick.** A dark segment through the foot of the flame, its last quarter glowing.

The idea that makes it cheap: **a candle flame is laminar, so its motion is three numbers, not a noise field.** Lean, tip lean and brightness are computed once per frame on the CPU and arrive as uniforms:

- `draught.ts` is a damped spring (natural frequency 11 rad/s, damping ratio 0.42, steps of at most 1/120 s). Its target is the idle sway plus what the pointer asks for. A pointer is treated as moving air: the flame leans **away** from it (up to 0.24 flame heights for a still pointer beside the flame, falling off as `1 / (1 + (d / 1.1)^2)`) and **along** its direction of travel (0.07 flame heights per flame height per second). The tip follows the base 0.11 s later, so a push travels up the flame, and a moving pointer raises a `gust` that roughens the edge and decays over 0.6 s.
- The idle sway is `flickerOffset` and the brightness is `flickerIntensity` from `src/gpu/emission/flicker.ts`, on a clock that `speed` can slow but never push past real time.
- Pointer position and velocity come from `trackPointers` (`src/gpu/pointer.ts`). With no pointer over the canvas, or no DOM, the candle idles.

The only texture fetch is the fluttering edge: one read of the shared noise tile, taken inside the silhouette and only when `flutter` (plus gust) is above 0.01.

## Cost

GPU time: not measured yet. What was read and counted:

- Indicative HUD readings, headless Chrome on the Apple M1 Max at 1920 × 1080: 0.99, 1.03 and 1.48 ms for the whole frame over three runs (the `draughty` preset: 0.97 to 1.04 ms), while other work was using the GPU. The tail alone reads 1.1 to 1.3 ms there, so the candle's own pass is below what this machine can resolve. No integrated GPU or phone has been measured; Tier A is provisional.
- Passes: one scene pass, then the tail.
- Procedural noise: none.
- Texture fetches: at most one per pixel, and only inside the flame. The flame's bounding box (`flame_reach`, wide enough for the largest lean) is 3.7% of a 16:9 canvas at the default size; the silhouette inside it, where the fetch happens, is roughly a third of that (estimated from the shape, not counted). The `calm` preset still fetches (flutter 0.04); at flutter 0 there is no fetch at all.
- Every pixel pays for five comparisons and one `pow`. The halo disc (41% of a 16:9 canvas at the defaults) adds about ten arithmetic operations and no fetch.
- CPU per frame: the spring (at most 30 steps of a few multiplies) and two flicker evaluations (15 integer hashes).
- Texture memory at 1080p as the HUD reports it: about 21.8 MB in 8 textures, nearly all of it the tail's scene target and bloom chain. The noise tile is shared with every other effect (0.7 MB).
- Bundle size: not measured yet.

## Pitfalls

- **Over a light page the halo is a peach tint, not light.** The flame itself reads (saturated yellow and orange, a blue foot, a dark wick), which is why `lightPage` is `yes`, but the halo at its default 0.16 is visible as a soft orange disc. Turn `halo` down on light pages.
- **The wax is as bright as `ambient` says, whatever the page.** The effect cannot see the page. At the default 0.3 the stick is a readable ivory on both tones; on a very dark page it can look lit from nowhere, on a white one a little dim.
- The swell that makes the sides convex scales x after the lean, so the distance fed to the heat function is not a true distance there. The rim is slightly thinner than the teardrop's would be; no artefact was seen.
- The lean is a shear, not a rotation. Past about 0.4 flame heights the flame looks stretched rather than blown, so the tip is also shortened (`1 / hypot(1, 1.2 lean)`) and the lean is capped at 0.55.
- Headless renders have no pointer. The lean was checked numerically (`tests/epic4-b.test.ts`: the spring alone, and the flame's centroid on the GPU with a pointer either side) and not by eye in a browser with a real mouse.
- Flash analysis (8 s, 480 × 270 standing for 1080p): no cell is over the limit in any preset. Defaults: at most 1 flash a second in a cell, whole-frame luminance range 0.002. `draughty`: at most 2. `calm`, `tea light` and `dinner candle` measured `none`. The scorecard says `low`.
- The canvas must reach down to whatever the candle stands on: the wax is cut by the bottom edge on purpose.

## When to use it

For one calm flame that should respond to the visitor: a memorial page, a "lit" state, a cursor toy. Tier A (provisional): the scene pass is too cheap to measure on the development machine, and the cost that matters is the tail's. Give it a canvas only as large as the candle and its halo; a full-width canvas pays the tail for empty pixels.

A row of candles needs one canvas each, or a different effect: this one draws a single candle. For many small flames in one canvas use `torch`. Where the flame need not respond to anything, a transparent video or an animated image is cheaper to ship.

## References

- M. Faraday, [The Chemical History of a Candle](https://www.gutenberg.org/ebooks/14474) (1861): the dark zone round the wick, the blue cup at the base, the luminous body.
- Inigo Quilez, [2D distance functions](https://iquilezles.org/articles/distfunctions2d/): the uneven capsule behind `flame_sd_teardrop`.
- `src/wgsl/flame.wgsl`, `src/wgsl/ramp.wgsl`, `src/wgsl/flicker.wgsl`: the shared chunks, with their own derivations.
- W3C, [WCAG 2.2, 2.3.1 Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html).
