// Unit tests for the Deepgram audio path helpers (src/renderer/pcm-core.js):
// downsampling to 16 kHz, Float32 -> Int16, 100 ms framing and the
// talk-only audio gate. Synthetic signals, no Web Audio.
// Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pcm = require('../src/renderer/pcm-core.js');

const { Downsampler, floatTo16BitPCM, PcmFramer, AudioGate, int16ToBytes, FRAME_SAMPLES, TARGET_RATE } = pcm;

function sine(freq, rate, n, amp = 0.5, phase0 = 0) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(phase0 + (2 * Math.PI * freq * i) / rate);
  return out;
}
const rmsOf = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

test('48 kHz -> 16 kHz gives a third of the samples, even across odd block sizes', () => {
  const d = new Downsampler(48000);
  let total = 0;
  for (const size of [128, 128, 4096, 1, 7, 2048, 4800]) total += d.process(new Float32Array(size)).length;
  const input = 128 + 128 + 4096 + 1 + 7 + 2048 + 4800;
  assert.ok(Math.abs(total - input / 3) <= 1, `${total} vs ${input / 3}`);
});

test('44.1 kHz -> 16 kHz (non-integer ratio) does not drift over a minute of audio', () => {
  const d = new Downsampler(44100);
  let total = 0;
  let input = 0;
  while (input < 44100 * 60) {
    total += d.process(new Float32Array(128)).length;
    input += 128;
  }
  const expected = (input * TARGET_RATE) / 44100;
  assert.ok(Math.abs(total - expected) <= 1, `${total} samples for ${expected.toFixed(1)} expected`);
});

test('downsampling keeps DC level and a 1 kHz tone, and 16 kHz input passes through', () => {
  const d = new Downsampler(48000);
  const dc = d.process(new Float32Array(4800).fill(0.25));
  assert.ok(dc.every((x) => Math.abs(x - 0.25) < 1e-6));

  const tone = new Downsampler(48000).process(sine(1000, 48000, 48000));
  const ratio = rmsOf(tone) / (0.5 / Math.SQRT2);
  assert.ok(ratio > 0.97 && ratio < 1.01, `1 kHz kept at ${ratio.toFixed(3)} of its level`);

  const same = new Downsampler(16000).process(Float32Array.from([0.1, -0.2]));
  assert.deepEqual(Array.from(same).map((x) => +x.toFixed(4)), [0.1, -0.2]);
  assert.throws(() => new Downsampler(8000), /upsample/);
  assert.throws(() => new Downsampler(0), /Invalid/);
});

test('a tone above 8 kHz is strongly reduced (box-filter anti-aliasing)', () => {
  const high = new Downsampler(48000).process(sine(15000, 48000, 48000));
  assert.ok(rmsOf(high) < 0.2 * (0.5 / Math.SQRT2), `15 kHz leaks at ${rmsOf(high).toFixed(3)}`);
});

test('float -> int16 scales and clamps (and NaN becomes silence)', () => {
  const out = floatTo16BitPCM(Float32Array.from([0, 1, -1, 0.5, -0.5, 2, -3, NaN]));
  assert.deepEqual(Array.from(out), [0, 32767, -32768, 16384, -16384, 32767, -32768, 0]);
});

test('framer hands out exact 100 ms frames and keeps the remainder', () => {
  const f = new PcmFramer();
  assert.equal(FRAME_SAMPLES, 1600);
  assert.equal(f.push(new Int16Array(1000)).length, 0);
  const frames = f.push(Int16Array.from({ length: 2500 }, (_, i) => i));
  assert.equal(frames.length, 2);
  assert.ok(frames.every((fr) => fr.length === 1600));
  assert.equal(frames[0][1000], 0, 'continues where the last push stopped');
  assert.equal(frames[1][0], 600);
  // 3500 pushed so far = 2 frames + 300 left over.
  assert.equal(f.push(new Int16Array(1299)).length, 0);
  assert.equal(f.push(new Int16Array(1)).length, 1);
});

test('int16ToBytes is a little-endian byte view of the samples', () => {
  const bytes = int16ToBytes(Int16Array.from([1, -2]));
  assert.equal(bytes.length, 4);
  assert.deepEqual(Array.from(bytes), [1, 0, 0xfe, 0xff]);
});

test('audio gate: silence is held back, speech sends the pre-roll first, the tail keeps going, then stops', () => {
  const g = new AudioGate({ preRollFrames: 2, hangoverMs: 1500 });
  const fr = (n) => Int16Array.from([n]);
  let t = 0;
  const step = (lastVoicedAt) => {
    t += 100;
    return g.push(fr(t), { now: t, lastVoicedAt }).map((x) => x[0]);
  };
  assert.deepEqual(step(-Infinity), []);
  assert.deepEqual(step(-Infinity), []);
  assert.deepEqual(step(-Infinity), []); // ring holds 200, 300
  assert.deepEqual(step(400), [200, 300, 400], 'pre-roll then the frame');
  assert.deepEqual(step(400), [500]);
  // Quiet for a while: still sent until the hangover runs out.
  const tail = [];
  for (let i = 0; i < 20; i++) tail.push(...step(500));
  assert.ok(tail.length >= 14 && tail.length <= 16, `sent ${tail.length} tail frames`);
  assert.equal(g.active, false);
  assert.deepEqual(step(500), []);
});
