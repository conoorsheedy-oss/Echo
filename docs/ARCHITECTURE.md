# Architecture

Echo is a plain Electron app: no framework, no bundler. Three pieces:

```
┌──────────── Renderer (src/renderer) ─────────────┐
│ index.html + renderer.js + styles.css             │  the overlay UI
│ vad-core.js   voice-activity chunking (pure)      │  no Node, strict CSP
│ pcm-core.js + pcm-worklet.js  PCM for Deepgram    │
│ stt-core.js   speech-to-text key readiness (pure) │
│ question-core.js  question? when to answer (pure) │
│ intent-core.js  intent + needs a reply? (pure,    │
│                 also required by main)            │
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
│ suggest-pipeline.js  answer + instant first line  │
│ keyStore.js   encrypted keys (safeStorage)        │
│ knowledge.js  keyword search over your notes      │
│ interview-session.js  threads, facts, CV query    │
│               (pure, memory only)                 │
└───────────────────────────────────────────────────┘
```

- **Main** owns everything privileged: API keys, network calls, files, screen capture, global shortcuts and permissions.
- **Preload** exposes a fixed list of functions as `window.assistant`. `renderer.js` wraps it as `api` (it can't be a top-level `const assistant`: that clashes with the `window.assistant` global and kills the script). The wrapper restores `err.code` / `err.status` from errors (main tags them onto the message, because IPC only carries the message).
- **Renderer** is the UI. It never sees an API key and has no Node access (`contextIsolation: true`, `nodeIntegration: false`).

### Renderer layout

`index.html` is three rows inside `#app`: the top bar (`#header`: status dot, status badges, Start/Stop, mode, `⋯` menu, compact, hide), the answer card (`#suggestion-section`: Script / Cues toggle, **New answer ready** chip and Generate in its header, the answer text or an empty state, and the Shorten / Expand / Regenerate / Copy toolbar as its footer), and the dock (`#dock`). Transcript, chat, knowledge base and screen context are `.drawer` sections inside `#drawers`, absolutely positioned above the dock; `setOpenDrawer()` in `renderer.js` shows one at a time and `Esc` closes the topmost thing (menu, full-window panel, drawer). Dock badges (unread transcript lines, knowledge files, attached screenshots) are set with `setDockBadge()`. Settings, Summary and Diagnostics are full-window panels on top.

- **IDs are the contract.** `renderer.js` and `gestures.js` look elements up by ID, and gestures fire actions by clicking the real buttons (`#generate-btn`, `#listen-btn`, `#capture-screen-btn`, `#clear-screen-btn`, the Copy button in `#suggestion-actions`). Move elements freely, but keep the IDs.
- **Icons** are an inline SVG sprite at the top of `index.html` (`<symbol id="i-…">`, 24px grid, stroke only), used as `<svg class="icon"><use href="#i-name"/></svg>`. They were drawn for Echo; there is no icon font or remote asset (the CSP allows none). Buttons with an icon keep their text in a `.btn-label` / `.menu-label` span, and code changes it with `setBtnLabel()` so the icon survives.
- **Styles** are token-based (`:root` in `styles.css`): one spacing scale, one radius scale, one icon size. Compact bar (`#app.compact`) and Focus mode (`#app.suggestion-expanded`) are classes on `#app` that hide rows.
- **See-through** (Settings > Appearance > Transparency, `Ctrl+Shift+T`): the window is created `transparent: true` with a fully transparent page background, and the UI paints its own surfaces. `renderer.js` (SEE-THROUGH) stores one level, 0-85 %, in `localStorage` (`echo.transparency`; `echo.transparencyLast` is the level `Ctrl+Shift+T` restores), and writes it to the `--see-through` CSS variable on `<html>`, plus `data-see-through` while it's above 0. Every surface alpha in `:root` derives from that variable (`--bg-app` frame, `--bg-card` extra fill under the answer, `--bg-drawer` / `--bg-menu` / `--bg-overlay` capped at 12 / 10 / 20 %, `--code-bg`), and section 10 of `styles.css` adds the legibility protection that scales with it: a text halo (`--text-halo`, inherited from `#app`, set explicitly on form controls), an icon `drop-shadow`, lifted `--text-muted` / `--text-subtle`, a heavier answer weight, and a dark backing behind the frame's ghost controls and tinted chips. `BrowserWindow.setOpacity` is never used (it would fade text too). `prefers-reduced-transparency: reduce` forces `--see-through: 0`. Click-through (`#app.click-through`) only changes `#app`'s opacity (`0.55 + 0.4 × see-through`), so the two stack.

## IPC channels

All `invoke` channels are handled in `main.js` with `handle()`, which validates payloads.

| Area | Renderer → main (`invoke` unless noted) | Main → renderer (events) |
|---|---|---|
| Audio | `desktop:get-audio-source`, `stt:transcribe`, `stt:stream-start`, `stt:stream-stop`, `stt:stream-audio` (send) | `stt:stream-event` |
| Answers | `ai:suggest`, `ai:ask`, `ai:summarize`, `summary:export`, `session:reset` | `ai:chunk` (`{ requestId, part: 'answer' \| 'headline', text }`) |
| Keys | `keys:status`, `keys:save`, `keys:remove`, `keys:test`, `external:open` | |
| Screen | `screen:list-sources`, `screen:capture` | |
| Knowledge | `knowledge:status`, `knowledge:reload`, `knowledge:open-folder`, `knowledge:add-files` | |
| Window | `window:set-compact`, `window:hide` (send), `window:minimize` (send) | `window:compact-changed`, `window:visibility-changed` |
| Privacy | `privacy:status`, `content-protection:status`, `content-protection:toggle` | `hotkey:privacy-mode-changed`, `hotkey:content-protection-changed` |
| Gestures | `gestures:set-enabled`, `gestures:status`, `gestures:load-model` | |
| Misc | `config:status`, `clipboard:write-text` | `hotkey:generate`, `hotkey:clear`, `hotkey:click-through-changed`, `hotkey:capture-screen`, `hotkey:summarize`, `hotkey:toggle-expand`, `hotkey:diagnostics`, `hotkey:toggle-transparency` |

## Speech-to-text flow

1. **Start** opens the mic and system audio (a `getUserMedia` desktop-capture stream, `chromeMediaSource: 'desktop'` with the screen id from `desktop:get-audio-source`, whose video track is dropped).
2. Each stream gets its own Web Audio `AnalyserNode` (never connected to the speakers) and its own `VadSegmenter` from `vad-core.js`. Every 40 ms the renderer reads the RMS loudness of the last ~21 ms of samples and feeds it to the segmenter.
3. A `MediaRecorder` is **always running** on each stream, so the first syllable is never lost waiting for "speech started". The segmenter answers each reading with:
   - **cut**: speech happened and then `SILENCE_MS` (550 ms; was 700 ms) of quiet followed, or someone talked for `MAX_CHUNK_MS` (12 s) without pausing. The next recorder starts first, then the finished one stops and uploads. One recorder per chunk means every chunk is a complete, standalone webm/opus file.
   - **reset**: the recording has no speech in it after `IDLE_RESET_MS` (2.5 s). It's thrown away: silent audio is never uploaded.
   - Chunks are never shorter than `MIN_CHUNK_MS` (800 ms), and less than `MIN_SPEECH_MS` (200 ms) of voiced audio (a click or cough) doesn't count as speech.
4. **Threshold**: `max(MIN_THRESHOLD (0.01 RMS ≈ -40 dBFS), 3 × noise floor)`. The noise floor is the quietest moment of the last ~3 s (speech dips to the background level between words), smoothed: it rises slowly (2 s) and falls fast (0.3 s), capped at 0.03. Hysteresis keeps a trailing-off word voiced down to 70% of the threshold. A cut also needs 3 quiet readings, so a throttled page can't cut on one sample (`main.js` turns off `backgroundThrottling` so the 40 ms timer keeps running while the overlay is hidden).
5. Fallback: if Web Audio isn't available, or the `AudioContext` isn't running after 2 s, that stream goes back to fixed 6 s chunks (`CHUNK_MS`). Diagnostics shows which mode is active.
6. Each uploaded chunk goes to `stt:transcribe` → `ai.transcribeAudio()` → Groq Whisper (`verbose_json`). Tiny chunks and Whisper's "thanks for watching" hallucinations are dropped.
7. Lines are appended in recording order per stream as `You:` (mic) or `Them:` (system audio), with the chunk's cut reason and the time its speech ended.
8. **Stop Listening** discards the chunk in progress (as before); a chunk already cut at a pause still gets transcribed.

## Live speech-to-text with Deepgram (optional)

Settings > **Speech-to-text** picks the provider (`renderer.js` keeps it in `localStorage` as `echo.sttProvider`; it applies on the next Start). `stt-core.js` decides what Start needs: Gemini always, plus Groq (Groq mode) or Deepgram (Deepgram mode). In Deepgram mode Groq is optional and only used as the fallback.

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

1. **Start**: for each stream the renderer calls `stt:stream-start` (`{ speaker }`). Main opens a WebSocket with `model=nova-3`, `smart_format=true`, `interim_results=true`, `endpointing=300`, `utterance_end_ms=1000`, `vad_events=true`, `encoding=linear16`, `sample_rate=16000`, `channels=1`, `language=en` (`DEEPGRAM_MODEL` / `DEEPGRAM_LANGUAGE` in `.env` override the last two). The key goes in the handshake's `Authorization: Token <key>` header via the `ws` package: the WHATWG `WebSocket` (global in Electron 45's Node 24) can't set headers. (Deepgram's `token` subprotocol alternative would put the key in `Sec-WebSocket-Protocol`, which is logged more readily.) The invoke resolves once the socket is open, or rejects with a coded error: `BAD_KEY` (401/403), `NO_CREDIT` (402), `RATE_LIMIT` (429), `OFFLINE` / `TIMEOUT`, `NO_KEY`.
2. **Audio**: `stt:stream-audio` is fire-and-forget (`ipcRenderer.send`, ~10 frames/s per stream while someone talks). Main checks the sender is Echo's own page and that the frame is bytes with an even length ≤ 1 s of audio, then forwards it as a binary WebSocket message. A few frames are queued while (re)connecting.
3. **Idle**: the renderer stops sending 1.5 s after the last voiced VAD frame (longer than `utterance_end_ms`, so Deepgram still sees the pause). Main then sends `{"type":"Finalize"}` (0.8 s after the last frame) and `{"type":"KeepAlive"}` every 5 s (Deepgram closes idle streams after ~10 s; its docs suggest 3-5 s).
4. **Transcripts**: `deepgram-core.js` turns `Results` / `UtteranceEnd` into renderer events `{ speaker, kind }`:
   - `interim` `{ text }`: settled words of the utterance + the latest guess. Shown as one dimmed line per speaker at the bottom of the transcript, replaced in place. Never sent to Gemini.
   - `final` `{ text, endOfSpeech }`: on `speech_final`, `UtteranceEnd` or a `Finalize` flush (`endOfSpeech: true`); a line that runs past 15 s without a pause is cut with `endOfSpeech: false`.
   - `end-of-speech`: `UtteranceEnd` after a line that was cut for length.
   The renderer feeds finals to the same `appendLine()` as Groq chunks, as `cut: 'silence'` (end of speech) or `cut: 'max'` (mid-speech). So question detection, de-dup and the "Speech end → first answer word" latency (speech end = last voiced VAD frame) work the same way. A final with `endOfSpeech` is also marked `live`, so a question in it is answered with no extra wait (the 300 ms endpointing pause already happened). `end-of-speech` (and an `UtteranceEnd`-driven final) releases a question that was waiting for its second half, or cuts a 1.5 s "maybe there's more" wait short.
5. **Drops**: an unexpected close reconnects after 0.5 s, 1.5 s, 3.5 s (the budget resets after 10 s of stable connection). Bad audio (1008) and auth/credit closes don't retry. After that main sends `{ kind: 'error', fatal: true, code, message }`; the renderer shows a banner and switches that stream to the Groq recorder if a Groq key is set, otherwise stops listening.
6. **Stop**: `stt:stream-stop` sends `{"type":"CloseStream"}`; Deepgram returns the last finals and closes (force-closed after 3 s). Finals arriving right after Stop are still added, like a Groq chunk already cut at a pause. Removing keys (`keys:remove`), the window closing or the renderer crashing also close every stream.
7. **Privacy Mode** works as before: it pauses automatic answers, not transcription. Keys, audio and transcripts are never logged; only HTTP statuses / close codes are.

## Suggestion flow

0. **Intent layer** (`src/renderer/intent-core.js`, pure, rule-based, no API calls; loaded as a classic script after `question-core.js` and `require()`d by `ai.js` / `suggest-pipeline.js`). `classifyIntent(text, { mode, speaker, prior, recentYou, hasImages })` returns `{ intent, confidence, needsResponse, technical }`. Intents: `direct_question`, `opinion_request`, `follow_up`, `disagreement`, `proposal`, `suggestion_request`, `clarification_request`, `problem`, `information_sharing`, `explanation_request`, `behavioural_question`, `technical_question`, `no_response` (fillers / acknowledgements / under three words). It reuses `question-core.js`'s `looksLikeQuestion()` and owns `looksTechnical()` / `classifyQuestion()` (moved from `ai.js`, which re-exports them unchanged). `needsResponse` by mode:
   - **interview**: exactly `looksLikeQuestion()`, so interviews trigger as they always did.
   - **meeting**: any question-type intent, proposals and problems; disagreement only when it plausibly answers the user (they spoke within the last 2 `Them` lines and 60 s, or the line asks them directly).
   - **presentation**: question-type intents (including explanation / clarification).
   - **general**: question-type intents and disagreement.
   - Never for `You` lines, information sharing or fillers. `shouldAutoTrigger(intent, { mode, speaker })` is the renderer's gate.

1. A `Them:` line that needs a response (`autoTriggerDecision()` in `renderer.js`: in interviews, one that looks like a question) schedules an automatic answer. `question-core.js` decides:
   - **Is it a question?** A `?` anywhere, or interrogative wording at the start of a clause: what / why / how / which / who, can / could / would / do / did / have you, is it / is there / are there, tell me, walk / talk me through, explain, describe, give me an example, what if, how about, any edge cases, and interview tasks given as instructions ("Write a function...", "Implement...", "Given an array..."). Set-ups ("Let's say we have a million users.") are not questions.
   - **How long to wait** (`autoSuggestDelay()`): Deepgram final at end of speech (`speech_final`) on a question: **0 ms**. A question chunk the VAD cut at a pause (Groq): **150 ms**. Another finished sentence at a pause: 300 ms. A line that trails off (`...`, a trailing comma, "and the", "um"), a mid-speech cut or fixed chunks: 1.5 s.
   - A chunk cut mid-speech (the 12 s safety cut, or fixed-chunk fallback) with no `?`: Echo waits for their next chunk first.
   Any new `Them:` line restarts the wait. The same question, or fewer than 12 new characters from them since the last automatic answer, never re-fires.
   (No speculative start on Deepgram *interim* text: with 300 ms endpointing, `speech_final` arrives about as soon as a "no new words for ~350 ms" timer would fire, and starting from interim text would mean sending provisional transcript lines and paying for a restart whenever the final differs.)
   Statements that need a reply (a disagreement, a proposal) use the same timing: 300 ms after a finished sentence at a pause, never mid-utterance. Diagnostics shows **Last auto trigger** (fired / not needed / skipped, with the intent).
2. `renderer.js` calls `ai:suggest` with a `requestId`, the whole transcript, mode, earlier answers, quality setting, **answer style** (`script` / `cues`), `intent` + `intentConfidence`, any tray screenshots and `headline` (Settings > Answers > **Instant first line**, `localStorage` `echo.instantHeadline`, default on).
3. `main.js` validates the payload (mode against `ai.MODES`, unknown → `general`; intent against `ai.INTENTS`, unknown → recomputed), updates the interview session state and searches the knowledge base with its query (see **Interview session state** below), registers the request in `ai-requests.js` and hands it to `suggest-pipeline.js`, which first calls `ai.analyzeSuggestion()` ONCE (question kind, intent, `allowNoResponse` = automatic request outside interviews) and passes the same analysis to `ai.generateSuggestion()` and, when `headline` is on, `ai.generateHeadline()`, run in parallel:
   - Both share the request's `AbortSignal`, so a superseding request cancels both HTTP requests.
   - Chunks go out as `ai:chunk` with `part: 'headline'` or `part: 'answer'`.
   - If the full answer's first text arrives before any headline text, the headline call is aborted and never shown. When the full answer finishes (or fails), a still-running headline call is aborted. A failing headline is logged by error code only and never affects the full answer.
   - **Nothing to add**: outside interviews, an automatic request may get the sentinel `[[NO_RESPONSE]]` back. Every stream's start is held back until it can't be the sentinel (usually one character, so no visible delay). On the sentinel from either call, both calls are aborted and the invoke resolves `{ skipped: true, reason: 'no_response' }`; the renderer drops it silently (no chip, no panel change, no history). Explicit requests are never skipped: a sentinel headline is dropped and a sentinel full answer becomes a short fallback line. The sentinel never reaches the renderer, the humanizer or the markdown renderer.
   - Otherwise the invoke resolves with the full answer only.
4. `ai.js`:
   - **Instant first line** (`generateHeadline()`): its own short system prompt ("give ONLY the first sentence the user should say out loud right now, in their voice", plus the same banned AI tells / no em dashes), `thinkingLevel: 'minimal'` on Gemini 3 (nothing sent on 2.x), 80 visible output tokens, the last ~8k chars of transcript + the last two answers (they hold the code a follow-up is about) + knowledge snippets + screenshots, streamed through the `humanize.js` filter, never retried without streaming.
   - **Full answer**: `classifyQuestion()` labels the question:
     - `problem`: a NEW problem to solve. Strong signals on their own: a code fence, "coding question", "here's a puzzle/problem", "the problem is", probability / expected value / how many ways / estimate how many, "given an array/string/tree...", "minimum number of / longest substring...". With a technical keyword (`looksTechnical()`), also an ask plus a solve verb ("can you reverse...", "write / implement / design / find / return...", "how would you design..."). Long technical prompts (≥ 40 words) that don't reference existing code. Screenshots, unless the question is a short follow-up to an earlier answer.
     - `followup`: a technical question about existing work or a quick conceptual one: why did/do you..., why not, what if / what happens / what about, complexity / big O, can you explain / walk me through, how would you test / handle / optimize, edge cases, trade-offs, "your code / solution / approach", "does it handle...". A short (< 25 words) question that opens like a follow-up is one even if it also says "find" or "return". A technical question with no task in it is treated as conceptual (follow-up). Plain-word follow-ups ("what if the input is empty?") count only when one of the last two answers was technical.
     - `general`: everything else (behavioural, small talk, meetings).
   - Thinking (`resolveThinkingLevel()`): **Auto**: interview → `high` only for `problem`, `low` for `followup` and `general`; meeting / presentation / general → `low`. **Fast** = always `low`, **Max** = always `high`.
   - Output budget (`answerTokensFor()`): `problem` 2560 visible tokens, `followup` 700, `general` 400, Shorten / Expand 900; plus thinking headroom (minimal 256, low 1536, medium 3072, high 8192), because Gemini 3 counts thinking against `maxOutputTokens`. The cap never slows an answer; it only stops a runaway one.
   - The question type also adds a one-line format hint at the end of the prompt (new problem: full walk-through; follow-up: short spoken answer, no full code again). That's interview mode; the other modes get a one-line **intent hint** instead (e.g. "Intent: disagreement ... respond thoughtfully, not defensively"), a short technical hint for a new problem, and for automatic requests the "you may reply `[[NO_RESPONSE]]`" line. All of it is in LATEST, so the system prompt stays fixed per (mode, style).
   - **Prompt layout** (`buildConversation()` / `buildUserParts()`): system instruction (the same for every question in a mode/style) → full transcript (append-only, the long stable prefix) → earlier answers → knowledge snippets → screenshots note, then the screenshots as image parts, then a final text part `=== LATEST ===` (last lines, the question/instruction, the format hint). Gemini's implicit caching reuses a shared prefix, so the block that only grows at its end goes first; the knowledge snippets (searched with the question itself) and the newest answer change on almost every question, so they go after it. Putting them first would make the shared prefix stop at the system prompt.
   - It streams from `streamGenerateContent?alt=sse`. Each text piece goes through the `humanize.js` stream filter and is sent back as an `ai:chunk` event. If the stream breaks, the full answer retries once without streaming.
5. The renderer shows the answer. The **first sentence is rendered big** (`p.headline`) as soon as it starts streaming, so the user can start talking while the rest arrives. A sentence only ends at `. ! ?` followed by whitespace, so text already on screen never re-flows. Script answers then show one sentence per line; Cues answers a short bold-keyword list.
   - **Headline → full answer handoff** (`streamView()` in `renderer.js`): the instant first line shows first (only its first sentence). The full answer streams in behind it, invisibly, until its own first sentence is complete (or its first line is code / a list). Then, in one frame, its first sentence replaces the headline text in the same slot and its body appears below. Nothing was below the headline, so nothing moves down; the only change is that line's wording. Keeping the headline on top of the full answer's body was rejected: the body (for a coding answer, the code) follows from the full answer's own first sentence, and this way what's on screen always matches Copy / Shorten / Expand / history. `#suggestion-text[data-source]` is `headline` or `answer`.
   - An answer you asked for (Generate, `Ctrl+Enter`, Regenerate, Shorten, Expand, `Ctrl+Shift+S`) streams straight into the panel, headline first.
   - An **automatic** answer that arrives while another answer is showing is held back behind a **New answer ready** chip. The chip appears as soon as that answer has a first line (headline or full); clicking it while it is still streaming hands it the panel, and the rest streams in. The visible text only changes when you click. There is no timer-based auto-swap (see "CALM ANSWERS" in `renderer.js`).
6. Superseding: a new explicit request cancels every suggestion in flight; a new automatic one only cancels older automatic ones (`AbortController` per request, shared by the full answer and its headline).

Chat (`ai:ask`) works the same way (same question classifier and thinking policy, no instant first line) but streams into the chat log. Summaries (`ai:summarize`) use a plain request with a JSON schema.

**Latency stat** (Diagnostics, `Ctrl+Shift+D`): time from the end of the speech in the latest `Them` chunk (last voiced VAD frame) to the first streamed token of the answer that followed, from **either** call (instant first line or full answer), last value and average of the last 10, with the speech-to-text share shown separately. **Last answer timing** splits the latest request: end of speech → request sent, request → first instant-first-line token, request → first full-answer token (measured in the renderer, so IPC is included).

## Interview session state (Phase 2a)

`src/main/interview-session.js` is pure (no Electron, no I/O, no API calls). `main.js` keeps one session in memory for the current listening session (`liveInterview`). It is never written to disk; `session:reset` (sent by the renderer on **Stop** and **Clear transcript**) drops it, and quitting loses it. In 2a it changes only one thing an answer sees: the **knowledge snippets** (CV lookup). The prompts, thinking level, format, classification, streaming and cancellation are untouched; the state is exposed through `getThreadContext()` for Phase 2b.

**Per request** (`ai:suggest`): `planKnowledgeSearch()` ingests the transcript, links the request's question (or, with no question and no instruction, the latest interviewer question), and returns `{ query, prefer, threadId, questionId, link, label, generation, afterLine }`. `main.js` searches with `query` (+ `prefer`), runs the answer as before, then `recordSuggestion()` logs the finished answer (not skipped / sentinel answers; a stale `generation` after a reset is ignored). Any exception in the session layer resets it and falls back to the old query. Everything is synchronous: about 5 ms per request on a 1,000-line session; a full rebuild of 1,000 lines (first request after a reset) about 50-120 ms.

**Ingestion** (`ingestTranscript()`): the renderer resends the whole transcript every time; only lines past the previously seen prefix are processed. A transcript that no longer extends that prefix (cleared / new session) resets the state; one whose oldest lines were trimmed (the renderer's ~990k-char cap) carries on, keeping absolute line indexes. A `Them` line is a **question** when `question-core.looksLikeQuestion()` says so or `intent-core.classifyIntent()` gives a question-type intent; the second half of a question cut mid-sentence (`endsMidThought()`) joins the same question. Other `Them` lines and every `You` line attach to the current question / thread.

**Items** (every stored record, `session.items`):

| field | values |
|---|---|
| `type` | `interviewer_statement` (a `Them` line), `candidate_statement` (a `You` line, or a knowledge snippet used for the thread), `echo_suggestion` (a whole suggestion, or one atomic detail / code block from it), `confirmed_detail`, `inferred` (thread type, link decision) |
| `status` | `stated`, `suggested`, `confirmed`, `inferred`, `superseded` (an older link decision after re-resolution, an older code block, a confirmation made in the wrong thread) |
| `source` | `{ kind: 'transcript', ref: absolute line index }`, `{ kind: 'suggestion', ref: requestId }`, `{ kind: 'knowledge', ref: file name }`, `{ kind: 'rule', ref: rule name }` |
| also | `id`, `text` (verbatim for lines and snippets), `threadId`, `questionId`, `order`, `timestamp`, `labels`, and `confidence` on `inferred` items |

Rule-based categories are **labels** (`{ label, confidence, source: { kind: 'rule' } }`) on an item that keeps its true type and source: `question`, `problem_statement`, `constraint` ("assume", "you can't use", "in O(1) space", "n up to 10^5", "the input is sorted"), `interviewer_fact` ("we use Go on the backend", "our team", "the role involves"), `transition`, `candidate_claim` (first-person experience: "I built / led / worked on", "at my last internship"), `knowledge_snippet`.

**Threads** (`session.threads`): `{ id, number, title (first question), type (behavioural | technical_problem | concept | experience | system_design | other) + typeConfidence, openedAt, status (open | answered | merged), questionIds (opening), followUpIds, interviewerLineIds, candidateLineIds, suggestionIds, pinned: { problemStatement, constraints, interviewerFacts, candidateClaims, confirmedDetails }, code (latest suggested code block, always `suggested`), knowledgeSources }`. Arrays hold item ids; `getThreadContext()` returns copies of the items.

**Linking** (`decideLink()`, scores per interpretation: `new`, or `follow_up` of each of the 20 most recent threads; confidence = top / sum of the top three):
- Explicit transition ("next question", "let's move on", "switching gears", "different topic"), in the question or a line just before it: **new**, 0.95.
- Reference back ("going back to", "earlier you mentioned", "you said earlier", "circle back to"): +0.7 to the thread sharing the most terms (or, with none, the latest technical thread for "solution / code / approach", the latest behavioural one for "project / team / story").
- New problem (`classifyQuestion() === 'problem'`): new +0.5. Behavioural opener (`intent-core` `behavioural_question`): new +0.45.
- Technical follow-up (`classifyQuestion() === 'followup'`) or behavioural follow-up ("what was the outcome", "what did you learn", "what would you do differently", "how did the team react", intent-core `follow_up`): +0.45 to the current thread, or to the latest thread of the matching kind when the current one is the other kind.
- Short pronoun reference ("walk me through that"): +0.35 to the current thread; if the current thread has no answer yet and an earlier one does, +0.2 current / +0.4 earlier (deliberately ambiguous).
- Type change (technical vs behavioural): new +0.25. Term overlap: +0.15 per shared word (max 4), +0.2 more for 2+ shared words with an older thread. No marker and no shared words: new +0.2.
- **Provisional** when confidence < **0.6** (`LINK_CONFIDENCE_THRESHOLD`): the best interpretation is used, the others stay in `link.alternatives` / `interpretations`. Later evidence re-resolves it: lines attached to the question are scored against each interpretation's thread (shared words, +2 when the candidate says a detail Echo suggested in that thread), and a later confident follow-up of one of them adds 1. When one thread leads with ≥ 2 and a margin ≥ 1.5, the question (and its lines, suggestions and snippets) moves there; the old link item becomes `superseded`, an emptied thread becomes `merged`. An explicit transition settles a provisional link as it is.

**Confirmation** (per detail, never per suggestion): `extractDetails()` pulls atomic details from each suggestion: complexities (`O(n log n)`), named data structures / techniques ("hash map", "two pointers", "BFS"), languages / tools, numbers with units / percentages, and names that also appear in the knowledge snippets used for it. A detail becomes a `confirmed_detail` only when a candidate line in the **same thread**, spoken after the request was made, contains it: normalised exact phrase or a small alias table ("O(n)" = "o of n" = "linear time"; "hash map" = "hashmap" = "hash table" = "dictionary"; "BFS" = "breadth first search"), not right after a negation ("instead of sorting"). The confirmed item records the suggestion id, the detail item, the candidate line id / index / verbatim text and the alias matched. Unconfirmed details stay `suggested` and are never candidate facts; code is never confirmed.

**Knowledge query** (`buildKnowledgeQuery()`): a question that opens its own thread is searched exactly as before (the question text), so its snippets and prompt are byte-identical. A follow-up searches with the question + the thread's original question + (technical) the problem statement + names the candidate said in the thread + up to three of their claim lines + confirmed details, never Echo's unconfirmed suggestion text. Snippets already used for the thread are passed as `prefer` to `knowledge.searchKnowledge(query, topK, { prefer })`, which multiplies their score by 1.5 only if they still match (still top 4 overall; without `opts` the ranking is unchanged). Outside Interview mode, and for Shorten / Expand without a question, the query is the old one (`question || instruction || last line`).

Diagnostics shows the last answer's thread: `#3 follow-up (0.82)` or `#4 follow-up? (0.45, alt: follow-up of #3)`.

## Answer voice and style

Prompts live in `ai.js`. The suggest system prompt is `MODE_INTROS[mode]` + one shared core (`GROUNDING`, `HUMAN_VOICE` with the banned tells and three tone examples, `SCRIPT_STYLE` / `CUES_STYLE`, then the context / screen / knowledge notes) with one `MODE_NOTES[mode]` block after the answer style:

- **interview**: STAR for behavioural questions, experience questions grounded or `[placeholders]`, and `TECHNICAL_STYLE` (new-problem walk-through vs follow-up).
- **meeting**: help the user contribute to a discussion, not answer an exam: opinion → a clear position + one reason; disagreement → acknowledge, then hold with a reason / concede part / propose a test (never automatically defensive or agreeing); proposal → a benefit, a risk or question, or an improvement; ideas → one or two; problem → a next step or a clarifying question; clarification → restate simply. The first line can be a question. 1-3 lines, no summarising the meeting back, technical only when the discussion is.
- **presentation**: short talking points; audience question → direct answer + one supporting point; a bridge back to the main point if the user is lost.
- **general**: a natural reply (answer, explain, suggest or ask back), no interview framing.
- Every non-interview block allows `[[NO_RESPONSE]]` for automatic requests only. STAR and the coding walk-through appear only in interview mode. The headline prompt has matching per-mode lines.

- `HUMAN_VOICE` (suggest) asks for how people actually talk: contractions, plain words, short varied sentences, first person, concrete specifics, an occasional "So," / "Yeah, so" / "Honestly," opener. It bans common AI tells ("Great question", "Certainly", "leverage", "delve", "spearheaded", "robust", "seamless", "in conclusion", em dashes, three-adjective lists, "Not only X but Y") and includes three BEFORE (stiff AI) → AFTER (spoken) examples. The chat prompt gets the same ban list.
- Knowledge files (CV / notes) are for **facts only**; the prompt says never to copy their wording, because CVs are often AI-written.
- **Answer style** (`answerStyle`, validated in `main.js`): `SCRIPT_STYLE` = a headline sentence, then 1-3 short spoken sentences, one per line, STAR for behavioural questions; `CUES_STYLE` = a headline sentence, then 3-4 `- **keyword** detail` cues, no full sentences. `TECHNICAL_STYLE` covers both styles with two formats: (A) a new problem gets the spoken summary line, a 3-5 step numbered walk-through, one complete code block (or the final number / design) and complexity; (B) a follow-up or conceptual question gets the headline plus 1-3 short lines, no walk-through, no full code again, at most a tiny block of the changed lines. The renderer stores the choice in `localStorage` (`echo.answerStyle`).
- `humanize.js` is a safety net after the model: em dashes (and en dashes used as dashes between words) become commas, or disappear next to punctuation / at line edges, outside code fences; a stock opener at the very start ("Great question!", "Certainly.", "I'd be happy to help!") is removed. The stream version holds back only what it can't decide yet (the first word or two, trailing spaces/dashes), so every streamed piece is a prefix of the final answer.

## Key storage

`keyStore.js` encrypts keys with Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret/KWallet on Linux) and writes only ciphertext to `keys.enc.json` in the app's user-data folder. It uses the asynchronous API (`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`; the synchronous calls are deprecated in Electron 45 and removed in 46, and keys saved by older Echo versions still decrypt). `main.js` awaits `keyStore.init()`, which decrypts the saved keys into memory, before it opens the window, so `getKey()` stays synchronous. If OS encryption isn't available, it refuses to save (use `.env` instead); on Linux that includes the `basic_text` fallback (no keyring), which the async API would otherwise accept. The renderer only gets booleans plus where each key came from (`saved` / `env`). Keys are sent only to their own provider, in headers, and never logged.

## Hand gestures

`gestures.js` (opt-in) opens the webcam at 320×240, runs MediaPipe's GestureRecognizer locally (WebAssembly, CPU) about 12 times a second, and feeds results to `HoldDetector` in `gesture-core.js`. A sign must be held (0.8 s, 1.2 s for the fist) with ≥70% confidence; then a 1.5 s cooldown applies and the same sign must be released before it can fire again. Each action **clicks the real button** by ID, so it runs the same code as a click. `main.js` grants the camera only to Echo's own page and only while gestures are on. The runtime and model are copied/downloaded by `scripts/fetch-gesture-assets.js` into the git-ignored `src/renderer/vendor/mediapipe/`, and the model bytes are read by main (`gestures:load-model`).

## Security notes

- **CSP** (`index.html`): `default-src 'self'`, `connect-src 'self'` (the page can't call the internet; main does), no inline scripts or styles. `'wasm-unsafe-eval'` is only there so MediaPipe's WebAssembly can run.
- The window denies new windows and navigation. `external:open` only opens three allowlisted key pages (Groq, Gemini, Deepgram sign-up).
- The CSP is unchanged by Deepgram mode: the AudioWorklet module (`pcm-worklet.js`) is a same-origin file, which `script-src 'self'` already allows, and the WebSocket is opened by main, not the page.
- Permissions are deny-by-default and only for Echo's own page: the mic (`media`, audio), clipboard writes (`clipboard-sanitized-write`), the camera (`media`, video) only while gestures are on, and desktop capture for system audio (`display-capture`, which Electron 45+ uses for `chromeMediaSource` requests) only for a few seconds after the renderer calls `desktop:get-audio-source`.

## Tests

`npm test` runs Node's built-in test runner (no Electron needed):

- `test/gesture-core.test.js`: the hold-to-confirm state machine with synthetic frames.
- `test/vad-core.test.js`: the voice-activity chunker with synthetic RMS frames (speech start, 550 ms silence cut, min/max chunk length, blips, idle reset, adaptive noise floor, hysteresis, throttled frames).
- `test/ai-answers.test.js`: streaming, fallback, cancellation, thinking levels, the new-problem / follow-up classifier (dozens of realistic problem, follow-up and behavioural questions), output budgets, prompt building (voice rules, answer styles, layout and the shared-prefix property) and the `humanize.js` safety net, with `fetch` mocked.
- `test/suggest-pipeline.test.js`: the no-response sentinel (auto skipped silently, never emitted, sibling call cancelled; explicit never skipped), one shared analysis for both calls, and the instant first line + full answer pipeline with fake and real (`fetch`-mocked) Gemini calls: headline first, late headline dropped, failures isolated, one cancellation for both, setting off = no extra call, a timing test where the headline reaches the first visible token well before a delayed full stream, and the headline request itself (minimal thinking, tiny budget, trimmed context, no non-streaming retry).
- `test/interview-session.test.js`: scripted interviews for the session state: technical thread + follow-ups, "let's move on" into a behavioural thread, older-thread references, an ambiguous follow-up kept provisional and re-resolved by the candidate's answer, per-detail confirmation (aliases, negation, same thread, timing), claims / facts / constraints with their sources, resets, a schema check of every item, and the knowledge query with a fixture CV (the follow-up finds the same story; a plain question's snippets and prompt are byte-identical to before).
- `test/question-core.test.js`: question detection by wording, "trailing off" detection and the auto-suggest delays (0 / 150 / 300 / 1500 ms).
- `test/intent-core.test.js`: intent labels for realistic lines of every intent, `needsResponse` per mode (disagreement + recency), interview triggering identical to `looksLikeQuestion()`, never on `You` lines, the mode allowlist and the sentinel helpers.
- `test/deepgram-core.test.js`: listen URL, message parsing, the interim/final assembler (`speech_final`, `UtteranceEnd`, length cuts, `Finalize` flushes), error/close classification, backoff and KeepAlive/Finalize timing, PCM frame validation.
- `test/deepgram-stream.test.js`: `deepgram.js` with a fake WebSocket and clock (auth header, 401/402/429/offline, queueing, KeepAlive, CloseStream, reconnect then fatal error) and the Deepgram key test with `fetch` mocked.
- `test/pcm-core.test.js`: downsampling (48 / 44.1 kHz → 16 kHz, no drift), Int16 conversion, framing and the talk-only audio gate.
- `test/stt-core.test.js`: which keys Start needs per provider, and the banner text.
