/**
 * Step definitions for transcript_alignment.feature, bound directly to
 * packages/core/align -- the PRD's example timestamps translated literally.
 */

import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { alignScreenshots } from '@core/align/align';
import type { Screenshot, TranscriptSegment } from '@core/types';

interface World {
  segments: TranscriptSegment[];
  screenshots: Screenshot[];
  aligned: Screenshot[];
}

let world: World;

function toMs(timestamp: string): number {
  const [mm, ss] = timestamp.split(':').map(Number);
  return (mm! * 60 + ss!) * 1000;
}

function seg(id: string, startMs: number): TranscriptSegment {
  return { id, sessionId: 'test-session', startMs, endMs: startMs + 5000, text: `segment ${id}`, speaker: 'them', chunkSeq: 0 };
}

function shot(id: string, timestampMs: number): Screenshot {
  return {
    id,
    sessionId: 'test-session',
    timestampMs,
    blobKey: `${id}.png`,
    phash: '0'.repeat(16),
    diffScore: 64,
    width: 1280,
    height: 720,
    linkedSegmentId: null,
  };
}

Given('a transcript with segments at {word}, {word}, and {word}', function (t1: string, t2: string, t3: string) {
  world = {
    segments: [seg('seg_10', toMs(t1)), seg('seg_45', toMs(t2)), seg('seg_80', toMs(t3))],
    screenshots: [],
    aligned: [],
  };
});

Given('a screenshot captured at timestamp {word}', function (t: string) {
  world.screenshots.push(shot('shot_1', toMs(t)));
});

When('alignment runs', function () {
  world.aligned = alignScreenshots({ segments: world.segments, screenshots: world.screenshots });
});

Then('the screenshot is linked to the segment starting at {word}', function (t: string) {
  const expectedSegment = world.segments.find((s) => s.startMs === toMs(t));
  assert.ok(expectedSegment, `no segment in fixture starts at ${t}`);
  assert.equal(world.aligned[0]!.linkedSegmentId, expectedSegment!.id);
});
