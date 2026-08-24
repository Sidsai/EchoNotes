/**
 * Session list / review / export tab page. Loaded as a real extension tab
 * (never a popup), which matters because `showDirectoryPicker()` -- needed
 * for the Markdown/Obsidian export flow -- fails when called from an
 * extension popup and only works from a full tab or window.
 */

import {
  listSessions,
  findInterruptedSessions,
  getSession,
  getStructuredNote,
  getSegmentsForSession,
  getScreenshotsForSession,
  getBlob,
  putExportRecord,
  getExportRecordsForSession,
  deleteSession,
} from '@shared/db';
import { newId } from '@shared/id';
import { getSettings, setAnthropicApiKey, setNotionApiKey, setNotionParentPageId } from '@shared/settings';
import { exportMarkdown } from '@core/export/markdown';
import type { ExportRecord, Screenshot, Session, StructuredNote, TranscriptSegment } from '@core/types';
import { pickVault, getVaultHandle, writeMarkdownExport } from './obsidianExport';
import { exportToNotion } from './notionExport';
import type { RegenerateNoteRequest, RegenerateNoteResponse } from '@shared/messages';

// ---- Element refs ----

const listView = el('list-view');
const detailView = el('detail-view');
const listEl = el('session-list');
const emptyEl = el('empty-state');
const bannerEl = el('recovery-banner');

const settingsPanel = el('settings-panel');
const toggleSettingsButton = el('toggle-settings');
const anthropicKeyInput = el<HTMLInputElement>('anthropic-key-input');
const notionKeyInput = el<HTMLInputElement>('notion-key-input');
const notionParentInput = el<HTMLInputElement>('notion-parent-input');
const pickVaultButton = el('pick-vault-button');
const vaultStatusEl = el('vault-status');
const saveSettingsButton = el('save-settings-button');
const settingsSavedHint = el('settings-saved-hint');

const backButton = el('back-button');
const detailTitle = el('detail-title');
const detailMeta = el('detail-meta');
const detailStatusNote = el('detail-status-note');
const generateNoteButton = el('generate-note-button');
const noteViewEl = el('note-view');
const deleteSessionButton = el('delete-session-button');
const regenerateInstruction = el<HTMLTextAreaElement>('regenerate-instruction');
const regenerateButton = el('regenerate-button');
const regenerateStatus = el('regenerate-status');
const exportMarkdownButton = el('export-markdown-button');
const exportNotionButton = el('export-notion-button');
const exportStatus = el('export-status');
const rawTranscriptContent = el('raw-transcript-content');

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id} in app.html`);
  return found as T;
}

// ---- Object URL bookkeeping (screenshot <img> previews) ----

let activeObjectUrls: string[] = [];
function trackObjectUrl(url: string): string {
  activeObjectUrls.push(url);
  return url;
}
function revokeTrackedObjectUrls(): void {
  for (const url of activeObjectUrls) URL.revokeObjectURL(url);
  activeObjectUrls = [];
}

// ---- Settings panel ----

toggleSettingsButton.addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});

async function loadSettingsIntoForm(): Promise<void> {
  const settings = await getSettings();
  if (settings.anthropicApiKey) anthropicKeyInput.value = settings.anthropicApiKey;
  if (settings.notionApiKey) notionKeyInput.value = settings.notionApiKey;
  if (settings.notionParentPageId) notionParentInput.value = settings.notionParentPageId;
  await refreshVaultStatus();
}

async function refreshVaultStatus(): Promise<void> {
  const handle = await getVaultHandle();
  vaultStatusEl.textContent = handle ? `Vault: ${handle.name}` : 'No vault selected';
}

pickVaultButton.addEventListener('click', async () => {
  try {
    const handle = await pickVault();
    vaultStatusEl.textContent = `Vault: ${handle.name}`;
  } catch (err) {
    // The picker throws AbortError if the user just cancels the dialog -- not a real failure.
    if (err instanceof Error && err.name === 'AbortError') return;
    vaultStatusEl.textContent = `Failed to select vault: ${String(err)}`;
  }
});

saveSettingsButton.addEventListener('click', async () => {
  await Promise.all([
    setAnthropicApiKey(anthropicKeyInput.value.trim()),
    setNotionApiKey(notionKeyInput.value.trim()),
    setNotionParentPageId(notionParentInput.value.trim()),
  ]);
  settingsSavedHint.hidden = false;
  setTimeout(() => (settingsSavedHint.hidden = true), 2000);
});

// ---- List view ----

function formatDuration(startedAt: number, endedAt: number | null): string {
  const end = endedAt ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - startedAt) / 1000));
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${mm}m ${String(ss).padStart(2, '0')}s`;
}

function statusLabel(status: Session['status']): string {
  switch (status) {
    case 'recording':
      return 'Recording';
    case 'transcribing':
      return 'Transcribing';
    case 'structuring':
      return 'Structuring';
    case 'ready':
      return 'Ready';
    case 'interrupted':
      return 'Interrupted';
    case 'failed':
      return 'Failed';
  }
}

function platformLabel(platform: Session['platform']): string {
  return platform === 'meet' ? 'Google Meet' : platform === 'teams' ? 'Teams' : 'Unknown platform';
}

function renderSessionCard(session: Session): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'session-card';
  li.addEventListener('click', () => void showDetail(session.id));

  const info = document.createElement('div');
  const title = document.createElement('p');
  title.className = 'session-card__title';
  title.textContent = session.title;

  const meta = document.createElement('p');
  meta.className = 'session-card__meta';
  meta.textContent = `${new Date(session.startedAt).toLocaleString()} -- ${platformLabel(session.platform)} -- ${formatDuration(session.startedAt, session.endedAt)}`;

  info.append(title, meta);

  const status = document.createElement('span');
  status.className = 'session-card__status';
  status.dataset.status = session.status;
  status.textContent = statusLabel(session.status);

  li.append(info, status);
  return li;
}

async function renderList(): Promise<void> {
  const [sessions, interrupted] = await Promise.all([listSessions(), findInterruptedSessions()]);

  if (interrupted.length > 0) {
    bannerEl.hidden = false;
    bannerEl.textContent =
      interrupted.length === 1
        ? `1 session was interrupted before it finished. Its captured audio and screenshots are safe -- open it below.`
        : `${interrupted.length} sessions were interrupted before they finished. Their captured audio and screenshots are safe.`;
  } else {
    bannerEl.hidden = true;
  }

  listEl.innerHTML = '';
  if (sessions.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  for (const session of sessions) listEl.appendChild(renderSessionCard(session));
}

// ---- Detail view ----

let currentSessionId: string | null = null;

backButton.addEventListener('click', showList);

function showList(): void {
  currentSessionId = null;
  revokeTrackedObjectUrls();
  detailView.hidden = true;
  listView.hidden = false;
  void renderList();
}

async function showDetail(sessionId: string): Promise<void> {
  currentSessionId = sessionId;
  listView.hidden = true;
  detailView.hidden = false;
  regenerateStatus.textContent = '';
  exportStatus.textContent = '';
  regenerateInstruction.value = '';
  await renderDetail(sessionId);
}

async function renderDetail(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) {
    showList();
    return;
  }

  revokeTrackedObjectUrls();

  const [note, segments, screenshots, exportRecords] = await Promise.all([
    getStructuredNote(sessionId),
    getSegmentsForSession(sessionId),
    getScreenshotsForSession(sessionId),
    getExportRecordsForSession(sessionId),
  ]);

  // The LLM gives each note its own, usually more specific, title (e.g.
  // "Q1 Roadmap Review" vs. the generic "Meeting 8/24/2026, 11:00 PM" session
  // title) -- lead with that once it exists, since it's what the user
  // actually wants to recognize the session by, and fall back to the
  // session's own title before a note exists yet.
  detailTitle.textContent = note?.title || session.title;
  detailMeta.textContent = `${session.title} -- ${new Date(session.startedAt).toLocaleString()} -- ${platformLabel(session.platform)} -- ${formatDuration(session.startedAt, session.endedAt)} -- ${statusLabel(session.status)}`;

  if (session.status === 'failed' && session.error) {
    detailStatusNote.hidden = false;
    detailStatusNote.textContent = `Error: ${session.error}`;
  } else if (session.status === 'structuring' || session.status === 'transcribing') {
    detailStatusNote.hidden = false;
    detailStatusNote.textContent = 'Still processing -- reopen this session in a moment for the finished note.';
  } else if (session.status === 'interrupted') {
    detailStatusNote.hidden = false;
    detailStatusNote.textContent = 'This session was interrupted before it finished. Its captured audio and screenshots are safe -- generate a note from what was captured below.';
  } else {
    detailStatusNote.hidden = true;
  }

  // FR6/FR19: an interrupted or failed session still has its captured audio
  // and screenshots -- offer to run finalization (alignment + the LLM call)
  // against whatever was actually captured, same as a normal end-of-session
  // run, rather than leaving the session permanently note-less.
  const canGenerate = !note && (session.status === 'interrupted' || session.status === 'failed');
  generateNoteButton.hidden = !canGenerate;
  generateNoteButton.onclick = () => void handleRegenerate(sessionId);

  await renderNoteView(note, screenshots);
  renderTranscript(segments);
  renderExportStatus(exportRecords);

  exportMarkdownButton.onclick = () => void handleExportMarkdown(sessionId, note, screenshots);
  exportNotionButton.onclick = () => void handleExportNotion(sessionId, note, screenshots);
  regenerateButton.onclick = () => void handleRegenerate(sessionId);
  deleteSessionButton.onclick = () => void handleDelete(sessionId, session.title);
}

async function renderNoteView(note: StructuredNote | undefined, screenshots: Screenshot[]): Promise<void> {
  noteViewEl.innerHTML = '';
  if (!note) {
    const p = document.createElement('p');
    p.className = 'detail__status-note';
    p.textContent = 'No structured note yet.';
    noteViewEl.appendChild(p);
    return;
  }

  const shotsById = new Map(screenshots.map((s) => [s.id, s]));

  const summary = document.createElement('p');
  summary.textContent = note.summary;
  noteViewEl.appendChild(summary);

  addListSection('Decisions', note.decisions.map((d) => d.text));
  addListSection(
    'Action Items',
    note.actionItems.map((a) => (a.owner ? `${a.text} (${a.owner})` : a.text)),
  );
  addListSection('Open Questions', note.openQuestions);

  for (const section of note.sections) {
    const wrapper = document.createElement('div');
    wrapper.className = 'note-section';
    const heading = document.createElement('h3');
    heading.textContent = section.heading;
    wrapper.appendChild(heading);
    const body = document.createElement('p');
    body.textContent = section.body;
    wrapper.appendChild(body);

    for (const shotId of section.screenshotIds) {
      const shot = shotsById.get(shotId);
      if (!shot) continue;
      const blob = await getBlob(shot.blobKey);
      if (!blob) continue;
      const img = document.createElement('img');
      img.className = 'note-screenshot';
      img.src = trackObjectUrl(URL.createObjectURL(blob));
      img.alt = `Screenshot from ${section.heading}`;
      wrapper.appendChild(img);
    }

    noteViewEl.appendChild(wrapper);
  }

  function addListSection(heading: string, items: string[]): void {
    if (items.length === 0) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'note-section';
    const h = document.createElement('h3');
    h.textContent = heading;
    const ul = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    }
    wrapper.append(h, ul);
    noteViewEl.appendChild(wrapper);
  }
}

function renderTranscript(segments: TranscriptSegment[]): void {
  rawTranscriptContent.innerHTML = '';
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  if (sorted.length === 0) {
    rawTranscriptContent.textContent = 'No transcript yet.';
    return;
  }
  for (const seg of sorted) {
    const row = document.createElement('div');
    row.className = 'transcript-segment';
    const time = document.createElement('span');
    time.className = 'transcript-segment__time';
    time.textContent = formatTimestamp(seg.startMs);
    const speaker = document.createElement('span');
    speaker.className = 'transcript-segment__speaker';
    speaker.textContent = seg.speaker === 'me' ? 'Me:' : seg.speaker === 'them' ? 'Them:' : 'Unknown:';
    const text = document.createElement('span');
    text.textContent = seg.text;
    row.append(time, speaker, text);
    rawTranscriptContent.appendChild(row);
  }
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  return `[${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}]`;
}

function renderExportStatus(records: ExportRecord[]): void {
  if (records.length === 0) return;
  const latestByFormat = new Map<string, ExportRecord>();
  for (const r of records) latestByFormat.set(r.format, r);
  const parts = [...latestByFormat.values()].map((r) => `${r.format}: ${r.status} (${new Date(r.exportedAt).toLocaleString()})`);
  exportStatus.textContent = `Previous exports -- ${parts.join(', ')}`;
}

// ---- Regenerate (FR11) ----

async function handleRegenerate(sessionId: string): Promise<void> {
  regenerateButton.setAttribute('disabled', 'true');
  regenerateStatus.textContent = 'Regenerating…';
  try {
    const instruction = regenerateInstruction.value.trim() || undefined;
    const request: RegenerateNoteRequest = { type: 'REGENERATE_NOTE', sessionId, instruction };
    const response: RegenerateNoteResponse = await chrome.runtime.sendMessage(request);
    if (!response.ok) {
      regenerateStatus.textContent = `Failed: ${response.error ?? 'unknown error'}`;
      return;
    }
    regenerateStatus.textContent = 'Done.';
    await renderDetail(sessionId);
  } catch (err) {
    regenerateStatus.textContent = `Failed: ${String(err)}`;
  } finally {
    regenerateButton.removeAttribute('disabled');
  }
}

// ---- Export (FR13-FR16) ----

async function handleExportMarkdown(sessionId: string, note: StructuredNote | undefined, screenshots: Screenshot[]): Promise<void> {
  if (!note) {
    exportStatus.textContent = 'No structured note to export yet.';
    return;
  }
  exportStatus.textContent = 'Exporting to Markdown…';
  try {
    const vault = await getVaultHandle();
    if (!vault) {
      exportStatus.textContent = 'Choose a vault folder in Settings first.';
      return;
    }
    const result = exportMarkdown(note, screenshots);
    const fileBaseName = sanitizeFileName(note.title || sessionId);
    const path = await writeMarkdownExport(vault, sessionId, result, fileBaseName);

    const record: ExportRecord = {
      id: newId('export'),
      sessionId,
      format: 'markdown',
      exportedAt: Date.now(),
      destinationRef: path,
      status: 'ok',
    };
    await putExportRecord(record);
    exportStatus.textContent = `Exported to ${path} in your vault.`;
  } catch (err) {
    exportStatus.textContent = `Export failed: ${String(err)}`;
    await putExportRecord({
      id: newId('export'),
      sessionId,
      format: 'markdown',
      exportedAt: Date.now(),
      destinationRef: '',
      status: 'failed',
      error: String(err),
    });
  }
}

async function handleExportNotion(sessionId: string, note: StructuredNote | undefined, screenshots: Screenshot[]): Promise<void> {
  if (!note) {
    exportStatus.textContent = 'No structured note to export yet.';
    return;
  }
  exportStatus.textContent = 'Exporting to Notion…';
  try {
    const settings = await getSettings();
    if (!settings.notionApiKey || !settings.notionParentPageId) {
      exportStatus.textContent = 'Set your Notion API key and parent page id in Settings first.';
      return;
    }
    const url = await exportToNotion({
      note,
      screenshots,
      apiKey: settings.notionApiKey,
      parentPageId: settings.notionParentPageId,
    });

    const record: ExportRecord = {
      id: newId('export'),
      sessionId,
      format: 'notion',
      exportedAt: Date.now(),
      destinationRef: url,
      status: 'ok',
    };
    await putExportRecord(record);
    exportStatus.textContent = `Exported: ${url}`;
  } catch (err) {
    exportStatus.textContent = `Export failed: ${String(err)}`;
    await putExportRecord({
      id: newId('export'),
      sessionId,
      format: 'notion',
      exportedAt: Date.now(),
      destinationRef: '',
      status: 'failed',
      error: String(err),
    });
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').slice(0, 100) || 'echonotes-session';
}

// ---- Delete (FR18) ----

async function handleDelete(sessionId: string, title: string): Promise<void> {
  const confirmed = window.confirm(`Delete "${title}" and all its local audio, screenshots, and notes? This cannot be undone.`);
  if (!confirmed) return;
  await deleteSession(sessionId);
  showList();
}

// ---- Init ----

void loadSettingsIntoForm();
void renderList();
