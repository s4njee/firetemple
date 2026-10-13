## How it works

Sparks with no buffers and no particle state. Nothing is simulated and nothing is remembered from one frame to the next: one fragment pass (`sparks.wgsl`) asks at every pixel, for each depth layer, "which spark could be here now?", and two small integer hashes answer.

**The grid.** The frame is polar about a point behind the emitter. A pixel has a direction (which **lane** it is in) and a distance travelled from the emitter. Each lane is a conveyor that carries one **slot** every `slot_len` of travel, and a slot holds at most one spark:

```wgsl
let slot = (params.rise * speed - r) / params.slot_len + lane_hash.y;
let bits = pcg_1d(lane_bits + u32(wrapped) * 0x85ebca6bu);   // this slot's spark, if it has one
```

`rise` is the distance an average spark has travelled, accumulated on the CPU from `time.delta * speed`, so the speed control changes how fast the conveyors run and never where a spark is. Each lane runs at its own speed (0.6 to 1.4 times the average), which is what stops a layer from moving as one sheet. A spark's age is the distance it has travelled over the distance it will live for, so it is born at the emitter, cools on the way and dies at its own height.

**One frame for every kind of spray.** The distance of that point behind the emitter is the only difference between a bed of embers and a welding arc. `source` (the emitter's width) and `spread` (the fan's half-angle) set it: far behind gives parallel lanes, zero gives a fan from a point. `direction` turns the fan, and `gravity` bends it: a spark that has gone `r` has dropped `gravity * r²`, so the pixel is lifted by that much before it is asked which straight ray it is on.

**Streaks.** A spark is `sprite_streak` from `sprite.wgsl`, drawn in lane coordinates: a round head and a tail that lies along the lane. Because turbulence bends the lanes themselves (one fetch of the shared noise tile, read differently by each layer), a streak follows its own curved path with no rotation maths.

**Colour.** Temperature falls with age from `temperature` to 950 K, slowly at first, and goes through `blackbody_radiance`; `ramp_whiten` turns the brightest cores pale instead of lemon yellow. Sparks twinkle by up to 35%, each at its own rate.

**Depth.** Up to four layers, each 0.68 times the size, speed and reach of the one in front. The polar transform (one square root, one `atan2`) is shared by all of them: the layers differ only by a scale about the emitter.

`grid.ts` works out the lane width, slot length and the share of slots that are filled for a requested number of sparks per area, on the CPU, once per frame.

## Cost

GPU time, measured on a quiet GPU (Apple M1 Max, 1920 × 1080, default settings, tail included): 0.4 ms per frame on Dawn, where the tail alone reads 0.5 ms and repeated runs differ by about half a millisecond, so this effect cannot be told apart from the tail; and 1.79 ms for one frame in Chrome 155 at 60 fps (median of 3 loads, 1.64 to 1.81), which includes the browser's timing floor. Both are inside the Tier A budget of 2 ms on this machine. The budget is set for an integrated GPU, and no integrated GPU or phone has been measured, so the tier is provisional. Tables: `docs/studies/epic-4.md` and `docs/studies/browser-check.md`.

What can be counted, per pixel inside the fan: one noise-texture fetch, one square root and one `atan2` (three square roots with gravity), then per layer two `pcg_1d` hashes (about 7 integer operations each) and roughly 40 arithmetic operations before the pixel is rejected. Only a pixel that is actually on a spark (a few percent of the canvas at most) pays for a third hash, the streak shape and the blackbody colour (one `exp`, one `log`). No procedural noise, no Voronoi, no loops over neighbouring cells: a spark is confined to its lane and its slot, so one cell is looked at per layer.

Cost does not depend on the number of sparks: `density` changes how many slots are filled, not how many are looked at. It scales with the pixel count and with `layers`. An earlier version repeated the polar transform in every layer; sharing it was the largest saving found (the HUD reading for one frame at 1920 × 1080 in headless Chrome on an Apple M1 Max, tail included, went from 1.9 to 2.2 ms over three runs to 1.4 and 1.9 ms over two, with other work on the GPU: noisy, and indicative only).

One pass plus the tail. No textures of its own; the noise tile is shared by every effect.

## Pitfalls

- **Dark pages only.** A spark is a few pixels of light with little area. Over the light page the default preset shows as small orange-red flecks with a faint peach halo: visible, but it reads as confetti, not as light, and the pale cores vanish into the paper. The welding spray keeps its shape as orange ink, and its blue-white arc becomes a grey smudge. `scorecard.lightPage` is `no`.
- **The fast presets flash.** The default (`campfire drift`) measures `none` on the flash analyser: no cell of the picture completes a flash, and the frame mean moves by 0.05% of white. `bonfire gust` measures `low` (one cell reached four red flashes in a second; it measured `high` until it was slowed from 0.7 to 0.45 heights a second). `welding spray` and `grinder` measure **`high`** when the canvas fills a 1920 × 1080 view: cells near the source swing nine to eleven times a second, over about 150 000 and 80 000 CSS px² against a threshold of 21 824. Dimmer, slower, denser and bloom-free variants of the welding spray all still measured `high`, because a dense spray of bright streaks is a flashing thing. The scorecard says `low` for the default and the gust; for the two sprays, keep the canvas small (the flashing area is about 7% of it, so under roughly 700 × 400 CSS px for the welding spray) or do not use them where the audience is unknown.
- A spark never leaves its lane. Near a point source the lanes are narrower than a spark, so the lane edge clips it to a sliver; the glow of the source hides that. With `spread` at 180° there is a seam straight behind the fan where the first and last lanes meet.
- Gravity is an approximation: the drop depends on distance travelled, not on time, so fast and slow lanes follow the same curve. Past `gravity` 2 the two rounds of substitution no longer converge and paths kink.
- Changing `density`, `size` or `streak` changes the grid, so every spark jumps to a new place while the slider moves. Changing `speed` does not.
- The travelled distance wraps every 256 canvas heights to keep `f32` precise. The shader rounds each lane's speed to a whole number of slots per wrap, which makes the wrap invisible (`tests/epic4-c.test.ts` checks it). The twinkle clock wraps every 1024 seconds with a one-frame change of sparkle.
- Size is a fraction of the canvas height, with a floor: at `size` 1 a spark is never under 1.5 pixels in radius, so a card-sized canvas shows relatively larger sparks than a hero. Below that floor (far layers, `size` under 1) a spark thinner than 0.75 pixels is drawn at that width and dimmed by the area it gained, so it gets fainter instead of flickering.
- Sparks fade out over the top 14% of the canvas, to nothing just below the edge, so the rectangle never shows. A spray aimed sideways is still cut by the side edges.

## When to use it

Embers behind a dark hero, over a fire drawn by another effect, or a spray from a point on a dark interface. It is the right tool when a particle system would be overkill: no state to keep, nothing to resize, the same cost at any density, and it can start on any frame fully populated (which is also why a still frame under `prefers-reduced-motion` looks right).

Tier A, provisional until an integrated GPU has been measured.

Reach for a real particle system (`soft-sprites`, and the simulated ones in Epic 7) when sparks must collide, follow a moving emitter along a path, swirl in a velocity field or be lit by depth. Do not use it on a light page.

## References

- M. Jarzynski, M. Olano, [Hash Functions for GPU Rendering](https://jcgt.org/published/0009/03/02/), JCGT 2020: the PCG hashes in `hash.wgsl`.
- T. Lorach, "Soft Particles", NVIDIA 2007, and `src/wgsl/sprite.wgsl`: the streak shape.
- W3C, [Understanding SC 2.3.1: Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html).
- [docs/compositing-study.md](../../../docs/compositing-study.md): why thin light does not read on a light page.
