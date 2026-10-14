# Cost study: Epic 6

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
| (floor) | one constant-colour pass | 1 | 0.13 | 0.04 | -0.02 to 0.09 |
| (tail) | constant scene + bloom + output | 11 | 0.72 | 0.68 | 0.50 to 0.98 |
| fire-3d | default | 19 | 2.03 | 1.55 | 1.16 to 1.97 |
| fire-3d | preset campfire | 19 | 2.69 | 1.84 | 1.57 to 2.29 |
| fire-3d | preset gas flame | 20 | 1.90 | 1.35 | 1.11 to 2.45 |
| fire-3d | preset smoulder | 19 | 1.77 | 1.35 | 1.18 to 2.45 |
| fire-3d | preset windy | 19 | 2.10 | 1.51 | 1.20 to 2.32 |
| fire-3d | preset budget | 19 | 2.03 | 1.55 | 1.35 to 1.88 |
| fire-fluid | default | 18 | 1.38 | 1.03 | 0.79 to 2.25 |
| fire-fluid | preset campfire | 18 | 1.70 | 1.25 | 0.87 to 2.45 |
| fire-fluid | preset gas burner | 18 | 1.57 | 1.35 | 0.92 to 2.62 |
| fire-fluid | preset torch | 19 | 1.84 | 1.53 | 1.22 to 1.88 |
| fire-fluid | preset smoky smoulder | 18 | 1.84 | 1.53 | 1.03 to 2.36 |
| fire-fluid | preset copper ring | 18 | 1.64 | 1.38 | 0.92 to 2.58 |
| fire-fluid | preset detail: none | 17 | 1.31 | 0.90 | 0.68 to 1.90 |
| fire-fluid | preset detail: confinement only | 17 | 1.38 | 1.11 | 0.83 to 1.81 |
| fire-fluid | preset detail: MacCormack only | 17 | 1.97 | 1.81 | 0.85 to 2.42 |
| fire-fluid | preset detail: BFECC only | 17 | 1.64 | 1.33 | 1.11 to 1.86 |
| fire-fluid | preset detail: turbulence only | 18 | 1.38 | 1.20 | 0.85 to 1.79 |
| fire-haze | default | 7 | 0.85 | 0.85 | 0.72 to 1.14 |
| fire-haze | preset hot plate | 7 | 0.92 | 0.83 | 0.72 to 0.94 |
| fire-haze | preset chimney | 7 | 0.85 | 0.68 | 0.39 to 0.81 |
| fire-haze | preset torch only | 6 | 0.72 | 0.66 | 0.52 to 0.70 |
| fire-haze | preset gradient only | 7 | 0.85 | 0.85 | 0.66 to 0.96 |
| fire-haze | preset test grid | 7 | 0.85 | 0.87 | 0.76 to 0.96 |
| fire-obstacles | default | 16 | 1.57 | 1.40 | 1.31 to 1.51 |
| fire-obstacles | preset burner | 16 | 1.64 | 1.40 | 1.35 to 1.51 |
| fire-obstacles | preset smoke pools | 16 | 1.57 | 1.38 | 1.27 to 1.53 |
| fire-obstacles | preset embers only | 15 | 1.51 | 1.25 | 1.18 to 1.31 |
| fire-obstacles | preset card row | 16 | 1.57 | 1.35 | 1.29 to 1.46 |
| fire-obstacles | preset round obstacle | 16 | 1.51 | 1.31 | 1.18 to 1.40 |
| fire-obstacles | preset slanted plate | 16 | 1.51 | 1.35 | 1.22 to 1.42 |
| stable-fluids | default | 16 | 0.92 | 0.79 | 0.66 to 1.00 |
| stable-fluids | preset smoulder | 16 | 1.77 | 1.38 | 0.92 to 2.42 |
| stable-fluids | preset stirred smoke | 16 | 1.64 | 1.22 | 0.81 to 2.40 |
| stable-fluids | preset semi-Lagrangian, no confinement | 16 | 1.18 | 0.92 | 0.76 to 1.75 |
| stable-fluids | preset fine multigrid | 16 | 1.90 | 1.66 | 1.40 to 4.22 |
| stable-fluids | preset expanding | 16 | 1.44 | 1.11 | 0.87 to 2.60 |
| stable-fluids | resolution=64 | 16 | 1.38 | 0.81 | 0.68 to 2.14 |
| stable-fluids | resolution=96 | 16 | 1.31 | 0.96 | 0.61 to 1.94 |
| stable-fluids | resolution=128 | 16 | 1.90 | 1.42 | 0.83 to 2.16 |
| stable-fluids | resolution=192 | 16 | 1.38 | 1.29 | 0.98 to 1.92 |
| stable-fluids | resolution=256 | 16 | 1.51 | 1.35 | 1.25 to 2.23 |
| stable-fluids | resolution=192 pressureSolver=jacobi | 16 | 1.44 | 1.27 | 0.92 to 2.67 |
| stable-fluids | resolution=192 pressureSolver=sor | 16 | 1.64 | 1.40 | 1.22 to 1.73 |
| stable-fluids | resolution=192 pressureSolver=multigrid | 16 | 1.84 | 1.59 | 1.25 to 1.92 |
| fire-fluid | resolution=96 | 18 | 1.77 | 1.40 | 1.03 to 2.42 |
| fire-fluid | resolution=128 | 18 | 1.84 | 1.38 | 1.09 to 1.97 |
| fire-fluid | resolution=160 | 18 | 1.64 | 1.49 | 1.07 to 1.79 |
| fire-fluid | resolution=192 | 18 | 2.03 | 1.66 | 1.53 to 1.94 |
| fire-3d | grid=32 | 19 | 2.42 | 1.88 | 1.59 to 2.14 |
| fire-3d | grid=48 | 19 | 2.29 | 1.86 | 1.42 to 2.23 |
| fire-3d | grid=64 | 19 | 2.16 | 1.77 | 1.62 to 2.14 |

## 960 × 540

| Effect | Configuration | Passes | Span (ms) | Per frame (ms) | Range (ms) |
| --- | --- | ---: | ---: | ---: | --- |
| (floor) | one constant-colour pass | 1 | 0.00 | 0.07 | 0.02 to 0.26 |
| (tail) | constant scene + bloom + output | 9 | 0.39 | 0.35 | 0.31 to 0.57 |
| fire-3d | default | 17 | 2.03 | 1.57 | 0.83 to 1.90 |
| fire-3d | preset campfire | 17 | 1.64 | 1.20 | 0.85 to 2.53 |
| fire-3d | preset gas flame | 18 | 1.64 | 1.46 | 0.66 to 2.12 |
| fire-3d | preset smoulder | 17 | 1.44 | 0.98 | 0.85 to 1.75 |
| fire-3d | preset windy | 17 | 1.77 | 1.62 | 0.87 to 2.49 |
| fire-3d | preset budget | 17 | 1.25 | 0.72 | 0.52 to 1.46 |
| fire-fluid | default | 16 | 1.77 | 1.38 | 1.14 to 1.92 |
| fire-fluid | preset campfire | 16 | 1.57 | 1.31 | 1.07 to 2.01 |
| fire-fluid | preset gas burner | 16 | 1.11 | 0.94 | 0.76 to 1.59 |
| fire-fluid | preset torch | 17 | 1.25 | 1.09 | 0.70 to 2.21 |
| fire-fluid | preset smoky smoulder | 16 | 1.18 | 0.92 | 0.70 to 1.70 |
| fire-fluid | preset copper ring | 16 | 1.44 | 1.20 | 0.79 to 1.66 |
| fire-fluid | preset detail: none | 15 | 0.98 | 0.87 | 0.26 to 1.31 |
| fire-fluid | preset detail: confinement only | 15 | 1.11 | 0.74 | 0.57 to 1.59 |
| fire-fluid | preset detail: MacCormack only | 15 | 1.77 | 1.38 | 1.20 to 1.75 |
| fire-fluid | preset detail: BFECC only | 15 | 1.11 | 1.05 | 0.70 to 1.77 |
| fire-fluid | preset detail: turbulence only | 16 | 1.51 | 1.38 | 0.85 to 1.59 |
| fire-haze | default | 7 | 0.79 | 0.79 | 0.68 to 0.87 |
| fire-haze | preset hot plate | 7 | 0.72 | 0.76 | 0.70 to 0.87 |
| fire-haze | preset chimney | 7 | 0.72 | 0.66 | 0.61 to 0.85 |
| fire-haze | preset torch only | 6 | 0.66 | 0.59 | 0.55 to 0.72 |
| fire-haze | preset gradient only | 7 | 0.79 | 0.72 | 0.68 to 0.90 |
| fire-haze | preset test grid | 7 | 0.79 | 0.76 | 0.70 to 0.85 |
| fire-obstacles | default | 14 | 1.31 | 1.27 | 1.20 to 1.40 |
| fire-obstacles | preset burner | 14 | 1.38 | 1.25 | 1.18 to 1.33 |
| fire-obstacles | preset smoke pools | 14 | 1.38 | 1.27 | 1.14 to 1.35 |
| fire-obstacles | preset embers only | 13 | 1.25 | 1.14 | 1.07 to 1.27 |
| fire-obstacles | preset card row | 14 | 1.38 | 1.22 | 1.16 to 1.35 |
| fire-obstacles | preset round obstacle | 14 | 1.38 | 1.27 | 1.09 to 1.35 |
| fire-obstacles | preset slanted plate | 14 | 1.38 | 1.25 | 1.18 to 1.38 |
| stable-fluids | default | 14 | 0.92 | 0.85 | 0.50 to 0.94 |
| stable-fluids | preset smoulder | 14 | 1.57 | 1.07 | 0.85 to 1.88 |
| stable-fluids | preset stirred smoke | 14 | 1.77 | 1.44 | 1.07 to 1.97 |
| stable-fluids | preset semi-Lagrangian, no confinement | 14 | 1.51 | 1.31 | 1.00 to 1.49 |
| stable-fluids | preset fine multigrid | 14 | 1.70 | 1.44 | 1.20 to 2.25 |
| stable-fluids | preset expanding | 14 | 1.11 | 0.94 | 0.74 to 1.18 |
| stable-fluids | resolution=64 | 14 | 1.44 | 1.33 | 0.98 to 1.84 |
| stable-fluids | resolution=96 | 14 | 1.57 | 1.42 | 1.14 to 1.73 |
| stable-fluids | resolution=128 | 14 | 1.05 | 1.07 | 0.85 to 1.73 |
| stable-fluids | resolution=192 | 14 | 1.77 | 1.49 | 1.20 to 1.92 |
| stable-fluids | resolution=256 | 14 | 1.70 | 1.64 | 1.20 to 1.88 |
| stable-fluids | resolution=192 pressureSolver=jacobi | 14 | 1.57 | 1.35 | 0.81 to 2.23 |
| stable-fluids | resolution=192 pressureSolver=sor | 14 | 1.44 | 1.18 | 0.94 to 2.21 |
| stable-fluids | resolution=192 pressureSolver=multigrid | 14 | 1.57 | 1.40 | 1.16 to 1.73 |
| fire-fluid | resolution=96 | 16 | 1.05 | 1.11 | 0.70 to 1.81 |
| fire-fluid | resolution=128 | 16 | 1.51 | 1.33 | 0.85 to 1.84 |
| fire-fluid | resolution=160 | 16 | 1.84 | 1.40 | 1.20 to 1.79 |
| fire-fluid | resolution=192 | 16 | 1.44 | 1.25 | 1.00 to 2.10 |
| fire-3d | grid=32 | 17 | 1.25 | 0.87 | 0.66 to 1.84 |
| fire-3d | grid=48 | 17 | 1.70 | 1.40 | 0.83 to 2.25 |
| fire-3d | grid=64 | 17 | 1.64 | 1.27 | 0.90 to 2.12 |

## Download size

What the page fetches to show the effect, beyond the first-load bundle (18.6 kB gzipped, no shaders).

| Effect | Chunks | Own chunk (kB gzip) | Total (kB gzip) |
| --- | ---: | ---: | ---: |
| fire-3d | 27 | 23.6 | 96.3 |
| fire-fluid | 26 | 11.2 | 91.8 |
| fire-haze | 26 | 3.7 | 77.1 |
| fire-obstacles | 18 | 8.7 | 66.4 |
| stable-fluids | 16 | 3.7 | 54.6 |
