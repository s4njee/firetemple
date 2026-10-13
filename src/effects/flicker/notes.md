## How it works

Fire flickers, and flicker is a photosensitivity risk. This page shows the one signal every later flame and light on the site is driven by: `src/wgsl/flicker.wgsl`, and its TypeScript twin `src/gpu/emission/flicker.ts` for CSS and canvas lights. It is band-limited noise with caps chosen so that a light driven by it cannot exceed the WCAG 2.3.1 flash threshold, whatever settings it is given.

**Reading the picture.** Three candles with seeds `seed`, `seed + 1`, `seed + 2`, each beside an oscilloscope of its own intensity. Time runs from now (left, at the white dot) to `span` seconds ago (right). The vertical axis ends at 1.0 at the top and starts at the quarter below the signal's range, with a rule every 0.25.

- The **pale amber line** is the capped signal, `flicker_intensity`. It drives the candle.
- The **red line** is the same settings with no caps, `flicker_intensity_unsafe`. It only parts from the amber one when the request is outside the safe range (try the `clamped` preset). With `uncapped` switched on the red line drives the candle and the frame of the screen turns red.
- The **blue band** is 10% of full white, centred on the signal's mean: a change has to cross the whole band to count towards a flash. The brighter strip inside it is 4%, the cap on the fast part.
- The **dashed line** is 0.80: a change only counts when its darker end is below it.
- **Vertical rules** mark seconds. The **ticks along the bottom** mark the knots of the slow swing; the signal can turn round at most once between two ticks.
- The **white dot** is the current value computed on the CPU by the TypeScript twin. It sits on the start of the line for as long as the two implementations agree.

**The signal.** Four settings: `rate` and `depth` for a slow swing, `shimmer` and `shimmer rate` for a fast, small one.

```wgsl
slow      = mix(B(rate * t), B'(rate * t / 4), 0.4)        // in [0, 1]
fast      = B''(shimmer_rate * t)                          // in [0, 1]
intensity = 1 - depth * (1 - slow) - shimmer * (1 - fast)  // in [1 - depth - shimmer, 1]
offset    = 2 * slow2 - 1                                  // the same shape, two values per knot
```

`B` is a uniform quadratic B-spline whose control values are integer hashes (`pcg_2d` from `hash.wgsl`) of the knot index and the seed. `rate` is in knots per second: how often the swing picks a new random target. A B-spline rather than interpolated value noise because it never stops at the knots (no stop-and-go rhythm), it stays inside the range of its control values, and its derivative is piecewise linear, which is what the guarantee rests on.

**The caps** (`flicker_clamp`, applied inside `flicker_intensity` and `flicker_offset`):

| Setting        | Safe range         | Why                                                                |
| -------------- | ------------------ | ------------------------------------------------------------------ |
| `rate`         | 0 to 4 knots/s     | At most one reversal per knot, so at most two full swings a second |
| `shimmer`      | 0 to 0.04          | Its whole range is under half of the 10% a flash needs             |
| `shimmer rate` | 0 to 24 knots/s    | A band limit, so a 60 Hz display does not alias it                 |
| `depth`        | 0 to 1 - `shimmer` | The slow swing may be as deep as it likes; the output never clips  |

**Why that is enough.** WCAG 2.3.1 allows no more than three flashes in any second, a flash being a pair of opposing changes in relative luminance of 10% or more of full white where the darker state is below 0.80.

1. The slow part can reverse direction at most once per knot interval. The drift octave has its knots on every fourth knot of the main one, so the sum is still such a spline.
2. A run of `n` alternating changes inside one second needs `n - 2` reversals strictly inside it, so `n < rate + 4`. With `rate` at most 4 that is at most 7 changes, which is 3 flashes, even if every change spans the whole range.
3. The fast part cannot make a flash alone and cannot add one: a 10% change of the sum still needs the slow part to move 6% the same way.

The argument also holds for a weighted mix of lights that share one `rate` (every seed has its knots at the same instants, and the spline is linear in its control values), and through any monotone display curve whose slope stays under 2.5.

**What was measured** (`tests/emission-motion.test.ts`, section `flicker`):

- Capped signal at the worst-case safe settings (a request of 1e6 for everything, clamped to rate 4, depth 0.96, shimmer 0.04, shimmer rate 24, and the same with shimmer 0 and depth 1), sampled at 240 Hz, 8 seeds, 10 minutes each: at most **5 qualifying changes in any one-second window, which is 2 flashes**. The same over the whole 1024 s period at 250 Hz, through a display gain of 2.4, and for a mix of four lights: 5, 5 and 4 changes.
- Adversarial control values (strict alternation, random bits) with a square-wave shimmer at the cap: also 5 changes, 2 flashes.
- Uncapped path, 240 Hz: rate 8, depth 1 gives 4 flashes a second; rate 16, depth 1 gives 7; shimmer 0.5 at 30 knots/s gives 10.
- This scene, rendered headlessly at 60 frames a second and read back as 8-bit sRGB, luminance averaged over a 12 by 9 grid of blocks: 1 flash a second at the defaults, 2 with the `clamped` preset, 7 with the same settings and `uncapped` on.
- WGSL against TypeScript: largest difference **2.1e-7** over 29 000 points in time, each comparing the safe intensity, the unsafe intensity and both axes of the offset, on Dawn/Metal; the test's tolerance is 2e-6.
- Range, mean (1 - (depth + shimmer) / 2), spread (standard deviation 0.15 of depth), slope (at most 0.7 * depth * rate + shimmer * shimmer rate per second; 0.0131 per 1/240 s measured at the caps against a bound of 0.0152) and the exact 1024 s period are each asserted.

**Passes.** `signals.wgsl` evaluates the signals into a small `rgba16float` texture, one row per light and one column per pixel of trace (column 0 is now). `scene.wgsl` draws candles, wall and scopes from that texture and evaluates no noise itself. Then the tail.

## Cost

GPU time, measured: 1.2 ms per frame at 1920 × 1080 with the default settings, tail included (Apple M1 Max, Dawn under Node; the tail alone reads 0.7 ms, and repeated runs differ by up to about half a millisecond). In Chrome 155 on the same machine the HUD reads 1.6 ms for one frame at 1080p and 60 fps (`docs/studies/browser-check.md`); that figure includes the browser's timing floor. No integrated GPU or phone has been measured. The full table is `docs/studies/epic-3.md`.

What the cost is made of: one `flicker_intensity` is 9 `pcg_2d` hashes and three quadratic polynomials; one `flicker_offset` is 6 hashes. No textures, no branches. This scene evaluates two intensities and one or two offsets per texel of the signal texture, which is three rows of at most 2048 texels, so the noise work is a few thousand evaluations a frame however large the canvas is. The scene pass does up to five texel loads per pixel and no noise; the tail is the same as on every effect.

The TypeScript twin took about 0.12 microseconds per intensity in Node 26 on the Apple Silicon development machine (one million evaluations in 117 ms; indicative). This page calls it three times a frame, for the dots.

Texture memory: the signal texture is at most 2048 x 3 `rgba16float` (48 kB), plus the tail's scene target and bloom levels. Bundle size: 29.4 kB gzipped for everything the effect loads beyond the first page.

## Pitfalls

- **`t` must be real seconds.** A speed factor on time multiplies both rates and takes the signal straight past the cap. Change `rate` instead.
- **Lights with different rates summed over one area are not covered.** Their knots no longer line up, so the mix can reverse more often than either. Lights that overlap on screen should share `rate` and differ in seed and depth.
- **Gain.** The shimmer cap leaves a factor of 2.5 between the signal and the display. Exposure, a steep tonemap or several lights piled on one area can use that up; the slow part is unaffected, since any monotone curve keeps its reversal count.
- **`depth` is a bound, not the typical swing.** The spline is a low-pass filter: the standard deviation is about 0.15 of `depth` and 90% of the time the signal is within a quarter of `depth` of its mean. Set `depth` about twice as large as the swing you want to see.
- **Changing `rate` moves every light to a different part of its curve**, because the signal is a function of time times rate. This page rescales its clock to keep the slow phase; after a large cut in rate late in the period that is not possible and the lights jump once. The trace is a plot of the function at the current settings, not a recording, so it redraws its past as well.
- **f32 time.** The signal repeats exactly every 1024 s and wraps `t` itself, but an f32 cannot resolve a frame once `t` is large (steps of 8 ms at 18 hours). Wrap on the CPU, in f64: `seconds % FLICKER_PERIOD`. Rates are rounded to a whole number of knots per period (1/256 Hz steps) to make the wrap seamless.
- **Position is not covered by the proof.** Each axis of the offset obeys the same reversal bound, but a light sliding across a pixel changes that pixel in ways the bound does not reach. Keep the offset's scale under about a tenth of the light's radius.
- **The red-flash threshold was not analysed separately.** The count of slow reversals carries over to any colour that is a monotone function of the signal; the shimmer argument has only been made for luminance.
- **The flash counter is a model.** It treats the signal as the luminance of a large area and counts each change at the instant it reaches 10%. It does not do the area analysis (a quarter of a 10 degree field) that a broadcast checker does; it errs towards counting more.
- **Do not name an effect's shader `flicker.wgsl`.** Includes resolve beside the including file first, so `#include "flicker.wgsl"` would pick it up instead of the library chunk. That is why this effect's shaders are `signals.wgsl` and `scene.wgsl`.
- **`uncapped` flashes.** At high settings it measured 7 flashes a second in this scene. It is off by default and no preset turns it on.

## When to use it

Whenever something on the page changes brightness because it is fire: flame intensity, the glow around a flame, light cast on the page, a CSS `filter` or `opacity` that should breathe with a WebGPU flame. It is meant to be evaluated once per light: in the vertex stage, in a small texture as here, or on the CPU with the twin. Evaluating it per pixel across a full screen spends most of a Tier A noise budget on a value that is the same for every pixel.

Recommended starting point, `flicker_default()` / `FLICKER_DEFAULT`: rate 3, depth 0.3, shimmer 0.03, shimmer rate 13. For a hearth or embers, slow it down and deepen it (the `hearth` preset: rate 1.2, depth 0.55, shimmer 0.015). Use the capped functions everywhere a light can cover a large part of the view; reach for the `_unsafe` ones only for something small (a single spark) or behind an explicit opt-in.

It is a signal over time for a whole light. For structure across a flame (tongues, turbulence) use the noise and advection chunks; for a flame that reacts to sound or scroll, feed those in as their own multipliers and keep this as the base.

## References

- W3C, [Understanding Success Criterion 2.3.1: Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html).
- W3C, [WCAG 2.2, definition of the general flash and red flash thresholds](https://www.w3.org/TR/WCAG22/#dfn-general-flash-and-red-flash-thresholds).
- ITU-R, [Recommendation BT.1702: Guidance for the reduction of photosensitive epileptic seizures caused by television](https://www.itu.int/rec/R-REC-BT.1702).
- Mark Jarzynski and Marc Olano, [Hash Functions for GPU Rendering](https://jcgt.org/published/0009/03/02/) (JCGT 2020), the `pcg_2d` hash behind the knots.
- Wikipedia, [B-spline](https://en.wikipedia.org/wiki/B-spline): the convex hull property and the derivative of a spline as a spline one degree lower, which give the range and the reversal bound.
