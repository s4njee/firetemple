# Browser check

Every registered effect, loaded in Google Chrome 155.0.8059.40 (headless, this machine's GPU) on 2026-10-14 by `npm run browser-check`.

Views per effect: `hero-light` (1280 × 900), `hero-dark` (1280 × 900), `cards-dark` (1280 × 900), `band-light` (1280 × 900), `backdrop-dark` (1280 × 900), `phone-light` (390 × 844 at 2x), `phone-dark` (390 × 844 at 2x), `hud-1080p` (1920 × 1080). The layouts are the mock pages of the effect page; "light" and "dark" are the page tone of the stage.

- **Started** counts the views in which the effect got a canvas and drew more than a flat fill, with no fallback notice and no console error.
- **Animates** means two captures a second apart differ by more than dither in at least one view.
- **HUD** is what the performance HUD showed on a 1920 × 1080 canvas: frames per second, and the GPU time of one frame as the browser reports it (first pass start to last pass end), as the median of several page loads with the range beside it. The range is wide for the lightest effects: when there is little to draw the GPU idles, and the same page reads either near the timing floor or about twice that from one load to the next.

The HUD time is not the number the cost studies report. It is one frame measured alone, through Chrome's coarse timestamps, on a GPU that idles between frames, so it carries a floor and reads higher than the per-frame cost in `docs/studies/epic-*.md`. It is here because it is what a visitor's browser actually does. This check says nothing about how an effect looks: the screenshots do.

| Effect | Started | Animates | HUD at 1080p |
| --- | ---: | --- | --- |
| advected-noise | 8 of 8 | yes | 60 fps, 3.85 ms (3.80 to 3.86 over 3 loads) |
| blackbody | 8 of 8 | no (a still picture) | 60 fps, 6.14 ms (6.07 to 6.41 over 3 loads) |
| bloom-tuning | 8 of 8 | yes | 60 fps, 1.27 ms (1.27 to 1.41 over 3 loads) |
| burn-front | 8 of 8 | yes | 60 fps, 1.50 ms (1.34 to 1.51 over 3 loads) |
| candle | 8 of 8 | yes | 60 fps, 1.66 ms (1.57 to 1.85 over 3 loads) |
| combustion-front | 8 of 8 | yes | 60 fps, 1.31 ms (1.29 to 1.39 over 3 loads) |
| compositing | 8 of 8 | yes | 60 fps, 3.57 ms (3.57 to 3.61 over 3 loads) |
| dom-fuel | 8 of 8 | yes | 60 fps, 1.16 ms (1.04 to 1.20 over 3 loads) |
| doom-fire | 8 of 8 | yes | 60 fps, 0.97 ms (0.88 to 1.06 over 3 loads) |
| ember-bed | 8 of 8 | yes | 60 fps, 1.32 ms (1.10 to 1.42 over 3 loads) |
| fire-light | 8 of 8 | yes | 60 fps, 4.64 ms (4.39 to 4.83 over 3 loads) |
| fire-ring | 8 of 8 | yes | 60 fps, 1.03 ms (1.01 to 1.03 over 3 loads) |
| firelight-background | 8 of 8 | yes | 60 fps, 1.17 ms (1.10 to 1.37 over 3 loads) |
| fireplace | 8 of 8 | yes | 60 fps, 1.52 ms (1.38 to 2.18 over 3 loads) |
| flame-ramps | 8 of 8 | yes | 60 fps, 3.08 ms (2.66 to 3.12 over 3 loads) |
| flame-shape | 8 of 8 | yes | 60 fps, 1.69 ms (1.69 to 1.96 over 3 loads) |
| flame-strip | 8 of 8 | yes | 60 fps, 1.49 ms (1.41 to 1.52 over 3 loads) |
| flicker | 8 of 8 | yes | 60 fps, 2.27 ms (2.25 to 2.38 over 3 loads) |
| forest-fire | 8 of 8 | yes | 60 fps, 1.51 ms (1.12 to 1.52 over 3 loads) |
| gas-jet | 8 of 8 | yes | 60 fps, 1.01 ms (0.97 to 1.03 over 3 loads) |
| haze-overlay | 8 of 8 | yes | 60 fps, 0.40 ms (0.38 to 0.45 over 3 loads) |
| heat-haze | 8 of 8 | yes | 60 fps, 3.46 ms (3.36 to 4.20 over 3 loads) |
| hello | 8 of 8 | yes | 60 fps, 6.19 ms (5.88 to 6.30 over 3 loads) |
| noise-flame | 8 of 8 | yes | 60 fps, 0.90 ms (0.88 to 1.07 over 3 loads) |
| smoke-shading | 8 of 8 | yes | 60 fps, 6.64 ms (6.09 to 7.97 over 3 loads) |
| soft-sprites | 8 of 8 | yes | 60 fps, 1.71 ms (1.70 to 1.84 over 3 loads) |
| sparks | 8 of 8 | yes | 60 fps, 1.46 ms (1.46 to 1.59 over 3 loads) |
| toon-fire | 8 of 8 | yes | 60 fps, 2.18 ms (1.49 to 2.19 over 3 loads) |
| torch | 8 of 8 | yes | 60 fps, 1.78 ms (1.34 to 1.97 over 3 loads) |
| volume-march | 8 of 8 | yes | 60 fps, 7.26 ms (7.10 to 7.49 over 3 loads) |

No view logged a console error.
