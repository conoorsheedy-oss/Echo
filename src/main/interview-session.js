// Interview session state (Phase 2a): a question / thread log built from the
// transcript, new-question vs follow-up linking, pinned facts with their
// sources, candidate spoken-answer tracking and per-detail confirmation of
// Echo's suggestions, plus a thread-aware knowledge (CV) query.
//
// Pure: no Electron, no I/O, no API calls, everything synchronous and cheap
// (regexes + token sets). main.js keeps ONE session in memory per listening
// session; it is never written to disk and is cleared on Stop / Clear / quit.
// Unit-tested in test/interview-session.test.js.
//
// Sources stay separate. Every stored item is
//   { id, type, text, threadId, questionId, source: { kind, ref }, status,
//     order, timestamp, labels: [{ label, confidence, source }], confidence? }
//   type    interviewer_statement | candidate_statement | echo_suggestion |
//           confirmed_detail | inferred
//   status  stated | suggested | confirmed | inferred | superseded
//   source  transcript (ref = absolute line index) | suggestion (requestId) |
//           knowledge (file name) | rule (rule name)
// Rule-based categorisations (question, constraint, interviewer_fact,
// problem_statement, candidate_claim, transition) are LABELS on the item,
// each with a confidence; the item itself keeps its true source and type.
// Thread types and link decisions are `inferred` items with a confidence.
//
// Confirmation (per detail, never per suggestion): atomic details are pulled
// out of each Echo suggestion (complexities, named data structures /
// techniques, languages / tools, numbers with units, names that came from
// the knowledge snippets). A detail is `confirmed` only when a later
// candidate ("You") line in the SAME thread contains that exact detail
// (normalised phrase or a small alias table: "O(n)" = "o of n" = "linear
// time"), and not right after a negation ("instead of sorting"). Unconfirmed
// suggestion details never become candidate facts.
'use strict';

const Question = require('../renderer/question-core');
const Intent = require('../renderer/intent-core');

const ITEM_TYPES = Object.freeze(['interviewer_statement', 'candidate_statement', 'echo_suggestion', 'confirmed_detail', 'inferred']);
const ITEM_STATUSES = Object.freeze(['stated', 'suggested', 'confirmed', 'inferred', 'superseded']);
const SOURCE_KINDS = Object.freeze(['transcript', 'suggestion', 'knowledge', 'rule']);
const THREAD_TYPES = Object.freeze(['behavioural', 'technical_problem', 'concept', 'experience', 'system_design', 'other']);

// Below this a link decision is provisional: both interpretations are kept
// and later evidence may re-resolve it.
const LINK_CONFIDENCE_THRESHOLD = 0.6;

// Only the most recent threads are candidates for a follow-up link (keeps
// every request O(1) in long sessions; an interview rarely has more topics).
const MAX_LINK_THREADS = 20;

const MAX_QUERY_CHARS = 800;
const MAX_CLAIMS_IN_QUERY = 3;
const CLAIM_QUERY_CHARS = 200;
const KNOWLEDGE_TEXT_CHARS = 1200;

// ---------------------------------------------------------------------------
// Rule patterns (only what intent-core / question-core don't already have).

// Explicit topic change: forces a new thread.
const TRANSITION_RE = /\b(?:next question|(?:let'?s|we can|we'll|i'?d like to|going to|gonna) move on|moving on|switch(?:ing)? gears|change (?:of )?(?:topic|gears)|different (?:topic|question|area|direction)|new (?:topic|question)|another question|let'?s (?:talk about|switch to|change to) something (?:else|different)|on to the next|that'?s (?:all|enough) (?:for|on) (?:that|this))\b/i;

// A reference to something said earlier (possibly an older thread).
const REFERENCE_RE = /\b(?:going back to|go back to|back to (?:your|the|that|what)|coming back to|returning to|circle back to|circling back|revisit(?:ing)?|earlier you (?:mentioned|said|talked|described)|you (?:mentioned|said|talked about|described) (?:earlier|before|a (?:while|minute|moment) ago)|(?:you|we) (?:mentioned|discussed|talked about) (?:earlier|before)|earlier (?:on|today)|from (?:earlier|before)|the (?:\w+ ){0,3}(?:you|we) (?:discussed|talked about|mentioned) (?:earlier|before)?)\b/i;
const TECH_REF_NOUN_RE = /\b(?:solution|code|algorithm|approach|implementation|function|query|design|complexity)\b/i;
const STORY_REF_NOUN_RE = /\b(?:project|story|team|teammate|situation|experience|internship|job|role|manager|company|example)\b/i;

// Behavioural follow-ups (STAR result / reflection questions).
const BEHAVIOURAL_FOLLOWUP_RE = /\b(?:what was the (?:result|outcome|impact|end result|takeaway|lesson)|what (?:did|have) you learn|what would you (?:do|have done) differently|what (?:would|could) you have done|looking back|in hindsight|how did (?:the team|they|your (?:manager|team|teammate|lead|boss)|people|he|she|it|that) (?:react|respond|take it|feel|go|turn out|end)|how did you (?:handle|resolve|measure|feel|convince|deal)|how did that (?:go|end|turn out|work out)|what happened (?:next|then|after|in the end)|what was your (?:role|part|contribution)|why did you (?:decide|choose|pick|go with)|did it work)\b/i;

// Short pronoun / deictic reference ("walk me through that").
const DEICTIC_RE = /\b(?:it|that|this|those|these|them|your (?:solution|approach|answer|code|idea|story|example|project))\b/i;
const DEICTIC_MAX_WORDS = 12;

const SYSTEM_DESIGN_RE = /\bsystem design\b|\bdesign (?:a|an) /i;
const EXPERIENCE_RE = /\b(?:tell me about yourself|walk me through your (?:resume|cv|background|career)|your experience (?:with|in|at)|have you (?:used|worked with|worked on)|what (?:projects|technologies|tools) have you|tell me about (?:your|a) (?:project|internship|role|previous)|what did you (?:build|work on))\b/i;

// Interviewer lines.
const CONSTRAINT_STRONG_RE = /\b(?:assume|assuming|you may assume|you can assume|you can'?t use|you cannot use|you can not use|without using|don'?t use|no extra (?:space|memory)|in o\(1\) (?:space|memory)|constant (?:extra )?(?:space|memory)|in[- ]place|must (?:run|be|not)|has to (?:run|be)|should run in|(?:is|are) guaranteed|there (?:is|will be) exactly one|time limit|memory limit)\b/i;
const CONSTRAINT_WEAK_RE = /\b(?:(?:n|k|m|the (?:array|input|string|list)(?: size| length)?) (?:is |will be )?(?:up to|at most|less than|no more than|<=?)\s*\d|up to \d[\d,.]*\s*(?:k|m|million|thousand|billion)?|at most \d|the input is (?:sorted|small|large|always|never|guaranteed)|(?:will|can) (?:always|never) be|between \d+ and \d+|fits in memory)\b/i;
const INTERVIEWER_FACT_RE = /\b(?:we use|we'?re using|we are using|we'?ve been using|we (?:mostly|mainly|primarily) use|our (?:team|stack|backend|frontend|product|company|codebase|platform|customers|users|infrastructure|engineers|engineering team|services?)|the (?:role|team|position|job) (?:is|involves|would|will|requires|includes)|in this role|we'?re building|we are building|we build|we'?re hiring|we have (?:a|an|about|around|over|\d)|we'?re (?:moving|migrating|switching)|we work (?:on|with|in))\b/i;
const PROBLEM_DETAIL_RE = /\b(?:given|return|input|output|example|for instance|e\.g\.|such that|each|every|target|indices|array|string|list|tree|graph)\b/i;

// Candidate lines: first-person experience claims (verbatim; the label is inferred).
const CLAIM_RE = /\bi(?:'ve| have)? (?:worked|used|built|led|managed|developed|designed|implemented|wrote|created|shipped|launched|migrated|founded|interned|studied|ran|owned|taught|tutored|mentored|deployed|maintained|automated|reduced|improved|cut|won)\b|\bi was (?:at|in charge|responsible|working|an? \w+ (?:at|on|for)|the \w+ (?:on|for|at))\b|\bi(?:'m| am) (?:currently )?(?:working|studying|responsible|an? \w+ at)\b|\b(?:at|during) my (?:last |previous |current |summer )?(?:job|internship|company|role|placement)\b/i;

const NEGATION_RE = /\b(?:not|never|no|without|instead of|rather than|avoid|avoiding|n't|dont|wouldnt|wont|cant|didnt|doesnt)\s*$/;

// ---------------------------------------------------------------------------
// Tokens for linking (overlap between a line and a thread's words).

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'for', 'with', 'that', 'this', 'it', 'as', 'at', 'by', 'its',
  'from', 'i', 'you', 'he', 'she', 'they', 'we', 'my', 'your', 'their', 'our', 'his', 'her',
  'me', 'what', 'how', 'why', 'when', 'where', 'who', 'can', 'could', 'would', 'should',
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'shall', 'about', 'if', 'so', 'than',
  'then', 'which', 'into', 'out', 'up', 'down', 'not', 'no', 'yes', 'there', 'here', 'these',
  'those', 'them', 'some', 'any', 'all', 'each', 'just', 'also', 'very', 'really', 'okay',
  'ok', 'yeah', 'sure', 'right', 'well', 'like', 'know', 'mean', 'think', 'thing', 'things',
  'something', 'way', 'want', 'need', 'use', 'used', 'using', 'make', 'made', 'let', "let's",
  'lets', 'going', 'back', 'earlier', 'mentioned', 'said', 'walk', 'through', 'explain',
  'more', 'one', 'get', 'got', 'done', 'now', 'first', 'next', 'move', 'moving', 'talk',
  'tell', 'time', 'question', 'solution', 'approach', 'answer', 'code', "i'd", "i'm",
  "it's", "that's", "what's", "you're", "we're", "don't", 'great', 'good', 'cool', 'nice',
  'thanks', 'alright', 'um', 'uh', 'hmm', 'kind', 'bit', 'little', 'lot', 'pretty', 'actually',
  'basically', 'probably', 'maybe', 'other', 'another', 'same', 'different', 'give', 'take',
  'see', 'look', 'say', 'went', 'go', 'come', 'came', 'try', 'tried', 'work', 'worked',
]);

function stem(word) {
  let w = word.replace(/'s$/, '');
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

function linkTokens(text) {
  const words = String(text || '').toLowerCase().replace(/[‘’]/g, "'").match(/[a-z0-9+#']+/g) || [];
  const out = new Set();
  for (const raw of words) {
    const w = raw.replace(/^'+|'+$/g, '');
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    const s = stem(w);
    if (s.length < 3 || STOPWORDS.has(s)) continue;
    out.add(s);
  }
  return out;
}

function wordCount(text) {
  return Intent.wordCount(text);
}

function normKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Lowercase, punctuation -> spaces (keeps c++, c#, node.js), padded with
// spaces so ` ${alias} ` is a whole-phrase match.
function normalizePhrase(text) {
  let t = String(text || '').toLowerCase().replace(/[‘’]/g, "'");
  t = t.replace(/[^a-z0-9+#.'%\s]/g, ' ').replace(/'/g, '').replace(/\.(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  return ` ${t} `;
}

// ---------------------------------------------------------------------------
// Atomic details (suggestions -> details; candidate lines -> matches).

// canonical -> aliases (already normalised: lowercase, single spaces).
// Deliberately small and conservative.
const VOCAB = [
  // data structures
  ['data_structure', 'hash map', ['hash map', 'hashmap', 'hash table', 'hashtable', 'dictionary', 'dict']],
  ['data_structure', 'hash set', ['hash set', 'hashset']],
  ['data_structure', 'linked list', ['linked list', 'linked lists']],
  ['data_structure', 'stack', ['stack']],
  ['data_structure', 'queue', ['queue', 'deque']],
  ['data_structure', 'heap', ['heap', 'min heap', 'max heap', 'priority queue']],
  ['data_structure', 'trie', ['trie', 'prefix tree']],
  ['data_structure', 'binary search tree', ['binary search tree', 'bst']],
  ['data_structure', 'union find', ['union find', 'disjoint set']],
  ['data_structure', 'segment tree', ['segment tree']],
  // techniques / algorithms
  ['technique', 'two pointers', ['two pointers', 'two pointer']],
  ['technique', 'sliding window', ['sliding window']],
  ['technique', 'binary search', ['binary search']],
  ['technique', 'BFS', ['bfs', 'breadth first search', 'breadth first']],
  ['technique', 'DFS', ['dfs', 'depth first search', 'depth first']],
  ['technique', 'dynamic programming', ['dynamic programming', 'dp']],
  ['technique', 'memoization', ['memoization', 'memoisation', 'memoize', 'memoise']],
  ['technique', 'recursion', ['recursion', 'recursive', 'recursively']],
  ['technique', 'backtracking', ['backtracking', 'backtrack']],
  ['technique', 'greedy', ['greedy']],
  ['technique', 'sorting', ['sorting', 'sort the', 'sort it']],
  ['technique', 'topological sort', ['topological sort']],
  ['technique', 'prefix sum', ['prefix sum', 'prefix sums', 'running sum']],
  ['technique', 'divide and conquer', ['divide and conquer']],
  ['technique', 'merge sort', ['merge sort', 'mergesort']],
  ['technique', 'quicksort', ['quicksort', 'quick sort']],
  ['technique', "Dijkstra's", ['dijkstra', 'dijkstras']],
  // languages / libraries / tools
  ['tool', 'Python', ['python']],
  ['tool', 'Java', ['java']],
  ['tool', 'JavaScript', ['javascript']],
  ['tool', 'TypeScript', ['typescript']],
  ['tool', 'Go', ['golang']],
  ['tool', 'C++', ['c++', 'cpp']],
  ['tool', 'C#', ['c#', 'c sharp']],
  ['tool', 'Rust', ['rust']],
  ['tool', 'Kotlin', ['kotlin']],
  ['tool', 'SQL', ['sql']],
  ['tool', 'PostgreSQL', ['postgres', 'postgresql']],
  ['tool', 'MySQL', ['mysql']],
  ['tool', 'MongoDB', ['mongodb', 'mongo']],
  ['tool', 'Redis', ['redis']],
  ['tool', 'Kafka', ['kafka']],
  ['tool', 'RabbitMQ', ['rabbitmq']],
  ['tool', 'Docker', ['docker']],
  ['tool', 'Kubernetes', ['kubernetes', 'k8s']],
  ['tool', 'AWS', ['aws']],
  ['tool', 'GCP', ['gcp', 'google cloud']],
  ['tool', 'Azure', ['azure']],
  ['tool', 'React', ['react']],
  ['tool', 'Node.js', ['node.js', 'nodejs']],
  ['tool', 'Django', ['django']],
  ['tool', 'Flask', ['flask']],
  ['tool', 'FastAPI', ['fastapi']],
  ['tool', 'Spring Boot', ['spring boot']],
  ['tool', 'pandas', ['pandas']],
  ['tool', 'NumPy', ['numpy']],
  ['tool', 'PyTorch', ['pytorch']],
  ['tool', 'TensorFlow', ['tensorflow']],
  ['tool', 'Celery', ['celery']],
  ['tool', 'GraphQL', ['graphql']],
  ['tool', 'Terraform', ['terraform']],
].map(([kind, canonical, aliases]) => ({ kind, canonical, key: `${kind}:${canonical.toLowerCase()}`, aliases }));

// Complexity: written "O(...)" and a few spoken forms -> marker words
// (cx_n, cx_nlogn, ...) inserted into the normalised text.
function complexityKey(inner) {
  let k = String(inner).toLowerCase().replace(/\s+/g, '').replace(/[*·]/g, '');
  k = k.replace(/\^2|²/g, '2').replace(/\^3|³/g, '3');
  if (k === 'one') k = '1';
  return `cx_${k.replace(/[^a-z0-9]/g, '_')}`;
}
const SPOKEN_COMPLEXITY = [
  [/\bbig o\b/g, 'o'],
  [/\bo of n log n\b|\bn log n\b/g, ' cx_nlogn '],
  [/\bo of log n\b|\blog n time\b|\blogarithmic(?: time| space)?\b/g, ' cx_logn '],
  [/\bo of n squared\b|\bn squared\b|\bquadratic(?: time| space)?\b/g, ' cx_n2 '],
  [/\bo of n\b|\blinear (?:time|space)\b/g, ' cx_n '],
  [/\bo of (?:1|one)\b|\bconstant (?:time|space|extra space|memory)\b/g, ' cx_1 '],
];
function withComplexityMarkers(text) {
  let t = String(text || '').toLowerCase().replace(/[‘’]/g, "'");
  t = t.replace(/\bo\s*\(\s*([^()]{1,15})\)/g, (_m, inner) => ` ${complexityKey(inner)} `);
  for (const [re, rep] of SPOKEN_COMPLEXITY) t = t.replace(re, rep);
  return t;
}
const COMPLEXITY_DISPLAY = { cx_1: 'O(1)', cx_n: 'O(n)', cx_logn: 'O(log n)', cx_nlogn: 'O(n log n)', cx_n2: 'O(n^2)' };

// Numbers with units / percentages -> "40 %", "20 min", "50k transactions".
const UNIT_CANON = {
  '%': '%', percent: '%', ms: 'ms', millisecond: 'ms', milliseconds: 'ms', s: 's', sec: 's', secs: 's', second: 's', seconds: 's',
  min: 'min', mins: 'min', minute: 'min', minutes: 'min', h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h', day: 'day', days: 'day',
  week: 'week', weeks: 'week', month: 'month', months: 'month', year: 'year', years: 'year', x: 'x', gb: 'gb', mb: 'mb', tb: 'tb', kb: 'kb',
  users: 'users', requests: 'requests', rps: 'rps', qps: 'qps', transactions: 'transactions', people: 'people', engineers: 'engineers',
};
const NUMBER_RE = /(\d+(?:[.,]\d+)?)(k|m)?\s?(%|percent\b|milliseconds?\b|ms\b|seconds?\b|secs?\b|minutes?\b|mins?\b|hours?\b|hrs?\b|days?\b|weeks?\b|months?\b|years?\b|x\b|gb\b|mb\b|tb\b|kb\b|users\b|requests\b|rps\b|qps\b|transactions\b|people\b|engineers\b)/gi;
function extractNumbers(text) {
  const out = [];
  const src = String(text || '');
  let m;
  NUMBER_RE.lastIndex = 0;
  while ((m = NUMBER_RE.exec(src))) {
    const unit = UNIT_CANON[m[3].toLowerCase()];
    if (!unit) continue;
    const num = `${m[1].replace(',', '.')}${(m[2] || '').toLowerCase()}`;
    out.push({ key: `number:${num} ${unit}`, text: m[0].trim(), index: m.index });
  }
  return out;
}

// Capitalised words that aren't names.
const COMMON_CAPS = new Set([
  'I', 'The', 'This', 'That', 'These', 'Those', 'So', 'And', 'But', 'Or', 'For', 'In', 'On', 'At', 'My', 'We', 'It', 'When',
  'What', 'Then', 'First', 'Next', 'Also', 'Use', 'Sure', 'Yes', 'No', 'Okay', 'OK', 'Situation', 'Task', 'Action', 'Result',
  'Time', 'Space', 'If', 'Once', 'After', 'Before', 'There', 'Here', 'You', 'Your', 'Our', 'They', 'He', 'She', 'As', 'By',
  'With', 'From', 'To', 'Of', 'A', 'An', 'One', 'Two', 'Three', 'Because', 'Since', 'While', 'Each', 'Every', 'Finally',
  'Lesson', 'Learned', 'Built', 'Led', 'Worked', 'Used', 'Projects', 'Project', 'Experience', 'Education', 'Skills',
  'Summary', 'Note', 'Example', 'Step', 'Approach', 'Complexity', 'Code', 'Edge', 'Cases', 'Test', 'Tests',
]);
const NAME_RE = /\b[A-Z][A-Za-z0-9]*[A-Za-z0-9](?:[ -][A-Z][A-Za-z0-9]*[A-Za-z0-9])*\b/g;

function hasWord(haystack, needle) {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9])${esc}(?:$|[^A-Za-z0-9])`).test(haystack);
}

// Names in an Echo suggestion that came from the knowledge snippets used
// for it (project / company / product names).
function namesFromKnowledge(text, knowledgeSources) {
  const snippets = (knowledgeSources || []).map((k) => String((k && k.text) || '')).filter(Boolean);
  if (!snippets.length) return [];
  const out = new Map();
  for (const m of String(text || '').match(NAME_RE) || []) {
    const parts = m.split(/[ -]/).filter((p) => !COMMON_CAPS.has(p));
    if (!parts.length) continue;
    const name = parts.join(' ');
    if (name.length < 3 || out.has(name.toLowerCase())) continue;
    if (VOCAB.some((v) => v.aliases.includes(name.toLowerCase()))) continue;
    if (snippets.some((s) => hasWord(s, name))) out.set(name.toLowerCase(), name);
  }
  return [...out.values()];
}

// Proper names a candidate said (not sentence-initial words).
function spokenNames(text) {
  const out = [];
  const sentences = String(text || '').split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    const words = s.trim().split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const w = words[i].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#]+$/g, '').replace(/'s$/, '');
      if (!/^[A-Z][A-Za-z0-9+#]+$/.test(w) || COMMON_CAPS.has(w)) continue;
      if (!out.includes(w)) out.push(w);
    }
  }
  return out;
}

const CODE_BLOCK_RE = /```[^\n]*\n([\s\S]*?)```/g;

// Atomic details of an Echo suggestion: [{ kind, key, text, aliases? }].
function extractDetails(text, knowledgeSources) {
  const details = [];
  const seen = new Set();
  const add = (d) => {
    if (seen.has(d.key)) return;
    seen.add(d.key);
    details.push(d);
  };
  const raw = String(text || '');
  const prose = raw.replace(CODE_BLOCK_RE, ' ');
  // Complexity (written or spoken forms).
  for (const m of withComplexityMarkers(prose).match(/\bcx_[a-z0-9_]+\b/g) || []) {
    const display = COMPLEXITY_DISPLAY[m] || `O(${m.slice(3).replace(/_/g, ' ').trim()})`;
    add({ kind: 'complexity', key: `complexity:${m}`, text: display, marker: m });
  }
  const norm = normalizePhrase(prose);
  for (const v of VOCAB) {
    if (v.aliases.some((a) => norm.includes(` ${a} `))) add({ kind: v.kind, key: v.key, text: v.canonical, aliases: v.aliases });
  }
  for (const n of extractNumbers(prose)) add({ kind: 'number', key: n.key, text: n.text });
  for (const name of namesFromKnowledge(prose, knowledgeSources)) {
    add({ kind: 'name', key: `name:${name.toLowerCase()}`, text: name, aliases: [normalizePhrase(name).trim()] });
  }
  return details;
}

function lastCodeBlock(text) {
  let last = null;
  let m;
  CODE_BLOCK_RE.lastIndex = 0;
  while ((m = CODE_BLOCK_RE.exec(String(text || '')))) last = m[0];
  return last;
}

function negatedBefore(normText, index) {
  const before = normText.slice(Math.max(0, index - 40), index).trim().split(' ').slice(-4).join(' ');
  return NEGATION_RE.test(before) || /\b(?:not|never|no|without|instead of|rather than|avoid|n't|dont|wouldnt|wont|cant|didnt)\b/.test(before);
}

// Does this candidate line contain this exact detail? -> { alias } | null
function matchDetail(detail, lineText) {
  if (!detail || detail.kind === 'code') return null;
  if (detail.kind === 'complexity') {
    const t = ` ${withComplexityMarkers(lineText).replace(/[^a-z0-9_+#\s]/g, ' ').replace(/\s+/g, ' ')} `;
    const at = t.indexOf(` ${detail.marker} `);
    if (at === -1 || negatedBefore(t, at)) return null;
    return { alias: detail.marker };
  }
  if (detail.kind === 'number') {
    const hit = extractNumbers(lineText).find((n) => n.key === detail.key);
    if (!hit) return null;
    const norm = String(lineText).toLowerCase();
    if (negatedBefore(norm, hit.index)) return null;
    return { alias: hit.text };
  }
  const norm = normalizePhrase(lineText);
  for (const alias of detail.aliases || []) {
    const at = norm.indexOf(` ${alias} `);
    if (at !== -1 && !negatedBefore(norm, at)) return { alias };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session.

function createSession({ now = () => Date.now() } = {}) {
  const s = { now, generation: 0 };
  resetState(s);
  return s;
}

function resetState(s) {
  s.generation = (s.generation || 0) + 1;
  s.seenLines = []; // raw transcript lines, as last seen (for prefix detection)
  s.lineOffset = 0; // absolute index of seenLines[0] (renderer trims the oldest lines in huge sessions)
  s.items = [];
  s.itemById = new Map();
  s.threads = [];
  s.threadMap = new Map();
  s.questions = [];
  s.questionMap = new Map();
  s.threadCache = new Map(); // threadId -> { terms: Map, candidateLines: n } (incremental; dropped on relink)
  s.suggestions = []; // { itemId, requestId, questionId, threadId, afterLine, detailIds, knowledge }
  s.currentThreadId = null;
  s.pendingTransition = false;
  s.lastLine = null; // { speaker, itemId, questionRecordId, endsMidThought }
  s.seq = { item: 0, thread: 0, question: 0, order: 0 };
  return s;
}

function resetSession(s) {
  return resetState(s);
}

function nextId(s, kind, prefix) {
  s.seq[kind] += 1;
  return `${prefix}${s.seq[kind]}`;
}

function rule(ref) {
  return { kind: 'rule', ref };
}

function label(name, confidence, ruleName) {
  return { label: name, confidence: round(confidence), source: rule(ruleName) };
}

function round(x) {
  return Math.round(Math.max(0, Math.min(1, x)) * 100) / 100;
}

function addItem(s, fields) {
  const item = {
    id: nextId(s, 'item', 'it'),
    type: fields.type,
    text: String(fields.text == null ? '' : fields.text),
    threadId: fields.threadId || null,
    questionId: fields.questionId || null,
    source: fields.source,
    status: fields.status,
    order: ++s.seq.order,
    timestamp: s.now(),
    labels: fields.labels || [],
  };
  if (typeof fields.confidence === 'number') item.confidence = round(fields.confidence);
  for (const [k, v] of Object.entries(fields)) {
    if (!(k in item) && k !== 'confidence') item[k] = v;
  }
  s.items.push(item);
  s.itemById.set(item.id, item);
  if (item.threadId) noteThreadItem(s, item);
  return item;
}

// Attach an item to a thread (keeps the per-thread cache in step).
function setThread(s, item, threadId) {
  item.threadId = threadId || null;
  if (item.threadId) noteThreadItem(s, item);
}

function threadById(s, id) {
  return (id && s.threadMap.get(id)) || null;
}
function questionById(s, id) {
  return (id && s.questionMap.get(id)) || null;
}
// The most recent `limit` threads that weren't merged into another one.
function liveThreads(s, limit = Infinity) {
  const out = [];
  for (let i = s.threads.length - 1; i >= 0 && out.length < limit; i--) {
    if (s.threads[i].status !== 'merged') out.push(s.threads[i]);
  }
  return out.reverse();
}

function familyOf(type) {
  if (type === 'technical_problem' || type === 'concept' || type === 'system_design') return 'technical';
  if (type === 'behavioural' || type === 'experience') return 'people';
  return null;
}

// Thread type of an opening question (reuses intent-core's classifiers).
function inferQuestionType(text, { intent, kind } = {}) {
  const technical = Intent.looksTechnical(text);
  if (technical && SYSTEM_DESIGN_RE.test(text)) return { type: 'system_design', confidence: 0.85, rule: 'system-design' };
  if (kind === 'problem') return { type: 'technical_problem', confidence: 0.85, rule: 'classifyQuestion:problem' };
  if (EXPERIENCE_RE.test(text)) return { type: 'experience', confidence: 0.75, rule: 'experience-question' };
  if (intent === 'behavioural_question') return { type: 'behavioural', confidence: 0.85, rule: 'intent:behavioural_question' };
  if (technical) return { type: 'concept', confidence: 0.7, rule: 'looksTechnical' };
  return { type: 'other', confidence: 0.5, rule: 'fallback' };
}

function analyzeLine(s, text) {
  const cur = threadById(s, s.currentThreadId);
  const curTechnical = !!cur && familyOf(cur.type) === 'technical';
  const hasPrior = s.questions.length > 0;
  const intent = Intent.classifyIntent(text, {
    mode: 'interview', speaker: 'them', prior: { hasPriorAnswer: hasPrior, lastAnswerTechnical: curTechnical },
  });
  const kind = Intent.classifyQuestion(text, { hasPriorAnswer: hasPrior, priorCode: curTechnical });
  return { intent: intent.intent, intentConfidence: intent.confidence, kind };
}

const QUESTION_INTENTS = new Set(['behavioural_question', 'technical_question', 'explanation_request', 'clarification_request', 'follow_up', 'direct_question']);
function isQuestionLine(text, analysis) {
  return Question.looksLikeQuestion(text) || QUESTION_INTENTS.has(analysis.intent);
}

// Weighted words of a thread (for overlap): its questions, interviewer and
// candidate lines and confirmed details (weight 1), Echo's suggestion details
// (1) and suggestion text (0.5). Linking is inference, so Echo's words may
// help find the thread; they never become facts.
const itemTokens = new WeakMap(); // item -> linkTokens(item.text); texts never change after creation
function tokensOf(it) {
  let t = itemTokens.get(it);
  if (!t) {
    t = linkTokens(it.text);
    itemTokens.set(it, t);
  }
  return t;
}

function itemTerms(it) {
  if (it.status === 'superseded') return null;
  if (it.type === 'interviewer_statement' || (it.type === 'candidate_statement' && it.source.kind === 'transcript')) return [tokensOf(it), 1];
  if (it.type === 'confirmed_detail') return [tokensOf(it), 1];
  if (it.type === 'echo_suggestion') return [tokensOf(it), it.detail ? 1 : 0.5];
  return null;
}

function putTerms(terms, tokens, w) {
  for (const t of tokens) if ((terms.get(t) || 0) < w) terms.set(t, w);
}

function isCandidateLine(it) {
  return it.type === 'candidate_statement' && it.source.kind === 'transcript' && it.status !== 'superseded';
}

function noteThreadItem(s, item) {
  const entry = s.threadCache.get(item.threadId);
  if (!entry) return; // built lazily on first use
  entry.items.push(item);
  const tw = itemTerms(item);
  if (tw) putTerms(entry.terms, tw[0], tw[1]);
  if (isCandidateLine(item)) entry.candidateLines += 1;
}

function threadEntry(s, threadId) {
  let entry = s.threadCache.get(threadId);
  if (!entry) {
    entry = { terms: new Map(), candidateLines: 0, items: [] };
    for (const it of s.items) {
      if (it.threadId !== threadId) continue;
      entry.items.push(it);
      const tw = itemTerms(it);
      if (tw) putTerms(entry.terms, tw[0], tw[1]);
      if (isCandidateLine(it)) entry.candidateLines += 1;
    }
    s.threadCache.set(threadId, entry);
  }
  return entry;
}

// excludeQuestionId leaves out a provisional question's own lines when
// weighing evidence for it (uncached; only a few threads, rarely).
function threadTerms(s, thread, excludeQuestionId) {
  if (!excludeQuestionId) return threadEntry(s, thread.id).terms;
  const terms = new Map();
  for (const it of threadEntry(s, thread.id).items) {
    if (it.threadId !== thread.id || it.questionId === excludeQuestionId) continue;
    const tw = itemTerms(it);
    if (tw) putTerms(terms, tw[0], tw[1]);
  }
  return terms;
}

function overlap(tokens, terms) {
  let score = 0;
  const shared = [];
  for (const t of tokens) {
    const w = terms.get(t);
    if (w) {
      score += w;
      shared.push(t);
    }
  }
  return { score, shared };
}

function threadHasCandidateLines(s, thread) {
  return threadEntry(s, thread.id).candidateLines > 0;
}

function mostRecentThread(s, predicate, exceptId) {
  const live = liveThreads(s, MAX_LINK_THREADS);
  for (let i = live.length - 1; i >= 0; i--) {
    if (live[i].id !== exceptId && predicate(live[i])) return live[i];
  }
  return null;
}

// The link decision for an interviewer question. Pure w.r.t. the session.
// -> { relation, targetThreadId, confidence, provisional, alternatives,
//      reasons, questionType }
function decideLink(s, text, { pendingTransition = false, analysis: given } = {}) {
  const analysis = given || analyzeLine(s, text);
  const qType = inferQuestionType(text, analysis);
  const qFamily = familyOf(qType.type);
  const threads = liveThreads(s, MAX_LINK_THREADS);
  const base = { questionType: qType, analysis };
  if (!threads.length) {
    return { ...base, relation: 'new', targetThreadId: null, confidence: 1, provisional: false, alternatives: [], reasons: ['first question of the session'] };
  }
  const cur = threadById(s, s.currentThreadId) || threads[threads.length - 1];
  const curFamily = familyOf(cur.type);
  const qTokens = linkTokens(text);
  const transition = TRANSITION_RE.test(text) || pendingTransition;
  const reference = REFERENCE_RE.test(text);

  const cands = new Map();
  const cand = (key, relation, targetThreadId, score) => cands.set(key, { relation, targetThreadId, score, reasons: [] });
  cand('new', 'new', null, 0.3);
  for (const t of threads) cand(t.id, 'follow_up', t.id, t.id === cur.id ? 0.3 : 0);
  const bump = (key, delta, why) => {
    const c = cands.get(key);
    if (!c) return;
    c.score += delta;
    if (why) c.reasons.push(why);
  };

  // Term overlap with every live thread.
  let maxShared = 0;
  const overlaps = new Map();
  for (const t of threads) {
    const o = overlap(qTokens, threadTerms(s, t));
    overlaps.set(t.id, o);
    maxShared = Math.max(maxShared, o.shared.length);
    if (o.shared.length) bump(t.id, 0.15 * Math.min(o.shared.length, 4), `shares terms with #${t.number}: ${o.shared.slice(0, 4).join(', ')}`);
    if (t.id !== cur.id && o.shared.length >= 2) bump(t.id, 0.2, `strong term overlap with older thread #${t.number}`);
  }

  if (reference) {
    let best = null;
    for (const t of threads) {
      const o = overlaps.get(t.id);
      if (o.shared.length && (!best || o.score > overlaps.get(best.id).score)) best = t;
    }
    if (!best && TECH_REF_NOUN_RE.test(text)) best = mostRecentThread(s, (t) => familyOf(t.type) === 'technical');
    if (!best && STORY_REF_NOUN_RE.test(text)) best = mostRecentThread(s, (t) => familyOf(t.type) === 'people');
    if (best) {
      bump(best.id, 0.7, `refers back to earlier talk ("${(text.match(REFERENCE_RE) || [''])[0]}") about #${best.number}`);
      if (best.id !== cur.id) bump(cur.id, -0.15);
      bump('new', -0.2);
    } else {
      bump(cur.id, 0.2, 'refers back to earlier talk (no thread matched; current thread)');
    }
  } else if (transition) {
    const alts = [{ relation: 'follow_up', targetThreadId: cur.id, score: 0.05 }];
    return {
      ...base, relation: 'new', targetThreadId: null, confidence: 0.95, provisional: false, alternatives: alts,
      reasons: [pendingTransition && !TRANSITION_RE.test(text) ? 'explicit transition just before this question' : 'explicit transition ("next question" / "let\'s move on")'],
    };
  }

  if (analysis.intent === 'behavioural_question') bump('new', 0.45, 'behavioural opener (intent-core)');
  if (analysis.kind === 'problem') bump('new', 0.5, 'new problem statement (classifyQuestion)');

  const techFollow = analysis.kind === 'followup';
  const behavFollow = BEHAVIOURAL_FOLLOWUP_RE.test(text) || analysis.intent === 'follow_up';
  const strongFollow = !reference && (techFollow || behavFollow);
  let redirected = false;
  const shortDeictic = DEICTIC_RE.test(text) && wordCount(text) <= DEICTIC_MAX_WORDS;
  if (strongFollow) {
    let target = cur;
    let why = techFollow ? 'technical follow-up (classifyQuestion)' : 'behavioural follow-up marker';
    if (techFollow && Intent.looksTechnical(text) && curFamily !== 'technical') {
      const t = mostRecentThread(s, (x) => familyOf(x.type) === 'technical');
      if (t) {
        target = t;
        why += `; technical, so the latest technical thread #${t.number}`;
      }
    } else if (!techFollow && behavFollow && curFamily === 'technical') {
      const t = mostRecentThread(s, (x) => familyOf(x.type) === 'people');
      if (t) {
        target = t;
        why += `; about a story, so the latest behavioural thread #${t.number}`;
      }
    }
    redirected = target.id !== cur.id;
    bump(target.id, 0.45, why);
    bump('new', -0.2);
  } else if (!reference && shortDeictic && analysis.kind !== 'problem' && analysis.intent !== 'behavioural_question') {
    const prev = mostRecentThread(s, (t) => threadHasCandidateLines(s, t), cur.id);
    if (!threadHasCandidateLines(s, cur) && prev) {
      bump(cur.id, 0.2, 'pronoun reference; current thread not answered yet');
      bump(prev.id, 0.4, `pronoun reference; #${prev.number} was the last thing answered`);
    } else {
      bump(cur.id, 0.35, 'pronoun reference to the current thread');
    }
    bump('new', -0.2);
  }

  if (!reference && !redirected && qFamily && curFamily && qFamily !== curFamily) {
    bump('new', 0.25, `type change (${curFamily} -> ${qFamily})`);
    bump(cur.id, -0.1);
  } else if (qFamily && qFamily === curFamily && analysis.kind !== 'problem') {
    bump(cur.id, 0.05);
  }
  if (!reference && !strongFollow && !shortDeictic && maxShared === 0) bump('new', 0.2, 'no follow-up marker and no shared terms');

  const ranked = [...cands.values()].map((c) => ({ ...c, score: Math.max(0, c.score) })).sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const sum = ranked.slice(0, 3).reduce((n, c) => n + c.score, 0);
  const confidence = sum > 0 ? top.score / sum : 0.5;
  const alternatives = ranked.slice(1, 4).filter((c) => c.score > 0).map((c) => ({ relation: c.relation, targetThreadId: c.targetThreadId, score: round(c.score) }));
  return {
    ...base,
    relation: top.relation,
    targetThreadId: top.targetThreadId,
    confidence: round(confidence),
    provisional: confidence < LINK_CONFIDENCE_THRESHOLD,
    alternatives,
    reasons: top.reasons.length ? top.reasons : ['default'],
  };
}

function publicDecision(d) {
  return {
    relation: d.relation,
    targetThreadId: d.targetThreadId,
    confidence: d.confidence,
    provisional: !!d.provisional,
    alternatives: d.alternatives.map((a) => ({ ...a })),
    reasons: [...d.reasons],
  };
}

function createThread(s, q, decision) {
  const number = s.threads.length + 1;
  const thread = {
    id: `th${number}`,
    number,
    title: clip(q.text, 160),
    type: decision.questionType.type,
    typeConfidence: decision.questionType.confidence,
    openedAt: s.now(),
    openedAtLine: q.lineIndex,
    status: 'open',
    mergedInto: null,
    questionIds: [],
    followUpIds: [],
    interviewerLineIds: [],
    candidateLineIds: [],
    suggestionIds: [],
    pinned: { problemStatement: [], constraints: [], interviewerFacts: [], candidateClaims: [], confirmedDetails: [] },
    code: null,
    knowledgeSources: [],
    typeItemId: null,
  };
  s.threads.push(thread);
  s.threadMap.set(thread.id, thread);
  s.threadCache.set(thread.id, { terms: new Map(), candidateLines: 0, items: [] }); // empty so far: no scan needed
  const typeItem = addItem(s, {
    type: 'inferred', text: `thread type: ${thread.type}`, threadId: thread.id, questionId: q.id,
    source: rule(`thread-type:${decision.questionType.rule}`), status: 'inferred', confidence: thread.typeConfidence,
  });
  thread.typeItemId = typeItem.id;
  return thread;
}

function clip(text, max) {
  const t = String(text || '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function linkItem(s, q, decision) {
  const d = publicDecision(decision);
  const thread = threadById(s, q.threadId);
  return addItem(s, {
    type: 'inferred',
    text: d.relation === 'new' ? `new thread #${thread ? thread.number : '?'}` : `follow-up of #${thread ? thread.number : '?'}`,
    threadId: q.threadId, questionId: q.id, source: rule('thread-link'), status: 'inferred', confidence: d.confidence, decision: d,
  });
}

// A new interviewer question: decide, create/attach, log.
function openQuestion(s, lineItem, analysis) {
  const decision = decideLink(s, lineItem.text, { pendingTransition: s.pendingTransition, analysis });
  s.pendingTransition = false;
  const q = {
    id: nextId(s, 'question', 'q'),
    text: lineItem.text,
    norm: normKey(lineItem.text),
    itemIds: [lineItem.id],
    lineIndex: lineItem.source.ref,
    threadId: null,
    link: null,
    linkItemId: null,
    evidence: {},
    resolution: null,
  };
  s.questions.push(q);
  s.questionMap.set(q.id, q);
  if (decision.relation === 'new') {
    const t = createThread(s, q, decision);
    q.threadId = t.id;
    decision.targetThreadId = t.id;
  } else {
    q.threadId = decision.targetThreadId;
  }
  q.link = publicDecision(decision);
  q.linkItemId = linkItem(s, q, decision).id;
  lineItem.questionId = q.id;
  setThread(s, lineItem, q.threadId);
  lineItem.labels.push(label('question', /\?/.test(lineItem.text) ? 0.9 : 0.7, 'question-core:looksLikeQuestion'));
  s.currentThreadId = q.threadId;

  // A later question that confidently picks one of a provisional question's
  // interpretations is (weak) evidence for it.
  if (!q.link.provisional && q.link.relation === 'follow_up') {
    for (const p of s.questions.slice(-MAX_LINK_THREADS)) {
      if (p === q || !p.link.provisional) continue;
      const targets = interpretationTargets(p);
      if (targets.includes(q.threadId)) addEvidence(s, p, q.threadId, 1, `later question #${q.id} followed up #${threadById(s, q.threadId).number}`);
    }
  }
  return q;
}

function interpretationTargets(q) {
  const out = [];
  if (q.link.relation === 'follow_up') out.push(q.link.targetThreadId);
  for (const a of q.link.alternatives) if (a.relation === 'follow_up' && a.targetThreadId && !out.includes(a.targetThreadId)) out.push(a.targetThreadId);
  return out;
}

function labelInterviewerStatement(s, item, thread, isQuestion) {
  const text = item.text;
  if (CONSTRAINT_STRONG_RE.test(text)) item.labels.push(label('constraint', 0.8, 'constraint:explicit'));
  else if (CONSTRAINT_WEAK_RE.test(text)) item.labels.push(label('constraint', 0.6, 'constraint:bound'));
  if (INTERVIEWER_FACT_RE.test(text)) item.labels.push(label('interviewer_fact', 0.75, 'interviewer-fact'));
  if (TRANSITION_RE.test(text)) item.labels.push(label('transition', 0.9, 'transition'));
  if (thread && thread.type === 'technical_problem' && !item.labels.some((l) => l.label === 'constraint' || l.label === 'interviewer_fact')) {
    const opening = isQuestion && thread.questionIds.length === 0 && thread.openedAtLine === item.source.ref;
    if (opening) item.labels.push(label('problem_statement', 0.8, 'problem-statement:opening-question'));
    else if (!isQuestion && !threadHasCandidateLines(s, thread) && PROBLEM_DETAIL_RE.test(text)) item.labels.push(label('problem_statement', 0.6, 'problem-statement:detail'));
  }
}

function hasLabel(item, name) {
  return item.labels.some((l) => l.label === name);
}

function parseLine(raw) {
  const m = /^(You|Them):\s?(.*)$/.exec(raw);
  if (!m) return null;
  return { speaker: m[1], text: m[2].trim() };
}

function ingestLine(s, raw, lineIndex) {
  const parsed = parseLine(raw);
  if (!parsed || !parsed.text) {
    s.lastLine = null;
    return;
  }
  const { speaker, text } = parsed;
  if (speaker === 'Them') {
    const item = addItem(s, {
      type: 'interviewer_statement', text, source: { kind: 'transcript', ref: lineIndex }, status: 'stated',
    });
    const analysis = analyzeLine(s, text);
    const prev = s.lastLine;
    // The second half of a question cut mid-sentence: same question.
    if (prev && prev.speaker === 'Them' && prev.questionRecordId && prev.endsMidThought) {
      const q = questionById(s, prev.questionRecordId);
      q.itemIds.push(item.id);
      q.text = `${q.text} ${text}`;
      q.norm = normKey(q.text);
      item.questionId = q.id;
      setThread(s, item, q.threadId);
      labelInterviewerStatement(s, item, threadById(s, q.threadId), false);
      s.lastLine = { speaker, itemId: item.id, questionRecordId: q.id, endsMidThought: Question.endsMidThought(text) };
      return;
    }
    if (isQuestionLine(text, analysis)) {
      const q = openQuestion(s, item, analysis);
      const thread = threadById(s, q.threadId);
      labelInterviewerStatement(s, item, thread, true);
      if (q.link.relation === 'new') thread.questionIds.push(q.id);
      else thread.followUpIds.push(q.id);
      adoptPendingSuggestions(s, q);
      s.lastLine = { speaker, itemId: item.id, questionRecordId: q.id, endsMidThought: Question.endsMidThought(text) };
      return;
    }
    // A statement: belongs to the current question / thread.
    const lastQ = s.questions[s.questions.length - 1] || null;
    item.questionId = lastQ ? lastQ.id : null;
    setThread(s, item, s.currentThreadId);
    labelInterviewerStatement(s, item, threadById(s, s.currentThreadId), false);
    if (TRANSITION_RE.test(text)) {
      s.pendingTransition = true;
      for (const p of s.questions) {
        if (p.link.provisional) finalizeProvisional(s, p, 'an explicit transition closed the topic');
      }
    } else if (lastQ && lastQ.link.provisional && item.questionId === lastQ.id) {
      weighEvidence(s, lastQ, item);
    }
    s.lastLine = { speaker, itemId: item.id, questionRecordId: null, endsMidThought: false };
    return;
  }
  // You: a candidate statement in the active (or provisional) thread.
  const lastQ = s.questions[s.questions.length - 1] || null;
  const item = addItem(s, {
    type: 'candidate_statement', text, threadId: s.currentThreadId, questionId: lastQ ? lastQ.id : null,
    source: { kind: 'transcript', ref: lineIndex }, status: 'stated', lineIndex,
  });
  if (CLAIM_RE.test(text)) item.labels.push(label('candidate_claim', 0.7, 'candidate-claim:first-person-experience'));
  if (lastQ && lastQ.link.provisional) weighEvidence(s, lastQ, item);
  confirmFromLine(s, item);
  s.lastLine = { speaker, itemId: item.id, questionRecordId: null, endsMidThought: false };
}

// ---- Provisional links: evidence and re-resolution ----

function addEvidence(s, q, threadId, amount, why) {
  q.evidence[threadId] = (q.evidence[threadId] || 0) + amount;
  q.evidenceReasons = q.evidenceReasons || [];
  if (why) q.evidenceReasons.push(why);
  maybeResolve(s, q);
}

function weighEvidence(s, q, lineItem) {
  const tokens = linkTokens(lineItem.text);
  for (const tid of interpretationTargets(q)) {
    const t = threadById(s, tid);
    if (!t || t.status === 'merged') continue;
    const o = overlap(tokens, threadTerms(s, t, q.id));
    let amount = o.score;
    const why = [];
    if (o.shared.length) why.push(`shares ${o.shared.slice(0, 4).join(', ')}`);
    if (lineItem.type === 'candidate_statement') {
      const hit = suggestionDetailsInThread(s, tid, q.id).find((d) => matchDetail(d.detail, lineItem.text));
      if (hit) {
        amount += 2;
        why.push(`says "${hit.text}" from a suggestion in #${t.number}`);
      }
    }
    if (amount > 0) {
      q.evidence[tid] = (q.evidence[tid] || 0) + amount;
      q.evidenceReasons = q.evidenceReasons || [];
      q.evidenceReasons.push(`${lineItem.type === 'candidate_statement' ? 'candidate answer' : 'interviewer line'} ${why.join('; ')} (#${t.number})`);
    }
  }
  maybeResolve(s, q);
}

const RESOLVE_MIN = 2;
const RESOLVE_MARGIN = 1.5;

function maybeResolve(s, q) {
  if (!q.link.provisional) return;
  const ranked = Object.entries(q.evidence).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return;
  const [bestId, best] = ranked[0];
  const second = ranked[1] ? ranked[1][1] : 0;
  if (best < RESOLVE_MIN || best - second < RESOLVE_MARGIN) return;
  const why = (q.evidenceReasons || []).slice(-2).join(' | ');
  if (q.link.relation === 'follow_up' && q.link.targetThreadId === bestId) {
    finalizeProvisional(s, q, `confirmed by later evidence: ${why}`, 0.8);
    return;
  }
  relink(s, q, bestId, `re-resolved by later evidence: ${why}`);
}

function finalizeProvisional(s, q, why, confidence) {
  const old = s.itemById.get(q.linkItemId);
  const decision = {
    ...q.link,
    provisional: false,
    confidence: typeof confidence === 'number' ? round(Math.max(confidence, q.link.confidence)) : q.link.confidence,
    reasons: [...q.link.reasons, why],
  };
  if (old) old.status = 'superseded';
  q.link = decision;
  q.resolution = why;
  q.linkItemId = linkItem(s, q, { ...decision, questionType: { type: 'other', confidence: 0 } }).id;
}

// Moves a question (and everything attached to it) to another thread.
function relink(s, q, targetThreadId, why) {
  const fromId = q.threadId;
  const from = threadById(s, fromId);
  const target = threadById(s, targetThreadId);
  const oldDecision = q.link;
  const alternatives = [{ relation: oldDecision.relation, targetThreadId: fromId, score: round(oldDecision.confidence) }]
    .concat(oldDecision.alternatives.filter((a) => a.targetThreadId !== targetThreadId && a.targetThreadId !== fromId));
  const decision = {
    relation: 'follow_up', targetThreadId, confidence: 0.8, provisional: false, alternatives, reasons: [why],
  };
  const old = s.itemById.get(q.linkItemId);
  if (old) old.status = 'superseded';
  q.link = decision;
  q.threadId = targetThreadId;
  q.resolution = why;
  // Everything attached to this question moves with it.
  const moved = [];
  for (const it of s.items) {
    if (it.questionId !== q.id || it.status === 'superseded') continue;
    if (it.type === 'inferred' && it.source.ref.startsWith('thread-type')) continue;
    it.threadId = targetThreadId;
    if (it.type === 'candidate_statement' && it.source.kind === 'transcript') moved.push(it);
  }
  for (const sug of s.suggestions) if (sug.questionId === q.id) sug.threadId = targetThreadId;
  s.threadCache.delete(fromId);
  s.threadCache.delete(targetThreadId);
  // Confirmations made in the wrong thread no longer hold.
  for (const it of s.items) {
    if (it.type !== 'confirmed_detail' || it.status === 'superseded') continue;
    if (!moved.some((m) => m.id === it.candidateLineId)) continue;
    const sug = s.suggestions.find((x) => x.itemId === it.suggestionItemId);
    if (!sug || sug.threadId !== targetThreadId) {
      it.status = 'superseded';
      const detail = s.itemById.get(it.detailItemId);
      if (detail && detail.confirmedBy === it.id) detail.confirmedBy = null;
    }
  }
  q.linkItemId = linkItem(s, q, { ...decision, questionType: { type: 'other', confidence: 0 } }).id;
  // A thread that only held this question is folded into the target.
  if (from && oldDecision.relation === 'new' && !s.questions.some((x) => x !== q && x.threadId === fromId)) {
    from.status = 'merged';
    from.mergedInto = targetThreadId;
    const typeItem = s.itemById.get(from.typeItemId);
    if (typeItem) typeItem.status = 'superseded';
  }
  if (s.questions[s.questions.length - 1] === q) s.currentThreadId = targetThreadId;
  for (const line of moved) confirmFromLine(s, line);
  void target;
}

// ---- Suggestions and per-detail confirmation ----

function suggestionDetailsInThread(s, threadId, excludeQuestionId) {
  const out = [];
  for (const sug of s.suggestions) {
    if (sug.threadId !== threadId) continue;
    if (excludeQuestionId && sug.questionId === excludeQuestionId) continue;
    for (const id of sug.detailIds) {
      const d = s.itemById.get(id);
      if (d && d.status !== 'superseded') out.push(d);
    }
  }
  return out;
}

function confirmFromLine(s, line) {
  if (!line.threadId) return;
  for (const sug of s.suggestions) {
    if (sug.threadId !== line.threadId || line.lineIndex < sug.afterLine) continue;
    for (const id of sug.detailIds) {
      const d = s.itemById.get(id);
      if (!d || d.status === 'superseded' || d.confirmedBy || d.detail.kind === 'code') continue;
      const hit = matchDetail(d.detail, line.text);
      if (!hit) continue;
      const confirmed = addItem(s, {
        type: 'confirmed_detail',
        text: d.text,
        threadId: line.threadId,
        questionId: line.questionId,
        source: { kind: 'transcript', ref: line.lineIndex },
        status: 'confirmed',
        detail: { ...d.detail },
        suggestionId: sug.requestId,
        suggestionItemId: sug.itemId,
        detailItemId: d.id,
        candidateLineId: line.id,
        candidateLineIndex: line.lineIndex,
        candidateText: line.text,
        matchedAlias: hit.alias,
      });
      d.confirmedBy = confirmed.id;
    }
  }
}

// After a suggestion finished. knowledgeSources: the snippets it was
// grounded in ({ source, index, text }). afterLine: transcript length when
// the request was made (only candidate lines from then on can confirm).
// generation: from planKnowledgeSearch(); a stale one (session reset since)
// is ignored.
function recordSuggestion(s, { requestId, threadId, questionId, question, text, knowledgeSources, afterLine, generation } = {}) {
  if (generation !== undefined && generation !== s.generation) return null;
  const body = String(text || '').trim();
  if (!body) return null;
  let q = questionId ? questionById(s, questionId) : null;
  if (!q && question) q = findQuestion(s, question);
  if (!q && !question && !threadId) q = s.questions[s.questions.length - 1] || null;
  const tid = q ? q.threadId : (threadId && threadById(s, threadId) ? threadId : null);
  const ref = requestId || `suggestion-${s.seq.item + 1}`;
  const sugItem = addItem(s, {
    type: 'echo_suggestion', text: body, threadId: tid, questionId: q ? q.id : null,
    source: { kind: 'suggestion', ref }, status: 'suggested', question: question || (q ? q.text : ''),
  });
  const knowledge = (knowledgeSources || []).filter((k) => k && k.source).map((k) => ({
    source: String(k.source), index: Number.isFinite(k.index) ? k.index : null, text: clip(k.text, KNOWLEDGE_TEXT_CHARS),
  }));
  const record = {
    itemId: sugItem.id, requestId: ref, questionId: q ? q.id : null, threadId: tid,
    afterLine: Number.isFinite(afterLine) ? afterLine : s.lineOffset + s.seenLines.length, detailIds: [],
    codeItemId: null,
  };
  for (const d of extractDetails(body, knowledge)) {
    const di = addItem(s, {
      type: 'echo_suggestion', text: d.text, threadId: tid, questionId: record.questionId,
      source: { kind: 'suggestion', ref }, status: 'suggested', detail: d, parentId: sugItem.id, confirmedBy: null,
    });
    record.detailIds.push(di.id);
  }
  const code = lastCodeBlock(body);
  const thread = tid ? threadById(s, tid) : null;
  if (code) {
    const ci = addItem(s, {
      type: 'echo_suggestion', text: code, threadId: tid, questionId: record.questionId,
      source: { kind: 'suggestion', ref }, status: 'suggested', detail: { kind: 'code', key: 'code' }, parentId: sugItem.id, confirmedBy: null,
    });
    record.detailIds.push(ci.id);
    record.codeItemId = ci.id;
  }
  if (thread) attachSuggestionToThread(s, record, thread, knowledge);
  if (!q && question) {
    // An early-start answer (renderer.js) is asked for before its question's
    // line reaches the transcript: link it when that line arrives
    // (adoptPendingSuggestions).
    record.pendingNorm = normKey(question);
    record.pendingKnowledge = thread ? [] : knowledge;
  }
  s.suggestions.push(record);
  // Candidate lines already spoken after the request may confirm details now.
  for (const it of s.items) {
    if (it.type === 'candidate_statement' && it.source.kind === 'transcript' && it.threadId === tid && tid && it.lineIndex >= record.afterLine) {
      confirmFromLine(s, it);
    }
  }
  rebuildThreads(s);
  return sugItem.id;
}

// The suggestion's code becomes the thread's current code; its knowledge
// snippets become the thread's knowledge sources.
function attachSuggestionToThread(s, record, thread, knowledge) {
  if (record.codeItemId) {
    const prev = thread.code && s.itemById.get(thread.code);
    if (prev && prev.id !== record.codeItemId) {
      prev.status = 'superseded';
      s.threadCache.delete(thread.id);
    }
    thread.code = record.codeItemId;
  }
  for (const k of knowledge || []) {
    if (thread.knowledgeSources.some((x) => x.source === k.source && x.index === k.index)) continue;
    const ki = addItem(s, {
      type: 'candidate_statement', text: k.text, threadId: thread.id, questionId: record.questionId,
      source: { kind: 'knowledge', ref: k.source }, status: 'stated', chunkIndex: k.index,
      labels: [label('knowledge_snippet', 1, 'knowledge-search')],
    });
    thread.knowledgeSources.push({ source: k.source, index: k.index, itemId: ki.id, requestId: record.requestId });
  }
}

// A question line just opened q: a suggestion recorded for it before the
// line arrived (early start) joins q -- and q's thread, if the request's own
// link decision had none (a new topic), so follow-ups find its code /
// knowledge and the candidate's next lines can confirm its details. One
// that was already linked to a different thread stays there. Matched on the
// question text, like findQuestion().
function adoptPendingSuggestions(s, q) {
  const thread = threadById(s, q.threadId);
  if (!thread) return;
  for (const rec of s.suggestions) {
    const n = rec.pendingNorm;
    if (!n || rec.questionId || rec.afterLine > q.lineIndex) continue;
    if (!(q.norm === n || n.includes(q.norm) || q.norm.includes(n))) continue;
    const knowledge = rec.pendingKnowledge;
    delete rec.pendingNorm;
    delete rec.pendingKnowledge;
    if (rec.threadId && rec.threadId !== thread.id) continue;
    const attach = !rec.threadId;
    rec.questionId = q.id;
    rec.threadId = thread.id;
    for (const id of [rec.itemId, ...rec.detailIds]) {
      const it = s.itemById.get(id);
      if (it) {
        it.questionId = q.id;
        it.threadId = thread.id;
      }
    }
    if (attach) attachSuggestionToThread(s, rec, thread, knowledge);
  }
}

// ---- Transcript ingestion ----

// lines: the renderer's whole transcript text ("You: ..." / "Them: ..."
// per line) or an array of such lines. Incremental: only lines past what
// was already seen are processed. A transcript that no longer extends the
// one seen before (cleared, or a new listening session) resets the session;
// one whose OLDEST lines were trimmed (huge sessions) keeps going.
function ingestTranscript(s, lines) {
  const arr = Array.isArray(lines)
    ? lines.map((l) => (typeof l === 'string' ? l : `${l.speaker}: ${l.text}`))
    : String(lines || '').split('\n');
  const next = arr.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
  const seen = s.seenLines;
  let start = 0;
  if (seen.length) {
    if (extendsPrefix(seen, next, 0)) {
      start = seen.length;
    } else {
      const d = trimmedOffset(seen, next);
      if (d > 0) {
        s.lineOffset += d;
        s.seenLines = seen.slice(d);
        start = s.seenLines.length;
      } else {
        resetState(s);
      }
    }
  }
  if (!s.seenLines.length && start === 0) s.seenLines = [];
  for (let i = start; i < next.length; i++) {
    s.seenLines.push(next[i]);
    ingestLine(s, next[i], s.lineOffset + i);
  }
  if (start < next.length) rebuildThreads(s);
  return { added: Math.max(0, next.length - start), generation: s.generation };
}

function extendsPrefix(seen, next, offset) {
  if (next.length < seen.length - offset) return false;
  for (let i = offset; i < seen.length; i++) if (seen[i] !== next[i - offset]) return false;
  return true;
}

function trimmedOffset(seen, next) {
  if (!next.length) return -1;
  for (let d = 1; d < seen.length; d++) {
    if (seen[d] === next[0] && extendsPrefix(seen, next, d)) return d;
  }
  return -1;
}

// Thread arrays / pinned facts / status, recomputed from the items.
function rebuildThreads(s) {
  const byThread = new Map(s.threads.map((t) => [t.id, []]));
  for (const it of s.items) {
    if (it.threadId && it.status !== 'superseded' && byThread.has(it.threadId)) byThread.get(it.threadId).push(it);
  }
  const qByThread = new Map(s.threads.map((t) => [t.id, []]));
  for (const q of s.questions) if (qByThread.has(q.threadId)) qByThread.get(q.threadId).push(q);
  for (const t of s.threads) {
    const mine = byThread.get(t.id);
    t.questionIds = qByThread.get(t.id).filter((q) => q.link.relation === 'new').map((q) => q.id);
    t.followUpIds = qByThread.get(t.id).filter((q) => q.link.relation === 'follow_up').map((q) => q.id);
    t.interviewerLineIds = mine.filter((it) => it.type === 'interviewer_statement').map((it) => it.id);
    t.candidateLineIds = mine.filter((it) => it.type === 'candidate_statement' && it.source.kind === 'transcript').map((it) => it.id);
    t.suggestionIds = mine.filter((it) => it.type === 'echo_suggestion' && !it.detail).map((it) => it.id);
    t.pinned = {
      problemStatement: mine.filter((it) => it.type === 'interviewer_statement' && hasLabel(it, 'problem_statement')).map((it) => it.id),
      constraints: mine.filter((it) => it.type === 'interviewer_statement' && hasLabel(it, 'constraint')).map((it) => it.id),
      interviewerFacts: mine.filter((it) => it.type === 'interviewer_statement' && hasLabel(it, 'interviewer_fact')).map((it) => it.id),
      candidateClaims: mine.filter((it) => it.type === 'candidate_statement' && hasLabel(it, 'candidate_claim')).map((it) => it.id),
      confirmedDetails: mine.filter((it) => it.type === 'confirmed_detail').map((it) => it.id),
    };
    t.knowledgeSources = t.knowledgeSources.filter((k) => {
      const it = s.itemById.get(k.itemId);
      return it && it.threadId === t.id;
    });
    // Knowledge snippets that moved here with their question (relink).
    for (const it of mine) {
      if (it.type !== 'candidate_statement' || it.source.kind !== 'knowledge') continue;
      if (t.knowledgeSources.some((k) => k.itemId === it.id || (k.source === it.source.ref && k.index === it.chunkIndex))) continue;
      t.knowledgeSources.push({ source: it.source.ref, index: it.chunkIndex, itemId: it.id });
    }
    if (t.status !== 'merged') t.status = t.candidateLineIds.length ? 'answered' : 'open';
  }
}

// ---- Queries ----

// The question record a request's question text refers to (the renderer
// may join two "Them" lines of one burst).
function findQuestion(s, text) {
  const n = normKey(text);
  if (!n) return null;
  for (let i = s.questions.length - 1; i >= 0; i--) {
    const q = s.questions[i];
    if (q.norm === n || n.endsWith(q.norm) || n.includes(q.norm) || q.norm.includes(n)) return q;
  }
  return null;
}

function itemView(it) {
  return it ? JSON.parse(JSON.stringify(it)) : null;
}

function threadView(s, t) {
  if (!t) return null;
  const v = JSON.parse(JSON.stringify(t));
  v.status = t.status;
  return v;
}

function itemsFor(s, ids) {
  return (ids || []).map((id) => itemView(s.itemById.get(id))).filter(Boolean);
}

// Everything known about the thread a question belongs to.
// question: the request's question text (optional: the latest question).
function getThreadContext(s, question) {
  let q = question ? findQuestion(s, question) : s.questions[s.questions.length - 1] || null;
  let link;
  let threadId;
  if (q) {
    link = publicDecision(q.link);
    threadId = q.threadId;
  } else if (question && String(question).trim()) {
    const d = decideLink(s, String(question), { pendingTransition: s.pendingTransition });
    link = { ...publicDecision(d), virtual: true };
    threadId = d.relation === 'follow_up' ? d.targetThreadId : null;
  } else {
    link = null;
    threadId = s.currentThreadId;
  }
  const thread = threadById(s, threadId);
  const related = [];
  const addRelated = (id) => {
    if (!id || id === threadId || related.some((r) => r.id === id)) return;
    const t = threadById(s, id);
    if (t && t.status !== 'merged') related.push(threadView(s, t));
  };
  if (link) for (const a of link.alternatives) addRelated(a.targetThreadId);
  if (thread) {
    const idx = s.threads.indexOf(thread);
    for (let i = idx - 1; i >= 0 && related.length < 3; i--) addRelated(s.threads[i].id);
  }
  const interpretations = link
    ? [{ relation: link.relation, targetThreadId: threadId, score: link.confidence, chosen: true }]
      .concat(link.alternatives.map((a) => ({ ...a, chosen: false })))
    : [];
  const all = s.items.filter((it) => it.status !== 'superseded');
  return {
    generation: s.generation,
    question: q ? { id: q.id, text: q.text, lineIndex: q.lineIndex, resolution: q.resolution } : (question ? { id: null, text: String(question) } : null),
    link,
    provisional: !!(link && link.provisional),
    interpretations,
    currentThread: threadView(s, thread),
    relatedThreads: related,
    pinned: thread ? {
      problemStatement: itemsFor(s, thread.pinned.problemStatement),
      constraints: itemsFor(s, thread.pinned.constraints),
      interviewerFacts: itemsFor(s, thread.pinned.interviewerFacts),
      candidateClaims: itemsFor(s, thread.pinned.candidateClaims),
      confirmedDetails: itemsFor(s, thread.pinned.confirmedDetails),
    } : { problemStatement: [], constraints: [], interviewerFacts: [], candidateClaims: [], confirmedDetails: [] },
    candidateStatements: thread ? itemsFor(s, thread.candidateLineIds) : [],
    code: thread && thread.code ? itemView(s.itemById.get(thread.code)) : null,
    knowledgeSources: thread ? threadKnowledgeSources(s, thread.id) : [],
    sessionFacts: {
      interviewerFacts: all.filter((it) => it.type === 'interviewer_statement' && hasLabel(it, 'interviewer_fact')).map(itemView),
      candidateClaims: all.filter((it) => it.type === 'candidate_statement' && hasLabel(it, 'candidate_claim')).map(itemView),
    },
  };
}

// Snippets already used for this thread, oldest first: [{ source, index, text }].
function threadKnowledgeSources(s, threadId) {
  const t = threadById(s, threadId);
  if (!t) return [];
  return t.knowledgeSources.map((k) => {
    const it = s.itemById.get(k.itemId);
    return { source: k.source, index: k.index, text: it ? it.text : '' };
  });
}

// The knowledge-base query for a question: the question itself, plus (for
// a thread with history) the thread's original question and key terms the
// candidate actually said (names, first-person claims) or confirmed, and
// the problem statement. Never Echo's unconfirmed suggestion text.
// A question that opens its own thread gets exactly the question back.
function buildKnowledgeQuery(s, question) {
  const ctx = getThreadContext(s, question);
  const q = String(question || (ctx.question && ctx.question.text) || '').trim() ? (question || ctx.question.text) : '';
  if (!q) return '';
  const thread = ctx.currentThread;
  if (!thread) return q;
  const parts = [];
  const qNorm = normKey(q);
  const title = threadTitleQuestion(s, thread);
  if (title && !qNorm.includes(normKey(title)) && !normKey(title).includes(qNorm)) parts.push(title);
  if (thread.type === 'technical_problem') {
    for (const it of ctx.pinned.problemStatement.slice(0, 2)) if (!parts.includes(it.text) && normKey(it.text) !== qNorm) parts.push(it.text);
  }
  const names = [];
  for (const it of ctx.candidateStatements) for (const n of spokenNames(it.text)) if (!names.includes(n)) names.push(n);
  if (names.length) parts.push(names.join(' '));
  for (const it of ctx.pinned.candidateClaims.slice(-MAX_CLAIMS_IN_QUERY)) parts.push(clip(it.text, CLAIM_QUERY_CHARS));
  const confirmed = [...new Set(ctx.pinned.confirmedDetails.map((it) => it.text))];
  if (confirmed.length) parts.push(confirmed.join(' '));
  if (!parts.length) return q;
  return clip(`${q} ${parts.join(' ')}`, MAX_QUERY_CHARS);
}

function threadTitleQuestion(s, thread) {
  const first = s.questions.find((q) => thread.questionIds.includes(q.id)) || s.questions.find((q) => q.threadId === thread.id);
  return first ? first.text : thread.title;
}

// ---- main.js entry points ----

// The legacy query (unchanged behaviour): the named question, else the
// instruction, else the text of the last transcript line.
function extractSearchQuery(transcript) {
  if (!transcript) return '';
  const lines = transcript.trim().split('\n').filter(Boolean);
  if (!lines.length) return '';
  const lastLine = lines[lines.length - 1];
  const colonIdx = lastLine.indexOf(':');
  return colonIdx !== -1 ? lastLine.slice(colonIdx + 1).trim() : lastLine.trim();
}

function legacySearchQuery({ question, instruction, transcript } = {}) {
  return question || instruction || extractSearchQuery(transcript);
}

// One call per ai:suggest request, before the knowledge search: ingests the
// transcript, links the request's question, and returns the knowledge query
// (+ snippets to prefer). Outside Interview mode the query is the legacy one.
// -> { query, prefer, legacyQuery, threadId, questionId, link, label,
//      generation, afterLine }
function planKnowledgeSearch(s, { transcript, question, instruction, mode } = {}) {
  const legacyQuery = legacySearchQuery({ question, instruction, transcript });
  ingestTranscript(s, transcript || '');
  const afterLine = s.lineOffset + s.seenLines.length;
  const named = typeof question === 'string' && question.trim() ? question : '';
  const latest = s.questions[s.questions.length - 1];
  const target = named || (!instruction && latest ? latest.text : '');
  const plan = {
    query: legacyQuery, prefer: [], legacyQuery, threadId: null, questionId: null, link: null, label: '', generation: s.generation, afterLine,
  };
  if (!target) return plan;
  const ctx = getThreadContext(s, target);
  plan.threadId = ctx.currentThread ? ctx.currentThread.id : null;
  plan.questionId = ctx.question ? ctx.question.id : null;
  plan.link = ctx.link;
  plan.label = describeLink(s, ctx);
  if (Intent.normalizeMode(mode) !== 'interview') return plan;
  plan.query = buildKnowledgeQuery(s, target) || legacyQuery;
  plan.prefer = plan.threadId ? threadKnowledgeSources(s, plan.threadId).map((k) => ({ source: k.source, index: k.index })) : [];
  return plan;
}

// Diagnostics: "#3 follow-up (0.82)" or "#4 new? (0.45, alt: follow-up of #3)".
function describeLink(s, ctx) {
  if (!ctx || !ctx.link) return '';
  const num = (id) => {
    const t = threadById(s, id);
    return t ? `#${t.number}` : '#?';
  };
  const l = ctx.link;
  const here = ctx.currentThread ? `#${ctx.currentThread.number}` : '(new)';
  const rel = l.relation === 'new' ? 'new' : 'follow-up';
  let out = `${here} ${rel}${l.provisional ? '?' : ''} (${l.confidence.toFixed(2)}`;
  const alt = l.alternatives[0];
  if (l.provisional && alt) out += `, alt: ${alt.relation === 'new' ? 'new thread' : `follow-up of ${num(alt.targetThreadId)}`}`;
  out += ')';
  return out;
}

// ---------------------------------------------------------------------------
// Phase 2b: the INTERVIEW STATE block and the shared answer direction.
//
// Both are pure, deterministic text built from the session (no API calls).
// main.js builds them ONCE per Interview-mode request (buildInterviewState)
// and passes the same strings to the full answer and the instant first line
// (ai.js puts the block after the background, before LATEST, and the
// direction line inside LATEST; the system prompt is untouched per request).
//
// Every line carries a source label. Only [You said] (the candidate's own
// transcript lines and details they actually said) and [From CV: file] are
// facts about the user; [Interviewer] is what the other side said, and
// [Echo suggested — not confirmed] is Echo's own earlier output, never the
// user's.
//
// Trimming: the block is made of units (one line each; Echo's code is one
// multi-line unit). Units are picked greedily in priority order
//   header > link uncertainty > current question + follow-ups >
//   [You said] lines / confirmed details / CV files > pinned constraints /
//   problem / interviewer facts > Echo suggestion / code > other threads
// (within a tier: the most recent first); a unit that doesn't fit is dropped
// whole (never cut mid-label) and smaller ones after it may still fit. The
// chosen units are then printed in reading order. The first line's smaller
// block is picked the same way from the full block's units, so it is always
// a subset of the full block, in the same order.

const STATE_BLOCK_MAX_CHARS = 1500;
const HEADLINE_STATE_BLOCK_MAX_CHARS = 900;
const STATE_HEADER = 'INTERVIEW STATE (labels show where each item came from; only [You said] and [From CV] are facts about the user)';
const L_INTERVIEWER = '[Interviewer]';
const L_YOU = '[You said]';
const L_ECHO = '[Echo suggested — not confirmed]';
const L_INFERRED = '[Inferred from the wording]';
const STATE_QUESTION_CHARS = 300;
const STATE_FOLLOWUPS = 4;
const STATE_FOLLOWUP_CHARS = 200;
const STATE_YOU_LINES = 4;
const STATE_YOU_LINE_CHARS = 280;
const STATE_YOU_TOTAL_CHARS = 700;
const STATE_PINNED_CHARS = 200;
const STATE_ECHO_POINTS = 8;
const STATE_ECHO_LINE_CHARS = 160;
const STATE_CODE_CHARS = 1200;
const STATE_CODE_MIN_CHARS = 160;
const STATE_CODE_LINE_CHARS = 160;
const STATE_OTHER_THREADS = 5;
const STATE_TITLE_CHARS = 80;
const SHORT_TITLE_CHARS = 48;
// A link counts as uncertain below the threshold, or below this when there
// is an alternative reading.
const CLOSE_ALTERNATIVE_CONFIDENCE = 0.7;
const APPROACH_KINDS = new Set(['data_structure', 'technique', 'complexity']);

const TIER = { header: 0, link: 1, question: 2, you: 3, pinned: 4, echo: 5, other: 6 };

function quote(text, max) {
  return `"${clip(String(text || '').replace(/\s+/g, ' '), max)}"`;
}

function typeName(type) {
  return String(type || 'other').replace(/_/g, ' ');
}

// Clip on a word boundary for short titles: "Given an array of integers, return…".
function shortTitle(text, max = SHORT_TITLE_CHARS) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

// A thread's question without a leading transition sentence ("Okay, let's
// move on. Tell me about..." -> "Tell me about..."), for titles.
function titleText(s, thread) {
  const text = threadTitleQuestion(s, thread);
  const sentences = String(text || '').split(/(?<=[.!?])\s+/);
  while (sentences.length > 1 && TRANSITION_RE.test(sentences[0])) sentences.shift();
  return sentences.join(' ');
}

function threadLabel(s, thread) {
  return `#${thread.number} (${shortTitle(titleText(s, thread))})`;
}

// The thread a request is about: its plan's thread, else (no question, e.g.
// Shorten) the current one.
function stateTarget(s, plan) {
  const p = plan || {};
  const link = p.link || null;
  let thread = threadById(s, p.threadId);
  if (thread && thread.status === 'merged') thread = threadById(s, thread.mergedInto);
  if (!thread && !link) thread = threadById(s, s.currentThreadId);
  return { thread, link, questionId: p.questionId || null };
}

function linkIsUncertain(link) {
  if (!link) return false;
  if (link.provisional || link.confidence < LINK_CONFIDENCE_THRESHOLD) return true;
  return link.alternatives.length > 0 && link.confidence < CLOSE_ALTERNATIVE_CONFIDENCE;
}

// A follow-up of a thread that isn't the newest one.
function refersBack(s, thread, link) {
  if (!thread || !link || link.relation !== 'follow_up') return false;
  return s.threads.some((t) => t.status !== 'merged' && t.number > thread.number);
}

// "a follow-up to #1 (Given an array…) or a new question" for every reading.
function interpretationPhrases(s, thread, link) {
  const out = [];
  const add = (relation, threadId) => {
    let phrase;
    if (relation === 'new') {
      const own = threadById(s, threadId);
      phrase = own ? `a new question (#${own.number})` : 'a new question';
    } else {
      const t = threadById(s, threadId);
      if (!t || t.status === 'merged') return;
      phrase = `a follow-up to ${threadLabel(s, t)}`;
    }
    if (!out.includes(phrase)) out.push(phrase);
  };
  add(link.relation, thread ? thread.id : link.targetThreadId);
  for (const a of link.alternatives) add(a.relation, a.targetThreadId);
  return out.slice(0, 3);
}

function liveItems(s, ids) {
  return (ids || []).map((id) => s.itemById.get(id)).filter((it) => it && it.status !== 'superseded');
}

// Candidate transcript lines of a thread, oldest first.
function candidateLines(s, thread) {
  return thread ? liveItems(s, thread.candidateLineIds).filter(isCandidateLine) : [];
}

// File names of the CV / notes snippets used for this thread (and this
// request), in first-use order.
function cvFiles(s, thread, knowledgeSnippets) {
  const out = [];
  for (const k of thread ? thread.knowledgeSources : []) if (k.source && !out.includes(k.source)) out.push(k.source);
  for (const k of knowledgeSnippets || []) if (k && k.source && !out.includes(String(k.source))) out.push(String(k.source));
  return out;
}

// Echo's code, shortened to `max` chars if needed: the fence + signature
// line + as many first/last lines as fit, with an elision marker.
function elideCode(code, max) {
  const lines = String(code || '').split('\n').map((l) => (l.length > STATE_CODE_LINE_CHARS ? `${l.slice(0, STATE_CODE_LINE_CHARS - 1)}…` : l));
  const whole = lines.join('\n');
  if (whole.length <= max) return whole;
  const open = /^```/.test(lines[0]) ? lines[0] : '```';
  const close = '```';
  const inner = lines.filter((l, i) => !(i === 0 && /^```/.test(l)) && !(i === lines.length - 1 && /^```\s*$/.test(l)));
  if (!inner.length) return null;
  const head = [inner[0]];
  const tail = [];
  let lo = 1;
  let hi = inner.length - 1;
  const render = () => {
    const omitted = inner.length - head.length - tail.length;
    const mid = omitted > 0 ? [`… (${omitted} line${omitted === 1 ? '' : 's'} omitted)`] : [];
    return [open, ...head, ...mid, ...tail, close].join('\n');
  };
  if (render().length > max) return null;
  let turn = 0;
  while (lo <= hi) {
    if (turn % 2 === 0) {
      head.push(inner[lo]);
      if (render().length > max) { head.pop(); break; }
      lo += 1;
    } else {
      tail.unshift(inner[hi]);
      if (render().length > max) { tail.shift(); break; }
      hi -= 1;
    }
    turn += 1;
  }
  return render();
}

// The candidate's approach in their latest line that names one (data
// structures, techniques, complexities), in the order they said them,
// skipping negated ones ("instead of sorting"). -> ['two pointers', ...]
function candidateApproach(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i].text;
    const norm = normalizePhrase(text);
    const found = [];
    for (const d of extractDetails(text)) {
      if (!APPROACH_KINDS.has(d.kind) || !matchDetail(d, text)) continue;
      let at = Infinity;
      if (d.kind === 'complexity') at = withComplexityMarkers(text).indexOf(d.marker) + 1e6; // after the named approach
      else for (const a of d.aliases || []) { const k = norm.indexOf(` ${a} `); if (k !== -1 && k < at) at = k; }
      found.push({ text: d.text, at });
    }
    if (found.length) return found.sort((a, b) => a.at - b.at).map((f) => f.text);
  }
  return [];
}

// Names the candidate said in this thread (project / company names).
function candidateNames(lines, max = 2) {
  const out = [];
  for (const it of lines) {
    for (const n of spokenNames(it.text)) {
      if (VOCAB.some((v) => v.aliases.includes(n.toLowerCase()))) continue;
      if (!out.includes(n)) out.push(n);
    }
  }
  return out.slice(0, max);
}

// The CV file the candidate's story came from: the thread's / request's
// snippet that shares the most words with what they said (else the first
// one used for the thread).
function storyFile(s, thread, lines, knowledgeSnippets) {
  const snippets = [];
  for (const k of thread ? threadKnowledgeSources(s, thread.id) : []) snippets.push(k);
  for (const k of knowledgeSnippets || []) if (k && k.source) snippets.push({ source: String(k.source), text: String(k.text || '') });
  if (!snippets.length) return null;
  const said = new Set();
  for (const it of lines) for (const t of tokensOf(it)) said.add(t);
  let best = null;
  let bestScore = 0;
  for (const k of snippets) {
    let score = 0;
    for (const t of linkTokens(k.text)) if (said.has(t)) score += 1;
    if (score > bestScore) { best = k; bestScore = score; }
  }
  if (best && bestScore >= 2) return best.source;
  return thread && thread.knowledgeSources.length ? thread.knowledgeSources[0].source : (lines.length ? null : snippets[0].source);
}

// All units of the block (unselected). unit: { tier, rank, order, text }.
function stateUnits(s, plan, { question, knowledgeSnippets } = {}) {
  const { thread, link, questionId } = stateTarget(s, plan);
  const units = [];
  let order = 0;
  const push = (tier, rank, text) => { if (text) units.push({ tier, rank, order: order++, text }); };
  push(TIER.header, 0, STATE_HEADER);

  // Link uncertainty / older-thread reference.
  if (link && linkIsUncertain(link)) {
    const phrases = interpretationPhrases(s, thread, link);
    if (phrases.length > 1) push(TIER.link, 0, `Link ${L_INFERRED}: this question may be ${phrases.join(' or ')} — decide from the wording.`);
  } else if (refersBack(s, thread, link)) {
    push(TIER.link, 0, `Link ${L_INFERRED}: refers back to ${threadLabel(s, thread)}, an earlier thread, not the latest one.`);
  }

  // Current question / thread.
  const askedNow = String(question || '').trim();
  if (thread) {
    const opener = threadTitleQuestion(s, thread);
    const isNew = link && link.relation === 'new';
    push(TIER.question, 0, `Current thread #${thread.number} (${typeName(thread.type)}${isNew ? ', new' : ''}). Original question: ${quote(opener, STATE_QUESTION_CHARS)} ${L_INTERVIEWER}`);
    const follow = s.questions.filter((q) => thread.followUpIds.includes(q.id));
    const now = askedNow && !follow.some((q) => q.id === questionId) && !(questionId && thread.questionIds.includes(questionId))
      && normKey(askedNow) !== normKey(opener) ? askedNow : '';
    const shown = follow.slice(-(now ? STATE_FOLLOWUPS - 1 : STATE_FOLLOWUPS));
    const fl = shown.map((q) => `Follow-up${q.id === questionId ? ' (asked now)' : ''}: ${quote(q.text, STATE_FOLLOWUP_CHARS)} ${L_INTERVIEWER}`);
    if (now) fl.push(`Follow-up (asked now): ${quote(now, STATE_FOLLOWUP_CHARS)} ${L_INTERVIEWER}`);
    // Most recent first when trimming, printed oldest first.
    fl.forEach((text, i) => push(TIER.question, 1 + (fl.length - 1 - i), text));
  } else if (askedNow) {
    push(TIER.question, 0, `Current question (a new thread): ${quote(askedNow, STATE_QUESTION_CHARS)} ${L_INTERVIEWER}`);
  }

  // What the candidate actually said in this thread.
  const lines = candidateLines(s, thread);
  const confirmed = [];
  for (const it of liveItems(s, thread ? thread.pinned.confirmedDetails : [])) if (!confirmed.includes(it.text)) confirmed.push(it.text);
  if (confirmed.length) push(TIER.you, 0, `Details the candidate said out loud: ${confirmed.map((c) => `[You said — confirmed: ${quote(c, 60)}]`).join(' ')}`);
  const youLines = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0 && youLines.length < STATE_YOU_LINES; i--) {
    const text = `${L_YOU} ${quote(lines[i].text, STATE_YOU_LINE_CHARS)}`;
    if (used + text.length > STATE_YOU_TOTAL_CHARS) break;
    used += text.length;
    youLines.unshift(text);
  }
  youLines.forEach((text, i) => push(TIER.you, 1 + (youLines.length - 1 - i), text));
  const files = cvFiles(s, thread, null);
  if (files.length) push(TIER.you, 1 + STATE_YOU_LINES, `CV files used for this thread: ${files.slice(0, 4).map((f) => `[From CV: ${f}]`).join(' ')}`);

  // Pinned interviewer facts.
  if (thread) {
    const seen = new Set([normKey(threadTitleQuestion(s, thread)), ...s.questions.filter((q) => q.threadId === thread.id).map((q) => q.norm)]);
    const pinnedLines = (ids, name, max) => {
      const out = [];
      for (const it of liveItems(s, ids)) {
        const k = normKey(it.text);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(`${name}: ${quote(it.text, STATE_PINNED_CHARS)} ${L_INTERVIEWER}`);
      }
      return out.slice(-max);
    };
    let rank = 0;
    for (const text of pinnedLines(thread.pinned.constraints, 'Constraint', 3)) push(TIER.pinned, rank++, text);
    for (const text of pinnedLines(thread.pinned.problemStatement, 'Problem detail', 2)) push(TIER.pinned, rank++, text);
    for (const text of pinnedLines(thread.pinned.interviewerFacts, 'Interviewer fact', 2)) push(TIER.pinned, rank++, text);
  }

  // Echo's earlier suggestion for this thread (never the user's facts).
  if (thread) {
    const sugs = s.suggestions.filter((r) => r.threadId === thread.id);
    const last = sugs[sugs.length - 1];
    const lastItem = last && s.itemById.get(last.itemId);
    if (lastItem && lastItem.status !== 'superseded') {
      const first = (lastItem.text.replace(CODE_BLOCK_RE, ' ').split('\n').map((l) => l.trim()).find((l) => l) || '');
      const points = [];
      for (const r of sugs) {
        for (const d of liveItems(s, r.detailIds)) {
          if (d.detail.kind === 'code' || d.confirmedBy) continue;
          if (confirmed.includes(d.text)) continue;
          const i = points.indexOf(d.text);
          if (i !== -1) points.splice(i, 1);
          points.push(d.text);
        }
      }
      let text = `Echo's earlier answer for #${thread.number} ${L_ECHO}:`;
      if (first) text += ` ${quote(first, STATE_ECHO_LINE_CHARS)}`;
      if (points.length) text += ` Points the candidate hasn't said: ${points.slice(-STATE_ECHO_POINTS).join(', ')}.`;
      push(TIER.echo, 0, text);
    }
    const code = thread.code && familyOf(thread.type) === 'technical' ? s.itemById.get(thread.code) : null;
    if (code && code.status !== 'superseded') {
      units.push({ tier: TIER.echo, rank: 1, order: order++, text: null, code: code.text, prefix: `Echo's latest code for #${thread.number} ${L_ECHO}:` });
    }
  }

  // Other threads, most recent first.
  const others = liveThreads(s).filter((t) => !thread || t.id !== thread.id).reverse().slice(0, STATE_OTHER_THREADS);
  others.forEach((t, i) => push(TIER.other, i, `Other thread #${t.number} (${typeName(t.type)}, ${t.status === 'answered' ? 'answered' : 'open'}): ${quote(titleText(s, t), STATE_TITLE_CHARS)} ${L_INTERVIEWER}`));
  void knowledgeSnippets;
  return units;
}

function unitText(u, budget) {
  if (u.text) return u.text;
  const room = Math.min(STATE_CODE_CHARS, budget - u.prefix.length - 1);
  if (room < STATE_CODE_MIN_CHARS) return null;
  const code = elideCode(u.code, room);
  return code ? `${u.prefix}\n${code}` : null;
}

// Greedy pick in priority order; returns the chosen units (with text).
function pickUnits(units, maxChars) {
  const ranked = [...units].sort((a, b) => a.tier - b.tier || a.rank - b.rank || a.order - b.order);
  const chosen = [];
  let used = 0;
  for (const u of ranked) {
    const sep = chosen.length ? 1 : 0;
    const text = unitText(u, maxChars - used - sep);
    if (!text || used + sep + text.length > maxChars) continue;
    used += sep + text.length;
    chosen.push({ ...u, text });
  }
  return chosen.sort((a, b) => a.order - b.order);
}

// Nothing beyond the header and the question itself: no block (a plain
// first question keeps exactly the old prompt).
function worthSending(chosen) {
  return chosen.some((u) => u.tier !== TIER.header && !(u.tier === TIER.question && u.rank === 0));
}

// The INTERVIEW STATE block for one request ('' when there's nothing to add).
// plan: planKnowledgeSearch()'s result (or { threadId, questionId, link }).
// opts: { maxChars = 1500, question }.
function buildStateBlock(s, plan, { maxChars = STATE_BLOCK_MAX_CHARS, question } = {}) {
  const chosen = pickUnits(stateUnits(s, plan, { question }), maxChars);
  return worthSending(chosen) ? chosen.map((u) => u.text).join('\n') : '';
}

// One line for LATEST, shared by the full answer and the first line.
// analysis: { intent, kind } (ai.analyzeSuggestion's intent / questionKind).
function buildAnswerDirection(s, plan, analysis = {}, { question, knowledgeSnippets } = {}) {
  const { intent, kind } = analysis || {};
  const { thread, link } = stateTarget(s, plan);
  const q = String(question || '').trim();
  // No question (e.g. Shorten / Expand an answer): nothing to direct.
  if (!link && !q) return '';
  const relation = link ? link.relation : (thread ? 'follow_up' : 'new');
  const uncertain = linkIsUncertain(link);
  let uncertainNote = '';
  if (uncertain) {
    const alts = [];
    for (const a of link.alternatives) {
      const t = threadById(s, a.targetThreadId);
      const phrase = a.relation === 'new' ? 'a new question' : (t && t.status !== 'merged' && (!thread || t.id !== thread.id) ? `#${t.number}` : '');
      if (phrase && !alts.includes(phrase)) alts.push(phrase);
    }
    if (alts.length) uncertainNote = ` Uncertain link: it may instead be about ${alts.slice(0, 2).join(' or ')}; go with the wording.`;
  }
  if (relation === 'new' || !thread) {
    const type = thread ? thread.type : inferQuestionType(q, { intent, kind }).type;
    const family = thread ? familyOf(type) : (kind === 'problem' ? 'technical' : familyOf(type));
    let line;
    if (type === 'technical_problem' || type === 'system_design' || (family === 'technical' && kind === 'problem')) line = 'Direction: new problem — start with the approach, then the walk-through.';
    else if (family === 'technical') line = 'Direction: new technical question — give the direct answer first.';
    else if (family === 'people' || intent === 'behavioural_question') line = 'Direction: new behavioural question — pick one real story from the CV; use [placeholders] if none fits.';
    else line = 'Direction: new question — answer it directly.';
    return `${line}${uncertainNote}`;
  }
  const lines = candidateLines(s, thread);
  const verb = refersBack(s, thread, link) && !uncertain ? 'refers back to' : 'follow-up on';
  const head = `Direction: ${uncertain ? 'probably a ' : ''}${verb} ${threadLabel(s, thread)}`;
  const family = familyOf(thread.type);
  let body;
  if (family === 'technical') {
    const approach = candidateApproach(lines);
    body = approach.length
      ? `answer in terms of the approach the candidate described: ${approach.join(', ')} ${L_YOU}.`
      : "answer the follow-up directly and stay consistent with what's already been said in this thread.";
  } else if (family === 'people') {
    const names = candidateNames(lines);
    const file = storyFile(s, thread, lines, knowledgeSnippets);
    const facts = [];
    if (names.length) facts.push(`${names.join(', ')} ${L_YOU}`);
    if (file) facts.push(`[From CV: ${file}]`);
    if (file) body = `stay with the same story (${facts.join('; ')}).`;
    else body = `stay with the same story${names.length ? ` (${facts[0]})` : ''}; no CV facts, so use [placeholders] for anything the candidate hasn't said.`;
  } else {
    body = 'build on what the candidate already said.';
  }
  return `${head} — ${body}${uncertainNote}`;
}

// Everything main.js needs for one Interview-mode request, computed once.
// -> { block, headlineBlock, direction, threadNumber, linkConfidence, diagnostic }
function buildInterviewState(s, plan, { question, analysis, knowledgeSnippets, maxChars = STATE_BLOCK_MAX_CHARS, headlineMaxChars = HEADLINE_STATE_BLOCK_MAX_CHARS } = {}) {
  const units = stateUnits(s, plan, { question });
  const full = pickUnits(units, maxChars);
  const block = worthSending(full) ? full.map((u) => u.text).join('\n') : '';
  // The first line's block: picked from the full block's own units.
  const head = block ? pickUnits(full.map((u) => ({ ...u, code: null })), headlineMaxChars) : [];
  const headlineBlock = worthSending(head) ? head.map((u) => u.text).join('\n') : '';
  const direction = buildAnswerDirection(s, plan, analysis, { question, knowledgeSnippets });
  const { thread, link } = stateTarget(s, plan);
  const threadNumber = thread ? thread.number : null;
  const linkConfidence = link ? link.confidence : null;
  const where = [threadNumber ? `thread #${threadNumber}` : 'new thread'];
  if (linkConfidence !== null) where.push(`link ${linkConfidence.toFixed(2)}`);
  return {
    block, headlineBlock, direction, threadNumber, linkConfidence,
    diagnostic: `State block: ${block.length} chars (${where.join(', ')})`,
  };
}

module.exports = {
  ITEM_TYPES,
  ITEM_STATUSES,
  SOURCE_KINDS,
  THREAD_TYPES,
  LINK_CONFIDENCE_THRESHOLD,
  createSession,
  resetSession,
  ingestTranscript,
  recordSuggestion,
  getThreadContext,
  buildKnowledgeQuery,
  threadKnowledgeSources,
  planKnowledgeSearch,
  describeLink,
  buildStateBlock,
  buildAnswerDirection,
  buildInterviewState,
  STATE_BLOCK_MAX_CHARS,
  HEADLINE_STATE_BLOCK_MAX_CHARS,
  STATE_HEADER,
  extractSearchQuery,
  legacySearchQuery,
  // pure helpers (tests)
  decideLink,
  extractDetails,
  matchDetail,
  spokenNames,
  linkTokens,
};
