## How it works

`compositing` is the test scene of story 3.3: what should an overlay effect write to a transparent, premultiplied canvas so it reads over a dark page and a light one? The full comparison, with images and contrast numbers for every strategy, is in `docs/compositing-study.md`. This page is the short version.

One fullscreen pass (`scene.wgsl`) draws three things into the `rgba16float` scene target, each with a different relationship to the page:

1. **A flame.** Emission only: linear radiance (body about 8, core about 24) and scene alpha 0. It adds light and covers nothing.
2. **Smoke.** Dark soot, premultiplied, with its real coverage in scene alpha (up to 0.85).
3. **Two logs.** Opaque char with ember cracks: scene alpha 1.

Everything else is left at (0, 0, 0, 0). The tail then blooms, tonemaps and encodes as usual, and `OVERLAY_PARAMS` decides what goes into the canvas's alpha. The browser shows `rgb + (1 - alpha) * page`, so alpha is the whole question:

```wgsl
// luminance: the brightest written channel, or the scene's coverage if that is larger
alpha = clamp(max(scene_texel.a, written * post.alpha_gain), 0.0, 1.0);
// underlay: a second, darker layer masked by the bloom; the page is seen through both
let veil = post.underlay * (1.0 - reach * reach * reach);   // reach = 1 - glow brightness
alpha = 1.0 - (1.0 - alpha) * (1.0 - veil);
```

The presets are the strategies of the study: `recommended` (luminance alpha, underlay 0.3, the default of `OVERLAY_PARAMS`), `no underlay`, `heavy underlay`, `additive`, `additive + underlay`, `coverage`, `hard alpha` (gain 3), `opaque`, and four `css …` presets that also set `mix-blend-mode` on the canvas element. Setting that style is the one place this effect touches the DOM; it is restored on destroy and does nothing in the headless tests.

Over a dark page every preset but `css multiply` looks the same. Switch the theme to light to see them come apart: additive and the lightening blend modes vanish, coverage leaves smoke rising from nothing, luminance alpha keeps the flame as flame-coloured ink, and the underlay gives the core something darker to be seen against.

## Cost

Two stages: the scene pass at full resolution, then the tail (bloom and output). The alpha modes and the underlay are a few arithmetic operations in the output pass that every effect already runs; they add no pass and no texture fetch.

Per pixel the scene evaluates up to 15 octaves of gradient noise: 9 for the flame (2 for the lean, 3 for the wobble, 4 for the edge) and 6 for the smoke (2 for the drift, 4 for the density). Pixels inside the logs add 5 more. Pixels outside the flame's box and below the smoke return early.

GPU time per device: not measured yet. Texture memory is one `rgba16float` target at canvas size plus the bloom levels, about a third as much again.

## Pitfalls

- **Nothing here was checked in a browser.** The composites in the study are computed from the canvas contents with the browser's formula, and the CSS blend modes are simulated. The `css …` presets exist so that can be checked by eye.
- `additive` and `coverage` write colour brighter than its alpha (every drawn pixel for additive, 37% for coverage in the study's frame). The WebGPU canvas specification leaves the result of compositing such colour undefined. The default never does this.
- On a light page fire is seen by its hue, not its brightness. The luminance contrast of the flame body against the light page is 1.5 to 1.7; it reads because orange is not white. White or pale light does not read at all (ΔE 2.7 to 4.5, at the edge of visibility).
- The underlay uses the bloom as its mask. With bloom at 0 there is no underlay, and it reaches exactly as far as the bloom does.
- Smoke colour is encoded after it was premultiplied, so thin smoke comes out lighter than the same colour and alpha drawn by CSS. Keep overlay smoke dark.
- `alphaGain` above 1 puts a brown fringe on every soft edge. Below 1 the colour is brighter than its alpha again.
- The flame is a stand-in (a noise-eroded teardrop) and so is its colour ramp. Flame shaping and colour are stories 3.7 and 3.1/3.2.
- Whole-frame brightness is steady: over 3 seconds at 30 frames a second the mean frame luminance stayed within 0.4% of white in any one-second window (indicative, headless, 240 × 180). The flicker is local to the flame's edge.

## When to use it

As a reference when making any effect that sits on the page instead of in a box: spread `OVERLAY_PARAMS`, keep the defaults, write coverage into scene alpha for whatever should block the page, then look at it over the light theme and fill in `scorecard.lightPage` honestly. The study lists when an effect should be marked dark-theme-only: light with little hue, effects that are mostly glow, and anything that depends on being brighter than paper white.

As decoration it is a small Tier A campfire. A transparent animated image would do the same job; the shader earns its place only if the flame has to respond to something.

## References

- [docs/compositing-study.md](../../../docs/compositing-study.md): the comparison, the numbers and the recommendation.
- W3C, [Compositing and Blending Level 1](https://www.w3.org/TR/compositing-1/): source-over and the blend modes.
- W3C, [WebGPU, `GPUCanvasAlphaMode`](https://www.w3.org/TR/webgpu/#enumdef-gpucanvasalphamode): what a premultiplied canvas promises.
- T. Porter, T. Duff, "Compositing Digital Images", SIGGRAPH 1984.
- Inigo Quilez, [Domain warping](https://iquilezles.org/articles/warp/), for the flame's wobble.
