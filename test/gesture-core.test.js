// Unit tests for the hand-gesture hold/cooldown state machine.
// Run: npm test   (plain `node --test`, no dependencies)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HoldDetector, GESTURE_ACTIONS, COOLDOWN_MS } = require('../src/renderer/gesture-core.js');

const FPS = 12;
const STEP = Math.round(1000 / FPS);

// Feed `ms` worth of frames showing `gesture` (null = no hand) starting at t0.
// Returns { fired: [gesture names], last, t } where t is the next timestamp.
function feed(det, gesture, ms, t0, score = 0.9) {
  const fired = [];
  let last = null;
  let t = t0;
  for (; t < t0 + ms; t += STEP) {
    last = det.update({ gesture, score, t });
    if (last.fired) fired.push(last.fired.gesture);
  }
  return { fired, last, t };
}

test('mapping has unique gestures and actions, fist needs the longest hold', () => {
  const gestures = GESTURE_ACTIONS.map((e) => e.gesture);
  assert.equal(new Set(gestures).size, gestures.length);
  assert.equal(new Set(GESTURE_ACTIONS.map((e) => e.action)).size, gestures.length);
  const fist = GESTURE_ACTIONS.find((e) => e.gesture === 'Closed_Fist');
  assert.ok(fist.holdMs >= 1200);
});

test('a stable gesture fires exactly once after ~800 ms', () => {
  const det = new HoldDetector();
  let t = 0;
  const early = feed(det, 'Open_Palm', 700, t);
  assert.deepEqual(early.fired, [], 'must not fire before the hold time');
  assert.equal(early.last.state, 'holding');
  assert.ok(early.last.progress > 0.7 && early.last.progress < 1);
  const rest = feed(det, 'Open_Palm', 3000, early.t);
  assert.deepEqual(rest.fired, ['Open_Palm'], 'fires once, then stays quiet while still held');
  assert.equal(rest.last.state, 'locked');
});

test('progress grows monotonically while holding', () => {
  const det = new HoldDetector();
  let prev = -1;
  for (let t = 0; t < 750; t += STEP) {
    const r = det.update({ gesture: 'Thumb_Up', score: 0.95, t });
    assert.ok(r.progress >= prev);
    prev = r.progress;
  }
});

test('low-confidence frames never fire', () => {
  const det = new HoldDetector();
  const r = feed(det, 'Open_Palm', 3000, 0, 0.6);
  assert.deepEqual(r.fired, []);
  assert.equal(r.last.state, 'idle');
});

test('unmapped gestures (None, ILoveYou) never fire', () => {
  const det = new HoldDetector();
  assert.deepEqual(feed(det, 'None', 2000, 0).fired, []);
  assert.deepEqual(feed(det, 'ILoveYou', 2000, 2000).fired, []);
});

test('closed fist needs ~1.2 s', () => {
  const det = new HoldDetector();
  const a = feed(det, 'Closed_Fist', 1000, 0);
  assert.deepEqual(a.fired, []);
  const b = feed(det, 'Closed_Fist', 400, a.t);
  assert.deepEqual(b.fired, ['Closed_Fist']);
});

test('same gesture re-fires only after cooldown AND the hand leaving', () => {
  const det = new HoldDetector();
  const first = feed(det, 'Open_Palm', 900, 0);
  assert.deepEqual(first.fired, ['Open_Palm']);
  // keep holding past the cooldown: still locked, no re-fire
  const held = feed(det, 'Open_Palm', COOLDOWN_MS + 1500, first.t);
  assert.deepEqual(held.fired, []);
  // hand leaves for a moment, then the palm comes back and is held again
  const gone = feed(det, null, 400, held.t);
  const again = feed(det, 'Open_Palm', 900, gone.t);
  assert.deepEqual(again.fired, ['Open_Palm']);
});

test('hand leaving during cooldown still counts as a release', () => {
  const det = new HoldDetector();
  const first = feed(det, 'Victory', 900, 0);
  assert.deepEqual(first.fired, ['Victory']);
  const gone = feed(det, null, 500, first.t); // inside the 1.5 s cooldown
  const during = feed(det, 'Victory', 600, gone.t); // still cooling down
  assert.deepEqual(during.fired, []);
  const after = feed(det, 'Victory', 1200, during.t);
  assert.deepEqual(after.fired, ['Victory']);
});

test('a different gesture can fire after the cooldown without a release', () => {
  const det = new HoldDetector();
  const first = feed(det, 'Thumb_Up', 900, 0);
  assert.deepEqual(first.fired, ['Thumb_Up']);
  const cooling = feed(det, 'Victory', COOLDOWN_MS - 100, first.t);
  assert.deepEqual(cooling.fired, []);
  const next = feed(det, 'Victory', 1000, cooling.t);
  assert.deepEqual(next.fired, ['Victory']);
});

test('a one-frame dropout does not restart the hold; a long one does', () => {
  const det = new HoldDetector();
  let t = 0;
  for (; t < 500; t += STEP) det.update({ gesture: 'Open_Palm', score: 0.9, t });
  const blip = det.update({ gesture: 'None', score: 0.9, t });
  assert.equal(blip.state, 'holding');
  t += STEP;
  const r = feed(det, 'Open_Palm', 400, t);
  assert.deepEqual(r.fired, ['Open_Palm'], 'blip tolerated: fires at ~800 ms total');

  const det2 = new HoldDetector();
  const a = feed(det2, 'Open_Palm', 500, 0);
  const gap = feed(det2, null, 400, a.t);
  assert.equal(gap.last.state, 'idle');
  const b = feed(det2, 'Open_Palm', 500, gap.t);
  assert.deepEqual(b.fired, [], 'hold restarted after a real break');
});

test('switching gesture mid-hold restarts the timer', () => {
  const det = new HoldDetector();
  const a = feed(det, 'Open_Palm', 600, 0);
  const b = feed(det, 'Thumb_Up', 600, a.t);
  assert.deepEqual([...a.fired, ...b.fired], []);
  const c = feed(det, 'Thumb_Up', 300, b.t);
  assert.deepEqual(c.fired, ['Thumb_Up']);
});

test('a big gap between frames (window hidden) cancels the hold', () => {
  const det = new HoldDetector();
  feed(det, 'Open_Palm', 700, 0);
  const r = det.update({ gesture: 'Open_Palm', score: 0.9, t: 5000 });
  assert.equal(r.fired, null);
  assert.ok(r.progress < 0.2);
});

test('cancelHold keeps the lock so un-pausing never re-fires a held gesture', () => {
  const det = new HoldDetector();
  const first = feed(det, 'Open_Palm', 900, 0);
  assert.deepEqual(first.fired, ['Open_Palm']);
  det.cancelHold();
  const after = feed(det, 'Open_Palm', 3000, first.t);
  assert.deepEqual(after.fired, []);
  det.reset();
  const fresh = feed(det, 'Open_Palm', 900, after.t + 1000);
  assert.deepEqual(fresh.fired, ['Open_Palm']);
});

test('garbage frames are ignored', () => {
  const det = new HoldDetector();
  assert.equal(det.update(undefined).state, 'idle');
  assert.equal(det.update({ gesture: 'Open_Palm', score: NaN, t: 0 }).state, 'idle');
  assert.equal(det.update({ gesture: 42, score: 1, t: 10 }).state, 'idle');
});
