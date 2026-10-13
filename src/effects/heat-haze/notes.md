## How it works

Hot air is slightly less dense than the air around it, so it bends light slightly less. A rising column of it is a weak, lumpy, moving lens, and what you see through it wavers. This effect fakes that in screen space: it draws a backdrop into a texture, and then reads the texture back at coordinates nudged by an animated noise field, wherever a heat mask says the air is hot.

There are two passes of its own, plus the tail.

1. **Backdrop** (`backdrop.wgsl`), drawn once, and again only when the canvas is resized or the `backdrop` parameter changes. It writes a wireframe page (greeked text, rules, a gridded figure), the same page on paper, or a test chart, into an `rgba8unorm-srgb` texture at canvas size. `generateMipmaps` then fills its mip chain. Everything in it is a straight edge, because straight edges are what make refraction easy to judge.
2. **Haze** (`heat-haze.wgsl`), every frame, into the HDR scene target. Per pixel it computes the heat mask, turns it into an offset, samples the backdrop there, and draws the heat source over the result.

The offset comes from the shared chunk `src/wgsl/haze.wgsl`. Light bends along the gradient of the refractive index, so the chunk uses the analytic gradient of two octaves of gradient noise (`gnoise_3d_d`) as the direction to push the texture coordinate. The noise cells are three times taller than wide, which makes the gradient mostly horizontal: vertical edges waver, horizontal ones barely move, and the field shows as fine vertical streaks. That is the look of real shimmer, and it is the difference from a water ripple, which pushes equally in every direction.

```wgsl
let q = vec3f(p.x * scale, (p.y + rise) * scale / HAZE_STRETCH, boil);
let g = (coarse + fine * 0.7) * vec2f(1.0, 1.0 / HAZE_STRETCH) * 0.7;
return g * inverseSqrt(1.0 + dot(g, g)); // same direction, length squashed below 1
```

`rise` is how far the air has climbed and `boil` is the phase of the churn in place; both are accumulated from `time.delta` in `index.ts`, so changing the speed never makes the pattern jump. The field is a function of `p.y + rise` exactly: what is at a pixel now was that far below it a moment ago. `tests/haze.test.ts` checks that, and that the offset is bit-exact zero where the heat is zero and never longer than `strength`.

The heat mask is the effect's own (`hz_heat`). It is 1 at the ember bed, falls to 0 at `heat height`, and is broken into columns by two octaves of slowly rising noise, each column reaching a different height. Above the mask the shader reads the backdrop with one unmodified tap, so the unheated part of the picture is the backdrop, untouched.

Two optional refinements ride on the same offset, both in `haze_sample_soft`:

- **Colour split.** Red is displaced a little further than green and blue a little less (three taps instead of one). Air does not really disperse light this much; it is there because a faint fringe on an edge reads as "looking through something".
- **Softening.** The taps read a blurrier mip level where it is hottest (`blur` mip levels at full heat). The effect passes heat squared, which keeps the softening close to the source.

The ember bed and the low flames are a stand-in heat source with a small local colour ramp (`hz_glow`): Voronoi cells for coals glowing in the gaps, and noise minus a height ramp for the tongues. They are the only thing in the scene above 1.0, so they are the only thing the tail blooms. The `view` parameter replaces the picture with the heat mask or with the offset field (red sideways, green vertical).

## Cost

GPU time, measured: 1.2 ms per frame at 1920 × 1080 with the default settings, tail included (Apple M1 Max, Dawn under Node; the tail alone reads 0.7 ms, and repeated runs differ by up to about half a millisecond). In Chrome 155 on the same machine the HUD reads 3.2 ms for one frame at 1080p and 60 fps (median of 3 loads) (`docs/studies/browser-check.md`); that figure includes the browser's timing floor. No integrated GPU or phone has been measured. The full table is `docs/studies/epic-3.md`. What can be counted from the code:

- **Passes per frame:** one fullscreen pass, then the tail (bloom chain and output). The backdrop pass and its mip chain run only on a resize or a change of backdrop.
- **Per pixel, above the heat:** one texture tap, no noise.
- **Per pixel, in heated air:** 4 gradient-noise evaluations (2 for the mask, 2 with derivatives for the offset, roughly 5 plain evaluations of work) and 3 trilinear taps.
- **Flame band** (the bottom quarter): 4 more noise evaluations. **Ember bed** (the bottom tenth): 5 two-dimensional noise evaluations and one Voronoi lookup (9 hashes), and no haze where a coal covers the backdrop.
- With `heat height` at its default the mask is evaluated over about 60% of the picture, so the average over the whole frame is about 4 noise evaluations and 2 to 3 taps per pixel. That count is inside the Tier A rule of thumb (about six noise evaluations per pixel), which is why it was first marked Tier A. Measured in Chrome, a 1080p frame of this scene reads 4.2 ms on the M1 Max, so it is marked Tier B; the backdrop it draws is part of that.

Texture memory, beyond the tail's own targets: the backdrop, 4 bytes per pixel plus a third for mips. At 1920 × 1080 that is 11.1 MB. Cost scales with the canvas area and with `heat height`; `scale`, `strength` and `rise speed` do not change it. Setting `colour split` to 0 does not save the two extra taps in this shader; call `haze_sample` instead of `haze_sample_soft` if you do not want them.

## Pitfalls

- **It needs the pixels behind it, and a canvas does not have the page's.** A WebGPU canvas cannot read what the browser painted under or around it. There is no way to shimmer live DOM text with this technique. Water Temple's backdrop study tested the routes: uploading an image, video frame or another canvas works everywhere; HTML-in-Canvas is experimental and behind a flag or origin trial; rendering HTML through an SVG `foreignObject` failed to decode in the browser tested; re-rendering your own content inside the canvas always works. So this ships over images, video, and scenes or layouts the canvas draws itself. Here the "page" is drawn by `backdrop.wgsl`.
- **Too much blur reads as out of focus, not hot.** The first version softened at 0.8 mip levels across the whole mask and the lower page simply looked blurred. Weighting by heat squared and lowering the default fixed it. In a still frame the displacement has to carry the effect.
- **Frosted glass.** When `strength × scale` goes much above 0.2 (strength as a fraction of the height), neighbouring pixels are thrown past each other and the picture scrambles instead of wavering. The furnace preset sits just under that.
- **Strength is a fraction of the picture height.** At the default 0.3% a 1080-pixel-tall canvas moves pixels by up to 3; a 300-pixel band moves them by less than one and the haze all but disappears. Raise `strength` and lower `scale` for small canvases.
- **It is about motion.** Under `prefers-reduced-motion` the shell holds one frame, and a frozen haze is just slightly wobbly edges. That is harmless, but it is not heat; a site could set `strength` to 0 there and lose nothing.
- **Paper is not white after the tail.** The tail tonemaps, so a backdrop of 0.9 comes out light grey rather than near white, and the bloom's soft knee starts half a unit below its threshold, so page content brighter than 0.5 feeds the glow slightly. The "light page" preset raises the threshold to 1.5 to keep the page out of the bloom. Above the heat mask the scene target is identical with the haze on or off; after the bloom a handful of pixels just above it differ by one 8-bit step.
- **Flames wash out on a light backdrop.** They are added to what is behind them, and paper has little headroom left. The haze itself reads the same on light and dark content; the embers still read because they cover the page.
- **The blur needs mips.** A backdrop without a mip chain, or a sampler without `mipmapFilter: 'linear'`, silently gets no softening. A video backdrop would need its mips rebuilt every frame; set `blur` to 0 instead.
- **Edges.** The sampler clamps, so at the border of the picture an offset repeats the edge pixels. At these strengths that is a few pixels and invisible; it would show with a much larger strength or a backdrop with a bright frame.
- **Long visits.** The rise phase wraps every 256 picture heights (about ten minutes at the default speed) to keep the noise coordinates small. The wrap is a one-frame change of an already restless pattern.
- A shader that fails to compile renders as an empty frame in `npm run shot`, not as an error. `npx vitest run tests/effects.test.ts` prints the compiler message.

## When to use it

Use it for the air above anything hot that the canvas already draws: a flame, an ember bed, an exhaust, a sunlit road in a hero illustration. It is the cheapest way to make a fire feel hot rather than merely bright, and at a few noise evaluations per pixel it can sit on top of most other effects. It also works over a photograph or a video frame uploaded as a texture.

Keep it subtle. The default preset is close to what a real fire does; the furnace preset is as far as it goes before it stops looking like air.

Do not reach for it to distort a page's real text, images or controls: the canvas cannot see them. If the content is an element of your own, an SVG displacement filter (`feTurbulence` into `feDisplacementMap`, applied with CSS `filter`) distorts the element itself with no canvas at all; its cost and browser behaviour were not measured here. If the content is important to read, do not distort it at all.

The chunk on its own (`#include "haze.wgsl"`) is the part to reuse: `haze_offset` to get the displacement from a heat value you already have (a flame's own density, a temperature texture from a simulation), and one of the `haze_sample*` functions to read whatever is behind.

## References

- Water Temple, `docs/backdrop-capture-study.md`: the four ways to get page content into a WebGPU texture, and which of them work.
- W3C, [WebGPU: `copyExternalImageToTexture`](https://www.w3.org/TR/webgpu/#dom-gpuqueue-copyexternalimagetotexture), the sources a texture can be filled from.
- WICG, [HTML-in-Canvas](https://wicg.github.io/html-in-canvas/), the proposal that would let a canvas draw DOM content.
- Wikipedia, [Schlieren photography](https://en.wikipedia.org/wiki/Schlieren_photography) and the [Gladstone–Dale relation](https://en.wikipedia.org/wiki/Gladstone%E2%80%93Dale_relation): light bends along the gradient of refractive index, and the index of a gas follows its density.
- Ken Perlin, [Improving Noise](https://mrl.cs.nyu.edu/~perlin/paper445.pdf) (SIGGRAPH 2002), the gradient noise underneath.
- Inigo Quilez, [Gradient noise derivatives](https://iquilezles.org/articles/gradientnoise/), the analytic gradient the offset is made of.
- MDN, [`feDisplacementMap`](https://developer.mozilla.org/en-US/docs/Web/SVG/Element/feDisplacementMap), the DOM-side way to displace an element's own pixels.
