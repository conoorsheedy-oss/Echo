// Echo overlay UI. Talks to the main process only through window.assistant
// (preload.js), wrapped below as `api`. vad-core.js, pcm-core.js,
// stt-core.js, question-core.js, intent-core.js and early-start-core.js load
// before this file (window.EchoVadCore / EchoPcmCore / EchoSttCore /
// EchoQuestionCore / EchoIntentCore / EchoEarlyStartCore);
// gestures.js loads after it and uses window.echoGestureBridge (bottom of
// this file).

// ---- State ----
// Audio is cut into chunks at pauses (voice-activity detection, see "Audio
// chunking" below and vad-core.js). CHUNK_MS is only the fallback chunk
// length when Web Audio isn't available.
const CHUNK_MS = 6000;
const VAD_MAX_CHUNK_MS = (window.EchoVadCore && window.EchoVadCore.MAX_CHUNK_MS) || 12000;
// Is a "Them" line a question (by wording, not just a "?"), and how long to
// wait before answering it -- see question-core.js. A chunk can still hold
// several sentences, so a question often lands mid-chunk ("yeah so, what's
// your approach here").
const Question = window.EchoQuestionCore;
// What kind of thing did they say (question, opinion request, disagreement,
// proposal, problem, small talk...) and does it need an automatic answer in
// this mode -- see intent-core.js. Interview mode triggers exactly as
// before (looksLikeQuestion); meeting / general also trigger on
// disagreement, proposals, problems and requests for ideas.
const Intent = window.EchoIntentCore;
// Deepgram mode: start an automatic answer from the interviewer's interim
// text once it reads like a complete question and has stopped changing, and
// label which end-of-speech signal started each answer -- see
// early-start-core.js and "Early start" below.
const EarlyStart = window.EchoEarlyStartCore;

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
// The wait itself is Question.autoSuggestDelay():
//   - Deepgram heard the end of a question (speech_final): right away.
//   - A question the VAD cut at a pause (Groq): 150 ms.
//   - Another finished sentence at a pause: 300 ms.
//   - Anything else (trailing off "...", "and the", a mid-speech cut, fixed
//     chunks): wait AUTO_SUGGEST_QUIET_MS for more.
const AUTO_SUGGEST_QUIET_MS = Question.QUIET_MS;
const MIN_NEW_THEM_CHARS = 12;
// Two "Them" lines this close together count as one question ("Re: ..." line).
const QUESTION_JOIN_MS = 10000;
let autoSuggestTimer = null;
let lastAutoQuestionKey = '';
// The intent of the line that scheduled the pending automatic suggestion.
let pendingTriggerIntent = null;
let themCharsTotal = 0;
let themCharsAtLastAuto = 0;
// Which end-of-speech signal scheduled the pending automatic suggestion
// (Diagnostics > Last answer timing): { trigger, detail, gapMs }.
let pendingAutoTrigger = null;

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
const suggestionPlaceholderTitle = document.getElementById('suggestion-placeholder-title');
const suggestionPlaceholderHint = document.getElementById('suggestion-placeholder-hint');
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
const transcriptBadge = document.getElementById('transcript-badge');
const knowledgeBadge = document.getElementById('knowledge-badge');
const screenBadge = document.getElementById('screen-badge');
const screenEmptyHint = document.getElementById('screen-empty-hint');
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
const deepgramKeyField = document.getElementById('deepgram-key-field');
const deepgramKeyInput = document.getElementById('deepgram-key-input');
const deepgramKeyState = document.getElementById('deepgram-key-state');
const openDeepgramKeysBtn = document.getElementById('open-deepgram-keys-btn');
const groqKeyOptional = document.getElementById('groq-key-optional');
const deepgramKeyOptional = document.getElementById('deepgram-key-optional');
const sttProviderSelect = document.getElementById('stt-provider-select');
const sttProviderNote = document.getElementById('stt-provider-note');
const removeKeysBtn = document.getElementById('remove-keys-btn');
const settingsMessage = document.getElementById('settings-message');
const settingsStorageNote = document.getElementById('settings-storage-note');
const hideFromShareBtn = document.getElementById('hide-from-share-btn');
const contentProtectionBadge = document.getElementById('content-protection-badge');

// Header pills, compact bar, summary/diagnostics, answer settings
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

// Buttons are icon + text label (or icon only): change the label without
// wiping the icon. Dock badges: a small count, hidden at zero.
function setBtnLabel(btn, text) {
  const label = btn.querySelector('.btn-label, .menu-label');
  (label || btn).textContent = text;
}
function setDockBadge(badgeEl, count) {
  badgeEl.textContent = count > 99 ? '99+' : String(count || '');
  badgeEl.classList.toggle('hidden', !count);
}

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
  'transcribeChunk', 'startSttStream', 'generateSuggestion', 'askFollowUp', 'summarizeSession', 'testKeys',
]);
// Sent ~10 times a second per stream while someone talks: no wrapping.
const PASS_THROUGH = new Set(['sendSttAudio']);

// Named `api`, not `assistant`: a top-level `const assistant` clashes with the
// window.assistant global the preload script exposes (SyntaxError at load).
const api = {};
for (const name of Object.keys(window.assistant)) {
  const fn = window.assistant[name];
  if (typeof fn !== 'function') continue;
  if (/^on[A-Z]/.test(name) || PASS_THROUGH.has(name)) {
    api[name] = fn; // event subscriptions / fire-and-forget -- nothing to wrap
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
// Flipped on by any Groq/Gemini/Deepgram call failing with OFFLINE (network
// unreachable), off again by any call reaching the provider. There's no
// Echo server to probe, so the next real request is the retry.
let aiOffline = false;

function setOffline(offline) {
  if (offline === aiOffline) return;
  aiOffline = offline;
  setBanner('offline', offline
    ? (navigator.onLine === false
      ? "You're offline -- answers are paused until the connection is back."
      : "Can't reach the speech or answer service -- check your connection. Echo retries with the next request.")
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
  groqKeySet: false, geminiKeySet: false, deepgramKeySet: false,
  groqSource: null, geminiSource: null, deepgramSource: null,
  canSave: true, cannotSaveReason: '',
};

// ---- Speech-to-text provider (Settings > Speech-to-text) ----
// 'groq' (default): clips cut at pauses -> Groq Whisper. 'deepgram': live
// PCM stream -> Deepgram Nova-3 via main (deepgram.js); Groq, if its key is
// set, is the automatic fallback. Stored per computer; applies on the next
// Start Listening.
const SttCore = window.EchoSttCore;
const STT_PROVIDER_KEY = 'echo.sttProvider';
let sttProvider = 'groq';
try {
  sttProvider = SttCore.normalizeProvider(localStorage.getItem(STT_PROVIDER_KEY));
} catch (err) { /* default is fine */ }

function sttReadiness() {
  return SttCore.readiness(keyStatus, sttProvider);
}

// Gemini + the chosen speech-to-text provider's key.
function keysReady() {
  return sttReadiness().ready;
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
  deepgramKeyState.textContent = describeKeySource(keyStatus.deepgramSource);
  groqKeyState.classList.toggle('set', !!keyStatus.groqKeySet);
  geminiKeyState.classList.toggle('set', !!keyStatus.geminiKeySet);
  deepgramKeyState.classList.toggle('set', !!keyStatus.deepgramKeySet);
  syncSttProviderUI();

  const anySet = keyStatus.groqKeySet || keyStatus.geminiKeySet || keyStatus.deepgramKeySet;
  const hasSaved = [keyStatus.groqSource, keyStatus.geminiSource, keyStatus.deepgramSource].includes('saved');
  removeKeysBtn.disabled = !hasSaved;
  testKeysBtn.disabled = !anySet;
  saveKeysBtn.disabled = !keyStatus.canSave;
  groqKeyInput.disabled = !keyStatus.canSave;
  geminiKeyInput.disabled = !keyStatus.canSave;
  deepgramKeyInput.disabled = !keyStatus.canSave;

  const notes = [];
  if (!keyStatus.canSave) {
    notes.push(`Can't save keys securely on this system: ${keyStatus.cannotSaveReason} Put GROQ_API_KEY and GEMINI_API_KEY (and DEEPGRAM_API_KEY if you use it) in a .env file next to package.json instead (see README), then restart Echo.`);
  } else {
    notes.push("Saved keys are encrypted with your operating system's keychain and stored only on this computer. Echo never shows them again after saving.");
  }
  if ([keyStatus.groqSource, keyStatus.geminiSource, keyStatus.deepgramSource].includes('env')) {
    notes.push('Keys marked "From .env" come from your .env file -- edit or delete that file to change them.');
  }
  settingsStorageNote.textContent = notes.join(' ');

  setBanner('keys', SttCore.missingKeysBanner(sttReadiness()) || null);
  syncListeningUI();
}

// Settings: the Deepgram key field shows when Deepgram is picked (or a
// Deepgram key is already set); Groq is marked optional (fallback) then.
function syncSttProviderUI() {
  const dg = sttProvider === 'deepgram';
  sttProviderSelect.value = sttProvider;
  deepgramKeyField.classList.toggle('hidden', !dg && !keyStatus.deepgramKeySet);
  // Whichever speech-to-text key isn't the chosen one is marked optional.
  groqKeyOptional.classList.toggle('hidden', !dg);
  deepgramKeyOptional.classList.toggle('hidden', dg);
  sttProviderNote.textContent = dg
    ? 'Words appear live as people talk, and answers start sooner. Needs a Deepgram key. If Deepgram fails, Echo falls back to Groq when a Groq key is set.'
    : 'Audio is sent in short clips at natural pauses (about half a second after someone stops). Free with a Groq key.';
}

function setSttProvider(value) {
  const next = SttCore.normalizeProvider(value);
  const changed = next !== sttProvider;
  sttProvider = next;
  try { localStorage.setItem(STT_PROVIDER_KEY, sttProvider); } catch (err) { /* not remembered -- fine */ }
  applyKeyStatus();
  if (changed && listening) showToast('Speech-to-text change applies the next time you press Start.', 4000);
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
    // The first key that's still missing, in the order the fields appear.
    const missing = sttReadiness().missing;
    const inputs = { Groq: groqKeyInput, Gemini: geminiKeyInput, Deepgram: deepgramKeyInput };
    (inputs[missing[0]] || groqKeyInput).focus();
  }, 0);
}

function closeSettings() {
  settingsOverlay.classList.add('hidden');
  settingsOverlay.classList.remove('see-through-peek');
  groqKeyInput.value = '';
  geminiKeyInput.value = '';
  deepgramKeyInput.value = '';
  setSettingsMessage('');
}

function syncContentProtectionUI(enabled) {
  setBtnLabel(hideFromShareBtn, enabled ? 'Hide from Screen Share: On' : 'Hide from Screen Share: Off');
  hideFromShareBtn.classList.toggle('active', enabled);
  contentProtectionBadge.classList.toggle('hidden', !enabled);
}

// The first-line model is looked up after the first answer request, so the
// diagnostics panel re-reads this when it opens.
async function refreshModelsText() {
  const { groqModel, geminiModel, headlineModel, deepgramModel } = await api.getConfigStatus();
  modelsText = `${groqModel || '?'} / ${deepgramModel || '?'} (speech-to-text), ${geminiModel || '?'} (answers), ${headlineModel || geminiModel || '?'} (first line)`;
  modelNote.textContent = `Answers use ${geminiModel || 'the default Gemini model'}. Google retires older Flash models over time -- to use a newer Gemini Flash model, set GEMINI_MODEL in your .env file and restart Echo.`;
}

async function init() {
  syncListeningUI();
  try {
    await refreshModelsText();
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
refreshBrief();

minimizeBtn.addEventListener('click', () => api.minimizeWindow());
// × quits Echo completely (stopping any session first).
async function quitEcho() {
  try { if (listening) await stopListening(); } catch (e) { /* quitting anyway */ }
  api.quitApp();
}
hideBtn.addEventListener('click', quitEcho);
document.getElementById('quit-menu-btn').addEventListener('click', quitEcho);

api.onGenerateHotkey(() => requestSuggestion(undefined, { question: null }));
api.onClearHotkey(() => clearTranscript());
// Click-through dims the overlay (#app.click-through in styles.css: 0.55
// when solid, less when see-through is on since the background is already
// thin). It only changes opacity; see-through only changes background alpha,
// so the two stack instead of fighting.
api.onClickThroughChanged((enabled) => {
  appEl.classList.toggle('click-through', !!enabled);
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
  compactBtn.setAttribute('aria-label', compactMode ? 'Back to the full view' : 'Compact bar');
  if (compactMode) closeDrawer();
  suggestionBodyEl.scrollTop = 0;
}
function exitCompact() {
  if (compactMode) api.setCompact(false).catch(() => {});
}
compactBtn.addEventListener('click', () => {
  api.setCompact(!compactMode).catch((err) => showToast('Could not switch view: ' + err.message));
});

// ---- Transcript ----
// meta (from the recorder): { cut: 'silence' | 'max' | 'timer', speechEndAt, live }
//   cut = why the chunk ended; speechEndAt = performance.now() of the last
//   voiced audio in it (for the latency stat in Diagnostics); live = a
//   Deepgram final at end of speech.
let lastThemChunk = null; // { speechEndAt, transcribedAt }

function autoSuggestDelay(text, meta) {
  return Question.autoSuggestDelay(text, meta);
}

function appendLine(speaker, text, meta = null) {
  if (!text) return;
  transcriptLines.push({ speaker, text, ts: Date.now() });

  const div = document.createElement('div');
  div.className = `line ${speaker === 'You' ? 'you' : 'them'}`;
  div.innerHTML = `<span class="speaker">${speaker}:</span> ${escapeHtml(text)}`;
  // Finished lines go above any live (in-progress) lines, which stay last.
  transcriptEl.insertBefore(div, transcriptEl.querySelector('.line.interim'));
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  noteTranscriptLineForDock();

  const delay = autoSuggestDelay(text, meta);
  let trigger = null;
  if (speaker === 'Them') {
    themCharsTotal += text.length;
    const now = performance.now();
    lastThemChunk = {
      speechEndAt: meta && Number.isFinite(meta.speechEndAt) ? meta.speechEndAt : now,
      transcribedAt: now,
    };
    trigger = signalTrigger(EarlyStart.triggerFor({ stt: meta && meta.stt, cut: meta && meta.cut, reason: meta && meta.endReason }), lastThemChunk.speechEndAt, now);
    // The final line of an utterance an early request was started on: the
    // same question -> that request answers it, nothing more to do here.
    if (reconcileEarlyStart(text) === 'keep') return;
    // They're still talking: push a scheduled auto-suggestion back.
    if (autoSuggestTimer) scheduleAutoSuggest(delay, trigger);
  }

  // This is the chunk we were waiting for (the rest of a question that
  // spilled over): answer after the quiet window with the fuller text.
  if (awaitingNextThemLine && speaker === 'Them') {
    awaitingNextThemLine = false;
    clearTimeout(pendingQuestionTimer);
    pendingQuestionTimer = null;
    pendingTriggerIntent = null; // worked out again on the whole question
    scheduleAutoSuggest(delay, trigger);
    return;
  }

  // Auto-suggest when the other side said something the user should answer:
  // a question (every mode), or in meetings / general conversation also a
  // disagreement, a proposal, a problem or a request for ideas.
  const decision = speaker === 'Them' ? autoTriggerDecision(text) : null;
  if (decision) noteAutoTrigger(decision);
  if (decision && decision.trigger) {
    pendingTriggerIntent = decision.intent;
    if (/\?\s*$/.test(text.trim()) || (meta && meta.cut === 'silence')) {
      // Ends with "?", or they stopped talking: the question is done.
      scheduleAutoSuggest(delay, trigger);
    } else {
      // A question started but may continue in the next chunk: wait for it
      // (with a safety-net timeout) rather than answering half a question.
      awaitingNextThemLine = true;
      cancelAutoSuggest(); // more is coming -- wait for it instead
      clearTimeout(pendingQuestionTimer);
      pendingQuestionTimer = setTimeout(() => {
        awaitingNextThemLine = false;
        pendingQuestionTimer = null;
        // Already waited well past the quiet window.
        autoSuggest(signalTrigger({ trigger: 'other', detail: 'timeout' }, lastThemChunk && lastThemChunk.speechEndAt, performance.now()));
      }, (meta && meta.cut === 'max' ? VAD_MAX_CHUNK_MS : CHUNK_MS) + 4000); // one full chunk + generous STT margin
    }
  }
}

// The intent of a "Them" line, plus whether it should fire an automatic
// suggestion in the current mode (intent-core.js, pure + unit-tested).
function intentContext() {
  const recent = answerHistory.slice(-2);
  let youIndex = -1;
  for (let i = transcriptLines.length - 1; i >= 0; i--) {
    if (transcriptLines[i].speaker === 'You') { youIndex = i; break; }
  }
  const recentYou = youIndex === -1 ? null : {
    themLinesSince: transcriptLines.slice(youIndex + 1).filter((l) => l.speaker === 'Them').length,
    msSince: Date.now() - transcriptLines[youIndex].ts,
  };
  return {
    mode: modeSelect.value,
    speaker: 'them',
    prior: {
      hasPriorAnswer: answerHistory.length > 0,
      lastAnswerTechnical: recent.some((a) => /```/.test(a.text || '') || Intent.looksTechnical(a.question || '')),
    },
    recentYou,
  };
}

function classifyForSend(text) {
  return Intent.classifyIntent(text || '', intentContext());
}

// { trigger, intent } for the "Them" line that just landed.
function autoTriggerDecision(text) {
  const ctx = intentContext();
  const intent = Intent.classifyIntent(text, ctx);
  return { trigger: Intent.shouldAutoTrigger(intent, ctx), intent };
}

// Diagnostics only: why the last "Them" line did or didn't fire.
let lastAutoNote = 'nothing yet';
let lastThreadNote = 'none yet'; // Diagnostics: the interview thread of the last answer (main's session state)
function noteAutoTrigger(decision) {
  const { intent } = decision;
  lastAutoNote = decision.trigger
    ? `fired (${intent.intent}, ${intent.confidence})`
    : `not needed (${intent.intent})`;
  if (!diagnosticsOverlay.classList.contains('hidden')) renderDiagnostics();
}

// ---- Live (interim) lines: Deepgram mode only ----
// One dimmed in-progress line per speaker at the bottom of the transcript,
// replaced as Deepgram refines its guess and removed when the final line
// lands (appendLine). Never part of the transcript sent to Gemini; a "Them"
// interim can start an automatic answer early (see "Early start" below).
const interimEls = new Map(); // speaker -> element

function setInterimLine(speaker, text) {
  let el = interimEls.get(speaker);
  const t = String(text || '').trim();
  if (!t) {
    if (el) el.remove();
    interimEls.delete(speaker);
    return;
  }
  const nearBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 40;
  if (!el) {
    el = document.createElement('div');
    el.className = `line ${speaker === 'You' ? 'you' : 'them'} interim`;
    el.title = 'Still listening -- this line may change';
    transcriptEl.appendChild(el);
    interimEls.set(speaker, el);
  }
  el.innerHTML = `<span class="speaker">${speaker}:</span> ${escapeHtml(t)}`;
  if (nearBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function clearInterimLines() {
  for (const el of interimEls.values()) el.remove();
  interimEls.clear();
}

// Deepgram said they've stopped talking (UtteranceEnd after a line that was
// cut for length, or after a line that trailed off): the question that was
// waiting for its second half -- or a 1.5 s "maybe there's more" wait -- is
// done, so answer now. UtteranceEnd comes ~1 s after the last word: it's the
// fallback for when speech_final didn't settle it.
function handleEndOfSpeech(speaker, speechEndAt, reason) {
  if (speaker !== 'Them') return;
  const now = performance.now();
  if (lastThemChunk) lastThemChunk = { speechEndAt, transcribedAt: now };
  const trigger = signalTrigger(EarlyStart.triggerFor({ stt: 'deepgram', reason: reason || 'utterance_end' }), speechEndAt, now);
  if (awaitingNextThemLine) {
    awaitingNextThemLine = false;
    clearTimeout(pendingQuestionTimer);
    pendingQuestionTimer = null;
    scheduleAutoSuggest(Question.LIVE_QUESTION_DELAY_MS, trigger);
  } else if (autoSuggestTimer) {
    scheduleAutoSuggest(Question.LIVE_QUESTION_DELAY_MS, trigger);
  }
}

// { trigger, detail } + how long after the last voiced audio the signal came.
function signalTrigger(t, speechEndAt, at) {
  return { trigger: t.trigger, detail: t.detail || '', gapMs: msBetween(speechEndAt, at), outcome: '' };
}

// ---- Early start (Deepgram mode, "Them" only, automatic answers only) ----
// Deepgram's speech_final doesn't always fire (e.g. on TTS or music-backed
// system audio); the line then waits for UtteranceEnd (~1 s) plus
// processing. So while the interviewer's interim text is on screen, once it
// reads like a complete question that needs an answer and has not changed
// for EarlyStart.EARLY_START_MS (350 ms), the automatic request starts with
// that text as its question (trigger 'early_interim'). The interim text is
// never added to the transcript: the request's transcript is the finished
// lines only, the question travels separately.
// When the final line lands, appendLine() -> reconcileEarlyStart():
//   keep     same words (punctuation / fillers / a trailing "okay" aside):
//            the request in flight answers it; de-dup marks it answered.
//   restart  they kept talking or the words changed: the de-dup state goes
//            back to before the early start and the normal path judges the
//            full line; its request supersedes the early one (CALM rule in
//            requestSuggestion: an early answer already on screen for
//            SWAP_WINDOW_MS is left to finish and the new one waits behind
//            the "New answer ready" chip).
// Never for "You", in Privacy Mode, on Groq (no interim text) or for
// requests the user asked for.
const earlyStart = {
  text: '', // the current "Them" utterance (settled pieces + latest guess)
  confidence: null,
  changedAt: 0,
  timer: null,
  // The early request for the current utterance, until its final lands:
  // { text, key, prevKey, prevChars, trigger, intent, reqId, failed }
  fired: null,
};

function noteThemInterim(text, confidence) {
  const t = String(text || '').trim();
  if (t === earlyStart.text) return;
  earlyStart.text = t;
  earlyStart.confidence = Number.isFinite(confidence) ? confidence : null;
  earlyStart.changedAt = performance.now();
  clearTimeout(earlyStart.timer);
  earlyStart.timer = t ? setTimeout(maybeEarlyStart, EarlyStart.EARLY_START_MS) : null;
}

// The utterance ended (final line / end of speech): stop watching it.
function clearEarlyInterim() {
  clearTimeout(earlyStart.timer);
  earlyStart.timer = null;
  earlyStart.text = '';
  earlyStart.confidence = null;
}

function resetEarlyStart() {
  clearEarlyInterim();
  earlyStart.fired = null;
}

function maybeEarlyStart() {
  earlyStart.timer = null;
  if (!listening) return;
  const text = earlyStart.text;
  const provider = systemRecorder && systemRecorder.mode() === 'deepgram' ? 'deepgram' : 'groq';
  const decision = EarlyStart.shouldEarlyStart({
    text,
    lastChangeAt: earlyStart.changedAt,
    now: performance.now(),
    speaker: 'Them',
    provider,
    privacy: privacyModeEnabled,
    confidence: earlyStart.confidence,
    mode: modeSelect.value,
    intentCtx: intentContext(),
  });
  if (!decision.fire) return;
  const prior = earlyStart.fired;
  // Already answering this (they paused again on the same words).
  if (prior && EarlyStart.reconcileFinal({ provisional: prior.text, final: text }) === 'keep') return;
  const question = earlyQuestion(text);
  const key = questionKey(question);
  if (!key || key === lastAutoQuestionKey) return; // already answered this one
  if (themCharsTotal + text.length - themCharsAtLastAuto < MIN_NEW_THEM_CHARS) return; // tiny change
  const now = performance.now();
  const speechEndAt = liveSpeechEndAt('Them');
  const trigger = signalTrigger({ trigger: 'early_interim' }, speechEndAt, now);
  trigger.outcome = 'pending';
  earlyStart.fired = {
    text,
    key,
    // De-dup state to go back to on a restart (from the first early start
    // of this utterance, if it fired more than once).
    prevKey: prior ? prior.prevKey : lastAutoQuestionKey,
    prevChars: prior ? prior.prevChars : themCharsAtLastAuto,
    trigger,
    intent: decision.intent,
    reqId: null,
    failed: false,
  };
  lastAutoQuestionKey = key;
  themCharsAtLastAuto = themCharsTotal + text.length; // the final line will add about this much
  awaitingNextThemLine = false;
  clearTimeout(pendingQuestionTimer);
  pendingQuestionTimer = null;
  pendingTriggerIntent = null;
  cancelAutoSuggest();
  lastAutoNote = `fired early (${decision.intent.intent}, ${decision.intent.confidence})`;
  if (!diagnosticsOverlay.classList.contains('hidden')) renderDiagnostics();
  requestSuggestion(undefined, {
    question,
    auto: true,
    intent: decision.intent,
    trigger,
    early: earlyStart.fired,
    latencyFrom: { speechEndAt, transcribedAt: now },
  });
}

// Like recentThemQuestion(), with the provisional text as their last line.
function earlyQuestion(text) {
  let prev = null;
  for (let i = transcriptLines.length - 1; i >= 0; i--) {
    if (transcriptLines[i].speaker === 'Them') { prev = transcriptLines[i]; break; }
  }
  return prev && Date.now() - prev.ts <= QUESTION_JOIN_MS ? `${prev.text} ${text}` : text;
}

// A "Them" final line landed (appendLine): 'keep' | 'restart' | null (no
// early request for this utterance).
function reconcileEarlyStart(finalText) {
  clearEarlyInterim();
  const early = earlyStart.fired;
  earlyStart.fired = null;
  if (!early) return null;
  const verdict = early.failed ? 'restart' : EarlyStart.reconcileFinal({ provisional: early.text, final: finalText });
  early.trigger.outcome = verdict === 'keep' ? 'kept' : 'restarted';
  if (verdict === 'keep') {
    // Answered: the normal path must not ask again for this line.
    lastAutoQuestionKey = questionKey(recentThemQuestion());
    themCharsAtLastAuto = themCharsTotal;
    awaitingNextThemLine = false;
    clearTimeout(pendingQuestionTimer);
    pendingQuestionTimer = null;
    pendingTriggerIntent = null;
    cancelAutoSuggest();
    lastAutoNote = `fired early, kept (${early.intent.intent})`;
  } else if (lastAutoQuestionKey === early.key) {
    // Judge the full line as if the early start hadn't happened.
    lastAutoQuestionKey = early.prevKey;
    themCharsAtLastAuto = early.prevChars;
  }
  if (!diagnosticsOverlay.classList.contains('hidden')) renderDiagnostics();
  return verdict;
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

function scheduleAutoSuggest(delay = AUTO_SUGGEST_QUIET_MS, trigger = null) {
  clearTimeout(autoSuggestTimer);
  if (trigger) pendingAutoTrigger = trigger;
  autoSuggestTimer = setTimeout(() => {
    autoSuggestTimer = null;
    autoSuggest(pendingAutoTrigger);
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
// trigger: which end-of-speech signal released it (Diagnostics).
function autoSuggest(trigger = null) {
  pendingAutoTrigger = null;
  if (privacyModeEnabled || !listening) return;
  const question = recentThemQuestion();
  const key = questionKey(question);
  if (!key || key === lastAutoQuestionKey) return; // already answered this one
  if (themCharsTotal - themCharsAtLastAuto < MIN_NEW_THEM_CHARS) return; // tiny change
  lastAutoQuestionKey = key;
  themCharsAtLastAuto = themCharsTotal;
  const intent = pendingTriggerIntent || classifyForSend(question);
  pendingTriggerIntent = null;
  requestSuggestion(undefined, { question, auto: true, intent, trigger: trigger || { trigger: 'other', detail: '', gapMs: null, outcome: '' } });
}

// Clearing the transcript starts a fresh session: earlier answers and any
// waiting auto-suggestion go too (the answer on screen stays until replaced).
function clearTranscript() {
  transcriptLines.length = 0;
  transcriptEl.innerHTML = '';
  resetTranscriptUnread();
  interimEls.clear();
  awaitingNextThemLine = false;
  clearTimeout(pendingQuestionTimer);
  pendingQuestionTimer = null;
  cancelAutoSuggest();
  lastAutoQuestionKey = '';
  pendingTriggerIntent = null;
  pendingAutoTrigger = null;
  resetEarlyStart();
  themCharsTotal = 0;
  themCharsAtLastAuto = 0;
  lastThemChunk = null;
  answerHistory.length = 0;
  clearPendingAnswer();
  resetInterviewSession();
}

// Main keeps the interview's thread / fact state in memory for the current
// listening session; Stop and Clear transcript drop it.
function resetInterviewSession() {
  lastThreadNote = 'none yet';
  if (typeof api.resetInterviewSession !== 'function') return;
  api.resetInterviewSession().catch((err) => console.warn('Could not reset the interview session:', err.message));
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
    knowledgeStatusEl.textContent = 'No files yet. Add your CV or notes (.txt or .md) and answers will draw on them.';
    setDockBadge(knowledgeBadge, 0);
    return;
  }
  setDockBadge(knowledgeBadge, status.fileCount);
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

// ---- Interview brief (all optional; main.js / interview-brief.js) ----
const briefForm = document.getElementById('brief-form');
const briefCompanyRole = document.getElementById('brief-company-role');
const briefType = document.getElementById('brief-type');
const briefJobAd = document.getElementById('brief-job-ad');
const briefNotes = document.getElementById('brief-notes');
const briefStatusEl = document.getElementById('brief-status');
const briefBadge = document.getElementById('brief-badge');
const saveBriefBtn = document.getElementById('save-brief-btn');
const clearBriefBtn = document.getElementById('clear-brief-btn');
let briefPollTimer = null;

function briefStatusText(view) {
  if (!view || view.empty) return 'No brief: Echo answers as usual.';
  const bits = ['Saved.'];
  if (view.brief.jobAd) {
    if (view.summaryStatus === 'pending') bits.push('Summarising the job ad…');
    else if (view.summaryStatus === 'ready') bits.push('Job ad summarised.');
    else if (view.summaryStatus === 'failed') bits.push("Couldn't summarise the job ad yet, so Echo uses the start of it.");
  }
  if (modeSelect.value !== 'interview') bits.push('Switch to Interview mode to use it.');
  return bits.join(' ');
}

function renderBrief(view, { fillForm = false } = {}) {
  if (!view) return;
  if (fillForm) {
    briefCompanyRole.value = view.brief.companyRole || '';
    briefType.value = view.brief.type || 'auto';
    briefJobAd.value = view.brief.jobAd || '';
    briefNotes.value = view.brief.notes || '';
  }
  briefBadge.textContent = view.empty ? '' : '✓';
  briefBadge.classList.toggle('hidden', !!view.empty);
  briefStatusEl.textContent = briefStatusText(view);
  clearTimeout(briefPollTimer);
  // The summary runs in main; check back until it's done (it never takes long).
  if (view.summaryStatus === 'pending') {
    briefPollTimer = setTimeout(async () => {
      try { renderBrief(await api.getBrief()); } catch (e) { /* keep the last status */ }
    }, 1500);
  }
}

async function refreshBrief() {
  try {
    renderBrief(await api.getBrief(), { fillForm: true });
  } catch (err) {
    briefStatusEl.textContent = 'Could not load the brief.';
  }
}

briefForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  saveBriefBtn.disabled = true;
  try {
    const view = await api.saveBrief({
      companyRole: briefCompanyRole.value,
      type: briefType.value,
      jobAd: briefJobAd.value,
      notes: briefNotes.value,
    });
    renderBrief(view, { fillForm: true });
    showToast(view.empty ? 'Brief cleared' : 'Brief saved');
  } catch (err) {
    briefStatusEl.textContent = 'Could not save the brief: ' + err.message;
  } finally {
    saveBriefBtn.disabled = false;
  }
});

clearBriefBtn.addEventListener('click', async () => {
  try {
    renderBrief(await api.clearBrief(), { fillForm: true });
    showToast('Brief cleared');
  } catch (err) {
    briefStatusEl.textContent = 'Could not clear the brief: ' + err.message;
  }
});

modeSelect.addEventListener('change', () => {
  if (!briefStatusEl.textContent) return;
  api.getBrief().then((view) => renderBrief(view)).catch(() => {});
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
  captureScreenBtn.classList.add('busy');
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
    captureScreenBtn.classList.remove('busy');
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
  screenEmptyHint.classList.toggle('hidden', screenshots.length > 0);
  setDockBadge(screenBadge, screenshots.length);
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

// preferredRate: Deepgram mode asks for a 16 kHz context so Chromium does
// the (high-quality) resampling; pcm-core's Downsampler handles whatever
// rate we actually get.
function getAudioContext(preferredRate) {
  if (audioCtx && audioCtx.state !== 'closed') return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    audioCtx = preferredRate ? new Ctx({ sampleRate: preferredRate }) : new Ctx();
  } catch (err) {
    try {
      audioCtx = new Ctx();
    } catch (err2) {
      console.warn('No AudioContext -- using fixed-length audio chunks:', err2);
      audioCtx = null;
    }
  }
  return audioCtx;
}

// ~21 ms of samples per VAD reading at 48 kHz (1024), ~32 ms at 16 kHz (512).
function vadFftSize(ctx) {
  return ctx.sampleRate <= 24000 ? 512 : 1024;
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
    if (speaker === 'You') showToast('Microphone stopped delivering audio -- check it, then Stop / Start.');
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
    if (speaker === 'You') showToast('Microphone stopped delivering audio -- check it, then Stop / Start.');
    return { stop() {}, mode: () => 'off' };
  }
  indicatorEl.classList.add('active');

  let analyser = null;
  const ctx = Vad ? getAudioContext() : null;
  if (ctx) {
    try {
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = vadFftSize(ctx);
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

// ---- Deepgram live streaming (Settings > Speech-to-text > Deepgram) ----
// Per stream: the same AnalyserNode + VadSegmenter as above, used only for
// the "speaking" halo and to know when someone is talking; raw samples from
// an AudioWorklet (pcm-worklet.js; ScriptProcessorNode if that can't load)
// -> 16 kHz Int16 100 ms frames (pcm-core.js) -> streamed to main only while
// someone talks (AudioGate). Main owns the socket and the key (deepgram.js)
// and sends transcript events back (onSttEvent below).
const Pcm = window.EchoPcmCore || null;
const workletReady = new WeakMap(); // AudioContext -> Promise from addModule

async function createPcmCapture(ctx, source, onSamples) {
  // Silent sink: worklet / script-processor nodes only run when pulled by
  // the destination. Gain 0, so nothing is ever played.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);
  if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
    try {
      if (!workletReady.has(ctx)) workletReady.set(ctx, ctx.audioWorklet.addModule('pcm-worklet.js'));
      await workletReady.get(ctx);
      const node = new AudioWorkletNode(ctx, 'echo-pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1, // Web Audio mixes stereo system audio down to mono for us
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      node.port.onmessage = (e) => { if (e.data instanceof Float32Array) onSamples(e.data); };
      source.connect(node);
      node.connect(sink);
      return {
        kind: 'worklet',
        stop() {
          node.port.onmessage = null;
          try { source.disconnect(node); } catch (err) { /* already gone */ }
          try { node.disconnect(); sink.disconnect(); } catch (err) { /* already gone */ }
        },
      };
    } catch (err) {
      workletReady.delete(ctx);
      console.warn('AudioWorklet unavailable -- using ScriptProcessorNode for live audio:', err && err.message);
    }
  }
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => onSamples(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(proc);
  proc.connect(sink);
  return {
    kind: 'script-processor',
    stop() {
      proc.onaudioprocess = null;
      try { source.disconnect(proc); } catch (err) { /* already gone */ }
      try { proc.disconnect(); sink.disconnect(); } catch (err) { /* already gone */ }
    },
  };
}

// Resolves a pipeline { stop, mode, capture, lastVoicedAt } once Deepgram's
// socket is open; rejects (coded error) if it can't start, so the caller can
// fall back to Groq.
async function startDeepgramStream(stream, speaker, indicatorEl) {
  const ctx = getAudioContext(Pcm ? Pcm.TARGET_RATE : undefined);
  if (!ctx || !Pcm || !Vad) throw Object.assign(new Error('Live audio capture is not available here.'), { code: 'NO_WEB_AUDIO' });
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  await api.startSttStream(speaker);

  let stopped = false;
  let lastVoicedAt = -Infinity;
  let capture = null;
  let vadTimer = null;
  let source = null;
  const pipeline = {
    speaker,
    mode: () => 'deepgram',
    capture: () => (capture ? capture.kind : 'starting'),
    lastVoicedAt: () => lastVoicedAt,
    // remote=false: main already closed the stream (fatal error).
    stop({ remote = true } = {}) {
      if (stopped) return;
      stopped = true;
      clearInterval(vadTimer);
      if (capture) capture.stop();
      try { if (source) source.disconnect(); } catch (err) { /* already gone */ }
      indicatorEl.classList.remove('active', 'speaking');
      setInterimLine(speaker, '');
      if (remote) api.stopSttStream(speaker).catch(() => {});
    },
  };

  try {
    source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = vadFftSize(ctx);
    source.connect(analyser); // never connected to the speakers
    const seg = new Vad.VadSegmenter();
    const samples = new Float32Array(analyser.fftSize);
    vadTimer = setInterval(() => {
      if (stopped || ctx.state !== 'running') return;
      const t = performance.now();
      analyser.getFloatTimeDomainData(samples);
      // Only `voiced` matters here; Deepgram finds the pauses itself.
      const ev = seg.update({ rms: Vad.rms(samples), t });
      indicatorEl.classList.toggle('speaking', ev.voiced);
      if (ev.voiced) lastVoicedAt = t;
    }, VAD_FRAME_MS);

    const down = new Pcm.Downsampler(ctx.sampleRate, Pcm.TARGET_RATE);
    const framer = new Pcm.PcmFramer();
    const gate = new Pcm.AudioGate();
    capture = await createPcmCapture(ctx, source, (block) => {
      if (stopped) return;
      const frames = framer.push(Pcm.floatTo16BitPCM(down.process(block)));
      const now = performance.now();
      for (const frame of frames) {
        for (const out of gate.push(frame, { now, lastVoicedAt })) {
          api.sendSttAudio(speaker, Pcm.int16ToBytes(out));
        }
      }
    });
    if (stopped) capture.stop();
  } catch (err) {
    pipeline.stop();
    throw err;
  }
  indicatorEl.classList.add('active');
  return pipeline;
}

function pipelineFor(speaker) {
  return speaker === 'You' ? micRecorder : systemRecorder;
}

function setPipeline(speaker, pipeline) {
  if (speaker === 'You') micRecorder = pipeline;
  else systemRecorder = pipeline;
}

// Starts one stream on the chosen provider. Deepgram failing to start falls
// back to Groq (if there's a key) for that stream.
async function startStreamPipeline(stream, speaker, indicatorEl, provider) {
  if (provider === 'deepgram') {
    try {
      return await startDeepgramStream(stream, speaker, indicatorEl);
    } catch (err) {
      return deepgramFailed(stream, speaker, indicatorEl, err);
    }
  }
  return startRollingRecorder(stream, speaker, indicatorEl);
}

// Deepgram couldn't start, or gave up after reconnecting: tell the user and
// carry on with Groq Whisper when possible.
function deepgramFailed(stream, speaker, indicatorEl, err) {
  console.warn(`Deepgram stream (${speaker}) failed:`, err.code || '', err.message);
  if (err.code === 'BAD_KEY' || err.code === 'NO_KEY') setBanner('keys', `${err.message} Click here to fix.`);
  if (!listening || !stream) return null;
  const msg = /Deepgram/.test(err.message) ? err.message : `Deepgram: ${err.message}`;
  if (keyStatus.groqKeySet) {
    setBanner('service', `${msg} Using Groq Whisper for now.`);
    return startRollingRecorder(stream, speaker, indicatorEl);
  }
  setBanner('service', msg);
  return null;
}

let lastDeepgramStatus = {}; // speaker -> 'open' | 'reconnecting' | 'closed' (diagnostics)

// performance.now() of the speaker's last voiced audio (the stream's VAD),
// or now if there's none recent.
function liveSpeechEndAt(speaker) {
  const pipeline = pipelineFor(speaker);
  const t = pipeline && pipeline.mode() === 'deepgram' ? pipeline.lastVoicedAt() : -Infinity;
  const now = performance.now();
  return Number.isFinite(t) && now - t < 5000 ? t : now;
}

api.onSttEvent((ev) => {
  if (!ev || (ev.speaker !== 'You' && ev.speaker !== 'Them')) return;
  const speaker = ev.speaker;
  const pipeline = pipelineFor(speaker);
  const live = !!pipeline && pipeline.mode() === 'deepgram';
  const speechEndAt = () => liveSpeechEndAt(speaker);
  switch (ev.kind) {
    case 'interim':
      if (listening && live) {
        const text = typeof ev.text === 'string' ? ev.text : '';
        setInterimLine(speaker, text);
        if (speaker === 'Them') noteThemInterim(text, ev.confidence);
      }
      break;
    case 'final': {
      setInterimLine(speaker, '');
      const text = typeof ev.text === 'string' ? ev.text.trim() : '';
      // Finals flushed right after Stop still count (like a Groq chunk
      // already cut at a pause).
      if (!text) break;
      transcribeFailures = 0;
      // endOfSpeech = Deepgram heard the pause (speech_final / UtteranceEnd):
      // to the auto-suggest logic that's the same as a VAD cut at a pause,
      // except a question fires straight away (live: no extra wait -- the
      // endpointing pause, 200 ms by default, already happened).
      appendLine(speaker, text, {
        cut: ev.endOfSpeech ? 'silence' : 'max',
        live: !!ev.endOfSpeech,
        speechEndAt: speechEndAt(),
        stt: 'deepgram',
        endReason: typeof ev.reason === 'string' ? ev.reason : '',
      });
      break;
    }
    case 'end-of-speech':
      setInterimLine(speaker, '');
      if (speaker === 'Them') clearEarlyInterim();
      handleEndOfSpeech(speaker, speechEndAt(), typeof ev.reason === 'string' ? ev.reason : '');
      break;
    case 'status':
      lastDeepgramStatus[speaker] = ev.state;
      if (ev.state === 'reconnecting' && listening && live) {
        setBanner('service', 'Live transcription connection dropped -- reconnecting to Deepgram…');
      } else if (ev.state === 'open' && bannerState.service && /reconnecting to Deepgram/.test(bannerState.service)) {
        setBanner('service', null);
      }
      break;
    case 'error': {
      lastDeepgramStatus[speaker] = 'failed';
      if (!ev.fatal || !live) break;
      pipeline.stop({ remote: false });
      setPipeline(speaker, null);
      const err = Object.assign(new Error(String(ev.message || 'Live transcription stopped.')), { code: ev.code });
      const stream = speaker === 'You' ? micStream : systemStream;
      const next = deepgramFailed(stream, speaker, speaker === 'You' ? micIndicator : systemIndicator, err);
      setPipeline(speaker, next);
      if (!micRecorder && !systemRecorder && listening) {
        stopListening();
        showToast(`Listening stopped: ${err.message}`, 7000);
      }
      break;
    }
    default:
      break;
  }
});

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
  // One short line + a quiet hint; the icon follows data-state (styles.css).
  const state = suggestInFlight ? 'thinking' : listening ? 'listening' : keysReady() ? 'idle' : 'keys';
  const copy = {
    thinking: ['Thinking…', ''],
    listening: ['Listening… answers appear when they ask a question', 'Ctrl+Enter to answer now'],
    idle: ['Press Start, answers appear here', 'or Ctrl+Enter to generate one anytime'],
    keys: [`${SttCore.missingKeysHint(sttReadiness())} to get started`, '⋯ menu > API keys'],
  }[state];
  suggestionPlaceholder.dataset.state = state;
  suggestionPlaceholderTitle.textContent = copy[0];
  suggestionPlaceholderHint.textContent = copy[1];
}

function syncListeningUI() {
  // Start needs Gemini + the speech-to-text provider's key; Stop must always work.
  listenBtn.disabled = listenBusy || (!listening && !keysReady());
  if (!listenBusy) setBtnLabel(listenBtn, listening ? 'Stop' : 'Start');
  listenBtn.setAttribute('aria-label', listening ? 'Stop listening' : 'Start listening');
  listenBtn.setAttribute('aria-busy', listenBusy ? 'true' : 'false');
  listenBtn.classList.toggle('recording', listening);
  listenBtn.title = listening
    ? 'Stop listening'
    : keysReady()
      ? 'Listen to mic + system audio and transcribe it'
      : `${SttCore.missingKeysHint(sttReadiness())} first (⋯ menu > API keys)`;
  statusDot.classList.toggle('live', listening);
  statusDot.title = listening ? 'Listening' : 'Not listening';
  appEl.classList.toggle('listening', listening);
  updateSuggestionPlaceholder();
}

async function startListening() {
  if (listenBusy || listening) return;
  if (!keysReady()) {
    openSettings(`${SttCore.missingKeysHint(sttReadiness())} to start listening.`);
    return;
  }
  listenBusy = true;
  setBtnLabel(listenBtn, 'Starting…');
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
  lastDeepgramStatus = {};
  const provider = sttProvider;

  systemIndicator.textContent = 'System audio';
  const hasSystem = !!(systemStream && systemStream.getAudioTracks().length);
  const [mic, system] = await Promise.all([
    startStreamPipeline(micStream, 'You', micIndicator, provider),
    hasSystem ? startStreamPipeline(systemStream, 'Them', systemIndicator, provider) : null,
  ]);
  if (!listening) {
    // Stopped (e.g. keys removed) while the streams were still starting.
    mic?.stop();
    system?.stop();
    return;
  }
  micRecorder = mic;
  systemRecorder = system;
  if (!hasSystem) {
    systemIndicator.textContent = 'System audio (unavailable)';
    showToast("Couldn't capture system audio -- only your mic is being transcribed.", 5000);
  }
  if (!micRecorder && !systemRecorder) {
    // Deepgram couldn't start and there's no Groq key to fall back on.
    await stopListening();
    showToast('Could not start live transcription -- see the message at the top.', 6000);
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
  resetEarlyStart();

  micRecorder?.stop();
  systemRecorder?.stop();
  micRecorder = null;
  systemRecorder = null;
  clearInterimLines();

  releaseStreams();
  closeAudioContext();

  micIndicator.classList.remove('active', 'speaking');
  systemIndicator.classList.remove('active', 'speaking');
  resetInterviewSession();
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
openDeepgramKeysBtn.addEventListener('click', () => {
  api.openKeyPage('deepgram').catch((err) => setSettingsMessage('Could not open the browser: ' + err.message, 'error'));
});
sttProviderSelect.addEventListener('change', () => {
  setSttProvider(sttProviderSelect.value);
  if (sttProvider === 'deepgram' && !keyStatus.deepgramKeySet && keyStatus.canSave) deepgramKeyInput.focus();
});
syncSttProviderUI();

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const groq = groqKeyInput.value.trim();
  const gemini = geminiKeyInput.value.trim();
  const deepgram = deepgramKeyInput.value.trim();
  if (!groq && !gemini && !deepgram) {
    setSettingsMessage('Paste at least one key first.', 'error');
    return;
  }
  saveKeysBtn.disabled = true;
  setSettingsMessage('Saving…', 'info');
  try {
    const status = await api.saveKeys({ groq: groq || undefined, gemini: gemini || undefined, deepgram: deepgram || undefined });
    // The keys now live (encrypted) in the main process only -- drop them here.
    groqKeyInput.value = '';
    geminiKeyInput.value = '';
    deepgramKeyInput.value = '';
    applyKeyStatus(status);
    setSettingsMessage(keysReady()
      ? 'Saved. Checking the keys…'
      : `Saved. ${SttCore.missingKeysHint(sttReadiness())} to start listening.`, 'ok');
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
    const result = await api.testKeys();
    const lines = [];
    const needed = []; // results that must pass for Start Listening
    const dg = sttProvider === 'deepgram';
    const groq = result.groq || { ok: false, message: 'Not set.' };
    const gemini = result.gemini || { ok: false, message: 'Not set.' };
    const deepgram = result.deepgram || { ok: false, message: 'Not set.' };
    if (!dg || keyStatus.groqKeySet) {
      lines.push(`Groq: ${groq.message}${dg ? ' (fallback)' : ''}`);
      if (!dg) needed.push(groq);
    } else {
      lines.push('Groq: not set (optional with Deepgram; it would be the fallback).');
    }
    lines.push(`Gemini: ${gemini.message}`);
    needed.push(gemini);
    if (dg || keyStatus.deepgramKeySet) {
      lines.push(`Deepgram: ${deepgram.message}`);
      if (dg) needed.push(deepgram);
    }
    const allOk = needed.every((r) => r.ok);
    if (allOk) lines.push("You're all set.");
    setSettingsMessage(lines.join('\n'), allOk ? 'ok' : 'error');
  } catch (err) {
    setSettingsMessage('Could not test keys: ' + err.message, 'error');
  } finally {
    testKeysBtn.disabled = !(keyStatus.groqKeySet || keyStatus.geminiKeySet || keyStatus.deepgramKeySet);
  }
}
testKeysBtn.addEventListener('click', () => runKeyTest());
// Esc closes Settings: see the one Escape handler in setupShell (bottom of this file).

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
//   The chip appears as soon as the background answer has its first line
//   (instant first line, or the full answer's first words), not only when
//   it has finished; clicking it then hands the panel to that answer, which
//   keeps streaming in.
// No motion on the answer itself: no dimming while generating (the header
// "Thinking" pill says that), no flash on arrival, and the scroll position
// only resets when an answer the user asked for starts streaming in (or the
// chip is clicked).
//
// INSTANT FIRST LINE (Settings > Answers, default on): main runs a tiny
// parallel Gemini call that writes only the first sentence to say
// (suggest-pipeline.js); its text arrives as 'ai:chunk' events with
// part: 'headline'. Handoff to the full answer (streamView below):
//   1. The headline shows in the big first-line slot (p.headline) as soon as
//      it arrives -- for a request that owns the panel.
//   2. The full answer streams in behind it, invisibly, until ITS OWN first
//      sentence is complete (or its first line is code / a list).
//   3. Then, in one frame, the full answer takes over: its first sentence
//      replaces the headline text in the same slot, and its body appears
//      below. Nothing was below the headline before, so nothing moves down
//      -- the only change is that one line's wording.
//   Why swap instead of keeping the headline on top of the full answer's
//   body: the full answer's body follows from its own first sentence (for a
//   coding answer it's the approach the code below implements), and what's
//   on screen then matches Copy / Shorten / Expand / history exactly. The
//   full answer is always the source of truth.
//   If the full answer's first words arrive before any headline, the
//   headline is dropped (main aborts it; anything late is ignored here).
// Two copies of the chip: answer card header (full view) and top bar (compact bar).
const newAnswerChips = [document.getElementById('new-answer-chip'), document.getElementById('new-answer-chip-compact')];

let shownAnswer = null; // last finished answer put on screen: { text, question, groundingFiles }
let panelState = 'empty'; // 'empty' | 'answer' | 'streaming'
let panelOwnerId = null; // the request currently allowed to write into the panel
let pendingAnswer = null; // finished background answer waiting behind the chip
let pendingStreamReq = null; // background answer still streaming, but with a first line ready
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
// source: 'answer' (the real answer) or 'headline' (instant first line only).
function renderAnswerText(text, style, source = 'answer') {
  const s = style === 'cues' ? 'cues' : 'script';
  const key = `${s}\u0000${source}\u0000${text}`;
  if (renderedSource === key) return;
  renderedSource = key;
  suggestionText.dataset.style = s;
  suggestionText.dataset.source = source;
  suggestionText.innerHTML = safeRenderSuggestion(text, s);
}

// The instant first line, as shown: its first sentence only, no wrapping quotes.
function headlineSentence(raw) {
  const src = toRenderableString(raw).replace(/\r\n/g, '\n').replace(/^\s+/, '');
  const line = (src.split('\n')[0] || '').replace(/^["'“‘]+/, '');
  const end = firstSentenceEnd(line);
  return (end === -1 ? line : line.slice(0, end)).replace(/["'”’]+$/, '').trim();
}

// Has the full answer got a complete first unit to replace the headline
// with? Its first sentence (followed by more text), its first line, or a
// first line that is code / a list (no sentence to wait for).
function fullFirstLineReady(buffer) {
  const src = toRenderableString(buffer).replace(/\r\n/g, '\n').replace(/^\s+/, '');
  if (!src) return false;
  const nl = src.indexOf('\n');
  const firstLine = nl === -1 ? src : src.slice(0, nl);
  if (NON_PROSE_LINE_RE.test(firstLine) || nl !== -1) return true;
  return firstSentenceEnd(firstLine) !== -1;
}

// What a streaming request should show right now: { source, text } or null.
function streamView(req) {
  const headline = req.headline ? headlineSentence(req.headline) : '';
  if (req.buffer.trim() && (req.fullShown || !headline || fullFirstLineReady(req.buffer))) {
    req.fullShown = true;
    return { source: 'answer', text: req.buffer };
  }
  if (!req.fullShown && headline) return { source: 'headline', text: headline };
  return null;
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
  if (req.superseded || panelOwnerId !== req.id) return;
  const view = streamView(req);
  if (!view) return;
  if (!req.started) {
    // First words of an answer the user asked for (or of the first answer):
    // only now does the old answer leave the screen.
    req.started = true;
    req.shownAt = performance.now();
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
  // Text only ever grows at the end, so what's above doesn't move (the one
  // exception: the headline -> full answer handoff described above).
  renderAnswerText(view.text, req.answerStyle, view.source);
}

function syncNewAnswerChips() {
  const show = !!(pendingAnswer || pendingStreamReq);
  newAnswerChips.forEach((chip) => chip.classList.toggle('hidden', !show));
}

function showPendingAnswer(answer) {
  pendingAnswer = answer;
  syncNewAnswerChips();
}

// A background answer has its first line: offer it now (latest wins).
function showPendingStream(req) {
  pendingStreamReq = req;
  syncNewAnswerChips();
}

function dropPendingStream(req) {
  if (pendingStreamReq !== req) return;
  pendingStreamReq = null;
  syncNewAnswerChips();
}

function clearPendingAnswer() {
  pendingAnswer = null;
  pendingStreamReq = null;
  syncNewAnswerChips();
}

newAnswerChips.forEach((chip) => chip.addEventListener('click', () => {
  const req = pendingStreamReq;
  if (req && !req.superseded && suggestRequests.get(req.id) === req) {
    // Still streaming: hand it the panel; the rest streams straight in.
    clearPendingAnswer();
    panelOwnerId = req.id;
    req.started = false;
    renderStreamFrame(req);
    return;
  }
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

// ---- Answer style (Settings + the Script / Cues toggle on the answer card) ----
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
  // Two-segment toggle: both labels stay in the markup, .active = Cues.
  answerStyleChip.setAttribute('aria-label', cues ? 'Answer style: Cues. Click for Script.' : 'Answer style: Script. Click for Cues.');
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

// ---- Instant first line (Settings > Answers) ----
// One extra, tiny Gemini call per suggestion (see INSTANT FIRST LINE above).
// On by default; off saves free-tier quota.
const INSTANT_HEADLINE_KEY = 'echo.instantHeadline';
const instantHeadlineToggle = document.getElementById('instant-headline-toggle');
try {
  instantHeadlineToggle.checked = localStorage.getItem(INSTANT_HEADLINE_KEY) !== '0';
} catch (err) {
  instantHeadlineToggle.checked = true;
}
instantHeadlineToggle.addEventListener('change', () => {
  try { localStorage.setItem(INSTANT_HEADLINE_KEY, instantHeadlineToggle.checked ? '1' : '0'); } catch (err) { /* not remembered -- fine */ }
});
function instantHeadlineEnabled() {
  return instantHeadlineToggle.checked;
}

// ---- SEE-THROUGH (Settings > Appearance > Transparency, Ctrl+Shift+T) ----
// Makes the overlay's *background* see-through so the call or code editor
// behind it shows, while text and icons stay fully opaque (we never use
// BrowserWindow.setOpacity, which would fade the text too). One number,
// 0 (solid, the original look) .. 85 (%), goes into the --see-through CSS
// variable on <html>; styles.css derives every surface's alpha and the
// text/icon legibility halos from it (section 1 + section 10). Default:
// 30% ("Light"): you can see what's behind, and body text stays at ~7:1
// contrast even over a white page, before the halo.
const SEE_THROUGH_KEY = 'echo.transparency';          // current level, '0'..'85'
const SEE_THROUGH_LAST_KEY = 'echo.transparencyLast'; // last level above 0 (Ctrl+Shift+T restores it)
const SEE_THROUGH_MAX = 85;
const SEE_THROUGH_DEFAULT = 30;
const transparencyRange = document.getElementById('transparency-range');
const transparencyValue = document.getElementById('transparency-value');
const transparencySystemNote = document.getElementById('transparency-system-note');
const transparencyPresetBtns = Array.from(document.querySelectorAll('#transparency-presets [data-transparency]'));
const reducedTransparencyQuery = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-transparency: reduce)')
  : null;
let seeThrough = SEE_THROUGH_DEFAULT;
let seeThroughLast = SEE_THROUGH_DEFAULT;

// null for anything that isn't a number (a missing localStorage value included).
function clampSeeThrough(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(SEE_THROUGH_MAX, Math.max(0, Math.round(n)));
}

function systemWantsSolid() {
  return !!(reducedTransparencyQuery && reducedTransparencyQuery.matches);
}

function saveSeeThrough() {
  try {
    localStorage.setItem(SEE_THROUGH_KEY, String(seeThrough));
    localStorage.setItem(SEE_THROUGH_LAST_KEY, String(seeThroughLast));
  } catch (err) { /* not remembered -- fine */ }
}

function applySeeThrough(value, { save = true } = {}) {
  const level = clampSeeThrough(value);
  seeThrough = level === null ? SEE_THROUGH_DEFAULT : level;
  if (seeThrough > 0) seeThroughLast = seeThrough;
  const root = document.documentElement;
  root.style.setProperty('--see-through', (seeThrough / 100).toFixed(2));
  // Halos + lifted text colours only while it's actually see-through, so
  // Solid (and a system that asks for reduced transparency) renders exactly
  // as before.
  if (seeThrough > 0 && !systemWantsSolid()) root.dataset.seeThrough = 'on';
  else delete root.dataset.seeThrough;

  transparencyRange.value = String(seeThrough);
  transparencyRange.style.setProperty('--range-fill', `${(seeThrough / SEE_THROUGH_MAX) * 100}%`);
  transparencyRange.setAttribute('aria-valuetext', seeThrough === 0 ? 'Solid' : `${seeThrough}% see-through`);
  transparencyValue.textContent = seeThrough === 0 ? 'Solid' : `${seeThrough}%`;
  transparencyPresetBtns.forEach((btn) => {
    btn.setAttribute('aria-pressed', Number(btn.dataset.transparency) === seeThrough ? 'true' : 'false');
  });
  if (save) saveSeeThrough();
}

function syncReducedTransparency() {
  const solid = systemWantsSolid();
  transparencySystemNote.classList.toggle('hidden', !solid);
  transparencyRange.disabled = solid;
  transparencyPresetBtns.forEach((btn) => { btn.disabled = solid; });
  applySeeThrough(seeThrough, { save: false });
}

// Ctrl+Shift+T: Solid <-> your level (Light if you've never picked one).
function toggleSeeThrough() {
  if (systemWantsSolid()) {
    showToast('Transparency is off: your system is set to reduce transparency.', 3000);
    return;
  }
  applySeeThrough(seeThrough > 0 ? 0 : (seeThroughLast || SEE_THROUGH_DEFAULT));
  showToast(seeThrough > 0 ? `See-through: ${seeThrough}% (Ctrl+Shift+T for solid)` : 'Solid background (Ctrl+Shift+T for see-through)', 2000);
}

try {
  const last = clampSeeThrough(localStorage.getItem(SEE_THROUGH_LAST_KEY));
  if (last) seeThroughLast = last;
  const saved = clampSeeThrough(localStorage.getItem(SEE_THROUGH_KEY));
  applySeeThrough(saved === null ? SEE_THROUGH_DEFAULT : saved, { save: false });
} catch (err) {
  applySeeThrough(SEE_THROUGH_DEFAULT, { save: false });
}
syncReducedTransparency();
if (reducedTransparencyQuery && typeof reducedTransparencyQuery.addEventListener === 'function') {
  reducedTransparencyQuery.addEventListener('change', syncReducedTransparency);
}

// While you drag (or arrow-key) the slider, Settings itself previews the
// answer card's see-through level (#settings-overlay.see-through-peek).
let seeThroughPeekHeld = false;
let seeThroughPeekTimer = null;
function peekSeeThrough() {
  settingsOverlay.classList.add('see-through-peek');
  clearTimeout(seeThroughPeekTimer);
  if (!seeThroughPeekHeld) {
    seeThroughPeekTimer = setTimeout(() => settingsOverlay.classList.remove('see-through-peek'), 900);
  }
}
function endSeeThroughPeek() {
  if (!seeThroughPeekHeld) return;
  seeThroughPeekHeld = false;
  peekSeeThrough(); // lingers briefly, then Settings goes back to its own background
}
transparencyRange.addEventListener('pointerdown', () => {
  seeThroughPeekHeld = true;
  peekSeeThrough();
});
window.addEventListener('pointerup', endSeeThroughPeek);
window.addEventListener('pointercancel', endSeeThroughPeek);
transparencyRange.addEventListener('input', () => {
  applySeeThrough(transparencyRange.value, { save: false }); // live while dragging
  peekSeeThrough();
});
transparencyRange.addEventListener('change', () => applySeeThrough(transparencyRange.value));
transparencyPresetBtns.forEach((btn) => {
  btn.addEventListener('click', () => applySeeThrough(btn.dataset.transparency));
});
api.onToggleTransparencyHotkey(() => toggleSeeThrough());

// ---- Latency stat (Diagnostics): end of their speech -> first answer word ----
// Measured from the last voiced audio of the latest "Them" chunk (VAD) to
// the first streamed token of the suggestion that followed it -- from either
// call (instant first line or full answer), whichever came first. Includes
// the silence wait, upload + transcription, the auto-suggest delay and
// Gemini's time to first token. Each sample also keeps the split:
//   sendMs      end of speech -> request sent
//   headlineMs  request sent -> first instant-first-line token (null: off / dropped / failed)
//   answerMs    request sent -> first full-answer token
const LATENCY_SAMPLES = 10;
const LATENCY_WINDOW_MS = 30_000; // older speech isn't what the answer is responding to
const latencySamples = []; // { totalMs, sttMs, sendMs, headlineMs, answerMs, via, auto }
let lastTiming = null; // the same split for the latest request, timed from speech or not

function latencyStartFor() {
  if (!lastThemChunk) return null;
  if (performance.now() - lastThemChunk.transcribedAt > LATENCY_WINDOW_MS) return null;
  return { ...lastThemChunk };
}

function msBetween(from, to) {
  return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, Math.round(to - from)) : null;
}

// part: 'headline' | 'answer' (a non-streamed answer counts as 'answer').
function noteFirstToken(req, part = 'answer') {
  const now = performance.now();
  if (part === 'headline' && !req.firstHeadlineAt) req.firstHeadlineAt = now;
  if (part === 'answer' && !req.firstAnswerAt) req.firstAnswerAt = now;
  if (!req.timing) {
    // The first token from either call: that's when there's something to say.
    req.firstTokenAt = now;
    req.timing = {
      totalMs: req.latencyFrom ? msBetween(req.latencyFrom.speechEndAt, now) : null,
      sttMs: req.latencyFrom ? msBetween(req.latencyFrom.speechEndAt, req.latencyFrom.transcribedAt) : null,
      sendMs: req.latencyFrom ? msBetween(req.latencyFrom.speechEndAt, req.sentAt) : null,
      headlineMs: null,
      answerMs: null,
      via: part,
      auto: req.auto,
      trigger: req.trigger, // same object: an early start's kept / restarted shows up later
    };
    lastTiming = req.timing;
    if (req.timing.totalMs !== null) {
      latencySamples.push(req.timing);
      if (latencySamples.length > LATENCY_SAMPLES) latencySamples.shift();
    }
  }
  req.timing.headlineMs = msBetween(req.sentAt, req.firstHeadlineAt);
  req.timing.answerMs = msBetween(req.sentAt, req.firstAnswerAt);
  if (!diagnosticsOverlay.classList.contains('hidden')) renderDiagnostics();
}

function describeLatency() {
  if (!latencySamples.length) return 'no timed answers yet';
  const last = latencySamples[latencySamples.length - 1];
  const avg = Math.round(latencySamples.reduce((n, x) => n + x.totalMs, 0) / latencySamples.length);
  const via = last.via === 'headline' ? 'instant first line' : 'full answer';
  return `last ${last.totalMs} ms (${last.auto ? 'auto' : 'manual'}, via ${via}; speech-to-text ${last.sttMs} ms) · avg of last ${latencySamples.length}: ${avg} ms`;
}

function describeTrigger(tr) {
  if (!tr) return 'trigger: manual';
  const bits = [];
  if (tr.detail) bits.push(tr.detail);
  if (tr.gapMs !== null && tr.gapMs !== undefined) bits.push(`+${tr.gapMs} ms after last audio`);
  if (tr.outcome) bits.push(tr.outcome);
  return `trigger: ${tr.trigger}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

function describeTimingSplit() {
  const t = lastTiming;
  if (!t) return 'no answers yet';
  const fmt = (ms) => (ms === null ? '--' : `${ms} ms`);
  return `${describeTrigger(t.trigger)} · speech end → request ${fmt(t.sendMs)} · request → first line ${t.headlineMs === null ? (instantHeadlineEnabled() ? '-- (none / dropped)' : '-- (off)') : `${t.headlineMs} ms`} · request → full answer ${fmt(t.answerMs)}`;
}

// Streamed text for suggestions and chat answers (see main.js 'ai:chunk').
// payload.part: 'answer' (default) or 'headline' (instant first line).
const chatRequests = new Map(); // requestId -> chat request state
api.onAiChunk((payload) => {
  if (!payload || typeof payload.text !== 'string') return;
  const req = suggestRequests.get(payload.requestId) || chatRequests.get(payload.requestId);
  if (!req || req.superseded) return;
  if (req.kind !== 'suggest') {
    req.buffer += payload.text;
    req.onChunk();
    return;
  }
  if (payload.part === 'headline') {
    // Too late (the full answer is already writing) or turned off: drop it.
    if (!req.useHeadline || (req.buffer && !req.headline)) return;
    req.headline += payload.text;
    noteFirstToken(req, 'headline');
  } else {
    req.buffer += payload.text;
    noteFirstToken(req, 'answer');
  }
  req.onChunk();
});

// opts.question: string -> the question being answered (shown as "Re: ...");
//                null -> none (manual Generate); undefined -> keep the
//                current one (Shorten / Expand / Regenerate).
// opts.auto: true for question-detected suggestions (never replace a
//            visible answer -- see CALM ANSWERS above).
// opts.intent: intent-core.js result for the line being answered (worked
//            out here when missing). Explicit requests always answer: the
//            intent only shapes the prompt, needsResponse is ignored.
// opts.trigger: { trigger, detail, gapMs, outcome } -- the end-of-speech
//            signal that released an automatic request (Diagnostics).
// opts.early: the earlyStart.fired record of an early-start request.
// opts.latencyFrom: { speechEndAt, transcribedAt } instead of the last line's.
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
  const intentInfo = opts.intent || classifyForSend(questionLine || recentThemQuestion() || '');

  // An explicit request supersedes everything in flight; an automatic one
  // only older automatic ones (main.js aborts the same set). CALM rule for
  // early starts: an early answer that owns the panel and has been on screen
  // for EarlyStart.SWAP_WINDOW_MS is spared (it finishes; this one waits
  // behind the chip); before that it is simply replaced.
  const supersedeAt = performance.now();
  let spare;
  for (const r of suggestRequests.values()) {
    if (!auto || r.auto) {
      if (auto && r.early && EarlyStart.keepEarlyOnScreen({ ownsPanel: panelOwnerId === r.id, shownAt: r.shownAt, now: supersedeAt })) {
        spare = r.id;
        continue;
      }
      r.superseded = true;
      suggestRequests.delete(r.id);
      if (panelOwnerId === r.id) panelOwnerId = null;
      dropPendingStream(r);
    }
  }

  const id = newRequestId('s');
  const req = {
    id, kind: 'suggest', auto, questionLine, buffer: '', headline: '', fullShown: false,
    started: false, frameQueued: false, superseded: false,
    answerStyle: currentAnswerStyle(), latencyFrom: opts.latencyFrom || latencyStartFor(), firstTokenAt: null,
    useHeadline: instantHeadlineEnabled(), sentAt: null, firstHeadlineAt: null, firstAnswerAt: null, timing: null,
    trigger: auto ? opts.trigger || null : null, early: auto && !!opts.early, shownAt: null,
  };
  if (req.early) opts.early.reqId = id;
  req.onChunk = () => {
    if (panelOwnerId !== id) {
      // Buffered behind the visible answer: nothing on screen changes, but
      // once it has a first line the "New answer ready" chip offers it.
      if (!req.superseded && pendingStreamReq !== req && streamView(req)) showPendingStream(req);
      return;
    }
    if (req.frameQueued) return;
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
    const payload = {
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
      headline: req.useHeadline,
      intent: intentInfo.intent,
      intentConfidence: intentInfo.confidence,
      spare,
    };
    req.sentAt = performance.now();
    const result = await api.generateSuggestion(payload);
    // They reached Gemini -- clear them unless "Keep screenshots" is on
    // (even if a newer request superseded this one's answer).
    screenshotsSent(shots.ids);
    if (req.superseded) return;
    const isObj = result && typeof result === 'object';
    if ((isObj && result.skipped) || (auto && Intent.isNoResponse(isObj ? result.text : result))) {
      // An automatic suggestion the model judged unnecessary ("nothing to
      // add"): drop it silently. No chip, no panel change, no history. (Only
      // if its instant first line was already showing does the panel go
      // back to what it showed before.)
      dropPendingStream(req);
      if (panelOwnerId === id && req.started) restorePanel();
      lastAutoNote = `skipped: nothing to add (${intentInfo.intent})`;
      if (!diagnosticsOverlay.classList.contains('hidden')) renderDiagnostics();
      return;
    }
    if (auto) lastAutoNote = `answered (${intentInfo.intent})`;
    if (isObj && typeof result.thread === 'string' && result.thread) lastThreadNote = result.thread;
    noteFirstToken(req); // no-op if it streamed; times a non-streamed answer
    // ai:suggest resolves { text, groundingFiles } -- the full answer, which
    // also replaces whatever was streamed (it's authoritative if streaming
    // fell back to a normal request part-way).
    const rawText = (isObj ? result.text : result) || '';
    const answer = {
      // main.js already swaps a "nothing to add" reply for a short line on
      // requests you asked for; this only guards the marker reaching the screen.
      text: Intent.isNoResponse(rawText) ? 'Nothing obvious to add here yet. Try Regenerate.' : (rawText || '(no suggestion returned)'),
      question: questionLine,
      groundingFiles: isObj ? result.groundingFiles : undefined,
      style: (isObj && result.answerStyle) || req.answerStyle,
    };
    dropPendingStream(req);
    if (panelOwnerId === id) displayAnswer(answer, { resetScroll: !req.started });
    else showPendingAnswer(answer);
  } catch (err) {
    dropPendingStream(req);
    if (req.early && !req.superseded) opts.early.failed = true; // the final line then asks again
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
  const actionBtn = e.target.closest('[data-action]');
  const action = actionBtn && actionBtn.dataset.action;
  if (!action) return;
  // main.js rejects instructions over 4000 chars: quote at most 3000.
  const quoted = lastSuggestion.length > 3000 ? `${lastSuggestion.slice(0, 3000)}…` : lastSuggestion;
  if (action === 'copy') {
    const btn = actionBtn;
    const copied = () => {
      setBtnLabel(btn, 'Copied');
      btn.classList.add('copied');
      setTimeout(() => { setBtnLabel(btn, 'Copy'); btn.classList.remove('copied'); }, 1200);
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
  const live = [micRecorder, systemRecorder].filter((r) => r && r.mode() === 'deepgram');
  const recorders = [micRecorder, systemRecorder].filter((r) => r && r.mode() !== 'deepgram');
  const parts = [];
  if (live.length) {
    parts.push(live.map((r) => `${r.speaker}: Deepgram live (${r.capture()}, ${lastDeepgramStatus[r.speaker] || 'open'})`).join('; '));
  }
  if (recorders.length) parts.push(describeRecorderChunking(recorders));
  return parts.length ? parts.join(' · ') : 'not recording';
}

function describeRecorderChunking(recorders) {
  const modes = recorders.map((r) => r.mode());
  if (modes.every((m) => m === 'vad')) {
    const V = window.EchoVadCore;
    return `cut at pauses (${V.SILENCE_MS} ms quiet, max ${V.MAX_CHUNK_MS / 1000} s)`;
  }
  return modes.includes('vad') ? 'mixed: some streams on fixed chunks' : `fixed ${CHUNK_MS / 1000} s chunks (no Web Audio)`;
}

function renderDiagnostics() {
  const rows = [
    ['Listening', listening ? 'yes' : 'no'],
    ['Speech-to-text', SttCore.describeProvider(sttProvider)],
    ['Groq key', describeKeySource(keyStatus.groqSource)],
    ['Gemini key', describeKeySource(keyStatus.geminiSource)],
    ['Deepgram key', describeKeySource(keyStatus.deepgramSource)],
    ['Models', modelsText || '?'],
    ['Network', aiOffline ? "can't reach a provider" : 'ok'],
    ['System audio', systemRecorder ? 'capturing' : 'off'],
    ['Audio chunks', describeChunking()],
    ['Speech end → first answer word', describeLatency()],
    ['Last auto trigger', lastAutoNote],
    ['Thread', lastThreadNote],
    ['Last answer timing', describeTimingSplit()],
    ['Instant first line', instantHeadlineEnabled() ? 'on' : 'off'],
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
    li.textContent = 'No provider calls yet.';
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
    refreshModelsText()
      .then(() => { if (!diagnosticsOverlay.classList.contains('hidden')) renderDiagnostics(); })
      .catch(() => { /* diagnostics only */ });
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
  'Ctrl+Shift+T  See-through background on/off',
  'Ctrl+Shift+P  Privacy mode',
  'Ctrl+Shift+H  Hide from screen share',
  'Ctrl+Shift+D  Diagnostics',
].join('\n');
shortcutsBtn.addEventListener('click', () => showToast(SHORTCUTS_TEXT, 12000));

// ---- "Focus" mode (⋯ menu / Ctrl+Shift+E): the dock goes, the answer card fills the overlay ----
let suggestionExpanded = false;

function setSuggestionExpanded(expanded) {
  suggestionExpanded = expanded;
  appEl.classList.toggle('suggestion-expanded', expanded);
  setBtnLabel(expandSuggestionBtn, expanded ? 'Exit focus mode' : 'Focus mode');
  expandSuggestionBtn.setAttribute('aria-pressed', expanded ? 'true' : 'false');
  if (expanded) closeDrawer();
}

expandSuggestionBtn.addEventListener('click', () => setSuggestionExpanded(!suggestionExpanded));

// ---- ⋯ menu, dock + drawers ----
// The default view is top bar + answer card + dock. Everything else
// (transcript, chat, knowledge base, screen context) is a drawer opened
// from the dock: one at a time, sliding up over the lower part of the
// window; the same dock button, its close button or Esc dismisses it.
const dockButtons = Array.from(document.querySelectorAll('#dock [data-drawer]'));
const drawerEls = Array.from(document.querySelectorAll('#drawers .drawer'));
let openDrawerId = null;
let transcriptUnread = 0;

function setOpenDrawer(id) {
  openDrawerId = id && drawerEls.some((d) => d.id === id) ? id : null;
  drawerEls.forEach((d) => d.classList.toggle('hidden', d.id !== openDrawerId));
  dockButtons.forEach((b) => {
    const on = b.dataset.drawer === openDrawerId;
    b.classList.toggle('active', on);
    b.setAttribute('aria-expanded', on ? 'true' : 'false');
  });
  if (openDrawerId) appEl.dataset.drawer = openDrawerId;
  else delete appEl.dataset.drawer;
  if (openDrawerId === 'transcript-section') {
    resetTranscriptUnread();
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  } else if (openDrawerId === 'chat-section') {
    chatLog.scrollTop = chatLog.scrollHeight;
    chatInput.focus();
  }
}

function closeDrawer() {
  if (!openDrawerId) return;
  const btn = dockButtons.find((b) => b.dataset.drawer === openDrawerId);
  const hadFocus = document.activeElement && document.activeElement.closest('#drawers');
  setOpenDrawer(null);
  if (hadFocus && btn) btn.focus();
}

// Unread count on the transcript dock button: finished lines that arrived
// while its drawer was closed.
function noteTranscriptLineForDock() {
  if (openDrawerId === 'transcript-section') return;
  transcriptUnread += 1;
  setDockBadge(transcriptBadge, transcriptUnread);
}
function resetTranscriptUnread() {
  transcriptUnread = 0;
  setDockBadge(transcriptBadge, 0);
}

(function setupShell() {
  const menuBtn = document.getElementById('menu-btn');
  const menu = document.getElementById('menu');
  const setMenuOpen = (open) => {
    menu.classList.toggle('hidden', !open);
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenuOpen(menu.classList.contains('hidden'));
  });
  menu.addEventListener('click', () => setMenuOpen(false));
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && !menuBtn.contains(e.target)) setMenuOpen(false);
  });

  dockButtons.forEach((btn) => {
    btn.addEventListener('click', () => setOpenDrawer(openDrawerId === btn.dataset.drawer ? null : btn.dataset.drawer));
  });
  document.querySelectorAll('#drawers .drawer-close').forEach((btn) => {
    btn.addEventListener('click', () => closeDrawer());
  });

  // Esc closes the topmost thing: menu, then a full-window panel, then a drawer.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!menu.classList.contains('hidden')) {
      setMenuOpen(false);
      menuBtn.focus();
      return;
    }
    if (!settingsOverlay.classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (!diagnosticsOverlay.classList.contains('hidden')) {
      diagnosticsOverlay.classList.add('hidden');
      return;
    }
    if (!summaryOverlay.classList.contains('hidden')) {
      summaryOverlay.classList.add('hidden');
      return;
    }
    closeDrawer();
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
