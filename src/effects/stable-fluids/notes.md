## How it works

This is the validation scene of story 6.1: Water Temple's 2D stable-fluids solver, ported to `src/gpu/sim/fluid.ts` and re-validated here, doing the things Epic 6 will ask of it. It is not a fire model yet; it has no fuel and no reaction.

**The solver** (`fluid.ts` and the `fluid-*.wgsl` kernels beside it) is Stam's stable fluids on a staggered (MAC) grid, in compute shaders. One step is: advect the velocity by itself, add forces (vorticity confinement, buoyancy from the dye, body force), project (divergence, a pressure solve, subtract the gradient), then advect the dye. Velocity lives on cell faces in one `rgba16float` texture of (W + 1) x (H + 1) texels; pressure, divergence and vorticity are `r32float` at cell centres. The staggered layout makes the divergence and the pressure gradient matching compact differences, so the projected field is divergence-free to the solver's tolerance and a solid face is exactly zero. The dye lives on a grid four times finer (512 x 288 texels at the default 128 x 72 cells) and is carried by the coarse velocity through the texture filter. Advection is semi-Lagrangian, MacCormack or BFECC, the last two with the limiter that keeps them stable. The pressure is solved by damped Jacobi (30 warm-started iterations a step by default), red-black SOR, or a multigrid V-cycle. 60 fixed steps a second, at most 4 a frame.

**The scene.** A bed at the bottom feeds five tongues of heat (dye r) and smoke (dye b), each breathing on its own slow clock, and a slow side wind comes and goes. Three things that combustion needs, and that this port adds, are switched on:

- buoyancy reads the dye through `buoyancyWeights`: heat lifts (weight 1), smoke weighs down a little (-0.05);
- the dye dissipates per channel: heat cools at `cooling` (0.7 /s), smoke thins at `smoke fade` (0.25 /s);
- the gas at the bed expands: a standing divergence source of `expansion` (0.5 /s) in a disc of radius 0.08 canvas heights, which the projection targets (div u = S) instead of zero. The edges are `open`, so the expanded gas leaves through them.

The pointer stirs through `fluid-stir.ts`: a press-drag pushes the fluid with the pointer's velocity and lays glowing heat and smoke; a hover pushes gently and lays smoke only (fire is lit by a press, as in the Epic 5 ignition layer). The first frame is a plume laid analytically, so a still frame (reduced motion, poster) is already a picture.

**Display** (`display.wgsl`, one pass at canvas size): smoke is a surface with real coverage, `1 - exp(-opacity * smoke)`, written premultiplied with that coverage in alpha and lit by a dim ambient and the glow of the bed; heat is emission through `ramp_fire`, added on top, and is what blooms. It is an overlay (`OVERLAY_PARAMS`). The `diagnostic` select shows the solver's own fields: velocity (hue is direction), vorticity, the pressure potential, and what the last projection removed (the divergence advection left, minus the expansion source: cell-sized speckle in the plume, close to zero over the bed, where the warm-started pressure already holds the source).

**What the port changed** (details in `fluid.ts`'s header): shaders are imported as `ShaderSource` modules, with the generated uniform struct added by `withChunks`; half floats come from the shared `half-float.ts` (ties now round to even); `ObstacleRect` comes from `dom-rects.ts`. Besides the three additions above, two Water Temple bugs turned up in this scene and are fixed, each with a test: the multigrid V-cycle diverged with `open` edges on grids of 96 cells and more (a coarse level put its zero-pressure boundary too far out), and vorticity confinement at an `open` edge grew a sheet of flow that reached the speed cap in about five seconds (it now fades out over the last four cells before an open edge). Neither touches `wall` or `wrap`.

## Cost

Measured on a quiet GPU (Apple M1 Max, 1920 × 1080, defaults): 0.8 ms per frame on Dawn and 3.19 ms for one frame in Chrome 155 (median of three loads; `docs/studies/epic-6.md`, `docs/studies/browser-check.md`), inside the Tier B budget on this machine; no integrated GPU or phone has been measured. An earlier reading: Chrome 155, Apple M1 Max, 1920 x 1080, defaults: **3.1 ms** of GPU time for one frame as the HUD reads it (three loads: 3.08, 3.10, 3.73 ms; indicative, it includes the browser's timing floor). That is inside the Tier B budget (6 ms) on this machine; no integrated GPU or phone has been measured, so the tier is provisional. Not measured on Dawn yet (`npm run study`).

What can be counted at the defaults:

- **Simulation:** 128 x 72 cells, dye 512 x 288. Per step: MacCormack velocity advection (2 dispatches over 129 x 73 faces), curl, curl blur and forces (3), the divergence and 30 Jacobi iterations and the projection (32 over 128 x 72), MacCormack dye advection (2 over 147 thousand texels). About 40 dispatches a step, one step a frame at 60 Hz. The dye advection is the largest single cost; the pressure iterations are the most dispatches.
- **Display:** one pass over the canvas, one filtered dye tap, then the HDR tail (bloom and output), which costs more than the solver at 1080p.
- **Memory:** about 4 MB for the solver (three dye textures are 3.5 MB of it), 25 MB in all at 1080p with the tail.
- **What scales it:** the solver scales with `resolution` squared and does not depend on the canvas; the dye is four times the velocity grid on each side, capped at 1024. `fine multigrid` (256 cells, dye 1024) is about four times the simulation work of the default. BFECC adds one dispatch per field, multigrid replaces the 30 iterations with a few V-cycles of roughly 10 dispatches each.

## Pitfalls

- **Confinement adds energy; damping takes it out.** Strong confinement fills the field with cell-sized vortices: at 20 / s against a damping of 0.9 / s the mean speed over the whole canvas settles at about 0.2 canvas heights a second, four times the default's, bounded but busy (measured over 30 s). Water Temple's rule of thumb was to keep confinement under about 14 times the damping. The defaults are 3 against 0.9; `stirred smoke` is 12 against 1.2.
- **Open edges are where things go wrong.** The velocity on an open edge is held by nothing outside it. Before the port's fixes, this scene reached the speed cap (5 canvas heights a second) about five seconds in with confinement on, and with the multigrid solver within the first second. Both are fixed, with tests, but any new force should be checked against `open` edges for several seconds, not three frames.
- **A source in a closed box has no solution.** With `wall` edges the divergence source must sum to zero (a sink balancing it), or the pressure drifts further every step. Fire wants `open` edges.
- **Half-float dye.** The dye is `rgba16float`; values are clamped to ±64 by default and a quantity that changes by less than half a step per write is lost to rounding (truncation on Apple GPUs). Keep the combustion quantities normalised, about 0 to 4.
- **Re-creating the grid clears it.** A new `resolution` or a large change of the canvas's shape re-creates every texture (`generation` goes up); the scene lays its first plume again. Small changes of shape (under 6%) stretch the fluid instead of clearing it.
- **WGSL reserved words.** A helper called `diagnostic` does not compile: it is reserved (for the `diagnostic` directive).

## When to use it

As the reference for the solver every Epic 6 effect builds on: switch the scheme, the pressure solver, confinement and the grid and watch the diagnostic views. As a smoke effect, it is a Tier B overlay that a visitor can stir, readable over a dark page and, as grey haze with a red core, over a light one; it needs compute shaders, so there is no WebGL2 path. For smoke that only drifts and is never touched, a fragment-shader effect with advected noise (`advected-noise`, `smoke-shading`) is cheaper. For fire, wait for the combustion layer (stories 6.2 to 6.4), which keeps temperature, fuel and soot in this dye.

## References

- Jos Stam, [Stable Fluids](https://www.dgp.toronto.edu/public_user/stam/reality/Research/pdf/ns.pdf), SIGGRAPH 1999.
- Mark J. Harris, [Fast Fluid Dynamics Simulation on the GPU](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu), GPU Gems, chapter 38, 2004.
- Ronald Fedkiw, Jos Stam, Henrik Wann Jensen, [Visual Simulation of Smoke](https://web.stanford.edu/class/cs237d/smoke.pdf), SIGGRAPH 2001 (vorticity confinement, buoyancy from temperature and density).
- Andrew Selle, Ronald Fedkiw, ByungMoon Kim, Yingjie Liu, Jarek Rossignac, [An Unconditionally Stable MacCormack Method](https://physbam.stanford.edu/~fedkiw/papers/stanford2006-09.pdf), Journal of Scientific Computing, 2008.
- Duc Quang Nguyen, Ronald Fedkiw, Henrik Wann Jensen, [Physically Based Modeling and Animation of Fire](https://physbam.stanford.edu/~fedkiw/papers/stanford2002-02.pdf), SIGGRAPH 2002 (expansion across the flame front as a divergence source).
- William L. Briggs, Van Emden Henson, Steve F. McCormick, A Multigrid Tutorial, 2nd edition, SIAM, 2000 (boundary conditions on coarse grids).
- Robert Bridson, Fluid Simulation for Computer Graphics, 2nd edition, CRC Press, 2015 (the MAC grid and the pressure projection).
