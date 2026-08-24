/**
 * Speaker attribution from two audio lanes (FR "best effort" diarization).
 *
 * We don't run a diarization model. Mic and tab audio are captured as
 * separate lanes purely for RMS energy metering (they're mixed into one
 * stream before reaching Whisper, so there's one transcription pass, not
 * two). Each transcript segment is attributed to whichever lane carried more
 * energy across that segment's time range: `me` if the mic lane dominated,
 * `them` if the tab lane did. This can't tell two remote participants apart,
 * but it gets the one distinction the PRD actually needs for free: whether a
 * decision or action item came from the user or from someone else.
 */

import type { LaneEnergyWindow, Speaker, TranscriptSegment } from '../types';

/** How much more energy one lane needs, as a share of total, to call it decisive. Below this, we don't guess. */
const DOMINANCE_MARGIN = 0.1;

export function attributeSpeaker(segment: Pick<TranscriptSegment, 'startMs' | 'endMs'>, windows: LaneEnergyWindow[]): Speaker {
  let mic = 0;
  let tab = 0;

  for (const w of windows) {
    const overlapMs = overlap(segment.startMs, segment.endMs, w.startMs, w.endMs);
    if (overlapMs <= 0) continue;
    mic += w.mic * overlapMs;
    tab += w.tab * overlapMs;
  }

  const total = mic + tab;
  if (total === 0) return 'unknown';

  const micShare = mic / total;
  if (micShare > 0.5 + DOMINANCE_MARGIN) return 'me';
  if (micShare < 0.5 - DOMINANCE_MARGIN) return 'them';
  return 'unknown';
}

/** Attributes every segment in place-equivalent fashion, returning new objects. */
export function attributeSegments(
  segments: TranscriptSegment[],
  windows: LaneEnergyWindow[],
): TranscriptSegment[] {
  return segments.map((seg) => ({ ...seg, speaker: attributeSpeaker(seg, windows) }));
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}
