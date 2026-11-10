// Raw audio for Deepgram live streaming -- the pure part. No DOM, no Web
// Audio, so it's unit-tested in plain Node (test/pcm-core.test.js). Loaded as
// a classic script before renderer.js (window.EchoPcmCore), like vad-core.js.
//
// Pipeline (renderer.js): Float32 samples from an AudioWorklet (or the
// ScriptProcessorNode fallback) at the AudioContext's rate
//   -> Downsampler      to 16 kHz mono
//   -> floatTo16BitPCM  to signed 16-bit ("linear16")
//   -> PcmFramer        into 100 ms frames (1600 samples = 3200 bytes)
//   -> AudioGate        only while someone is talking (plus pre-roll and a
//                       tail), so silence isn't streamed and billed
//   -> IPC to main (src/main/deepgram.js), which owns the WebSocket.
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.EchoPcmCore = core;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TARGET_RATE = 16000;
  const FRAME_MS = 100;
  const FRAME_SAMPLES = (TARGET_RATE * FRAME_MS) / 1000; // 1600
  // Audio kept from before the VAD noticed speech, so the first syllable
  // isn't cut off (frames are ~100 ms, and capture runs a little behind).
  const PRE_ROLL_FRAMES = 4;
  // Keep streaming this long after the last voiced moment: longer than
  // Deepgram's utterance_end_ms (1000), so its end-of-speech signals can fire.
  const HANGOVER_MS = 1500;

  // Streaming downsampler: averages the input samples that fall into each
  // output sample's slot (a box filter -- cheap anti-aliasing that's plenty
  // for speech). Works for non-integer ratios (44.1 kHz -> 16 kHz) and keeps
  // its fractional position between blocks, so there's no drift or clicks.
  class Downsampler {
    constructor(inRate, outRate = TARGET_RATE) {
      if (!(inRate > 0) || !(outRate > 0)) throw new Error('Invalid sample rate.');
      if (inRate < outRate) throw new Error(`Can't upsample ${inRate} Hz to ${outRate} Hz.`);
      this.inRate = inRate;
      this.outRate = outRate;
      this.ratio = inRate / outRate;
      this.pos = 0; // input samples consumed (fractional bookkeeping)
      this.boundary = this.ratio; // where the current output slot ends
      this.sum = 0;
      this.count = 0;
    }

    process(input) {
      if (!input || !input.length) return new Float32Array(0);
      if (this.ratio === 1) return Float32Array.from(input);
      const out = new Float32Array(Math.ceil(input.length / this.ratio) + 1);
      let o = 0;
      for (let i = 0; i < input.length; i++) {
        this.sum += input[i];
        this.count += 1;
        this.pos += 1;
        if (this.pos >= this.boundary) {
          out[o++] = this.sum / this.count;
          this.sum = 0;
          this.count = 0;
          this.boundary += this.ratio;
        }
      }
      // Keep the numbers small in a long session.
      const shift = Math.floor(this.pos);
      this.pos -= shift;
      this.boundary -= shift;
      return out.subarray(0, o);
    }
  }

  // Float samples in [-1, 1] -> Int16 (clamped).
  function floatTo16BitPCM(input) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let s = input[i];
      if (!(s === s)) s = 0; // NaN
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return out;
  }

  // Collects Int16 samples and hands out fixed-size frames.
  class PcmFramer {
    constructor(frameSamples = FRAME_SAMPLES) {
      this.frameSamples = frameSamples;
      this.buf = new Int16Array(frameSamples);
      this.n = 0;
    }

    push(samples) {
      const frames = [];
      let i = 0;
      while (i < samples.length) {
        const take = Math.min(this.frameSamples - this.n, samples.length - i);
        this.buf.set(samples.subarray(i, i + take), this.n);
        this.n += take;
        i += take;
        if (this.n === this.frameSamples) {
          frames.push(this.buf);
          this.buf = new Int16Array(this.frameSamples);
          this.n = 0;
        }
      }
      return frames;
    }
  }

  // Decides which frames get streamed. push(frame, { now, lastVoicedAt })
  // returns the frames to send now (possibly none, possibly the pre-roll too).
  // `lastVoicedAt` is when the VAD last heard speech (same clock as `now`).
  class AudioGate {
    constructor({ preRollFrames = PRE_ROLL_FRAMES, hangoverMs = HANGOVER_MS } = {}) {
      this.preRollFrames = preRollFrames;
      this.hangoverMs = hangoverMs;
      this.ring = [];
      this.active = false;
    }

    push(frame, { now, lastVoicedAt }) {
      const talking = Number.isFinite(lastVoicedAt) && now - lastVoicedAt <= this.hangoverMs;
      if (talking) {
        const out = this.active ? [frame] : [...this.ring, frame];
        this.ring = [];
        this.active = true;
        return out;
      }
      this.active = false;
      this.ring.push(frame);
      if (this.ring.length > this.preRollFrames) this.ring.shift();
      return [];
    }
  }

  // Int16Array -> the bytes to send (a view, no copy).
  function int16ToBytes(samples) {
    return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  }

  return Object.freeze({
    TARGET_RATE,
    FRAME_MS,
    FRAME_SAMPLES,
    PRE_ROLL_FRAMES,
    HANGOVER_MS,
    Downsampler,
    floatTo16BitPCM,
    PcmFramer,
    AudioGate,
    int16ToBytes,
  });
});
