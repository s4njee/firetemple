## How it works

A flame effect produces a scalar "heat" per pixel (0 no flame, 1 the hottest core) and needs a mapping from that to light. `src/wgsl/ramp.wgsl` collects the mappings; this scene draws one flame (`flame_heat_teardrop` from `flame.wgsl`) eight times, once per ramp, so colour is the only thing that changes between panels. Under each flame its ramp is laid out from heat 0 to 1 at a quarter of its radiance: the upper half of the bar is the formula, the lower half the baked texture.

Left to right, top row first:

1. **Blackbody** (`ramp_blackbody`): heat mapped to a temperature between `blackbody cold K` and `blackbody hot K`, through `blackbody_radiance`. Physically based.
2. **Fire** (`ramp_fire`): the authored default. Red `6.4 h^2 + 9.6 h^3`, green `12 h^6`, blue `6 h^12`: each channel switches on later than the last, which is what walks the hue from red through orange and yellow to a pale core.
3. **Toon**: four flat bands, authored as colour stops in `index.ts`. It has no formula and exists only as a texture.
4. **Gas** (`ramp_gas`): a violet-blue mantle to an azure cone.
5. to 8. **Copper, sodium, potassium, lithium** (`ramp_tinted` with a fixed tint each): one hue at every heat, as a single emission line gives, with a little grey added at the core.

**Authored versus blackbody.** Soot in a wood or candle flame is about 1000 to 1900 K. Over that range a blackbody only runs from red to orange, and its brightness (even tamed) climbs faster than an authored ramp. The yellow-white of a real flame comes from the camera or the eye saturating. `ramp_fire` paints that result directly; `ramp_blackbody` needs `ramp_whiten` after it to get there (the `whiten blackbody highlights` switch; turn it off to see the raw result).

**Formula versus texture.** `createRampTexture` (`src/gpu/emission/ramp-texture.ts`) bakes any list of ramps into one `rgba16float` texture, one row each, and `ramp_lookup` reads a row with one bilinear fetch. `source: split` colours the left half of every flame from the formula and the right half from the texture; `texture texels` sets the width. Measured worst-channel difference between a baked ramp and its formula, as the tail displays it (ACES then sRGB, `tests/emission-colour.test.ts`):

| Texels | `ramp_fire` | `ramp_blackbody(800, 2000)` |
| ------ | ----------- | --------------------------- |
| 16     | 12/255      | 23/255                      |
| 32     | 2.7/255     | 19/255                      |
| 64     | 0.7/255     | 11/255                      |
| 128    | 0.2/255     | 3.1/255                     |
| 256    | 0.05/255    | 1.7/255                     |

All six polynomial ramps are below one 8-bit step at 64 texels. The WGSL ramps and their TypeScript twins agree to within 0.002 in radiance.

**Flicker.** The flames move but the frame's brightness barely does: over six seconds at 320 x 180 the mean relative luminance of the default view stayed between 0.066 and 0.084 and changed by at most 0.0006 per frame, far below the 10% swing that counts as a flash.

## Cost

One fullscreen pass plus the tail. The flame costs six noise evaluations per pixel inside its bounding region and nothing outside it. The ramp is the cheap part:

| Ramp                                      | Work per pixel                                    |
| ----------------------------------------- | ------------------------------------------------- |
| `ramp_fire`, `ramp_gas`                   | 6 to 8 multiplies, no `pow`                       |
| `ramp_tinted` and the four chemical ramps | about 10 multiply-adds                            |
| `ramp_blackbody`                          | about 40 ALU ops and 3 `exp`/`log`                |
| `ramp_lookup`                             | one bilinear fetch; a texture and sampler binding |

The texture is 8 rows of 64 half-float texels: 4 KB. GPU time per device: not measured yet.

## Pitfalls

- **Bright means white.** The tail's ACES curve shows any channel above about 3 as full, so a colour keeps its hue only while its smaller channels stay below 1. A first version of the tinted ramps peaked at 14 with a grey core of 3 and every flame came out white with a coloured fringe. They now peak at 8 with a core of 0.5, and the tints are more saturated than the colour they are meant to show.
- **The fire ramp's exponents had to go up for the same reason.** With green at `h^4` the flame was yellow from heat 0.6 and white from 0.8. At `h^6` and `h^12` it stays orange through the body.
- **Blackbody without whitening is lemon yellow.** A colour with zero blue (anything below 1900 K) saturates to (1, 1, 0). `blackbody, physical` shows it.
- **The blackbody ramp bakes badly.** It has kinks where it leaves black and where the gamut clips, and linear filtering cannot follow them: it needs 256 texels where the polynomial ramps need 64.
- **Hard steps soften.** The toon bands are stored as stops at the same heat, but a bilinear fetch blends across one texel. At 8 texels the bands are gone; use 64 or more, or a nearest-filtered sampler.
- **The chemical tints are picked by eye** from flame-test photographs, not derived from emission spectra. Sodium's 589 nm line is outside Rec.709 in any case.

## When to use it

`ramp_fire` is the default for every procedural flame: no binding, no `pow`, tuned for the tail. Use `ramp_gas` for burners and jets and `ramp_tinted` for any single-colour flame (pass your own tint for strontium red, barium green, a brand colour).

Use `ramp_blackbody` with `ramp_whiten` when the input really is a temperature, such as a simulated heat field, and physical behaviour matters more than art direction.

Use a texture when the gradient has no tidy formula (bands, hand-placed stops), when a designer should be able to change it without touching a shader, or when one shader must switch between many ramps at run time: the row index is just a number.

## References

- Inigo Quilez, [Palettes](https://iquilezles.org/articles/palettes/): the case for procedural colour ramps over textures.
- Krzysztof Narkowicz, [ACES filmic tone mapping curve](https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/): the per-channel curve the ramps are tuned against.
- Wikipedia, [Flame test](https://en.wikipedia.org/wiki/Flame_test): the emitters and their colours.
- A. G. Gaydon and H. G. Wolfhard, _Flames: Their Structure, Radiation and Temperature_ (Chapman and Hall, 4th edition 1979): soot temperatures and the blue of premixed hydrocarbon flames (CH and C2 bands).
- Story 3.1 on this site, `blackbody`: the temperature-to-colour routes `ramp_blackbody` is built on.
