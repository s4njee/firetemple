## How it works

The page is the fuel. Every element marked `data-ft-obstacle` near the canvas is a rounded rectangle (`trackDomRects` in `src/gpu/dom-rects.ts` reports them in canvas uv, with their corner radii), and those rectangles are drawn into the fuel map of the burn solver that `burn-front` also uses (`src/gpu/sim/burn.ts`; its notes and `burn-step.wgsl` explain the solver). Fire lit on an element climbs it, crosses it, stops at its edge, and jumps to the next element only if the gap is narrower than `jump`.

**Rectangles to fuel.** The map stores, per cell, the signed distance to the nearest rectangle (the union of up to 32 rounded boxes, `sd_rounded_box_2d`). Negative is fuel. A cell outside every element but closer than half of `jump` to one is a _bridge_: it carries the front at 0.7 of the speed and burns nothing. So a gap narrower than `jump` is bridged from both sides and the fire crosses it; a wider one has a strip of cells in the middle that carry nothing, and it never does (tested at the cell level in `tests/epic5-b.test.ts`). `jump` is in CSS pixels, the unit gaps between elements are designed in. The halo of bridge cells around every element is also why flames lick a little past an element's edge.

**When the layout changes** (a resize, a scroll, a card that grows), `trackDomRects` reports `changed`, and only the map is redrawn: one small pass. The state (what is alight, what has burnt, when it burnt) is untouched. A cell that has burnt out stays burnt out wherever the fuel now is, and does not light a neighbour; it only regrows on its own timer. A cell that has lost its fuel stops carrying the front. Movement under a quarter of a cell is not counted as a change, so a page that settles by a sub-pixel does not redraw anything. When the canvas itself changes size, the solver carries its state over to the new grid.

**The fire.** `climb` makes the front faster upwards and as much slower downwards (1.8 by default), which is what makes it climb a card rather than spread over it evenly. Every cell regrows `regrow` seconds after it burnt out and fades back in over 1.5 s, so the page is never left burnt. Scorch is the solver's char: it starts as each cell burns and fades over `scorch fade` seconds, unevenly. Taps and drags light what they touch (`createPointerIgnition`); stray embers (`createAmbientIgnition`) land inside the box that holds the elements, and an opening spark 0.35 s after start lights the foot of the largest element so there is always something to see. `drive` raises the ember rate by up to its calm level and the speed by up to half of it.

**Flames** are a second small texture at the solver's resolution (`licks.wgsl`), updated once a frame: each cell keeps the hotter of the solver's heat and what the cell below held a frame ago, cooled by a factor from a smooth noise field that climbs about one noise cell a second. That is the Doom fire's rule, with smooth noise instead of a random number per cell per frame, so the tongues lean and stretch rather than flicker at the frame rate.

**Display** (`scene.wgsl`): three fetches per pixel, no noise: the map (an early-out beyond the furthest reach of any flame, and the element's edge), the state (the front's heat and the char) and the flames. The front is `ramp_fire(heat^2)`, the flames are never hotter than orange, and the scorch is near-black with real coverage over the element. Everything else is transparent.

**What it cannot do.** A WebGPU canvas cannot read the pixels of the elements under it, so the fire cannot consume them: it draws light and scorch over a card, never a hole in it, and it cannot know where the text is, only the element's box. To be seen over the elements, the canvas has to be above them; the mock pages put it behind their content, so while there are elements to burn the effect raises its own canvas (`position: relative; z-index: 5`, restored on `destroy`; `canvas above content` turns it off). On a real page a canvas over the content takes the pointer: give it `pointer-events: none` and feed the ignition from the page instead, or keep the canvas under translucent content. With no marked elements at all (the tests, the bare canvas, the band layout, a gallery thumbnail) it burns a built-in set of stand-in cards that it draws itself.

## Cost

GPU time: not measured yet. Chrome's HUD in the browser check (Apple M1 Max, 1920 x 1080 canvas in the bare layout, so on the stand-in cards, default settings, while other agents were using the GPU, indicative only) read 1.05 to 1.19 ms for one frame over two runs (medians 1.17 and 1.05 ms of three loads each), which is the HDR tail's own cost there.

What can be counted, at the defaults on a 1920 x 1080 canvas:

- Grid: 455 x 256 = 116 000 cells.
- Per step (one a frame at 60 Hz): the solver's pass, 10 texel loads per cell.
- Per frame: the flames pass over the grid, 3 fetches per cell (state, the flames below, the noise tile).
- Per pixel: one fullscreen pass, 3 fetches, nothing beyond the reach of a flame; then the tail.
- When the layout moves: one pass redraws the fuel map, a loop over at most 32 rectangles per cell.
- On the CPU per frame: one `getBoundingClientRect` for the canvas and one per marked element, cached computed style (see `dom-rects.ts`).
- Texture memory beyond the tail: state 2 x 0.93 MB, map 0.93 MB, flames 2 x 0.93 MB.

There is no whole-map regrowth here, so the reduction passes `burn-front` needs never run. It is labelled Tier B for the story; by the reading above it may fit Tier A, which needs measuring on a quiet GPU and an integrated one.

## Pitfalls

- **The canvas has to be on top.** In the mock layouts the canvas is the page's background (hero) or a card's backdrop (cards), under 90%-opaque plates: fire drawn there would be all but invisible under the very elements it burns. Hence the raised canvas, the one change the effect makes outside its own pixels. Its stacking works because nothing between the canvas and the page creates a stacking context; in another page it may need a wrapper with its own `z-index`.
- **Scorch stays where the canvas was.** The state lives in canvas space. When an element scrolls under a fixed canvas (the backdrop layout), its scorch and fire do not move with it: burning cells left outside the element go out and the new area under it is fresh fuel. Carrying the state along with a common scroll is possible (shift the grid by whole cells, keep the remainder as an offset) but not done.
- **Only the box burns.** Text, images and transparent padding inside a marked element are all fuel. Mark the inline element, or give a heading `width: fit-content`, to burn the words' box rather than the line's.
- **32 rectangles.** More marked elements than that are dropped (the first 32 in DOM order are kept).
- **The jump is in CSS pixels.** On the stand-in cards, which are laid out in canvas fractions, a larger canvas means wider gaps in pixels, so the fire jumps between them on a small canvas and not on a large one.
- **Half-float timers.** Each cell's regrowth counts from a stored phase of a 128-second period, which an early version compared with `fract` so a value rounded a hair past "now" read as a whole period: every cell regrew the moment it burnt out and the front stalled. `regrow` is capped at 60 s here (120 in the solver).
- **Flash.** The analyser (480 x 270 for 1080p, 24 s at the defaults) found at most one flash a second in any cell and no flashing area (`low`). The risk would be a whole card lighting at once; the front never does that (it advances at most 0.85 of a cell a step and the default is under a third of that), and the flames' noise climbs about one cell a second. Every preset is swept by `tests/flash.test.ts` and none is over the threshold.
- **Light page.** The front and flames read as orange ink over light elements and the scorch is real coverage, so it reads on a light page; checked in Chrome over the light hero layout and the phone view, and in headless renders.

## When to use it

A page that reacts to being clicked with fire that respects its layout: a 404, a launch page, a game menu, cards that burn when dismissed and come back. It is decoration on top of real content and needs nothing from that content but the `data-ft-obstacle` marker. Tier B for now (see Cost).

It is not a way to destroy content: nothing under the canvas changes, and the content stays readable through the scorch only as far as `scorch` allows. For fire inside one element use `burn-front` (a sheet with its own coverage) or a stateless border effect; for fire that flows around elements rather than consuming them, the fluid solvers of Epic 6 with DOM obstacles.

## References

- J. A. Sethian, [A fast marching level set method for monotonically advancing fronts](https://www.pnas.org/doi/10.1073/pnas.93.4.1591), PNAS 1996, and M. S. Hassouna and A. A. Farag, [Multistencils Fast Marching Methods](https://ieeexplore.ieee.org/document/4250465), IEEE TPAMI 2007: the solver's front.
- Fabien Sanglard, [How Doom Fire Was Done](https://fabiensanglard.net/doom_fire_psx/), 2018: the rule behind the flames texture.
- Inigo Quilez, [2D distance functions](https://iquilezles.org/articles/distfunctions2d/): the rounded boxes of the fuel map.
- `src/gpu/dom-rects.ts`: why the boxes are read per frame rather than from observers.
- WCAG 2.2, [Success Criterion 2.3.1](https://www.w3.org/TR/WCAG22/#three-flashes-or-below-threshold).
