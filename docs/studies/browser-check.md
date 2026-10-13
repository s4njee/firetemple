# Browser check

Every registered effect, loaded in Google Chrome 155.0.8059.40 (headless, this machine's GPU) on 2026-10-13 by `npm run browser-check`.

Views per effect: `hero-light` (1280 × 900), `hero-dark` (1280 × 900), `cards-dark` (1280 × 900), `band-light` (1280 × 900), `backdrop-dark` (1280 × 900), `phone-light` (390 × 844 at 2x), `phone-dark` (390 × 844 at 2x), `hud-1080p` (1920 × 1080). The layouts are the mock pages of the effect page; "light" and "dark" are the page tone of the stage.

- **Started** counts the views in which the effect got a canvas and drew more than a flat fill, with no fallback notice and no console error.
- **Animates** means two captures a second apart differ by more than dither in at least one view.
- **HUD** is what the performance HUD showed on a 1920 × 1080 canvas: frames per second, and the GPU time of one frame as the browser reports it (first pass start to last pass end), as the median of several page loads with the range beside it. The range is wide for the lightest effects: when there is little to draw the GPU idles, and the same page reads either near the timing floor or about twice that from one load to the next.

The HUD time is not the number the cost studies report. It is one frame measured alone, through Chrome's coarse timestamps, on a GPU that idles between frames, so it carries a floor and reads higher than the per-frame cost in `docs/studies/epic-*.md`. It is here because it is what a visitor's browser actually does. This check says nothing about how an effect looks: the screenshots do.

| Effect | Started | Animates | HUD at 1080p |
| --- | ---: | --- | --- |
| advected-noise | 8 of 8 | yes | 60 fps, 3.56 ms (3.19 to 3.67 over 3 loads) |
| blackbody | 8 of 8 | no (a still picture) | 60 fps, 6.71 ms (6.68 to 6.84 over 3 loads) |
| bloom-tuning | 8 of 8 | yes | 60 fps, 1.31 ms (1.31 to 1.53 over 3 loads) |
| candle | 8 of 8 | yes | 60 fps, 1.03 ms (1.02 to 1.03 over 3 loads) |
| compositing | 8 of 8 | yes | 60 fps, 4.67 ms (4.39 to 4.71 over 3 loads) |
| ember-bed | 8 of 8 | yes | 60 fps, 1.33 ms (1.29 to 1.38 over 3 loads) |
| fire-light | 8 of 8 | yes | 60 fps, 4.42 ms (4.01 to 4.59 over 3 loads) |
| fire-ring | 8 of 8 | yes | 60 fps, 1.29 ms (1.12 to 1.36 over 3 loads) |
| firelight-background | 8 of 8 | yes | 60 fps, 1.35 ms (1.33 to 1.42 over 3 loads) |
| fireplace | 8 of 8 | yes | 60 fps, 1.37 ms (1.36 to 1.57 over 3 loads) |
| flame-ramps | 8 of 8 | yes | 60 fps, 2.32 ms (2.29 to 2.62 over 3 loads) |
| flame-shape | 8 of 8 | yes | 60 fps, 2.17 ms (1.98 to 2.50 over 3 loads) |
| flame-strip | 8 of 8 | yes | 60 fps, 1.08 ms (0.98 to 1.18 over 3 loads) |
| flicker | 8 of 8 | yes | 60 fps, 1.80 ms (1.80 to 2.03 over 3 loads) |
| gas-jet | 8 of 8 | yes | 60 fps, 1.04 ms (1.02 to 1.20 over 3 loads) |
| haze-overlay | 8 of 8 | yes | 60 fps, 0.39 ms (0.39 to 0.40 over 3 loads) |
| heat-haze | 8 of 8 | yes | 60 fps, 3.20 ms (3.18 to 3.33 over 3 loads) |
| hello | 8 of 8 | yes | 60 fps, 6.58 ms (6.58 to 6.69 over 3 loads) |
| noise-flame | 8 of 8 | yes | 60 fps, 1.01 ms (0.99 to 1.09 over 3 loads) |
| smoke-shading | 8 of 8 | yes | 60 fps, 7.50 ms (7.24 to 7.73 over 3 loads) |
| soft-sprites | 8 of 8 | yes | 60 fps, 1.24 ms (1.19 to 1.26 over 3 loads) |
| sparks | 8 of 8 | yes | 60 fps, 1.79 ms (1.64 to 1.81 over 3 loads) |
| toon-fire | 8 of 8 | yes | 60 fps, 1.33 ms (1.26 to 1.33 over 3 loads) |
| torch | 8 of 8 | yes | 60 fps, 1.46 ms (1.37 to 1.46 over 3 loads) |
| volume-march | 8 of 8 | yes | 60 fps, 7.94 ms (7.42 to 8.53 over 3 loads) |

No view logged a console error.
