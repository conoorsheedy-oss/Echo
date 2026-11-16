// Unit tests for the instant first line ("headline") + full answer pipeline
// (src/main/suggest-pipeline.js) and the headline Gemini call in ai.js.
// fetch() is mocked -- no network, no real API key.
// Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/electron-stub');
delete process.env.GEMINI_MODEL;
const keyStore = require('../src/main/keyStore');
keyStore.getKey = (provider) => (provider === 'gemini' ? 'test-gemini-key' : 'test-groq-key');
const ai = require('../src/main/ai');
const { runSuggestion } = require('../src/main/suggest-pipeline');
// These tests are about the pipeline, not the first-line model lookup
// (test/headline-model.test.js): no Flash-Lite, so the first line uses
// GEMINI_MODEL and no extra models-list request is made.
delete process.env.GEMINI_HEADLINE_MODEL;
ai._resetHeadlineModel({ status: 'done', model: null });

const encoder = new TextEncoder();
const realFetch = global.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.afterEach(() => {
  global.fetch = realFetch;
  ai._resetSessionState();
});

function textEvent(text, finishReason) {
  return `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }] })}\n\n`;
}

// An SSE Response whose pieces arrive at the given delays (ms from the
// request), and which errors when the request's signal aborts.
function timedSse(pieces, signal) {
  const started = Date.now();
  let i = 0;
  const body = new ReadableStream({
    start(controller) {
      if (!signal) return;
      const onAbort = () => {
        try { controller.error(signal.reason); } catch (e) { /* closed */ }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(controller) {
      if (i >= pieces.length) {
        controller.close();
        return;
      }
      const [at, text] = pieces[i++];
      const wait = at - (Date.now() - started);
      if (wait > 0) await sleep(wait);
      if (signal && signal.aborted) return;
      controller.enqueue(encoder.encode(text));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const isHeadlineCall = (body) => /Give ONLY the first sentence/.test(body.systemInstruction.parts[0].text);

// A fake ai module: each generator streams its pieces at the given delays.
// analysis: when set, the fake also has analyzeSuggestion() returning it.
function fakeAi({ headline = [], answer = [], headlineError = null, answerText = 'Full answer.', analysis = null } = {}) {
  const seen = { headlineSignal: null, answerSignal: null, headlineCalls: 0, analyzeCalls: 0, headlineParams: null, answerParams: null };
  async function play(pieces, signal, onChunk) {
    const t0 = Date.now();
    for (const [at, text] of pieces) {
      const wait = at - (Date.now() - t0);
      // Like a real fetch, an abort ends the wait at once.
      if (wait > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, wait);
          if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
      onChunk(text);
    }
  }
  const fake = {
    seen,
    async generateHeadline(params) {
      const { signal, onChunk } = params;
      seen.headlineCalls += 1;
      seen.headlineSignal = signal;
      seen.headlineParams = params;
      if (headlineError) {
        await sleep(5);
        throw headlineError;
      }
      await play(headline, signal, onChunk);
      return { text: headline.map((p) => p[1]).join('') };
    },
    async generateSuggestion(params) {
      const { signal, onChunk } = params;
      seen.answerSignal = signal;
      seen.answerParams = params;
      await play(answer, signal, onChunk || (() => {}));
      return { text: answerText, thinkingLevel: 'low' };
    },
  };
  if (analysis) {
    fake.analyzeSuggestion = () => {
      seen.analyzeCalls += 1;
      return analysis;
    };
  }
  return fake;
}

function recorder() {
  const t0 = Date.now();
  const events = [];
  return { events, emit: (part, text) => events.push({ part, text, at: Date.now() - t0 }) };
}

const quietLog = { warn: () => {} };

test('headline arrives first, then the full answer; the result is the full answer', async () => {
  const fake = fakeAi({
    headline: [[10, "I'd use a hash map."]],
    answer: [[80, 'I would use '], [90, 'a hash map.']],
  });
  const rec = recorder();
  const result = await runSuggestion({ ai: fake, params: {}, emit: rec.emit, headline: true, log: quietLog });
  assert.equal(result.text, 'Full answer.');
  assert.deepEqual(rec.events.map((e) => e.part), ['headline', 'answer', 'answer']);
  assert.ok(rec.events[0].at < rec.events[1].at);
  assert.ok(fake.seen.headlineSignal.aborted, 'headline call is closed once the full answer is done');
});

test('a headline slower than the full answer is dropped silently (and aborted)', async () => {
  const fake = fakeAi({
    headline: [[120, 'Too late.']],
    answer: [[10, 'Full '], [20, 'answer.']],
  });
  const rec = recorder();
  await runSuggestion({ ai: fake, params: {}, emit: rec.emit, headline: true, log: quietLog });
  await sleep(150);
  assert.deepEqual(rec.events.map((e) => e.part), ['answer', 'answer']);
  assert.ok(fake.seen.headlineSignal.aborted);
});

test('a failing headline never affects the full answer, and logs only a code', async () => {
  const warnings = [];
  const fake = fakeAi({
    headlineError: Object.assign(new Error('secret prompt text'), { code: 'RATE_LIMIT' }),
    answer: [[20, 'Full answer.']],
  });
  const rec = recorder();
  const result = await runSuggestion({ ai: fake, params: {}, emit: rec.emit, headline: true, log: { warn: (m) => warnings.push(m) } });
  assert.equal(result.text, 'Full answer.');
  assert.deepEqual(rec.events.map((e) => e.part), ['answer']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /RATE_LIMIT/);
  assert.ok(!warnings[0].includes('secret'), 'never logs the error body');
});

test('one cancellation stops both calls', async () => {
  const fake = fakeAi({
    headline: [[10, 'First line.'], [500, ' more']],
    answer: [[500, 'Never shown.']],
  });
  const controller = new AbortController();
  const rec = recorder();
  const pending = runSuggestion({ ai: fake, params: {}, signal: controller.signal, emit: rec.emit, headline: true, log: quietLog });
  await sleep(40);
  controller.abort();
  await assert.rejects(pending, (err) => err.code === 'ABORTED');
  assert.ok(fake.seen.headlineSignal.aborted && fake.seen.answerSignal.aborted);
  assert.deepEqual(rec.events.map((e) => e.part), ['headline']);
});

test('setting off (or no streaming) = no extra call', async () => {
  const fake = fakeAi({ headline: [[1, 'x.']], answer: [[5, 'Full answer.']] });
  const rec = recorder();
  await runSuggestion({ ai: fake, params: {}, emit: rec.emit, headline: false });
  assert.equal(fake.seen.headlineCalls, 0);
  await runSuggestion({ ai: fake, params: {}, emit: undefined, headline: true });
  assert.equal(fake.seen.headlineCalls, 0, 'no requestId -> nothing could be shown');
});

// ---- The real ai.js calls, with fetch mocked ----
test('timing: with a slow full answer, the instant first line is the first visible token', async () => {
  const transcript = Array.from({ length: 600 }, (_, i) => `${i % 2 ? 'Them' : 'You'}: earlier line number ${i} ${'x'.repeat(30)}`).join('\n')
    + '\nThem: Why did you use a hash map instead of an array?';
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, init });
    if (isHeadlineCall(body)) {
      return timedSse([[40, textEvent("Because lookups ")], [60, textEvent('are constant time. ', 'STOP')]], init.signal);
    }
    // The full answer "thinks" for a while before its first token.
    return timedSse([[400, textEvent('Because a hash map gives O(1) lookups. ')], [420, textEvent('An array would need a scan.', 'STOP')]], init.signal);
  };
  const rec = recorder();
  const result = await runSuggestion({
    ai,
    params: {
      transcript,
      mode: 'interview',
      question: 'Why did you use a hash map instead of an array?',
      previousAnswers: [{ kind: 'suggestion', question: 'Two sum', text: 'Use a map.\n```py\nseen = {}\n```' }],
    },
    emit: rec.emit,
    headline: true,
    log: quietLog,
  });
  const firstHeadline = rec.events.find((e) => e.part === 'headline');
  const firstAnswer = rec.events.find((e) => e.part === 'answer');
  assert.ok(firstHeadline && firstAnswer);
  assert.equal(rec.events[0].part, 'headline', 'first visible token comes from the headline call');
  assert.ok(firstHeadline.at + 200 < firstAnswer.at, `headline at ${firstHeadline.at} ms, full answer at ${firstAnswer.at} ms`);
  assert.equal(result.text, 'Because a hash map gives O(1) lookups. An array would need a scan.');

  // The headline request: minimal thinking, tiny budget, trimmed context, streamed.
  const h = calls.find((c) => isHeadlineCall(c.body));
  const full = calls.find((c) => !isHeadlineCall(c.body));
  assert.match(h.url, /:streamGenerateContent\?alt=sse$/);
  assert.equal(h.init.headers['x-goog-api-key'], 'test-gemini-key');
  assert.deepEqual(h.body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
  assert.ok(h.body.generationConfig.maxOutputTokens <= 400, `headline budget ${h.body.generationConfig.maxOutputTokens}`);
  const hText = h.body.contents[0].parts.map((p) => p.text || '').join('');
  const fullText = full.body.contents[0].parts.map((p) => p.text || '').join('');
  assert.ok(hText.length < 11000, `headline context trimmed (${hText.length} chars)`);
  assert.ok(fullText.length > 20000, 'full answer keeps the whole transcript');
  assert.ok(hText.includes('Why did you use a hash map instead of an array?'));
  assert.ok(hText.includes('seen = {}'), 'the earlier answer (the code) is in the headline context');
  assert.ok(hText.trimEnd().endsWith('Reply with ONLY the first sentence the user should say.'));
  // The full answer for this follow-up thinks low.
  assert.equal(full.body.generationConfig.thinkingConfig.thinkingLevel, 'low');
});

test('headline system prompt: one spoken sentence, same voice rules', () => {
  for (const mode of ['interview', 'meeting', 'presentation', 'general', 'bogus']) {
    const p = ai.buildHeadlineSystemPrompt(mode);
    assert.match(p, /Give ONLY the first sentence the user should say out loud right now, in their own voice/);
    assert.match(p, /no markdown, no lists, no code/);
    assert.match(p, /em dash/i);
    for (const tell of ['Great question', 'Certainly', 'leverage', 'spearheaded']) assert.ok(p.includes(tell));
  }
});

test('generateHeadline: humanized stream, first sentence only, no non-streaming fallback', async () => {
  let n = 0;
  global.fetch = async (url, init) => {
    n += 1;
    return timedSse([[5, textEvent('Great question! ')], [10, textEvent("I'd start with a hash map — one pass. ")], [15, textEvent('Then return the pair.', 'STOP')]], init.signal);
  };
  const chunks = [];
  const out = await ai.generateHeadline({ transcript: 'Them: How would you solve two sum?', mode: 'interview', onChunk: (t) => chunks.push(t) });
  assert.equal(n, 1);
  assert.ok(!chunks.join('').includes('Great question'));
  assert.ok(!chunks.join('').includes('—'));
  assert.equal(out.text, "I'd start with a hash map, one pass.");

  // A broken stream is NOT retried without streaming (a late line is useless).
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(encoder.encode('data: {not json\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  await assert.rejects(ai.generateHeadline({ transcript: 'Them: hi?', mode: 'general', onChunk: () => {} }), (err) => err.code === 'STREAM_FAILED');
  assert.equal(calls, 1);
});

test('firstSpokenSentence strips quotes and extra sentences', () => {
  assert.equal(ai.firstSpokenSentence('"I\'d use a heap." Then sort.'), "I'd use a heap.");
  assert.equal(ai.firstSpokenSentence('\n\nYeah, mostly O(n) time\n'), 'Yeah, mostly O(n) time');
  assert.equal(ai.firstSpokenSentence(''), '');
});

test('a model without the "minimal" level: the headline retries with low, full answers keep their thinking level', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const level = body.generationConfig.thinkingConfig && body.generationConfig.thinkingConfig.thinkingLevel;
    if (level === 'minimal') {
      return new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Thinking level minimal is not supported for this model.' } }), { status: 400 });
    }
    return timedSse([[5, textEvent('Fine. ', 'STOP')]], init.signal);
  };
  await ai.generateHeadline({ transcript: 'Them: hi?', mode: 'interview', onChunk: () => {} });
  assert.deepEqual(calls.map((b) => b.generationConfig.thinkingConfig.thinkingLevel), ['minimal', 'low']);
  await ai.generateHeadline({ transcript: 'Them: again?', mode: 'interview', onChunk: () => {} });
  assert.equal(calls[2].generationConfig.thinkingConfig.thinkingLevel, 'low', 'remembered for the session');
  await ai.generateSuggestion({ transcript: 'Them: Write a function to reverse a linked list.', mode: 'interview', onChunk: () => {} });
  assert.equal(calls[3].generationConfig.thinkingConfig.thinkingLevel, 'high', 'full answers still send their level');
});

// ---- "Nothing to add" (NO_RESPONSE sentinel) ----
const { createSentinelGate, EXPLICIT_FALLBACK_TEXT } = require('../src/main/suggest-pipeline');
const AUTO_MEETING = { mode: 'meeting', questionKind: 'general', intent: 'information_sharing', allowNoResponse: true };
const EXPLICIT_MEETING = { ...AUTO_MEETING, allowNoResponse: false };
const SENTINEL = ai.NO_RESPONSE_SENTINEL;
const allText = (events) => events.map((e) => e.text).join('');

test('sentinel gate: holds back only what could still be the sentinel', () => {
  const g = createSentinelGate();
  assert.deepEqual(g.push('[[NO_'), { state: 'maybe', out: '' });
  assert.deepEqual(g.push('RESPONSE]]'), { state: 'yes', out: '' });
  assert.deepEqual(g.push(' more'), { state: 'yes', out: '' });
  const n = createSentinelGate();
  assert.deepEqual(n.push('N'), { state: 'maybe', out: '' });
  assert.deepEqual(n.push('o, I would wait.'), { state: 'no', out: 'No, I would wait.' });
  assert.deepEqual(n.push(' Really.'), { state: 'no', out: ' Really.' });
  const t = createSentinelGate();
  assert.deepEqual(t.push('I'), { state: 'no', out: 'I' }, 'a normal first character goes straight out');
  const short = createSentinelGate();
  short.push('NO');
  assert.equal(short.flush(), 'NO', 'an undecided ending is real text');
});

test('auto request: a sentinel full answer is skipped silently and the headline is cancelled', async () => {
  const fake = fakeAi({
    analysis: AUTO_MEETING,
    headline: [[300, 'Too slow.']],
    answer: [[10, '[[NO_'], [20, 'RESPONSE]]'], [400, ' never']],
    answerText: SENTINEL,
  });
  const rec = recorder();
  const result = await runSuggestion({ ai: fake, params: { mode: 'meeting', requestKind: 'auto' }, emit: rec.emit, headline: true, log: quietLog });
  assert.deepEqual(result, { skipped: true, reason: 'no_response', intent: 'information_sharing' });
  assert.deepEqual(rec.events, [], 'nothing reaches the renderer');
  assert.ok(fake.seen.headlineSignal.aborted, 'sibling (headline) cancelled');
  assert.ok(fake.seen.answerSignal.aborted, 'the full answer stream is stopped too');
});

test('auto request: a sentinel headline cancels the full answer and skips', async () => {
  const fake = fakeAi({
    analysis: AUTO_MEETING,
    headline: [[10, SENTINEL]],
    answer: [[300, 'Slow full answer.']],
  });
  const rec = recorder();
  const t0 = Date.now();
  const result = await runSuggestion({ ai: fake, params: {}, emit: rec.emit, headline: true, log: quietLog });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no_response');
  assert.ok(Date.now() - t0 < 250, 'did not wait for the full answer');
  assert.ok(fake.seen.answerSignal.aborted, 'full answer cancelled');
  assert.deepEqual(rec.events, []);
});

test('auto request: a non-streamed sentinel answer is skipped too', async () => {
  const fake = fakeAi({ analysis: AUTO_MEETING, answer: [], answerText: ` ${SENTINEL}` });
  const result = await runSuggestion({ ai: fake, params: {}, emit: undefined, headline: true });
  assert.equal(result.skipped, true);
});

test('explicit request: never skipped; the sentinel is never shown', async () => {
  // Full answer says the sentinel: replaced by a short fallback line.
  const fake = fakeAi({ analysis: EXPLICIT_MEETING, answer: [[10, SENTINEL]], answerText: SENTINEL });
  const rec = recorder();
  const result = await runSuggestion({ ai: fake, params: {}, emit: rec.emit, headline: false, log: quietLog });
  assert.ok(!result.skipped);
  assert.equal(result.text, EXPLICIT_FALLBACK_TEXT);
  assert.ok(!allText(rec.events).includes('NO_RESPONSE'));

  // Headline says the sentinel: dropped; the full answer still shows.
  const fake2 = fakeAi({ analysis: EXPLICIT_MEETING, headline: [[5, SENTINEL]], answer: [[60, 'I would '], [70, 'wait a week.']] });
  const rec2 = recorder();
  const result2 = await runSuggestion({ ai: fake2, params: {}, emit: rec2.emit, headline: true, log: quietLog });
  assert.equal(result2.text, 'Full answer.');
  assert.deepEqual(rec2.events.map((e) => e.part), ['answer', 'answer']);
  assert.equal(allText(rec2.events), 'I would wait a week.');
});

test('normal answers stream unchanged, including ones that start like the sentinel', async () => {
  const fake = fakeAi({ analysis: AUTO_MEETING, headline: [[5, 'N'], [10, "o, I'd wait."]], answer: [[80, 'N'], [90, 'ot yet, '], [100, 'I think we wait.']] });
  const rec = recorder();
  const result = await runSuggestion({ ai: fake, params: {}, emit: rec.emit, headline: true, log: quietLog });
  assert.equal(result.text, 'Full answer.');
  assert.equal(rec.events.filter((e) => e.part === 'headline').map((e) => e.text).join(''), "No, I'd wait.");
  assert.equal(rec.events.filter((e) => e.part === 'answer').map((e) => e.text).join(''), 'Not yet, I think we wait.');
});

test('one analysis per request, shared by the headline and the full answer', async () => {
  const analysis = { mode: 'meeting', questionKind: 'general', intent: 'disagreement', allowNoResponse: true };
  const fake = fakeAi({ analysis, headline: [[5, 'Fair point on cost.']], answer: [[40, 'Full.']] });
  await runSuggestion({ ai: fake, params: { transcript: 'Them: x', mode: 'meeting' }, emit: recorder().emit, headline: true, log: quietLog });
  assert.equal(fake.seen.analyzeCalls, 1);
  for (const p of [fake.seen.headlineParams, fake.seen.answerParams]) {
    assert.equal(p.intent, 'disagreement');
    assert.equal(p.questionKind, 'general');
    assert.equal(p.allowNoResponse, true);
    assert.equal(p.transcript, 'Them: x');
  }
});

test('real ai.js: an automatic meeting request answered with the sentinel never emits it', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (isHeadlineCall(body)) return timedSse([[60, textEvent('[[NO_RESP')], [70, textEvent('ONSE]]', 'STOP')]], init.signal);
    return timedSse([[10, textEvent('[[NO')], [20, textEvent('_RESPONSE]]', 'STOP')]], init.signal);
  };
  const rec = recorder();
  const result = await runSuggestion({
    ai,
    params: { transcript: 'You: hi all\nThem: Just so you know, the release is on Friday.', mode: 'meeting', requestKind: 'auto', question: 'Just so you know, the release is on Friday.' },
    emit: rec.emit,
    headline: true,
    log: quietLog,
  });
  assert.equal(result.skipped, true);
  assert.equal(result.intent, 'information_sharing');
  assert.deepEqual(rec.events, []);
  const full = calls.find((b) => !isHeadlineCall(b));
  const head = calls.find((b) => isHeadlineCall(b));
  assert.match(full.contents[0].parts.at(-1).text, /triggered automatically/);
  if (head) assert.match(head.contents[0].parts.at(-1).text, /Intent: an update or statement/);
});

test('real ai.js: the same request in interview mode never gets the allowance', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return timedSse([[5, textEvent('I would say yes.', 'STOP')]], init.signal);
  };
  const result = await runSuggestion({
    ai,
    params: { transcript: 'Them: Do you have any questions for us?', mode: 'interview', requestKind: 'auto', question: 'Do you have any questions for us?' },
    emit: recorder().emit,
    headline: true,
    log: quietLog,
  });
  assert.equal(result.text, 'I would say yes.');
  for (const b of calls) {
    assert.ok(!JSON.stringify(b).includes('NO_RESPONSE'), 'no sentinel anywhere in an interview request');
  }
});

test('headline system prompt: mode-aware rules, sentinel only outside interviews', () => {
  const interview = ai.buildHeadlineSystemPrompt('interview');
  assert.ok(!interview.includes(ai.NO_RESPONSE_SENTINEL));
  assert.ok(!/In a meeting/.test(interview));
  const meeting = ai.buildHeadlineSystemPrompt('meeting');
  assert.match(meeting, /first line can be a position, a concrete suggestion or a short question back/);
  assert.match(meeting, /never just agree, never get defensive/);
  for (const mode of ['meeting', 'presentation', 'general', 'bogus']) {
    assert.ok(ai.buildHeadlineSystemPrompt(mode).includes(ai.NO_RESPONSE_SENTINEL), mode);
  }
  assert.equal(ai.buildHeadlineSystemPrompt('bogus'), ai.buildHeadlineSystemPrompt('general'));
});
