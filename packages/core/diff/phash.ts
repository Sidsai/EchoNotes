/**
 * Perceptual hashing over raw pixel buffers.
 *
 * Pure functions over `Uint8ClampedArray` RGBA data -- no canvas, no DOM -- so
 * frame-diff behaviour can be tested from synthetic fixtures without a browser.
 *
 * The hash is the standard DCT pHash: greyscale, downscale to 32x32, 2D DCT-II,
 * keep the low-frequency 8x8 corner, and threshold each coefficient against the
 * median. Low-frequency-only comparison is what makes it robust to the
 * compression noise and minor antialiasing shifts of a video stream, which is
 * exactly what we get from a screen-shared tab.
 */

const DCT_SIZE = 32;
const HASH_SIDE = 8;

export interface Frame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Rec. 709 luma. Matches how a viewer perceives brightness. */
export function toGreyscale(frame: Frame): Float64Array {
  const { data, width, height } = frame;
  const out = new Float64Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.2126 * data[p]! + 0.7152 * data[p + 1]! + 0.0722 * data[p + 2]!;
  }
  return out;
}

/**
 * Box-filter downscale. Averaging every source pixel that falls in a target
 * cell (rather than sampling one of them) is what stops a one-pixel scroll or a
 * moving cursor from changing the result.
 */
export function downscale(
  src: Float64Array,
  width: number,
  height: number,
  size: number = DCT_SIZE,
): Float64Array {
  const out = new Float64Array(size * size);
  for (let ty = 0; ty < size; ty++) {
    const y0 = Math.floor((ty * height) / size);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / size));
    for (let tx = 0; tx < size; tx++) {
      const x0 = Math.floor((tx * width) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / size));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += src[y * width + x]!;
          count++;
        }
      }
      // count is always >= 1: y1/x1 are bounded below by y0+1/x0+1 above, so
      // the inner loop always runs at least once.
      out[ty * size + tx] = sum / count;
    }
  }
  return out;
}

const cosTable = (() => {
  const t = new Float64Array(DCT_SIZE * DCT_SIZE);
  for (let n = 0; n < DCT_SIZE; n++) {
    for (let k = 0; k < DCT_SIZE; k++) {
      t[n * DCT_SIZE + k] = Math.cos(((n + 0.5) * Math.PI * k) / DCT_SIZE);
    }
  }
  return t;
})();

/** Separable 2D DCT-II: rows, then columns. */
export function dct2d(input: Float64Array, size: number = DCT_SIZE): Float64Array {
  const rows = new Float64Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let k = 0; k < size; k++) {
      let sum = 0;
      for (let n = 0; n < size; n++) sum += input[y * size + n]! * cosTable[n * size + k]!;
      rows[y * size + k] = sum;
    }
  }
  const out = new Float64Array(size * size);
  for (let x = 0; x < size; x++) {
    for (let k = 0; k < size; k++) {
      let sum = 0;
      for (let n = 0; n < size; n++) sum += rows[n * size + x]! * cosTable[n * size + k]!;
      out[k * size + x] = sum;
    }
  }
  return out;
}

/**
 * Returns a 64-bit hash as 16 lowercase hex characters.
 *
 * The DC term at [0][0] is excluded from the median: it carries overall
 * brightness, which is orders of magnitude larger than the rest and would drag
 * the median far enough to flatten the hash.
 */
export function phash(frame: Frame): string {
  const grey = toGreyscale(frame);
  const small = downscale(grey, frame.width, frame.height);
  const freq = dct2d(small);

  const coefficients: number[] = [];
  for (let y = 0; y < HASH_SIDE; y++) {
    for (let x = 0; x < HASH_SIDE; x++) {
      coefficients.push(freq[y * DCT_SIZE + x]!);
    }
  }

  // HASH_SIDE*HASH_SIDE - 1 (DC excluded) is always odd, so the middle
  // element of the sorted list is always the exact median -- no even-length
  // averaging case exists through this call path.
  const forMedian = coefficients.slice(1).sort((a, b) => a - b);
  const median = forMedian[forMedian.length >> 1]!;

  let hex = '';
  for (let nibble = 0; nibble < 16; nibble++) {
    let value = 0;
    for (let bit = 0; bit < 4; bit++) {
      value = (value << 1) | (coefficients[nibble * 4 + bit]! > median ? 1 : 0);
    }
    hex += value.toString(16);
  }
  return hex;
}

const BIT_COUNT = new Uint8Array(16);
for (let i = 0; i < 16; i++) BIT_COUNT[i] = (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1);

/** Number of differing bits between two hashes, 0-64. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error(`hash length mismatch: ${a.length} vs ${b.length}`);
  }
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    total += BIT_COUNT[parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16)]!;
  }
  return total;
}
