## How it works

Additive particles need no sort: light adds up in any order. Smoke hides what is behind it, so its
puffs must be composited back to front, or the order has to be made not to matter. This scene draws
the same puffs four ways, with the same colours, so the blending is the only difference.

**The puffs** (`puffs.wgsl`, one compute pass). 2 048 slots by default, each a pool entry that
replays a fixed life from its own phase, with each life's randomness hashed from (slot, cycle): a
GPU particle pool without state to carry. A quarter are flame puffs (1 s, from a disc at the base,
accelerating up and inwards, cooling along the blackbody curve from 2000 to 1150 K, alpha 0.05);
the rest are smoke puffs (7 s, born above the flame with a little glow left, rising fast then
slowly, spreading, leaning in a breeze and growing to about 1.3 units). Puffs born at the same moment
leave in a similar direction and the fire "breathes" (dense puffs in surges, thin ones in lulls), so
the column rises as billows. Smoke is soot-coloured (`smoke_albedo`), lit by a dim sky and by the
fire below (`smoke_fire_falloff`); no self-shadowing, since every mode gets the same colours. The
first 14 slots are lanterns on a ring around the fire: pure emitters that hide nothing but must be
hidden by smoke in front of them. The camera orbits at 0.1 rad/s, so the depth order keeps changing.
The scene is cleared to transparent and the smoke writes real coverage, so it works over the page.

**The modes** (`draw.wgsl`: one vertex stage, a fragment entry and a pipeline per blend):

- `additive`: colour times alpha plus emission, blended one + one. Order independent, no sort.
- `unsorted`: premultiplied "over" (one, one-minus-src-alpha) in buffer order.
- `sorted`: the same, but instance `k` draws particle `order[k]` from the GPU depth sort,
  `src/gpu/particles/sort.ts`. It makes a key per particle from its view depth (the float's bits made
  order-preserving and inverted, so the farthest sorts first), then sorts (key, index) pairs with an
  LSD radix sort of 4-bit digits: per digit a histogram per 1024-element tile, an exclusive scan of
  the digit-major histogram (`scan.ts`, ported from Water Temple), and a stable scatter that ranks
  each tile's elements with one packed Hillis-Steele scan of all sixteen bins at once. 32-bit keys
  are exact and take 8 digit passes; 16-bit keys (depth quantised between near and far) take 4. A
  bitonic network and a temporal block sort are there to compare. All of it is one compute pass with
  a uniform slot per dispatch (dynamic offsets): one `writeBuffer` and one timestamp pair a frame.
- `oit`: weighted blended order-independent transparency (McGuire and Bavoil 2013),
  `src/gpu/particles/oit.ts`. Each fragment adds premultiplied colour times a weight to an
  `rgba16float` accumulation target and multiplies an `r16float` revealage by (1 - alpha); a
  fullscreen composite draws accum.rgb / accum.a over the scene with coverage 1 - revealage.

**The weight** is the paper's equation 7, `alpha * clamp(10 / (1e-5 + (z/5)^2 + (z/200)^6), 0.01, 3000)`
with z the view depth in scene units. Here the puffs are 6 to 17 units from the eye, which equation
7 weighs from about 7 down to 0.9: the nearest smoke counts eight times the farthest. Equation 9
sits on its 3000 clamp anywhere nearer than about 25 units and equation 10 (on the depth-buffer
value) is flat at its floor beyond a few units with near 0.1 and far 90, so neither gives this
scale any depth cue; equation 8 behaves like 7. The `OIT weight` and `OIT depth scale` controls
switch them.

**Emission is added, not weighted.** A flame puff is bright and nearly transparent; as a weighted
layer its colour is divided by a tiny alpha, and at alpha 0 it is lost. So emission goes to a third
target, unweighted, and the composite adds it times `mix(1, revealage, occlusion)`. WBOIT throws
away the order, so whether the smoke at a pixel is in front of a flame (and should hide it) or
behind it (and should not) is unknown: `occlusion` 0 lets all fire shine through all smoke, 1 dims
it by all the smoke at its pixel, front and back. 0.5 had the lowest mean error here (below).

`right half` shows a second mode beside the first, each drawn with a scissor rectangle.

## Cost

GPU time: not measured yet (no `npm run study` run). Indicative readings, M1 Max, 1920 x 1080,
another agent sharing the GPU throughout.

Dawn under Node, slope method (`PSORT_FRAME=1 npx vitest run tests/particle-sort.test.ts`), the
cost of one more frame including the tail:

| puffs            | additive | unsorted | sorted (radix) | sorted (bitonic) | oit     |
| ---------------- | -------- | -------- | -------------- | ---------------- | ------- |
| 2 048 (default)  | 2.0 ms   | 1.8 ms   | 1.8 ms         | 2.1 ms           | 2.8 ms  |
| 32 768 (`dense`) | 9.9 ms   | 10.4 ms  | 9.2 ms         | 9.6 ms           | 13.9 ms |

Chrome's HUD (`hud-1080p` view, camera held still with `p.orbit=false`, median of four or five
loads, range in brackets): at 2 048 puffs additive 5.5 ms (5.0 to 6.3), unsorted 4.7 (3.9 to 5.4), sorted 5.7
(4.5 to 6.2), oit 3.8 (3.1 to 6.4); at 32 768 additive 5.0, unsorted 4.7, sorted 5.3, oit 5.3. The
ranges overlap, so Chrome cannot rank the modes on this machine today; with the camera orbiting,
the reading also follows how much of the screen the plume covers at the moment it is taken.

What costs what:

- **The draw is the cost**: fill. 2 048 soft puffs up to 1.3 units across, at 1080p, are dozens
  of layers deep in the column, and the cost follows puff size times count times resolution. Puffs
  fainter than 1.5% opacity (the oldest, which are also the biggest) are not drawn at all.
- **The sort is noise beside it**: 0.25 to 0.32 ms in Chrome's HUD (the browser's per-pass floor)
  at 2 048, 0.15 to 0.67 at 32 768. Measured alone on Dawn (`PSORT_BENCH=1`, median of five runs):

  | method                   | 16k     | 64k     | 256k    | 1M      |
  | ------------------------ | ------- | ------- | ------- | ------- |
  | radix, 32-bit keys       | 0.22 ms | 0.33 ms | 0.81 ms | 1.29 ms |
  | radix, 16-bit keys       | 0.09 ms | 0.11 ms | 0.26 ms | 0.96 ms |
  | bitonic                  | 0.18 ms | 0.42 ms | 1.14 ms | 3.10 ms |
  | temporal, 2 block passes | 0.07 ms | 0.11 ms | 0.33 ms | 1.22 ms |

  Dawn's timestamps tick every 0.066 ms, so the smallest figures are at the floor.

- **OIT costs a millisecond at the default count and four at 32 768** on Dawn: each fragment writes
  three blended targets (18 bytes) instead of one (8), plus a fullscreen composite.

Memory: the OIT targets are 18 bytes a pixel (accum 8, revealage 2, emission 8), 37 MB at 1080p,
allocated only while an OIT view is on screen (10 bytes without the emission target, 9 with an
`r8unorm` revealage). The HUD's texture estimate at 1080p reads 21.8 MB for the default view and
57.4 MB with an OIT half on screen. The sort holds 16 bytes per slot of capacity (keys and indices, double
buffered, padded to a power of two for bitonic): 1 MB for 65 536 slots, plus a 4 KB histogram and
16 KB of uniform slots. The puffs are 48 bytes a slot (3 MB at 65 536) plus a 256 KB identity order.

Tier B: the default (`sorted`) read between 3.2 and 5.7 ms (medians of separate runs) in Chrome on
this machine, inside B's 6 ms; B is an integrated-GPU budget, so the label is provisional. Bundle
size: not measured yet.

## Pitfalls

What each mode looks like, measured against `sorted`, which is exact for camera-facing quads (each
lies in one plane of constant view depth). `PSORT_STUDY=1 npx vitest run tests/particle-sort.test.ts`
renders all four at 640 x 360 at five moments over a dark page and compares 8-bit pixels inside the
plume; "pops" is the share of plume pixels whose second difference over three consecutive frames
exceeds 12 levels (steady motion cancels in it, a jump does not).

| mode     | mean error  | pixels off by > 16 | pops  |
| -------- | ----------- | ------------------ | ----- |
| additive | 45.8 levels | 47.4%              | 0.75% |
| unsorted | 2.1         | 0.82%              | 0.79% |
| sorted   | 0           | 0                  | 0.79% |
| oit      | 2.1         | 1.11%              | 0.80% |

- **Additive: smoke turns into glow.** The column is a pale pink light, half its pixels more than
  16 levels off, and over a light page it all but disappears (light adds nothing to coverage, so
  only the luminance alpha shows it, as a pink haze). It saves nothing measurable at this count.
- **Unsorted: wrong occlusion where colours differ.** Here the buffer order is the pool's slot
  order, fixed for each puff's life, so the error is steady rather than a shimmer: wrong occlusion
  that slides as the camera turns. It shows at the fire-lit underside and at the lanterns, which
  are first in the buffer, so the smoke covers them even when they are in front. With the fire and
  lanterns off, a one-colour column is almost right (mean 2.0 levels, 0.07% over 16): order barely
  matters for uniform smoke. A system that compacts its alive list with atomics reorders every frame,
  and then every overlap flips at random: that is the shimmer Water Temple's billboards describe, not
  built here.
- **Sorted pops in principle, not measurably here.** When two puffs swap depth the composite
  changes in one frame, which is also the correct result for flat cards. The second-difference
  measure finds no more jumps than unsorted or OIT (0.79% against 0.79% and 0.80%; 0.034% against
  0.031% and 0.040% with the fire off): soft, noisy puffs hide the swaps, and the flame's motion
  dominates.
- **OIT: emission and colour bias.** Mean error matches unsorted, but it has more large errors
  (1.1%; 2.3% against unsorted's 1.5% in `heavy smoke`). The visible failure is emission: a lantern
  behind the column shows through it, dimmed only halfway, and one in front is dimmed by smoke
  behind it. `occlusion` 0 gives a mean error of 3.6 levels (1.9% over 16), 1 gives 3.5 (0.6%), 0.5
  gives 2.1 (1.1%). The colour bias is the weighted average: a near puff never fully wins. The tests
  pin it: an opaque red layer over a 0.6-alpha green one at the same depth composites to 0.735 red
  and 0.265 green, because the weight carries alpha and the colour is premultiplied, so layers mix
  by alpha squared. The weight equation hardly matters here (eq. 7 2.14, none 2.18, eq. 8 at double
  depth scale 2.12): the smoke's colours are too alike for the weighting to have much to choose.
- 16-bit sort keys clamp outside [near, far]: everything behind the camera ties.
- The accumulation target is half float: colour times weight times layers must stay under 65504.
  Equation 8 near the eye (weight 1250 at z = 2) overflows after a few dozen layers of colour 2;
  the composite clamps, which shows as a flat colour. Keep HDR emission out of the weighted sum.
- `r8unorm` revealage rounds at every blend, about half a level a layer over dozens of layers;
  `r16float` is the default.
- A `DepthSort` uses one uniform buffer of per-dispatch slots: encode it once per `queue.submit`.
- WGSL: `step` is a built-in function name (the uniform is `pstep`), and `TAU` already exists in
  `math.wgsl`, which `smoke.wgsl` pulls in: redeclaring it fails to compile.
- Chrome's dense readings came out lower than Dawn's, the reverse of every earlier epic; not
  explained, which is one more reason to read the HUD as indicative only.

## When to use it

For fire with smoke on a web page: draw what emits (flames, embers, sparks, lanterns) additively
and the smoke with premultiplied alpha after a GPU radix sort with 16-bit keys. It is exact for
camera-facing puffs, costs a fraction of a millisecond at any count a page uses, and needs no extra
targets. That is the `sorted` mode, and the default here.

Weighted blended OIT bought nothing in this scene: it costs a millisecond more at 2 048 puffs and
four more at 32 768 (Dawn), 37 MB of targets at 1080p, and its error is no smaller than unsorted's,
with lights showing through smoke. Reach for it when there is no per-object order to sort by
(transparent meshes mixed with particles, intersecting volumes), or where compute is missing: it is
render passes only, so unlike the sort it can be ported to WebGL2 with float render targets.

Unsorted alpha is a defensible fallback for thin smoke of one colour, which it gets within a couple
of levels, but not for smoke over lights or fire. Additive is right for fire and wrong for smoke.

This is a study scene (Tier B, provisional), not something to ship; the sort and OIT modules plug
into any particle buffer of vec4 positions.

## References

- Morgan McGuire and Louis Bavoil, [Weighted Blended Order-Independent Transparency](https://jcgt.org/published/0002/02/09/), JCGT 2(2), 2013 (equations 7 to 10)
- Morgan McGuire, [Implementing Weighted, Blended Order-Independent Transparency](https://casual-effects.blogspot.com/2015/03/implemented-weighted-blended-order.html), 2015
- Mark Harris, Shubhabrata Sengupta and John D. Owens, [Parallel Prefix Sum (Scan) with CUDA](https://developer.nvidia.com/gpugems/gpugems3/part-vi-gpu-computing/chapter-39-parallel-prefix-sum-scan-cuda), GPU Gems 3, ch. 39
- Duane Merrill and Andrew Grimshaw, [Revisiting Sorting for GPGPU Stream Architectures](https://doi.org/10.1145/1854273.1854344), PACT 2010
- Michael Herf, [Radix Tricks](http://stereopsis.com/radix.html) (order-preserving float keys)
- Ken Batcher, [Sorting networks and their applications](https://doi.org/10.1145/1468075.1468121), AFIPS 1968 (bitonic sort)
- Water Temple, `src/gpu/particles/scan.ts` (ported) and `billboards.ts` (why alpha in a changing order shimmers)
