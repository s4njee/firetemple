## How it works

A smoke plume above a small fire, ray-marched in 3D in one fragment pass (`smoke-shading.wgsl`), with a fixed camera. It is a true volume march, not a 2D trick: the fire sits under the smoke and the sky above it, and the point of the story is how much of that lighting each self-shadowing method keeps. The shading lives in the shared chunk `src/wgsl/smoke.wgsl`; the accumulation along the ray is `volume_accumulate` from `volume.wgsl`. Later volumetric effects are meant to reuse both.

**The density field.** The plume is a leaning cone whose radius grows linearly with height. Inside it, density is a soft column eroded by noise: `shape = envelope + gain * noise`, smoke where `shape > 0`. Three things keep it from reading as a scrolling texture:

- Noise space is measured in plume radii across the plume, so puffs grow as they rise, and along the plume in the integral of `dh / sqrt(radius)`, which makes the smoke streaky and quick near the fire and round higher up.
- A swirl of nested sines bends the pattern and climbs more slowly than the pattern does, so billows change shape on the way up.
- The two coarse octaves are part billow noise (`sqrt(n² + ε)`, round bumps with soft creases), the two fine ones plain gradient noise.

The march is clipped to the plume's bounding cone analytically (the lean is a shear, so the ray is sheared instead and intersected with an upright cone), which puts all 32 steps inside the smoke: short steps near the narrow base, longer ones at the top. Each ray starts at a different offset (`volume_jitter`) so the fixed step count shows as fine grain instead of bands.

**Shading one sample.** `soot` picks a single-scattering albedo between pale wood smoke, (0.86, 0.88, 0.91), and black oil smoke, (0.17, 0.14, 0.11). Extinction is `density × 13 × the density parameter` per world unit, tinted slightly so blue is extinguished a little more than red. Then:

```wgsl
sigma_t = smoke_extinction(rho, extinction, soot);
let direct = smoke_fire_light(fire, fire_dist, FIRE_RADIUS, fire_shadow);
let ambient = smoke_sky_light(sky, sky_shadow);
source = smoke_in_scatter(sigma_t, bright, direct, phase, ambient);
acc = volume_accumulate(acc, sigma_t, source, ds);
```

- **Fire light** falls off as the fraction of the sphere a disc of the fire's radius fills, `0.5 (1 − d / sqrt(d² + r²))`: finite at the fire, inverse-square far away. It is multiplied by the shadow of the smoke between the sample and the fire.
- **Sky light** is half a sphere of dim blue, brightest up and to the left, shadowed by the smoke in that direction.
- **Phase**: two Henyey–Greenstein lobes, 0.75 forward at `g` and 0.25 backward at `−g / 2`.
- `bright` is `smoke_multi_albedo(albedo) = a / (1 − 0.7 a)`, an art term for the scattering orders a single-scattering march leaves out. Without it pale and mid-grey smoke look nearly the same.

The flame is an emissive medium in the same march (heat mapped through a local colour ramp, body around 10, core up to about 30) and the ember bed is a disc on the ground behind it.

### Self-shadowing: none, gradient, march

`shadowing` switches how `fire_shadow` and `sky_shadow` are found. Every tap is one more evaluation of the density field (one octave of it; using two made no visible difference).

|            | taps per lit sample             | what it looks like                                                                                                 | where it breaks                                                                                                               |
| ---------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `none`     | 0                               | A flat, evenly lit fog. The fire's warmth reaches the top of the plume unhindered and the whole column turns pink. | Always. Over a light page pale smoke has nothing darker than the paper and all but disappears.                                |
| `gradient` | 2 (1 per light)                 | Dark cores, lit flanks, warm base and cool top. Close to `march` in a still.                                       | The fire's light ends in a harder band, where the single sample enters dense smoke.                                           |
| `march`    | 5 (3 to the fire, 2 to the sky) | The same picture with a smoother warm-to-cool gradient and warm light catching the outer flanks at mid height.     | Cost. With three taps the samples toward the fire are still far apart, so it is a smoothed estimate, not a sharp cast shadow. |

`gradient` is `smoke_gradient_depth`: the optical depth toward the light if density kept changing at the rate two samples show. Where the tap goes matters more than the formula:

- With a **short reach** (a tap 0.3 units toward the fire, standing for 0.75 units) it is local form shading only. The fire cannot see the two units of smoke further down, so warm light leaks all the way up the plume. It gives the most local contrast and the least believable lighting.
- With the tap at the **midpoint of the whole path** to the fire (what the effect ships) it is the midpoint rule with one sample. The far field is right, and it matches `march` closely at a third of the taps toward the fire.

**Recommendation for later effects: `gradient`, one tap per light at the midpoint of the path to it.** It keeps the two things that make smoke read as a volume (dense cores go dark, light from below dies out with height) for 2 extra density taps per sample against 5, which in noise evaluations per lit sample is 6 against 9 (and 4 for `none`). Use `march` with 3 or 4 taps for a hero shot, or when the smoke has separate layers that one sample would step between. Use `none` only for smoke too thin to shadow itself.

The shadow itself is `smoke_shadow_multi`: Beer–Lambert for sooty smoke, and for pale smoke a blend with a slower exponential so that the inside of a white plume does not go black. A Schneider-style powder term was tried on top and removed: it darkened the lit rims and made puffs read flatter.

### Coverage

The scene is premultiplied: colour is the radiance gathered along the ray, alpha says how much of the page it hides. Both of the tail's `coverage` and `luminance` modes use that alpha. `luminance`, the shared default and the default here, also raises it wherever the output is bright, so the flame and its glow cover the page instead of adding to it; `coverage` shows the scene's alpha alone.

In linear light alpha would be `1 − transmittance`. The canvas, though, is blended over the page after tonemapping and sRGB encoding, and there `1 − T` hides far too little of a light page: half-transparent grey smoke over white came out white. `page_alpha` in the shader writes the alpha that makes the blend over a white page equal the linear-light answer; over a black page alpha does not matter. `smoke_coverage` in the chunk is still the plain `1 − luminance(T)`.

In the other modes: `coverage` looks the same for the smoke and leaves the flame a softer edge, with a glow that adds to the page and so fades out over white; `additive` ignores coverage, so smoke only adds light, black smoke vanishes and pale smoke turns a light page white; `opaque` draws the plume in a black box. Over a dark page all but `opaque` look alike.

## Cost

GPU time, measured: 4.7 ms per frame at 1920 × 1080 with the default settings, tail included (Apple M1 Max, Dawn under Node; the tail alone reads 0.7 ms, and repeated runs differ by up to about half a millisecond). In Chrome 155 on the same machine the HUD reads 8.0 ms for one frame at 1080p and 60 fps (`docs/studies/browser-check.md`); that figure includes the browser's timing floor. No integrated GPU or phone has been measured. The full table is `docs/studies/epic-3.md`. By self-shadowing option: none 3.4 ms, gradient 4.3 ms, march 6.6 ms. By step count: 16 2.6 ms, 32 4.7 ms, 64 8.8 ms.

- Passes: the march, an upsample when the march ran at reduced size, then the tail (bloom chain and output).
- Resolution: the march never runs taller than 540 px. On a taller canvas it renders into its own `rgba16float` target at `540 / height` of the size (no less than a third) and is stretched bilinearly, so at 1080p it shades a quarter of the pixels. That target is 8 bytes per pixel, about 4 MB at 1080p, on top of the tail's.
- Primary steps: `steps`, 32 by default (16 to 64), all inside the bounding cone, with an early exit once less than 2% of the background is left.
- Noise per primary sample: up to 4 `gnoise_3d` plus 10 sines; 2 when the two coarse octaves already rule smoke out, 0 outside the plume's radius.
- Shadow taps per lit sample: 0, 2 or 5 (see the table), each 1 `gnoise_3d` plus 10 sines.
- The flame adds 1 `gnoise_3d` and 2 `gnoise_2d` to the samples below its tip; the ember bed costs the same once per pixel it covers.

What scales the cost: the number of pixels the plume covers at march resolution, `steps`, and the shadow taps. Pixels whose ray misses the bounding cone cost almost nothing.

## Pitfalls

- At 16 steps the jitter shows as a hatch pattern; 32 is faint, 64 clean. The upsample hides more of it on large canvases.
- `gradient` puts a visible band where the fire's light ends; the band follows whichever puff the midpoint sample lands in.
- The fire's light has no occluder but the smoke: the flame does not shadow it, and nothing lights the ground.
- `page_alpha` assumes the tail's ACES curve and ignores bloom. Over a mid-grey page it is closer to right than `1 − T` but not exact. If the tail ever un-premultiplies before encoding, remove it.
- Over a light page the flame core is white on white; its coverage, the orange halo and the shared underlay (0.3) are what keep it readable. That underlay shows as a brown veil around the embers, heaviest in `smoulder`; at 0.1 it looked cleaner.
- Pale smoke is faint on a light page, as white smoke on white paper would be.
- In `coverage` mode the bloom and the flame's red channel are brighter than their alpha, which the canvas specification leaves undefined (see `docs/compositing-study.md`). `luminance` does not have that problem.
- High `g` makes smoke between the camera and the fire very bright (the phase function peaks at about 34 times isotropic at 0.8), which is why the slider stops there.
- Time is accumulated into the noise coordinates. After a few hours of running, 32-bit floats start to quantise them.
- The plume is a shaped noise field, not a simulation: nothing in it responds to anything.

## When to use it

Use it as the reference for shading smoke in a volume march, and as a smoke column over a hero, on a dark or a light page. Tier C until it is measured: a 32-step march with noise evaluated at every sample and shadow tap is the expensive kind of effect, even at reduced resolution. For a cheaper column reach for a 2D advected-noise treatment or soft sprites; they cannot be lit from below with occlusion, which is the thing this effect is for.

For the shading alone, `#include "smoke.wgsl"`: its header documents every function, the units and the loop a caller writes for each shadowing method.

## References

- Henyey & Greenstein, [Diffuse radiation in the galaxy](https://ui.adsabs.harvard.edu/abs/1941ApJ....93...70H) (1941), the phase function.
- Andrew Schneider, [The Real-time Volumetric Cloudscapes of Horizon Zero Dawn](https://www.guerrilla-games.com/read/the-real-time-volumetric-cloudscapes-of-horizon-zero-dawn) (SIGGRAPH 2015): Beer–powder, cheap light marches, low-detail shadow samples.
- Magnus Wrenninge, Chris Kulla, Viktor Lundqvist, [Oz: The Great and Volumetric](https://dl.acm.org/doi/10.1145/2504459.2504518) (SIGGRAPH 2013 talk): approximating multiple scattering with extra, slower exponentials.
- Sébastien Hillaire, [Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite](https://www.ea.com/frostbite/news/physically-based-sky-atmosphere-and-cloud-rendering) (SIGGRAPH 2016 course): the analytic per-step integration used by `volume_accumulate`.
- Inigo Quilez, [Directional derivative](https://iquilezles.org/articles/derivative/): lighting from one extra sample toward the light, the origin of the gradient trick.
- Jorge Jimenez, [Next Generation Post Processing in Call of Duty: Advanced Warfare](https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare) (SIGGRAPH 2014): interleaved gradient noise for the jitter.
