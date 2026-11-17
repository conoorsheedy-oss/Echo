// The saved interview brief (interview-brief.js) and its job ad summary.
// One JSON file in Electron's userData folder, on this machine only. The
// brief goes to Gemini only as part of Interview-mode prompts, and the ad
// once more to make its summary.
'use strict';

const fs = require('node:fs');
const B = require('./interview-brief');

// summarize({ text, signal }) -> Promise<string>  (ai.summarizeJobAd)
function createBriefStore({ file, summarize, log = console } = {}) {
  let brief = B.normalizeBrief({});
  let summary = null; // { text, forAd }
  let status = 'none'; // none | not_needed | pending | ready | failed
  let inFlight = null; // AbortController of the running summary
  let cachedPlan = null;

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      brief = B.normalizeBrief(data && data.brief);
      summary = data && data.summary && typeof data.summary.text === 'string' ? { text: String(data.summary.text), forAd: String(data.summary.forAd || '') } : null;
    } catch (err) {
      brief = B.normalizeBrief({});
      summary = null;
    }
    refreshStatus();
  }

  function save() {
    try {
      fs.writeFileSync(file, JSON.stringify({ version: 1, brief, summary }, null, 1));
    } catch (err) {
      log.warn('[brief] Could not save the interview brief:', err && err.message);
    }
  }

  function refreshStatus() {
    cachedPlan = null;
    if (!brief.jobAd) status = 'none';
    else if (!B.needsAdSummary(brief)) status = 'not_needed';
    else if (B.usableSummary(brief, summary)) status = 'ready';
    else if (status !== 'pending') status = 'failed';
  }

  // Starts the summary if this ad needs one and doesn't have it. Returns
  // the promise (tests), never rejects.
  function ensureSummary() {
    if (!B.needsAdSummary(brief) || B.usableSummary(brief, summary)) return Promise.resolve();
    if (inFlight) inFlight.abort();
    const controller = new AbortController();
    inFlight = controller;
    const forAd = B.adHash(brief.jobAd);
    status = 'pending';
    cachedPlan = null;
    return Promise.resolve()
      .then(() => summarize({ text: brief.jobAd, signal: controller.signal }))
      .then((text) => {
        if (inFlight !== controller || B.adHash(brief.jobAd) !== forAd) return;
        if (typeof text === 'string' && text.trim()) {
          summary = { text: text.trim(), forAd };
          status = 'ready';
          save();
        } else {
          status = 'failed';
        }
      })
      .catch((err) => {
        if (inFlight !== controller) return;
        status = 'failed';
        log.warn(`[brief] Job ad summary failed (${(err && err.code) || 'error'}); using the start of the ad instead.`);
      })
      .finally(() => {
        if (inFlight === controller) inFlight = null;
        cachedPlan = null;
      });
  }

  function view() {
    return {
      brief: { ...brief },
      summary: B.usableSummary(brief, summary),
      summaryStatus: status,
      empty: B.isEmptyBrief(brief),
      diagnostic: B.describeBrief(brief, summary, status),
    };
  }

  function set(raw) {
    const next = B.normalizeBrief(raw);
    const adChanged = next.jobAd !== brief.jobAd;
    brief = next;
    if (adChanged && !B.usableSummary(brief, summary)) summary = null;
    if (adChanged && inFlight) {
      inFlight.abort();
      inFlight = null;
      status = 'none';
    }
    refreshStatus();
    save();
    const pending = ensureSummary();
    return { ...view(), pending };
  }

  function clear() {
    return set({});
  }

  // What one Interview-mode request needs (null = no brief): the blocks,
  // the interview type and the role keywords. Cached until the brief or
  // its summary changes, so every request in a session gets the same text.
  function plan() {
    if (B.isEmptyBrief(brief)) return null;
    if (!cachedPlan) {
      cachedPlan = {
        block: B.buildBriefBlock(brief, summary),
        headlineBlock: B.buildHeadlineBriefBlock(brief, summary),
        type: brief.type,
        keywords: B.keywordsFor(brief, summary),
        company: B.companyName(brief),
        diagnostic: B.describeBrief(brief, summary, status),
      };
    }
    return cachedPlan;
  }

  load();
  return { get: view, set, clear, plan, ensureSummary, reload: load };
}

module.exports = { createBriefStore };
