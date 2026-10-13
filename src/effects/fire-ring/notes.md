## How it works

A flame strip bent round a circle. In a strip, "along" is x and "up" is y; here "along" is the angle round the ring and "up" is the distance from the ring line. Everything else is an ordinary noise flame, drawn in one fullscreen pass (`fire-ring.wgsl`) into the HDR scene target, followed by the tail.

Per pixel the shader works in ring units (the centre is the origin, 1 is half the shorter side of the canvas, so the ring stays round in any box):

1. **Early out.** Further from the ring line than the flames can reach: return nothing. No fetch, no angle.
2. **Where on the ring.** `ring_turn` turns the position into a turn: 0 at twelve o'clock, growing clockwise, 0.25 at three. `ring_lit` says how much of the ring is alight there for the current `progress` (see below).
3. **Noise.** Two fetches of the shared baked noise tile (`getNoiseTexture`, `noisetex.wgsl`). The first layer is read at `u = repeats × turn`, `v = distance from the ring − rise`; the second, which only bends the lookup of the first, wraps one more time round the ring and climbs more slowly, so the tongues shear instead of sliding outward as one sheet.
4. **Flame.** The noise eats a wedge that runs from 1 at the ring line to 0 at `flame length`; what is left is the depth into the flame. The edge of a tongue is red, the body orange, and only the thick of a tongue goes yellow. A hot band `thickness` wide is the ring line itself. The heat goes through one of the six ramps of `ramp.wgsl` (`palette`).
5. **Inner glow.** Inside the ring, a little of the ramp's colour that falls off with the sixth power of the radius, so it hugs the ring and is exactly zero at the centre.

Alpha is left at 0: the tail's `luminance` mode turns brightness into coverage, so the middle of the ring and everything outside the flames is fully transparent and the page shows through.

**The seamless wrap.** The angle jumps from +0.5 to −0.5 turns at six o'clock. The noise tile repeats, so if it is wrapped a _whole number_ of times round the ring, the two sides of the jump are a whole number of tiles apart and a repeating sampler returns the same texel for both: there is nothing to hide. `tongues` is rounded to an integer for that reason. Two more things would otherwise bring a seam back:

- A texture read with `textureSample` picks its mip level from screen-space derivatives, and the derivative of the angle across the jump is enormous: the classic one-pixel line of blurred texels in polar shaders. Here the level is computed from the radius (`log2` of texels per pixel) and passed to `textureSampleLevel`, which also lets the tile shrink toward the centre without aliasing.
- A whole number of repeats makes the pattern repeat that many times round the ring, which the eye finds at once on a circle. The second layer wraps `repeats + 1` times; the two share no period shorter than the full turn.

`tests/epic4-d.test.ts` checks the wrap in numbers: the two sides of the jump are an integer number of tiles apart for every repeat count, and in the rendered picture the pixels either side of six o'clock differ no more than neighbours do at twelve, three and nine (about 9 against 7 8-bit steps when it was written; with the rounding removed, 37).

**Progress.** `ring_lit` lights the arc that starts at twelve o'clock and runs clockwise for `progress` turns. The leading end fades over 0.03 turns and the flames shorten toward it; `tail taper` fades the trailing end over a share of the arc, which turns a spinning arc into a comet. From 0.92 the gap closes smoothly and at 1 the function returns exactly 1 everywhere, so a full ring has no notch where the arc began. `unlit track` draws the rest of the ring as a dull line.

**Spin** turns the lit arc. The flame pattern follows it only up to 2.5 noise cells a second: past that the fire stays where it was lit while the head moves on, as a real trail of fire does, and the tips lean back.

## Cost

GPU time: not measured yet. One indicative reading: the HUD in headless Chrome showed 0.9 to 1.1 ms for one frame at 1920 × 1080 on an Apple M1 Max over five runs, tail included, while other work was using the GPU; the ring pass on its own read about 0.2 ms. That is at the HUD's floor on this machine (a pass that draws almost nothing reads about 1.2 ms), so read it as "too cheap to tell apart from the tail", not as a number.

Counted from the code, at the defaults on a 1920 × 1080 canvas:

- **Passes:** one fullscreen pass, then the tail (bloom chain and output).
- **Outside the flames' reach (55% of the canvas):** a length and a compare, then return.
- **In the flame annulus (36%):** 2 fetches of the noise tile, 1 `atan2`, 1 `log2`, 1 `exp`, two ramp polynomials. No procedural noise anywhere.
- **Inside the ring (9%):** 1 `atan2` and one ramp polynomial for the glow. No fetch.

Texture memory: nothing of its own. It reads the shared noise tile (about 0.7 MB, one copy per device, shared with every other effect); the rest is the tail's targets. Cost scales with the area of the annulus, so with `radius × flame length`; `direction: both` doubles the annulus.

## Pitfalls

- **`tongues` must be a whole number.** It is rounded before use. Feed the shader 3.5 and the seam is back, at six o'clock.
- **`flame length` is the longest a tongue can be, not the typical one.** With the default `roughness` most tongues end at a third to a half of it. Lower `roughness` for a fuller, longer flame; raise it for sparse, ragged ones.
- **Inward flames run out of room.** With `direction: inward` a `flame length` larger than the radius converges on the centre, where one noise cell covers very few pixels. The level-of-detail term keeps it from aliasing, but it turns to mush: keep the length under about 0.7 of the radius.
- **The first version was white.** Mapping "how far inside the flame" straight to heat made a solid pale band with a ragged edge; separating where the flame is (the eaten wedge) from how hot it is (the depth left over) is what gave it a red edge and an orange body.
- **A spinning arc and the flash limit.** Carrying the noise pattern round with a fast arc made whole tongues sweep past every point of the ring several times a second: the flash analyser rated the loader preset "high" for saturated red (4 cells over the limit). Capping how fast the pattern is carried brought it to "low". With `spin` and `speed` both at their maximum it is still "low" by area, but individual cells do exceed three flashes a second; keep such a ring small.
- **The inner glow does not survive a light page.** It is faint light, and light on paper is only a tint. The flames and the ring line read; the glow shows as a pale orange wash.
- **The underlay shows on a light page** as a soft grey halo round the ring (it is the bloom, used as a mask). Set `underlay` to 0 for a cleaner ring on white, at the cost of a paler core.
- **Small sizes.** In a 64-pixel loader the tongues are a few pixels long. It still reads as a burning ring, but lower `tongues` to 2 and `roughness` to about 1 so there is something left to see.

## When to use it

Portals, summoning circles, a burning frame round an avatar or a badge, a loader, a determinate progress ring. It is Tier A (provisionally: no integrated GPU has been measured), costs two texture fetches in a thin annulus and nothing elsewhere, and is transparent in the middle, so the thing it frames can be ordinary page content under the canvas.

For a progress indicator, drive `progress` from your own state and leave `spin` at 0; the `unlit track` shows how far there is to go. For an indeterminate loader, fix `progress` near 0.4 and let `spin` carry it round.

Reach for something else when the flame should follow a shape that is not a circle (a flame strip along a path, or the fire UI effects of Epic 9), or when the ring is large and central enough to deserve real flame motion (the fluid effects of Epic 6).

## References

- Inigo Quilez, [Texture repetition](https://iquilezles.org/articles/texturerepetition/): why one tile repeated shows, and layering as the cure.
- Inigo Quilez, [Making a shader: tunnel](https://iquilezles.org/articles/tunnel/): the derivative discontinuity of `atan` in polar texture lookups, and fixing it with explicit gradients or levels.
- W3C, [WGSL: `textureSampleLevel`](https://www.w3.org/TR/WGSL/#texturesamplelevel), the explicit-level fetch that is legal after an early return.
- W3C, [WCAG 2.2, Understanding SC 2.3.1](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html), the flash and red-flash thresholds the spin cap is there for.
- `docs/compositing-study.md`: why luminance alpha is the default over the page, and what an underlay does on a light one.
