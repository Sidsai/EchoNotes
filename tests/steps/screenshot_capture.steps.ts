/**
 * Step definitions for screenshot_capture.feature, bound directly to
 * packages/core/diff -- no browser, no fixture image files. "Slides" are
 * synthetic frames built with the same generators the diff unit tests use
 * (tests/fixtures/synthFrame.ts), and "capture" means feeding frames through
 * the real ScreenshotChangeDetector + phash, exactly as the offscreen
 * document's frame sampler does.
 */

import { Given, When, Then, Before } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { ScreenshotChangeDetector, type DiffDecision } from '@core/diff/detector';
import { phash, hammingDistance } from '@core/diff/phash';
import { quadrantFrame, slideFrame, movingDotFrame } from '../fixtures/synthFrame';

const THRESHOLD = 20;
const DEBOUNCE_MS = 3000;

interface World {
  detector: ScreenshotChangeDetector;
  nowMs: number;
  captured: DiffDecision[];
  slides: Record<string, ReturnType<typeof quadrantFrame>>;
}

let world: World;

Before(function () {
  world = {
    detector: new ScreenshotChangeDetector({ threshold: THRESHOLD, debounceMs: DEBOUNCE_MS, hammingDistance }),
    nowMs: 0,
    captured: [],
    slides: {
      'Slide 1': quadrantFrame(64, 64, false),
      'Slide 2': quadrantFrame(64, 64, true),
    },
  };
});

function feed(frame: ReturnType<typeof quadrantFrame>): void {
  const outcome = world.detector.evaluate({ timestampMs: world.nowMs, phash: phash(frame) });
  if (outcome.kind === 'capture') world.captured.push(outcome);
  world.nowMs += 500; // one sample tick, matching the real 2fps sampler
}

function settle(): void {
  world.nowMs += DEBOUNCE_MS;
  const settled = world.detector.flush(world.nowMs);
  if (settled) world.captured.push(settled);
}

Given('a capture session is active', function () {
  // No setup needed beyond the fresh detector from Before(); this step
  // exists for readability in the feature file.
});

Given('the shared screen shows {string}', function (label: string) {
  // The detector unconditionally captures the very first frame it ever
  // sees (the session's baseline screenshot) -- that's expected real
  // behavior, but it isn't the thing "exactly one new screenshot" is
  // asserting on below, so the log is cleared once the baseline is set.
  feed(world.slides[label]!);
  world.captured = [];
});

Given('the shared screen shows a static slide', function () {
  // Cursor position 10 -- matches the exact pair (10, 14) already verified
  // stable under phash in packages/core/diff/phash.test.ts's "is stable
  // under a small moving highlight" case, rather than guessing at a new,
  // untested pixel comparison here.
  feed(movingDotFrame(64, 64, 10));
  world.captured = [];
});

When('the shared screen changes to {string}', function (label: string) {
  feed(world.slides[label]!);
  settle();
});

When('only the mouse cursor moves across the slide', function () {
  feed(movingDotFrame(64, 64, 14));
  settle();
});

When('the screen changes three times within 2 seconds during a slide animation', function () {
  // The feature text has no explicit "Given the screen shows X" before this
  // scenario, but there is necessarily some slide on screen before an
  // animation can start -- feed and clear a neutral baseline first so its
  // unconditional first-frame capture doesn't get counted as one of the
  // "three changes" the scenario is actually asserting on.
  //
  // Each transition frame here is a genuinely different synthetic image
  // (not a subtle variation), each pair verified well clear of the
  // threshold -- an animation's intermediate frames are exactly this kind
  // of large-but-transient change, which is the case debouncing exists for.
  feed(quadrantFrame(64, 64, false));
  world.captured = [];

  feed(slideFrame(64, 64, 0)); // transition frame A
  feed(quadrantFrame(64, 64, true)); // transition frame B
  feed(slideFrame(64, 64, 1)); // final settled frame
  settle();
});

Then('exactly one new screenshot is saved', function () {
  assert.equal(world.captured.length, 1, `expected exactly 1 capture, got ${world.captured.length}`);
});

Then('its diff_score exceeds the configured threshold', function () {
  const last = world.captured.at(-1);
  assert.ok(last, 'no capture recorded to check diff_score against');
  assert.ok(last!.diffScore > THRESHOLD, `diff_score ${last!.diffScore} did not exceed threshold ${THRESHOLD}`);
});

Then('no new screenshot is saved', function () {
  assert.equal(world.captured.length, 0, `expected no captures, got ${world.captured.length}`);
});

Then('only one screenshot is saved', function () {
  assert.equal(world.captured.length, 1, `expected exactly 1 capture, got ${world.captured.length}`);
});

Then('it corresponds to the final settled frame', function () {
  const last = world.captured.at(-1)!;
  const expected = phash(slideFrame(64, 64, 1));
  assert.equal(last.candidate.phash, expected, 'captured frame does not match the final settled frame');
});
