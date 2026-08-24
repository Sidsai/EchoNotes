import { describe, it, expect } from 'vitest';
import { validateStructuredNote } from './schema';

const validIds = new Set(['seg1', 'seg2', 'seg3']);

function rawNote(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    generatedAt: 12345,
    title: 'Sync',
    summary: 'We synced.',
    decisions: [],
    actionItems: [],
    openQuestions: [],
    sections: [],
    ...overrides,
  };
}

describe('validateStructuredNote', () => {
  it('keeps a decision that cites a real segment', () => {
    const raw = rawNote({ decisions: [{ text: 'Ship Friday', citations: ['seg1'] }] });
    const { note, droppedClaims } = validateStructuredNote(raw, validIds);
    expect(note.decisions).toEqual([{ text: 'Ship Friday', citations: ['seg1'] }]);
    expect(droppedClaims).toEqual([]);
  });

  it('drops a decision with no citations at all', () => {
    const raw = rawNote({ decisions: [{ text: 'Ship Friday', citations: [] }] });
    const { note, droppedClaims } = validateStructuredNote(raw, validIds);
    expect(note.decisions).toEqual([]);
    expect(droppedClaims[0]).toContain('Ship Friday');
  });

  it('drops a decision whose citation references a nonexistent segment (hallucinated citation)', () => {
    const raw = rawNote({ decisions: [{ text: 'Ship Friday', citations: ['seg-does-not-exist'] }] });
    const { note, droppedClaims } = validateStructuredNote(raw, validIds);
    expect(note.decisions).toEqual([]);
    expect(droppedClaims).toHaveLength(1);
  });

  it('keeps a decision if at least one of several citations is valid, filtering out the bad ones', () => {
    const raw = rawNote({ decisions: [{ text: 'Ship Friday', citations: ['seg1', 'seg-fake'] }] });
    const { note } = validateStructuredNote(raw, validIds);
    expect(note.decisions).toEqual([{ text: 'Ship Friday', citations: ['seg1'] }]);
  });

  it('applies the same grounding rule to action items, preserving owner', () => {
    const raw = rawNote({
      actionItems: [
        { text: 'Write RFC', owner: 'Sai', citations: ['seg2'] },
        { text: 'Made up task', owner: 'Nobody', citations: [] },
      ],
    });
    const { note, droppedClaims } = validateStructuredNote(raw, validIds);
    expect(note.actionItems).toEqual([{ text: 'Write RFC', owner: 'Sai', citations: ['seg2'] }]);
    expect(droppedClaims).toHaveLength(1);
    expect(droppedClaims[0]).toContain('Made up task');
  });

  it('passes through open questions and sections unchanged (no citation requirement)', () => {
    const raw = rawNote({
      openQuestions: ['Who owns billing?'],
      sections: [{ heading: 'A', body: 'b', screenshotIds: ['shot1'] }],
    });
    const { note } = validateStructuredNote(raw, validIds);
    expect(note.openQuestions).toEqual(['Who owns billing?']);
    expect(note.sections).toEqual([{ heading: 'A', body: 'b', screenshotIds: ['shot1'] }]);
  });

  it('defaults missing/malformed top-level fields rather than throwing', () => {
    const { note } = validateStructuredNote({}, validIds);
    expect(note.title).toBe('Untitled meeting');
    expect(note.summary).toBe('');
    expect(note.decisions).toEqual([]);
  });

  it('handles completely non-object input without throwing', () => {
    expect(() => validateStructuredNote(null, validIds)).not.toThrow();
    expect(() => validateStructuredNote(undefined, validIds)).not.toThrow();
    expect(() => validateStructuredNote('garbage', validIds)).not.toThrow();
    expect(() => validateStructuredNote(42, validIds)).not.toThrow();
  });

  it('ignores malformed entries within decisions/actionItems arrays rather than crashing', () => {
    const raw = rawNote({ decisions: [null, 'not-an-object', { text: 'Real one', citations: ['seg1'] }] });
    const { note } = validateStructuredNote(raw, validIds);
    expect(note.decisions).toEqual([{ text: 'Real one', citations: ['seg1'] }]);
  });

  it('carries through a custom instruction when present (FR11 regenerate)', () => {
    const raw = rawNote({ instruction: 'focus on action items only' });
    const { note } = validateStructuredNote(raw, validIds);
    expect(note.instruction).toBe('focus on action items only');
  });

  it('omits the instruction field when absent', () => {
    const { note } = validateStructuredNote(rawNote(), validIds);
    expect(note.instruction).toBeUndefined();
  });
});
