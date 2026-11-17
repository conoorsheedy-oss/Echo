// The story bank on disk (story-bank.js does the checking and picking).
// Built once per version of the knowledge files, in the background, by one
// Gemini call (ai.extractStories), and cached in userData/story-bank.json
// with a hash of the files, so it's rebuilt only when they change. Can be
// switched off (Knowledge drawer); then no file is sent and nothing is used.
'use strict';

const fs = require('node:fs');
const SB = require('./story-bank');

// extract({ text, signal }) -> Promise<raw JSON object>   (ai.extractStories)
// getDocuments() -> [{ source, text }]                     (knowledge.getDocuments)
function createStoryStore({ file, extract, getDocuments, log = console } = {}) {
  let enabled = true;
  let stories = [];
  let forDocs = '';
  let status = 'empty'; // empty | off | building | ready | failed | none_found
  let lastError = '';
  let inFlight = null;
  // This listening session: story id -> the question it was told for.
  const used = new Map();

  function save() {
    try {
      fs.writeFileSync(file, JSON.stringify({ version: 1, enabled, forDocs, stories }, null, 1));
    } catch (err) {
      log.warn('[stories] Could not save the story bank:', err && err.message);
    }
  }

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      enabled = data.enabled !== false;
      forDocs = typeof data.forDocs === 'string' ? data.forDocs : '';
      // Re-check what was saved against nothing but its own shape (the files
      // are re-checked on the next rebuild if they changed).
      stories = Array.isArray(data.stories) ? data.stories.filter((s) => s && typeof s.id === 'string' && typeof s.title === 'string' && Array.isArray(s.quotes)) : [];
    } catch (err) {
      enabled = true;
      stories = [];
      forDocs = '';
    }
    status = !enabled ? 'off' : stories.length ? 'ready' : forDocs ? 'none_found' : 'empty';
  }

  // Rebuild if the files changed since the last build. Never rejects.
  function rebuild({ force = false } = {}) {
    if (!enabled) { status = 'off'; return Promise.resolve(); }
    const docs = getDocuments() || [];
    if (!docs.length) {
      if (inFlight) inFlight.abort();
      inFlight = null;
      stories = [];
      forDocs = '';
      status = 'empty';
      save();
      return Promise.resolve();
    }
    const hash = SB.docsHash(docs);
    if (!force && hash === forDocs && (status === 'ready' || status === 'none_found')) return Promise.resolve();
    if (inFlight) inFlight.abort();
    const controller = new AbortController();
    inFlight = controller;
    status = 'building';
    lastError = '';
    return Promise.resolve()
      .then(() => extract({ text: SB.buildExtractionInput(docs), signal: controller.signal }))
      .then((raw) => {
        if (inFlight !== controller) return;
        const { stories: checked, dropped } = SB.verifyStories(raw, docs);
        if (dropped) log.warn(`[stories] Dropped ${dropped} stor${dropped === 1 ? 'y' : 'ies'} that didn't match the files word for word.`);
        stories = checked;
        forDocs = hash;
        status = checked.length ? 'ready' : 'none_found';
        used.clear();
        save();
      })
      .catch((err) => {
        if (inFlight !== controller) return;
        status = 'failed';
        lastError = (err && err.code) || 'error';
        log.warn(`[stories] Story bank build failed (${lastError}).`);
      })
      .finally(() => {
        if (inFlight === controller) inFlight = null;
      });
  }

  function setEnabled(on) {
    enabled = on !== false;
    if (!enabled) {
      if (inFlight) inFlight.abort();
      inFlight = null;
      stories = [];
      forDocs = '';
      used.clear();
      status = 'off';
      save();
      return { ...view(), pending: Promise.resolve() };
    }
    status = 'empty';
    save();
    return { ...view(), pending: rebuild({ force: true }) };
  }

  function view() {
    return {
      enabled,
      status,
      error: lastError,
      count: stories.length,
      stories: stories.map((s) => ({ id: s.id, title: s.title, source: s.source, themes: s.themes })),
    };
  }

  // For one NEW behavioural question: the picked stories and their blocks.
  function plan({ question, keywords } = {}) {
    if (!enabled || status === 'off' || !stories.length) return null;
    const picked = SB.pickStories(stories, { question, keywords, used });
    if (!picked.length) return null;
    return {
      picked,
      block: SB.buildStoryBlock(picked, { used }),
      headlineLine: SB.buildHeadlineStoryLine(picked),
      diagnostic: `stories ${picked.map((s) => s.id).join(', ')}`,
    };
  }

  // After the answer: remember which story it told (if any).
  function noteAnswer(storyPlan, question, answer) {
    if (!storyPlan) return null;
    const told = SB.storyToldIn(answer, storyPlan.picked);
    if (told && !used.has(told.id)) used.set(told.id, String(question || '').slice(0, 200));
    return told;
  }

  function resetSession() {
    used.clear();
  }

  load();
  return { get: view, rebuild, setEnabled, plan, noteAnswer, resetSession, _used: used };
}

module.exports = { createStoryStore };
