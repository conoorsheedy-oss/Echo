// Unit tests for the intent layer (src/renderer/intent-core.js): intent
// labels for realistic lines, needsResponse per mode, the auto-trigger gate
// (interview must trigger exactly like question-core's looksLikeQuestion)
// and the NO_RESPONSE sentinel helpers.
// Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const intent = require('../src/renderer/intent-core.js');
const question = require('../src/renderer/question-core.js');

const label = (text, ctx = {}) => intent.classifyIntent(text, { mode: 'meeting', speaker: 'them', ...ctx }).intent;
const needs = (mode, text, ctx = {}) => intent.classifyIntent(text, { mode, speaker: 'them', ...ctx }).needsResponse;
const RECENT_YOU = { recentYou: { themLinesSince: 1, msSince: 5000 } };

const CASES = {
  opinion_request: [
    'What do you think?',
    'What do you think about moving the launch to March?',
    'Sarah what do you think',
    'How do you feel about the new pricing?',
    'Any thoughts on the roadmap?',
    'Thoughts?',
    'Would you agree that onboarding is the bottleneck?',
    "What's your take on hiring a contractor?",
    'Do you think we should delay the release?',
    'Should we just ship it?',
    "What's your view on this?",
    'Are you okay with that plan?',
  ],
  disagreement: [
    "I don't think that'll work.",
    "I don't think that will work for enterprise customers.",
    'I disagree.',
    "Honestly, I'm not sure about that.",
    "I'm not convinced the numbers support it.",
    "That won't scale past a few hundred users.",
    'The problem with that is we lose the audit trail.',
    'But what about latency?',
    "I'd push back on that a little.",
    "That's not how the billing system works.",
    "I have some concerns about the timeline.",
    "I'm a bit skeptical, to be honest.",
  ],
  proposal: [
    'What if we cached the results?',
    'I suggest we split this into two tickets.',
    'I propose we move standup to 10.',
    'How about we try it with one customer first?',
    "Let's use Redis for this.",
    'We could just drop the feature for now.',
    'Maybe we should ask legal first.',
    'I think we should push the launch by a week.',
    "Why don't we pair on it tomorrow?",
    'One option is to buy instead of build.',
  ],
  suggestion_request: [
    'Any ideas?',
    'Any suggestions for the name?',
    'What would you suggest?',
    'What would you recommend for monitoring?',
    'How should we handle the migration?',
    'What should we do about the churn numbers?',
    'Where should we start?',
    "What's the best way to onboard the new hires?",
    'What are our options here?',
  ],
  clarification_request: [
    'What do you mean?',
    'What do you mean by that?',
    'Can you clarify the second point?',
    'Could you explain what you meant by phase two?',
    'Sorry, did you say Tuesday or Thursday?',
    'Can you repeat that?',
    "Sorry, I didn't catch that.",
  ],
  explanation_request: [
    'Can you explain how the sync job works?',
    'Walk me through the rollout plan.',
    'Talk us through the numbers.',
    'How does the approval flow work?',
    "What's the difference between the two plans?",
    'Help me understand why the costs went up.',
  ],
  behavioural_question: [
    'Tell me about a time you failed.',
    'Tell me about yourself.',
    'Describe a situation where you had to deal with a difficult stakeholder.',
    'Give me an example of when you showed leadership.',
    'How do you handle conflict in a team?',
    "What's your greatest weakness?",
    'Why do you want to work here?',
    'Where do you see yourself in five years?',
    'Walk me through your resume.',
    'Have you ever disagreed with your manager?',
  ],
  problem: [
    "We're blocked on the API keys.",
    'The issue is the vendor keeps changing the schema.',
    'The deploy keeps failing.',
    'We have a problem with the payments integration.',
    'Staging is down again.',
    "The export still isn't working.",
    "We're running behind on the design work.",
    "There's a bug in the invoice totals.",
  ],
  information_sharing: [
    'Just so you know, the release is on Friday.',
    'FYI the client moved the meeting.',
    'Quick update: the contract is signed.',
    'We shipped the new onboarding flow last week.',
    'Okay so the numbers look good this quarter.',
    'Revenue is down five percent this quarter.',
    "Let's move on to the next item.",
    "Let's say we have a million users.",
    'I talked to the vendor yesterday.',
  ],
  no_response: [
    '',
    'Okay.',
    'Yeah.',
    'Mm-hmm.',
    'Uh huh',
    'Sounds good, thanks.',
    'That makes sense.',
    'Got it.',
    'Right?',
    'Cool cool.',
    'Thank you so much!',
    'Great.',
    'Hmm.',
  ],
  technical_question: [
    'Reverse a linked list.',
    'Write a function that checks if a string is a palindrome.',
    'What is the probability of rolling two sixes with two dice?',
    'Design a URL shortener.',
    'Given an array of integers, return the two numbers that add up to a target.',
  ],
  direct_question: [
    'When is the deadline?',
    'Who owns the vendor relationship?',
    'Is the budget approved?',
    'Why?',
    'How did you get into data science?',
    'Have you used Figma before?',
  ],
};

test('classifyIntent: realistic lines get the right intent', () => {
  for (const [expected, lines] of Object.entries(CASES)) {
    for (const line of lines) assert.equal(label(line), expected, `${JSON.stringify(line)} -> ${expected}`);
  }
});

test('classifyIntent: follow-ups need something to follow', () => {
  const afterCode = { prior: { hasPriorAnswer: true, lastAnswerTechnical: true } };
  assert.equal(label('Why did you use a hash map?', afterCode), 'follow_up');
  assert.equal(label("What's the time complexity?", afterCode), 'follow_up');
  assert.equal(label('What if the input is empty?', afterCode), 'follow_up');
  assert.equal(label('Tell me more.', { prior: { hasPriorAnswer: true } }), 'follow_up');
  assert.equal(label('How so?', RECENT_YOU), 'follow_up');
  assert.equal(label('Can you expand on that?', RECENT_YOU), 'follow_up');
  // Nothing said before: not a follow-up.
  assert.notEqual(label('Tell me more.'), 'follow_up');
});

test('classifyIntent: technical flag, confidence and curly apostrophes', () => {
  const r = intent.classifyIntent('Write a function to reverse a linked list.', { mode: 'interview', speaker: 'them' });
  assert.equal(r.technical, true);
  assert.equal(r.confidence, 'high');
  assert.equal(intent.classifyIntent('What do you think about the roadmap?', { mode: 'meeting' }).technical, false);
  assert.equal(label('I don’t think that’ll work.'), 'disagreement');
  assert.equal(label('What’s your take?'), 'opinion_request');
  assert.equal(intent.classifyIntent('When is the deadline', { mode: 'meeting' }).confidence, 'low', 'no "?" -> low');
  assert.equal(intent.classifyIntent('When is the deadline?', { mode: 'meeting' }).confidence, 'high');
  for (const r2 of [intent.classifyIntent('Okay.', {}), intent.classifyIntent('Let us see what happens with these lines over here today', {})]) {
    assert.ok(intent.INTENTS.includes(r2.intent));
    assert.ok(intent.CONFIDENCES.includes(r2.confidence));
    assert.equal(typeof r2.needsResponse, 'boolean');
  }
});

test('needsResponse: meeting', () => {
  for (const kind of ['opinion_request', 'suggestion_request', 'clarification_request', 'explanation_request', 'proposal', 'problem', 'direct_question', 'technical_question']) {
    for (const line of CASES[kind]) assert.equal(needs('meeting', line), true, `${kind}: ${line}`);
  }
  for (const kind of ['information_sharing', 'no_response']) {
    for (const line of CASES[kind]) assert.equal(needs('meeting', line), false, `${kind}: ${line}`);
  }
  // Disagreement: only when it plausibly answers the user.
  assert.equal(needs('meeting', "I don't think that'll work."), false, 'nobody heard from the user yet');
  assert.equal(needs('meeting', "I don't think that'll work.", RECENT_YOU), true, 'the user just spoke');
  assert.equal(needs('meeting', "I don't think that'll work.", { recentYou: { themLinesSince: 5, msSince: 5000 } }), false, 'several lines ago');
  assert.equal(needs('meeting', "I don't think that'll work.", { recentYou: { themLinesSince: 1, msSince: 120_000 } }), false, 'two minutes ago');
  assert.equal(needs('meeting', "I don't think that'll work.", { lastYouLine: { themLinesSince: 2, msSince: 30_000 } }), true, 'lastYouLine alias');
  assert.equal(needs('meeting', "I'm not convinced, what do you think?"), true, 'asks the user directly');
  assert.equal(needs('meeting', 'But what about latency?'), true, 'a question to the room');
});

test('needsResponse: presentation answers questions, not proposals or problems', () => {
  for (const kind of ['direct_question', 'explanation_request', 'clarification_request', 'opinion_request', 'technical_question']) {
    for (const line of CASES[kind]) assert.equal(needs('presentation', line), true, `${kind}: ${line}`);
  }
  for (const kind of ['proposal', 'problem', 'information_sharing', 'no_response']) {
    for (const line of CASES[kind].filter((l) => !question.looksLikeQuestion(l) || kind === 'no_response')) {
      assert.equal(needs('presentation', line), false, `${kind}: ${line}`);
    }
  }
  assert.equal(needs('presentation', "I don't think that'll work.", RECENT_YOU), false);
});

test('needsResponse: general answers questions, opinions, ideas and disagreement', () => {
  for (const kind of ['direct_question', 'opinion_request', 'suggestion_request', 'explanation_request', 'clarification_request']) {
    for (const line of CASES[kind]) assert.equal(needs('general', line), true, `${kind}: ${line}`);
  }
  for (const line of CASES.disagreement) assert.equal(needs('general', line), true, line);
  assert.equal(needs('general', "Let's use Redis for this."), false);
  assert.equal(needs('general', "We're blocked on the API keys."), false);
  for (const line of [...CASES.information_sharing, ...CASES.no_response]) assert.equal(needs('general', line), false, line);
});

// Interview mode must trigger exactly as before the intent layer.
const INTERVIEW_LINES = [
  ...Object.values(CASES).flat(),
  'What is the time complexity of your approach',
  'why did you use a hash map',
  'Let\'s say we have a million users.',
  'So the first thing I noticed was the cache.',
  'Okay?',
  'Hmm, interesting.',
  'Great, thanks for that.',
  'and the',
  'I’m curious how you’d scale it',
  'Any edge cases',
  'Give me an example of a hard bug you fixed.',
  'We use Kafka for events.',
];

test('interview: needsResponse === looksLikeQuestion for every line (trigger unchanged)', () => {
  for (const line of INTERVIEW_LINES) {
    const r = intent.classifyIntent(line, { mode: 'interview', speaker: 'them' });
    assert.equal(r.needsResponse, question.looksLikeQuestion(line), JSON.stringify(line));
    assert.equal(intent.shouldAutoTrigger(r, { mode: 'interview', speaker: 'them' }), question.looksLikeQuestion(line), JSON.stringify(line));
  }
  // Prior answers / recency don't change interview triggering either.
  for (const line of INTERVIEW_LINES) {
    const r = intent.classifyIntent(line, { mode: 'interview', speaker: 'them', prior: { hasPriorAnswer: true, lastAnswerTechnical: true }, ...RECENT_YOU });
    assert.equal(r.needsResponse, question.looksLikeQuestion(line), JSON.stringify(line));
  }
});

test('shouldAutoTrigger: never on the user\'s own lines, only when needed', () => {
  for (const mode of intent.MODES) {
    for (const line of ['What do you think?', "I don't think that'll work.", 'Any ideas?']) {
      const mine = intent.classifyIntent(line, { mode, speaker: 'you', ...RECENT_YOU });
      assert.equal(mine.needsResponse, false, `${mode}: You: ${line}`);
      assert.equal(intent.shouldAutoTrigger(mine, { mode, speaker: 'you' }), false);
      const theirs = intent.classifyIntent(line, { mode, speaker: 'them', ...RECENT_YOU });
      assert.equal(intent.shouldAutoTrigger(theirs, { mode, speaker: 'You' }), false, 'speaker is checked again');
    }
  }
  const info = intent.classifyIntent('FYI the client moved the meeting.', { mode: 'meeting', speaker: 'them' });
  assert.equal(intent.shouldAutoTrigger(info, { mode: 'meeting', speaker: 'them' }), false);
  const disagree = intent.classifyIntent("I don't think that'll work.", { mode: 'meeting', speaker: 'them', ...RECENT_YOU });
  assert.equal(intent.shouldAutoTrigger(disagree, { mode: 'meeting', speaker: 'them' }), true);
  assert.equal(intent.shouldAutoTrigger(null, { speaker: 'them' }), false);
});

test('modes: allowlist, unknown -> general', () => {
  assert.deepEqual([...intent.MODES], ['interview', 'meeting', 'presentation', 'general']);
  for (const m of intent.MODES) assert.equal(intent.normalizeMode(m), m);
  for (const bad of ['', 'Meeting', '__proto__', 'constructor', null, undefined, 42, 'x'.repeat(60)]) {
    assert.equal(intent.normalizeMode(bad), 'general', String(bad));
  }
  // An unknown mode behaves like general.
  assert.equal(needs('mystery', "I don't think that'll work."), true);
  assert.equal(needs('mystery', "Let's use Redis."), false);
  assert.equal(intent.isIntent('disagreement'), true);
  assert.equal(intent.isIntent('__proto__'), false);
  assert.equal(intent.isIntent(undefined), false);
});

test('sentinel: detected at the start only, tolerant of quotes / backticks / casing', () => {
  const S = intent.NO_RESPONSE_SENTINEL;
  assert.equal(S, '[[NO_RESPONSE]]');
  for (const t of [S, ` ${S}`, `${S}\n`, '`[[NO_RESPONSE]]`', '"[[NO_RESPONSE]]"', '[NO_RESPONSE]', 'NO_RESPONSE', 'no_response', '**[[NO_RESPONSE]]**']) {
    assert.equal(intent.isNoResponse(t), true, t);
  }
  for (const t of ['', 'No, I think we should wait.', 'Not sure yet.', 'I would say no response is needed', 'Nope.', '[link]']) {
    assert.equal(intent.isNoResponse(t), false, t);
  }
  // Streaming: undecided while it could still become the sentinel.
  for (const p of ['', ' ', '[', '[[', '[[NO', '[[NO_RESP', 'N', 'NO', 'NO_R', '`']) assert.equal(intent.sentinelState(p), 'maybe', JSON.stringify(p));
  for (const p of ['I', 'No,', 'Not', 'Yeah', '[l', 'So']) assert.equal(intent.sentinelState(p), 'no', JSON.stringify(p));
  assert.equal(intent.sentinelState('[[NO_RESPONSE'), 'yes');
});

test('looksTechnical / classifyQuestion are the same functions ai.js exports', () => {
  require('./helpers/electron-stub');
  const ai = require('../src/main/ai');
  assert.equal(ai.looksTechnical, intent.looksTechnical);
  assert.equal(ai.classifyQuestion, intent.classifyQuestion);
});
