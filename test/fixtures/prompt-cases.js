// Inputs for the prompt snapshot test (test/interview-state.test.js): the
// Gemini request bodies these produce were recorded from the Phase 2a code
// (prompt-snapshots-2a.json), so later changes can prove that meeting /
// presentation / general prompts stay byte-identical.
'use strict';

const KNOWLEDGE = [{ source: 'cv.md', index: 0, text: 'Built Ledgerly, a payments reconciliation service in Django at Kobo.' }];
const PREVIOUS = [{ kind: 'suggestion', question: 'Two sum', text: 'Use a hash map.\n```py\nseen = {}\n```' }];
const TRANSCRIPT = [
  'Them: Thanks for joining. Can you hear me okay?',
  'You: Yes, all good.',
  'Them: Given an array of integers, return indices of two numbers that add to target.',
  "You: I'd use a hash map and check for the complement as I go.",
  'Them: What if the input is a stream?',
].join('\n');

const BASES = [
  { name: 'question', transcript: TRANSCRIPT, question: 'What if the input is a stream?' },
  { name: 'knowledge+previous', transcript: TRANSCRIPT, question: 'What if the input is a stream?', knowledgeSnippets: KNOWLEDGE, previousAnswers: PREVIOUS },
  { name: 'no-question', transcript: `${TRANSCRIPT}\nYou: Hmm, let me think.` },
  { name: 'instruction', transcript: TRANSCRIPT, instruction: 'Make this shorter' },
  { name: 'auto', transcript: 'Them: We shipped the new dashboard yesterday.', requestKind: 'auto' },
  { name: 'empty', transcript: '' },
];

function cases() {
  const out = [];
  for (const mode of ['interview', 'meeting', 'presentation', 'general']) {
    for (const answerStyle of ['script', 'cues']) {
      for (const base of BASES) out.push({ id: `${mode}/${answerStyle}/${base.name}`, mode, params: { ...base, mode, answerStyle } });
    }
  }
  return out;
}

module.exports = { cases };
