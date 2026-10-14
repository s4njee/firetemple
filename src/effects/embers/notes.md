## How it works

Flying embers as real particles on the Epic 7 framework (`src/gpu/particles/`): each ember is a slot in a GPU pool with a position, a velocity, an age and a temperature, stepped at a fixed 60 steps a second, recycled when it dies, and drawn as an instanced sprite. Nothing about an ember is computed on the CPU. Everything happens in the 2D overlay space, in canvas heights with the origin at the bottom-left, so the picture is the same at any canvas size.

**Where they come from.** A segment emitter lies just below the bottom edge (a fire line nobody sees) and emits at the rate that keeps `count` embers alive on average (Little's law: `count / glow time`). Ambient pops (`createAmbientIgnition`, a Poisson process on the simulation clock) throw a dozen or more hotter embers at once from a random point along it, so the source never looks like a sprinkler. The pointer is a torch through the shared igniters (`createPointerIgnition`): every segment a press or drag covered since the last frame becomes a segment emitter whose burst is proportional to its length, so a fast stroke leaves an even trail rather than dots at the frame boundaries. `torch on hover` lets a pointer that is only moving shed a few too.

**How they move.** The update kernel applies, per ember:

```
a = (0, -0.02) + up * buoyancy * (T - 300 K) / 1000 + curl_2d_anim(p * 2.2, t * 0.25) * turbulence
v = wind + particle_drag(v + a dt - wind, 1.2 / s, 0, dt)
```

Buoyancy is set so a fresh ember's terminal speed is `rise`. It is proportional to how much hotter than the air the ember is, so as an ember cools it slows, stalls and drifts on the curl-noise air instead of climbing: colour and motion are tied by the same state.

**How they glow.** Temperature cools exactly (Newton) at the rate that takes the mean ember from `temperature` (± 250 K) to 650 K in `glow time`; at 650 K it dies, giving off well under 1% of its first light. Each sprite's radiance is `blackbody_radiance(T, 1800 K, 0.4)` times `intensity` (1 to 6 in the HDR scene at the start, less than a hundredth at the end), so the cooling alone carries an ember from yellow-orange through deep red to nothing. Twinkle is `particle_twinkle`: two sines per ember at 1.25 to 2.5 Hz with phases from its seed, a swing of `twinkle`, capped at 4 Hz in the shader whatever the parameter says. Embers are tiny (0.11 to 0.26% of the canvas height) with a pixel floor of 0.8 px (a smaller ember is drawn at the floor and dimmed by the area it gained, so it does not shimmer), shrink a little as they cool, and are stretched along their screen velocity by up to four times, dimmed by the square root of the stretch.

**Drive.** `drive` (`none`, `scroll`, `audio`) feeds `createExcitation`'s 0..1 level into the fire-line rate and the pop rate as up to 60% more than the calm level. It never touches the clock.

**Start.** The first frame after the effect starts (or its pool is resized) runs one and a half glow times of simulation at 30 steps a second in its own submits, so the sky is already full: a still frame under reduced motion looks right.

**What statefulness buys, against `sparks` (4.9) and `soft-sprites` (3.9).** `sparks` is stateless: each pixel finds the one spark that could be in its lane from two hashes, so its cost does not depend on density, but a spark is confined to a straight (or turbulence-bent) lane, its age is the distance it has travelled, gravity is approximated by distance rather than time, and changing the density re-lays the grid so every spark jumps. `soft-sprites` computes every sprite on the CPU each frame as a closed-form function of one clock and uploads them; it is full from the first frame and exact at any frame rate, but every sprite costs CPU time and upload bandwidth every frame (it stops at 4 000), and nothing can depend on history. With state: an ember's path is the integral of the air it has met, so curl noise produces wandering paths, not bent lanes; its temperature is its own history, so buoyancy can depend on it; embers can be born anywhere at any time (a pop, a drag) and then live on; changing the rate does not move a single existing ember; and the count can go to hundreds of thousands at no CPU cost. The price is that cost now grows with the count, and the pool has to be warmed up to start full.

## Cost

GPU time: not measured yet with the benchmark harness (`npm run study`); the scorecard has no `gpuMs`.

Indicative readings, Apple M1 Max, 1920 × 1080, headless Chrome, HUD "GPU" span of one frame including the HDR tail, median of five loads (range in brackets). Another agent was using the same GPU; the first sweep, under heavier contention, read up to twice these numbers, so treat them as indicative:

| `count` (average alive) |    Pool |                  Frame |
| ----------------------- | ------: | ---------------------: |
| 2 500 (default)         |   8 192 | 0.89 ms (0.76 to 0.99) |
| 10 000                  |  32 768 | 1.35 ms (1.00 to 1.38) |
| 20 000                  |  65 536 | 1.55 ms (1.52 to 1.94) |
| 40 000                  | 131 072 | 1.79 ms (1.73 to 2.09) |
| 100 000                 | 262 144 | 2.49 ms (2.35 to 2.74) |
| 200 000 (maximum)       | 524 288 | 4.97 ms (3.51 to 8.70) |

A last check of the default, after every change, read 1.24 ms (1.06 to 1.72, three loads), under the same contention.

Of the default frame, the HUD's own passes read about 0.12 ms for the simulation step (one compute pass: update, plan, emit, finish), 0.04 ms for writing the sprite instances and 0.11 ms for drawing them; the rest is the bloom and tonemap tail. At 100 000 the step reads 0.4 ms and the sprites 1 ms. On Dawn the framework's step for 50 000 live particles is about 0.1 ms and for 250 000 about 0.2 ms (the particle-system notes have the table).

Counts that fit: Tier A (1.5 ms per frame at 1080p) up to about 15 000 embers on this machine; the default of 2 500 has plenty of room. Tier B (6 ms) up to the 200 000 maximum. The pool is the next power of two above 2.5 times `count` (room for the drive, pops and the torch): 48 bytes of state, 12 of list entries and 48 of sprite instance per slot, under 1 MB at the default.

Bundle: not measured.

## Pitfalls

- **A run of fewer igniter segments than torch emitters emitted nothing.** Splitting the frame's segments into at most three runs divided by three even when there was one segment, so every run was empty; `tests/embers.test.ts` caught it by dragging across an otherwise empty canvas.
- **Dark pages only.** Over the light page an ember is a few pale orange or red pixels: visible, but confetti, not light. `scorecard.lightPage` is `no`.
- **Tiny sprites need the pixel floor.** Without it an ember smaller than a pixel flickers as it crosses pixel centres; with it, it is drawn at 0.8 px and dimmed by the area gained. On a small canvas (a card) embers are relatively larger.
- **Flicker.** The default and the quiet presets measure `none` on the flash analyser (frame mean swing 0.07% of white); `bonfire gust` and `ember storm` measure `low` (one cell, one flash). The twinkle cap makes a flashing ember impossible; a dense, fast, bright storm could still add up, so the drive only adds a share of the calm rate.
- **Changing `count`** past a power-of-two boundary rebuilds the pool and warms it up again: a one-frame hitch and a new sky.
- The torch's embers are spread along the frame's path from the igniters, not along the true curve, when a stroke has more than three segments in one frame: the path is cut into three straight chords.

## When to use it

Embers over a dark hero, a footer or the whole page; over a fire drawn by another effect, to carry its heat up; or as a torch trail that follows a press and drag. Tier A at the default count on this machine (provisional until an integrated GPU has been measured). Reach for `sparks` when a fixed cost whatever the density matters more than embers that wander and live on, and for `ember-bed` for glowing coals rather than flying embers. Do not use it on a light page.

## References

- [docs/effect-authoring.md](../../../docs/effect-authoring.md), "Particles": the framework this is built on.
- R. Bridson, J. Hourihan, M. Nordenstam, "Curl-Noise for Procedural Fluid Flow", SIGGRAPH 2007: the drift.
- `src/wgsl/blackbody.wgsl` (story 3.1): the colour of a cooling ember.
- W3C, [Understanding SC 2.3.1: Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html): the twinkle cap.
