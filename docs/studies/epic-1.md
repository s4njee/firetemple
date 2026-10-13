# Cost study: Epic 1

Measured 2026-10-13 on **Apple M1 Max** (apple-silicon), Dawn (node webgpu bindings).

Method: GPU timestamps: frame span (first pass start to last pass end) and marginal cost per extra frame. 12 warm-up frames, then the median of 11 rounds; each round encodes the frame once and 4 times in one command buffer.

- **span** is one frame alone, first pass start to last pass end. It includes the timing floor of this adapter (the `(floor)` row).
- **per frame** is the cost of one more frame of the same work (the slope). It is the number to compare effects by, and the one the Scorecard shows.
- `(tail)` is the HDR tail alone at its default settings. Every effect below includes it.

Only this adapter was measured. spanMs includes the timing floor (see the "(floor)" rows); slopeMs is the cost of one more frame of the same work and is the number to compare by. A slope at or below zero means the work is below what this method can resolve.

## 1920 × 1080

| Effect | Configuration | Passes | Span (ms) | Per frame (ms) | Range (ms) |
| --- | --- | ---: | ---: | ---: | --- |
| (floor) | one constant-colour pass | 1 | 0.07 | 0.07 | 0.02 to 0.39 |
| (tail) | constant scene + bloom + output | 11 | 0.59 | 0.61 | 0.33 to 1.35 |
| hello | default | 11 | 2.62 | 2.77 | 2.53 to 3.10 |
| hello | preset embers | 11 | 2.75 | 2.75 | 2.27 to 2.91 |
| hello | preset furnace | 11 | 2.75 | 2.73 | 2.51 to 3.04 |

## 960 × 540

| Effect | Configuration | Passes | Span (ms) | Per frame (ms) | Range (ms) |
| --- | --- | ---: | ---: | ---: | --- |
| (floor) | one constant-colour pass | 1 | 0.07 | 0.02 | -0.04 to 0.09 |
| (tail) | constant scene + bloom + output | 11 | 0.46 | 0.42 | 0.35 to 0.79 |
| hello | default | 11 | 0.79 | 0.79 | 0.63 to 0.92 |
| hello | preset embers | 11 | 0.79 | 0.70 | 0.42 to 0.96 |
| hello | preset furnace | 11 | 0.79 | 0.74 | 0.52 to 1.11 |

## Download size

What the page fetches to show the effect, beyond the first-load bundle (5.4 kB gzipped, no shaders).

| Effect | Chunks | Own chunk (kB gzip) | Total (kB gzip) |
| --- | ---: | ---: | ---: |
| hello | 11 | 8.8 | 21.5 |
