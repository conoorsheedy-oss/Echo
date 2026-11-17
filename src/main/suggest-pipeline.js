// One suggestion request = the full answer, plus (Settings > Answers >
// "Instant first line", on by default) a tiny parallel "headline" call that
// only writes the first sentence to say. Pure (the ai module and the event
// sink are passed in), so it's unit-tested with fakes in
// test/suggest-pipeline.test.js; main.js wires it to IPC.
//
// Events: emit(part, text) with part 'headline' | 'answer'; main.js sends
// them as 'ai:chunk' { requestId, part, text }.
//
// Rules:
//   - The question is analysed ONCE (ai.analyzeSuggestion: question kind,
//     intent, may-decline flag) and the same analysis goes to both calls, so
//     the first line and the full answer read the question the same way.
//     Likewise params.interviewState (Interview mode: the INTERVIEW STATE
//     block + "Direction:" line, built once in main.js) reaches both calls
//     unchanged; ai.js picks the full or the trimmed first-line block.
//   - Both calls share the request's AbortSignal: a superseding request
//     (ai-requests.js) cancels both HTTP requests at once.
//   - The headline is only useful BEFORE the full answer has anything to
//     show. If the full answer's first text arrives first, the headline call
//     is aborted and nothing of it is ever sent (dropped silently).
//   - Once the full answer is done (or failed), a headline still running is
//     aborted too.
//   - A failing headline never affects the full answer (no error, no retry).
//   - "Nothing to add": an AUTOMATIC request outside interviews may get the
//     NO_RESPONSE sentinel back from either call. The start of every stream
//     is held back until it can't be the sentinel (usually the first
//     character), so the sentinel never reaches the renderer. On the
//     sentinel, both calls are aborted and the request resolves
//     { skipped: true, reason: 'no_response' }. An EXPLICIT request is never
//     skipped: a sentinel headline is just dropped, and a sentinel full
//     answer is replaced by EXPLICIT_FALLBACK_TEXT.
//   - Otherwise the resolved value is the full answer, unchanged: it stays
//     the source of truth for Copy / Shorten / Expand / history.
'use strict';

const intentCore = require('../renderer/intent-core');

const EXPLICIT_FALLBACK_TEXT = "Nothing obvious to add here yet. Try Regenerate, or type what you need under Ask the assistant.";

// Holds back the start of a stream until it's clearly not the sentinel.
// push(text) -> { state: 'yes' | 'maybe' | 'no', out } where out is the
// text that may now be shown.
function createSentinelGate() {
  let held = '';
  let state = 'maybe';
  return {
    get state() { return state; },
    push(text) {
      if (state === 'no') return { state, out: text };
      if (state === 'yes') return { state, out: '' };
      held += text;
      state = intentCore.sentinelState(held);
      if (state === 'no') {
        const out = held;
        held = '';
        return { state, out };
      }
      return { state, out: '' };
    },
    // Stream over while still undecided: whatever was held is real text.
    flush() {
      if (state !== 'maybe') return '';
      state = intentCore.sentinelState(held) === 'yes' ? 'yes' : 'no';
      const out = state === 'no' ? held : '';
      held = '';
      return out;
    },
  };
}

function skippedResult(analysis) {
  return { skipped: true, reason: 'no_response', intent: analysis.intent || null };
}

async function runSuggestion({ ai, params, signal, emit, headline = false, log = console }) {
  const streaming = typeof emit === 'function';
  const analysis = typeof ai.analyzeSuggestion === 'function' ? ai.analyzeSuggestion(params) : {};
  const shared = { ...params, ...analysis };
  const canSkip = !!analysis.allowNoResponse;

  let answerStarted = false;
  let headlineStarted = false;
  let headlineCtl = null;
  let skipped = false;
  const answerCtl = new AbortController();
  const answerSignal = signal ? AbortSignal.any([signal, answerCtl.signal]) : answerCtl.signal;

  // Auto request + sentinel: stop both calls; nothing was ever emitted.
  function skip() {
    if (skipped) return;
    skipped = true;
    answerCtl.abort();
    if (headlineCtl) headlineCtl.abort();
  }

  if (headline && streaming && typeof ai.generateHeadline === 'function') {
    headlineCtl = new AbortController();
    const headlineSignal = signal ? AbortSignal.any([signal, headlineCtl.signal]) : headlineCtl.signal;
    const gate = createSentinelGate();
    let headlineDead = false; // explicit request whose headline was the sentinel
    // Not awaited: the request resolves with the full answer alone.
    Promise.resolve()
      .then(() => ai.generateHeadline({
        ...shared,
        signal: headlineSignal,
        onChunk: (text) => {
          if (!text || headlineCtl.signal.aborted || headlineDead || skipped) return;
          const { state, out } = gate.push(text);
          if (state === 'yes') {
            if (canSkip) skip();
            else headlineDead = true;
            return;
          }
          if (!out) return;
          if (answerStarted && !headlineStarted) return; // too late to be useful
          headlineStarted = true;
          emit('headline', out);
        },
      }))
      .then(() => {
        // A one-word headline that was still undecided when the stream ended.
        const rest = gate.flush();
        if (gate.state === 'yes') {
          if (canSkip && !answerStarted) skip();
          return;
        }
        if (rest && !headlineCtl.signal.aborted && !skipped && !headlineDead && !(answerStarted && !headlineStarted)) {
          headlineStarted = true;
          emit('headline', rest);
        }
      })
      .catch((err) => {
        if (headlineSignal.aborted || (err && err.code === 'ABORTED')) return;
        // Code only -- never the prompt or the provider's body.
        log.warn(`[ai] Instant first line skipped (${(err && err.code) || 'error'}).`);
      });
  }

  const answerGate = createSentinelGate();
  let explicitSentinel = false;
  const showAnswer = (text) => {
    if (!text) return;
    if (!answerStarted) {
      answerStarted = true;
      // The full answer beat the headline: drop it.
      if (headlineCtl && !headlineStarted) headlineCtl.abort();
    }
    emit('answer', text);
  };

  try {
    const result = await ai.generateSuggestion({
      ...shared,
      signal: answerSignal,
      onChunk: streaming
        ? (text) => {
          if (skipped || explicitSentinel) return;
          const { state, out } = answerGate.push(text);
          if (state === 'yes') {
            if (canSkip) skip();
            else explicitSentinel = true; // keep quiet; replaced below
            return;
          }
          showAnswer(out);
        }
        : undefined,
    });
    if (skipped) return skippedResult(analysis);
    // Also covers a non-streamed answer (no requestId, or the stream fell
    // back to a normal request) and a reply too short to have been decided.
    const text = result && typeof result === 'object' ? result.text : result;
    if (intentCore.isNoResponse(text)) {
      if (canSkip) {
        skip();
        return skippedResult(analysis);
      }
      return { ...(typeof result === 'object' ? result : {}), text: EXPLICIT_FALLBACK_TEXT, noResponse: true };
    }
    if (streaming) showAnswer(answerGate.flush());
    return result;
  } catch (err) {
    // Our own abort after the sentinel, not the caller's.
    if (skipped && !(signal && signal.aborted)) return skippedResult(analysis);
    throw err;
  } finally {
    if (headlineCtl) headlineCtl.abort();
  }
}

module.exports = { runSuggestion, createSentinelGate, EXPLICIT_FALLBACK_TEXT };
