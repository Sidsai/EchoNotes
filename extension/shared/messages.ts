/**
 * Typed message contracts between the four extension surfaces (popup,
 * service worker, offscreen document, content script). Chrome's messaging
 * API is untyped by default; centralizing the shapes here means a change to
 * one side's expectations is a compile error on the other, not a runtime
 * surprise discovered mid-meeting.
 */

import type { Platform, SessionStatus } from '@core/types';

// ---- Popup -> Service Worker ----

export interface StartSessionRequest {
  type: 'START_SESSION';
  tabId: number;
  platform: Platform;
}

export interface StopSessionRequest {
  type: 'STOP_SESSION';
}

export interface GetStatusRequest {
  type: 'GET_STATUS';
}

export type PopupToSwMessage = StartSessionRequest | StopSessionRequest | GetStatusRequest;

export interface StatusResponse {
  type: 'STATUS';
  status: 'idle' | 'recording' | 'error';
  sessionId: string | null;
  startedAt: number | null;
  error?: string;
}

// ---- Service Worker -> Offscreen Document ----

export interface OffscreenStartCapture {
  type: 'OFFSCREEN_START_CAPTURE';
  sessionId: string;
  /** From chrome.tabCapture.getMediaStreamId(), consumed via getUserMedia in the offscreen doc. */
  tabStreamId: string;
}

export interface OffscreenStopCapture {
  type: 'OFFSCREEN_STOP_CAPTURE';
}

export type SwToOffscreenMessage = OffscreenStartCapture | OffscreenStopCapture | PresentationRegionUpdate;

// ---- Offscreen Document -> Service Worker ----

export interface OffscreenCaptureStarted {
  type: 'OFFSCREEN_CAPTURE_STARTED';
  sessionId: string;
}

export interface OffscreenCaptureError {
  type: 'OFFSCREEN_CAPTURE_ERROR';
  sessionId: string;
  message: string;
}

export interface OffscreenCaptureStopped {
  type: 'OFFSCREEN_CAPTURE_STOPPED';
  sessionId: string;
}

/**
 * Sent once the offscreen document's transcription queue has actually
 * drained after a stop (or timed out waiting, see the cap in
 * offscreen/index.ts) -- distinct from OFFSCREEN_CAPTURE_STOPPED, which only
 * means capture itself stopped. This is the signal it's safe to run
 * finalization (alignment + the LLM call) without missing the last chunk or
 * two of transcript.
 */
export interface OffscreenFinalizeReady {
  type: 'OFFSCREEN_FINALIZE_READY';
  sessionId: string;
}

export type OffscreenToSwMessage = OffscreenCaptureStarted | OffscreenCaptureError | OffscreenCaptureStopped | OffscreenFinalizeReady;

// ---- Content Script -> Service Worker / Offscreen Document ----

export interface PresentationRegionUpdate {
  type: 'PRESENTATION_REGION_UPDATE';
  /** null when no shared-content element is currently present (audio-only mode). */
  region: { x: number; y: number; width: number; height: number } | null;
}

export type ContentToSwMessage = PresentationRegionUpdate;

// ---- App tab page -> Service Worker ----

export interface RegenerateNoteRequest {
  type: 'REGENERATE_NOTE';
  sessionId: string;
  /** Custom regeneration instruction (FR11), e.g. "focus on action items only". Omit to regenerate with the default prompt. */
  instruction?: string;
}

export type AppToSwMessage = RegenerateNoteRequest;

export interface RegenerateNoteResponse {
  type: 'REGENERATE_NOTE_RESULT';
  ok: boolean;
  error?: string;
}

// ---- Shared helper ----

export function isSessionActive(status: SessionStatus): boolean {
  return status === 'recording';
}
