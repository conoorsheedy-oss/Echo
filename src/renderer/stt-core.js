// Speech-to-text provider choice (Settings > Speech-to-text) -- the pure
// part: which keys are needed before Start Listening, and what the banner
// says when one is missing. No DOM, so it's unit-tested in plain Node
// (test/stt-core.test.js). Loaded as a classic script before renderer.js
// (window.EchoSttCore).
//
//   groq      (default) audio clips cut at pauses -> Groq Whisper
//   deepgram  live 16 kHz PCM stream -> Deepgram Nova-3 (src/main/deepgram.js);
//             Groq, if its key is set, is the automatic fallback
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.EchoSttCore = core;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PROVIDERS = Object.freeze(['groq', 'deepgram']);
  const DEFAULT_PROVIDER = 'groq';
  const LABELS = Object.freeze({ groq: 'Groq', gemini: 'Gemini', deepgram: 'Deepgram' });

  function normalizeProvider(value) {
    return PROVIDERS.includes(value) ? value : DEFAULT_PROVIDER;
  }

  // keyStatus: what main's keys:status returns (booleans only).
  // -> { ready, missing: ['Gemini', 'Deepgram', ...], provider, canFallBack }
  function readiness(keyStatus, provider) {
    const k = keyStatus || {};
    const p = normalizeProvider(provider);
    const missing = [];
    if (p === 'groq' && !k.groqKeySet) missing.push(LABELS.groq);
    if (!k.geminiKeySet) missing.push(LABELS.gemini);
    if (p === 'deepgram' && !k.deepgramKeySet) missing.push(LABELS.deepgram);
    return {
      ready: missing.length === 0,
      missing,
      provider: p,
      // Deepgram mode can drop back to Groq Whisper if a stream fails.
      canFallBack: p === 'deepgram' && !!k.groqKeySet,
    };
  }

  // The top banner when keys are missing (clicking it opens Settings).
  function missingKeysBanner(r) {
    if (!r || r.ready) return '';
    const names = r.missing.join(' + ');
    const plural = r.missing.length > 1 ? 's' : '';
    if (r.provider === 'deepgram' && r.missing.length === 1 && r.missing[0] === LABELS.deepgram) {
      return 'Add your Deepgram API key (or switch Speech-to-text back to Groq) to start -- click here.';
    }
    const free = r.missing.includes(LABELS.deepgram) ? '' : 'free ';
    return `Add your ${free}${names} API key${plural} to start -- click here.`;
  }

  // "Add your Gemini + Deepgram API keys" -- callers add where / why.
  function missingKeysHint(r) {
    if (!r || r.ready) return '';
    return `Add your ${r.missing.join(' + ')} API key${r.missing.length > 1 ? 's' : ''}`;
  }

  function describeProvider(provider) {
    return normalizeProvider(provider) === 'deepgram' ? 'Deepgram Nova-3 (live)' : 'Groq Whisper (clips at pauses)';
  }

  return Object.freeze({
    PROVIDERS,
    DEFAULT_PROVIDER,
    normalizeProvider,
    readiness,
    missingKeysBanner,
    missingKeysHint,
    describeProvider,
  });
});
