/**
 * Service worker: session lifecycle orchestration and message routing only.
 *
 * Chrome can kill this worker at any time between events, so it holds no
 * session state that matters -- the offscreen document is the source of
 * truth for an in-progress capture, and IndexedDB (extension/shared/db.ts) is
 * the source of truth once anything is written. The only state kept here is
 * `chrome.storage.session`, which is scoped to the browser session and
 * rebuilt cheaply from a GET_STATUS round-trip to the offscreen document if
 * it's ever stale.
 *
 * `chrome.tabCapture.getMediaStreamId()` must be called from this
 * "foreground" extension context (a service worker triggered by a user
 * gesture on the action button), not from the offscreen document itself --
 * that's why capture setup happens here and only the resulting stream id
 * crosses into the offscreen document.
 */

import type { Platform, Session } from '@core/types';
import { newId } from '@shared/id';
import { putSession, getSession } from '@shared/db';
import type {
  PopupToSwMessage,
  StatusResponse,
  SwToOffscreenMessage,
  OffscreenToSwMessage,
  ContentToSwMessage,
  AppToSwMessage,
  RegenerateNoteResponse,
} from '@shared/messages';
import { finalizeSession } from './finalize';

const OFFSCREEN_URL = 'offscreen.html';

interface ActiveSession {
  sessionId: string;
  tabId: number;
  startedAt: number;
}

let active: ActiveSession | null = null;

/**
 * Message types this listener actually owns. `chrome.runtime.sendMessage`
 * broadcasts to every listening context in the extension, including the
 * sender's own -- so the service worker's own `sendMessage(startMsg)` call
 * to the offscreen document also arrives right back here. Without this
 * filter, this listener would fall through to a default case and call
 * `sendResponse(undefined)` for a message meant for someone else, and since
 * only one of possibly several responses to a broadcast actually reaches the
 * original caller, that spurious fast response can win the race against the
 * real one -- e.g. `startSession` reporting success before the offscreen
 * document has actually confirmed capture started. Anything not in this set
 * is left alone: no response is sent and the listener returns `false`,
 * so it never contends for the response channel that another context owns.
 */
const OWNED_MESSAGE_TYPES = new Set<string>([
  'START_SESSION',
  'STOP_SESSION',
  'GET_STATUS',
  'PRESENTATION_REGION_UPDATE',
  'OFFSCREEN_CAPTURE_ERROR',
  'OFFSCREEN_CAPTURE_STOPPED',
  'OFFSCREEN_CAPTURE_STARTED',
  'OFFSCREEN_FINALIZE_READY',
  'REGENERATE_NOTE',
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message?.type !== 'string' || !OWNED_MESSAGE_TYPES.has(message.type)) {
    return false;
  }
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err: unknown) => {
      console.error('[echonotes/sw] message handler failed', err);
      sendResponse({ type: 'STATUS', status: 'error', sessionId: null, startedAt: null, error: String(err) });
    });
  return true; // keep the message channel open for the async response
});

async function handleMessage(
  message: PopupToSwMessage | OffscreenToSwMessage | ContentToSwMessage | AppToSwMessage,
  sender: chrome.runtime.MessageSender,
): Promise<StatusResponse | RegenerateNoteResponse | void> {
  switch (message.type) {
    case 'START_SESSION':
      return startSession(message.tabId, message.platform);
    case 'STOP_SESSION':
      return stopSession();
    case 'GET_STATUS':
      return currentStatus();
    case 'OFFSCREEN_CAPTURE_ERROR':
      console.error('[echonotes/sw] offscreen capture error', message.message);
      active = null;
      return;
    case 'OFFSCREEN_CAPTURE_STOPPED':
    case 'OFFSCREEN_CAPTURE_STARTED':
      return; // informational; state already updated by the caller
    case 'OFFSCREEN_FINALIZE_READY':
      // The transcript is complete (or the drain wait timed out -- either
      // way, this is as complete as it's going to get). Finalization is
      // still fire-and-forget from here: it's a real LLM call, and nothing
      // is waiting on this message's response to unblock a UI action the
      // way STOP_SESSION's response unblocks the popup.
      void finalizeSession(message.sessionId).catch((err: unknown) => {
        console.error(`[echonotes/sw] finalization failed for session ${message.sessionId}`, err);
      });
      // Only close the document if no new session has started in it since
      // this one stopped -- ensureOffscreenDocument reuses an existing
      // document rather than creating a second one, so a quick stop/start
      // could otherwise have this signal arrive after a new capture is
      // already live in the very document about to be closed.
      if (!active) {
        await chrome.offscreen.closeDocument().catch(() => undefined);
      }
      return;
    case 'PRESENTATION_REGION_UPDATE':
      return forwardRegionToOffscreen(message, sender);
    case 'REGENERATE_NOTE': {
      const result = await finalizeSession(message.sessionId, message.instruction);
      return { type: 'REGENERATE_NOTE_RESULT', ok: result.ok, error: result.ok ? undefined : result.error };
    }
  }
}

async function startSession(tabId: number, platform: Platform): Promise<StatusResponse> {
  if (active) {
    return currentStatus();
  }

  const sessionId = newId('session');
  const startedAt = Date.now();

  const session: Session = {
    id: sessionId,
    title: `Meeting ${new Date(startedAt).toLocaleString()}`,
    platform,
    startedAt,
    endedAt: null,
    status: 'recording',
    error: undefined,
  };
  await putSession(session);

  try {
    const tabStreamId = await getMediaStreamId(tabId);
    await ensureOffscreenDocument();

    const startMsg: SwToOffscreenMessage = { type: 'OFFSCREEN_START_CAPTURE', sessionId, tabStreamId };
    await chrome.runtime.sendMessage(startMsg);

    active = { sessionId, tabId, startedAt };
    return currentStatus();
  } catch (err) {
    session.status = 'failed';
    session.error = String(err);
    await putSession(session);
    return { type: 'STATUS', status: 'error', sessionId: null, startedAt: null, error: String(err) };
  }
}

async function stopSession(): Promise<StatusResponse> {
  if (!active) return currentStatus();

  const stopMsg: SwToOffscreenMessage = { type: 'OFFSCREEN_STOP_CAPTURE' };
  await chrome.runtime.sendMessage(stopMsg).catch(() => undefined);

  const sessionId = active.sessionId;
  const session = await getSession(sessionId);
  if (session) {
    session.status = 'transcribing';
    session.endedAt = Date.now();
    await putSession(session);
  }

  active = null;
  // Deliberately not closing the offscreen document here. Closing
  // immediately would very likely cut off transcription of the last chunk or
  // two before it finishes -- OFFSCREEN_STOP_CAPTURE's response only means
  // capture itself stopped, not that the transcription queue it kicked off
  // has drained (see the comment on drainTranscriptionAndFinalize in
  // offscreen/index.ts). Finalizing a note without the last 30-60s of
  // transcript would routinely be missing whatever wrap-up, decisions, or
  // action items were said right before the user clicked "stop" -- often the
  // most important part of the meeting. The offscreen document reports
  // OFFSCREEN_FINALIZE_READY once its own queue is actually drained (or a
  // timeout gives up on it), and closing the document happens from this
  // service worker's handler for that message, above -- an offscreen
  // document can only use chrome.runtime, not chrome.offscreen, so it isn't
  // able to close itself.
  return currentStatus();
}

async function currentStatus(): Promise<StatusResponse> {
  if (!active) {
    return { type: 'STATUS', status: 'idle', sessionId: null, startedAt: null };
  }
  return { type: 'STATUS', status: 'recording', sessionId: active.sessionId, startedAt: active.startedAt };
}

async function forwardRegionToOffscreen(message: ContentToSwMessage, sender: chrome.runtime.MessageSender): Promise<void> {
  if (!active || sender.tab?.id !== active.tabId) return;
  // This re-broadcast also arrives back at this listener (see the
  // OWNED_MESSAGE_TYPES note above -- PRESENTATION_REGION_UPDATE is in that
  // set, since it's this function that owns handling it from the content
  // script). It doesn't re-forward in a loop only because a message this
  // service worker sends itself has no originating tab, so `sender.tab` is
  // undefined on that second receipt and the guard above rejects it. Don't
  // relax that guard to something that would stop excluding self-sent copies.
  await chrome.runtime.sendMessage(message).catch(() => undefined);
}

/** Promise wrapper -- @types/chrome only exposes the callback form for this API. */
function getMediaStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'tabCapture.getMediaStreamId returned no stream id'));
        return;
      }
      resolve(streamId);
    });
  });
}

async function ensureOffscreenDocument(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Capture and mix tab + microphone audio, sample and diff shared-screen frames, and run local Whisper inference for the duration of a meeting.',
  });
}

