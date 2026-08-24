import { describe, it, expect } from 'vitest';
import { buildNotePrompt } from './prompt';
import type { Screenshot, TranscriptSegment } from '../types';

function seg(id: string, startMs: number, text: string, speaker: TranscriptSegment['speaker'] = 'them'): TranscriptSegment {
  return { id, sessionId: 's1', startMs, endMs: startMs + 1000, text, speaker, chunkSeq: 0 };
}

function shot(id: string, timestampMs: number): Screenshot {
  return {
    id,
    sessionId: 's1',
    timestampMs,
    blobKey: `${id}.png`,
    phash: '0'.repeat(16),
    diffScore: 64,
    width: 1280,
    height: 720,
    linkedSegmentId: null,
  };
}

describe('buildNotePrompt', () => {
  it('instructs the model that every decision/action item needs a citation', () => {
    const { system } = buildNotePrompt({ segments: [], screenshots: [] });
    expect(system).toMatch(/citations/i);
    expect(system).toMatch(/do not invent/i);
  });

  it('interleaves transcript segments and screenshots in chronological order', () => {
    const segments = [seg('seg1', 0, 'Lets look at the roadmap'), seg('seg2', 5000, 'Any questions')];
    const screenshots = [shot('shot1', 2000)];
    const { user } = buildNotePrompt({ segments, screenshots });

    const seg1Idx = user.indexOf('(seg1)');
    const shot1Idx = user.indexOf('(shot1)');
    const seg2Idx = user.indexOf('(seg2)');
    expect(seg1Idx).toBeGreaterThanOrEqual(0);
    expect(shot1Idx).toBeGreaterThan(seg1Idx);
    expect(seg2Idx).toBeGreaterThan(shot1Idx);
  });

  it('labels speaker as Me / Them / Unknown', () => {
    const segments = [seg('a', 0, 'hi', 'me'), seg('b', 1000, 'hey', 'them'), seg('c', 2000, 'huh', 'unknown')];
    const { user } = buildNotePrompt({ segments, screenshots: [] });
    expect(user).toContain('Me: hi');
    expect(user).toContain('Them: hey');
    expect(user).toContain('Unknown: huh');
  });

  it('formats timestamps as mm:ss', () => {
    const segments = [seg('a', 65_000, 'late segment')];
    const { user } = buildNotePrompt({ segments, screenshots: [] });
    expect(user).toContain('[01:05]');
  });

  it('includes a custom instruction when provided (FR11)', () => {
    const { user } = buildNotePrompt({ segments: [], screenshots: [], instruction: 'focus on action items only' });
    expect(user).toContain('focus on action items only');
  });

  it('omits the instruction line entirely when not provided', () => {
    const { user } = buildNotePrompt({ segments: [], screenshots: [] });
    expect(user).not.toContain('Additional instruction');
  });

  it('includes the expected JSON schema shape in the user message', () => {
    const { user } = buildNotePrompt({ segments: [], screenshots: [] });
    expect(user).toContain('"decisions"');
    expect(user).toContain('"actionItems"');
    expect(user).toContain('"screenshotIds"');
  });

  it('handles an empty timeline without throwing', () => {
    expect(() => buildNotePrompt({ segments: [], screenshots: [] })).not.toThrow();
  });
});
