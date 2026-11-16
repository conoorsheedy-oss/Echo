// Unit tests for answer generation in src/main/ai.js: SSE streaming,
// cancellation, thinking-level policy, transcript capping, and the
// "model rejected thinkingConfig" fallback. fetch() is mocked -- no network,
// no real API key.
// Run: npm test   (plain `node --test`, no dependencies)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/electron-stub'); // no Electron binary needed (see file)
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

// All text parts of the user turn, in order (context, then LATEST after any images).
function promptText(call) {
  return call.body.contents[0].parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n\n');
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
  // Streamed through the humanize.js filter: trailing whitespace is held
  // back until the next piece arrives, so piece boundaries shift slightly.
  assert.deepEqual(chunks, ['I led the', ' migration', ' and cut costs 30%.']);
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
  // Speed first: normal / behavioural interview questions think LOW.
  assert.equal(lvl('interview', 'Tell me about yourself.'), 'low');
  assert.equal(lvl('interview', 'Why do you want to work here?'), 'low');
  assert.equal(lvl('interview', 'Tell me about a time you disagreed with your manager.'), 'low');
  assert.equal(lvl('interview', 'Can you reverse a linked list in place?'), 'high');
  // A follow-up about existing code is NOT a new problem: low (fast).
  assert.equal(lvl('interview', 'What is the time complexity of your approach?'), 'low');
  assert.equal(lvl('interview', 'Why did you use a hash map instead of an array?'), 'low');
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
    assert.equal(lvl('interview', q), 'low', q);
  }
  assert.equal(lvl('meeting', 'Can you reverse a linked list?'), 'low');
  assert.equal(lvl('presentation', 'Any questions?'), 'low');
  assert.equal(lvl('general', 'What do you think?'), 'low');
  assert.equal(lvl('mystery-mode', 'What do you think?'), 'low');
  assert.equal(ai.resolveThinkingLevel({ mode: 'interview', question: 'Implement LRU cache', quality: 'fast' }), 'low');
  assert.equal(ai.resolveThinkingLevel({ mode: 'general', question: 'hi', quality: 'max' }), 'high');
  assert.equal(ai.resolveThinkingLevel({ mode: 'interview', question: 'hi', quality: 'bogus' }), 'low');
  assert.equal(ai.resolveThinkingLevel({ mode: 'interview', question: 'Tell me about yourself', quality: 'max' }), 'high');
  assert.equal(ai.resolveThinkingLevel({ mode: 'meeting', question: 'Reverse a linked list', hasImages: true, quality: 'auto' }), 'low');
  for (const level of ['minimal', 'medium']) {
    // Auto never picks these any more.
    for (const mode of ['interview', 'meeting', 'presentation', 'general']) {
      for (const question of ['Tell me about yourself', 'Implement LRU cache']) {
        assert.notEqual(lvl(mode, question), level);
      }
    }
  }
});

test('behavioural interview question: low thinking is sent', async () => {
  const calls = mockFetch((call) => sseResponse([textEvent('I led it.', 'STOP')], { signal: call.init.signal }));
  const result = await ai.generateSuggestion({
    transcript: 'Them: Tell me about a time you led a project.',
    mode: 'interview',
    onChunk: () => {},
  });
  assert.equal(result.thinkingLevel, 'low');
  assert.equal(calls[0].body.generationConfig.thinkingConfig.thinkingLevel, 'low');
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
  const prompt = promptText(calls[0]);
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
  const prompt = promptText(calls[0]);
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
  assert.match(system, /ONE sentence per line/);
  assert.match(system, /Answer style: SCRIPT/);
});

test('system prompt: natural voice, banned AI tells, few-shot examples, CV facts only', () => {
  for (const mode of ['interview', 'meeting', 'presentation', 'general']) {
    const system = ai.buildSystemPrompt(mode, 'script');
    assert.match(system, /contractions/i);
    for (const tell of ['Great question', 'Certainly', 'Absolutely', "I'd be happy to", 'leverage', 'delve', 'utilize',
      'passionate about', 'spearheaded', 'synergy', 'robust', 'seamless', 'in summary', 'in conclusion', 'overall', 'Not only X']) {
      assert.ok(system.includes(tell), `${mode}: bans "${tell}"`);
    }
    assert.match(system, /em dash/i);
    assert.equal((system.match(/BEFORE \(stiff AI\)/g) || []).length, 3, 'three BEFORE/AFTER pairs');
    assert.equal((system.match(/AFTER \(spoken\)/g) || []).length, 3);
    assert.match(system, /ONLY as a source of facts/);
    assert.match(system, /Never copy its wording/);
  }
});

// ---- Mode-specific prompts (shared core + one mode block) ----
const MODE_LIST = ['interview', 'meeting', 'presentation', 'general'];
const count = (hay, needle) => hay.split(needle).length - 1;

test('mode prompts: the shared core appears once in every mode, plus that mode\'s block', () => {
  for (const style of ['script', 'cues']) {
    for (const mode of MODE_LIST) {
      const system = ai.buildSystemPrompt(mode, style);
      for (const core of ['TRUTH FIRST (this overrides', 'Sound like a real person talking', `Answer style: ${style.toUpperCase()}`, 'What you are given: the WHOLE conversation', 'One or more attached screen images', 'ONLY as a source of facts']) {
        assert.equal(count(system, core), 1, `${mode}/${style}: "${core}" once`);
      }
      assert.equal(count(system, 'BEFORE (stiff AI)'), 3, `${mode}/${style}: tone examples once`);
      const blocks = { interview: 'Interview rules:', meeting: 'Meeting rules.', presentation: 'Presentation rules:', general: 'Conversation rules:' };
      for (const [m, heading] of Object.entries(blocks)) {
        assert.equal(count(system, heading), m === mode ? 1 : 0, `${mode}/${style}: ${heading}`);
      }
      // New shared voice rules.
      assert.match(system, /Don't reflexively agree with or praise the other person's point/);
      assert.match(system, /Don't start with the other person's name or with "So basically"/);
      for (const tell of ['Great point', "That's a great question", 'I completely agree']) assert.ok(system.includes(tell), `${mode}: bans ${tell}`);
    }
  }
});

test('mode prompts: STAR and the coding walk-through are interview-only', () => {
  for (const style of ['script', 'cues']) {
    const interview = ai.buildSystemPrompt('interview', style);
    assert.match(interview, /STAR/);
    assert.match(interview, /A\) A NEW problem/);
    assert.match(interview, /B\) A FOLLOW-UP/);
    for (const mode of ['meeting', 'presentation', 'general']) {
      const system = ai.buildSystemPrompt(mode, style);
      assert.ok(!/STAR/.test(system), `${mode}/${style}: no STAR`);
      assert.ok(!system.includes('A) A NEW problem'), `${mode}/${style}: no interview coding walk-through`);
      assert.ok(system.includes(ai.NO_RESPONSE_SENTINEL), `${mode}: may decline automatic suggestions`);
    }
    assert.ok(!interview.includes(ai.NO_RESPONSE_SENTINEL), 'interviews never decline');
  }
  const meeting = ai.buildSystemPrompt('meeting', 'script');
  assert.match(meeting, /not answer an exam/);
  assert.match(meeting, /Never automatically defensive, never automatically agreeing/);
  assert.match(meeting, /the best contribution is a good question/);
  assert.match(meeting, /Don't summarise the meeting back/);
  assert.match(ai.buildSystemPrompt('presentation', 'script'), /bridge back to their main point/);
  assert.match(ai.buildSystemPrompt('general', 'script'), /ask a short follow-up question back/);
});

test('mode prompts: fixed per (mode, style); unknown modes are general', () => {
  for (const mode of MODE_LIST) {
    for (const style of ['script', 'cues']) assert.equal(ai.buildSystemPrompt(mode, style), ai.buildSystemPrompt(mode, style));
    assert.notEqual(ai.buildSystemPrompt(mode, 'script'), ai.buildSystemPrompt(mode, 'cues'));
  }
  assert.equal(new Set(MODE_LIST.map((m) => ai.buildSystemPrompt(m, 'script'))).size, 4);
  for (const bad of ['bogus', '__proto__', 'constructor', undefined, '']) {
    assert.equal(ai.buildSystemPrompt(bad, 'script'), ai.buildSystemPrompt('general', 'script'), String(bad));
    assert.equal(ai.normalizeMode(bad), 'general');
  }
  assert.deepEqual([...ai.MODES], MODE_LIST);
});

test('meeting: intent hint + auto no-response allowance go in LATEST; the system prompt stays the same', async () => {
  const calls = mockFetch((call) => sseResponse([textEvent('Fair, but the cost is the real issue.', 'STOP')], { signal: call.init.signal }));
  const transcript = "You: I think we should move to Postgres.\nThem: I don't think that'll work.";
  const auto = await ai.generateSuggestion({ transcript, mode: 'meeting', question: "I don't think that'll work.", requestKind: 'auto', onChunk: () => {} });
  const explicit = await ai.generateSuggestion({ transcript, mode: 'meeting', question: "I don't think that'll work.", onChunk: () => {} });
  assert.equal(auto.intent, 'disagreement');
  assert.equal(explicit.intent, 'disagreement');
  const [a, e] = calls;
  assert.equal(a.body.systemInstruction.parts[0].text, e.body.systemInstruction.parts[0].text, 'same system prompt (prefix caching)');
  assert.equal(a.body.systemInstruction.parts[0].text, ai.buildSystemPrompt('meeting', 'script'));
  const aLatest = a.body.contents[0].parts.at(-1).text;
  const eLatest = e.body.contents[0].parts.at(-1).text;
  assert.match(aLatest, /Intent: disagreement/);
  assert.match(aLatest, /triggered automatically/);
  assert.ok(aLatest.includes(ai.NO_RESPONSE_SENTINEL));
  assert.match(eLatest, /Intent: disagreement/);
  assert.ok(!eLatest.includes(ai.NO_RESPONSE_SENTINEL), 'an explicit request must always answer');
  assert.equal(a.body.generationConfig.thinkingConfig.thinkingLevel, 'low');
  assert.equal(a.body.generationConfig.maxOutputTokens, ai.ANSWER_TOKENS.spoken + ai.THINKING_HEADROOM_TOKENS.low);
  // A renderer-supplied intent wins over re-detection.
  await ai.generateSuggestion({ transcript, mode: 'meeting', question: "I don't think that'll work.", intent: 'proposal', onChunk: () => {} });
  assert.match(calls[2].body.contents[0].parts.at(-1).text, /Intent: a proposal/);
});

test('interview: no intent hint and never the no-response allowance, even for automatic requests', async () => {
  const calls = mockFetch((call) => sseResponse([textEvent('Ok.', 'STOP')], { signal: call.init.signal }));
  await ai.generateSuggestion({ transcript: 'Them: Tell me about a time you failed.', mode: 'interview', question: 'Tell me about a time you failed.', requestKind: 'auto', allowNoResponse: true, onChunk: () => {} });
  const latest = calls[0].body.contents[0].parts.at(-1).text;
  assert.ok(!/Intent:/.test(latest));
  assert.ok(!latest.includes(ai.NO_RESPONSE_SENTINEL));
  const a = ai.analyzeSuggestion({ transcript: 'Them: hi?', mode: 'interview', requestKind: 'auto' });
  assert.equal(a.allowNoResponse, false);
  assert.equal(ai.analyzeSuggestion({ transcript: 'Them: hi?', mode: 'meeting', requestKind: 'auto' }).allowNoResponse, true);
  assert.equal(ai.analyzeSuggestion({ transcript: 'Them: hi?', mode: 'meeting', requestKind: 'explicit' }).allowNoResponse, false);
});

test('analyzeSuggestion: one analysis (kind + intent) per request; bad intents are recomputed', () => {
  const base = { transcript: 'You: We could use Redis.\nThem: The problem with that is we lose the audit trail.', mode: 'meeting' };
  const a = ai.analyzeSuggestion(base);
  assert.equal(a.intent, 'disagreement');
  assert.equal(a.questionKind, 'general');
  assert.equal(a.mode, 'meeting');
  assert.equal(ai.analyzeSuggestion({ ...base, intent: 'proposal' }).intent, 'proposal');
  assert.equal(ai.analyzeSuggestion({ ...base, intent: '__proto__' }).intent, 'disagreement');
  assert.equal(ai.analyzeSuggestion({ ...base, intent: 'nonsense' }).intent, 'disagreement');
  assert.equal(ai.analyzeSuggestion({ ...base, mode: 'weird' }).mode, 'general');
  const tech = ai.analyzeSuggestion({ transcript: 'Them: Write a function to reverse a linked list.', mode: 'interview' });
  assert.equal(tech.questionKind, 'problem');
  assert.equal(tech.intent, 'technical_question');
  assert.ok(ai.INTENTS.includes('disagreement') && ai.INTENTS.length === 13);
});

test('answer style: Cues gets its own prompt variant; unknown styles fall back to Script', async () => {
  const cues = ai.buildSystemPrompt('interview', 'cues');
  assert.match(cues, /Answer style: CUES/);
  assert.match(cues, /3-4 cue lines/);
  assert.match(cues, /Fragments only/);
  assert.ok(!cues.includes('Answer style: SCRIPT'));
  assert.ok(cues.includes('ONE short headline sentence'), 'cues still start with a big first line');
  assert.equal(ai.buildSystemPrompt('interview', 'bogus'), ai.buildSystemPrompt('interview', 'script'));
  assert.equal(ai.buildSystemPrompt('interview'), ai.buildSystemPrompt('interview', 'script'));
  assert.equal(ai.normalizeAnswerStyle('cues'), 'cues');
  assert.equal(ai.normalizeAnswerStyle('__proto__'), 'script');
  assert.ok(ai.ANSWER_STYLES.has('script') && ai.ANSWER_STYLES.has('cues') && ai.ANSWER_STYLES.size === 2);

  const calls = mockFetch((call) => sseResponse([textEvent('Ok.', 'STOP')], { signal: call.init.signal }));
  const result = await ai.generateSuggestion({ transcript: 'Them: hi?', mode: 'interview', answerStyle: 'cues', onChunk: () => {} });
  assert.match(calls[0].body.systemInstruction.parts[0].text, /Answer style: CUES/);
  assert.equal(result.answerStyle, 'cues');
});

test('ask (chat) prompt also bans the AI tells and treats CV files as facts only', async () => {
  const calls = mockFetch((call) => sseResponse([textEvent('Ok.', 'STOP')], { signal: call.init.signal }));
  await ai.askFollowUp({ transcript: 'Them: hi?', question: 'what should I say?', mode: 'interview', onChunk: () => {} });
  const system = calls[0].body.systemInstruction.parts[0].text;
  assert.match(system, /spearheaded/);
  assert.match(system, /em dash/i);
  assert.match(system, /only for facts/);
});

// ---- humanize.js safety net ----
const { humanizeAnswer, createStreamHumanizer } = require('../src/main/humanize');

test('humanize: em dashes become commas (or vanish next to punctuation / line edges), code untouched', () => {
  assert.equal(humanizeAnswer('I led the migration — and it cut costs 30%.'), 'I led the migration, and it cut costs 30%.');
  assert.equal(humanizeAnswer('So the thing is—we shipped it.'), 'So the thing is, we shipped it.');
  assert.equal(humanizeAnswer('It was fast — really fast — and cheap.'), 'It was fast, really fast, and cheap.');
  assert.equal(humanizeAnswer('I did it — .'), 'I did it.');
  assert.equal(humanizeAnswer('Done. — Then we moved on.'), 'Done. Then we moved on.');
  assert.equal(humanizeAnswer('— leading\nline end —\nnext'), 'leading\nline end\nnext');
  assert.equal(humanizeAnswer('this – that'), 'this, that');
  assert.equal(humanizeAnswer('scores of 2 – 3 and 2–3 and 1999–2003'), 'scores of 2 – 3 and 2–3 and 1999–2003');
  const code = 'Like this:\n```js\nconst s = "a — b";\n```\nThat — works.';
  assert.equal(humanizeAnswer(code), 'Like this:\n```js\nconst s = "a — b";\n```\nThat, works.');
});

test('humanize: a stock opener at the start is stripped and the next word capitalised', () => {
  assert.equal(humanizeAnswer('Great question! I led the team.'), 'I led the team.');
  assert.equal(humanizeAnswer('Certainly. so the plan was simple.'), 'So the plan was simple.');
  assert.equal(humanizeAnswer('Absolutely, I think so.'), 'I think so.');
  assert.equal(humanizeAnswer("That's a great question — honestly, it depends."), 'Honestly, it depends.');
  assert.equal(humanizeAnswer('I\u2019d be happy to help! Here it is.'), 'Here it is.');
  assert.equal(humanizeAnswer('Great question! Certainly, yes.'), 'Yes.');
  // Not openers: used inside a real sentence, or not at the start.
  assert.equal(humanizeAnswer('Absolutely no idea, to be honest.'), 'Absolutely no idea, to be honest.');
  assert.equal(humanizeAnswer('Of course.js is not a thing.'), 'Of course.js is not a thing.');
  assert.equal(humanizeAnswer('Yeah, so. Great question!'), 'Yeah, so. Great question!');
  assert.equal(humanizeAnswer('Great question'), 'Great question', 'nothing left to say: keep it');
  assert.equal(humanizeAnswer(''), '');
});

test('humanize stream: every piece is a prefix of the final answer, whatever the chunking', () => {
  const samples = [
    'Great question! I led the migration — and it cut costs 30%. Then — well — it worked.\n\nNext line.',
    'Certainly — so the code is:\n```py\nx = "a — b"\n```\nDone — mostly.',
    'I built it in Go.  It handles 2 – 3k requests a second.',
    'Absolutely no worries.',
  ];
  for (const full of samples) {
    const expected = humanizeAnswer(full.trim());
    for (let size = 1; size <= 13; size++) {
      const filter = createStreamHumanizer();
      let shown = '';
      for (let i = 0; i < full.length; i += size) {
        shown += filter.push(full.slice(i, i + size));
        assert.ok(expected.startsWith(shown), `size ${size}: "${shown}" is a prefix of "${expected}"`);
      }
      shown += filter.end();
      assert.equal(shown, expected, `size ${size}`);
    }
  }
  // The opener is held back until it's decided, then never shown.
  const f = createStreamHumanizer();
  assert.equal(f.push('Great'), '');
  assert.equal(f.push(' question'), '');
  // "I" alone could still become "I'd be happy to help", so it waits a word.
  assert.equal(f.push('! I'), '');
  assert.equal(f.push(' did.'), 'I did.');
  assert.equal(f.push(' Then'), ' Then');
});

test('suggestions arrive humanized, both streamed and final', async () => {
  mockFetch((call) => sseResponse([
    textEvent('Great question! '),
    textEvent('I cut our build time — from 20 minutes'),
    textEvent(' to 6.', 'STOP'),
  ], { signal: call.init.signal }));
  const chunks = [];
  const result = await ai.generateSuggestion({ transcript: 'Them: What are you proud of?', mode: 'interview', onChunk: (t) => chunks.push(t) });
  assert.equal(result.text, 'I cut our build time, from 20 minutes to 6.');
  assert.equal(chunks.join(''), result.text);
  assert.ok(!chunks.join('').includes('Great question'));
});

// ---- New problem vs follow-up (classifyQuestion) ----
const NEW_PROBLEMS = [
  'Can you reverse a linked list in place?',
  'Write a function to check if a string is a palindrome.',
  'Given an array of integers and a target, return the indices of the two numbers that add up to the target.',
  'Implement an LRU cache.',
  'How would you design a URL shortener at scale?',
  'Design a rate limiter for our API.',
  'What is the probability of rolling two sixes with two dice?',
  "What's the expected value of a single die roll?",
  'Here is a brain teaser for you.',
  'In how many ways can you climb a staircase of n steps taking one or two steps at a time?',
  'Okay, next problem: given a binary tree, find its maximum depth.',
  "Let's do a coding question. Merge two sorted linked lists.",
  'So the problem is you have a list of meetings each with a start and end time and you need to figure out the minimum number of rooms required so that no two meetings overlap.',
  'Find the longest substring without repeating characters.',
  'Can you write a SQL query that returns the second highest salary?',
  'Given a string, determine if it is a valid palindrome ignoring punctuation.',
  'Now implement a function that serializes and deserializes a binary tree.',
  'Estimate how many piano tuners there are in Chicago.',
  'I want you to implement a min stack that supports push, pop and get min in constant time.',
  'Given an unsorted array, find the kth largest element.',
];
const FOLLOW_UPS = [
  'What is the time complexity of your approach?',
  "What's the time and space complexity?",
  'Why did you use a hash map instead of an array?',
  'Can you explain why you used recursion here?',
  'How would you test this function?',
  'Any edge cases you would check in your code?',
  'Can you optimize it to O(n)?',
  'Is there a better approach than sorting the array?',
  'Why not use a binary search here?',
  'Walk me through your code line by line.',
  'Does your function handle negative numbers in the array?',
  'What would change if the array was sorted?',
  'So why did you pick a heap for this?',
  'Could you explain what the sliding window is doing in your solution?',
  'What is a hash map?',
  "What's the difference between an array and a linked list?",
  'And what about the space complexity of the recursion stack?',
];
// Plain-word follow-ups: only follow-ups when the last answer was technical.
const PLAIN_FOLLOW_UPS = [
  'What happens if the input is empty?',
  'How would you handle really large inputs that do not fit in memory with your current approach?',
  'Okay, what if we need to return all the pairs instead of just one?',
];
const BEHAVIOURAL = [
  'Tell me about yourself.',
  'Why do you want to work here?',
  'Tell me about a time you disagreed with your manager.',
  'What sort of role are you looking for?',
  'Tell me about a time you had to solve a conflict in your team.',
  'What are your salary expectations?',
  'On a scale of 1 to 10, how would you rate your Python?',
  'What was your biggest challenge in that job from 2020 - 2023?',
  'Why are you job searching right now?',
  'Tell me about a time you had to find the root cause of a problem.',
  "Here's a question for you: what motivates you?",
  'Given the current market, how do you see your career developing?',
  'Tell me about a project where you had to design a new process.',
  'Why did you leave your last job?',
  'What would you do if a teammate missed a deadline?',
  'What is the largest team you have led?',
];

test('classifyQuestion: new problems vs technical follow-ups vs everything else', () => {
  for (const q of NEW_PROBLEMS) assert.equal(ai.classifyQuestion(q), 'problem', q);
  for (const q of FOLLOW_UPS) assert.equal(ai.classifyQuestion(q), 'followup', q);
  for (const q of FOLLOW_UPS) assert.equal(ai.classifyQuestion(q, { hasPriorAnswer: true, priorCode: true }), 'followup', `${q} (after code)`);
  for (const q of BEHAVIOURAL) {
    assert.equal(ai.classifyQuestion(q), 'general', q);
    // ...even straight after a coding answer.
    assert.equal(ai.classifyQuestion(q, { hasPriorAnswer: true, priorCode: true }), 'general', `${q} (after code)`);
  }
  for (const q of PLAIN_FOLLOW_UPS) {
    assert.equal(ai.classifyQuestion(q), 'general', `${q} (nothing to follow up on)`);
    assert.equal(ai.classifyQuestion(q, { hasPriorAnswer: true, priorCode: true }), 'followup', `${q} (after code)`);
  }
  // Long technical prompts read as problem statements.
  assert.equal(ai.classifyQuestion('Okay so here we have an array of stock prices and on each day you can either buy or sell one share but you can only hold one share at a time and there is a cooldown of one day after you sell, maximise the profit you can make over all the days in the array'), 'problem');
  assert.equal(ai.classifyQuestion(''), 'general');
});

test('classifyQuestion: screenshots mean a new problem unless it is a short follow-up to an earlier answer', () => {
  assert.equal(ai.classifyQuestion('Walk me through it.', { hasImages: true }), 'problem');
  assert.equal(ai.classifyQuestion('', { hasImages: true }), 'problem');
  assert.equal(ai.classifyQuestion('Tell me about yourself.', { hasImages: true }), 'problem');
  assert.equal(ai.classifyQuestion('Why did you use a hash map?', { hasImages: true }), 'problem', 'no earlier answer: the screenshot is the problem');
  assert.equal(ai.classifyQuestion('Why did you use a hash map?', { hasImages: true, hasPriorAnswer: true }), 'followup');
  assert.equal(ai.classifyQuestion("What's the complexity of this?", { hasImages: true, hasPriorAnswer: true }), 'followup');
  assert.equal(ai.classifyQuestion('Now solve this one.', { hasImages: true, hasPriorAnswer: true }), 'problem');
});

test('priorContext: knows when the last answers were technical', () => {
  assert.deepEqual(ai.priorContext(undefined), { hasPriorAnswer: false, priorCode: false });
  assert.deepEqual(ai.priorContext([{ question: 'Tell me about yourself', text: 'I build things.' }]), { hasPriorAnswer: true, priorCode: false });
  assert.deepEqual(ai.priorContext([{ question: 'q', text: 'Use a map.\n```py\nx = {}\n```' }]), { hasPriorAnswer: true, priorCode: true });
  assert.deepEqual(ai.priorContext([{ question: 'Reverse a linked list', text: 'Use two pointers.' }]), { hasPriorAnswer: true, priorCode: true });
});

test('thinking level: interview problems high, follow-ups and behavioural low, overrides still win', () => {
  const lvl = (question, extra = {}) => ai.resolveThinkingLevel({ mode: 'interview', question, quality: 'auto', ...extra });
  for (const q of NEW_PROBLEMS) assert.equal(lvl(q), 'high', q);
  for (const q of [...FOLLOW_UPS, ...BEHAVIOURAL]) assert.equal(lvl(q), 'low', q);
  for (const q of FOLLOW_UPS) assert.equal(lvl(q, { quality: 'max' }), 'high', `Max: ${q}`);
  for (const q of NEW_PROBLEMS) assert.equal(lvl(q, { quality: 'fast' }), 'low', `Fast: ${q}`);
  assert.equal(ai.resolveThinkingLevel({ mode: 'interview', quality: 'auto', kind: 'problem' }), 'high');
  assert.equal(ai.resolveThinkingLevel({ mode: 'interview', quality: 'auto', kind: 'followup' }), 'low');
});

test('output budgets: follow-ups short, problems roomy, thinking headroom never starves the answer', () => {
  assert.equal(ai.answerTokensFor('general'), ai.ANSWER_TOKENS.spoken);
  assert.equal(ai.answerTokensFor('followup'), ai.ANSWER_TOKENS.followUp);
  assert.equal(ai.answerTokensFor('problem'), ai.ANSWER_TOKENS.technical);
  assert.equal(ai.answerTokensFor('general', 'Make this shorter'), ai.ANSWER_TOKENS.detailed);
  assert.equal(ai.answerTokensFor('general', 'Rewrite:\n```js\nx\n```'), ai.ANSWER_TOKENS.technical);
  assert.ok(ai.ANSWER_TOKENS.followUp > ai.ANSWER_TOKENS.spoken && ai.ANSWER_TOKENS.followUp < ai.ANSWER_TOKENS.technical);
  const H = ai.THINKING_HEADROOM_TOKENS;
  assert.ok(H.low >= ai.ANSWER_TOKENS.followUp * 2, 'low thinking has room to think about code');
  assert.ok(H.high >= 8192, 'high thinking keeps generous headroom');
  assert.ok(H.minimal < H.low && H.low < H.medium && H.medium < H.high);
});

test('technical follow-up: low thinking, short budget and a "keep it short" hint in LATEST', async () => {
  const calls = mockFetch((call) => sseResponse([textEvent('Because lookups are O(1).', 'STOP')], { signal: call.init.signal }));
  const result = await ai.generateSuggestion({
    transcript: 'Them: Reverse a linked list.\nYou: Sure, I used two pointers.\nThem: What is the time complexity of your approach?',
    mode: 'interview',
    question: 'What is the time complexity of your approach?',
    previousAnswers: [{ kind: 'suggestion', question: 'Reverse a linked list.', text: 'Two pointers.\n```py\ndef rev(h): ...\n```' }],
    onChunk: () => {},
  });
  assert.equal(result.thinkingLevel, 'low');
  assert.equal(result.questionKind, 'followup');
  const gc = calls[0].body.generationConfig;
  assert.equal(gc.thinkingConfig.thinkingLevel, 'low');
  assert.equal(gc.maxOutputTokens, ai.ANSWER_TOKENS.followUp + ai.THINKING_HEADROOM_TOKENS.low);
  const latest = calls[0].body.contents[0].parts.at(-1).text;
  assert.match(latest, /^=== LATEST ===/);
  assert.match(latest, /FOLLOW-UP/);
  assert.match(latest, /No numbered walk-through and no full code again/);
  // The system prompt explains both formats but is the same for every question.
  const system = calls[0].body.systemInstruction.parts[0].text;
  assert.match(system, /A\) A NEW problem/);
  assert.match(system, /B\) A FOLLOW-UP/);
  assert.equal(system, ai.buildSystemPrompt('interview', 'script'));
});

test('new problem: high thinking, technical budget and the full-format hint', async () => {
  const calls = mockFetch((call) => sseResponse([textEvent('Use two pointers.', 'STOP')], { signal: call.init.signal }));
  const result = await ai.generateSuggestion({
    transcript: 'Them: Given an array of integers, return the indices of two numbers that add up to a target.',
    mode: 'interview',
    question: 'Given an array of integers, return the indices of two numbers that add up to a target.',
    onChunk: () => {},
  });
  assert.equal(result.questionKind, 'problem');
  const gc = calls[0].body.generationConfig;
  assert.equal(gc.thinkingConfig.thinkingLevel, 'high');
  assert.equal(gc.maxOutputTokens, ai.ANSWER_TOKENS.technical + ai.THINKING_HEADROOM_TOKENS.high);
  assert.match(calls[0].body.contents[0].parts.at(-1).text, /a NEW problem to solve/);
});

// ---- Prompt layout (caching + "the question is never buried") ----
test('layout: transcript -> earlier answers -> background -> screenshots -> LATEST last, after the images', async () => {
  const calls = mockFetch((call) => sseResponse([textEvent('Ok.', 'STOP')], { signal: call.init.signal }));
  await ai.generateSuggestion({
    transcript: 'You: hello\nThem: What does this code do?',
    mode: 'interview',
    question: 'What does this code do?',
    previousAnswers: [{ kind: 'suggestion', question: 'hi', text: 'EARLIER-ANSWER' }],
    knowledgeSnippets: [{ source: 'cv.md', text: 'KNOWLEDGE-SNIPPET' }],
    images: [{ mimeType: 'image/jpeg', base64: 'AAAA', name: 'VS Code' }, { mimeType: 'image/jpeg', base64: 'BBBB', name: 'Chrome' }],
    onChunk: () => {},
  });
  const parts = calls[0].body.contents[0].parts;
  assert.equal(parts.length, 4, 'context text, 2 images, LATEST text');
  assert.equal(parts[1].inline_data.data, 'AAAA');
  assert.equal(parts[2].inline_data.data, 'BBBB');
  const context = parts[0].text;
  const order = ['FULL CONVERSATION SO FAR', 'You: hello', 'EARLIER-ANSWER', 'KNOWLEDGE-SNIPPET', '2 screenshots are attached right below'];
  const idx = order.map((s) => context.indexOf(s));
  assert.ok(idx.every((i) => i >= 0), JSON.stringify(idx));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'blocks in cache-friendly order');
  assert.ok(!context.includes('=== LATEST ==='));
  assert.match(parts[3].text, /^=== LATEST ===/);
  assert.ok(parts[3].text.includes('What does this code do?'));
});

test('layout: consecutive requests share the whole earlier transcript as a prefix (implicit caching)', () => {
  const t1 = Array.from({ length: 200 }, (_, i) => `${i % 2 ? 'Them' : 'You'}: line ${i}`).join('\n');
  const first = ai.buildConversationText({
    transcript: t1,
    previousAnswers: [{ kind: 'suggestion', question: 'q1', text: 'answer one' }],
    knowledgeSnippets: [{ source: 'cv.md', text: 'snippet matched by question one' }],
    question: 'question one?',
  });
  const second = ai.buildConversationText({
    transcript: `${t1}\nYou: my reply\nThem: question two?`,
    previousAnswers: [{ kind: 'suggestion', question: 'q1', text: 'answer one' }, { kind: 'suggestion', question: 'q2', text: 'answer two' }],
    knowledgeSnippets: [{ source: 'notes.md', text: 'a different snippet for question two' }],
    question: 'question two?',
  });
  let shared = 0;
  while (shared < first.length && first[shared] === second[shared]) shared++;
  assert.ok(shared >= first.indexOf(t1) + t1.length, `shared prefix (${shared} chars) covers the whole old transcript`);
});
