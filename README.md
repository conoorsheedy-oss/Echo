# Echo (open edition)

A small always-on-top desktop overlay that transcribes your calls and suggests what to say next, using **your own free API keys**.

- **Live transcript** of you (mic) and them (system audio).
- **Suggested answers** when the other side asks a question, or any time with **Generate**.
- **Screenshots, your own notes, and a chat box** for extra context.
- **No Echo server, no login, no credits.** It talks straight to Groq (speech-to-text) and Google Gemini (answers).
- Free and open source ([MIT](LICENSE)).

> **Use it responsibly.** Echo is for interview *practice*, mock interviews and meetings where everyone knows it's running. Many interviews, exams and employers forbid AI help during live assessments, and recording people without consent is illegal in many places. Follow the rules that apply to you. You are responsible for how you use it.

## Download (Windows)

1. Download `Echo-Setup-x.y.z.exe` from the [Releases page](https://github.com/conoorsheedy-oss/Echo/releases) and run it.
2. Windows may show **"Windows protected your PC"**. Echo isn't code-signed yet, so click **More info** > **Run anyway**.
3. Pick an install folder. The installer adds Desktop and Start menu shortcuts; uninstall from Windows Settings > Apps.
4. On first run Echo opens **Settings**: paste two free keys (Groq and Gemini, see the table below) and click **Save keys**.

The installer is Windows-only for now. macOS and Linux are untested (system-audio capture especially), so run from source there.

## Quick start (from source)

You need [Node.js](https://nodejs.org) **20 or newer**.

```bash
git clone https://github.com/conoorsheedy-oss/Echo.git
cd Echo
npm install
npm start
```

On first run Echo opens **Settings**. Paste two free keys and click **Save keys** (Echo then tests them):

| Key | Used for | Get one |
|---|---|---|
| Groq | Speech-to-text (Whisper) | https://console.groq.com/keys |
| Gemini | Answers, chat, summaries | https://aistudio.google.com/apikey |

You can reopen Settings any time from the `⋯` menu > **API keys**.

## Using it

- **Start Listening** records your mic and system audio and shows the transcript (`You:` / `Them:`). Speech is sent at natural pauses (about 0.7 s after someone stops talking), and silence is never uploaded. The Mic / System audio dots glow while voice is detected.
- When they finish a question, an answer starts in **Suggested response** within about a second. The first sentence shows in large text straight away, so you can start talking while the rest arrives. Press **Generate** (`Ctrl+Enter`) to get one any time, even without listening.
- An automatic answer never replaces the one you're reading: a **New answer ready** chip appears instead. Click it when you're ready.
- Every answer has **Shorten**, **Expand**, **Regenerate** and **Copy**.
- **Modes** (dropdown next to Start Listening): Interview, Meeting, Presentation, General. Each has its own answer style.
- **Script / Cues** (chip next to **Suggested response**): **Script** gives full spoken sentences, one per line. **Cues** gives a first line to say, then 3–4 bold keywords to talk around in your own words, which sounds more natural than reading.
- Answers are written to sound like a person talking: contractions, plain words, no "Great question" or em dashes. Facts from your CV or notes are re-said in plain words, never copied.
- **Screen context:** pick a screen or window and click **Capture**. Up to **4 screenshots** wait in a tray and go with your next answer or question. `Ctrl+Shift+S` captures and answers in one go.
- **Knowledge base:** **Add Files** to add your CV or notes (`.txt` / `.md`). Only the snippets that match a question are sent.
- **Ask the assistant:** a chat box for follow-up questions about the conversation.
- **Summarize** (`Ctrl+Shift+M`): summary, decisions, action items and open questions. Copy it or export it.
- **Compact bar** (`▭` button or `Ctrl+Shift+K`): shrinks Echo to just the latest answer.
- **Focus** (`Ctrl+Shift+E`): the answer panel fills the window.
- **Privacy Mode** (`Ctrl+Shift+P`): pauses screen capture and automatic answers. Manual Generate still works.
- **Hide from screen share** (`⋯` menu or `Ctrl+Shift+H`): asks the OS to hide Echo from screen sharing and recording. Off by default, never remembered between launches, and a **Hidden** badge shows while it's on. Only use it when the people you're sharing with know. It doesn't work with every capture tool.

## Keyboard shortcuts

On macOS, `Ctrl` is `Cmd`. These work even when Echo isn't focused.

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+Space` | Show / hide Echo (also brings it back if it's off-screen) |
| `Ctrl+Enter` | Generate an answer now |
| `Ctrl+Shift+S` | Capture the screen and answer |
| `Ctrl+Shift+M` | Summarize the session |
| `Ctrl+Shift+E` | Focus the answer panel |
| `Ctrl+Shift+K` | Compact bar on/off |
| `Ctrl+Shift+C` | Clear the transcript |
| `Ctrl+Shift+X` | Click-through on/off (clicks go to the app underneath) |
| `Ctrl+Shift+P` | Privacy Mode on/off |
| `Ctrl+Shift+H` | Hide from screen share on/off |
| `Ctrl+Shift+D` | Diagnostics panel |

## Hand gestures (experimental, off by default)

Webcam shortcuts for when your hands are off the keyboard. Turn them on in `⋯` menu > **Hand gestures** > **Use webcam hand gestures as shortcuts**. A **Gestures** chip shows while the camera is on; click it to turn gestures off.

Hold a sign steady for about **0.8 s** (the fist needs **1.2 s**). After a gesture fires there's a 1.5 s cooldown, and the same sign won't fire again until your hand drops or changes.

| Sign | Does |
|---|---|
| Open palm | Generate an answer |
| Closed fist (hold 1.2 s) | Start / stop listening |
| Thumb up | Copy the answer |
| Pointing up | Scroll the answer up |
| Victory (V sign) | Capture a screenshot |
| Thumb down | Clear attached screenshots |

Gestures are ignored while Settings is open, while you're typing in Echo, and in Privacy Mode. The camera is released whenever gestures are off or Echo is hidden. Frames are processed **on your computer** by MediaPipe and never saved or sent. The mapping lives in `src/renderer/gesture-core.js`.

## Settings

- **Quality vs speed** (Settings > Answers) sets how hard Gemini thinks before answering:
  - **Auto** (default): `high` for coding, maths, probability, puzzle and system-design questions in Interview mode, or when screenshots are attached. Everything else uses `low` for speed.
  - **Fast**: always `low`, quickest answers.
  - **Max**: always `high`, best quality but slower.
- **Answer style** (Settings > Answers, or the chip): **Script** (default) or **Cues**.
- **Models** (when running from source): copy `.env.example` to `.env` to override them, then restart Echo:
  - `GEMINI_MODEL` (default `gemini-3.5-flash`). Google retires older Flash models, so if answers say the model is unknown, set a current Gemini Flash id from Google AI Studio.
  - `GROQ_STT_MODEL` (default `whisper-large-v3-turbo`).
- `.env` can also hold `GROQ_API_KEY` / `GEMINI_API_KEY` as a developer fallback. Keys saved in the app take priority.

## Privacy

| What | Goes to | When |
|---|---|---|
| Audio chunks (mic + system audio) | **Groq**, with your key | While listening |
| Transcript, your questions, matched knowledge snippets | **Google Gemini**, with your key | When an answer, chat reply or summary is requested |
| Screenshots in the tray | **Google Gemini**, with your key | With the next answer or question (never in Privacy Mode) |
| Camera frames (gestures only) | **Nowhere**, processed locally | While gestures are on |
| Anything | **An Echo server** | **Never.** There isn't one. |

- **Keys** are encrypted with your OS keychain (Electron `safeStorage`) and stored only on your computer. The UI can save or remove a key but never read it back.
- **Free-tier Gemini:** Google may use free-tier prompts and responses to improve its products. Use a paid (billing-enabled) key if that matters to you. See the [Gemini API terms](https://ai.google.dev/gemini-api/terms).
- Transcripts and summaries stay in memory unless you export them.

## Troubleshooting

| Problem | Fix |
|---|---|
| "rejected your API key" | Copy the key again into Settings, or create a new one. Click **Test keys** to check. |
| "rate limit hit" (HTTP 429) | Free-tier limit. Wait a minute and try again. Long sessions can hit it. |
| **System audio (unavailable)** / only your side is transcribed | System-audio capture works best on Windows. On macOS it needs extra permissions or a loopback device; Echo falls back to mic only. |
| "Gesture model missing - run npm install" | Run `npm install` (or `npm run gestures:fetch`). If the file is damaged: `npm run gestures:fetch -- --force`. |
| Camera access denied | Windows: Settings > Privacy & security > Camera, allow camera access and **Let desktop apps access your camera**. macOS: System Settings > Privacy & Security > Camera. |
| Blank or frozen window | Check the terminal you ran `npm start` from for `[renderer ...]` error lines. `Ctrl+Shift+Space` or the tray's **Reset window position** brings a lost window back. |
| "doesn't know the model" | Set `GEMINI_MODEL` in `.env` to a current Gemini Flash model and restart. |

`Ctrl+Shift+D` opens a diagnostics panel with recent request timings, errors and the "Speech end → first answer word" latency (last value and average). It never shows keys.

## Building the installer

For maintainers. On Windows, with Node.js 20+:

```bash
npm install
npm run dist
```

This writes `dist/Echo-Setup-<version>.exe` (NSIS, x64). `npm run dist` first re-checks the hand-gesture files and stops if any are missing (fix: `npm run gestures:fetch`). `npm run pack` builds just the unpacked app in `dist/` for a quick test.

To publish a release, set `version` in `package.json`, commit, and push a matching tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions (`.github/workflows/release.yml`) then builds the installer on Windows and attaches it to the release for that tag. CI (`ci.yml`) runs the tests on Windows and Ubuntu for every push and pull request to `main`.

## Project structure

```
src/
  main/          Electron main process (Node)
    main.js        window, tray, shortcuts, permissions, IPC handlers
    preload.js     the only bridge to the UI (window.assistant)
    ai.js          Groq + Gemini calls, prompts, streaming
    ai-requests.js cancels stale answer requests
    keyStore.js    encrypted key storage (+ .env fallback)
    knowledge.js   keyword search over your notes
    env.js         tiny .env loader
  renderer/      the overlay UI (no Node access)
    index.html, renderer.js, styles.css
    gesture-core.js, gestures.js   experimental hand gestures
scripts/         fetch-gesture-assets.js (runs on npm install)
test/            npm test
docs/            ARCHITECTURE.md
assets/          tray icons
build/           installer icon (electron-builder)
```

How the pieces fit together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing and license

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md) for reporting vulnerabilities. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

[MIT](LICENSE) © 2026 conoorsheedy-oss. Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
