## How it works

Story 6.9: hot air bending what is behind it, where the hot air is a fluid simulation rather than a texture. A heat source just below the frame (and the pointer, as a torch) puts heat into the stable-fluids solver (`src/gpu/sim/fluid.ts`); buoyancy lifts it, vorticity confinement curls it, it cools as it rises, and the picture is read back at coordinates the gas has bent. The shimmer is carried with the gas: it rises at the gas's speed, swirls where the gas swirls, leans when the plume leans and fades where the gas has cooled. There is no fire to see, only a faint dull-red glow where the gas is hottest (`source glow`, 0 hides it).

**The fluid.** The solver at 128 cells on the long side, dye 512 texels, MacCormack advection, `open` edges, vorticity confinement 6 / s against a damping of 0.5 / s. Dye r is the temperature (excess over ambient); buoyancy reads only it (`buoyancyWeights` [1, 0, 0, 0]) and it cools at `cooling` (0.7 / s). Nothing else is in the dye.

**Heat in, lumpy on purpose.** A smooth plume is a smooth lens: it bends the picture behind it as a whole, and that reads as glass, not heat. Real shimmer comes from small hot and cool parcels, so the source does not lay a line of heat: every frame it drops small lumps (radius 0.007 to 0.018 canvas heights, random strengths) at random places along a line at the bottom edge, about one per 0.02 canvas heights of source, from a repeatable generator. The flow then stretches and folds them. The torch is the shared pointer ignition (`createPointerIgnition`), turned into four lumps around each segment the pointer covered since the last frame: a press is full heat, a hover is `torch when hovering` of it (0.5 by default; 1 in `torch only`), because a torch that has to be held down is not a torch. Stray wisps (`createAmbientIgnition`, 0.5 a second) keep the air moving when the source is off. The `drive` parameter raises the source by up to 60% and the wisp rate by up to 100%, never the clock.

**From fields to displacement** (`shimmer.wgsl`, one pass at canvas size):

1. **Temperature gradient.** Four bilinear taps of the dye, one texel either side in x and in y: their mean is the temperature T, their differences the gradient (temperature per canvas height), continuous across texels.
2. **Cold air returns early.** The mask is smoothstep(0.02, 0.08, T): exactly zero below 0.02, and there the picture is one untouched tap. `tests/epic6-c.test.ts` checks that every pixel with a zero mask has zero displacement, and that with nothing hot the picture equals the picture with `strength` 0.
3. **Bend.** Air's refractive index falls as it warms, so light bends toward the cooler side: the push is -grad T times a gain (0.015 per unit of gradient), which makes a hot blob a weak diverging lens and ripples its edges.
4. **Carried detail.** Below the dye's resolution (about four canvas pixels a texel at 1080p) the gas carries a noise pattern of its own: the shared baked noise tile read through a flow map over the fluid's velocity (one tap of `fluid.fieldsView`). Two layers, each advected by the local velocity for up to 0.8 s and then restarted at a new offset, are cross-faded half a period apart and normalised so the cross-fade does not dim them. It is weighted by `carried detail` and by how hot the air is. The pattern therefore moves at the speed and in the direction of the gas at that point, not as one sheet.
5. **Bounded.** The sum is squashed to a length below 1 (g / sqrt(1 + |g|²)) and scaled by `strength` (0.8% of the height) and by the mask, so no pixel is ever moved further than `strength`. The test reads the displacement back through the `displacement` view and checks the bound.
6. **Read the picture** at the bent coordinate, with a faint colour split (`colour split`) and a slightly softer mip level where the air is hottest (`blur`), as `haze-overlay` does. The faint glow, `ramp_fire` of the temperature, is added last.

`view: temperature` shows the temperature field and `view: displacement` the push (0.5 grey is none), which is how the tests read it.

**The picture.** As in `haze-overlay`, everything goes through the `MediaTexture` interface of `src/gpu/media.ts`. `picture.wgsl` draws one of three stand-ins once, at canvas size, into an sRGB texture with mips: a printed page (a headline, two columns of pseudo-glyph text and a framed bar chart), a brick wall with a window, and a test grid. They are made of thin strokes because thin strokes show a shimmer. Drop an image or a video file on the canvas and it replaces the stand-in; choosing a stand-in again puts it away.

**Bloom and tonemap are off for the picture.** The scene is display-referred picture content at or below 1.0, not radiance: a photo must come out as it went in. The tail therefore runs with its tonemap set to `none` (exposure, sRGB encode and dither only), and bloom defaults to 0, because nothing in the picture is brighter than paper white and the bloom's soft knee would only fog its highlights. The faint glow is the one emissive thing and stays under about 1; a brighter, blooming fire belongs in an effect that draws fire. The diagnostic views are not dithered, so they can be read back as numbers.

**A still frame already shimmers.** Two seconds of heating run before the first frame, one step per command buffer.

**Against the noise-driven `haze-overlay` (Epic 4).** Both bend a picture with the same optics; what differs is where the bend comes from.

|                                          | `haze-overlay`                                                       | `fire-haze`                                                                |
| ---------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Source of the bend                       | two fetches of the baked noise tile, scrolled upward at one speed    | the temperature gradient of a simulated gas, plus noise the gas carries    |
| Where it is                              | a fixed mask (band, plume, whole frame)                              | wherever the gas is hot; it moves, leans, curls and fades with the flow    |
| Motion                                   | the pattern climbs and boils in place; it never swirls, never reacts | rises at the gas's own speed, swirls round eddies, follows a moving torch  |
| Interaction                              | none                                                                 | the pointer heats the air; the scroll or the audio drive raises the source |
| Cost (indicative, Chrome, M1 Max, 1080p) | 0.39 ms, Tier A                                                      | 2.4 ms, Tier B                                                             |
| Needs                                    | fragment shaders only                                                | compute shaders (no WebGL2 path)                                           |
| Look in a still                          | fine, even streaks                                                   | lumps and curls, coarser near the source, smoother higher up               |

The overlay is the right choice for ambient heat that nothing touches (a road, a desert, a hero photograph): it is a fraction of the cost and its look is easy to keep subtle. The fluid earns its cost when the heat has a source and a history: a plume that should lean, swirl and fade, a torch the visitor carries, heat that responds to the page. A still frame of the two can look alike; the difference is in motion.

## Cost

GPU time, measured on a quiet GPU (Apple M1 Max, 1920 × 1080, default settings, simulation and tail included): 0.8 ms per frame on Dawn, where the tail alone reads 0.7 ms; and 3.01 ms for one frame in Chrome 155 at 60 fps (median of 3 loads, 2.19 to 4.91), which includes the browser's timing floor. The gap between the two is larger for these effects than for the single-pass ones, because a fluid step is many small dispatches. Both are inside the Tier B budget of 6 ms on this machine; no integrated GPU or phone has been measured. How the cost moves with grid size and pressure solver is in `docs/studies/epic-6.md` (story 6.10). An earlier indicative reading: the HUD in headless Chrome showed 2.4 ms for one frame at 1920 × 1080 on an Apple M1 Max at the defaults (three loads: 2.0, 2.4, 2.6 ms; `npm run browser-check`, view `hud-1080p`), while other work was using the GPU. That is 41% of the Tier B budget of 6 ms, about six times `haze-overlay`'s 0.39 ms, and less than `stable-fluids` (2.6 to 3.1 ms on the same solver and grid) because there is no bloom. No integrated GPU or phone has been measured, so the tier is provisional.

Counted from the code, at the defaults:

- **Simulation:** 128 × 72 cells, dye 512 × 288, one step a frame at 60 Hz, about 40 dispatches a step (as `stable-fluids`: MacCormack advection of velocity and dye, forces, divergence, 30 Jacobi iterations, projection), plus two small splat passes for the lumps (about 20 to 40 dye splats a frame for the source, up to 64 for a fast torch).
- **Display:** one pass at canvas size. Cold air: 4 dye taps and 1 picture tap. Hot air: + 1 fields tap, 2 noise fetches and 1 picture tap (3 with the colour split). No procedural noise.
- **Tail:** output pass only (bloom off), no tonemap curve.
- **Not per frame:** the stand-in picture and its mip chain, on a resize or a change of picture.
- **Memory:** about 4 MB for the solver, plus the picture at canvas size with mips (11 MB at 1080p) and the tail.

## Pitfalls

- **A smooth plume is glass.** Heat laid as smooth tongues (as `stable-fluids` lays it) makes a smooth temperature field, and its gradient bends the picture as one lens. The source here is lumpy from the start for that reason (a design choice, not a version that was built and compared); the flow-carried noise adds what the dye is too coarse to hold. With `carried detail` at 0 (`gradient only`) a still frame changes little (about 1% of pixels by more than 20 levels at 960 × 540): most of the shimmer is the gas's own lumps.
- **Saturation flattens the falloff.** With a large gain the squashed push reaches `strength` almost everywhere in the plume, and the text in it is scrambled from the source to the top. The gain is low enough (0.015) that only the hottest lumps near the source saturate, and the shimmer calms as the gas cools.
- **The gradient is only as fine as the dye.** At 512 dye texels on a 1920-pixel canvas the gradient has kinks every 3.75 pixels, which a test grid shows as small steps along a wavering line. A finer dye costs dye advection; the carried noise hides most of it.
- **Thermals roll up.** A 2D hot blob rises as a vortex pair, and near the source the lumps make rows of small chevrons in the temperature field (visible in the `temperature` view). In the picture it reads as boiling air.
- **It distorts a picture it owns, not the page.** A canvas cannot read the pixels the browser painted behind it: this works over an image, a video or what the canvas draws itself, not over live text or DOM elements (as `haze-overlay`).
- **Strength is a fraction of the height.** 0.8% is 8.6 pixels at 1080p but 2 pixels on a 270-pixel card, where the shimmer is barely there; raise `strength` for small canvases.
- **No softening on video.** As in `haze-overlay`, a dropped video has no mips, and `blur` does nothing for it.
- **Open edges and long runs.** Each preset was run for 30 s headless: no field went non-finite and the speed stayed under the grid's cap (the `chimney` jet is the fastest, under 4 canvas heights a second against a cap of 5).
- **WGSL.** Scene names start with `fh_`. The display file is `shimmer.wgsl`, not `haze.wgsl`: a file beside the effect is found before the library's, and the name would have hidden `src/wgsl/haze.wgsl`.

## When to use it

A hero picture above a grill, a radiator, an engine or a chimney whose shimmer should rise and swirl like real hot air; a pointer that warms the page it passes over and leaves the air wavering behind it. Tier B (provisionally), compute shaders only, opaque (it draws the picture, so it reads the same on a light or a dark page), and no flash: the analyser finds no cell that completes a flash at the defaults, and the frame's mean luminance moves by under 0.1% of white.

For heat with no source and no interaction, use `haze-overlay` (Tier A, a fraction of the cost). For a visible fire with haze above it, draw the fire and use the same displacement from that fire's own temperature field. Do not put it over anything that has to be read.

## References

- Wikipedia, [Schlieren photography](https://en.wikipedia.org/wiki/Schlieren_photography): light bends along the gradient of refractive index, and warm air has a lower one.
- Alex Vlachos, [Water Flow in Portal 2](<https://advances.realtimerendering.com/s2010/Vlachos-Waterflow(SIGGRAPH%202010%20Advanced%20RealTime%20Rendering%20Course).pdf>), SIGGRAPH 2010 Advances in Real-Time Rendering: flow maps with two cross-faded phases.
- Fabrice Neyret, [Advected Textures](https://hal.inria.fr/inria-00537472/document), Symposium on Computer Animation 2003: texture carried by a flow and regenerated before it distorts.
- Jos Stam, [Stable Fluids](https://www.dgp.toronto.edu/public_user/stam/reality/Research/pdf/ns.pdf), SIGGRAPH 1999.
- Ronald Fedkiw, Jos Stam, Henrik Wann Jensen, [Visual Simulation of Smoke](https://web.stanford.edu/class/cs237d/smoke.pdf), SIGGRAPH 2001 (buoyancy from temperature, vorticity confinement).
- Water Temple, `src/gpu/sim/fluid-warp.ts`: a displacement field advected by the fluid that warps an image (story 6.4 there). Not used here: it accumulates the motion of the flow and relaxes it, which is paint being smeared; haze is an instantaneous refraction that should vanish where the gas has cooled, which the temperature gradient gives directly.
