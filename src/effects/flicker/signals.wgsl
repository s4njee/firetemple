#include "fullscreen.wgsl"
#include "flicker.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;

// The signal texture: one row per light, one texel per trace sample. Column 0 is now and each
// column to the right is `span / (width - 1)` seconds older, so the scene pass reads the lights
// from column 0 and the oscilloscope traces from the rest, and evaluates no noise itself.
//   r: flicker_intensity          the capped signal
//   g: flicker_intensity_unsafe   the same settings with no caps
//   ba: flicker_offset            (uncapped when the switch is on)
@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let texel = floor(in.position.xy);
  let age = texel.x / max(params.trace_width - 1.0, 1.0) * params.span;
  // Times before zero wrap inside the chunk: the signal has an exact period.
  let t = params.time - age;
  let seed = u32(params.seed + texel.y);
  let req = params.settings;
  let s = flicker_settings(req.x, req.y, req.z, req.w);

  var offset = flicker_offset(t, seed, s);
  if (params.uncapped > 0.5) {
    offset = flicker_offset_unsafe(t, seed, s);
  }
  return vec4f(flicker_intensity(t, seed, s), flicker_intensity_unsafe(t, seed, s), offset);
}
