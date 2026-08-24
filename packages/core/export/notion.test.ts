import { describe, it, expect } from 'vitest';
import { exportNotion, type NotionImageRef } from './notion';
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

function shot(id: string): Screenshot {
  return {
    id,
    sessionId: 'sess1',
    timestampMs: 1000,
    blobKey: `${id}.png`,
    phash: '0'.repeat(16),
    diffScore: 64,
    width: 1280,
    height: 720,
    linkedSegmentId: null,
  };
}

/** The real flow always resolves to file_upload -- screenshots are local blobs with no public URL. */
const resolveImage = (s: Screenshot): NotionImageRef => ({ type: 'file_upload', id: `upload-${s.id}` });

describe('exportNotion', () => {
  it('returns the note title separately from the block children', () => {
    const result = exportNotion(baseNote(), [], { resolveImage });
    expect(result.title).toBe('Q3 Planning Sync');
  });

  it('renders the summary as the first paragraph block', () => {
    const result = exportNotion(baseNote(), [], { resolveImage });
    expect(result.children[0]).toEqual({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: 'Team aligned on Q3 priorities.' } }] },
    });
  });

  it('renders decisions as a heading followed by bulleted items', () => {
    const note = baseNote({ decisions: [{ text: 'Ship by Friday', citations: [] }] });
    const result = exportNotion(note, [], { resolveImage });
    expect(result.children).toContainEqual(
      expect.objectContaining({ type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: 'Decisions' } }] } }),
    );
    expect(result.children).toContainEqual(expect.objectContaining({ type: 'bulleted_list_item' }));
  });

  it('omits the Decisions heading entirely when there are none', () => {
    const result = exportNotion(baseNote(), [], { resolveImage });
    const headings = result.children.filter((b) => b.type === 'heading_2');
    expect(headings.some((h: any) => h.heading_2.rich_text[0].text.content === 'Decisions')).toBe(false);
  });

  it('renders action items as unchecked to_do blocks, with owner appended when present', () => {
    const note = baseNote({
      actionItems: [
        { text: 'Write the RFC', owner: 'Sai', citations: [] },
        { text: 'Review PR', owner: null, citations: [] },
      ],
    });
    const result = exportNotion(note, [], { resolveImage });
    const todos = result.children.filter((b) => b.type === 'to_do');
    expect(todos).toHaveLength(2);
    expect((todos[0] as any).to_do.rich_text[0].text.content).toBe('Write the RFC (Sai)');
    expect((todos[0] as any).to_do.checked).toBe(false);
    expect((todos[1] as any).to_do.rich_text[0].text.content).toBe('Review PR');
  });

  it('renders open questions as bullets under their own heading', () => {
    const note = baseNote({ openQuestions: ['Who owns billing?'] });
    const result = exportNotion(note, [], { resolveImage });
    expect(result.children).toContainEqual(
      expect.objectContaining({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: 'Who owns billing?' } }] } }),
    );
  });

  it('places each section image block immediately after that section, not appended at the end', () => {
    const note = baseNote({
      sections: [
        { heading: 'Roadmap', body: 'body A', screenshotIds: ['s1'] },
        { heading: 'Budget', body: 'body B', screenshotIds: ['s2'] },
      ],
    });
    const result = exportNotion(note, [shot('s1'), shot('s2')], { resolveImage });
    const idx = result.children.map((b) => b.type);
    const roadmapIdx = idx.indexOf('heading_2');
    const roadmapImageIdx = result.children.findIndex(
      (b) => b.type === 'image' && (b as any).image.file_upload?.id === 'upload-s1',
    );
    const budgetHeadingIdx = idx.lastIndexOf('heading_2');
    expect(roadmapImageIdx).toBeGreaterThan(roadmapIdx);
    expect(roadmapImageIdx).toBeLessThan(budgetHeadingIdx);
  });

  it('builds a file_upload image block from a file_upload ref', () => {
    const note = baseNote({ sections: [{ heading: 'A', body: 'b', screenshotIds: ['s1'] }] });
    const result = exportNotion(note, [shot('s1')], { resolveImage: () => ({ type: 'file_upload', id: 'abc-123' }) });
    const img = result.children.find((b) => b.type === 'image');
    expect(img).toEqual({
      object: 'block',
      type: 'image',
      image: { type: 'file_upload', file_upload: { id: 'abc-123' } },
    });
  });

  it('builds an external image block from an external ref (fallback path)', () => {
    const note = baseNote({ sections: [{ heading: 'A', body: 'b', screenshotIds: ['s1'] }] });
    const result = exportNotion(note, [shot('s1')], { resolveImage: () => ({ type: 'external', url: 'https://custom/x.png' }) });
    const img = result.children.find((b) => b.type === 'image');
    expect(img).toEqual({
      object: 'block',
      type: 'image',
      image: { type: 'external', external: { url: 'https://custom/x.png' } },
    });
  });

  it('skips a screenshot reference with no matching Screenshot record', () => {
    const note = baseNote({ sections: [{ heading: 'A', body: 'b', screenshotIds: ['missing'] }] });
    const result = exportNotion(note, [], { resolveImage });
    expect(result.children.some((b) => b.type === 'image')).toBe(false);
  });

  it('does not perform any network IO -- returns pure block data', () => {
    const result = exportNotion(baseNote(), [], { resolveImage });
    expect(Array.isArray(result.children)).toBe(true);
  });
});
