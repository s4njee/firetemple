// fire-shade.wgsl -- what the fields of the 3D fire (src/gpu/sim/fire3d.ts) look like, shared by the
// march, the light probe and the scene lighting so they agree on how bright the fire is.
//
// The field's temperature T is in units of 1000 K above a 300 K room (T = 1 is 1300 K). Radiance comes from
// the blackbody chunk at the tamed gamma, 1 at FIRE3D_T_REF; the caller multiplies by a brightness that puts
// flame bodies at 3-15 and cores at 15-50 (docs/effect-authoring.md). Below about 600 K (T = 0.3) the gas
// is faded out: a blackbody that cool is invisible, and the fade keeps the warm air above a fire from
// painting the whole box dull red.

#include "blackbody.wgsl"

const FIRE3D_ROOM_K: f32 = 300.0;
const FIRE3D_K_PER_UNIT: f32 = 1000.0;
const FIRE3D_T_REF: f32 = 1800.0;

fn fire3d_kelvin(t: f32) -> f32 {
  return FIRE3D_ROOM_K + FIRE3D_K_PER_UNIT * max(t, 0.0);
}

// Radiance of the gas at field temperature t, before the effect's brightness: 1 (luminance) at 1800 K.
fn fire3d_radiance(t: f32) -> vec3f {
  return blackbody_radiance(fire3d_kelvin(t), FIRE3D_T_REF, BLACKBODY_GAMMA) * smoothstep(0.2, 0.6, t);
}
