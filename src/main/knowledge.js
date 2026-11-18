// Personal knowledge base: a tiny, dependency-free keyword search over plain
// text/markdown files the user drops into the `knowledge/` folder (their CV,
// project write-ups, notes, etc.). No embeddings/vector DB — just chunking +
// keyword overlap scoring, which is plenty for one person's personal files
// and keeps this feature completely free and offline.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Lives in Electron's private per-user app-data folder (same place the
// encrypted keys file lives), NOT inside the project/source folder -- so it's
// private to whoever's machine the app is running on, and nobody ever
// needs to open the source tree to find it.
const KNOWLEDGE_DIR = path.join(app.getPath('userData'), 'knowledge');
const CHUNK_SIZE = 700; // rough character budget per chunk
// A heading or one-liner shorter than this always joins the paragraph after
// it: alone it can win a search while saying nothing ("Project deep-dive 1:
// ovgraph (lead with this)"), and the model then guesses what the name means.
const MIN_CHUNK = 200;
const MAX_FILE_CHARS = 2_000_000; // ~2MB of text — generous for a CV/notes file, cheap to enforce

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'for', 'with', 'that', 'this', 'it', 'as', 'at', 'by',
  'from', 'i', 'you', 'he', 'she', 'they', 'we', 'my', 'your', 'their', 'our',
  'me', 'what', 'how', 'why', 'when', 'where', 'who', 'can', 'could', 'would',
  'should', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'shall', 'about',
  'if', 'so', 'than', 'then', 'which', 'into', 'out', 'up', 'down', 'not', 'no',
]);

let chunks = []; // { source, index, text, tokens }
let documents = []; // { source, text } -- whole files, for the story bank (story-store.js)
let loadedAt = null;
let failedFiles = []; // { file, reason } — surfaced in getStatus() so the UI (not just the console) can show them

function ensureKnowledgeDir() {
  if (fs.existsSync(KNOWLEDGE_DIR)) return;
  fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  const readme = `Drop your own background material here as plain .txt or .md files:
your CV, project write-ups, README files, lecture notes, past interview
answers, whatever you want the assistant to actually know about you.

Each file gets split into chunks. When you ask for a suggestion or use the
chat panel, the assistant searches these files for relevant snippets and
includes them as grounding context — so "tell me about a project where you
dealt with concurrency" gets answered from YOUR real projects instead of a
generic invented one.

Supported for now: .txt and .md only (no PDF/DOCX parsing yet — copy/paste
the text you want into a .md file as a workaround).

After adding or editing files here, click "Reload" in the app (or restart it)
to pick up the changes.

This folder lives in Echo's private app-data folder on this computer. The
snippets that match a question are sent to Gemini (under your key). With the
story bank on (Knowledge drawer), the files are also sent once each time they
change, to pull out your real stories.
`;
  fs.writeFileSync(path.join(KNOWLEDGE_DIR, 'README.txt'), readme, 'utf-8');
}

function splitIntoChunks(text) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const result = [];
  let buffer = '';
  for (const p of paragraphs) {
    if (buffer && buffer.length >= MIN_CHUNK && (buffer.length + p.length + 2) > CHUNK_SIZE) {
      result.push(buffer.trim());
      buffer = p;
    } else {
      buffer = buffer ? `${buffer}\n\n${p}` : p;
    }
  }
  if (buffer.trim()) result.push(buffer.trim());
  return result;
}

function tokenize(str) {
  return (str.toLowerCase().match(/[a-z0-9']+/g) || []).filter(
    (w) => w.length > 2 && !STOPWORDS.has(w)
  );
}

function loadKnowledgeBase() {
  ensureKnowledgeDir();
  chunks = [];
  documents = [];
  failedFiles = [];

  const files = fs
    .readdirSync(KNOWLEDGE_DIR)
    .filter((f) => /\.(txt|md)$/i.test(f) && f.toLowerCase() !== 'readme.txt');

  const seenChunkText = new Set(); // dedupe identical chunks (e.g. two copies of the same CV)

  for (const file of files) {
    try {
      const text = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf-8');
      if (text.length > MAX_FILE_CHARS) {
        failedFiles.push({ file, reason: `too large (${Math.round(text.length / 1000)}KB, limit ${Math.round(MAX_FILE_CHARS / 1000)}KB)` });
        continue;
      }
      let addedAny = false;
      splitIntoChunks(text).forEach((c, i) => {
        const dedupeKey = c.trim().toLowerCase();
        if (seenChunkText.has(dedupeKey)) return; // identical content already loaded from another file
        seenChunkText.add(dedupeKey);
        chunks.push({ source: file, index: i, text: c, tokens: tokenize(c) });
        addedAny = true;
      });
      if (addedAny) documents.push({ source: file, text });
      if (!addedAny && text.trim()) {
        // Every chunk in this file was a duplicate of content already loaded.
        failedFiles.push({ file, reason: 'duplicate content (skipped)' });
      }
    } catch (err) {
      console.error(`Failed to read knowledge file "${file}":`, err);
      failedFiles.push({ file, reason: 'could not be read' });
    }
  }

  loadedAt = Date.now();
  return getStatus();
}

// Plain keyword-overlap ranking — no embeddings, no API call, no cost.
// Score is normalized by chunk length (sqrt) so a long chunk doesn't
// automatically outscore a short, precise one purely by containing more
// words overall.
//
// opts.prefer (optional, used by interview follow-ups): [{ source, index }]
// chunks already used for the same interview thread. They get a
// PREFER_BOOST on their score, but only when they still match the query
// (score > 0), and the result is still the top K overall. Without opts the
// ranking is exactly as before.
const PREFER_BOOST = 1.5;

// "Tell me about yourself" / "walk me through your CV" share almost no words
// with a CV, so plain keyword search finds headings and plans instead of the
// profile. For these, search with profile words too and favour files named
// like a profile / CV.
const INTRO_RE = /\b(?:tell me (?:a (?:bit|little) )?about yourself|introduce yourself|walk me through your (?:cv|resume|résumé|background|career|experience)|(?:what's|what is|tell me about) your background|who are you)\b/i;
const INTRO_WORDS = 'student studying university degree year currently intern internship research project projects built backend experience';
const PROFILE_FILE_RE = /profile|about|cv|resume|bio/i;
const PROFILE_BOOST = 1.6;
function isIntroQuestion(query) {
  return INTRO_RE.test(String(query || ''));
}

function searchKnowledge(query, topK = 4, opts = undefined) {
  if (!chunks.length || !query) return [];

  const intro = isIntroQuestion(query);
  const queryCounts = {};
  for (const t of tokenize(intro ? `${query} ${INTRO_WORDS}` : query)) queryCounts[t] = (queryCounts[t] || 0) + 1;
  if (!Object.keys(queryCounts).length) return [];

  const prefer = opts && Array.isArray(opts.prefer) ? opts.prefer : [];
  const isPreferred = (c) => prefer.some((p) => p && p.source === c.source && p.index === c.index);

  const scored = chunks.map((c) => {
    let overlap = 0;
    for (const t of c.tokens) {
      if (queryCounts[t]) overlap += queryCounts[t];
    }
    let score = c.tokens.length ? overlap / Math.sqrt(c.tokens.length) : 0;
    if (score > 0 && prefer.length && isPreferred(c)) score *= PREFER_BOOST;
    if (score > 0 && intro && PROFILE_FILE_RE.test(c.source)) score *= PROFILE_BOOST;
    return { ...c, score };
  });

  return scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function getStatus() {
  return {
    fileCount: new Set(chunks.map((c) => c.source)).size,
    files: [...new Set(chunks.map((c) => c.source))],
    chunkCount: chunks.length,
    loadedAt,
    dir: KNOWLEDGE_DIR,
    failedFiles, // [{ file, reason }] — files that were skipped or failed to load
  };
}

// "Add a real story" (Knowledge drawer): appended to my-stories.md in the
// knowledge folder as a "## title" section, so it's searched like any other
// file and the story bank picks it up. The user can edit the file later.
const STORIES_FILE = 'my-stories.md';
function addStory({ title, text }) {
  ensureKnowledgeDir();
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const body = String(text || '').replace(/\r\n?/g, '\n').trim().slice(0, 3000);
  if (!body) throw new Error('Write the story first.');
  const file = path.join(KNOWLEDGE_DIR, STORIES_FILE);
  const exists = fs.existsSync(file);
  const head = exists ? '' : '# My stories\n\nReal stories, written by me. Echo uses them for behavioural questions.\n';
  fs.appendFileSync(file, `${head}\n## ${t || 'Story'}\n\n${body}\n`, 'utf-8');
  return STORIES_FILE;
}

// The loaded files' full text (story-store.js builds the story bank from it).
function getDocuments() {
  return documents.map((d) => ({ ...d }));
}

module.exports = { loadKnowledgeBase, searchKnowledge, getStatus, getDocuments, addStory, isIntroQuestion, splitIntoChunks, KNOWLEDGE_DIR };
