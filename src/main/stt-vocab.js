// Speech-to-text vocabulary (pure): the user's own terms, pulled from their
// knowledge files and interview brief, so the transcriber spells them right
// ("NIST SP 800-22", not "NIST SP 822"; "FastAPI", "Ledgerly", "Kobo").
//   Deepgram Nova-3: one `keyterm` query parameter per term (deepgram-core.js)
//   Groq Whisper:    a short `prompt` listing them (ai.transcribeAudio)
// Only names and technical terms go out, never sentences from the files.
'use strict';

const MAX_TERMS = 40;
const MAX_TERM_CHARS = 40;
const MAX_TOTAL_CHARS = 600;
const WHISPER_PROMPT_MAX_CHARS = 600;

// Capitalised words that are just ordinary English at the start of a line
// or a CV bullet, not names.
const COMMON = new Set(('the a an and or but i my we our you your it this that these those he she they in on at to for of from with by as '
  + 'built led worked work working created developed designed made used using implemented wrote write helped improved managed '
  + 'experience education skills projects project summary profile contact email phone languages tools technologies '
  + 'present current university college school bachelor master degree certificate award awards achievements achievement '
  + 'january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec '
  + 'monday tuesday wednesday thursday friday saturday sunday intern internship engineer engineering software student researcher research '
  + 'senior junior lead team teams also about over under during after before when while first second third one two three '
  + 'role responsibilities including include includes key main other more most new old part full time remote hybrid onsite '
  // Short acronyms every transcriber already gets right: not worth a slot.
  + 'ai ui ux qa it ok cv us uk eu pm hr ceo cto ml api apis').split(/\s+/));

// Phrases like "NIST SP 800-22", "ISO 27001", "Python 3.12", "Next.js 14".
const CODE_PHRASE_RE = /\b[A-Z][A-Za-z.+#]*(?:\s+[A-Z]{1,6})?\s+\d+(?:[.-]\d+)*\b/g;
// Single tokens worth keeping: CamelCase, ALLCAPS (2+), letters+digits,
// dotted names (Next.js, Node.js), C++ / C#.
const TOKEN_RE = /(?:[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z]+)+|[A-Za-z]+\+\+|[A-Za-z]+#|[A-Za-z][A-Za-z0-9-]*)/g;

function isInteresting(token) {
  if (token.length < 2 || token.length > MAX_TERM_CHARS) return false;
  if (/^[A-Z]{2,}[0-9A-Z-]*$/.test(token)) return true; // NIST, AWS, SQL, GPT4
  if (/[a-z][A-Z]/.test(token)) return true; // FastAPI, PostgreSQL, TypeScript
  if (/[A-Za-z]\d|\d[A-Za-z]/.test(token)) return true; // S3, Py3, nova-3
  if (/\.[a-z]+$/i.test(token) || /\+\+$|#$/.test(token)) return true; // Next.js, C++, C#
  return false;
}

// documents: [{ source, text }]; brief: { companyRole, jobAd, notes } (optional)
function extractVocabulary({ documents = [], brief = null } = {}) {
  const counts = new Map();
  const add = (term, weight = 1) => {
    const t = term.replace(/\s+/g, ' ').trim();
    if (!t || t.length > MAX_TERM_CHARS) return;
    const key = t.toLowerCase();
    const prev = counts.get(key);
    counts.set(key, { term: prev ? prev.term : t, n: (prev ? prev.n : 0) + weight });
  };
  const texts = [];
  if (brief && typeof brief === 'object') {
    // "Stripe, SWE intern": every capitalised word in the role line is a name.
    if (typeof brief.companyRole === 'string') {
      for (const w of brief.companyRole.match(TOKEN_RE) || []) if (/^[A-Z]/.test(w) && !COMMON.has(w.toLowerCase())) add(w, 3);
    }
    for (const k of ['notes', 'jobAd']) if (typeof brief[k] === 'string') texts.push({ text: brief[k], weight: 2 });
  }
  for (const d of documents || []) texts.push({ text: String(d.text || ''), weight: 1 });

  for (const { text, weight } of texts) {
    for (const m of text.match(CODE_PHRASE_RE) || []) {
      if (/\d/.test(m) && /[A-Z]{2,}|[a-z][A-Z]/.test(m)) add(m, weight * 2);
    }
    // Capitalised words in the middle of a sentence are names (Kobo,
    // Ledgerly, Maynooth); at the start of a line / sentence they may not be.
    const lines = text.split(/\n/);
    for (const line of lines) {
      const tokens = line.match(TOKEN_RE) || [];
      tokens.forEach((tok, i) => {
        const clean = tok.replace(/^-+|-+$/g, '');
        if (!clean) return;
        if (isInteresting(clean)) { add(clean, weight); return; }
        if (/^[A-Z][a-z]{2,}$/.test(clean) && i > 0 && !COMMON.has(clean.toLowerCase())) {
          const before = line.slice(0, line.indexOf(tok)).trimEnd();
          if (!/[.!?•*-]$/.test(before) && !/^#+$/.test(before)) add(clean, weight * 0.5);
        }
      });
    }
  }
  const all = [...counts.values()].filter((c) => !COMMON.has(c.term.toLowerCase()));
  // A word that's already inside a kept phrase ("NIST" in "NIST SP 800-22") is covered.
  const phrases = all.filter((c) => c.term.includes(' ')).map((c) => c.term.toLowerCase().split(' '));
  const ranked = all
    .filter((c) => c.term.includes(' ') || !phrases.some((words) => words.includes(c.term.toLowerCase())))
    .sort((a, b) => b.n - a.n || a.term.localeCompare(b.term));
  const out = [];
  let total = 0;
  for (const c of ranked) {
    if (out.length >= MAX_TERMS) break;
    if (total + c.term.length > MAX_TOTAL_CHARS) break;
    out.push(c.term);
    total += c.term.length;
  }
  return out;
}

// For Groq Whisper's `prompt` (it steers spelling; keep it short: a long
// prompt can leak into transcripts of silence).
function whisperPrompt(terms) {
  if (!Array.isArray(terms) || !terms.length) return '';
  let s = 'Job interview. Terms: ';
  for (const t of terms) {
    const next = `${s}${s.endsWith(': ') ? '' : ', '}${t}`;
    if (next.length > WHISPER_PROMPT_MAX_CHARS - 1) break;
    s = next;
  }
  return `${s}.`;
}

module.exports = { extractVocabulary, whisperPrompt, MAX_TERMS, MAX_TOTAL_CHARS, WHISPER_PROMPT_MAX_CHARS };
