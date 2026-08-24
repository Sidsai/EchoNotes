/**
 * Markdown/Obsidian export (FR13): writes packages/core/export/markdown.ts's
 * output to a real vault directory via the File System Access API.
 *
 * Must run from this app tab page, not the popup or service worker:
 * `showDirectoryPicker()` fails when called from an extension popup and only
 * works from a full tab -- one of the two constraints (along with mic/tab
 * mute-on-capture) called out as a trap in the plan. The vault handle is
 * picked once and persisted via IndexedDB structured clone (see
 * @shared/db's `handles` store) -- `chrome.storage.local` can't hold it,
 * since it JSON-serializes values and a directory handle isn't
 * JSON-serializable.
 *
 * Not exercised against a real vault from this environment -- see the
 * README's Verification section.
 */

import { getObsidianVaultHandle, putObsidianVaultHandle, getBlob } from '@shared/db';
import type { MarkdownExportResult } from '@core/export/markdown';

export class VaultAccessError extends Error {}

/** Opens the OS folder picker and persists the chosen vault for future sessions. */
export async function pickVault(): Promise<FileSystemDirectoryHandle> {
  // @ts-expect-error -- showDirectoryPicker isn't in every lib.dom version this project's TS targets, but is present in Chrome 122+.
  const handle: FileSystemDirectoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await putObsidianVaultHandle(handle);
  return handle;
}

/**
 * Returns the previously-picked vault handle, re-requesting permission if
 * needed (Chrome's persistent-permissions feature still requires an
 * explicit `requestPermission` call on each new page load, just not a fresh
 * picker dialog). Returns null if no vault has ever been picked.
 */
export async function getVaultHandle(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await getObsidianVaultHandle();
  if (!handle) return null;

  // @ts-expect-error -- queryPermission/requestPermission aren't in every lib.dom version this project's TS targets.
  const status: PermissionState = await handle.queryPermission({ mode: 'readwrite' });
  if (status === 'granted') return handle;

  // @ts-expect-error -- see above.
  const requested: PermissionState = await handle.requestPermission({ mode: 'readwrite' });
  return requested === 'granted' ? handle : null;
}

/**
 * Writes the Markdown file and its referenced images into the vault, under
 * `sessionId`'s own subdirectory of `imageDir` (as built by
 * packages/core/export/markdown.ts). Returns the path written, relative to
 * the vault root, for the ExportRecord's destinationRef.
 */
export async function writeMarkdownExport(
  vault: FileSystemDirectoryHandle,
  sessionId: string,
  result: MarkdownExportResult,
  fileBaseName: string,
): Promise<string> {
  const notePath = `${fileBaseName}.md`;
  await writeFile(vault, notePath, result.markdown);

  for (const image of result.images) {
    const blob = await getBlob(image.blobKey);
    if (!blob) {
      console.warn(`[echonotes/app] skipping missing screenshot blob for export: ${image.blobKey}`);
      continue;
    }
    await writeFile(vault, image.relativePath, blob);
  }

  return notePath;
}

async function writeFile(root: FileSystemDirectoryHandle, relativePath: string, content: string | Blob): Promise<void> {
  const segments = relativePath.split('/').filter(Boolean);
  const fileName = segments.pop();
  if (!fileName) throw new VaultAccessError(`invalid relative path: ${relativePath}`);

  let dir = root;
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }

  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}
