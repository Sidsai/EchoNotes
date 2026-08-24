import { describe, it, expect } from 'vitest';
import { exportMarkdown } from './markdown';
import type { StructuredNote, Screenshot } from '../types';

function baseNote(overrides: Partial<StructuredNote> = {}): StructuredNote {
  return {
    sessionId: 'sess1',
    generatedAt: Date.now(),
    title: 'Q3 Planning Sync',
    summary: 'Team aligned on Q3 priorities.',
    decisions: [],
    actionItems: [],
    openQuestions: [],
    sections: [],
    ...overrides,
  };
}

function shot(id: string, blobKey = `${id}.png`): Screenshot {
  return {
    id,
    sessionId: 'sess1',
    timestampMs: 1000,
    blobKey,
    phash: '0'.repeat(16),
    diffScore: 64,
    width: 1280,
    height: 720,
    linkedSegmentId: null,
  };
}

describe('exportMarkdown', () => {
  it('renders title and summary', () => {
    const { markdown } = exportMarkdown(baseNote(), []);
    expect(markdown).toContain('# Q3 Planning Sync');
    expect(markdown).toContain('Team aligned on Q3 priorities.');
  });

  it('renders decisions as a bulleted list', () => {
    const note = baseNote({ decisions: [{ text: 'Ship by Friday', citations: ['seg1'] }] });
    const { markdown } = exportMarkdown(note, []);
    expect(markdown).toContain('## Decisions');
    expect(markdown).toContain('- Ship by Friday');
  });

  it('omits the Decisions section entirely when there are none', () => {
    const { markdown } = exportMarkdown(baseNote(), []);
    expect(markdown).not.toContain('## Decisions');
  });

  it('renders action items as checkboxes with owner when present', () => {
    const note = baseNote({
      actionItems: [
        { text: 'Write the RFC', owner: 'Sai', citations: [] },
        { text: 'Review PR', owner: null, citations: [] },
      ],
    });
    const { markdown } = exportMarkdown(note, []);
    expect(markdown).toContain('- [ ] Write the RFC (Sai)');
    expect(markdown).toContain('- [ ] Review PR');
    expect(markdown).not.toContain('Review PR (null)');
  });

  it('renders open questions', () => {
    const note = baseNote({ openQuestions: ['Who owns billing?'] });
    const { markdown } = exportMarkdown(note, []);
    expect(markdown).toContain('## Open Questions');
    expect(markdown).toContain('- Who owns billing?');
  });

  it('embeds screenshots inline within their section, not collected at the bottom', () => {
    const note = baseNote({
      sections: [
        { heading: 'Roadmap', body: 'We reviewed the roadmap slide.', screenshotIds: ['s1'] },
        { heading: 'Budget', body: 'Then budget numbers.', screenshotIds: ['s2'] },
      ],
    });
    const { markdown, images } = exportMarkdown(note, [shot('s1'), shot('s2')]);

    const roadmapIdx = markdown.indexOf('## Roadmap');
    const s1ImgIdx = markdown.indexOf('attachments/sess1/s1.png');
    const budgetIdx = markdown.indexOf('## Budget');
    const s2ImgIdx = markdown.indexOf('attachments/sess1/s2.png');

    // s1's image appears within the Roadmap section, before Budget starts.
    expect(roadmapIdx).toBeGreaterThanOrEqual(0);
    expect(s1ImgIdx).toBeGreaterThan(roadmapIdx);
    expect(s1ImgIdx).toBeLessThan(budgetIdx);
    // s2's image appears after Budget starts.
    expect(s2ImgIdx).toBeGreaterThan(budgetIdx);

    expect(images).toEqual([
      { relativePath: 'attachments/sess1/s1.png', blobKey: 's1.png' },
      { relativePath: 'attachments/sess1/s2.png', blobKey: 's2.png' },
    ]);
  });

  it('uses a relative image path under a per-session attachments directory by default', () => {
    const note = baseNote({ sections: [{ heading: 'A', body: 'b', screenshotIds: ['s1'] }] });
    const { images } = exportMarkdown(note, [shot('s1')]);
    expect(images[0]!.relativePath).toBe('attachments/sess1/s1.png');
  });

  it('respects a custom imageDir option', () => {
    const note = baseNote({ sections: [{ heading: 'A', body: 'b', screenshotIds: ['s1'] }] });
    const { images } = exportMarkdown(note, [shot('s1')], { imageDir: 'media' });
    expect(images[0]!.relativePath).toBe('media/s1.png');
  });

  it('skips a screenshot reference that has no matching Screenshot record', () => {
    const note = baseNote({ sections: [{ heading: 'A', body: 'b', screenshotIds: ['missing'] }] });
    const { markdown, images } = exportMarkdown(note, []);
    expect(images).toEqual([]);
    expect(markdown).not.toContain('![]');
  });

  it('preserves file extension from the blob key', () => {
    const note = baseNote({ sections: [{ heading: 'A', body: 'b', screenshotIds: ['s1'] }] });
    const { images } = exportMarkdown(note, [shot('s1', 'raw/s1.jpg')]);
    expect(images[0]!.relativePath).toBe('attachments/sess1/s1.jpg');
  });

  it('does not perform any IO -- returns pure data', () => {
    const result = exportMarkdown(baseNote(), []);
    expect(typeof result.markdown).toBe('string');
    expect(Array.isArray(result.images)).toBe(true);
  });

  it('never leaves 3+ consecutive blank lines', () => {
    const note = baseNote({ decisions: [{ text: 'x', citations: [] }] });
    const { markdown } = exportMarkdown(note, []);
    expect(markdown).not.toMatch(/\n{3,}/);
  });
});
