/**
 * Markdown export (FR13/FR15): a note becomes a Markdown string plus a set of
 * image files to write alongside it, using relative paths so the result is an
 * Obsidian vault entry out of the box with no post-processing.
 *
 * Pure and IO-free by design: this returns data, the caller decides where to
 * write it (a real vault directory in production, an in-memory assertion in
 * tests). That split is what makes FR13-FR15 testable without a filesystem.
 */

import type { StructuredNote, Screenshot } from '../types';

export interface MarkdownExportResult {
  markdown: string;
  /** Relative path (e.g. "attachments/echonotes-<id>/shot-1.png") -> blob key to fetch. */
  images: Array<{ relativePath: string; blobKey: string }>;
}

export interface MarkdownExportOptions {
  /** Subdirectory (relative to the vault root) images are written under. */
  imageDir?: string;
}

export function exportMarkdown(
  note: StructuredNote,
  screenshots: Screenshot[],
  options: MarkdownExportOptions = {},
): MarkdownExportResult {
  const imageDir = options.imageDir ?? `attachments/${note.sessionId}`;
  const shotsById = new Map(screenshots.map((s) => [s.id, s]));
  const images: MarkdownExportResult['images'] = [];

  const relativePathFor = (shotId: string): string | null => {
    const shot = shotsById.get(shotId);
    if (!shot) return null;
    const ext = shot.blobKey.includes('.') ? shot.blobKey.slice(shot.blobKey.lastIndexOf('.')) : '.png';
    const relativePath = `${imageDir}/${shotId}${ext}`;
    images.push({ relativePath, blobKey: shot.blobKey });
    return relativePath;
  };

  const lines: string[] = [];
  lines.push(`# ${note.title}`);
  lines.push('');
  lines.push(note.summary);
  lines.push('');

  if (note.decisions.length > 0) {
    lines.push('## Decisions');
    for (const d of note.decisions) lines.push(`- ${d.text}`);
    lines.push('');
  }

  if (note.actionItems.length > 0) {
    lines.push('## Action Items');
    for (const a of note.actionItems) {
      lines.push(a.owner ? `- [ ] ${a.text} (${a.owner})` : `- [ ] ${a.text}`);
    }
    lines.push('');
  }

  if (note.openQuestions.length > 0) {
    lines.push('## Open Questions');
    for (const q of note.openQuestions) lines.push(`- ${q}`);
    lines.push('');
  }

  // Screenshots are embedded inline within each section, at the point they
  // were shown -- not collected at the bottom -- per FR15.
  for (const section of note.sections) {
    lines.push(`## ${section.heading}`);
    lines.push('');
    lines.push(section.body);
    for (const shotId of section.screenshotIds) {
      const relativePath = relativePathFor(shotId);
      if (relativePath) {
        lines.push('');
        lines.push(`![](${relativePath})`);
      }
    }
    lines.push('');
  }

  return { markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', images };
}
