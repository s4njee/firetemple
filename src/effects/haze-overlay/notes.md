## How it works

Hot air is a weak, lumpy, rising lens: what you see through it wavers. This effect is that and nothing else. There is no flame in it. It shows a picture (a photo, a video, or a stand-in it draws itself) and reads it back at coordinates nudged by a rising noise field, wherever a heat mask says the air is hot.

It is the shared haze chunk (`src/wgsl/haze.wgsl`, shown in the `heat-haze` scene) rebuilt to be shipped. The chunk gets its offset from two evaluations of 3D gradient noise with derivatives, and that noise is most of what the Epic 3 scene costs. Here the offset comes from two fetches of the shared baked noise tile and there is no procedural noise per frame at all.

**The picture.** Everything goes through the `MediaTexture` interface of `src/gpu/media.ts`, so a still, a video and the stand-in are one code path:

- By default `picture.wgsl` draws one of three stand-ins once, at canvas size, into an sRGB texture with mips (`mediaFromTexture`): a desert road running to a vanishing point with telegraph poles and a wire, a city at dusk with window grids, an aerial and a vent stack, and a test grid. They are made of straight lines because straight lines are what make a shimmer easy to judge. The repository ships no image files.
- **Drop an image or a video file on the canvas** and it replaces the stand-in (`createMediaFromFile`). Nothing is uploaded anywhere: the file is decoded in the page. A video is muted, looped and re-uploaded only when it has a new frame. Choosing a stand-in again puts the file away. `fit` is CSS `object-fit`: cover or contain.

**The haze pass** (`haze-overlay.wgsl`), every frame, per pixel:

1. **Heat mask.** `band`: a strip lying on a horizontal line (`source height`), reaching `haze height` above it and a third of that below, which is where shimmer sits over hot ground seen at a grazing angle. `plume`: a column rising from a point and spreading, for an exhaust or a chimney. `whole frame`: everywhere.
2. **Cold air returns early**: one tap of the picture, untouched. `tests/epic4-d.test.ts` checks that pixels outside the mask are bit for bit what they are with the haze off.
3. **Offset.** Two fetches of the noise tile, each giving two channels used as a sideways and a vertical push. The cells are three times taller than wide and the vertical push is divided by three, so the displacement is mostly sideways: vertical edges waver, horizontal ones barely move, which is the difference between heat shimmer and a water ripple. The second layer is 1.83 times finer and climbs 1.37 times faster, so the two interfere and the pattern boils instead of sliding upward as one sheet (and the tile's repeat does not show). The sum is squashed to a length below 1, scaled by `strength` and by the mask.
4. **Read the picture** at the displaced coordinate: one tap, or three with `colour split` above zero (red pushed a little further, blue a little less), from a slightly blurrier mip level where the air is hottest (`blur`).
5. **Mirage** (band only, optional). Just below the line, flat pools show the picture above the line upside down: the "water on the road" of an inferior mirage. The pools come from one more fetch of the tile, stretched sideways, and thin out toward the viewer.

**The tail, without a tonemap.** The scene is ordinary picture content at or below 1.0, not radiance, and a photo must come out as it went in. So the tail is run with its tonemap set to `none` (it still applies `exposure`, encodes to sRGB and dithers), and **bloom is off by default**: nothing here is brighter than paper white, so there is nothing for it to pick up, and above zero its soft knee would only fog the bright parts of the picture. With bloom at 0 the bloom chain does not run at all.

## Cost

GPU time, measured on a quiet GPU (Apple M1 Max, 1920 × 1080, default settings, tail included): 0.3 ms per frame on Dawn, where the tail alone reads 0.5 ms and repeated runs differ by about half a millisecond, so this effect cannot be told apart from the tail; and 0.39 ms for one frame in Chrome 155 at 60 fps (median of 3 loads, 0.39 to 0.40), which includes the browser's timing floor. Both are inside the Tier A budget of 2 ms on this machine. The budget is set for an integrated GPU, and no integrated GPU or phone has been measured, so the tier is provisional. Tables: `docs/studies/epic-4.md` and `docs/studies/browser-check.md`. One indicative reading: the HUD in headless Chrome showed 0.38 to 0.43 ms (four runs) for one frame at 1920 × 1080 on an Apple M1 Max (haze pass and output pass; no bloom), while other work was using the GPU. That is below the HUD's usual floor on this machine, so read it as "too cheap to measure here". For comparison, the Epic 3 `heat-haze` scene read 4.2 ms the same way.

Counted from the code:

- **Passes per frame:** the haze pass and the tail's output pass. The picture pass and its mip chain run only on a resize or a change of stand-in.
- **Cold air:** 1 tap of the picture.
- **Hot air:** 2 noise fetches and 1 tap of the picture, or 3 taps with a colour split (the default).
- **Under the line with `mirage` on** (a strip a third of `haze height` deep): 1 more noise fetch and 1 more tap.
- **Procedural noise per frame:** none.
- With the default band the mask covers about 40% of the canvas, so the average is under 3 fetches a pixel.

Texture memory: the stand-in picture at canvas size, 4 bytes a pixel plus a third for mips (11.1 MB at 1920 × 1080), or the dropped file at its own size (a 4096-pixel photo with mips is about 90 MB; `createMediaFromFile` downscales anything larger). The HUD showed about 27 MB in all at 1080p. A video adds one copy of each new frame (`copyExternalImageToTexture`), not measured here.

## Pitfalls

- **It distorts a picture it owns, not the page.** A canvas cannot read the pixels the browser painted behind it, so this cannot shimmer live text or DOM elements. It works over an image, a video, or content the canvas draws itself. Water Temple's backdrop study has the details.
- **Strength is a fraction of the picture height.** At the default 0.3% a 1080-pixel canvas moves pixels by up to 3; a 300-pixel band moves them by under one and the haze all but disappears. Raise `strength` and lower `scale` for small canvases.
- **Frosted glass.** When `strength × scale` goes much above 0.2 (strength as a fraction of the height) neighbouring pixels are thrown past each other and the picture scrambles instead of wavering.
- **The noise tile must be read from the right level.** `scale` 36 on a 500-pixel canvas puts one tile on about 110 pixels, well under its 256 texels; read at level 0 the finest octaves alias into a jitter that crawls as it rises. The level is computed from the canvas height and never goes below 2, which also keeps the push smooth.
- **Edges and bars.** The first version decided "is this pixel on the picture" at the displaced coordinate, which dragged black bars into the picture's edge in a row of dark blocks. The test is now made where the pixel is, and the sampler clamps, so at the border the haze repeats edge pixels (invisible at these strengths).
- **No softening on video.** The blur reads the mip chain, and rebuilding a video's mips for every frame would cost more than the effect. Dropped videos are uploaded without mips and `blur` does nothing for them.
- **The mirage needs the line to be the horizon.** `source height` is 0.44 for the stand-in road. On your own photo it has to be set to where the ground meets the sky, or the pools float in the wrong place.
- **It is about motion.** Under `prefers-reduced-motion` the shell holds one frame, and a frozen haze is just slightly wobbly edges: harmless, but not heat.
- **The stand-ins are illustrations.** They exist to show the effect without shipping an asset, and to give straight lines to judge it by. Judge the look on a real photograph.
- **Dropping needs the canvas to be reachable.** The listeners are on the canvas itself. In a layout where another element covers it and takes pointer events, a drop lands on that element instead.

## When to use it

A hero photograph that should feel hot: a road, a desert, a runway, a grill, a rooftop in summer. The air above an exhaust or a chimney in a product shot or a video loop. It is Tier A (provisionally: no integrated GPU has been measured), has no flash risk (the analyser finds no cell that completes a flash, and the frame's mean luminance moves by 0.02% of white), and looks the same on a dark or a light page because it is an opaque picture.

Keep it subtle: real shimmer is small and fine, and the default is close to it. Confine it to a band or a plume rather than the whole frame unless the whole scene is meant to be baking.

Do not use it over anything that has to be read. And if the thing to distort is a DOM element of your own rather than an image, an SVG displacement filter (`feTurbulence` into `feDisplacementMap`) distorts the element itself with no canvas; its cost and browser behaviour were not measured here.

For haze above a fire that the canvas draws, use the chunk (`#include "haze.wgsl"`) or this shader's `ho_direction` inside that effect, masked by the fire's own heat.

## References

- Water Temple, `docs/backdrop-capture-study.md`: the ways to get page content into a WebGPU texture, and which of them work.
- W3C, [WebGPU: `copyExternalImageToTexture`](https://www.w3.org/TR/webgpu/#dom-gpuqueue-copyexternalimagetotexture), the sources a texture can be filled from.
- MDN, [HTML Drag and Drop API: file drag and drop](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/File_drag_and_drop).
- Wikipedia, [Mirage](https://en.wikipedia.org/wiki/Mirage): the inferior mirage, an inverted image of the sky below the horizon over hot ground.
- Wikipedia, [Schlieren photography](https://en.wikipedia.org/wiki/Schlieren_photography): light bends along the gradient of refractive index.
- MDN, [`feDisplacementMap`](https://developer.mozilla.org/en-US/docs/Web/SVG/Element/feDisplacementMap), the DOM-side way to displace an element's own pixels.
