## How it works

Cartoon fire is three decisions: flat colour, hard edges, and animation that holds each drawing for several frames. All three are easy for a distance field, so the whole picture is one: a fullscreen pass (`toon-fire.wgsl`) that evaluates a signed distance to the flame and turns it into paint, then the tail.

**Shape.** One to three teardrops from `flame.wgsl` (`flame_sd_teardrop`): a tall one in the middle and, with `side flames` above zero, two shorter ones leaning outward, joined with a smooth minimum so they meet in a rounded valley rather than a crease.

**Bands.** Each band is the same field pushed inward by a fixed inset, so every band is a smaller flame inside the last: outline, outer, middle, inner, core. The insets shrink toward the base, which makes the inner flames sit low and share the foot of the outer one, as drawn flames do. A band's edge is `sd_coverage(d, 1.5 px)`: a hard edge, anti-aliased analytically from the distance, with no derivative functions (they are not allowed after an early return). The colours are five uniforms, not a ramp texture: an anti-aliased edge needs the two flat colours either side of it, and a bilinear fetch across a step in a ramp gives an edge whose width depends on how fast the heat changes there.

**Motion.** Two fetches of the shared baked noise tile:

- one along a vertical line, three slow values per height (one channel per tongue), which bends each tongue more toward its tip and not at all at the base;
- one over the flame, which pushes each band's edge in and out as it rises (one channel per band, so the inner flames do not copy the outline), again more toward the tip. Where it pushes past the tip it pinches off a lick.

Both are read from mip level 3 of the tile, where the fine octaves have been averaged away: that is what makes the shapes bold instead of frilly. The blend between texels is eased (a smoothstep on the fractional texel position, then one bilinear fetch), because plain bilinear filtering of a magnified texture has a crease along every texel edge and a hard threshold turns each crease into a corner in the outline.

**Stepped animation.** `stepped.ts` keeps two clocks. The animation runs on a smooth one (`phase`, advanced by `delta × speed` every frame); the shader is given `shown`, a copy of it that is refreshed `drawings per second` times a second of real time and held in between. Every display frame is still rendered, from the held value, so nothing is skipped: at 60 Hz and ten drawings a second each drawing is on screen for exactly six frames. Because the held value is the smooth phase, changing the rate or the speed never makes the animation jump, and a rate of 0 turns the stepping off without moving it. `tests/epic4-d.test.ts` checks the hold lengths at 60 and 120 Hz, that the picture is identical between drawings, and that it changes at each one.

**Extras.** Two logs (capsules with a lighter top and a sawn end), drawn over the foot of the flame, and a few diamond sparks that leave the flame, drift and shrink. Where each spark is this drawing is worked out in JavaScript (`sparks.ts`) and handed over as a small uniform array, so a pixel only measures its distance to them. Neither needs a fetch.

**Paint, not light.** The pass writes premultiplied colour with real coverage in alpha. The tail's default `luminance` mode takes the larger of that alpha and the brightness, so the shapes cover the page completely: on a light page the picture is exactly the same flat colours it is on a dark one.

**Skipping empty air.** Before either fetch, `tf_near` tests the pixel against an outline of everywhere the flame could be with all its sway and licks. The bound is exact rather than a guess: level 3 of the tile was read back and stays inside 0.17 to 0.86, which fixes the largest bend and the largest lick. After the first fetch the bent flame's distance is known, and the second fetch is skipped beyond the largest lick. Renders with and without both tests, at the extreme ends of every parameter, differ by at most one 8-bit step in a handful of pixels.

## Cost

GPU time: not measured yet. Indicative readings: the HUD in headless Chrome showed 1.3 to 1.7 ms for one frame at 1920 × 1080 on an Apple M1 Max over five runs, tail included, while other work was using the GPU; the flame pass on its own read about 0.4 ms. The HUD's floor on this machine is about 1.2 ms, so the readings say "a little above the tail alone" and not much more.

Counted from the code, at the defaults on a 1920 × 1080 canvas:

- **Passes:** one fullscreen pass, then the tail.
- **Outside the flame's outline (52% of the canvas):** a few compares, plus, in the strip where sparks can be (25% of the canvas), the distance to each of the five sparks (two absolute values and a subtraction each).
- **Where the flame could be (48%):** 1 noise fetch and up to 3 teardrop distances (one square root each).
- **Within a lick of the flame (25%):** 1 more fetch and the band arithmetic.
- **No procedural noise.** The flame itself covers about 10% of the canvas.

Texture memory: nothing of its own beyond the tail's targets; it reads the shared noise tile (about 0.7 MB per device). Cost scales with the size of the flame on screen and hardly at all with anything else; `side flames: 0` saves two of the three distance evaluations.

## Pitfalls

- **Per-step change is the flash risk.** A large, bright, saturated shape that is redrawn ten times a second is what a flash analyser looks for. The first version let the noise climb 1.5 cells a second: at ten drawings a second a feature moved 60% of its own size per drawing, side tongues appeared and vanished between two drawings, and it looked like a slideshow. The noise now climbs 0.7 and 0.5 cells a second (a feature moves about a quarter of its size per drawing). Measured with the flash analyser (which treats the canvas as a 1920 × 1080 picture): at the defaults no cell completes more than one flash a second; the other presets at most two; the frame's mean luminance moves by 1.4% of white. With `speed` at 3 and twelve drawings a second individual cells reach three, the limit, so do not combine a high speed with a large canvas.
- **Work that is the same for every pixel belongs on the CPU.** The first spark loop hashed each spark's seed and took a sine per spark, per pixel, over a quarter of the canvas: more arithmetic than the two fetches. Computing the positions once a frame in JavaScript took the flame pass from about 0.6 ms to about 0.4 ms in the Chrome HUD (indicative, M1 Max, 1080p).
- **The outline is not an even width.** The field is a true distance only before it is bent and pushed, so the ink is thicker in the notches between tongues. It reads as a hand-drawn line, which suits the look; a perfectly even stroke would need the gradient of the final field.
- **On a dark page the dark outline disappears** into the page and leaves a thin dark gap between the flame and its glow. Set `outline` to 0 there, or enjoy the gap.
- **Bloom fights flatness.** The bands are bright (the red channel runs from about 2 to 6), so the default tail bloom would wash a glow over them. This effect lowers the default to 0.3. At 0 it is pure paint; much above 0.5 the bands stop looking flat.
- **Band colours are chosen through the tonemap.** They are linear radiance, and the tail's curve shows any channel above about 3 as full, so a band's hue is set by its smaller channels. Change `exposure` and the palette shifts.
- **Sparks have no outline**, so the pale ones are faint on a white page.
- **The logs are not lit by the fire.** They are flat brown: fine for an icon, and wrong the moment the scene around them is shaded.
- **Very small sizes.** Below about 40 pixels of flame height the inner bands are a pixel or two wide. Use `bands: 2` or 3 and a thicker outline, as the flame-icon preset does.

## When to use it

A game UI, an illustrated or playful page, an icon that has to read at small sizes and on white: anywhere realistic fire would look out of place or would not survive the background. It is the one flame in this set that is fully at home on a light page, because it is opaque paint with an outline rather than light. It is Tier A (provisionally: no integrated GPU has been measured).

If the flame never needs to react to anything, an SVG or a sprite sheet of the same drawing is a perfectly good way to ship it, and costs nothing at run time; what the shader adds is that it never loops, takes any palette, and scales to any size. For fire that should read as hot rather than drawn, use one of the ramp-shaded flames instead (`noise-flame`, `candle`, `torch`).

## References

- Inigo Quilez, [2D distance functions](https://iquilezles.org/articles/distfunctions2d/) and [Smooth minimum](https://iquilezles.org/articles/smin/): the teardrop (an uneven capsule) and the join between tongues.
- Inigo Quilez, [Improved texture interpolation](https://iquilezles.org/articles/texture/): easing the fractional texel position so a magnified texture has no creases.
- Frank Thomas and Ollie Johnston, _The Illusion of Life: Disney Animation_ (1981): animating on twos, holding each drawing for two or more frames.
- W3C, [WCAG 2.2, Understanding SC 2.3.1](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html): the flash thresholds the slow rise is there for.
- `docs/compositing-study.md`: coverage, luminance alpha, and why paint reads on a light page where light does not.
