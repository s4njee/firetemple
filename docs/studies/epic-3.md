# Cost study: Epic 3

Measured 2026-10-13 on **Apple M1 Max** (apple-silicon), Dawn (node webgpu bindings).

Method: GPU timestamps: frame span (first pass start to last pass end) and marginal cost per extra frame. 12 warm-up frames, then the median of 11 rounds; each round encodes the frame once and 4 times in one command buffer.

- **span** is one frame alone, first pass start to last pass end. It includes the timing floor of this adapter (the `(floor)` row).
- **per frame** is the cost of one more frame of the same work (the slope). It is the number to compare effects by, and the one the Scorecard shows.
- `(tail)` is the HDR tail alone at its default settings. Every effect below includes it.

Only this adapter was measured. spanMs includes the timing floor (see the "(floor)" rows); slopeMs is the cost of one more frame of the same work and is the number to compare by. A slope at or below zero means the work is below what this method can resolve.

Two limits on reading these numbers. Repeated runs of a light effect differ by up to about half a millisecond (see the Range column), and a GPU's clock follows its load, so a light effect can read slower per unit of work than a heavy one: differences under about half a millisecond mean nothing. And the Tier A and B budgets are set for an integrated GPU; a time measured on a faster one can show an effect is over budget but cannot show that it fits.

## 1920 × 1080

| Effect | Configuration | Passes | Span (ms) | Per frame (ms) | Range (ms) |
| --- | --- | ---: | ---: | ---: | --- |
| (floor) | one constant-colour pass | 1 | 0.13 | 0.04 | -0.15 to 0.15 |
| (tail) | constant scene + bloom + output | 11 | 0.72 | 0.72 | 0.66 to 1.00 |
| advected-noise | default | 11 | 1.64 | 1.59 | 1.22 to 2.27 |
| advected-noise | preset compare | 11 | 1.51 | 1.46 | 1.27 to 2.05 |
| advected-noise | preset split against scroll | 11 | 1.44 | 1.38 | 1.16 to 1.94 |
| advected-noise | preset no rise | 11 | 1.44 | 1.31 | 1.03 to 1.46 |
| advected-noise | preset too much | 11 | 1.44 | 1.51 | 1.33 to 2.01 |
| advected-noise | preset backdrop | 11 | 1.51 | 1.46 | 1.25 to 3.15 |
| blackbody | default | 11 | 2.88 | 2.69 | 2.53 to 2.91 |
| blackbody | preset fire range | 11 | 2.69 | 2.69 | 2.51 to 2.75 |
| blackbody | preset full range | 11 | 2.62 | 2.64 | 2.56 to 2.80 |
| blackbody | preset tiny lookup | 11 | 2.69 | 2.69 | 2.62 to 2.97 |
| blackbody | preset physical | 11 | 2.62 | 2.80 | 2.67 to 3.01 |
| blackbody | preset intensity curves | 11 | 0.46 | 0.42 | 0.28 to 0.81 |
| bloom-tuning | default | 11 | 0.52 | 0.46 | 0.35 to 0.66 |
| bloom-tuning | preset none | 2 | 0.26 | 0.22 | 0.00 to 0.37 |
| bloom-tuning | preset minimal | 9 | 0.59 | 0.50 | 0.15 to 0.70 |
| bloom-tuning | preset default | 11 | 1.05 | 1.22 | 1.14 to 1.42 |
| bloom-tuning | preset heavy | 11 | 1.11 | 1.20 | 0.87 to 1.31 |
| compositing | default | 11 | 1.70 | 1.53 | 1.25 to 2.36 |
| compositing | preset recommended | 11 | 1.31 | 1.38 | 1.25 to 1.55 |
| compositing | preset no underlay | 11 | 1.38 | 1.29 | 1.25 to 1.51 |
| compositing | preset heavy underlay | 11 | 1.31 | 1.38 | 1.22 to 1.66 |
| compositing | preset additive | 11 | 1.38 | 1.38 | 1.16 to 1.55 |
| compositing | preset additive + underlay | 11 | 1.44 | 1.40 | 1.25 to 1.49 |
| compositing | preset coverage | 11 | 1.31 | 1.40 | 1.29 to 1.55 |
| compositing | preset hard alpha | 11 | 1.44 | 1.44 | 1.22 to 1.64 |
| compositing | preset opaque | 11 | 1.31 | 1.42 | 1.05 to 1.55 |
| compositing | preset css screen | 11 | 1.38 | 1.22 | 1.11 to 1.70 |
| compositing | preset css plus-lighter | 11 | 1.38 | 1.42 | 1.20 to 1.62 |
| compositing | preset css lighten | 11 | 1.31 | 1.35 | 1.16 to 1.68 |
| compositing | preset css multiply | 11 | 1.57 | 1.31 | 1.07 to 1.84 |
| fire-light | default | 11 | 1.64 | 1.66 | 1.55 to 1.73 |
| fire-light | preset candle | 11 | 1.51 | 1.62 | 1.49 to 4.11 |
| fire-light | preset hearth | 11 | 1.57 | 1.55 | 1.51 to 1.66 |
| fire-light | preset twin | 11 | 1.64 | 1.66 | 1.62 to 1.75 |
| flame-ramps | default | 11 | 0.72 | 0.72 | 0.52 to 0.87 |
| flame-ramps | preset all ramps | 11 | 0.98 | 1.14 | 0.83 to 2.62 |
| flame-ramps | preset campfire | 11 | 0.98 | 0.98 | 0.66 to 1.14 |
| flame-ramps | preset gas burner | 11 | 1.05 | 1.42 | 0.61 to 1.75 |
| flame-ramps | preset copper green | 11 | 1.05 | 1.18 | 0.72 to 1.99 |
| flame-ramps | preset blackbody, physical | 11 | 0.79 | 0.74 | 0.52 to 1.70 |
| flame-ramps | preset tiny texture | 11 | 1.31 | 1.27 | 0.81 to 1.99 |
| flame-shape | default | 11 | 0.98 | 0.98 | 0.76 to 1.59 |
| flame-shape | preset candle | 11 | 1.18 | 1.27 | 0.76 to 1.81 |
| flame-shape | preset campfire | 11 | 0.98 | 1.11 | 0.76 to 2.10 |
| flame-shape | preset jet | 11 | 1.05 | 1.00 | 0.61 to 1.27 |
| flicker | default | 12 | 1.25 | 1.20 | 0.76 to 1.77 |
| flicker | preset hearth | 12 | 1.05 | 1.40 | 1.14 to 1.62 |
| flicker | preset shimmer only | 12 | 1.51 | 0.79 | 0.57 to 1.79 |
| flicker | preset clamped | 12 | 0.85 | 0.85 | 0.66 to 0.94 |
| heat-haze | default | 11 | 1.31 | 1.18 | 0.96 to 1.31 |
| heat-haze | preset hot road | 11 | 1.57 | 1.53 | 1.27 to 2.01 |
| heat-haze | preset furnace | 11 | 1.70 | 1.42 | 1.22 to 2.21 |
| heat-haze | preset light page | 11 | 1.25 | 1.38 | 1.16 to 1.42 |
| heat-haze | preset off | 11 | 1.31 | 1.18 | 0.87 to 1.53 |
| smoke-shading | default | 12 | 4.59 | 4.67 | 3.87 to 5.18 |
| smoke-shading | preset wood-smoke | 12 | 4.52 | 4.67 | 4.35 to 5.51 |
| smoke-shading | preset oil-fire | 12 | 5.05 | 4.85 | 4.00 to 5.48 |
| smoke-shading | preset smoulder | 12 | 4.52 | 4.43 | 3.63 to 5.05 |
| soft-sprites | default | 12 | 0.66 | 0.48 | 0.13 to 1.03 |
| soft-sprites | preset compare | 13 | 0.52 | 0.50 | 0.42 to 0.76 |
| soft-sprites | preset sparks | 12 | 0.59 | 0.52 | 0.37 to 0.72 |
| soft-sprites | preset embers | 12 | 1.11 | 1.09 | 0.96 to 1.51 |
| volume-march | default | 15 | 6.29 | 6.73 | 5.79 to 7.41 |
| volume-march | preset reference | 15 | 38.47 | 37.53 | 33.42 to 40.96 |
| volume-march | preset budget | 15 | 2.10 | 2.08 | 1.94 to 2.12 |
| volume-march | preset no-jitter | 15 | 7.01 | 6.82 | 6.40 to 7.32 |
| volume-march | preset edge-closeup | 15 | 4.52 | 4.59 | 4.37 to 5.29 |
| volume-march | preset smoulder | 15 | 6.49 | 6.55 | 6.07 to 6.82 |
| bloom-tuning | levels=1 | 3 | 0.33 | 0.24 | 0.22 to 0.42 |
| bloom-tuning | levels=2 | 5 | 0.33 | 0.28 | 0.24 to 0.33 |
| bloom-tuning | levels=3 | 7 | 0.39 | 0.31 | 0.26 to 0.52 |
| bloom-tuning | levels=4 | 9 | 0.46 | 0.39 | 0.09 to 0.74 |
| bloom-tuning | levels=5 | 11 | 0.52 | 0.52 | 0.15 to 1.35 |
| bloom-tuning | levels=6 | 13 | 1.11 | 1.31 | 0.52 to 1.40 |
| bloom-tuning | bloom=0 | 2 | 0.39 | 0.33 | 0.31 to 0.48 |
| advected-noise | mode=scroll | 11 | 1.44 | 1.29 | 1.07 to 1.81 |
| advected-noise | mode=warp | 11 | 1.25 | 1.22 | 1.14 to 1.77 |
| advected-noise | mode=flow noise | 11 | 1.44 | 1.09 | 1.07 to 2.75 |
| advected-noise | mode=curl | 11 | 1.11 | 1.20 | 0.85 to 2.08 |
| advected-noise | mode=two-phase | 11 | 1.64 | 1.44 | 1.27 to 1.75 |
| advected-noise | mode=curl + flow | 11 | 1.90 | 1.75 | 1.40 to 2.64 |
| smoke-shading | shadowing=none | 12 | 3.47 | 3.39 | 3.06 to 3.67 |
| smoke-shading | shadowing=gradient | 12 | 4.59 | 4.35 | 3.67 to 4.87 |
| smoke-shading | shadowing=march | 12 | 6.16 | 6.60 | 5.48 to 7.10 |
| smoke-shading | steps=16 | 12 | 2.56 | 2.62 | 2.34 to 3.10 |
| smoke-shading | steps=32 | 12 | 4.52 | 4.67 | 4.13 to 5.20 |
| smoke-shading | steps=64 | 12 | 8.39 | 8.76 | 7.51 to 9.24 |
| fire-light | shadows=none | 11 | 1.51 | 1.57 | 1.33 to 1.62 |
| fire-light | shadows=hard | 11 | 1.84 | 1.73 | 1.44 to 2.08 |
| fire-light | shadows=soft | 11 | 1.97 | 1.79 | 1.59 to 5.02 |
| fire-light | shadows=traced | 11 | 3.28 | 3.28 | 3.17 to 3.45 |
| fire-light | shadows=traced-classic | 11 | 3.28 | 3.32 | 3.12 to 3.58 |
| volume-march | resolution=1 | 15 | 18.09 | 19.38 | 16.67 to 21.52 |
| volume-march | resolution=1/2 | 15 | 6.36 | 6.51 | 5.99 to 6.95 |
| volume-march | resolution=1/4 | 15 | 3.21 | 3.10 | 2.86 to 3.58 |
| volume-march | resolution=1/2 steps=32 | 15 | 3.87 | 4.37 | 3.84 to 4.57 |
| volume-march | resolution=1/2 steps=64 | 15 | 7.08 | 6.47 | 5.79 to 7.93 |
| volume-march | resolution=1/2 steps=128 | 15 | 11.47 | 11.69 | 10.51 to 14.37 |
| volume-march | resolution=1/2 upsample=bilinear | 15 | 6.36 | 6.29 | 5.05 to 7.32 |
| volume-march | resolution=1/2 upsample=depth-aware | 15 | 6.36 | 7.12 | 6.18 to 7.45 |

## 960 × 540

| Effect | Configuration | Passes | Span (ms) | Per frame (ms) | Range (ms) |
| --- | --- | ---: | ---: | ---: | --- |
| (floor) | one constant-colour pass | 1 | 0.00 | 0.04 | 0.02 to 0.09 |
| (tail) | constant scene + bloom + output | 9 | 0.39 | 0.33 | 0.09 to 0.55 |
| advected-noise | default | 9 | 0.39 | 0.35 | 0.13 to 0.57 |
| advected-noise | preset compare | 9 | 0.46 | 0.44 | 0.37 to 0.57 |
| advected-noise | preset split against scroll | 9 | 1.11 | 1.29 | 0.52 to 1.44 |
| advected-noise | preset no rise | 9 | 0.98 | 0.96 | 0.61 to 1.31 |
| advected-noise | preset too much | 9 | 0.98 | 1.05 | 0.79 to 1.27 |
| advected-noise | preset backdrop | 9 | 1.11 | 1.22 | 0.79 to 1.38 |
| blackbody | default | 9 | 1.11 | 1.07 | 0.81 to 3.10 |
| blackbody | preset fire range | 9 | 0.98 | 0.98 | 0.94 to 1.14 |
| blackbody | preset full range | 9 | 1.05 | 1.05 | 0.94 to 1.09 |
| blackbody | preset tiny lookup | 9 | 1.05 | 1.07 | 0.96 to 1.25 |
| blackbody | preset physical | 9 | 1.38 | 1.22 | 1.00 to 1.84 |
| blackbody | preset intensity curves | 9 | 0.39 | 0.31 | 0.15 to 0.70 |
| bloom-tuning | default | 9 | 0.46 | 0.39 | 0.37 to 0.68 |
| bloom-tuning | preset none | 2 | 0.26 | 0.17 | 0.09 to 0.52 |
| bloom-tuning | preset minimal | 7 | 0.46 | 0.33 | 0.02 to 0.72 |
| bloom-tuning | preset default | 9 | 0.46 | 0.42 | 0.11 to 0.74 |
| bloom-tuning | preset heavy | 9 | 0.46 | 0.37 | 0.28 to 0.92 |
| compositing | default | 9 | 0.72 | 0.72 | 0.48 to 0.87 |
| compositing | preset recommended | 9 | 1.05 | 0.85 | 0.48 to 2.01 |
| compositing | preset no underlay | 9 | 0.79 | 0.81 | 0.59 to 0.96 |
| compositing | preset heavy underlay | 9 | 0.92 | 0.90 | 0.81 to 0.96 |
| compositing | preset additive | 9 | 0.92 | 0.74 | 0.48 to 1.70 |
| compositing | preset additive + underlay | 9 | 0.98 | 0.79 | 0.57 to 1.44 |
| compositing | preset coverage | 9 | 0.98 | 0.98 | 0.59 to 1.25 |
| compositing | preset hard alpha | 9 | 1.11 | 1.11 | 0.81 to 1.33 |
| compositing | preset opaque | 9 | 1.05 | 0.68 | 0.31 to 1.77 |
| compositing | preset css screen | 9 | 0.79 | 0.76 | 0.57 to 1.00 |
| compositing | preset css plus-lighter | 9 | 1.05 | 1.09 | 0.81 to 1.68 |
| compositing | preset css lighten | 9 | 0.79 | 0.70 | 0.42 to 1.29 |
| compositing | preset css multiply | 9 | 0.85 | 0.83 | 0.61 to 0.98 |
| fire-light | default | 9 | 1.05 | 1.14 | 0.59 to 1.64 |
| fire-light | preset candle | 9 | 0.79 | 0.81 | 0.66 to 1.03 |
| fire-light | preset hearth | 9 | 0.66 | 0.66 | 0.55 to 0.74 |
| fire-light | preset twin | 9 | 1.18 | 1.18 | 0.63 to 1.55 |
| flame-ramps | default | 9 | 0.52 | 0.52 | 0.24 to 0.74 |
| flame-ramps | preset all ramps | 9 | 0.79 | 0.76 | 0.48 to 1.20 |
| flame-ramps | preset campfire | 9 | 0.66 | 0.66 | 0.46 to 0.85 |
| flame-ramps | preset gas burner | 9 | 0.59 | 0.70 | 0.44 to 0.92 |
| flame-ramps | preset copper green | 9 | 0.66 | 0.68 | 0.37 to 0.96 |
| flame-ramps | preset blackbody, physical | 9 | 0.66 | 0.63 | 0.31 to 0.74 |
| flame-ramps | preset tiny texture | 9 | 0.46 | 0.50 | 0.28 to 1.05 |
| flame-shape | default | 9 | 0.52 | 0.48 | 0.31 to 0.81 |
| flame-shape | preset candle | 9 | 0.59 | 0.55 | 0.26 to 0.94 |
| flame-shape | preset campfire | 9 | 0.79 | 0.68 | 0.35 to 0.83 |
| flame-shape | preset jet | 9 | 0.66 | 0.57 | 0.35 to 0.96 |
| flicker | default | 10 | 0.59 | 0.55 | 0.37 to 0.76 |
| flicker | preset hearth | 10 | 0.59 | 0.52 | 0.35 to 0.76 |
| flicker | preset shimmer only | 10 | 0.59 | 0.50 | 0.13 to 0.94 |
| flicker | preset clamped | 10 | 0.59 | 0.52 | 0.35 to 0.79 |
| heat-haze | default | 9 | 1.11 | 0.96 | 0.42 to 1.09 |
| heat-haze | preset hot road | 9 | 1.11 | 1.18 | 0.70 to 1.42 |
| heat-haze | preset furnace | 9 | 0.66 | 0.70 | 0.50 to 1.33 |
| heat-haze | preset light page | 9 | 1.11 | 1.25 | 0.72 to 1.44 |
| heat-haze | preset off | 9 | 0.92 | 0.66 | 0.57 to 1.03 |
| smoke-shading | default | 9 | 4.59 | 4.33 | 3.65 to 4.76 |
| smoke-shading | preset wood-smoke | 9 | 4.65 | 4.17 | 4.00 to 4.92 |
| smoke-shading | preset oil-fire | 9 | 4.52 | 4.54 | 3.74 to 5.37 |
| smoke-shading | preset smoulder | 9 | 4.33 | 4.22 | 3.54 to 4.70 |
| soft-sprites | default | 10 | 0.39 | 0.37 | 0.33 to 0.61 |
| soft-sprites | preset compare | 11 | 0.46 | 0.46 | 0.33 to 0.76 |
| soft-sprites | preset sparks | 10 | 1.18 | 0.31 | 0.00 to 0.50 |
| soft-sprites | preset embers | 10 | 0.52 | 0.44 | 0.04 to 0.72 |
| volume-march | default | 13 | 2.56 | 2.56 | 2.47 to 3.04 |
| volume-march | preset reference | 13 | 11.53 | 11.62 | 9.00 to 13.06 |
| volume-march | preset budget | 13 | 1.57 | 0.83 | 0.68 to 1.00 |
| volume-march | preset no-jitter | 13 | 2.49 | 2.58 | 2.25 to 4.78 |
| volume-march | preset edge-closeup | 13 | 2.10 | 2.10 | 2.01 to 2.23 |
| volume-march | preset smoulder | 13 | 2.75 | 2.60 | 2.23 to 2.64 |
| bloom-tuning | levels=1 | 3 | 0.13 | 0.11 | -0.11 to 0.13 |
| bloom-tuning | levels=2 | 5 | 0.26 | 0.17 | 0.13 to 0.44 |
| bloom-tuning | levels=3 | 7 | 0.33 | 0.26 | 0.22 to 0.57 |
| bloom-tuning | levels=4 | 9 | 0.39 | 0.33 | 0.24 to 0.59 |
| bloom-tuning | levels=5 | 11 | 0.46 | 0.44 | 0.37 to 0.79 |
| bloom-tuning | levels=6 | 13 | 0.59 | 0.52 | 0.24 to 0.81 |
| bloom-tuning | bloom=0 | 2 | 0.26 | 0.17 | -0.04 to 0.22 |
| advected-noise | mode=scroll | 9 | 1.11 | 1.31 | 0.90 to 1.40 |
| advected-noise | mode=warp | 9 | 0.98 | 0.92 | 0.31 to 1.42 |
| advected-noise | mode=flow noise | 9 | 0.92 | 0.85 | 0.48 to 1.11 |
| advected-noise | mode=curl | 9 | 0.59 | 0.59 | 0.39 to 1.14 |
| advected-noise | mode=two-phase | 9 | 0.79 | 0.94 | 0.48 to 1.55 |
| advected-noise | mode=curl + flow | 9 | 0.92 | 0.87 | 0.52 to 1.11 |
| smoke-shading | shadowing=none | 9 | 3.15 | 3.30 | 2.88 to 3.71 |
| smoke-shading | shadowing=gradient | 9 | 4.39 | 4.24 | 3.56 to 4.87 |
| smoke-shading | shadowing=march | 9 | 6.23 | 5.88 | 4.52 to 6.66 |
| smoke-shading | steps=16 | 9 | 2.42 | 2.42 | 2.10 to 2.84 |
| smoke-shading | steps=32 | 9 | 4.46 | 4.26 | 3.45 to 5.20 |
| smoke-shading | steps=64 | 9 | 8.19 | 8.34 | 6.86 to 9.74 |
| fire-light | shadows=none | 9 | 0.52 | 0.44 | 0.33 to 0.68 |
| fire-light | shadows=hard | 9 | 0.72 | 0.55 | 0.44 to 0.90 |
| fire-light | shadows=soft | 9 | 0.79 | 0.72 | 0.48 to 1.31 |
| fire-light | shadows=traced | 9 | 1.38 | 1.38 | 1.20 to 1.64 |
| fire-light | shadows=traced-classic | 9 | 1.70 | 1.46 | 1.11 to 1.68 |
| volume-march | resolution=1 | 13 | 6.03 | 6.16 | 5.20 to 7.10 |
| volume-march | resolution=1/2 | 13 | 2.56 | 2.53 | 2.29 to 2.97 |
| volume-march | resolution=1/4 | 13 | 1.64 | 1.62 | 1.55 to 1.66 |
| volume-march | resolution=1/2 steps=32 | 13 | 1.51 | 1.51 | 1.44 to 1.77 |
| volume-march | resolution=1/2 steps=64 | 13 | 2.49 | 2.53 | 2.40 to 2.73 |
| volume-march | resolution=1/2 steps=128 | 13 | 4.59 | 4.61 | 4.35 to 5.20 |
| volume-march | resolution=1/2 upsample=bilinear | 13 | 2.56 | 2.56 | 2.40 to 2.73 |
| volume-march | resolution=1/2 upsample=depth-aware | 13 | 2.49 | 2.58 | 2.51 to 2.99 |

## Download size

What the page fetches to show the effect, beyond the first-load bundle (14.4 kB gzipped, no shaders).

| Effect | Chunks | Own chunk (kB gzip) | Total (kB gzip) |
| --- | ---: | ---: | ---: |
| advected-noise | 16 | 1.5 | 39.2 |
| blackbody | 13 | 1.4 | 26.7 |
| bloom-tuning | 10 | 1.0 | 19.9 |
| compositing | 13 | 1.1 | 26.3 |
| fire-light | 18 | 2.4 | 44.5 |
| flame-ramps | 18 | 2.3 | 40.7 |
| flame-shape | 16 | 1.1 | 38.3 |
| flicker | 14 | 1.5 | 29.4 |
| heat-haze | 17 | 1.7 | 36.2 |
| smoke-shading | 15 | 1.4 | 38.6 |
| soft-sprites | 13 | 6.6 | 41.6 |
| volume-march | 20 | 6.3 | 56.9 |
