// Question detection + "how long to wait before answering" -- the pure part
// of the auto-suggest trigger. No DOM, so it's unit-tested in plain Node
// (test/question-core.test.js). Loaded as a classic script before
// renderer.js (window.EchoQuestionCore).
//
// A "Them" line counts as a question by its WORDING, not only a "?":
// speech-to-text often drops or misplaces question marks, and interviewers
// often ask with an instruction ("Walk me through your code.", "Write a
// function that ..."). Set-ups ("Let's say we have a million users.") are
// deliberately NOT questions: the question usually follows in the next line.
//
// Delay after a line lands (renderer.js appendLine):
//   LIVE_QUESTION_DELAY_MS (0)    Deepgram heard the end of speech (speech_final /
//                                 UtteranceEnd / flush) on a question: the
//                                 300 ms endpointing pause already happened.
//   QUESTION_DELAY_MS (150)       a question cut at a pause (Groq VAD path).
//   AFTER_SPEECH_MS (300)         any other finished sentence (. ! ?) at a pause.
//   QUIET_MS (1500)               trailing off ("...", "so the", "and um,"), a
//                                 mid-speech cut, fixed chunks: wait for more.
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.EchoQuestionCore = core;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIVE_QUESTION_DELAY_MS = 0;
  const QUESTION_DELAY_MS = 150;
  const AFTER_SPEECH_MS = 300;
  const QUIET_MS = 1500;

  // Where a new clause can start: start of the line, after sentence/clause
  // punctuation, or after a joining word ("yeah so what's...", "ok and why...").
  const CLAUSE_START = String.raw`(?:^|[.!?,;:]\s+|\b(?:and|so|but|then|okay|ok|right|alright|cool|great|yeah|now|also|well)\s+)`;

  const INTERROGATIVES = [
    String.raw`(?:what|why|how|when|where|which|who|whose|whom)(?:'?s|'re|'d|'ll)?\b`,
    String.raw`(?:can|could|would|will|do|did|does|have|has|had|are|were|should|shall|may|might)\s+(?:you|we|i|it|they|that|this|there|your|one)\b`,
    String.raw`(?:is|was|isn'?t|wasn'?t|aren'?t|don'?t|doesn'?t|didn'?t|won'?t|wouldn'?t|couldn'?t|can'?t)\s+(?:it|there|that|this|you|your|the|a|an|we|they)\b`,
    String.raw`(?:are there|is there)\b`,
    String.raw`(?:tell me|walk me through|talk me through|take me through|run me through|show me|explain|describe|elaborate|clarify|define)\b`,
    String.raw`(?:give me (?:an |a |some )?(?:example|examples|idea|sense|overview|rundown))\b`,
    String.raw`(?:what if|how about|what about)\b`,
    String.raw`(?:i'?d like (?:you )?to (?:hear|know|understand|see)|i'?m curious|i was wondering|i wonder|i'?d love to hear|let'?s talk about)\b`,
    String.raw`(?:any (?:questions?|thoughts|ideas|edge cases|examples|concerns|other))\b`,
    // Interview tasks given as instructions.
    String.raw`(?:(?:please|now|first|next|go ahead and|let'?s|try to|i want you to|i'?d like you to|can you|could you)\s+)?(?:write|implement|code up|design|solve|find|compute|calculate|estimate|prove|reverse|sort|merge|build)\b\s+(?:a|an|the|me|some|this|that|all|two|it|whether|if|how)\b`,
    String.raw`(?:given (?:a|an|two|three|the|some|n|k|\d+))\b`,
  ];
  const QUESTION_RE = new RegExp(`${CLAUSE_START}(?:${INTERROGATIVES.join('|')})`, 'i');

  // The line stops on a word that can't end a finished question: they're
  // mid-sentence (a pause, or a speech-to-text cut), so wait for the rest.
  // Only words that almost never end a finished question: "what are you
  // proud of" / "who did you work with" / "why is that" are complete.
  const DANGLING_END_RE = /(?:,|\b(?:and|or|but|because|the|a|an|to|than|your|my|our|their|um|uh|er|erm|you know|i mean))["')\]]*\s*$/i;
  const SENTENCE_END_RE = /[?.!]["')\]]*\s*$/;

  function clean(text) {
    return String(text == null ? '' : text).trim();
  }

  // True when the line reads like a question / a request to answer.
  function looksLikeQuestion(text) {
    const t = clean(text);
    if (!t) return false;
    if (/\?/.test(t)) return true;
    return QUESTION_RE.test(t);
  }

  // True when the line ends mid-thought (no end punctuation, or trailing off).
  function endsMidThought(text) {
    const t = clean(text);
    if (!t) return true;
    if (/(?:\.\.\.|…)["')\]]*\s*$/.test(t)) return true;
    if (/\?["')\]]*\s*$/.test(t)) return false; // a "?" settles it
    return DANGLING_END_RE.test(t);
  }

  // meta (from renderer.js): { cut: 'silence' | 'max' | 'timer', live: true
  // when the line is a Deepgram final at end of speech }.
  function autoSuggestDelay(text, meta) {
    const m = meta || {};
    if (m.cut !== 'silence') return QUIET_MS;
    if (endsMidThought(text)) return QUIET_MS;
    if (looksLikeQuestion(text)) return m.live ? LIVE_QUESTION_DELAY_MS : QUESTION_DELAY_MS;
    if (SENTENCE_END_RE.test(clean(text))) return AFTER_SPEECH_MS;
    return QUIET_MS;
  }

  return Object.freeze({
    LIVE_QUESTION_DELAY_MS,
    QUESTION_DELAY_MS,
    AFTER_SPEECH_MS,
    QUIET_MS,
    QUESTION_RE,
    looksLikeQuestion,
    endsMidThought,
    autoSuggestDelay,
  });
});
