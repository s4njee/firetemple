## How it works

A bed of coals seen from above, or at a shallow angle with `tilt`. Two passes, of which one runs once.

**The layout is baked.** `coals.wgsl` draws the coals into an `rgba8unorm` texture the size of the canvas, when the effect starts and again only when the canvas, `scale` or `tilt` changes. It holds, per pixel: the distance to the nearest gap between coals (`f2 - f1` of a Voronoi pattern whose domain is bent by noise, so the coals are lumps and not polygons), a random number per coal, the distance to the nearest fracture line in the coal's crust (a finer Voronoi pattern, offset per coal so the lines stop at its edge), and a random number per crust plate. Distances are averaged over four taps so thin gaps do not alias.

**The frame is three fetches.** `embers.wgsl` reads that texel with `textureLoad`, then reads the shared noise tile twice for the heat field: two layers at different scales, drifting in different directions, the second bent by the first.

```wgsl
let wide = noisetex_sample(noise_tex, noise_smp, bed.xy * params.region_scale + params.drift_a);
let fine = noisetex_sample(noise_tex, noise_smp,
  bed.xy * params.region_scale * 2.3 + params.drift_b + (wide.gb - 0.5) * 0.7);
```

Where the two agree the bed is hot. Because they move apart, a hot region forms, wanders and fades over several seconds, and no two regions do it together. On top of that each coal is a little hotter or cooler than its surroundings and breathes on its own sine, 0.35 to 1.25 radians a second.

**What glows.** The gap between coals looks down into the bed and is the hottest thing; it is wide where the region is hot and choked where it is not. A coal glows through its sides, where the crust is thin, through its fracture lines, and dully all over when it is hot enough. All of that becomes one number, the fraction of the way from 720 K to `temperature`, and `blackbody_radiance` turns it into colour: deep red, orange, and a few yellow-white spots where a hot region meets a gap, which `ramp_whiten` keeps pale. Crust that does not glow is char lit faintly by the embers around it, with pale ash on some plates (`ash`).

`bed-space.wgsl` holds the one function both passes share: where on the bed a pixel looks. With `tilt` it is a homography, so the far coals are smaller and flatter.

## Cost

GPU time, measured on a quiet GPU (Apple M1 Max, 1920 × 1080, default settings, tail included): 0.6 ms per frame on Dawn, where the tail alone reads 0.5 ms and repeated runs differ by about half a millisecond, so this effect cannot be told apart from the tail; and 1.33 ms for one frame in Chrome 155 at 60 fps (median of 3 loads, 1.29 to 1.38), which includes the browser's timing floor. Both are inside the Tier A budget of 2 ms on this machine. The budget is set for an integrated GPU, and no integrated GPU or phone has been measured, so the tier is provisional. Tables: `docs/studies/epic-4.md` and `docs/studies/browser-check.md`.

Per pixel, per frame: three texture fetches (one `textureLoad` of the baked layout, two of the noise tile), no procedural noise, no Voronoi search, one `sin`, and the blackbody fit (about 40 arithmetic operations, one `exp`, two `log`). There is no early-out because every pixel is a coal. A first HUD reading in headless Chrome on an Apple M1 Max (one frame at 1920 × 1080, tail included, other work on the GPU) was 1.0 to 1.2 ms, with one reading of 1.8: indistinguishable from the tail alone, and indicative only.

The bake costs ten Voronoi searches and twenty gradient-noise evaluations per pixel, once (the HUD showed 8.7 ms for it at 1920 × 1080 on the same machine, in the first frame only). It runs in the first frame and whenever `scale` or `tilt` changes; dragging those sliders re-bakes every frame while they move.

Texture memory: the layout is one `rgba8unorm` texture at canvas size, 8.3 MB at 1920 × 1080, on top of the tail's float targets. An `r8`-per-channel layout at half resolution would be a quarter of that and was not tried.

## Pitfalls

- **It must stay calm, and it does.** At the defaults the flash analyser reports `none`: no cell completes a flash, and the mean of the whole frame moves by 0.9% of white over 8 seconds. The `forge` preset, the hottest and fastest, measures `low` (one cell made a single red flash; the frame mean moved 3%). `tests/epic4-c.test.ts` holds the default to that.
- Deep red is the dangerous colour for photosensitivity, and this effect is made of it. That is why `drift` tops out at 4 and the breathing is slow: do not multiply the clock to "liven it up".
- Seen flat on, it can read as cracked lava rather than coals. The lumps are sold by the dark crust on top of each coal and the glow on its sides; turning `ash` to 0 and `heat` to 1 removes both.
- `tilt` is a flat plane in perspective: coals do not hide the gaps behind them, as real lumps would at a shallow angle. Far coals are dimmed to stand in for that.
- The layout is baked at the canvas's pixel size. It is redrawn on resize, so a canvas that resizes every frame (an animated layout) pays the bake every frame.
- The two random numbers per pixel are 8-bit. Nothing needs more, but they must not be filtered: the frame pass reads them with `textureLoad`, never with a sampler.
- The heat field repeats every 6 bed units sideways (8 noise cells at 1.3 cells per unit; a unit is the canvas height, or 1 / 2.4 of the width on a wide band). A band wider than 14 : 1 shows the same hot region twice.

## When to use it

A calm, warm background that is safe to leave running: behind a hero, in a footer, in a card, or as the bed under a flame or under `sparks`. It is opaque and dark, so on a light page it sits in its own box like an image.

Tier A, provisional until an integrated GPU has been measured; of the Epic 4 effects it should be the cheapest per pixel. If even this is too much, the poster is nearly as good: nothing in the picture moves fast, so a still loses little.

For flames, use `fireplace` or one of the flame effects; this one has none.

## References

- S. Worley, "A Cellular Texture Basis Function", SIGGRAPH 1996: the cell pattern (`voronoi.wgsl`).
- I. Quilez, [Voronoi edges](https://iquilezles.org/articles/voronoilines/): why `f2 - f1` is only roughly a distance to the border, which is all a crack needs.
- `src/wgsl/blackbody.wgsl` and the `blackbody` effect: the temperature-to-colour fit and why its brightness is tamed.
- W3C, [Understanding SC 2.3.1: Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html): the red-flash definition this effect has to respect.
