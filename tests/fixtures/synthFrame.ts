/**
 * Synthetic-frame generators for diff/align tests. Avoids checking binary
 * fixtures into the repo for cases a few lines of pixel math can cover.
 */
import type { Frame } from '@core/diff/phash';

export function solidFrame(width: number, height: number, rgb: [number, number, number]): Frame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < data.length; p += 4) {
    data[p] = rgb[0];
    data[p + 1] = rgb[1];
    data[p + 2] = rgb[2];
    data[p + 3] = 255;
  }
  return { data, width, height };
}

/**
 * A 2x2 checkerboard of light/dark quadrants. Carries DCT energy in both the
 * horizontal and vertical low frequencies, unlike a one-axis split, so it's
 * used where the test wants a clean "definitely a different frame" signal.
 */
export function quadrantFrame(width: number, height: number, invert = false): Frame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const rightHalf = x >= width / 2;
      const bottomHalf = y >= height / 2;
      let light = rightHalf === bottomHalf;
      if (invert) light = !light;
      const v = light ? 230 : 25;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { data, width, height };
}

/**
 * A richer synthetic "slide": a diagonal gradient background with a handful
 * of rectangular blocks standing in for text/shapes. Real screen-shared
 * content -- rendered fonts, gradients, photos -- carries energy across most
 * of the low-frequency spectrum. A hard two- or four-tone block does not, and
 * produces a run of near-zero DCT coefficients whose sign is pure noise. This
 * fixture is what the noise- and motion-robustness tests exercise, since it's
 * representative of what the pHash detector actually sees in production.
 */
export function slideFrame(width: number, height: number, seed = 0): Frame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const gradient = ((x / width) * 0.6 + (y / height) * 0.4) * 180 + 30;
      data[p] = gradient;
      data[p + 1] = gradient;
      data[p + 2] = gradient;
      data[p + 3] = 255;
    }
  }
  const blocks: Array<[number, number, number, number, number]> = [
    [0.1, 0.15, 0.35, 0.08, 20],
    [0.1, 0.3, 0.5, 0.06, 235],
    [0.55, 0.15, 0.3, 0.3, 235],
    [0.1, 0.6 + seed * 0.05, 0.6, 0.1, 20],
  ];
  for (const [bx, by, bw, bh, v] of blocks) {
    const x0 = Math.floor(bx * width);
    const y0 = Math.floor(by * height);
    const x1 = Math.min(width, Math.floor((bx + bw) * width));
    const y1 = Math.min(height, Math.floor((by + bh) * height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * width + x) * 4;
        data[p] = v;
        data[p + 1] = v;
        data[p + 2] = v;
      }
    }
  }
  return { data, width, height };
}

/** Adds bounded random per-pixel noise, simulating codec/antialiasing jitter. */
export function withNoise(frame: Frame, amplitude: number, seed = 1): Frame {
  let s = seed;
  const rand = () => {
    // xorshift32 -- deterministic, no external dependency
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1000) / 1000;
  };
  const data = new Uint8ClampedArray(frame.data);
  for (let p = 0; p < data.length; p += 4) {
    for (let c = 0; c < 3; c++) {
      const delta = (rand() - 0.5) * 2 * amplitude;
      data[p + c] = Math.max(0, Math.min(255, data[p + c]! + delta));
    }
  }
  return { data, width: frame.width, height: frame.height };
}

/** A small mid-tone square moving slightly across an otherwise textured frame -- stands in for a webcam tile / cursor motion. */
export function movingDotFrame(width: number, height: number, xOffset: number): Frame {
  const frame = slideFrame(width, height);
  const dotSize = Math.max(2, Math.floor(width * 0.04));
  const y0 = Math.floor(height * 0.5);
  for (let dy = 0; dy < dotSize; dy++) {
    for (let dx = 0; dx < dotSize; dx++) {
      const x = xOffset + dx;
      const y = y0 + dy;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const p = (y * width + x) * 4;
      frame.data[p] = 128;
      frame.data[p + 1] = 128;
      frame.data[p + 2] = 128;
    }
  }
  return frame;
}
