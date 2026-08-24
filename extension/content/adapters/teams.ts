/**
 * Teams-in-browser platform adapter. See meet.ts and dominantRegion.ts for
 * why region detection is a geometry heuristic shared with the Meet adapter
 * rather than a hardcoded Teams selector -- Microsoft doesn't publish one
 * either, and this file exists separately from meet.ts specifically so a
 * Teams-specific refinement (if verification against a live share shows the
 * generic heuristic needs one) doesn't risk the Meet path.
 */

import type { PlatformAdapter, PresentationRegion } from './types';
import { pickDominantRegion, visibleVideoRects } from './dominantRegion';

export const teamsAdapter: PlatformAdapter = {
  platform: 'teams',

  matches(url: string): boolean {
    return url.includes('teams.microsoft.com') || url.includes('teams.live.com');
  },

  findPresentationRegion(): PresentationRegion | null {
    return pickDominantRegion(visibleVideoRects());
  },
};
