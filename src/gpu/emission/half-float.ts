// IEEE 754 half floats, for filling `rgba16float` textures from JavaScript numbers. `Float16Array`
// would do this, but it is too recent to rely on in every browser the site supports.

const scratchFloat = new Float32Array(1);
const scratchBits = new Uint32Array(scratchFloat.buffer);

/** The 16-bit pattern nearest to `value` (round to nearest even; overflow gives infinity). */
export function toHalf(value: number): number {
  scratchFloat[0] = value;
  const bits = scratchBits[0] ?? 0;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;

  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0); // infinity or NaN
  const e = exponent - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // too large: infinity
  if (e <= 0) {
    if (e < -10) return sign; // too small even for a subnormal: zero
    // Subnormal half: shift the mantissa (with its hidden bit) into place.
    const full = mantissa | 0x800000;
    const shift = 14 - e;
    const half = full >>> shift;
    const remainder = full & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    return (
      sign | (remainder > halfway || (remainder === halfway && (half & 1) === 1) ? half + 1 : half)
    );
  }
  const half = (e << 10) | (mantissa >>> 13);
  const remainder = mantissa & 0x1fff;
  // A carry out of the mantissa rolls into the exponent, which is the right answer.
  return (
    sign | (remainder > 0x1000 || (remainder === 0x1000 && (half & 1) === 1) ? half + 1 : half)
  );
}

/** The number a 16-bit half-float pattern stands for. */
export function fromHalf(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exponent = (half >>> 10) & 0x1f;
  const mantissa = half & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa ? Number.NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/** Converts every element; the result is what `createTextureFromData` wants for `*16float`. */
export function toHalfArray(values: ArrayLike<number>): Uint16Array {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = toHalf(values[i] ?? 0);
  return out;
}
