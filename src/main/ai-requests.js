// In-flight AI request registry (used by main.js; pure, so it's unit-tested).
//
// Every suggest/ask request gets its own AbortController, keyed by the
// renderer's requestId. Superseding rules for suggestions:
//   - a new *explicit* suggestion (Generate / hotkey / gesture / Regenerate /
//     Shorten / Expand) aborts every suggestion still in flight;
//   - a new *automatic* suggestion aborts only older automatic ones, so it
//     never kills an answer the user asked for.
// Chat ('ask') requests don't supersede anything; they can be cancelled by id.
'use strict';

function createRequestRegistry() {
  const inflight = new Map(); // id -> { controller, channel, kind }
  let anonSeq = 0;

  function start(channel, requestId, kind) {
    const requestKind = kind === 'auto' ? 'auto' : 'explicit';
    if (channel === 'suggest') {
      for (const entry of inflight.values()) {
        if (entry.channel === 'suggest' && (requestKind === 'explicit' || entry.kind === 'auto')) {
          entry.controller.abort();
        }
      }
    }
    const id = requestId || `anon-${++anonSeq}`;
    const existing = inflight.get(id);
    if (existing) existing.controller.abort(); // same id reused: newest wins
    const entry = { controller: new AbortController(), channel, kind: requestKind };
    inflight.set(id, entry);
    return {
      id,
      signal: entry.controller.signal,
      done() {
        if (inflight.get(id) === entry) inflight.delete(id);
      },
    };
  }

  function cancel(id) {
    const entry = inflight.get(id);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  return { start, cancel, size: () => inflight.size, has: (id) => inflight.has(id) };
}

module.exports = { createRequestRegistry };
