/**
 * Frame sampler: periodically grabs a frame from the tab's video track,
 * crops it to the presentation region reported by the content script, diffs
 * it against the last kept frame via the shared pHash + debounce detector
 * (packages/core/diff), and persists a screenshot on capture decisions.
 * Implements FR3-FR5.
 *
 * FR4's threshold is described in the PRD as "configurable," without a
 * specific default value; DEFAULT_THRESHOLD below is a starting point to
 * tune once diff_scores from real sessions are logged, which is exactly the
 * PRD's own stated mitigation for getting this parameter wrong (see the
 * plan's Risks section).
 *
 * Known unverified assumption, flagged rather than silently assumed: the
 * region reported by the content script is in the *shared meeting tab's*
 * CSS-pixel viewport coordinates, and this maps it directly onto the
 * captured video frame's pixel coordinates. That assumes a 1:1 scale between
 * the tab's rendered viewport and the captured stream's native resolution.
 * If devicePixelRatio scaling turns out to matter in a real capture, this is
 * the file to fix (divide/multiply region coordinates by
 * `window.devicePixelRatio` as reported by the content script) -- it hasn't
 * been checked against a live tab capture.
 */

import { phash, hammingDistance, type Frame } from '@core/diff/phash';
import { ScreenshotChangeDetector, type DiffCandidate, type DiffOutcome } from '@core/diff/detector';
import { putScreenshot } from '@shared/db';
import { newId } from '@shared/id';
import type { Screenshot } from '@core/types';

export const SAMPLE_INTERVAL_MS = 500; // 2fps per FR3
export const DEFAULT_THRESHOLD = 14; // out of 64 -- see note above
export const DEFAULT_DEBOUNCE_MS = 3000; // FR5 default

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PendingFrame {
  candidate: DiffCandidate;
  imageData: ImageData;
}

export class FrameSampler {
  private readonly detector: ScreenshotChangeDetector;
  private readonly videoEl: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly encodeCanvas: HTMLCanvasElement;
  private readonly encodeCtx: CanvasRenderingContext2D;
  private timer: ReturnType<typeof setInterval> | null = null;
  private region: Region | null = null;
  private pendingFrame: PendingFrame | null = null;

  constructor(
    private readonly sessionId: string,
    tabStream: MediaStream,
  ) {
    this.detector = new ScreenshotChangeDetector({
      threshold: DEFAULT_THRESHOLD,
      debounceMs: DEFAULT_DEBOUNCE_MS,
      hammingDistance,
    });

    this.videoEl = document.createElement('video');
    this.videoEl.muted = true;
    this.videoEl.srcObject = tabStream;
    this.videoEl.play().catch((err: unknown) => console.warn('[echonotes/offscreen] video playback failed', err));

    this.canvas = document.createElement('canvas');
    this.ctx = requireContext(this.canvas);
    this.encodeCanvas = document.createElement('canvas');
    this.encodeCtx = requireContext(this.encodeCanvas);
  }

  /** Called whenever the content script reports the shared-content region has changed (relayed via the service worker). Null means audio-only mode. */
  updateRegion(region: Region | null): void {
    this.region = region;
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), SAMPLE_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;

    // Settle anything still pending so a share's final slide isn't lost
    // just because the session ended before another debounce window passed.
    const flushed = this.detector.flush(performance.now());
    if (flushed) await this.persistPending(flushed);

    this.videoEl.pause();
    this.videoEl.srcObject = null;
  }

  private tick(): void {
    const now = performance.now();

    if (this.region && this.videoEl.readyState >= this.videoEl.HAVE_CURRENT_DATA) {
      const grabbed = this.grabFrame(this.region);
      if (grabbed) {
        const frame: Frame = { data: grabbed.data, width: grabbed.width, height: grabbed.height };
        const candidate: DiffCandidate = { timestampMs: now, phash: phash(frame) };
        const outcome = this.detector.evaluate(candidate);
        this.handleOutcome(outcome, candidate, grabbed);
      }
    }

    // Always attempt to settle a quiet pending run, even on a tick with no
    // region (e.g. the share just ended) -- otherwise the last screenshot of
    // an ended share could sit pending forever with nothing left to notice
    // it has gone quiet.
    const flushed = this.detector.flush(now);
    if (flushed) void this.persistPending(flushed);
  }

  private handleOutcome(outcome: DiffOutcome, currentCandidate: DiffCandidate, currentFrame: ImageData): void {
    switch (outcome.kind) {
      case 'skipped':
        this.pendingFrame = null;
        return;
      case 'pending':
        this.pendingFrame = { candidate: currentCandidate, imageData: currentFrame };
        return;
      case 'capture':
        if (outcome.candidate.timestampMs === currentCandidate.timestampMs) {
          // Baseline capture, or an immediate qualifying change with nothing
          // previously pending: this tick's own frame is what's being kept.
          void this.persist(outcome.candidate, outcome.diffScore, currentFrame);
          this.pendingFrame = null;
        } else {
          // evaluate() settled an older stale run to make room for this
          // tick's new one -- persist the cached frame from when that older
          // candidate was actually sampled, not this tick's frame.
          void this.persistPending(outcome);
          this.pendingFrame = { candidate: currentCandidate, imageData: currentFrame };
        }
        return;
    }
  }

  private async persistPending(outcome: { candidate: DiffCandidate; diffScore: number }): Promise<void> {
    const pending = this.pendingFrame;
    this.pendingFrame = null;
    if (!pending) {
      console.warn('[echonotes/offscreen] detector reported a settle with no cached pending frame; dropping');
      return;
    }
    await this.persist(outcome.candidate, outcome.diffScore, pending.imageData);
  }

  private grabFrame(region: Region): ImageData | null {
    const vw = this.videoEl.videoWidth;
    const vh = this.videoEl.videoHeight;
    if (vw === 0 || vh === 0) return null;

    const width = Math.max(1, Math.round(region.width));
    const height = Math.max(1, Math.round(region.height));
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.drawImage(this.videoEl, region.x, region.y, width, height, 0, 0, width, height);
    return this.ctx.getImageData(0, 0, width, height);
  }

  private async persist(candidate: DiffCandidate, diffScore: number, imageData: ImageData): Promise<void> {
    const blob = await this.encodeToPng(imageData);
    const id = newId('shot');
    const screenshot: Screenshot = {
      id,
      sessionId: this.sessionId,
      timestampMs: candidate.timestampMs,
      blobKey: `screenshots/${this.sessionId}/${id}.png`,
      phash: candidate.phash,
      diffScore,
      width: imageData.width,
      height: imageData.height,
      linkedSegmentId: null, // alignment (FR8) runs after transcription, see M3
    };
    await putScreenshot(screenshot, blob);
  }

  private encodeToPng(imageData: ImageData): Promise<Blob> {
    this.encodeCanvas.width = imageData.width;
    this.encodeCanvas.height = imageData.height;
    this.encodeCtx.putImageData(imageData, 0, 0);
    return new Promise((resolve, reject) => {
      this.encodeCanvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('canvas.toBlob returned null'));
      }, 'image/png');
    });
  }
}

function requireContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable in the offscreen document');
  return ctx;
}
