/**
 * API key storage. `chrome.storage.local`, not the OS keychain -- see the
 * README's Security note for why, and don't treat this as equivalent
 * protection. Centralized here so there's exactly one place that reads or
 * writes a key.
 *
 * The Obsidian vault directory handle deliberately does NOT live here.
 * `chrome.storage.local` serializes values as JSON internally, and a
 * `FileSystemDirectoryHandle` isn't JSON-serializable -- it would silently
 * fail to round-trip. IndexedDB uses structured clone instead, which does
 * support handles (confirmed against Chrome's own File System Access docs),
 * so the vault handle is stored via `@shared/db` alongside everything else
 * that needs structured-clone persistence.
 */

export interface Settings {
  anthropicApiKey: string | null;
  notionApiKey: string | null;
  /**
   * Notion's API cannot create a page at a workspace root -- every page
   * needs an explicit parent, and the integration has to be shared with
   * that parent page in Notion's own UI first (a one-time step outside this
   * extension). This is that parent page's id, set once from the sessions
   * page, the same way the Obsidian vault folder is picked once.
   */
  notionParentPageId: string | null;
}

const DEFAULTS: Settings = {
  anthropicApiKey: null,
  notionApiKey: null,
  notionParentPageId: null,
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return stored as Settings;
}

export async function setAnthropicApiKey(key: string): Promise<void> {
  await chrome.storage.local.set({ anthropicApiKey: key });
}

export async function setNotionApiKey(key: string): Promise<void> {
  await chrome.storage.local.set({ notionApiKey: key });
}

export async function setNotionParentPageId(pageId: string): Promise<void> {
  await chrome.storage.local.set({ notionParentPageId: pageId });
}
