// Unit tests for the speech-to-text provider readiness rules
// (src/renderer/stt-core.js): which keys Start Listening needs, and the
// banner text when one is missing.
// Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const stt = require('../src/renderer/stt-core.js');

const keys = (groq, gemini, deepgram) => ({ groqKeySet: groq, geminiKeySet: gemini, deepgramKeySet: deepgram });

test('provider defaults to groq for anything unknown', () => {
  assert.equal(stt.normalizeProvider('deepgram'), 'deepgram');
  assert.equal(stt.normalizeProvider('groq'), 'groq');
  assert.equal(stt.normalizeProvider(null), 'groq');
  assert.equal(stt.normalizeProvider('whisper'), 'groq');
});

test('Groq mode needs Groq + Gemini; the Deepgram key does not matter', () => {
  assert.equal(stt.readiness(keys(true, true, false), 'groq').ready, true);
  assert.deepEqual(stt.readiness(keys(false, true, true), 'groq').missing, ['Groq']);
  assert.deepEqual(stt.readiness(keys(false, false, false), 'groq').missing, ['Groq', 'Gemini']);
});

test('Deepgram mode needs Deepgram + Gemini; Groq is optional (fallback)', () => {
  const r = stt.readiness(keys(false, true, true), 'deepgram');
  assert.equal(r.ready, true);
  assert.equal(r.canFallBack, false);
  assert.equal(stt.readiness(keys(true, true, true), 'deepgram').canFallBack, true);
  assert.deepEqual(stt.readiness(keys(true, true, false), 'deepgram').missing, ['Deepgram']);
  assert.deepEqual(stt.readiness(keys(true, false, false), 'deepgram').missing, ['Gemini', 'Deepgram']);
  assert.equal(stt.readiness(keys(true, false, true), 'deepgram').ready, false, 'Gemini is always required');
});

test('missing-key banner and hint text', () => {
  assert.equal(stt.missingKeysBanner(stt.readiness(keys(true, true, false), 'groq')), '');
  assert.equal(
    stt.missingKeysBanner(stt.readiness(keys(false, false, false), 'groq')),
    'Add your free Groq + Gemini API keys to start -- click here.'
  );
  assert.equal(
    stt.missingKeysBanner(stt.readiness(keys(true, false, true), 'deepgram')),
    'Add your free Gemini API key to start -- click here.'
  );
  assert.match(stt.missingKeysBanner(stt.readiness(keys(true, true, false), 'deepgram')), /Deepgram API key \(or switch Speech-to-text back to Groq\)/);
  assert.equal(
    stt.missingKeysBanner(stt.readiness(keys(false, false, false), 'deepgram')),
    'Add your Gemini + Deepgram API keys to start -- click here.'
  );
  assert.equal(stt.missingKeysHint(stt.readiness(keys(true, true, false), 'deepgram')), 'Add your Deepgram API key');
  assert.equal(stt.missingKeysHint(stt.readiness(keys(true, true, true), 'deepgram')), '');
  assert.match(stt.describeProvider('deepgram'), /Nova-3/);
});

test('works with an empty / missing key status', () => {
  assert.deepEqual(stt.readiness(undefined, 'deepgram').missing, ['Gemini', 'Deepgram']);
});
