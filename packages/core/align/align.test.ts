import { describe, it, expect } from 'vitest';
import { alignScreenshots } from './align';
import type { Screenshot, TranscriptSegment } from '../types';

function seg(id: string, startMs: number, endMs: number): TranscriptSegment {
  return { id, sessionId: 's1', startMs, endMs, text: `segment ${id}`, speaker: 'them', chunkSeq: 0 };
}

function shot(id: string, timestampMs: number): Screenshot {
  return {
    id,
    sessionId: 's1',
    timestampMs,
    blobKey: `blob-${id}`,
    phash: '0'.repeat(16),
    diffScore: 64,
    width: 1280,
    height: 720,
    linkedSegmentId: null,
  };
}

describe('alignScreenshots', () => {
  // PRD Gherkin: transcript at 00:10, 00:45, 01:20; screenshot at 00:47 -> links to 00:45
  it('links to the nearest preceding segment (PRD example)', () => {
    const segments = [seg('a', 10_000, 20_000), seg('b', 45_000, 55_000), seg('c', 80_000, 90_000)];
    const [result] = alignScreenshots({ segments, screenshots: [shot('s', 47_000)] });
    expect(result!.linkedSegmentId).toBe('b');
  });

  it('links to null when the screenshot precedes every segment', () => {
    const segments = [seg('a', 10_000, 20_000)];
    const [result] = alignScreenshots({ segments, screenshots: [shot('s', 5_000)] });
    expect(result!.linkedSegmentId).toBeNull();
  });

  it('links a screenshot exactly at a segment start to that segment', () => {
    const segments = [seg('a', 10_000, 20_000), seg('b', 45_000, 55_000)];
    const [result] = alignScreenshots({ segments, screenshots: [shot('s', 45_000)] });
    expect(result!.linkedSegmentId).toBe('b');
  });

  it('links to the last segment when the screenshot is after everything', () => {
    const segments = [seg('a', 10_000, 20_000), seg('b', 45_000, 55_000)];
    const [result] = alignScreenshots({ segments, screenshots: [shot('s', 999_000)] });
    expect(result!.linkedSegmentId).toBe('b');
  });

  it('handles an empty segment list', () => {
    const [result] = alignScreenshots({ segments: [], screenshots: [shot('s', 1000)] });
    expect(result!.linkedSegmentId).toBeNull();
  });

  it('handles an empty screenshot list', () => {
    const segments = [seg('a', 10_000, 20_000)];
    expect(alignScreenshots({ segments, screenshots: [] })).toEqual([]);
  });

  it('aligns multiple screenshots independently', () => {
    const segments = [seg('a', 0, 10_000), seg('b', 20_000, 30_000), seg('c', 40_000, 50_000)];
    const shots = [shot('s1', 5_000), shot('s2', 25_000), shot('s3', 999_000)];
    const results = alignScreenshots({ segments, screenshots: shots });
    expect(results.map((r) => r.linkedSegmentId)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input screenshots or segments', () => {
    const segments = [seg('a', 10_000, 20_000)];
    const shots = [shot('s', 15_000)];
    const segmentsCopy = JSON.parse(JSON.stringify(segments));
    const shotsCopy = JSON.parse(JSON.stringify(shots));
    alignScreenshots({ segments, screenshots: shots });
    expect(segments).toEqual(segmentsCopy);
    expect(shots).toEqual(shotsCopy);
  });

  it('is correct regardless of input segment order (sorts internally)', () => {
    const segments = [seg('c', 80_000, 90_000), seg('a', 10_000, 20_000), seg('b', 45_000, 55_000)];
    const [result] = alignScreenshots({ segments, screenshots: [shot('s', 47_000)] });
    expect(result!.linkedSegmentId).toBe('b');
  });

  it('handles a large segment list without linear-scan-only correctness drift (binary search sanity)', () => {
    const segments = Array.from({ length: 500 }, (_, i) => seg(`seg${i}`, i * 1000, i * 1000 + 900));
    const [result] = alignScreenshots({ segments, screenshots: [shot('s', 250_500)] });
    expect(result!.linkedSegmentId).toBe('seg250');
  });
});
