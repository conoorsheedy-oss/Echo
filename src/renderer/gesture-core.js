// Hand gestures -- the pure part: the gesture -> action map and the
// hold-to-confirm state machine. No DOM, no camera, no MediaPipe, so it can
// be unit-tested in plain Node (test/gesture-core.test.js) with synthetic
// frames. Loaded as a classic script before gestures.js (window.EchoGestureCore).
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.EchoGestureCore = core;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // A gesture must be recognised at least this confidently to count.
  const MIN_SCORE = 0.7;
  // ...and held this long before it fires (per-gesture holdMs overrides).
  const DEFAULT_HOLD_MS = 800;
  // After anything fires, nothing else can start for this long.
  const COOLDOWN_MS = 1500;
  // The SAME gesture can only fire again after the hand has left/changed for
  // at least this long (so holding a palm up doesn't fire every 1.5 s).
  const RELEASE_MS = 300;
  // A brief recognition dropout (a frame or two of "None" mid-hold) doesn't
  // restart the hold -- MediaPipe flickers a little between frames.
  const GRACE_MS = 200;
  // Frames further apart than this (window hidden, paused, slow machine)
  // reset an in-progress hold rather than firing on stale evidence.
  const MAX_FRAME_GAP_MS = 600;

  // MediaPipe's canned gesture names -> Echo actions. The Settings table is
  // rendered from this list, so it is the single source of truth.
  const GESTURE_ACTIONS = Object.freeze([
    Object.freeze({ gesture: 'Open_Palm', label: 'Open palm', action: 'generate', actionLabel: 'Generate an answer', short: 'Generate' }),
    // Starting/stopping by accident is the most disruptive, so a longer hold.
    Object.freeze({ gesture: 'Closed_Fist', label: 'Closed fist', action: 'toggle-listen', actionLabel: 'Start / stop listening', short: 'Start/stop listening', holdMs: 1200 }),
    Object.freeze({ gesture: 'Thumb_Up', label: 'Thumb up', action: 'copy', actionLabel: 'Copy the answer', short: 'Copy' }),
    Object.freeze({ gesture: 'Pointing_Up', label: 'Pointing up', action: 'scroll-up', actionLabel: 'Scroll the answer up', short: 'Scroll up' }),
    Object.freeze({ gesture: 'Victory', label: 'Victory (V sign)', action: 'capture', actionLabel: 'Capture a screenshot', short: 'Capture screenshot' }),
    Object.freeze({ gesture: 'Thumb_Down', label: 'Thumb down', action: 'clear-screenshots', actionLabel: 'Clear attached screenshots', short: 'Clear screenshots' }),
  ]);

  // Hold-to-confirm. Feed it one frame per recognition result:
  //   update({ gesture: 'Open_Palm' | 'None' | null, score: 0..1, t: ms })
  // and it returns
  //   { state: 'idle' | 'holding' | 'cooldown' | 'locked', gesture, entry,
  //     progress: 0..1, fired: entry | null }
  // `fired` is set on exactly one frame per confirmed gesture.
  class HoldDetector {
    constructor(options = {}) {
      const mapping = options.mapping || GESTURE_ACTIONS;
      this.minScore = options.minScore ?? MIN_SCORE;
      this.holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
      this.cooldownMs = options.cooldownMs ?? COOLDOWN_MS;
      this.releaseMs = options.releaseMs ?? RELEASE_MS;
      this.graceMs = options.graceMs ?? GRACE_MS;
      this.maxGapMs = options.maxGapMs ?? MAX_FRAME_GAP_MS;
      this.byGesture = new Map(mapping.map((e) => [e.gesture, e]));
      this.reset();
    }

    // Forget everything (used when gestures are switched off/on).
    reset() {
      this.cancelHold();
      this.lastFrameT = null;
      this.cooldownUntil = -Infinity;
      this.locked = null; // gesture that fired and hasn't been released yet
      this.releaseStart = null;
    }

    // Drop an in-progress hold but keep cooldown/lock (used while gated, e.g.
    // Settings open or typing), so pausing never makes something fire later.
    cancelHold() {
      this.holdGesture = null;
      this.holdStart = 0;
      this.lastMatchT = 0;
    }

    holdMsFor(entry) {
      return entry && Number.isFinite(entry.holdMs) ? entry.holdMs : this.holdMs;
    }

    update(frame) {
      const t = Number(frame && frame.t);
      const name = frame && typeof frame.gesture === 'string' ? frame.gesture : null;
      const score = frame && Number.isFinite(frame.score) ? frame.score : 0;
      const result = { state: 'idle', gesture: null, entry: null, progress: 0, fired: null };
      if (!Number.isFinite(t)) return result;

      if (this.lastFrameT !== null && (t - this.lastFrameT > this.maxGapMs || t < this.lastFrameT)) {
        this.cancelHold();
      }
      this.lastFrameT = t;

      const entry = name && score >= this.minScore ? this.byGesture.get(name) || null : null;
      const candidate = entry ? entry.gesture : null;

      // Release the lock on the last-fired gesture once the hand has shown
      // something else (or nothing) for releaseMs.
      if (this.locked) {
        if (name === this.locked) {
          this.releaseStart = null;
        } else if (this.releaseStart === null) {
          this.releaseStart = t;
        } else if (t - this.releaseStart >= this.releaseMs) {
          this.locked = null;
          this.releaseStart = null;
        }
      }

      if (t < this.cooldownUntil) {
        this.cancelHold();
        result.state = 'cooldown';
        return result;
      }

      if (candidate && candidate === this.locked) {
        this.cancelHold();
        result.state = 'locked';
        result.gesture = candidate;
        result.entry = entry;
        return result;
      }

      if (candidate && candidate === this.holdGesture) {
        this.lastMatchT = t;
      } else if (this.holdGesture && t - this.lastMatchT <= this.graceMs && (!candidate || candidate === this.locked)) {
        // brief dropout: keep the hold, don't advance it
      } else if (candidate) {
        this.holdGesture = candidate;
        this.holdStart = t;
        this.lastMatchT = t;
      } else {
        this.cancelHold();
        return result;
      }

      const holding = this.byGesture.get(this.holdGesture);
      const needed = this.holdMsFor(holding);
      const progress = Math.max(0, Math.min(1, (this.lastMatchT - this.holdStart) / needed));
      result.gesture = this.holdGesture;
      result.entry = holding;
      result.progress = progress;
      result.state = 'holding';

      if (progress >= 1) {
        result.fired = holding;
        result.state = 'cooldown';
        this.locked = holding.gesture;
        this.releaseStart = null;
        this.cooldownUntil = t + this.cooldownMs;
        this.cancelHold();
      }
      return result;
    }
  }

  return Object.freeze({
    MIN_SCORE,
    DEFAULT_HOLD_MS,
    COOLDOWN_MS,
    RELEASE_MS,
    GRACE_MS,
    MAX_FRAME_GAP_MS,
    GESTURE_ACTIONS,
    HoldDetector,
  });
});
