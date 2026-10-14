// Bitonic sorting network on (key, value) pairs, ascending by key, in place (src/gpu/particles/sort.ts).
//
//   psort_block_sort     sorts every 512-element block completely in workgroup memory (45
//                        compare-exchange steps). Used for the first nine stages of the full sort,
//                        where the last stage's direction alternates per block (dir_bit = 512), and by
//                        the temporal sort, which sorts blocks ascending (dir_bit = 0) at offset 0 or 256
//   psort_bitonic_global one compare-exchange per invocation at distance j of a k-merge, for j >= 512
//   psort_block_merge    the rest of a k-merge (j = 256 .. 1) in workgroup memory
//
// So a sort of n = 2^m elements is 1 + sum over k = 1024 .. n of (log2(k) - 9 + 1) dispatches: 78 for
// 2^20 instead of the 210 of the plain network. Elements at or beyond `n` read as the largest key
// and are never written back, so a block may hang over the end of the array.

#include "sort-step.wgsl"

@group(0) @binding(0) var<uniform> pstep: PsortStep;
@group(0) @binding(1) var<storage, read_write> keys: array<u32>;
@group(0) @binding(2) var<storage, read_write> values: array<u32>;

const PSORT_BLOCK: u32 = 512u;

var<workgroup> psort_wg_keys: array<u32, 512>;
var<workgroup> psort_wg_values: array<u32, 512>;

fn psort_load(block_start: u32, lid: u32) {
  for (var h = 0u; h < 2u; h++) {
    let slot = lid + h * 256u;
    let i = block_start + slot;
    var k = 0xffffffffu;
    var v = 0xffffffffu;
    if (i < pstep.n) {
      k = keys[i];
      v = values[i];
    }
    psort_wg_keys[slot] = k;
    psort_wg_values[slot] = v;
  }
  workgroupBarrier();
}

fn psort_store(block_start: u32, lid: u32) {
  workgroupBarrier();
  for (var h = 0u; h < 2u; h++) {
    let slot = lid + h * 256u;
    let i = block_start + slot;
    if (i < pstep.n) {
      keys[i] = psort_wg_keys[slot];
      values[i] = psort_wg_values[slot];
    }
  }
}

// One compare-exchange of the in-block step (kk, jj) by invocation `lid` (256 pairs per step).
// `ascending` is the direction of the sequence the pair belongs to.
fn psort_exchange(lid: u32, jj: u32, ascending: bool) {
  let a = psort_pair_low(lid, jj);
  let b = a + jj;
  let ka = psort_wg_keys[a];
  let kb = psort_wg_keys[b];
  if ((ka > kb) == ascending && ka != kb) {
    psort_wg_keys[a] = kb;
    psort_wg_keys[b] = ka;
    let va = psort_wg_values[a];
    psort_wg_values[a] = psort_wg_values[b];
    psort_wg_values[b] = va;
  }
}

fn psort_pair_low(lid: u32, jj: u32) -> u32 {
  return 2u * jj * (lid / jj) + (lid % jj);
}

@compute @workgroup_size(256)
fn psort_block_sort(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let block_start = pstep.offset + wid.x * PSORT_BLOCK;
  psort_load(block_start, lid.x);
  for (var kk = 2u; kk <= PSORT_BLOCK; kk = kk << 1u) {
    for (var jj = kk >> 1u; jj > 0u; jj = jj >> 1u) {
      let low = psort_pair_low(lid.x, jj);
      var ascending = (low & kk) == 0u;
      if (kk == PSORT_BLOCK) {
        // The last stage: one direction for the whole block, alternating per block in the full
        // sort (so pairs of blocks form the bitonic sequences of the next stage).
        ascending = ((block_start + low) & pstep.dir_bit) == 0u;
      }
      psort_exchange(lid.x, jj, ascending);
      workgroupBarrier();
    }
  }
  psort_store(block_start, lid.x);
}

@compute @workgroup_size(256)
fn psort_bitonic_global(@builtin(global_invocation_id) gid: vec3u) {
  // Invocation t handles the pair (low, low + j); n / 2 invocations cover the array.
  let t = gid.x;
  let j = pstep.j;
  let low = 2u * j * (t / j) + (t % j);
  let high = low + j;
  if (high >= pstep.n) {
    return;
  }
  let ascending = (low & pstep.k) == 0u;
  let ka = keys[low];
  let kb = keys[high];
  if ((ka > kb) == ascending && ka != kb) {
    keys[low] = kb;
    keys[high] = ka;
    let va = values[low];
    values[low] = values[high];
    values[high] = va;
  }
}

@compute @workgroup_size(256)
fn psort_block_merge(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let block_start = wid.x * PSORT_BLOCK;
  psort_load(block_start, lid.x);
  // k >= 1024 > the block, so the direction is the same for the whole block.
  let ascending = (block_start & pstep.k) == 0u;
  for (var jj = PSORT_BLOCK >> 1u; jj > 0u; jj = jj >> 1u) {
    psort_exchange(lid.x, jj, ascending);
    workgroupBarrier();
  }
  psort_store(block_start, lid.x);
}
