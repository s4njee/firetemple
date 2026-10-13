## How it works

This is the test scene for `src/wgsl/advect.wgsl`, the shared chunk that every later procedural flame gets its motion from. The problem it addresses: noise that only scrolls upward, `fbm(p - v t)`, is one rigid picture sliding past. The eye locks on to it within a second and the flame turns into a conveyor belt. The chunk holds five ways of breaking that, and the scene shows them side by side on the same heat field (noise minus a height ramp, through `ramp_fire`), in strips, or stacked in bands when the canvas is taller than it is wide.

Every variant takes the same inputs: the position `p` in noise cells, `drift` (how far the gas has risen so far, accumulated on the CPU from `time.delta`), an evolution clock `t`, an amount and an octave count. Each returns a zero-mean value in [-1, 1] with the same spread, so swapping one for another does not change how much flame there is.

1. **Scroll** (`advect_scroll`). The baseline: `fbm_3d(vec3f(p - drift, t))`. With the clock held it is exactly a translation. Running the clock (`scroll: evolution`, off by default so the strip shows the look to beat) fades features in and out where they stand.
2. **Warp** (`advect_warp`). The lookup position is displaced by two animated noise fields. The fields are twice as coarse as the pattern and rise at half its speed, so the pattern shears through them.
3. **Flow noise** (`advect_flownoise`), from Perlin and Neyret. Gradient noise in which every lattice gradient rotates, finer octaves faster, so features turn over without anything being scrolled. Their second idea, pseudo-advection, looks each octave up a little way along the gradient of the coarser ones: fine detail is pushed off the crests of the large shapes into the troughs, which gives round billows with sharp dark creases.
4. **Curl** (`advect_curl`). The lookup steps backwards along a divergence-free field, the curl of a noise potential. A field with no divergence cannot pile the pattern up or thin it out, so features shear and swirl without swelling.
5. **Two-phase** (`advect_twophase`), the flow-map technique from Portal 2's water. The pattern is carried along a velocity field for real, at two phases half a cycle apart. Each phase is reset after one cycle, and a triangle cross-fade gives it zero weight at that moment, so the distortion never builds up.

The sixth strip, **curl + flow**, is not a sixth function. It is the composition the measurements below point to: flow noise looked up at the curl-displaced position.

```wgsl
let q = advect_curl_pos(p, drift, t, 0.4);                         // where the gas came from
let n = advect_flownoise(q, vec2f(0.0), 1.35 * t, 0.12, 4);        // a pattern that also ages
```

Three details are worth knowing before using the chunk.

- **Rotating gradients need unequal rates.** If every gradient turns at the same rate, as in the original sketch, the noise at angle `a` is `cos(a) A + sin(a) B` for two fixed fields: it becomes its own negative every half turn and repeats exactly. Here each gradient has its own hashed rate, triangular over +-2.45 times the nominal one. The correlation of the field with itself is then sinc squared of the angle turned (measured 0.88, 0.59, 0.27, 0.07 at 0.5, 1, 1.5, 2 radians against 0.88, 0.59, 0.28, 0.07 predicted), which falls to zero and never goes negative.
- **The two-phase blend must be renormalised.** A plain mix of two unrelated layers has, at mid-fade, half the variance of either. Measured through one cycle the plain mix keeps 0.99, 0.61, 0.49, 0.62, 1.00 of a single layer's variance; dividing by `sqrt(w^2 + (1 - w)^2)` keeps 0.98 to 1.00. Without it the pattern goes soft and flat twice per cycle. That only works if the layers really are unrelated, so each phase reads a different part of the pattern (their measured correlation is below 0.03), and a new part every cycle so that no cycle replays the last.
- **The phase offset is smooth and small.** A per-pixel phase offset from noise stops the whole frame resetting together. It also scales the apparent flow speed by `1 / (1 - cycle * dot(flow, gradient of the offset))`, so it is kept low-frequency: about +-13% at the defaults.

### Measured comparison

The measure is the co-moving correlation: over 30 000 points, the correlation between the noise now and the noise a moment later at the place the gas has carried it to. It is exactly 1 for a rigid sliding texture; lower means features were born, deformed or died on the way. All numbers are evaluated on the GPU by `tests/emission-motion.test.ts` at the scene's defaults: 4 octaves, a rise of 1.6 cells per second, the clock at one unit per second.

| Variant            | Evaluations | Corners hashed | 0.1 s | 0.25 s | 0.5 s | 1 s   | Tracking recovers |
| ------------------ | ----------- | -------------- | ----- | ------ | ----- | ----- | ----------------- |
| scroll             | 4           | 32             | 1.00  | 1.00   | 1.00  | 1.00  | 0.00              |
| scroll + evolution | 4           | 32             | 0.92  | 0.68   | 0.25  | -0.04 | 0.06              |
| warp, 0.4          | 6           | 32             | 0.91  | 0.66   | 0.38  | 0.29  | 0.18              |
| flow noise         | 4           | 16             | 0.93  | 0.69   | 0.27  | 0.00  | 0.04              |
| curl, 0.4          | 5           | 24             | 0.92  | 0.69   | 0.36  | 0.25  | 0.10              |
| curl + flow        | 5           | 24             | 0.90  | 0.64   | 0.28  | 0.09  | 0.11              |
| two-phase          | 10          | 44             | 0.95  | 0.78   | 0.45  | 0.11  | 0.04              |

"Evaluations" are noise evaluations per pixel; "corners hashed" counts the lattice corners behind them (4 for a 2D evaluation, 8 for 3D) and is the better guide to cost. Flow noise also pays four sine and cosine pairs per evaluation.

Read the table with one caveat first: **the correlation is a dial.** Every mechanism can be turned up until the texture is gone (at 0.25 s: scroll clock 0.5/1/2 gives 0.89/0.68/0.32, warp strength 0.2/0.4/0.8 gives 0.87/0.67/0.32, curl 0.88/0.69/0.36, flow rotation 1.35/2.7/5.4 gives 0.89/0.69/0.28). The defaults were tuned so the single-sample variants lose about the same share in a quarter of a second, which makes the other columns comparable. What then differs is:

- **The pattern still travels.** Left in place instead of followed, every variant drops to 0.75 to 0.83 after 0.1 s and to about 0.3 after 0.25 s, well below the co-moving figures. None of them trades the rise for noise.
- **How the change happens.** "Tracking recovers" is from block matching: how much better 1.5-cell blocks match a quarter of a second later when each is allowed to find its own best offset (within half a cell) instead of staying put. Evolution and flow noise score 0.04 to 0.06, which is just the bias of choosing the best of 81 offsets: their features change where they are and nothing moves sideways. Warp (0.18) and curl (0.10) really move features relative to their neighbours.
- **What survives.** A displacement of 0.4 cells cannot remove a feature larger than itself. After a second, warp and curl still correlate 0.25 to 0.29 with the rigid texture they started from: its coarse octave is still there, sliding. Anything whose pattern ages (evolution, flow noise, curl + flow) reaches zero.
- **Swelling.** At strength 0.4 the warp changes the area of a small patch by 0.56 RMS and curl by 0.39; at 0.2 it is 0.27 against 0.10. Curl's divergence is zero to four decimals, so its area change is second order in the strength; the warp's is first order.

Verdict, per unit of cost: flow noise buys the most decorrelation per corner hashed (16 corners for what scroll + evolution needs 32 for), but it only changes features in place. Curl buys the same decorrelation as the warp for three quarters of the hashes, with real relative motion and less swelling. The combination, curl + flow at 24 corners, is the only row that both moves features and lets them die, and is what later effects should start from. The two-phase blend costs the most and decorrelates the least for it; most of its short-term change is cross-fading. It earns its place only when there is a real velocity field to follow, which is what it is for.

## Cost

One fullscreen fragment pass into the `rgba16float` scene target, then the tail (bloom chain and output pass). Each pixel evaluates one variant, so in `compare` the cost per pixel is the average of the strips: 5.7 noise evaluations, 29 corner hashes. Full-frame it is the figure in the table above for that variant, from 16 corners (flow noise) to 44 (two-phase). Pixels above the height where even the largest noise value is cancelled by the falloff skip the noise; at the default falloff that is none of the frame, and from `falloff` 1.15 upward it is the top of it.

GPU time, measured: 1.6 ms per frame at 1920 × 1080 with the default settings, tail included (Apple M1 Max, Dawn under Node; the tail alone reads 0.7 ms, and repeated runs differ by up to about half a millisecond). No integrated GPU or phone has been measured. The full table is `docs/studies/epic-3.md`. One variant across the whole canvas: scroll 1.3 ms, warp 1.2 ms, flow noise 1.1 ms, curl 1.2 ms, two-phase 1.4 ms, curl + flow 1.7 ms. The differences are inside the run-to-run spread on this GPU. Texture memory is one `rgba16float` target at canvas size plus the bloom levels.

Whole-frame brightness, from headless renders at 160 by 90 sampled 30 times a second for four seconds (two cycles of the two-phase blend; mean of the encoded output, 1.0 = full white): `compare` 0.210 to 0.237, `two-phase` alone 0.193 to 0.221, `curl + flow` alone 0.192 to 0.226, and never more than 0.004 between consecutive samples. The two-phase blend does not pulse: its frame standard deviation over two cycles stays between 0.187 and 0.190. Locally it flickers as any fire does: the site's flash test (`tests/flash.test.ts`, defaults, four seconds) finds single cells swinging by a tenth of full white up to three times in a second and no flashing over a large area, which is the scorecard's `low`.

## Pitfalls

- **Displacement is not advection.** Warp and curl move the lookup by a bounded amount. Past a strength of about 0.5 the map folds and fine detail is drawn out into fibres (the `too much` preset shows it); the RMS strain is already 0.74 (warp) and 0.98 (curl) at 0.4. Curl's field is rougher than the warp's at equal displacement, which is why it fibres first.
- **Flow noise is pinned to its lattice.** Every octave is zero on its lattice points at every angle, so without drift it churns on the spot (the `no rise` preset). Its billows with dark creases are a look of their own, closer to lava or thick smoke than to flame tongues; past an advection of about 0.2 the creases join into a net.
- **Two-phase limits.** Keep flow speed times cycle below about 1.5: beyond that the phase offset folds the flow. Features cannot live longer than one cycle. Changing `cycle` re-phases the blend, so the picture jumps while that slider is dragged; the other sliders do not jump.
- **3D slices are not uniform.** The spread of `advect_scroll` dips by about 6% once per unit of the clock, where its coarsest octave crosses a lattice plane (standard deviation 0.177 there against 0.185 to 0.192 elsewhere). It is too small and too slow to see, but it is there.
- **Float precision.** The drift grows without limit, and noise loses resolution past about 10 000 cells. The scene wraps its accumulators instead, which costs one visible jump roughly every 43 minutes at the default speed (the drift) and about once an hour (the clocks).
- **The comparison is not neutral.** The strips share a clock, but each amount has its own slider and the defaults were chosen to equalise the quarter-second correlation. Different defaults give a different table; the tests print a sweep.

## When to use it

Use the chunk, not the scene: `#include "advect.wgsl"` and call one function per pixel. Tier A.

- **Default for a flame or an ember bed:** flow noise through the curl displacement (the `curl + flow` strip), 24 corners per pixel at four octaves. Drop to plain `advect_curl` if the billow look is wrong for the effect, and to three octaves if the budget is tight.
- **Cheapest thing that is not a conveyor belt:** `advect_flownoise` alone, 16 corners and no 3D noise. Good for smoke and for anything small on screen.
- **A flame with a velocity field of its own** (faster in the middle, drawn inward at the base, or a painted flow map): `advect_flowmap`, at twice the pattern cost. Nothing else here follows streamlines.
- **A pattern that is not fbm** (a texture, Voronoi cells, a flame silhouette): `advect_curl_pos` or `advect_warp_pos` for the lookup position, or `advect_phases` with `advect_phase_mix` for the two-phase blend.
- **Plain scroll** is still right for something that is on screen for a fraction of a second, such as a spark trail, where nobody can follow a feature long enough to see that it is rigid.

As a visual the scene is a warm abstract fire wall (the `backdrop` preset); it has no flame shape.

## References

- Ken Perlin and Fabrice Neyret, [Flow Noise](https://inria.hal.science/inria-00537499) (SIGGRAPH 2001 Technical Sketches): rotating gradients and pseudo-advection.
- Stefan Gustavson and Ian McEwan, [Tiling simplex noise and flow noise in two and three dimensions](https://jcgt.org/published/0011/01/02/) (JCGT 2022): the gradient form of the pseudo-advection used here.
- Robert Bridson, Jim Hourihan and Marcus Nordenstam, [Curl-Noise for Procedural Fluid Flow](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph2007-curlnoise.pdf) (SIGGRAPH 2007).
- Alex Vlachos, [Water Flow in Portal 2](https://advances.realtimerendering.com/s2010/Vlachos-Waterflow%28SIGGRAPH%202010%20Advanced%20RealTime%20Rendering%20Course%29.pdf) (SIGGRAPH 2010, Advances in Real-Time Rendering course): the two-phase flow-map blend and its phase offset.
- Eric Heitz and Fabrice Neyret, [High-Performance By-Example Noise using a Histogram-Preserving Blending Operator](https://inria.hal.science/hal-01824773) (HPG 2018): why a linear blend of unrelated samples loses contrast, and the variance-preserving fix.
- Inigo Quilez, [Domain warping](https://iquilezles.org/articles/warp/).
