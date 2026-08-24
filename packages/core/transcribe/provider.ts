/**
 * The seam behind Sai's extension-only decision.
 *
 * MVP ships one implementation -- Whisper-small via transformers.js/WebGPU in
 * the offscreen document -- accepting reduced accuracy versus a native
 * large-v3 model in exchange for zero install friction. This interface is
 * what keeps that swap-in-a-native-or-cloud-provider-later a one-file change
 * instead of a re-architecture: nothing outside `extension/offscreen` should
 * import a concrete provider directly.
 */

import type { Speaker } from '../types';

export interface TranscribeChunkInput {
  /** Mono PCM, 16kHz, as required by Whisper. */
  pcm: Float32Array;
  /** Offset of this chunk's start within the session, for absolute segment timestamps. */
  chunkStartMs: number;
}

export interface RawSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptionProvider {
  readonly id: string;
  /** Called once before the first chunk of a session; may warm up a model. */
  init(): Promise<void>;
  transcribeChunk(input: TranscribeChunkInput): Promise<RawSegment[]>;
  dispose(): Promise<void>;
}

/** Placeholder speaker until diarize/lanes.ts attributes it from lane energy. */
export const UNATTRIBUTED_SPEAKER: Speaker = 'unknown';
