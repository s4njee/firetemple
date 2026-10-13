## How it works

Embers, sparks and glow are the cheapest fire there is: a quad per particle, a procedural shape in the fragment shader, and additive blending into the HDR scene. This page is the building block for that, in three parts that later effects reuse: the shared chunk `sprite.wgsl`, the instanced renderer `src/gpu/sprites.ts`, and this test scene.

The frame is three stages. The forward renderer draws a dim courtyard into the `rgba16float` scene target and a `depth32float` target. The sprite pass adds every sprite on top (`one`, `one`, target loaded, not cleared). The tail blooms and tonemaps. Sprite radiance is far above 1.0 (an ember core is around 16, a spark around 30), which is what makes a three-pixel dot read as hot once the bloom has spread it.

**Shapes.** Each is a function of the quad-local coordinate `p` in -1..1 and returns an intensity that is exactly 0 on the quad's border, so no quad ever shows its corners however many pile up: `sprite_disc`, `sprite_gaussian`, `sprite_ember` (a tight core on a wide dim halo, plus a core weight used to push the centre towards white) and `sprite_streak` (a rounded head and a tail that fades and narrows). The gaussian is shifted so it really reaches zero at radius 1, which a plain truncated gaussian does not.

**Soft fade.** The sprite pass has no depth attachment. It binds the scene depth as a texture, reads it with `textureLoad` at the pixel, and compares linear depths in the fragment shader:

```wgsl
let scene_z = camera_linear_depth(cam, textureLoad(scene_depth, vec2i(in.position.xy), 0));
// 0 at or behind the geometry, 1 once the geometry is `reach` behind the sprite
fade *= sprite_depth_fade_contrast(scene_z, in.view_z, reach, settings.fade_contrast);
```

A fade distance of zero is the ordinary depth test: the `hard` setting, which leaves a sharp line wherever a quad passes through the floor or a wall. With a distance, the sprite thins out as it approaches the surface and the line is gone. The `split` setting draws hard on the left half and soft on the right. `fade contrast` is the curve from Lorach's paper: above 1 the ramp becomes an S, so neither end of the fade is visible as an edge.

The fade distance here is a multiple of each sprite's own size, not a world distance. One world distance cannot serve a 3 cm spark and a 1 m puff: anything that suits the puff erases every spark lying on the ground.

**Velocity stretch.** In the vertex stage the sprite's velocity is reduced to the part that moves it on screen (`sprite_screen_velocity`), and the quad is lengthened along that direction to `size * (1 + stretch * speed)`, clamped. A sprite flying straight at the camera has no on-screen velocity and stays a square. Sparks trail behind their position, so the head of the streak is where the spark is. Stretched sprites are dimmed by the square root of the stretch.

**Sprites smaller than a pixel** are enlarged to one pixel and dimmed by the area ratio (`sprite_pixel_clamp`); otherwise they flicker as they cross pixel centres.

**Animation** is on the CPU in `particles.ts` and has no state. Every sprite's position is a closed-form function of one clock, with its randomness from an integer hash of (sprite, life number, channel). That makes the first frame already full, the motion independent of frame rate, and a headless render repeatable. Embers follow a swaying, wind-leaned path; sparks are ballistic and then lie on the ground cooling; a few dozen large dim gaussians make the flame body and the firelight on the floor. `shade.wgsl` replaces the renderer's default shading to colour each sprite from its heat.

## Cost

GPU time, measured: 0.5 ms per frame at 1920 × 1080 with the default settings, tail included (Apple M1 Max, Dawn under Node; the tail alone reads 0.7 ms, and repeated runs differ by up to about half a millisecond). In Chrome 155 on the same machine the HUD reads 1.1 ms for one frame at 1080p and 60 fps (`docs/studies/browser-check.md`); that figure includes the browser's timing floor. No integrated GPU or phone has been measured. The full table is `docs/studies/epic-3.md`. What can be counted:

- Passes: the scene, one sprite pass (two half-screen ones in `split`), then the tail.
- Per sprite pixel: one depth texel load, a divide and a `pow` for the fade, and one `sqrt` or `exp` for the shape. No texture sampling, no loop.
- Overdraw at 1920 × 1080 from the default camera, summing quad areas without clipping to the screen, so an upper bound: about 4.8 million sprite pixels a frame, 2.3 times the screen. The 48 large puffs are 4.3 million of that (about 89,000 pixels each). The 1,400 embers and sparks are 0.55 million (about 470 and 210 pixels each, stretch included). At the maximum of 4,000 embers and sparks the total is 5.8 million. Size is what costs, not count.
- Upload: 48 bytes per sprite every frame, 70 kB at the default count and 194 kB at the maximum, in one `writeBuffer`.
- CPU: about a dozen integer hashes per sprite per frame, and two path evaluations per ember for its velocity. Not measured.
- Memory: the instance buffer (194 kB) and a `depth32float` target at canvas size, on top of the scene target and bloom chain every effect has.

## Pitfalls

- The fade is measured along the view ray. Seen at a grazing angle, a sprite a small height above the floor has a long way to the floor behind it, so the fade band is thin on screen and starts to look like an edge again. Raise the fade distance for low cameras.
- A world-space fade distance dims every sprite that sits closer than that to a surface. Sparks resting on the ground vanished entirely until the distance was made relative to sprite size.
- A truncated gaussian leaves a faint square where many sprites overlap. Subtract its edge value, as `sprite_gaussian` does.
- A depth texture cannot be a writable attachment and a sampled texture in the same pass. The sprite pass therefore has no depth attachment, which also means hidden sprite pixels are not rejected early; they return after one texel load.
- A sprite at rest has no direction, so its quad falls back to an unstretched square facing +x. Round shapes cross that without a pop; a streak would turn. The scene blends sparks from streak to round as their stretch drops.
- Additive sprites are not sorted and never occlude each other, which is right for light and wrong for smoke. Dense overlaps add up to white quickly; the scene keeps puff radiance low for that reason.
- The renderer's settings live in one uniform buffer, so two draws of one renderer in the same frame share the last settings. The split view uses a second renderer on the same instance buffer.
- The scene geometry is not antialiased, and additive sprites over a bright background lose their colour. Neither is addressed here.

## When to use it

Whenever a fire needs embers or sparks, and for glow halos and haze light that must sit in a 3D scene without seams. It is Tier A in technique: the cost is overdraw, so it stays cheap as long as large sprites are few. Use the soft fade when sprites are larger than a few pixels or can touch geometry; for pixel-sized embers the hard test costs the same and looks the same. Over a 2D page with no depth buffer, draw with depth off.

Once the count goes past a few thousand, or the motion needs real forces and collisions, move the animation to the GPU and keep this renderer for the drawing: it accepts any instance buffer in the documented layout. For smoke, which has to darken what is behind it, additive sprites are the wrong tool.

## References

- Tristan Lorach, [Soft Particles](https://developer.download.nvidia.com/whitepapers/2007/SDK10/SoftParticles_hi.pdf) (NVIDIA, 2007): the depth fade and its contrast function.
- Iain Cantlay, [High-Speed, Off-Screen Particles](https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-23-high-speed-screen-particles) (GPU Gems 3, chapter 23): reducing the overdraw cost of large particles.
- [WebGPU specification, `depthReadOnly`](https://www.w3.org/TR/webgpu/#dom-gpurenderpassdepthstencilattachment-depthreadonly): a depth attachment that is written cannot also be sampled in the same pass; a read-only one can.
