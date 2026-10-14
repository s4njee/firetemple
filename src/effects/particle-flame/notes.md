## How it works

The particle-system fire of Reeves (1983), which every game engine has shipped since: a flame is not drawn, it is the sum of many large, soft, short-lived sprites. Here every sprite is a particle on the Epic 7 framework (`src/gpu/particles/`): a slot in a GPU pool with a position, velocity, age and temperature, stepped 60 times a second and recycled when it dies, in the 2D overlay space (canvas heights, origin bottom-left). The CPU only says how many are born each step.

**Birth.** A base emits at the rate that keeps `count` particles alive on average (Little's law: `count / life`), breathing by ±10% on two sines under 1 Hz. The bases (`flame.ts`) are a log line (a thin box), a torch head and a wick (discs), and a long line of fire. Particles are born at about 1900 K; on a log line the ends are born up to 700 K cooler than the middle (`hook_emit`), which rounds the foot of the flame.

**Motion** (all in `hooks.wgsl`, spliced into the framework's update kernel):

```
a = up * buoyancy * (T - 300 K) / 1000                      buoyancy, from the framework
  - taper * (x - (axis + wind * age))                       hook_force: a spring towards the axis
  + curl_2d_anim((x, y - rise * t) * f, 0.6 t) * s * (0.2 + height share)   hook_force: rising curl noise
v = wind + exp(-3.2 dt) (v + a dt - wind)                   the framework's exact drag
```

Buoyancy is set so the terminal speed, averaged over the particle's cooling, carries it the flame height in its life. The spring pulls every particle towards the base's axis (or, on a line of fire, mostly towards the point it was born above), so the flame tapers to tips; the axis moves with the wind, so the flame leans instead of being pulled back upright. The turbulence is the hooks' own curl noise rather than the framework's: the framework's field is fixed in space and only evolves, which made one large standing eddy throw the whole flame sideways; this one scrolls upwards at about the flame's own speed, so an eddy travels with the particles and a tongue forms and climbs, and it is weak at the base and strong at the tips, as a real flame is laminar low down and turbulent high up.

**Colour and shape.** Temperature cools exactly (Newton, `hook_update`) so the mean particle ends its life at 950 K. `hook_sprite` maps temperature to heat (1 at 2000 K, 0 at 800 K) and through `ramp_fire` (or, in the `black body` preset, `blackbody_radiance`), scaled so one sprite is at most about 1 in radiance: the body is the overlap. Size follows a curve (0.75 at birth, 1 at a fifth of the life, 0.3 at death); the custom sprite shading (`shade.wgsl`) draws a gaussian dome that softens as the particle ages, and the quad is stretched along the velocity, so a rising puff is a teardrop. Sprites are added in any order (no sort). Low down, many young hot sprites overlap and the tail's tonemapper turns the sum white-yellow; higher up, fewer, cooler, smaller sprites leave orange and red tongues.

**Embers.** A flame particle that dies of age throws off an ember with probability `embers / rate` (`hook_die` calls `ps_spawn_with`: GPU spawning, no CPU round trip). Embers keep 18% of the lift, cool at 0.45/s, are drawn with the ember shape and the black body, and drift up for two or three seconds.

**Pointer.** The pointer is an igniter (`createPointerIgnition`): a press lights a fire where it is, a drag spreads it along the stroke (each run of drag segments becomes a moving segment emitter, swept so a fast stroke leaves no gaps), and on release the fire dies down over about a second. Up to three at once.

**Drive.** `drive` (`none`, `scroll`, `audio`) adds up to half of the calm emission. It never touches the clock.

**Smoke** was left out. On an overlay it needs real coverage, which the shared sprite renderer (additive only) cannot write; 7.9 found sorted premultiplied puffs the right way, at the price of a second renderer, a depth sort and a pipeline of its own for what is a small part of a campfire. The fluid jet (7.8) shows smoke from a fluid's soot instead.

### Compared with 4.1, the scrolling-noise flame, at equal cost

Measured in headless Chrome 155 on the M1 Max at 1920 × 1080 (the HUD's GPU span of one frame, tail included), interleaved with `noise-flame` in three rounds of three loads each, median of the rounds; another agent was using the same GPU, so the spread is wide:

| What                                                   | Frame (ms) | Rounds           |
| ------------------------------------------------------ | ---------: | ---------------- |
| `noise-flame`, default wall (62% of the canvas height) |       1.27 | 1.17, 1.51, 1.27 |
| `noise-flame`, height 0.3                              |       1.20 | 1.42, 1.15, 1.20 |
| `noise-flame`, height 1.4 (the whole canvas)           |       1.30 | 1.24, 1.30, 1.57 |
| `particle-flame` campfire, 250 particles               |       1.56 | 2.96, 1.56, 1.53 |
| 500                                                    |       1.41 | 1.39, 1.41, 2.26 |
| 1 000                                                  |       1.83 | 1.47, 1.83, 2.07 |
| 2 500 (default)                                        |       2.44 | 2.22, 2.94, 2.44 |
| 5 000                                                  |       3.05 | 2.93, 3.47, 3.05 |
| 10 000                                                 |       3.99 | 3.99, 4.28, 3.90 |
| 20 000                                                 |       6.14 | 5.43, 6.14, 6.81 |
| 2 500, sprites, flame and base twice the size          |       3.58 | 3.58, 4.67, 3.58 |
| 2 500, sprites, flame and base half the size           |       2.29 | 1.82, 2.29, 3.03 |
| `line of fire` preset (5 000)                          |       3.31 | 2.64, 3.31, 3.43 |

The tail alone reads 1.1 to 1.3 ms here, so `noise-flame` is at the floor and **equal cost is about 400 to 500 particles**: the particle flame costs the noise flame's frame from a few hundred sprites up. Of the default frame, the HUD's own passes read about 0.15 ms for the simulation step, 0.04 ms for writing the sprite instances and 1.1 ms for drawing them; at 20 000 the draw is 8 ms. The cost is the sprites' fill, not the simulation.

How they compare at that cost (`output/browser-7d/compare/particle-vs-noise-flame.png` in the working copy: noise-flame wall, line of fire at 450 and at 5 000, campfire at 450 and at 2 500, then the light page):

- **Shape.** The noise flame is a wall: a solid body with tongues and detached licks along its top, and nothing else; it has no base, no width and no axis. The particle flame has a real shape: a base with an end, a body that tapers to tips, a lean. A campfire at 450 particles is a recognisable flame (a little lumpy); a line of fire at 450 is not: it breaks up into a row of separate blobs. A wall of particle fire needs about ten times as many particles (the 5 000 of the preset) to overlap into a body, and then costs two to three times the noise flame.
- **Motion.** Noise is advected texture: tongues rise and change, but every part moves at the same speed and there is no history. Particles carry their history: a tongue that swings out keeps going, a gust leans the whole flame and the tips lag it, embers leave the flame and drift.
- **Edge.** The noise flame's edge is sharp and detailed at any count (the detail is in the texture). The particle flame's edge is as soft as its sprites, and with few sprites it is lumpy; more, smaller sprites sharpen it at a cost proportional to their number.
- **Pointer and wind.** The noise flame does neither. The particle flame leans in the wind with lagging tips, and the pointer lights new fires anywhere, which no amount of noise can do without becoming a different effect.
- **Cost with flame size.** The noise flame's cost follows the area under its height, and with the baked noise tile it is at the floor either way (0.3 and 1.4 of the canvas height read the same). The particle flame's cost follows the sprites drawn: doubling the sprite size, the flame and the base read 3.58 ms against 2.44, halving them 2.29 ms. The draw is not purely fill-bound at these sizes (a quarter of the area did not save three quarters of the time), so the count matters as much as the size. A big particle flame filling the canvas is the expensive case; a small one (a candle, a torch, an icon) costs almost nothing, where the noise flame pays for its whole box whatever is in it.

What each is for: the noise flame for a wall or a band of fire, cheaply and sharply, at any size; the particle flame for a fire with a shape and a place, one that moves with wind and pointer, sheds embers and can be lit anywhere, at a few hundred to a few thousand sprites.

## Cost

GPU time: not measured yet with the benchmark harness (`npm run study`); the scorecard has no `gpuMs`.

Indicative readings, Apple M1 Max, 1920 × 1080, headless Chrome, the HUD's GPU span of one frame including the HDR tail, median of three rounds of three loads, with another agent using the same GPU: 2.44 ms at the default 2 500 particles (table above); two later checks of the default, after the last changes, read 2.72 ms (2.64 to 2.84) and 2.10 ms (1.98 to 2.80), with `noise-flame` at 1.47 ms alongside the second. Tier A (2 ms) holds up to about 1 000 particles on this machine, Tier B (6 ms) up to about 15 000. The pool is the next power of two above three times `count` (8 192 at the default): 64 bytes of state with the per-particle user data, 12 of list entries and 48 of sprite instance per slot, about 1 MB.

What scales the cost: the number of sprites and their size on screen. The simulation is about 0.15 ms whatever the count.

Bundle: not measured.

## Pitfalls

- **Too few particles look like bubbles.** Under about a thousand for a campfire, and several thousand for a line of fire, the sprites stop overlapping into a body and read as separate blobs. The radiance per sprite is scaled by `sqrt(2500 / count)` so the body stays about as bright at any count, which is what makes the blobs visible rather than dim.
- **A standing eddy.** The framework's curl turbulence is fixed in space; with flame-sized cells one eddy held the whole flame bent to one side for seconds. The hooks' noise rises with the flame.
- **Black body colour saturates to lemon yellow.** Summing many 1900 K sprites (red and green, no blue) drives the per-channel tonemapper to (1, 1, 0) in the dense core; `ramp_fire` has its pale core built in. The `black body` preset is kept to show it.
- **Light page.** Over the light page the flame reads as flame-coloured ink: an orange and yellow body with red tips, in the same way as `noise-flame`. The faint outer haze of the sprites disappears into the paper, so the flame looks smaller. `lightPage` is `yes` for the campfire; at a few hundred particles the line of fire is pink blobs.
- **Changing `count`** past a power-of-two boundary rebuilds the pool and warms it up again: a one-frame hitch.
- **Flicker.** The default measures `low` on the flash analyser (two cells of red flashing, 12 300 px² against the 21 824 px² limit, from the orange-red tongues swinging across a cell; the frame mean moves 0.2% of white), and so does every preset. The per-sprite twinkle is capped at 4 Hz and the breath is under 1 Hz and 10%; the turbulence is what makes the tongues flash, so do not raise its rise or evolution speed without measuring. As with every effect on the framework, runs are not repeatable to the bit (pool slots are handed out in atomic order and seed each particle's randomness), so keep a margin.

## When to use it

A fire with a place and a shape: a campfire, a torch or a candle over a dark hero or a card, a fire the visitor lights by pressing, a flame that leans in a wind. Tier B at the default 2 500 particles (provisionally: no integrated GPU measured), Tier A at about 1 000. Reach for `noise-flame` for a wall or band of fire, where it is sharper and cheaper at any size; for `candle` or `torch` for a single small laminar flame drawn by a shader; and for the fluid effects (`fire-fluid`) when the fire must interact with its surroundings as a gas.

## References

- W. T. Reeves, "Particle Systems: A Technique for Modeling a Class of Fuzzy Objects", ACM Transactions on Graphics 2(2), 1983: the technique, and the Genesis wall of fire.
- R. Bridson, J. Hourihan, M. Nordenstam, "Curl-Noise for Procedural Fluid Flow", SIGGRAPH 2007: the turbulence.
- [docs/effect-authoring.md](../../../docs/effect-authoring.md), "Particles": the framework this is built on; `src/effects/noise-flame/notes.md` for the effect it is compared with.
- `src/wgsl/ramp.wgsl` (story 3.2) and `src/wgsl/blackbody.wgsl` (story 3.1): the colour.
