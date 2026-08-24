/**
 * Transcript-to-screenshot alignment (FR8): attach each saved screenshot to
 * the nearest *preceding* transcript segment.
 *
 * "Preceding" is deliberate, not incidental: a screenshot is captured after
 * whatever content triggered it appeared, so the segment that was being
 * spoken right before the screenshot is the one that's actually about the new
 * screen state -- attaching to whichever segment happens to start next would
 * often mean attaching to a sentence that hasn't been said yet.
 */

import type { Screenshot, TranscriptSegment } from '../types';

export interface AlignmentInput {
  segments: TranscriptSegment[];
  screenshots: Screenshot[];
}

/**
 * Returns new Screenshot objects with `linkedSegmentId` populated. Does not
 * mutate its inputs.
 *
 * A screenshot links to null only when no segment starts at or before it --
 * i.e. it was taken before anyone had said anything yet (a shared screen that
 * appears before the first word).
 */
export function alignScreenshots(input: AlignmentInput): Screenshot[] {
  const sorted = [...input.segments].sort((a, b) => a.startMs - b.startMs);

  return input.screenshots.map((shot) => {
    const linkedSegmentId = findPrecedingSegmentId(sorted, shot.timestampMs);
    return { ...shot, linkedSegmentId };
  });
}

/**
 * Binary search for the last segment whose startMs is <= timestampMs.
 * `segments` must already be sorted ascending by startMs.
 */
function findPrecedingSegmentId(segments: TranscriptSegment[], timestampMs: number): string | null {
  let lo = 0;
  let hi = segments.length - 1;
  let result: string | null = null;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid]!;
    if (seg.startMs <= timestampMs) {
      result = seg.id;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return result;
}
