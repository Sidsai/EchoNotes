import { describe, it, expect } from 'vitest';
import { resampleTo16kHz } from './resample';

describe('resampleTo16kHz', () => {
  it('returns the input unchanged when already at 16kHz', () => {
    const pcm = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleTo16kHz(pcm, 16000)).toBe(pcm);
  });

  it('halves the sample count when downsampling from 32kHz', () => {
    const pcm = new Float32Array(3200); // 0.1s at 32kHz
    const out = resampleTo16kHz(pcm, 32000);
    expect(out.length).toBe(1600); // 0.1s at 16kHz
  });

  it('downsamples 48kHz to roughly a third the length', () => {
    const pcm = new Float32Array(4800); // 0.1s at 48kHz
    const out = resampleTo16kHz(pcm, 48000);
    expect(out.length).toBe(1600);
  });

  it('preserves a constant signal', () => {
    const pcm = new Float32Array(4800).fill(0.5);
    const out = resampleTo16kHz(pcm, 48000);
    expect(Array.from(out).every((v) => Math.abs(v - 0.5) < 1e-9)).toBe(true);
  });

  it('interpolates linearly between two known points', () => {
    // 4 samples at 32kHz representing a straight ramp 0 -> 1; resampling to
    // 16kHz (2x downsample) should still trace the same ramp.
    const pcm = new Float32Array([0, 1 / 3, 2 / 3, 1]);
    const out = resampleTo16kHz(pcm, 32000);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(2 / 3, 5);
  });

  it('handles an empty buffer', () => {
    expect(resampleTo16kHz(new Float32Array(0), 48000).length).toBe(0);
  });

  it('never produces a zero-length output for a non-empty input', () => {
    const out = resampleTo16kHz(new Float32Array([0.5]), 48000);
    expect(out.length).toBeGreaterThanOrEqual(1);
  });
});
