// AudioWorklet processor for Deepgram live streaming: batches the (already
// mono -- see channelCount in renderer.js) input into ~100 ms Float32 blocks
// and posts them to the page, which downsamples / converts / frames them
// (pcm-core.js). Loaded with audioWorklet.addModule('pcm-worklet.js'); it
// must be its own same-origin file because the CSP allows only 'self'
// scripts. renderer.js falls back to a ScriptProcessorNode if this can't load.
/* global sampleRate, registerProcessor, AudioWorkletProcessor */
'use strict';

class EchoPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.max(128, Math.round(sampleRate / 10)); // ~100 ms
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buf[this.n++] = channel[i];
        if (this.n === this.size) {
          // Transfer, not copy: a new buffer for the next block.
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true; // keep running while connected
  }
}

registerProcessor('echo-pcm-capture', EchoPcmCapture);
