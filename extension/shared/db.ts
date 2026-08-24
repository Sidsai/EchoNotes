/**
 * IndexedDB persistence layer, shared by the offscreen document (writer, live
 * during capture) and the app tab page (reader, for session review/export).
 *
 * Everything here is written incrementally as it is produced -- audio chunks,
 * screenshots, transcript segments -- never held only in memory, per FR6.
 * `unlimitedStorage` (declared in the manifest) is what makes it safe to keep
 * a full session's audio and images here rather than spilling to a
 * filesystem the extension doesn't have access to anyway.
 *
 * Crash recovery (FR6, the "companion app crashes mid-session" scenario)
 * falls out of this schema rather than needing separate machinery: any
 * session found in `recording` status on next open was interrupted, and
 * `findInterruptedSessions` is what the app tab page's recovery banner
 * queries.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AudioChunk, ExportRecord, Screenshot, Session, StructuredNote, TranscriptSegment } from '@core/types';

interface EchoNotesDB extends DBSchema {
  sessions: {
    key: string;
    value: Session;
    indexes: { 'by-status': Session['status']; 'by-startedAt': number };
  };
  transcriptSegments: {
    key: string;
    value: TranscriptSegment;
    indexes: { 'by-sessionId': string };
  };
  screenshots: {
    key: string;
    value: Screenshot;
    indexes: { 'by-sessionId': string };
  };
  audioChunks: {
    key: [string, number];
    value: AudioChunk;
    indexes: { 'by-sessionId': string };
  };
  structuredNotes: {
    key: string; // sessionId -- MVP keeps only the latest note per session
    value: StructuredNote;
  };
  exportRecords: {
    key: string;
    value: ExportRecord;
    indexes: { 'by-sessionId': string };
  };
  /** Raw bytes for audio chunks and screenshot images, keyed by blobKey. */
  blobs: {
    key: string;
    value: Blob;
  };
  /**
   * Structured-clone-only values that don't fit the domain model above --
   * currently just the Obsidian vault directory handle (FR13), keyed by a
   * fixed constant since there's only ever one. `chrome.storage.local`
   * can't hold this (see @shared/settings.ts); IndexedDB's structured clone
   * can.
   */
  handles: {
    key: string;
    value: FileSystemDirectoryHandle;
  };
}

export const OBSIDIAN_VAULT_HANDLE_KEY = 'obsidianVault';

const DB_NAME = 'echonotes';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<EchoNotesDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<EchoNotesDB>> {
  if (!dbPromise) {
    dbPromise = openDB<EchoNotesDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('by-status', 'status');
        sessions.createIndex('by-startedAt', 'startedAt');

        const segments = db.createObjectStore('transcriptSegments', { keyPath: 'id' });
        segments.createIndex('by-sessionId', 'sessionId');

        const shots = db.createObjectStore('screenshots', { keyPath: 'id' });
        shots.createIndex('by-sessionId', 'sessionId');

        const chunks = db.createObjectStore('audioChunks', { keyPath: ['sessionId', 'seq'] });
        chunks.createIndex('by-sessionId', 'sessionId');

        db.createObjectStore('structuredNotes', { keyPath: 'sessionId' });

        const exportsStore = db.createObjectStore('exportRecords', { keyPath: 'id' });
        exportsStore.createIndex('by-sessionId', 'sessionId');

        db.createObjectStore('blobs');
        db.createObjectStore('handles');
      },
    });
  }
  return dbPromise;
}

export async function putSession(session: Session): Promise<void> {
  const db = await getDb();
  await db.put('sessions', session);
}

export async function getSession(id: string): Promise<Session | undefined> {
  const db = await getDb();
  return db.get('sessions', id);
}

export async function listSessions(): Promise<Session[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex('sessions', 'by-startedAt');
  return all.reverse(); // most recent first
}

/** Sessions left in `recording` state -- interrupted by a crash, tab close, or Chrome killing the offscreen document. */
export async function findInterruptedSessions(): Promise<Session[]> {
  const db = await getDb();
  return db.getAllFromIndex('sessions', 'by-status', 'recording');
}

export async function putSegment(segment: TranscriptSegment): Promise<void> {
  const db = await getDb();
  await db.put('transcriptSegments', segment);
}

export async function getSegmentsForSession(sessionId: string): Promise<TranscriptSegment[]> {
  const db = await getDb();
  return db.getAllFromIndex('transcriptSegments', 'by-sessionId', sessionId);
}

export async function putScreenshot(screenshot: Screenshot, blob: Blob): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['screenshots', 'blobs'], 'readwrite');
  await Promise.all([
    tx.objectStore('screenshots').put(screenshot),
    tx.objectStore('blobs').put(blob, screenshot.blobKey),
    tx.done,
  ]);
}

export async function getScreenshotsForSession(sessionId: string): Promise<Screenshot[]> {
  const db = await getDb();
  return db.getAllFromIndex('screenshots', 'by-sessionId', sessionId);
}

export async function putAudioChunk(chunk: AudioChunk, blob: Blob, blobKey: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['audioChunks', 'blobs'], 'readwrite');
  await Promise.all([
    tx.objectStore('audioChunks').put(chunk),
    tx.objectStore('blobs').put(blob, blobKey),
    tx.done,
  ]);
}

export async function getAudioChunksForSession(sessionId: string): Promise<AudioChunk[]> {
  const db = await getDb();
  return db.getAllFromIndex('audioChunks', 'by-sessionId', sessionId);
}

/**
 * Flips an already-written chunk's `state` after transcription succeeds or
 * fails, without touching its blob. Used instead of a full re-`putAudioChunk`
 * so a transcription outcome can never accidentally overwrite the audio
 * bytes themselves -- this only ever updates the one field.
 */
export async function updateAudioChunkState(sessionId: string, seq: number, state: AudioChunk['state']): Promise<void> {
  const db = await getDb();
  const existing = await db.get('audioChunks', [sessionId, seq]);
  if (!existing) return; // chunk was never written (or session deleted); nothing to update
  existing.state = state;
  await db.put('audioChunks', existing);
}

export async function getBlob(blobKey: string): Promise<Blob | undefined> {
  const db = await getDb();
  return db.get('blobs', blobKey);
}

export async function putStructuredNote(note: StructuredNote): Promise<void> {
  const db = await getDb();
  await db.put('structuredNotes', note);
}

export async function getStructuredNote(sessionId: string): Promise<StructuredNote | undefined> {
  const db = await getDb();
  return db.get('structuredNotes', sessionId);
}

export async function putExportRecord(record: ExportRecord): Promise<void> {
  const db = await getDb();
  await db.put('exportRecords', record);
}

export async function getExportRecordsForSession(sessionId: string): Promise<ExportRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex('exportRecords', 'by-sessionId', sessionId);
}

export async function putObsidianVaultHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await getDb();
  await db.put('handles', handle, OBSIDIAN_VAULT_HANDLE_KEY);
}

export async function getObsidianVaultHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  const db = await getDb();
  return db.get('handles', OBSIDIAN_VAULT_HANDLE_KEY);
}

export async function deleteSession(sessionId: string): Promise<void> {
  const db = await getDb();
  const [segments, screenshots, chunks, exportRecords] = await Promise.all([
    db.getAllFromIndex('transcriptSegments', 'by-sessionId', sessionId),
    db.getAllFromIndex('screenshots', 'by-sessionId', sessionId),
    db.getAllFromIndex('audioChunks', 'by-sessionId', sessionId),
    db.getAllFromIndex('exportRecords', 'by-sessionId', sessionId),
  ]);

  const tx = db.transaction(
    ['sessions', 'transcriptSegments', 'screenshots', 'audioChunks', 'structuredNotes', 'exportRecords', 'blobs'],
    'readwrite',
  );
  const blobKeys = [...screenshots.map((s) => s.blobKey)];
  await Promise.all([
    tx.objectStore('sessions').delete(sessionId),
    ...segments.map((s) => tx.objectStore('transcriptSegments').delete(s.id)),
    ...screenshots.map((s) => tx.objectStore('screenshots').delete(s.id)),
    ...chunks.map((c) => tx.objectStore('audioChunks').delete([c.sessionId, c.seq])),
    ...exportRecords.map((e) => tx.objectStore('exportRecords').delete(e.id)),
    ...blobKeys.map((k) => tx.objectStore('blobs').delete(k)),
    tx.objectStore('structuredNotes').delete(sessionId),
    tx.done,
  ]);
}
