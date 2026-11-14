# Changelog

## 0.2.0 – unreleased

- **Faster answers.**
  - **Instant first line** (Settings > Answers, on by default): every answer request also runs a tiny parallel Gemini call (minimal thinking, ~80 output tokens, last ~8k characters of transcript + the last two answers + knowledge snippets) that writes only the first sentence to say, in the same voice rules. It's shown in the big first-line slot as soon as it arrives; when the full answer's own first sentence is ready it replaces that line in place and the body appears below (nothing below it moves). The full answer stays the source of truth for Copy / Shorten / Expand / history. Both calls share cancellation; a first line that fails, or arrives after the full answer started, is dropped silently. Turn it off to save quota (one extra small request per answer).
  - **Smarter thinking level**: Auto now tells a **new problem** ("write a function", "given an array", "design a ...", maths / probability / puzzles, long problem statements, problem screenshots → `high` in Interview mode) from a **follow-up** about code already discussed ("why did you use X", "what if...", "what's the complexity", "how would you test it", edge cases, short conceptual questions → `low`). Follow-ups get a short spoken answer (first line + 1-3 lines, at most a tiny snippet of the changed code) instead of the full numbered walk-through and code. This was the main cause of 3-4 s waits on coding follow-ups.
  - **Earlier start**: "Them" lines count as questions by their wording, not only a `?` (`src/renderer/question-core.js`). With Deepgram, a question fires as soon as `speech_final` arrives (UtteranceEnd stays the fallback); with Groq, 150 ms after a question chunk lands (was 300 ms / 1.5 s without punctuation), and the VAD now cuts after 550 ms of quiet (was 700 ms). Lines that trail off ("and the...") still wait.
  - The **New answer ready** chip appears as soon as a background answer has its first line; clicking it while the answer is still streaming hands the panel to it.
  - **Prompt layout**: the LATEST question now comes after the screenshots (images are their own parts between the context and the question). The long, append-only transcript stays first so Gemini's implicit prefix caching can reuse it between questions; per-question parts (knowledge snippets, the newest answer, the format hint) come after it.
  - Output budgets: follow-ups get 700 visible tokens; thinking headroom is now 1536 (low) / 3072 (medium) / 8192 (high) tokens on top of the visible budget.
  - Diagnostics: the latency stat counts the first word from either call, and a new row splits the last answer into end of speech → request, request → first line, request → full answer.

- **Deepgram Nova-3 live speech-to-text (optional).** Settings > **Speech-to-text**: Groq Whisper (free, default) or Deepgram Nova-3 (live, faster). With Deepgram, words appear in the transcript as people speak (a dimmed in-progress line per speaker), and Deepgram's end-of-speech signals (`speech_final` / `UtteranceEnd`) trigger automatic answers. Needs an optional third key (Deepgram: $200 free credit, no card; about $0.46/hour of streamed audio after that).
- The WebSocket lives in the main process (`src/main/deepgram.js`, using the `ws` package), so the Deepgram key never reaches the UI. Audio is captured with an AudioWorklet (ScriptProcessorNode fallback), converted to 16 kHz 16-bit PCM and streamed only while someone is talking. KeepAlive while idle, CloseStream on stop, up to 3 reconnects, then an automatic fall back to Groq Whisper when a Groq key is set.
- Start Listening now needs Gemini + the chosen speech-to-text provider's key; the banner and Settings say which one is missing. **Test keys** also checks the Deepgram key (a free, read-only request).
- `setup.cmd` / `setup.ps1`: one-click Windows setup for people running from source. Checks Git and Node.js (offers to install Node LTS with winget), puts local `package.json` / `package-lock.json` changes aside so `git pull` works, runs `npm install` with retries, then builds and launches the installer or runs `npm start`.
- Node.js **22 or newer** is now required to build (`engines` in `package.json`); electron-builder's dependencies need it.

## 0.1.0

First open-source, bring-your-own-keys release.

- Always-on-top overlay that transcribes your mic ("You") and system audio ("Them") in ~6 s chunks with Groq Whisper.
- Automatic answer suggestions when the other side asks a question, plus Generate (`Ctrl+Enter`), Shorten, Expand, Regenerate and Copy.
- Streaming answers from Google Gemini; automatic answers wait behind a "New answer ready" chip instead of replacing the one you're reading.
- Interview, Meeting, Presentation and General modes; Quality vs speed setting (Auto / Fast / Max).
- Screenshot tray (up to 4), knowledge base from your own `.txt` / `.md` files, chat box, and session summaries with export.
- Compact bar, Focus mode, Privacy Mode, hide from screen share (opt-in), click-through, diagnostics panel and global shortcuts.
- Experimental webcam hand gestures (off by default, processed locally with MediaPipe).
- API keys encrypted with the OS keychain via Electron `safeStorage`; no Echo server, no login, no credits.
- Windows installer (`Echo-Setup-<version>.exe`, NSIS x64) built with electron-builder via `npm run dist`; not code-signed yet.
- GitHub Actions: CI runs a syntax check and `npm test` on Windows and Ubuntu; pushing a `v*` tag builds the installer and attaches it to a GitHub Release.
