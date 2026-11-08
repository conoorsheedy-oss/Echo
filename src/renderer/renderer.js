// Echo overlay UI. Talks to the main process only through window.assistant
// (preload.js), wrapped below as `api`. vad-core.js loads before this file
// (window.EchoVadCore); gestures.js loads after it and uses
// window.echoGestureBridge (bottom of this file).

// ---- State ----
// Audio is cut into chunks at pauses (voice-activity detection, see "Audio
// chunking" below and vad-core.js). CHUNK_MS is only the fallback chunk
// length when Web Audio isn't available.
const CHUNK_MS = 6000;
const VAD_MAX_CHUNK_MS = (window.EchoVadCore && window.EchoVadCore.MAX_CHUNK_MS) || 12000;
// A "?" anywhere, or a question starter at the start of the chunk or after a
// pause word/punctuation. A chunk can still hold several sentences, so a
// question often lands mid-chunk ("yeah so, what's your approach here").
const QUESTION_RE = /\?|(?:^|[.!,;:]\s+|\b(?:and|so|but)\s+)(?:what|why|how|when|where|who|which)(?:'?s)?\b|(?:^|[.!,;:]\s+|\b(?:and|so|but)\s+)(?:can you|could you|would you|do you|did you|have you|are you|is there|tell me|explain|describe)\b/i;

let micStream = null;
let systemStream = null;
let micRecorder = null;
let systemRecorder = null;
let listening = false;

const transcriptLines = []; // { speaker: 'You'|'Them', text, ts }
let lastSuggestion = '';
// Screenshot tray: up to MAX_SCREENSHOTS captures, oldest first. Each is
// { id, name, mimeType, base64, dataUrl, capturedAt } (already downscaled +
// JPEG'd by main.js). All of them go with the next suggestion/question.
const MAX_SCREENSHOTS = 4;
let screenshots = [];
let nextScreenshotId = 1;

// A chunk cut mid-speech (the MAX_CHUNK_MS safety cut, or the fixed-chunk
// fallback) can end half-way through a question that continues in the next
// chunk. These track "we saw the start of a question, don't fire yet -- wait
// for the next chunk from them to actually land so the suggestion answers
// the whole question, not half of it." Chunks cut at a pause don't need this.
let awaitingNextThemLine = false;
let pendingQuestionTimer = null;

let listenBusy = false; // a Start/Stop is in flight -- blocks double clicks
let suggestInFlight = false; // any suggestion request running (header "Thinking" pill)

// Auto-suggest debounce: a detected question fires once the other side has
// stopped talking, and not again for the same question or for a tiny
// transcript change (fewer than MIN_NEW_THEM_CHARS new characters from them
// since the last automatic answer). Any new "Them" line restarts the wait.
//   - A chunk the VAD cut at a pause that ends like a finished sentence
//     ("?", ".", "!"): the pause itself was the end-of-speech signal, so
//     fire after just AUTO_SUGGEST_AFTER_SPEECH_MS.
//   - Anything else (trailing off "...", a mid-speech cut, fixed chunks):
//     wait AUTO_SUGGEST_QUIET_MS for more.
const AUTO_SUGGEST_AFTER_SPEECH_MS = 300;
const AUTO_SUGGEST_QUIET_MS = 1500;
const MIN_NEW_THEM_CHARS = 12;
// Two "Them" lines this close together count as one question ("Re: ..." line).
const QUESTION_JOIN_MS = 10000;
let autoSuggestTimer = null;
let lastAutoQuestionKey = '';
let themCharsTotal = 0;
let themCharsAtLastAuto = 0;

// ---- DOM ----
const statusDot = document.getElementById('status-dot');
const keyWarning = document.getElementById('key-warning');
const listenBtn = document.getElementById('listen-btn');
const micIndicator = document.getElementById('mic-indicator');
const systemIndicator = document.getElementById('system-indicator');
const transcriptEl = document.getElementById('transcript');
const modeSelect = document.getElementById('mode-select');
const generateBtn = document.getElementById('generate-btn');
const suggestionPlaceholder = document.getElementById('suggestion-placeholder');
const suggestionText = document.getElementById('suggestion-text');
const suggestionActions = document.getElementById('suggestion-actions');
const suggestionGrounding = document.getElementById('suggestion-grounding');
const chatLog = document.getElementById('chat-log');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const minimizeBtn = document.getElementById('minimize-btn');
const hideBtn = document.getElementById('hide-btn');
const screenSourceSelect = document.getElementById('screen-source-select');
const refreshSourcesBtn = document.getElementById('refresh-sources-btn');
const captureScreenBtn = document.getElementById('capture-screen-btn');
const clearScreenBtn = document.getElementById('clear-screen-btn');
const screenPreviewRow = document.getElementById('screen-preview-row');
const screenThumb = document.getElementById('screen-thumb');
const screenStatus = document.getElementById('screen-status');
const keepScreenshotsToggle = document.getElementById('keep-screenshots-toggle');
const knowledgeStatusEl = document.getElementById('knowledge-status');
const reloadKnowledgeBtn = document.getElementById('reload-knowledge-btn');
const openKnowledgeFolderBtn = document.getElementById('open-knowledge-folder-btn');
const addKnowledgeFilesBtn = document.getElementById('add-knowledge-files-btn');
const summarizeBtn = document.getElementById('summarize-btn');
const summaryOverlay = document.getElementById('summary-overlay');
const closeSummaryBtn = document.getElementById('close-summary-btn');
const copySummaryBtn = document.getElementById('copy-summary-btn');
const summaryLoading = document.getElementById('summary-loading');
const summaryEmpty = document.getElementById('summary-empty');
const summaryContent = document.getElementById('summary-content');
const summaryTextBlock = document.getElementById('summary-text-block');
const summaryDecisionsEl = document.getElementById('summary-decisions');
const summaryActionsListEl = document.getElementById('summary-actions-list');
const summaryUnresolvedEl = document.getElementById('summary-unresolved');
const appEl = document.getElementById('app');
const expandSuggestionBtn = document.getElementById('expand-suggestion-btn');
const suggestionBodyEl = document.getElementById('suggestion-body');

// API keys (Settings overlay) + screen-share visibility
const apiKeysBtn = document.getElementById('api-keys-btn');
const settingsOverlay = document.getElementById('settings-overlay');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const settingsForm = document.getElementById('settings-form');
const groqKeyInput = document.getElementById('groq-key-input');
const geminiKeyInput = document.getElementById('gemini-key-input');
const groqKeyState = document.getElementById('groq-key-state');
const geminiKeyState = document.getElementById('gemini-key-state');
const openGroqKeysBtn = document.getElementById('open-groq-keys-btn');
const openGeminiKeysBtn = document.getElementById('open-gemini-keys-btn');
const saveKeysBtn = document.getElementById('save-keys-btn');
const testKeysBtn = document.getElementById('test-keys-btn');
const removeKeysBtn = document.getElementById('remove-keys-btn');
const settingsMessage = document.getElementById('settings-message');
const settingsStorageNote = document.getElementById('settings-storage-note');
const hideFromShareBtn = document.getElementById('hide-from-share-btn');
const contentProtectionBadge = document.getElementById('content-protection-badge');

// Header pills, compact bar, summary/diagnostics, answer settings
const liveBadge = document.getElementById('live-badge');
const thinkingIndicator = document.getElementById('thinking-indicator');
const suggestionQuestion = document.getElementById('suggestion-question');
const suggestionError = document.getElementById('suggestion-error');
const compactBtn = document.getElementById('compact-btn');
const shortcutsBtn = document.getElementById('shortcuts-btn');
const toastEl = document.getElementById('toast');
const privacyBadge = document.getElementById('privacy-badge');
const privacyScreenNote = document.getElementById('privacy-screen-note');
const exportSummaryBtn = document.getElementById('export-summary-btn');
const diagnosticsOverlay = document.getElementById('diagnostics-overlay');
const closeDiagnosticsBtn = document.getElementById('close-diagnostics-btn');
const diagnosticsStateEl = document.getElementById('diagnostics-state');
const diagnosticsEventsEl = document.getElementById('diagnostics-events');
const qualitySelect = document.getElementById('quality-select');
const modelNote = document.getElementById('model-note');

// ---- IPC wrapper ----
// Electron only carries an error's message across ipcRenderer.invoke, so
// main.js appends a small "[[echo:{...}]]" marker with the error's code /
// HTTP status. This restores err.code / err.status and strips Electron's
// "Error invoking remote method ..." prefix so messages read cleanly.
const IPC_PREFIX_RE = /^Error invoking remote method '[^']+':\s*(?:[A-Za-z]*Error:\s*)?/;
const IPC_META_RE = /\s*\[\[echo:(\{[^\]]*\})\]\]\s*$/;

function normalizeIpcError(rawErr) {
  let message = String((rawErr && rawErr.message) || rawErr || 'Unknown error').replace(IPC_PREFIX_RE, '');
  let meta = {};
  const m = message.match(IPC_META_RE);
  if (m) {
    try { meta = JSON.parse(m[1]) || {}; } catch (e) { meta = {}; }
    message = message.slice(0, m.index);
  }
  const err = new Error(message || 'Unknown error');
  err.code = meta.code || (rawErr && rawErr.code) || undefined;
  err.status = meta.status || (rawErr && rawErr.status) || undefined;
  return err;
}

// Calls that actually go out to Groq / Gemini -- used for the offline
// banner and the diagnostics panel (local-only calls say nothing about it).
const AI_CALLS = new Set([
  'transcribeChunk', 'generateSuggestion', 'askFollowUp', 'summarizeSession', 'testKeys',
]);

// Named `api`, not `assistant`: a top-level `const assistant` clashes with the
// window.assistant global the preload script exposes (SyntaxError at load).
const api = {};
for (const name of Object.keys(window.assistant)) {
  const fn = window.assistant[name];
  if (typeof fn !== 'function') continue;
  if (/^on[A-Z]/.test(name)) {
    api[name] = fn; // event subscriptions -- nothing to wrap
    continue;
  }
  api[name] = async (...args) => {
    const started = performance.now();
    try {
      const result = await fn(...args);
      noteAiCall(name, true, performance.now() - started);
      return result;
    } catch (rawErr) {
      const err = normalizeIpcError(rawErr);
      noteAiCall(name, false, performance.now() - started, err);
      // A missing key: re-check what's configured (the banner follows).
      // A rejected key: say so in the banner, which opens Settings.
      if (err.code === 'NO_KEY') refreshKeyStatus().catch(() => {});
      else if (err.code === 'BAD_KEY') setBanner('keys', `${err.message} Click here to fix.`);
      throw err;
    }
  };
}

// ---- Banner (top strip) + toast ----
// One banner, highest-priority message wins: keys > offline > service.
const BANNER_PRIORITY = ['keys', 'offline', 'service'];
const bannerState = {};

function setBanner(kind, text) {
  bannerState[kind] = text || null;
  const active = BANNER_PRIORITY.find((k) => bannerState[k]);
  keyWarning.textContent = active ? bannerState[active] : '';
  keyWarning.dataset.kind = active || '';
  keyWarning.classList.toggle('hidden', !active);
}

keyWarning.addEventListener('click', () => {
  if (keyWarning.dataset.kind === 'keys') openSettings();
});

let toastTimer = null;
function showToast(text, ms = 3500) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), ms);
}
toastEl.addEventListener('click', () => toastEl.classList.add('hidden'));

// ---- Offline detection ----
// Flipped on by any Groq/Gemini call failing with OFFLINE (network
// unreachable), off again by any call reaching the provider. There's no
// Echo server to probe, so the next real request is the retry.
let aiOffline = false;

function setOffline(offline) {
  if (offline === aiOffline) return;
  aiOffline = offline;
  setBanner('offline', offline
    ? (navigator.onLine === false
      ? "You're offline -- answers are paused until the connection is back."
      : "Can't reach Groq/Gemini -- check your connection. Echo retries with the next request.")
    : null);
}

window.addEventListener('offline', () => setOffline(true));
window.addEventListener('online', () => setOffline(false));

// ---- Diagnostics (Ctrl+Shift+D): recent AI calls + current state ----
const diagEvents = []; // most recent first
let modelsText = '';

function noteAiCall(name, ok, ms, err) {
  if (!AI_CALLS.has(name)) return;
  if (err && err.code === 'ABORTED') return; // superseded on purpose, not a failure
  diagEvents.unshift({ at: Date.now(), name, ok, ms: Math.round(ms), error: err ? err.message : '' });
  if (diagEvents.length > 40) diagEvents.length = 40;
  // Any HTTP response (even an error status) proves the provider is reachable.
  if (ok || (err && err.status)) setOffline(false);
  else if (err && err.code === 'OFFLINE') setOffline(true);
  if (!diagnosticsOverlay.classList.contains('hidden')) renderDiagnostics();
}

// ---- API keys (bring your own; stored by the main process, never here) ----
// The renderer only ever knows whether each key is set and where it came
// from ('saved' = encrypted in the app's data folder, 'env' = .env file).
let keyStatus = {
  groqKeySet: false, geminiKeySet: false, groqSource: null, geminiSource: null,
  canSave: true, cannotSaveReason: '',
};

function keysReady() {
  return !!(keyStatus.groqKeySet && keyStatus.geminiKeySet);
}

function isKeyError(err) {
  return !!err && (err.code === 'NO_KEY' || err.code === 'BAD_KEY');
}

function describeKeySource(source) {
  if (source === 'saved') return 'Saved';
  if (source === 'env') return 'From .env';
  return 'Not set';
}

function applyKeyStatus(status) {
  if (status && typeof status === 'object') keyStatus = { ...keyStatus, ...status };
  groqKeyState.textContent = describeKeySource(keyStatus.groqSource);
  geminiKeyState.textContent = describeKeySource(keyStatus.geminiSource);
  groqKeyState.classList.toggle('set', !!keyStatus.groqKeySet);
  geminiKeyState.classList.toggle('set', !!keyStatus.geminiKeySet);

  const hasSaved = keyStatus.groqSource === 'saved' || keyStatus.geminiSource === 'saved';
  removeKeysBtn.disabled = !hasSaved;
  testKeysBtn.disabled = !(keyStatus.groqKeySet || keyStatus.geminiKeySet);
  saveKeysBtn.disabled = !keyStatus.canSave;
  groqKeyInput.disabled = !keyStatus.canSave;
  geminiKeyInput.disabled = !keyStatus.canSave;

  const notes = [];
  if (!keyStatus.canSave) {
    notes.push(`Can't save keys securely on this system: ${keyStatus.cannotSaveReason} Put GROQ_API_KEY and GEMINI_API_KEY in a .env file next to package.json instead (see README), then restart Echo.`);
  } else {
    notes.push("Saved keys are encrypted with your operating system's keychain and stored only on this computer. Echo never shows them again after saving.");
  }
  if (keyStatus.groqSource === 'env' || keyStatus.geminiSource === 'env') {
    notes.push('Keys marked "From .env" come from your .env file -- edit or delete that file to change them.');
  }
  settingsStorageNote.textContent = notes.join(' ');

  if (keysReady()) {
    setBanner('keys', null);
  } else {
    const missing = [!keyStatus.groqKeySet && 'Groq', !keyStatus.geminiKeySet && 'Gemini'].filter(Boolean).join(' + ');
    setBanner('keys', `Add your free ${missing} API key${missing.includes('+') ? 's' : ''} to start -- click here.`);
  }
  syncListeningUI();
}

async function refreshKeyStatus() {
  const status = await api.getKeyStatus();
  applyKeyStatus(status);
  return status;
}

function setSettingsMessage(text, kind) {
  settingsMessage.textContent = text || '';
  settingsMessage.dataset.kind = kind || '';
}

function openSettings(message) {
  exitCompact();
  summaryOverlay.classList.add('hidden');
  diagnosticsOverlay.classList.add('hidden');
  settingsOverlay.classList.remove('hidden');
  setSettingsMessage(message || '', message ? 'info' : '');
  refreshKeyStatus().catch(() => {});
  setTimeout(() => {
    if (!keyStatus.canSave) return;
    (keyStatus.groqKeySet && !keyStatus.geminiKeySet ? geminiKeyInput : groqKeyInput).focus();
  }, 0);
}

function closeSettings() {
  settingsOverlay.classList.add('hidden');
  groqKeyInput.value = '';
  geminiKeyInput.value = '';
  setSettingsMessage('');
}

function syncContentProtectionUI(enabled) {
  hideFromShareBtn.textContent = enabled ? 'Hide from Screen Share: On' : 'Hide from Screen Share: Off';
  hideFromShareBtn.classList.toggle('active', enabled);
  contentProtectionBadge.classList.toggle('hidden', !enabled);
}

async function init() {
  syncListeningUI();
  try {
    const { groqModel, geminiModel } = await api.getConfigStatus();
    modelsText = `${groqModel || '?'} (STT), ${geminiModel || '?'} (answers)`;
    modelNote.textContent = `Answers use ${geminiModel || 'the default Gemini model'}. Google retires older Flash models over time -- to use a newer Gemini Flash model, set GEMINI_MODEL in your .env file and restart Echo.`;
  } catch (e) { /* diagnostics only */ }
  try {
    const { enabled: privacyOn } = await api.getPrivacyStatus();
    syncPrivacyUI(privacyOn);
  } catch (e) { /* default (off) is fine */ }

  try {
    await refreshKeyStatus();
  } catch (err) {
    console.error('Could not read API key status:', err.message);
  }
  // First run (or keys removed): go straight to the API keys screen.
  if (!keysReady()) openSettings();

  try {
    const { enabled } = await api.getContentProtectionStatus();
    syncContentProtectionUI(enabled);
  } catch (e) { /* default (off) is fine */ }
}
init();
refreshScreenSources();
refreshKnowledgeStatus();

minimizeBtn.addEventListener('click', () => api.minimizeWindow());
hideBtn.addEventListener('click', () => api.hideWindow());

api.onGenerateHotkey(() => requestSuggestion(undefined, { question: null }));
api.onClearHotkey(() => clearTranscript());
api.onClickThroughChanged((enabled) => {
  appEl.style.opacity = enabled ? '0.55' : '1';
});
api.onCaptureScreenHotkey(() => captureScreen({ andAnswer: true }));
api.onSummarizeHotkey(() => requestSummary());
api.onToggleExpandHotkey(() => setSuggestionExpanded(!suggestionExpanded));
api.onPrivacyModeChanged((enabled) => syncPrivacyUI(enabled));
api.onDiagnosticsHotkey(() => toggleDiagnostics());
api.onCompactChanged((enabled) => applyCompact(enabled));

// ---- Privacy / Presentation Mode (Ctrl+Shift+P, toggled in main.js) ----
// Pauses screen capture and *automatic* suggestions; manual Generate still works.
let privacyModeEnabled = false;
function syncPrivacyUI(enabled) {
  privacyModeEnabled = !!enabled;
  privacyBadge.classList.toggle('hidden', !privacyModeEnabled);
  privacyScreenNote.classList.toggle('hidden', !privacyModeEnabled);
  captureScreenBtn.disabled = privacyModeEnabled;
  // Don't keep sending screenshots taken before Privacy Mode went on.
  if (privacyModeEnabled && screenshots.length) clearScreenshots();
}

// ---- Compact bar (Ctrl+Shift+K): window shrinks to just the latest answer ----
let compactMode = false;
function applyCompact(enabled) {
  compactMode = !!enabled;
  appEl.classList.toggle('compact', compactMode);
  compactBtn.classList.toggle('active', compactMode);
  compactBtn.title = compactMode
    ? 'Back to the full view (Ctrl+Shift+K)'
    : 'Compact bar: show only the latest answer (Ctrl+Shift+K)';
  suggestionBodyEl.scrollTop = 0;
}
function exitCompact() {
  if (compactMode) api.setCompact(false).catch(() => {});
}
compactBtn.addEventListener('click', () => {
  api.setCompact(!compactMode).catch((err) => showToast('Could not switch view: ' + err.message));
});

// ---- Transcript ----
// meta (from the recorder): { cut: 'silence' | 'max' | 'timer', speechEndAt }
//   cut = why the chunk ended; speechEndAt = performance.now() of the last
//   voiced audio in it (for the latency stat in Diagnostics).
let lastThemChunk = null; // { speechEndAt, transcribedAt }

// The chunk ended at a pause and reads like a finished sentence.
function endedAtPause(text, meta) {
  if (!meta || meta.cut !== 'silence') return false;
  const t = text.trim();
  return /[?.!]["')\]]*$/.test(t) && !/(\.\.\.|…)["')\]]*$/.test(t);
}

function autoSuggestDelay(text, meta) {
  return endedAtPause(text, meta) ? AUTO_SUGGEST_AFTER_SPEECH_MS : AUTO_SUGGEST_QUIET_MS;
}

function appendLine(speaker, text, meta = null) {
  if (!text) return;
  transcriptLines.push({ speaker, text, ts: Date.now() });

  const div = document.createElement('div');
  div.className = `line ${speaker === 'You' ? 'you' : 'them'}`;
  div.innerHTML = `<span class="speaker">${speaker}:</span> ${escapeHtml(text)}`;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;

  const delay = autoSuggestDelay(text, meta);
  if (speaker === 'Them') {
    themCharsTotal += text.length;
    const now = performance.now();
    lastThemChunk = {
      speechEndAt: meta && Number.isFinite(meta.speechEndAt) ? meta.speechEndAt : now,
      transcribedAt: now,
    };
    // They're still talking: push a scheduled auto-suggestion back.
    if (autoSuggestTimer) scheduleAutoSuggest(delay);
  }

  // This is the chunk we were waiting for (the rest of a question that
  // spilled over): answer after the quiet window with the fuller text.
  if (awaitingNextThemLine && speaker === 'Them') {
    awaitingNextThemLine = false;
    clearTimeout(pendingQuestionTimer);
    pendingQuestionTimer = null;
    scheduleAutoSuggest(delay);
    return;
  }

  // Auto-suggest when the other side seems to have asked a question.
  if (speaker === 'Them' && QUESTION_RE.test(text.trim())) {
    if (/\?\s*$/.test(text.trim()) || (meta && meta.cut === 'silence')) {
      // Ends with "?", or they stopped talking: the question is done.
      scheduleAutoSuggest(delay);
    } else {
      // A question started but may continue in the next chunk: wait for it
      // (with a safety-net timeout) rather than answering half a question.
      awaitingNextThemLine = true;
      cancelAutoSuggest(); // more is coming -- wait for it instead
      clearTimeout(pendingQuestionTimer);
      pendingQuestionTimer = setTimeout(() => {
        awaitingNextThemLine = false;
        pendingQuestionTimer = null;
        autoSuggest(); // already waited well past the quiet window
      }, (meta && meta.cut === 'max' ? VAD_MAX_CHUNK_MS : CHUNK_MS) + 4000); // one full chunk + generous STT margin
    }
  }
}

// The other side's latest question, for the "Re: ..." line above the answer:
// their last line, plus the one before it if it was part of the same burst
// (a question can span two audio chunks).
function recentThemQuestion() {
  const them = transcriptLines.filter((l) => l.speaker === 'Them');
  if (!them.length) return null;
  const last = them[them.length - 1];
  const prev = them[them.length - 2];
  const parts = prev && last.ts - prev.ts <= QUESTION_JOIN_MS ? [prev.text, last.text] : [last.text];
  return parts.join(' ');
}

function scheduleAutoSuggest(delay = AUTO_SUGGEST_QUIET_MS) {
  clearTimeout(autoSuggestTimer);
  autoSuggestTimer = setTimeout(() => {
    autoSuggestTimer = null;
    autoSuggest();
  }, delay);
}

function cancelAutoSuggest() {
  clearTimeout(autoSuggestTimer);
  autoSuggestTimer = null;
}

function questionKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Automatic (question-detected) suggestion. Privacy Mode pauses these.
function autoSuggest() {
  if (privacyModeEnabled || !listening) return;
  const question = recentThemQuestion();
  const key = questionKey(question);
  if (!key || key === lastAutoQuestionKey) return; // already answered this one
  if (themCharsTotal - themCharsAtLastAuto < MIN_NEW_THEM_CHARS) return; // tiny change
  lastAutoQuestionKey = key;
  themCharsAtLastAuto = themCharsTotal;
  requestSuggestion(undefined, { question, auto: true });
}

// Clearing the transcript starts a fresh session: earlier answers and any
// waiting auto-suggestion go too (the answer on screen stays until replaced).
function clearTranscript() {
  transcriptLines.length = 0;
  transcriptEl.innerHTML = '';
  awaitingNextThemLine = false;
  clearTimeout(pendingQuestionTimer);
  pendingQuestionTimer = null;
  cancelAutoSuggest();
  lastAutoQuestionKey = '';
  themCharsTotal = 0;
  themCharsAtLastAuto = 0;
  lastThemChunk = null;
  answerHistory.length = 0;
  clearPendingAnswer();
}

// The WHOLE session goes with every request (ai.js trims the prompt copy to
// ~100k chars, oldest lines first). This cap only keeps the IPC payload
// under main.js's 1,000,000-char limit in an extremely long session.
const MAX_SEND_TRANSCRIPT_CHARS = 990_000;
function buildTranscriptText() {
  const lines = transcriptLines.map((l) => `${l.speaker}: ${l.text}`);
  let total = lines.reduce((n, l) => n + l.length + 1, 0);
  let start = 0;
  while (total > MAX_SEND_TRANSCRIPT_CHARS && start < lines.length - 1) {
    total -= lines[start].length + 1;
    start += 1;
  }
  return lines.slice(start).join('\n');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- Minimal markdown rendering for AI answers ----
// Not CommonMark: headings, **bold**, *em*, `code`, ``` fences and simple
// lists -- what the prompts in ai.js ask for. Stray LaTeX ($..$, \mathcal)
// is stripped. Everything is escaped first, and any input is coerced to a
// string so a bad value can never break the panel.
function toRenderableString(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function renderInline(str) {
  let s = escapeHtml(toRenderableString(str));
  s = s.replace(/\\mathcal\{([^}]*)\}/g, '$1');
  s = s.replace(/\\text\{([^}]*)\}/g, '$1');
  s = s.replace(/\$([^$\n]+)\$/g, '$1');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return s;
}

// If the parser itself throws, show plain escaped text instead.
function safeRenderMarkdown(value) {
  try {
    return renderMarkdown(value);
  } catch (err) {
    console.error('renderMarkdown failed, falling back to plain text:', err);
    return `<p>${escapeHtml(toRenderableString(value))}</p>`;
  }
}

// opts.sentenceLines: each sentence of a paragraph on its own line (Script
// answers in the suggestion panel).
function renderMarkdown(rawInput, opts = {}) {
  const raw = toRenderableString(rawInput);
  if (!raw) return '';
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let i = 0;
  let list = null; // { type: 'ul' | 'ol', items: [] }

  function flushList() {
    if (!list) return;
    html += `<${list.type}>${list.items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</${list.type}>`;
    list = null;
  }

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushList();
      i++;
      const codeLines = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip the closing fence (or run off the end if it was never closed)
      html += `<pre class="code-block"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`;
      continue;
    }

    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      flushList();
      html += `<h5>${renderInline(heading[1].trim())}</h5>`;
      i++;
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
      list.items.push(bullet[1]);
      i++;
      continue;
    }

    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
      list.items.push(numbered[1]);
      i++;
      continue;
    }

    if (line.trim() === '') {
      flushList();
      i++;
      continue;
    }

    flushList();
    const para = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i]) &&
      !/^#{1,4}\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    const paraText = para.join(' ');
    html += opts.sentenceLines
      ? `<p class="sentences">${splitSentences(paraText).map((t) => `<span class="sentence">${renderInline(t)}</span>`).join('')}</p>`
      : `<p>${renderInline(paraText)}</p>`;
  }
  flushList();
  return html;
}

// ---- Sentences (big first line + one sentence per line) ----
// A sentence ends at . ! ? (plus closing quotes/brackets/bold markers)
// FOLLOWED BY WHITESPACE -- so while an answer streams, "3." isn't an end
// until we see what comes next ("3.5"), and the split never moves text that
// is already on screen. Common abbreviations, initials and splits inside
// **bold** don't count.
const SENTENCE_END_RE = /[.!?]+["'”’)\]*]*(?=\s)/g;
const ABBREVIATION_RE = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|approx|mr|mrs|ms|dr|prof|st|no|fig|inc|ltd|[A-Za-z])\.$/i;

function firstSentenceEnd(text, from = 0) {
  const re = new RegExp(SENTENCE_END_RE.source, 'g');
  re.lastIndex = from;
  let m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    const head = text.slice(0, end);
    const bare = head.replace(/["'”’)\]*]+$/, '');
    if (bare.endsWith('.') && ABBREVIATION_RE.test(bare)) continue;
    if ((head.match(/\*\*/g) || []).length % 2 === 1) continue; // inside **bold**
    return end;
  }
  return -1;
}

function splitSentences(text) {
  const out = [];
  let rest = text;
  for (let guard = 0; guard < 200; guard++) {
    const end = firstSentenceEnd(rest);
    if (end === -1) break;
    const piece = rest.slice(0, end).trim();
    if (piece) out.push(piece);
    rest = rest.slice(end);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

// The suggestion panel: the answer's FIRST SENTENCE is the big headline,
// shown as soon as it starts streaming so the user can start talking while
// the rest arrives. It only grows at its end and, once finished, never
// changes -- the rest goes below it (steady answers: no reflow).
const NON_PROSE_LINE_RE = /^(?:```|#{1,4}\s|\s*[-*]\s|\s*\d+[.)]\s)/;
function renderSuggestionHtml(rawInput, style) {
  const src = toRenderableString(rawInput).replace(/\r\n/g, '\n').replace(/^\s+/, '');
  if (!src) return '';
  const opts = { sentenceLines: style !== 'cues' };
  const nl = src.indexOf('\n');
  const firstLine = nl === -1 ? src : src.slice(0, nl);
  if (NON_PROSE_LINE_RE.test(firstLine)) return renderMarkdown(src, opts);
  const end = firstSentenceEnd(firstLine);
  const headline = end === -1 ? firstLine : firstLine.slice(0, end);
  const rest = (end === -1 ? '' : firstLine.slice(end)) + (nl === -1 ? '' : src.slice(nl));
  return `<p class="headline">${renderInline(headline.trim())}</p>${renderMarkdown(rest.replace(/^[ \t]+/, ''), opts)}`;
}

function safeRenderSuggestion(value, style) {
  try {
    return renderSuggestionHtml(value, style);
  } catch (err) {
    console.error('renderSuggestionHtml failed, falling back:', err);
    return safeRenderMarkdown(value);
  }
}

// ---- Knowledge base (personal files searched for grounding context) ----
function renderKnowledgeStatus(status) {
  if (!status || !status.fileCount) {
    knowledgeStatusEl.textContent = 'No files yet — click "Add Files" to pick your CV/notes (.txt or .md).';
    return;
  }
  knowledgeStatusEl.textContent = `${status.fileCount} file${status.fileCount === 1 ? '' : 's'} loaded (${status.chunkCount} chunks): ${status.files.join(', ')}`;
}

async function refreshKnowledgeStatus() {
  try {
    const status = await api.getKnowledgeStatus();
    renderKnowledgeStatus(status);
  } catch (err) {
    knowledgeStatusEl.textContent = 'Could not load knowledge base status.';
  }
}

addKnowledgeFilesBtn.addEventListener('click', async () => {
  addKnowledgeFilesBtn.disabled = true;
  try {
    const result = await api.addKnowledgeFiles();
    if (result.status) renderKnowledgeStatus(result.status);
  } catch (err) {
    knowledgeStatusEl.textContent = 'Could not add files: ' + err.message;
  } finally {
    addKnowledgeFilesBtn.disabled = false;
  }
});

openKnowledgeFolderBtn.addEventListener('click', () => {
  api.openKnowledgeFolder();
});

reloadKnowledgeBtn.addEventListener('click', async () => {
  reloadKnowledgeBtn.disabled = true;
  try {
    const status = await api.reloadKnowledge();
    renderKnowledgeStatus(status);
  } finally {
    reloadKnowledgeBtn.disabled = false;
  }
});

// ---- Screen capture (visual context, separate from audio) ----
async function refreshScreenSources() {
  const previouslySelected = screenSourceSelect.value;
  try {
    const sources = await api.listScreenSources();
    screenSourceSelect.innerHTML = '';
    for (const s of sources) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      screenSourceSelect.appendChild(opt);
    }
    // Keep the previous selection if it still exists, otherwise default to the first (primary screen).
    if (previouslySelected && sources.some((s) => s.id === previouslySelected)) {
      screenSourceSelect.value = previouslySelected;
    }
  } catch (err) {
    console.error('Could not list screen sources:', err);
  }
}

// The Capture button adds to the tray (so several screens can be collected
// before asking); the Ctrl+Shift+S hotkey keeps its "capture + answer"
// behavior and answers right away with everything in the tray.
async function captureScreen({ andAnswer = false } = {}) {
  if (privacyModeEnabled) {
    showToast('Screen capture is disabled while Privacy Mode is active.');
    return;
  }
  const sourceId = screenSourceSelect.value || undefined;
  const previousLabel = captureScreenBtn.textContent;
  captureScreenBtn.textContent = '…';
  captureScreenBtn.disabled = true;
  try {
    const result = await api.captureScreen(sourceId);
    // Privacy Mode may have been switched on while the capture was in flight.
    if (privacyModeEnabled) return;
    screenshots.push({ ...result, id: nextScreenshotId++, capturedAt: Date.now() });
    let dropped = false;
    while (screenshots.length > MAX_SCREENSHOTS) {
      screenshots.shift(); // drop the oldest
      dropped = true;
    }
    renderScreenshotTray();
    if (andAnswer) {
      requestSuggestion(undefined, { question: null });
    } else {
      showToast(`Screenshot added (${screenshots.length}/${MAX_SCREENSHOTS})${dropped ? ' -- oldest one removed' : ''}. It goes with your next answer or question.`);
    }
  } catch (err) {
    showToast('Screen capture failed: ' + err.message);
  } finally {
    captureScreenBtn.textContent = previousLabel;
    captureScreenBtn.disabled = privacyModeEnabled;
  }
}

function renderScreenshotTray() {
  screenThumb.replaceChildren();
  screenshots.forEach((shot, i) => {
    const li = document.createElement('li');
    li.className = 'shot';
    const img = document.createElement('img');
    img.src = shot.dataUrl;
    img.alt = `Screenshot ${i + 1}: ${shot.name || 'screen'}`;
    img.title = `${shot.name || 'Screen'} · ${new Date(shot.capturedAt).toLocaleTimeString()}`;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'shot-remove';
    removeBtn.dataset.shotId = String(shot.id);
    removeBtn.title = 'Remove this screenshot';
    removeBtn.setAttribute('aria-label', `Remove screenshot ${i + 1}`);
    removeBtn.textContent = '×';
    li.append(img, removeBtn);
    screenThumb.appendChild(li);
  });
  const last = screenshots[screenshots.length - 1];
  screenStatus.textContent = last
    ? `${screenshots.length}/${MAX_SCREENSHOTS} · latest: ${last.name || 'screen'} · ${new Date(last.capturedAt).toLocaleTimeString()}`
    : '';
  screenPreviewRow.classList.toggle('hidden', screenshots.length === 0);
  clearScreenBtn.disabled = screenshots.length === 0;
}

function removeScreenshot(id) {
  screenshots = screenshots.filter((s) => s.id !== id);
  renderScreenshotTray();
}

function clearScreenshots() {
  screenshots = [];
  renderScreenshotTray();
}

// Snapshot of what to send with a request: the payload plus the ids, so
// only those exact screenshots are cleared afterwards (one captured while
// the request was in flight stays in the tray).
function screenshotsForSend() {
  if (privacyModeEnabled || !screenshots.length) return { images: undefined, ids: [] };
  return {
    images: screenshots.map((s) => ({ mimeType: s.mimeType, base64: s.base64, name: s.name })),
    ids: screenshots.map((s) => s.id),
  };
}

// Called after a request that carried screenshots succeeded.
function screenshotsSent(ids) {
  if (!ids.length || keepScreenshotsToggle.checked) return;
  screenshots = screenshots.filter((s) => !ids.includes(s.id));
  renderScreenshotTray();
}

const KEEP_SCREENSHOTS_KEY = 'echo.keepScreenshotsAfterSend';
try {
  keepScreenshotsToggle.checked = localStorage.getItem(KEEP_SCREENSHOTS_KEY) === '1';
} catch (err) {
  keepScreenshotsToggle.checked = false;
}
keepScreenshotsToggle.addEventListener('change', () => {
  try { localStorage.setItem(KEEP_SCREENSHOTS_KEY, keepScreenshotsToggle.checked ? '1' : '0'); } catch (err) { /* ignore */ }
});

screenThumb.addEventListener('click', (e) => {
  const btn = e.target.closest('.shot-remove');
  if (!btn) return;
  removeScreenshot(Number(btn.dataset.shotId));
});

refreshSourcesBtn.addEventListener('click', () => refreshScreenSources());
captureScreenBtn.addEventListener('click', () => captureScreen());
clearScreenBtn.addEventListener('click', () => clearScreenshots());
renderScreenshotTray();

// ---- Audio capture ----
async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ---- Audio chunking: voice-activity detection (vad-core.js) ----
// Each stream (mic = "You", system audio = "Them") gets its own
// AnalyserNode + VadSegmenter, sampled every VAD_FRAME_MS. A MediaRecorder
// is always running, so the start of an utterance is never lost:
//   'cut'   (speech, then SILENCE_MS of quiet -- or MAX_CHUNK_MS of non-stop
//           talking): the next recorder starts FIRST, then the finished one
//           stops and uploads. One recorder per chunk = every chunk is a
//           complete, standalone webm file.
//   'reset' (no speech in the recording): it's thrown away, never uploaded.
// Without Web Audio (or if the AudioContext never starts) it falls back to
// fixed CHUNK_MS chunks, the pre-VAD behaviour.
const Vad = window.EchoVadCore || null;
const VAD_FRAME_MS = 40;
const VAD_START_TIMEOUT_MS = 2000; // AudioContext still not running -> fixed chunks
let audioCtx = null;

function getAudioContext() {
  if (audioCtx && audioCtx.state !== 'closed') return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    audioCtx = new Ctx();
  } catch (err) {
    console.warn('No AudioContext -- using fixed-length audio chunks:', err);
    audioCtx = null;
  }
  return audioCtx;
}

function closeAudioContext() {
  if (!audioCtx) return;
  audioCtx.close().catch(() => {});
  audioCtx = null;
}

function startRollingRecorder(stream, speaker, indicatorEl) {
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  let stopped = false;
  let current = null; // { recorder, chunks, upload, meta }
  let vadTimer = null;
  let fixedTimer = null;
  let source = null;
  let mode = 'vad';
  // Results are appended strictly in recording order, even if a later
  // chunk's transcription happens to come back first.
  let appendQueue = Promise.resolve();

  function begin() {
    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch (err) {
      console.error(`Could not start recorder (${speaker}):`, err);
      return null;
    }
    const rec = { recorder, chunks: [], upload: false, meta: null };
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) rec.chunks.push(e.data);
    };
    recorder.onstop = () => finish(rec);
    try {
      recorder.start();
    } catch (err) {
      // e.g. the mic was unplugged and the stream has ended.
      console.error(`Recorder failed to start (${speaker}):`, err);
      return null;
    }
    return rec;
  }

  function finish(rec) {
    // Discarded (no speech) or Stop was pressed: don't upload.
    if (!rec.upload) return;
    const blob = new Blob(rec.chunks, { type: mimeType });
    if (!blob.size) return;
    const meta = rec.meta;
    const pending = transcribeBlob(blob, mimeType, speaker);
    appendQueue = appendQueue
      .then(() => pending)
      .then((text) => { if (text) appendLine(speaker, text, meta); })
      .catch((err) => console.error('appendLine failed:', err));
  }

  function dead() {
    stopTimers();
    indicatorEl.classList.remove('active', 'speaking');
    if (speaker === 'You') showToast('Microphone stopped delivering audio -- check it, then Stop / Start Listening.');
  }

  // Ends the current recording (uploading it or not) and starts the next
  // one first, so no audio falls between two chunks.
  function rotate(upload, meta) {
    if (stopped) return;
    const prev = current;
    current = begin();
    if (prev) {
      prev.upload = upload;
      prev.meta = meta;
      try {
        if (prev.recorder.state !== 'inactive') prev.recorder.stop();
      } catch (err) { /* already stopped */ }
    }
    if (!current) dead();
  }

  function stopTimers() {
    clearInterval(vadTimer);
    clearInterval(fixedTimer);
    vadTimer = null;
    fixedTimer = null;
  }

  function useFixedChunks(why) {
    if (stopped) return;
    if (why) console.warn(`Voice-activity detection unavailable (${speaker}) -- using ${CHUNK_MS / 1000}s chunks:`, why);
    mode = 'fixed';
    stopTimers();
    indicatorEl.classList.remove('speaking');
    fixedTimer = setInterval(() => {
      rotate(true, { cut: 'timer', speechEndAt: performance.now() });
    }, CHUNK_MS);
  }

  current = begin();
  if (!current) {
    indicatorEl.classList.remove('active');
    if (speaker === 'You') showToast('Microphone stopped delivering audio -- check it, then Stop / Start Listening.');
    return { stop() {}, mode: () => 'off' };
  }
  indicatorEl.classList.add('active');

  let analyser = null;
  const ctx = Vad ? getAudioContext() : null;
  if (ctx) {
    try {
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024; // ~21 ms of samples per reading at 48 kHz
      source.connect(analyser); // never connected to the speakers
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch (err) {
      analyser = null;
      useFixedChunks(err);
    }
  } else {
    useFixedChunks(Vad ? 'no AudioContext' : 'vad-core.js not loaded');
  }

  if (analyser) {
    const seg = new Vad.VadSegmenter();
    const samples = new Float32Array(analyser.fftSize);
    const startedAt = performance.now();
    vadTimer = setInterval(() => {
      if (stopped || !current) return;
      const t = performance.now();
      if (ctx.state !== 'running') {
        // Silent zeros from a suspended context would never count as speech.
        if (t - startedAt > VAD_START_TIMEOUT_MS) useFixedChunks(`AudioContext ${ctx.state}`);
        return;
      }
      analyser.getFloatTimeDomainData(samples);
      const ev = seg.update({ rms: Vad.rms(samples), t });
      indicatorEl.classList.toggle('speaking', ev.voiced);
      if (ev.action === 'cut') {
        rotate(true, { cut: ev.reason, speechEndAt: ev.speechEndT });
      } else if (ev.action === 'reset') {
        rotate(false, null);
      }
    }, VAD_FRAME_MS);
  }

  return {
    stop() {
      stopped = true;
      stopTimers();
      try { if (source) source.disconnect(); } catch (err) { /* already gone */ }
      // Stop was pressed: don't upload the chunk in progress. (A chunk that
      // was already cut at a pause still gets transcribed.)
      if (current) {
        current.upload = false;
        try {
          if (current.recorder.state !== 'inactive') current.recorder.stop();
        } catch (err) { /* already stopped */ }
      }
      indicatorEl.classList.remove('active', 'speaking');
    },
    mode: () => mode,
  };
}

// Repeated transcription failures that aren't "offline" (e.g. the speech
// service erroring) get a banner instead of failing silently in the console.
let transcribeFailures = 0;

async function transcribeBlob(blob, mimeType, speaker) {
  try {
    const base64 = await blobToBase64(blob);
    const { text } = await api.transcribeChunk({ base64, mimeType, speaker });
    transcribeFailures = 0;
    setBanner('service', null);
    return text;
  } catch (err) {
    if (isKeyError(err)) {
      // The key banner (set by refreshKeyStatus) already says what to do;
      // stop rather than failing on every chunk.
      if (listening) {
        stopListening();
        showToast(err.message, 6000);
      }
      return null;
    }
    console.error(`Transcription error (${speaker}):`, err.code || '', err.message);
    transcribeFailures += 1;
    if (listening && err.code !== 'OFFLINE' && (transcribeFailures >= 2 || err.code === 'RATE_LIMIT')) {
      setBanner('service', `Transcription is failing (${err.message}) -- still retrying.`);
    }
    return null;
  }
}

function releaseStreams() {
  micStream?.getTracks().forEach((t) => t.stop());
  systemStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  systemStream = null;
}

function updateSuggestionPlaceholder() {
  if (lastSuggestion) return; // an answer is showing -- placeholder is hidden anyway
  suggestionPlaceholder.textContent = suggestInFlight
    ? 'Thinking…'
    : listening
      ? 'Listening… an answer appears here as soon as they ask a question. Ctrl+Enter to generate one now.'
      : keysReady()
        ? 'Not listening. Press Start Listening — answers appear here when a question is detected, or press Generate anytime.'
        : 'Add your Groq + Gemini API keys (⋯ menu > API keys) to get started.';
}

function syncListeningUI() {
  // Start needs both keys; Stop must always work.
  listenBtn.disabled = listenBusy || (!listening && !keysReady());
  if (!listenBusy) listenBtn.textContent = listening ? 'Stop Listening' : 'Start Listening';
  listenBtn.classList.toggle('recording', listening);
  listenBtn.title = listening
    ? 'Stop listening'
    : keysReady()
      ? 'Listen to mic + system audio and transcribe it'
      : 'Add your Groq + Gemini API keys first (⋯ menu > API keys)';
  statusDot.classList.toggle('live', listening);
  statusDot.title = listening ? 'Listening' : 'Not listening';
  liveBadge.classList.toggle('hidden', !listening);
  appEl.classList.toggle('listening', listening);
  updateSuggestionPlaceholder();
}

async function startListening() {
  if (listenBusy || listening) return;
  if (!keysReady()) {
    openSettings('Add both keys to start listening.');
    return;
  }
  listenBusy = true;
  listenBtn.textContent = 'Starting…';
  syncListeningUI();
  try {
    await startListeningInner();
  } finally {
    listenBusy = false;
    syncListeningUI();
  }
}

async function startListeningInner() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast('Could not access the microphone: ' + err.message, 6000);
    return;
  }

  try {
    const sourceId = await api.getDesktopAudioSourceId();
    systemStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          minWidth: 1,
          maxWidth: 2,
          minHeight: 1,
          maxHeight: 2,
        },
      },
    });
    // We only need the audio track — drop any video track immediately.
    systemStream.getVideoTracks().forEach((t) => t.stop());
  } catch (err) {
    console.warn('System audio capture unavailable, continuing with mic only:', err);
    systemStream = null;
  }

  listening = true;
  transcribeFailures = 0;
  setBanner('service', null);

  systemIndicator.textContent = 'System audio';
  micRecorder = startRollingRecorder(micStream, 'You', micIndicator);
  if (systemStream && systemStream.getAudioTracks().length) {
    systemRecorder = startRollingRecorder(systemStream, 'Them', systemIndicator);
  } else {
    systemIndicator.textContent = 'System audio (unavailable)';
    showToast("Couldn't capture system audio -- only your mic is being transcribed.", 5000);
  }
}

async function stopListening() {
  if (!listening) return;
  listening = false;
  syncListeningUI();
  setBanner('service', null);

  // Don't let a pending "waiting for the rest of a question" timer fire a
  // suggestion request after listening has stopped.
  awaitingNextThemLine = false;
  clearTimeout(pendingQuestionTimer);
  pendingQuestionTimer = null;
  cancelAutoSuggest();

  micRecorder?.stop();
  systemRecorder?.stop();
  micRecorder = null;
  systemRecorder = null;

  releaseStreams();
  closeAudioContext();

  micIndicator.classList.remove('active', 'speaking');
  systemIndicator.classList.remove('active', 'speaking');
}

listenBtn.addEventListener('click', () => {
  if (listenBusy) return;
  if (listening) stopListening();
  else startListening();
});

// ---- API keys screen (⋯ menu > API keys) ----
apiKeysBtn.addEventListener('click', () => openSettings());
closeSettingsBtn.addEventListener('click', () => closeSettings());
openGroqKeysBtn.addEventListener('click', () => {
  api.openKeyPage('groq').catch((err) => setSettingsMessage('Could not open the browser: ' + err.message, 'error'));
});
openGeminiKeysBtn.addEventListener('click', () => {
  api.openKeyPage('gemini').catch((err) => setSettingsMessage('Could not open the browser: ' + err.message, 'error'));
});

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const groq = groqKeyInput.value.trim();
  const gemini = geminiKeyInput.value.trim();
  if (!groq && !gemini) {
    setSettingsMessage('Paste at least one key first.', 'error');
    return;
  }
  saveKeysBtn.disabled = true;
  setSettingsMessage('Saving…', 'info');
  try {
    const status = await api.saveKeys({ groq: groq || undefined, gemini: gemini || undefined });
    // The keys now live (encrypted) in the main process only -- drop them here.
    groqKeyInput.value = '';
    geminiKeyInput.value = '';
    applyKeyStatus(status);
    setSettingsMessage(keysReady()
      ? 'Saved. Checking the keys with Groq and Gemini…'
      : 'Saved. Add the other key too to start listening.', 'ok');
    if (keysReady()) await runKeyTest();
  } catch (err) {
    setSettingsMessage(err.message || 'Could not save keys.', 'error');
  } finally {
    saveKeysBtn.disabled = !keyStatus.canSave;
  }
});

async function runKeyTest() {
  testKeysBtn.disabled = true;
  setSettingsMessage('Testing keys…', 'info');
  try {
    const { groq, gemini } = await api.testKeys();
    const allOk = groq.ok && gemini.ok;
    setSettingsMessage(`Groq: ${groq.message}\nGemini: ${gemini.message}${allOk ? "\nYou're all set." : ''}`, allOk ? 'ok' : 'error');
  } catch (err) {
    setSettingsMessage('Could not test keys: ' + err.message, 'error');
  } finally {
    testKeysBtn.disabled = !(keyStatus.groqKeySet || keyStatus.geminiKeySet);
  }
}
testKeysBtn.addEventListener('click', () => runKeyTest());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsOverlay.classList.contains('hidden')) closeSettings();
});

removeKeysBtn.addEventListener('click', async () => {
  if (!window.confirm('Remove the API keys saved by Echo on this computer?')) return;
  try {
    if (listening) await stopListening();
    const status = await api.removeKeys();
    applyKeyStatus(status);
    setSettingsMessage(keysReady()
      ? 'Saved keys removed. Keys from your .env file are still in use.'
      : 'Saved keys removed from this computer.', 'ok');
  } catch (err) {
    setSettingsMessage(err.message || 'Could not remove keys.', 'error');
  }
});

// ---- Screen-share visibility (opt-in, off by default -- see main.js) ----
hideFromShareBtn.addEventListener('click', async () => {
  const { enabled } = await api.toggleContentProtection();
  syncContentProtectionUI(enabled);
});

api.onContentProtectionChanged((enabled) => {
  syncContentProtectionUI(enabled);
});

// ---- Suggestions ----
// CALM ANSWERS -- when the visible answer is allowed to change:
//   It is replaced ONLY when
//     (a) the panel is empty (no finished answer showing), or
//     (b) the user explicitly asked: Generate button, Ctrl+Enter, the
//         "generate" hand gesture (it clicks Generate), Ctrl+Shift+S
//         capture + answer, Regenerate / Shorten / Expand, or clicking the
//         "New answer ready" chip.
//   Those requests "own" the panel, and their text streams into it as it
//   arrives. An automatic (question-detected) suggestion that finishes
//   while an answer is showing is buffered instead: a "New answer ready"
//   chip appears and the visible text stays exactly as it is until the chip
//   is clicked. A newer buffered answer replaces an older one behind the
//   chip (latest wins).
//   There is deliberately no timer/hover-based auto-swap: an idle timer
//   can't tell "reading" from "looked away", and a surprise swap
//   mid-sentence is the thing this avoids.
// No motion on the answer itself: no dimming while generating (the header
// "Thinking" pill says that), no flash on arrival, and the scroll position
// only resets when an answer the user asked for starts streaming in (or the
// chip is clicked).
// Two copies of the chip: label row (full view) and header (compact bar).
const newAnswerChips = [document.getElementById('new-answer-chip'), document.getElementById('new-answer-chip-compact')];

let shownAnswer = null; // last finished answer put on screen: { text, question, groundingFiles }
let panelState = 'empty'; // 'empty' | 'answer' | 'streaming'
let panelOwnerId = null; // the request currently allowed to write into the panel
let pendingAnswer = null; // finished background answer waiting behind the chip
let renderedSource = null; // markdown source currently rendered in #suggestion-text
const suggestRequests = new Map(); // requestId -> request state
let requestCounter = 0;

function newRequestId(prefix) {
  requestCounter += 1;
  return `${prefix}${Date.now().toString(36)}${requestCounter}`;
}

function updateThinking() {
  suggestInFlight = suggestRequests.size > 0;
  thinkingIndicator.classList.toggle('hidden', !suggestInFlight);
  updateSuggestionPlaceholder();
}

function setQuestionLine(text) {
  const t = (text || '').trim();
  suggestionQuestion.textContent = t ? `Re: “${t}”` : '';
  suggestionQuestion.classList.toggle('hidden', !t);
}

function showSuggestionError(message) {
  suggestionError.textContent = message;
  suggestionError.classList.toggle('hidden', !message);
}

// Headline-first: the first sentence is rendered big (renderSuggestionHtml);
// Script answers then show one sentence per line, Cues answers a short list.
function renderAnswerText(text, style) {
  const s = style === 'cues' ? 'cues' : 'script';
  const key = `${s}\u0000${text}`;
  if (renderedSource === key) return;
  renderedSource = key;
  suggestionText.dataset.style = s;
  suggestionText.innerHTML = safeRenderSuggestion(text, s);
}

function showGrounding(groundingFiles) {
  if (!Array.isArray(groundingFiles) || !groundingFiles.length) {
    suggestionGrounding.classList.add('hidden');
    suggestionGrounding.textContent = '';
    return;
  }
  suggestionGrounding.textContent = `Grounded in: ${groundingFiles.join(', ')}`;
  suggestionGrounding.classList.remove('hidden');
}

// A finished answer goes on screen (and into the session's answer history).
function displayAnswer(answer, { resetScroll = true, remember = true } = {}) {
  shownAnswer = answer;
  panelState = 'answer';
  lastSuggestion = answer.text;
  showSuggestionError('');
  setQuestionLine(answer.question);
  suggestionPlaceholder.classList.add('hidden');
  suggestionText.classList.remove('hidden');
  suggestionActions.classList.remove('hidden');
  renderAnswerText(answer.text, answer.style);
  showGrounding(answer.groundingFiles);
  if (resetScroll) suggestionBodyEl.scrollTop = 0;
  if (remember) rememberAnswer('suggestion', answer.question, answer.text);
}

function showEmptyPanel() {
  panelState = 'empty';
  lastSuggestion = '';
  renderedSource = null;
  suggestionText.innerHTML = '';
  suggestionText.classList.add('hidden');
  suggestionActions.classList.add('hidden');
  showGrounding(undefined);
  setQuestionLine('');
  suggestionPlaceholder.classList.remove('hidden');
  updateSuggestionPlaceholder();
}

// A streaming answer died part-way: put back what was there before it.
function restorePanel() {
  if (shownAnswer) displayAnswer(shownAnswer, { resetScroll: false, remember: false });
  else showEmptyPanel();
}

function renderStreamFrame(req) {
  req.frameQueued = false;
  if (req.superseded || panelOwnerId !== req.id || !req.buffer) return;
  if (!req.started) {
    // First words of an answer the user asked for (or of the first answer):
    // only now does the old answer leave the screen.
    req.started = true;
    panelState = 'streaming';
    lastSuggestion = '';
    showSuggestionError('');
    setQuestionLine(req.questionLine);
    suggestionPlaceholder.classList.add('hidden');
    suggestionText.classList.remove('hidden');
    suggestionActions.classList.add('hidden');
    showGrounding(undefined);
    suggestionBodyEl.scrollTop = 0;
  }
  // Text only ever grows at the end, so what's above doesn't move.
  renderAnswerText(req.buffer, req.answerStyle);
}

function showPendingAnswer(answer) {
  pendingAnswer = answer;
  newAnswerChips.forEach((chip) => chip.classList.remove('hidden'));
}

function clearPendingAnswer() {
  pendingAnswer = null;
  newAnswerChips.forEach((chip) => chip.classList.add('hidden'));
}

newAnswerChips.forEach((chip) => chip.addEventListener('click', () => {
  if (!pendingAnswer) return;
  const answer = pendingAnswer;
  clearPendingAnswer();
  displayAnswer(answer, { resetScroll: true });
}));

// ---- Session answer history (sent with every request, so "expand on
// that" / "going back to earlier" work and answers don't repeat) ----
const MAX_ANSWER_HISTORY = 10;
const answerHistory = []; // { kind: 'suggestion' | 'chat', question, text }

function rememberAnswer(kind, question, text) {
  if (!text) return;
  const last = answerHistory[answerHistory.length - 1];
  if (last && last.kind === kind && last.text === text) return;
  answerHistory.push({ kind, question: question || '', text });
  if (answerHistory.length > MAX_ANSWER_HISTORY) answerHistory.shift();
}

function previousAnswersForSend() {
  return answerHistory.map((a) => ({
    kind: a.kind,
    question: a.question.length > 600 ? `${a.question.slice(0, 600)}…` : a.question,
    text: a.text.length > 4000 ? `${a.text.slice(0, 4000)}…` : a.text,
  }));
}

// ---- Quality vs speed (Settings) -- picks Gemini's thinking level ----
const QUALITY_KEY = 'echo.answerQuality';
const QUALITY_VALUES = ['auto', 'fast', 'max'];
function currentQuality() {
  return QUALITY_VALUES.includes(qualitySelect.value) ? qualitySelect.value : 'auto';
}
try {
  const saved = localStorage.getItem(QUALITY_KEY);
  qualitySelect.value = QUALITY_VALUES.includes(saved) ? saved : 'auto';
} catch (err) {
  qualitySelect.value = 'auto';
}
qualitySelect.addEventListener('change', () => {
  try { localStorage.setItem(QUALITY_KEY, currentQuality()); } catch (err) { /* not remembered -- fine */ }
});

// ---- Answer style (Settings + the chip by "Suggested response") ----
// 'script': full spoken sentences, one per line. 'cues': a big first line to
// say, then a few bold keywords to talk around in your own words.
const ANSWER_STYLE_KEY = 'echo.answerStyle';
const ANSWER_STYLE_VALUES = ['script', 'cues'];
const answerStyleSelect = document.getElementById('answer-style-select');
const answerStyleChip = document.getElementById('answer-style-chip');
let answerStyle = 'script';

function currentAnswerStyle() {
  return ANSWER_STYLE_VALUES.includes(answerStyle) ? answerStyle : 'script';
}

function setAnswerStyle(style, { save = true } = {}) {
  answerStyle = ANSWER_STYLE_VALUES.includes(style) ? style : 'script';
  answerStyleSelect.value = answerStyle;
  const cues = answerStyle === 'cues';
  answerStyleChip.textContent = cues ? 'Cues' : 'Script';
  answerStyleChip.classList.toggle('active', cues);
  answerStyleChip.setAttribute('aria-pressed', cues ? 'true' : 'false');
  answerStyleChip.title = cues
    ? 'Answer style: Cues (a first line + keywords to talk around). Click for Script (full sentences). Applies to the next answer.'
    : 'Answer style: Script (full sentences to say). Click for Cues (a first line + keywords). Applies to the next answer.';
  if (save) {
    try { localStorage.setItem(ANSWER_STYLE_KEY, answerStyle); } catch (err) { /* not remembered -- fine */ }
  }
}
try {
  setAnswerStyle(localStorage.getItem(ANSWER_STYLE_KEY), { save: false });
} catch (err) {
  setAnswerStyle('script', { save: false });
}
answerStyleSelect.addEventListener('change', () => setAnswerStyle(answerStyleSelect.value));
answerStyleChip.addEventListener('click', () => {
  setAnswerStyle(currentAnswerStyle() === 'cues' ? 'script' : 'cues');
  showToast(currentAnswerStyle() === 'cues'
    ? 'Answer style: Cues (a first line + keywords). Applies from the next answer.'
    : 'Answer style: Script (full sentences). Applies from the next answer.', 2500);
});

// ---- Latency stat (Diagnostics): end of their speech -> first answer word ----
// Measured from the last voiced audio of the latest "Them" chunk (VAD) to
// the first streamed token of the suggestion that followed it. Includes the
// silence wait, upload + transcription, the auto-suggest delay and Gemini's
// time to first token.
const LATENCY_SAMPLES = 10;
const LATENCY_WINDOW_MS = 30_000; // older speech isn't what the answer is responding to
const latencySamples = []; // { totalMs, sttMs, auto }

function latencyStartFor() {
  if (!lastThemChunk) return null;
  if (performance.now() - lastThemChunk.transcribedAt > LATENCY_WINDOW_MS) return null;
  return { ...lastThemChunk };
}

function noteFirstToken(req) {
  if (req.firstTokenAt) return;
  req.firstTokenAt = performance.now();
  if (!req.latencyFrom) return;
  latencySamples.push({
    totalMs: Math.max(0, Math.round(req.firstTokenAt - req.latencyFrom.speechEndAt)),
    sttMs: Math.max(0, Math.round(req.latencyFrom.transcribedAt - req.latencyFrom.speechEndAt)),
    auto: req.auto,
  });
  if (latencySamples.length > LATENCY_SAMPLES) latencySamples.shift();
  if (!diagnosticsOverlay.classList.contains('hidden')) renderDiagnostics();
}

function describeLatency() {
  if (!latencySamples.length) return 'no timed answers yet';
  const last = latencySamples[latencySamples.length - 1];
  const avg = Math.round(latencySamples.reduce((n, x) => n + x.totalMs, 0) / latencySamples.length);
  return `last ${last.totalMs} ms (${last.auto ? 'auto' : 'manual'}, of which speech-to-text ${last.sttMs} ms) · avg of last ${latencySamples.length}: ${avg} ms`;
}

// Streamed text for suggestions and chat answers (see main.js 'ai:chunk').
const chatRequests = new Map(); // requestId -> chat request state
api.onAiChunk((payload) => {
  if (!payload || typeof payload.text !== 'string') return;
  const req = suggestRequests.get(payload.requestId) || chatRequests.get(payload.requestId);
  if (!req || req.superseded) return;
  if (req.kind === 'suggest') noteFirstToken(req);
  req.buffer += payload.text;
  req.onChunk();
});

// opts.question: string -> the question being answered (shown as "Re: ...");
//                null -> none (manual Generate); undefined -> keep the
//                current one (Shorten / Expand / Regenerate).
// opts.auto: true for question-detected suggestions (never replace a
//            visible answer -- see CALM ANSWERS above).
async function requestSuggestion(instruction, opts = {}) {
  // Works with or without listening (e.g. a screenshot-only question) --
  // it only needs the Gemini key.
  if (!keyStatus.geminiKeySet) {
    showSuggestionError('Add your Gemini API key first (⋯ menu > API keys).');
    return;
  }
  const auto = opts.auto === true;
  if (!auto) {
    // The user is dealing with the current question themselves: don't let
    // the auto path answer it again a moment later.
    cancelAutoSuggest();
    lastAutoQuestionKey = questionKey(recentThemQuestion());
    themCharsAtLastAuto = themCharsTotal;
  }
  const questionLine = opts.question !== undefined
    ? (opts.question || '')
    : (shownAnswer && shownAnswer.question) || '';

  // An explicit request supersedes everything in flight; an automatic one
  // only older automatic ones (main.js aborts the same set).
  for (const r of suggestRequests.values()) {
    if (!auto || r.auto) {
      r.superseded = true;
      suggestRequests.delete(r.id);
      if (panelOwnerId === r.id) panelOwnerId = null;
    }
  }

  const id = newRequestId('s');
  const req = {
    id, kind: 'suggest', auto, questionLine, buffer: '', started: false, frameQueued: false, superseded: false,
    answerStyle: currentAnswerStyle(), latencyFrom: latencyStartFor(), firstTokenAt: null,
  };
  req.onChunk = () => {
    if (panelOwnerId !== id || req.frameQueued) return; // buffered: nothing on screen changes
    req.frameQueued = true;
    requestAnimationFrame(() => renderStreamFrame(req));
  };
  if (!auto || (!panelOwnerId && panelState !== 'answer')) {
    panelOwnerId = id;
    if (!auto) clearPendingAnswer();
  }
  suggestRequests.set(id, req);
  updateThinking();

  try {
    const shots = screenshotsForSend();
    const result = await api.generateSuggestion({
      requestId: id,
      kind: auto ? 'auto' : 'explicit',
      transcript: buildTranscriptText(),
      mode: modeSelect.value,
      instruction,
      question: questionLine || undefined,
      previousAnswers: previousAnswersForSend(),
      quality: currentQuality(),
      answerStyle: req.answerStyle,
      images: shots.images,
    });
    // They reached Gemini -- clear them unless "Keep screenshots" is on
    // (even if a newer request superseded this one's answer).
    screenshotsSent(shots.ids);
    if (req.superseded) return;
    noteFirstToken(req); // no-op if it streamed; times a non-streamed answer
    // ai:suggest resolves { text, groundingFiles } -- the full answer, which
    // also replaces whatever was streamed (it's authoritative if streaming
    // fell back to a normal request part-way).
    const isObj = result && typeof result === 'object';
    const answer = {
      text: (isObj ? result.text : result) || '(no suggestion returned)',
      question: questionLine,
      groundingFiles: isObj ? result.groundingFiles : undefined,
      style: (isObj && result.answerStyle) || req.answerStyle,
    };
    if (panelOwnerId === id) displayAnswer(answer, { resetScroll: !req.started });
    else showPendingAnswer(answer);
  } catch (err) {
    if (req.superseded || err.code === 'ABORTED') return;
    if (panelOwnerId === id) {
      if (req.started) restorePanel();
      // Keep the previous answer on screen; show the error above it.
      showSuggestionError(`Couldn't get an answer: ${err.message} (Ctrl+Enter to retry)`);
    } else {
      // A background answer failing must not disturb the one being read.
      console.warn('Background suggestion failed:', err.code || '', err.message);
    }
  } finally {
    if (suggestRequests.get(id) === req) suggestRequests.delete(id);
    if (panelOwnerId === id) panelOwnerId = null;
    updateThinking();
  }
}

generateBtn.addEventListener('click', () => requestSuggestion(undefined, { question: null }));

suggestionActions.addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  // main.js rejects instructions over 4000 chars: quote at most 3000.
  const quoted = lastSuggestion.length > 3000 ? `${lastSuggestion.slice(0, 3000)}…` : lastSuggestion;
  if (action === 'copy') {
    const btn = e.target;
    const copied = () => {
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    };
    navigator.clipboard.writeText(lastSuggestion).then(copied).catch(() => {
      // navigator.clipboard refuses when the overlay isn't focused (e.g. a
      // hand-gesture copy while you're in another app) -- let main write it.
      api.copyText(lastSuggestion).then(copied).catch(() => showToast('Could not copy the answer.'));
    });
  } else if (action === 'shorten') {
    requestSuggestion(`Make this shorter and punchier, 1-2 sentences: "${quoted}"`);
  } else if (action === 'expand') {
    requestSuggestion(`Expand this with more concrete detail: "${quoted}"`);
  } else if (action === 'regenerate') {
    requestSuggestion();
  }
});

// ---- Chat ----
function appendChatLine(who, text) {
  const div = document.createElement('div');
  div.className = 'line';
  div.innerHTML = `<span class="speaker">${who}:</span> ${escapeHtml(text)}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function chatNearBottom() {
  return chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 24;
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = chatInput.value.trim();
  if (!question) return;
  chatInput.value = '';
  appendChatLine('You', question);
  appendChatLine('Assistant', '…');
  const placeholder = chatLog.lastElementChild;

  // You asked, so the chat answer streams in as it's written.
  const id = newRequestId('c');
  const req = { id, buffer: '', frameQueued: false, finished: false };
  req.onChunk = () => {
    if (req.frameQueued) return;
    req.frameQueued = true;
    requestAnimationFrame(() => {
      req.frameQueued = false;
      if (req.finished) return;
      const stick = chatNearBottom();
      placeholder.innerHTML = `<span class="speaker">Assistant:</span> ${safeRenderMarkdown(req.buffer)}`;
      if (stick) chatLog.scrollTop = chatLog.scrollHeight;
    });
  };
  chatRequests.set(id, req);

  try {
    const shots = screenshotsForSend();
    const answer = await api.askFollowUp({
      requestId: id,
      transcript: buildTranscriptText(),
      question,
      mode: modeSelect.value,
      previousAnswers: previousAnswersForSend(),
      quality: currentQuality(),
      images: shots.images,
    });
    screenshotsSent(shots.ids);
    req.finished = true;
    placeholder.innerHTML = `<span class="speaker">Assistant:</span> ${safeRenderMarkdown(answer || '(no answer)')}`;
    rememberAnswer('chat', question, answer || '');
  } catch (err) {
    req.finished = true;
    placeholder.innerHTML = `<span class="speaker">Assistant:</span> Error: ${escapeHtml(err.message)}`;
  } finally {
    chatRequests.delete(id);
  }
  // The full answer is longer than the "…" placeholder: scroll to its end.
  chatLog.scrollTop = chatLog.scrollHeight;
});

// ---- Session summary (summary / decisions / action items / unresolved) ----
let lastSummaryText = '';

function fillList(ulEl, items, emptyLabel) {
  ulEl.innerHTML = '';
  if (!items || !items.length) {
    ulEl.classList.add('empty-list');
    const li = document.createElement('li');
    li.textContent = emptyLabel;
    ulEl.appendChild(li);
    return;
  }
  ulEl.classList.remove('empty-list');
  for (const item of items) {
    const li = document.createElement('li');
    li.innerHTML = renderInline(item);
    ulEl.appendChild(li);
  }
}

function buildSummaryPlainText(result) {
  const lines = [];
  lines.push('SESSION SUMMARY');
  lines.push('');
  lines.push(result.summary || '(no summary)');
  lines.push('');
  lines.push('Decisions:');
  if (result.decisions && result.decisions.length) {
    result.decisions.forEach((d) => lines.push(`- ${d}`));
  } else {
    lines.push('- (none)');
  }
  lines.push('');
  lines.push('Action items:');
  if (result.actionItems && result.actionItems.length) {
    result.actionItems.forEach((a) => lines.push(`- [${a.owner}] ${a.task}`));
  } else {
    lines.push('- (none)');
  }
  lines.push('');
  lines.push('Unresolved questions:');
  if (result.unresolved && result.unresolved.length) {
    result.unresolved.forEach((u) => lines.push(`- ${u}`));
  } else {
    lines.push('- (none)');
  }
  return lines.join('\n');
}

function showSummaryState(state) {
  summaryLoading.classList.toggle('hidden', state !== 'loading');
  summaryEmpty.classList.toggle('hidden', state !== 'empty');
  summaryContent.classList.toggle('hidden', state !== 'content');
}

async function requestSummary() {
  exitCompact();
  summaryOverlay.classList.remove('hidden');

  if (!transcriptLines.length) {
    showSummaryState('empty');
    return;
  }

  showSummaryState('loading');
  try {
    const result = await api.summarizeSession(buildTranscriptText());
    summaryTextBlock.innerHTML = renderInline(result.summary || '(no summary)');
    fillList(summaryDecisionsEl, result.decisions, 'No decisions captured.');
    fillList(
      summaryActionsListEl,
      (result.actionItems || []).map((a) => `[${a.owner}] ${a.task}`),
      'No action items captured.'
    );
    fillList(summaryUnresolvedEl, result.unresolved, 'Nothing left unresolved.');
    lastSummaryText = buildSummaryPlainText(result);
    showSummaryState('content');
  } catch (err) {
    summaryTextBlock.textContent = 'Error: ' + err.message;
    fillList(summaryDecisionsEl, [], 'No decisions captured.');
    fillList(summaryActionsListEl, [], 'No action items captured.');
    fillList(summaryUnresolvedEl, [], 'Nothing left unresolved.');
    lastSummaryText = '';
    showSummaryState('content');
  }
}

summarizeBtn.addEventListener('click', () => requestSummary());
closeSummaryBtn.addEventListener('click', () => summaryOverlay.classList.add('hidden'));
copySummaryBtn.addEventListener('click', () => {
  if (lastSummaryText) navigator.clipboard.writeText(lastSummaryText).then(() => showToast('Summary copied.')).catch(() => {});
});

exportSummaryBtn.addEventListener('click', async () => {
  if (!lastSummaryText) {
    showToast('Nothing to export yet.');
    return;
  }
  try {
    const res = await api.exportSummary(lastSummaryText);
    if (res && !res.canceled) showToast(`Saved to ${res.filePath}`, 5000);
  } catch (err) {
    showToast('Could not export: ' + err.message);
  }
});

// ---- Diagnostics panel (Ctrl+Shift+D) ----
function describeChunking() {
  const modes = [micRecorder, systemRecorder].filter(Boolean).map((r) => r.mode());
  if (!modes.length) return 'not recording';
  if (modes.every((m) => m === 'vad')) {
    const V = window.EchoVadCore;
    return `cut at pauses (${V.SILENCE_MS} ms quiet, max ${V.MAX_CHUNK_MS / 1000} s)`;
  }
  return modes.includes('vad') ? 'mixed: some streams on fixed chunks' : `fixed ${CHUNK_MS / 1000} s chunks (no Web Audio)`;
}

function renderDiagnostics() {
  const rows = [
    ['Listening', listening ? 'yes' : 'no'],
    ['Groq key', describeKeySource(keyStatus.groqSource)],
    ['Gemini key', describeKeySource(keyStatus.geminiSource)],
    ['Models', modelsText || '?'],
    ['Network', aiOffline ? "can't reach Groq/Gemini" : 'ok'],
    ['System audio', systemRecorder ? 'capturing' : 'off'],
    ['Audio chunks', describeChunking()],
    ['Speech end → first answer word', describeLatency()],
    ['Privacy mode', privacyModeEnabled ? 'on' : 'off'],
    ['Compact bar', compactMode ? 'on' : 'off'],
    ['Transcript lines', String(transcriptLines.length)],
    ['Answer quality', currentQuality()],
    ['Answer style', currentAnswerStyle()],
  ];
  diagnosticsStateEl.innerHTML = '';
  for (const [k, v] of rows) {
    const li = document.createElement('li');
    li.textContent = `${k}: ${v}`;
    diagnosticsStateEl.appendChild(li);
  }
  diagnosticsEventsEl.innerHTML = '';
  if (!diagEvents.length) {
    const li = document.createElement('li');
    li.textContent = 'No Groq/Gemini calls yet.';
    diagnosticsEventsEl.appendChild(li);
  }
  for (const ev of diagEvents) {
    const li = document.createElement('li');
    li.className = ev.ok ? 'ok' : 'fail';
    li.textContent = `${new Date(ev.at).toLocaleTimeString()}  ${ev.name}  ${ev.ok ? 'ok' : 'FAILED'}  ${ev.ms} ms${ev.error ? `  -- ${ev.error}` : ''}`;
    diagnosticsEventsEl.appendChild(li);
  }
}

function toggleDiagnostics() {
  const opening = diagnosticsOverlay.classList.contains('hidden');
  if (opening) {
    exitCompact();
    renderDiagnostics();
  }
  diagnosticsOverlay.classList.toggle('hidden', !opening);
}
closeDiagnosticsBtn.addEventListener('click', () => diagnosticsOverlay.classList.add('hidden'));

// ---- Keyboard shortcuts cheat sheet (menu item) ----
const SHORTCUTS_TEXT = [
  'Keyboard shortcuts (Cmd on macOS):',
  'Ctrl+Enter  Generate an answer now',
  'Ctrl+Shift+Space  Show / hide Echo',
  'Ctrl+Shift+K  Compact bar on/off',
  'Ctrl+Shift+E  Focus the answer panel',
  'Ctrl+Shift+S  Capture screen + answer',
  'Ctrl+Shift+M  Summarize session',
  'Ctrl+Shift+C  Clear transcript',
  'Ctrl+Shift+X  Click-through on/off',
  'Ctrl+Shift+P  Privacy mode',
  'Ctrl+Shift+H  Hide from screen share',
  'Ctrl+Shift+D  Diagnostics',
].join('\n');
shortcutsBtn.addEventListener('click', () => showToast(SHORTCUTS_TEXT, 12000));

// ---- "Focus" mode: suggestion panel fills the whole overlay ----
let suggestionExpanded = false;

function setSuggestionExpanded(expanded) {
  suggestionExpanded = expanded;
  appEl.classList.toggle('suggestion-expanded', expanded);
  expandSuggestionBtn.textContent = expanded ? 'Restore' : 'Focus';
}

expandSuggestionBtn.addEventListener('click', () => setSuggestionExpanded(!suggestionExpanded));

// ---- ⋯ menu + collapsible sections ----
(function setupMenuAndSections() {
  const menuBtn = document.getElementById('menu-btn');
  const menu = document.getElementById('menu');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });
  menu.addEventListener('click', () => menu.classList.add('hidden'));
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== menuBtn) menu.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menu.classList.add('hidden');
  });

  // Extra sections start collapsed; the open/closed choice is remembered.
  document.querySelectorAll('section.collapsible').forEach((sec) => {
    const key = `ui:collapsed:${sec.id}`;
    let collapsed = true;
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) collapsed = saved === '1';
    } catch (err) { /* storage unavailable -- default is fine */ }
    sec.classList.toggle('collapsed', collapsed);

    const label = sec.querySelector('.section-label');
    if (!label) return;
    label.addEventListener('click', (e) => {
      if (e.target.closest('button')) return; // action buttons keep working
      const nowCollapsed = !sec.classList.contains('collapsed');
      sec.classList.toggle('collapsed', nowCollapsed);
      try { localStorage.setItem(key, nowCollapsed ? '1' : '0'); } catch (err) { /* ignore */ }
    });
  });
})();

// ---- Hand gestures bridge (read by gestures.js, which loads after this file) ----
// gestures.js fires every action by clicking the real buttons, so a gesture
// runs exactly the code a click or hotkey runs. This only exposes the state
// it needs to say "nothing to copy" etc. instead.
window.echoGestureBridge = Object.freeze({
  api,
  toast: (text, ms) => showToast(text, ms),
  openSettings: (message) => openSettings(message),
  isPrivacyMode: () => privacyModeEnabled,
  isListening: () => listening,
  isListenBusy: () => listenBusy,
  hasSuggestion: () => !!lastSuggestion && !suggestionActions.classList.contains('hidden'),
  screenshotCount: () => screenshots.length,
});
