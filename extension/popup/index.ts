/**
 * Popup: start/stop control and live status. Deliberately thin -- all it does
 * is identify the active tab's platform, send START_SESSION/STOP_SESSION to
 * the service worker, and reflect whatever status comes back. All actual
 * capture state lives in the offscreen document and IndexedDB.
 */

import type { Platform } from '@core/types';
import type { PopupToSwMessage, StatusResponse } from '@shared/messages';

const statusDot = document.getElementById('status-dot')!;
const statusText = document.getElementById('status-text')!;
const toggleButton = document.getElementById('toggle-button') as HTMLButtonElement;
const hintText = document.getElementById('hint-text')!;
const openSessionsLink = document.getElementById('open-sessions-link')!;

function detectPlatform(url: string | undefined): Platform {
  if (!url) return 'unknown';
  if (url.includes('meet.google.com')) return 'meet';
  if (url.includes('teams.microsoft.com') || url.includes('teams.live.com')) return 'teams';
  // The fake-Meet E2E harness only matches when this was built with --e2e --
  // never true for the manifest actually shipped to users. See
  // extension/content/adapters/testHarness.ts and scripts/build.mjs.
  if (__E2E__ && url.includes('localhost:4173')) return 'meet';
  return 'unknown';
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function render(status: StatusResponse, platform: Platform): void {
  const isRecording = status.status === 'recording';
  statusDot.dataset.status = status.status;
  toggleButton.dataset.recording = String(isRecording);
  toggleButton.textContent = isRecording ? 'Stop capture' : 'Start capture';

  if (status.status === 'error') {
    statusText.textContent = 'Capture failed';
    hintText.textContent = status.error ?? 'Something went wrong. Check chrome://extensions for details.';
    toggleButton.disabled = false;
    return;
  }

  if (isRecording && status.startedAt) {
    const elapsed = Math.floor((Date.now() - status.startedAt) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    statusText.textContent = `Recording -- ${mm}:${ss}`;
    hintText.textContent = '';
    toggleButton.disabled = false;
    return;
  }

  statusText.textContent = 'Not recording';
  toggleButton.disabled = platform === 'unknown';
  hintText.textContent = platform === 'unknown' ? 'Open a Google Meet or Teams tab to capture a meeting.' : '';
}

async function refresh(platform: Platform): Promise<void> {
  const status = await sendToSw({ type: 'GET_STATUS' });
  render(status, platform);
}

function sendToSw(message: PopupToSwMessage): Promise<StatusResponse> {
  return chrome.runtime.sendMessage(message);
}

async function main(): Promise<void> {
  const tab = await getActiveTab();
  const platform = detectPlatform(tab?.url);

  await refresh(platform);
  const ticker = setInterval(() => void refresh(platform), 1000);
  window.addEventListener('unload', () => clearInterval(ticker));

  toggleButton.addEventListener('click', async () => {
    toggleButton.disabled = true;
    const status = await sendToSw({ type: 'GET_STATUS' });

    if (status.status === 'recording') {
      const next = await sendToSw({ type: 'STOP_SESSION' });
      render(next, platform);
      return;
    }

    if (!tab?.id) return;
    const next = await sendToSw({ type: 'START_SESSION', tabId: tab.id, platform });
    render(next, platform);
  });

  openSessionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    void chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
  });
}

void main();
