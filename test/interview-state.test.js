// Tests for Phase 2b: the INTERVIEW STATE block and the shared "Direction:"
// line (src/main/interview-session.js buildStateBlock / buildAnswerDirection
// / buildInterviewState) and how ai.js / suggest-pipeline.js put them into
// the full answer and the instant first line (Interview mode only).
// Scripted interviews (the Phase 2a fixtures), fetch() mocked: no network,
// no real API key. Deterministic.
// Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const electronStub = require('./helpers/electron-stub');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-state-test-'));
electronStub.app.getPath = () => userData;
delete process.env.GEMINI_MODEL;
delete process.env.GEMINI_HEADLINE_MODEL;
const keyStore = require('../src/main/keyStore');
keyStore.getKey = (provider) => (provider === 'gemini' ? 'test-gemini-key' : '');
const knowledge = require('../src/main/knowledge');
const ai = require('../src/main/ai');
const { runSuggestion } = require('../src/main/suggest-pipeline');
const S = require('../src/main/interview-session');
const { cases: promptCases } = require('./fixtures/prompt-cases');

// No Flash-Lite lookup: the first line uses GEMINI_MODEL (no models-list call).
ai._resetHeadlineModel({ status: 'done', model: null });
const realFetch = global.fetch;
test.afterEach(() => {
  global.fetch = realFetch;
  ai._resetSessionState();
});

const ECHO = '[Echo suggested — not confirmed]';
const TWO_SUM = 'Given an array of integers, return indices of two numbers that add to target.';
const TWO_SUM_ANSWER = [
  "I'd use a hash map from each value to its index, in one pass.",
  '',
  '1. Brute force checks every pair, O(n^2).',
  '2. Sorting with two pointers also works but loses the indices.',
  '',
  '```python',
  'def two_sum(nums, target):',
  '    seen = {}',
  '    for i, n in enumerate(nums):',
  '        if target - n in seen:',
  '            return [seen[target - n], i]',
  '        seen[n] = i',
  '```',
  'O(n) time, O(n) space.',
].join('\n');

// ---- helpers (same scripted-interview shape as interview-session.test.js) ----

function interview() {
  const session = S.createSession({ now: (() => { let t = 1000; return () => (t += 1); })() });
  const lines = [];
  return {
    session,
    lines,
    say(line) {
      lines.push(line);
      S.ingestTranscript(session, lines.join('\n'));
    },
    text() {
      return lines.join('\n');
    },
    suggest(requestId, question, text, knowledgeSources) {
      return S.recordSuggestion(session, { requestId, question, text, knowledgeSources, afterLine: lines.length });
    },
    // Like main.js for one Interview-mode request: plan, then state.
    state(question, analysis = { intent: 'follow_up', kind: 'followup' }, knowledgeSnippets) {
      const plan = S.planKnowledgeSearch(session, { transcript: lines.join('\n'), question, mode: 'interview' });
      return { plan, ...S.buildInterviewState(session, plan, { question, analysis, knowledgeSnippets }) };
    },
  };
}

// Two-sum: the candidate says "hash map"; Echo suggested hash map, O(n),
// sorting / two pointers and code.
function twoSumInterview() {
  const iv = interview();
  iv.say(`Them: ${TWO_SUM}`);
  iv.say('Them: You can assume there is exactly one solution.');
  iv.say('You: Okay, so my first thought is to loop through and for each number look for its complement.');
  iv.suggest('s1', TWO_SUM, TWO_SUM_ANSWER);
  iv.say("You: I'd use a hash map, store each number with its index, and check for the complement as I go.");
  return iv;
}

const lineOf = (block, re) => block.split('\n').find((l) => re.test(l));
// Block lines outside Echo's code fence.
function proseLines(block) {
  const out = [];
  let inCode = false;
  for (const l of block.split('\n')) {
    if (/^```/.test(l)) { inCode = !inCode; continue; }
    if (!inCode) out.push(l);
  }
  return out;
}
const LABEL_RE = /\[(?:Interviewer|You said|From CV: [^\]]+|Echo suggested — not confirmed|Inferred from the wording)\]|\[You said — confirmed: "[^"]+"\]/;

// ---- 1. contents and labels ----

test('two-sum follow-up: [You said] lines verbatim, confirmed "hash map", O(n) only under Echo\'s label', () => {
  const iv = twoSumInterview();
  const q = "What's the time complexity?";
  iv.say(`Them: ${q}`);
  const st = iv.state(q);
  const block = st.block;
  assert.ok(block.startsWith(S.STATE_HEADER), block);
  assert.ok(block.includes(`Current thread #1 (technical problem). Original question: "${TWO_SUM}" [Interviewer]`), block);
  assert.ok(block.includes(`Follow-up (asked now): "${q}" [Interviewer]`));
  assert.ok(block.includes(`[You said] "I'd use a hash map, store each number with its index, and check for the complement as I go."`));
  assert.ok(block.includes('[You said — confirmed: "hash map"]'));
  assert.ok(block.includes('Constraint: "You can assume there is exactly one solution." [Interviewer]'));
  // Unconfirmed suggestion details live only under Echo's label.
  for (const l of block.split('\n').filter((x) => x.includes('O(n)'))) assert.ok(l.includes(ECHO), `O(n) outside Echo's label: ${l}`);
  for (const l of block.split('\n').filter((x) => x.startsWith('[You said') || x.startsWith('Details the candidate said'))) {
    assert.ok(!/O\(n\)|two pointers|sorting/i.test(l), `suggested detail under You said: ${l}`);
  }
  assert.match(lineOf(block, /^Echo's earlier answer/), /Points the candidate hasn't said: .*O\(n\)/);
  // Technical thread: Echo's code, labelled, right after its label line.
  const lines = block.split('\n');
  const codeAt = lines.findIndex((l) => l.startsWith("Echo's latest code for #1 [Echo suggested — not confirmed]:"));
  assert.ok(codeAt > 0 && lines[codeAt + 1] === '```python' && lines[codeAt + 2] === 'def two_sum(nums, target):', block);
  // Every line outside the code says where it came from.
  for (const l of proseLines(block).slice(1)) {
    if (l.startsWith("Echo's latest code")) continue;
    assert.match(l, LABEL_RE, `unlabelled line: ${l}`);
  }
  assert.match(st.direction, /^Direction: follow-up on #1 \(Given an array of integers/);
  assert.match(st.direction, /the approach the candidate described: hash map \[You said\]\.$/);
  assert.equal(st.diagnostic, `State block: ${block.length} chars (thread #1, link ${st.plan.link.confidence.toFixed(2)})`);
});

test('the candidate contradicts the suggestion ("Actually I\'d sort it and use two pointers"): the direction follows the candidate', () => {
  const iv = twoSumInterview();
  iv.say("Them: Hmm, what if memory is tight?");
  iv.say("You: Actually I'd sort it and use two pointers instead of a hash map.");
  const q = 'What about duplicates?';
  iv.say(`Them: ${q}`);
  const st = iv.state(q);
  assert.match(st.direction, /the approach the candidate described: sorting, two pointers \[You said\]\.$/);
  assert.ok(!st.direction.includes('hash map'), st.direction);
  assert.ok(st.block.includes(`[You said] "Actually I'd sort it and use two pointers instead of a hash map."`), st.block);
  // Negation: "instead of sorting" isn't the candidate's approach.
  const iv2 = twoSumInterview();
  iv2.say('Them: Why that choice?');
  iv2.say("You: I'd keep the hash map instead of sorting, so I don't lose the indices.");
  iv2.say('Them: What about duplicates?');
  const d2 = iv2.state('What about duplicates?').direction;
  assert.match(d2, /described: hash map \[You said\]/);
  assert.ok(!/sorting/.test(d2), d2);
  // Nothing technical said: no approach detail, and nothing borrowed from Echo.
  const iv3 = interview();
  iv3.say(`Them: ${TWO_SUM}`);
  iv3.suggest('s1', TWO_SUM, TWO_SUM_ANSWER);
  iv3.say('You: Okay, let me think about the indices first.');
  iv3.say("Them: What's the time complexity?");
  const d3 = iv3.state("What's the time complexity?").direction;
  assert.match(d3, /^Direction: follow-up on #1 /);
  assert.ok(!/hash map|O\(n\)|two pointers/.test(d3), d3);
});

const CV = `# Sam Rivera

### Ledgerly (payments reconciliation, Kobo, 2025)
Built Ledgerly, a payments reconciliation service in Django at Kobo. It matched about 50k transactions a day against bank statements and cut manual reconciliation from 6 hours to 20 minutes. I disagreed with a teammate about running the nightly job on Celery versus a cron script; we agreed to benchmark both for a week, and Celery won on retries and monitoring.

### Orbit (satellite telemetry dashboard, 2026)
Built Orbit, a React and FastAPI dashboard that streams satellite telemetry from a simulator and flags anomalies with a rolling z-score. It handled 200 messages a second, and after tuning thresholds with the research group alert noise dropped by 35 percent.
`;
fs.mkdirSync(path.join(userData, 'knowledge'), { recursive: true });
fs.writeFileSync(path.join(userData, 'knowledge', 'sam-cv.md'), CV);
knowledge.loadKnowledgeBase();

const DISAGREE = 'Tell me about a time you disagreed with a teammate.';

function behaviouralInterview({ withCv }) {
  const iv = interview();
  iv.say(`Them: ${DISAGREE}`);
  const plan = S.planKnowledgeSearch(iv.session, { transcript: iv.text(), question: DISAGREE, mode: 'interview' });
  const snippets = withCv ? knowledge.searchKnowledge(plan.query) : [];
  S.recordSuggestion(iv.session, {
    requestId: 'r1', question: DISAGREE, afterLine: plan.afterLine, generation: plan.generation, knowledgeSources: snippets,
    text: withCv ? 'Use the Ledgerly story, or Orbit if you prefer. Mention the 35 percent drop.' : 'At [company], I disagreed with [teammate] about [decision].',
  });
  iv.say('You: Sure. At Kobo I disagreed with a teammate about running the Ledgerly nightly job on Celery or cron.');
  iv.say('You: We benchmarked both for a week and went with Celery.');
  return iv;
}

test('behavioural follow-up "What did you learn?": same story, with the CV file the story came from; no CV -> placeholders', () => {
  const q = 'What did you learn from it?';
  const iv = behaviouralInterview({ withCv: true });
  iv.say(`Them: ${q}`);
  const st = iv.state(q, { intent: 'follow_up', kind: 'general' }, knowledge.searchKnowledge('learn'));
  assert.equal(st.direction, 'Direction: follow-up on #1 (Tell me about a time you disagreed with a…) — stay with the same story (Kobo, Ledgerly [You said]; [From CV: sam-cv.md]).');
  assert.ok(!/Orbit|35/.test(st.direction), st.direction);
  assert.ok(st.block.includes('CV files used for this thread: [From CV: sam-cv.md]'), st.block);
  // Echo's unconfirmed "Orbit" never shows up as something the candidate said.
  for (const l of st.block.split('\n').filter((x) => x.includes('Orbit'))) assert.ok(l.includes(ECHO), l);

  const bare = behaviouralInterview({ withCv: false });
  bare.say(`Them: ${q}`);
  const st2 = bare.state(q, { intent: 'follow_up', kind: 'general' }, []);
  assert.match(st2.direction, /stay with the same story \(Kobo, Ledgerly \[You said\]\); no CV facts, so use \[placeholders\]/);
  assert.ok(!st2.direction.includes('From CV'));
  assert.ok(!st2.block.includes('[From CV:'), st2.block);
});

test('new questions get a type-specific direction (and the very first question adds no block)', () => {
  const iv = interview();
  iv.say(`Them: ${TWO_SUM}`);
  const first = iv.state(TWO_SUM, { intent: 'technical_question', kind: 'problem' });
  assert.equal(first.block, '', 'nothing to add beyond the question itself');
  assert.equal(first.headlineBlock, '');
  assert.equal(first.direction, 'Direction: new problem — start with the approach, then the walk-through.');
  assert.equal(first.diagnostic, 'State block: 0 chars (thread #1, link 1.00)');
  iv.say("You: I'd use a hash map.");
  iv.say("Them: Okay, let's move on. Tell me about a time you failed.");
  const beh = iv.state('Tell me about a time you failed.', { intent: 'behavioural_question', kind: 'general' });
  assert.equal(beh.direction, 'Direction: new behavioural question — pick one real story from the CV; use [placeholders] if none fits.');
  assert.match(beh.block, /^Other thread #1 \(technical problem, answered\)/m);
  // Early start: the question isn't in the transcript yet (virtual link).
  const early = interview();
  early.say(`Them: ${TWO_SUM}`);
  early.say("You: I'd use a hash map.");
  const pre = early.state('Design a URL shortener for a large website.', { intent: 'technical_question', kind: 'problem' });
  assert.match(pre.direction, /^Direction: new problem/);
  assert.ok(pre.block.includes('Current question (a new thread): "Design a URL shortener for a large website." [Interviewer]'), pre.block);
  assert.match(pre.diagnostic, /\(new thread, link \d\.\d\d\)$/);
});

test('low-confidence "Can you walk me through that?": both readings in the block, the direction says it is uncertain', () => {
  const iv = twoSumInterview();
  iv.say("Them: Okay, let's move on. Tell me about a time you disagreed with a teammate.");
  iv.say('Them: Can you walk me through that?');
  const st = iv.state('Can you walk me through that?');
  assert.equal(st.plan.link.provisional, true);
  const link = lineOf(st.block, /^Link /);
  assert.ok(link, st.block);
  assert.match(link, /^Link \[Inferred from the wording\]: this question may be a follow-up to #2 \(Tell me about a time you disagreed with a…\) or a follow-up to #1 \(Given an array of integers, return indices of…\)/);
  assert.match(link, /decide from the wording\.$/);
  // Link uncertainty outranks everything but the header.
  assert.equal(st.block.split('\n')[1], link);
  assert.match(st.direction, /^Direction: probably a follow-up on #2 /);
  assert.match(st.direction, /Uncertain link: it may instead be about #1( or a new question)?; go with the wording\.$/);
});

test('an older-thread reference says "refers back to #1"', () => {
  const iv = twoSumInterview();
  iv.say("Them: Okay, let's move on. Tell me about a time you disagreed with a teammate.");
  iv.say('You: At my last internship I disagreed with a teammate about the nightly job.');
  const q = 'Going back to your two-sum solution, how would you handle a stream?';
  iv.say(`Them: ${q}`);
  const st = iv.state(q);
  assert.match(st.block, /^Link \[Inferred from the wording\]: refers back to #1 \(Given an array of integers, return indices of…\), an earlier thread, not the latest one\.$/m);
  assert.match(st.direction, /^Direction: refers back to #1 \(Given an array of integers, return indices of…\) — answer in terms of the approach the candidate described: hash map \[You said\]\.$/);
  assert.match(st.block, /^Other thread #2 \(behavioural, answered\)/m);
});

// ---- 2. size cap, priority, determinism ----

function longInterview() {
  const iv = interview();
  const longCode = ['```java', 'public int[] solve(int[] nums, int target) {', ...Array.from({ length: 120 }, (_, i) => `    int v${i} = nums[${i}] * target + ${i}; // step ${i} ${'x'.repeat(40)}`), '    return new int[0];', '}', '```'].join('\n');
  for (let i = 1; i <= 20; i++) {
    const q = i % 2
      ? `Given an array of ${i} integers, return the longest increasing run number ${i} ${'and more words '.repeat(6)}`
      : `Tell me about a time you led project ${i} under a tight deadline ${'with lots of detail '.repeat(5)}`;
    iv.say(`Them: ${q}`);
    if (i % 2) iv.suggest(`s${i}`, q, `I'd use a hash map and a sliding window.\n${longCode}\nO(n) time.`);
    iv.say(`You: For number ${i} I'd use dynamic programming. ${'I keep talking for quite a while about it. '.repeat(12)}`);
    iv.say(`Them: We use Kafka on our team for question ${i}. Assume the input has at most 100000 items.`);
    iv.say(`You: Then I'd use a heap for ${i}, ${'and keep explaining the reasoning. '.repeat(8)}`);
  }
  iv.say('Them: What is the complexity of that?');
  return iv;
}

test('a 20-thread session with long code stays within the caps, keeps the priority items, and is deterministic', () => {
  const iv = longInterview();
  const st = iv.state('What is the complexity of that?');
  assert.ok(st.block.length <= S.STATE_BLOCK_MAX_CHARS, `${st.block.length}`);
  assert.ok(st.headlineBlock.length <= S.HEADLINE_STATE_BLOCK_MAX_CHARS, `${st.headlineBlock.length}`);
  for (const b of [st.block, st.headlineBlock]) {
    const lines = b.split('\n');
    assert.equal(lines[0], S.STATE_HEADER);
    assert.ok(lines.some((l) => l.startsWith('Current thread #')), b);
    assert.ok(lines.some((l) => l.startsWith('Follow-up (asked now): "What is the complexity of that?"')), b);
    assert.ok(lines.some((l) => l.startsWith('[You said] "Then I\'d use a heap')), 'most recent candidate line kept');
    // No line cut in the middle: every non-code line still ends with its label or a full sentence.
    for (const l of proseLines(b).slice(1)) if (!l.startsWith("Echo's latest code")) assert.match(l, LABEL_RE, l);
  }
  // The first line's block is the full block minus its lowest-priority units, same order.
  const full = st.block.split('\n');
  let at = 0;
  for (const l of st.headlineBlock.split('\n')) {
    at = full.indexOf(l, at);
    assert.ok(at !== -1, `headline line not in the full block (in order): ${l}`);
    at += 1;
  }
  // Same input, same output (a fresh replay of the same interview).
  const again = longInterview().state('What is the complexity of that?');
  assert.equal(again.block, st.block);
  assert.equal(again.headlineBlock, st.headlineBlock);
  assert.equal(again.direction, st.direction);
  // Tighter caps drop whole lower-priority units, never the top ones.
  for (const cap of [1200, 800, 500, 350]) {
    const b = S.buildStateBlock(iv.session, st.plan, { maxChars: cap, question: 'What is the complexity of that?' });
    assert.ok(b.length <= cap, `${cap}: ${b.length}`);
    if (!b) continue;
    assert.ok(b.startsWith(S.STATE_HEADER));
    assert.ok(b.includes('Current thread #'), `${cap}: ${b}`);
  }
});

test('long code is elided (signature, first and last lines, marker) and capped', () => {
  const iv = interview();
  const q = 'Given an array of integers, return the length of the longest increasing run.';
  iv.say(`Them: ${q}`);
  const body = Array.from({ length: 80 }, (_, i) => `    total += step(${i}, nums) # line ${i} of the loop body`);
  iv.suggest('s1', q, `Use one pass.\n\`\`\`python\ndef longest_run(nums):\n${body.join('\n')}\n    return best\n\`\`\``);
  iv.say('You: I would scan once and track the current run.');
  iv.say('Them: Why does that work?');
  const st = iv.state('Why does that work?');
  const lines = st.block.split('\n');
  const at = lines.findIndex((l) => l.startsWith("Echo's latest code for #1"));
  assert.ok(at > 0, st.block);
  const code = lines.slice(at + 1).join('\n');
  assert.ok(code.length <= 1200, String(code.length));
  assert.ok(code.startsWith('```python\ndef longest_run(nums):\n'), code);
  assert.match(code, /… \(\d+ lines omitted\)/);
  assert.ok(code.endsWith('    return best\n```'), code);
  assert.ok(st.block.length <= S.STATE_BLOCK_MAX_CHARS);
  // Behavioural threads never carry code.
  const b = behaviouralInterview({ withCv: true });
  b.say('Them: What was the outcome?');
  assert.ok(!b.state('What was the outcome?').block.includes('```'));
});

// ---- 3. the full answer and the first line get the same state ----

function textEvent(text, finishReason) {
  const c = { content: { parts: [{ text }] } };
  if (finishReason) c.finishReason = finishReason;
  return `data: ${JSON.stringify({ candidates: [c] })}\n\n`;
}
function captureFetch() {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), raw: init.body });
    return new Response(textEvent('Sure, it is linear time.', 'STOP'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return calls;
}
const isHeadline = (body) => body.generationConfig.thinkingConfig && body.generationConfig.thinkingConfig.thinkingLevel === 'minimal';
const textOf = (body) => body.contents[0].parts.filter((p) => p.text).map((p) => p.text);
const settle = () => new Promise((r) => setTimeout(r, 10));

// The request main.js would make (ai:suggest, Interview mode).
async function suggestLikeMain(iv, question, { mode = 'interview', answerStyle = 'script' } = {}) {
  const plan = S.planKnowledgeSearch(iv.session, { transcript: iv.text(), question, mode });
  const knowledgeSnippets = knowledge.searchKnowledge(plan.query, undefined, { prefer: plan.prefer });
  const params = { transcript: iv.text(), mode, question, previousAnswers: [{ kind: 'suggestion', question: TWO_SUM, text: TWO_SUM_ANSWER }], answerStyle, knowledgeSnippets };
  let state = null;
  if (mode === 'interview') {
    const analysis = ai.analyzeSuggestion(params);
    state = S.buildInterviewState(iv.session, plan, { question, analysis: { intent: analysis.intent, kind: analysis.questionKind }, knowledgeSnippets });
    params.interviewState = state;
  }
  const calls = captureFetch();
  await runSuggestion({ ai, params, emit: () => {}, headline: true, log: { warn() {} } });
  await settle();
  return { state, full: calls.find((c) => !isHeadline(c.body)), head: calls.find((c) => isHeadline(c.body)) };
}

test('the full answer and the instant first line get the same state block (first line trimmed, a subset) and the same Direction line', async () => {
  const iv = longInterview();
  const { state, full, head } = await suggestLikeMain(iv, 'What is the complexity of that?');
  assert.ok(full && head);
  const [fullContext, fullLatest] = textOf(full.body);
  const [headContext, headLatest] = textOf(head.body);
  assert.ok(fullContext.endsWith(`\n\n${state.block}`), 'full answer: the block ends the context (no screenshots)');
  assert.ok(headContext.endsWith(`\n\n${state.headlineBlock}`), 'first line: its trimmed block');
  assert.ok(state.headlineBlock.length <= S.HEADLINE_STATE_BLOCK_MAX_CHARS && state.headlineBlock.length < state.block.length);
  assert.ok(state.block.startsWith(state.headlineBlock.split('\n').slice(0, 3).join('\n')), 'same top-priority lines');
  // The block sits after the background, before LATEST; the transcript stays first.
  for (const ctx of [fullContext, headContext]) {
    assert.ok(ctx.indexOf('INTERVIEW STATE') > ctx.lastIndexOf('[from sam-cv.md]'));
  }
  assert.ok(fullContext.startsWith('FULL CONVERSATION SO FAR'));
  assert.ok(headContext.startsWith('RECENT CONVERSATION'));
  // Identical Direction line in both LATEST parts, right after the question.
  const dirLine = (latest) => latest.split('\n').filter((l) => l.startsWith('Direction:'));
  assert.deepEqual(dirLine(fullLatest), [state.direction]);
  assert.deepEqual(dirLine(headLatest), [state.direction]);
  assert.ok(fullLatest.indexOf(state.direction) > fullLatest.indexOf('Question to answer now'));
  assert.ok(headLatest.indexOf(state.direction) > headLatest.indexOf('Question to answer now'));
  assert.ok(headLatest.trimEnd().endsWith('Reply with ONLY the first sentence the user should say.'));
});

test('prompt caching: the system prompt stays fixed per (mode, style) and the transcript stays first', async () => {
  const iv = twoSumInterview();
  iv.say("Them: What's the time complexity?");
  const a = await suggestLikeMain(iv, "What's the time complexity?");
  iv.say("You: It's linear, one pass.");
  iv.say("Them: Okay, let's move on. Tell me about a time you disagreed with a teammate.");
  const b = await suggestLikeMain(iv, 'Tell me about a time you disagreed with a teammate.');
  assert.notEqual(a.state.block, b.state.block);
  for (const r of [a, b]) {
    assert.equal(r.full.body.systemInstruction.parts[0].text, ai.buildSystemPrompt('interview', 'script'));
    assert.equal(r.head.body.systemInstruction.parts[0].text, ai.buildHeadlineSystemPrompt('interview'));
  }
  const sys = ai.buildSystemPrompt('interview', 'script');
  assert.ok(sys.includes("Answer follow-ups in terms of what the candidate actually said ([You said]); if that differs from [Echo suggested], follow the candidate's version and don't contradict them."));
  assert.ok(sys.includes('Never treat [Echo suggested — not confirmed] as something the user did or said.'));
  assert.ok(sys.includes('pick the reading the wording supports best'));
  for (const mode of ['meeting', 'presentation', 'general']) {
    for (const style of ['script', 'cues']) assert.ok(!ai.buildSystemPrompt(mode, style).includes('INTERVIEW STATE'), mode);
    assert.ok(!ai.buildHeadlineSystemPrompt(mode).includes('INTERVIEW STATE'), mode);
  }
  // Consecutive requests share the whole earlier transcript as a prefix.
  const first = textOf(a.full.body)[0];
  const second = textOf(b.full.body)[0];
  let shared = 0;
  while (shared < first.length && first[shared] === second[shared]) shared++;
  const t1 = first.indexOf('FULL CONVERSATION SO FAR');
  assert.equal(t1, 0);
  assert.ok(shared >= first.indexOf("Them: What's the time complexity?") + 10, `shared prefix ${shared}`);
});

test('non-interview modes: request bodies are byte-identical to Phase 2a (even if a state is passed); interview without state keeps its user message', async () => {
  const snapshots = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'prompt-snapshots-2a.json'), 'utf8'));
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const bogusState = { block: 'INTERVIEW STATE should never appear', headlineBlock: 'INTERVIEW STATE nope', direction: 'Direction: nope' };
  let checked = 0;
  for (const c of promptCases()) {
    const interviewMode = c.mode === 'interview';
    const calls = captureFetch();
    await runSuggestion({ ai, params: interviewMode ? c.params : { ...c.params, interviewState: bogusState }, emit: () => {}, headline: true, log: { warn() {} } });
    await settle();
    ai._resetSessionState();
    const want = snapshots[c.id];
    for (const call of calls) {
      const part = isHeadline(call.body) ? 'headline' : 'answer';
      if (interviewMode) assert.equal(sha(JSON.stringify(call.body.contents)), want[part].contents, `${c.id} ${part}`);
      else assert.equal(sha(call.raw), want[part].body, `${c.id} ${part}: request body changed`);
      checked += 1;
    }
  }
  assert.equal(checked, promptCases().length * 2);
});

test('ai.js ignores a malformed interviewState; an empty session gives no block', async () => {
  for (const bad of ['garbage', 42, { block: 42, headlineBlock: {}, direction: null }, null]) {
    const calls = captureFetch();
    await runSuggestion({ ai, params: { transcript: 'Them: Why a hash map?', question: 'Why a hash map?', mode: 'interview', interviewState: bad }, emit: () => {}, headline: true, log: { warn() {} } });
    await settle();
    const ref = captureFetch();
    await runSuggestion({ ai, params: { transcript: 'Them: Why a hash map?', question: 'Why a hash map?', mode: 'interview' }, emit: () => {}, headline: true, log: { warn() {} } });
    await settle();
    const sorted = (cs) => cs.map((c) => c.raw).sort();
    assert.deepEqual(sorted(calls), sorted(ref), JSON.stringify(bad));
  }
  const plain = ai.buildConversationText({ transcript: 'Them: hi?', question: 'hi?', mode: 'interview', kind: 'general' });
  const withEmpty = ai.buildConversationText({ transcript: 'Them: hi?', question: 'hi?', mode: 'interview', kind: 'general', stateBlock: '', direction: '' });
  assert.equal(withEmpty, plain);
  const s = S.createSession();
  const st = S.buildInterviewState(s, null, {});
  assert.equal(st.block, '');
  assert.equal(st.direction, '');
  assert.equal(S.buildStateBlock(s, { threadId: 'th99', link: null }), '');
});
