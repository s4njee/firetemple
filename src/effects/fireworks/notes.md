## How it works

A firework show on the Epic 7 particle framework (`src/gpu/particles/`). The CPU decides only when and where a shell goes up (`show.ts`); everything after the launch happens on the GPU in the hooks of `hooks.wgsl`, which the framework splices into its kernels. The system is three-dimensional in the 2D overlay space (canvas heights, origin bottom-left): the orthographic overlay camera ignores depth, so a spherical burst is a real sphere seen from the front (denser at the rim) and a ring is an ellipse.

**Stages as roles.** A particle's `kind` packs its role (shell, tail spark, star, trail ember, crossette sub-star, crackle pop, smoke puff, glitter glint, break glow), its shell type, its salt and, for a shell, its burst count. Two emitters: the launcher (rate 0, one `burst(1)` per shell, with the shell's `kind`, direction and speed set just before) and a template every GPU-spawned child is sampled from (speed 0; `hook_emit` builds each child's velocity from the request's, `source.velocity`, which is the parent's).

- **Shell.** Rises with no drag, so the launch velocity solved on the CPU (`launchVelocity`: the semi-implicit Euler apogee is `v0 dt / 2` below the continuous one, and is corrected) puts its apogee at the target. `hook_update` spawns a tail spark every step (three for a palm) and kills the shell on the first step whose vertical speed is not positive. `hook_die` then calls `ps_spawn` for its `count` stars, one break glow and the smoke puffs; the stars are born in the emit pass of that same step.
- **Star directions** (`hook_emit`, from the request's index and count): point _i_ of _n_ on a golden-angle (Fibonacci) sphere under a random rotation of the burst (Shoemake's quaternion from the burst's seed) for every spherical type, so a burst is evenly filled with no clumps and no pole; a ring in a random plane within about 40 degrees of facing the viewer; the upper sphere for a palm. Speed per type (0.36 to 0.48 canvas heights a second at size 1, so a burst reaches about 0.25 canvas heights) with ±5% jitter (none for a ring), then linear drag per role (`hook_force`: 1.6/s for stars, 2/s willow, 1.3/s palm, 3 to 4/s embers) and gravity.
- **Multi-stage.** Chrysanthemum, willow and palm stars shed charcoal embers as they fly (`hook_update`, a hashed chance per step; willow embers hang for two seconds), glitter stars shed glints that strobe at 3 to 4 Hz each with its own phase. Crossette stars die after about 0.6 s and `hook_die` splits each into four sub-stars across its path (the two perpendiculars of its velocity, both signs); sub-stars have their own role, so they never split again. Crackle stars die into six pops each, which wait a random 30 to 580 ms and then shine for 80 ms.
- **Cooling** is per role in `hook_update` (Newton towards 300 K): tail sparks in a fraction of a second, willow embers over two, stars hardly at all.

**Colour.** `hook_sprite` writes every sprite's linear HDR radiance. Coloured stars use the emission of their salt, computed once (offline, CIE 1931 colour-matching functions, Wyman-Sloan-Shirley fit) from its molecular bands and pulled into the Rec.709 gamut by adding white: strontium red (SrCl 636 nm, SrOH 606 and 682 nm) `(1, 0, 0.007)`, barium green (BaCl 507 to 532 nm) `(0, 1, 0.4)`, copper blue (CuCl 420 to 460 nm) `(0.21, 0, 1)`, sodium yellow (the D lines, 589 nm) `(1, 0.26, 0)`, purple (strontium plus copper) `(1, 0, 0.72)`, magnesium white `(1, 0.98, 0.95)`; titanium silver and charcoal gold are blackbodies (3300 K, and the particle's own 2100 to 2400 K, cooling). An `incandescent white` share (default 5%) mixes in the continuum of the hot particles a real star also has. Stars peak at `brightness` (5) in the HDR scene; the tail's bloom does the glow. Every spectral colour lies outside sRGB: on screen a bright star burns to a white-yellow core with its hue in the halo, as the tonemapper does with any saturated light.

**The schedule.** Ambient shows use `createAmbientIgnition` (a Poisson process on the simulation clock) for break points in the sky; the pointer (`createPointerIgnition`) launches a shell towards a press and another every 0.8 s while held. Every request goes through `createLaunchSchedule`, which delays a launch so its break comes at least `spacing` seconds after the previous one. The drive (`none`, `scroll`, `audio`) adds up to 60% more shells than the calm rate, never speed. The first frame warms up one shell that broke half a second ago, so a reduced-motion still shows a burst.

**Flash.** A burst is a sudden bright event over a large area, so it was measured preset by preset with the WCAG 2.3.1 analyser (`tests/flash.ts`: 24 x 14 cells of a 1920 x 1080 view, a flash is a pair of opposite swings of 10% of white in a cell's mean, more than three a second over 21 824 CSS px² fails). Shaping, in order of what it buys:

- _Spacing between breaks_ (0.45 s default, 0.18 s in `finale`) is what holds the count per cell down: no cell sees more than three bursts a second unless the schedule allows it.
- _Ramp-up_: stars and the break glow rise over `ramp` (0.12 s, seven frames) instead of appearing at full brightness, and fade out over the last 30% of their life. This makes a burst bloom rather than pop; the analyser cannot see the difference (it counts swings, not their speed), but the eye can.
- _Limited peak_: the break glow is small (0.07 canvas heights) and dim (`glow` 0.4); the stars are points, so even a large burst covers a small share of any cell.

Measured over 10 s each (`FLASH_EFFECTS=fireworks FLASH_PRESET=... experiments/flash.test.ts`): every preset is `low`, with at most one flash in any cell in any second (two in `peonies and chrysanthemums` and `finale`), no flashing area at all, and a whole-frame mean that never moves by more than 0.4% of white (`evening show`), 2% (`willow gold`) or 3.7% (`finale`). Pushed to the worst the controls allow (`finale` with `ramp` 0, `glow` 3, `brightness` 12, `size` 1.8, four shells a second 0.1 s apart, bloom 2) it is still `low`: three flashes in the busiest cell (the limit is more than three), a 14% frame swing. So `scorecard.flash` is `low` and no preset is listed in `flashPresets`.

## Cost

GPU time, measured with another browser sharing the GPU (Apple M1 Max, 1920 × 1080, defaults, tail included): 0.31 ms per frame on Dawn and 2.93 ms for one frame in Chrome 155 (median of 3 loads, 2.35 to 3.76; `docs/studies/epic-7.md`, `docs/studies/browser-check.md`). Tier B on this machine by both readings; no integrated GPU or phone has been measured. Bundle: 93.8 kB.

Indicative readings, Apple M1 Max, 1920 x 1080, headless Chrome, HUD "GPU" span of one frame including the HDR tail, median of three loads (two other agents were using the same GPU):

| Show                             |                  Frame |
| -------------------------------- | ---------------------: |
| `evening show` (default)         | 1.35 ms (0.94 to 1.37) |
| `willow gold`                    | 1.39 ms (1.24 to 1.57) |
| `finale` (three shells a second) | 1.28 ms (1.10 to 1.65) |

A last check of the default after every change (bigger bursts) read 1.65 ms (1.64 to 2.02, three loads, heavier contention). Most of it is the HDR tail's bloom; the particle step and the sprites read 0.1 to 0.4 ms each, at the HUD's floor. Tier B as planned, and the default fits Tier A's budget on this machine.

The pool holds 65 536 particles: 48 bytes of state, 16 of user data, 12 of list entries and 48 of sprite instance a slot, 8.1 MB, plus a spawn queue of 4 096 requests (256 KB). The live count follows the show. Peak live particles of one shell at size 1 with trails and haze on (`FIREWORKS_CENSUS=1 npx vitest run tests/epic7-e.test.ts -t census`): peony 168, ring 88, crossette 66, crackle 291, palm 1 292, chrysanthemum 2 449, glitter 2 545, willow 9 227 (80 stars shedding about 54 embers a second each, which hang for two seconds); everything, smoke included, is gone 7 to 8 s after the launch. The pool holds about seven willows at their peak at once. A trailing star spawns through one queue request per ember, a few hundred requests a step at worst, which the framework plans with a prefix sum in one workgroup. Everything is drawn as one instanced, indirect sprite draw; the tail's bloom costs more than the particles.

Bundle: not measured.

## Pitfalls

- **The analyser does not see a firework as a flash.** A burst is hundreds of points, and the WCAG measure averages light over cells about 80 CSS px across, so a cell's mean moves by a few percent of white even inside a dense burst. That is why every setting measures `low`. Do not read it as "bursts cannot hurt": the ramp-up and the spacing are there for the eye, and a design that adds a big white break flash should be measured again.
- **One launch per stepping frame.** The launcher's `burst(1)` is taken by the next step that runs; on a 144 Hz display some frames run no step, so the effect only arms the launcher again after a frame that stepped (`inFlight`), or a second shell would overwrite the first one's settings.
- **Spawned children are born at the end of the step, unmoved.** The burst's stars are emitted in the same step's emit pass, after the update, so they first move a step later. The tests read their velocities in that step to check the burst's shape.
- **Parent velocity.** `hook_emit` reads the request's velocity (`source.velocity`, the parent's) to build every child's: a crossette's cross is built from it. (The first version, before the framework exposed it, used a template with `speed` 0 and `inherit` 1 to the same end.) The shell's burst count still travels in the top bits of its `kind`, where `hook_die` needs it; `burst(n, user)` could carry it to `hook_emit`, but the shell would still have to keep it for its death.
- **Depth range.** The overlay camera sees `z` in -0.5..0.5; a star that drifts further is killed in `hook_update` (it would be clipped anyway). Burst radii are about 0.25 at size 1 and 0.45 at the largest size.
- **Light page.** Stars are points of saturated light: over the light page they are pastel confetti with a faint underlay haze. `scorecard.lightPage` is `no`.

## When to use it

A celebration over a dark hero, a launch or "thank you" page, or a click that answers with a shell where the pointer is. Tier B on the reading above (it would fit A on this machine; provisional until an integrated GPU has been measured). Use `embers` or `sparks` for a steady fire mood rather than events, and do not use it on a light page.

## References

- [docs/effect-authoring.md](../../../docs/effect-authoring.md), "Particles": the framework, its hooks and GPU spawning.
- T. Shimizu, _Fireworks: The Art, Science and Technique_, Pyrotechnica Publications (1981): shell types, star compositions and their emitters.
- J. A. Conkling, C. J. Mocella, _Chemistry of Pyrotechnics_, 2nd ed., CRC Press (2010): the emitting species (SrCl, SrOH, BaCl, CuCl, Na) and their bands.
- C. Wyman, P.-P. Sloan, P. Shirley, "Simple Analytic Approximations to the CIE XYZ Color Matching Functions", JCGT 2(2), 2013: the colours of the salts.
- K. Shoemake, "Uniform Random Rotations", Graphics Gems III (1992): the burst's random orientation.
- R. Swinbank, R. J. Purser, "Fibonacci grids", Q. J. R. Meteorol. Soc. 132 (2006): evenly spread directions on a sphere.
- W3C, [Understanding SC 2.3.1: Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html).
