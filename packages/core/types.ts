/**
 * Domain model for EchoNotes.
 *
 * These types are deliberately free of any browser or Chrome API surface so
 * that the whole pipeline -- diffing, alignment, diarisation, note structuring
 * and export -- can be exercised from fixtures in a plain Node test run.
 */

export type Platform = 'meet' | 'teams' | 'unknown';

/**
 * `recording` is the only state that implies a live capture. A session found in
 * `recording` at startup was interrupted, and is what the recovery flow looks
 * for.
 */
export type SessionStatus =
  | 'recording'
  | 'transcribing'
  | 'structuring'
  | 'ready'
  | 'interrupted'
  | 'failed';

export interface Session {
  id: string;
  title: string;
  platform: Platform;
  startedAt: number;
  endedAt: number | null;
  status: SessionStatus;
  /** Set when status is `failed`, for display in the session list. */
  error?: string;
}

/** Which capture lane a sound arrived on. Drives speaker attribution. */
export type Lane = 'mic' | 'tab';

/**
 * `me` is the local user (mic lane), `them` is everyone else (tab lane). We do
 * not attempt to tell remote participants apart -- the PRD scopes diarisation
 * to best effort, and the two-lane split is the part we can do exactly.
 */
export type Speaker = 'me' | 'them' | 'unknown';

export interface TranscriptSegment {
  id: string;
  sessionId: string;
  startMs: number;
  endMs: number;
  text: string;
  speaker: Speaker;
  /** Index of the audio chunk this segment was decoded from. */
  chunkSeq: number;
}

export interface Screenshot {
  id: string;
  sessionId: string;
  timestampMs: number;
  /** Key into the blob store; not a filesystem path until export time. */
  blobKey: string;
  /** Perceptual hash of the cropped frame, as a 64-bit hex string. */
  phash: string;
  /** Hamming distance from the previously kept frame, 0-64. */
  diffScore: number;
  width: number;
  height: number;
  linkedSegmentId: string | null;
}

export type ChunkState = 'pending' | 'transcribed' | 'failed';

/**
 * Audio is persisted in chunks as it is captured, never held only in memory.
 * A chunk that is `pending` after a crash can simply be re-transcribed.
 */
export interface AudioChunk {
  sessionId: string;
  seq: number;
  startMs: number;
  endMs: number;
  state: ChunkState;
  /** Per-lane RMS energy over the chunk, sampled on a fixed grid. */
  laneEnergy: LaneEnergyWindow[];
}

export interface LaneEnergyWindow {
  startMs: number;
  endMs: number;
  mic: number;
  tab: number;
}

export interface ActionItem {
  text: string;
  owner: string | null;
  /** Segment ids backing this claim. Empty means unsupported -- drop it. */
  citations: string[];
}

export interface Decision {
  text: string;
  citations: string[];
}

export interface NoteSection {
  heading: string;
  body: string;
  screenshotIds: string[];
}

export interface StructuredNote {
  sessionId: string;
  generatedAt: number;
  title: string;
  summary: string;
  decisions: Decision[];
  actionItems: ActionItem[];
  openQuestions: string[];
  sections: NoteSection[];
  /** The instruction used, when regenerated with a custom one (FR11). */
  instruction?: string;
}

export type ExportFormat = 'markdown' | 'notion';

export interface ExportRecord {
  id: string;
  sessionId: string;
  format: ExportFormat;
  exportedAt: number;
  /** Vault path or Notion page URL. */
  destinationRef: string;
  status: 'ok' | 'failed';
  error?: string;
}
