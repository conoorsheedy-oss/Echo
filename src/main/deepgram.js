// Deepgram Nova-3 live transcription (Settings > Speech-to-text > Deepgram).
//
// The main process owns the WebSockets, so the Deepgram key never reaches
// the renderer: the renderer sends ~100 ms frames of 16 kHz mono Int16 PCM
// over IPC ('stt:stream-audio') and gets transcript events back
// ('stt:stream-event'). One socket per stream: mic = "You", system audio =
// "Them".
//
// Auth: an `Authorization: Token <key>` header on the WebSocket handshake,
// via the `ws` package. Electron 31's Node (20.x) has no global WebSocket,
// and the WHATWG WebSocket API can't set headers anyway. (Deepgram also
// accepts the key as a `token` subprotocol, but that puts it in
// Sec-WebSocket-Protocol, which proxies and servers log far more readily.)
//
// Lifecycle per stream:
//   start()  -> connect; resolves once the socket is open (rejects with a
//               friendly, coded error: BAD_KEY / NO_CREDIT / RATE_LIMIT / OFFLINE ...)
//   audio()  -> binary frame; a few are queued while (re)connecting
//   timer    -> {"type":"Finalize"} once audio stops arriving (the renderer
//               only streams while someone talks), {"type":"KeepAlive"}
//               every few seconds while idle
//   drop     -> reconnect with backoff (up to MAX_RECONNECTS), then a fatal
//               'error' event so the renderer can fall back to Groq
//   stop()   -> {"type":"CloseStream"}, Deepgram flushes final results and
//               closes; force-closed after STOP_TIMEOUT_MS
//
// Never logged: the key, audio, transcripts. Only codes/HTTP statuses.
'use strict';

const core = require('./deepgram-core');

const HANDSHAKE_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 3_000;
const TICK_MS = 250;
const STABLE_AFTER_MS = 10_000;
const MAX_QUEUED_FRAMES = 30; // ~3 s of audio held while (re)connecting

const SPEAKERS = new Set(['You', 'Them']);

function defaultWebSocket() {
  // Lazy so the unit tests (which inject a fake) never need the package.
  return require('ws');
}

// deps (all optional, for tests): WebSocket, getKey, now, setTimeout,
// clearTimeout, setInterval, clearInterval, model, language, log.
function createDeepgramManager(deps = {}) {
  const WS = deps.WebSocket || defaultWebSocket();
  const getKey = deps.getKey || (() => '');
  const now = deps.now || Date.now;
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const setI = deps.setInterval || setInterval;
  const clearI = deps.clearInterval || clearInterval;
  const log = deps.log || console;
  const sessions = new Map(); // speaker -> session

  function model() {
    return core.cleanModel(typeof deps.model === 'function' ? deps.model() : deps.model || process.env.DEEPGRAM_MODEL);
  }
  function language() {
    return core.cleanLanguage(typeof deps.language === 'function' ? deps.language() : deps.language || process.env.DEEPGRAM_LANGUAGE);
  }

  function createSession(speaker, emit) {
    const s = {
      speaker,
      ws: null,
      state: 'idle', // 'connecting' | 'open' | 'reconnecting' | 'stopping' | 'closed'
      attempt: 0, // reconnects tried since the last stable connection
      openedAt: 0,
      queue: [],
      lastAudioAt: 0,
      lastSendAt: 0,
      flowing: false,
      tick: null,
      retryTimer: null,
      stopTimer: null,
      assembler: core.createUtteranceAssembler(),
    };

    function safeEmit(ev) {
      try {
        emit({ speaker, ...ev });
      } catch (err) {
        // The window went away -- nothing to tell.
      }
    }

    function sendRaw(data) {
      if (!s.ws || s.ws.readyState !== WS.OPEN) return false;
      try {
        s.ws.send(data);
        s.lastSendAt = now();
        return true;
      } catch (err) {
        return false;
      }
    }

    function clearTimers() {
      if (s.tick) clearI(s.tick);
      if (s.retryTimer) clearT(s.retryTimer);
      s.tick = null;
      s.retryTimer = null;
    }

    function emitTranscript(events) {
      for (const ev of events) safeEmit(ev);
    }

    function onTick() {
      if (s.state !== 'open') return;
      // Only a connection that stays up resets the retry budget, so a
      // flapping connection still gives up after MAX_RECONNECTS.
      if (s.attempt && now() - s.openedAt >= STABLE_AFTER_MS) s.attempt = 0;
      const act = core.idleActions({ now: now(), lastAudioAt: s.lastAudioAt, lastSendAt: s.lastSendAt, flowing: s.flowing });
      if (act.finalize) {
        s.flowing = false;
        sendRaw(core.CONTROL.finalize);
      } else if (act.keepAlive) {
        sendRaw(core.CONTROL.keepAlive);
      }
    }

    // Opens one socket. onFirstResult(err|null) is called exactly once:
    // null when it opened, an error if it failed before opening.
    function connect(onFirstResult) {
      const key = getKey('deepgram');
      if (!key) {
        const err = new Error('No Deepgram API key yet -- add one under ⋯ menu > API keys, or switch Speech-to-text back to Groq.');
        err.code = 'NO_KEY';
        onFirstResult(err, true);
        return;
      }
      let settled = false;
      let opened = false;
      let handshakeFailure = null; // { fatal, error } from an HTTP refusal
      let socketError = null;
      const settle = (err, fatal) => {
        if (settled) return;
        settled = true;
        onFirstResult(err, fatal);
      };

      let ws;
      try {
        ws = new WS(core.buildListenUrl({ model: model(), language: language() }), {
          headers: core.authHeaders(key),
          handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
          perMessageDeflate: false,
        });
      } catch (err) {
        settle(core.networkError(err), false);
        return;
      }
      s.ws = ws;

      ws.on('unexpected-response', (_req, res) => {
        const status = res && res.statusCode;
        handshakeFailure = core.classifyHandshakeStatus(status);
        log.error(`[deepgram] ${speaker} stream refused: HTTP ${status}`);
        try { res.resume(); } catch (err) { /* ignore */ }
        try { ws.terminate(); } catch (err) { /* ignore */ }
      });

      ws.on('open', () => {
        if (s.ws !== ws || s.state === 'stopping' || s.state === 'closed') return;
        opened = true;
        s.state = 'open';
        s.openedAt = now();
        s.lastSendAt = now();
        s.tick = setI(onTick, TICK_MS);
        // Audio that arrived while (re)connecting.
        const queued = s.queue;
        s.queue = [];
        for (const frame of queued) sendRaw(frame);
        safeEmit({ kind: 'status', state: 'open' });
        settle(null);
      });

      ws.on('message', (data, isBinary) => {
        if (s.ws !== ws || isBinary) return;
        const msg = core.parseMessage(data);
        if (!msg) return;
        if (msg.type === 'error') {
          log.error(`[deepgram] ${speaker} stream reported an error`);
          return;
        }
        emitTranscript(s.assembler.push(msg));
      });

      ws.on('error', (err) => {
        socketError = err;
        log.error(`[deepgram] ${speaker} socket error${err && err.code ? ` (${err.code})` : ''}`);
      });

      ws.on('close', (code, reasonBuf) => {
        const current = s.ws === ws;
        if (current) {
          s.ws = null;
          clearTimers(); // before settle(), which may schedule the next retry
        }
        if (!settled) {
          if (s.state === 'stopping' || s.state === 'closed') {
            const aborted = new Error('Stopped.');
            aborted.code = 'ABORTED';
            settle(aborted, true);
          } else {
            // Never opened: the handshake was refused or the network failed.
            const failure = handshakeFailure || { fatal: false, error: core.networkError(socketError) };
            settle(failure.error, failure.fatal);
          }
        }
        if (!current) return;
        // Settled text from before the close still becomes a line.
        emitTranscript(s.assembler.flush());
        if (s.state === 'stopping') {
          finishStop();
          return;
        }
        if (!opened || s.state === 'closed') return; // failure already reported via settle()
        log.warn(`[deepgram] ${speaker} stream closed unexpectedly (code ${code})`);
        const verdict = core.classifyClose(code, reasonBuf ? String(reasonBuf) : '');
        scheduleReconnect(verdict.error, !verdict.reconnect);
      });
    }

    function scheduleReconnect(lastError, fatal) {
      const delay = core.reconnectDelay(s.attempt, { fatal });
      if (delay < 0) {
        giveUp(lastError);
        return;
      }
      s.attempt += 1;
      s.state = 'reconnecting';
      safeEmit({ kind: 'status', state: 'reconnecting', attempt: s.attempt });
      s.retryTimer = setT(() => {
        s.retryTimer = null;
        if (s.state !== 'reconnecting') return;
        connect((err, isFatal) => {
          if (!err) return;
          if (s.state !== 'reconnecting') return;
          scheduleReconnect(err, isFatal);
        });
      }, delay);
    }

    function giveUp(err) {
      s.state = 'closed';
      clearTimers();
      s.queue = [];
      if (sessions.get(speaker) === session) sessions.delete(speaker);
      safeEmit({
        kind: 'error',
        fatal: true,
        code: (err && err.code) || 'STREAM_DROPPED',
        message: (err && err.message) || 'Live transcription stopped.',
      });
    }

    let stopResolvers = [];
    function finishStop() {
      if (s.stopTimer) clearT(s.stopTimer);
      s.stopTimer = null;
      const already = s.state === 'closed';
      s.state = 'closed';
      clearTimers();
      if (sessions.get(speaker) === session) sessions.delete(speaker);
      if (!already) safeEmit({ kind: 'status', state: 'closed' });
      const resolvers = stopResolvers;
      stopResolvers = [];
      resolvers.forEach((r) => r());
    }

    const session = {
      start() {
        s.state = 'connecting';
        return new Promise((resolve, reject) => {
          connect((err) => {
            if (!err) {
              resolve();
              return;
            }
            if (s.state !== 'stopping') {
              s.state = 'closed';
              clearTimers();
              if (sessions.get(speaker) === session) sessions.delete(speaker);
            }
            reject(err);
          });
        });
      },
      audio(buf) {
        s.lastAudioAt = now();
        s.flowing = true;
        if (s.state === 'open' && sendRaw(buf)) return;
        if (s.state === 'connecting' || s.state === 'reconnecting') {
          s.queue.push(buf);
          if (s.queue.length > MAX_QUEUED_FRAMES) s.queue.shift();
        }
      },
      stop() {
        return new Promise((resolve) => {
          if (s.state === 'closed' || s.state === 'idle') {
            resolve();
            return;
          }
          stopResolvers.push(resolve);
          if (s.state === 'stopping') return;
          const wasOpen = s.state === 'open';
          s.state = 'stopping';
          clearTimers();
          s.queue = [];
          if (!s.ws) {
            finishStop();
            return;
          }
          if (wasOpen && sendRaw(core.CONTROL.closeStream)) {
            // Deepgram sends the last finals, then closes the socket itself.
            s.stopTimer = setT(() => {
              s.stopTimer = null;
              if (!s.ws) {
                finishStop();
                return;
              }
              try { s.ws.terminate(); } catch (err) { finishStop(); }
            }, STOP_TIMEOUT_MS);
            return;
          }
          // Still connecting (or the socket is broken): the close event finishes.
          try { s.ws.terminate(); } catch (err) { finishStop(); }
        });
      },
      state: () => s.state,
    };
    return session;
  }

  return {
    // emit(event) gets { speaker, kind, ... } -- see deepgram-core.js.
    async start(speaker, emit) {
      if (!SPEAKERS.has(speaker)) throw new Error('Invalid speaker.');
      const existing = sessions.get(speaker);
      if (existing) await existing.stop();
      const session = createSession(speaker, emit);
      sessions.set(speaker, session);
      await session.start();
      return { model: model(), language: language(), sampleRate: core.SAMPLE_RATE };
    },
    // Returns false when the frame was rejected (bad size / no stream).
    audio(speaker, data) {
      const session = sessions.get(speaker);
      if (!session) return false;
      const buf = core.toPcmBuffer(data);
      if (!buf) return false;
      session.audio(buf);
      return true;
    },
    async stop(speaker) {
      const session = sessions.get(speaker);
      if (session) await session.stop();
    },
    async stopAll() {
      await Promise.all([...sessions.values()].map((sess) => sess.stop()));
    },
    activeSpeakers: () => [...sessions.keys()],
    model,
    language,
  };
}

module.exports = { createDeepgramManager, HANDSHAKE_TIMEOUT_MS, STOP_TIMEOUT_MS, MAX_QUEUED_FRAMES };
