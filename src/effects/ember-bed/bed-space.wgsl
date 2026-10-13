// Where on the bed a pixel looks. Shared by the bake and the frame pass so the two agree.
//
//   bed_point(uv, aspect, tilt) -> vec3f
//       xy: the point on the bed, x from the centre, y away from the viewer. One unit is the
//           canvas height at the near (bottom) edge, or 1 / 2.4 of the width if that is larger:
//           a wide, short band would otherwise be paved with coals too small to read
//       z:  how much further away than the near edge it is (1 at the bottom, larger above)
// tilt 0 looks straight down (z is 1 everywhere); tilt 1 is a shallow view in which the top edge
// is 2.6 times further away. The map is a homography: straight lines stay straight, and a coal
// at depth z is 1 / z as wide and 1 / z^2 as tall.

fn bed_point(uv: vec2f, aspect: f32, tilt: f32) -> vec3f {
  let up = 1.0 - uv.y;
  let depth = 1.0 / (1.0 - 0.62 * clamp(tilt, 0.0, 1.0) * up);
  let unit = max(1.0, aspect / 2.4);
  return vec3f(vec2f((uv.x - 0.5) * aspect, up) * (depth / unit), depth);
}
