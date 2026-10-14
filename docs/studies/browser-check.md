# Browser check

Every registered effect, loaded in Google Chrome 155.0.8059.40 (headless, this machine's GPU) on 2026-10-14 by `npm run browser-check`.

Views per effect: `hero-light` (1280 × 900), `hero-dark` (1280 × 900), `cards-dark` (1280 × 900), `band-light` (1280 × 900), `backdrop-dark` (1280 × 900), `phone-light` (390 × 844 at 2x), `phone-dark` (390 × 844 at 2x), `hud-1080p` (1920 × 1080). The layouts are the mock pages of the effect page; "light" and "dark" are the page tone of the stage.

- **Started** counts the views in which the effect got a canvas and drew more than a flat fill, with no fallback notice and no console error.
- **Animates** means two captures a second apart differ by more than dither in at least one view.
- **HUD** is what the performance HUD showed on a 1920 × 1080 canvas: frames per second, and the GPU time of one frame as the browser reports it (first pass start to last pass end), as the median of several page loads with the range beside it. The range is wide for the lightest effects: when there is little to draw the GPU idles, and the same page reads either near the timing floor or about twice that from one load to the next.

The HUD time is not the number the cost studies report. It is one frame measured alone, through Chrome's coarse timestamps, on a GPU that idles between frames, so it carries a floor and reads higher than the per-frame cost in `docs/studies/epic-*.md`. It is here because it is what a visitor's browser actually does. This check says nothing about how an effect looks: the screenshots do.

| Effect | Started | Animates | HUD at 1080p |
| --- | ---: | --- | --- |
| advected-noise | 8 of 8 | yes | 60 fps, 6.50 ms (4.29 to 8.22 over 3 loads) |
| blackbody | 8 of 8 | no (a still picture) | 60 fps, 10.70 ms (8.30 to 14.20 over 3 loads) |
| bloom-tuning | 8 of 8 | yes | 60 fps, 3.67 ms (2.30 to 4.22 over 3 loads) |
| burn-front | 8 of 8 | yes | 60 fps, 4.01 ms (4.01 to 4.38 over 3 loads) |
| candle | 8 of 8 | yes | 60 fps, 3.16 ms (2.90 to 3.74 over 3 loads) |
| combustion-front | 8 of 8 | yes | 60 fps, 4.15 ms (3.54 to 4.52 over 3 loads) |
| compositing | 8 of 8 | yes | 60 fps, 6.25 ms (5.71 to 7.51 over 3 loads) |
| dom-fuel | 8 of 8 | yes | 60 fps, 1.42 ms (1.34 to 1.52 over 3 loads) |
| doom-fire | 8 of 8 | yes | 60 fps, 1.35 ms (1.03 to 1.48 over 3 loads) |
| ember-bed | 8 of 8 | yes | 60 fps, 1.16 ms (1.14 to 1.49 over 3 loads) |
| embers | 8 of 8 | yes | 60 fps, 1.25 ms (1.22 to 3.31 over 3 loads) |
| fire-3d | 8 of 8 | yes | 60 fps, 7.20 ms (6.90 to 7.54 over 3 loads) |
| fire-fluid | 8 of 8 | yes | 60 fps, 2.57 ms (1.52 to 2.63 over 3 loads) |
| fire-haze | 8 of 8 | yes | 60 fps, 3.52 ms (3.35 to 4.09 over 3 loads) |
| fire-jet | 8 of 8 | yes | 60 fps, 3.61 ms (3.39 to 3.72 over 3 loads) |
| fire-light | 8 of 8 | yes | 60 fps, 6.03 ms (5.89 to 7.59 over 3 loads) |
| fire-obstacles | 8 of 8 | yes | 60 fps, 3.98 ms (2.87 to 4.73 over 3 loads) |
| fire-ring | 8 of 8 | yes | 60 fps, 0.99 ms (0.93 to 0.99 over 3 loads) |
| firelight-background | 8 of 8 | yes | 60 fps, 1.26 ms (1.10 to 1.32 over 3 loads) |
| fireplace | 8 of 8 | yes | 60 fps, 1.65 ms (1.53 to 1.93 over 3 loads) |
| fireworks | 8 of 8 | yes | 60 fps, 2.93 ms (2.35 to 3.76 over 3 loads) |
| flame-ramps | 8 of 8 | yes | 60 fps, 2.59 ms (1.66 to 4.11 over 3 loads) |
| flame-shape | 8 of 8 | yes | 60 fps, 1.34 ms (1.26 to 1.96 over 3 loads) |
| flame-strip | 8 of 8 | yes | 60 fps, 1.66 ms (1.66 to 2.28 over 3 loads) |
| flicker | 8 of 8 | yes | 60 fps, 1.69 ms (1.60 to 2.50 over 3 loads) |
| forest-fire | 8 of 8 | yes | 60 fps, 1.22 ms (1.12 to 1.44 over 3 loads) |
| gas-jet | 8 of 8 | yes | 60 fps, 1.38 ms (0.97 to 1.66 over 3 loads) |
| haze-overlay | 8 of 8 | yes | 60 fps, 0.41 ms (0.39 to 1.13 over 3 loads) |
| heat-haze | 8 of 8 | yes | 60 fps, 1.97 ms (1.87 to 2.07 over 3 loads) |
| hello | 8 of 8 | yes | 60 fps, 4.44 ms (3.75 to 4.93 over 3 loads) |
| noise-flame | 8 of 8 | yes | 60 fps, 1.13 ms (1.11 to 1.34 over 3 loads) |
| particle-blending | 8 of 8 | yes | 60 fps, 3.52 ms (3.44 to 3.75 over 3 loads) |
| particle-flame | 8 of 8 | yes | 60 fps, 2.09 ms (1.66 to 3.07 over 3 loads) |
| particle-system | 8 of 8 | yes | 60 fps, 1.69 ms (1.45 to 1.81 over 3 loads) |
| particle-trails | 8 of 8 | yes | 60 fps, 1.59 ms (1.45 to 2.42 over 3 loads) |
| smoke-shading | 8 of 8 | yes | 60 fps, 5.55 ms (5.45 to 5.75 over 3 loads) |
| soft-sprites | 8 of 8 | yes | 60 fps, 1.33 ms (1.26 to 1.69 over 3 loads) |
| spark-shower | 8 of 8 | yes | 60 fps, 1.99 ms (1.82 to 1.99 over 3 loads) |
| sparkler | 8 of 8 | yes | 60 fps, 1.73 ms (1.70 to 2.09 over 3 loads) |
| sparks | 8 of 8 | yes | 60 fps, 1.32 ms (1.16 to 1.52 over 3 loads) |
| stable-fluids | 8 of 8 | yes | 60 fps, 2.05 ms (1.60 to 2.21 over 3 loads) |
| toon-fire | 8 of 8 | yes | 60 fps, 1.29 ms (1.24 to 1.38 over 3 loads) |
| torch | 8 of 8 | yes | 60 fps, 1.09 ms (0.95 to 1.10 over 3 loads) |
| volume-march | 8 of 8 | yes | 60 fps, 11.90 ms (11.90 to 13.70 over 3 loads) |

No view logged a console error.
