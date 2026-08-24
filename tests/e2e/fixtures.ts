/**
 * Extension-loading fixture, shared by every E2E spec. Launches a persistent
 * Chromium context with the built `dist/` extension loaded unpacked, and
 * resolves its extension id from the service worker's own URL -- the
 * standard Playwright pattern for testing MV3 extensions (there is no
 * `chrome.runtime.id` available from outside the extension itself).
 *
 * `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`
 * make the mic `getUserMedia()` call in the offscreen document deterministic
 * and permission-prompt-free in CI, where there's no real microphone and no
 * human to click "Allow." `chrome.tabCapture` itself doesn't need a fake
 * device (it captures the tab, not real hardware), but does need the
 * extension's own activeTab/tabCapture permission, already declared in the
 * manifest.
 */

import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const DIST_DIR = path.resolve(import.meta.dirname, '..', '..', 'dist');

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
}>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    if (!fs.existsSync(path.join(DIST_DIR, 'manifest.json'))) {
      throw new Error(`dist/manifest.json not found at ${DIST_DIR} -- run "npm run build" before the E2E suite.`);
    }

    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', // enables Chromium's newer headless mode with real extension support, per Playwright's own docs
      headless: true,
      args: [
        `--disable-extensions-except=${DIST_DIR}`,
        `--load-extension=${DIST_DIR}`,
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(serviceWorker.url().split('/')[2]!);
  },
});

export const expect = test.expect;
