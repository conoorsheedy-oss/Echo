# Changelog

## 0.1.0 – unreleased

First open-source, bring-your-own-keys release.

- Always-on-top overlay that transcribes your mic ("You") and system audio ("Them") in ~6 s chunks with Groq Whisper.
- Automatic answer suggestions when the other side asks a question, plus Generate (`Ctrl+Enter`), Shorten, Expand, Regenerate and Copy.
- Streaming answers from Google Gemini; automatic answers wait behind a "New answer ready" chip instead of replacing the one you're reading.
- Interview, Meeting, Presentation and General modes; Quality vs speed setting (Auto / Fast / Max).
- Screenshot tray (up to 4), knowledge base from your own `.txt` / `.md` files, chat box, and session summaries with export.
- Compact bar, Focus mode, Privacy Mode, hide from screen share (opt-in), click-through, diagnostics panel and global shortcuts.
- Experimental webcam hand gestures (off by default, processed locally with MediaPipe).
- API keys encrypted with the OS keychain via Electron `safeStorage`; no Echo server, no login, no credits.
