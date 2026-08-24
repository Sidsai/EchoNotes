/**
 * The one TranscriptionProvider implementation MVP ships: Whisper-small,
 * running fully in-browser via transformers.js. This is the concrete side of
 * the seam described in packages/core/transcribe/provider.ts -- nothing
 * outside this file should import transformers.js directly, so swapping in a
 * native or cloud provider later stays a one-file change.
 *
 * Model weights are fetched from the Hugging Face CDN on first use and
 * cached under the extension's own origin thereafter (transformers.js's
 * default caching behavior) -- this is the one network dependency M2
 * introduces beyond the LLM/Notion calls the PRD's architecture already
 * accounts for, and it only fires once per install, not per session.
 *
 * Device selection: WebGPU when available (the whole reason extension-only
 * was viable at all -- see the pinned architecture memory), falling back to
 * WASM otherwise, per the plan's M2 scope ("whisper-small in offscreen via
 * WebGPU with a WASM fallback"). Neither path has been exercised against a
 * real model download or real audio in this environment -- see the README's
 * Verification section.
 */

import { pipeline, type AutomaticSpeechRecognitionPipeline, type DeviceType } from '@huggingface/transformers';
import type { RawSegment, TranscribeChunkInput, TranscriptionProvider } from '@core/transcribe/provider';

const MODEL_ID = 'onnx-community/whisper-small';

export class WhisperTranscriptionProvider implements TranscriptionProvider {
  readonly id = `whisper-small@${MODEL_ID}`;
  private pipe: AutomaticSpeechRecognitionPipeline | null = null;

  async init(): Promise<void> {
    const device = selectDevice();
    // TypeScript can't resolve `pipeline`'s task-keyed return-type overload
    // through an intermediate variable without blowing up its union budget
    // (TS2590) -- routing through `unknown` sidesteps that without losing
    // real type safety on the other side of the cast.
    const created: unknown = await pipeline('automatic-speech-recognition', MODEL_ID, { device });
    this.pipe = created as AutomaticSpeechRecognitionPipeline;
  }

  async transcribeChunk(input: TranscribeChunkInput): Promise<RawSegment[]> {
    if (!this.pipe) {
      throw new Error('WhisperTranscriptionProvider.transcribeChunk called before init() completed');
    }
    if (input.pcm.length === 0) return [];

    const output = await this.pipe(input.pcm, {
      return_timestamps: true,
      chunk_length_s: 30,
    });

    // The pipeline's TS types allow a single result or an array (for batched
    // input); we only ever pass one chunk's audio, so normalize to the
    // single-result shape rather than carrying the array case everywhere.
    const result = Array.isArray(output) ? output[0] : output;
    if (!result?.chunks || result.chunks.length === 0) {
      // No timestamped chunks came back (e.g. silence, or a model that
      // didn't honor return_timestamps) -- fall back to the whole-chunk
      // text as a single segment spanning the chunk, rather than losing it.
      const text = result?.text?.trim();
      if (!text) return [];
      return [{ startMs: input.chunkStartMs, endMs: input.chunkStartMs + estimateDurationMs(input.pcm), text }];
    }

    return result.chunks
      .filter((c) => c.text.trim().length > 0)
      .map((c) => ({
        startMs: input.chunkStartMs + c.timestamp[0] * 1000,
        endMs: input.chunkStartMs + c.timestamp[1] * 1000,
        text: c.text.trim(),
      }));
  }

  async dispose(): Promise<void> {
    await this.pipe?.dispose();
    this.pipe = null;
  }
}

function selectDevice(): DeviceType {
  const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
  return hasWebGpu ? 'webgpu' : 'wasm';
}

/** Input PCM is always 16kHz by the time it reaches this provider (see @shared/resample). */
function estimateDurationMs(pcm16kHz: Float32Array): number {
  return (pcm16kHz.length / 16000) * 1000;
}
