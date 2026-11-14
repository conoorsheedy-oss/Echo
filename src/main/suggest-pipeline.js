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
//   - Both calls share the request's AbortSignal: a superseding request
//     (ai-requests.js) cancels both HTTP requests at once.
//   - The headline is only useful BEFORE the full answer has anything to
//     show. If the full answer's first text arrives first, the headline call
//     is aborted and nothing of it is ever sent (dropped silently).
//   - Once the full answer is done (or failed), a headline still running is
//     aborted too.
//   - A failing headline never affects the full answer (no error, no retry).
//   - The resolved value is the full answer, unchanged: it stays the source
//     of truth for Copy / Shorten / Expand / history.
'use strict';

async function runSuggestion({ ai, params, signal, emit, headline = false, log = console }) {
  const streaming = typeof emit === 'function';
  let answerStarted = false;
  let headlineStarted = false;
  let headlineCtl = null;

  if (headline && streaming && typeof ai.generateHeadline === 'function') {
    headlineCtl = new AbortController();
    const headlineSignal = signal ? AbortSignal.any([signal, headlineCtl.signal]) : headlineCtl.signal;
    // Not awaited: the request resolves with the full answer alone.
    Promise.resolve()
      .then(() => ai.generateHeadline({
        ...params,
        signal: headlineSignal,
        onChunk: (text) => {
          if (!text || headlineCtl.signal.aborted) return;
          if (answerStarted && !headlineStarted) return; // too late to be useful
          headlineStarted = true;
          emit('headline', text);
        },
      }))
      .catch((err) => {
        if (headlineSignal.aborted || (err && err.code === 'ABORTED')) return;
        // Code only -- never the prompt or the provider's body.
        log.warn(`[ai] Instant first line skipped (${(err && err.code) || 'error'}).`);
      });
  }

  try {
    return await ai.generateSuggestion({
      ...params,
      signal,
      onChunk: streaming
        ? (text) => {
          if (!answerStarted) {
            answerStarted = true;
            // The full answer beat the headline: drop it.
            if (headlineCtl && !headlineStarted) headlineCtl.abort();
          }
          emit('answer', text);
        }
        : undefined,
    });
  } finally {
    if (headlineCtl) headlineCtl.abort();
  }
}

module.exports = { runSuggestion };
