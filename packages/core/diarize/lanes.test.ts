import { describe, it, expect } from 'vitest';
import { attributeSpeaker, attributeSegments } from './lanes';
import type { LaneEnergyWindow, TranscriptSegment } from '../types';

function seg(startMs: number, endMs: number): TranscriptSegment {
  return { id: 'x', sessionId: 's', startMs, endMs, text: 'hi', speaker: 'unknown', chunkSeq: 0 };
}

function win(startMs: number, endMs: number, mic: number, tab: number): LaneEnergyWindow {
  return { startMs, endMs, mic, tab };
}

describe('attributeSpeaker', () => {
  it('attributes to "me" when the mic lane clearly dominates', () => {
    const windows = [win(0, 1000, 0.9, 0.05)];
    expect(attributeSpeaker(seg(0, 1000), windows)).toBe('me');
  });

  it('attributes to "them" when the tab lane clearly dominates', () => {
    const windows = [win(0, 1000, 0.05, 0.9)];
    expect(attributeSpeaker(seg(0, 1000), windows)).toBe('them');
  });

  it('returns "unknown" when both lanes are close (crosstalk / silence)', () => {
    const windows = [win(0, 1000, 0.5, 0.5)];
    expect(attributeSpeaker(seg(0, 1000), windows)).toBe('unknown');
  });

  it('returns "unknown" when there is no energy at all', () => {
    const windows = [win(0, 1000, 0, 0)];
    expect(attributeSpeaker(seg(0, 1000), windows)).toBe('unknown');
  });

  it('returns "unknown" when no window overlaps the segment', () => {
    const windows = [win(5000, 6000, 0.9, 0.05)];
    expect(attributeSpeaker(seg(0, 1000), windows)).toBe('unknown');
  });

  it('weighs windows by their overlap duration with the segment, not just presence', () => {
    // Segment spans 0-1000. Window A (mic-dominant) overlaps only 0-100ms.
    // Window B (tab-dominant) overlaps the remaining 900ms. Tab should win.
    const windows = [win(0, 100, 1.0, 0.0), win(100, 1000, 0.0, 1.0)];
    expect(attributeSpeaker(seg(0, 1000), windows)).toBe('them');
  });

  it('handles partial overlap at segment boundaries correctly', () => {
    // Window extends beyond the segment on both sides; only the intersection counts.
    const windows = [win(-500, 1500, 0.9, 0.05)];
    expect(attributeSpeaker(seg(0, 1000), windows)).toBe('me');
  });

  it('combines multiple overlapping windows by summed weighted energy', () => {
    const windows = [win(0, 500, 0.9, 0.1), win(500, 1000, 0.9, 0.1)];
    expect(attributeSpeaker(seg(0, 1000), windows)).toBe('me');
  });
});

describe('attributeSegments', () => {
  it('attributes each segment independently and returns new objects', () => {
    const segments = [seg(0, 1000), seg(1000, 2000)];
    const windows = [win(0, 1000, 0.9, 0.05), win(1000, 2000, 0.05, 0.9)];
    const result = attributeSegments(segments, windows);
    expect(result.map((s) => s.speaker)).toEqual(['me', 'them']);
    expect(segments[0]!.speaker).toBe('unknown'); // original untouched
  });

  it('handles an empty segment list', () => {
    expect(attributeSegments([], [win(0, 1000, 0.9, 0.1)])).toEqual([]);
  });
});
