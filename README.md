# Echo (open edition)

A small always-on-top desktop overlay that transcribes your calls and suggests what to say next, using **your own free API keys**.

- **Live transcript** of you (mic) and them (system audio), with Groq Whisper (free) or, optionally, **Deepgram Nova-3** for word-by-word live captions and faster answers.
- **Suggested answers** when the other side asks a question, or any time with **Generate**.
- **Screenshots, your own notes, and a chat box** for extra context.
- **No Echo server, no login, no credits.** It talks straight to Groq or Deepgram (speech-to-text) and Google Gemini (answers).
- Free and open source ([MIT](LICENSE)).

> **Use it responsibly.** Echo is for interview *practice*, mock interviews and meetings where everyone knows it's running. Many interviews, exams and employers forbid AI help during live assessments, and recording people without consent is illegal in many places. Follow the rules that apply to you. You are responsible for how you use it.

## Download (Windows)

1. Download `Echo-Setup-x.y.z.exe` from the [Releases page](https://github.com/conoorsheedy-oss/Echo/releases) and run it.
2. Windows may show **"Windows protected your PC"**. Echo isn't code-signed yet, so click **More info** > **Run anyway**.
3. Pick an install folder. The installer adds Desktop and Start menu shortcuts; uninstall from Windows Settings > Apps.
4. On first run Echo opens **Settings**: paste two free keys (Groq and Gemini, see the table below) and click **Save keys**.

The installer is Windows-only for now. macOS and Linux are untested (system-audio capture especially), so run from source there.

## Easiest setup from source (Windows): double-click `setup.cmd`

Cloned (or downloaded) the repo? Double-click **`setup.cmd`** in the Echo folder. It:

1. checks Git and Node.js, and offers to install Node.js LTS with `winget` if yours is missing or older than 22 (then asks you to re-open it),
2. updates the folder with `git pull` (local `package.json` / `package-lock.json` changes from an earlier `npm install` are discarded if you say yes; anything else is put aside with `git stash`),
3. runs `npm install` (retried, because GitHub downloads sometimes fail with 504),
4. asks: **A** build and install the desktop app (default; then click **More info** > **Run anyway** on the SmartScreen warning), or **B** just run it now with `npm start`.

It never asks for API keys: you paste those into Echo's Settings. If it stops, read the message above the "Press any key" line.

## Quick start (from source)

You need [Node.js](https://nodejs.org) **22.12 or newer**. The first `npm start` downloads the Electron runtime (~100 MB from GitHub) if it isn't there yet; if that download fails (GitHub sometimes answers 504), run `npm run electron:fetch` to retry.

```bash
git clone https://github.com/conoorsheedy-oss/Echo.git
cd Echo
npm install
npm start
```

On first run Echo opens **Settings**. Paste two free keys (Groq and Gemini; Deepgram is an optional third) and click **Save keys** (Echo then tests them):

| Key | Used for | Get one |
|---|---|---|
| Groq | Speech-to-text (Whisper). Optional if you pick Deepgram (then it's the fallback) | https://console.groq.com/keys |
| Gemini | Answers, chat, summaries | https://aistudio.google.com/apikey |
| Deepgram (optional) | Live speech-to-text (Nova-3), only if **Speech-to-text** is set to Deepgram. $200 free credit, no card; about $0.46/hour after that | https://console.deepgram.com/signup |

You can reopen Settings any time from the `⋯` menu > **API keys**.

## Using it

The window has three parts: a slim **top bar**, the **answer card** (most of the window), and an icon **dock** along the bottom.

**Top bar**

- **Start / Stop** records your mic and system audio. With Groq (default), speech is sent at natural pauses (about half a second after someone stops talking), and silence is never uploaded. With **Deepgram**, words appear live. The dot next to the name is green while listening, and Stop pulses red.
- **Mode** (the dropdown): Interview, Meeting, Presentation, General. Each has its own answer style and its own idea of what needs an answer: Interview answers questions; Meeting also helps when someone pushes back on you, proposes something, raises a blocker or asks for ideas, and stays quiet for updates and small talk (it may also decide there's nothing worth adding and show nothing).
- **`⋯` menu**: API keys & settings, keyboard shortcuts, Focus mode, hand gestures, Hide from screen share, Hide (keep running), Quit Echo.
- **Closing:** the **×** button quits Echo completely. To tuck it away but keep it running, use **⋯ → Hide (keep running)** or `Ctrl+Shift+Space`. Opening Echo again while it's running just brings the existing window back.
- **Compact bar** (the bar icon or `Ctrl+Shift+K`) shrinks Echo to just the latest answer; **×** hides Echo (`Ctrl+Shift+Space` brings it back).
- Small icons appear next to the name only while something is on: thinking dots, **Privacy Mode**, **Hidden from screen share**, **Gestures**.

**Answer card**

- When they finish a question, a first sentence to say appears in large text, usually within about a second (**Instant first line**, see Settings). The full answer follows and takes over that line, with the rest below it, so you can start talking while it arrives. Press **Generate** (`Ctrl+Enter`) to get one any time, even without listening.
- An automatic answer never replaces the one you're reading: a **New answer ready** chip appears in the card's header instead, as soon as the new answer has its first line. Click it when you're ready; if the answer is still being written, the rest streams in.
- **Script / Cues** (toggle at the top left of the card): **Script** gives full spoken sentences, one per line. **Cues** gives a first line to say, then 3–4 bold keywords to talk around in your own words, which sounds more natural than reading.
- The toolbar under an answer has **Shorten**, **Expand**, **Regenerate** (icons, hover for the name) and **Copy**.
- Answers are written to sound like a person talking: contractions, plain words, no "Great question" or em dashes. Facts from your CV or notes are re-said in plain words, never copied.

**Dock** (each icon opens a drawer over the lower part of the window; click it again, the drawer's ×, or press `Esc` to close)

- **Live transcript:** the conversation as `You:` / `Them:`. The dock icon counts new lines while the drawer is closed, and the Mic / System audio dots in its header glow while voice is detected.
- **Ask the assistant:** a chat box for follow-up questions about the conversation.
- **Knowledge base:** **Add files** to add your CV or notes (`.txt` / `.md`). Only the snippets that match a question are sent. The dock icon shows how many files are loaded.
- **Screen context:** pick which screen or window to capture and manage the screenshot tray. The dock icon shows how many screenshots are attached.
- **Summarize** (`Ctrl+Shift+M`): summary, decisions, action items and open questions. Copy it or export it.
- **Camera** (right end of the dock): one tap adds a screenshot to the tray. Up to **4 screenshots** go with your next answer or question. `Ctrl+Shift+S` captures and answers in one go.

**Modes of the window**

- **Focus mode** (`⋯` menu or `Ctrl+Shift+E`): hides the dock so the answer card fills the window.
- **Privacy Mode** (`Ctrl+Shift+P`): pauses screen capture and automatic answers. Manual Generate still works.
- **Hide from screen share** (`⋯` menu or `Ctrl+Shift+H`): asks the OS to hide Echo from screen sharing and recording. Off by default, never remembered between launches, and a red eye icon shows in the top bar while it's on. Only use it when the people you're sharing with know. It doesn't work with every capture tool.
- **See-through** (Settings > Appearance > **Transparency**, or `Ctrl+Shift+T`): lets you see the call or your code editor behind Echo while you read. Only the background fades; the text stays solid. See [Settings](#settings).
- **Click-through** (`Ctrl+Shift+X`): clicks go to the app underneath, and Echo dims so you can tell. With see-through on it dims less, because the background is already thin.

### How Echo keeps track of the interview

In Interview mode Echo keeps a running log of the interview in memory (never saved; cleared on Stop, Clear transcript and quit): which questions belong together, what the interviewer pinned down ("assume the input is sorted"), what **you** actually said, and what Echo only suggested. Each answer gets a short, labelled summary of that state: your own words are marked `[You said]`, facts from your CV `[From CV: file]`, the interviewer's `[Interviewer]`, and Echo's earlier suggestions `[Echo suggested — not confirmed]`, so a follow-up like "why that approach?" is answered in terms of what you said (if you went with two pointers instead of the suggested hash map, the answer follows you), and something you never said is never treated as yours. A behavioural follow-up ("what did you learn?") stays with the story you told. The instant first line and the full answer get the same summary and the same one-line direction, so they agree. When it's unclear which earlier question a follow-up is about, the prompt says so and lets the model decide from the wording. Other modes are unchanged.

## Keyboard shortcuts

On macOS, `Ctrl` is `Cmd`. These work even when Echo isn't focused.

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+Space` | Show / hide Echo (also brings it back if it's off-screen) |
| `Ctrl+Enter` | Generate an answer now |
| `Ctrl+Shift+S` | Capture the screen and answer |
| `Ctrl+Shift+M` | Summarize the session |
| `Ctrl+Shift+E` | Focus mode (hide the dock) on/off |
| `Ctrl+Shift+K` | Compact bar on/off |
| `Ctrl+Shift+C` | Clear the transcript |
| `Ctrl+Shift+X` | Click-through on/off (clicks go to the app underneath) |
| `Ctrl+Shift+T` | See-through background on/off (Solid ↔ your Transparency level) |
| `Ctrl+Shift+P` | Privacy Mode on/off |
| `Ctrl+Shift+H` | Hide from screen share on/off |
| `Ctrl+Shift+D` | Diagnostics panel |

Inside Echo, `Esc` closes the open menu, panel or drawer.

`Ctrl+Shift+T` is a global shortcut too, so while Echo runs it isn't available to other apps (in browsers it normally reopens a closed tab).

## Hand gestures (experimental, off by default)

Webcam shortcuts for when your hands are off the keyboard. Turn them on in `⋯` menu > **Hand gestures** > **Use webcam hand gestures as shortcuts**. A hand icon shows in the top bar while the camera is on; click it to turn gestures off.

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

- **Speech-to-text** (Settings, top):
  - **Groq Whisper** (free, default): audio is sent in clips cut at pauses, so each line appears shortly after the speaker pauses.
  - **Deepgram Nova-3** (live, faster): audio streams while someone talks and words appear as they're spoken; the end of a question is detected about 0.3 s after they stop. Needs a Deepgram key ($200 free credit, no card; about $0.46 per hour of streamed audio after that, and each side is its own stream). Echo only streams while someone is talking. If Deepgram fails (bad key, out of credit, network), Echo reconnects up to 3 times, then switches to Groq when a Groq key is set.
- **Quality vs speed** (Settings > Answers) sets how hard Gemini thinks before answering:
  - **Auto** (default): in Interview mode, `high` only for a **new problem to solve**: "write a function...", "given an array...", "design a URL shortener", a maths / probability / puzzle question, a long technical problem statement, or a problem on attached screenshots. **Follow-ups about your code** ("why did you use a hash map?", "what's the complexity?", "what if the input is empty?", "how would you test it?") use `low` and get a short spoken answer (a first line plus 1-3 lines, and at most a tiny snippet of the changed code) instead of the full walk-through. Behavioural questions and the other modes use `low` too.
  - **Fast**: always `low`, quickest answers.
  - **Max**: always `high`, best quality but slower.
- **Answer style** (Settings > Answers, or the Script / Cues toggle on the answer card): **Script** (default) or **Cues**.
- **Instant first line** (Settings > Answers, on by default): with every answer, Echo also asks Gemini for just the first sentence to say (a tiny request with minimal thinking and a trimmed context), and shows it as soon as it arrives. When the full answer's own first sentence is ready, it replaces that line in place and the rest appears below; Copy, Shorten, Expand and the answer history always use the full answer. If the full answer is quicker, the first line is skipped. Turn it off to save free-tier quota: it's one extra small Gemini request per answer.

- **Transparency** (Settings > Appearance): how see-through Echo's background is, from **0%** (solid, the original look) to **85%**, with **Solid** (0%), **Light** (30%, the default) and **Glass** (60%) presets. It applies live as you drag (Settings previews the level while you hold the slider) and is remembered on this computer. `Ctrl+Shift+T` switches between Solid and your level.
  - Only backgrounds fade. Text and icons stay fully opaque (Echo never fades the whole window). As the background thins, text gets a soft dark outline, the answer text gets slightly bolder, grey labels get lighter, and buttons on the window frame get a small dark backing, so it stays readable over white pages and busy video.
  - The answer card is always a bit darker than the frame around it (about 73% opaque at 30%, 58% at 85%). Drawers, menus and toasts stay almost solid (at most 12% / 10% see-through) because they sit over the answer text; Settings, Summary and Diagnostics at most 20%, and the main view under them is hidden.
  - The compact bar and Focus mode use the same level. With click-through on (`Ctrl+Shift+X`) the whole overlay is dimmed on top of it: to 55% when solid, less as you go clearer (about 67% at 30%, 89% at 85%) so the text stays readable.
  - If your system asks for reduced transparency (Windows: Settings > Accessibility > Visual effects > Transparency effects off; macOS: Reduce transparency), Echo stays solid and the slider is disabled.
  - Echo's blur only blurs its own content: Windows doesn't blur other apps' windows behind a transparent Electron window, so what's behind shows through sharp. Pick the level that's comfortable over your own call and editor.

### How Echo keeps answers fast

- **End of speech**: with Deepgram, a question is answered the moment Deepgram reports the speaker has stopped (`speech_final`, about 0.2 s after the last word; `DEEPGRAM_ENDPOINTING_MS` changes that pause). With Groq, audio is cut 0.55 s after someone stops and a question is answered 150 ms after it's transcribed. Questions are recognised by their wording ("what's the complexity", "walk me through your code", "write a function...") even without a question mark; a line that trails off ("and the...") waits up to 1.5 s for the rest.
- **First line first**: the instant first line usually lands well before the full answer, which may still be thinking. It's written by the newest stable Gemini **Flash-Lite** your key can use, found once per run from Gemini's model list (until that lookup finishes, and if there's none, it uses `GEMINI_MODEL`); full answers always use `GEMINI_MODEL`.
- **Thinking only where it pays**: `high` thinking is kept for new problems; follow-ups and everything else use `low`.
- **Prompt order**: the long, growing transcript goes first and the question last, so Gemini can reuse ("implicitly cache") the unchanged start of the prompt between questions.
- `Ctrl+Shift+D` shows the split for the last answer: end of speech → request sent → first line → first word of the full answer.
- **Models** (when running from source): copy `.env.example` to `.env` to override them, then restart Echo:
  - `GEMINI_MODEL` (default `gemini-3.5-flash`). Google retires older Flash models, so if answers say the model is unknown, set a current Gemini Flash id from Google AI Studio.
  - `GEMINI_HEADLINE_MODEL` (default: unset = pick the newest stable Flash-Lite automatically): the model for the instant first line only. If it's unknown to your key, Echo uses `GEMINI_MODEL` for the first line instead. `Ctrl+Shift+D` > Models shows which one is in use.
  - `GROQ_STT_MODEL` (default `whisper-large-v3-turbo`).
  - `DEEPGRAM_MODEL` (default `nova-3`) and `DEEPGRAM_LANGUAGE` (default `en`; `multi` for Nova-3 multilingual).
  - `DEEPGRAM_ENDPOINTING_MS` (default `200`, allowed `100`-`1000`): how long a pause Deepgram waits for before it calls the end of speech. Lower answers sooner; raise it (e.g. `300`) if questions get cut at a breath.
- `.env` can also hold `GROQ_API_KEY` / `GEMINI_API_KEY` / `DEEPGRAM_API_KEY` as a developer fallback. Keys saved in the app take priority.

## Privacy

| What | Goes to | When |
|---|---|---|
| Audio chunks (mic + system audio) | **Groq**, with your key | While listening (Speech-to-text = Groq, or as Deepgram's fallback) |
| Live audio stream (mic + system audio, only while someone is talking) | **Deepgram** ([console.deepgram.com](https://console.deepgram.com)), with your key | While listening with Speech-to-text = Deepgram |
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
| "Deepgram rejected your API key" (HTTP 401/403) | Create a new key at [console.deepgram.com](https://console.deepgram.com), paste it into Settings and click **Test keys**. Keys with restricted permissions may also be refused. |
| "Deepgram account is out of credit" (HTTP 402) | Add credit in the Deepgram console, or set **Speech-to-text** back to Groq. Echo switches to Groq for the session if a Groq key is set. |
| Live transcript not appearing (Deepgram) | Check the Mic / System audio dots (Live transcript drawer) glow when people talk (Echo only streams while it hears voice). Open `Ctrl+Shift+D`: "Audio chunks" should say `Deepgram live (worklet, open)`; `reconnecting` or a banner means the connection dropped. A changed Speech-to-text setting applies the next time you press Start Listening. Firewalls must allow `wss://api.deepgram.com`. |
| `git pull` refuses: "local changes would be overwritten" | Run `setup.cmd` (it offers to discard `package.json` / `package-lock.json` changes and stashes anything else), or run `git checkout -- package.json package-lock.json` yourself. |
| `npm install` / `npm run dist` fails on Node 18 or 20 | Install Node.js 22.12 or newer (LTS) and run it again. `setup.cmd` can install it for you. |
| "Electron failed to install correctly" on `npm start` | The Electron runtime download failed (usually a GitHub 504). Run `npm run electron:fetch` until it succeeds, then `npm start`. |
| Linux (Wayland): the window doesn't stay on top or forgets its position | Electron runs as a native Wayland app there, and Wayland doesn't let apps position or pin windows. Start it under XWayland: `npm start -- --ozone-platform=x11`. |
| "rate limit hit" (HTTP 429) | Free-tier limit. Wait a minute and try again. Long sessions can hit it. |
| **System audio (unavailable)** / only your side is transcribed | System-audio capture works best on Windows. On macOS it needs extra permissions or a loopback device; Echo falls back to mic only. |
| "Gesture model missing - run npm install" | Run `npm install` (or `npm run gestures:fetch`). If the file is damaged: `npm run gestures:fetch -- --force`. |
| Camera access denied | Windows: Settings > Privacy & security > Camera, allow camera access and **Let desktop apps access your camera**. macOS: System Settings > Privacy & Security > Camera. |
| Blank or frozen window | Check the terminal you ran `npm start` from for `[renderer ...]` error lines. `Ctrl+Shift+Space` or the tray's **Reset window position** brings a lost window back. |
| "doesn't know the model" | Set `GEMINI_MODEL` in `.env` to a current Gemini Flash model and restart. |

`Ctrl+Shift+D` opens a diagnostics panel with recent request timings, errors, the "Speech end → first answer word" latency (last value and average, counting whichever came first: the instant first line or the full answer) and the split for the last answer (speech end → request, request → first line, request → full answer). It never shows keys.

## Building the installer

For maintainers. On Windows, with Node.js 22.12+:

```bash
npm install
npm run dist
```

This writes `dist/Echo-Setup-<version>.exe` (NSIS, x64). `npm run dist` first downloads the Electron runtime into `node_modules/electron/dist` if it isn't there yet (since Electron 42, `npm install` no longer does), then re-checks the hand-gesture files and stops if any are missing (fix: `npm run gestures:fetch`). `npm run pack` builds just the unpacked app in `dist/` for a quick test.

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
    ai.js          Groq + Gemini calls, prompts, streaming, key tests
    deepgram.js    Deepgram live WebSockets (one per speaker)
    deepgram-core.js  Deepgram URL, message parsing, errors (pure)
    ai-requests.js cancels stale answer requests
    suggest-pipeline.js  full answer + parallel instant first line
    keyStore.js    encrypted key storage (+ .env fallback)
    knowledge.js   keyword search over your notes
    env.js         tiny .env loader
  renderer/      the overlay UI (no Node access)
    index.html, renderer.js, styles.css
    vad-core.js    voice-activity detection (pure)
    pcm-core.js, pcm-worklet.js    16 kHz PCM for Deepgram
    stt-core.js    which keys the speech-to-text choice needs
    question-core.js  is a line a question, and how long to wait (pure)
    gesture-core.js, gestures.js   experimental hand gestures
scripts/         fetch-gesture-assets.js (runs on npm install)
setup.cmd/.ps1   one-click Windows setup from source
test/            npm test
docs/            ARCHITECTURE.md
assets/          tray icons
build/           installer icon (electron-builder)
```

How the pieces fit together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing and license

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md) for reporting vulnerabilities. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

[MIT](LICENSE) © 2026 conoorsheedy-oss. Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
