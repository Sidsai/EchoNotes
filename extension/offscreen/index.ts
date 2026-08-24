/**
 * Capture engine, hosted in the offscreen document.
 *
 * This is the single long-lived owner of tab audio, mic audio, and (from M2
 * on) WebGPU inference and frame sampling -- see the architecture note in the
 * plan. The service worker only relays a `tabStreamId` here and otherwise
 * stays out of the way, since it can be killed by Chrome mid-session and this
 * document cannot.
 *
 * Two things this file exists specifically to get right, both called out as
 * traps in the design:
 *
 *   1. `chrome.tabCapture` mutes the tab for the user once captured. The tab
 *      audio source is explicitly re-connected to `context.destination` to
 *      restore playback -- skip that wiring and the meeting goes silent the
 *      moment recording starts.
 *   2. The mic source is captured for the mix and for lane-energy metering,
 *      but is deliberately never connected to `context.destination` -- doing
 *      so would let the user hear their own voice echoed back.
 *
 * Audio chunks are written to IndexedDB incrementally (~30s at a time) as
 * they are produced, never accumulated only in memory, per FR6.
 */

import { encodePcmToWav } from '@shared/wav';
import { resampleTo16kHz } from '@shared/resample';
import { putAudioChunk, updateAudioChunkState, putSegment, getSession, putSession } from '@shared/db';
import { newId } from '@shared/id';
import type { SwToOffscreenMessage, OffscreenToSwMessage } from '@shared/messages';
import type { AudioChunk, LaneEnergyWindow, TranscriptSegment } from '@core/types';
import { attributeSegments } from '@core/diarize/lanes';
import { FrameSampler } from './frameSampler';
import { WhisperTranscriptionProvider } from './whisperProvider';

const CHUNK_DURATION_MS = 30_000;
const ENERGY_WINDOW_MS = 250;
// ScriptProcessorNode is deprecated in favor of AudioWorkletNode; kept for
// MVP simplicity (no separate worklet module to load/build). Revisit if
// browsers start warning loudly enough to matter, or when chunk latency
// requirements tighten.
const PROCESSOR_BUFFER_SIZE = 4096;

interface CaptureState {
  sessionId: string;
  audioContext: AudioContext;
  tabStream: MediaStream;
  micStream: MediaStream;
  mixDestination: MediaStreamAudioDestinationNode;
  micProcessor: ScriptProcessorNode;
  tabProcessor: ScriptProcessorNode;
  mixProcessor: ScriptProcessorNode;
  frameSampler: FrameSampler;
  transcriber: WhisperTranscriptionProvider;
  /** Resolves once the model has finished loading; rejects if loading failed. Awaited by each chunk, not blocking capture itself. */
  transcriberReady: Promise<void>;
  /** Serializes transcribeChunk calls -- concurrent calls into the same pipeline instance are not known to be safe, so chunks are transcribed one at a time, in order. */
  transcriptionQueue: Promise<void>;
  chunkSeq: number;
  chunkSamples: number[];
  chunkStartMs: number;
  laneWindows: LaneEnergyWindow[];
  currentWindowStartMs: number;
  currentWindowMicSum: number;
  currentWindowTabSum: number;
  currentWindowSampleCount: number;
}

let capture: CaptureState | null = null;

/**
 * `chrome.runtime.sendMessage` broadcasts to every listening context,
 * including ones a message was never meant for -- GET_STATUS from the popup,
 * for instance, reaches this document too. Without filtering, this listener
 * would fall through to nothing matching, call `sendResponse(undefined)`
 * anyway, and race the service worker's real answer for the response channel
 * the popup is awaiting. Only the two message types this document actually
 * owns are handled; everything else is left alone (`return false`) so it
 * never contends for a response another context is responsible for.
 */
const OWNED_MESSAGE_TYPES = new Set<string>(['OFFSCREEN_START_CAPTURE', 'OFFSCREEN_STOP_CAPTURE', 'PRESENTATION_REGION_UPDATE']);

chrome.runtime.onMessage.addListener((message: SwToOffscreenMessage, _sender, sendResponse) => {
  if (typeof (message as { type?: unknown })?.type !== 'string' || !OWNED_MESSAGE_TYPES.has(message.type)) {
    return false;
  }
  handleMessage(message)
    .then(() => sendResponse())
    .catch((err: unknown) => {
      console.error('[echonotes/offscreen] failed to handle message', err);
      if (capture) {
        void reportError(capture.sessionId, String(err));
      }
    });
  return true;
});

async function handleMessage(message: SwToOffscreenMessage): Promise<void> {
  switch (message.type) {
    case 'OFFSCREEN_START_CAPTURE':
      await startCapture(message.sessionId, message.tabStreamId);
      return;
    case 'OFFSCREEN_STOP_CAPTURE':
      await stopCapture();
      return;
    case 'PRESENTATION_REGION_UPDATE':
      capture?.frameSampler.updateRegion(message.region);
      return;
  }
}

async function startCapture(sessionId: string, tabStreamId: string): Promise<void> {
  if (capture) {
    console.warn('[echonotes/offscreen] capture already in progress; ignoring duplicate start');
    return;
  }

  try {
    // Tab audio AND video: the stream id from chrome.tabCapture.getMediaStreamId()
    // is single-use and is consumed here, in the offscreen document, via the
    // chromeMediaSource constraint -- this is the one place that constraint
    // is legal to use, and both tracks have to be requested in this one call
    // since the id can't be reused for a second getUserMedia call later.
    // Video feeds the frame sampler (FR3-FR5); audio feeds the mix below.
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // @ts-expect-error -- chromeMediaSource/chromeMediaSourceId are a
        // Chrome-only constraint extension not present in lib.dom's types.
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: tabStreamId },
      },
      video: {
        // @ts-expect-error -- see above.
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: tabStreamId },
      },
    });

    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    const audioContext = new AudioContext();
    const tabSource = audioContext.createMediaStreamSource(tabStream);
    const micSource = audioContext.createMediaStreamSource(micStream);

    // Restore tab audio playback for the user -- tabCapture mutes the tab by
    // default once its audio track is captured.
    tabSource.connect(audioContext.destination);

    // Mix both lanes into one stream for a single Whisper pass (M2). Neither
    // source is connected to the destination a second time here; the mic is
    // never connected to the destination at all, to avoid echoing the user's
    // own voice back to them.
    const mixDestination = audioContext.createMediaStreamDestination();
    tabSource.connect(mixDestination);
    micSource.connect(mixDestination);

    const transcriber = new WhisperTranscriptionProvider();
    // Model loading (first-run download + WebGPU/WASM compilation) starts
    // immediately but is never awaited here -- capture must not be gated on
    // it. Each chunk awaits `transcriberReady` individually instead, so the
    // first chunk or two may wait on a slow first load while later ones
    // don't. The rejection is deliberately swallowed at the source and
    // logged once here; each chunk's own try/catch (see
    // transcribeAndPersistChunk) handles the already-rejected promise on
    // every subsequent await without re-logging per chunk.
    const transcriberReady = transcriber.init().catch((err: unknown) => {
      console.error('[echonotes/offscreen] whisper model failed to load; transcription will be unavailable for this session (audio is still captured)', err);
      throw err;
    });
    // A rejection nobody has awaited yet (e.g. the first chunk is still 30s
    // away) would otherwise surface as an unhandled-rejection console
    // warning. This no-op handler marks the promise "handled" for that
    // purpose without affecting the real awaits chunks perform on the same
    // `transcriberReady` reference later -- multiple handlers on one promise
    // are independent.
    transcriberReady.catch(() => undefined);

    const state: CaptureState = {
      sessionId,
      audioContext,
      tabStream,
      micStream,
      mixDestination,
      micProcessor: audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1),
      tabProcessor: audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1),
      mixProcessor: audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1),
      frameSampler: new FrameSampler(sessionId, tabStream),
      transcriber,
      transcriberReady,
      transcriptionQueue: Promise.resolve(),
      chunkSeq: 0,
      chunkSamples: [],
      chunkStartMs: 0,
      laneWindows: [],
      currentWindowStartMs: 0,
      currentWindowMicSum: 0,
      currentWindowTabSum: 0,
      currentWindowSampleCount: 0,
    };
    capture = state;

    // Lane energy metering: tap each source independently, before the mix,
    // so we can later tell which lane dominated a given transcript segment
    // (packages/core/diarize/lanes.ts). These processors do not connect
    // onward to the destination -- they exist purely to observe samples.
    micSource.connect(state.micProcessor);
    state.micProcessor.connect(silentSink(audioContext));
    tabSource.connect(state.tabProcessor);
    state.tabProcessor.connect(silentSink(audioContext));

    state.micProcessor.onaudioprocess = (e) => accumulateLaneEnergy(state, 'mic', e.inputBuffer.getChannelData(0));
    state.tabProcessor.onaudioprocess = (e) => accumulateLaneEnergy(state, 'tab', e.inputBuffer.getChannelData(0));

    // Mixed PCM for chunk storage.
    const mixSource = audioContext.createMediaStreamSource(mixDestination.stream);
    mixSource.connect(state.mixProcessor);
    state.mixProcessor.connect(silentSink(audioContext));
    state.chunkStartMs = performance.now();
    state.mixProcessor.onaudioprocess = (e) => {
      const samples = e.inputBuffer.getChannelData(0);
      state.chunkSamples.push(...samples);
      maybeFlushChunk(state, audioContext.sampleRate);
    };

    state.frameSampler.start();

    const response: OffscreenToSwMessage = { type: 'OFFSCREEN_CAPTURE_STARTED', sessionId };
    await chrome.runtime.sendMessage(response).catch(() => undefined);
  } catch (err) {
    await reportError(sessionId, String(err));
    capture = null;
  }
}

/**
 * A ScriptProcessorNode only fires onaudioprocess while connected into a live
 * audio graph reaching the destination (or an equivalent sink); we don't want
 * these metering taps audible, so they're routed to a zero-gain node instead
 * of the real destination.
 */
function silentSink(context: AudioContext): GainNode {
  const gain = context.createGain();
  gain.gain.value = 0;
  gain.connect(context.destination);
  return gain;
}

function accumulateLaneEnergy(state: CaptureState, lane: 'mic' | 'tab', samples: Float32Array): void {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i]! * samples[i]!;

  if (lane === 'mic') state.currentWindowMicSum += sumSquares;
  else state.currentWindowTabSum += sumSquares;
  state.currentWindowSampleCount += samples.length;

  const elapsedMs = performance.now() - state.currentWindowStartMs;
  if (elapsedMs >= ENERGY_WINDOW_MS) {
    const micRms = Math.sqrt(state.currentWindowMicSum / Math.max(1, state.currentWindowSampleCount));
    const tabRms = Math.sqrt(state.currentWindowTabSum / Math.max(1, state.currentWindowSampleCount));
    state.laneWindows.push({
      startMs: state.currentWindowStartMs,
      endMs: performance.now(),
      mic: micRms,
      tab: tabRms,
    });
    state.currentWindowStartMs = performance.now();
    state.currentWindowMicSum = 0;
    state.currentWindowTabSum = 0;
    state.currentWindowSampleCount = 0;
  }
}

function maybeFlushChunk(state: CaptureState, sampleRate: number): void {
  const elapsedMs = performance.now() - state.chunkStartMs;
  if (elapsedMs < CHUNK_DURATION_MS) return;
  void takeAndFlushChunk(state, sampleRate);
}

/**
 * Synchronously swaps `state.chunkSamples` (and the paired lane-energy
 * windows) out for a fresh empty array, then writes the swapped-out data to
 * IndexedDB asynchronously.
 *
 * The swap has to happen before any `await`: onaudioprocess keeps firing
 * while the IndexedDB write is in flight, and if it kept pushing onto the
 * same array that this function later resets to `[]` post-write, every
 * sample captured during that write would be silently discarded the moment
 * the reset ran -- real audio lost on every chunk boundary, not just on a
 * crash. Swapping the array reference first means new samples accumulate
 * into the fresh array with nothing to collide with.
 */
function takeAndFlushChunk(state: CaptureState, sampleRate: number, isFinal = false): Promise<void> {
  if (state.chunkSamples.length === 0 && !isFinal) return Promise.resolve();

  const pcm = new Float32Array(state.chunkSamples);
  const laneWindows = state.laneWindows;
  const chunkStartMs = state.chunkStartMs;
  const seq = state.chunkSeq++;

  state.chunkSamples = [];
  state.laneWindows = [];
  state.chunkStartMs = performance.now();

  const writePromise = writeChunk(state.sessionId, seq, pcm, laneWindows, chunkStartMs, sampleRate);

  // Transcription is chained onto the session's queue (never run concurrently
  // with another chunk -- see the field comment on transcriptionQueue) and
  // deliberately not awaited here: a slow or still-loading model must never
  // hold up the audio pipeline or the next chunk boundary. A rejection from
  // one chunk is swallowed before the next chunk's transcription chains on,
  // so one bad chunk doesn't take down transcription for the rest of the
  // session.
  state.transcriptionQueue = state.transcriptionQueue
    .catch(() => undefined)
    .then(() => transcribeAndPersistChunk(state, seq, pcm, laneWindows, chunkStartMs, sampleRate, writePromise));

  return writePromise;
}

async function writeChunk(
  sessionId: string,
  seq: number,
  pcm: Float32Array,
  laneWindows: LaneEnergyWindow[],
  chunkStartMs: number,
  sampleRate: number,
): Promise<void> {
  const blob = encodePcmToWav(pcm, sampleRate);
  const blobKey = `audio/${sessionId}/${seq}`;
  const endMs = chunkStartMs + (pcm.length / sampleRate) * 1000;

  const chunk: AudioChunk = {
    sessionId,
    seq,
    startMs: chunkStartMs,
    endMs,
    state: 'pending', // flipped to 'transcribed' or 'failed' by transcribeAndPersistChunk once it resolves
    laneEnergy: laneWindows,
  };

  await putAudioChunk(chunk, blob, blobKey);
}

/**
 * Transcribes one chunk (FR7/FR9) and persists the resulting segments,
 * attributed to a speaker via the chunk's own lane-energy windows
 * (packages/core/diarize/lanes.ts). Waits for the write of the raw audio
 * chunk to land first, so the AudioChunk row this updates the `state` field
 * of is guaranteed to already exist.
 *
 * Never throws outward: a transcription failure marks this one chunk
 * `failed` and moves on. The audio itself is already safe in IndexedDB
 * regardless of what happens here.
 */
async function transcribeAndPersistChunk(
  state: CaptureState,
  seq: number,
  pcm: Float32Array,
  laneWindows: LaneEnergyWindow[],
  chunkStartMs: number,
  sampleRate: number,
  writePromise: Promise<void>,
): Promise<void> {
  await writePromise.catch(() => undefined); // if the audio write itself failed, there's no row to update -- updateAudioChunkState no-ops safely either way

  try {
    await state.transcriberReady;
    const pcm16k = resampleTo16kHz(pcm, sampleRate);
    const rawSegments = await state.transcriber.transcribeChunk({ pcm: pcm16k, chunkStartMs });

    const segments: TranscriptSegment[] = rawSegments.map((r) => ({
      id: newId('seg'),
      sessionId: state.sessionId,
      startMs: r.startMs,
      endMs: r.endMs,
      text: r.text,
      speaker: 'unknown',
      chunkSeq: seq,
    }));
    const attributed = attributeSegments(segments, laneWindows);
    for (const segment of attributed) await putSegment(segment);

    await updateAudioChunkState(state.sessionId, seq, 'transcribed');
  } catch (err) {
    console.error(`[echonotes/offscreen] transcription failed for chunk ${seq}; audio is safe, this chunk's transcript will be missing`, err);
    await updateAudioChunkState(state.sessionId, seq, 'failed').catch(() => undefined);
  }
}

async function stopCapture(): Promise<void> {
  if (!capture) return;
  const state = capture;
  capture = null;

  await takeAndFlushChunk(state, state.audioContext.sampleRate, true);
  await state.frameSampler.stop();

  for (const track of [...state.tabStream.getTracks(), ...state.micStream.getTracks()]) track.stop();
  state.micProcessor.disconnect();
  state.tabProcessor.disconnect();
  state.mixProcessor.disconnect();
  await state.audioContext.close();

  // Session status on a normal stop is the service worker's job (it moves
  // the session to `transcribing`); this document only touches session
  // status when *it* is the one discovering something went wrong (see
  // reportError below).
  //
  // This response is what unblocks the service worker's stopSession(), which
  // is what unblocks the user's "Stop capture" click in the popup -- so it
  // has to go out now, before anything below that could take a while.
  const response: OffscreenToSwMessage = { type: 'OFFSCREEN_CAPTURE_STOPPED', sessionId: state.sessionId };
  await chrome.runtime.sendMessage(response).catch(() => undefined);

  // Everything from here runs in the background and is deliberately not
  // awaited by this function: capture has already stopped and its audio is
  // safe, and there is no UI action left waiting on transcription finishing
  // or the model disposing.
  void drainTranscriptionAndFinalize(state);
}

/** Capped wait for the transcription queue: a stuck inference call must not keep this document (and the model's GPU/WASM resources) alive indefinitely. */
const TRANSCRIPTION_DRAIN_TIMEOUT_MS = 120_000;

/**
 * Waits for whatever chunk(s) are still queued for transcription to actually
 * finish, then disposes the model and tells the service worker it's safe to
 * run finalization (alignment + the LLM call) and close this document.
 *
 * This exists specifically because finalizing before the last chunk's
 * transcript lands would routinely produce a note missing the final 30-60s
 * of the meeting -- often the wrap-up, decisions, and action items. If the
 * wait times out instead of draining cleanly, finalization proceeds anyway
 * with whatever transcript exists; that chunk's *audio* is always safe
 * regardless (written to IndexedDB before this function is ever reached),
 * only its transcript may end up missing. This is the documented boundary of
 * M2's scope -- FR9's "final full-pass reconciliation after the session
 * ends," which would retry any chunk still left in `pending` state, is not
 * yet implemented.
 *
 * Only `chrome.runtime` is available from inside an offscreen document, so
 * this can signal the service worker but cannot close the document itself --
 * `chrome.offscreen.closeDocument()` runs on the service worker's side, once
 * it receives OFFSCREEN_FINALIZE_READY.
 */
async function drainTranscriptionAndFinalize(state: CaptureState): Promise<void> {
  await Promise.race([
    state.transcriptionQueue.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, TRANSCRIPTION_DRAIN_TIMEOUT_MS)),
  ]);

  await state.transcriber.dispose().catch(() => undefined);

  const ready: OffscreenToSwMessage = { type: 'OFFSCREEN_FINALIZE_READY', sessionId: state.sessionId };
  await chrome.runtime.sendMessage(ready).catch(() => undefined);
}

async function reportError(sessionId: string, message: string): Promise<void> {
  const session = await getSession(sessionId);
  if (session) {
    session.status = 'failed';
    session.error = message;
    await putSession(session);
  }
  const response: OffscreenToSwMessage = { type: 'OFFSCREEN_CAPTURE_ERROR', sessionId, message };
  await chrome.runtime.sendMessage(response).catch(() => undefined);
}

// Deliberately no startup recovery pass here. This document is recreated for
// every ordinary session start (ensureOffscreenDocument runs each time,
// closeOffscreenDocumentIfIdle tears it down after each stop) -- and the
// service worker writes the new session's `recording` status *before*
// creating this document. A "mark stale `recording` sessions as interrupted"
// pass at module load would race the brand-new session's own record and
// could flip it to `interrupted` before capture even begins. Interrupted-
// session detection is a read-only concern instead, handled by the app tab
// page (extension/app/index.ts) querying `findInterruptedSessions` when it
// renders -- nothing here needs to mutate session state to make that work.
