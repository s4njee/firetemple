# Cost study: Epic 7

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
| (floor) | one constant-colour pass | 1 | 0.07 | 0.22 | -0.57 to 0.66 |
| (tail) | constant scene + bloom + output | 11 | 1.38 | 0.37 | -0.96 to 1.11 |
| embers | default | 13 | 0.72 | 0.76 | -1.68 to 1.99 |
| embers | preset campfire | 13 | 2.10 | 0.42 | -0.42 to 2.34 |
| embers | preset bonfire gust | 13 | 2.82 | 0.90 | -0.22 to 2.12 |
| embers | preset quiet hearth | 13 | 2.88 | 0.11 | -0.81 to 2.62 |
| embers | preset torch trail | 13 | 2.56 | 1.00 | -0.94 to 3.25 |
| embers | preset ember storm | 13 | 5.31 | 0.74 | -0.26 to 3.01 |
| fire-jet | default | 22 | 10.75 | 5.55 | -21.76 to 9.79 |
| fire-jet | preset flamethrower | 22 | 8.39 | 7.89 | 3.91 to 13.78 |
| fire-jet | preset dragon breath | 22 | 9.44 | 4.67 | 2.67 to 8.06 |
| fire-jet | preset wall splash | 22 | 14.61 | 7.47 | 4.09 to 14.40 |
| fire-jet | preset two-way coupling | 22 | 9.96 | 6.38 | 3.47 to 7.58 |
| fire-jet | preset particles only | 22 | 7.14 | 5.61 | 2.34 to 7.49 |
| fire-jet | preset fluid only | 21 | 5.37 | 2.53 | 0.96 to 5.35 |
| fireworks | default | 13 | 3.93 | 0.31 | -1.09 to 3.15 |
| fireworks | preset evening show | 13 | 4.33 | -0.48 | -10.70 to 1.40 |
| fireworks | preset peonies and chrysanthemums | 13 | 3.34 | 0.68 | -0.37 to 3.06 |
| fireworks | preset willow gold | 13 | 2.23 | 0.98 | -0.59 to 3.58 |
| fireworks | preset crossettes | 13 | 3.21 | 0.35 | -0.81 to 1.38 |
| fireworks | preset crackle and glitter | 13 | 3.41 | 0.70 | -0.59 to 2.10 |
| fireworks | preset rings and palms | 13 | 2.16 | 0.28 | -0.55 to 1.99 |
| fireworks | preset finale | 13 | 3.01 | 0.61 | -0.76 to 1.18 |
| particle-blending | default | 13 | 7.80 | 6.51 | 5.42 to 8.32 |
| particle-blending | preset sorted | oit | 15 | 13.43 | 14.64 | 10.11 to 17.89 |
| particle-blending | preset additive | sorted | 14 | 10.55 | 9.59 | 7.73 to 15.40 |
| particle-blending | preset unsorted | sorted | 14 | 10.29 | 10.88 | 6.62 to 16.36 |
| particle-blending | preset heavy smoke | 15 | 25.82 | 18.61 | 12.93 to 20.71 |
| particle-blending | preset dense | 13 | 26.74 | 25.62 | 22.33 to 30.80 |
| particle-flame | default | 13 | 5.64 | 2.88 | 0.15 to 8.02 |
| particle-flame | preset campfire | 13 | 4.26 | 3.91 | 1.07 to 5.92 |
| particle-flame | preset torch | 13 | 5.96 | 2.69 | 1.59 to 5.22 |
| particle-flame | preset candle | 13 | 4.65 | 1.81 | -0.22 to 5.40 |
| particle-flame | preset line of fire | 13 | 6.55 | 5.05 | 3.04 to 9.00 |
| particle-flame | preset windy brazier | 13 | 6.03 | 3.60 | 0.85 to 6.68 |
| particle-flame | preset black body | 13 | 6.75 | 3.65 | -0.42 to 5.90 |
| particle-system | default | 14 | 5.57 | 1.00 | -0.31 to 4.48 |
| particle-system | preset fountain | 14 | 4.39 | 1.62 | -0.31 to 4.13 |
| particle-system | preset collisions | 14 | 3.93 | 0.74 | -0.50 to 4.65 |
| particle-system | preset split on impact | 14 | 3.87 | 1.25 | -0.28 to 2.40 |
| particle-system | preset bursts and children | 14 | 3.41 | 0.98 | -0.26 to 2.14 |
| particle-system | preset swept emitter | 14 | 5.05 | 2.64 | 0.39 to 4.87 |
| particle-system | preset vortex field | 14 | 3.67 | 2.36 | -0.28 to 6.53 |
| particle-system | preset attractor | 14 | 3.01 | 1.46 | -0.35 to 4.04 |
| particle-system | preset 3d scene | 14 | 4.13 | 0.70 | -0.48 to 2.16 |
| particle-system | preset million | 14 | 25.10 | 15.51 | 7.25 to 21.41 |
| particle-trails | default | 17 | 6.09 | 1.49 | 0.22 to 5.22 |
| particle-trails | preset vortex embers | 17 | 3.67 | 0.79 | -0.35 to 3.08 |
| particle-trails | preset comets | 17 | 4.65 | 0.63 | 0.07 to 3.39 |
| particle-trails | preset sparkler | 17 | 1.57 | 0.98 | -0.98 to 2.53 |
| particle-trails | preset camera motion | 17 | 3.54 | 0.72 | 0.07 to 3.74 |
| particle-trails | preset ribbons only | 15 | 3.54 | 0.46 | -0.90 to 1.99 |
| particle-trails | preset accumulation only | 16 | 3.41 | 1.07 | -0.61 to 2.84 |
| particle-trails | preset 100k vortex | 17 | 10.94 | 8.21 | 5.35 to 13.24 |
| spark-shower | default | 15 | 4.33 | 1.31 | -0.26 to 3.21 |
| spark-shower | preset grinder | 15 | 4.33 | 1.55 | -0.28 to 3.25 |
| spark-shower | preset welding | 15 | 4.13 | 1.88 | 0.52 to 3.47 |
| spark-shower | preset forge hammer | 14 | 5.24 | 2.03 | -0.46 to 2.82 |
| spark-shower | preset sparks on cards | 14 | 5.37 | 1.44 | -0.31 to 3.01 |
| sparkler | default | 14 | 5.11 | 1.70 | 0.22 to 3.50 |
| sparkler | preset hand-held | 14 | 4.06 | 2.77 | -1.75 to 4.98 |
| sparkler | preset light painting | 14 | 4.46 | 2.64 | 0.39 to 4.06 |
| sparkler | preset golden shower | 14 | 4.39 | 2.29 | -2.34 to 5.37 |
| sparkler | preset branching stars | 14 | 3.41 | 2.67 | -0.26 to 4.15 |
| particle-system | fill=0.95 count=16384 | 14 | 5.24 | 2.42 | -0.44 to 4.02 |
| particle-system | fill=0.95 count=65536 | 14 | 5.96 | 3.74 | -1.31 to 5.99 |
| particle-system | fill=0.95 count=262144 | 14 | 12.85 | 7.73 | 5.90 to 11.82 |
| particle-system | fill=0.95 count=1048576 | 14 | 29.03 | 21.06 | 14.66 to 28.55 |
| particle-system | space=3d fill=0.95 count=65536 | 14 | 3.21 | 1.77 | -0.02 to 3.15 |
| particle-system | space=3d fill=0.95 count=262144 | 14 | 10.03 | 6.77 | 3.30 to 9.39 |
| particle-system | space=3d fill=0.95 count=1048576 | 14 | 27.00 | 21.98 | 8.06 to 30.63 |
| embers | count=2500 | 13 | 5.57 | 1.51 | -0.52 to 3.08 |
| embers | count=10000 | 13 | 4.06 | 1.59 | -0.79 to 4.35 |
| embers | count=40000 | 13 | 3.54 | 0.96 | -0.48 to 2.95 |
| embers | count=200000 | 13 | 7.47 | 4.65 | 2.47 to 7.62 |
| particle-flame | count=500 | 13 | 2.16 | 1.40 | -0.26 to 2.38 |
| particle-flame | count=2500 | 13 | 3.47 | 2.88 | 0.09 to 3.54 |
| particle-flame | count=10000 | 13 | 10.62 | 7.32 | 4.81 to 10.49 |
| particle-trails | method=ribbons count=1000 | 15 | 2.49 | 0.66 | 0.00 to 2.16 |
| particle-trails | method=ribbons count=10000 | 15 | 3.93 | 1.33 | -0.33 to 2.47 |
| particle-trails | method=ribbons count=100000 | 15 | 13.50 | 11.49 | 6.55 to 15.75 |
| particle-trails | method=accumulation count=1000 | 16 | 2.29 | 0.74 | -1.05 to 4.41 |
| particle-trails | method=accumulation count=10000 | 16 | 1.31 | 0.63 | 0.42 to 1.33 |
| particle-trails | method=accumulation count=100000 | 16 | 2.23 | 1.86 | 1.49 to 2.47 |
| particle-blending | count=2048 mode=additive | 12 | 6.03 | 7.10 | 5.05 to 9.90 |
| particle-blending | count=2048 mode=unsorted | 12 | 7.14 | 8.06 | 4.94 to 9.70 |
| particle-blending | count=2048 mode=sorted | 13 | 9.18 | 9.26 | 7.08 to 12.10 |
| particle-blending | count=2048 mode=oit | 13 | 13.11 | 12.12 | 10.01 to 14.96 |
| particle-blending | count=32768 mode=additive | 12 | 56.49 | 57.19 | 44.21 to 61.84 |
| particle-blending | count=32768 mode=unsorted | 12 | 58.59 | 54.37 | 49.20 to 67.83 |
| particle-blending | count=32768 mode=sorted | 13 | 54.79 | 60.25 | 48.96 to 71.70 |
| particle-blending | count=32768 mode=oit | 13 | 84.54 | 76.48 | 66.93 to 94.96 |
| particle-blending | count=32768 sort=radix | 13 | 56.95 | 59.64 | 53.22 to 69.95 |
| particle-blending | count=32768 sort=radix16 | 13 | 64.88 | 61.98 | 51.75 to 68.09 |
| particle-blending | count=32768 sort=bitonic | 13 | 57.21 | 56.54 | 47.82 to 68.90 |
| particle-blending | count=32768 sort=temporal | 13 | 64.42 | 57.80 | 45.35 to 64.33 |

## 960 × 540

| Effect | Configuration | Passes | Span (ms) | Per frame (ms) | Range (ms) |
| --- | --- | ---: | ---: | ---: | --- |
| (floor) | one constant-colour pass | 1 | 0.33 | 0.09 | -0.70 to 1.00 |
| (tail) | constant scene + bloom + output | 9 | 0.59 | 0.33 | -0.22 to 0.76 |
| embers | default | 11 | 0.52 | 0.35 | -0.61 to 1.57 |
| embers | preset campfire | 11 | 0.66 | 0.44 | -0.52 to 2.03 |
| embers | preset bonfire gust | 11 | 1.64 | 0.35 | -0.28 to 1.55 |
| embers | preset quiet hearth | 11 | 1.11 | 0.33 | -0.87 to 2.27 |
| embers | preset torch trail | 11 | 1.64 | 0.24 | -0.83 to 0.81 |
| embers | preset ember storm | 11 | 2.03 | 0.07 | -0.44 to 1.05 |
| fire-jet | default | 20 | 4.26 | 2.34 | -37.71 to 4.11 |
| fire-jet | preset flamethrower | 20 | 4.65 | 2.77 | 1.66 to 4.43 |
| fire-jet | preset dragon breath | 20 | 2.62 | 2.45 | 1.64 to 4.41 |
| fire-jet | preset wall splash | 20 | 13.17 | 9.94 | 6.53 to 12.17 |
| fire-jet | preset two-way coupling | 20 | 10.16 | 5.88 | 2.86 to 9.24 |
| fire-jet | preset particles only | 20 | 9.04 | 6.44 | 3.91 to 8.85 |
| fire-jet | preset fluid only | 19 | 5.31 | 5.81 | 2.12 to 10.62 |
| fireworks | default | 11 | 2.42 | 0.26 | -0.37 to 1.75 |
| fireworks | preset evening show | 11 | 1.77 | 0.35 | -0.70 to 1.27 |
| fireworks | preset peonies and chrysanthemums | 11 | 1.11 | 0.46 | -0.24 to 1.70 |
| fireworks | preset willow gold | 11 | 1.97 | 0.13 | -0.52 to 1.66 |
| fireworks | preset crossettes | 11 | 0.59 | 0.59 | -0.09 to 1.90 |
| fireworks | preset crackle and glitter | 11 | 0.46 | 0.52 | 0.15 to 1.62 |
| fireworks | preset rings and palms | 11 | 0.59 | 0.68 | -0.74 to 1.40 |
| fireworks | preset finale | 11 | 1.44 | 0.11 | -0.76 to 1.40 |
| particle-blending | default | 11 | 4.06 | 2.56 | 1.66 to 3.76 |
| particle-blending | preset sorted | oit | 13 | 2.88 | 4.24 | 1.44 to 6.27 |
| particle-blending | preset additive | sorted | 12 | 3.54 | 3.01 | 1.81 to 4.50 |
| particle-blending | preset unsorted | sorted | 12 | 3.80 | 2.97 | 1.62 to 3.56 |
| particle-blending | preset heavy smoke | 13 | 5.77 | 3.98 | 2.73 to 7.03 |
| particle-blending | preset dense | 11 | 15.20 | 14.22 | 11.01 to 19.64 |
| particle-flame | default | 11 | 2.03 | 0.81 | 0.31 to 1.49 |
| particle-flame | preset campfire | 11 | 1.84 | 0.57 | -0.17 to 1.86 |
| particle-flame | preset torch | 11 | 0.79 | 0.48 | 0.20 to 2.08 |
| particle-flame | preset candle | 11 | 2.36 | 0.35 | -1.35 to 2.51 |
| particle-flame | preset line of fire | 11 | 3.34 | 2.01 | -0.15 to 3.25 |
| particle-flame | preset windy brazier | 11 | 3.54 | 0.74 | -0.33 to 2.29 |
| particle-flame | preset black body | 11 | 1.97 | 1.92 | -0.59 to 3.10 |
| particle-system | default | 12 | 2.03 | 0.87 | -0.55 to 1.44 |
| particle-system | preset fountain | 12 | 2.69 | 1.14 | -0.90 to 1.99 |
| particle-system | preset collisions | 12 | 1.25 | 0.68 | -0.85 to 1.68 |
| particle-system | preset split on impact | 12 | 1.25 | 0.79 | -0.55 to 1.94 |
| particle-system | preset bursts and children | 12 | 1.05 | 1.42 | -0.94 to 2.69 |
| particle-system | preset swept emitter | 12 | 2.16 | 1.59 | 1.14 to 2.34 |
| particle-system | preset vortex field | 12 | 2.56 | 2.34 | 0.17 to 3.32 |
| particle-system | preset attractor | 12 | 1.90 | 0.74 | 0.09 to 2.10 |
| particle-system | preset 3d scene | 12 | 3.21 | 1.64 | 0.28 to 3.54 |
| particle-system | preset million | 12 | 26.80 | 14.77 | 12.89 to 19.51 |
| particle-trails | default | 15 | 5.18 | 1.29 | -0.79 to 4.26 |
| particle-trails | preset vortex embers | 15 | 5.24 | 1.51 | 0.33 to 4.28 |
| particle-trails | preset comets | 15 | 4.52 | 2.69 | -0.68 to 4.00 |
| particle-trails | preset sparkler | 15 | 5.05 | 2.12 | -0.90 to 4.04 |
| particle-trails | preset camera motion | 15 | 5.11 | 1.99 | -0.44 to 4.43 |
| particle-trails | preset ribbons only | 13 | 5.51 | 0.20 | -1.27 to 3.56 |
| particle-trails | preset accumulation only | 14 | 3.87 | 1.79 | -1.59 to 4.78 |
| particle-trails | preset 100k vortex | 15 | 9.57 | 7.32 | 4.43 to 10.97 |
| spark-shower | default | 13 | 2.75 | 0.22 | -0.61 to 1.57 |
| spark-shower | preset grinder | 13 | 1.18 | 0.52 | -0.76 to 1.38 |
| spark-shower | preset welding | 13 | 2.75 | 0.09 | -1.07 to 0.81 |
| spark-shower | preset forge hammer | 12 | 0.72 | 0.79 | -0.83 to 1.64 |
| spark-shower | preset sparks on cards | 12 | 1.44 | 0.46 | -0.66 to 1.25 |
| sparkler | default | 12 | 1.97 | 0.04 | -0.85 to 0.50 |
| sparkler | preset hand-held | 12 | 0.66 | 0.50 | -0.79 to 1.70 |
| sparkler | preset light painting | 12 | 0.79 | 0.52 | -0.76 to 0.66 |
| sparkler | preset golden shower | 12 | 1.05 | 0.44 | -0.74 to 2.47 |
| sparkler | preset branching stars | 12 | 0.98 | 0.46 | -0.17 to 1.29 |
| particle-system | fill=0.95 count=16384 | 12 | 0.52 | 0.76 | 0.33 to 1.40 |
| particle-system | fill=0.95 count=65536 | 12 | 1.64 | 1.11 | 0.33 to 1.99 |
| particle-system | fill=0.95 count=262144 | 12 | 4.13 | 3.23 | 2.16 to 4.13 |
| particle-system | fill=0.95 count=1048576 | 12 | 21.56 | 13.43 | 8.89 to 17.94 |
| particle-system | space=3d fill=0.95 count=65536 | 12 | 3.47 | 1.27 | -0.26 to 2.67 |
| particle-system | space=3d fill=0.95 count=262144 | 12 | 8.59 | 6.07 | 2.97 to 10.51 |
| particle-system | space=3d fill=0.95 count=1048576 | 12 | 28.57 | 18.72 | 13.81 to 21.54 |
| embers | count=2500 | 11 | 2.95 | 0.17 | -1.25 to 0.81 |
| embers | count=10000 | 11 | 1.31 | 0.72 | -0.33 to 1.38 |
| embers | count=40000 | 11 | 3.08 | 0.98 | -0.26 to 3.25 |
| embers | count=200000 | 11 | 5.96 | 4.50 | 2.01 to 5.26 |
| particle-flame | count=500 | 11 | 1.70 | 0.96 | -0.59 to 3.45 |
| particle-flame | count=2500 | 11 | 3.21 | 1.77 | 0.00 to 3.69 |
| particle-flame | count=10000 | 11 | 3.87 | 5.51 | 1.90 to 7.43 |
| particle-trails | method=ribbons count=1000 | 13 | 3.15 | 0.31 | -0.85 to 1.27 |
| particle-trails | method=ribbons count=10000 | 13 | 2.95 | 1.75 | 0.63 to 3.95 |
| particle-trails | method=ribbons count=100000 | 13 | 16.06 | 9.79 | 7.19 to 15.95 |
| particle-trails | method=accumulation count=1000 | 14 | 4.13 | 2.53 | -0.35 to 4.19 |
| particle-trails | method=accumulation count=10000 | 14 | 5.96 | -0.13 | -0.74 to 3.78 |
| particle-trails | method=accumulation count=100000 | 14 | 5.70 | 4.63 | 2.18 to 7.19 |
| particle-blending | count=2048 mode=additive | 10 | 6.62 | 6.73 | 4.26 to 8.80 |
| particle-blending | count=2048 mode=unsorted | 10 | 11.60 | 5.53 | 0.81 to 6.95 |
| particle-blending | count=2048 mode=sorted | 11 | 5.44 | 4.19 | 1.94 to 5.33 |
| particle-blending | count=2048 mode=oit | 11 | 6.49 | 4.78 | 1.94 to 7.45 |
| particle-blending | count=32768 mode=additive | 10 | 24.12 | 24.36 | 21.23 to 26.78 |
| particle-blending | count=32768 mode=unsorted | 10 | 23.00 | 21.30 | 20.62 to 27.11 |
| particle-blending | count=32768 mode=sorted | 11 | 23.66 | 22.09 | 18.13 to 29.23 |
| particle-blending | count=32768 mode=oit | 11 | 27.07 | 27.35 | 21.04 to 43.47 |
| particle-blending | count=32768 sort=radix | 11 | 25.76 | 25.80 | 21.95 to 28.22 |
| particle-blending | count=32768 sort=radix16 | 11 | 26.08 | 27.22 | 21.80 to 31.89 |
| particle-blending | count=32768 sort=bitonic | 11 | 23.13 | 25.60 | 20.97 to 28.70 |
| particle-blending | count=32768 sort=temporal | 11 | 22.02 | 23.27 | 20.60 to 27.63 |

## Download size

What the page fetches to show the effect, beyond the first-load bundle (21.6 kB gzipped, no shaders).

| Effect | Chunks | Own chunk (kB gzip) | Total (kB gzip) |
| --- | ---: | ---: | ---: |
| embers | 23 | 2.5 | 88.1 |
| fire-jet | 36 | 4.6 | 145.5 |
| fireworks | 24 | 3.1 | 93.8 |
| particle-blending | 24 | 2.9 | 74.8 |
| particle-flame | 26 | 3.1 | 94.3 |
| particle-system | 26 | 4.5 | 91.7 |
| particle-trails | 26 | 5.1 | 94.1 |
| spark-shower | 27 | 4.6 | 96.2 |
| sparkler | 25 | 3.2 | 90.9 |
