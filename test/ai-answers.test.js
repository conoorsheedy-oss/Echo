// Unit tests for answer generation in src/main/ai.js: SSE streaming,
// cancellation, thinking-level policy, transcript capping, and the
// "model rejected thinkingConfig" fallback. fetch() is mocked -- no network,
// no real API key.
// Run: npm test   (plain `node --test`, no dependencies)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.GEMINI_MODEL; // use the built-in default model id
const keyStore = require('../src/main/keyStore');
keyStore.getKey = (provider) => (provider === 'gemini' ? 'test-gemini-key' : 'test-groq-key');
const ai = require('../src/main/ai');
const { createRequestRegistry } = require('../src/main/ai-requests');

const encoder = new TextEncoder();
const realFetch = global.fetch;

// ---- helpers ----
function sseEvent(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
function textEvent(text, finishReason) {
  return sseEvent({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }],
  });
}

// A Response whose body yields `pieces` (strings) one by one. If hang is
// true the stream then stays open until the request's signal aborts.
function sseResponse(pieces, { signal, hang = false } = {}) {
  let i = 0;
  const body = new ReadableStream({
    start(controller) {
      if (signal) {
        const onAbort = () => {
          try { controller.error(signal.reason); } catch (e) { /* already closed */ }
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    },
    async pull(controller) {
      await new Promise((r) => setTimeout(r, 2));
      if (i < pieces.length) {
        controller.enqueue(encoder.encode(pieces[i++]));
      } else if (!hang) {
        controller.close();
      } else {
        await new Promise(() => {}); // wait for abort
      }
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(handler) {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    const call = { url: String(url), init, body };
    calls.push(call);
    return handler(call, calls.length);
  };
  return calls;
}

test.afterEach(() => {
  global.fetch = realFetch;
  ai._resetSessionState();
});

// ---- SSE parser ----
test('SSE parser handles events split across chunks, CRLF, comments and [DONE]', () => {
  const got = [];
  const parser = ai.createSseParser((payload) => got.push(payload));
  const stream = `: keep-alive\n\ndata: {"a":1}\n\ndata: {"b":\r\ndata: 2}\r\n\r\ndata: [DONE]\n\ndata: {"c":3}`;
  // Feed it one character at a time -- the worst possible chunking.
  for (const ch of stream) parser.push(ch);
  parser.end(); // flushes the final event that had no trailing blank line
  assert.deepEqual(got, ['{"a":1}', '{"b":\n2}', '{"c":3}']);
});

// ---- Streaming ----
test('suggestions stream from :streamGenerateContent?alt=sse and forward chunks in order', async () => {
  const calls = mockFetch((call) => sseResponse([
    textEvent('I led the '),
    textEvent('migration'),
    textEvent(' and cut costs 30%.', 'STOP'),
  ], { signal: call.init.signal }));

  const chunks = [];
  const result = await ai.generateSuggestion({
    transcript: 'Them: Tell me about a time you saved money?',
    mode: 'meeting',
    question: 'Tell me about a time you saved money?',
    onChunk: (t) => chunks.push(t),
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/models\/[^/:]+:streamGenerateContent\?alt=sse$/);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'test-gemini-key');
  assert.ok(!calls[0].url.includes('test-gemini-key'), 'key never goes in the URL');
  assert.deepEqual(chunks, ['I led the ', 'migration', ' and cut costs 30%.']);
  assert.equal(result.text, 'I led the migration and cut costs 30%.');
  assert.equal(result.thinkingLevel, 'low');

  const gc = calls[0].body.generationConfig;
  assert.deepEqual(gc.thinkingConfig, { thinkingLevel: 'low' });
  assert.ok(!('thinkingBudget' in gc.thinkingConfig), 'never send thinkingBudget');
  assert.ok(gc.maxOutputTokens <= 2000, `spoken answers keep a tight budget (got ${gc.maxOutputTokens})`);
});

test('thought parts are not forwarded; MAX_TOKENS adds the cut-off note', async () => {
  mockFetch((call) => sseResponse([
    sseEvent({ candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] } }] }),
    textEvent('Answer.', 'MAX_TOKENS'),
  ], { signal: call.init.signal }));
  const chunks = [];
  const result = await ai.generateSuggestion({ transcript: 'Them: hi?', mode: 'general', onChunk: (t) => chunks.push(t) });
  assert.deepEqual(chunks, ['Answer.']);
  assert.match(result.text, /^Answer\.\n\n\[cut off/);
});

test('without onChunk the plain :generateContent path is used (summaries)', async () => {
  const calls = mockFetch(() => jsonResponse({ candidates: [{ content: { parts: [{ text: ' Plain answer. ' }] }, finishReason: 'STOP' }] }));
  const result = await ai.generateSuggestion({ transcript: 'Them: hello?', mode: 'general' });
  assert.match(calls[0].url, /:generateContent$/);
  assert.equal(result.text, 'Plain answer.');
});

test('a broken stream falls back to the non-streaming request', async () => {
  const calls = mockFetch((call, n) => {
    if (n === 1) return sseResponse(['data: {not json\n\n'], { signal: call.init.signal });
    return jsonResponse({ candidates: [{ content: { parts: [{ text: 'Fallback answer.' }] }, finishReason: 'STOP' }] });
  });
  const result = await ai.generateSuggestion({ transcript: 'Them: why?', mode: 'general', onChunk: () => {} });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /streamGenerateContent/);
  assert.match(calls[1].url, /:generateContent$/);
  assert.equal(result.text, 'Fallback answer.');
});

test('a 5xx on the stream endpoint is retried once without streaming', async () => {
  const calls = mockFetch((call, n) => (n === 1
    ? jsonResponse({ error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded' } }, 503)
    : jsonResponse({ candidates: [{ content: { parts: [{ text: 'OK.' }] } }] })));
  const result = await ai.generateSuggestion({ transcript: 'Them: ok?', mode: 'general', onChunk: () => {} });
  assert.equal(calls.length, 2);
  assert.equal(result.text, 'OK.');
});

test('auth / rate-limit errors are NOT retried and keep their friendly codes', async () => {
  for (const [status, code] of [[401, 'BAD_KEY'], [429, 'RATE_LIMIT']]) {
    const calls = mockFetch(() => jsonResponse({ error: { code: status, status: 'X', message: 'nope' } }, status));
    await assert.rejects(
      ai.generateSuggestion({ transcript: 'Them: q?', mode: 'general', onChunk: () => {} }),
      (err) => err.code === code,
    );
    assert.equal(calls.length, 1);
  }
});

test('unknown model error suggests setting GEMINI_MODEL to a newer Flash model', async () => {
  mockFetch(() => jsonResponse({ error: { code: 404, status: 'NOT_FOUND', message: 'model not found' } }, 404));
  await assert.rejects(
    ai.generateSuggestion({ transcript: 'Them: q?', mode: 'general', onChunk: () => {} }),
    (err) => err.code === 'MODEL_NOT_FOUND' && /GEMINI_MODEL/.test(err.message) && /Flash/.test(err.message),
  );
});

// ---- Cancellation ----
test('aborting mid-stream rejects with ABORTED and cancels the HTTP request', async () => {
  let fetchSignal;
  mockFetch((call) => {
    fetchSignal = call.init.signal;
    return sseResponse([textEvent('First words')], { signal: call.init.signal, hang: true });
  });
  const controller = new AbortController();
  const chunks = [];
  const pending = ai.generateSuggestion({
    transcript: 'Them: question?',
    mode: 'general',
    signal: controller.signal,
    onChunk: (t) => {
      chunks.push(t);
      controller.abort(); // superseded right after the first chunk
    },
  });
  await assert.rejects(pending, (err) => err.code === 'ABORTED');
  assert.deepEqual(chunks, ['First words']);
  assert.ok(fetchSignal.aborted, 'the signal handed to fetch was aborted');
});

test('request registry: explicit supersedes all suggestions, auto only older autos, ask is independent', () => {
  const reg = createRequestRegistry();
  const a1 = reg.start('suggest', 'a1', 'auto');
  const chat = reg.start('ask', 'c1', 'explicit');
  const e1 = reg.start('suggest', 'e1', 'explicit');
  assert.ok(a1.signal.aborted, 'explicit cancels an in-flight auto');
  assert.ok(!chat.signal.aborted, 'chat requests are untouched');

  const a2 = reg.start('suggest', 'a2', 'auto');
  assert.ok(!e1.signal.aborted, 'auto never cancels an explicit request');
  const a3 = reg.start('suggest', 'a3', 'auto');
  assert.ok(a2.signal.aborted, 'a newer auto cancels the older auto');
  assert.ok(!a3.signal.aborted);

  const e2 = reg.start('suggest', 'e2', 'explicit');
  assert.ok(e1.signal.aborted && a3.signal.aborted, 'explicit cancels everything');
  assert.ok(!e2.signal.aborted);

  assert.equal(reg.cancel('c1'), true);
  assert.ok(chat.signal.aborted);
  assert.equal(reg.cancel('nope'), false);

  e2.done();
  assert.equal(reg.has('e2'), false);
});

// ---- Thinking level policy ----
test('thinking level: Auto by mode + question, Fast = low, Max = high', () => {
  const lvl = (mode, question, extra = {}) => ai.resolveThinkingLevel({ mode, question, quality: 'auto', ...extra });
  assert.equal(lvl('interview', 'Tell me about yourself.'), 'medium');
  assert.equal(lvl('interview', 'Why do you want to work here?'), 'medium');
  assert.equal(lvl('interview', 'Can you reverse a linked list in place?'), 'high');
  assert.equal(lvl('interview', 'What is the time complexity of your approach?'), 'high');
  assert.equal(lvl('interview', 'What is the probability of rolling two sixes with two dice?'), 'high');
  assert.equal(lvl('interview', 'How would you design a URL shortener at scale?'), 'high');
  assert.equal(lvl('interview', 'Here is a brain teaser for you.'), 'high');
  assert.equal(lvl('interview', 'Walk me through it.', { hasImages: true }), 'high');
  // Everyday behavioural phrasing must not trip the technical heuristic.
  for (const q of [
    'What sort of role are you looking for?',
    'Tell me about a time you had to solve a conflict in your team.',
    'What are your salary expectations?',
    'On a scale of 1 to 10, how would you rate your Python?',
    'What was your biggest challenge in that job from 2020 - 2023?',
    'Why are you job searching right now?',
  ]) {
    assert.equal(lvl('interview', q), 'medium', q);
  }
  assert.equal(lvl('meeting', 'Can you reverse a linked list?'), 'low');
  assert.equal(lvl('presentation', 'Any questions?'), 'low');
  assert.equal(lvl('general', 'What do you think?'), 'low');
  assert.equal(lvl('mystery-mode', 'What do you think?'), 'low');
  assert.equal(ai.resolveThinkingLevel({ mode: 'interview', question: 'Implement LRU cache', quality: 'fast' }), 'low');
  assert.equal(ai.resolveThinkingLevel({ mode: 'general', question: 'hi', quality: 'max' }), 'high');
  assert.equal(ai.resolveThinkingLevel({ mode: 'interview', question: 'hi', quality: 'bogus' }), 'medium');
});

test('interview coding question: high thinking + a bigger output budget is sent', async () => {
  const calls = mockFetch((call) => sseResponse([textEvent('Use two pointers.', 'STOP')], { signal: call.init.signal }));
  await ai.generateSuggestion({
    transcript: 'Them: Write a function to check if a string is a palindrome.',
    mode: 'interview',
    onChunk: () => {},
  });
  const gc = calls[0].body.generationConfig;
  assert.equal(gc.thinkingConfig.thinkingLevel, 'high');
  assert.ok(gc.maxOutputTokens >= 4096, `coding answers get room for code + thinking (got ${gc.maxOutputTokens})`);
});

// ---- 400 "thinking" fallback ----
test('a 400 that mentions thinking is retried once without thinkingConfig, and remembered', async () => {
  const calls = mockFetch((call) => {
    if (call.body.generationConfig.thinkingConfig) {
      return jsonResponse({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Thinking level is not supported for this model.' } }, 400);
    }
    return sseResponse([textEvent('Fine.', 'STOP')], { signal: call.init.signal });
  });
  const r1 = await ai.generateSuggestion({ transcript: 'Them: hi?', mode: 'interview', onChunk: () => {} });
  assert.equal(r1.text, 'Fine.');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].body.generationConfig.thinkingConfig);
  assert.ok(!calls[1].body.generationConfig.thinkingConfig);

  // Next request this session: no thinkingConfig at all, first try succeeds.
  await ai.generateSuggestion({ transcript: 'Them: again?', mode: 'interview', onChunk: () => {} });
  assert.equal(calls.length, 3);
  assert.ok(!calls[2].body.generationConfig.thinkingConfig);
});

test('a 400 unrelated to thinking is not retried', async () => {
  const calls = mockFetch(() => jsonResponse({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Image could not be read.' } }, 400));
  await assert.rejects(
    ai.generateSuggestion({ transcript: 'Them: hi?', mode: 'interview', onChunk: () => {} }),
    (err) => err.code === 'BAD_REQUEST',
  );
  assert.equal(calls.length, 1);
});

// ---- Full-session context + capping ----
test('capTranscript keeps short transcripts intact and drops the OLDEST lines past the cap', () => {
  assert.equal(ai.capTranscript('You: a\nThem: b'), 'You: a\nThem: b');

  const lines = [];
  for (let i = 0; i < 5000; i++) lines.push(`${i % 2 ? 'Them' : 'You'}: line ${i} ${'x'.repeat(40)}`);
  const full = lines.join('\n');
  assert.ok(full.length > ai.MAX_PROMPT_TRANSCRIPT_CHARS);

  const capped = ai.capTranscript(full);
  assert.ok(capped.length <= ai.MAX_PROMPT_TRANSCRIPT_CHARS, `capped length ${capped.length}`);
  assert.ok(capped.startsWith(`${ai.TRANSCRIPT_TRIMMED_MARKER}\n`));
  assert.ok(capped.endsWith(lines[lines.length - 1]), 'newest line kept');
  assert.ok(!capped.includes('line 0 '), 'oldest line dropped');
  // Only whole lines are kept (no half line right after the marker).
  const firstKept = capped.split('\n')[1];
  assert.ok(lines.includes(firstKept));

  // Custom cap + a single giant line still yields something within the cap.
  const giant = ai.capTranscript(`Them: ${'y'.repeat(500)}`, 100);
  assert.ok(giant.length <= 100 && giant.startsWith(ai.TRANSCRIPT_TRIMMED_MARKER));
});

test('prompt carries the whole transcript, earlier answers, and the latest question LAST', async () => {
  const calls = mockFetch((call) => sseResponse([textEvent('Sure.', 'STOP')], { signal: call.init.signal }));
  const transcriptLines = [];
  for (let i = 0; i < 300; i++) transcriptLines.push(`${i % 2 ? 'Them' : 'You'}: turn ${i}`);
  transcriptLines.push('Them: Going back to earlier, can you expand on that?');
  await ai.generateSuggestion({
    transcript: transcriptLines.join('\n'),
    mode: 'interview',
    question: 'Going back to earlier, can you expand on that?',
    previousAnswers: [
      { kind: 'suggestion', question: 'Tell me about yourself', text: 'I build backend systems.' },
      { kind: 'chat', question: 'what did they mean?', text: 'They want depth.' },
    ],
    onChunk: () => {},
  });
  const prompt = calls[0].body.contents[0].parts[0].text;
  assert.ok(prompt.includes('You: turn 0'), 'oldest line included (no recent-window slicing)');
  assert.ok(prompt.includes('Them: turn 299'));
  assert.ok(prompt.includes('I build backend systems.') && prompt.includes('They want depth.'));
  assert.ok(prompt.includes('Suggested answer') && prompt.includes("Chat answer to the user's own question"));
  const latestIdx = prompt.lastIndexOf('=== LATEST ===');
  assert.ok(latestIdx > prompt.indexOf('They want depth.'), 'LATEST comes after context');
  assert.ok(prompt.slice(latestIdx).includes('Going back to earlier, can you expand on that?'));
  assert.ok(!prompt.includes(ai.TRANSCRIPT_TRIMMED_MARKER));
});

test('a huge transcript is trimmed in the prompt with the marker', async () => {
  const calls = mockFetch((call) => sseResponse([textEvent('Ok.', 'STOP')], { signal: call.init.signal }));
  const big = Array.from({ length: 4000 }, (_, i) => `Them: sentence number ${i} ${'z'.repeat(30)}`).join('\n');
  await ai.askFollowUp({ transcript: big, question: 'What did they ask last?', mode: 'meeting', onChunk: () => {} });
  const prompt = calls[0].body.contents[0].parts[0].text;
  assert.ok(prompt.includes(ai.TRANSCRIPT_TRIMMED_MARKER));
  assert.ok(prompt.includes('sentence number 3999 '));
  assert.ok(!prompt.includes('sentence number 0 '));
  assert.ok(prompt.trimEnd().endsWith("User's question to you: What did they ask last?"));
});

test('suggest system prompt asks for spoken, headline-first answers', async () => {
  const calls = mockFetch((call) => sseResponse([textEvent('Ok.', 'STOP')], { signal: call.init.signal }));
  await ai.generateSuggestion({ transcript: 'Them: hi?', mode: 'interview', onChunk: () => {} });
  const system = calls[0].body.systemInstruction.parts[0].text;
  assert.match(system, /say this out loud/i);
  assert.match(system, /ONE short headline sentence/);
  assert.match(system, /STAR/);
  assert.match(system, /No headings, no bullet lists/);
});
