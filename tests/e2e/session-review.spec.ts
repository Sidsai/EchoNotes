/**
 * Verifies the app tab page actually renders a session's note, transcript,
 * and status correctly -- by seeding IndexedDB directly with a synthetic
 * session (bypassing the tabCapture-gated capture flow entirely, see
 * capture-flow.spec.ts's header comment for why that path can't be
 * automated) and checking the real rendered DOM. This is real coverage of
 * extension/app/index.ts's rendering logic that unit tests can't reach
 * (jsdom isn't part of this project's test setup, and this logic is DOM-
 * heavy enough that faking it would mostly test the fake).
 */

import { test, expect } from './fixtures';

test('a session with a structured note renders correctly, and delete removes it', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/app.html`);

  await page.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('echonotes');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['sessions', 'transcriptSegments', 'structuredNotes'], 'readwrite');
        const startedAt = Date.now() - 600_000;

        tx.objectStore('sessions').put({
          id: 'e2e-session-1',
          title: 'E2E Review Test Session',
          platform: 'meet',
          startedAt,
          endedAt: startedAt + 600_000,
          status: 'ready',
        });

        tx.objectStore('transcriptSegments').put({
          id: 'e2e-seg-1',
          sessionId: 'e2e-session-1',
          startMs: 0,
          endMs: 5000,
          text: 'Let us review the roadmap for next quarter.',
          speaker: 'them',
          chunkSeq: 0,
        });

        tx.objectStore('structuredNotes').put({
          sessionId: 'e2e-session-1',
          generatedAt: Date.now(),
          title: 'Q1 Roadmap Review',
          summary: 'The team reviewed the Q1 roadmap and agreed on priorities.',
          decisions: [{ text: 'Ship the export feature first', citations: ['e2e-seg-1'] }],
          actionItems: [{ text: 'Draft the launch plan', owner: 'Sai', citations: ['e2e-seg-1'] }],
          openQuestions: ['Who owns the Notion integration long-term?'],
          sections: [{ heading: 'Roadmap', body: 'Discussed priorities for the quarter.', screenshotIds: [] }],
        });

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
  });

  await page.reload();
  await expect(page.getByText('E2E Review Test Session')).toBeVisible();

  await page.getByText('E2E Review Test Session').click();
  await expect(page.locator('#detail-title')).toHaveText('Q1 Roadmap Review');
  await expect(page.getByText('The team reviewed the Q1 roadmap and agreed on priorities.')).toBeVisible();
  await expect(page.getByText('Ship the export feature first')).toBeVisible();
  await expect(page.getByText('Draft the launch plan (Sai)')).toBeVisible();
  await expect(page.getByText('Who owns the Notion integration long-term?')).toBeVisible();

  // Raw transcript (FR12/FR19): independent of the structured note, still reachable.
  await page.locator('.raw-transcript summary').click();
  await expect(page.getByText('Let us review the roadmap for next quarter.')).toBeVisible();

  // Delete (FR18): confirmation dialog, then the session disappears from the
  // list. Scoped to #session-list specifically -- the now-hidden detail
  // view's stale text (session.title also appears in #detail-meta) is
  // harmless and gets overwritten the next time a session is opened, so
  // asserting zero occurrences anywhere on the page would be checking
  // something the product was never designed to guarantee.
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#delete-session-button').click();
  await expect(page.getByText('No sessions yet.')).toBeVisible();
  await expect(page.locator('#session-list').getByText('E2E Review Test Session')).toHaveCount(0);
});
