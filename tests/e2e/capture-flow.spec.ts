/**
 * Drives a full capture session against the fake-Meet harness and inspects
 * IndexedDB directly for the result -- the closest this suite can get to
 * the plan's "real 10-minute meeting" verification without an actual
 * meeting.
 *
 * Messages are sent from a "driver" page navigated to the extension's own
 * app.html, not from `serviceWorker.evaluate()` and not by navigating to
 * popup.html. Two real things learned empirically while building this
 * suite, not assumed:
 *
 *   1. `chrome.runtime.sendMessage` never delivers a message back to the
 *      same script context that sent it -- Chrome explicitly excludes the
 *      sender's own frame. Calling `sendMessage` from within
 *      `serviceWorker.evaluate()` to reach the service worker's own
 *      listener fails with "Could not establish connection," every time,
 *      confirmed by first writing that version of this test and watching
 *      it fail. A driver page is a genuinely different context, which is
 *      what makes delivery work at all -- this isn't a workaround for a
 *      test-only quirk, it's the real mechanics popup.ts relies on too.
 *   2. popup.html's own `chrome.tabs.query({active: true})` would report
 *      itself, not the harness tab, if Playwright navigated directly to it
 *      -- becoming the active tab is what navigating there does. The driver
 *      page sidesteps that by supplying the harness's tab id directly
 *      (found via `chrome.tabs.query({url: ...})`, which works reliably)
 *      rather than depending on "active tab" semantics designed for a real
 *      user's toolbar click.
 *
 * One thing this test CANNOT get past, confirmed empirically rather than
 * assumed: `chrome.tabCapture.getMediaStreamId()` requires `activeTab` to
 * have been granted for the target tab, which Chrome only grants on a real,
 * physical user gesture on the extension's toolbar icon -- `chrome.action
 * .openPopup()` called from script does not satisfy it, confirmed by trying
 * it and getting the same "Extension has not been invoked for the current
 * page" error either way. This is Chrome's own security boundary working as
 * designed (it exists specifically to resist scripted simulation), not a
 * bug in this codebase, and not something specific to this test harness --
 * a real user clicking "Start capture" inside the popup works because
 * *opening the popup* is the real gesture that grants activeTab, and it
 * persists for that tab afterward. When this environment limitation is hit,
 * the test skips with an explicit reason rather than failing (which would
 * misrepresent a Chrome platform constraint as a product defect) or
 * silently passing (which would misrepresent a skip as a pass). Everything
 * up to that point -- the harness, cross-context messaging, and tab
 * resolution -- still runs and is asserted on for real.
 */

import { test, expect } from './fixtures';

interface DbCounts {
  sessions: number;
  audioChunks: number;
  screenshots: number;
}

async function readDbCounts(page: import('@playwright/test').Page): Promise<DbCounts> {
  return page.evaluate(() => {
    return new Promise<DbCounts>((resolve, reject) => {
      const req = indexedDB.open('echonotes');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['sessions', 'audioChunks', 'screenshots'], 'readonly');
        const counts: Partial<DbCounts> = {};
        let pending = 3;
        const done = () => {
          if (--pending === 0) resolve(counts as DbCounts);
        };
        tx.objectStore('sessions').count().onsuccess = (e) => {
          counts.sessions = (e.target as IDBRequest<number>).result;
          done();
        };
        tx.objectStore('audioChunks').count().onsuccess = (e) => {
          counts.audioChunks = (e.target as IDBRequest<number>).result;
          done();
        };
        tx.objectStore('screenshots').count().onsuccess = (e) => {
          counts.screenshots = (e.target as IDBRequest<number>).result;
          done();
        };
      };
    });
  });
}

test('a capture session records audio chunks and at least one screenshot', async ({ context, extensionId }) => {
  test.setTimeout(60_000);

  const harnessPage = await context.newPage();
  await harnessPage.goto('http://localhost:4173');
  await expect(harnessPage.locator('#status')).toHaveText('ready');
  await harnessPage.evaluate(() => window.__harness.resumeAudio());

  const driverPage = await context.newPage();
  await driverPage.goto(`chrome-extension://${extensionId}/app.html`);

  const tabs = await driverPage.evaluate(() => chrome.tabs.query({ url: 'http://localhost:4173/*' }));
  const tabId = tabs[0]?.id;
  expect(tabId, 'harness tab not found via chrome.tabs.query').toBeDefined();

  const startStatus = await driverPage.evaluate(
    (id) => chrome.runtime.sendMessage({ type: 'START_SESSION', tabId: id, platform: 'meet' }),
    tabId,
  );

  if (startStatus.status === 'error' && String(startStatus.error).includes('has not been invoked')) {
    test.skip(
      true,
      'chrome.tabCapture requires a real, physical user gesture on the toolbar icon to grant activeTab -- ' +
        'not scriptable from Playwright (see this file\'s header comment). Verify this path manually: load ' +
        'dist/ unpacked, open a real Meet call, and click "Start capture" in the popup.',
    );
    return;
  }

  expect(startStatus.status, `START_SESSION did not report recording: ${JSON.stringify(startStatus)}`).toBe('recording');

  // Let the sampler run for a bit, then change the slide so the frame
  // differs enough to trigger a screenshot once the debounce window settles.
  await harnessPage.waitForTimeout(2000);
  await harnessPage.evaluate(() => window.__harness.setSlide(2));
  await harnessPage.waitForTimeout(4000); // past the 3s debounce

  const stopStatus = await driverPage.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP_SESSION' }));
  expect(stopStatus.status).toBe('idle');

  const counts = await readDbCounts(driverPage);

  expect(counts.sessions, 'no session record was written').toBeGreaterThanOrEqual(1);
  expect(counts.audioChunks, 'no audio chunks were written').toBeGreaterThanOrEqual(1);
  expect(counts.screenshots, 'no screenshots were captured').toBeGreaterThanOrEqual(1);
});
