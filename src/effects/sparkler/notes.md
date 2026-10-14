## How it works

A hand-held sparkler as real particles on the Epic 7 framework (`src/gpu/particles/`), in the 2D overlay space (canvas heights, origin bottom-left). `sparkler.ts` holds the particle system apart from the page so the tests drive the same code.

**The tip.** One emitter, a disc 0.4% of the height across, throws `sparks / s` (1 800 by default) in every direction at 0.5 to 1.5 times `speed`, each living 0.1 to 0.4 s (`life` is the mean). Strong linear drag (1.6/s) slows them within their short lives and a little gravity bends them down, which gives a sparkler's short, slightly drooping rays. They are drawn as streaks a 60 ms exposure long with their light conserved along the streak, the look of a photograph of a sparkler, blending into round dots as they slow (`shade.wgsl`). Colour is `blackbody_radiance(T)` from 2 800 to 3 300 K, cooling at 1.2/s: white-gold rays with orange ends.

**Swept emission.** The tip is moved with `moveTo` once a frame and every step of the frame sweeps it from where the last step left it; a spark born at fraction u of a step is placed at fraction u of the sweep. A tip swung at three canvas heights a second (0.05 a step) still lays its sparks down a spark-spacing apart, with no clumps at the frame or step boundaries (`tests/epic7-c.test.ts` checks the largest gap).

**Forking** (`hook_update` + `ps_spawn`, `hooks.wgsl`). The branching is what makes it a sparkler rather than a fountain: a burning fleck bursts mid-flight into two or three. Each spark decides once, from its own seed, whether it forks (`fork chance`, 55%) and when (35 to 80% of its life). In the step its age crosses that moment it asks the spawn queue for two children (three, 40% of the time) of the next generation and dies. `hook_emit` sends them off either side of the parent's direction (the third straight on) by about `fork angle`, at 0.86 to 1.3 times its speed and 5% hotter (the burst flares), each living 60 to 100% of what the parent had left, so a child is always shorter-lived than its parent. Generation `generations` (2) never forks: at most nine leaves a spark. No CPU round trip.

**How many are alive.** Little's law: rate × mean life × a fork factor `sparkLifeFactor` (each generation's expected particle-seconds in units of its parent's life, k = c (E[f] + E[n] E[1 − f] E[h] k′) + 1 − c). At the default that is 1 800 × 0.25 × 1.31 = 590; measured 598.

**The hand.** The pointer is the hand through the shared igniters (`createPointerIgnition`, hover counts): the tip is wherever the pointer is, so it writes in the air. When the pointer has been gone 0.8 s the tip drifts back over 1.2 s to a slow figure of eight (a 1:2 Lissajous curve, `idle figure` seconds round, 0.7 of the width and 0.6 of the height times `idle figure size`), so it is never still.

**Core and afterimage.** The core (a tight sprite at 30 times paper white), its halo and an afterimage of the tip's path are a few hundred CPU-written sprites in one draw: the path of the last `afterimage (s)` is resampled every 0.0018 heights (fewer dots, each brighter, when it is long, at most 480) and fades with age, a light-painting trail. Trails proper are story 7.7. `drive` (scroll or audio) adds up to 60% of the calm rate, never speed. The first frame runs half a second of simulation, so a still frame under reduced motion is already burning.

## Cost

GPU time: not measured yet with the benchmark harness (`npm run study`); the scorecard has no `gpuMs`.

Counts: about 600 sparks alive at the default (1 800 a second plus 5 300 forked children a second); pool 4 096 (the peak drive rate × mean life × fork factor × 2.5, a power of two); 480 afterimage sprites at most.

Indicative readings, Apple M1 Max, 1920 × 1080, headless Chrome, HUD "GPU" span of one frame including the HDR tail, median of three loads, with other agents on the same GPU: 1.35 ms (1.31 to 1.44) at the default (a later run of the final version: 1.58 ms, 1.08 to 1.63), 1.39 ms (1.19 to 2.07) at the maximum of 8 000 sparks a second. Both are at the HUD's floor of about 1.2 ms; the frame is the bloom tail.

On Dawn with GPU timestamps, at 200 000 sparks a second so the step can be resolved (`PARTICLE_BENCH=1 npx vitest run tests/particles.test.ts -t "spawn requests"`, two runs): 50 000 live without forks cost 0.07 to 0.11 ms a step (1.4 to 2.3 ns a particle); with forks, 67 000 live cost 0.12 to 0.15 ms (1.8 to 2.3 ns a particle). Forking at that rate means thousands of spawn requests a step; the framework used to plan them in one thread and that cost 1.2 ms a step (18 ns a particle), and since it plans them with a prefix sum in one workgroup forking costs about what the extra particles do. At the default (about 40 requests a step) neither shows.

Tier B, provisional: it is under 2 ms on this machine, but the A budget is for an integrated GPU, which has not been measured.

Bundle: not measured.

## Pitfalls

- **Flicker.** Thousands of short bright sparks around one point could flash the cells round the tip. Every preset measures `low` with no flashing area (peak cell one flash a second), for the same two reasons as the spark shower: many sparks each dim rather than few bright ones, and a long exposure with the light conserved along the streak, which smooths each cell's brightness over several frames. The core is steady. The tip only moves as fast as the pointer moves it; a visitor swinging it hard across a large canvas makes local brightness changes of their own.
- **Dark pages only.** Over the light page the sparks are thin pale orange lines round a pale core. `scorecard.lightPage` is `no`.
- The fork moment is quantised to a step: a parent lives up to one step past its fork and the children start at the step's end. Little's law still holds to about 2% (the test allows 8%).
- A fork only happens in the step where the age crosses the chosen moment, so a spark must live at least a step past it; with the shortest lives the controls allow (a few hundredths of a second) some forks are missed.
- The tip is a point: a sparkler's long burning rod and its smoke are not drawn. The afterimage is drawn from the CPU's record of where the tip was each frame, so a swing faster than a frame is a straight chord in it (the sparks themselves are swept).
- Sizes are in canvas heights, so in a 160 px band the whole sparkler is about 60 px across.

## When to use it

A celebration moment on a dark page, a cursor that writes in light, or a dark hero or card that should never be still. Tier B (provisional). For fireworks proper, see story 7.5; for a trail that persists, story 7.7. Do not use it on a light page.

## References

- [docs/effect-authoring.md](../../../docs/effect-authoring.md), "Particles": the framework, its swept emitters and GPU spawning.
- J. D. C. Little, "A Proof for the Queuing Formula L = λW", Operations Research 9(3), 1961: the live count.
- `src/wgsl/blackbody.wgsl` (story 3.1) and `src/wgsl/sprite.wgsl` (story 3.9): the colour of a spark and the streak shape.
- W3C, [Understanding SC 2.3.1: Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html), and `tests/flash.ts`.
