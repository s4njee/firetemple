## How it works

`bloom-tuning` is a test chart for story 3.4: how little bloom still reads as heat? One fullscreen pass (`scene.wgsl`) draws hot shapes at known radiance on black, and the tail does the rest. "Radiance" is the brightest channel, which is what the bloom threshold tests; every fire-coloured element is the tint (1, 0.36, 0.08) times its stated value, and 1.0 is paper white.

- **Strip** (bottom): 0.5 at the left to 50 at the right, logarithmic. Ticks sit under 0.5, 1, 2, 5, 10, 20 and 50; the tall one is 1.0, the default threshold.
- **Filaments** (top left): three wires 1.5 px wide at 4, 12 and 40.
- **Blob and disc** (left): a soft Gaussian ball and a hard-edged disc, both peaking at 12.
- **Sparks** (right): dots 1 to 2.5 px across, between 8 and 60, drifting upwards.
- **Paper white** (centre): a neutral square at exactly 1.0. It should not glow.

The controls are the tail's own (`bloom` intensity, `bloom threshold`, `bloom radius`, `exposure`) plus the settings the tail normally keeps to itself: `knee`, `levels`, half or full resolution, the firefly filter, and a `view` that shows the scene or the bloom alone. `levels` above 0 is a level count, which is what a cost sweep wants; 0 is the automatic count for the canvas size and -1 is one fewer.

**What the chart shows**

With bloom off (`none`) nothing reads as hot. The tonemapper clips everything above about 5 to the same cream, so the right half of the strip is flat and a spark at 60 looks like a spark at 8. The glow is the only cue for how far above white a pixel is.

How far the glow reaches is set by the level count, and it doubles with every level. Measured off the edge of the disc at 960 × 540, half resolution, to where the glow falls below 8 of 255:

| Levels | Reach | Share of the image height | Reads as                                |
| ------ | ----- | ------------------------- | --------------------------------------- |
| 1      | 3 px  | 0.6%                      | Fatter pixels. Worse than none.         |
| 2      | 11 px | 2.0%                      | A sticker outline with a hard end.      |
| 3      | 24 px | 4.4%                      | Hot. The glow still has a visible edge. |
| 4      | 46 px | 8.5%                      | Hot, and the edge is gone.              |
| 5      | 88 px | 16%                       | A wash over a third of the frame.       |

So the answer depends on the canvas size: a fixed count of 5 looks right at 1080p and floods a 480 × 270 card with orange. The level count that gives the same picture at every size keeps the coarsest level about 34 texels on its shorter side, which is 5 levels at 1080p, 4 at 540p and 3 at 270p. `bloomLevelsForSize` in `src/gpu/post/bloom.ts` computes it, and the tail now uses it when no count is given (`DEFAULT_BLOOM.levels` is 0, automatic; it was 5).

**The cheapest bloom that still reads as hot** is half resolution with one level fewer than automatic (the `minimal` preset): reach about 4% of the shorter side, 4 levels and 7 passes at 1080p. One fewer than that is the sticker. The default keeps the automatic count, because the visible edge at -1 is the thing that looks cheap.

The other tail defaults are unchanged: intensity 0.6, threshold 1, knee 0.5, radius 0.7. They cost nothing to change, and at those values the paper-white square does not visibly glow while the filament at 4 does. `heavy` shows the failure on the other side: a threshold of 0.8 with a wide knee makes paper white glow.

Full resolution with 5 levels looks like half resolution with 4: every level is twice as fine, so it needs one more level for the same reach. No difference was visible on the 1.5 px filaments or the sparks.

## Cost

GPU time, measured: 0.5 ms per frame at 1920 × 1080 with the default settings, tail included (Apple M1 Max, Dawn under Node; the tail alone reads 0.7 ms, and repeated runs differ by up to about half a millisecond). In Chrome 155 on the same machine the HUD reads 1.3 ms for one frame at 1080p and 60 fps (`docs/studies/browser-check.md`); that figure includes the browser's timing floor. No integrated GPU or phone has been measured. The full table is `docs/studies/epic-3.md`. By bloom level count, from the same run: 1 0.2 ms, 2 0.3 ms, 3 0.3 ms, 4 0.4 ms, 5 0.5 ms, 6 1.3 ms; with bloom off 0.3 ms. Those are all inside the run-to-run spread, so the honest reading is that the level count is not what bloom costs. What can be counted, at 1920 × 1080 (`bloomWorkload` in `src/gpu/post/bloom.ts`; a down pass reads 13 taps per texel, an up pass 9):

| Bloom                                  | Passes | Texels written | Share of the screen | Taps   | Level textures |
| -------------------------------------- | ------ | -------------- | ------------------- | ------ | -------------- |
| half, 1 level                          | 1      | 518,400        | 0.25                | 6.7 M  | 4.1 MB         |
| half, 2 levels                         | 3      | 1,166,400      | 0.56                | 13.1 M | 5.2 MB         |
| half, 3 levels                         | 5      | 1,328,400      | 0.64                | 14.7 M | 5.4 MB         |
| half, 4 levels (`minimal`)             | 7      | 1,368,960      | 0.66                | 15.1 M | 5.5 MB         |
| half, 5 levels (`default`)             | 9      | 1,379,160      | 0.67                | 15.2 M | 5.5 MB         |
| half, 8 levels                         | 15     | 1,382,530      | 0.67                | 15.2 M | 5.5 MB         |
| full, 6 levels (same reach as half, 5) | 11     | 5,526,360      | 2.67                | 60.8 M | 22.1 MB        |

Level sizes at half resolution: 960 × 540, 480 × 270, 240 × 135, 120 × 68, 60 × 34, 30 × 17, 15 × 9, 8 × 5.

Two things follow from the counting alone. The level count hardly moves the texel total: each level is a quarter of the one before, so going from 5 levels to 4 saves 0.7% of the texels and two passes. Whatever a level costs, it is the fixed cost of a pass, not its pixels. And full resolution is four times the texels, taps and memory for no visible gain. Both need the benchmark run to turn into milliseconds.

The chart pass itself is cheap arithmetic: no noise, and six hash calls per pixel in the spark area.

## Pitfalls

- A fixed level count is not a fixed look. Reach is in pixels and doubles per level, so the same count gives a tighter glow on a larger canvas or a higher pixel ratio. Use the automatic count, or compute one from the size.
- The automatic count steps by one as the canvas crosses a size boundary (the shorter side at about 48, 96, 192, 385, 770 and 1540 px), so the glow changes visibly at those sizes during a resize.
- One level is not a small bloom. It only thickens every shape by about 3 px.
- The knee starts below the threshold. With threshold 1 and knee 0.5, anything above 0.5 feeds the bloom a little; paper white at 1.0 contributes 12.5% of itself before intensity. Raise the threshold or lower the knee over a light backdrop.
- An override passed to `tail.encode` used to switch bloom back on at the default intensity when the `bloom` parameter was 0. That is fixed in `tail.ts` and tested; it is why `none` once looked like `default`.
- When the canvas shrinks, bloom levels that are no longer used stay allocated until the tail is destroyed.
- The reach figures were read off headless renders at one size. Timing, phones and the look in a browser are not covered.
- The firefly filter removes energy from isolated hot pixels on purpose, so a 1 px spark glows less than its radiance says.

## When to use it

Before tuning the bloom of any effect, and as the scene the cost study sweeps: `--params '{"levels":3}'` sets a count, `fullResolution` switches the chain. It is a tool, not decoration, and it fills its box with black, so it is not for a light page.

For an effect: keep the tail's defaults, and reach for `minimal` (one level fewer) only when many canvases share a page and two passes each matter. Do not ship full-resolution bloom.

## References

- Jorge Jimenez, [Next Generation Post Processing in Call of Duty: Advanced Warfare](https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare) (SIGGRAPH 2014): the 13-tap downsample, the tent upsample and the firefly weighting.
- Brian Karis, [Real Shading in Unreal Engine 4](https://blog.selfshadow.com/publications/s2013-shading-course/) (SIGGRAPH 2013 course): the luma-weighted average.
- Krzysztof Narkowicz, [ACES filmic tone mapping curve](https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/): why everything above about 5 clips to the same colour.
