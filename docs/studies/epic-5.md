# Cost study: Epic 5

Measured 2026-10-14 on **Apple M1 Max** (apple-silicon), Dawn (node webgpu bindings).

Method: GPU timestamps: frame span (first pass start to last pass end) and marginal cost per extra frame. 12 warm-up frames, then the median of 11 rounds; each round encodes the frame once and 4 times in one command buffer.

- **span** is one frame alone, first pass start to last pass end. It includes the timing floor of this adapter (the `(floor)` row).
- **per frame** is the cost of one more frame of the same work (the slope). It is the number to compare effects by, and the one the Scorecard shows.
- `(tail)` is the HDR tail alone at its default settings. Every effect below includes it.

Only this adapter was measured. spanMs includes the timing floor (see the "(floor)" rows); slopeMs is the cost of one more frame of the same work and is the number to compare by. A slope at or below zero means the work is below what this method can resolve.

Two limits on reading these numbers. Repeated runs of a light effect differ by up to about half a millisecond (see the Range column), and a GPU's clock follows its load, so a light effect can read slower per unit of work than a heavy one: differences under about half a millisecond mean nothing. And the Tier A and B budgets are set for an integrated GPU; a time measured on a faster one can show an effect is over budget but cannot show that it fits.

## 1920 × 1080

| Effect | Configuration | Passes | Span (ms) | Per frame (ms) | Range (ms) |
| --- | --- | ---: | ---: | ---: | --- |
| (floor) | one constant-colour pass | 1 | 0.07 | 0.07 | -0.04 to 0.17 |
| (tail) | constant scene + bloom + output | 11 | 0.66 | 0.70 | 0.17 to 1.00 |
| burn-front | default | 12 | 1.18 | 0.98 | 0.92 to 1.16 |
| burn-front | preset slow paper | 12 | 0.85 | 0.66 | 0.46 to 1.62 |
| burn-front | preset flash paper | 12 | 0.92 | 1.16 | 0.52 to 1.51 |
| burn-front | preset hole | 12 | 1.25 | 1.29 | 0.66 to 1.51 |
| burn-front | preset from below | 12 | 1.18 | 1.09 | 0.87 to 1.88 |
| burn-front | preset ash | 12 | 1.18 | 1.27 | 0.74 to 1.53 |
| combustion-front | default | 12 | 1.18 | 0.98 | 0.63 to 1.14 |
| combustion-front | preset burn | 12 | 1.18 | 1.05 | 0.87 to 1.44 |
| combustion-front | preset steady creep | 12 | 1.11 | 0.94 | 0.42 to 1.42 |
| combustion-front | preset patchy smoulder | 12 | 0.85 | 0.85 | 0.37 to 0.98 |
| combustion-front | preset fast cycle | 13 | 1.18 | 0.81 | 0.50 to 1.53 |
| dom-fuel | default | 13 | 1.11 | 0.68 | 0.55 to 0.96 |
| dom-fuel | preset slow creep | 13 | 1.51 | 0.76 | 0.48 to 0.83 |
| dom-fuel | preset fast spread | 13 | 1.05 | 1.14 | 0.85 to 1.40 |
| dom-fuel | preset embers only | 13 | 1.05 | 0.96 | 0.50 to 1.16 |
| doom-fire | default | 12 | 0.66 | 0.70 | 0.48 to 0.90 |
| doom-fire | preset hearth | 12 | 0.66 | 0.46 | 0.42 to 0.76 |
| doom-fire | preset classic doom | 12 | 0.66 | 0.48 | 0.37 to 0.72 |
| doom-fire | preset footer | 11 | 0.59 | 0.52 | 0.44 to 0.85 |
| doom-fire | preset draw with the pointer | 12 | 0.59 | 0.48 | 0.33 to 0.70 |
| doom-fire | preset burnt out | 12 | 0.59 | 0.48 | 0.20 to 0.70 |
| doom-fire | preset fed by scrolling | 12 | 0.59 | 0.46 | 0.42 to 0.61 |
| doom-fire | preset gas blue | 12 | 0.59 | 0.46 | 0.39 to 0.76 |
| doom-fire | preset compute backend | 12 | 0.59 | 0.50 | 0.46 to 0.81 |
| forest-fire | default | 12 | 1.05 | 1.09 | 0.57 to 1.33 |
| forest-fire | preset living forest | 12 | 1.11 | 1.25 | 1.18 to 1.27 |
| forest-fire | preset quiet valley | 12 | 1.11 | 1.22 | 1.20 to 1.31 |
| forest-fire | preset windy day | 12 | 1.11 | 1.25 | 0.81 to 1.46 |
| forest-fire | preset all sizes | 12 | 0.66 | 0.57 | 0.33 to 1.05 |
| forest-fire | preset embers | 12 | 0.66 | 0.55 | 0.39 to 1.03 |
| doom-fire | backend=render resolution=48 | 12 | 0.92 | 1.09 | 0.57 to 1.22 |
| doom-fire | backend=render resolution=96 | 12 | 0.92 | 0.79 | 0.48 to 0.98 |
| doom-fire | backend=render resolution=192 | 12 | 0.72 | 0.52 | 0.26 to 0.76 |
| doom-fire | backend=render resolution=256 | 12 | 0.59 | 0.44 | 0.26 to 0.72 |
| doom-fire | backend=compute resolution=48 | 12 | 0.66 | 0.48 | 0.33 to 0.96 |
| doom-fire | backend=compute resolution=96 | 12 | 0.66 | 0.55 | 0.24 to 0.81 |
| doom-fire | backend=compute resolution=192 | 12 | 0.59 | 0.50 | 0.44 to 0.68 |
| doom-fire | backend=compute resolution=256 | 12 | 0.59 | 0.44 | 0.39 to 0.70 |
| burn-front | resolution=64 | 12 | 0.92 | 0.94 | 0.74 to 1.51 |
| burn-front | resolution=128 | 12 | 0.98 | 0.90 | 0.55 to 1.33 |
| burn-front | resolution=256 | 12 | 1.18 | 1.05 | 0.42 to 1.49 |
| burn-front | resolution=512 | 12 | 0.72 | 0.72 | 0.48 to 1.14 |
| forest-fire | resolution=48 | 12 | 0.72 | 0.74 | 0.44 to 0.96 |
| forest-fire | resolution=90 | 12 | 0.85 | 0.70 | 0.52 to 1.46 |
| forest-fire | resolution=180 | 12 | 0.79 | 0.74 | 0.55 to 1.16 |
| forest-fire | resolution=360 | 12 | 0.92 | 0.81 | 0.66 to 1.07 |
| combustion-front | grid=192 | 12 | 0.66 | 0.61 | 0.42 to 1.42 |
| combustion-front | grid=256 | 12 | 0.92 | 0.74 | 0.59 to 1.11 |
| combustion-front | grid=384 | 12 | 1.11 | 1.14 | 0.76 to 1.27 |
| combustion-front | grid=512 | 13 | 1.18 | 1.03 | 0.79 to 1.25 |

## 960 × 540

| Effect | Configuration | Passes | Span (ms) | Per frame (ms) | Range (ms) |
| --- | --- | ---: | ---: | ---: | --- |
| (floor) | one constant-colour pass | 1 | 0.07 | 0.07 | 0.00 to 0.11 |
| (tail) | constant scene + bloom + output | 9 | 0.52 | 0.35 | 0.31 to 0.42 |
| burn-front | default | 10 | 0.52 | 0.52 | 0.42 to 0.90 |
| burn-front | preset slow paper | 10 | 0.52 | 0.52 | 0.33 to 0.79 |
| burn-front | preset flash paper | 10 | 0.52 | 0.52 | 0.31 to 0.72 |
| burn-front | preset hole | 10 | 0.52 | 0.52 | 0.35 to 0.85 |
| burn-front | preset from below | 10 | 0.52 | 0.46 | 0.17 to 0.87 |
| burn-front | preset ash | 10 | 0.59 | 0.55 | 0.13 to 0.94 |
| combustion-front | default | 10 | 0.52 | 0.46 | 0.28 to 0.70 |
| combustion-front | preset burn | 10 | 0.59 | 0.42 | 0.15 to 0.85 |
| combustion-front | preset steady creep | 10 | 0.52 | 0.42 | 0.11 to 0.81 |
| combustion-front | preset patchy smoulder | 10 | 0.52 | 0.44 | 0.13 to 0.81 |
| combustion-front | preset fast cycle | 11 | 0.59 | 0.50 | 0.13 to 0.90 |
| dom-fuel | default | 11 | 0.59 | 0.44 | 0.11 to 0.79 |
| dom-fuel | preset slow creep | 11 | 0.52 | 0.48 | 0.33 to 0.81 |
| dom-fuel | preset fast spread | 11 | 0.59 | 0.52 | 0.31 to 0.87 |
| dom-fuel | preset embers only | 11 | 0.59 | 0.46 | 0.42 to 0.72 |
| doom-fire | default | 10 | 0.39 | 0.37 | 0.31 to 0.61 |
| doom-fire | preset hearth | 10 | 0.46 | 0.39 | 0.31 to 0.61 |
| doom-fire | preset classic doom | 10 | 0.46 | 0.37 | 0.26 to 0.72 |
| doom-fire | preset footer | 9 | 0.46 | 0.37 | 0.33 to 0.42 |
| doom-fire | preset draw with the pointer | 10 | 0.46 | 0.39 | 0.31 to 0.57 |
| doom-fire | preset burnt out | 10 | 0.46 | 0.37 | 0.31 to 0.52 |
| doom-fire | preset fed by scrolling | 10 | 0.46 | 0.35 | 0.15 to 0.42 |
| doom-fire | preset gas blue | 10 | 0.46 | 0.39 | 0.33 to 0.63 |
| doom-fire | preset compute backend | 10 | 0.46 | 0.31 | 0.11 to 0.48 |
| forest-fire | default | 10 | 0.52 | 0.42 | 0.11 to 0.72 |
| forest-fire | preset living forest | 10 | 0.52 | 0.42 | 0.09 to 0.79 |
| forest-fire | preset quiet valley | 10 | 0.52 | 0.46 | 0.07 to 0.66 |
| forest-fire | preset windy day | 10 | 0.59 | 0.42 | -0.15 to 0.83 |
| forest-fire | preset all sizes | 10 | 0.52 | 0.42 | 0.07 to 0.70 |
| forest-fire | preset embers | 10 | 0.52 | 0.46 | 0.15 to 0.74 |
| doom-fire | backend=render resolution=48 | 10 | 0.52 | 0.39 | 0.37 to 0.72 |
| doom-fire | backend=render resolution=96 | 10 | 0.66 | 0.39 | 0.26 to 1.05 |
| doom-fire | backend=render resolution=192 | 10 | 0.46 | 0.33 | 0.28 to 0.35 |
| doom-fire | backend=render resolution=256 | 10 | 0.46 | 0.37 | 0.31 to 0.70 |
| doom-fire | backend=compute resolution=48 | 10 | 0.39 | 0.33 | 0.28 to 0.59 |
| doom-fire | backend=compute resolution=96 | 10 | 0.39 | 0.37 | 0.31 to 0.42 |
| doom-fire | backend=compute resolution=192 | 10 | 0.46 | 0.35 | 0.31 to 0.70 |
| doom-fire | backend=compute resolution=256 | 10 | 0.39 | 0.37 | 0.33 to 0.61 |
| burn-front | resolution=64 | 10 | 0.46 | 0.37 | 0.31 to 0.70 |
| burn-front | resolution=128 | 10 | 0.59 | 0.44 | 0.28 to 0.90 |
| burn-front | resolution=256 | 10 | 0.52 | 0.52 | 0.20 to 0.98 |
| burn-front | resolution=512 | 10 | 0.52 | 0.52 | 0.07 to 0.94 |
| forest-fire | resolution=48 | 10 | 0.52 | 0.44 | 0.15 to 0.83 |
| forest-fire | resolution=90 | 10 | 0.52 | 0.44 | 0.15 to 0.74 |
| forest-fire | resolution=180 | 10 | 0.52 | 0.39 | 0.04 to 0.81 |
| forest-fire | resolution=360 | 10 | 0.59 | 0.42 | 0.09 to 0.90 |
| combustion-front | grid=192 | 10 | 0.52 | 0.42 | 0.11 to 0.85 |
| combustion-front | grid=256 | 10 | 0.59 | 0.42 | 0.13 to 0.72 |
| combustion-front | grid=384 | 10 | 0.52 | 0.44 | 0.02 to 0.81 |
| combustion-front | grid=512 | 11 | 0.66 | 0.52 | 0.28 to 0.83 |

## Download size

What the page fetches to show the effect, beyond the first-load bundle (16.8 kB gzipped, no shaders).

| Effect | Chunks | Own chunk (kB gzip) | Total (kB gzip) |
| --- | ---: | ---: | ---: |
| burn-front | 23 | 2.2 | 55.9 |
| combustion-front | 21 | 6.8 | 49.2 |
| dom-fuel | 25 | 2.7 | 58.0 |
| doom-fire | 20 | 8.6 | 46.6 |
| forest-fire | 22 | 8.1 | 51.2 |
