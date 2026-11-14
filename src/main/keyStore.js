// Where the user's own API keys live: Groq + Gemini, plus an optional
// Deepgram key (only needed for Settings > Speech-to-text > Deepgram).
//
// 1. Keys pasted into the in-app "API keys" screen are encrypted with
//    Electron's safeStorage (backed by the OS: DPAPI on Windows, Keychain on
//    macOS, libsecret/kwallet on Linux) and written to keys.enc.json in the
//    app's private userData folder. Only ciphertext ever touches disk.
// 2. If nothing is saved there, GROQ_API_KEY / GEMINI_API_KEY from the
//    environment (DEEPGRAM_API_KEY too; or a .env file next to package.json
//    -- see env.js) are
//    used instead. Handy for development.
//
// Keys stay in the main process. The renderer only ever learns booleans
// ("is a key set, and where from") -- never the key itself, not even after
// the user typed it in. If OS-backed encryption isn't available, saving is
// refused rather than silently writing plain text.

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const PROVIDERS = ['groq', 'gemini', 'deepgram'];
const ENV_VARS = { groq: 'GROQ_API_KEY', gemini: 'GEMINI_API_KEY', deepgram: 'DEEPGRAM_API_KEY' };
const LABELS = { groq: 'Groq', gemini: 'Gemini', deepgram: 'Deepgram' };

function keysFile() {
  return path.join(app.getPath('userData'), 'keys.enc.json');
}

// Decrypted keys, held in memory for this run only (so the OS keychain isn't
// hit on every audio chunk). Filled once at startup by init() -- main.js
// awaits it before opening the window, so getKey() can stay synchronous --
// and updated in place by saveKeys() / removeKeys().
//
// safeStorage's asynchronous API is used throughout: the synchronous
// isEncryptionAvailable/encryptString/decryptString are deprecated in
// Electron 45 and removed in 46. Ciphertext written by the old synchronous
// API decrypts fine with decryptStringAsync (same per-platform key stores).
let cache = {};
let encStatus = { available: false, reason: 'OS-backed encryption has not been checked yet.' };
let initPromise = null;

async function checkEncryption() {
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      return { available: false, reason: 'Your system has no OS-backed encryption available for Electron.' };
    }
    // On Linux without a keyring, Electron falls back to a hardcoded
    // password ("basic_text") -- that's obfuscation, not encryption. The
    // async API reports itself available even then, so check the backend.
    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
      const storageBackend = safeStorage.getSelectedStorageBackend();
      if (storageBackend === 'basic_text' || storageBackend === 'unknown') {
        return { available: false, reason: 'No system keyring (e.g. GNOME Keyring / KWallet) was found.' };
      }
    }
    return { available: true, reason: '' };
  } catch (err) {
    return { available: false, reason: 'OS-backed encryption could not be checked.' };
  }
}

function readSavedFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(keysFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {}; // first run, or unreadable -- treat as "nothing saved"
  }
}

function writeSavedFile(next) {
  fs.mkdirSync(path.dirname(keysFile()), { recursive: true });
  // Write-then-rename so a crash mid-write can't leave a half-written file.
  const tmp = `${keysFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, keysFile());
}

async function encrypt(value) {
  return (await safeStorage.encryptStringAsync(value)).toString('base64');
}

async function loadSaved() {
  encStatus = await checkEncryption();
  const out = {};
  const file = readSavedFile();
  if (!encStatus.available) return out;
  const reEncrypt = {};
  for (const p of PROVIDERS) {
    if (typeof file[p] !== 'string' || !file[p]) continue;
    try {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(file[p], 'base64'));
      out[p] = result;
      if (shouldReEncrypt) reEncrypt[p] = result;
    } catch (err) {
      // Encrypted on another machine/user account, or the keyring changed.
      console.error(`[keys] Could not decrypt the saved ${p} key -- please paste it again.`);
    }
  }
  // The OS rotated the key (or a stronger one is available): store fresh
  // ciphertext. Best-effort -- the old ciphertext still decrypts meanwhile.
  if (Object.keys(reEncrypt).length) {
    try {
      const next = { ...file };
      for (const [p, v] of Object.entries(reEncrypt)) next[p] = await encrypt(v);
      writeSavedFile(next);
    } catch (err) {
      console.error('[keys] Could not re-encrypt the saved keys:', err.message);
    }
  }
  return out;
}

// Call once after app 'ready' (safeStorage needs it); safe to call again.
function init() {
  if (!initPromise) {
    initPromise = loadSaved().then((keys) => {
      cache = keys;
    });
  }
  return initPromise;
}

function envKey(provider) {
  const v = process.env[ENV_VARS[provider]];
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

// Main-process only. Saved key wins over .env.
function getKey(provider) {
  if (!PROVIDERS.includes(provider)) return '';
  return cache[provider] || envKey(provider);
}

function sourceOf(provider) {
  if (cache[provider]) return 'saved';
  if (envKey(provider)) return 'env';
  return null;
}

// The ONLY key information the renderer ever gets.
function getStatus() {
  const enc = encStatus;
  const groqSource = sourceOf('groq');
  const geminiSource = sourceOf('gemini');
  const deepgramSource = sourceOf('deepgram');
  return {
    groqKeySet: !!groqSource,
    geminiKeySet: !!geminiSource,
    deepgramKeySet: !!deepgramSource,
    groqSource, // 'saved' | 'env' | null
    geminiSource,
    deepgramSource,
    canSave: enc.available,
    cannotSaveReason: enc.available ? '' : enc.reason,
  };
}

// Light sanity check only -- real validation is "Test keys", which asks the
// provider. Keys are opaque tokens: no whitespace, sane length.
function validateKey(provider, value) {
  if (typeof value !== 'string') throw new Error('Invalid key.');
  const v = value.trim();
  if (!v) return '';
  if (v.length < 10 || v.length > 400 || /\s/.test(v)) {
    const label = LABELS[provider] || 'API';
    throw new Error(`That doesn't look like a ${label} API key -- copy it again from the provider's page.`);
  }
  return v;
}

// keys: { groq?, gemini?, deepgram? } (strings) -- empty/missing fields are left as they are.
async function saveKeys(keys = {}) {
  await init();
  const enc = encStatus;
  if (!enc.available) {
    const err = new Error(
      `${enc.reason} Echo won't store keys in plain text -- put GROQ_API_KEY and GEMINI_API_KEY (and DEEPGRAM_API_KEY if you use it) in a .env file instead (see README).`
    );
    err.code = 'NO_SAFE_STORAGE';
    throw err;
  }
  const updates = {};
  for (const p of PROVIDERS) {
    if (keys[p] === undefined || keys[p] === null) continue;
    const v = validateKey(p, keys[p]);
    if (v) updates[p] = v;
  }
  if (!Object.keys(updates).length) {
    throw new Error('Paste at least one key first.');
  }

  const file = readSavedFile();
  const next = {};
  for (const p of PROVIDERS) if (typeof file[p] === 'string' && file[p]) next[p] = file[p];
  for (const [p, v] of Object.entries(updates)) {
    next[p] = await encrypt(v);
  }
  next.updatedAt = new Date().toISOString();

  writeSavedFile(next);
  cache = { ...cache, ...updates };
  return getStatus();
}

// Deletes the saved (encrypted) keys. Keys coming from .env / the
// environment can't be removed from inside the app -- getStatus() still
// reports them as source 'env' so the UI can say so.
function removeKeys() {
  try {
    fs.unlinkSync(keysFile());
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error('Could not remove the saved keys file.');
  }
  cache = {};
  return getStatus();
}

module.exports = { init, getKey, getStatus, saveKeys, removeKeys };
