// The per-dispatch uniform of the depth sort (src/gpu/particles/sort.ts). Every dispatch of one sort
// reads its own 256-byte slot of one buffer through a dynamic offset, so a sort of many passes
// needs one writeBuffer a frame. Field order must match `writeStep` in sort.ts.

struct PsortStep {
  // Elements to sort.
  count: u32,
  // Elements this dispatch covers: the padded power of two for bitonic, the count otherwise.
  n: u32,
  // Radix: the bit position of this pass's 4-bit digit.
  shift: u32,
  // Radix: 1024-element tiles, ceil(count / 1024).
  tiles: u32,
  // Bitonic: the size of the sequences being merged, and the compare distance.
  k: u32,
  j: u32,
  // Block sort: index of the first element of block 0 (0 or 256 in the temporal sort).
  offset: u32,
  // Block sort: the final stage sorts ascending where (index & dir_bit) == 0; 0 = all ascending.
  dir_bit: u32,
  _pad0: u32,
  _pad1: u32,
  // Keys: 32 or 16.
  key_bits: u32,
  // Keys: 1 = read the previous frame's order from `values` (temporal), 0 = start from identity.
  reuse_order: u32,
}
