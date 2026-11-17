// Tests for the interview brief (src/main/interview-brief.js, brief-store.js)
// and how ai.js uses it: all fields optional, Interview mode only, an empty
// brief changes nothing, company facts never invented, notes labelled
// [From brief], coding rounds think harder on follow-ups.
// fetch() mocked: no network, no real API key. Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const electronStub = require('./helpers/electron-stub');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-brief-test-'));
electronStub.app.getPath = () => userData;
delete process.env.GEMINI_MODEL;
delete process.env.GEMINI_HEADLINE_MODEL;
const keyStore = require('../src/main/keyStore');
keyStore.getKey = (provider) => (provider === 'gemini' ? 'test-gemini-key' : '');
const ai = require('../src/main/ai');
const B = require('../src/main/interview-brief');
const { createBriefStore } = require('../src/main/brief-store');
const { runSuggestion } = require('../src/main/suggest-pipeline');
const { cases: promptCases } = require('./fixtures/prompt-cases');

ai._resetHeadlineModel({ status: 'done', model: null });
const realFetch = global.fetch;
test.afterEach(() => {
  global.fetch = realFetch;
  ai._resetSessionState();
});

const LONG_AD = [
  'Software Engineer Intern, Payments Platform.',
  'We are looking for an intern to join the payments platform team.',
  'Requirements: Python or Go, REST APIs, SQL, testing.',
  'Nice to have: distributed systems, Kafka, Kubernetes.',
  'You care about reliability and writing clear code.',
].join('\n') + '\n' + 'More about the team and the day to day work. '.repeat(30);

function textEvent(text, finishReason) {
  const c = { content: { parts: [{ text }] } };
  if (finishReason) c.finishReason = finishReason;
  return `data: ${JSON.stringify({ candidates: [c] })}\n\n`;
}
function captureFetch(reply = 'Sure, it is linear time.') {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), raw: init.body });
    if (/:generateContent/.test(String(url))) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: reply }] }, finishReason: 'STOP' }] }), { status: 200 });
    }
    return new Response(textEvent(reply, 'STOP'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return calls;
}
const isHeadline = (body) => body.generationConfig.thinkingConfig && body.generationConfig.thinkingConfig.thinkingLevel === 'minimal';
const firstText = (body) => body.contents[0].parts[0].text;
const settle = () => new Promise((r) => setTimeout(r, 10));
const planOf = (brief, summary) => (B.isEmptyBrief(brief) ? null : {
  block: B.buildBriefBlock(brief, summary),
  headlineBlock: B.buildHeadlineBriefBlock(brief, summary),
  type: B.normalizeBrief(brief).type,
});

async function suggest(params) {
  const calls = captureFetch();
  await runSuggestion({ ai, params, emit: () => {}, headline: true, log: { warn() {} } });
  await settle();
  ai._resetSessionState();
  return calls;
}

// ---- 1. the brief itself ----

test('normalizeBrief: every field optional, capped, unknown type -> auto', () => {
  assert.deepEqual(B.normalizeBrief(undefined), { companyRole: '', jobAd: '', type: 'auto', notes: '' });
  assert.deepEqual(B.normalizeBrief({ type: 'nonsense', companyRole: 42 }), { companyRole: '', jobAd: '', type: 'auto', notes: '' });
  const b = B.normalizeBrief({ companyRole: ' Stripe,\nSWE intern ', jobAd: 'x'.repeat(20000), notes: 'n'.repeat(5000), type: 'coding' });
  assert.equal(b.companyRole, 'Stripe, SWE intern');
  assert.equal(b.jobAd.length, B.LIMITS.jobAd);
  assert.equal(b.notes.length, B.LIMITS.notes);
  assert.equal(b.type, 'coding');
  assert.ok(B.isEmptyBrief({}));
  assert.ok(B.isEmptyBrief({ type: 'auto', companyRole: '   ' }));
  assert.ok(!B.isEmptyBrief({ type: 'hr_screen' }));
});

test('an empty brief gives no block at all', () => {
  assert.equal(B.buildBriefBlock({}), '');
  assert.equal(B.buildHeadlineBriefBlock({}), '');
  assert.equal(B.describeBrief({}), '');
});

test('each field on its own adds only what it needs', () => {
  const role = B.buildBriefBlock({ companyRole: 'Stripe, SWE intern' });
  assert.match(role, /^INTERVIEW BRIEF/);
  assert.match(role, /Company and role: Stripe, SWE intern/);
  assert.match(role, /Facts about the company .* only if they are written in this brief; otherwise use a short \[placeholder\]/);
  assert.ok(!/skill or tool from the ad/.test(role), 'no ad, no ad-skill rule');
  assert.ok(!/Interview type/.test(role));

  const type = B.buildBriefBlock({ type: 'coding' });
  assert.match(type, /Interview type: Coding/);
  assert.match(type, /A coding round: think out loud/);
  assert.ok(!/Facts about the company/.test(type), 'no company, no company rule');

  const ad = B.buildBriefBlock({ jobAd: 'Requirements: Python, SQL.' });
  assert.match(ad, /Job ad \(as the user pasted it\):\nRequirements: Python, SQL\./);
  assert.match(ad, /isn't in the user's facts: be honest.*Never claim it/);

  const notes = B.buildBriefBlock({ notes: 'Notice period: 2 weeks\n\nThey use Go' });
  assert.match(notes, /\[From brief\] Notice period: 2 weeks\n\[From brief\] They use Go/);
  assert.match(notes, /their own facts, as reliable as \[You said\]/);
  assert.ok(!/How to use the brief/.test(notes), 'notes alone need no extra rules');
});

test('HR screen: money and notice questions only from the notes', () => {
  const block = B.buildBriefBlock({ type: 'hr_screen' });
  assert.match(block, /Salary, notice period.*only from the \[From brief\] notes/);
});

test('long job ad: start of the ad until the summary is ready; a summary only counts for its own ad', () => {
  const brief = { jobAd: LONG_AD };
  assert.ok(B.needsAdSummary(brief));
  const raw = B.adForPrompt(brief, null);
  assert.equal(raw.source, 'raw');
  assert.ok(raw.text.length <= B.AD_RAW_CHARS + 2, `raw ${raw.text.length}`);
  assert.match(B.buildBriefBlock(brief), /Job ad \(the start of the ad the user pasted\):/);

  const summary = { text: 'Role: SWE intern, payments platform\nMust-haves: Python or Go, REST, SQL', forAd: B.adHash(B.normalizeBrief(brief).jobAd) };
  const withSummary = B.buildBriefBlock(brief, summary);
  assert.match(withSummary, /Job ad \(summary of the ad the user pasted\):\nRole: SWE intern/);
  assert.equal(B.adForPrompt({ jobAd: `${LONG_AD} changed` }, summary).source, 'raw', 'stale summary ignored');
  assert.ok(!B.needsAdSummary({ jobAd: 'short ad' }));
});

test('size caps: full block and first-line block', () => {
  const big = { companyRole: 'c'.repeat(300), jobAd: LONG_AD, notes: 'note line\n'.repeat(400), type: 'hr_screen' };
  assert.ok(B.buildBriefBlock(big).length <= B.BRIEF_BLOCK_MAX_CHARS);
  const head = B.buildHeadlineBriefBlock(big);
  assert.ok(head.length <= B.HEADLINE_BRIEF_MAX_CHARS, `headline ${head.length}`);
  assert.match(head, /company facts only from here, never invented/);
});

test('keywords come from the role and the ad, not filler words', () => {
  const kw = B.keywordsFor({ companyRole: 'Stripe, backend intern', jobAd: 'Requirements: Python, Django, SQL. Python experience with REST APIs. Nice to have: Kafka.' });
  for (const w of ['python', 'django', 'sql', 'kafka', 'stripe']) assert.ok(kw.includes(w), `${w} in ${kw}`);
  assert.equal(kw[0], 'python', 'most frequent first');
  for (const w of ['requirements', 'nice', 'experience', 'with']) assert.ok(!kw.includes(w), `${w} dropped`);
});

test('best-fit CV snippet: behavioural questions only, adds one, never replaces', () => {
  const own = [{ source: 'cv.md', index: 0, text: 'a' }];
  const found = [{ source: 'cv.md', index: 0, text: 'a' }, { source: 'projects.md', index: 2, text: 'payments in Go' }];
  const search = () => found;
  const behavioural = { intent: 'behavioural_question', questionKind: 'general' };
  const r = B.pickFitSnippet({ snippets: own, keywords: ['go'], analysis: behavioural, prefer: [], search });
  assert.equal(r.fit, 'projects.md');
  assert.deepEqual(r.snippets.map((s) => `${s.source}#${s.index}`), ['cv.md#0', 'projects.md#2']);
  assert.equal(B.pickFitSnippet({ snippets: own, keywords: ['go'], analysis: { intent: 'technical_question', questionKind: 'problem' }, search }).fit, '');
  assert.equal(B.pickFitSnippet({ snippets: own, keywords: ['go'], analysis: behavioural, prefer: [{ source: 'cv.md', index: 0 }], search }).fit, '', 'thread follow-up keeps its snippets');
  assert.equal(B.pickFitSnippet({ snippets: own, keywords: [], analysis: behavioural, search }).fit, '');
  assert.equal(B.pickFitSnippet({ snippets: own, keywords: ['go'], analysis: behavioural, search: () => [own[0]] }).fit, '', 'nothing new');
});

test('thinking level: coding / system design follow-ups get medium (Auto only)', () => {
  assert.equal(B.adjustThinkingLevel('low', { type: 'coding', kind: 'followup', quality: 'auto' }), 'medium');
  assert.equal(B.adjustThinkingLevel('low', { type: 'system_design', kind: 'followup' }), 'medium');
  assert.equal(B.adjustThinkingLevel('high', { type: 'coding', kind: 'problem' }), 'high');
  assert.equal(B.adjustThinkingLevel('low', { type: 'coding', kind: 'general' }), 'low');
  assert.equal(B.adjustThinkingLevel('low', { type: 'behavioural', kind: 'followup' }), 'low');
  assert.equal(B.adjustThinkingLevel('low', { type: 'coding', kind: 'followup', quality: 'fast' }), 'low');
});

test('diagnostics line', () => {
  assert.equal(B.describeBrief({ companyRole: 'x', type: 'coding' }), 'Brief: role ✓ · type Coding');
  assert.match(B.describeBrief({ jobAd: LONG_AD }, null, 'pending'), /ad ✓ \(raw start \d+ chars, summary pending\)/);
  assert.equal(B.describeBrief({ type: 'behavioural' }), 'Brief: type only · type Behavioural');
});

// ---- 2. in the Gemini requests ----

test('no brief (or an empty one): interview requests are exactly as before', async () => {
  for (const c of promptCases().filter((x) => x.mode === 'interview')) {
    const plain = await suggest(c.params);
    const withEmpty = await suggest({ ...c.params, brief: { block: '', headlineBlock: '', type: 'auto' } });
    assert.deepEqual(withEmpty.map((x) => x.raw).sort(), plain.map((x) => x.raw).sort(), c.id);
  }
});

test('other modes never get the brief: byte-identical to the recorded bodies', async () => {
  const snapshots = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'prompt-snapshots-2a.json'), 'utf8'));
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const brief = planOf({ companyRole: 'Stripe, SWE intern', type: 'coding', notes: 'Notice: 2 weeks' });
  let checked = 0;
  for (const c of promptCases().filter((x) => x.mode !== 'interview')) {
    const calls = await suggest({ ...c.params, brief });
    for (const call of calls) {
      assert.equal(sha(call.raw), snapshots[c.id][isHeadline(call.body) ? 'headline' : 'answer'].body, c.id);
      checked += 1;
    }
  }
  assert.ok(checked >= 36);
});

test('interview: the brief opens the user message of both the full answer and the first line', async () => {
  const brief = planOf({ companyRole: 'Stripe, SWE intern', jobAd: 'Requirements: Python, SQL.', type: 'behavioural', notes: 'Notice period: 2 weeks' });
  const calls = await suggest({ transcript: 'Them: Why do you want to work here?', question: 'Why do you want to work here?', mode: 'interview', brief });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const text = firstText(call.body);
    assert.ok(text.startsWith('INTERVIEW BRIEF'), text.slice(0, 40));
    assert.ok(text.indexOf('INTERVIEW BRIEF') < text.indexOf('CONVERSATION'), 'before the transcript');
    assert.match(text, /Stripe, SWE intern/);
    assert.match(text, /\[From brief\] Notice period: 2 weeks/);
  }
  const head = calls.find((c) => isHeadline(c.body));
  assert.ok(firstText(head.body).startsWith(brief.headlineBlock));
  const full = calls.find((c) => !isHeadline(c.body));
  assert.ok(firstText(full.body).startsWith(brief.block));
  // System prompts unchanged by the brief (prefix caching per mode/style).
  const plain = await suggest({ transcript: 'Them: Why do you want to work here?', question: 'Why do you want to work here?', mode: 'interview' });
  const sys = (cs, h) => cs.find((c) => isHeadline(c.body) === h).body.systemInstruction.parts[0].text;
  assert.equal(sys(calls, false), sys(plain, false));
  assert.equal(sys(calls, true), sys(plain, true));
});

test('interview: the same brief text on every request (cache-friendly prefix)', async () => {
  const brief = planOf({ companyRole: 'Stripe', type: 'coding' });
  const a = await suggest({ transcript: 'Them: Two sum, given an array return indices.', question: 'Given an array of integers, return indices of two numbers that add to target.', mode: 'interview', brief });
  const b = await suggest({ transcript: 'Them: Two sum, given an array return indices.\nYou: hash map\nThem: Why a hash map?', question: 'Why a hash map?', mode: 'interview', brief, previousAnswers: [{ kind: 'suggestion', question: 'Two sum', text: 'Use a hash map.\n```py\nseen = {}\n```' }] });
  const full = (cs) => firstText(cs.find((c) => !isHeadline(c.body)).body);
  assert.equal(full(a).slice(0, brief.block.length), full(b).slice(0, brief.block.length));
});

test('coding round: a technical follow-up thinks at medium; without the brief it stays low', async () => {
  const params = {
    transcript: "Them: Given an array of integers, return indices of two numbers that add to target.\nYou: hash map\nThem: What's the time complexity?",
    question: "What's the time complexity?",
    mode: 'interview',
    previousAnswers: [{ kind: 'suggestion', question: 'Two sum', text: 'Use a hash map.\n```py\nseen = {}\n```' }],
  };
  const level = (cs) => cs.find((c) => !isHeadline(c.body)).body.generationConfig.thinkingConfig.thinkingLevel;
  assert.equal(level(await suggest(params)), 'low');
  assert.equal(level(await suggest({ ...params, brief: planOf({ type: 'coding' }) })), 'medium');
  assert.equal(level(await suggest({ ...params, brief: planOf({ type: 'behavioural' }) })), 'low');
  assert.equal(level(await suggest({ ...params, quality: 'fast', brief: planOf({ type: 'coding' }) })), 'low');
  // The first line stays minimal whatever the brief says.
  const head = (await suggest({ ...params, brief: planOf({ type: 'coding' }) })).find((c) => isHeadline(c.body));
  assert.equal(head.body.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
});

test('ai.js ignores a malformed brief', async () => {
  const plain = await suggest({ transcript: 'Them: Why a hash map?', question: 'Why a hash map?', mode: 'interview' });
  for (const bad of ['garbage', 42, null, { block: 42, headlineBlock: {}, type: 'weird' }]) {
    const calls = await suggest({ transcript: 'Them: Why a hash map?', question: 'Why a hash map?', mode: 'interview', brief: bad });
    assert.deepEqual(calls.map((c) => c.raw).sort(), plain.map((c) => c.raw).sort(), String(bad));
  }
});

test('Ask panel: interview mode gets the brief at the top; other modes and no brief unchanged', async () => {
  const brief = planOf({ companyRole: 'Stripe, SWE intern', notes: 'Notice period: 2 weeks' });
  const ask = async (extra) => {
    const calls = captureFetch();
    await ai.askFollowUp({ transcript: 'Them: Any questions for us?', question: 'What should I ask them?', mode: 'interview', ...extra });
    return calls[0];
  };
  const withBrief = await ask({ brief });
  assert.ok(firstText(withBrief.body).startsWith(brief.block));
  const plain = await ask({});
  assert.equal((await ask({ brief: null })).raw, plain.raw);
  assert.equal((await ask({ mode: 'meeting', brief })).raw, (await ask({ mode: 'meeting' })).raw);
});

// ---- 3. the job ad summary call ----

test('summarizeJobAd: one non-streaming call, ad-only prompt, cleaned and capped', async () => {
  const calls = captureFetch('**Role:** SWE intern, payments\n- Must-haves: Python, SQL\n\n' + 'x'.repeat(2000));
  const out = await ai.summarizeJobAd({ text: LONG_AD });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /:generateContent/);
  assert.match(calls[0].body.systemInstruction.parts[0].text, /Use ONLY what the ad itself says/);
  assert.match(firstText(calls[0].body), /^JOB AD \(pasted by the user\):/);
  assert.ok(out.startsWith('Role: SWE intern, payments\nMust-haves: Python, SQL'), out.slice(0, 60));
  assert.ok(out.length <= B.AD_SUMMARY_MAX_CHARS);
  assert.equal(await ai.summarizeJobAd({ text: '   ' }), '');
});

// ---- 4. the saved brief ----

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-brief-store-')), 'interview-brief.json');
}

test('store: save, reload from disk, clear', async () => {
  const file = tmpFile();
  const store = createBriefStore({ file, summarize: async () => 'unused', log: { warn() {} } });
  assert.equal(store.get().empty, true);
  assert.equal(store.plan(), null);
  const v = store.set({ companyRole: 'Stripe, SWE intern', type: 'coding', notes: 'Go' });
  assert.equal(v.empty, false);
  assert.equal(v.summaryStatus, 'none');
  const again = createBriefStore({ file, summarize: async () => '', log: { warn() {} } });
  assert.equal(again.get().brief.companyRole, 'Stripe, SWE intern');
  assert.equal(again.plan().type, 'coding');
  assert.match(again.plan().block, /Company and role: Stripe, SWE intern/);
  again.clear();
  assert.equal(createBriefStore({ file, summarize: async () => '', log: { warn() {} } }).get().empty, true);
});

test('store: a long ad is summarised once in the background; the plan switches to the summary', async () => {
  const file = tmpFile();
  let n = 0;
  const store = createBriefStore({ file, summarize: async ({ text }) => { n += 1; assert.equal(text, B.normalizeBrief({ jobAd: LONG_AD }).jobAd); return 'Role: SWE intern\nMust-haves: Python, SQL'; }, log: { warn() {} } });
  const v = store.set({ jobAd: LONG_AD });
  assert.equal(v.summaryStatus, 'pending');
  assert.match(store.plan().block, /the start of the ad/);
  await v.pending;
  assert.equal(store.get().summaryStatus, 'ready');
  assert.match(store.plan().block, /summary of the ad the user pasted\):\nRole: SWE intern/);
  // Saving the same ad again doesn't re-summarise; the summary survives a restart.
  await store.set({ jobAd: LONG_AD, type: 'coding' }).pending;
  assert.equal(n, 1);
  const reloaded = createBriefStore({ file, summarize: async () => { throw new Error('should not run'); }, log: { warn() {} } });
  assert.equal(reloaded.get().summaryStatus, 'ready');
  await reloaded.ensureSummary();
});

test('store: a failed summary falls back to the start of the ad; a stale result is dropped', async () => {
  const failing = createBriefStore({ file: tmpFile(), summarize: async () => { const e = new Error('x'); e.code = 'OFFLINE'; throw e; }, log: { warn() {} } });
  await failing.set({ jobAd: LONG_AD }).pending;
  assert.equal(failing.get().summaryStatus, 'failed');
  assert.match(failing.plan().block, /the start of the ad/);
  assert.match(failing.plan().diagnostic, /summary failed/);

  let release;
  const slow = createBriefStore({ file: tmpFile(), summarize: () => new Promise((r) => { release = r; }), log: { warn() {} } });
  const first = slow.set({ jobAd: LONG_AD }).pending;
  slow.set({ jobAd: 'Short ad: Python.' });
  await new Promise((r) => setImmediate(r));
  release('Role: from the OLD ad');
  await first;
  assert.equal(slow.get().summary, '');
  assert.equal(slow.get().summaryStatus, 'not_needed');
  assert.match(slow.plan().block, /Job ad \(as the user pasted it\):\nShort ad: Python\./);
});
