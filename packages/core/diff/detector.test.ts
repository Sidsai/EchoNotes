import { describe, it, expect } from 'vitest';
import { ScreenshotChangeDetector, type DiffOutcome } from './detector';

/**
 * A fake "hamming distance" over single-character hash labels: identical
 * labels are distance 0, anything else is a fixed distance of 30. Keeps
 * these tests about the state machine's timing/threshold logic, independent
 * of the real pHash implementation (which has its own dedicated tests).
 */
function labelDistance(a: string, b: string): number {
  return a === b ? 0 : 30;
}

function makeDetector(overrides: Partial<{ threshold: number; debounceMs: number }> = {}) {
  return new ScreenshotChangeDetector({
    threshold: overrides.threshold ?? 20,
    debounceMs: overrides.debounceMs ?? 3000,
    hammingDistance: labelDistance,
  });
}

describe('ScreenshotChangeDetector', () => {
  it('captures the very first frame unconditionally, as the session baseline', () => {
    const d = makeDetector();
    const outcome = d.evaluate({ timestampMs: 0, phash: 'slide1' });
    expect(outcome).toEqual({
      kind: 'capture',
      candidate: { timestampMs: 0, phash: 'slide1' },
      diffScore: 64,
    });
  });

  // PRD Gherkin: "A new slide triggers a screenshot"
  it('captures a new slide once it has settled', () => {
    const d = makeDetector();
    d.evaluate({ timestampMs: 0, phash: 'slide1' }); // baseline capture

    const pending = d.evaluate({ timestampMs: 100, phash: 'slide2' });
    expect(pending).toEqual({ kind: 'pending' });

    const settled = d.flush(3100);
    expect(settled).toEqual({
      kind: 'capture',
      candidate: { timestampMs: 100, phash: 'slide2' },
      diffScore: 30,
    });
    expect(settled!.diffScore).toBeGreaterThan(20); // exceeds configured threshold
  });

  it('does not settle before the debounce window has elapsed', () => {
    const d = makeDetector();
    d.evaluate({ timestampMs: 0, phash: 'slide1' });
    d.evaluate({ timestampMs: 100, phash: 'slide2' });
    expect(d.flush(1000)).toBeNull();
    expect(d.flush(3099)).toBeNull();
  });

  // PRD Gherkin: "Minor cursor movement does not trigger a screenshot"
  it('does not capture when the diff stays at or below threshold', () => {
    const d = makeDetector({ threshold: 20 });
    d.evaluate({ timestampMs: 0, phash: 'slide1' });

    // labelDistance is binary (0 or 30) so exercise the boundary via a
    // detector configured with threshold >= the only nonzero distance,
    // simulating "changed, but not enough to matter."
    const lenient = makeDetector({ threshold: 30 });
    lenient.evaluate({ timestampMs: 0, phash: 'slide1' });
    const outcome = lenient.evaluate({ timestampMs: 100, phash: 'cursor-moved' });
    expect(outcome).toEqual({ kind: 'skipped', diffScore: 30 });
    expect(lenient.flush(10_000)).toBeNull();
  });

  // PRD Gherkin: "Rapid transition frames are debounced"
  it('collapses a burst of changes within the debounce window into one capture of the final frame', () => {
    const d = makeDetector({ debounceMs: 3000 });
    d.evaluate({ timestampMs: 0, phash: 'slide1' });

    // Three qualifying changes within 2 seconds, simulating a transition animation.
    expect(d.evaluate({ timestampMs: 500, phash: 'transition-a' }).kind).toBe('pending');
    expect(d.evaluate({ timestampMs: 1200, phash: 'transition-b' }).kind).toBe('pending');
    expect(d.evaluate({ timestampMs: 2000, phash: 'slide2-final' }).kind).toBe('pending');

    // No further frames; the picture settles on slide2-final.
    expect(d.flush(2000 + 3000 - 1)).toBeNull();
    const settled = d.flush(2000 + 3000);
    expect(settled).toEqual({
      kind: 'capture',
      candidate: { timestampMs: 2000, phash: 'slide2-final' },
      diffScore: 30,
    });
  });

  it('settles a stale pending run via evaluate() when a new burst starts after a full quiet gap', () => {
    const d = makeDetector({ debounceMs: 3000 });
    d.evaluate({ timestampMs: 0, phash: 'slide1' });
    d.evaluate({ timestampMs: 100, phash: 'slide2' }); // pending, never explicitly flushed

    // A new qualifying change arrives well after slide2's debounce window
    // would have elapsed -- evaluate() must settle slide2 before starting a
    // new run for slide3, since nothing else will ever observe that gap.
    const outcome = d.evaluate({ timestampMs: 100 + 3000 + 500, phash: 'slide3' });
    expect(outcome).toEqual({
      kind: 'capture',
      candidate: { timestampMs: 100, phash: 'slide2' },
      diffScore: 30,
    });

    // slide3 is now the new pending run, on top of slide2 (not slide1).
    const settled = d.flush(100 + 3000 + 500 + 3000);
    expect(settled).toEqual({
      kind: 'capture',
      candidate: { timestampMs: 100 + 3000 + 500, phash: 'slide3' },
      diffScore: 30,
    });
  });

  it('discards a pending run that reverts to the last kept frame before settling', () => {
    const d = makeDetector();
    d.evaluate({ timestampMs: 0, phash: 'slide1' });
    d.evaluate({ timestampMs: 100, phash: 'overlay' }); // pending
    // The overlay disappears; the frame returns to slide1 before the debounce
    // window elapses. Nothing permanent changed, so nothing should capture.
    const reverted = d.evaluate({ timestampMs: 200, phash: 'slide1' });
    expect(reverted).toEqual({ kind: 'skipped', diffScore: 0 });
    expect(d.flush(10_000)).toBeNull();
  });

  it('uses the last-kept frame, not the previous pending candidate, as the comparison baseline', () => {
    // Regression guard: diffScore on settle must reflect distance from what
    // was last actually *kept*, not from whatever was pending before it.
    const d = makeDetector();
    d.evaluate({ timestampMs: 0, phash: 'slide1' });
    d.evaluate({ timestampMs: 100, phash: 'slide2' });
    const settled = d.flush(3100);
    expect((settled as { candidate: { phash: string } }).candidate.phash).toBe('slide2');

    // Next run starts fresh, compared against slide2 (now kept), not slide1.
    const next = d.evaluate({ timestampMs: 3200, phash: 'slide2' }); // identical to newly kept frame
    expect(next).toEqual({ kind: 'skipped', diffScore: 0 });
  });
});
