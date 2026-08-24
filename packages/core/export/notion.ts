/**
 * Notion export (FR14/FR15): a note becomes a page payload of native Notion
 * blocks, with screenshots embedded as image blocks in place, not appended
 * after the text.
 *
 * Pure and IO-free: this builds the block JSON the Notion API expects, but
 * does not call the API and does not upload anything. Notion's image blocks
 * need either a public URL or a Notion-hosted `file_upload` id -- since our
 * screenshots are local blobs, the real flow is an async multi-step upload
 * (create upload -> POST the bytes -> reference the resulting id), which
 * has to happen as I/O in the extension layer *before* this function runs.
 * The caller resolves every screenshot the note references into a
 * `NotionImageRef` up front (an already-uploaded file_upload id, or an
 * external URL) and passes that resolution in as a synchronous lookup --
 * that's what keeps block-structure correctness testable here without a
 * network call, while the actual upload logic lives in
 * extension/app/notionExport.ts.
 */

import type { StructuredNote, Screenshot } from '../types';

export type NotionBlock = Record<string, unknown>;

export type NotionImageRef = { type: 'external'; url: string } | { type: 'file_upload'; id: string };

export interface NotionExportOptions {
  /** Resolves a screenshot to an already-uploaded (or externally hosted) image reference. */
  resolveImage: (screenshot: Screenshot) => NotionImageRef;
}

export interface NotionExportResult {
  /** Page title, for the caller to set via the Notion page-creation call. */
  title: string;
  children: NotionBlock[];
}

function heading2(text: string): NotionBlock {
  return richBlock('heading_2', text);
}

function paragraph(text: string): NotionBlock {
  return richBlock('paragraph', text);
}

function bullet(text: string): NotionBlock {
  return richBlock('bulleted_list_item', text);
}

function todo(text: string, checked = false): NotionBlock {
  return {
    object: 'block',
    type: 'to_do',
    to_do: { rich_text: [{ type: 'text', text: { content: text } }], checked },
  };
}

function richBlock(type: string, text: string): NotionBlock {
  return {
    object: 'block',
    type,
    [type]: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function image(ref: NotionImageRef): NotionBlock {
  return {
    object: 'block',
    type: 'image',
    image: ref.type === 'external' ? { type: 'external', external: { url: ref.url } } : { type: 'file_upload', file_upload: { id: ref.id } },
  };
}

export function exportNotion(
  note: StructuredNote,
  screenshots: Screenshot[],
  options: NotionExportOptions,
): NotionExportResult {
  const shotsById = new Map(screenshots.map((s) => [s.id, s]));
  const children: NotionBlock[] = [];

  children.push(paragraph(note.summary));

  if (note.decisions.length > 0) {
    children.push(heading2('Decisions'));
    for (const d of note.decisions) children.push(bullet(d.text));
  }

  if (note.actionItems.length > 0) {
    children.push(heading2('Action Items'));
    for (const a of note.actionItems) {
      children.push(todo(a.owner ? `${a.text} (${a.owner})` : a.text));
    }
  }

  if (note.openQuestions.length > 0) {
    children.push(heading2('Open Questions'));
    for (const q of note.openQuestions) children.push(bullet(q));
  }

  for (const section of note.sections) {
    children.push(heading2(section.heading));
    children.push(paragraph(section.body));
    for (const shotId of section.screenshotIds) {
      const shot = shotsById.get(shotId);
      if (!shot) continue;
      children.push(image(options.resolveImage(shot)));
    }
  }

  return { title: note.title, children };
}
