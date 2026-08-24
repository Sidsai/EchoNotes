/**
 * Google Meet platform adapter. See types.ts for why this file exists in
 * isolation from the rest of the pipeline, and dominantRegion.ts for why
 * region detection is a geometry heuristic rather than a hardcoded Meet
 * selector: Google doesn't publish one, and Meet's DOM changes often enough
 * that a hardcoded guess would go stale fast and fail silently.
 *
 * If this proves too coarse against a real Meet layout (verify per the
 * plan's step-3 verification, not assumed here), the next refinement is
 * platform-specific: Meet's presentation tile is reachable via a container
 * with an aria-label naming the presenter, which could narrow the candidate
 * set before the geometry heuristic runs -- worth adding once confirmed
 * against a live share, not before.
 */

import type { PlatformAdapter, PresentationRegion } from './types';
import { pickDominantRegion, visibleVideoRects } from './dominantRegion';

export const meetAdapter: PlatformAdapter = {
  platform: 'meet',

  matches(url: string): boolean {
    return url.includes('meet.google.com');
  },

  findPresentationRegion(): PresentationRegion | null {
    return pickDominantRegion(visibleVideoRects());
  },
};
