/**
 * Screenshot-on-change detector: threshold + debounce state machine over a
 * stream of frame hashes.
 *
 * This implements FR4/FR5 from the PRD: save a screenshot only when a frame
 * differs from the last *kept* frame by more than `threshold` (Hamming
 * distance out of 64), and collapse a burst of qualifying changes into a
 * single screenshot of the frame the picture settles on -- the classic
 * trailing-edge debounce. Without it, a slide-transition animation produces
 * one screenshot per intermediate frame instead of one screenshot of the
 * destination slide.
 *
 * The detector holds no timers and does no I/O. The caller drives it two ways:
 *   - `evaluate(candidate)` for each sampled frame. If this candidate's
 *     qualifying run has clearly gone quiet before now (a new burst started
 *     after a gap >= debounceMs), the *previous* run is settled and reported
 *     immediately, since nothing else will ever tell the detector that gap
 *     occurred.
 *   - `flush(nowMs)` on an external tick (e.g. from a scheduler, or a test),
 *     to settle a run that has gone quiet with no further frames arriving at
 *     all -- the common case, since sampling continues at a fixed rate but
 *     duplicate frames below `threshold` don't reach `evaluate` as new input.
 *
 * That split keeps the class usable from both the offscreen document's
 * real-time sampler and from fixture-driven unit tests with synthetic
 * timestamps and no real clock.
 */

export interface DiffCandidate {
  timestampMs: number;
  phash: string;
}

export interface DiffDecision {
  kind: 'capture';
  candidate: DiffCandidate;
  diffScore: number;
}

export interface DiffPending {
  /** Candidate qualified but is being held for the debounce window. */
  kind: 'pending';
}

export interface DiffSkipped {
  /** Candidate did not differ enough from the last kept frame. */
  kind: 'skipped';
  diffScore: number;
}

export type DiffOutcome = DiffDecision | DiffPending | DiffSkipped;

export interface DetectorConfig {
  /** Hamming distance (0-64) above which a frame counts as "changed." */
  threshold: number;
  /** Quiet period, in ms, required before a pending run is settled. */
  debounceMs: number;
  hammingDistance: (a: string, b: string) => number;
}

export class ScreenshotChangeDetector {
  private lastKeptHash: string | null = null;
  private pendingCandidate: DiffCandidate | null = null;
  private pendingDiffScore = 0;
  private lastActivityMs = 0;

  constructor(private readonly config: DetectorConfig) {}

  evaluate(candidate: DiffCandidate): DiffOutcome {
    if (this.lastKeptHash === null) {
      this.keep(candidate);
      return { kind: 'capture', candidate, diffScore: 64 };
    }

    const diffScore = this.config.hammingDistance(this.lastKeptHash, candidate.phash);
    if (diffScore <= this.config.threshold) {
      // Matches (or is close enough to) the last kept frame: any in-flight
      // run reverted before settling, so there is nothing to capture.
      this.pendingCandidate = null;
      return { kind: 'skipped', diffScore };
    }

    // A qualifying change. If a previous run was already pending and has been
    // quiet for a full debounce window before this new candidate arrived,
    // that run is done -- settle it now, since evaluate() is the only place
    // that gap will ever be observed.
    let settled: DiffDecision | null = null;
    if (this.pendingCandidate !== null && candidate.timestampMs - this.lastActivityMs >= this.config.debounceMs) {
      settled = this.settle();
    }

    this.pendingCandidate = candidate;
    this.pendingDiffScore = diffScore;
    this.lastActivityMs = candidate.timestampMs;

    return settled ?? { kind: 'pending' };
  }

  /**
   * Settle a pending run if it has been quiet for a full debounce window as
   * of `nowMs`, with no new candidate having arrived to report it via
   * `evaluate`. Returns null if there is nothing pending, or the pending run
   * hasn't gone quiet yet.
   */
  flush(nowMs: number): DiffDecision | null {
    if (this.pendingCandidate === null) return null;
    if (nowMs - this.lastActivityMs < this.config.debounceMs) return null;
    return this.settle();
  }

  private settle(): DiffDecision {
    const candidate = this.pendingCandidate!;
    const diffScore = this.pendingDiffScore;
    this.keep(candidate);
    this.pendingCandidate = null;
    return { kind: 'capture', candidate, diffScore };
  }

  private keep(candidate: DiffCandidate): void {
    this.lastKeptHash = candidate.phash;
  }
}
