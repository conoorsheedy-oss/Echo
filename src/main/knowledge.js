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

This folder lives in Echo's private app-data folder on this computer. Only
the few snippets that match a question are sent to Gemini (under your key).
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
    if (buffer && (buffer.length + p.length + 2) > CHUNK_SIZE) {
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
function searchKnowledge(query, topK = 4) {
  if (!chunks.length || !query) return [];

  const queryCounts = {};
  for (const t of tokenize(query)) queryCounts[t] = (queryCounts[t] || 0) + 1;
  if (!Object.keys(queryCounts).length) return [];

  const scored = chunks.map((c) => {
    let overlap = 0;
    for (const t of c.tokens) {
      if (queryCounts[t]) overlap += queryCounts[t];
    }
    const score = c.tokens.length ? overlap / Math.sqrt(c.tokens.length) : 0;
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

module.exports = { loadKnowledgeBase, searchKnowledge, getStatus, KNOWLEDGE_DIR };
