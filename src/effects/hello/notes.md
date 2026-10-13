## How it works

`hello` is a placeholder. It exists to exercise the foundation end to end: per-effect shader packaging, a generated uniform struct, the parameter schema and presets, the shared WGSL library, the HDR tail, and the shell around them. It glows, but it is not meant to look like a flame yet.

It is one fullscreen fragment pass into an `rgba16float` scene target, followed by the tail. The fragment stage turns the pixel position into aspect-corrected coordinates with y pointing up, then:

1. **Rise and warp.** The coordinates scroll upward with time, and `domain_warp_2d_anim` displaces them along two animated noise fields so the motion does not read as one sliding texture.
2. **Heat.** A 5-octave fractal sum gives a value `n` in 0..1. Subtracting a height ramp (`falloff`) leaves it hot at the base and empty at the top.
3. **Radiance.** `heat` squared times the `tint` is the flame body, and `heat` to the sixth power adds a pale core. The result is multiplied by `intensity` and written as linear light, well above 1.0 in the hot parts.

```wgsl
let heat = clamp(n * 1.7 - up * params.falloff, 0.0, 1.0);
let body = params.tint * pow(heat, 2.0);
let core = vec3f(1.0, 0.85, 0.6) * pow(heat, 6.0);
return vec4f((body + core) * params.intensity, 1.0);
```

The tail (`createHdrTail`, `src/gpu/post/tail.ts`) then blooms everything above the threshold, tonemaps, encodes to sRGB and dithers into the canvas. Its four controls (`exposure`, `bloom`, `bloom threshold`, `bloom radius`) come from `TAIL_PARAMS` and are the same on every effect.

`hello.wgsl` is imported as a module (`import shader from './hello.wgsl'`). The build resolves its `#include`s to the library files it needs and nothing else; the `Params` struct is generated from `index.ts` and added at run time with `withChunks`. The Source tab shows each chunk and the fully expanded shader.

## Cost

Three stages: the noise pass at full resolution, the bloom chain (five levels starting at half resolution), and the output pass. Per pixel the noise pass evaluates gradient noise about 11 times: 6 for the warp (two 3-octave fields) and 5 for the pattern.

GPU time per device: not measured yet. The Scorecard tab shows a live, indicative reading once the browser reports pass timings. Texture memory is one `rgba16float` target at canvas size plus the bloom levels, about a third as much again.

## Pitfalls

- Nothing here has the shape of a flame: no tongues, no base, no flicker. It reads as a glowing cloud.
- The pattern scrolls upward at a constant rate. The warp hides that at the default settings and stops hiding it when `warp` is near zero.
- The output is opaque. Over a page it is a rectangle of fire, not fire on the page; compositing is story 3.3.

## When to use it

Not for shipping. Use it to check that a change to the shell, the shader plugin, the uniform writer, the tail or the shared library still runs an effect from start to finish. As a visual it is a warm abstract background.

## References

- Inigo Quilez, [Domain warping](https://iquilezles.org/articles/warp/).
- Krzysztof Narkowicz, [ACES filmic tone mapping curve](https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/).
- Jorge Jimenez, [Next Generation Post Processing in Call of Duty: Advanced Warfare](https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare) (SIGGRAPH 2014), the bloom downsample filter.
