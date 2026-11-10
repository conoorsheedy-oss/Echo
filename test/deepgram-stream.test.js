// Tests for the Deepgram stream manager (src/main/deepgram.js) with a fake
// WebSocket and a fake clock, plus the "Test keys" check for the Deepgram
// key (ai.testOne) with fetch mocked. No network, no real key.
// Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

require('./helpers/electron-stub'); // no Electron binary needed
const keyStore = require('../src/main/keyStore');
const { createDeepgramManager, STOP_TIMEOUT_MS } = require('../src/main/deepgram');
const core = require('../src/main/deepgram-core');

const KEY = 'dg-test-key-0123456789abcdef';
const tick = () => new Promise((r) => setImmediate(r));

// ---- fakes ----
class FakeWebSocket extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('not open');
    this.sent.push(data);
  }
  terminate() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    const wasConnecting = this.readyState === FakeWebSocket.CONNECTING;
    this.readyState = FakeWebSocket.CLOSED;
    setImmediate(() => {
      if (wasConnecting) this.emit('error', new Error('WebSocket was closed before the connection was established'));
      this.emit('close', 1006, Buffer.alloc(0));
    });
  }
  // server side
  serverOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }
  serverMessage(obj) {
    this.emit('message', Buffer.from(JSON.stringify(obj)), false);
  }
  serverClose(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }
  serverRefuse(status) {
    this.emit('unexpected-response', {}, { statusCode: status, resume() {} });
  }
  serverNetworkFail(message = 'getaddrinfo ENOTFOUND api.deepgram.com') {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('error', Object.assign(new Error(message), { code: 'ENOTFOUND' }));
    this.emit('close', 1006, Buffer.alloc(0));
  }
  controlMessages() {
    return this.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d).type);
  }
  audioFrames() {
    return this.sent.filter((d) => typeof d !== 'string');
  }
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;
FakeWebSocket.instances = [];

function fakeClock() {
  let t = 1_000_000;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { timers.set(++nextId, { fn, at: t + ms, every: 0 }); return nextId; },
    setInterval: (fn, ms) => { timers.set(++nextId, { fn, at: t + ms, every: ms }); return nextId; },
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, tm] of timers) if (tm.at <= end && (!next || tm.at < next[1].at)) next = [id, tm];
        if (!next) break;
        const [id, tm] = next;
        t = tm.at;
        if (tm.every) tm.at += tm.every;
        else timers.delete(id);
        tm.fn();
      }
      t = end;
    },
  };
}

function setup({ key = KEY } = {}) {
  FakeWebSocket.instances = [];
  const clock = fakeClock();
  const logs = [];
  const log = { error: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) };
  const events = [];
  const mgr = createDeepgramManager({
    WebSocket: FakeWebSocket,
    getKey: (p) => (p === 'deepgram' ? key : ''),
    model: 'nova-3',
    language: 'en',
    log,
    ...clock,
  });
  const emit = (ev) => events.push(ev);
  const last = () => FakeWebSocket.instances.at(-1);
  return { mgr, clock, logs, events, emit, last };
}

async function openStream(ctx, speaker = 'Them') {
  const started = ctx.mgr.start(speaker, ctx.emit);
  await tick();
  ctx.last().serverOpen();
  await started;
  return ctx.last();
}

const frame = (bytes = 3200) => new Uint8Array(bytes);

// ---- tests ----
test('connects with the Token header (never in the URL) and resolves once open', async () => {
  const ctx = setup();
  const started = ctx.mgr.start('You', ctx.emit);
  await tick();
  const ws = ctx.last();
  assert.equal(ws.opts.headers.Authorization, `Token ${KEY}`);
  assert.ok(!ws.url.includes(KEY));
  assert.match(ws.url, /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/);
  assert.match(ws.url, /model=nova-3/);
  ws.serverOpen();
  const info = await started;
  assert.equal(info.sampleRate, 16000);
  assert.deepEqual(ctx.mgr.activeSpeakers(), ['You']);
  assert.deepEqual(ctx.events.at(-1), { speaker: 'You', kind: 'status', state: 'open' });
});

test('one socket per speaker', async () => {
  const ctx = setup();
  const you = await openStream(ctx, 'You');
  const them = await openStream(ctx, 'Them');
  assert.notEqual(you, them);
  assert.deepEqual(ctx.mgr.activeSpeakers().sort(), ['Them', 'You']);
  assert.ok(ctx.mgr.audio('You', frame()));
  assert.equal(you.audioFrames().length, 1);
  assert.equal(them.audioFrames().length, 0);
});

test('a refused handshake rejects with a friendly coded error (401 / 402 / 429)', async () => {
  for (const [status, code] of [[401, 'BAD_KEY'], [403, 'BAD_KEY'], [402, 'NO_CREDIT'], [429, 'RATE_LIMIT']]) {
    const ctx = setup();
    const started = ctx.mgr.start('Them', ctx.emit);
    await tick();
    ctx.last().serverRefuse(status);
    await assert.rejects(started, (err) => err.code === code && !err.message.includes(KEY));
    assert.deepEqual(ctx.mgr.activeSpeakers(), []);
    assert.ok(ctx.logs.every((l) => !l.includes(KEY)), 'key never logged');
  }
});

test('no key / network failure reject with NO_KEY / OFFLINE', async () => {
  const noKey = setup({ key: '' });
  await assert.rejects(noKey.mgr.start('You', noKey.emit), { code: 'NO_KEY' });
  assert.equal(FakeWebSocket.instances.length, 0);

  const ctx = setup();
  const started = ctx.mgr.start('You', ctx.emit);
  await tick();
  ctx.last().serverNetworkFail();
  await assert.rejects(started, { code: 'OFFLINE' });
});

test('audio frames are sent as binary; frames sent while connecting are queued; bad frames dropped', async () => {
  const ctx = setup();
  const started = ctx.mgr.start('You', ctx.emit);
  await tick();
  assert.equal(ctx.mgr.audio('You', frame()), true); // queued
  assert.equal(ctx.mgr.audio('You', frame(3)), false); // odd size
  assert.equal(ctx.mgr.audio('Them', frame()), false); // no such stream
  const ws = ctx.last();
  ws.serverOpen();
  await started;
  ctx.mgr.audio('You', frame());
  assert.equal(ws.audioFrames().length, 2);
  assert.ok(Buffer.isBuffer(ws.audioFrames()[0]));
});

test('Finalize when audio stops, KeepAlive while idle', async () => {
  const ctx = setup();
  const ws = await openStream(ctx);
  for (let i = 0; i < 5; i++) {
    ctx.mgr.audio('Them', frame());
    ctx.clock.advance(100);
  }
  assert.deepEqual(ws.controlMessages(), []);
  ctx.clock.advance(core.FINALIZE_AFTER_IDLE_MS + 300);
  assert.deepEqual(ws.controlMessages(), ['Finalize']);
  ctx.clock.advance(core.KEEPALIVE_MS + 300);
  assert.deepEqual(ws.controlMessages(), ['Finalize', 'KeepAlive']);
  ctx.clock.advance(core.KEEPALIVE_MS * 2 + 600);
  assert.equal(ws.controlMessages().filter((m) => m === 'KeepAlive').length, 3);
});

test('Results / UtteranceEnd become interim + final transcript events for that speaker', async () => {
  const ctx = setup();
  const ws = await openStream(ctx, 'Them');
  ctx.events.length = 0;
  const res = (transcript, extra) => ({ type: 'Results', start: 0, duration: 1, channel: { alternatives: [{ transcript }] }, ...extra });
  ws.serverMessage(res('how would'));
  ws.serverMessage(res('How would you', { is_final: true }));
  ws.serverMessage(res('design it?', { is_final: true, speech_final: true }));
  ws.serverMessage({ type: 'UtteranceEnd', last_word_end: 2 });
  assert.deepEqual(ctx.events, [
    { speaker: 'Them', kind: 'interim', text: 'how would' },
    { speaker: 'Them', kind: 'interim', text: 'How would you' },
    { speaker: 'Them', kind: 'final', text: 'How would you design it?', endOfSpeech: true },
  ]);
});

test('stop sends CloseStream, takes the last finals, and resolves when Deepgram closes', async () => {
  const ctx = setup();
  const ws = await openStream(ctx);
  ctx.events.length = 0;
  const stopped = ctx.mgr.stop('Them');
  assert.deepEqual(ws.controlMessages(), ['CloseStream']);
  ws.serverMessage({ type: 'Results', is_final: true, start: 0, duration: 1, channel: { alternatives: [{ transcript: 'last words' }] } });
  ws.serverClose(1000);
  await stopped;
  assert.deepEqual(ctx.events, [
    { speaker: 'Them', kind: 'interim', text: 'last words' },
    { speaker: 'Them', kind: 'final', text: 'last words', endOfSpeech: true },
    { speaker: 'Them', kind: 'status', state: 'closed' },
  ]);
  assert.deepEqual(ctx.mgr.activeSpeakers(), []);
  assert.equal(FakeWebSocket.instances.length, 1, 'no reconnect after a stop');
});

test('stop force-closes if Deepgram never answers CloseStream', async () => {
  const ctx = setup();
  const ws = await openStream(ctx);
  const stopped = ctx.mgr.stop('Them');
  ctx.clock.advance(STOP_TIMEOUT_MS + 10);
  await stopped;
  assert.equal(ws.readyState, FakeWebSocket.CLOSED);
});

test('stop while still connecting rejects the start and resolves the stop', async () => {
  const ctx = setup();
  const started = ctx.mgr.start('You', ctx.emit);
  await tick();
  const stopped = ctx.mgr.stop('You');
  await assert.rejects(started, { code: 'ABORTED' });
  await stopped;
  assert.deepEqual(ctx.mgr.activeSpeakers(), []);
});

test('an unexpected drop reconnects with backoff; after 3 failed tries a fatal error event', async () => {
  const ctx = setup();
  const ws = await openStream(ctx);
  ws.serverClose(1006);
  assert.equal(ctx.events.at(-1).state, 'reconnecting');

  for (let attempt = 1; attempt <= core.MAX_RECONNECTS; attempt++) {
    const before = FakeWebSocket.instances.length;
    ctx.clock.advance(core.reconnectDelay(attempt - 1) - 1);
    assert.equal(FakeWebSocket.instances.length, before, 'waits for the backoff');
    ctx.clock.advance(1);
    assert.equal(FakeWebSocket.instances.length, before + 1, `reconnect attempt ${attempt}`);
    ctx.last().serverNetworkFail();
  }
  const fatal = ctx.events.at(-1);
  assert.equal(fatal.kind, 'error');
  assert.equal(fatal.fatal, true);
  assert.equal(fatal.code, 'OFFLINE');
  assert.deepEqual(ctx.mgr.activeSpeakers(), []);
  ctx.clock.advance(60_000);
  assert.equal(FakeWebSocket.instances.length, 1 + core.MAX_RECONNECTS, 'gives up for good');
});

test('a successful reconnect resumes the stream (audio flows to the new socket)', async () => {
  const ctx = setup();
  const first = await openStream(ctx);
  first.serverClose(1011, 'NET-0001');
  ctx.mgr.audio('Them', frame()); // queued while reconnecting
  ctx.clock.advance(core.reconnectDelay(0));
  const second = ctx.last();
  assert.notEqual(second, first);
  second.serverOpen();
  assert.equal(second.audioFrames().length, 1);
  assert.equal(ctx.events.at(-1).state, 'open');
});

test('bad audio close (1008) is fatal straight away', async () => {
  const ctx = setup();
  const ws = await openStream(ctx);
  ws.serverClose(1008, 'DATA-0000');
  assert.equal(ctx.events.at(-1).kind, 'error');
  assert.equal(ctx.events.at(-1).code, 'BAD_AUDIO');
  assert.equal(FakeWebSocket.instances.length, 1);
});

test('stopAll closes every stream (used on key removal / window gone)', async () => {
  const ctx = setup();
  const a = await openStream(ctx, 'You');
  const b = await openStream(ctx, 'Them');
  const done = ctx.mgr.stopAll();
  a.serverClose(1000);
  b.serverClose(1000);
  await done;
  assert.deepEqual(ctx.mgr.activeSpeakers(), []);
});

test('invalid speaker is rejected', async () => {
  const ctx = setup();
  await assert.rejects(ctx.mgr.start('Bob', ctx.emit), /Invalid speaker/);
});

// ---- Settings > Test keys (ai.testOne('deepgram')) with fetch mocked ----
test('Deepgram key test: GET /v1/projects with Token auth; 401 / 402 / offline are friendly', async () => {
  keyStore.getKey = (p) => (p === 'deepgram' ? KEY : '');
  const ai = require('../src/main/ai');
  const realFetch = global.fetch;
  const realError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const calls = [];
    let status = 200;
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (status === 0) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(status === 200 ? { projects: [] } : { err_msg: 'nope' }), { status });
    };

    let r = await ai.testOne('deepgram');
    assert.equal(r.ok, true);
    assert.match(r.message, /nova-3/);
    assert.equal(calls[0].url, 'https://api.deepgram.com/v1/projects');
    assert.equal(calls[0].init.headers.Authorization, `Token ${KEY}`);
    assert.ok(!calls[0].url.includes(KEY));

    status = 401;
    r = await ai.testOne('deepgram');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_KEY');
    assert.match(r.message, /Deepgram rejected your API key/);

    status = 402;
    r = await ai.testOne('deepgram');
    assert.equal(r.code, 'NO_CREDIT');
    assert.match(r.message, /out of credit/);

    status = 0;
    r = await ai.testOne('deepgram');
    assert.equal(r.code, 'OFFLINE');
    assert.match(r.message, /Couldn't reach Deepgram/);

    keyStore.getKey = () => '';
    r = await ai.testOne('deepgram');
    assert.deepEqual(r, { ok: false, set: false, message: 'Not set.' });

    const all = await ai.testKeys();
    assert.deepEqual(Object.keys(all).sort(), ['deepgram', 'gemini', 'groq']);
    assert.ok(logged.every((l) => !l.includes(KEY)), 'key never logged');
  } finally {
    global.fetch = realFetch;
    console.error = realError;
  }
});
