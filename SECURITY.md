# Security policy

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately with GitHub's **private vulnerability reporting**: the repository's **Security** tab > **Report a vulnerability**. Include:

- what the issue is and its impact,
- steps to reproduce (a small proof of concept helps),
- your OS and Echo version.

You should get a reply within a few days. Please allow reasonable time for a fix before disclosing publicly.

**Never paste API keys into issues, PRs, screenshots or logs**, even old ones.

## How keys are handled

- Keys pasted into the app are encrypted with Electron `safeStorage` (DPAPI / Keychain / libsecret) and stored as ciphertext in `keys.enc.json` in the app's user-data folder. Without OS encryption, Echo refuses to save them and asks you to use `.env`.
- `.env` keys are read by the main process only. `.env` is git-ignored.
- Keys never reach the renderer; the UI only gets "is a key set" booleans.
- Keys are sent only to their own provider (`api.groq.com`, `generativelanguage.googleapis.com`) in request headers, never in URLs, and are never logged.

In scope: any way to get a key into the renderer, logs, URLs or another host; to open arbitrary URLs or navigate the window; to bypass the CSP; or to use the camera, mic or screen capture without the user turning it on.

## If you leaked a key

Revoke it right away at https://console.groq.com/keys or https://aistudio.google.com/apikey and create a new one. Deleting a commit doesn't make a pushed key safe.

## Supported versions

Only the latest version on the default branch.
