// Unit tests for the early start on Deepgram interim text and the trigger
// labels (src/renderer/early-start-core.js): when an interviewer's
// in-progress utterance may start an automatic answer, whether the final
// line keeps or restarts it, the CALM swap rule, and which end-of-speech
// signal released a line. Pure, no DOM, no network.
// Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../src/renderer/early-start-core');

// A stable, complete interview question from the system audio, 400 ms after
// the last interim change.
function opts(text, extra = {}) {
  return {
    text,
    lastChangeAt: 1000,
    now: 1000 + E.EARLY_START_MS + 50,
    speaker: 'Them',
    provider: 'deepgram',
    privacy: false,
    confidence: 0.95,
    mode: 'interview',
    intentCtx: { prior: { hasPriorAnswer: false, lastAnswerTechnical: false }, recentYou: null },
    ...extra,
  };
}
const fires = (text, extra) => E.shouldEarlyStart(opts(text, extra));

test('fires once a complete question has been stable for EARLY_START_MS', () => {
  assert.equal(E.EARLY_START_MS, 350);
  for (const q of [
    'What is your biggest weakness?',
    'Tell me about a time you disagreed with a teammate.',
    'Walk me through your resume',
    'How would you design a URL shortener',
    'Write a function that reverses a linked list.',
    'Tell me about yourself',
  ]) {
    const d = fires(q);
    assert.equal(d.fire, true, `${q}: ${d.reason}`);
    assert.ok(d.intent && d.intent.needsResponse, q);
  }
  // Exactly at the threshold counts; 1 ms before doesn't.
  assert.equal(fires('What is your biggest weakness?', { now: 1000 + E.EARLY_START_MS }).fire, true);
  const early = fires('What is your biggest weakness?', { now: 1000 + E.EARLY_START_MS - 1 });
  assert.deepEqual([early.fire, early.reason], [false, 'still-talking']);
});

test('does not fire on incomplete / trailing utterances, short or low-confidence text, or statements', () => {
  const no = (text, reason, extra) => {
    const d = fires(text, extra);
    assert.equal(d.fire, false, text);
    assert.equal(d.reason, reason, `${text}: ${d.reason}`);
  };
  no('How would you design', 'incomplete'); // a pause mid-sentence, no punctuation
  no('How would you design a', 'incomplete');
  no('Tell me about a time when you', 'incomplete');
  no('So the system has a cache and', 'incomplete');
  no('What would you do if...', 'incomplete');
  no('Can you walk me through, um', 'incomplete');
  no('Why that one?', 'too-short');
  no('Tell me more?', 'too-short');
  no('What is your biggest weakness?', 'low-confidence', { confidence: 0.3 });
  no("Let's say we have a million users.", 'not-needed'); // a set-up, the question follows
  no('Thanks, that sounds good to me.', 'not-needed');
  // No confidence from Deepgram: not required.
  assert.equal(fires('What is your biggest weakness?', { confidence: null }).fire, true);
});

test('never fires for "You", in Privacy Mode, on Groq, or for explicit requests', () => {
  const q = 'What is your biggest weakness?';
  assert.equal(fires(q, { speaker: 'You' }).reason, 'not-them');
  assert.equal(fires(q, { privacy: true }).reason, 'privacy');
  assert.equal(fires(q, { provider: 'groq' }).reason, 'provider');
  assert.equal(fires(q, { explicit: true }).reason, 'explicit');
  assert.equal(fires('', {}).reason, 'empty');
});

test('mode matters: meeting fires on a proposal, interview does not', () => {
  const text = 'What if we moved the cache in front of the database.';
  assert.equal(fires(text, { mode: 'meeting' }).fire, true);
  const interviewProposal = 'I think we should move the cache in front of the database.';
  assert.equal(fires(interviewProposal, { mode: 'interview' }).fire, false);
  assert.equal(fires(interviewProposal, { mode: 'meeting' }).fire, true);
});

test('reconcileFinal: punctuation, case and filler differences keep the request', () => {
  const keep = (provisional, final) => assert.equal(E.reconcileFinal({ provisional, final }), 'keep', `${provisional} -> ${final}`);
  keep('Tell me about yourself', 'Tell me about yourself.');
  keep('what is your biggest weakness', 'What is your biggest weakness?');
  keep('Um, so tell me about a time you led a team', 'So tell me about a time you led a team.');
  keep('Tell me about yourself', 'Um, tell me about yourself, uh, okay?'); // fillers + a soft tail word
  keep("What's your biggest weakness?", 'What is your biggest weakness?'.replace('What is', "What's"));
  keep('How would you design a URL shortener for a large company', 'How would you design a URL shortener for a large company, right?');
  // One changed word in a long question is still the same question (>= 90%).
  keep('Tell me about a time you had to deal with a really difficult customer at work', 'Tell me about a time you had to deal with a very difficult customer at work.');
});

test('reconcileFinal: an appended clause or changed words restart it', () => {
  const restart = (provisional, final) => assert.equal(E.reconcileFinal({ provisional, final }), 'restart', `${provisional} -> ${final}`);
  restart('Tell me about yourself', 'Tell me about yourself and why you want this job.');
  restart('How would you design a cache?', 'How would you design a cache? And how would you invalidate it?');
  restart('Design a cash', 'Design a cache.'); // a misheard word in a short question
  restart('What is your biggest strength?', 'What is your biggest weakness?');
  restart('Tell me about yourself', 'Tell me about yourself, okay, so then...'); // three trailing words
  restart('', 'Tell me about yourself.');
  restart('Tell me about yourself', '');
});

test('keepEarlyOnScreen: replace within SWAP_WINDOW_MS, spare once it has been read', () => {
  assert.equal(E.SWAP_WINDOW_MS, 1500);
  assert.equal(E.keepEarlyOnScreen({ ownsPanel: true, shownAt: 1000, now: 1000 + 1499 }), false);
  assert.equal(E.keepEarlyOnScreen({ ownsPanel: true, shownAt: 1000, now: 1000 + 1500 }), true);
  assert.equal(E.keepEarlyOnScreen({ ownsPanel: true, shownAt: null, now: 5000 }), false, 'not on screen yet');
  assert.equal(E.keepEarlyOnScreen({ ownsPanel: false, shownAt: 1000, now: 9000 }), false, 'behind the chip: replaced');
});

test('triggerFor labels the end-of-speech signal', () => {
  assert.deepEqual(E.triggerFor({ stt: 'deepgram', cut: 'silence', reason: 'speech_final' }), { trigger: 'speech_final', detail: '' });
  assert.deepEqual(E.triggerFor({ stt: 'deepgram', cut: 'silence', reason: 'utterance_end' }), { trigger: 'utterance_end', detail: '' });
  assert.deepEqual(E.triggerFor({ stt: 'deepgram', cut: 'silence', reason: 'finalize' }), { trigger: 'other', detail: 'finalize' });
  assert.deepEqual(E.triggerFor({ stt: 'deepgram', cut: 'max', reason: 'max' }), { trigger: 'other', detail: 'max' });
  assert.deepEqual(E.triggerFor({ cut: 'silence' }), { trigger: 'groq_vad', detail: '' });
  assert.deepEqual(E.triggerFor({ cut: 'timer' }), { trigger: 'other', detail: 'timer' });
  for (const t of ['speech_final', 'utterance_end', 'early_interim', 'groq_vad', 'other']) assert.ok(E.TRIGGERS.includes(t));
});
