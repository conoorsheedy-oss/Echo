// Deepgram live speech-to-text -- the pure part (no sockets, no Electron), so
// it's unit-tested in plain Node (test/deepgram-core.test.js). deepgram.js
// owns the WebSocket and uses these helpers.
//
//   buildListenUrl()        wss://api.deepgram.com/v1/listen?... for one stream
//   parseMessage()          a raw Deepgram JSON message -> a small normalized event
//   createUtteranceAssembler()  Results / UtteranceEnd -> transcript events
//                           for the renderer: 'interim' (the dimmed in-progress
//                           line), 'final' (a finished line) and 'end-of-speech'
//   classifyHandshakeStatus() / classifyClose()  -> friendly, key-free errors
//   reconnectDelay() / idleActions()  reconnect backoff + KeepAlive/Finalize timing
'use strict';

const DEEPGRAM_LISTEN_URL = 'wss://api.deepgram.com/v1/listen';
const DEEPGRAM_PROJECTS_URL = 'https://api.deepgram.com/v1/projects';
const DEFAULT_DEEPGRAM_MODEL = 'nova-3';
const DEFAULT_DEEPGRAM_LANGUAGE = 'en';

// Audio format the renderer sends (src/renderer/pcm-core.js): 16 kHz mono
// signed 16-bit little-endian PCM, ~100 ms per frame.
const SAMPLE_RATE = 16000;
// Deepgram finalizes ("speech_final") after this much silence. 200 ms gets
// the answer started sooner. If a question is split at a breath, the second
// half arrives as a new line: the renderer asks again with both lines joined
// (recentThemQuestion), and that automatic request supersedes the first.
// Override with DEEPGRAM_ENDPOINTING_MS (clamped to 100-1000).
const ENDPOINTING_MS = 200;
const MIN_ENDPOINTING_MS = 100;
const MAX_ENDPOINTING_MS = 1000;
// Backup end-of-speech signal based on word timings, robust to background
// noise that keeps endpointing from firing. 1000 ms is Deepgram's minimum.
const UTTERANCE_END_MS = 1000;
// A line that never reaches an endpoint (non-stop talking) is still cut into
// lines this long, like the Groq path's 12 s safety cut.
const MAX_UTTERANCE_MS = 15000;

// Deepgram closes a stream after ~10 s with neither audio nor a KeepAlive;
// its docs recommend a KeepAlive every 3-5 s while idle.
const KEEPALIVE_MS = 5000;
// Audio stopped arriving (the renderer only streams while someone is talking,
// plus a short tail): ask Deepgram to flush what it has.
const FINALIZE_AFTER_IDLE_MS = 800;

const MAX_RECONNECTS = 3;
const RECONNECT_DELAYS_MS = [500, 1500, 3500];

function cleanModel(model) {
  const m = String(model || '').trim();
  return /^[A-Za-z0-9._-]{1,60}$/.test(m) ? m : DEFAULT_DEEPGRAM_MODEL;
}

// 'en', 'en-US', 'es', 'multi' (Nova-3 multilingual) ... anything else -> 'en'.
function cleanLanguage(language) {
  const l = String(language || '').trim();
  return /^(?:multi|[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?)$/.test(l) ? l : DEFAULT_DEEPGRAM_LANGUAGE;
}

// DEEPGRAM_ENDPOINTING_MS -> an integer in [100, 1000]; blank/garbage -> 200.
function cleanEndpointing(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!/^\d{1,6}$/.test(raw)) return ENDPOINTING_MS;
  return Math.min(MAX_ENDPOINTING_MS, Math.max(MIN_ENDPOINTING_MS, Number(raw)));
}

// Nova-3 keyterm prompting (English): one `keyterm` parameter per term, so
// the user's own names and specs are spelled right. Other models ignore it,
// so it's only sent to nova-3.
const MAX_KEYTERMS = 40;
const MAX_KEYTERM_CHARS = 40;
function cleanKeyterms(keyterms, model, language) {
  if (!Array.isArray(keyterms) || !/^nova-3/.test(model) || !/^(en|multi)/.test(language)) return [];
  const out = [];
  for (const t of keyterms) {
    const s = typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : '';
    if (!s || s.length > MAX_KEYTERM_CHARS || out.includes(s)) continue;
    out.push(s);
    if (out.length >= MAX_KEYTERMS) break;
  }
  return out;
}

function buildListenUrl({ model, language, sampleRate = SAMPLE_RATE, endpointingMs = ENDPOINTING_MS, keyterms } = {}) {
  const params = new URLSearchParams({
    model: cleanModel(model),
    language: cleanLanguage(language),
    smart_format: 'true',
    interim_results: 'true',
    endpointing: String(cleanEndpointing(endpointingMs)),
    utterance_end_ms: String(UTTERANCE_END_MS),
    vad_events: 'true',
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    channels: '1',
  });
  for (const term of cleanKeyterms(keyterms, params.get('model'), params.get('language'))) params.append('keyterm', term);
  return `${DEEPGRAM_LISTEN_URL}?${params.toString()}`;
}

// The auth header Deepgram expects. Header (not ?token= in the URL), so the
// key never ends up in a URL that could be logged.
function authHeaders(key) {
  return { Authorization: `Token ${key}` };
}

// Raw message (string / Buffer) -> { type, ... } or null for anything unknown.
function parseMessage(raw) {
  let obj;
  try {
    obj = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  switch (obj.type) {
    case 'Results': {
      const alt = obj.channel && Array.isArray(obj.channel.alternatives) ? obj.channel.alternatives[0] : null;
      const text = alt && typeof alt.transcript === 'string' ? alt.transcript.trim() : '';
      const confidence = alt && Number.isFinite(alt.confidence) ? alt.confidence : null;
      const start = Number.isFinite(obj.start) ? obj.start : 0;
      const duration = Number.isFinite(obj.duration) ? obj.duration : 0;
      return {
        type: 'results',
        text,
        isFinal: obj.is_final === true,
        speechFinal: obj.speech_final === true,
        fromFinalize: obj.from_finalize === true,
        confidence,
        start,
        end: start + duration,
      };
    }
    case 'UtteranceEnd':
      return { type: 'utterance-end', lastWordEnd: Number.isFinite(obj.last_word_end) ? obj.last_word_end : null };
    case 'SpeechStarted':
      return { type: 'speech-started' };
    case 'Metadata':
      return { type: 'metadata' };
    case 'Error':
      // Short provider description only; never echoed with audio/transcript.
      return { type: 'error', message: String(obj.description || obj.message || '').slice(0, 200) };
    default:
      return null;
  }
}

function joinText(a, b) {
  if (!a) return b;
  if (!b) return a;
  return `${a} ${b}`;
}

// One per stream. Deepgram sends, per stretch of audio:
//   is_final=false   interim guesses (each replaces the previous one)
//   is_final=true    that stretch's text is settled (may be mid-sentence)
//   speech_final     ...and an endpoint was detected: the speaker paused
//   UtteranceEnd     a word-timing gap: also "they stopped" (backup signal)
// The assembler keeps the settled pieces of the current utterance and emits:
//   { kind: 'interim', text, confidence }          settled pieces + latest guess
//                                                  (confidence of the latest piece, or null)
//   { kind: 'final', text, endOfSpeech: boolean, reason }  one finished line
//   { kind: 'end-of-speech', reason }              they stopped, but the line
//                                                  was already finalized earlier
// reason = which signal ended it (Diagnostics > Last answer timing):
//   'speech_final'   Deepgram's endpointing pause
//   'utterance_end'  the UtteranceEnd word-timing gap (backup, ~1 s)
//   'finalize'       the Finalize flush main sends when audio stops
//   'max'            the MAX_UTTERANCE_MS length cut (endOfSpeech: false)
//   'close'          the stream closing
function createUtteranceAssembler({ maxUtteranceMs = MAX_UTTERANCE_MS } = {}) {
  let settled = ''; // is_final pieces of the utterance in progress
  let utteranceStart = null; // seconds (Deepgram stream time)
  let lastInterim = '';
  // The previous final ended mid-speech (MAX_UTTERANCE_MS cut): a later
  // UtteranceEnd still means "they stopped".
  let pendingEndOfSpeech = false;

  function finalize(endOfSpeech, reason) {
    const text = settled.trim();
    const hadInterim = !!lastInterim;
    settled = '';
    utteranceStart = null;
    lastInterim = '';
    if (!text) {
      // e.g. speech_final on an empty result right after a length cut.
      if (endOfSpeech && pendingEndOfSpeech) {
        pendingEndOfSpeech = false;
        return [{ kind: 'end-of-speech', reason }];
      }
      return hadInterim ? [{ kind: 'interim', text: '' }] : [];
    }
    pendingEndOfSpeech = !endOfSpeech;
    return [{ kind: 'final', text, endOfSpeech, reason }];
  }

  function push(msg) {
    if (!msg) return [];
    if (msg.type === 'utterance-end') {
      if (settled.trim()) return finalize(true, 'utterance_end');
      if (pendingEndOfSpeech) {
        pendingEndOfSpeech = false;
        return [{ kind: 'end-of-speech', reason: 'utterance_end' }];
      }
      return []; // already finalized by speech_final -- nothing new
    }
    if (msg.type !== 'results') return [];

    if (msg.text && utteranceStart === null) utteranceStart = msg.start;
    const confidence = Number.isFinite(msg.confidence) ? msg.confidence : null;
    if (!msg.isFinal) {
      const text = joinText(settled, msg.text);
      if (!text || text === lastInterim) return [];
      lastInterim = text;
      return [{ kind: 'interim', text, confidence }];
    }

    settled = joinText(settled, msg.text);
    // An endpoint, or the flush we asked for when audio stopped (Finalize).
    if (msg.speechFinal) return finalize(true, 'speech_final');
    if (msg.fromFinalize) return finalize(true, 'finalize');
    if (utteranceStart !== null && (msg.end - utteranceStart) * 1000 >= maxUtteranceMs) return finalize(false, 'max');
    if (!settled) {
      // The guess on screen turned out to be nothing (noise): clear it.
      if (!lastInterim) return [];
      lastInterim = '';
      return [{ kind: 'interim', text: '' }];
    }
    if (settled === lastInterim) return [];
    lastInterim = settled;
    return [{ kind: 'interim', text: settled, confidence }];
  }

  // Stream closing: whatever is settled becomes a final line.
  function flush() {
    return finalize(true, 'close');
  }

  return { push, flush, hasPending: () => !!settled.trim() };
}

// ---- Errors (messages are safe to show verbatim; they never contain a key) ----
const MANAGE_KEYS = '⋯ menu > API keys';

function sttError(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

// HTTP status of a refused WebSocket handshake. fatal = retrying won't help.
function classifyHandshakeStatus(status) {
  if (status === 401 || status === 403) {
    return { fatal: true, error: sttError('BAD_KEY', `Deepgram rejected your API key (it may be wrong or revoked) -- update it under ${MANAGE_KEYS}.`, status) };
  }
  if (status === 402) {
    return { fatal: true, error: sttError('NO_CREDIT', 'Your Deepgram account is out of credit -- add credit at console.deepgram.com, or switch Speech-to-text back to Groq in Settings.', status) };
  }
  if (status === 429) {
    return { fatal: false, error: sttError('RATE_LIMIT', 'Deepgram rate limit hit (too many live streams at once) -- wait a moment and try again.', status) };
  }
  if (status === 400) {
    return { fatal: true, error: sttError('BAD_REQUEST', "Deepgram couldn't start a live stream with these settings (check DEEPGRAM_MODEL / DEEPGRAM_LANGUAGE in .env).", status) };
  }
  if (status >= 500) {
    return { fatal: false, error: sttError('PROVIDER_DOWN', 'Deepgram is having problems right now -- try again in a moment.', status) };
  }
  return { fatal: false, error: sttError('PROVIDER_ERROR', `Deepgram returned an error (${status}) -- try again in a moment.`, status) };
}

// A socket-level failure before or during the stream (DNS, TLS, reset).
function networkError(err) {
  if (err && /timed? ?out/i.test(String(err.message || ''))) {
    return sttError('TIMEOUT', 'Deepgram took too long to answer -- check your connection.');
  }
  return sttError('OFFLINE', "Couldn't reach Deepgram -- check your internet connection.");
}

// Close frames Deepgram sends mid-stream. 1000/1001/1006/1011 (normal, going
// away, dropped, NET-* timeouts) are worth a reconnect; 1008 (DATA-0000:
// audio it can't decode) and policy/auth closes are not.
function classifyClose(code, reason) {
  const r = String(reason || '');
  if (code === 1008 || /^DATA-/i.test(r)) {
    return { reconnect: false, error: sttError('BAD_AUDIO', "Deepgram couldn't decode the audio Echo sent -- switch Speech-to-text back to Groq and report this bug.") };
  }
  if (code === 4001 || code === 4003 || /auth|credential/i.test(r)) {
    return { reconnect: false, error: sttError('BAD_KEY', `Deepgram rejected your API key -- update it under ${MANAGE_KEYS}.`) };
  }
  if (/credit|payment|balance/i.test(r)) {
    return { reconnect: false, error: sttError('NO_CREDIT', 'Your Deepgram account is out of credit -- add credit at console.deepgram.com, or switch Speech-to-text back to Groq in Settings.') };
  }
  return { reconnect: true, error: sttError('STREAM_DROPPED', 'The live transcription connection to Deepgram dropped.') };
}

// attempt = how many reconnects already tried for this drop (0-based).
// Returns ms to wait, or -1 = give up.
function reconnectDelay(attempt, { fatal = false } = {}) {
  if (fatal || !Number.isInteger(attempt) || attempt < 0 || attempt >= MAX_RECONNECTS) return -1;
  return RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
}

// Called on a timer while the socket is open. lastAudioAt / lastSendAt are
// ms timestamps (0 = never); flowing = audio has arrived since the last
// Finalize. Returns which control messages to send now.
function idleActions({ now, lastAudioAt = 0, lastSendAt = 0, flowing = false }) {
  const finalize = !!flowing && lastAudioAt > 0 && now - lastAudioAt >= FINALIZE_AFTER_IDLE_MS;
  const keepAlive = !finalize && now - lastSendAt >= KEEPALIVE_MS;
  return { finalize, keepAlive };
}

const CONTROL = Object.freeze({
  keepAlive: JSON.stringify({ type: 'KeepAlive' }),
  finalize: JSON.stringify({ type: 'Finalize' }),
  closeStream: JSON.stringify({ type: 'CloseStream' }),
});

// Validates one PCM frame from the renderer: Int16 samples as bytes, even
// length, at most MAX_FRAME_BYTES. Returns a Buffer view or null.
const MAX_FRAME_BYTES = SAMPLE_RATE * 2; // 1 s of audio; frames are ~100 ms (3200 bytes)
function toPcmBuffer(data) {
  let view = null;
  if (data instanceof ArrayBuffer) view = new Uint8Array(data);
  else if (ArrayBuffer.isView(data) && data.BYTES_PER_ELEMENT === 1) view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (!view || !view.byteLength || view.byteLength > MAX_FRAME_BYTES || view.byteLength % 2) return null;
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

module.exports = {
  DEEPGRAM_LISTEN_URL,
  DEEPGRAM_PROJECTS_URL,
  DEFAULT_DEEPGRAM_MODEL,
  SAMPLE_RATE,
  ENDPOINTING_MS,
  MIN_ENDPOINTING_MS,
  MAX_ENDPOINTING_MS,
  UTTERANCE_END_MS,
  MAX_UTTERANCE_MS,
  KEEPALIVE_MS,
  FINALIZE_AFTER_IDLE_MS,
  MAX_RECONNECTS,
  MAX_FRAME_BYTES,
  CONTROL,
  cleanModel,
  cleanLanguage,
  cleanEndpointing,
  buildListenUrl,
  authHeaders,
  parseMessage,
  createUtteranceAssembler,
  classifyHandshakeStatus,
  classifyClose,
  networkError,
  reconnectDelay,
  idleActions,
  toPcmBuffer,
};
