// Light safety net for AI-sounding tells that slip past the prompt (pure, so
// it's unit-tested). The prompts in ai.js do the real work; this only fixes
// two things that are cheap to fix mechanically and very noticeable when
// read out loud:
//   - em dashes (and spaced en dashes) -> a comma, or nothing next to
//     punctuation / at a line edge. Code fences are left alone.
//   - a stock opener at the very start ("Great question!", "Certainly!",
//     "Absolutely,", "I'd be happy to help!") is removed and the next word
//     capitalised.
// createStreamHumanizer() does the same to a stream of text deltas without
// ever having to take back text it already emitted: it holds back the start
// until the opener is decided and any trailing whitespace/dash/backticks
// until the next piece shows what follows them.
'use strict';

// Lower-case, straight apostrophes. Matched only at the very start and only
// when followed by punctuation (so "Absolutely no idea" mid-thought stays).
const OPENERS = [
  "that's a great question", "that's a good question", "that's a really good question",
  'that is a great question', 'what a great question', 'great question', 'good question',
  'excellent question', 'fantastic question', 'interesting question',
  'certainly', 'absolutely', 'of course', 'sure thing',
  "i'd be happy to help", "i'd be happy to answer that", "i'd be glad to help",
  'i would be happy to help', "i'd love to answer that",
];
const OPENER_PUNCT_RE = /^[ \t]*[!.,:;—–-]+/;

function normalizeForMatch(s) {
  return s.replace(/[‘’]/g, "'").toLowerCase();
}

// Returns { decided, text }. decided=false means "can't tell yet" (only when
// final=false): the start might still turn out to be an opener.
function stripOpeners(input, final) {
  let text = input;
  for (let guard = 0; guard < 4; guard++) {
    const lead = text.match(/^\s*/)[0].length;
    const body = text.slice(lead);
    const lower = normalizeForMatch(body);
    let stripped = false;
    for (const p of OPENERS) {
      if (lower.length < p.length) {
        if (!final && p.startsWith(lower)) return { decided: false, text: '' };
        continue;
      }
      if (!lower.startsWith(p)) continue;
      const after = body.slice(p.length);
      const punct = after.match(OPENER_PUNCT_RE);
      if (!punct) {
        // "Certainly" + end of the stream so far: punctuation may still come.
        if (!final && after === '') return { decided: false, text: '' };
        continue; // followed by a letter/space: part of a real sentence
      }
      const rest = after.slice(punct[0].length);
      if (!final && rest === '') return { decided: false, text: '' };
      if (rest !== '' && !/^\s/.test(rest)) continue; // e.g. "Of course.js"
      text = rest.replace(/^\s+/, '');
      stripped = true;
      break;
    }
    if (!stripped) break;
    if (!text && !final) return { decided: false, text: '' };
  }
  if (text !== input) text = text.charAt(0).toUpperCase() + text.slice(1);
  return { decided: true, text };
}

// Em dashes, and en dashes used as a dash between words ("this – that",
// not "2 – 3"), in prose -- never inside ``` code fences.
const DASH_RE = /[ \t]*(?:—+|(?<=[A-Za-z,)][ \t]+)–(?=[ \t]+[A-Za-z]))[ \t]*/g;

function replaceDashes(prose) {
  return prose.replace(DASH_RE, (m, offset, str) => {
    const before = offset > 0 ? str[offset - 1] : '';
    const after = str[offset + m.length] || '';
    if (!before || before === '\n' || !after || after === '\n') return '';
    if (/[,.;:!?)\]]/.test(after)) return '';
    if (/[,.;:!?(]/.test(before)) return before === '(' ? '' : ' ';
    return ', ';
  });
}

function fixDashes(text) {
  if (!/[—–]/.test(text)) return text;
  const parts = text.split('```');
  // Even indexes are prose, odd ones are inside code fences.
  return parts.map((part, i) => (i % 2 === 0 ? replaceDashes(part) : part)).join('```');
}

function humanizeAnswer(text) {
  const s = String(text == null ? '' : text);
  if (!s) return s;
  const { text: noOpener } = stripOpeners(s, true);
  return fixDashes(noOpener);
}

// Streaming version: push(delta) returns the text that is now safe to show
// (possibly ''). Everything it returns is a prefix of humanizeAnswer(full),
// so the final answer only ever extends what was shown.
function createStreamHumanizer() {
  let raw = '';
  let emitted = '';
  return {
    push(delta) {
      raw += String(delta || '');
      const stable = raw.replace(/[\s—–`]+$/, '');
      if (!stable) return '';
      const opener = stripOpeners(stable, false);
      if (!opener.decided) return '';
      const clean = fixDashes(opener.text);
      if (!clean.startsWith(emitted)) return ''; // can't happen in practice; the final text fixes it
      const out = clean.slice(emitted.length);
      emitted = clean;
      return out;
    },
    // Whatever is left once the stream has ended.
    end() {
      const clean = humanizeAnswer(raw.trim());
      if (!clean.startsWith(emitted)) return '';
      const out = clean.slice(emitted.length);
      emitted = clean;
      return out;
    },
  };
}

module.exports = { humanizeAnswer, createStreamHumanizer, stripOpeners, fixDashes, OPENERS };
