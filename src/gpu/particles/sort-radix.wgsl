// One pass of the LSD radix sort (src/gpu/particles/sort.ts): a 4-bit digit, 16 bins, stable.
//
//   psort_histogram  each 1024-element tile counts its digits into hist[digit * tiles + tile]
//   (scan.wgsl)      exclusive prefix sum over hist: digit-major order makes hist[d * tiles + t]
//                    the number of elements with a smaller digit anywhere, plus those with digit d
//                    in earlier tiles, i.e. where tile t's first digit-d element goes
//   psort_scatter    each tile ranks its elements within the tile (stable: by position) and writes
//                    key and value to hist[d * tiles + t] + rank
//
// The in-tile rank is the part that needs care without subgroup operations. Each invocation holds
// four consecutive elements and counts them into 16 bins packed as 16-bit halves of 8 u32 (two
// vec4u). A Hillis-Steele scan of those packed counters across the 256 invocations gives, for
// every bin at once, how many of the tile's earlier elements share it: 8 steps of two vec4u adds,
// with no per-bin loop and no atomics. A bin of one tile holds at most 1024, which fits 16 bits.

#include "sort-step.wgsl"

@group(0) @binding(0) var<uniform> pstep: PsortStep;
@group(0) @binding(1) var<storage, read> keys_in: array<u32>;
@group(0) @binding(2) var<storage, read> values_in: array<u32>;
@group(0) @binding(3) var<storage, read_write> hist: array<u32>;
@group(0) @binding(4) var<storage, read_write> keys_out: array<u32>;
@group(0) @binding(5) var<storage, read_write> values_out: array<u32>;

const PSORT_BINS: u32 = 16u;

var<workgroup> psort_counts: array<atomic<u32>, 16>;
// Packed per-invocation bin counts: [lid * 2] holds bins 0..7, [lid * 2 + 1] bins 8..15, each u32
// carrying two bins (low half even, high half odd).
var<workgroup> psort_packed: array<vec4u, 512>;
var<workgroup> psort_tile_offset: array<u32, 16>;

fn psort_digit(key: u32) -> u32 {
  return (key >> pstep.shift) & 15u;
}

@compute @workgroup_size(256)
fn psort_histogram(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  if (lid.x < PSORT_BINS) {
    atomicStore(&psort_counts[lid.x], 0u);
  }
  workgroupBarrier();
  let base = wid.x * 1024u + lid.x * 4u;
  for (var e = 0u; e < 4u; e++) {
    if (base + e < pstep.count) {
      atomicAdd(&psort_counts[psort_digit(keys_in[base + e])], 1u);
    }
  }
  workgroupBarrier();
  if (lid.x < PSORT_BINS) {
    hist[lid.x * pstep.tiles + wid.x] = atomicLoad(&psort_counts[lid.x]);
  }
}

// Adds one to bin `d` of the packed counters.
fn psort_bump(lo: ptr<function, vec4u>, hi: ptr<function, vec4u>, d: u32) {
  let one = 1u << ((d & 1u) * 16u);
  let word = (d >> 1u) & 3u;
  if (d < 8u) {
    (*lo)[word] += one;
  } else {
    (*hi)[word] += one;
  }
}

fn psort_bin(lo: vec4u, hi: vec4u, d: u32) -> u32 {
  let word = (d >> 1u) & 3u;
  let packed = select(hi[word], lo[word], d < 8u);
  return (packed >> ((d & 1u) * 16u)) & 0xffffu;
}

@compute @workgroup_size(256)
fn psort_scatter(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let base = wid.x * 1024u + lid.x * 4u;
  var key: array<u32, 4>;
  var value: array<u32, 4>;
  var digit: array<u32, 4>;
  // Rank of each element among this invocation's own elements of the same digit.
  var local_rank: array<u32, 4>;
  var lo = vec4u(0u);
  var hi = vec4u(0u);
  for (var e = 0u; e < 4u; e++) {
    digit[e] = PSORT_BINS;
    if (base + e < pstep.count) {
      key[e] = keys_in[base + e];
      value[e] = values_in[base + e];
      digit[e] = psort_digit(key[e]);
      local_rank[e] = psort_bin(lo, hi, digit[e]);
      psort_bump(&lo, &hi, digit[e]);
    }
  }

  // Inclusive scan of the packed counters over the workgroup.
  psort_packed[lid.x * 2u] = lo;
  psort_packed[lid.x * 2u + 1u] = hi;
  workgroupBarrier();
  for (var offset = 1u; offset < 256u; offset = offset << 1u) {
    var a = psort_packed[lid.x * 2u];
    var b = psort_packed[lid.x * 2u + 1u];
    if (lid.x >= offset) {
      a += psort_packed[(lid.x - offset) * 2u];
      b += psort_packed[(lid.x - offset) * 2u + 1u];
    }
    workgroupBarrier();
    psort_packed[lid.x * 2u] = a;
    psort_packed[lid.x * 2u + 1u] = b;
    workgroupBarrier();
  }
  // Exclusive prefix: what the invocations before this one hold, per bin.
  let before_lo = psort_packed[lid.x * 2u] - lo;
  let before_hi = psort_packed[lid.x * 2u + 1u] - hi;

  if (lid.x < PSORT_BINS) {
    psort_tile_offset[lid.x] = hist[lid.x * pstep.tiles + wid.x];
  }
  workgroupBarrier();

  for (var e = 0u; e < 4u; e++) {
    let d = digit[e];
    if (d < PSORT_BINS) {
      let slot = psort_tile_offset[d] + psort_bin(before_lo, before_hi, d) + local_rank[e];
      keys_out[slot] = key[e];
      values_out[slot] = value[e];
    }
  }
}
