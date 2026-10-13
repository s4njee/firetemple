## How it works

A fire is two media in the same space: a flame that emits light and barely blocks it, and smoke that blocks and scatters light and emits none. This effect integrates both in one front-to-back ray march, at reduced resolution, and composites the result under a full-resolution depth buffer. It is the kernel the later volumetric effects are built on; the campfire is its test scene. The reusable parts are `src/wgsl/volume.wgsl` (the maths) and `src/gpu/volume/` (the passes and the blue-noise generator).

**The integral.** Each march step treats the medium as constant over its length `ds` and adds the exact integral for that case, so the result does not depend on the step count when the medium is uniform:

```wgsl
// source: radiance added per unit length (emission + in-scattered light); sigma_t: extinction
radiance      += transmittance * source * (1 - exp(-sigma_t * ds)) / sigma_t;
transmittance *= exp(-sigma_t * ds);
```

`VolumeMedium { source, sigma_t }` describes one point. `volume_emitter_thermal(radiance, sigma_a)` is the flame: its source is `sigma_a * radiance`, so however thick the flame gets it never exceeds `radiance`, thin parts are dim and see-through, and brightness does not drift with step count. `volume_scatterer(sigma_t, albedo, incoming)` is the smoke. `volume_combine` adds the two where they overlap, and `volume_accumulate_medium` takes the step. `tests/volume.test.ts` checks the march against the closed form for a uniform slab at 1 to 256 steps, for fire behind smoke, and for fire inside smoke.

**Steps.** `volume_march_length(span, step_length, max_steps, jitter)` places samples a fixed distance apart, so a ray that geometry stops early takes fewer steps. The `max steps` control is the count for the longest path through the box (5.5 units); a ray straight through the plume takes about 70% of it. `volume_opaque` ends a ray once its transmittance falls under `early out`, and `volume_resolve` remaps that threshold to zero so an early exit is fully opaque instead of leaking 2% of the background.

**Jitter.** Every pixel starts its march at a different offset inside the first step, which turns the bands of a fixed step count into noise. Five sources are selectable: none, white (a hash), interleaved gradient noise (IGN), an R2 lattice, and a 64 x 64 void-and-cluster blue-noise tile generated at start-up (`src/gpu/volume/blue-noise.ts`). `animate jitter` shifts the offsets by the golden ratio each frame.

**Reduced resolution.** `createReducedVolume` runs three passes around the effect's own march:

1. `march depth`: the depth buffer reduced to the march resolution as view-space depth. Each low-resolution texel takes the nearest depth of its block on one colour of a checkerboard and the farthest on the other, so both sides of every silhouette are present among neighbouring texels. Depths beyond the plume's box are clamped to one value (`depthLimit`).
2. `march`: `march.wgsl`, drawn at 1, 1/2 or 1/4 resolution into an `rgba16float` target as `vec4f(radiance, transmittance)`. Each ray stops at its own texel's depth.
3. `upsample`: for every full-resolution pixel, the four nearest low-resolution texels are weighted by their bilinear weight divided by `(1 + (r / tolerance)^2)^2`, where `r` is the relative difference between the depth the texel was marched against and the pixel's own depth (`volume_upsample_weights`). The result is blended as `scene * transmittance + radiance`.

The opaque scene is a small deferred setup: the forward renderer writes flat albedo and depth, and `lighting.wgsl` rebuilds normals from depth and lights the scene with the fire as a point light. That part is scaffolding.

### What the comparisons found

Errors are root-mean-square differences from a 256-step, full-resolution, unjittered render, in 8-bit output levels over a 400 x 450 crop around the plume at 960 x 540. The second figure is the same after a 1.5 px Gaussian blur, which is closer to what the eye and the bloom leave.

| Jitter (64 max steps, one frame) | full        | 1/2         | 1/4         |
| -------------------------------- | ----------- | ----------- | ----------- |
| none                             | 1.00 / 0.76 | 0.93 / 0.75 | 1.37 / 0.98 |
| white                            | 1.32 / 0.47 | 0.94 / 0.59 | 1.46 / 1.05 |
| IGN                              | 1.31 / 0.36 | 0.80 / 0.44 | 1.43 / 0.97 |
| R2 lattice                       | 1.31 / 0.36 | 0.80 / 0.43 | 1.46 / 1.00 |
| blue noise                       | 1.31 / 0.37 | 0.87 / 0.48 | 1.42 / 0.96 |

Jitter roughly halves the blurred error against no jitter, and white noise is clearly worse than the other three. Blue noise did not beat IGN: they tie at full resolution and IGN is slightly ahead at half resolution, where the upsample acts as the small box filter IGN was designed for. Looking at 3x crops, IGN shows as a faint regular cross-hatch, the R2 lattice as diagonal stripes and blue noise as an irregular grain of about the same strength. The default is IGN: no texture, no start-up cost (the blue-noise tile takes about 30 ms to generate in JavaScript), and no worse. With `animate jitter`, averaging two consecutive frames brings the raw error from 1.11 to 0.68 at full resolution for all four sources, and they are indistinguishable from the fourth frame on. That was measured on stills; how it looks in motion has not been judged.

| Max steps (IGN) | 16          | 24          | 32          | 48          | 64          | 96          | 128         |
| --------------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- |
| full            | 6.60 / 2.39 | 4.47 / 1.28 | 3.30 / 0.78 | 1.95 / 0.37 | 1.31 / 0.24 | 0.74 / 0.18 | 0.55 / 0.16 |
| 1/2             | 3.37 / 1.54 | 2.23 / 0.84 | 1.65 / 0.59 | 1.08 / 0.41 | 0.80 / 0.33 | 0.59 / 0.27 | 0.53 / 0.26 |
| 1/4             | 4.33 / 3.05 | 2.92 / 1.94 | 2.33 / 1.52 | 1.66 / 1.05 | 1.43 / 0.90 | 1.23 / 0.74 | 1.19 / 0.71 |

Half resolution with 64 steps has a lower raw error than full resolution with 64 steps, because the upsample averages the grain, for a quarter of the march work. Quarter resolution stops improving after about 64 steps: its error is the resolution. Below 48 steps the grain in the flame is visible at any resolution.

| Upsample filter | 1/2         | 1/4         |
| --------------- | ----------- | ----------- |
| bilinear        | 3.11 / 1.73 | 6.04 / 4.82 |
| depth-aware     | 0.80 / 0.33 | 1.43 / 0.90 |

With bilinear upsampling the smoke is painted over the crossbar and the pot's edge in blocks, and at quarter resolution the thin rod the pot hangs from disappears. The depth-aware filter matches the full-resolution render at those edges (preset `edge-closeup`, then switch `upsample`).

Early termination at the default 0.02 changes no pixel by more than one 8-bit level; 0.05 changes some by 3, 0.1 by 6, 0.25 by 20.

## Cost

GPU time, measured: 6.7 ms per frame at 1920 × 1080 with the default settings, tail included (Apple M1 Max, Dawn under Node; the tail alone reads 0.7 ms, and repeated runs differ by up to about half a millisecond). In Chrome 155 on the same machine the HUD reads 9.9 ms for one frame at 1080p and 60 fps (`docs/studies/browser-check.md`); that figure includes the browser's timing floor. No integrated GPU or phone has been measured. The full table is `docs/studies/epic-3.md`. By march resolution at 64 steps: full 19.4 ms, half 6.5 ms, quarter 3.1 ms. By step count at half resolution: 32 4.4 ms, 64 6.5 ms, 128 11.7 ms. Bilinear and depth-aware upsampling cost the same within the spread (6.3 and 7.1 ms). What the frame consists of:

- Six passes before the tail: `scene` (forward pass, 23 meshes, albedo and depth), `lighting` (fullscreen), `march depth` (march resolution), `march` (march resolution), `upsample` (fullscreen, blended), then the tail's bloom chain and output pass.
- The march, at the defaults: half resolution (a quarter of the pixels), at most 64 steps per ray, with rays outside the plume's box skipped entirely. Each sample costs 2 gradient-noise evaluations, plus a 3-octave fractal sum where the flame can be and a 4-octave one where the smoke can be: 2 to 9 noise evaluations per sample.
- The upsample reads 9 texels per pixel with the depth-aware filter (4 march, 4 march depth, 1 scene depth) and 4 with bilinear. The depth reduction reads 4 texels per low-resolution texel at 1/2 and 16 at 1/4.
- Texture memory at 1080p: albedo `rgba8unorm` (8 MB), depth `depth32float` (8 MB), the tail's `rgba16float` scene (16 MB) and bloom chain, and the march targets `rgba16float` + `r32float` at march resolution (6 MB at 1/2, 1.5 MB at 1/4).

The march scales with march pixels x steps x noise per sample; resolution is the strongest lever, then step count.

## Pitfalls

- **Geometry inside the dense part of a medium shows the jitter as grain.** A ray that ends on a surface in the middle of a steep gradient has nothing behind it to cancel the error of its last step, so its error is proportional to the step length instead of its square. The first version of this scene had the pot in the hottest part of the flame and it was covered in speckle even at 128 steps. Fade the medium out toward surfaces (here: nothing inside the pot, thinning toward it), or move the geometry.
- **Plain bilinear upsampling is not a fair baseline if the depth was reduced on a checkerboard.** It then shows a zigzag along every silhouette. `encodeDepth` takes the filter and reduces to the farthest depth for bilinear.
- **Without the depth limit the depth-aware filter makes things worse behind the volume.** A ground plane at a grazing angle changes depth by several percent per low-resolution texel, the filter treats that as an edge, falls back to the nearest texel, and the jitter shows as blocks. Clamping depths to the far side of the volume's box removed it.
- **The march target can overhang the scene.** At a size that is not a multiple of the divisor the last row and column of the march target extend past the scene's edge; the march shader multiplies its uv by `uvScale` to stay aligned with the depth it reads.
- **A constant has to survive the upsample bit for bit**, or a volume with no content darkens the scene by a rounding error. The filter blends as the first texel plus weighted differences.
- **The flame is under-sampled at low step counts.** Its noise has detail down to about 0.08 units and a step at 32 max steps is 0.17, so the cross-hatch of the jitter is visible in the flame below about 48 steps.
- **The smoke is not self-shadowed.** Its sky light is dimmed by its own local density and its fire light by height, which is a stand-in; story 3.10 is the real treatment.
- Normals come from depth, so curved meshes are lit per facet. The pot is finely tessellated to hide it.

## When to use it

Use the kernel for any fire or smoke that has to sit in a 3D scene: geometry in front of it, inside it and behind it, and a camera that moves. It is Tier C as a whole scene; the march alone at half resolution is the part to budget. For later effects the defaults to start from are half resolution, 64 max steps with `volume_march_length`, IGN jitter, the depth-aware upsample with a depth limit at the far side of the volume, and early termination at 0.02. Quarter resolution is acceptable for smoke and distant fire; it softens flame detail.

Do not use it for a flame seen from one side over a page: a 2D shader (Epic 4) or sprites cost a fraction and nobody can walk around them.

## References

- Sébastien Hillaire, [Physically Based and Unified Volumetric Rendering in Frostbite](https://www.ea.com/frostbite/news/physically-based-unified-volumetric-rendering-in-frostbite) (SIGGRAPH 2015), the analytic integration of one step.
- Jorge Jimenez, [Next Generation Post Processing in Call of Duty: Advanced Warfare](https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare) (SIGGRAPH 2014), interleaved gradient noise.
- Robert Ulichney, [The void-and-cluster method for dither array generation](http://cv.ulichney.com/papers/1993-void-cluster.pdf) (1993).
- Martin Roberts, [The Unreasonable Effectiveness of Quasirandom Sequences](https://extremelearning.com.au/unreasonable-effectiveness-of-quasirandom-sequences/), the R2 lattice.
- Pete Shopf, [Mixed Resolution Rendering](https://developer.amd.com/wordpress/media/2012/10/ShopfMixedResolutionRendering.pdf) (GDC 2009), checkerboard depth reduction and bilateral upsampling.
- Louis Bavoil, [Fast rendering of opacity-mapped particles using DirectX 11 tessellation and mixed resolutions](https://developer.nvidia.com/sites/default/files/akamai/gamedev/files/sdk/11/OpacityMappingSDKWhitePaper.pdf) (NVIDIA, 2011), nearest-depth upsampling.
- Andrew Schneider, [The Real-time Volumetric Cloudscapes of Horizon Zero Dawn](https://www.guerrilla-games.com/read/the-real-time-volumetric-cloudscapes-of-horizon-zero-dawn) (SIGGRAPH 2015), reduced-resolution marching of a noise-shaped medium.
