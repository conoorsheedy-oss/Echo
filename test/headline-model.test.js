// Tests for the instant first line's model choice (src/main/ai.js):
// GEMINI_HEADLINE_MODEL, the one-off Flash-Lite lookup from Gemini's models
// list, and the fallbacks (none found, lookup failed, 404, thinking refused).
// fetch() is mocked -- no network, no real API key.
// Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/electron-stub');
delete process.env.GEMINI_MODEL;
delete process.env.GEMINI_HEADLINE_MODEL;
const keyStore = require('../src/main/keyStore');
const KEY = 'test-gemini-key';
keyStore.getKey = (provider) => (provider === 'gemini' ? KEY : '');
const ai = require('../src/main/ai');

const MAIN = 'gemini-3.5-flash';
const realFetch = global.fetch;
const realNow = Date.now;

test.beforeEach(() => {
  delete process.env.GEMINI_HEADLINE_MODEL;
  ai._resetHeadlineModel();
  ai._resetSessionState();
});
test.afterEach(() => {
  global.fetch = realFetch;
  Date.now = realNow;
  delete process.env.GEMINI_HEADLINE_MODEL;
});

const model = (name, methods = ['generateContent', 'countTokens']) => ({ name: `models/${name}`, supportedGenerationMethods: methods });

function sse(text) {
  const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] })}\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
const isList = (url) => /\/v1beta\/models\?/.test(url);
const modelOf = (url) => (/\/models\/([^:?]+):/.exec(url) || [])[1];

// Records every call; handler(call) -> Response.
function mockFetch(handler) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const call = { url: String(url), init, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    return handler(call);
  };
  return calls;
}
const generateCalls = (calls) => calls.filter((c) => !isList(c.url));

const params = (extra = {}) => ({ transcript: 'Them: How would you find duplicates in an array?', mode: 'interview', onChunk: () => {}, ...extra });

// ---- pickHeadlineModel ----
test('picks the newest stable Flash-Lite that supports generateContent', () => {
  const models = [
    model('gemini-2.0-flash-lite'),
    model('gemini-2.5-flash-lite'),
    model('gemini-3-flash-lite'),
    model('gemini-3.1-flash-lite'),
    model('gemini-3.5-flash'), // not lite
    model('gemini-9-flash-lite-preview'), // preview
    model('gemini-9-flash-lite-preview-06-17'),
    model('gemini-9-flash-lite-exp'),
    model('gemini-9-flash-lite-001'), // dated / pinned
    model('gemini-9.0-flash-lite', ['embedContent']), // no generateContent
    model('gemini-embedding-001', ['embedContent']),
    { name: 'models/gemini-9.5-flash-lite' }, // no methods listed
    { displayName: 'junk' },
    null,
  ];
  assert.equal(ai.pickHeadlineModel(models), 'gemini-3.1-flash-lite');
  // Numeric, not string, comparison: 10 > 3.5 > 3 > 2.5.
  assert.equal(ai.pickHeadlineModel([model('gemini-3.5-flash-lite'), model('gemini-10-flash-lite'), model('gemini-3-flash-lite')]), 'gemini-10-flash-lite');
  assert.equal(ai.pickHeadlineModel([model('gemini-2.5-flash-lite'), model('gemini-3-flash-lite')]), 'gemini-3-flash-lite');
});

test('no stable Flash-Lite -> null', () => {
  assert.equal(ai.pickHeadlineModel([]), null);
  assert.equal(ai.pickHeadlineModel(undefined), null);
  assert.equal(ai.pickHeadlineModel([model('gemini-3.5-flash'), model('gemini-3-flash-lite-preview')]), null);
});

// ---- lookup + use ----
test('lookup pages through the list (key in a header, never the URL); the first headline does not wait for it', async () => {
  const calls = mockFetch((c) => {
    if (isList(c.url)) {
      const token = new URL(c.url).searchParams.get('pageToken');
      return token === 'p2'
        ? json({ models: [model('gemini-3.1-flash-lite'), model('gemini-3.5-flash')] })
        : json({ models: [model('gemini-2.5-flash-lite'), model('gemini-3-flash-lite-preview')], nextPageToken: 'p2' });
    }
    return sse("I'd use a hash set.");
  });
  assert.equal(ai.headlineModel({ discover: false }), MAIN, 'nothing known yet');

  const first = await ai.generateHeadline(params());
  assert.equal(first.text, "I'd use a hash set.");
  await ai.discoverHeadlineModel();
  const lists = calls.filter((c) => isList(c.url));
  assert.equal(lists.length, 2);
  assert.equal(new URL(lists[1].url).searchParams.get('pageToken'), 'p2');
  for (const c of lists) {
    assert.ok(!c.url.includes(KEY), 'key never in the URL');
    assert.equal(c.init.headers['x-goog-api-key'], KEY);
  }
  assert.equal(modelOf(generateCalls(calls)[0].url), MAIN, 'lookup not finished: the first headline used the main model');

  await ai.generateHeadline(params());
  assert.equal(modelOf(generateCalls(calls)[1].url), 'gemini-3.1-flash-lite');
  assert.equal(ai.headlineModel({ discover: false }), 'gemini-3.1-flash-lite');

  // Full answers stay on GEMINI_MODEL.
  await ai.generateSuggestion(params());
  assert.equal(modelOf(generateCalls(calls)[2].url), MAIN);
  // One lookup per run.
  await ai.generateHeadline(params());
  assert.equal(calls.filter((c) => isList(c.url)).length, 2);
});

test('the headline sends the same prompt, context, intent and kind on either model', async () => {
  const calls = mockFetch((c) => (isList(c.url) ? json({ models: [model('gemini-3.1-flash-lite')] }) : sse('Sure.')));
  const p = params({ question: 'Walk me through your approach.', mode: 'meeting', intent: 'clarification', previousAnswers: [{ question: 'q', text: 'a' }] });
  await ai.generateHeadline(p);
  await ai.discoverHeadlineModel();
  await ai.generateHeadline(p);
  const [onMain, onLite] = generateCalls(calls);
  assert.equal(modelOf(onMain.url), MAIN);
  assert.equal(modelOf(onLite.url), 'gemini-3.1-flash-lite');
  assert.deepEqual(onLite.body, onMain.body);
});

test('GEMINI_HEADLINE_MODEL wins: no lookup at all', async () => {
  process.env.GEMINI_HEADLINE_MODEL = 'models/gemini-custom-lite';
  const calls = mockFetch(() => sse('Okay.'));
  await ai.generateHeadline(params());
  await ai.generateSuggestion(params());
  assert.equal(calls.filter((c) => isList(c.url)).length, 0);
  assert.equal(modelOf(calls[0].url), 'gemini-custom-lite');
  assert.equal(modelOf(calls[1].url), MAIN);
  assert.equal(ai.headlineModel({ discover: false }), 'gemini-custom-lite');
  // An unusable value falls back to the main model instead of breaking the line.
  process.env.GEMINI_HEADLINE_MODEL = 'gemini/../x';
  assert.equal(ai.headlineModel({ discover: false }), MAIN);
});

test('no stable Flash-Lite in the list -> the first line stays on the main model', async () => {
  const calls = mockFetch((c) => (isList(c.url) ? json({ models: [model('gemini-3.5-flash'), model('gemini-3-flash-lite-preview')] }) : sse('Okay.')));
  await ai.generateHeadline(params());
  await ai.discoverHeadlineModel();
  await ai.generateHeadline(params());
  assert.deepEqual(generateCalls(calls).map((c) => modelOf(c.url)), [MAIN, MAIN]);
});

test('a failed lookup is silent, uses the main model, and is retried only after ~10 minutes', async () => {
  let t = 1_000_000;
  Date.now = () => t;
  let listOk = false;
  const calls = mockFetch((c) => {
    if (isList(c.url)) return listOk ? json({ models: [model('gemini-3.1-flash-lite')] }) : json({ error: { code: 503, status: 'UNAVAILABLE' } }, 503);
    return sse('Okay.');
  });
  await ai.generateHeadline(params());
  await ai.discoverHeadlineModel();
  await ai.generateHeadline(params());
  assert.equal(calls.filter((c) => isList(c.url)).length, 1, 'not retried straight away');
  assert.deepEqual(generateCalls(calls).map((c) => modelOf(c.url)), [MAIN, MAIN]);

  listOk = true;
  t += 10 * 60_000;
  await ai.generateHeadline(params());
  await ai.discoverHeadlineModel();
  await ai.generateHeadline(params());
  assert.equal(calls.filter((c) => isList(c.url)).length, 2);
  assert.equal(modelOf(generateCalls(calls).at(-1).url), 'gemini-3.1-flash-lite');
});

test('a lookup that hangs never delays the first line', async () => {
  const calls = mockFetch((c) => (isList(c.url) ? new Promise(() => {}) : sse('Right away.')));
  const out = await ai.generateHeadline(params());
  assert.equal(out.text, 'Right away.');
  assert.equal(modelOf(generateCalls(calls)[0].url), MAIN);
});

// ---- fallbacks on the first-line model ----
test('a 404 on the first-line model falls back to the main model and skips it for the run', async () => {
  const calls = mockFetch((c) => {
    if (isList(c.url)) return json({ models: [model('gemini-3.1-flash-lite')] });
    if (modelOf(c.url) === 'gemini-3.1-flash-lite') {
      return json({ error: { code: 404, status: 'NOT_FOUND', message: 'models/gemini-3.1-flash-lite is not found for API version v1beta' } }, 404);
    }
    return sse('Fallback line.');
  });
  await ai.generateHeadline(params());
  await ai.discoverHeadlineModel();
  const out = await ai.generateHeadline(params());
  assert.equal(out.text, 'Fallback line.');
  assert.deepEqual(generateCalls(calls).map((c) => modelOf(c.url)), [MAIN, 'gemini-3.1-flash-lite', MAIN]);
  await ai.generateHeadline(params());
  assert.equal(modelOf(generateCalls(calls).at(-1).url), MAIN, 'not tried again');
  assert.equal(ai.headlineModel({ discover: false }), MAIN);
});

test('same for a GEMINI_HEADLINE_MODEL the key cannot use', async () => {
  process.env.GEMINI_HEADLINE_MODEL = 'gemini-typo-lite';
  const calls = mockFetch((c) => (modelOf(c.url) === 'gemini-typo-lite' ? json({ error: { code: 404, status: 'NOT_FOUND' } }, 404) : sse('Okay.')));
  const out = await ai.generateHeadline(params());
  assert.equal(out.text, 'Okay.');
  assert.deepEqual(calls.map((c) => modelOf(c.url)), ['gemini-typo-lite', MAIN]);
});

test('other errors on the first-line model are not retried on the main model', async () => {
  process.env.GEMINI_HEADLINE_MODEL = 'gemini-3.1-flash-lite';
  const calls = mockFetch(() => json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, 429));
  await assert.rejects(ai.generateHeadline(params()), (err) => err.code === 'RATE_LIMIT');
  assert.equal(calls.length, 1);
});

test('a first-line model that refuses "minimal" and then thinking at all: low, then none; the answer model is unaffected', async () => {
  process.env.GEMINI_HEADLINE_MODEL = 'gemini-3.1-flash-lite';
  const calls = mockFetch((c) => {
    const thinking = c.body.generationConfig.thinkingConfig;
    if (modelOf(c.url) === 'gemini-3.1-flash-lite' && thinking) {
      return json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: `Thinking level ${thinking.thinkingLevel} is not supported for this model.` } }, 400);
    }
    return sse('Okay.');
  });
  const out = await ai.generateHeadline(params());
  assert.equal(out.text, 'Okay.');
  const levels = calls.map((c) => (c.body.generationConfig.thinkingConfig || {}).thinkingLevel || 'none');
  assert.deepEqual(levels, ['minimal', 'low', 'none']);

  // Remembered for that model only.
  await ai.generateHeadline(params());
  assert.equal(calls[3].body.generationConfig.thinkingConfig, undefined);
  await ai.generateSuggestion(params({ transcript: 'Them: Write a function to reverse a linked list.' }));
  assert.equal(modelOf(calls[4].url), MAIN);
  assert.equal(calls[4].body.generationConfig.thinkingConfig.thinkingLevel, 'high');
});
