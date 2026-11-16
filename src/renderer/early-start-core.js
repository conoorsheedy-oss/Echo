// Early start on Deepgram interim text + which end-of-speech signal started
// an automatic answer -- the pure part. No DOM, so it's unit-tested in plain
// Node (test/early-start-core.test.js). Loaded as a classic script after
// intent-core.js and before renderer.js (window.EchoEarlyStartCore).
//
// Why: Deepgram's speech_final (endpointing, 200 ms) doesn't always fire --
// e.g. on TTS / music-backed system audio -- and then the answer waited for
// UtteranceEnd (~1 s of word-timing gap) plus processing. Early start fires
// the automatic request once the interviewer's CURRENT utterance (settled
// pieces + latest interim guess) reads like a complete question and no new
// words have arrived for EARLY_START_MS. When the final line lands,
// reconcileFinal() decides whether that request still answers it.
//
//   shouldEarlyStart(opts)   -> { fire, reason, intent }
//   reconcileFinal({ provisional, final }) -> 'keep' | 'restart'
//   keepEarlyOnScreen(opts)  -> true = a restart must not yank this early answer
//   triggerFor({ stt, cut, reason }) -> { trigger, detail } for Diagnostics
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./question-core.js'), require('./intent-core.js'));
  } else {
    root.EchoEarlyStartCore = factory(root.EchoQuestionCore, root.EchoIntentCore);
  }
})(typeof self !== 'undefined' ? self : this, function (Question, Intent) {
  'use strict';

  // No new interim words for this long -> start answering.
  const EARLY_START_MS = 350;
  // Deepgram interim text is noisy: at least this many words...
  const MIN_WORDS = 4;
  // ...and, when Deepgram reports one, at least this confidence.
  const MIN_CONFIDENCE = 0.6;
  // reconcileFinal: share of the final's words the provisional text must match.
  const MIN_OVERLAP = 0.9;
  // reconcileFinal: harmless words the final may add at the end ("..., okay?").
  const MAX_SOFT_TAIL = 2;
  // CALM rule for a restart: an early answer that has been on screen this
  // long is being read -- it is left to finish and the corrected answer waits
  // behind the "New answer ready" chip. Before that it is simply replaced.
  const SWAP_WINDOW_MS = 1500;

  const TRIGGERS = Object.freeze(['speech_final', 'utterance_end', 'early_interim', 'groq_vad', 'other']);

  const FILLERS = new Set(['um', 'umm', 'uh', 'uhm', 'uhh', 'er', 'erm', 'ah', 'eh', 'hm', 'hmm', 'mm', 'mmm', 'mhm']);
  const SOFT_TAIL = new Set(['okay', 'ok', 'so', 'yeah', 'right', 'please', 'then', 'now', 'alright']);

  const END_PUNCT_RE = /[?.]["')\]]*\s*$/;
  // A clear interrogative / imperative opener somewhere in the utterance
  // (after a clause start), for text Deepgram hasn't punctuated yet.
  const CLEAR_ASK_RE = new RegExp(String.raw`(?:^|[,.!?;:]\s*|\b(?:and|so|okay|ok|now|alright|right|great|cool|next)\s+)(?:tell me about|tell me more|walk me through|talk me through|take me through|run me through|how (?:would|could|do|did|will|can|should) you|what (?:would|do|did|is|are|was|were|will|has|have)|why (?:would|did|do|does|is|are|was)|which (?:one|would|do)|(?:can|could|would|will) you|describe|explain|design|implement|write (?:a|an|me|some|the)|give me (?:an? )?examples?)\b`, 'i');
  // Without end punctuation, the last word must not leave the sentence open
  // ("How would you design" is a pause; "How would you design a cache" isn't).
  // Only for unpunctuated text: "who did you work with?" is fine.
  const OPEN_TAIL_RE = /\b(?:of|for|with|in|on|at|by|about|from|into|onto|like|as|is|are|was|were|be|been|being|would|could|should|will|can|do|does|did|have|has|had|you|we|i|they|it|he|she|that|this|these|those|some|any|if|when|how|what|why|which|where|who|so|then|also|just|really|very|more|most|design|implement|write|explain|describe|tell|walk|talk|give|make|build|use|using|approach|handle|solve|test|scale|improve|optimi[sz]e|structure|start|go|get|find|choose|pick)\s*$/i;

  function clean(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  function wordCount(text) {
    const m = clean(text).match(/\S+/g);
    return m ? m.length : 0;
  }

  // Does the utterance look finished (not a breath mid-sentence)?
  function looksComplete(text) {
    const t = clean(text);
    if (!t || Question.endsMidThought(t)) return false;
    if (END_PUNCT_RE.test(t)) return true;
    return CLEAR_ASK_RE.test(t) && !OPEN_TAIL_RE.test(t);
  }

  // opts: { text, lastChangeAt, now, speaker, provider, privacy, explicit,
  //         confidence, mode, intentCtx }
  // intentCtx is renderer.js intentContext() (prior answers, recent "You").
  function shouldEarlyStart(opts = {}) {
    const no = (reason) => ({ fire: false, reason, intent: null });
    const o = opts || {};
    if (o.explicit) return no('explicit');
    if (String(o.speaker || '') !== 'Them') return no('not-them');
    if (o.provider !== 'deepgram') return no('provider');
    if (o.privacy) return no('privacy');
    const text = clean(o.text);
    if (!text) return no('empty');
    if (!Number.isFinite(o.lastChangeAt) || !Number.isFinite(o.now) || o.now - o.lastChangeAt < EARLY_START_MS) return no('still-talking');
    if (wordCount(text) < MIN_WORDS) return no('too-short');
    if (Number.isFinite(o.confidence) && o.confidence < MIN_CONFIDENCE) return no('low-confidence');
    if (!looksComplete(text)) return no('incomplete');
    const ctx = { ...(o.intentCtx || {}), mode: o.mode || (o.intentCtx && o.intentCtx.mode), speaker: 'them' };
    const intent = Intent.classifyIntent(text, ctx);
    if (!Intent.shouldAutoTrigger(intent, ctx)) return { fire: false, reason: 'not-needed', intent };
    return { fire: true, reason: 'ok', intent };
  }

  // Lowercase words, punctuation and apostrophes stripped, fillers dropped.
  function tokens(text) {
    return String(text == null ? '' : text)
      .toLowerCase()
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter((t) => t && !FILLERS.has(t));
  }

  // Longest common subsequence of a and b: { length, lastB } (lastB = index
  // in b of the last matched word, -1 if none).
  function lcs(a, b) {
    const n = Math.min(a.length, 200);
    const m = Math.min(b.length, 200);
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    let i = n;
    let j = m;
    let lastB = -1;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        if (lastB === -1) lastB = j - 1;
        i -= 1;
        j -= 1;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        i -= 1;
      } else {
        j -= 1;
      }
    }
    return { length: dp[n][m], lastB };
  }

  // The final line of the utterance an early request was started on:
  //   'keep'     same question (punctuation, case, fillers and up to
  //              MAX_SOFT_TAIL "okay / so / right" at the end don't count;
  //              >= 90% of the words match) -- the request in flight answers it
  //   'restart'  they kept talking (new words after it) or the words changed
  function reconcileFinal({ provisional, final } = {}) {
    const p = tokens(provisional);
    const f = tokens(final);
    if (!p.length || !f.length) return 'restart';
    const { length, lastB } = lcs(p, f);
    if (lastB === -1) return 'restart';
    const tail = f.slice(lastB + 1);
    if (tail.length > MAX_SOFT_TAIL || tail.some((t) => !SOFT_TAIL.has(t))) return 'restart';
    const overlap = length / Math.max(p.length, lastB + 1);
    return overlap >= MIN_OVERLAP ? 'keep' : 'restart';
  }

  // CALM rule when a restart supersedes an early request: keep it (let it
  // finish; the corrected answer goes behind the chip) only once it owns the
  // panel and has been visible for SWAP_WINDOW_MS. Earlier than that -- or
  // not on screen at all -- it is cancelled and the restart replaces it.
  function keepEarlyOnScreen({ ownsPanel, shownAt, now } = {}) {
    return !!ownsPanel && Number.isFinite(shownAt) && Number.isFinite(now) && now - shownAt >= SWAP_WINDOW_MS;
  }

  // Which end-of-speech signal released a line (Diagnostics).
  //   stt: 'deepgram' | 'groq'; cut: 'silence' | 'max' | 'timer';
  //   reason: the Deepgram assembler's reason ('speech_final', 'utterance_end',
  //   'finalize', 'max', 'close').
  function triggerFor({ stt, cut, reason } = {}) {
    if (stt === 'deepgram') {
      if (reason === 'speech_final' || reason === 'utterance_end') return { trigger: reason, detail: '' };
      return { trigger: 'other', detail: String(reason || cut || '') };
    }
    if (cut === 'silence') return { trigger: 'groq_vad', detail: '' };
    return { trigger: 'other', detail: String(cut || '') };
  }

  return Object.freeze({
    EARLY_START_MS,
    MIN_WORDS,
    MIN_CONFIDENCE,
    MIN_OVERLAP,
    MAX_SOFT_TAIL,
    SWAP_WINDOW_MS,
    TRIGGERS,
    looksComplete,
    shouldEarlyStart,
    tokens,
    reconcileFinal,
    keepEarlyOnScreen,
    triggerFor,
  });
});
