// Unit tests for the pure Deepgram helpers (src/main/deepgram-core.js):
// listen URL, message parsing, the interim/final assembler, error
// classification, reconnect backoff and KeepAlive/Finalize timing.
// No network, no WebSocket.
// Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dg = require('../src/main/deepgram-core');

// ---- message builders (shapes from Deepgram's live API) ----
function results(text, { isFinal = false, speechFinal = false, fromFinalize = false, start = 0, duration = 1 } = {}) {
  return JSON.stringify({
    type: 'Results',
    channel_index: [0, 1],
    duration,
    start,
    is_final: isFinal,
    speech_final: speechFinal,
    from_finalize: fromFinalize,
    channel: { alternatives: [{ transcript: text, confidence: 0.98, words: [] }] },
    metadata: { request_id: 'r1' },
  });
}
const utteranceEnd = (lastWordEnd = 2.1) => JSON.stringify({ type: 'UtteranceEnd', channel: [0, 1], last_word_end: lastWordEnd });

function run(assembler, raws) {
  return raws.flatMap((raw) => assembler.push(dg.parseMessage(raw)));
}

// ---- URL / auth ----
test('listen URL has nova-3, linear16 16 kHz mono, interim results, endpointing and utterance end', () => {
  const url = new URL(dg.buildListenUrl());
  assert.equal(url.origin + url.pathname, 'wss://api.deepgram.com/v1/listen');
  const p = url.searchParams;
  assert.equal(p.get('model'), 'nova-3');
  assert.equal(p.get('language'), 'en');
  assert.equal(p.get('smart_format'), 'true');
  assert.equal(p.get('interim_results'), 'true');
  assert.equal(p.get('endpointing'), String(dg.ENDPOINTING_MS));
  assert.equal(p.get('utterance_end_ms'), '1000');
  assert.equal(p.get('vad_events'), 'true');
  assert.equal(p.get('encoding'), 'linear16');
  assert.equal(p.get('sample_rate'), '16000');
  assert.equal(p.get('channels'), '1');
  assert.equal(p.has('token'), false, 'the key never goes in the URL');
});

test('model / language overrides are sanitised', () => {
  const ok = new URL(dg.buildListenUrl({ model: 'nova-3-medical', language: 'multi' })).searchParams;
  assert.equal(ok.get('model'), 'nova-3-medical');
  assert.equal(ok.get('language'), 'multi');
  const bad = new URL(dg.buildListenUrl({ model: 'nova-3&x=1', language: 'en; drop' })).searchParams;
  assert.equal(bad.get('model'), 'nova-3');
  assert.equal(bad.get('language'), 'en');
  assert.equal(dg.cleanLanguage('en-US'), 'en-US');
});

test('auth uses the Token scheme in a header', () => {
  assert.deepEqual(dg.authHeaders('abc123'), { Authorization: 'Token abc123' });
});

// ---- parsing ----
test('parseMessage normalizes Results, UtteranceEnd, SpeechStarted and ignores junk', () => {
  const r = dg.parseMessage(results(' Hello there ', { isFinal: true, speechFinal: true, start: 1.5, duration: 0.5 }));
  assert.deepEqual(r, { type: 'results', text: 'Hello there', isFinal: true, speechFinal: true, fromFinalize: false, start: 1.5, end: 2 });
  assert.deepEqual(dg.parseMessage(Buffer.from(utteranceEnd(3.2))), { type: 'utterance-end', lastWordEnd: 3.2 });
  assert.deepEqual(dg.parseMessage(JSON.stringify({ type: 'SpeechStarted', channel: [0], timestamp: 0 })), { type: 'speech-started' });
  assert.equal(dg.parseMessage(JSON.stringify({ type: 'Metadata', request_id: 'x' })).type, 'metadata');
  assert.equal(dg.parseMessage('not json'), null);
  assert.equal(dg.parseMessage(JSON.stringify({ type: 'Nope' })), null);
  assert.equal(dg.parseMessage(JSON.stringify({ type: 'Results' })).text, '');
});

// ---- assembler ----
test('interim guesses replace each other, speech_final makes one final line (end of speech)', () => {
  const a = dg.createUtteranceAssembler();
  const out = run(a, [
    results('what'),
    results('what is'),
    results('what is'), // duplicate guess: nothing new
    results('What is your', { isFinal: true, start: 0, duration: 1.2 }),
    results('biggest'),
    results('biggest weakness?', { isFinal: true, speechFinal: true, start: 1.2, duration: 1 }),
  ]);
  assert.deepEqual(out, [
    { kind: 'interim', text: 'what' },
    { kind: 'interim', text: 'what is' },
    { kind: 'interim', text: 'What is your' },
    { kind: 'interim', text: 'What is your biggest' },
    { kind: 'final', text: 'What is your biggest weakness?', endOfSpeech: true },
  ]);
  assert.equal(a.hasPending(), false);
});

test('UtteranceEnd finalizes settled text when no speech_final came (noisy room)', () => {
  const a = dg.createUtteranceAssembler();
  const out = run(a, [
    results('Tell me about', { isFinal: true, start: 0, duration: 1 }),
    results('a project', { isFinal: true, start: 1, duration: 1 }),
    utteranceEnd(),
  ]);
  assert.deepEqual(out.at(-1), { kind: 'final', text: 'Tell me about a project', endOfSpeech: true });
});

test('UtteranceEnd right after speech_final is ignored (no duplicate signal)', () => {
  const a = dg.createUtteranceAssembler();
  const out = run(a, [results('Hi.', { isFinal: true, speechFinal: true }), utteranceEnd()]);
  assert.deepEqual(out, [{ kind: 'final', text: 'Hi.', endOfSpeech: true }]);
});

test('non-stop talking is cut into lines (endOfSpeech false), then UtteranceEnd signals the end', () => {
  const a = dg.createUtteranceAssembler({ maxUtteranceMs: 5000 });
  const out = run(a, [
    results('one two three', { isFinal: true, start: 0, duration: 3 }),
    results('four five six', { isFinal: true, start: 3, duration: 3 }), // 6 s >= 5 s
    utteranceEnd(),
  ]);
  assert.deepEqual(out, [
    { kind: 'interim', text: 'one two three' },
    { kind: 'final', text: 'one two three four five six', endOfSpeech: false },
    { kind: 'end-of-speech' },
  ]);
});

test('a Finalize flush (from_finalize) ends the utterance; empty finals clear a stale guess', () => {
  const a = dg.createUtteranceAssembler();
  assert.deepEqual(run(a, [results('so yeah', { isFinal: true, fromFinalize: true })]), [
    { kind: 'final', text: 'so yeah', endOfSpeech: true },
  ]);
  const b = dg.createUtteranceAssembler();
  assert.deepEqual(run(b, [results('uh'), results('', { isFinal: true })]), [
    { kind: 'interim', text: 'uh' },
    { kind: 'interim', text: '' },
  ]);
});

test('flush() turns settled text into a final line (stream closing)', () => {
  const a = dg.createUtteranceAssembler();
  run(a, [results('almost done', { isFinal: true })]);
  assert.deepEqual(a.flush(), [{ kind: 'final', text: 'almost done', endOfSpeech: true }]);
  assert.deepEqual(a.flush(), []);
});

// ---- errors ----
test('handshake statuses map to friendly coded errors without the key', () => {
  const cases = [
    [401, 'BAD_KEY', true],
    [403, 'BAD_KEY', true],
    [402, 'NO_CREDIT', true],
    [429, 'RATE_LIMIT', false],
    [400, 'BAD_REQUEST', true],
    [503, 'PROVIDER_DOWN', false],
    [418, 'PROVIDER_ERROR', false],
  ];
  for (const [status, code, fatal] of cases) {
    const v = dg.classifyHandshakeStatus(status);
    assert.equal(v.error.code, code, `HTTP ${status}`);
    assert.equal(v.fatal, fatal, `HTTP ${status} fatal`);
    assert.equal(v.error.status, status);
    assert.match(v.error.message, /Deepgram/);
  }
  assert.match(dg.classifyHandshakeStatus(402).error.message, /out of credit/);
  assert.equal(dg.networkError(new Error('getaddrinfo ENOTFOUND')).code, 'OFFLINE');
  assert.equal(dg.networkError(new Error('Opening handshake has timed out')).code, 'TIMEOUT');
});

test('close codes: drops reconnect, bad audio / auth / credit do not', () => {
  assert.equal(dg.classifyClose(1006, '').reconnect, true);
  assert.equal(dg.classifyClose(1011, 'NET-0001').reconnect, true);
  assert.equal(dg.classifyClose(1000, '').reconnect, true);
  assert.equal(dg.classifyClose(1008, 'DATA-0000').reconnect, false);
  assert.equal(dg.classifyClose(1008, 'DATA-0000').error.code, 'BAD_AUDIO');
  assert.equal(dg.classifyClose(1011, 'insufficient credit').error.code, 'NO_CREDIT');
});

test('reconnect backoff: 3 growing delays, then give up; fatal errors never retry', () => {
  const delays = [0, 1, 2].map((n) => dg.reconnectDelay(n));
  assert.ok(delays.every((d) => d > 0));
  assert.ok(delays[0] < delays[1] && delays[1] < delays[2]);
  assert.equal(dg.reconnectDelay(dg.MAX_RECONNECTS), -1);
  assert.equal(dg.reconnectDelay(0, { fatal: true }), -1);
  assert.equal(dg.reconnectDelay(-1), -1);
});

test('idle timing: Finalize once audio stops, KeepAlive while idle', () => {
  const t = 100_000;
  // Audio still arriving: nothing.
  assert.deepEqual(dg.idleActions({ now: t, lastAudioAt: t - 100, lastSendAt: t - 100, flowing: true }), { finalize: false, keepAlive: false });
  // Audio stopped a moment ago: flush.
  assert.equal(dg.idleActions({ now: t, lastAudioAt: t - dg.FINALIZE_AFTER_IDLE_MS, lastSendAt: t - 900, flowing: true }).finalize, true);
  // Already flushed, idle for a while: KeepAlive.
  assert.deepEqual(dg.idleActions({ now: t, lastAudioAt: t - 20_000, lastSendAt: t - dg.KEEPALIVE_MS, flowing: false }), { finalize: false, keepAlive: true });
  assert.ok(dg.KEEPALIVE_MS < 10_000, "inside Deepgram's 10 s idle timeout");
});

test('PCM frames are size-checked', () => {
  assert.ok(dg.toPcmBuffer(new Uint8Array(3200)));
  assert.ok(dg.toPcmBuffer(new ArrayBuffer(320)));
  assert.equal(dg.toPcmBuffer(new Uint8Array(0)), null);
  assert.equal(dg.toPcmBuffer(new Uint8Array(3)), null, 'odd byte count is not Int16');
  assert.equal(dg.toPcmBuffer(new Uint8Array(dg.MAX_FRAME_BYTES + 2)), null);
  assert.equal(dg.toPcmBuffer('AAAA'), null);
  assert.equal(dg.toPcmBuffer(new Int16Array(10)), null, 'only bytes cross IPC');
  const view = new Uint8Array(new ArrayBuffer(10), 2, 4);
  assert.equal(dg.toPcmBuffer(view).length, 4, 'respects the view offset');
});
