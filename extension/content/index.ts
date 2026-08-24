/**
 * Content script: selects the platform adapter for the current page and
 * polls it for the shared-content region, relaying changes to the service
 * worker. Injected only on meet.google.com and teams.microsoft.com/live.com
 * (see manifest.json content_scripts).
 *
 * Polling rather than a MutationObserver keeps this robust to whatever DOM
 * churn each platform's adapter has to deal with -- a share starting,
 * stopping, or switching presenter doesn't need to be caught by a specific
 * mutation, just noticed within one poll interval.
 */

import { meetAdapter } from './adapters/meet';
import { teamsAdapter } from './adapters/teams';
import { testHarnessAdapter } from './adapters/testHarness';
import type { PlatformAdapter, PresentationRegion } from './adapters/types';
import type { ContentToSwMessage } from '@shared/messages';

const POLL_INTERVAL_MS = 1000;
// testHarnessAdapter is always in this list, but only ever matches when the
// extension was built with --e2e -- the manifest actually shipped to users
// never has a content_scripts match pattern that would inject this script
// on localhost in the first place, so its presence here doesn't change
// production behavior. See extension/content/adapters/testHarness.ts.
const adapters: PlatformAdapter[] = [meetAdapter, teamsAdapter, testHarnessAdapter];

function selectAdapter(): PlatformAdapter | null {
  return adapters.find((a) => a.matches(location.href)) ?? null;
}

function regionsEqual(a: PresentationRegion | null, b: PresentationRegion | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function main(): void {
  const adapter = selectAdapter();
  if (!adapter) return;

  let lastRegion: PresentationRegion | null = null;

  setInterval(() => {
    const region = adapter.findPresentationRegion();
    if (regionsEqual(region, lastRegion)) return;
    lastRegion = region;

    // The sender's tab id (which this script cannot read about itself) is
    // available to the service worker via sender.tab.id, so it isn't
    // duplicated into the message body -- see sw/index.ts's forwardRegionToOffscreen.
    const message: ContentToSwMessage = { type: 'PRESENTATION_REGION_UPDATE', region };
    chrome.runtime.sendMessage(message).catch(() => undefined);
  }, POLL_INTERVAL_MS);
}

main();
