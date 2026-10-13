## How it works

A glowing body's colour depends only on its temperature. `src/wgsl/blackbody.wgsl` turns kelvin into linear Rec.709 RGB three ways, and this scene draws all three against the same temperature axis (800 K at the left, linear in 1/T so the red end gets most of the width). Rows are numbered in the margin: **1** the Planck reference, **2** the polynomial fit, **3** the lookup texture.

- **Top group, colour only.** Each route's colour scaled so its largest channel is 1.
- **Middle group, radiance.** The same colour at luminance 1, times the tamed brightness mapping, times `radiance at reference`. This is what `blackbody_radiance` writes into the HDR target.
- **Bottom group, error.** The absolute difference between a route and the reference in the colour-only form, times `error gain`. The fit's error is smooth; the lookup's shows its texels.

The three routes:

1. **`blackbody_planck`** integrates Planck's law against the CIE 1931 colour-matching functions in 80 samples from 380 to 780 nm, converts XYZ to Rec.709, clips negative channels and scales to luminance 1. The matching functions are the analytic fit of Wyman, Sloan and Shirley with two far-red lobes added here (see Pitfalls).
2. **`blackbody_fit`** is two degree-5 polynomials in 1000/T for red and blue; green follows from luminance 1. They were fitted by least squares to route 1.
3. **`blackbody_lookup`** is one bilinear fetch from a 64 x 1 `rgba16float` texture baked from route 1 in TypeScript (`src/gpu/emission/blackbody-lut.ts`).

Measured against the reference over 800 to 12000 K, on the colour-only form (`tests/emission-colour.test.ts`):

| Route                       | Max error        | Mean error | Max chromaticity error (u'v') |
| --------------------------- | ---------------- | ---------- | ----------------------------- |
| Polynomial fit              | 0.0066 (1.7/255) | 0.0027     | 0.0004                        |
| Lookup, 16 texels           | 0.016 (4.2/255)  | 0.0074     | 0.0035                        |
| Lookup, 32 texels           | 0.0048 (1.2/255) | 0.0017     | 0.0019                        |
| Lookup, 64 texels (default) | 0.0011 (0.3/255) | 0.0004     | 0.0007                        |
| Lookup, 128 texels          | 0.0004 (0.1/255) | 0.0001     | 0.0001                        |

A just-noticeable chromaticity difference is about 0.001 in u'v'. The reference itself agrees with Krystek's independent fit of the Planckian locus to within 0.0007 in CIE xy between 1000 K and 12000 K, and the WGSL (f32) and TypeScript (f64) implementations of it agree to better than 0.0001.

**Brightness.** Physical luminance is unusable directly: it rises 540000 times between 1000 K and 2200 K. Stefan-Boltzmann's T^4 is the total power, mostly infrared, and understates the visible change. `blackbody_intensity(t, t_ref, gamma)` is the physical luminance relative to `t_ref`, raised to `gamma`. At the default 0.4 the same 1000 to 2200 K flame spans 196:1, close to the contrast of the authored ramps. The `intensity curves` preset plots the three on one scale: white is physical, pale blue is T^4, orange is the tamed curve.

```wgsl
// A temperature field to radiance: no texture, about 40 ALU ops and 3 exp/log.
let radiance = blackbody_radiance(kelvin, 2000.0, BLACKBODY_GAMMA) * 8.0;
```

## Cost

One fullscreen pass plus the tail. Per pixel:

| Route                 | Work                                                         |
| --------------------- | ------------------------------------------------------------ |
| `blackbody_planck`    | 80 wavelength samples, about 800 `exp`                       |
| `blackbody_fit`       | about 30 ALU ops, one divide, no transcendentals             |
| `blackbody_lookup`    | one bilinear fetch and about 6 ALU ops; 512 bytes of texture |
| `blackbody_intensity` | 3 `exp`/`log` on top of any route                            |

GPU time, measured: 2.7 ms per frame at 1920 × 1080 with the default settings, tail included (Apple M1 Max, Dawn under Node; the tail alone reads 0.7 ms, and repeated runs differ by up to about half a millisecond). In Chrome 155 on the same machine the HUD reads 6.5 ms for one frame at 1080p and 60 fps (`docs/studies/browser-check.md`); that figure includes the browser's timing floor. No integrated GPU or phone has been measured. The full table is `docs/studies/epic-3.md`. In Chrome the same frame reads 6.5 ms, so the scene is marked Tier C. That is only because the reference runs on every pixel of a third of the rows and behind both error rows; nobody would ship that route per pixel. The fit and the lookup are both small enough for a Tier A effect.

## Pitfalls

- **The published colour-matching fit is wrong where fire lives.** The Wyman-Sloan-Shirley Gaussians underestimate the red response beyond 660 nm, by half at 700 nm. For daylight that is invisible. For a 1000 K body, whose visible light is almost all far red, it moves the chromaticity by 0.015 in xy toward orange (0.006 at 1500 K). The two extra lobes in `blackbody_cmf` fix that; the test against Krystek's locus is what caught it.
- **Rec.709 cannot show these colours.** Below about 1900 K blue clips to zero, and below about 950 K green does too: everything colder is the same pure red, only dimmer.
- **Bright blackbody colours turn lemon yellow.** The tail's ACES curve works per channel, so a colour with zero blue ends at (1, 1, 0) when it is overexposed. The radiance rows show it between 1700 K and 2100 K. A real flame goes pale instead. `ramp_whiten` in `ramp.wgsl` is the workaround; highlight desaturation in the tonemapper would be the proper fix.
- **Do not bake the lookup with a linear temperature axis.** At 64 texels it is three times worse (0.0034) than the 1/T axis, with the error concentrated at the red end. Below 16 texels the 1/T axis starves the hot end instead.
- **Past 128 texels the lookup stops improving.** What is left (0.0005) is the half-float rounding of the stored values.
- **`gamma` is a look, not physics.** 0.25 gives thick, flat flames (27:1 over 1000 to 2200 K); 1.0 leaves only the hottest pixels visible. Pick `t_ref` near the hottest temperature expected: the mapping has no upper bound.

## When to use it

Use `blackbody_fit` (through `blackbody_radiance`) as the default wherever a temperature exists: simulated heat fields, embers and sparks cooling over their lifetime, lights tinted by temperature. It needs no binding and its error is below two 8-bit steps.

Use the lookup when a pass already samples textures and the brightness mapping can be baked in (`withIntensity`): one fetch then returns finished radiance, at a sixth of the fit's error. Use the reference only to bake and to test.

When there is no temperature, only a shaped "heat" value, an authored ramp is the better tool: see `flame-ramps`.

## References

- Chris Wyman, Peter-Pike Sloan, Peter Shirley, [Simple Analytic Approximations to the CIE XYZ Color Matching Functions](https://jcgt.org/published/0002/02/01/) (JCGT, 2013).
- Michael P. Krystek, "An algorithm to calculate correlated colour temperature", Color Research & Application 10 (1985): the rational fit of the Planckian locus used as the independent check. Reproduced on Wikipedia, [Planckian locus](https://en.wikipedia.org/wiki/Planckian_locus#Approximation).
- CIE, [Colorimetry, 4th edition](https://cie.co.at/publications/colorimetry-4th-edition) (CIE 015:2018): the 1931 standard observer.
- Wikipedia, [Draper point](https://en.wikipedia.org/wiki/Draper_point): why the range starts near 800 K.
- Mitchell Charity, [What color is a blackbody?](http://www.vendian.org/mncharity/dir3/blackbody/): the widely copied table, for comparison.
