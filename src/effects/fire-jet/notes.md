## How it works

A flamethrower or a dragon's breath, made of two simulations that run one after the other every frame: the Epic 6 fire fluid supplies the flow, and the Epic 7 particle framework puts burning things in it.

**The fluid** (`createFireFluid` on the stable-fluids solver, 128 velocity cells on the long side, open on every edge). A nozzle drives it in two ways:

- a burner capsule in the nozzle's mouth adds fuel and holds a pilot's heat, so the fuel lights as it leaves (the fire module's own `setSources`, with the fuel weight scaled by the jet speed: a fast stream carries the same fuel per second over a longer path);
- a push of momentum along the aim over the first 0.07 canvas heights of the jet (`fluid.addForce`), queued before every update and sized to the simulated time: gas crosses that stretch in about length / speed seconds, so a push of speed × speed / length per second brings it up to the jet speed by the time it leaves (`jetImpulse` in `jet.ts`). Measured at the default 1.4 heights per second, 1.5 s in (one run; the flow is turbulent and differs from run to run): 1.0 at 0.03 canvas heights from the nozzle, 1.3 at 0.06, 1.95 at 0.12 (the burning gas expands and accelerates), all within 6° of the aim; then 1.0 at 0.2, and 0.5 at 0.3, where the jet has spread and turned 50° upwards as it rises.

The gas burns as it goes, expands, slows, rolls up into eddies along the shear layers and rises; its soot is the smoke.

**The particles** (a 2D pool of 32 768, overlay space) read the fluid's resolved velocity texture: `system.setField(fire.fluid.fieldsView)`, `forces.fieldMapping = overlayFieldMapping(aspect)`, `forces.field = 'drag'` at the droplets' coupling (2.2/s). What differs by kind is in `hooks.wgsl`:

- **Burning droplets** leave the nozzle 5 to 30% faster than the jet, within a narrow cone, and are dragged towards the gas slowly, so they outrun it: measured 1.6 heights per second at birth, 0.9 after a third of a second, 0.3 after 0.7 s. Gravity (`hook_force`) bends them into the arc a real stream of burning fuel makes. They cool slowly, shed flame and the odd ember along the way (`hook_update` calls `ps_spawn_with`), and break into embers when they hit a wall hard (`hook_collide`).
- **Flame sprites** come from the nozzle and from every droplet (14 a second each, born at the droplet's temperature). `hook_force` drags them towards the gas at a further 7/s, so they are the gas made visible: they slow from 0.7 to 0.5 heights per second, spread, curl and rise with it. They grow to three times their size as they slow (their own size curve in `hook_sprite`), cool along `ramp_fire`, and are stretched by only a third of their speed (`hook_sprite` scales the sprite's velocity), so they are puffs blurred by motion while the droplets are streaks.
- **Embers** drift up on their own heat for one to three seconds.

**The aim.** With a pointer over the canvas the nozzle turns to it (in 0.12 s, within 70° of its rest direction, so it never fires back into its own edge); idle, it sweeps slowly. Dragon breath comes in breaths: 3.2 s of fire, 1.8 s of smoke, with half-second ramps. `wall` adds a wall: a solid in the fluid's obstacle mask, which the gas rolls along and over, and a box collider for the particles, on which droplets splash.

**The look: fluid and particles together, by default.** `look` switches either off. With the particles alone the stream, the arc and the billows are all there, but there is no smoke and the flame is soft everywhere. With the fluid alone the flame is a thin curling sheet that hugs the first third of the jet and then rises: it has the sharpest detail of the three (rolled-up shear layers, crisp tongues) and real smoke, but a 128-cell grid cannot carry a droplet stream that outruns the gas, so the long burning arc of a flamethrower is missing. Together, the particles give the stream, its reach and the volume of flame, and the fluid gives the fine curling edges and smoke with real coverage, which is also what makes the jet read over a light page. The fluid's glow is turned down to 0.7 of its own level so the two do not add up to white.

### One-way coupling, and whether two-way is worth it

One way, the field moves the particles and nothing goes back, which is cheap (the particles read one bilinear tap of a texture the solver writes anyway) and stable (nothing the particles do can blow up the solver). What it costs in this effect:

- **Flame shed far along the arc sat in air the jet never heated or moved.** The fluid's flow only reaches as far as its own jet; beyond that the droplets fly through still, cold air, so a flame sprite dragged hard to the gas simply stopped and hung. They needed their own lift (`hook_force`, 2 heights / s² per 1000 K): a stand-in for heat the fluid never received.
- **The fluid's fire stops short.** The fuel the fluid burns is only what the nozzle gives it; the droplets carrying fuel down the arc do not release any into it.

Two-way coupling would mean the particles pushing the gas (their drag, opposite) and giving it fuel and heat where they burn. Done properly on the GPU it needs a particle-to-grid scatter (atomic fixed-point sums into a buffer: WebGPU has no float atomics), a pass turning that into a force texture, and a place to add it: the fire module already owns the solver's only `hooks.forces` and `hooks.dye`, so both would have to be chained. The framework has no splat for this.

To see whether it is worth building, the effect has a cheap stand-in, `two-way coupling` (the preset of that name): the CPU predicts the mean droplet's path (the same ODE the GPU integrates, solved exactly for still air: `meanDropletPath` in `jet.ts`), and along six stretches of it queues the stream's drag on the air (`addForce`, half its momentum transfer, scaled by the droplet rate and the share still alive) and fuel and heat (`addDye`). Twelve splats a frame. The difference is large: the fluid's flame follows the arc out and a column of burning gas rises from where the stream comes down, where one-way the fluid's fire curls up near the nozzle. It costs 3.5 ms a frame against 3.3 (indicative, below). The preset runs the jet at 1.0 heights per second to stay under the flash limit (the rising column flickers red); the one-way jet at the same speed is the comparison. It is a mean field (one path, not each droplet), so it is wrong when the droplets fan out (wide spread, a wall); a real scatter would be right, and would also let the particles' own buoyancy go. For a flamethrower that is worth doing; for embers, sparks or smoke riding a flow, where the particles carry little momentum and no fuel, one way is enough.

## Cost

GPU time, measured with another browser sharing the GPU (Apple M1 Max, 1920 × 1080, defaults, tail included): 5.55 ms per frame on Dawn and 3.61 ms for one frame in Chrome 155 (median of 3 loads, 3.39 to 3.72; `docs/studies/epic-7.md`, `docs/studies/browser-check.md`). Tier B on this machine by both readings; no integrated GPU or phone has been measured. Bundle: 145.5 kB.

Indicative readings, Apple M1 Max, 1920 × 1080, headless Chrome, the HUD's GPU span of one frame including the HDR tail, median of three loads, with another agent using the same GPU throughout. Two sessions, which differ by more than the settings do:

| Setting                                                   |       Frame (ms) | Loads            |
| --------------------------------------------------------- | ---------------: | ---------------- |
| default (final, jet speed 1.4), three checks              | 4.20, 4.25, 4.63 | 4.09 to 4.66     |
| earlier session, jet speed 1.6: fluid + particles         |             3.27 | 3.19, 3.27, 4.66 |
| earlier session: `look` particles (fluid still simulated) |             3.27 | 3.06, 3.27, 3.32 |
| earlier session: `look` fluid (particles still simulated) |             3.07 | 2.71, 3.07, 3.19 |
| earlier session: with `two-way coupling`                  |             3.50 | 3.37, 3.50, 3.56 |

`noise-flame`, measured alongside as a yardstick, read 1.27 ms in the earlier session and 1.47 ms in the final one. Of the final default frame the HUD's own passes read about 0.5 ms for advection and forces, 0.5 to 0.7 ms for the pressure solve, 0.2 ms for the dye and the reaction, 0.1 ms for the particle step, 1.8 ms for the fluid display pass (four bilinear taps of the dye for the cubic B-spline, and the smoke) and 1.5 ms for the sprites; the rest is the tail. Switching either half of the look off saves little, because both are still simulated; the two-way stand-in adds about 0.2 ms. As with the Epic 6 fluids, it is the number of small dispatches a fluid step needs, not the grid size, that a 2D fluid costs here.

Counts: 260 droplets and 900 flame sprites a second from the nozzle, plus up to 14 flame sprites a second shed by each burning droplet; measured after 3 s, about 2 840 flame sprites, 320 droplets and 300 embers alive (3 460 of a 32 768 pool, 108 bytes a slot with the sprite instance: 3.5 MB). Velocity grid 128 × 72, dye 512 × 288.

Tier B on this machine (planned as C): under the 6 ms budget at 3.3 to 4.6 ms, as the Epic 6 2D fluids are (3.0 to 5.5 ms). Provisional: no integrated GPU has been measured, and a fluid's many dispatches are where a slower GPU and browser overhead hurt most.

Bundle: not measured.

## Pitfalls

- **A lumpy fuel supply flashed.** The fire module's `lumps` (noise rising through the burner) modulate the fuel; carried along a jet at 1.6 heights per second they became bright pulses passing every cell several times a second, and the default measured `high` on the flash analyser (24 700 px² of red flashing against the 21 824 px² limit). With a steady supply it was `low` over 8 s but `high` again over the 4 s the test suite measures; at a jet speed of 1.6 the red rims of the fluid's fast eddies sit right at the limit, so the default is 1.4 (one or two cells of red flashing). The `two-way coupling` preset runs at 1.0 and `wall splash` at 1.6 for the same reason; every preset now measures `low`.
- **Runs were not repeatable to the bit.** The same preset measured 6 200 and 18 500 px² of red flashing on two runs: the framework handed out pool slots in the order threads reach the dead stack (atomics), and each particle's random seed mixed in its slot, so ember and flame shedding, twinkle phases and therefore the picture differed from run to run, and a turbulent flow amplified it. The framework now derives every seed from what the birth is (emitter and index, or the parent's seed), never the slot, so the particles of two runs are the same. Keep a margin under the flash limit anyway: another GPU rounds differently, and the flow amplifies it.
- **`addForce` adds velocity, once per update.** The gas leaves the push region within a few steps, so a push of the jet speed times a fixed share per second (the fire module's own jet uses 6 per second) left the gas at a third of the jet speed. The push is the jet speed times speed / length per second of simulated time.
- **Fuel has to scale with the jet speed.** A burner sized for a campfire, in a stream moving at 1.4 to 1.6 heights per second, gave each parcel a twentieth of the fuel it needed and the fluid's flame was a red thread.
- **The framework's field coupling is one number for the system.** Flame sprites and droplets need different ones: the system's is the droplets', and `hook_force` adds the flames' extra (`ps_field` is callable from a hook). Likewise the sprite stretch is one setting: `hook_sprite` scales the velocity it hands the renderer per kind. Both are the framework's documented recipes for per-kind coupling and stretch (docs/effect-authoring.md, "Particles"), not workarounds.
- **The single pointer tracker only marks the pointer inside on `pointerenter`.** `trackPointers` (the multi-pointer one) reports a hover from the first move.
- **Light page.** The flame reads as flame-coloured ink with grey smoke over it: the smoke has real coverage and the stream is saturated orange, so `lightPage` is `yes`; the outer flame haze turns pink.

## When to use it

A showpiece: a flamethrower that follows the pointer across a hero, a dragon breathing across a section, a jet of fire splashing against a page element. Tier B on the M1 Max at 3.3 to 4.6 ms; a slower GPU should drop the velocity grid to 96 cells first. Reach for `gas-jet` for a steady burner flame drawn by a shader at a fraction of the cost, and for `fire-fluid` when the fire stays where it is.

## References

- J. Stam, "Stable Fluids", SIGGRAPH 1999, and D. Nguyen, R. Fedkiw, H. W. Jensen, "Physically Based Modeling and Animation of Fire", SIGGRAPH 2002: the fluid and its combustion (`src/gpu/sim/fluid.ts`, `fire-fluid.ts`).
- W. T. Reeves, "Particle Systems: A Technique for Modeling a Class of Fuzzy Objects", ACM Transactions on Graphics 2(2), 1983.
- C. T. Crowe, M. P. Sharma, D. E. Stock, "The Particle-Source-In Cell (PSI-CELL) Model for Gas-Droplet Flows", Journal of Fluids Engineering 99(2), 1977: two-way coupling of droplets and gas.
- [docs/effect-authoring.md](../../../docs/effect-authoring.md), "Particles" and "Simulations".
