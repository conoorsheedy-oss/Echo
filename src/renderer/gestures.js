// Hand gestures (experimental, opt-in, OFF by default).
//
// Webcam -> MediaPipe GestureRecognizer (WASM, CPU), entirely on this
// computer. The runtime and model are bundled in ./vendor/mediapipe/ (see
// scripts/fetch-gesture-assets.js); nothing is fetched from the network and
// no frame is stored or sent anywhere. A recognised sign has to be held
// steady (gesture-core.js) before it fires, and every action is fired by
// clicking the app's real buttons, so it runs exactly the code a click or a
// hotkey runs. The camera is released whenever gestures are off or Echo is
// hidden/minimized, and main.js only grants the webcam while this is on.
(function () {
  'use strict';

  const bridge = window.echoGestureBridge;
  const core = window.EchoGestureCore;
  if (!bridge || !core) {
    console.error('[gestures] renderer bridge or gesture-core.js missing -- hand gestures unavailable.');
    return;
  }
  const { api } = bridge;

  const STORAGE_ENABLED = 'echo.gestures.enabled';
  const STORAGE_PREVIEW = 'echo.gestures.preview';
  const TARGET_FPS = 12; // recognition rate; the camera itself runs at <= 15 fps
  const CAMERA_CONSTRAINTS = {
    audio: false,
    video: {
      width: { ideal: 320 },
      height: { ideal: 240 },
      frameRate: { ideal: 15, max: 15 },
      facingMode: 'user',
    },
  };
  const SCROLL_FRACTION = 0.8; // of the answer panel's height per "scroll up"
  const MODEL_MISSING_TEXT = 'Gesture model missing - run npm install';

  const $ = (id) => document.getElementById(id);
  const el = {
    enableToggle: $('gesture-enable-toggle'),
    previewToggle: $('gesture-preview-toggle'),
    status: $('gesture-status'),
    mapBody: $('gesture-map-body'),
    section: $('gesture-settings'),
    menuBtn: $('gestures-menu-btn'),
    badge: $('gesture-badge'),
    preview: $('gesture-preview'),
    video: $('gesture-video'),
    previewLabel: $('gesture-preview-label'),
    previewClose: $('gesture-preview-close'),
    hold: $('gesture-hold'),
    holdLabel: $('gesture-hold-label'),
    holdBar: $('gesture-hold-bar'),
    settingsOverlay: $('settings-overlay'),
    generateBtn: $('generate-btn'),
    listenBtn: $('listen-btn'),
    captureBtn: $('capture-screen-btn'),
    clearShotsBtn: $('clear-screen-btn'),
    suggestionBody: $('suggestion-body'),
    copyBtn: document.querySelector('#suggestion-actions [data-action="copy"]'),
  };
  const missing = Object.keys(el).filter((k) => !el[k]);
  if (missing.length) {
    console.error('[gestures] missing elements:', missing.join(', '));
    return;
  }

  const store = {
    get(key) {
      try { return localStorage.getItem(key); } catch (err) { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch (err) { /* ignore */ }
    },
  };

  // ---- State ----
  let enabled = false; // the user's switch
  let previewWanted = store.get(STORAGE_PREVIEW) !== '0'; // default on
  let stream = null;
  let recognizer = null;
  let visionModule = null;
  let running = false; // camera open + loop scheduled
  let rafId = 0;
  let lastInferAt = 0;
  let lastVideoTime = -1;
  let lastTimestamp = 0;
  let mainSaysVisible = true; // window hide/minimize events from main.js
  let generation = 0; // bumped on every enable/disable; stale async work bails
  const detector = new core.HoldDetector();
  const byGesture = new Map(core.GESTURE_ACTIONS.map((e) => [e.gesture, e]));

  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const windowVisible = () => mainSaysVisible && !document.hidden;

  function setStatus(text, kind) {
    el.status.textContent = text || '';
    el.status.dataset.kind = kind || '';
  }

  function prettyGesture(name) {
    const entry = byGesture.get(name);
    return entry ? entry.label : String(name || '').replace(/_/g, ' ');
  }

  // ---- Settings table (from the single mapping in gesture-core.js) ----
  function renderMap() {
    el.mapBody.textContent = '';
    for (const entry of core.GESTURE_ACTIONS) {
      const tr = document.createElement('tr');
      const sign = document.createElement('td');
      sign.textContent = entry.label;
      const hold = entry.holdMs || core.DEFAULT_HOLD_MS;
      if (hold !== core.DEFAULT_HOLD_MS) {
        const note = document.createElement('span');
        note.className = 'gesture-hold-note';
        note.textContent = ` (hold ${(hold / 1000).toFixed(1)} s)`;
        sign.appendChild(note);
      }
      const does = document.createElement('td');
      does.textContent = entry.actionLabel;
      tr.append(sign, does);
      el.mapBody.appendChild(tr);
    }
  }

  // ---- UI sync ----
  function syncUI() {
    el.enableToggle.checked = enabled;
    el.previewToggle.checked = previewWanted;
    el.menuBtn.textContent = enabled ? 'Hand gestures: On (turn off)' : 'Hand gestures: Off…';
    el.menuBtn.classList.toggle('active', enabled);
    el.badge.classList.toggle('hidden', !enabled);
    el.preview.classList.toggle('hidden', !(enabled && previewWanted && running));
    if (!running) showHold(null);
  }

  function showHold(out) {
    if (!out || out.state !== 'holding' || !out.entry) {
      el.hold.classList.add('hidden');
      el.preview.style.setProperty('--gesture-progress', '0');
      return;
    }
    el.holdLabel.textContent = `${out.entry.label} → ${actionShortLabel(out.entry)}`;
    el.holdBar.style.transform = `scaleX(${out.progress.toFixed(3)})`;
    el.preview.style.setProperty('--gesture-progress', out.progress.toFixed(3));
    el.hold.classList.remove('hidden');
  }

  function setPreviewLabel(text) {
    if (el.previewLabel.textContent !== text) el.previewLabel.textContent = text;
  }

  // ---- Actions: always the app's own buttons ----
  function actionShortLabel(entry) {
    if (entry.action === 'toggle-listen') return bridge.isListening() ? 'Stop listening' : 'Start listening';
    return entry.short;
  }

  // Each returns nothing on success, or a short reason it couldn't run.
  const ACTIONS = {
    generate() {
      el.generateBtn.click();
    },
    'toggle-listen'() {
      if (bridge.isListenBusy()) return 'already starting/stopping.';
      if (el.listenBtn.disabled) return 'add your API keys first (⋯ menu > API keys).';
      el.listenBtn.click();
    },
    copy() {
      if (!bridge.hasSuggestion()) return 'nothing to copy yet.';
      el.copyBtn.click();
    },
    'scroll-up'() {
      const body = el.suggestionBody;
      if (body.scrollTop <= 0) return 'already at the top.';
      body.scrollBy({
        top: -Math.max(40, Math.round(body.clientHeight * SCROLL_FRACTION)),
        behavior: reducedMotion() ? 'auto' : 'smooth',
      });
    },
    capture() {
      if (bridge.isPrivacyMode()) return 'screen capture is off in Privacy Mode.';
      if (el.captureBtn.disabled) return 'a capture is already in progress.';
      el.captureBtn.click();
    },
    'clear-screenshots'() {
      if (!bridge.screenshotCount()) return 'no screenshots to clear.';
      el.clearShotsBtn.click();
    },
  };

  function fire(entry) {
    const label = actionShortLabel(entry); // before the action flips state
    let problem;
    try {
      problem = ACTIONS[entry.action] ? ACTIONS[entry.action]() : 'not available.';
    } catch (err) {
      console.error('[gestures] action failed:', err);
      problem = 'something went wrong.';
    }
    bridge.toast(problem ? `${entry.label}: ${problem}` : `${entry.label} → ${label}`, 2200);
  }

  // ---- When to ignore the camera ----
  function isTyping() {
    if (!document.hasFocus()) return false; // focus left in an input while you're in another app doesn't count
    const a = document.activeElement;
    if (!a) return false;
    if (a.isContentEditable || a.tagName === 'TEXTAREA') return true;
    return a.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'range'].includes(a.type);
  }

  function pauseReason() {
    if (bridge.isPrivacyMode()) return 'Privacy';
    if (!el.settingsOverlay.classList.contains('hidden')) return 'Settings';
    if (isTyping()) return 'Typing';
    return '';
  }

  // ---- Recognition loop (throttled rAF; rAF itself stops when hidden) ----
  function loop() {
    rafId = 0;
    if (!running) return;
    const now = performance.now();
    if (now - lastInferAt >= 1000 / TARGET_FPS) {
      lastInferAt = now;
      step(now);
    }
    if (running) rafId = requestAnimationFrame(loop);
  }

  function step(now) {
    const reason = pauseReason();
    if (reason) {
      detector.cancelHold();
      showHold(null);
      setPreviewLabel(`Paused: ${reason}`);
      return;
    }
    const video = el.video;
    if (!recognizer || video.readyState < 2 || video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;
    const ts = Math.max(Math.round(now), lastTimestamp + 1); // must strictly increase
    lastTimestamp = ts;
    let result;
    try {
      result = recognizer.recognizeForVideo(video, ts);
    } catch (err) {
      console.error('[gestures] recognition failed:', err);
      fail('Gesture recognition stopped unexpectedly. Turn it on again to retry.');
      return;
    }
    const top = result && result.gestures && result.gestures[0] && result.gestures[0][0];
    const name = top ? top.categoryName : null;
    const score = top ? top.score : 0;
    const out = detector.update({ gesture: name, score, t: now });
    showHold(out);
    setPreviewLabel(name && name !== 'None' ? `${prettyGesture(name)} ${Math.round(score * 100)}%` : '');
    if (out.fired) fire(out.fired);
  }

  // ---- MediaPipe ----
  async function createRecognizer() {
    if (!visionModule) visionModule = await import('./vendor/mediapipe/vision_bundle.mjs');
    const { FilesetResolver, GestureRecognizer } = visionModule;
    // An absolute file:// base (no trailing slash -- MediaPipe appends
    // "/vision_wasm_internal.js"), so its loader reads the local files.
    const base = new URL('vendor/mediapipe', document.baseURI).href;
    const fileset = await FilesetResolver.forVisionTasks(base);
    const bytes = await api.loadGestureModel();
    const modelAssetBuffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
  }

  function closeRecognizer() {
    if (!recognizer) return;
    try { recognizer.close(); } catch (err) { /* already gone */ }
    recognizer = null;
  }

  // ---- Camera ----
  function cameraErrorMessage(err, platform) {
    const name = err && err.name;
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
      return 'No webcam found.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      return platform === 'win32'
        ? 'The camera is in use by another app, or Windows is blocking it (Settings > Privacy & security > Camera).'
        : 'The camera is in use by another app.';
    }
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      return platform === 'win32'
        ? 'Camera access was denied. Check Windows Settings > Privacy & security > Camera ("Let desktop apps access your camera").'
        : 'Camera access was denied.';
    }
    return `Could not start the camera${err && err.message ? `: ${err.message}` : '.'}`;
  }

  function osBlockedMessage(platform) {
    if (platform === 'darwin') {
      return 'macOS is blocking camera access for Echo. Allow it in System Settings > Privacy & Security > Camera, then restart Echo.';
    }
    return 'Windows is blocking camera access. Turn on Settings > Privacy & security > Camera > "Camera access" and "Let desktop apps access your camera", then try again.';
  }

  let lastPlatform = '';

  async function openCamera(gen) {
    if (!enabled || !recognizer || stream || !windowVisible() || gen !== generation) return;
    let s;
    try {
      s = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
    } catch (err) {
      if (gen === generation) fail(cameraErrorMessage(err, lastPlatform));
      return;
    }
    if (gen !== generation || !enabled || !windowVisible() || stream) {
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = s;
    s.getVideoTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (stream === s) fail('The camera stopped (unplugged, or taken by another app).');
      });
    });
    el.video.srcObject = s;
    try {
      await el.video.play();
    } catch (err) { /* frames still arrive for a muted inline video */ }
    if (stream !== s) return;
    running = true;
    lastVideoTime = -1;
    detector.cancelHold();
    setPreviewLabel('');
    setStatus('On \u2014 the camera is watching for hand signs.', 'ok');
    syncUI();
    if (!rafId) rafId = requestAnimationFrame(loop);
  }

  function closeCamera() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    try { el.video.pause(); } catch (err) { /* ignore */ }
    el.video.srcObject = null;
    detector.cancelHold();
    syncUI();
  }

  // ---- On / off ----
  async function enable() {
    const gen = ++generation;
    enabled = true;
    store.set(STORAGE_ENABLED, '1');
    syncUI();
    setStatus('Starting…', 'info');

    let status;
    try {
      status = await api.setGesturesEnabled(true);
    } catch (err) {
      if (gen === generation) fail(`Could not turn on gestures: ${err.message}`);
      return;
    }
    if (gen !== generation) return;
    lastPlatform = status.platform || '';
    if (status.camera === 'denied' || status.camera === 'restricted') {
      fail(osBlockedMessage(status.platform));
      return;
    }
    if (!status.modelPresent || !status.runtimePresent) {
      fail(`${MODEL_MISSING_TEXT} (it downloads the model once), then switch this on again.`);
      return;
    }

    if (!recognizer) {
      setStatus('Loading the gesture model…', 'info');
      let created;
      try {
        created = await createRecognizer();
      } catch (err) {
        console.error('[gestures] could not load MediaPipe:', err);
        if (gen === generation) {
          // MediaPipe errors carry a long C++ source trace; keep the first line.
          const detail = String((err && err.message) || err).split('\n')[0].slice(0, 160);
          fail(err && err.code === 'GESTURE_MODEL_MISSING'
            ? MODEL_MISSING_TEXT
            : `Could not load the gesture model (${detail}). If the file is damaged, run npm run gestures:fetch -- --force.`);
        }
        return;
      }
      if (gen !== generation || !enabled) {
        try { created.close(); } catch (err) { /* ignore */ }
        return;
      }
      recognizer = created;
    }
    if (!windowVisible()) {
      setStatus('Paused while Echo is hidden.', 'info');
      return;
    }
    await openCamera(gen);
  }

  async function disable({ message = '', kind = '' } = {}) {
    generation += 1;
    enabled = false;
    store.set(STORAGE_ENABLED, '0');
    closeCamera();
    detector.reset();
    closeRecognizer();
    setStatus(message || 'Off. The camera is not in use.', kind);
    syncUI();
    try {
      await api.setGesturesEnabled(false);
    } catch (err) { /* main resets it with the window anyway */ }
  }

  // Something went wrong: switch off (and remember off), explain why.
  function fail(message) {
    console.warn('[gestures]', message);
    disable({ message, kind: 'error' });
    if (el.settingsOverlay.classList.contains('hidden')) bridge.toast(`Hand gestures turned off: ${message}`, 6000);
  }

  function onVisibilityMaybeChanged() {
    if (!enabled) return;
    if (!windowVisible()) {
      if (stream) {
        closeCamera();
        setStatus('Paused while Echo is hidden (camera off).', 'info');
      }
    } else if (!stream && recognizer) {
      openCamera(generation);
    }
  }

  function openGestureSettings() {
    bridge.openSettings();
    // openSettings focuses a key field on the next tick; scroll after it.
    setTimeout(() => {
      el.section.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
      el.enableToggle.focus({ preventScroll: true });
    }, 30);
  }

  // ---- Wiring ----
  el.enableToggle.addEventListener('change', () => {
    if (el.enableToggle.checked) enable();
    else disable();
  });
  el.previewToggle.addEventListener('change', () => {
    previewWanted = el.previewToggle.checked;
    store.set(STORAGE_PREVIEW, previewWanted ? '1' : '0');
    syncUI();
  });
  el.previewClose.addEventListener('click', (e) => {
    e.stopPropagation();
    previewWanted = false;
    store.set(STORAGE_PREVIEW, '0');
    syncUI();
    bridge.toast('Camera preview hidden. Gestures keep working (turn the preview back on in Settings).', 4000);
  });
  el.menuBtn.addEventListener('click', () => {
    if (enabled) {
      disable();
      bridge.toast('Hand gestures off. The camera is not in use.', 2500);
    } else {
      openGestureSettings();
    }
  });
  el.badge.addEventListener('click', () => {
    disable();
    bridge.toast('Hand gestures off. The camera is not in use.', 2500);
  });
  document.addEventListener('visibilitychange', onVisibilityMaybeChanged);
  if (typeof api.onWindowVisibilityChanged === 'function') {
    api.onWindowVisibilityChanged((visible) => {
      mainSaysVisible = !!visible;
      onVisibilityMaybeChanged();
    });
  }
  window.addEventListener('beforeunload', () => closeCamera());

  // ---- Start-up ----
  renderMap();
  syncUI();
  if (store.get(STORAGE_ENABLED) === '1') {
    enable();
  } else {
    setStatus('Off. The camera is not in use.', '');
    api.setGesturesEnabled(false).catch(() => {});
    api.getGestureStatus().then((st) => {
      if (!enabled && st && (!st.modelPresent || !st.runtimePresent)) {
        setStatus(`${MODEL_MISSING_TEXT} (downloads it once). Everything else works without it.`, 'error');
      }
    }).catch(() => {});
  }
})();
