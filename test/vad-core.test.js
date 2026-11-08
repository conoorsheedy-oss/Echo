// Unit tests for the voice-activity chunking state machine (vad-core.js),
// fed synthetic RMS frames -- no audio hardware, no Web Audio.
// Run: npm test   (plain `node --test`, no dependencies)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vad = require('../src/renderer/vad-core.js');

const { VadSegmenter, SILENCE_MS, MIN_CHUNK_MS, MAX_CHUNK_MS, IDLE_RESET_MS, MIN_THRESHOLD } = vad;
const FRAME = 40; // ms between readings, like renderer.js
const QUIET = 0.002; // a quiet room
const SPEECH = 0.08; // normal speech on a mic

// Feeds `ms` of frames at level `level` (a number or (t) => number).
// Returns { events: [non-'none' results with t], t: next timestamp, last }.
function feed(seg, level, ms, t0) {
  const events = [];
  let last = null;
  let t = t0;
  for (; t < t0 + ms; t += FRAME) {
    const rms = typeof level === 'function' ? level(t) : level;
    last = seg.update({ rms, t });
    if (last.action !== 'none') events.push({ ...last, t });
  }
  return { events, t, last };
}

test('rms of a block of samples', () => {
  assert.equal(vad.rms(new Float32Array(0)), 0);
  assert.ok(Math.abs(vad.rms(Float32Array.from([0.5, -0.5, 0.5, -0.5])) - 0.5) < 1e-9);
});

test('speech start is reported once and quiet audio never cuts', () => {
  const seg = new VadSegmenter();
  let r = feed(seg, QUIET, 600, 0);
  assert.equal(r.events.length, 0);
  const first = seg.update({ rms: SPEECH, t: r.t });
  assert.equal(first.voiced, true);
  assert.equal(first.speechStarted, true);
  const second = seg.update({ rms: SPEECH, t: r.t + FRAME });
  assert.equal(second.speechStarted, false);
  assert.ok(seg.hasSpeech());
});

test('a chunk is cut ~SILENCE_MS after speech ends, with the speech end time', () => {
  const seg = new VadSegmenter();
  let r = feed(seg, QUIET, 400, 0);
  r = feed(seg, SPEECH, 1500, r.t); // 1.5 s of talking
  const speechEnd = r.t - FRAME;
  assert.equal(r.events.length, 0, 'no cut while talking');
  r = feed(seg, QUIET, 1200, r.t);
  assert.equal(r.events.length, 1);
  const cut = r.events[0];
  assert.equal(cut.action, 'cut');
  assert.equal(cut.reason, 'silence');
  assert.equal(cut.speechEndT, speechEnd);
  const waited = cut.t - speechEnd;
  assert.ok(waited >= SILENCE_MS && waited < SILENCE_MS + 3 * FRAME, `cut ${waited} ms after speech`);
});

test('short pauses inside a sentence do not cut it', () => {
  const seg = new VadSegmenter();
  let r = feed(seg, SPEECH, 800, 0);
  r = feed(seg, QUIET, 400, r.t); // a breath
  r = feed(seg, SPEECH, 800, r.t);
  r = feed(seg, QUIET, 500, r.t); // another, still < SILENCE_MS
  r = feed(seg, SPEECH, 400, r.t);
  assert.equal(r.events.length, 0);
});

test('MIN_CHUNK_MS: a very short utterance is held until the chunk is long enough', () => {
  const seg = new VadSegmenter({ silenceMs: 300 }); // so the minimum is what decides
  let r = feed(seg, SPEECH, 280, 0); // "Yes."
  r = feed(seg, QUIET, 2000, r.t);
  const cuts = r.events.filter((e) => e.action === 'cut');
  assert.equal(cuts.length, 1);
  assert.ok(cuts[0].chunkMs >= MIN_CHUNK_MS, `chunk ${cuts[0].chunkMs} ms`);
});

test('MAX_CHUNK_MS: non-stop talking is cut at the safety limit and keeps going', () => {
  const seg = new VadSegmenter();
  const r = feed(seg, SPEECH, 30000, 0);
  const cuts = r.events.filter((e) => e.action === 'cut');
  assert.equal(cuts.length, 2);
  for (const c of cuts) {
    assert.equal(c.reason, 'max');
    assert.ok(c.chunkMs >= MAX_CHUNK_MS && c.chunkMs < MAX_CHUNK_MS + 2 * FRAME);
  }
  assert.ok(seg.hasSpeech(), 'the next chunk starts mid-speech');
});

test('silence only: recordings are reset (never uploaded) and nothing is cut', () => {
  const seg = new VadSegmenter();
  const r = feed(seg, QUIET, 10000, 0);
  assert.ok(r.events.length >= 3);
  assert.ok(r.events.every((e) => e.action === 'reset'));
  const first = r.events[0];
  assert.ok(first.t >= IDLE_RESET_MS && first.t < IDLE_RESET_MS + 2 * FRAME);
});

test('a short click/cough is a blip, not a chunk', () => {
  const seg = new VadSegmenter();
  let r = feed(seg, QUIET, 500, 0);
  r = feed(seg, SPEECH, 80, r.t); // two frames
  r = feed(seg, QUIET, 4000, r.t);
  assert.ok(r.events.length >= 1);
  assert.ok(r.events.every((e) => e.action === 'reset'), JSON.stringify(r.events.map((e) => e.action)));
});

test('noise floor: the threshold adapts to steady background noise, with a minimum', () => {
  const quiet = new VadSegmenter();
  feed(quiet, 0, 5000, 0); // digital silence (system audio)
  assert.equal(quiet.threshold(), MIN_THRESHOLD, 'never below the minimum');

  const noisy = new VadSegmenter();
  const HUM = 0.012; // fan/hum just above the minimum threshold
  // Starts out "voiced" (the floor isn't known yet); after the safety cut the
  // floor catches up and the hum stops counting as speech.
  let r = feed(noisy, HUM, 20000, 0);
  assert.ok(noisy.threshold() > HUM * 1.5, `threshold ${noisy.threshold()} adapted above the hum`);
  r = feed(noisy, HUM, 6000, r.t);
  assert.ok(r.events.every((e) => e.action === 'reset'), 'steady hum is not speech any more');
  // Real speech over the hum is still detected and cut normally.
  r = feed(noisy, 0.1, 1500, r.t);
  r = feed(noisy, HUM, 1200, r.t);
  assert.ok(r.events.some((e) => e.action === 'cut' && e.reason === 'silence'));
});

test('continuous speech with short gaps between words keeps the threshold low', () => {
  const seg = new VadSegmenter();
  // 10 s of talking: 200 ms syllables with 40 ms dips to the room level.
  const r = feed(seg, (t) => (t % 240 < 200 ? SPEECH : QUIET), 10000, 0);
  assert.ok(seg.threshold() < 0.02, `threshold ${seg.threshold()}`);
  assert.equal(r.events.filter((e) => e.action === 'cut' && e.reason === 'silence').length, 0);
});

test('hysteresis: trailing-off speech stays voiced below the start threshold', () => {
  const seg = new VadSegmenter();
  const thr = seg.threshold();
  assert.equal(seg.update({ rms: thr * 0.8, t: 0 }).voiced, false, 'too quiet to start');
  assert.equal(seg.update({ rms: thr * 1.2, t: 40 }).voiced, true);
  assert.equal(seg.update({ rms: thr * 0.8, t: 80 }).voiced, true, 'quieter tail still counts');
  assert.equal(seg.update({ rms: thr * 0.5, t: 120 }).voiced, false);
});

test('throttled frames: one quiet sample a second apart is not enough to cut', () => {
  const seg = new VadSegmenter();
  let t = 0;
  for (; t < 1000; t += FRAME) seg.update({ rms: SPEECH, t });
  const r1 = seg.update({ rms: QUIET, t: t + 1000 });
  assert.equal(r1.action, 'none');
  seg.update({ rms: QUIET, t: t + 2000 });
  const r3 = seg.update({ rms: QUIET, t: t + 3000 });
  assert.equal(r3.action, 'cut');
});

test('reset() forgets the current chunk but keeps the noise floor', () => {
  const seg = new VadSegmenter();
  feed(seg, 0.008, 6000, 0);
  feed(seg, SPEECH, 500, 6000);
  const floor = seg.noiseFloor;
  assert.ok(floor > 0.005, `learned floor ${floor}`);
  seg.reset(7000);
  assert.equal(seg.hasSpeech(), false);
  assert.equal(seg.noiseFloor, floor);
});
