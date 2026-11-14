// Unit tests for question detection + the auto-suggest delay
// (src/renderer/question-core.js).
// Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/renderer/question-core.js');

const QUESTIONS = [
  'What is the time complexity of your approach',
  'why did you use a hash map',
  'How would you test this',
  'When did you start using Rust',
  'Where do you see yourself in five years',
  'Which approach would you pick',
  'Who was the hardest stakeholder',
  'Can you walk me through your code',
  'Could you explain the second loop',
  'Would you do it differently now',
  'Do you have any questions for us',
  'Did you consider a heap',
  'Have you used Kubernetes in production',
  'Tell me about yourself.',
  'Walk me through your resume.',
  'Talk me through the trade-offs.',
  'Explain how the cache gets invalidated.',
  'Describe a time you failed.',
  'Give me an example of a hard bug you fixed.',
  'What if the input is empty',
  'Is it possible to do this in one pass',
  'Are there any edge cases',
  'Is there a faster way',
  'Any edge cases',
  'Okay so what if the array is sorted',
  'Cool, and how would you scale it',
  'Write a function that reverses a string.',
  'Implement a queue using two stacks.',
  'Given an array of integers, return the two that sum to target.',
  'Design a URL shortener.',
  'Yeah so, what is your approach here',
  "I'm curious how you handled the rollout.",
  'Your code looks good?',
];
const NOT_QUESTIONS = [
  'That makes sense.',
  'I think we can use a map.',
  'Thanks, that was great.',
  'Interesting.',
  'I see what you did there.',
  "Let's say we have a million users.",
  'Okay.',
  'Right, the second loop is the expensive part.',
  'We use Kubernetes for most services.',
  '',
];

test('questions are detected by wording, not only a "?"', () => {
  for (const t of QUESTIONS) assert.equal(q.looksLikeQuestion(t), true, t);
  for (const t of NOT_QUESTIONS) assert.equal(q.looksLikeQuestion(t), false, t);
  assert.equal(q.looksLikeQuestion('so yeah?'), true, 'a "?" always counts');
});

test('lines that trail off are mid-thought; finished ones are not', () => {
  for (const t of ['So the next thing is,', 'And then we would need the', 'What about the um', 'I was thinking that maybe and', 'Hmm...', 'So…']) {
    assert.equal(q.endsMidThought(t), true, t);
  }
  for (const t of ['What are you most proud of', 'Who did you work with', 'Why is that', 'What are you looking for', 'Can you explain this', 'What is it?', 'Done.']) {
    assert.equal(q.endsMidThought(t), false, t);
  }
});

test('delay: questions at a pause answer fast, Deepgram end of speech answers at once', () => {
  const pause = { cut: 'silence' };
  const live = { cut: 'silence', live: true };
  // Groq / VAD path: a question cut at a pause -> short delay (<= 150 ms),
  // even without a question mark.
  assert.equal(q.autoSuggestDelay('What is the complexity of your solution', pause), q.QUESTION_DELAY_MS);
  assert.ok(q.QUESTION_DELAY_MS <= 150);
  assert.equal(q.autoSuggestDelay('Walk me through your code.', pause), q.QUESTION_DELAY_MS);
  // Deepgram speech_final on a question: no extra wait.
  assert.equal(q.autoSuggestDelay('Why did you use a hash map?', live), 0);
  assert.equal(q.autoSuggestDelay('why did you use a hash map', live), 0);
  // Other finished sentences at a pause: 300 ms.
  assert.equal(q.autoSuggestDelay('That makes sense.', pause), q.AFTER_SPEECH_MS);
  // Trailing off, or no end-of-speech: the long wait.
  assert.equal(q.autoSuggestDelay('So what about the', pause), q.QUIET_MS);
  assert.equal(q.autoSuggestDelay('And then,', live), q.QUIET_MS);
  assert.equal(q.autoSuggestDelay('So what happens if...', live), q.QUIET_MS);
  assert.equal(q.autoSuggestDelay('What is the complexity?', { cut: 'max' }), q.QUIET_MS);
  assert.equal(q.autoSuggestDelay('What is the complexity?', { cut: 'timer' }), q.QUIET_MS);
  assert.equal(q.autoSuggestDelay('What is the complexity?', null), q.QUIET_MS);
  assert.equal(q.autoSuggestDelay('we use kubernetes', pause), q.QUIET_MS);
  assert.equal(q.QUIET_MS, 1500);
});
