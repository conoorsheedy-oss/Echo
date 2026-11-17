// Tests for the CV story bank (src/main/story-bank.js, story-store.js) and
// how ai.js uses it: every quote and number checked against the files,
// best-fitting / unused stories first, Interview mode only, no stories = no
// change. fetch() mocked: no network. Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const electronStub = require('./helpers/electron-stub');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-story-test-'));
electronStub.app.getPath = () => userData;
delete process.env.GEMINI_MODEL;
delete process.env.GEMINI_HEADLINE_MODEL;
const keyStore = require('../src/main/keyStore');
keyStore.getKey = (provider) => (provider === 'gemini' ? 'test-gemini-key' : '');
const ai = require('../src/main/ai');
const SB = require('../src/main/story-bank');
const { createStoryStore } = require('../src/main/story-store');
const { runSuggestion } = require('../src/main/suggest-pipeline');

ai._resetHeadlineModel({ status: 'done', model: null });
const realFetch = global.fetch;
test.afterEach(() => {
  global.fetch = realFetch;
  ai._resetSessionState();
});

const CV = `# Mahmoud Example
## Experience
Software Engineering Intern, Kobo (2025)
- Built Ledgerly, a payments reconciliation service in Django that cut manual checks by 40%.
- Led a team of 3 interns to migrate 1,200 test cases to pytest.
- Disagreed with my lead about caching; we ran a two-week A/B test and kept the simpler design.
## Projects
- Chaos engine: a C++ orbital simulation; my first version leaked memory under long runs, so I rewrote the allocator.`;
const DOCS = [{ source: 'cv.md', text: CV }];

const RAW = {
  stories: [
    {
      title: 'Ledgerly reconciliation service', source: 'cv.md',
      situation: 'At Kobo payments were checked by hand.', action: 'I built Ledgerly in Django to reconcile them.', result: 'Manual checks dropped by 40%.',
      quotes: ['Built Ledgerly, a payments reconciliation service in Django', 'cut manual checks by 40%'], themes: ['impact', 'technical depth'], skills: ['Django', 'Python'],
    },
    {
      title: 'Leading the pytest migration', source: 'cv.md',
      situation: 'Our tests were on an old runner.', action: 'I led 3 interns moving 1,200 test cases to pytest.', result: 'Finished in 2 weeks.',
      quotes: ['Led a team of 3 interns to migrate 1,200 test cases to pytest'], themes: ['leadership', 'teamwork'], skills: ['pytest'],
    },
    {
      title: 'Caching disagreement', source: 'cv.md',
      situation: 'My lead wanted a cache.', action: 'I suggested we test it first, and we ran an A/B test.', result: 'We kept the simpler design.',
      quotes: ['Disagreed with my lead about caching', 'we ran a two-week A/B test'], themes: ['conflict'], skills: [],
    },
    {
      title: 'Allocator rewrite', source: 'cv.md',
      situation: 'My simulation leaked memory.', action: 'I rewrote the allocator.', result: '',
      quotes: ['my first version leaked memory under long runs'], themes: ['failure', 'learning', 'made_up_theme'], skills: ['C++'],
    },
    { title: 'Invented award', source: 'cv.md', action: 'I won the national prize.', quotes: ['won the national coding prize in 2024'], themes: ['impact'] },
    { title: 'Invented number', source: 'cv.md', action: 'I served 5000 users with Ledgerly.', quotes: ['Built Ledgerly, a payments reconciliation service'], themes: ['impact'] },
  ],
};

// ---- 1. checking ----

test('verifyStories: quotes word for word, numbers from the files, no quote = no story', () => {
  const { stories, dropped } = SB.verifyStories(RAW, DOCS);
  assert.deepEqual(stories.map((s) => s.title), ['Ledgerly reconciliation service', 'Leading the pytest migration', 'Caching disagreement', 'Allocator rewrite']);
  assert.equal(dropped, 2, 'the invented award (quote not in the file) and the invented number (in the action)');
  assert.deepEqual(stories.map((s) => s.id), ['S1', 'S2', 'S3', 'S4']);
  assert.equal(stories[0].result, 'Manual checks dropped by 40%.', '40 is in the CV');
  assert.equal(stories[1].result, '', '"2 weeks" is not in the CV: the result goes, the story stays');
  assert.match(stories[1].action, /1,200/, '"1,200" matches 1,200 in the file');
  assert.deepEqual(stories[0].themes, ['impact', 'technical_depth']);
  assert.deepEqual(stories[3].themes, ['failure', 'learning'], 'unknown themes dropped');
  assert.equal(stories[0].source, 'cv.md');
});

test('verifyStories: curly quotes, dashes and spacing don\'t matter; paraphrases do', () => {
  const docs = [{ source: 'notes.md', text: "I didn't sleep — we shipped the   release on time." }];
  const ok = SB.verifyStories({ stories: [{ title: 'Release crunch', source: 'notes.md', action: 'I worked through the night.', quotes: ['I didn’t sleep - we shipped the release on time'], themes: ['pressure'] }] }, docs);
  assert.equal(ok.stories.length, 1);
  const para = SB.verifyStories({ stories: [{ title: 'Release crunch', source: 'notes.md', action: 'I worked late.', quotes: ['we delivered the release on schedule'], themes: ['pressure'] }] }, docs);
  assert.equal(para.stories.length, 0);
  assert.equal(SB.verifyStories('garbage', docs).stories.length, 0);
  assert.equal(SB.verifyStories(null, docs).stories.length, 0);
});

test('extraction input: each file under a header, capped', () => {
  const input = SB.buildExtractionInput([{ source: 'cv.md', text: 'hello' }, { source: 'big.md', text: 'x'.repeat(50_000) }]);
  assert.match(input, /^=== FILE: cv\.md ===\nhello/);
  assert.match(input, /=== FILE: big\.md ===/);
  assert.ok(input.length <= SB.EXTRACT_INPUT_MAX_CHARS + 30);
  assert.notEqual(SB.docsHash(DOCS), SB.docsHash([{ source: 'cv.md', text: `${CV} ` }]));
});

// ---- 2. picking ----

test('pickStories: the theme of the question wins; told stories go to the back; the role breaks ties', () => {
  const { stories } = SB.verifyStories(RAW, DOCS);
  assert.equal(SB.pickStories(stories, { question: 'Tell me about a time you disagreed with your manager.' })[0].title, 'Caching disagreement');
  assert.equal(SB.pickStories(stories, { question: 'Tell me about a time you led a team.' })[0].title, 'Leading the pytest migration');
  assert.equal(SB.pickStories(stories, { question: 'Tell me about a mistake you made.' })[0].title, 'Allocator rewrite');
  // Already told for another question: a different story comes first.
  const used = new Map([['S1', 'Tell me about a project you are proud of']]);
  assert.notEqual(SB.pickStories(stories, { question: "What's your biggest achievement?", used })[0].id, 'S1');
  // No theme: the brief's role words decide.
  assert.equal(SB.pickStories(stories, { question: 'Tell me about yourself.', keywords: ['c++', 'simulation', 'memory'] })[0].title, 'Allocator rewrite');
  assert.equal(SB.pickStories(stories, { question: 'x' }).length, 2);
  assert.deepEqual(SB.pickStories([], { question: 'x' }), []);
});

test('story block: labelled, capped, notes what was already told; headline line is the top story', () => {
  const { stories } = SB.verifyStories(RAW, DOCS);
  const used = new Map([['S2', 'Tell me about leading a team']]);
  const block = SB.buildStoryBlock([stories[0], stories[1]], { used });
  assert.match(block, /^STORY BANK \(the user's own stories, checked against their files/);
  assert.match(block, /S1 "Ledgerly reconciliation service" \[From CV: cv\.md\] \(impact, technical depth\)/);
  assert.match(block, /Their words: "Built Ledgerly, a payments reconciliation service in Django"/);
  assert.match(block, /\(Already told this session, for: "Tell me about leading a team"\)/);
  assert.match(block, /If none of them really fits, don't stretch one/);
  assert.ok(block.length <= SB.STORY_BLOCK_MAX_CHARS);
  assert.equal(SB.buildStoryBlock([]), '');
  const line = SB.buildHeadlineStoryLine([stories[0]]);
  assert.match(line, /"Ledgerly reconciliation service", result: Manual checks dropped by 40%/);
  assert.ok(line.length <= SB.HEADLINE_STORY_MAX_CHARS);
});

test('storyToldIn: which story the answer actually told', () => {
  const { stories } = SB.verifyStories(RAW, DOCS);
  const picked = [stories[0], stories[2]];
  assert.equal(SB.storyToldIn('Probably Ledgerly. I built a reconciliation service in Django for payments.', picked).id, 'S1');
  assert.equal(SB.storyToldIn('I disagreed with my lead about caching, so we ran an A/B test.', picked).id, 'S3');
  assert.equal(SB.storyToldIn('I think communication matters.', picked), null);
});

// ---- 3. the store ----

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-story-store-')), 'story-bank.json');
}
const quiet = { warn() {} };

test('store: builds once per version of the files, survives a restart, rebuilds when they change', async () => {
  const file = tmpFile();
  let docs = DOCS;
  let calls = 0;
  const extract = async ({ text }) => { calls += 1; assert.match(text, /=== FILE: cv\.md ===/); return RAW; };
  const store = createStoryStore({ file, extract, getDocuments: () => docs, log: quiet });
  assert.equal(store.get().status, 'empty');
  const p = store.rebuild();
  assert.equal(store.get().status, 'building');
  await p;
  assert.equal(store.get().status, 'ready');
  assert.equal(store.get().count, 4);
  await store.rebuild();
  assert.equal(calls, 1, 'same files: no second call');
  const again = createStoryStore({ file, extract, getDocuments: () => docs, log: quiet });
  assert.equal(again.get().count, 4);
  await again.rebuild();
  assert.equal(calls, 1, 'restart with the same files: no call');
  docs = [{ source: 'cv.md', text: `${CV}\n- New line.` }];
  await again.rebuild();
  assert.equal(calls, 2, 'files changed: rebuilt');
  docs = [];
  await again.rebuild();
  assert.equal(again.get().status, 'empty');
  assert.equal(again.plan({ question: 'Tell me about a time you led a team.' }), null);
});

test('store: switched off = no call, no stories; back on = rebuilt', async () => {
  let calls = 0;
  const store = createStoryStore({ file: tmpFile(), extract: async () => { calls += 1; return RAW; }, getDocuments: () => DOCS, log: quiet });
  store.setEnabled(false);
  await store.rebuild();
  assert.equal(calls, 0);
  assert.equal(store.get().status, 'off');
  assert.equal(store.plan({ question: 'Tell me about a time you led a team.' }), null);
  await store.setEnabled(true).pending;
  assert.equal(calls, 1);
  assert.equal(store.get().status, 'ready');
});

test('store: failure and stale results', async () => {
  const failing = createStoryStore({ file: tmpFile(), extract: async () => { const e = new Error('x'); e.code = 'OFFLINE'; throw e; }, getDocuments: () => DOCS, log: quiet });
  await failing.rebuild();
  assert.equal(failing.get().status, 'failed');
  assert.equal(failing.get().error, 'OFFLINE');

  let docs = DOCS;
  let release;
  const slow = createStoryStore({ file: tmpFile(), extract: () => new Promise((r) => { release = r; }), getDocuments: () => docs, log: quiet });
  const first = slow.rebuild();
  await new Promise((r) => setImmediate(r));
  const firstRelease = release;
  docs = [{ source: 'other.md', text: 'Nothing much here at all.' }];
  const second = slow.rebuild();
  firstRelease(RAW); // the old files' answer arrives late
  await first;
  assert.equal(slow.get().count, 0, 'stale result dropped');
  await new Promise((r) => setImmediate(r));
  release({ stories: [] });
  await second;
  assert.equal(slow.get().status, 'none_found');
});

test('store: plan + noteAnswer remember what was told this session; reset forgets', async () => {
  const store = createStoryStore({ file: tmpFile(), extract: async () => RAW, getDocuments: () => DOCS, log: quiet });
  await store.rebuild();
  const plan = store.plan({ question: "What's your biggest achievement?" });
  assert.equal(plan.picked[0].id, 'S1');
  assert.match(plan.block, /^STORY BANK/);
  assert.match(plan.headlineLine, /Ledgerly/);
  assert.equal(store.noteAnswer(plan, "What's your biggest achievement?", 'Probably Ledgerly, the Django reconciliation service for payments.').id, 'S1');
  const next = store.plan({ question: 'Tell me about something you are proud of.' });
  assert.notEqual(next.picked[0].id, 'S1', 'a fresh story first');
  assert.ok(!next.picked.some((x) => x.id === 'S1'), 'the told story is no longer in the top two');
  // A question that only that story fits strongly still gets it, marked as told.
  const strong = store.plan({ question: 'What technical achievement had the most impact?' });
  assert.equal(strong.picked[0].id, 'S1');
  assert.match(strong.block, /Already told this session, for: "What's your biggest achievement\?"/);
  store.resetSession();
  assert.equal(store.plan({ question: 'Tell me about something you are proud of.' }).picked[0].id, 'S1');
});

// ---- 4. in the Gemini requests ----

function textEvent(text) {
  return `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] })}\n\n`;
}
function captureFetch(reply = 'Probably Ledgerly.') {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), raw: init.body });
    if (/:generateContent/.test(String(url))) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: reply }] }, finishReason: 'STOP' }] }), { status: 200 });
    }
    return new Response(textEvent(reply), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return calls;
}
const isHeadline = (body) => body.generationConfig.thinkingConfig && body.generationConfig.thinkingConfig.thinkingLevel === 'minimal';
const allText = (body) => body.contents[0].parts.filter((p) => p.text).map((p) => p.text).join('\n');
async function suggest(params) {
  const calls = captureFetch();
  await runSuggestion({ ai, params, emit: () => {}, headline: true, log: { warn() {} } });
  await new Promise((r) => setTimeout(r, 10));
  ai._resetSessionState();
  return calls;
}

test('extractStories: one JSON-schema call on the answer model', async () => {
  const calls = captureFetch(JSON.stringify(RAW));
  const out = await ai.extractStories({ text: SB.buildExtractionInput(DOCS) });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /:generateContent/);
  assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');
  assert.ok(calls[0].body.generationConfig.responseSchema.properties.stories);
  const sys = calls[0].body.systemInstruction.parts[0].text;
  assert.match(sys, /Use ONLY what the files say/);
  assert.match(sys, /leadership, teamwork, conflict/);
  assert.equal(out.stories.length, RAW.stories.length);
  assert.deepEqual(await ai.extractStories({ text: '' }), { stories: [] });
});

test('interview: the story block follows the background, replaces "no background" and reaches the first line', async () => {
  const store = createStoryStore({ file: tmpFile(), extract: async () => RAW, getDocuments: () => DOCS, log: quiet });
  await store.rebuild();
  const plan = store.plan({ question: 'Tell me about a time you led a team.' });
  const params = { transcript: 'Them: Tell me about a time you led a team.', question: 'Tell me about a time you led a team.', mode: 'interview', stories: { block: plan.block, headlineLine: plan.headlineLine } };
  const calls = await suggest(params);
  const full = allText(calls.find((c) => !isHeadline(c.body)).body);
  const head = allText(calls.find((c) => isHeadline(c.body)).body);
  assert.ok(full.includes(plan.block));
  assert.ok(!full.includes('No background about the user was provided'), 'stories are background');
  assert.ok(full.indexOf('STORY BANK') < full.indexOf('=== LATEST ==='));
  assert.ok(head.includes(plan.headlineLine));
  assert.ok(!head.includes('No background about the user was provided'));
  // With CV snippets too, both are there, snippets first.
  const withSnippets = allText((await suggest({ ...params, knowledgeSnippets: [{ source: 'cv.md', index: 0, text: 'Led a team of 3 interns' }] })).find((c) => !isHeadline(c.body)).body);
  assert.ok(withSnippets.indexOf('Relevant background about the user') < withSnippets.indexOf('STORY BANK'));
});

test('no stories, a malformed value, or another mode: requests unchanged', async () => {
  const params = { transcript: 'Them: Tell me about a time you led a team.', question: 'Tell me about a time you led a team.', mode: 'interview' };
  const plain = (await suggest(params)).map((c) => c.raw).sort();
  for (const bad of [undefined, null, 'x', { block: 1, headlineLine: {} }, { block: '', headlineLine: '' }]) {
    assert.deepEqual((await suggest({ ...params, stories: bad })).map((c) => c.raw).sort(), plain, String(bad));
  }
  const meeting = { ...params, mode: 'meeting' };
  assert.deepEqual((await suggest({ ...meeting, stories: { block: 'STORY BANK x', headlineLine: 'y' } })).map((c) => c.raw).sort(), (await suggest(meeting)).map((c) => c.raw).sort());
});

test('Ask panel: grounding + spoken-answer rules; a typed behavioural question gets the story bank (Interview only)', async () => {
  const store = createStoryStore({ file: tmpFile(), extract: async () => RAW, getDocuments: () => DOCS, log: quiet });
  await store.rebuild();
  const plan = store.plan({ question: 'Tell me about a time you led a team.' });
  const ask = async (extra) => {
    const calls = captureFetch();
    await ai.askFollowUp({ transcript: '', question: 'Tell me about a time you led a team.', mode: 'interview', ...extra });
    return calls[0];
  };
  const withStories = await ask({ stories: { block: plan.block, headlineLine: plan.headlineLine } });
  const sys = withStories.body.systemInstruction.parts[0].text;
  assert.match(sys, /TRUTH FIRST/);
  assert.match(sys, /No intro line \("Here's an answer you can give"\), no quotation marks around it, no closing moral/);
  assert.match(sys, /no extra numbers, team sizes, durations, results, setbacks/);
  const text = allText(withStories.body);
  assert.ok(text.includes(plan.block));
  assert.ok(!text.includes('No background about the user was provided'));
  const plain = await ask({});
  assert.ok(!allText(plain.body).includes('STORY BANK'));
  assert.equal((await ask({ mode: 'meeting', stories: { block: plan.block } })).raw, (await ask({ mode: 'meeting' })).raw);
});
