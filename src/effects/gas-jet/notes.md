## How it works

One fullscreen pass (`jet.wgsl`), then the HDR tail. A jet is drawn in its own frame: x across it, y along its axis from the nozzle.

**Which jet.** Every pixel belongs to at most one jet and finds it with arithmetic, so the count is free. `single` is one frame. `row` rounds the across-coordinate to the nearest of `count` jets along a pipe. `ring` is a stove burner seen from above: an `atan2` and a round pick the nearest of `count` jets leaving the edge of a round cap. `jetLayout` (in `index.ts`) centres burner and flames in the canvas and zooms out when they would not fit, so `direction` and `length` work at any aspect.

**One jet** is three layers:

1. **Mantle.** `flame_heat_taper` from `flame.wgsl`: an open-based cone whose tip can be widened (`spread`). One fetch of the shared noise tile gives both its sway and the erosion of its edge; the noise is stretched eleven times along the jet and scrolls away from the nozzle. Colour is `ramp_gas`, with the heat lifted (`heat^0.6`) and the ramp's red held to 0.35, because a thin mantle otherwise sits in the ramp's violet end.
2. **Inner cone.** A second, shorter taper (`cone` of the length, 0.62 of the width) drawn as a thin luminous wall with a paler fill: the pale cone inside a clean gas flame. It does not move.
3. **Shock diamonds** (`diamonds`). A lozenge `|x| / a + |y| / b < 1` repeated every `diamondSpacing` nozzle widths, each one 27% fainter than the last (`exp(-0.32 k)`), with its edge nudged by the same noise and its brightness swinging 12% at about 1.1 Hz. The plume is also drawn in by up to 22% between diamonds, which is what makes them read as standing waves rather than stickers.

`warmth` blends the mantle from the gas ramp to an orange-to-pale-yellow range of `ramp_fire` (starting at heat 0.72, so it never passes through red) and the diamonds from pale blue to pale yellow. The burner (a tube, a pipe with brass ports, or a round cap) is drawn with coverage 1 and takes a little of the flame's colour near the mouth.

## Cost

GPU time, measured on a quiet GPU (Apple M1 Max, 1920 × 1080, default settings, tail included): 1.2 ms per frame on Dawn, where the tail alone reads 0.5 ms and repeated runs differ by about half a millisecond, so this effect cannot be told apart from the tail; and 1.04 ms for one frame in Chrome 155 at 60 fps (median of 3 loads, 1.02 to 1.20), which includes the browser's timing floor. Both are inside the Tier A budget of 2 ms on this machine. The budget is set for an integrated GPU, and no integrated GPU or phone has been measured, so the tier is provisional. Tables: `docs/studies/epic-4.md` and `docs/studies/browser-check.md`. What was read and counted:

- Indicative HUD readings, headless Chrome on the Apple M1 Max at 1920 × 1080, whole frame, three runs while other work was using the GPU: blowtorch (the default) 1.13, 0.94, 0.90 ms; `afterburner` 1.01, 1.07, 1.02 ms; `stove burner` 1.15, 1.07, 1.07 ms. The tail alone reads 1.1 to 1.3 ms there, so the jets' own pass is below what this machine can resolve. No integrated GPU or phone has been measured; Tier A is provisional.
- Passes: one scene pass, then the tail. Procedural noise: none.
- Texture fetches: one per pixel, only inside a jet's bounding box (`flame_reach`). That box is 4.2% of a 16:9 canvas for the default blowtorch, 9.7% for the 20 jets of `stove burner`, 11.7% for `afterburner`.
- Inside the box: the fetch, two taper distance fields (two `sqrt`), six `pow`, three `exp`, one `cos`, both ramps. Diamonds add a `sin`.
- Outside it: two dot products and the burner's distance function. In `ring` mode every pixel within the ring's reach (24% of a 16:9 canvas for `stove burner`) also pays for an `atan2`, a `sin` and a `cos`.
- Texture memory at 1080p as the HUD reports it: about 21.8 MB in 8 textures, nearly all of it the tail. Bundle size: 43.7 kB gzipped for everything the effect loads beyond the first page.

## Pitfalls

- **A bright plume can flash.** Blue carries 7% of relative luminance, so a blue jet cannot flash by WCAG's definition however it shimmers: the defaults measure `none`. A wide, warm plume is bright, and the first `afterburner` measured `high` (4 flashes a second over 24 700 px², limit 3 over 21 824 px²) with the noise passing at 8 cells a second. The fix was to stretch the noise further along the jet and slow it to 2.4 cells a second, so the flow looks as fast while a point on the jet changes at 2.4 Hz; the sway was cut by a third and the diamonds' edge noise halved. `afterburner` now measures `low`: at most 2 flashes a second in a cell, no area over the limit. `speed` ends at 1.25 (3 cells a second) for the same reason. The scorecard says `low` rather than `none` because of that preset.
- **The corner of the parameter range is still over.** A warm plume at the largest size (`width` 0.4, `length` 1.6) with `roar` 1 and `speed` 1.25 measured `high` (24 700 px²). No preset is near it. Keep `roar` under about 0.6 on a jet that fills the screen.
- **Over a light page the brightest part is the palest.** Looked at over the light page, with and without the underlay: the mantle is saturated blue ink and reads well; the inner cone, the hottest thing on a dark page, is pale cyan close to the paper and is seen only because the mantle outlines it. Hence `lightPage: yes` for the blue jet. The `afterburner` reads as an orange shape with pale diamonds; its glow is lost.
- `warmth` halfway is violet: blue and orange add to purple. Use it near 0 or near 1.
- The burner cuts the flame's base. With `nozzle` off the flame starts on a hard line; cover it with your own artwork.
- Neighbouring jets do not blend. In a row or ring each pixel draws only its nearest jet, so jets wider than their spacing are clipped at the midline.
- Shock diamonds are drawn, not simulated: evenly spaced and fading by a fixed ratio. Real ones stretch with pressure ratio; `diamondSpacing` is that knob.

## When to use it

For clean, directional flame: a burner as an "on" state, a thruster or afterburner behind something that moves, a blowtorch as the head of a progress bar. Tier A (provisional). Size the canvas to the jet; the tail is the cost.

It is the wrong tool for anything sooty or lazy: use `candle`, `torch` or the scrolling-noise flame. Rocket plumes that expand into smoke need the particle and smoke effects of later epics.

## References

- Wikipedia, [Shock diamond](https://en.wikipedia.org/wiki/Shock_diamond): the standing-wave pattern in an over- or under-expanded exhaust, and what sets its spacing.
- Wikipedia, [Bunsen burner](https://en.wikipedia.org/wiki/Bunsen_burner): the inner cone and outer mantle of a premixed flame.
- Inigo Quilez, [2D distance functions](https://iquilezles.org/articles/distfunctions2d/): the isosceles trapezoid behind `flame_sd_taper`.
- Inigo Quilez, [Domain repetition](https://iquilezles.org/articles/sdfrepetition/): rows and rings from one evaluation.
- W3C, [WCAG 2.2, 2.3.1 Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html).
