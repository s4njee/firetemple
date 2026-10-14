# Browser check

Every registered effect, loaded in Google Chrome 155.0.8059.40 (headless, this machine's GPU) on 2026-10-14 by `npm run browser-check`.

Views per effect: `hero-light` (1280 × 900), `hero-dark` (1280 × 900), `cards-dark` (1280 × 900), `band-light` (1280 × 900), `backdrop-dark` (1280 × 900), `phone-light` (390 × 844 at 2x), `phone-dark` (390 × 844 at 2x), `hud-1080p` (1920 × 1080). The layouts are the mock pages of the effect page; "light" and "dark" are the page tone of the stage.

- **Started** counts the views in which the effect got a canvas and drew more than a flat fill, with no fallback notice and no console error.
- **Animates** means two captures a second apart differ by more than dither in at least one view.
- **HUD** is what the performance HUD showed on a 1920 × 1080 canvas: frames per second, and the GPU time of one frame as the browser reports it (first pass start to last pass end), as the median of several page loads with the range beside it. The range is wide for the lightest effects: when there is little to draw the GPU idles, and the same page reads either near the timing floor or about twice that from one load to the next.

The HUD time is not the number the cost studies report. It is one frame measured alone, through Chrome's coarse timestamps, on a GPU that idles between frames, so it carries a floor and reads higher than the per-frame cost in `docs/studies/epic-*.md`. It is here because it is what a visitor's browser actually does. This check says nothing about how an effect looks: the screenshots do.

| Effect | Started | Animates | HUD at 1080p |
| --- | ---: | --- | --- |
| advected-noise | 8 of 8 | yes | 60 fps, 3.61 ms (3.53 to 3.62 over 3 loads) |
| blackbody | 8 of 8 | no (a still picture) | 60 fps, 6.81 ms (6.59 to 7.10 over 3 loads) |
| bloom-tuning | 8 of 8 | yes | 60 fps, 1.48 ms (1.48 to 1.49 over 3 loads) |
| burn-front | 8 of 8 | yes | 60 fps, 1.52 ms (1.49 to 1.53 over 3 loads) |
| candle | 8 of 8 | yes | 60 fps, 1.00 ms (0.99 to 1.05 over 3 loads) |
| combustion-front | 8 of 8 | yes | 60 fps, 1.38 ms (1.21 to 1.53 over 3 loads) |
| compositing | 8 of 8 | yes | 60 fps, 3.75 ms (3.32 to 4.15 over 3 loads) |
| dom-fuel | 8 of 8 | yes | 60 fps, 1.17 ms (1.09 to 1.18 over 3 loads) |
| doom-fire | 8 of 8 | yes | 60 fps, 1.24 ms (1.23 to 1.40 over 3 loads) |
| ember-bed | 8 of 8 | yes | 60 fps, 1.11 ms (0.92 to 1.17 over 3 loads) |
| fire-3d | 8 of 8 | yes | 60 fps, 5.53 ms (5.51 to 5.74 over 3 loads) |
| fire-fluid | 8 of 8 | yes | 60 fps, 3.24 ms (3.02 to 3.33 over 3 loads) |
| fire-haze | 8 of 8 | yes | 60 fps, 3.01 ms (2.19 to 4.91 over 3 loads) |
| fire-light | 8 of 8 | yes | 60 fps, 4.74 ms (1.87 to 5.66 over 3 loads) |
| fire-obstacles | 8 of 8 | yes | 60 fps, 4.85 ms (4.81 to 4.99 over 3 loads) |
| fire-ring | 8 of 8 | yes | 60 fps, 1.06 ms (1.05 to 1.07 over 3 loads) |
| firelight-background | 8 of 8 | yes | 60 fps, 1.08 ms (1.04 to 1.15 over 3 loads) |
| fireplace | 8 of 8 | yes | 60 fps, 2.05 ms (1.94 to 2.15 over 3 loads) |
| flame-ramps | 8 of 8 | yes | 60 fps, 3.03 ms (2.88 to 3.12 over 3 loads) |
| flame-shape | 8 of 8 | yes | 60 fps, 2.20 ms (1.93 to 2.34 over 3 loads) |
| flame-strip | 8 of 8 | yes | 60 fps, 1.14 ms (1.11 to 1.16 over 3 loads) |
| flicker | 8 of 8 | yes | 60 fps, 1.58 ms (1.57 to 1.82 over 3 loads) |
| forest-fire | 8 of 8 | yes | 60 fps, 1.30 ms (1.15 to 1.31 over 3 loads) |
| gas-jet | 8 of 8 | yes | 60 fps, 0.98 ms (0.97 to 1.03 over 3 loads) |
| haze-overlay | 8 of 8 | yes | 60 fps, 0.51 ms (0.50 to 0.55 over 3 loads) |
| heat-haze | 8 of 8 | yes | 60 fps, 3.76 ms (3.60 to 3.94 over 3 loads) |
| hello | 8 of 8 | yes | 60 fps, 6.59 ms (6.21 to 6.94 over 3 loads) |
| noise-flame | 8 of 8 | yes | 60 fps, 0.98 ms (0.94 to 0.98 over 3 loads) |
| smoke-shading | 8 of 8 | yes | 60 fps, 8.38 ms (7.95 to 8.42 over 3 loads) |
| soft-sprites | 8 of 8 | yes | 60 fps, 1.24 ms (1.14 to 1.28 over 3 loads) |
| sparks | 8 of 8 | yes | 60 fps, 1.67 ms (1.62 to 1.98 over 3 loads) |
| stable-fluids | 8 of 8 | yes | 60 fps, 3.19 ms (3.15 to 3.25 over 3 loads) |
| toon-fire | 8 of 8 | yes | 60 fps, 1.28 ms (1.24 to 1.29 over 3 loads) |
| torch | 8 of 8 | yes | 60 fps, 1.11 ms (1.10 to 1.21 over 3 loads) |
| volume-march | 8 of 8 | yes | 60 fps, 8.75 ms (8.55 to 8.76 over 3 loads) |

No view logged a console error.
