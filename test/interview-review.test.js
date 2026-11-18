// Fixes from a mock-interview review: the user's terms reach speech-to-text
// (Deepgram keyterms, Whisper prompt), garbled terms aren't repeated, lines
// short enough to say after one glance, cue-led technical steps, one-breath
// trade-offs, checked formulas, "any questions for me?" always gets questions,
// and no story is bent into a theme it doesn't have. Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const electronStub = require('./helpers/electron-stub');
electronStub.app.getPath = () => fs.mkdtempSync(path.join(os.tmpdir(), 'echo-review-test-'));
delete process.env.GEMINI_MODEL;
delete process.env.GEMINI_HEADLINE_MODEL;
const keyStore = require('../src/main/keyStore');
keyStore.getKey = (provider) => (provider === 'gemini' || provider === 'groq' ? 'test-key' : '');
const ai = require('../src/main/ai');
const vocab = require('../src/main/stt-vocab');
const dg = require('../src/main/deepgram-core');
const SB = require('../src/main/story-bank');
const { runSuggestion } = require('../src/main/suggest-pipeline');

ai._resetHeadlineModel({ status: 'done', model: null });
const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; ai._resetSessionState(); });

const CV = `# Example
## Experience
Student Researcher, Hamilton Institute (Jun 2026 - Aug 2026)
- Led a NIST SP 800-22 randomness testing framework in Python with a Flask web UI.
- Validated MyRNG at 1,000,000 bits.
Backend Intern, PayDai
- Built Django REST endpoints for Calendly and GoHighLevel; Stripe OAuth and webhooks.
Skills: Java, Python, TypeScript, C++, FastAPI, PostgreSQL, Docker`;

test('vocabulary: names and specs from the files and the brief, not ordinary words', () => {
  const terms = vocab.extractVocabulary({ documents: [{ source: 'cv.md', text: CV }], brief: { companyRole: 'Stripe, SWE intern', notes: 'They use Kafka.' } });
  for (const t of ['NIST SP 800-22', 'MyRNG', 'GoHighLevel', 'PayDai', 'FastAPI', 'PostgreSQL', 'C++', 'Stripe', 'Calendly', 'Django', 'Hamilton', 'Kafka']) {
    assert.ok(terms.includes(t), `${t} in ${terms.join(', ')}`);
  }
  for (const t of ['NIST', 'Built', 'Led', 'Experience', 'AI', 'UI', 'Validated']) assert.ok(!terms.includes(t), `${t} left out`);
  assert.ok(terms.length <= vocab.MAX_TERMS);
  assert.ok(terms.join('').length <= vocab.MAX_TOTAL_CHARS);
  assert.deepEqual(vocab.extractVocabulary({}), []);
  const prompt = vocab.whisperPrompt(terms);
  assert.match(prompt, /^Job interview\. Terms: .*NIST SP 800-22/);
  assert.ok(prompt.length <= vocab.WHISPER_PROMPT_MAX_CHARS);
  assert.equal(vocab.whisperPrompt([]), '');
});

test('Deepgram: one keyterm per term, Nova-3 English only, capped', () => {
  const url = new URL(dg.buildListenUrl({ keyterms: ['NIST SP 800-22', 'PayDai', 'PayDai', '', 'x'.repeat(80)] }));
  assert.deepEqual(url.searchParams.getAll('keyterm'), ['NIST SP 800-22', 'PayDai']);
  assert.deepEqual(new URL(dg.buildListenUrl({ model: 'nova-2', keyterms: ['PayDai'] })).searchParams.getAll('keyterm'), []);
  assert.deepEqual(new URL(dg.buildListenUrl({ language: 'fr', keyterms: ['PayDai'] })).searchParams.getAll('keyterm'), []);
  assert.equal(new URL(dg.buildListenUrl({ keyterms: Array.from({ length: 80 }, (_, i) => `Term${i}`) })).searchParams.getAll('keyterm').length, 40);
  assert.equal(new URL(dg.buildListenUrl()).searchParams.getAll('keyterm').length, 0);
});

test('Groq Whisper: the prompt is sent; a transcript of the prompt itself is dropped', async () => {
  const sent = [];
  let reply = 'We used NIST SP 800-22.';
  global.fetch = async (url, init) => {
    sent.push(init.body);
    return new Response(JSON.stringify({ text: reply, segments: [{ no_speech_prob: 0.01, avg_logprob: -0.1 }] }), { status: 200 });
  };
  const base64 = Buffer.alloc(4000, 1).toString('base64');
  assert.equal(await ai.transcribeAudio({ base64, mimeType: 'audio/webm', prompt: 'Job interview. Terms: NIST SP 800-22.' }), 'We used NIST SP 800-22.');
  assert.equal(sent[0].get('prompt'), 'Job interview. Terms: NIST SP 800-22.');
  await ai.transcribeAudio({ base64, mimeType: 'audio/webm' });
  assert.equal(sent[1].get('prompt'), null, 'no terms, no prompt');
  reply = 'Job interview. Terms: NIST SP 800-22.';
  assert.equal(await ai.transcribeAudio({ base64, mimeType: 'audio/webm', prompt: 'Job interview. Terms: NIST SP 800-22.' }), '');
});

test('prompt: garbled terms corrected, lines sayable, cue-led steps, one-breath trade-offs, checked formulas', () => {
  for (const style of ['script', 'cues']) {
    const system = ai.buildSystemPrompt('interview', style);
    assert.match(system, /"SP 822" for "SP 800-22", use the correct one and never repeat the garbled version/);
    assert.match(system, /\*\*bold cue of 1-3 words\*\*/);
    assert.match(system, /Never write "first", "second", "then three"/);
    assert.match(system, /one plain contrast the user can say in one breath/);
    assert.match(system, /double-check it and every increment \/ decrement/);
  }
  assert.match(ai.buildSystemPrompt('interview', 'script'), /each under about 15 words so it can be said after one glance\. One idea per line\./);
});

test('"any questions for me?": both answers are told to give the user questions to ask', async () => {
  for (const q of ['Do you have any questions for me?', 'Any questions for us?', 'Is there anything you would like to ask me?', 'What questions do you have for us?']) assert.ok(ai.invitesQuestions(q), q);
  for (const q of ['Do you have any questions so far about the problem?', 'Anything you would like to ask about the input format?', 'Tell me about a time you asked questions.']) assert.ok(!ai.invitesQuestions(q), q);
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'What does the first month look like?' }] }, finishReason: 'STOP' }] })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  await runSuggestion({ ai, params: { transcript: 'Them: Do you have any questions for me?', question: 'Do you have any questions for me?', mode: 'interview' }, emit: () => {}, headline: true, log: { warn() {} } });
  await new Promise((r) => setTimeout(r, 10));
  const textOf = (b) => b.contents[0].parts.map((p) => p.text || '').join('\n');
  const head = calls.find((b) => b.generationConfig.thinkingConfig.thinkingLevel === 'minimal');
  const full = calls.find((b) => b !== head);
  assert.match(textOf(full), /Give 2 short, genuine questions the user could ask/);
  assert.match(textOf(head), /give the first good question the user could ask them/);
});

test('story bank: no story with the asked-for theme -> told not to bend one into it', () => {
  const docs = [{ source: 'cv.md', text: 'Built Ledgerly, a payments reconciliation service in Django. Rewrote the allocator after a memory leak.' }];
  const { stories } = SB.verifyStories({ stories: [
    { title: 'Ledgerly', source: 'cv.md', action: 'I built Ledgerly.', quotes: ['Built Ledgerly, a payments reconciliation service'], themes: ['impact'] },
    { title: 'Allocator', source: 'cv.md', action: 'I rewrote the allocator.', quotes: ['Rewrote the allocator after a memory leak'], themes: ['failure', 'learning'] },
  ] }, docs);
  const q = 'Tell me about a time you disagreed with your supervisor.';
  const block = SB.buildStoryBlock(SB.pickStories(stories, { question: q }), { question: q });
  assert.match(block, /None of these stories is about a disagreement or conflict\. Don't turn one into that kind of story/);
  const ok = 'Tell me about a mistake you made.';
  assert.ok(!/None of these stories/.test(SB.buildStoryBlock(SB.pickStories(stories, { question: ok }), { question: ok })), 'the failure story fits');
  const generic = 'Tell me about a project you are proud of.';
  assert.ok(!/None of these stories/.test(SB.buildStoryBlock(SB.pickStories(stories, { question: generic }), { question: generic })));
});

// ---- Second mock interview ----

test('prompt: no code read aloud, failure-case follow-ups, STAR names the user\'s own part, numbers not mixed', () => {
  for (const style of ['script', 'cues']) {
    const system = ai.buildSystemPrompt('interview', style);
    assert.match(system, /Spoken lines never contain code: no identifiers with underscores or camelCase, no brackets/);
    assert.match(system, /Failure-case follow-ups \(a crash, a retry, a timeout, two requests at once\): say what state is written before the risky step/);
    assert.match(system, /about 30 seconds out loud/);
    assert.match(system, /never mix figures from different places/);
  }
  assert.match(ai.buildSystemPrompt('interview', 'script'), /make the user's own part explicit \("I did X; my lead did Y"\)/);
  assert.match(ai.buildSystemPrompt('interview', 'cues'), /one cue says what the user did themselves \(not the team\)/);
});

test('brief: "why us" leads with the user\'s real connection; a CV line naming the company wins', () => {
  const B = require('../src/main/interview-brief');
  assert.match(B.buildBriefBlock({ companyRole: 'Stripe, SWE intern' }), /"Why this company \/ role\?": lead with the user's own real connection/);
  assert.equal(B.companyName({ companyRole: 'Stripe, Software Engineering Intern, payments' }), 'Stripe');
  assert.equal(B.companyName({ companyRole: 'SWE intern at Jane Street' }), 'Jane Street');
  assert.equal(B.companyName({ companyRole: 'Google - STEP intern' }), 'Google');
  const behavioural = { intent: 'behavioural_question', questionKind: 'general' };
  const own = [{ source: 'cv.md', index: 0, text: 'Tutored 50 students in Java' }];
  const found = [{ source: 'cv.md', index: 1, text: 'Python and Django REST' }, { source: 'cv.md', index: 2, text: 'Stripe OAuth and webhooks at PayDai' }];
  const r = B.pickFitSnippet({ snippets: own, keywords: ['python'], analysis: behavioural, search: () => found, company: 'Stripe' });
  assert.deepEqual(r.snippets.map((x) => x.index), [0, 2]);
  assert.equal(B.pickFitSnippet({ snippets: [found[1]], keywords: ['python'], analysis: behavioural, search: () => found, company: 'Stripe' }).fit, '', 'a CV line naming Stripe is already there: nothing added');
  // "Stripey" doesn't count as naming Stripe.
  assert.equal(B.pickFitSnippet({ snippets: own, keywords: [], analysis: behavioural, search: () => [{ source: 'a.md', index: 9, text: 'stripey shirts' }], company: 'Stripe' }).fit, 'a.md', 'falls back to the best keyword match');
});

test('failure-case follow-ups think at medium, in any interview type', () => {
  const B = require('../src/main/interview-brief');
  for (const q of ['What happens if your server crashes after calling the provider?', 'What if two requests with the same key arrive at the same time?', 'What about retries?']) {
    assert.equal(B.adjustThinkingLevel('low', { type: 'auto', kind: 'followup', quality: 'auto', question: q }), 'medium', q);
  }
  assert.equal(B.adjustThinkingLevel('low', { type: 'auto', kind: 'followup', quality: 'auto', question: 'What if the input is empty?' }), 'low');
  assert.equal(B.adjustThinkingLevel('low', { type: 'auto', kind: 'general', quality: 'auto', question: 'Tell me about a failure.' }), 'low', 'behavioural "failure" is not a failure case');
  assert.equal(B.adjustThinkingLevel('low', { type: 'auto', kind: 'followup', quality: 'fast', question: 'What if it crashes?' }), 'low');
  const pc = [{ kind: 'suggestion', question: 'Design an idempotent payments API', text: 'Use an idempotency key.' }];
  assert.equal(ai.analyzeSuggestion({ mode: 'interview', question: 'What happens if your server crashes after calling the provider?', transcript: 'Them: x', previousAnswers: pc }).questionKind, 'followup');
});

test('"Add a real story" appends to my-stories.md, which then loads like any file', () => {
  const knowledge = require('../src/main/knowledge');
  assert.throws(() => knowledge.addStory({ title: 'x', text: '   ' }), /Write the story first/);
  assert.equal(knowledge.addStory({ title: 'Disagreeing with my supervisor', text: 'He wanted tests to auto-pass.\nI showed the failing rows.' }), 'my-stories.md');
  knowledge.addStory({ title: '', text: 'A second story.' });
  const text = fs.readFileSync(path.join(knowledge.KNOWLEDGE_DIR, 'my-stories.md'), 'utf8');
  assert.match(text, /^# My stories\n/);
  assert.match(text, /## Disagreeing with my supervisor\n\nHe wanted tests to auto-pass\.\nI showed the failing rows\.\n/);
  assert.match(text, /## Story\n\nA second story\./);
  assert.equal((text.match(/^# My stories/gm) || []).length, 1, 'header once');
  knowledge.loadKnowledgeBase();
  assert.ok(knowledge.getDocuments().some((d) => d.source === 'my-stories.md'));
  assert.ok(knowledge.searchKnowledge('supervisor auto-pass tests').some((s) => s.source === 'my-stories.md'));
});

test('new coding / design problem: a clarifying question first, commented code; answers compact but specific', () => {
  for (const style of ['script', 'cues']) {
    const system = ai.buildSystemPrompt('interview', style);
    assert.match(system, /1\. Line 1: ONE short clarifying question the user asks before solving/);
    assert.match(system, /about something the problem doesn't already state/);
    assert.match(system, /short comments on the key lines .* not one on every line/);
    assert.match(system, /Compact but specific: fewer words, more concrete detail/);
  }
  assert.match(ai.buildHeadlineSystemPrompt('interview'), /A NEW coding or design problem: one short clarifying question to ask them first/);
});

// ---- Microsoft mock ----

test('go-to story: the first story told for a theme comes first in later interviews, not twice in one', async () => {
  const { createStoryStore } = require('../src/main/story-store');
  const docs = [{ source: 'cv.md', text: 'Disagreed with my supervisor about auto-passing tests. Disagreed with my lead about caching. Built Ledgerly, a payments reconciliation service.' }];
  const raw = { stories: [
    { title: 'Caching', source: 'cv.md', action: 'I argued for measuring first.', quotes: ['Disagreed with my lead about caching'], themes: ['conflict'] },
    { title: 'Auto-pass tests', source: 'cv.md', action: 'I asked to keep failing tests visible.', quotes: ['Disagreed with my supervisor about auto-passing tests'], themes: ['conflict'] },
    { title: 'Ledgerly', source: 'cv.md', action: 'I built Ledgerly.', quotes: ['Built Ledgerly, a payments reconciliation service'], themes: ['impact'] },
  ] };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-goto-')), 'story-bank.json');
  const store = createStoryStore({ file, extract: async () => raw, getDocuments: () => docs, log: { warn() {} } });
  await store.rebuild();
  const q = 'Tell me about a time you disagreed with someone senior.';
  // Interview 1: the user's answer tells the auto-pass story (2nd in the list).
  const p1 = store.plan({ question: q });
  assert.deepEqual(p1.picked.map((x) => x.title), ['Caching', 'Auto-pass tests'], 'no go-to yet: list order');
  const told = store.noteAnswer(p1, q, 'My supervisor wanted tests to auto-pass; I disagreed and asked to keep failing tests visible.');
  assert.equal(told.title, 'Auto-pass tests');
  assert.deepEqual(store.get().stories.find((s) => s.title === 'Auto-pass tests').goToFor, ['conflict']);
  // Interview 2 (new session, even after a restart): the same story first, marked.
  store.resetSession();
  const restarted = createStoryStore({ file, extract: async () => raw, getDocuments: () => docs, log: { warn() {} } });
  const p2 = restarted.plan({ question: 'Describe a conflict with your manager.' });
  assert.equal(p2.picked[0].title, 'Auto-pass tests');
  assert.match(p2.block, /go-to story for a disagreement or conflict questions: tell it the same way as before/);
  // Within that interview, once told, a second conflict question gets the other story.
  restarted.noteAnswer(p2, 'Describe a conflict with your manager.', 'My supervisor wanted tests to auto-pass; I asked to keep failing tests visible.');
  assert.equal(restarted.plan({ question: 'Tell me about another disagreement.' }).picked[0].title, 'Caching');
  // Clearing the go-to frees the theme.
  restarted.clearGoTo('conflict');
  assert.deepEqual(restarted.get().stories.find((s) => s.title === 'Auto-pass tests').goToFor, []);
});

test('prompt: nobody looks bad, scaling follow-ups finished, complexities checked, no "first things first"; why-us specific', () => {
  const B = require('../src/main/interview-brief');
  for (const style of ['script', 'cues']) {
    const system = ai.buildSystemPrompt('interview', style);
    assert.match(system, /Never make another person look bad/);
    assert.match(system, /Scaling follow-ups \(a stream, memory limits, very large data, several machines\): name the concrete technique/);
    assert.match(system, /never stop at "we'd need something distributed"/);
    assert.match(system, /Every complexity you state must match the operations it describes/);
    assert.match(system, /"First things first"/);
  }
  assert.match(B.buildBriefBlock({ companyRole: 'Microsoft, SWE intern' }), /naming a specific team, product or engineering choice .* \[placeholder\] such as "\[a team or product you'd want to work on\]"/);
  for (const q of ['What if the data is a stream that does not fit in memory?', 'How would you make it work across many machines?']) {
    assert.equal(B.adjustThinkingLevel('low', { type: 'auto', kind: 'followup', quality: 'auto', question: q }), 'medium', q);
  }
});

// ---- "Tell me about yourself" ----

test('brief intro: used for "tell me about yourself" in both answers; no upgraded facts; no "excited" closers', () => {
  const B = require('../src/main/interview-brief');
  const intro = "I'm a second-year CS and Statistics student at Maynooth. I built a NIST randomness testing framework at the Hamilton Institute. Before that I did backend work at PayDai.";
  const brief = { companyRole: 'Microsoft, SWE intern', intro };
  assert.ok(!B.isEmptyBrief({ intro }));
  const block = B.buildBriefBlock(brief);
  assert.ok(block.includes(intro));
  assert.match(block, /same facts, same order, in their words\. Only shorten it or point its last line at this role\. Never add to it\./);
  assert.match(B.buildHeadlineBriefBlock(brief), /Their intro for "tell me about yourself" starts: "I'm a second-year CS and Statistics student at Maynooth\."/);
  assert.match(B.describeBrief(brief), /intro ✓/);
  assert.equal(B.normalizeBrief({ intro: 'x'.repeat(5000) }).intro.length, B.LIMITS.intro);
  const system = ai.buildSystemPrompt('interview', 'script');
  assert.match(system, /Don't work facts out or upgrade them: the user's year of study, title, seniority or "final year"/);
  assert.match(system, /"I'm excited", "excited about", "which is why I'm"/);
});

test('knowledge: a heading stays with its text; intro questions find the profile, not a plan heading', () => {
  const knowledge = require('../src/main/knowledge');
  const chunks = knowledge.splitIntoChunks(`Project deep-dive 1: ovgraph (lead with this)\n\n${'One line: a Python tool that turns OpenVINO graphs into readable diagrams. Solo, 82 tests. '.repeat(9)}`);
  assert.ok(chunks[0].startsWith('Project deep-dive 1: ovgraph'));
  assert.match(chunks[0], /a Python tool that turns OpenVINO graphs/, 'the heading is not a chunk on its own');
  for (const q of ['Tell me about yourself.', 'tell me a bit about yourself', 'Walk me through your CV', "What's your background?"]) assert.ok(knowledge.isIntroQuestion(q), q);
  assert.ok(!knowledge.isIntroQuestion('Tell me about a time you failed.'));
  // Real-ish files: a plan with a heading and a profile.
  const dir = knowledge.KNOWLEDGE_DIR;
  fs.writeFileSync(path.join(dir, 'Interview_plan.txt'), `Project deep-dive 1: ovgraph (lead with this)\nTell it in 2 minutes, then let them dig:\n\n${'| Question | Story |\n'.repeat(60)}`);
  fs.writeFileSync(path.join(dir, 'my_profile.txt'), 'Maynooth University, B.A. Computer Science and Statistics, currently 2nd year student. Research intern at the Hamilton Institute. Built ovgraph, a Python tool for OpenVINO graphs.');
  knowledge.loadKnowledgeBase();
  const top = knowledge.searchKnowledge('Tell me about yourself.')[0];
  assert.equal(top.source, 'my_profile.txt');
  assert.match(ai.buildSystemPrompt('interview', 'script'), /Never describe something from its name/);
  assert.match(ai.buildSystemPrompt('interview', 'script'), /marks as planned, in progress or not built yet is only ever mentioned as planned/);
});

test('search: generic interview words barely count, tiny chunks can\'t win, max 2 per file', () => {
  const knowledge = require('../src/main/knowledge');
  const dir = knowledge.KNOWLEDGE_DIR;
  for (const f of fs.readdirSync(dir)) if (/\.(txt|md)$/.test(f) && f !== 'README.txt') fs.unlinkSync(path.join(dir, f));
  const para = (t) => `${t} ${'filler words about nothing in particular here. '.repeat(6)}`;
  fs.writeFileSync(path.join(dir, 'plan.txt'), [para('Tell me about a time: project experience example.'), para('Another tell time project experience example line.'), para('Yet another time project example.'), para('Kafka consumer lag fix one.')].join('\n\n'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), para('Kafka consumer lag: I fixed the partition rebalancing.'));
  knowledge.loadKnowledgeBase();
  const hits = knowledge.searchKnowledge('Tell me about a time you fixed Kafka consumer lag on a project.');
  assert.equal(hits[0].source, 'notes.txt', 'the topic word wins over "tell / time / project"');
  assert.ok(hits.filter((h) => h.source === 'plan.txt').length <= 2, 'at most 2 per file');
  const system = ai.buildSystemPrompt('interview', 'script');
  assert.match(system, /Notes are not proof: in plans, cheat sheets and prep files, sections like "what to say"/);
  assert.match(system, /what was prototyped, what someone approved, what was shipped and what was measured/);
  assert.match(system, /frame it as an example \("For example, if I were building it, I'd\.\.\."\), never as something the user did/);
});

test('Answers = Detailed: no TRUTH FIRST or placeholders, longer answers; Strict unchanged', async () => {
  for (const style of ['script', 'cues']) {
    const strict = ai.buildSystemPrompt('interview', style);
    const detailed = ai.buildSystemPrompt('interview', style, 'detailed');
    assert.equal(ai.buildSystemPrompt('interview', style, 'strict'), strict, 'strict is the default');
    assert.match(strict, /TRUTH FIRST/);
    assert.ok(!/TRUTH FIRST/.test(detailed), `${style}: no TRUTH FIRST`);
    assert.ok(!/\[placeholders?\] \(see TRUTH FIRST\)/.test(detailed));
    assert.ok(!/Never add a setback, a struggle/.test(detailed));
    assert.match(detailed, /tell one relevant story from the transcript or background/);
  }
  assert.match(ai.buildSystemPrompt('interview', 'script', 'detailed'), /about 200-300 spoken words/);
  assert.ok(!/about 200-300 spoken words/.test(ai.buildSystemPrompt('interview', 'script')));
  assert.ok(!/use a short \[placeholder\] instead/.test(ai.buildHeadlineSystemPrompt('interview', 'detailed')));
  assert.match(ai.buildHeadlineSystemPrompt('interview'), /use a short \[placeholder\] instead/);
  assert.equal(ai.normalizeDetail('nonsense'), 'strict');
  // Requests: detailed has a bigger budget, no "no background" note; strict is byte-identical to before.
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Sure.' }] }, finishReason: 'STOP' }] })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const params = { transcript: 'Them: Tell me about a project you are proud of.', question: 'Tell me about a project you are proud of.', mode: 'interview' };
  await ai.generateSuggestion({ ...params, detail: 'detailed', onChunk: () => {} });
  await ai.generateSuggestion({ ...params, onChunk: () => {} });
  const [d, s] = calls;
  assert.ok(d.generationConfig.maxOutputTokens > s.generationConfig.maxOutputTokens);
  const text = (b) => b.contents[0].parts.map((p) => p.text || '').join('\n');
  assert.ok(!/No background about the user was provided/.test(text(d)));
  assert.match(text(s), /No background about the user was provided/);
  // Ask panel.
  calls.length = 0;
  await ai.askFollowUp({ transcript: '', question: 'Tell me about yourself', mode: 'interview', detail: 'detailed', onChunk: () => {} });
  await ai.askFollowUp({ transcript: '', question: 'Tell me about yourself', mode: 'interview', onChunk: () => {} });
  assert.ok(!/TRUTH FIRST/.test(calls[0].systemInstruction.parts[0].text));
  assert.match(calls[0].systemInstruction.parts[0].text, /about 200-300 spoken words/);
  assert.match(calls[1].systemInstruction.parts[0].text, /TRUTH FIRST/);
});

test('Detailed keeps the clarifying question and bans "First, Second, Third"; numbers must agree', () => {
  const detailed = ai.buildSystemPrompt('interview', 'script', 'detailed');
  assert.match(detailed, /A NEW coding or design problem still follows the technical rules below: the opening line is ONE clarifying question/);
  assert.match(detailed, /never "First, \.\.\. Second, \.\.\. Third, \.\.\."/);
  for (const sys of [detailed, ai.buildSystemPrompt('interview', 'script')]) {
    assert.match(sys, /Numbers in one answer must agree with each other/);
    assert.match(sys, /spoken enumerations \("First, \.\.\. Second, \.\.\. Third, \.\.\."\)/);
  }
});

test('Ask panel in Interview mode: an interviewer question gets the interview answer; a help request gets chat', async () => {
  assert.ok(ai.isInterviewerQuestion('Design a URL shortener, like bit.ly.'));
  assert.ok(ai.isInterviewerQuestion('Tell me about yourself'));
  for (const q of ['What should I say?', 'what did they mean by sharding', 'summarise the interview so far', 'How do I answer this?']) assert.ok(!ai.isInterviewerQuestion(q), q);
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'How many links a day are we expecting?' }] }, finishReason: 'STOP' }] })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const text = await ai.askFollowUp({ transcript: '', question: 'Design a URL shortener, like bit.ly.', mode: 'interview', detail: 'detailed', answerStyle: 'script', onChunk: () => {} });
  assert.equal(typeof text, 'string');
  const sys = calls[0].systemInstruction.parts[0].text;
  assert.match(sys, /the opening line is ONE clarifying question/);
  assert.match(sys, /Spoken lines never contain code/);
  const body = calls[0].contents[0].parts.map((p) => p.text || '').join('\n');
  assert.match(body, /Question type: a NEW problem to solve/);
  assert.equal(calls[0].generationConfig.thinkingConfig.thinkingLevel, 'high', 'a new design problem thinks hard');
  // Meeting mode: always chat.
  calls.length = 0;
  await ai.askFollowUp({ transcript: '', question: 'Design a URL shortener', mode: 'meeting', onChunk: () => {} });
  assert.ok(!/Interview rules:/.test(calls[0].systemInstruction.parts[0].text));
});
