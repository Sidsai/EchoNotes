/**
 * Adapter for tests/harness/fake-meet, Playwright's E2E stand-in for a real
 * Meet/Teams tab (see the plan's Testing section on why the harness exists).
 * Content scripts are only ever injected here at all when the extension is
 * built with `--e2e` (see scripts/build.mjs) -- the manifest actually
 * shipped to users never matches localhost, so this adapter never activates
 * for a real user regardless of this file being present in the bundle.
 *
 * Deliberately reuses the exact same geometry heuristic meet.ts and
 * teams.ts do, rather than special-casing the harness's DOM -- the point of
 * the harness is to exercise the real adapter code path, not a mocked one.
 */

import type { PlatformAdapter, PresentationRegion } from './types';
import { pickDominantRegion, visibleVideoRects } from './dominantRegion';

export const testHarnessAdapter: PlatformAdapter = {
  platform: 'meet', // reported as 'meet' for session-record purposes; there's no dedicated Platform value for the test harness

  matches(url: string): boolean {
    return url.includes('localhost:4173');
  },

  findPresentationRegion(): PresentationRegion | null {
    return pickDominantRegion(visibleVideoRects());
  },
};
