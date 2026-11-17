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
  let drafts = []; // ideas to confirm (story-bank.js verifyDrafts)
  // draft key -> 'confirmed' | 'rejected': never offered again, across rebuilds.
  let decisions = {};
  // theme -> storyKey of the story told for it (kept across sessions and
  // rebuilds), so the same question gets the same story every interview.
  let goTo = {};
  let forDocs = '';
  let status = 'empty'; // empty | off | building | ready | failed | none_found
  let lastError = '';
  let inFlight = null;
  // This listening session: story id -> the question it was told for.
  const used = new Map();

  function save() {
    try {
      fs.writeFileSync(file, JSON.stringify({ version: 1, enabled, forDocs, stories, drafts, decisions, goTo }, null, 1));
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
      drafts = Array.isArray(data.drafts) ? data.drafts.filter((d) => d && typeof d.key === 'string' && typeof d.idea === 'string' && Array.isArray(d.themes)) : [];
      decisions = data.decisions && typeof data.decisions === 'object' ? data.decisions : {};
      goTo = data.goTo && typeof data.goTo === 'object' ? data.goTo : {};
    } catch (err) {
      goTo = {};
      enabled = true;
      stories = [];
      drafts = [];
      decisions = {};
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
      drafts = [];
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
        drafts = SB.verifyDrafts(raw, docs);
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
      drafts = [];
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
      stories: stories.map((s) => ({
        id: s.id, title: s.title, source: s.source, themes: s.themes,
        goToFor: Object.keys(goTo).filter((t) => goTo[t] === SB.storyKey(s)),
      })),
      // Ideas still waiting for "it happened / something like it / didn't happen".
      drafts: openDrafts().map(draftView),
    };
  }

  function decidedKeys() {
    return new Set(Object.keys(decisions));
  }
  function openDrafts() {
    return enabled ? drafts.filter((d) => !decisions[d.key]) : [];
  }
  function draftView(d) {
    return { key: d.key, title: d.title, idea: d.idea, basis: d.basis, source: d.source, themes: d.themes };
  }

  // A behavioural question with no confirmed story for its theme: an idea
  // for the answer card (never put into the answer itself).
  function draftFor({ question } = {}) {
    if (!enabled) return null;
    const d = SB.pickDraft(drafts, { question, stories, decided: decidedKeys() });
    return d ? draftView(d) : null;
  }

  // decision: 'confirmed' | 'rejected'. A confirmed draft is saved as a real
  // story by the caller (knowledge.addStory), which rebuilds the bank.
  function decideDraft(key, decision) {
    const d = drafts.find((x) => x.key === key);
    if (!d || (decision !== 'confirmed' && decision !== 'rejected')) return null;
    decisions[key] = decision;
    save();
    return draftView(d);
  }

  // For one NEW behavioural question: the picked stories and their blocks.
  function plan({ question, keywords } = {}) {
    if (!enabled || status === 'off' || !stories.length) return null;
    const picked = SB.pickStories(stories, { question, keywords, used, goTo });
    if (!picked.length) return null;
    return {
      picked,
      question,
      block: SB.buildStoryBlock(picked, { used, question, goTo }),
      headlineLine: SB.buildHeadlineStoryLine(picked),
      diagnostic: `stories ${picked.map((s) => s.id).join(', ')}`,
    };
  }

  // After the answer: remember which story it told (if any).
  function noteAnswer(storyPlan, question, answer) {
    if (!storyPlan) return null;
    const told = SB.storyToldIn(answer, storyPlan.picked);
    if (told && !used.has(told.id)) used.set(told.id, String(question || '').slice(0, 200));
    // The first story told for a theme becomes the go-to for it.
    if (told) {
      let changed = false;
      for (const t of SB.themesForQuestion(question)) {
        if (!goTo[t] && told.themes.includes(t)) { goTo[t] = SB.storyKey(told); changed = true; }
      }
      if (changed) save();
    }
    return told;
  }

  function resetSession() {
    used.clear();
  }

  load();
  // The user can free a theme ("pick again next time").
  function clearGoTo(theme) {
    if (theme === undefined) goTo = {};
    else delete goTo[theme];
    save();
    return view();
  }

  return { get: view, rebuild, setEnabled, plan, noteAnswer, resetSession, draftFor, decideDraft, clearGoTo, _used: used };
}

module.exports = { createStoryStore };
