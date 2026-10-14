// probe.wgsl -- the fire as one light, measured from the simulation every frame: a single workgroup samples
// the temperature field on a 16 x 24 x 16 lattice, adds up the luminance of the gas (fire-shade.wgsl) and
// its luminance-weighted centre, and eases the stored light toward the result. The light's colour is a
// fixed firelight orange, not the mean of the gas's own colours: most of the gas is cool and deep red, and
// lighting the ground with that average looked like a darkroom lamp (so did the 1900 K blackbody tint,
// which is nearly pure red-orange in Rec.709). The scene lighting and the smoke in the march read it, so the ground brightens when the fire flares and the light sits where the
// flames are. The easing (a time constant of about a fifth of a second) keeps whole-scene brightness
// changes slow, which is what the flash analyser cares about; local flicker stays in the flames.
//
// Bindings: 0 ProbeParams, 1 the fire's fields, 2 a linear sampler, 3 the light (read-write storage).

#include "fire-shade.wgsl"
#include "probe-params.wgsl"

struct FireLight {
  position: vec4f,   // xyz world position of the light; w unused
  color: vec4f,      // rgb the light: mean luminance of the gas times ProbeParams.gain, tinted; a its luminance
}

@group(0) @binding(0) var<uniform> params: ProbeParams;
@group(0) @binding(1) var fields: texture_3d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<storage, read_write> light: FireLight;

const LATTICE = vec3u(16u, 24u, 16u);
const LIGHT_TINT = vec3f(1.0, 0.5, 0.18);

var<workgroup> power_sum: array<f32, 64>;
var<workgroup> place_sum: array<vec4f, 64>;

@compute @workgroup_size(64)
fn cs_probe(@builtin(local_invocation_index) index: u32) {
  // 64 threads, each a 2 x 2 block of columns (x, z) all the way up.
  let block = vec2u(index % 8u, index / 8u) * 2u;
  var place = vec3f(0.0);
  var weight = 0.0;
  for (var n = 0u; n < 4u; n++) {
    let column = block + vec2u(n & 1u, n >> 1u);
    for (var j = 0u; j < LATTICE.y; j++) {
      let uvw = (vec3f(f32(column.x), f32(j), f32(column.y)) + 0.5) / vec3f(LATTICE);
      let t = textureSampleLevel(fields, samp, uvw, 0.0).r;
      let w = luminance(fire3d_radiance(t));
      place += w * mix(params.box_min, params.box_max, uvw);
      weight += w;
    }
  }
  power_sum[index] = weight;
  place_sum[index] = vec4f(place, 0.0);
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride = stride / 2u) {
    if (index < stride) {
      power_sum[index] += power_sum[index + stride];
      place_sum[index] += place_sum[index + stride];
    }
    workgroupBarrier();
  }
  if (index == 0u) {
    let total = power_sum[0];
    let count = f32(LATTICE.x * LATTICE.y * LATTICE.z);
    let color = LIGHT_TINT * (total / count * params.gain);
    let centre = select(params.fallback, place_sum[0].xyz / total, total > 1e-5);
    // The first frame (or a reset) takes the measurement as it is; later ones ease toward it.
    let blend = select(params.blend, 1.0, light.color.a < 0.0 || params.reset != 0u);
    let next_color = mix(max(light.color.rgb, vec3f(0.0)), color, blend);
    light.color = vec4f(next_color, luminance(next_color));
    light.position = vec4f(mix(light.position.xyz, centre, blend), 1.0);
  }
}
