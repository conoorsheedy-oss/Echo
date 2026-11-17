// CV story bank (pure): the user's real stories, pulled once from their own
// files (CV, notes) by one Gemini call (ai.extractStories), then CHECKED here
// against those files before anything is kept:
//   - every quote must appear word for word in the file it names;
//   - every number in a story (40%, 3 months, 200 users) must appear in the
//     files; an unchecked number in the result drops the result, anywhere
//     else it drops the story;
//   - a story with no checked quote is dropped.
// In Interview mode, a NEW behavioural question gets the best-fitting
// stories (theme words, the question's own words, the role from the brief,
// and stories not used yet this session first). Follow-ups stay on the
// story already being told (thread state / Direction line, Phase 2b).
'use strict';

const crypto = require('node:crypto');

const THEMES = [
  'leadership', 'teamwork', 'conflict', 'failure', 'challenge', 'impact', 'learning',
  'pressure', 'initiative', 'ambiguity', 'customer', 'technical_depth',
];
// Words in a question that point at a theme.
const THEME_CUES = {
  leadership: /\b(lead|led|leader|leading|leadership|mentor|mentored|in charge|took charge|ownership|own(ed)? (it|the))\b/i,
  teamwork: /\b(team|teamwork|collaborat\w*|work(ed)? with others|group|together|cross[- ]functional)\b/i,
  conflict: /\b(conflict|disagree\w*|argument|difficult (person|coworker|colleague|teammate|stakeholder)|push(ed)? back|tension)\b/i,
  failure: /\b(fail\w*|mistake|went wrong|didn'?t go|regret|setback|wrong decision|weakness\w*)\b/i,
  challenge: /\b(challeng\w*|difficult|hard(est)?|tough|obstacle|problem you (solved|faced))\b/i,
  impact: /\b(proud|achievement|accomplish\w*|impact|success\w*|best work|biggest win|result)\b/i,
  learning: /\b(learn\w*|new (skill|technology|language)|pick(ed)? up|grow(th)?|improve(d)? yourself|feedback)\b/i,
  pressure: /\b(pressure|deadline|tight|stress\w*|under time|urgent|crunch|multiple (projects|priorities)|prioriti[sz]\w*)\b/i,
  initiative: /\b(initiative|above and beyond|proactive|on your own|without being asked|self[- ]start\w*|side project)\b/i,
  ambiguity: /\b(ambigu\w*|unclear|uncertain\w*|without (clear|much) (direction|guidance)|vague)\b/i,
  customer: /\b(customer|client|user(s)?|stakeholder)\b/i,
  technical_depth: /\b(technical(ly)?|architecture|system|design(ed)?|debug\w*|performance|scal\w*|bug)\b/i,
};

const MAX_STORIES = 10;
const MAX_QUOTES = 3;
const FIELD_MAX = { title: 80, situation: 240, action: 320, result: 200, quote: 220, skill: 40 };
const EXTRACT_INPUT_MAX_CHARS = 30_000;
const STORY_BLOCK_MAX_CHARS = 1600;
const HEADLINE_STORY_MAX_CHARS = 220;

function docsHash(documents) {
  const h = crypto.createHash('sha256');
  for (const d of documents || []) h.update(`${d.source}\u0000${d.text}\u0000`);
  return h.digest('hex').slice(0, 20);
}

// The text the extraction call reads: each file with a header, capped.
function buildExtractionInput(documents) {
  let out = '';
  for (const d of documents || []) {
    const part = `=== FILE: ${d.source} ===\n${String(d.text || '').trim()}\n\n`;
    if (out.length + part.length > EXTRACT_INPUT_MAX_CHARS) {
      const room = EXTRACT_INPUT_MAX_CHARS - out.length;
      if (room > 500) out += `${part.slice(0, room)}\n[file cut here]\n`;
      break;
    }
    out += part;
  }
  return out.trim();
}

// For "does this appear in the file": case, whitespace, quote marks, dashes
// and bullet characters don't matter.
function normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/[•·▪●◦*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "40%", "3", "1,200", "2.5x", "£50k" -> "40", "3", "1200", "2.5", "50"
function numbersIn(s) {
  return (String(s || '').match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, '').replace(/\.0+$/, ''));
}

function clean(value, max) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trim()}…` : s;
}

// The model's JSON -> checked stories. documents: [{ source, text }].
// Returns { stories, dropped } (dropped: how many were thrown away, for logs).
function verifyStories(raw, documents) {
  const docs = (documents || []).map((d) => ({ source: d.source, norm: normalizeForMatch(d.text) }));
  const allNorm = docs.map((d) => d.norm).join('\n');
  const allNumbers = new Set(numbersIn(docs.map((d) => d.norm).join(' ')));
  const list = raw && Array.isArray(raw.stories) ? raw.stories : Array.isArray(raw) ? raw : [];
  const stories = [];
  let dropped = 0;
  const numbersOk = (text) => numbersIn(text).every((n) => allNumbers.has(n));

  for (const item of list) {
    if (stories.length >= MAX_STORIES) break;
    if (!item || typeof item !== 'object') { dropped += 1; continue; }
    const title = clean(item.title, FIELD_MAX.title);
    const situation = clean(item.situation, FIELD_MAX.situation);
    const action = clean(item.action, FIELD_MAX.action);
    let result = clean(item.result, FIELD_MAX.result);
    const named = docs.find((d) => d.source === item.source);
    const quotes = [];
    for (const q of Array.isArray(item.quotes) ? item.quotes : []) {
      const quote = clean(q, FIELD_MAX.quote).replace(/^["']|["']$/g, '');
      const norm = normalizeForMatch(quote);
      if (norm.length < 12) continue;
      const inNamed = named && named.norm.includes(norm);
      if (!inNamed && !allNorm.includes(norm)) continue;
      if (!quotes.includes(quote)) quotes.push(quote);
      if (quotes.length >= MAX_QUOTES) break;
    }
    if (!title || !action || !quotes.length) { dropped += 1; continue; }
    if (!numbersOk(title) || !numbersOk(situation) || !numbersOk(action)) { dropped += 1; continue; }
    if (!numbersOk(result)) result = '';
    const source = named ? named.source : (docs.find((d) => quotes.some((q) => d.norm.includes(normalizeForMatch(q)))) || {}).source || '';
    const themes = [...new Set((Array.isArray(item.themes) ? item.themes : []).map((t) => String(t).toLowerCase().replace(/[\s-]+/g, '_')).filter((t) => THEMES.includes(t)))];
    const skills = [...new Set((Array.isArray(item.skills) ? item.skills : []).map((s) => clean(s, FIELD_MAX.skill)).filter(Boolean))].slice(0, 8);
    stories.push({ id: `S${stories.length + 1}`, title, situation, action, result, quotes, themes, skills, source });
  }
  return { stories, dropped };
}

function tokens(s) {
  return (String(s || '').toLowerCase().match(/[a-z0-9+#]+/g) || []).filter((w) => w.length > 2);
}
const QUESTION_STOPWORDS = new Set(['tell', 'about', 'time', 'when', 'you', 'your', 'the', 'and', 'what', 'how', 'did', 'was', 'were', 'have', 'had', 'with', 'that', 'this', 'describe', 'give', 'example', 'can', 'could', 'would', 'which', 'where', 'why', 'there', 'some', 'one', 'had', 'made']);

function themesForQuestion(question) {
  return THEMES.filter((t) => THEME_CUES[t].test(String(question || '')));
}

// The best stories for one question (most relevant first).
//   keywords: role / ad words from the brief (optional)
//   used: Map id -> the question it was used for, this session
function pickStories(stories, { question, keywords = [], used = new Map(), k = 2 } = {}) {
  if (!Array.isArray(stories) || !stories.length) return [];
  const wanted = themesForQuestion(question);
  const qTokens = new Set(tokens(question).filter((w) => !QUESTION_STOPWORDS.has(w)));
  const kw = new Set((keywords || []).map((w) => String(w).toLowerCase()));
  const scored = stories.map((s, i) => {
    const body = new Set(tokens([s.title, s.situation, s.action, s.result, s.skills.join(' ')].join(' ')));
    let score = 0;
    score += 3 * s.themes.filter((t) => wanted.includes(t)).length;
    let overlap = 0;
    for (const w of qTokens) if (body.has(w)) overlap += 1;
    score += Math.min(overlap, 3);
    let fit = 0;
    for (const w of kw) if (body.has(w)) fit += 1;
    score += Math.min(fit, 4) * 0.5;
    // Telling the same story twice for different questions looks thin: a told
    // story needs to fit clearly better (two theme matches) to come first again.
    score += used.has(s.id) ? -2.5 : 1;
    return { s, score, i };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, k).map((x) => x.s);
}

function storyLines(s, used) {
  const lines = [`${s.id} "${s.title}"${s.source ? ` [From CV: ${s.source}]` : ''}${s.themes.length ? ` (${s.themes.join(', ').replace(/_/g, ' ')})` : ''}`];
  if (s.situation) lines.push(`  Situation: ${s.situation}`);
  lines.push(`  What they did: ${s.action}`);
  if (s.result) lines.push(`  Result: ${s.result}`);
  lines.push(`  Their words: ${s.quotes.map((q) => `"${q}"`).join(' | ')}`);
  if (used && used.has(s.id)) lines.push(`  (Already told this session, for: "${clean(used.get(s.id), 80)}")`);
  return lines.join('\n');
}

// The STORY BANK block for the full answer ('' when there's nothing).
function buildStoryBlock(picked, { used = new Map() } = {}) {
  if (!Array.isArray(picked) || !picked.length) return '';
  const head = "STORY BANK (the user's own stories, checked against their files; the quotes are word for word):";
  const rules = [
    'Tell ONE of these, the one that fits the question best (usually the first), in the user\'s voice. Use only its facts; anything missing stays general or a [placeholder].',
    'Prefer a story that hasn\'t been told yet this session, unless the interviewer is asking about that same story again.',
    "If none of them really fits, don't stretch one: give the answer shape with [placeholders] instead.",
  ].map((r) => `- ${r}`).join('\n');
  let body = '';
  for (const s of picked) {
    const part = storyLines(s, used);
    if (head.length + body.length + part.length + rules.length + 4 > STORY_BLOCK_MAX_CHARS) break;
    body += `${part}\n`;
  }
  if (!body) body = `${storyLines(picked[0], used).slice(0, STORY_BLOCK_MAX_CHARS - head.length - rules.length - 4)}\n`;
  return `${head}\n${body}${rules}`;
}

// One line for the instant first line: the top story, so both agree.
function buildHeadlineStoryLine(picked) {
  if (!Array.isArray(picked) || !picked.length) return '';
  const s = picked[0];
  const line = `Best-fitting real story from their CV: "${s.title}"${s.result ? `, result: ${s.result}` : ''}. Open with it, using only these facts.`;
  return line.length > HEADLINE_STORY_MAX_CHARS ? `${line.slice(0, HEADLINE_STORY_MAX_CHARS - 1)}…` : line;
}

// Which picked story did the answer tell? The one whose title / quote words
// it shares most with (at least 3 words), else none.
function storyToldIn(answer, picked) {
  const words = new Set(tokens(answer));
  let best = null;
  let bestHits = 0;
  for (const s of picked || []) {
    const own = new Set(tokens([s.title, s.quotes.join(' '), s.skills.join(' ')].join(' ')));
    let hits = 0;
    for (const w of own) if (words.has(w)) hits += 1;
    if (hits > bestHits) { best = s; bestHits = hits; }
  }
  return bestHits >= 3 ? best : null;
}

module.exports = {
  THEMES,
  MAX_STORIES,
  EXTRACT_INPUT_MAX_CHARS,
  STORY_BLOCK_MAX_CHARS,
  HEADLINE_STORY_MAX_CHARS,
  docsHash,
  buildExtractionInput,
  normalizeForMatch,
  numbersIn,
  verifyStories,
  themesForQuestion,
  pickStories,
  buildStoryBlock,
  buildHeadlineStoryLine,
  storyToldIn,
};
