/**
 * Linear-interpolation resampling to 16kHz mono, the fixed input rate
 * Whisper requires. The offscreen document's AudioContext runs at whatever
 * native rate the system provides (commonly 48000Hz), so every chunk has to
 * pass through this before reaching the transcription provider.
 *
 * Linear interpolation, not a proper sinc-based resampler: it's fast,
 * synchronous, and dependency-free, at some cost to audio fidelity. That
 * trade-off matches the PRD's own framing for FR9 -- trade real-time
 * responsiveness for accuracy where needed -- and speech intelligibility
 * tolerates it far better than music would.
 */
export function resampleTo16kHz(pcm: Float32Array, sourceSampleRate: number): Float32Array {
  if (sourceSampleRate === 16000) return pcm;
  if (pcm.length === 0) return new Float32Array(0);

  const ratio = sourceSampleRate / 16000;
  const outLength = Math.max(1, Math.round(pcm.length / ratio));
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(pcm.length - 1, i0 + 1);
    const frac = srcPos - i0;
    out[i] = pcm[i0]! * (1 - frac) + pcm[i1]! * frac;
  }

  return out;
}
