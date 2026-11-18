// Interview brief: what the user tells Echo before an interview (all
// optional): company and role, the job ad, the interview type, free notes.
// Pure functions only (main.js stores it, ai.js puts the blocks into the
// prompt). Interview mode only; an empty brief changes nothing.
//
// Sources: notes are the user's own words, so they are facts about the user
// ([From brief], as reliable as [You said]). The job ad and company name
// steer which real experience to talk about; they never add facts about the
// user, and company facts only come from what the user wrote here.
'use strict';

const crypto = require('node:crypto');

const LIMITS = {
  companyRole: 200,
  jobAd: 12_000,
  notes: 2_000,
  intro: 1_200,
};

const TYPES = ['auto', 'behavioural', 'coding', 'system_design', 'hr_screen', 'mixed'];
const TYPE_LABELS = {
  behavioural: 'Behavioural',
  coding: 'Coding',
  system_design: 'System design',
  hr_screen: 'Recruiter / HR screen',
  mixed: 'Mixed (behavioural and technical)',
};
const TYPE_RULES = {
  behavioural: "Mostly behavioural questions: answer with short STAR stories from the user's real facts. When they dig into a story, stay with the same one.",
  coding: 'A coding round: think out loud, confirm the input and edge cases before coding, and mention complexity. Follow-ups about the code matter as much as the code.',
  system_design: 'A system design round: start by confirming requirements and scale, then the core components, then the main trade-offs. Keep each spoken line short.',
  hr_screen: 'A recruiter / HR screen: short, friendly answers, one or two lines. Salary, notice period, start date, location or visa questions: answer only from the [From brief] notes; if the answer isn\'t there, stay polite and non-committal with a [placeholder].',
  mixed: 'A mix of behavioural and technical questions: STAR stories for the behavioural ones, the technical format for problems.',
};

// A job ad shorter than this goes in as it is (no summary call).
const AD_SUMMARY_MIN_CHARS = 900;
// Raw ad text used until the summary is ready (or if it failed).
const AD_RAW_CHARS = 1200;
const AD_SUMMARY_MAX_CHARS = 700;
const NOTES_BLOCK_CHARS = 1000;
const BRIEF_BLOCK_MAX_CHARS = 3200;
const HEADLINE_BRIEF_MAX_CHARS = 400;
const KEYWORDS_MAX = 12;

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // Normalise newlines, drop control characters (keep \n and \t), trim.
  const s = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

function normalizeType(type) {
  return TYPES.includes(type) ? type : 'auto';
}

// Anything -> { companyRole, jobAd, type, notes } (strings, capped).
function normalizeBrief(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  return {
    companyRole: cleanText(b.companyRole, LIMITS.companyRole).replace(/\s*\n\s*/g, ' '),
    jobAd: cleanText(b.jobAd, LIMITS.jobAd),
    type: normalizeType(b.type),
    notes: cleanText(b.notes, LIMITS.notes),
    intro: cleanText(b.intro, LIMITS.intro),
  };
}

function isEmptyBrief(brief) {
  const b = normalizeBrief(brief);
  return !b.companyRole && !b.jobAd && !b.notes && !b.intro && b.type === 'auto';
}

function adHash(jobAd) {
  return crypto.createHash('sha256').update(String(jobAd || '')).digest('hex').slice(0, 16);
}

function needsAdSummary(brief) {
  return normalizeBrief(brief).jobAd.length >= AD_SUMMARY_MIN_CHARS;
}

// A stored summary only counts if it was made from this exact ad text.
function usableSummary(brief, summary) {
  if (!summary || typeof summary !== 'object' || typeof summary.text !== 'string') return '';
  if (summary.forAd !== adHash(normalizeBrief(brief).jobAd)) return '';
  return cleanText(summary.text, AD_SUMMARY_MAX_CHARS);
}

function clipLines(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  return `${(nl > max * 0.6 ? cut.slice(0, nl) : cut).trim()} …`;
}

// The job ad as it goes into the prompt: the summary, the whole ad if it's
// short, or the start of it while the summary isn't ready.
function adForPrompt(brief, summary) {
  const b = normalizeBrief(brief);
  if (!b.jobAd) return { text: '', source: 'none' };
  const sum = usableSummary(b, summary);
  if (sum) return { text: sum, source: 'summary' };
  if (b.jobAd.length < AD_SUMMARY_MIN_CHARS) return { text: b.jobAd, source: 'full' };
  return { text: clipLines(b.jobAd, AD_RAW_CHARS), source: 'raw' };
}

function noteLines(notes, max) {
  return clipLines(notes, max)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `[From brief] ${l}`)
    .join('\n');
}

// The INTERVIEW BRIEF block for the full answer ('' for an empty brief).
// Fixed for the whole session, so it sits at the very top of the user
// message without hurting prefix caching.
function buildBriefBlock(brief, summary) {
  const b = normalizeBrief(brief);
  if (isEmptyBrief(b)) return '';
  const ad = adForPrompt(b, summary);
  const lines = ['INTERVIEW BRIEF (written by the user before the interview; the same all session):'];
  if (b.companyRole) lines.push(`Company and role: ${b.companyRole}`);
  if (b.type !== 'auto') lines.push(`Interview type: ${TYPE_LABELS[b.type]}`);
  if (ad.text) {
    const label = ad.source === 'summary'
      ? 'Job ad (summary of the ad the user pasted):'
      : ad.source === 'raw' ? 'Job ad (the start of the ad the user pasted):' : 'Job ad (as the user pasted it):';
    lines.push(label, ad.text);
  }
  if (b.notes) {
    lines.push('Notes from the user ([From brief] = their own facts, as reliable as [You said]):', noteLines(b.notes, NOTES_BLOCK_CHARS));
  }
  if (b.intro) {
    lines.push('The user\'s own intro, for "tell me about yourself" / "walk me through your background" ([From brief], their words):', clipLines(b.intro, LIMITS.intro));
    lines.push('- For those questions, use this intro: same facts, same order, in their words. Only shorten it or point its last line at this role. Never add to it.');
  }
  const rules = [];
  if (b.companyRole || ad.text) {
    rules.push("Use the role and the ad to choose which of the user's real experiences to talk about and what to stress. They never add facts about the user.");
    rules.push('Facts about the company (products, values, news, numbers, the team) only if they are written in this brief; otherwise use a short [placeholder] such as "[something you like about their product]".');
    rules.push('"Why this company / role?": lead with the user\'s own real connection to the company or its product from their files or notes (having used it, built on it, integrated it), then one concrete reason naming a specific team, product or engineering choice from this brief or ad. If the brief names none, use a [placeholder] such as "[a team or product you\'d want to work on]" rather than something every candidate says ("I use their product every day"). No abstract phrases ("reliability above everything", "robust infrastructure").');
  }
  if (ad.text) {
    rules.push("Asked about a skill or tool from the ad that isn't in the user's facts: be honest. Mention the closest thing they have actually done, or how they'd pick it up. Never claim it.");
  }
  if (b.type !== 'auto') rules.push(TYPE_RULES[b.type]);
  if (rules.length) lines.push('How to use the brief:', ...rules.map((r) => `- ${r}`));
  const block = lines.join('\n');
  return block.length > BRIEF_BLOCK_MAX_CHARS ? `${block.slice(0, BRIEF_BLOCK_MAX_CHARS - 1)}…` : block;
}

// The short version for the instant first line (role, type, a few ad
// lines, the start of the notes): same facts, so both answers agree.
function buildHeadlineBriefBlock(brief, summary) {
  const b = normalizeBrief(brief);
  if (isEmptyBrief(b)) return '';
  const parts = [];
  if (b.companyRole) parts.push(`Company and role: ${b.companyRole}`);
  if (b.type !== 'auto') parts.push(`Interview type: ${TYPE_LABELS[b.type]}`);
  const ad = adForPrompt(b, summary);
  if (ad.text) parts.push(`Job ad: ${ad.text.split('\n').filter((l) => l.trim()).slice(0, 2).join(' / ')}`);
  // "Tell me about yourself": the first line opens the user's own intro.
  if (b.intro) parts.push(`Their intro for "tell me about yourself" starts: "${b.intro.split(/(?<=[.!?])\s+/)[0].slice(0, 160)}"`);
  if (b.notes) parts.push(noteLines(b.notes, 200));
  let body = parts.join('\n');
  const head = 'INTERVIEW BRIEF (from the user; company facts only from here, never invented):\n';
  const room = HEADLINE_BRIEF_MAX_CHARS - head.length;
  if (body.length > room) body = `${body.slice(0, room - 1)}…`;
  return `${head}${body}`;
}

// ---- Keywords (to find the CV snippet that best fits the role) ----
const STOPWORDS = new Set(('a about above across after all also an and any are as at be been being both but by can could do does '
  + 'each etc for from has have having how if in into is it its join just like looking may more most must not of on '
  + 'one or other our out over own per plus role roles should so some such than that the their them then there these '
  + 'they this those through to under up us using we well were what when where which while who will with within work '
  + 'working would you your yours team teams experience years year strong ability skills skill knowledge new including '
  + 'help across based want wants need needs make ideal candidate candidates opportunity apply company great good '
  + 'responsibilities requirements required preferred qualifications nice bonus day days week weeks').split(' '));

function keywordsFor(brief, summary) {
  const b = normalizeBrief(brief);
  const text = [b.companyRole, adForPrompt(b, summary).text].filter(Boolean).join('\n').toLowerCase();
  const counts = new Map();
  for (const w of text.match(/[a-z][a-z0-9+#.]{1,30}/g) || []) {
    const word = w.replace(/\.+$/, '');
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, KEYWORDS_MAX)
    .map(([w]) => w);
}

// Behavioural questions ("tell me about yourself", "why this role", "a
// project you're proud of"): one extra CV snippet that best matches the role
// and the ad, so the story fits the job. Never replaces the question's own
// snippets; follow-ups in a thread (prefer list) keep theirs.
//   search(query, topK) -> snippets ({ source, index, text })
const FIT_MAX_SNIPPETS = 5;

// "Stripe, SWE intern" / "SWE intern at Stripe" / "Stripe - Payments" -> "Stripe".
function companyName(brief) {
  const role = normalizeBrief(brief).companyRole;
  if (!role) return '';
  const at = /\bat\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/.exec(role);
  const name = (at ? at[1] : role.split(/\s*[,|(–—]\s*|\s+-\s+/)[0]).trim();
  return name.length >= 2 && name.length <= 40 ? name : '';
}

// company: from companyName(); a snippet that names the company (they used
// it, built on it) is the best answer to "why us?", so it wins when present.
function pickFitSnippet({ snippets, keywords, analysis, prefer, search, company = '' }) {
  const list = Array.isArray(snippets) ? snippets : [];
  const none = { snippets: list, fit: '' };
  const words = [...(company ? [company] : []), ...(Array.isArray(keywords) ? keywords : [])];
  if (!words.length || list.length >= FIT_MAX_SNIPPETS) return none;
  if (Array.isArray(prefer) && prefer.length) return none;
  if (!analysis || analysis.intent !== 'behavioural_question' || analysis.questionKind !== 'general') return none;
  const have = new Set(list.map((x) => `${x.source}#${x.index}`));
  const found = (search(words.join(' '), 5) || []).filter((x) => !have.has(`${x.source}#${x.index}`));
  if (company && list.some((x) => mentions(x.text, company))) return { snippets: list, fit: '' };
  const named = company ? found.find((x) => mentions(x.text, company)) : null;
  const extra = named || found[0];
  return extra ? { snippets: [...list, extra], fit: extra.source } : none;
}

function mentions(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, 'i').test(String(text || ''));
}

// ---- Thinking level (Settings > Quality = Auto only) ----
// Coding and system design rounds: technical follow-ups get 'medium'
// instead of 'low' (the code and its trade-offs are what's being judged).
// Everything else keeps the usual Auto rule.
// Any interview type: a follow-up about failure cases (a crash, retries,
// two requests at once) or scale (a stream, memory limits, many machines)
// also gets 'medium': it's where shallow answers show.
const FAILURE_CASE_RE = /\b(stream(?:s|ing)?|distributed|(?:many|multiple|several) machines|doesn'?t fit|memory limits?|(?:billions|millions) of|at scale|scale (?:it|this|that|up)|crash\w*|fail(?:s|ed|ure|ures)?|goes? down|dies|restart\w*|retr(?:y|ies|ied)|time ?outs?|timed out|partial\w*|concurren\w*|race conditions?|at the same time|simultaneous\w*|twice|duplicates?|idempoten\w*|consisten\w*|network (?:split|partition|error))\b/i;
function adjustThinkingLevel(level, { type, kind, quality, question } = {}) {
  if (quality && quality !== 'auto') return level;
  if (kind !== 'followup' || level !== 'low') return level;
  if (type === 'coding' || type === 'system_design') return 'medium';
  if (FAILURE_CASE_RE.test(String(question || ''))) return 'medium';
  return level;
}

// Diagnostics: "Brief: role ✓ ad ✓ (summary 540 chars) · type Coding".
function describeBrief(brief, summary, status) {
  const b = normalizeBrief(brief);
  if (isEmptyBrief(b)) return '';
  const bits = [];
  if (b.companyRole) bits.push('role ✓');
  if (b.jobAd) {
    const ad = adForPrompt(b, summary);
    const how = ad.source === 'summary' ? `summary ${ad.text.length} chars`
      : ad.source === 'full' ? `full ${ad.text.length} chars`
        : `raw start ${ad.text.length} chars${status === 'pending' ? ', summary pending' : status === 'failed' ? ', summary failed' : ''}`;
    bits.push(`ad ✓ (${how})`);
  }
  if (b.notes) bits.push('notes ✓');
  if (b.intro) bits.push('intro ✓');
  let s = `Brief: ${bits.join(' ') || 'type only'}`;
  if (b.type !== 'auto') s += ` · type ${TYPE_LABELS[b.type]}`;
  return s;
}

module.exports = {
  LIMITS,
  TYPES,
  TYPE_LABELS,
  AD_SUMMARY_MIN_CHARS,
  AD_SUMMARY_MAX_CHARS,
  AD_RAW_CHARS,
  BRIEF_BLOCK_MAX_CHARS,
  HEADLINE_BRIEF_MAX_CHARS,
  normalizeBrief,
  isEmptyBrief,
  adHash,
  needsAdSummary,
  usableSummary,
  adForPrompt,
  buildBriefBlock,
  buildHeadlineBriefBlock,
  keywordsFor,
  pickFitSnippet,
  companyName,
  adjustThinkingLevel,
  describeBrief,
};
