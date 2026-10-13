## How it works

Fire is not only something to look at: it is the light in the scene. This effect is the lighting half on its own. A dark stone page carries a few cards, one or two small flames wander through the gutters between them, and everything else in the picture is what those flames light: the relief of the floor, the bevelled card tops, and the shadows the cards throw. The maths lives in the shared chunk `firelight.wgsl`, so later effects (fire that lights the page's real DOM cards) can call the same functions.

There are two passes before the tail.

1. **Bake the ground** (`ground.wgsl`, once per resize). A flagstone floor as a height field: Voronoi slabs with grooves between them, a level and a lean per slab, fbm wear and grain. The pass writes the height's gradient, an albedo shade and a per-slab value into an `rgba16float` texture the size of the canvas. The floor never changes, so none of that noise is paid for again.
2. **Light** (`fire-light.wgsl`, every frame, full resolution). One texel fetch gives the ground. A loop over the cards (rounded-rectangle SDFs) finds the nearest one and how much of the pixel it covers; a card pixel gets a flat top with a rounded shoulder, built from the SDF's outward direction, and some "text". Then, per light: falloff, N.L against the normal, a sheen lobe, and for ground pixels the shadow term. The flame itself is a small teardrop drawn at the light, far brighter than anything it lights, so the tail's bloom makes it glow.

**Falloff.** Inverse square, windowed so it ends (Karis's form), and normalised so it is 1 under the light:

```wgsl
fn firelight_falloff(d: f32, radius: f32, core: f32) -> f32 {
  let c2 = max(core * core, 1e-10);
  return firelight_window(d, radius) * c2 / (d * d + c2);   // window = saturate(1 - (d/radius)^4)^2
}
```

`core` is the light's height above the page: the light hovers, so its distance never reaches zero, and the same number that softens the hot spot also gives normal-mapped surfaces a sensible 3D light direction, `normalize(light.xy - p, height)`. Under the light a flat receiver gets exactly `intensity`; at distance `d` it gets `height^3 / (d^2 + height^2)^1.5` times the window. The window is exactly 0 at `radius` and beyond, so a light can be culled by its radius without a visible rim.

**Area lights.** The disc is the point light with `core^2 = height^2 + a^2 / 2`: the same power, spread over a wider, dimmer hot spot. Against the exact average over a disc under its centre it is 0.4% low at `a = height / 2`, 4% low at `a = height` and 17% low at `a = 2 height`. The line light integrates the point kernel along the segment in closed form (one `atan2`) and aims at the point that bisects the angle the segment subtends; it matches a 256-sample average to 0.2% and becomes the point light as its length goes to zero. Evaluating a line at its nearest point instead, the usual shortcut, is not normalised: it is 27% too bright under the middle of a line whose half length equals the height and 3.6 times too bright at five times the height. This effect uses the disc (the `softness` control is its radius); the line is in the chunk and in the tests.

**Shadows.** The cards are the occluders. Five ways to shade the same pixel were built and compared; the `shadows` control switches between them.

| `shadows`        | Method                                                  | Per ground pixel, per light | Result                                                        |
| ---------------- | ------------------------------------------------------- | --------------------------- | ------------------------------------------------------------- |
| `none`           | no shadow term                                          | nothing                     | cards look pasted on; the page reads as flat                  |
| `hard`           | exact segment against rounded box                       | 5 box tests, no loop        | correct outline, aliased edge, same sharpness at any distance |
| `soft`           | analytic penumbra                                       | 5 projections, no loop      | smooth, widens with distance, no banding or leaks             |
| `traced`         | sphere-traced, signed, with closest-approach refinement | up to 32 steps of 5 SDFs    | same penumbra within a few percent, faint stripes             |
| `traced-classic` | Quilez's original `min(k h / t)`                        | up to 32 steps of 5 SDFs    | outer half of the penumbra only: fatter, harder shadows       |

The analytic method works in the frame of the ray from the receiver to the light: `t` along it, `l` across it. A point at `(t, l)` hides the light directions `w = l / t`, and a source of radius `R` at distance `D` spans `|w| <= R / D`. A card is a convex box, so what it hides is one interval of `w`: clip its four edges to the part in front of the light, take the smallest and largest `l / t` over the clipped ends (widened by the corner radius), and the hidden fraction of the source is the overlap of two intervals, taken through a smoothstep so the source has a soft-edged profile. Penumbrae of different cards multiply.

Measured on the GPU for one card (`tests/smoke-light.test.ts`): the analytic shadow is half lit exactly on the geometric edge and its 10% to 90% width is `1.22 R t / g` (receiver `t` behind an edge that is `g` from the light) to within 0.5%. The traced version puts the edge 0.002 to 0.004 inside that and is 4 to 8% wider; inside the penumbra its mean error is 0.014 for `R = 0.08` and 0.05 for `R = 0.01`, with single samples up to 0.27 off. In this scene at 960 by 540 the two pictures differ by at most 14 of 255, as stripes across the penumbrae. The classic trace has 0.53 times the penumbra width and its half-lit line sits 0.014 to 0.039 outside the true edge.

**Recommendation for later effects: `soft`, the analytic penumbra.** For rounded rectangles, which is what DOM cards are, it is the most accurate of the five and has no per-pixel loop over distance, and the hard test it would replace costs about the same. Keep the trace for occluders that are not boxes (glyphs, circles, a distance texture): `firelight_penumbra` and `firelight_penumbra_resolve` are the per-step maths for an effect's own march.

**Shadows that end.** In classic 2D lighting an occluder is a wall and its shadow runs to the light's rim. A card is not a wall. If it is `e` tall and the light is `h` up, a ray from the ground only meets it within the first `e / h` of the way to the light, so every shadow function takes a `reach` and clips the occluder to it. The shadow of an edge `g` from the light is then about `g e / (h - e)` long, and its tip is soft because the flame has height too. `shadow length` is `e / h`; at 1 the cards are walls.

**Flicker.** Each light's intensity follows the shared band-limited signal in `flicker.wgsl` (story 3.6): 3 knots a second, a slow swing of up to `0.6 × flicker` of full scale (typical swings are about a quarter of that), and a 3% shimmer. Its caps keep a light under the WCAG flash limit by construction, both lights share one rate so their sum is covered too, and the signal runs on a clock that never goes faster than real time whatever `speed` says. Measured with the flash analyser (`tests/flash.ts`) over ten seconds: no flash of the whole frame and no area over the threshold; the frame's mean luminance stayed within 1.2% of full white at the defaults and 2.8% with `flicker` at 1. The flame shapes still use two bands of local value noise.

**Wiring real DOM cards.** The mock layout in `index.ts` is a list of `ObstacleRect`, the type `trackDomRects` (`src/gpu/dom-rects.ts`) reports. `toOccluder` turns one into the chunk's form: centre `((x + width / 2) * aspect, y + height / 2)`, half size `(width / 2 * aspect, height / 2)`, corner radius unchanged. Two `vec4f` per card go into the uniform block, at most `FIRELIGHT_MAX_OCCLUDERS` (8).

## Cost

GPU time: not measured yet.

Passes per frame: one fullscreen light pass at canvas resolution, then the tail (bloom chain from half resolution, output pass). The ground bake is one more fullscreen pass, run only when the canvas is resized.

Per pixel, the light pass does one texel load and 5 rounded-box SDFs to find the nearest card. Then per light: 4 integer hashes for the flicker, the disc falloff, N.L and a sheen lobe. Ground pixels add the shadow term:

- `soft`: one SDF and a cull test per card (about 40 arithmetic operations when the light's cone misses the card, about 150 when it touches it). No trace steps.
- `hard`: per card, a slab test, two box SDFs and four point-to-segment distances (about 100 operations). No trace steps.
- `traced`, `traced-classic`: up to 32 steps, each one SDF per card, so up to 160 box SDFs per light and 320 with two lights. A ray stops early when it is fully shadowed.

Card pixels skip the shadow. The flame is evaluated only in a small box around each light (one gradient-noise and two value-noise lookups there). The bake costs 5 height evaluations per pixel, each a Voronoi lookup, three gradient-noise samples and 8 octaves of fbm, once.

Texture memory: two `rgba16float` targets at canvas size (the scene and the baked ground, 8 bytes a pixel each) plus the bloom levels. Cost scales with pixel count, with the number of lights, and for `soft` with the number of cards a light's cone actually touches.

The flicker is a per-light constant computed per pixel. It is there so the shared chunk can replace it in place; computing it once in TypeScript and passing it as a uniform would save those hashes.

## Pitfalls

- **Aspect ratio.** Lengths are in image heights. On a portrait canvas that made the flames and their pools as wide as the page, so `index.ts` scales the light's lengths, the slab size and the card details by `min(1, aspect)` and switches to a stacked layout below 0.9.
- **The refinement in the trace can make things worse.** Estimating the closest approach from two samples' distance circles is only valid when the second sample is one sphere-tracing step from the first. Applied after a forced longer step it reported near-zero clearance beside flat edges and put dark dips of up to 0.4 into the penumbra. It is now applied only to true sphere-tracing steps, which brought the worst dip to 0.02.
- **Running out of steps leaks light.** A ray that skims a long edge takes tiny steps. The trace never steps less than an even share of what is left, so it always arrives; the price is that it can step over the thinnest part of a rounded corner, which is where its stripes come from.
- **The classic trace is not wrong, it answers a different question.** It treats the geometric shadow as fully dark and adds a penumbra outside it. Shadows come out larger and their soft part half as wide as the light's size implies.
- **Overlapping penumbrae multiply.** Where two cards' penumbrae cross, the analytic result is the product of the two, slightly darker than the true union. Not visible in this layout.
- **A light inside a card.** With walls, a light inside an occluder lights nothing but that card's top. The flames are pushed out of the cards in `index.ts`; an effect that lets the visitor drag a light needs the same.
- **Cards do not shadow each other's tops.** They are all the same height, so that is correct here, and the shadow call is skipped on card pixels. Cards of different heights need the `exclude` argument and a reach per pair.
- **A bright orange is not available.** Through the tail's filmic tonemap anything much above 1 turns yellow and then white, so only the flame's dim rim stays orange, and a page lit to about 0.5 looks warmer than one lit to 1. The stone and the cards have albedo 0.13 to 0.22 for that reason.
- **Relief is resolution dependent.** The gradient is a one-pixel central difference, so the finest grain sharpens with the canvas.
- **Opaque.** The effect fills its box with its own dark page. As an overlay on a light page the same light would have to darken the page everywhere it does not reach, which is the underlay mode of the tail and has not been tried here.

## When to use it

Tier A in intent: one fullscreen pass with no per-pixel noise and, with `soft`, no loops over distance; GPU time not measured yet. Reach for it when fire shares the screen with things it should light: cards on a dark page, a top-down scene, a cursor that carries a torch. The chunk is the reusable part: take `firelight_disc` or `firelight_point` for the falloff, `firelight_shadow_soft` with the page's own cards, `firelight_tint` for the colour.

It does not fit when the occluders are not rectangles (use the per-step functions and march your own SDF, at the traced cost), when there are more than 8 of them in view (cull to the nearest 8, or bake an occluder mask), or when the page is light, where a multiply or underlay pass is the missing piece. Where WebGPU is unavailable, a radial-gradient glow and CSS drop shadows offset away from it carry most of the idea.

## References

- Brian Karis, [Real Shading in Unreal Engine 4](https://blog.selfshadow.com/publications/s2013-shading-course/karis/s2013_pbs_epic_notes_v2.pdf) (SIGGRAPH 2013): the windowed inverse-square falloff and representative-point area lights.
- Inigo Quilez, [Soft shadows in raymarched SDFs](https://iquilezles.org/articles/rmshadows/): the `min(k h / t)` penumbra and the improved version after Sebastian Aaltonen.
- Inigo Quilez, [2D distance functions](https://iquilezles.org/articles/distfunctions2d/): the rounded box.
- Sebastian Lagarde and Charles de Rousiers, [Moving Frostbite to Physically Based Rendering](https://seblagarde.wordpress.com/2015/07/14/siggraph-2014-moving-frostbite-to-physically-based-rendering/) (SIGGRAPH 2014): area-light normalisation.
- W3C, [WCAG 2.3.1 Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html).
