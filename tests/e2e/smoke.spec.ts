/**
 * Loads the built extension and confirms it comes up without manifest or
 * runtime errors -- the one thing the plan explicitly could not verify
 * without a real browser (see the README's Verification section).
 */

import { test, expect } from './fixtures';

test('extension loads and the app tab page renders', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await page.goto(`chrome-extension://${extensionId}/app.html`);
  await expect(page.getByRole('heading', { name: 'EchoNotes' })).toBeVisible();
  await expect(page.getByText('No sessions yet.')).toBeVisible();

  expect(consoleErrors, `console errors on app.html: ${consoleErrors.join('\n')}`).toEqual([]);
});

test('popup renders and reflects idle status when no meeting tab is active', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByText('Not recording')).toBeVisible();

  expect(consoleErrors, `console errors on popup.html: ${consoleErrors.join('\n')}`).toEqual([]);
});
