# EchoNotes

A local-first meeting notes assistant. Captures Google Meet / Teams-in-browser
audio and shared-screen visuals from a Chrome extension, transcribes locally,
structures the result with an LLM, and exports to Markdown/Obsidian and
Notion. No native companion process, no meeting bot, no server.

See [`C:\Users\sid78\Downloads\PRD-MeetingNotes-MVP.md`](../Downloads/PRD-MeetingNotes-MVP.md)
for product requirements and the approved implementation plan for the
architecture rationale and milestone breakdown.

## Status

**All five milestones (M1-M5) implemented.** The extension has been loaded
in a real Chromium browser and driven end-to-end by an automated E2E suite
-- this is no longer "structurally complete but unverified" the way it was
at the M1/M2 checkpoint. See [Verification](#verification) for exactly what
that E2E suite actually exercised versus what still needs a human with a
real Meet call.

## How to Use EchoNotes

Everything from a clean checkout to a finished, exported note.

### Prerequisites

- **Chrome or a Chromium-based browser**, version 122 or newer (for the
  offscreen-document and File System Access APIs this relies on).
- **Node.js 20+** and npm, only to build the extension -- nothing runs on a
  server at any point after that.
- **An Anthropic API key**, to generate structured notes. Get one at
  [console.anthropic.com](https://console.anthropic.com). Optional unless
  you want notes generated at all.
- **A Notion integration token and a page id**, only if you want Notion
  export. Optional.

### 1. Build the extension

```bash
npm install
npm run build
```

This produces a loadable extension in `dist/`. Re-run `npm run build`
any time you change the source and want to reload it.

### 2. Load it into Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `dist/` folder from this repo.
4. EchoNotes now has a toolbar icon. Pin it (puzzle-piece icon in the
   toolbar → pin) so it's always visible.

### 3. First-time setup

1. Click the EchoNotes toolbar icon, then **View past sessions** at the
   bottom of the popup -- this opens the sessions page as a full tab.
2. Click **Settings** at the top.
3. Paste your **Anthropic API key**. This is what generates the structured
   note after a meeting; without it, sessions stay as raw transcript only.
4. *(Optional, for Notion export)* Paste your **Notion API key**, and a
   **Notion parent page id** -- the page your notes will be created under.
   Notion's API can't create pages at your workspace root, so you also need
   to open that page in Notion, click **Share**, and add your integration
   to it once. The page id is the string of characters at the end of that
   page's URL.
5. *(Optional, for Markdown/Obsidian export)* Click **Choose vault
   folder…** and pick your Obsidian vault (or any folder) on disk. Chrome
   will ask you to confirm folder access again the first time you use it
   in a fresh browser session -- that's Chrome's own permission model, not
   an EchoNotes prompt.
6. Click **Save settings**.

Keys are stored in this browser profile's local storage, not your OS
keychain -- see the [Security note](#security-note-deviation-from-the-prd)
below before treating this as production-grade credential storage.

### 4. Capture a meeting

1. Join a **Google Meet** or **Microsoft Teams (web)** call as you
   normally would, in this same browser.
2. With that meeting tab focused, click the EchoNotes toolbar icon.
3. Click **Start capture**.
4. The popup shows a live "Recording — mm:ss" timer. You can close the
   popup; capture keeps running in the background.
5. Talk, present, share your screen as normal. EchoNotes:
   - Records the meeting audio and your microphone together.
   - Watches whatever you share on screen and saves a screenshot whenever
     the content meaningfully changes (a new slide, not a moving cursor
     or a shifting webcam tile).
   - Transcribes as it goes, entirely on your machine.
6. When the meeting ends, click the toolbar icon again and click **Stop
   capture**.

A structured note is generated automatically after you stop -- typically
within about a minute, longer on the very first run while the local
transcription model downloads (a few hundred MB, one-time, cached after
that).

### 5. Review, regenerate, and export a note

1. Open the sessions page (toolbar icon → **View past sessions**).
2. Click any session to open it. You'll see the generated title, summary,
   decisions, action items, open questions, and each discussion section
   with the screenshot shown at that point in the conversation.
3. **Not happy with the note?** Type an instruction (e.g. "focus on action
   items only" or "make the summary one paragraph") into the box under
   the note and click **Regenerate note**. This re-runs the LLM step
   only -- it does not re-transcribe.
4. **Raw transcript**: click "Raw transcript" near the bottom to see the
   full transcript with timestamps and speaker labels, independent of the
   generated note.
5. **Export to Markdown / Obsidian**: click the button. This writes a
   `.md` file plus an `attachments/<session>/` folder of images into the
   vault folder you picked in Settings, with images referenced inline at
   the point they were shown.
6. **Export to Notion**: click the button. This creates a new page under
   your configured parent page, with the note as native Notion blocks and
   screenshots uploaded and embedded in place.
7. You can export the same session to either format again later, any
   number of times, without re-processing anything.

### 6. Manage past sessions

The sessions list shows every past session with its date, duration,
platform, and status. Click **Delete session** inside a session's detail
view to permanently remove it and all its local audio and screenshots (you
will be asked to confirm).

If a session was interrupted (browser closed, extension crashed) before it
could finish, it's flagged on the sessions list -- its captured audio and
screenshots are safe, and opening it offers a **Generate note from
captured audio** button to produce a note from what was captured anyway.

### Troubleshooting

- **"Start capture" is greyed out**: you need to be on a `meet.google.com`
  or `teams.microsoft.com`/`teams.live.com` tab.
- **No note appears after stopping**: check that an Anthropic API key is
  set in Settings, and check the session's detail view for an error
  message.
- **Export button does nothing / errors**: for Markdown, make sure a vault
  folder is picked in Settings; for Notion, make sure both the API key and
  parent page id are set, and that the integration has been shared with
  that page from Notion's own Share menu.
- **First capture is slow to produce a note**: the local Whisper model
  downloads once (a few hundred MB) the first time you capture; it's
  cached after that.

## Development Setup

```bash
npm install
npm run build      # bundles extension/ into dist/ for real use
npm run typecheck
npm test           # unit tests (core pipeline, 100% coverage on diff/ and align/)
npm run test:bdd   # Cucumber: PRD's Gherkin scenarios, bound to packages/core/
npm run test:e2e   # Playwright: loads the real built extension in Chromium
```

## Architecture

- `packages/core/` -- pure TypeScript, no `chrome.*` and no DOM. The whole
  pipeline (frame diffing, transcript alignment, speaker attribution, note
  structuring/grounding, export) lives here and is unit-testable from
  fixtures without a browser.
- `extension/sw/` -- service worker. Session lifecycle, message routing, and
  finalization orchestration (`finalize.ts`: alignment + the LLM call +
  citation-grounding validation, via `llm.ts`'s Anthropic client).
- `extension/offscreen/` -- the capture engine. Long-lived while a session is
  active: tab audio, mic audio, their mix, frame sampling
  (`frameSampler.ts`), and local Whisper inference (`whisperProvider.ts`).
- `extension/content/` -- per-platform DOM adapters (`adapters/meet.ts`,
  `adapters/teams.ts`, plus `adapters/testHarness.ts` for the E2E-only fake
  harness below), all delegating to a shared, platform-agnostic geometry
  heuristic (`adapters/dominantRegion.ts`) rather than a hardcoded selector.
- `extension/popup/` -- start/stop control.
- `extension/app/` -- session list / review / export / settings, as a full
  extension tab (not a popup) -- required because `showDirectoryPicker()`
  fails when called from a popup. Also has the async I/O layers
  `packages/core/export/*.ts` deliberately stays free of:
  `obsidianExport.ts` (File System Access) and `notionClient.ts` /
  `notionExport.ts` (Notion's real multi-step file upload API).
- `extension/shared/` -- IndexedDB persistence (`db.ts`), typed message
  contracts between the four surfaces above (`messages.ts`), API key storage
  (`settings.ts`), and small infrastructure (`id.ts`, `wav.ts`,
  `resample.ts`).
- `tests/harness/fake-meet/` -- a static page that synthesizes its own
  audio/video entirely in-browser (`canvas.captureStream()` + a WebAudio
  oscillator, no binary fixtures checked in) with a layout matching what the
  region-detection heuristic looks for, so the E2E suite can exercise the
  real content-script adapter code path instead of a mocked one.

## Security note (deviation from the PRD)

The PRD specifies OS-keychain storage for API keys. Chrome extensions have no
keychain access. Keys are stored in `chrome.storage.local`, which is
protected only as well as the Chrome profile itself is. Flagging this
explicitly rather than silently meeting a lesser bar: **do not treat this
extension's key storage as equivalent to OS-keychain-backed storage.**

## Verification

What has actually been checked, and how -- this section exists so
"implemented" is never conflated with "verified."

### Unit + BDD (fully automated, fully passing)

- `npm run typecheck`: clean across `packages/core` and `extension`.
- `npm test`: 111/111 passing. `packages/core/diff` and `packages/core/align`
  are at 100% statement/branch/function/line coverage, the PRD's sign-off
  bar; everything else in `packages/core` and the pure `extension/shared`
  utilities are covered too, though not held to the 100% bar.
- `npm run test:bdd`: all 4 of the PRD's fixture-realizable Gherkin scenarios
  pass, bound directly to `packages/core/diff` and `packages/core/align`
  (screenshot-on-change, minor-motion-is-ignored, debounced transitions,
  transcript-to-screenshot alignment). The PRD's crash-recovery scenario is
  kept as a `.feature` file for its spec value but is realized as a
  Playwright test instead (see below) -- it inherently exercises real
  IndexedDB and UI state, not pipeline logic.

### E2E (Playwright, against the real built extension in real Chromium)

`npm run test:e2e` builds a `--e2e` variant of the extension (the *only*
difference from the real build: the content script and host permissions
additionally match `localhost:4173`, where the fake-Meet harness runs --
confirmed absent from the real `npm run build` output) and loads it unpacked
in a real, automated Chromium instance. Three things this actually proved,
not assumed:

- **The extension loads in real Chrome with zero manifest or console
  errors**, on both `app.html` and `popup.html`. This was the single
  biggest "not verified" item at the M1/M2 checkpoint, and is now
  confirmed rather than hoped for.
- **The session review UI genuinely renders real note/transcript data** --
  a session, its structured note (summary/decisions/action items/open
  questions/sections), and a transcript segment are seeded directly into
  IndexedDB, `app.html` is loaded fresh, and the test clicks into the
  session and asserts the actual rendered DOM text matches, then deletes it
  and confirms it's gone. This caught and fixed a real gap while building
  it: the note's own LLM-generated title (often much more specific than the
  generic session title) was never surfaced anywhere in the UI.
- **`chrome.runtime.sendMessage` never delivers back to the same script
  context that sent it** -- confirmed empirically (not just documented) by
  first writing a test that called `sendMessage` from within the service
  worker's own context to reach its own listener, watching it fail with
  "Could not establish connection," and then fixing the test to send from a
  genuinely different context instead. This is real, load-bearing knowledge
  about how the actual message architecture behaves, not a guess.

**What the E2E suite could not get past, and why (a real Chrome security
boundary, not a bug):** `chrome.tabCapture.getMediaStreamId()` requires
`activeTab` to have been granted for the target tab, which Chrome only
grants on a genuine, physical user gesture on the extension's toolbar icon.
`chrome.action.openPopup()` called from script does **not** satisfy this --
confirmed by trying it and getting the identical "Extension has not been
invoked for the current page" error either way. This is Chrome's own
security boundary working as designed (resisting exactly this kind of
scripted simulation is the point of it), not a limitation specific to this
test harness. The one E2E test that needs it
(`tests/e2e/capture-flow.spec.ts`) detects this specific error and skips
with an explicit, logged reason rather than either failing (misrepresenting
a Chrome platform constraint as a product defect) or silently passing
(misrepresenting a skip as a pass).

### Still genuinely unverified -- requires a human with a real Meet call

Everything gated behind that same `activeTab` boundary, which is
everything downstream of `tabCapture` actually starting:

- Tab audio staying audible after `tabSource.connect(audioContext.destination)`
  restores playback (the fix for tabCapture's mute-on-capture behavior) --
  has never actually been heard.
- Both voices appearing in captured audio; mic permission prompt behavior.
- **The Meet/Teams region-detection heuristic** (`dominantRegion.ts`)
  against a *real* Meet/Teams layout -- proven correct in isolation (9/9
  unit tests) and against the synthetic harness (which deliberately mimics
  the geometry it looks for), never against the genuine, messier DOM of an
  actual video call.
- **The region-to-video-pixel mapping** in `frameSampler.ts`: assumes the
  content script's `getBoundingClientRect()` (tab CSS pixels) maps directly
  onto the captured video's native pixel dimensions. If `devicePixelRatio`
  scaling turns out to matter, screenshots crop to the wrong region.
- **Whisper transcription end-to-end**: model download from HuggingFace/
  jsdelivr, WebGPU device selection, and real inference output shape.
  `@huggingface/transformers` bundled into a single file via esbuild is a
  documented upstream gotcha (WASM backend path resolution can break once
  concatenated) -- if model loading fails silently, this is the first
  thing to check.
- **The Anthropic and Notion API calls** (`llm.ts`, `notionClient.ts`):
  request/response shapes are from current documentation and were
  cross-checked (the `anthropic-dangerous-direct-browser-access` header,
  Notion's 3-step small-file upload flow), but neither has been exercised
  against the real APIs with a real key.
- Whether `ScriptProcessorNode`'s `onaudioprocess` timing holds up over a
  real 10+ minute session without drift or dropped callbacks.

**Known, deliberate scope boundary (not a bug):** if the offscreen document
is torn down (which the service worker does shortly after every "Stop
capture," once the transcription queue drains or a timeout gives up on it)
while the last chunk's transcription is still in flight, that chunk's
transcript is lost -- its *audio* is always safe, already written to
IndexedDB before this can happen. FR9's "final full-pass reconciliation
after the session ends," which would retry any chunk left in `pending`
state, is not implemented. See the comments on `drainTranscriptionAndFinalize`
in `extension/offscreen/index.ts`.

**Known, deliberate export limitation (not a bug):** Notion's create-page
endpoint caps the `children` array per request (100 blocks, per Notion's API
docs at the time this was written); a note with many sections and
screenshots could exceed that. `notionClient.ts`'s `createNotionPage` does
not paginate into a create + append-children sequence to handle it -- a
typical meeting is very unlikely to hit this, but a very long,
heavily-illustrated session could, and the Notion API will reject the
request with a validation error rather than silently truncating content.

### To actually finish verifying this

Load `dist/` unpacked (the real build, `npm run build`, not `--e2e`), join a
real Google Meet or Teams call, set an Anthropic API key (and a Notion key +
parent page id, and pick an Obsidian vault, if testing those exports) from
the sessions page's Settings panel, and click "Start capture" in the popup
**while the meeting tab is focused** -- that click is the real user gesture
`activeTab` needs. Confirm meeting audio stays audible, a shared slide deck
produces one screenshot per slide (not per webcam twitch), the note reads as
usable without heavy editing, and both exports produce what they're supposed
to.
