# Cost study: Epic 4

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
| (floor) | one constant-colour pass | 1 | 0.07 | 0.07 | -0.37 to 0.79 |
| (tail) | constant scene + bloom + output | 11 | 0.66 | 0.48 | 0.00 to 1.38 |
| candle | default | 11 | 0.59 | 0.52 | 0.39 to 0.94 |
| candle | preset calm | 11 | 1.70 | 0.52 | 0.09 to 1.35 |
| candle | preset draughty | 11 | 0.85 | 0.87 | 0.46 to 1.79 |
| candle | preset tea light | 11 | 0.72 | 0.61 | 0.28 to 1.55 |
| candle | preset dinner candle | 11 | 0.92 | 0.87 | 0.09 to 1.29 |
| ember-bed | default | 11 | 0.59 | 0.63 | 0.44 to 0.76 |
| ember-bed | preset glowing bed | 11 | 0.66 | 0.59 | 0.11 to 0.90 |
| ember-bed | preset dying embers | 11 | 0.52 | 0.52 | 0.37 to 0.98 |
| ember-bed | preset forge | 11 | 0.66 | 0.70 | 0.50 to 1.20 |
| ember-bed | preset hearth | 11 | 0.59 | 0.59 | 0.52 to 1.00 |
| fire-ring | default | 11 | 0.79 | 1.05 | 0.52 to 1.84 |
| fire-ring | preset portal | 11 | 1.05 | 1.14 | 0.28 to 1.68 |
| fire-ring | preset avatar frame | 11 | 0.66 | 0.70 | 0.35 to 2.03 |
| fire-ring | preset loader | 11 | 0.72 | 0.57 | 0.11 to 1.42 |
| fire-ring | preset progress 60% | 11 | 0.72 | 0.63 | 0.37 to 1.00 |
| firelight-background | default | 12 | 0.59 | 0.52 | 0.02 to 1.29 |
| firelight-background | preset hearth | 12 | 0.66 | 0.50 | -0.07 to 1.57 |
| firelight-background | preset campfire to the left | 12 | 0.59 | 0.66 | 0.26 to 1.03 |
| firelight-background | preset embers | 12 | 1.11 | 0.44 | -0.37 to 0.90 |
| fireplace | default | 11 | 0.85 | 0.83 | 0.15 to 1.16 |
| fireplace | preset evening | 11 | 0.85 | 0.52 | 0.35 to 0.92 |
| fireplace | preset roaring | 11 | 0.72 | 0.72 | 0.28 to 0.94 |
| fireplace | preset low fire | 11 | 0.79 | 0.70 | 0.35 to 1.11 |
| fireplace | preset dying embers | 11 | 0.59 | 0.55 | 0.24 to 1.00 |
| flame-strip | default | 11 | 0.66 | 0.52 | 0.07 to 0.96 |
| flame-strip | preset strip | 11 | 0.66 | 0.66 | 0.31 to 1.66 |
| flame-strip | preset ember line | 11 | 0.66 | 0.63 | 0.09 to 1.07 |
| flame-strip | preset fire wall | 11 | 0.98 | 0.83 | 0.70 to 1.38 |
| gas-jet | default | 11 | 0.79 | 1.25 | 0.46 to 1.81 |
| gas-jet | preset blowtorch | 11 | 0.72 | 0.55 | 0.39 to 0.92 |
| gas-jet | preset stove burner | 11 | 0.79 | 0.68 | 0.33 to 1.00 |
| gas-jet | preset burner row | 11 | 0.85 | 0.85 | 0.48 to 1.05 |
| gas-jet | preset afterburner | 11 | 0.79 | 0.83 | 0.50 to 2.01 |
| gas-jet | preset bunsen | 11 | 0.72 | 0.61 | 0.33 to 1.20 |
| haze-overlay | default | 2 | 0.33 | 0.31 | 0.15 to 0.76 |
| haze-overlay | preset hot road | 2 | 0.33 | 0.24 | -0.04 to 0.52 |
| haze-overlay | preset mirage | 2 | 0.39 | 0.26 | -0.22 to 0.94 |
| haze-overlay | preset engine exhaust | 2 | 0.33 | 0.35 | 0.26 to 0.96 |
| haze-overlay | preset heat wave | 2 | 0.39 | 0.33 | -0.24 to 0.85 |
| haze-overlay | preset test grid | 2 | 0.46 | 0.42 | -0.07 to 1.07 |
| haze-overlay | preset off | 2 | 0.39 | 0.33 | -0.17 to 1.22 |
| noise-flame | default | 11 | 0.59 | 0.46 | -0.09 to 0.68 |
| noise-flame | preset wall | 11 | 0.66 | 0.57 | 0.02 to 1.14 |
| noise-flame | preset low burn | 11 | 0.92 | 0.63 | 0.35 to 1.35 |
| noise-flame | preset inferno | 11 | 0.72 | 0.59 | 0.39 to 1.00 |
| noise-flame | preset value noise | 11 | 1.11 | 1.44 | 0.98 to 1.88 |
| noise-flame | preset simplex | 11 | 1.18 | 1.18 | 0.63 to 1.57 |
| noise-flame | preset voronoi | 11 | 1.64 | 1.73 | 1.53 to 2.03 |
| noise-flame | preset gradient fbm | 11 | 0.92 | 1.09 | 0.85 to 1.27 |
| sparks | default | 11 | 0.59 | 0.44 | 0.13 to 0.74 |
| sparks | preset campfire drift | 11 | 0.66 | 0.59 | 0.50 to 1.03 |
| sparks | preset welding spray | 11 | 1.11 | 0.55 | 0.22 to 2.45 |
| sparks | preset grinder | 11 | 0.66 | 0.63 | 0.46 to 1.22 |
| sparks | preset bonfire gust | 11 | 0.98 | 1.38 | 0.48 to 1.62 |
| toon-fire | default | 11 | 0.85 | 0.55 | 0.35 to 1.14 |
| toon-fire | preset campfire | 11 | 0.92 | 1.29 | 0.11 to 1.84 |
| toon-fire | preset flame icon | 11 | 0.66 | 0.61 | 0.31 to 0.96 |
| toon-fire | preset spirit fire | 11 | 0.59 | 0.59 | 0.44 to 1.18 |
| toon-fire | preset toxic torch | 11 | 0.66 | 0.52 | -0.07 to 1.64 |
| toon-fire | preset smooth | 11 | 0.72 | 0.72 | 0.59 to 1.20 |
| torch | default | 11 | 1.11 | 1.31 | 0.59 to 1.86 |
| torch | preset wall torches | 11 | 1.44 | 0.48 | 0.17 to 1.25 |
| torch | preset braziers | 11 | 0.72 | 0.68 | 0.13 to 1.07 |
| torch | preset list markers | 11 | 1.51 | 0.52 | 0.22 to 1.03 |
| torch | preset blue fire | 11 | 0.79 | 0.48 | 0.09 to 0.90 |
| torch | preset one torch | 11 | 0.66 | 0.59 | 0.07 to 0.94 |
| torch | count=1 | 11 | 0.72 | 0.63 | 0.02 to 1.14 |
| torch | count=4 | 11 | 0.72 | 0.92 | 0.15 to 1.14 |
| torch | count=12 | 11 | 0.92 | 1.31 | 0.66 to 1.59 |
| torch | count=24 | 11 | 0.92 | 0.55 | 0.28 to 0.79 |
| torch | count=48 | 11 | 0.66 | 0.59 | 0.35 to 0.92 |
| sparks | layers=1 | 11 | 0.79 | 0.59 | 0.09 to 1.05 |
| sparks | layers=2 | 11 | 0.79 | 0.68 | 0.11 to 1.18 |
| sparks | layers=3 | 11 | 0.66 | 0.72 | 0.20 to 0.90 |
| sparks | layers=4 | 11 | 0.79 | 0.61 | 0.17 to 1.18 |

## 960 × 540

| Effect | Configuration | Passes | Span (ms) | Per frame (ms) | Range (ms) |
| --- | --- | ---: | ---: | ---: | --- |
| (floor) | one constant-colour pass | 1 | 0.00 | 0.07 | -0.11 to 0.09 |
| (tail) | constant scene + bloom + output | 9 | 0.39 | 0.33 | -0.13 to 0.52 |
| candle | default | 9 | 0.52 | 0.35 | -0.17 to 1.66 |
| candle | preset calm | 9 | 0.52 | 0.35 | 0.13 to 0.87 |
| candle | preset draughty | 9 | 0.46 | 0.37 | -0.20 to 1.29 |
| candle | preset tea light | 9 | 0.52 | 0.35 | -0.52 to 1.25 |
| candle | preset dinner candle | 9 | 0.52 | 0.33 | -0.28 to 1.25 |
| ember-bed | default | 9 | 0.46 | 0.33 | -0.22 to 0.85 |
| ember-bed | preset glowing bed | 9 | 0.46 | 0.33 | -0.42 to 1.09 |
| ember-bed | preset dying embers | 9 | 0.46 | 0.37 | -0.17 to 1.31 |
| ember-bed | preset forge | 9 | 0.46 | 0.31 | -0.26 to 0.79 |
| ember-bed | preset hearth | 9 | 0.39 | 0.35 | 0.15 to 0.85 |
| fire-ring | default | 9 | 0.46 | 0.35 | -0.46 to 1.38 |
| fire-ring | preset portal | 9 | 0.52 | 0.37 | -0.02 to 0.55 |
| fire-ring | preset avatar frame | 9 | 0.52 | 0.37 | 0.22 to 0.81 |
| fire-ring | preset loader | 9 | 0.52 | 0.37 | 0.02 to 0.81 |
| fire-ring | preset progress 60% | 9 | 0.52 | 0.39 | 0.17 to 0.87 |
| firelight-background | default | 10 | 0.46 | 0.35 | 0.28 to 0.63 |
| firelight-background | preset hearth | 10 | 0.52 | 0.44 | -0.24 to 1.25 |
| firelight-background | preset campfire to the left | 10 | 0.59 | 0.44 | -0.33 to 1.14 |
| firelight-background | preset embers | 10 | 0.59 | 0.48 | -0.17 to 1.49 |
| fireplace | default | 9 | 0.52 | 0.76 | -0.39 to 1.38 |
| fireplace | preset evening | 9 | 0.46 | 0.33 | 0.17 to 0.59 |
| fireplace | preset roaring | 9 | 0.39 | 0.37 | -0.13 to 0.85 |
| fireplace | preset low fire | 9 | 0.46 | 0.37 | -0.26 to 1.51 |
| fireplace | preset dying embers | 9 | 0.46 | 0.59 | 0.00 to 1.35 |
| flame-strip | default | 9 | 0.46 | 0.31 | -0.15 to 0.96 |
| flame-strip | preset strip | 9 | 0.52 | 0.35 | -0.22 to 0.72 |
| flame-strip | preset ember line | 9 | 1.90 | -0.09 | -0.55 to 1.22 |
| flame-strip | preset fire wall | 9 | 0.46 | 0.31 | -0.17 to 0.74 |
| gas-jet | default | 9 | 0.46 | 0.35 | -0.31 to 1.46 |
| gas-jet | preset blowtorch | 9 | 0.52 | 0.35 | -0.48 to 1.44 |
| gas-jet | preset stove burner | 9 | 0.52 | 0.37 | 0.02 to 1.29 |
| gas-jet | preset burner row | 9 | 0.52 | 0.35 | -0.55 to 1.03 |
| gas-jet | preset afterburner | 9 | 0.52 | 0.70 | -0.26 to 1.33 |
| gas-jet | preset bunsen | 9 | 0.52 | 0.33 | 0.11 to 0.92 |
| haze-overlay | default | 2 | 0.20 | 0.11 | -0.57 to 0.70 |
| haze-overlay | preset hot road | 2 | 0.20 | 0.11 | -0.39 to 1.00 |
| haze-overlay | preset mirage | 2 | 0.20 | 0.09 | -0.22 to 1.00 |
| haze-overlay | preset engine exhaust | 2 | 0.20 | 0.11 | -0.63 to 0.13 |
| haze-overlay | preset heat wave | 2 | 0.20 | 0.13 | -0.76 to 1.00 |
| haze-overlay | preset test grid | 2 | 0.20 | 0.11 | -0.39 to 0.96 |
| haze-overlay | preset off | 2 | 0.20 | 0.11 | -0.50 to 0.83 |
| noise-flame | default | 9 | 0.46 | 0.33 | -0.11 to 1.05 |
| noise-flame | preset wall | 9 | 0.46 | 0.37 | -0.11 to 1.44 |
| noise-flame | preset low burn | 9 | 0.52 | 0.35 | -0.20 to 1.33 |
| noise-flame | preset inferno | 9 | 0.52 | 0.35 | -0.22 to 1.51 |
| noise-flame | preset value noise | 9 | 0.66 | 0.66 | 0.39 to 0.92 |
| noise-flame | preset simplex | 9 | 0.79 | 0.46 | 0.28 to 1.22 |
| noise-flame | preset voronoi | 9 | 1.05 | 0.87 | 0.57 to 1.66 |
| noise-flame | preset gradient fbm | 9 | 0.46 | 0.42 | 0.11 to 0.76 |
| sparks | default | 9 | 0.46 | 0.33 | 0.28 to 0.81 |
| sparks | preset campfire drift | 9 | 0.52 | 0.52 | -0.02 to 1.16 |
| sparks | preset welding spray | 9 | 0.46 | 0.42 | -0.24 to 1.44 |
| sparks | preset grinder | 9 | 0.39 | 0.39 | 0.31 to 0.81 |
| sparks | preset bonfire gust | 9 | 0.52 | 0.59 | -0.09 to 1.66 |
| toon-fire | default | 9 | 0.52 | 0.33 | -0.31 to 0.85 |
| toon-fire | preset campfire | 9 | 0.52 | 0.28 | 0.17 to 0.96 |
| toon-fire | preset flame icon | 9 | 0.52 | 0.79 | -0.26 to 1.66 |
| toon-fire | preset spirit fire | 9 | 0.52 | 0.39 | -0.42 to 1.25 |
| toon-fire | preset toxic torch | 9 | 0.52 | 0.35 | -0.48 to 1.44 |
| toon-fire | preset smooth | 9 | 0.46 | 0.31 | -0.11 to 0.81 |
| torch | default | 9 | 0.46 | 0.35 | -0.35 to 1.31 |
| torch | preset wall torches | 9 | 0.52 | 0.33 | -0.42 to 1.27 |
| torch | preset braziers | 9 | 0.46 | 0.44 | -0.44 to 1.88 |
| torch | preset list markers | 9 | 0.46 | 0.35 | -0.09 to 0.90 |
| torch | preset blue fire | 9 | 0.46 | 0.37 | 0.15 to 0.92 |
| torch | preset one torch | 9 | 0.52 | 0.35 | -0.57 to 0.96 |
| torch | count=1 | 9 | 0.52 | 0.39 | -0.50 to 1.38 |
| torch | count=4 | 9 | 0.46 | 0.42 | 0.26 to 1.29 |
| torch | count=12 | 9 | 0.46 | 0.46 | -0.28 to 1.29 |
| torch | count=24 | 9 | 0.52 | 0.37 | -0.17 to 1.11 |
| torch | count=48 | 9 | 0.52 | 0.31 | -0.09 to 0.92 |
| sparks | layers=1 | 9 | 0.52 | 0.39 | -0.24 to 1.22 |
| sparks | layers=2 | 9 | 0.46 | 0.42 | 0.15 to 0.81 |
| sparks | layers=3 | 9 | 0.52 | 0.55 | -0.24 to 1.55 |
| sparks | layers=4 | 9 | 0.46 | 0.52 | 0.33 to 1.57 |

## Download size

What the page fetches to show the effect, beyond the first-load bundle (14.8 kB gzipped, no shaders).

| Effect | Chunks | Own chunk (kB gzip) | Total (kB gzip) |
| --- | ---: | ---: | ---: |
| candle | 21 | 2.1 | 45.8 |
| ember-bed | 20 | 1.6 | 39.2 |
| fire-ring | 18 | 1.6 | 37.2 |
| firelight-background | 14 | 1.7 | 25.7 |
| fireplace | 21 | 1.5 | 49.7 |
| flame-strip | 18 | 1.3 | 40.1 |
| gas-jet | 19 | 1.8 | 43.7 |
| haze-overlay | 18 | 4.1 | 38.5 |
| noise-flame | 20 | 1.2 | 40.2 |
| sparks | 18 | 1.9 | 41.7 |
| toon-fire | 17 | 2.0 | 37.2 |
| torch | 19 | 2.0 | 43.9 |
