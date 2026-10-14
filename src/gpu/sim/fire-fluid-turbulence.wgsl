// fire-fluid-turbulence.wgsl -- procedural turbulence for the 2D fluid fire (src/gpu/sim/fire-fluid.ts),
// run as the solver's `hooks.forces` once per step when `turbulence` is above zero.
//
// Detail the grid cannot keep is put back as a force: the curl of a noise potential psi, read from the
// shared baked noise tile, at a wavelength of `turb_scale` velocity cells (just above the grid; the tile's
// four octaves reach down to an eighth of that). The idea is the one Kim et al. (2008, "Wavelet
// Turbulence") apply below the grid and Horvath and Geiger (2009) use to direct GPU fire: synthetic
// small-scale motion, weighted by where the energy is. Here the weight is the temperature, so the noise
// stirs the flame and leaves still air still.
//
// The potential lives at the CELL CORNERS, so its discrete curl on the staggered grid,
//     u(i, j) += k (psi(i, j + 1) - psi(i, j))       v(i, j) -= k (psi(i + 1, j) - psi(i, j)),
// is divergence-free to the last bit: the projection that follows has nothing to remove, and the force
// is not wasted. psi = w(T) n(x, y, t) with w = T / (1 + T), and n two layers of the tile rising at
// `turb_rise` image heights a second (and 0.6 of that), so the eddies are carried up and change shape.
// k scales the per-cell difference so that `turbulence` reads as an acceleration in image heights per
// second squared. It fades over the last four cells before an open edge, as confinement does.
//
// Bindings: 0 the step's uniforms, 1 the velocity (sampled), 2 the new velocity (storage, every texel),
// 3 the dye, 4 a linear clamp sampler, 5 + 6 the shared noise tile and its sampler.

#include "noisetex.wgsl"
#include "fire-fluid-params.wgsl"

@group(0) @binding(0) var<uniform> F: FireFluidStep;
@group(0) @binding(1) var vel_src: texture_2d<f32>;
@group(0) @binding(2) var vel_dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var dye_tex: texture_2d<f32>;
@group(0) @binding(4) var dye_smp: sampler;
@group(0) @binding(5) var noise_tex: texture_2d<f32>;
@group(0) @binding(6) var noise_smp: sampler;

const FF_TAU: f32 = 6.2831853;

// 0 on an open edge, rising to 1 four cells in (closed edges, walls, do not count), for a corner at
// `corner` (cells). Applied to the potential, so the force stays exactly divergence-free.
fn ff_edge_fade(corner: vec2f) -> f32 {
  if (F.open_edges == 0u) {
    return 1.0;
  }
  let g = vec2f(F.grid);
  let far = 1e6;
  let left = select(far, corner.x, (F.open_edges & 1u) != 0u);
  let right = select(far, g.x - corner.x, (F.open_edges & 2u) != 0u);
  let top = select(far, corner.y, (F.open_edges & 4u) != 0u);
  let bottom = select(far, g.y - corner.y, (F.open_edges & 8u) != 0u);
  return clamp(min(min(left, right), min(top, bottom)) / 4.0, 0.0, 1.0);
}

// The potential at a cell corner (cells, top-left origin).
fn ff_psi(corner: vec2f) -> f32 {
  let g = vec2f(F.grid);
  let temp = max(textureSampleLevel(dye_tex, dye_smp, corner / g, 0.0).r, 0.0);
  let w = temp / (1.0 + temp) * ff_edge_fade(corner);
  if (w < 1e-3) {
    return 0.0;
  }
  let p = corner / F.turb_scale;
  let rise = F.time * F.turb_rise * g.y / F.turb_scale;
  // The tile has 32 texels per noise cell, so 32 / turb_scale per velocity cell: read the mip level
  // that leaves about one texel per cell, so the octaves finer than two cells (which the grid can only
  // alias into a checkerboard) are filtered out.
  let lod = max(0.0, log2(32.0 / F.turb_scale));
  let a = noisetex_sample_lod(noise_tex, noise_smp, p + vec2f(0.0, rise), lod).r;
  let b = noisetex_sample_lod(noise_tex, noise_smp, p * 1.37 + vec2f(5.2, 1.3 + 0.6 * rise), lod).g;
  return w * (a + b - 1.0);
}

@compute @workgroup_size(16, 16)
fn cs_turbulence(@builtin(global_invocation_id) id: vec3u) {
  let g = vec2i(F.grid);
  if (any(id.xy >= F.grid + vec2u(1u))) {
    return;
  }
  let texel = vec2i(id.xy);
  let here = textureLoad(vel_src, texel, 0);
  // The faces this texel stores (the padding row of u and column of v repeat the last real one).
  let fu = vec2i(texel.x, min(texel.y, g.y - 1));
  let fv = vec2i(min(texel.x, g.x - 1), texel.y);
  let k = F.turbulence * F.turb_scale / FF_TAU * F.dt;
  let pu = ff_psi(vec2f(fu));
  let du = k * (ff_psi(vec2f(fu) + vec2f(0.0, 1.0)) - pu);
  let pv = ff_psi(vec2f(fv));
  let dv = -k * (ff_psi(vec2f(fv) + vec2f(1.0, 0.0)) - pv);
  textureStore(vel_dst, texel, vec4f(here.x + du, here.y + dv, 0.0, 0.0));
}
