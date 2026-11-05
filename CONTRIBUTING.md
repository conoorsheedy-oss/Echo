# Contributing

Thanks for helping out. Echo is deliberately small: plain Electron, no framework, no bundler, very few dependencies.

## Setup

```bash
npm install     # also fetches the hand-gesture runtime + model
npm start       # run the app
npm test        # unit tests (no Electron needed)
```

Add your own Groq + Gemini keys in the app (`⋯` menu > **API keys**) or copy `.env.example` to `.env`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit.

## Code style

- Plain JavaScript, 2-space indent, single quotes, semicolons. Match the code around you.
- In `renderer.js` the preload wrapper **must stay named `api`**. A top-level `const assistant` clashes with the `window.assistant` global and stops the whole script from loading.
- **Keys never reach the renderer.** Provider calls live in `src/main/ai.js`; the UI can only save or remove keys.
- **Never log secrets:** no keys, request bodies, transcripts or full provider error bodies.
- **Keep the CSP strict:** no inline scripts or styles, nothing loaded from the network in `index.html`.
- **New IPC channel?** Add it to `preload.js` and a validating `handle()` in `main.js`.
- Every `getElementById` must match an element in `index.html`. `gestures.js` clicks real buttons by ID, so don't rename those IDs without updating it.
- Comments explain *why*, briefly. No heavy dependencies when ~50 lines of plain JS will do.

## Before opening a PR

```bash
npm test
for f in $(git ls-files '*.js'); do node --check "$f" || exit 1; done
```

Then run the app and try the flow you changed (Start/Stop Listening, Generate, Ask, Summarize, screenshots, Settings). Keep PRs focused and say how you tested (OS + Electron version).

**Never** include real API keys, transcripts or personal knowledge files in commits, screenshots or issues.

## Reporting bugs

Open an issue with steps to reproduce, your OS, and what the diagnostics panel (`Ctrl+Shift+D`) shows. Redact anything personal. Security problems go through [SECURITY.md](SECURITY.md) instead.

By contributing, you agree your contributions are licensed under the MIT License.
