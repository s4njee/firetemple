## How it works

This is the test scene for `src/wgsl/flame.wgsl`, the shared chunk that every 2D flame on the site is shaped with. It draws one flame three times, left to right (top to bottom on a portrait canvas), so each step of the chain can be seen on its own:

1. **Shape.** The bare silhouette as a signed distance field, with a contour every 0.1 flame heights. `flame_sd_teardrop` is a circle resting on the base joined by its tangent lines to a pointed tip; `flame_sd_taper` is a trapezoid, a column that narrows to a small flat top. Both are exact distances, which is why the contours are evenly spaced.
2. **Heat.** The same shape after turbulence and erosion, as a greyscale heat value in 0..1. The faint outline is the bare silhouette from panel 1.
3. **Flame.** That heat through `ramp_fire` (`src/wgsl/ramp.wgsl`), written as linear HDR radiance and finished by the tail.

Everything happens in flame space: the origin is the centre of the base, y points up and the tip is at y = 1. The chain is four small steps, and none of them evaluates noise. The scene supplies two noise values per pixel and the chunk does the rest:

```wgsl
let p = flame_turbulence(uv, vec2f(sway, 0.0), amount, height, curve); // base anchored, tip sways
let d = flame_sd_teardrop(p, half_width, height);                      // exact distance
let eroded = flame_erode(d, erosion_noise, amount, t, curve);          // edge recedes, more at the tip
let heat = body(eroded) * base_fade(t) * flame_height_falloff(t, hot, falloff);
```

- **Turbulence** displaces the sample position by `noise * amount * t^curve`. The weight is exactly zero at the base, so the foot never moves while the tip travels up to 0.6 half-widths either way.
- **Erosion** adds `noise * amount * t^curve` to the distance, so the surface recedes where the noise is high. Near the tip the flame is thinner than the amount removed, which is what cuts it into tongues and leaves detached licks. With noise in 0..1 the shape can only shrink, so the bare silhouette is a hard bound on where the flame can be.
- **Heat** is interior depth raised to 0.7 (a thin dim rim, then a quick climb), saturating at 0.85 half-widths, multiplied by a fade at the foot and a falloff from the hot spot (t = 0.2) to the tip. With zero noise it is exactly 1 at the hot spot and falls monotonically up the axis: 0.80 at t = 0.4, 0.50 at 0.6, 0.23 at 0.8, 0 at the tip.

`flame_heat_teardrop` and `flame_heat_taper` wrap the chain; `flame_heat_from_sd` is the shading alone, for a silhouette of your own. The taper version has an open base: the flame is cut on the base line at full heat, like a flame leaving a burner, and the scene draws a small burner bar over the cut.

The noise in `scene.wgsl` is deliberately plain. The sway is two octaves of 2D noise read along the height and scrolled upward, so a bend starts low and travels to the tip. The erosion is four octaves of 3D noise, three times taller than wide, rising at a constant rate and remapped with a `smoothstep` so that large areas are either untouched or fully eroded. Advecting the noise properly is a separate building block.

Time is accumulated from `time.delta * speed`, so moving the speed slider never makes the flame jump.

## Cost

One fullscreen fragment pass into the `rgba16float` scene target, then the tail (bloom chain and output pass).

Per pixel the flame costs six noise evaluations (2 for the sway, 4 for the erosion) and about 50 arithmetic operations, one square root and four `pow` for the shaping. Pixels outside `flame_reach` (a box around the silhouette widened by the sway) skip the noise entirely; the shape panel never evaluates noise. In the unit test a box of 2.4 by 2.2 flame heights around the default flame is 91% outside the reach. In the three-panel view at 16:9 the two reach boxes cover roughly a fifth of the canvas by area (calculated from the layout, not counted).

GPU time, measured: 1.0 ms per frame at 1920 × 1080 with the default settings, tail included (Apple M1 Max, Dawn under Node; the tail alone reads 0.7 ms, and repeated runs differ by up to about half a millisecond). No integrated GPU or phone has been measured. The full table is `docs/studies/epic-3.md`. Texture memory is one `rgba16float` target at canvas size plus the bloom levels.

What scales the cost: canvas area, and the fraction of it inside the reach box, which grows with `width` and `turbulence`. The single-stage `flame` view at a large `height` is the expensive case.

Whole-frame brightness, measured from headless renders at 480 by 270 over three seconds (61 frames, mean of the encoded output, 1.0 = full white): the mean moves by at most 0.011 over the whole run and by at most 0.002 between frames 50 ms apart. That holds for the default and the three presets in the three-panel view (default 0.118 to 0.126, candle 0.117 to 0.121, campfire 0.137 to 0.147, jet 0.103 to 0.108) and for the worst case tried, the campfire in the full-frame `flame` view (0.063 to 0.073). The flicker is local to the tip.

## Pitfalls

- **The visible flame is shorter than the silhouette.** The tip of the teardrop is thin, so erosion and the height falloff empty it most of the time. With the defaults the body ends near 60% of `height` and the rest holds the licks. Size the silhouette generously and judge the height by eye.
- **A wide teardrop is a fireball.** Above a half-width of about 0.3 heights the round base dominates and the lower body saturates into a white ball. For a wide fire use the taper (the `campfire` preset), or several teardrops merged with `smin_poly`.
- **The foot of the teardrop is not eroded.** The erosion weight is zero at the base, so the bottom arc is always the perfect circle. `base_soft` hides it by fading the heat there; with `base_soft = 0` the arc shows.
- **The taper is cut on its base line.** That is a hard horizontal edge by design. Something has to cover it: a burner, a wick, a log, the bottom of the card.
- **A swayed distance is no longer a distance.** After `flame_turbulence` the field is a bound whose slope can reach `1 + noise * amount * curve / height` (measured 1.26 against a bound of 1.6 for amount 0.3, curve 2). Fine for shading; step conservatively if you march it.
- **Erosion noise needs contrast.** Raw `fbm` sits near its mean, which removes the same depth everywhere and just makes the flame thinner. The tongues come from the `smoothstep(-0.3, 0.3, n)` remap in the scene.
- **Constant scroll.** The erosion field rises at one speed everywhere, and with `turbulence` at 0 it reads as a texture sliding through a mask.
- **Bloom spills across the dividers.** The flame panel's glow reaches into the heat panel. That is the tail working, not a layout bug; lower `bloom` to read the heat panel cleanly.
- The canvas is opaque and carries its own dark background, so it looks the same on a light page and a dark one. Putting a flame on the page itself is the compositing study's subject.

## When to use it

As a reference, and as a tuning bench. Pick a shape, set width, turbulence, erosion and falloff until the silhouette is right, then carry the numbers into `FlameParams` in the effect you are building. The `flame` view on its own is a serviceable single flame for a card or a hero (Tier A: six noise evaluations inside a small box), but the candle, torch and fireplace effects built on this chunk are the ones to ship.

Starting points: `flame_params_default()` (teardrop, half-width 0.19) for a single flame of the candle or lighter kind; the taper with `base_soft = 0`, `hot = 0` for anything that leaves a burner, a torch head or a row of jets. When the flame should spread, roll and never repeat, a simulation is the right tool and this is not.

## References

- Inigo Quilez, [2D distance functions](https://iquilezles.org/articles/distfunctions2d/): the uneven capsule (the teardrop is one with a zero tip radius) and the isosceles trapezoid (the taper).
- Inigo Quilez, [Smooth minimum](https://iquilezles.org/articles/smin/), for merging several silhouettes into one fire.
- XT95, [Flame](https://www.shadertoy.com/view/MdX3zr) (Shadertoy): the classic "a distance plus noise that grows with height" flame.
- W3C, [Understanding WCAG 2.3.1: Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG21/Understanding/three-flashes-or-below-threshold.html).
