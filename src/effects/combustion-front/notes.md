## How it works

Fire as a travelling front in two continuous fields on a grid: temperature `T` (above ambient; 1 is the rise from burning full fuel with no loss) and fuel `F`. The model, in `src/gpu/sim/combustion.ts` and `combustion-step.wgsl`:

```
dT/dt = D lap(T) + Q R - C T          R = k F g(T)
dF/dt = -R + regrow F0                (on cold ground, up to the capacity F0)
```

Heat diffuses ahead of the front into unburnt fuel, the fuel passes its ignition temperature and burns, burning releases heat. Nothing in the code sets a speed or a width: both come out of `D`, `k`, `Q`, `C` and the ignition law, and the measurements below show it.

**The ignition law is a threshold, `g = smoothstep(Tig, Tig + 0.15, T)`.** It is exactly zero below the ignition temperature, so cold fuel never reacts (the "cold boundary" problem of Arrhenius kinetics does not arise), it is bounded by 1, the ignition temperature is a parameter a person can reason about, and it needs no `exp` of large numbers in half precision. The module also implements the Arrhenius law (`g = exp(Ea/θb − Ea/θ)` with an absolute temperature θ, parameterised by the Zeldovich number β). It is measured below and deliberately not offered by the effect: it has the classic pulsating front, but only with almost no heat loss, and no ember or tap could light it in two dimensions.

**Discretisation.** One render pass per sub-step, ping-ponging two `rgba16float` textures (r = T, g = F, b = F0, a = reaction rate, kept for display). The step is split: diffusion is explicit Euler with the isotropic 9-point Laplacian `[1 4 1; 4 −20 4; 1 4 1] / 6` (a 5-point stencil is kept, `laplacian` parameter, for the comparison); the reaction, heat release, cooling and regrowth are then integrated exactly over the sub-step with `g` frozen (`F e^{−k g dt}`, `T e^{−C dt}`), so no value of `k`, `C` or `regrow` can overshoot or drive fuel negative. Walls are insulating.

**Stability.** Only diffusion can blow up. The scheme needs `α = D dt / dx² ≤ 3/8` with the 9-point stencil and `≤ 1/4` with the 5-point one (and stops being monotone above 3/10 and 1/4). `planCombustion` splits each 1/60 s step into as many sub-steps as keep `α ≤ 1/4`; at more than 8 per step it would lower `D` instead and report it, but no slider setting gets there. At the defaults (`D` 14) one sub-step is enough. `T` is clamped to 0..4 and `F` to 0..1 after every sub-step, and a test runs every parameter at both extremes (including 10⁶ and NaN) to show that the fields stay finite and in bounds.

**Precision.** Half floats hold 11 bits, and on Apple GPUs a float written to an `rgba16float` target is **truncated**, not rounded (measured: 1 − ¼ ulp is stored as 1 − 1 ulp). Untreated, cold full fuel decayed by about 0.05 per second and slow regrowth stalled. Every value is therefore quantised in the shader to an exactly representable half float with stochastic rounding (`floor(v / ulp + u) · ulp`, `u` from a per-cell hash): right on average whatever the hardware does next. A test shows untouched ground staying exactly at T = 0, F = 1, and regrowth of 2·10⁻⁵ per sub-step (below the spacing of half floats) arriving within 7% of the exact amount.

**Grid.** Independent of the canvas: `grid` rows (default 384), square cells, at most 1024 columns. Parameters are quoted in cells of the 384-row grid and rescaled on another one (`D` scales with the square of the row count), so a front crosses the canvas in the same time at any `grid`. A new shape or `grid` re-creates the textures (`generation` goes up) and resamples the old state into them, so a resize does not put the fire out. Changing the fuel sliders re-lays the capacity and keeps the burnt share of each cell.

**Fuel** capacity comes from the shared baked noise tile (`combustion-lay.wgsl`), sampled once when the fuel is laid: patches that burn fast, slowly or not at all. A front on poor fuel is cooler and slower; below a critical capacity it cannot sustain itself (at the defaults somewhere between 0.7 and 0.8, by analogy with the Q sweep below: full fuel stops carrying a front between Q 0.8 and 0.7), so fronts finger around poor patches and leave islands. Burnt ground grows back at `regrow` (share of the capacity per second) once it has cooled. Embers from `createAmbientIgnition` relight it, so the scene runs for ever without anyone; the pointer (`createPointerIgnition`) lights where it is tapped or dragged. Igniters hold the ground they touch at their temperature (embers 0.8, touches 1.5) rather than adding heat, so a finger held still cannot pile heat up. The first frame already has three fronts laid analytically, so a still frame (reduced motion, poster) is a complete picture.

**Display** (`scene.wgsl`, one pass at canvas size): `T` maps linearly to a temperature from 300 K to `kelvin` (default 2000 K) at `T` = 1, through `blackbody_radiance` with the tamed intensity, then `ramp_whiten` so the core pales. Ignition at `T` ≈ 0.25 then sits at about 720 K, just below the Draper point: preheated fuel does not glow, a front does. The reaction zone reads a little hotter (`flare`), which marks the leading edge. Burnt ground is char with real coverage in alpha (brown while it grows back, nearly black where burnt through, with ash flecks); unburnt fuel is a faint mottled surface (`show fuel`, off by default). It is an **overlay** (`OVERLAY_PARAMS`): the fronts are emission and the char is coverage, which is what a page that burns and heals needs; an opaque version would only be this over a black backdrop. The `diagnostic` select shows `T`, `F` and the reaction rate as plain grey maps (opaque, 0.9 × the value).

`drive` (scroll or audio, through `createExcitation`) raises the ember rate by up to 80% and the heat release by up to 20% of their calm values; it never touches the clock.

### Measurements

All on Dawn (Apple M1 Max), 1-D strips 640 × 8 lit along one edge and 2-D squares lit at the centre, at the defaults unless stated (`D` 14, `k` 6, `Q` 1, `C` 0.6, ignition 0.25). Reproduce with `COMBUSTION_MEASURE=1 npx vitest run --silent=false tests/epic5-c.test.ts`.

**Front speed against D, k, Q** (cells per second; v/√(Dk) in brackets):

| D   | 1.75        | 3.5         | 7           | 14          | 28          | 56          | 112         | 224         |
| --- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- |
| v   | 2.40 (0.74) | 4.47 (0.98) | 7.25 (1.12) | 11.1 (1.21) | 16.3 (1.26) | 23.5 (1.28) | 33.4 (1.29) | 47.5 (1.30) |

| k, with C / k fixed at 0.1 | 1.5         | 3           | 6           | 12          | 24          | 48          |
| -------------------------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- |
| v                          | 5.87 (1.28) | 8.15 (1.26) | 11.1 (1.21) | 14.8 (1.14) | 18.7 (1.02) | 21.2 (0.82) |

| Q   | 0.7  | 0.8  | 1    | 1.25 | 1.5  | 2    |
| --- | ---- | ---- | ---- | ---- | ---- | ---- |
| v   | dies | 8.43 | 11.1 | 13.5 | 15.5 | 18.6 |

- **Speed does scale like √(Dk), with a constant set by Q, C/k and the ignition temperature, as long as the front is resolved.** Scaling `D` and `k` together with `C / k` fixed (so the front keeps its width in cells) gives speeds in exact proportion: v/√(Dk) = 1.20, 1.20, 1.21, 1.21, 1.21 for D, k from (3.5, 1.5) to (56, 24). Sweeping one of them changes the width as well, and the constant falls from the continuum value of about 1.30 as the reaction zone drops below about 5 cells (1.21 at the defaults, 0.74 at 1.3 cells). With `C` held fixed rather than `C / k`, faster kinetics also make cooling relatively weaker, so `k` alone helps more: 6.8, 11.1, 16.0, 21.8, 28.6 cells/s for k = 3 to 48.
- **Width.** Reaction zone (fuel 0.9 to 0.1) 4.3 cells at the defaults, preheated zone (to a tenth of the peak) 7 cells, glowing tail (to half the peak) 16 cells; the zone scales as √(D/k) (8.7 cells at D 56, 2.7 at D 7). Peak temperature 0.72: loss takes 28% of the adiabatic `Q`.
- **Extinction** happens where heat release stops winning against loss: at the defaults the front dies for C ≥ 1.8 (it runs at 9.0 cells/s at C 1.2), for ignition ≥ 0.4 (7.6 at 0.35), for Q ≤ 0.7, and for k ≤ 1.5 with C at 0.6. It does not slow to zero: it goes out at a finite speed, as the theory of non-adiabatic fronts says.
- **Propagation failure on the lattice.** Below D / k ≈ 0.2 (reaction zone thinner than about 1.5 cells) a front stops dead even though the continuum model says it should run: a burnt cell cannot heat its neighbour past the threshold. At D / k = 0.25 a plane front still runs at 0.65 √(Dk); at 0.18 it does not start.
- **Roundness** of a point-lit front at a radius of 90 cells, as (largest − smallest radius) / mean over 64 directions, 9-point against 5-point stencil: 0.11% / 0.33% at D / k = 9.3, 0.48% / 0.98% at 4.7, **1.57% / 2.67% at the defaults (2.3)**, 3.0% / 6.3% at 1.2, 4.9% / 10.5% at 0.58, 11.9% / 19.8% at 0.29. Fronts on the lattice run a little faster along the diagonals (axis / diagonal radius 0.985 at the defaults with 9 points, 0.974 with 5). The isotropic stencil halves the error at every width; resolving the front matters more than the stencil.
- **Curvature.** A circle grows slower than a plane front by about D / r: (v_plane − v) × r measured 14 to 18 cells²/s for radii 10 to 35 cells (D = 14), falling off further out where the deficit is lost in noise. This is the eikonal relation v = v₀ − D κ, and it is why convex tongues lag and concave bays catch up, so a front heals its own wrinkles. Kernels of any size from 2 cells (0.5% of the canvas height) lit the defaults; on poor fuel the critical size grows until no ember lights it.
- **Largest stable timestep**, from the growth of a checkerboard mode in pure diffusion: the 9-point scheme is smooth at α = 0.37 and breaks up at 0.38 (theory 3/8); the 5-point scheme is smooth at 0.25 and breaks up at 0.30 (theory 1/4). The module stays at 0.25, so in seconds the largest step is 0.25 / D: 1/56 s at the defaults (one sub-step per 1/60 s step), 1/240 s at D = 60.
- **Regimes.** (1) _Steady fronts:_ with the threshold law the front speed is constant to ±3% (a ripple at one period per cell crossed, the lattice); peak temperature constant to two decimals. No pulsation was found anywhere up to extinction, including right at the limits (±12% ripple at ignition 0.36). Thin fronts (D 3.5, zone 2.3 cells) hop cell to cell, 2.7 to 6.2 cells/s around a mean of 4.5. (2) _Pulsating fronts_ exist with the Arrhenius law: steady up to β = 8 (speed ±20%), pulsating at β = 9 (1.6 to 16 cells/s at 1.6 swings a second, peak temperature 1.00 to 1.39, i.e. above the adiabatic one) and relaxation pulses above (β = 10: long stalls and jumps to 26 cells/s, 0.03 Hz), with no heat loss (C = 0, k = 24). The onset between 8 and 9 agrees with the theoretical 4 + 2√5 ≈ 8.5 for solid fuel. With any useful cooling it goes out: at k = 32 the front survives β = 8 only below C ≈ 0.03 and β = 6 only below about 0.1, and at C = 0.6 no k up to 32 sustains it; in 2-D, a tap of up to 20 cells held 0.2 s at T = 1.5 never started a front. That is why the effect uses the threshold law and has no pulsing preset. (3) _Extinction_, above. (4) _Recovery cycles:_ with regrowth and embers the ground is an excitable medium; each place burns, waits for its fuel and burns again. With fast regrowth (0.4/s) the same ground burns every few seconds (`fast cycle`). Without embers the fronts did not sustain themselves in any setting tried (no spiral waves: free ends of broken fronts on regrowing fuel retract rather than curl), so the embers are what keeps the scene alive.

### Compared with a rule-based front (story 5.3)

A cellular burn front (`burn-front`) moves by rule: a cell ignites when a neighbour burns, perhaps with a probability or a fuel threshold. What the continuous model gives that a rule does not:

- **Speed and thickness follow from physical constants.** Doubling `D` multiplies the speed by √2 and the width by √2; a rule front moves one cell per step (times a probability), so its speed is tied to the grid and the step rate, and its thickness to how many steps a cell stays "burning".
- **Round fronts.** A rule spreading to 4 or 8 neighbours grows a diamond or a square; a random rule grows a rough blob that is round only on average. The diffusion front is round to 1.6% at the defaults with no randomness at all.
- **Curvature effects.** Convex bulges are slower by D / r, so tongues lag and bays fill: the front smooths itself. A rule has no notion of curvature.
- **Extinction from the energy balance.** A front dies when cooling beats heat release, on poor fuel, or when too thin a strip leads it; a rule front dies only where a rule says so.
- **Re-ignition from a hot neighbour.** Heat is a field: a front that died next to hot ground can be relit by it, and a front crossing a poor patch preheats the rich one beyond, which burns faster for it. Fronts that meet annihilate and leave a hot seam.
- **Temperature for the display.** The field is a temperature, so blackbody colour and a whitened core are physically meaningful, not a palette lookup on a state number.

What it costs:

- **Steps for stability.** The explicit step needs D dt / dx² ≤ 1/4: at the defaults one sub-step per 1/60 s, at the largest `D` and `grid` eight. A rule is one pass per step whatever its speed.
- **State precision.** Two continuous fields in half floats, and the fight with half-float rounding above: without explicit stochastic rounding, fuel leaked away on Apple GPUs. A rule stores small integers that cannot drift.
- **Sensitivity.** Speed, width and survival all move with every parameter, and the window of living fronts is bounded on four sides (C, ignition, Q, k). Most of the Arrhenius parameter space is dead. A rule front always runs.
- **A front that dies or runs away.** Here the risks are death (extinction, propagation failure on the lattice below D / k ≈ 0.2) and anisotropy when the front is thin; it cannot run away, because heat release is bounded by the fuel and the state is clamped. A rule front never dies by itself and needs a separate rule to stop.
- **Cell size against front width.** The front must be at least about 3 cells thick to be round and to move at its physical speed, so the grid has to be finer than the thinnest front you want; a rule front can be one cell thick.

## Cost

GPU time, measured on a quiet GPU (Apple M1 Max, 1920 × 1080, default settings, simulation and tail included): 1.0 ms per frame on Dawn, where the tail alone reads 0.7 ms and repeated runs differ by about half a millisecond, so the simulation cannot be told apart from the tail; and 1.31 ms for one frame in Chrome 155 at 60 fps (median of 3 loads, 1.29 to 1.39), which includes the browser's timing floor. Both are inside the Tier A budget on this machine. The budget is set for an integrated GPU, and no integrated GPU or phone has been measured, so the tier is provisional. How the cost moves with grid size is in `docs/studies/epic-5.md` (story 5.9): within the sizes a page would use, it does not measurably move. What can be counted, at the defaults on a 1920 × 1080 canvas:

- **Simulation:** a 683 × 384 grid (262 thousand cells, 4.2 MB for the two `rgba16float` state textures). 60 steps a second whatever the display rate (0 or 1 per frame at 120 Hz, 2 at 30 fps, at most 2), and one sub-step per step at the default `D`. Per cell per sub-step: 9 texel loads, one 3-component PCG hash, 2 `exp`, a smoothstep, the igniter loop (usually 0 or 1 iteration, at most 16), two quantisations; one 8-byte write. So about 2.4 million texel loads a frame, a little more than one full-canvas pass.
- **Display:** one pass at canvas size, 2.07 million pixels: one bilinear fetch of the state, one of the shared noise tile, `blackbody_radiance` (about 30 ALU operations, 2 `exp`, 2 `log`) and `ramp_whiten`. Then the HDR tail.
- **What scales it:** sub-steps grow with `D × (grid / 384)²`: the worst setting (`D` 60, `grid` 512, 910 × 512 cells) takes 8 sub-steps, 33.5 million loads a frame, 16 passes at 30 fps. The display pass scales with the canvas, the simulation does not. Laying fuel is one extra pass, only at start, on a resize and when a fuel slider moves.

The work at the defaults is about two full-canvas passes plus the tail, and measured it fits Tier A on this machine (see above), so it is marked A, not the B the story planned. The heaviest slider settings (grid 512 with fast diffusion, eight sub-steps a step) cost more and were not measured; at those, treat it as Tier Be.

## Pitfalls

- **Half floats truncate on Apple GPUs.** Writing to `rgba16float` rounds toward zero there, so any value that should stay put loses half a unit in the last place per step on average: full fuel decayed visibly within seconds. Quantise in the shader (here, stochastic rounding to an exact half float); dithering before the write is not enough when the hardware truncates.
- **Thin fronts are a lattice artefact.** Below a reaction zone of about 3 cells the front goes square (5.0% out of round at D / k 0.58), hops from cell to cell and runs slower than √(Dk) says; below D / k ≈ 0.2 it stops. Keep `D / k` above about 1 in grid cells, or raise `grid`.
- **Fronts on regrown fuel are weaker.** Ground that has grown back part of the way carries a front that is cooler and slower, and below roughly 70 to 80% of its capacity (at the defaults; not measured directly) none at all. Raising `regrow` makes the scene busier, not brighter. Lowering `ignition` lets fronts run on poorer fuel, but they are then dim red.
- **Extinction is abrupt.** A small change in `C`, `Q`, `k` or `ignition` near the edge of the window takes the fire from running to dead. The sliders allow dead settings on purpose; the embers keep lighting kernels that go out.
- **The Arrhenius law is not practical here.** It needs near-zero cooling, which leaves the whole burnt area glowing for a minute, and it cannot be lit by a short contact. It is in the module and the measurements, not in the effect.
- **Flash.** A front crossing a region is one rise and one fall of its brightness, and embers land as small hot spots. The flash analyser (480 × 270 standing for 1080p) measured `low` for the defaults and every preset over 12 s: at most one flash per second in any cell, no area over the threshold, whole-frame luminance moving by 0.02 to 0.05. At the fastest settings (D 60, k 32, regrowth 0.5, 4 embers a second) it was still `low`, at most two flashes per second per cell. A white-hot igniter (a long-held touch) blooms; it is local.
- **Light page.** The fronts read as saturated orange lines with a red rim, and the char gives the burn a shape: `lightPage: yes`. Char covers much of the page while the ground regrows; for a page whose text must stay legible, set `char` low or 0.
- **Resizing resamples the state**, so a burnt region keeps its place in uv but is stretched by a change of aspect; the fuel capacity is re-laid for the new shape.
- Under reduced motion the shell holds one frame; the pre-laid fronts make the first frame a complete picture.

## When to use it

A page or hero that burns: fronts creep across the content, leave scorch that heals, and light where the visitor taps. It earns its cost where the spread itself is the point: speed and width that respond believably to a few physical sliders, round fronts, fronts that die on poor ground and leave islands. Tier B as labelled (not yet measured).

Reach for the rule-based burn front (story 5.3) when you want a crisp one-cell edge, guaranteed spread, a WebGL-free integer state, or a look that is graphic rather than physical. Reach for a fluid simulation (Epic 6) when the fire has to rise and flicker as flames; this is fire seen from above, on a surface.

## References

- Ya. B. Zeldovich, G. I. Barenblatt, V. B. Librovich, G. M. Makhviladze, The Mathematical Theory of Combustion and Explosions, Consultants Bureau, 1985: travelling combustion waves, ignition-temperature kinetics and the speed scaling.
- B. J. Matkowsky, G. I. Sivashinsky, [Propagation of a pulsating reaction front in solid fuel combustion](https://doi.org/10.1137/0135037), SIAM J. Appl. Math. 1978: the pulsating instability above β = 4 + 2√5.
- J. P. Keener, J. Sneyd, [Mathematical Physiology I](https://link.springer.com/book/10.1007/978-0-387-75847-3), ch. 6: excitable media, refractory periods and the eikonal relation v = v₀ − D κ.
- M. Patra, M. Karttunen, [Stencils with isotropic discretization error for differential operators](https://doi.org/10.1002/num.20129), Numer. Methods PDE 2006: the 9-point Laplacian.
- WCAG 2.2, [Success Criterion 2.3.1](https://www.w3.org/TR/WCAG22/#three-flashes-or-below-threshold).
