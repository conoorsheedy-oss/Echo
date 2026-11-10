# Changelog

## 0.2.0 – unreleased

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
