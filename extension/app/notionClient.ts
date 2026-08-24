/**
 * Notion API client: the async upload I/O that packages/core/export/notion.ts
 * deliberately stays free of. Runs from the app tab page rather than the
 * service worker -- there's no reason it couldn't run in either, but export
 * is a user-initiated action from a page the user is already looking at, so
 * keeping it there means errors surface directly instead of needing another
 * message round-trip to report them.
 *
 * Not exercised against the real API from this environment -- see the
 * README's Verification section. Endpoint shapes are from Notion's own
 * uploading-small-files documentation, current as of research for this
 * build; if Notion's API has moved since, this is the first place to check.
 */

import type { NotionBlock, NotionImageRef } from '@core/export/notion';

const API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';

export class NotionApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'NotionApiError';
  }
}

function headers(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'notion-version': NOTION_VERSION,
    ...extra,
  };
}

async function notionFetch(path: string, apiKey: string, init: RequestInit & { headers?: Record<string, string> }): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...headers(apiKey, init.headers) },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new NotionApiError(`Notion API request to ${path} failed (${response.status}): ${body.slice(0, 500)}`, response.status);
  }
  return response.json();
}

/**
 * Uploads one image blob via Notion's small-file flow (create -> send bytes)
 * and returns a NotionImageRef ready for packages/core/export/notion.ts to
 * embed. Files above Notion's small-file limit (20MB) aren't handled here --
 * a single screenshot PNG is nowhere near that size, so the multi-part flow
 * for large files is out of scope.
 */
export async function uploadImage(blob: Blob, filename: string, apiKey: string): Promise<NotionImageRef> {
  const created = (await notionFetch('/file_uploads', apiKey, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename, content_type: blob.type || 'image/png' }),
  })) as { id?: string };

  if (!created.id) throw new NotionApiError('Notion file_uploads response contained no id');

  const form = new FormData();
  form.append('file', blob, filename);
  // No explicit content-type header here: the browser sets the multipart
  // boundary itself when given a FormData body, and overriding it manually
  // is a well-known way to corrupt the boundary.
  await notionFetch(`/file_uploads/${created.id}/send`, apiKey, {
    method: 'POST',
    body: form,
  });

  return { type: 'file_upload', id: created.id };
}

export interface CreatePageInput {
  /** Notion page id to create the new page under. */
  parentPageId: string;
  title: string;
  children: NotionBlock[];
  apiKey: string;
}

/**
 * Returns the created page's URL, for the ExportRecord's destinationRef.
 *
 * Known unhandled limit: Notion's create-page endpoint caps the `children`
 * array per request (100 blocks, per Notion's API documentation at the time
 * this was written). A note with many sections and screenshots could exceed
 * that; this function does not paginate into a create + multiple
 * append-children calls to handle it. A meeting with a typical number of
 * slides is very unlikely to hit this, but a very long, heavily-illustrated
 * session could -- if so, the Notion API will reject the request with a
 * validation error rather than silently truncating content.
 */
export async function createNotionPage(input: CreatePageInput): Promise<string> {
  const created = (await notionFetch('/pages', input.apiKey, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      parent: { page_id: input.parentPageId },
      properties: {
        title: { title: [{ type: 'text', text: { content: input.title } }] },
      },
      children: input.children,
    }),
  })) as { url?: string; id?: string };

  if (!created.url) throw new NotionApiError('Notion pages response contained no url');
  return created.url;
}
