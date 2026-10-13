## How it works

The light of a fire that is just out of frame: a warm glow that is brightest along one edge, falls off across the canvas, and has slow patches of stronger and weaker light drifting away from the fire. No flames are drawn. It is opaque and meant to sit behind page content.

Two small passes and the tail:

1. **`field.wgsl`, at one eighth of the canvas each way.** The moving part. Slow domain-warped gradient noise (`domain_warp_2d_anim` and `fbm_3d` from `fbm.wgsl`): the lookup position is pushed around by two more noise fields, so patches stretch and fold instead of sliding past, and the third noise coordinate is time, so the pattern changes where it is. The whole field also drifts slowly away from the fire. It writes two values per texel: where the light is stronger or weaker, and a slower field that shifts the colour.
2. **`glow.wgsl`, at canvas size.** One bilinear fetch of that field, then arithmetic: the distance from the pixel to the fire (a line segment beyond the chosen edge, so a wide canvas is lit along its length and not by a spotlight), a falloff of `1 / (1 + (d / reach)^2)^2`, the field moving patches of light around a mean of 1, and the colour. The colour is the `tint` where the light is strong and turns redder where it is weak, because green and blue are made to fall away faster than red.

The one idea that makes it cheap: nothing in the moving field is finer than a few hundred pixels, so it is computed for 1 pixel in 64 and stretched. At 1080p the field is 240 x 135.

**Flicker.** The brightness of the whole picture is multiplied by `flickerIntensity` from `src/gpu/emission/flicker.ts`, the capped flicker signal: two new levels a second at most, no fast shimmer, and a depth of `flicker` x 12% of the picture's own brightness (3% at the default). It runs on a clock of real seconds that `speed` cannot push faster. Everything else that moves is the slow field.

`side` puts the fire below the frame, to the left or right, or beyond a bottom corner; `distance` is how far outside the frame it is and `fire width` how much of that edge it spans. Presets: `hearth`, `campfire to the left`, `embers`.

## Cost

GPU time: not measured yet. What can be counted:

- Passes: the field pass at 1/64 of the canvas area, the glow pass at canvas size, then the tail (bloom and output).
- Field pass, per texel: 9 evaluations of 3D gradient noise (4 for the warp, 3 for the light, 2 for the colour). At 1080p that is 32 400 texels, about 290 000 noise evaluations a frame; computed at canvas size it would be 18.7 million.
- Glow pass, per pixel: 1 texture fetch, 1 square root, a few divisions, no noise, no `pow`.
- Texture memory: the `rgba16float` scene target and bloom chain at canvas size (the HUD reports about 21.3 MB at 1080p, of which the field is 0.26 MB).

Indicative readings, Apple M1 Max, 1920 x 1080, taken while other work was using the GPU: Chrome's HUD read 1.1 ms and 1.5 ms for one frame in two runs, where the tail alone reads 1.1 to 1.3 ms, and the Dawn harness read 0.7 and 1.2 ms per frame in two runs against 0.5 to 1.0 ms for the `bloom-tuning` scene, which computes no noise. Nothing has been measured on an integrated GPU or a phone.

Only the band nearest the fire is brighter than the bloom threshold (1.0), so the bloom chain, which is most of what the tail costs, adds little to this picture. A variant that skips it was not built or measured.

## Pitfalls

- **It is a dark backdrop, not light on the page.** It is opaque, and most of it is dark. On a light-themed page it is a dark, warm block, which is why the scorecard says it does not suit a light page. A white page cannot be lit; a pale version of this would be a stain.
- **Text contrast depends on where the text is.** At the defaults (fire below, 960 x 540 still) the mean relative luminance of a row is 0.01 at the top, 0.06 in the middle, 0.16 three quarters of the way down and 0.40 along the bottom edge. White text has a contrast of about 18:1, 9:1, 5:1 and 2.4:1 against those. Keep text out of the third nearest the fire, or put a veil or a plate under it as the backdrop layout does.
- **Whole-frame brightness.** Measured with the flash analyser over 20 seconds at the defaults: the mean relative luminance of the frame moved by 0.018 in total, no cell of the picture completed a flash, verdict `none`. `campfire to the left` moved by 0.032 and `embers` by 0.002. With `flicker` 1, `speed` 3 and `movement` 0.9 together one cell completed a single flash (`low`). `tests/epic4-a.test.ts` holds the default to 3% over twelve seconds and 1.5% across any one second.
- **Smooth dark gradients band easily.** The tail dithers, so the canvas itself does not. A capture of it can: one of the contact sheets made while checking this effect was written with a reduced palette and showed terraces that were not in the canvas. Use a full-colour image for the poster and expect a compressed video of it to band.
- **Not periodic.** The field does not loop. Its clocks wrap after 4096 units so the shader never sees a large number, which is more than twelve hours at the default speed, and the picture jumps once when they do.
- **Side fires in a narrow canvas.** Distances are in canvas heights. In a tall, narrow canvas a fire to the left or right lights the whole width, and `reach` needs lowering to keep a gradient.
- Under reduced motion the shell holds one frame, which is a complete picture: a still gradient with soft patches.

## When to use it

Behind an article, a hero or a login screen on a dark page, when the page should feel lit by a fire without showing one; or as the warm fill behind another fire effect drawn on top. Tier A, provisionally: it reads at the tail's own cost on the M1 Max, and no integrated GPU has been measured.

Be honest about the alternative. Most of this picture is a radial gradient, and a CSS `radial-gradient` in the same colours costs nothing and is the right fallback. The canvas adds the slow movement of the light, which is the whole point if the page is looked at for a while and nothing at all in a screenshot. If only a gentle pulse is wanted, drive the opacity of a CSS gradient from `flickerIntensity` instead (story 9.12 compares the two).

## References

- Inigo Quilez, [Domain warping](https://iquilezles.org/articles/warp/): the technique of the field pass.
- Ken Perlin, [Improving Noise](https://mrl.cs.nyu.edu/~perlin/paper445.pdf), SIGGRAPH 2002: the gradient noise in `noise.wgsl`.
- The `flicker` effect and `src/wgsl/flicker.wgsl` in this site: the capped flicker signal and why it cannot flash.
- [docs/compositing-study.md](../../../docs/compositing-study.md), "When to mark an effect dark-theme-only".
- WCAG 2.2, [Success Criterion 2.3.1](https://www.w3.org/TR/WCAG22/#three-flashes-or-below-threshold) and [1.4.3 Contrast (Minimum)](https://www.w3.org/TR/WCAG22/#contrast-minimum).
