/**
 * Orchestrates a full Notion export: uploads every screenshot the note
 * actually references (not every screenshot the session captured -- only
 * the ones the LLM chose to cite in a section), builds the block payload via
 * the pure packages/core/export/notion.ts, and creates the page. This is the
 * async-I/O layer that module's own header comment describes as living
 * outside it.
 */

import { exportNotion } from '@core/export/notion';
import type { Screenshot, StructuredNote } from '@core/types';
import { getBlob } from '@shared/db';
import { uploadImage, createNotionPage } from './notionClient';

export interface NotionExportInput {
  note: StructuredNote;
  screenshots: Screenshot[];
  apiKey: string;
  parentPageId: string;
}

/** Returns the created Notion page's URL. */
export async function exportToNotion(input: NotionExportInput): Promise<string> {
  const referencedIds = new Set(input.note.sections.flatMap((s) => s.screenshotIds));
  const referenced = input.screenshots.filter((s) => referencedIds.has(s.id));

  const uploaded = new Map<string, Awaited<ReturnType<typeof uploadImage>>>();
  for (const shot of referenced) {
    const blob = await getBlob(shot.blobKey);
    if (!blob) {
      console.warn(`[echonotes/app] skipping missing screenshot blob for Notion export: ${shot.blobKey}`);
      continue;
    }
    try {
      const ref = await uploadImage(blob, `${shot.id}.png`, input.apiKey);
      uploaded.set(shot.id, ref);
    } catch (err) {
      // One screenshot failing to upload shouldn't sink the whole export --
      // the resulting page is just missing that one image, not broken.
      console.warn(`[echonotes/app] failed to upload screenshot ${shot.id} to Notion; the page will be missing this image`, err);
    }
  }

  // Only screenshots that actually uploaded are passed through: exportNotion
  // looks up each section's screenshotIds against this list and silently
  // skips any id it can't find, which is exactly the behavior wanted for a
  // failed upload -- omit the image, don't emit a block pointing at nothing.
  const successfullyUploaded = input.screenshots.filter((s) => uploaded.has(s.id));

  const { title, children } = exportNotion(input.note, successfullyUploaded, {
    resolveImage: (shot) => uploaded.get(shot.id)!,
  });

  return createNotionPage({ parentPageId: input.parentPageId, title, children, apiKey: input.apiKey });
}
