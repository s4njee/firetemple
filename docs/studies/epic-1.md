# Cost study: Epic 1

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
| (floor) | one constant-colour pass | 1 | 0.13 | 0.07 | 0.04 to 0.17 |
| (tail) | constant scene + bloom + output | 11 | 0.79 | 0.70 | 0.37 to 0.98 |
| hello | default | 11 | 2.42 | 2.47 | 2.25 to 2.99 |
| hello | preset embers | 11 | 2.42 | 2.42 | 2.38 to 2.51 |
| hello | preset furnace | 11 | 2.42 | 2.45 | 2.38 to 2.60 |

## 960 × 540

| Effect | Configuration | Passes | Span (ms) | Per frame (ms) | Range (ms) |
| --- | --- | ---: | ---: | ---: | --- |
| (floor) | one constant-colour pass | 1 | 0.07 | 0.04 | 0.02 to 0.07 |
| (tail) | constant scene + bloom + output | 9 | 0.39 | 0.33 | 0.26 to 0.57 |
| hello | default | 9 | 0.79 | 0.68 | 0.59 to 0.79 |
| hello | preset embers | 9 | 0.92 | 0.90 | 0.61 to 0.98 |
| hello | preset furnace | 9 | 0.92 | 1.00 | 0.70 to 1.81 |

## Download size

What the page fetches to show the effect, beyond the first-load bundle (14.4 kB gzipped, no shaders).

| Effect | Chunks | Own chunk (kB gzip) | Total (kB gzip) |
| --- | ---: | ---: | ---: |
| hello | 12 | 0.9 | 22.7 |
