// Voice-activity detection -- the pure part: decides where to cut the audio
// into chunks. No DOM, no Web Audio, no MediaRecorder, so it can be
// unit-tested in plain Node (test/vad-core.test.js) with synthetic RMS
// frames. Loaded as a classic script before renderer.js (window.EchoVadCore).
//
// renderer.js keeps one MediaRecorder running per stream (mic, system audio)
// and feeds this one loudness reading (RMS of the last ~20 ms of samples,
// from an AnalyserNode) about every 40 ms. The segmenter answers each frame
// with an action:
//   'cut'   -- speech happened and has now ended (SILENCE_MS of quiet), or a
//              long stretch of speech hit MAX_CHUNK_MS: upload this chunk and
//              start a new one.
//   'reset' -- the current recording holds no speech: throw it away and
//              start a new one (silent chunks are never uploaded).
//   'none'  -- keep recording.
// Because the recorder is always running, the first syllable of an utterance
// is never lost waiting for "speech started" to be detected.
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.EchoVadCore = core;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // End a chunk once this much quiet follows speech.
  const SILENCE_MS = 700;
  // Never cut a chunk shorter than this (Whisper does badly on tiny clips).
  const MIN_CHUNK_MS = 800;
  // Safety cut for someone talking without pausing.
  const MAX_CHUNK_MS = 12000;
  // Less voiced audio than this before the silence = a click/cough/blip, not speech.
  const MIN_SPEECH_MS = 200;
  // A recording with no speech in it is dropped and restarted after this
  // long, so a chunk never starts with a long stretch of silence.
  const IDLE_RESET_MS = 2500;
  // Silence must also span at least this many frames (if the page is ever
  // throttled to ~1 frame/s, one quiet sample isn't proof of a pause).
  const MIN_SILENT_FRAMES = 3;
  // Loudness threshold: NOISE_MULTIPLIER x the measured noise floor, never
  // below MIN_THRESHOLD. RMS of float samples in [-1, 1]: 0.01 is about
  // -40 dBFS; normal speech on a mic is roughly 0.03-0.2.
  const MIN_THRESHOLD = 0.01;
  const NOISE_MULTIPLIER = 3;
  // The floor can't climb past this (so continuous loud noise or music ends
  // up as MAX_CHUNK_MS cuts rather than "nothing ever counts as speech").
  const MAX_NOISE_FLOOR = 0.03;
  // Once speaking, stay "voiced" down to this fraction of the threshold
  // (hysteresis: trailing-off syllables don't end the utterance early).
  const RELEASE_RATIO = 0.7;
  // Noise floor = the quietest moment of the last few seconds ("minimum
  // statistics": even non-stop speech dips to the background level between
  // words), smoothed -- slowly upwards, quickly downwards. Tracking the
  // minimum (not just quiet frames) means a steady hum that starts out above
  // MIN_THRESHOLD is still learned as noise instead of counting as speech.
  const FLOOR_BUCKET_MS = 500;
  const FLOOR_WINDOW_BUCKETS = 6; // ~3 s
  const FLOOR_RISE_TAU_MS = 2000;
  const FLOOR_FALL_TAU_MS = 300;
  // One frame never counts for more than this (gaps between frames).
  const MAX_FRAME_CREDIT_MS = 200;

  // Root-mean-square of a block of float samples.
  function rms(samples) {
    if (!samples || !samples.length) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  class VadSegmenter {
    constructor(opts = {}) {
      this.silenceMs = opts.silenceMs ?? SILENCE_MS;
      this.minChunkMs = opts.minChunkMs ?? MIN_CHUNK_MS;
      this.maxChunkMs = opts.maxChunkMs ?? MAX_CHUNK_MS;
      this.minSpeechMs = opts.minSpeechMs ?? MIN_SPEECH_MS;
      this.idleResetMs = opts.idleResetMs ?? IDLE_RESET_MS;
      this.minSilentFrames = opts.minSilentFrames ?? MIN_SILENT_FRAMES;
      this.minThreshold = opts.minThreshold ?? MIN_THRESHOLD;
      this.noiseMultiplier = opts.noiseMultiplier ?? NOISE_MULTIPLIER;
      this.maxNoiseFloor = opts.maxNoiseFloor ?? MAX_NOISE_FLOOR;
      this.releaseRatio = opts.releaseRatio ?? RELEASE_RATIO;
      this.noiseFloor = 0;
      this.floorBuckets = [];
      this.bucketStartT = null;
      this.bucketMin = Infinity;
      this.lastT = null;
      this.voiced = false;
      this._newChunk(null);
    }

    _newChunk(t) {
      this.chunkStartT = t;
      this.speechStartT = null;
      this.lastVoiceT = null;
      this.voicedMs = 0;
      this.silentFrames = 0;
    }

    threshold() {
      return Math.max(this.minThreshold, this.noiseFloor * this.noiseMultiplier);
    }

    _trackFloor(value, t, dt) {
      if (this.bucketStartT === null) this.bucketStartT = t;
      if (value < this.bucketMin) this.bucketMin = value;
      if (t - this.bucketStartT >= FLOOR_BUCKET_MS) {
        this.floorBuckets.push(this.bucketMin);
        if (this.floorBuckets.length > FLOOR_WINDOW_BUCKETS) this.floorBuckets.shift();
        this.bucketStartT = t;
        this.bucketMin = Infinity;
      }
      if (!dt) return;
      const target = Math.min(this.bucketMin, ...this.floorBuckets);
      if (!Number.isFinite(target)) return;
      const tau = target > this.noiseFloor ? FLOOR_RISE_TAU_MS : FLOOR_FALL_TAU_MS;
      const alpha = 1 - Math.exp(-dt / tau);
      this.noiseFloor = Math.min(this.maxNoiseFloor, this.noiseFloor + (target - this.noiseFloor) * alpha);
    }

    // True while the current chunk contains real (non-blip) speech so far.
    hasSpeech() {
      return this.speechStartT !== null;
    }

    // One loudness reading. frame = { rms, t } (t in ms, monotonic).
    update({ rms: level, t }) {
      const value = Number.isFinite(level) && level > 0 ? level : 0;
      if (this.chunkStartT === null) this.chunkStartT = t;
      const dt = this.lastT === null ? 0 : Math.max(0, Math.min(t - this.lastT, MAX_FRAME_CREDIT_MS));
      this.lastT = t;

      const threshold = this.threshold();
      const voiced = value >= (this.voiced ? threshold * this.releaseRatio : threshold);
      this.voiced = voiced;

      this._trackFloor(value, t, dt);

      let speechStarted = false;
      if (voiced) {
        if (this.speechStartT === null) {
          this.speechStartT = t;
          speechStarted = true;
        }
        this.lastVoiceT = t;
        this.voicedMs += dt;
        this.silentFrames = 0;
      } else if (this.speechStartT !== null) {
        this.silentFrames += 1;
      }

      const base = { voiced, speechStarted, threshold, noiseFloor: this.noiseFloor };
      const chunkMs = t - this.chunkStartT;

      if (this.speechStartT !== null) {
        if (chunkMs >= this.maxChunkMs) {
          const out = { ...base, action: 'cut', reason: 'max', speechStartT: this.speechStartT, speechEndT: this.lastVoiceT, chunkMs };
          this._newChunk(t);
          if (voiced) {
            // Still mid-sentence: the next chunk starts with speech.
            this.speechStartT = t;
            this.lastVoiceT = t;
          }
          return out;
        }
        const quietFor = t - this.lastVoiceT;
        if (quietFor >= this.silenceMs && this.silentFrames >= this.minSilentFrames) {
          if (this.voicedMs < this.minSpeechMs) {
            // A blip, not speech: forget it; the idle reset drops the audio.
            this.speechStartT = null;
            this.lastVoiceT = null;
            this.voicedMs = 0;
            this.silentFrames = 0;
          } else if (chunkMs >= this.minChunkMs) {
            const out = { ...base, action: 'cut', reason: 'silence', speechStartT: this.speechStartT, speechEndT: this.lastVoiceT, chunkMs };
            this._newChunk(t);
            return out;
          }
          // else: speech ended but the chunk is still too short -- keep going.
        }
      }

      if (this.speechStartT === null && !voiced && chunkMs >= this.idleResetMs) {
        this._newChunk(t);
        return { ...base, action: 'reset', reason: 'idle', chunkMs };
      }
      return { ...base, action: 'none' };
    }

    // Stop / restart: forget the current chunk (the noise floor is kept).
    reset(t = null) {
      this.voiced = false;
      this.lastT = t;
      this._newChunk(t);
    }
  }

  return Object.freeze({
    SILENCE_MS,
    MIN_CHUNK_MS,
    MAX_CHUNK_MS,
    MIN_SPEECH_MS,
    IDLE_RESET_MS,
    MIN_SILENT_FRAMES,
    MIN_THRESHOLD,
    NOISE_MULTIPLIER,
    MAX_NOISE_FLOOR,
    RELEASE_RATIO,
    rms,
    VadSegmenter,
  });
});
