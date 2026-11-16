// Unit tests for the interview session state (src/main/interview-session.js):
// thread log, new-question vs follow-up linking (confidence, provisional
// links, re-resolution, older-thread references), sources / statuses,
// per-detail confirmation of Echo's suggestions, session reset, and the
// thread-aware knowledge (CV) query with a fixture knowledge base.
// Scripted interviews, deterministic, no network, no API key.
// Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A private knowledge folder for this test file (knowledge.js reads
// app.getPath('userData')/knowledge when it is first required).
const electronStub = require('./helpers/electron-stub');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-session-test-'));
electronStub.app.getPath = () => userData;
const knowledge = require('../src/main/knowledge');
const ai = require('../src/main/ai');
const S = require('../src/main/interview-session');

// ---- helpers ----

// A scripted interview: say() appends one line and ingests the WHOLE
// transcript again, exactly like the renderer resends it on every request.
function interview() {
  const session = S.createSession({ now: (() => { let t = 1000; return () => (t += 1); })() });
  const lines = [];
  return {
    session,
    lines,
    say(line) {
      lines.push(line);
      S.ingestTranscript(session, lines.join('\n'));
      return lines.length - 1; // absolute line index
    },
    text() {
      return lines.join('\n');
    },
    ctx(question) {
      return S.getThreadContext(session, question);
    },
    // Records an Echo suggestion for a question, made "now" (only later
    // candidate lines can confirm its details).
    suggest(requestId, question, text, knowledgeSources) {
      return S.recordSuggestion(session, { requestId, question, text, knowledgeSources, afterLine: lines.length });
    },
  };
}

function threadNumber(session, id) {
  const t = session.threads.find((x) => x.id === id);
  return t ? t.number : null;
}

const TWO_SUM = 'Given an array of integers, return indices of two numbers that add to target.';

// The technical -> behavioural -> back-to-technical interview used by
// several tests.
function scriptedInterview() {
  const iv = interview();
  iv.say(`Them: ${TWO_SUM}`);
  iv.say("You: Okay, so my first thought is to loop through and for each number look for its complement.");
  iv.suggest('s1', TWO_SUM, 'Use a hash map from each value to its index. For each number, check whether target minus it is already in the map, then store it. O(n) time, O(n) space.');
  iv.say("You: I'd use a hash map, store each number with its index, and check for the complement as I go.");
  return iv;
}

// ---- 1. technical thread + follow-ups ----

test('technical question opens thread 1 and its follow-ups attach to it with high confidence', () => {
  const iv = scriptedInterview();
  const first = iv.ctx(TWO_SUM);
  assert.equal(first.link.relation, 'new');
  assert.equal(first.currentThread.number, 1);
  assert.equal(first.currentThread.type, 'technical_problem');
  assert.equal(first.currentThread.status, 'answered');

  for (const q of ['Why a hash map instead of sorting?', "What's the space complexity?", 'What if there are duplicates?']) {
    iv.say(`Them: ${q}`);
    const c = iv.ctx(q);
    assert.equal(c.link.relation, 'follow_up', q);
    assert.equal(c.currentThread.number, 1, q);
    assert.ok(c.link.confidence >= 0.8, `${q}: ${c.link.confidence}`);
    assert.equal(c.provisional, false, q);
    assert.ok(c.link.reasons.length > 0, q);
    iv.say('You: Good question, let me think about that for a second.');
  }
  const t1 = iv.session.threads[0];
  assert.equal(t1.questionIds.length, 1);
  assert.equal(t1.followUpIds.length, 3);
  assert.equal(iv.session.threads.length, 1);
});

// ---- 2. explicit transition -> new behavioural thread ----

test('"let\'s move on" + a behavioural question opens a new thread; its follow-ups attach to it', () => {
  const iv = scriptedInterview();
  iv.say("Them: Okay, let's move on. Tell me about a time you disagreed with a teammate.");
  const c = iv.ctx();
  assert.equal(c.link.relation, 'new');
  assert.equal(c.currentThread.number, 2);
  assert.equal(c.currentThread.type, 'behavioural');
  assert.ok(c.link.confidence >= 0.9);
  assert.match(c.link.reasons.join(' '), /transition/);
  iv.say('You: Sure. At my last internship I disagreed with a teammate about how to schedule the nightly reconciliation job.');

  for (const q of ['What was the outcome?', 'What would you do differently?']) {
    iv.say(`Them: ${q}`);
    const f = iv.ctx(q);
    assert.equal(f.link.relation, 'follow_up', q);
    assert.equal(f.currentThread.number, 2, q);
    assert.ok(f.link.confidence >= 0.8, `${q}: ${f.link.confidence}`);
    iv.say('You: We ran both options for a week and picked the one with fewer failures.');
  }
  // A transition said on its own line also forces the next question new.
  iv.say('Them: Great. Next question.');
  iv.say('Them: How do you prioritise when everything is urgent?');
  const n = iv.ctx('How do you prioritise when everything is urgent?');
  assert.equal(n.link.relation, 'new');
  assert.equal(n.currentThread.number, 3);
  assert.match(n.link.reasons.join(' '), /transition/);
});

// ---- 3. older-thread reference ----

test('"going back to your two-sum solution" follows up thread 1 even though thread 2 is current', () => {
  const iv = scriptedInterview();
  iv.say("Them: Okay, let's move on. Tell me about a time you disagreed with a teammate.");
  iv.say('You: At my last internship I disagreed with a teammate about the nightly job.');
  const q = 'Going back to your two-sum solution, how would you handle a stream?';
  iv.say(`Them: ${q}`);
  const c = iv.ctx(q);
  assert.equal(c.link.relation, 'follow_up');
  assert.equal(c.currentThread.number, 1);
  assert.ok(c.link.confidence >= S.LINK_CONFIDENCE_THRESHOLD, String(c.link.confidence));
  assert.match(c.link.reasons.join(' '), /refers back/);
  // The thread before it is offered as related context.
  assert.ok(c.relatedThreads.some((t) => t.number === 2));
});

test('"earlier you mentioned the payments project" finds the behavioural thread that mentioned it', () => {
  const iv = interview();
  iv.say('Them: Tell me about a project you are proud of.');
  iv.say('You: At my last internship I built a payments reconciliation service in Django for the finance team.');
  iv.say("Them: Thanks. Let's move on. Write a function that reverses a linked list.");
  iv.say("You: I'd walk the list with three pointers, prev, current and next.");
  const q = 'Earlier you mentioned the payments project. How did you test it?';
  iv.say(`Them: ${q}`);
  const c = iv.ctx(q);
  assert.equal(c.link.relation, 'follow_up');
  assert.equal(c.currentThread.number, 1);
});

test('a brand-new coding problem during a behavioural thread opens a new thread without a transition', () => {
  const iv = interview();
  iv.say('Them: Tell me about a time you failed.');
  iv.say('You: In my first internship I shipped a migration without a rollback plan.');
  iv.say('Them: Given a binary tree, return its maximum depth.');
  const c = iv.ctx('Given a binary tree, return its maximum depth.');
  assert.equal(c.link.relation, 'new');
  assert.equal(c.currentThread.type, 'technical_problem');
  assert.ok(c.link.confidence >= 0.8);
});

// ---- 4. ambiguous follow-up -> provisional, then re-resolved ----

test('ambiguous "Can you walk me through that?" after a topic shift is provisional with both threads, then re-resolved by the answer', () => {
  const iv = scriptedInterview();
  iv.say("Them: Okay, let's move on. Tell me about a time you disagreed with a teammate.");
  iv.say('Them: Can you walk me through that?');
  const c = iv.ctx('Can you walk me through that?');
  assert.equal(c.provisional, true);
  assert.ok(c.link.confidence < S.LINK_CONFIDENCE_THRESHOLD, String(c.link.confidence));
  const targets = c.interpretations.filter((i) => i.relation === 'follow_up').map((i) => threadNumber(iv.session, i.targetThreadId));
  assert.ok(targets.includes(1) && targets.includes(2), JSON.stringify(c.interpretations));
  assert.equal(c.interpretations.filter((i) => i.chosen).length, 1);
  assert.match(S.describeLink(iv.session, c), /\?.*alt: follow-up of #/);

  // The candidate's answer is about the hash map: thread 1.
  iv.say("You: Sure, so I stored each number's index in a hash map and looked up the complement for each element.");
  const after = iv.ctx('Can you walk me through that?');
  assert.equal(after.provisional, false);
  assert.equal(after.currentThread.number, 1);
  assert.equal(after.link.relation, 'follow_up');
  assert.ok(after.link.confidence >= S.LINK_CONFIDENCE_THRESHOLD);
  assert.match(after.question.resolution, /re-resolved/);
  // The old interpretation is kept as an alternative and the old link item is superseded.
  assert.ok(after.link.alternatives.some((a) => threadNumber(iv.session, a.targetThreadId) === 2));
  const linkItems = iv.session.items.filter((it) => it.type === 'inferred' && it.source.ref === 'thread-link' && it.questionId === after.question.id);
  assert.equal(linkItems.filter((it) => it.status === 'superseded').length, 1);
  assert.equal(linkItems.filter((it) => it.status === 'inferred').length, 1);
  // The answer line moved with the question; thread 2 is unanswered again.
  const t2 = iv.session.threads[1];
  assert.equal(t2.status, 'open');
  assert.equal(t2.candidateLineIds.length, 0);
  assert.ok(iv.session.threads[0].candidateLineIds.length >= 3);
});

test('an explicit transition settles a provisional link without moving it', () => {
  const iv = scriptedInterview();
  iv.say("Them: Okay, let's move on. Tell me about a time you disagreed with a teammate.");
  iv.say('Them: Can you walk me through that?');
  assert.equal(iv.ctx('Can you walk me through that?').provisional, true);
  iv.say("Them: Actually, never mind, let's move on.");
  const c = iv.ctx('Can you walk me through that?');
  assert.equal(c.provisional, false);
  assert.match(c.question.resolution, /transition/);
});

// ---- 5. explicit per-detail confirmation ----

test('only the details the candidate actually said become confirmed; the rest stay suggested', () => {
  const iv = interview();
  iv.say(`Them: ${TWO_SUM}`);
  iv.suggest('req-7', TWO_SUM, 'O(n) time, O(n) space using a hash map. Walk the array once and check for target minus the current number.');
  const sayIdx = iv.say("You: I'd use a hash map.");
  const c = iv.ctx(TWO_SUM);
  const confirmed = c.pinned.confirmedDetails;
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].text, 'hash map');
  assert.equal(confirmed[0].type, 'confirmed_detail');
  assert.equal(confirmed[0].status, 'confirmed');
  assert.equal(confirmed[0].suggestionId, 'req-7');
  assert.equal(confirmed[0].candidateLineIndex, sayIdx);
  assert.equal(confirmed[0].candidateText, "I'd use a hash map.");
  assert.deepEqual(confirmed[0].source, { kind: 'transcript', ref: sayIdx });

  const details = iv.session.items.filter((it) => it.type === 'echo_suggestion' && it.detail);
  const on = details.find((d) => d.text === 'O(n)');
  assert.ok(on, JSON.stringify(details.map((d) => d.text)));
  assert.equal(on.status, 'suggested');
  assert.equal(on.confirmedBy, null);
  assert.deepEqual(on.source, { kind: 'suggestion', ref: 'req-7' });
  // Never a candidate fact.
  const facts = [...c.pinned.candidateClaims, ...c.pinned.confirmedDetails, ...c.candidateStatements, ...c.sessionFacts.candidateClaims];
  assert.ok(!facts.some((f) => /O\(n\)/.test(f.text)));
  assert.ok(!iv.session.items.some((it) => it.type === 'candidate_statement' && /O\(n\)/.test(it.text)));

  // Saying it (in a spoken alias) later confirms O(n), with its own refs.
  const linIdx = iv.say("You: And that's linear time overall.");
  const c2 = iv.ctx(TWO_SUM);
  const on2 = c2.pinned.confirmedDetails.find((d) => d.text === 'O(n)');
  assert.ok(on2);
  assert.equal(on2.candidateLineIndex, linIdx);
  assert.equal(on2.matchedAlias, 'cx_n');
});

test('confirmation is conservative: aliases, negation, same thread only, only lines after the suggestion', () => {
  // Alias table.
  const ext = S.extractDetails('Sort it first, then use two pointers. O(n log n) overall, or BFS with a queue.');
  const byText = Object.fromEntries(ext.map((d) => [d.text, d]));
  assert.ok(byText['O(n log n)'] && byText['two pointers'] && byText.BFS && byText.sorting && byText.queue, JSON.stringify(ext.map((d) => d.text)));
  assert.ok(S.matchDetail(byText['O(n log n)'], "it's o of n log n because of the sort"));
  assert.ok(!S.matchDetail(S.extractDetails('O(n)')[0], 'o of n log n because of the sort'), 'O(n) must not match n log n');
  assert.ok(S.matchDetail(byText.BFS, "I'd do a breadth first search from the root"));
  assert.ok(!S.matchDetail(byText.sorting, "I wouldn't sort it, that's too slow"));
  assert.ok(!S.matchDetail(byText.sorting, 'instead of sorting I would hash'));
  assert.ok(!S.matchDetail(byText['two pointers'], 'two of the pointers'));
  // Numbers with units.
  const num = S.extractDetails('We cut reconciliation time by 40% and handled 50k transactions a day.');
  assert.ok(S.matchDetail(num.find((d) => d.text === '40%'), 'we cut it by about 40 percent'));
  assert.ok(!S.matchDetail(num.find((d) => d.text === '40%'), 'we cut it by 30 percent'));

  // Same thread only; lines before the suggestion don't count.
  const iv = interview();
  iv.say('Them: Tell me about a time you improved performance.');
  iv.say('You: We used Redis for caching at my internship.');
  iv.suggest('b1', 'Tell me about a time you improved performance.', 'Talk about adding a Redis cache and cutting latency by 40%.');
  assert.equal(iv.ctx().pinned.confirmedDetails.length, 0, 'a line spoken before the suggestion must not confirm it');
  iv.say("Them: Okay, let's move on. Next question. What's a hash map?");
  iv.say('You: A hash map maps keys to values, kind of like Redis, and lookups are 40% faster than nothing.');
  const t1 = iv.session.threads[0];
  assert.equal(t1.pinned.confirmedDetails.length, 0, 'a line in another thread must not confirm');
});

test('names from knowledge snippets are details; code is stored as suggested and never confirmed', () => {
  const iv = interview();
  iv.say('Them: Tell me about a project you are proud of.');
  const cv = { source: 'cv.md', index: 0, text: 'Built Ledgerly, a payments reconciliation service in Django at Kobo.' };
  iv.suggest('k1', 'Tell me about a project you are proud of.', 'Talk about Ledgerly, the reconciliation service you built at Kobo.\n\n```python\ndef reconcile(a, b):\n    return a == b\n```', [cv]);
  const names = iv.session.items.filter((it) => it.detail && it.detail.kind === 'name').map((it) => it.text);
  assert.deepEqual(names.sort(), ['Kobo', 'Ledgerly']);
  iv.say('You: Sure, so Ledgerly was a reconciliation service, and the code was mostly a reconcile function.');
  const c = iv.ctx();
  assert.deepEqual(c.pinned.confirmedDetails.map((d) => d.text), ['Ledgerly']);
  assert.ok(c.code);
  assert.equal(c.code.status, 'suggested');
  assert.equal(c.code.type, 'echo_suggestion');
  // The snippet itself is a candidate fact from knowledge, verbatim, with its file.
  const k = c.knowledgeSources;
  assert.deepEqual(k, [{ source: 'cv.md', index: 0, text: cv.text }]);
  const kItem = iv.session.items.find((it) => it.source.kind === 'knowledge');
  assert.equal(kItem.type, 'candidate_statement');
  assert.equal(kItem.text, cv.text);
  assert.equal(kItem.source.ref, 'cv.md');
  // A newer code block supersedes the older one.
  iv.suggest('k2', 'Tell me about a project you are proud of.', '```python\nprint(1)\n```');
  const codes = iv.session.items.filter((it) => it.detail && it.detail.kind === 'code');
  assert.deepEqual(codes.map((x) => x.status), ['superseded', 'suggested']);
});

// ---- 6. candidate claims, interviewer facts, constraints ----

test('candidate claims, interviewer facts and constraints are labels on verbatim, correctly sourced items', () => {
  const iv = interview();
  const factIdx = iv.say('Them: We use Go on the backend, and our team owns the payments platform.');
  iv.say('Them: Given a sorted array of integers, find two numbers that sum to a target.');
  const a1 = iv.say('Them: Assume the array fits in memory.');
  const a2 = iv.say("Them: You can't use extra space.");
  const claimIdx = iv.say('You: At my last internship I built the payments reconciliation service in Django.');
  iv.say("You: For this I'd use two pointers from both ends.");

  const c = iv.ctx();
  const fact = c.sessionFacts.interviewerFacts.find((f) => f.source.ref === factIdx);
  assert.ok(fact);
  assert.equal(fact.type, 'interviewer_statement');
  assert.equal(fact.status, 'stated');
  assert.equal(fact.text, 'We use Go on the backend, and our team owns the payments platform.');
  const factLabel = fact.labels.find((l) => l.label === 'interviewer_fact');
  assert.ok(factLabel.confidence > 0 && factLabel.confidence < 1);
  assert.equal(factLabel.source.kind, 'rule');

  const cons = c.pinned.constraints;
  assert.deepEqual(cons.map((x) => x.source.ref), [a1, a2]);
  for (const x of cons) {
    assert.equal(x.type, 'interviewer_statement');
    assert.equal(x.source.kind, 'transcript');
    assert.ok(x.labels.some((l) => l.label === 'constraint' && l.source.kind === 'rule' && l.confidence > 0));
  }
  assert.equal(cons[1].text, "You can't use extra space.");
  assert.ok(c.pinned.problemStatement.some((p) => /Given a sorted array/.test(p.text)));

  const claims = c.pinned.candidateClaims;
  assert.equal(claims.length, 1);
  assert.equal(claims[0].type, 'candidate_statement');
  assert.equal(claims[0].status, 'stated');
  assert.equal(claims[0].text, 'At my last internship I built the payments reconciliation service in Django.');
  assert.deepEqual(claims[0].source, { kind: 'transcript', ref: claimIdx });
  assert.ok(claims[0].labels.some((l) => l.label === 'candidate_claim'));
  // A hypothetical answer is a candidate statement, not a claim.
  assert.equal(c.candidateStatements.length, 2);
});

// ---- 7. session reset ----

test('the session resets when the transcript restarts, keeps going when only the oldest lines were trimmed, and on resetSession()', () => {
  const iv = scriptedInterview();
  const gen = iv.session.generation;
  assert.equal(iv.session.threads.length, 1);
  // Oldest line trimmed (renderer cap in a huge session): same session.
  S.ingestTranscript(iv.session, iv.lines.slice(1).concat(['Them: What is the space complexity?']).join('\n'));
  assert.equal(iv.session.generation, gen);
  assert.equal(iv.session.questions.length, 2);
  assert.equal(iv.session.questions[1].lineIndex, iv.lines.length);
  // Cleared transcript / new listening session: fresh state.
  S.ingestTranscript(iv.session, 'Them: Tell me about yourself.');
  assert.equal(iv.session.generation, gen + 1);
  assert.equal(iv.session.threads.length, 1);
  assert.equal(iv.session.threads[0].type, 'experience');
  assert.equal(iv.session.suggestions.length, 0);
  // A suggestion from before the reset is ignored.
  assert.equal(S.recordSuggestion(iv.session, { requestId: 'old', text: 'Use a hash map.', generation: gen }), null);
  // Empty transcript = cleared.
  S.ingestTranscript(iv.session, '');
  assert.equal(iv.session.items.length, 0);
  // Explicit reset (Stop listening).
  S.ingestTranscript(iv.session, 'Them: Tell me about yourself.');
  S.resetSession(iv.session);
  assert.equal(iv.session.items.length, 0);
  assert.equal(iv.session.threads.length, 0);
  // Re-ingesting the same transcript rebuilds the same structure.
  const again = scriptedInterview();
  S.resetSession(again.session);
  S.ingestTranscript(again.session, again.text());
  assert.equal(again.session.threads.length, 1);
  assert.equal(again.session.threads[0].candidateLineIds.length, 2);
});

test('a question split across two "Them" lines is one question', () => {
  const iv = interview();
  iv.say('Them: Given an array of integers and a target, can you find the');
  iv.say('Them: two numbers that add up to it?');
  assert.equal(iv.session.questions.length, 1);
  assert.equal(iv.session.threads.length, 1);
  const joined = 'Given an array of integers and a target, can you find the two numbers that add up to it?';
  assert.equal(iv.ctx(joined).question.id, iv.session.questions[0].id);
});

// ---- 8. schema ----

test('every stored item has the required fields with a valid type, status and source', () => {
  const iv = scriptedInterview();
  for (const q of ['Why a hash map instead of sorting?', "What's the space complexity?"]) {
    iv.say(`Them: ${q}`);
    iv.say("You: It's O(n) space because of the hash map.");
  }
  iv.say('Them: We use Go on the backend. Assume the input fits in memory.');
  iv.say("Them: Okay, let's move on. Tell me about a time you disagreed with a teammate.");
  iv.say('Them: Can you walk me through that?');
  iv.say('You: Sure, so I stored each index in a hash map and looked up the complement.');
  iv.say('Them: Going back to your solution, how would you handle a stream?');
  iv.suggest('s9', 'Going back to your solution, how would you handle a stream?', 'Keep the hash map and process numbers as they arrive; O(1) per element.', [{ source: 'cv.md', index: 2, text: 'Stream processing with Kafka.' }]);
  iv.say("You: I'd keep the hash map and check each new number as it arrives, so O(1) per element.");

  assert.ok(iv.session.items.length > 20);
  const ids = new Set();
  for (const it of iv.session.items) {
    assert.equal(typeof it.id, 'string');
    assert.ok(!ids.has(it.id), `duplicate id ${it.id}`);
    ids.add(it.id);
    assert.ok(S.ITEM_TYPES.includes(it.type), it.type);
    assert.ok(S.ITEM_STATUSES.includes(it.status), it.status);
    assert.equal(typeof it.text, 'string');
    assert.ok(it.threadId === null || iv.session.threads.some((t) => t.id === it.threadId), `${it.id} threadId ${it.threadId}`);
    assert.ok(it.source && S.SOURCE_KINDS.includes(it.source.kind), JSON.stringify(it.source));
    assert.ok(it.source.ref !== undefined && it.source.ref !== null && it.source.ref !== '', JSON.stringify(it));
    if (it.source.kind === 'transcript') assert.equal(typeof it.source.ref, 'number');
    assert.equal(typeof it.order, 'number');
    assert.equal(typeof it.timestamp, 'number');
    assert.ok(Array.isArray(it.labels));
    for (const l of it.labels) {
      assert.equal(typeof l.label, 'string');
      assert.ok(l.confidence >= 0 && l.confidence <= 1);
      assert.equal(l.source.kind, 'rule');
    }
    if (it.type === 'inferred') {
      assert.ok(it.status === 'inferred' || it.status === 'superseded');
      assert.equal(it.source.kind, 'rule');
      assert.ok(typeof it.confidence === 'number' && it.confidence >= 0 && it.confidence <= 1, JSON.stringify(it));
    }
    // Source/type/status consistency.
    if (it.type === 'interviewer_statement') assert.equal(it.source.kind, 'transcript');
    if (it.type === 'candidate_statement') assert.ok(['transcript', 'knowledge'].includes(it.source.kind));
    if (it.type === 'echo_suggestion') {
      assert.equal(it.source.kind, 'suggestion');
      assert.ok(it.status === 'suggested' || it.status === 'superseded');
    }
    if (it.type === 'confirmed_detail') {
      assert.equal(it.source.kind, 'transcript');
      assert.ok(it.status === 'confirmed' || it.status === 'superseded');
      assert.ok(it.suggestionId && it.candidateLineId && Number.isInteger(it.candidateLineIndex));
    }
  }
  const orders = iv.session.items.map((it) => it.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  for (const t of iv.session.threads) {
    assert.ok(S.THREAD_TYPES.includes(t.type));
    assert.ok(['open', 'answered', 'merged'].includes(t.status));
    assert.ok(t.typeConfidence > 0 && t.typeConfidence <= 1);
  }
  for (const q of iv.session.questions) {
    assert.ok(['new', 'follow_up'].includes(q.link.relation));
    assert.ok(q.link.confidence >= 0 && q.link.confidence <= 1);
    assert.ok(Array.isArray(q.link.alternatives) && Array.isArray(q.link.reasons));
    for (const a of q.link.alternatives) assert.ok(['new', 'follow_up'].includes(a.relation) && typeof a.score === 'number');
  }
});

// ---- 9. knowledge query with a fixture knowledge base ----

const CV = `# Sam Rivera

### Ledgerly (payments reconciliation, Kobo, 2025)
Built Ledgerly, a payments reconciliation service in Django at Kobo. It matched about 50k transactions a day against bank statements and cut manual reconciliation from 6 hours to 20 minutes. I disagreed with a teammate about running the nightly job on Celery versus a cron script; we agreed to benchmark both for a week, and Celery won on retries and monitoring.

### Orbit (satellite telemetry dashboard, 2026)
Built Orbit, a React and FastAPI dashboard that streams satellite telemetry from a simulator and flags anomalies with a rolling z-score. It handled 200 messages a second, and after tuning thresholds with the research group alert noise dropped by 35 percent. Deployed with Docker on a lab server, with PostgreSQL for history and a small alerting service that pages on sustained drift rather than single spikes. The hardest part was replaying recorded passes deterministically so threshold changes could be compared side by side before rolling them out.

### Interests
I like to learn new languages, play chess and tutor first-year students in Java and Python.
`;

fs.mkdirSync(path.join(userData, 'knowledge'), { recursive: true });
fs.writeFileSync(path.join(userData, 'knowledge', 'cv.md'), CV);
knowledge.loadKnowledgeBase();
const chunkOf = (snippets, word) => snippets.find((s) => s.text.includes(word));

test('fixture knowledge base: one chunk per story', () => {
  const status = knowledge.getStatus();
  assert.equal(status.fileCount, 1);
  assert.ok(status.chunkCount >= 3, String(status.chunkCount));
});

test('behavioural follow-up "What did you learn from it?" searches with the thread\'s question and what the candidate said, and finds the same story', () => {
  const iv = interview();
  const original = 'Tell me about a time you disagreed with a teammate.';
  iv.say(`Them: ${original}`);
  // The original question's own search finds the Ledgerly story.
  const firstPlan = S.planKnowledgeSearch(iv.session, { transcript: iv.text(), question: original, mode: 'interview' });
  const firstSnippets = knowledge.searchKnowledge(firstPlan.query);
  assert.equal(firstPlan.query, original);
  assert.ok(chunkOf(firstSnippets.slice(0, 1), 'Ledgerly'), firstSnippets.map((s) => s.text.slice(0, 30)).join(' | '));
  // Echo's answer mentions things the candidate never says (Orbit, PostgreSQL).
  S.recordSuggestion(iv.session, {
    requestId: 'r1', question: original, afterLine: firstPlan.afterLine, generation: firstPlan.generation,
    text: 'Use the Ledgerly story, or Orbit if you prefer. Mention PostgreSQL and the 35 percent drop.',
    knowledgeSources: firstSnippets,
  });
  iv.say('You: Sure. At Kobo I disagreed with a teammate about running the Ledgerly nightly job on Celery or cron.');
  iv.say('You: We benchmarked both for a week and went with Celery.');
  const follow = 'What did you learn from it?';
  iv.say(`Them: ${follow}`);

  const plan = S.planKnowledgeSearch(iv.session, { transcript: iv.text(), question: follow, mode: 'interview' });
  assert.equal(plan.link.relation, 'follow_up');
  assert.ok(plan.query.startsWith(follow));
  assert.ok(plan.query.includes(original), plan.query);
  for (const said of ['Kobo', 'Ledgerly', 'Celery']) assert.ok(plan.query.includes(said), `${said} missing: ${plan.query}`);
  for (const notSaid of ['Orbit', 'PostgreSQL', '35']) assert.ok(!plan.query.includes(notSaid), `${notSaid} leaked: ${plan.query}`);
  assert.ok(plan.prefer.some((p) => p.source === 'cv.md'), 'snippets used for this thread are preferred');

  // Old behaviour: the bare follow-up finds nothing relevant to the story.
  const oldSnippets = knowledge.searchKnowledge(plan.legacyQuery);
  assert.equal(plan.legacyQuery, follow);
  assert.ok(!chunkOf(oldSnippets, 'Ledgerly'), 'old query should not find the story');
  // New behaviour: the same story's chunk, first.
  const newSnippets = knowledge.searchKnowledge(plan.query, undefined, { prefer: plan.prefer });
  assert.ok(newSnippets.length > 0);
  assert.ok(newSnippets[0].text.includes('Ledgerly'), newSnippets.map((s) => s.text.slice(0, 30)).join(' | '));
  assert.equal(newSnippets[0].index, firstSnippets[0].index);
});

test('technical follow-up query adds the problem statement and confirmed details, never unconfirmed ones', () => {
  const iv = scriptedInterview();
  iv.say('Them: What if the input is a stream?');
  const q = iv.ctx('What if the input is a stream?');
  assert.equal(q.currentThread.number, 1);
  const query = S.buildKnowledgeQuery(iv.session, 'What if the input is a stream?');
  assert.ok(query.includes(TWO_SUM), query);
  assert.ok(query.includes('hash map'), query); // confirmed by "I'd use a hash map"
  assert.ok(!/O\(n\)/.test(query), query); // suggested only
});

test('searchKnowledge: no opts / empty prefer = the old ranking; prefer only boosts chunks that still match', () => {
  const qy = 'satellite telemetry and reconciliation';
  const base = knowledge.searchKnowledge(qy);
  assert.deepEqual(knowledge.searchKnowledge(qy, 4, { prefer: [] }).map((s) => [s.source, s.index]), base.map((s) => [s.source, s.index]));
  assert.deepEqual(knowledge.searchKnowledge(qy, undefined, undefined).map((s) => s.score), base.map((s) => s.score));
  const second = base[1];
  const boosted = knowledge.searchKnowledge(qy, 4, { prefer: [{ source: second.source, index: second.index }] });
  assert.equal(boosted[0].index, second.index);
  // A preferred chunk that doesn't match the query is not pulled in.
  const interests = knowledge.searchKnowledge('learn chess')[0];
  const unrelated = knowledge.searchKnowledge('satellite telemetry', 4, { prefer: [{ source: interests.source, index: interests.index }] });
  assert.ok(!unrelated.some((s) => s.index === interests.index));
  assert.ok(knowledge.searchKnowledge(qy, 1).length === 1);
});

// ---- Regression: answers for plain questions are unchanged ----

function promptFor(transcript, question, knowledgeSnippets) {
  return ai.buildConversationText({
    transcript, question, knowledgeSnippets, previousAnswers: [], mode: 'interview', kind: 'general', intent: 'behavioural_question',
  });
}

test('regression: a plain interview question gets byte-identical knowledge and prompt to before', () => {
  for (const question of ['Tell me about a time you disagreed with a teammate.', TWO_SUM, 'Tell me about yourself.']) {
    const transcript = `Them: ${question}`;
    const session = S.createSession();
    const plan = S.planKnowledgeSearch(session, { transcript, question, mode: 'interview' });
    const legacyQuery = S.legacySearchQuery({ question, transcript });
    assert.equal(plan.query, legacyQuery, question);
    assert.deepEqual(plan.prefer, []);
    const before = knowledge.searchKnowledge(legacyQuery);
    const after = knowledge.searchKnowledge(plan.query);
    assert.deepEqual(after, before);
    assert.equal(promptFor(transcript, question, after), promptFor(transcript, question, before));
  }
});

test('regression: outside Interview mode, and with no question, the knowledge query is the old one', () => {
  const iv = scriptedInterview();
  iv.say('Them: What if there are duplicates?');
  for (const mode of ['meeting', 'general', 'presentation', undefined]) {
    const plan = S.planKnowledgeSearch(iv.session, { transcript: iv.text(), question: 'What if there are duplicates?', mode });
    assert.equal(plan.query, 'What if there are duplicates?', String(mode));
    assert.deepEqual(plan.prefer, []);
  }
  // Shorten / Expand without a question: the instruction, as before.
  const shorten = S.planKnowledgeSearch(iv.session, { transcript: iv.text(), instruction: 'Make this shorter', mode: 'interview' });
  assert.equal(shorten.query, 'Make this shorter');
  // No session state at all (screenshot-only request): the last line, as before.
  const empty = S.planKnowledgeSearch(S.createSession(), { transcript: '', mode: 'interview' });
  assert.equal(empty.query, '');
  const legacy = S.extractSearchQuery('You: hello\nThem: so what do you think?');
  assert.equal(legacy, 'so what do you think?');
});

test('planKnowledgeSearch is cheap: a 400-line interview plans in well under 50 ms per request', () => {
  const iv = interview();
  const qs = [TWO_SUM, 'Why a hash map?', "What's the space complexity?", "Okay, let's move on. Tell me about a time you failed.", 'What was the outcome?'];
  for (let i = 0; i < 80; i++) {
    for (const q of qs) iv.lines.push(`Them: ${q}`, `You: Answer number ${i} about the hash map and the team at Kobo.`);
  }
  const transcript = iv.lines.join('\n');
  const session = S.createSession();
  S.planKnowledgeSearch(session, { transcript, question: 'What was the outcome?', mode: 'interview' });
  const t0 = process.hrtime.bigint();
  const plan = S.planKnowledgeSearch(session, { transcript: `${transcript}\nThem: Why a hash map?`, question: 'Why a hash map?', mode: 'interview' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(plan.query);
  assert.ok(ms < 50, `${ms} ms`);
});
