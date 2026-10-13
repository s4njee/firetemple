## How it works

A whole hearth in one fragment pass (`hearth.wgsl`) and the tail. No state: every element is a function of position, two accumulated distances and the clock. Back to front:

1. **The room.** A brick wall and a stone floor in perspective, lit by the fire: brightness falls off with distance from the heart of the fire, and the floor carries a pool of light in front of the logs. The light's level comes from the CPU: `flickerIntensity` from `src/gpu/emission/flicker.ts`, capped by construction, on real seconds.
2. **Two flame layers.** Each is a bank of fire, tallest in the middle, whose top is cut into tongues by two sines that wander sideways. That gives a rough distance to the flame's surface, and `flame_heat_from_sd` from `flame.wgsl` does the rest: rising noise erodes the surface into licks, more with height, and heat fades towards each tongue's own tip. The noise is two fetches of the shared tile per layer: a slow field that makes the layer lean and a fast one, bent by the slow one, that does the eroding. `ramp_fire` turns heat into colour.
3. **A mound of coals** under the logs: one fetch, glowing lumps that breathe slowly.
4. **Two rear logs**, capsules with charred bark. One fetch each, stretched along the log like grain: where the fine noise crosses its middle the char splits, and the underside, which sits in the fire, glows through the splits.
5. **The nearest flame layer**, added in front of the two rear logs. This is what puts the logs in the fire rather than in front of a picture of one.
6. **The front log**, over everything so far.
7. **Embers**: two layers of the hash grid from `sparks`, in its simplest form (vertical lanes, a swaying column of air).

The back flame layer is 1.28 times the size of its own units, slower (0.75 of the scroll speed) and dimmer; the nearest is 0.78 times, faster (1.25) and brightest. Radiance: flame bodies 4 to 12, cores to about 16; coals and log undersides 1 to 5; the wall near the fire about 0.4.

`flame` sets the height of all three layers, and the presets run it from `roaring` down to `dying embers`, where there is no flame at all and the room is lit dull red by the coals.

## Cost

GPU time, measured on a quiet GPU (Apple M1 Max, 1920 × 1080, default settings, tail included): 0.8 ms per frame on Dawn, where the tail alone reads 0.5 ms and repeated runs differ by about half a millisecond, so this effect cannot be told apart from the tail; and 1.37 ms for one frame in Chrome 155 at 60 fps (median of 3 loads, 1.36 to 1.57), which includes the browser's timing floor. Both are inside the Tier A budget of 2 ms on this machine. The budget is set for an integrated GPU, and no integrated GPU or phone has been measured, so the tier is provisional. Tables: `docs/studies/epic-4.md` and `docs/studies/browser-check.md`.

What can be counted, per pixel: the room is arithmetic and one integer hash (wall pixels only), no fetch. A flame layer is two noise-texture fetches, and only inside the box that layer can reach; a pixel in the middle of the fire pays for all three layers, six fetches. The coal mound is one fetch inside its own box, a log is one fetch on the log (up to three where logs cross), and the embers are two small hashes per layer in the column above the fire. No procedural noise and no Voronoi anywhere. A pixel the front log covers skips everything behind it, and the three log distances are only measured inside the box that holds the logs.

So the cost follows how much of the canvas the fire fills, and `roaring` (the tallest flames) is the dearest preset. First HUD readings in headless Chrome on an Apple M1 Max, one frame at 1920 × 1080 with the default preset, tail included and with other work on the GPU: 1.4 to 2.1 ms across six runs, most near 1.6. That is too close to the 2 ms budget, and too noisy, to call; it is indicative only.

One pass plus the tail. No textures of its own.

## Pitfalls

- **Flash.** Flames move, and a fire that fills the screen is a large moving bright area. At the defaults the flash analyser reports `low`: the busiest cell made 2 general and 3 red flashes in a second, no area was over the limit, and the mean of the whole frame moved by 1.8% of white over 8 seconds. `roaring` also measures `low` (3 and 3, frame mean 2.7%); `dying embers` measures `none`. `speed` goes to 2.5; the measurements were at 1 and 1.5.
- The firelight on the wall and floor uses the capped flicker (`flicker` scales its depth up to 0.3) and runs on real time, not on `speed`, because the cap's guarantee is in real seconds.
- The flames are a bank with a noisy top, not separate teardrops. Seen still, the tongues are convincing; in motion the two sines that cut the bank make the tall tongues drift sideways at a steady rate, which a patient viewer can spot.
- Layers add. Where all three overlap the fire is yellow-white; raising `intensity` much past 1 flattens the middle of the fire to white.
- The layout is fixed: three logs, one wall, one floor. A canvas wider than about 2.5 : 1 is mostly dark wall, and a narrow one zooms out (below 1.05 : 1) and gains floor.
- Log ends are plain capsule ends: the glow wraps around them, and there are no end-grain rings.
- The flame scroll wraps every 64 units and the ember travel every 64 canvas heights; both are arranged to be seamless (`tests/epic4-c.test.ts` checks the flame wrap). The embers' twinkle is not, and changes for one frame about every 17 minutes at `speed` 1.
- The embers duplicate about forty lines of the `sparks` shader, because an effect can only include files beside it or in the shared library.

## When to use it

A hero or a card that should feel like sitting by a fire; a cosy background; an idle state (`low fire`, `dying embers`). It is an opaque scene with its own dark room, so on a light page it is a picture in a box, and it reads at card size (270 px) and in a phone-width hero.

Tier A is the target and is provisional: the first readings are within noise of the budget on an Apple Silicon GPU, so an integrated GPU may put it in Tier B. If it does, the cheapest cuts are the back flame layer (two fetches over the largest box) and the embers.

For a single flame on the page, use an overlay flame instead; for coals alone, `ember-bed`; for sparks over other content, `sparks`.

## References

- `src/wgsl/flame.wgsl` (story 3.7) for the heat field, `src/wgsl/ramp.wgsl` for `ramp_fire`, `src/wgsl/noisetex.wgsl` for noise from a texture.
- I. Quilez, [2D distance functions](https://iquilezles.org/articles/distfunctions2d/): the capsule the logs are made of.
- `src/wgsl/flicker.wgsl`: why the firelight cannot exceed three flashes a second.
- W3C, [Understanding SC 2.3.1: Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html).
