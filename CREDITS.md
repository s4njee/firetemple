# Credits and third-party notices

Fire Temple is MIT licensed (see [LICENSE](LICENSE)). Fire Temple redistributes
no third-party images, fonts or models: every poster and fixture is rendered from
its own shaders at build or capture time.

## Algorithms and references

Effects implement published algorithms from the graphics literature. Each effect
cites its sources in `src/effects/<id>/notes.md`. The most-used references are:

- **Inigo Quilez** — 2D distance functions, domain warping and domain repetition,
  used by the flame and ember shapes (for example `candle`, `gas-jet`,
  `ember-bed`, `advected-noise`). <https://iquilezles.org/articles/>
- **Stefan Gustavson** — gradient/simplex noise, and the tiling flow-noise
  formulation used by `advected-noise`.
- **Krzysztof Narkowicz** — the ACES filmic tone-mapping curve used by the shared
  HDR tail and `bloom-tuning`.
- Additional citations (Jimenez, Karis, Hillaire, Perlin/Neyret, Bridson,
  Vlachos, Heitz/Neyret, Jarzynski/Olano and others) appear in the per-effect
  notes and the studies under `docs/`.

These are citations for techniques reimplemented from published descriptions, not
redistributed source.
