import { describe, it, expect } from 'vitest';
import { encodePcmToWav } from './wav';

async function header(blob: Blob): Promise<DataView> {
  const buf = await blob.arrayBuffer();
  return new DataView(buf);
}

describe('encodePcmToWav', () => {
  it('writes a valid RIFF/WAVE header', async () => {
    const blob = encodePcmToWav(new Float32Array([0, 0.5, -0.5]), 16000);
    const view = await header(blob);
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF');
    expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe('WAVE');
  });

  it('encodes mono 16-bit PCM at the given sample rate', async () => {
    const blob = encodePcmToWav(new Float32Array(10), 16000);
    const view = await header(blob);
    expect(view.getUint16(20, true)).toBe(1); // PCM format
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it('produces a data chunk sized for the number of samples', async () => {
    const pcm = new Float32Array(100);
    const blob = encodePcmToWav(pcm, 16000);
    const view = await header(blob);
    expect(view.getUint32(40, true)).toBe(100 * 2);
    expect(blob.size).toBe(44 + 100 * 2);
  });

  it('clamps out-of-range samples instead of wrapping', async () => {
    const blob = encodePcmToWav(new Float32Array([2, -2]), 16000);
    const view = await header(blob);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });

  it('handles an empty PCM buffer', async () => {
    const blob = encodePcmToWav(new Float32Array(0), 16000);
    expect(blob.size).toBe(44);
  });
});
