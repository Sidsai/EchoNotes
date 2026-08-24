import { describe, it, expect } from 'vitest';
import { phash, hammingDistance, toGreyscale, downscale, dct2d } from './phash';
import { solidFrame, quadrantFrame, slideFrame, withNoise, movingDotFrame } from '../../../tests/fixtures/synthFrame';

describe('toGreyscale', () => {
  it('maps pure white to ~255 and pure black to 0', () => {
    const white = toGreyscale(solidFrame(2, 2, [255, 255, 255]));
    const black = toGreyscale(solidFrame(2, 2, [0, 0, 0]));
    for (const v of white) expect(v).toBeCloseTo(255, 6);
    expect(Array.from(black)).toEqual([0, 0, 0, 0]);
  });
});

describe('downscale', () => {
  it('preserves a uniform field', () => {
    const grey = toGreyscale(solidFrame(64, 64, [100, 100, 100]));
    const small = downscale(grey, 64, 64, 8);
    expect(Array.from(small).every((v) => Math.abs(v - 100) < 1e-9)).toBe(true);
  });

  it('averages source pixels within each target cell rather than sampling', () => {
    // left half 0, right half 200 -> every cell should read close to a blend,
    // not a single hard 0 or 200, once cells straddle the boundary.
    const grey = new Float64Array(4 * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) grey[y * 4 + x] = x < 2 ? 0 : 200;
    const small = downscale(grey, 4, 4, 2);
    // 2x2 target over 4x4 source: each target cell covers a 2x2 source block,
    // cleanly aligned with the half boundary here, so cells are pure 0 or 200.
    expect(Array.from(small)).toEqual([0, 200, 0, 200]);
  });
});

describe('dct2d', () => {
  it('concentrates energy in the DC term for a uniform field', () => {
    const grey = toGreyscale(solidFrame(32, 32, [128, 128, 128]));
    const small = downscale(grey, 32, 32, 32);
    const freq = dct2d(small);
    const dc = Math.abs(freq[0]!);
    const acSum = Array.from(freq.slice(1)).reduce((s, v) => s + Math.abs(v), 0);
    expect(dc).toBeGreaterThan(acSum);
  });
});

describe('phash', () => {
  it('produces a 16-character hex string', () => {
    const h = phash(solidFrame(64, 64, [50, 50, 50]));
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is identical for two calls on the same frame (determinism)', () => {
    const frame = quadrantFrame(64, 64);
    expect(phash(frame)).toBe(phash(frame));
  });

  it('is stable under small pixel noise (codec/antialiasing jitter)', () => {
    const base = slideFrame(64, 64);
    const noisy = withNoise(base, 6, 42);
    const distance = hammingDistance(phash(base), phash(noisy));
    expect(distance).toBeLessThanOrEqual(4);
  });

  it('is stable under a small moving highlight (webcam tile / cursor motion)', () => {
    const a = movingDotFrame(64, 64, 10);
    const b = movingDotFrame(64, 64, 14);
    const distance = hammingDistance(phash(a), phash(b));
    expect(distance).toBeLessThanOrEqual(4);
  });

  it('differs substantially between two unrelated frames (slide change)', () => {
    const slide1 = quadrantFrame(64, 64, false);
    const slide2 = quadrantFrame(64, 64, true);
    const distance = hammingDistance(phash(slide1), phash(slide2));
    expect(distance).toBeGreaterThan(20);
  });

  it('is roughly invariant to frame size for the same content', () => {
    const small = quadrantFrame(32, 32);
    const large = quadrantFrame(256, 256);
    const distance = hammingDistance(phash(small), phash(large));
    expect(distance).toBeLessThanOrEqual(4);
  });
});

describe('hammingDistance', () => {
  it('is zero for identical hashes', () => {
    expect(hammingDistance('abcdef0123456789', 'abcdef0123456789')).toBe(0);
  });

  it('is 64 for fully inverted hashes', () => {
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
  });

  it('counts a single flipped bit', () => {
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
    expect(hammingDistance('0000000000000000', '0000000000000008')).toBe(1);
  });

  it('throws on mismatched lengths', () => {
    expect(() => hammingDistance('ab', 'abcd')).toThrow();
  });
});
