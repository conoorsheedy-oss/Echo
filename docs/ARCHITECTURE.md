# Architecture

Echo is a plain Electron app: no framework, no bundler. Three pieces:

```
┌──────────── Renderer (src/renderer) ─────────────┐
│ index.html + renderer.js + styles.css             │  the overlay UI
│ vad-core.js   voice-activity chunking (pure)      │  no Node, strict CSP
│ pcm-core.js + pcm-worklet.js  PCM for Deepgram    │
│ stt-core.js   speech-to-text key readiness (pure) │
│ gesture-core.js + gestures.js (optional webcam)   │
└───────────────┬───────────────────▲───────────────┘
   api.* calls  │ invoke / send     │ events (ai:chunk, stt:stream-event, hotkey:*, window:*)
┌───────────────▼───────────────────┴───────────────┐
│ preload.js  ->  window.assistant (contextBridge)  │  the only bridge
└───────────────┬───────────────────▲───────────────┘
┌───────────────▼───────────────────┴───────────────┐
│ Main process (src/main)                           │
│ main.js       window, tray, shortcuts, IPC        │
│ ai.js         Groq + Gemini over HTTPS, prompts   │──► Groq  (audio → text)
│ deepgram.js   live WebSockets (ws), one/speaker   │──► Deepgram (PCM stream → live text)
│ deepgram-core.js  URL, parsing, errors (pure)     │
│ humanize.js   strips em dashes / stock openers    │──► Gemini (text + images → answer)
│ ai-requests.js  cancels superseded requests       │
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
| Audio | `desktop:get-audio-source`, `stt:transcribe`, `stt:stream-start`, `stt:stream-stop`, `stt:stream-audio` (send) | `stt:stream-event` |
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
2. Each stream gets its own Web Audio `AnalyserNode` (never connected to the speakers) and its own `VadSegmenter` from `vad-core.js`. Every 40 ms the renderer reads the RMS loudness of the last ~21 ms of samples and feeds it to the segmenter.
3. A `MediaRecorder` is **always running** on each stream, so the first syllable is never lost waiting for "speech started". The segmenter answers each reading with:
   - **cut**: speech happened and then `SILENCE_MS` (700 ms) of quiet followed, or someone talked for `MAX_CHUNK_MS` (12 s) without pausing. The next recorder starts first, then the finished one stops and uploads. One recorder per chunk means every chunk is a complete, standalone webm/opus file.
   - **reset**: the recording has no speech in it after `IDLE_RESET_MS` (2.5 s). It's thrown away: silent audio is never uploaded.
   - Chunks are never shorter than `MIN_CHUNK_MS` (800 ms), and less than `MIN_SPEECH_MS` (200 ms) of voiced audio (a click or cough) doesn't count as speech.
4. **Threshold**: `max(MIN_THRESHOLD (0.01 RMS ≈ -40 dBFS), 3 × noise floor)`. The noise floor is the quietest moment of the last ~3 s (speech dips to the background level between words), smoothed: it rises slowly (2 s) and falls fast (0.3 s), capped at 0.03. Hysteresis keeps a trailing-off word voiced down to 70% of the threshold. A cut also needs 3 quiet readings, so a throttled page can't cut on one sample (`main.js` turns off `backgroundThrottling` so the 40 ms timer keeps running while the overlay is hidden).
5. Fallback: if Web Audio isn't available, or the `AudioContext` isn't running after 2 s, that stream goes back to fixed 6 s chunks (`CHUNK_MS`). Diagnostics shows which mode is active.
6. Each uploaded chunk goes to `stt:transcribe` → `ai.transcribeAudio()` → Groq Whisper (`verbose_json`). Tiny chunks and Whisper's "thanks for watching" hallucinations are dropped.
7. Lines are appended in recording order per stream as `You:` (mic) or `Them:` (system audio), with the chunk's cut reason and the time its speech ended.
8. **Stop Listening** discards the chunk in progress (as before); a chunk already cut at a pause still gets transcribed.

## Live speech-to-text with Deepgram (optional)

Settings > **Speech-to-text** picks the provider (`renderer.js` keeps it in `localStorage` as `echo.sttProvider`; it applies on the next Start Listening). `stt-core.js` decides what Start needs: Gemini always, plus Groq (Groq mode) or Deepgram (Deepgram mode). In Deepgram mode Groq is optional and only used as the fallback.

```
mic / system audio ─► MediaStreamSource ─┬─► AnalyserNode ─► VadSegmenter (halo + "someone is talking")
  (16 kHz AudioContext                   └─► AudioWorklet pcm-worklet.js (ScriptProcessorNode fallback)
   when Chromium allows)                        ─► ~100 ms Float32 blocks
                                                ─► Downsampler → 16 kHz ─► Int16 ─► PcmFramer (1600 samples)
                                                ─► AudioGate: only while talking (+4 frames pre-roll, 1.5 s tail)
                                                ─► ipcRenderer.send('stt:stream-audio', speaker, bytes)
main: deepgram.js ─► wss://api.deepgram.com/v1/listen  (one socket per speaker, Authorization: Token <key>)
      ◄─ Results / UtteranceEnd ─► deepgram-core.js assembler ─► 'stt:stream-event' to the renderer
```

1. **Start**: for each stream the renderer calls `stt:stream-start` (`{ speaker }`). Main opens a WebSocket with `model=nova-3`, `smart_format=true`, `interim_results=true`, `endpointing=300`, `utterance_end_ms=1000`, `vad_events=true`, `encoding=linear16`, `sample_rate=16000`, `channels=1`, `language=en` (`DEEPGRAM_MODEL` / `DEEPGRAM_LANGUAGE` in `.env` override the last two). The key goes in the handshake's `Authorization: Token <key>` header via the `ws` package: Electron 31's Node has no global WebSocket, and the WHATWG API can't set headers anyway. (Deepgram's `token` subprotocol alternative would put the key in `Sec-WebSocket-Protocol`, which is logged more readily.) The invoke resolves once the socket is open, or rejects with a coded error: `BAD_KEY` (401/403), `NO_CREDIT` (402), `RATE_LIMIT` (429), `OFFLINE` / `TIMEOUT`, `NO_KEY`.
2. **Audio**: `stt:stream-audio` is fire-and-forget (`ipcRenderer.send`, ~10 frames/s per stream while someone talks). Main checks the sender is Echo's own page and that the frame is bytes with an even length ≤ 1 s of audio, then forwards it as a binary WebSocket message. A few frames are queued while (re)connecting.
3. **Idle**: the renderer stops sending 1.5 s after the last voiced VAD frame (longer than `utterance_end_ms`, so Deepgram still sees the pause). Main then sends `{"type":"Finalize"}` (0.8 s after the last frame) and `{"type":"KeepAlive"}` every 5 s (Deepgram closes idle streams after ~10 s; its docs suggest 3-5 s).
4. **Transcripts**: `deepgram-core.js` turns `Results` / `UtteranceEnd` into renderer events `{ speaker, kind }`:
   - `interim` `{ text }`: settled words of the utterance + the latest guess. Shown as one dimmed line per speaker at the bottom of the transcript, replaced in place. Never sent to Gemini.
   - `final` `{ text, endOfSpeech }`: on `speech_final`, `UtteranceEnd` or a `Finalize` flush (`endOfSpeech: true`); a line that runs past 15 s without a pause is cut with `endOfSpeech: false`.
   - `end-of-speech`: `UtteranceEnd` after a line that was cut for length.
   The renderer feeds finals to the same `appendLine()` as Groq chunks, as `cut: 'silence'` (end of speech) or `cut: 'max'` (mid-speech). So question detection, the 300 ms / 1.5 s waits, de-dup and the "Speech end → first answer word" latency (speech end = last voiced VAD frame) work unchanged; `end-of-speech` releases a question that was waiting for its second half.
5. **Drops**: an unexpected close reconnects after 0.5 s, 1.5 s, 3.5 s (the budget resets after 10 s of stable connection). Bad audio (1008) and auth/credit closes don't retry. After that main sends `{ kind: 'error', fatal: true, code, message }`; the renderer shows a banner and switches that stream to the Groq recorder if a Groq key is set, otherwise stops listening.
6. **Stop**: `stt:stream-stop` sends `{"type":"CloseStream"}`; Deepgram returns the last finals and closes (force-closed after 3 s). Finals arriving right after Stop are still added, like a Groq chunk already cut at a pause. Removing keys (`keys:remove`), the window closing or the renderer crashing also close every stream.
7. **Privacy Mode** works as before: it pauses automatic answers, not transcription. Keys, audio and transcripts are never logged; only HTTP statuses / close codes are.

## Suggestion flow

1. A `Them:` line that looks like a question (`QUESTION_RE`) schedules an automatic answer:
   - chunk cut at a pause (VAD) and ending like a finished sentence (`?`, `.`, `!`): after **300 ms** (`AUTO_SUGGEST_AFTER_SPEECH_MS`). The pause itself was the end-of-speech signal.
   - trailing off (`...`) or no end punctuation: after 1.5 s (`AUTO_SUGGEST_QUIET_MS`).
   - chunk cut mid-speech (the 12 s safety cut, or fixed-chunk fallback) with no `?`: Echo waits for their next chunk first.
   Any new `Them:` line restarts the wait. The same question, or fewer than 12 new characters from them since the last automatic answer, never re-fires.
2. `renderer.js` calls `ai:suggest` with a `requestId`, the whole transcript, mode, earlier answers, quality setting, **answer style** (`script` / `cues`) and any tray screenshots.
3. `main.js` validates the payload, searches the knowledge base, registers the request in `ai-requests.js` and calls `ai.generateSuggestion()`.
4. `ai.js` picks a thinking level and streams from Gemini's `streamGenerateContent?alt=sse`. Each text piece goes through the `humanize.js` stream filter and is sent back as an `ai:chunk` event. If the stream breaks, it retries once without streaming. Thinking (`resolveThinkingLevel()`):
   - **Auto**: interview → `low` for normal and behavioural questions, `high` only when the question looks technical (coding, maths, probability, puzzles, system design: `looksTechnical()`) or screenshots are attached; meeting / presentation / general → `low`.
   - **Fast** = always `low`, **Max** = always `high`.
5. The renderer shows the answer. The **first sentence is rendered big** (`p.headline`) as soon as it starts streaming, so the user can start talking while the rest arrives. A sentence only ends at `. ! ?` followed by whitespace, so text already on screen never re-flows. Script answers then show one sentence per line; Cues answers a short bold-keyword list.
   - An answer you asked for (Generate, `Ctrl+Enter`, Regenerate, Shorten, Expand, `Ctrl+Shift+S`) streams straight into the panel.
   - An **automatic** answer that finishes while another answer is showing is held back behind a **New answer ready** chip. The visible text only changes when you click it. There is no timer-based auto-swap (see "CALM ANSWERS" in `renderer.js`).
6. Superseding: a new explicit request cancels every suggestion in flight; a new automatic one only cancels older automatic ones (`AbortController` per request).

Chat (`ai:ask`) works the same way but streams into the chat log. Summaries (`ai:summarize`) use a plain request with a JSON schema.

**Latency stat** (Diagnostics, `Ctrl+Shift+D`): time from the end of the speech in the latest `Them` chunk (last voiced VAD frame) to the first streamed token of the answer that followed, last value and average of the last 10, with the speech-to-text share shown separately.

## Answer voice and style

Prompts live in `ai.js`:

- `HUMAN_VOICE` (suggest) asks for how people actually talk: contractions, plain words, short varied sentences, first person, concrete specifics, an occasional "So," / "Yeah, so" / "Honestly," opener. It bans common AI tells ("Great question", "Certainly", "leverage", "delve", "spearheaded", "robust", "seamless", "in conclusion", em dashes, three-adjective lists, "Not only X but Y") and includes three BEFORE (stiff AI) → AFTER (spoken) examples. The chat prompt gets the same ban list.
- Knowledge files (CV / notes) are for **facts only**; the prompt says never to copy their wording, because CVs are often AI-written.
- **Answer style** (`answerStyle`, validated in `main.js`): `SCRIPT_STYLE` = a headline sentence, then 1-3 short spoken sentences, one per line, STAR for behavioural questions; `CUES_STYLE` = a headline sentence, then 3-4 `- **keyword** detail` cues, no full sentences. Technical answers still get the code / steps in both styles. The renderer stores the choice in `localStorage` (`echo.answerStyle`).
- `humanize.js` is a safety net after the model: em dashes (and en dashes used as dashes between words) become commas, or disappear next to punctuation / at line edges, outside code fences; a stock opener at the very start ("Great question!", "Certainly.", "I'd be happy to help!") is removed. The stream version holds back only what it can't decide yet (the first word or two, trailing spaces/dashes), so every streamed piece is a prefix of the final answer.

## Key storage

`keyStore.js` encrypts keys with Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret/KWallet on Linux) and writes only ciphertext to `keys.enc.json` in the app's user-data folder. If OS encryption isn't available, it refuses to save (use `.env` instead). The renderer only gets booleans plus where each key came from (`saved` / `env`). Keys are sent only to their own provider, in headers, and never logged.

## Hand gestures

`gestures.js` (opt-in) opens the webcam at 320×240, runs MediaPipe's GestureRecognizer locally (WebAssembly, CPU) about 12 times a second, and feeds results to `HoldDetector` in `gesture-core.js`. A sign must be held (0.8 s, 1.2 s for the fist) with ≥70% confidence; then a 1.5 s cooldown applies and the same sign must be released before it can fire again. Each action **clicks the real button** by ID, so it runs the same code as a click. `main.js` grants the camera only to Echo's own page and only while gestures are on. The runtime and model are copied/downloaded by `scripts/fetch-gesture-assets.js` into the git-ignored `src/renderer/vendor/mediapipe/`, and the model bytes are read by main (`gestures:load-model`).

## Security notes

- **CSP** (`index.html`): `default-src 'self'`, `connect-src 'self'` (the page can't call the internet; main does), no inline scripts or styles. `'wasm-unsafe-eval'` is only there so MediaPipe's WebAssembly can run.
- The window denies new windows and navigation. `external:open` only opens three allowlisted key pages (Groq, Gemini, Deepgram sign-up).
- The CSP is unchanged by Deepgram mode: the AudioWorklet module (`pcm-worklet.js`) is a same-origin file, which `script-src 'self'` already allows, and the WebSocket is opened by main, not the page.
- Permissions are deny-by-default and only for Echo's own page: mic and system audio, clipboard writes, and the camera only while gestures are on (plus a few seconds after a system-audio request, which uses a desktop video track).

## Tests

`npm test` runs Node's built-in test runner (no Electron needed):

- `test/gesture-core.test.js`: the hold-to-confirm state machine with synthetic frames.
- `test/vad-core.test.js`: the voice-activity chunker with synthetic RMS frames (speech start, 700 ms silence cut, min/max chunk length, blips, idle reset, adaptive noise floor, hysteresis, throttled frames).
- `test/ai-answers.test.js`: streaming, fallback, cancellation, thinking levels, prompt building (voice rules, answer styles) and the `humanize.js` safety net, with `fetch` mocked.
- `test/deepgram-core.test.js`: listen URL, message parsing, the interim/final assembler (`speech_final`, `UtteranceEnd`, length cuts, `Finalize` flushes), error/close classification, backoff and KeepAlive/Finalize timing, PCM frame validation.
- `test/deepgram-stream.test.js`: `deepgram.js` with a fake WebSocket and clock (auth header, 401/402/429/offline, queueing, KeepAlive, CloseStream, reconnect then fatal error) and the Deepgram key test with `fetch` mocked.
- `test/pcm-core.test.js`: downsampling (48 / 44.1 kHz → 16 kHz, no drift), Int16 conversion, framing and the talk-only audio gate.
- `test/stt-core.test.js`: which keys Start Listening needs per provider, and the banner text.
