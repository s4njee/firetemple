# Browser check

Every registered effect, loaded in Google Chrome 155.0.8059.40 (headless, this machine's GPU) on 2026-10-13 by `npm run browser-check`.

Views per effect: `hero-light` (1280 × 900), `hero-dark` (1280 × 900), `cards-dark` (1280 × 900), `band-light` (1280 × 900), `backdrop-dark` (1280 × 900), `phone-light` (390 × 844 at 2x), `phone-dark` (390 × 844 at 2x), `hud-1080p` (1920 × 1080). The layouts are the mock pages of the effect page; "light" and "dark" are the page tone of the stage.

- **Started** counts the views in which the effect got a canvas and drew more than a flat fill, with no fallback notice and no console error.
- **Animates** means two captures a second apart differ by more than dither in at least one view.
- **HUD** is what the performance HUD showed on a 1920 × 1080 canvas: frames per second, and the GPU time of one frame as the browser reports it (first pass start to last pass end).

The HUD time is not the number the cost studies report. It is one frame measured alone, through Chrome's coarse timestamps, on a GPU that idles between frames, so it carries a floor and reads higher than the per-frame cost in `docs/studies/epic-*.md`. It is here because it is what a visitor's browser actually does. This check says nothing about how an effect looks: the screenshots do.

| Effect | Started | Animates | HUD at 1080p |
| --- | ---: | --- | --- |
| advected-noise | 8 of 8 | yes | 60 fps, 3.72 ms |
| blackbody | 8 of 8 | no (a still picture) | 60 fps, 6.49 ms |
| bloom-tuning | 8 of 8 | yes | 60 fps, 1.27 ms |
| compositing | 8 of 8 | yes | 60 fps, 4.20 ms |
| fire-light | 8 of 8 | yes | 60 fps, 4.66 ms |
| flame-ramps | 8 of 8 | yes | 60 fps, 3.19 ms |
| flame-shape | 8 of 8 | yes | 60 fps, 2.13 ms |
| flicker | 8 of 8 | yes | 60 fps, 1.60 ms |
| heat-haze | 8 of 8 | yes | 60 fps, 4.24 ms |
| hello | 8 of 8 | yes | 60 fps, 6.88 ms |
| smoke-shading | 8 of 8 | yes | 60 fps, 7.97 ms |
| soft-sprites | 8 of 8 | yes | 60 fps, 1.10 ms |
| volume-march | 8 of 8 | yes | 60 fps, 9.86 ms |

No view logged a console error.
