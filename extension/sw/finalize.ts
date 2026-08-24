/**
 * Session finalization (M3): after capture ends, runs alignment, builds the
 * note-structuring prompt, calls Claude, validates the response against real
 * segment ids (dropping any hallucinated claim), and persists the result.
 * Also the entry point for FR11's regenerate-with-custom-instruction, since
 * that's the same pipeline minus re-running transcription.
 *
 * Runs in the service worker rather than the offscreen document: by the time
 * a session needs structuring, capture has already stopped and the offscreen
 * document is being torn down (see the M2 boundary note in
 * extension/offscreen/index.ts), and the LLM call needs `host_permissions`
 * for api.anthropic.com that only extension pages (not content scripts)
 * have. The known gap this creates -- a service worker killed by Chrome
 * mid-finalization leaves the session stuck in `structuring` with no retry
 * -- is the same class of gap as the M2 transcription-loss boundary, and is
 * called out in the README rather than silently accepted.
 */

import { alignScreenshots } from '@core/align/align';
import { buildNotePrompt } from '@core/note/prompt';
import { validateStructuredNote } from '@core/note/schema';
import {
  getSession,
  putSession,
  getSegmentsForSession,
  getScreenshotsForSession,
  putScreenshot,
  putStructuredNote,
  getBlob,
} from '@shared/db';
import { getSettings } from '@shared/settings';
import { callClaude, extractJson, LlmError } from './llm';

export type FinalizeOutcome = { ok: true } | { ok: false; error: string };

export async function finalizeSession(sessionId: string, instruction?: string): Promise<FinalizeOutcome> {
  const session = await getSession(sessionId);
  if (!session) return { ok: false, error: `session ${sessionId} not found` };

  try {
    session.status = 'structuring';
    await putSession(session);

    const [segments, screenshots] = await Promise.all([
      getSegmentsForSession(sessionId),
      getScreenshotsForSession(sessionId),
    ]);

    // FR8: link each screenshot to the transcript segment it followed.
    // Re-persisted so the app tab page's session review reads the same
    // linkage the note itself was built from.
    const aligned = alignScreenshots({ segments, screenshots });
    await Promise.all(
      aligned.map(async (shot) => {
        const blob = await getBlob(shot.blobKey);
        if (blob) await putScreenshot(shot, blob);
      }),
    );

    const settings = await getSettings();
    if (!settings.anthropicApiKey) {
      throw new Error('No Anthropic API key configured. Set one from the sessions page before generating notes.');
    }

    const { system, user } = buildNotePrompt({ segments, screenshots: aligned, instruction });
    const responseText = await callClaude({ system, user, apiKey: settings.anthropicApiKey });
    const raw = extractJson(responseText);

    const validSegmentIds = new Set(segments.map((s) => s.id));
    const { note, droppedClaims } = validateStructuredNote(raw, validSegmentIds);
    // Ensure the fields the LLM has no business setting are always correct,
    // regardless of what (if anything) it echoed back for them.
    note.sessionId = sessionId;
    note.generatedAt = Date.now();
    if (instruction) note.instruction = instruction;

    if (droppedClaims.length > 0) {
      // Per the PRD's Observability NFR: log what was dropped and why,
      // rather than silently presenting a thinner note with no explanation.
      console.warn(`[echonotes/sw] dropped ${droppedClaims.length} ungrounded claim(s) for session ${sessionId}:`, droppedClaims);
    }

    await putStructuredNote(note);

    session.status = 'ready';
    await putSession(session);
    return { ok: true };
  } catch (err) {
    const message = err instanceof LlmError ? err.message : String(err);
    session.status = 'failed';
    session.error = message;
    await putSession(session);
    return { ok: false, error: message };
  }
}
