# Architecture

Echo is a plain Electron app: no framework, no bundler. Three pieces:

```
┌──────────── Renderer (src/renderer) ─────────────┐
│ index.html + renderer.js + styles.css             │  the overlay UI
│ gesture-core.js + gestures.js (optional webcam)   │  no Node, strict CSP
└───────────────┬───────────────────▲───────────────┘
   api.* calls  │ invoke / send     │ events (ai:chunk, hotkey:*, window:*)
┌───────────────▼───────────────────┴───────────────┐
│ preload.js  ->  window.assistant (contextBridge)  │  the only bridge
└───────────────┬───────────────────▲───────────────┘
┌───────────────▼───────────────────┴───────────────┐
│ Main process (src/main)                           │
│ main.js       window, tray, shortcuts, IPC        │
│ ai.js         Groq + Gemini over HTTPS            │──► Groq  (audio → text)
│ ai-requests.js  cancels superseded requests       │──► Gemini (text + images → answer)
│ keyStore.js   encrypted keys (safeStorage)        │
│ knowledge.js  keyword search over your notes      │
└───────────────────────────────────────────────────┘
```

- **Main** owns everything privileged: API keys, network calls, files, screen capture, global shortcuts and permissions.
- **Preload** exposes a fixed list of functions as `window.assistant`. `renderer.js` wraps it as `api` (it can't be a top-level `const assistant`: that clashes with the `window.assistant` global and kills the script). The wrapper restores `err.code` / `err.status` from errors (main tags them onto the message, because IPC only carries the message).
- **Renderer** is the UI. It never sees an API key and has no Node access (`contextIsolation: true`, `nodeIntegration: false`).

## IPC channels

All `invoke` channels are handled in `main.js` with `handle()`, which validates payloads.

| Area | Renderer → main (`invoke` unless noted) | Main → renderer (events) |
|---|---|---|
| Audio | `desktop:get-audio-source`, `stt:transcribe` | |
| Answers | `ai:suggest`, `ai:ask`, `ai:summarize`, `summary:export` | `ai:chunk` |
| Keys | `keys:status`, `keys:save`, `keys:remove`, `keys:test`, `external:open` | |
| Screen | `screen:list-sources`, `screen:capture` | |
| Knowledge | `knowledge:status`, `knowledge:reload`, `knowledge:open-folder`, `knowledge:add-files` | |
| Window | `window:set-compact`, `window:hide` (send), `window:minimize` (send) | `window:compact-changed`, `window:visibility-changed` |
| Privacy | `privacy:status`, `content-protection:status`, `content-protection:toggle` | `hotkey:privacy-mode-changed`, `hotkey:content-protection-changed` |
| Gestures | `gestures:set-enabled`, `gestures:status`, `gestures:load-model` | |
| Misc | `config:status`, `clipboard:write-text` | `hotkey:generate`, `hotkey:clear`, `hotkey:click-through-changed`, `hotkey:capture-screen`, `hotkey:summarize`, `hotkey:toggle-expand`, `hotkey:diagnostics` |

## Speech-to-text flow

1. **Start Listening** opens the mic and system audio (a desktop-capture stream whose video track is dropped).
2. Each stream is recorded in **6 s chunks** (`CHUNK_MS`). The next chunk starts before the current one uploads, so no audio is lost.
3. Each chunk goes to `stt:transcribe` → `ai.transcribeAudio()` → Groq Whisper (`verbose_json`). Near-silent chunks and Whisper's "thanks for watching" hallucinations are dropped.
4. Lines are appended in recording order as `You:` (mic) or `Them:` (system audio).

## Suggestion flow

1. A `Them:` line that looks like a question (`QUESTION_RE`) schedules an automatic answer once they've been quiet for 1.5 s. If the question may continue into the next chunk, Echo waits for that chunk first.
2. `renderer.js` calls `ai:suggest` with a `requestId`, the whole transcript, mode, earlier answers, quality setting and any tray screenshots.
3. `main.js` validates the payload, searches the knowledge base, registers the request in `ai-requests.js` and calls `ai.generateSuggestion()`.
4. `ai.js` picks a thinking level (Auto/Fast/Max policy in `resolveThinkingLevel()`) and streams from Gemini's `streamGenerateContent?alt=sse`. Each text piece is sent back as an `ai:chunk` event. If the stream breaks, it retries once without streaming.
5. The renderer shows the answer:
   - An answer you asked for (Generate, `Ctrl+Enter`, Regenerate, Shorten, Expand, `Ctrl+Shift+S`) streams straight into the panel.
   - An **automatic** answer that finishes while another answer is showing is held back behind a **New answer ready** chip. The visible text only changes when you click it. There is no timer-based auto-swap (see "CALM ANSWERS" in `renderer.js`).
6. Superseding: a new explicit request cancels every suggestion in flight; a new automatic one only cancels older automatic ones (`AbortController` per request).

Chat (`ai:ask`) works the same way but streams into the chat log. Summaries (`ai:summarize`) use a plain request with a JSON schema.

## Key storage

`keyStore.js` encrypts keys with Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret/KWallet on Linux) and writes only ciphertext to `keys.enc.json` in the app's user-data folder. If OS encryption isn't available, it refuses to save (use `.env` instead). The renderer only gets booleans plus where each key came from (`saved` / `env`). Keys are sent only to their own provider, in headers, and never logged.

## Hand gestures

`gestures.js` (opt-in) opens the webcam at 320×240, runs MediaPipe's GestureRecognizer locally (WebAssembly, CPU) about 12 times a second, and feeds results to `HoldDetector` in `gesture-core.js`. A sign must be held (0.8 s, 1.2 s for the fist) with ≥70% confidence; then a 1.5 s cooldown applies and the same sign must be released before it can fire again. Each action **clicks the real button** by ID, so it runs the same code as a click. `main.js` grants the camera only to Echo's own page and only while gestures are on. The runtime and model are copied/downloaded by `scripts/fetch-gesture-assets.js` into the git-ignored `src/renderer/vendor/mediapipe/`, and the model bytes are read by main (`gestures:load-model`).

## Security notes

- **CSP** (`index.html`): `default-src 'self'`, `connect-src 'self'` (the page can't call the internet; main does), no inline scripts or styles. `'wasm-unsafe-eval'` is only there so MediaPipe's WebAssembly can run.
- The window denies new windows and navigation. `external:open` only opens two allowlisted key pages.
- Permissions are deny-by-default and only for Echo's own page: mic and system audio, clipboard writes, and the camera only while gestures are on (plus a few seconds after a system-audio request, which uses a desktop video track).

## Tests

`npm test` runs Node's built-in test runner (no Electron needed):

- `test/gesture-core.test.js`: the hold-to-confirm state machine with synthetic frames.
- `test/ai-answers.test.js`: streaming, fallback, cancellation, thinking levels and prompt building, with `fetch` mocked.
