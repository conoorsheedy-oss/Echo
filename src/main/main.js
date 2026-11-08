const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  desktopCapturer,
  session,
  Tray,
  Menu,
  screen,
  nativeImage,
  dialog,
  shell,
  systemPreferences,
  clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');

const { loadEnv } = require('./env');
loadEnv();

// AI calls go straight from this (main) process to Groq and Google Gemini
// using the user's own API keys -- see ai.js and keyStore.js. There is no
// Echo server. The knowledge base (the user's CV/notes) stays on this
// machine; only the snippets that match a question are sent to Gemini.
const ai = require('./ai');
const keyStore = require('./keyStore');
const knowledge = require('./knowledge');
const { createRequestRegistry } = require('./ai-requests');

// The only external pages the app may open (Settings > "Get a free key").
// The renderer asks by name; it can't pass an arbitrary URL.
const EXTERNAL_PAGES = {
  groq: 'https://console.groq.com/keys',
  gemini: 'https://aistudio.google.com/apikey',
};

// Log unexpected errors instead of letting Electron quit mid-conversation.
process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled rejection:', reason);
});

// Loaded once at startup; reloaded on demand via the "Reload" button in the app.
let knowledgeStatus = knowledge.loadKnowledgeBase();

// Best-effort guess at "what's actually being asked right now" to search the
// knowledge base with — the last transcript line, falling back to the tail
// of the whole transcript.
function extractSearchQuery(transcript) {
  if (!transcript) return '';
  const lines = transcript.trim().split('\n').filter(Boolean);
  if (!lines.length) return '';
  const lastLine = lines[lines.length - 1];
  const colonIdx = lastLine.indexOf(':');
  return colonIdx !== -1 ? lastLine.slice(colonIdx + 1).trim() : lastLine.trim();
}

const DEFAULT_BOUNDS = { width: 480, height: 760 };
const BOUNDS_FILE = path.join(app.getPath('userData'), 'window-bounds.json');

// Window size/position is remembered across restarts (best-effort; falls
// back to DEFAULT_BOUNDS).
function loadSavedBounds() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8'));
    if (
      parsed &&
      Number.isFinite(parsed.width) &&
      Number.isFinite(parsed.height) &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y)
    ) {
      return parsed;
    }
  } catch (err) {
    // No saved bounds yet (first run), or the file is corrupt — ignore.
  }
  return null;
}

function saveBounds(bounds) {
  try {
    fs.writeFileSync(BOUNDS_FILE, JSON.stringify(bounds));
  } catch (err) {
    // Best-effort only — not worth surfacing to the user.
  }
}

let saveBoundsTimer = null;
function scheduleSaveBounds(win) {
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    if (compactMode && preCompactSize) {
      // In compact mode, remember where the bar was moved to, but keep the
      // full-size width/height as the saved size for next launch.
      compactHeight = b.height;
      saveBounds({ x: b.x, y: b.y, width: preCompactSize.width, height: preCompactSize.height });
    } else {
      saveBounds(b);
    }
  }, 400);
}

let overlayWindow = null;
let tray = null;
let clickThroughEnabled = false;

// Privacy / Presentation Mode: pauses screen capture and automatic
// (background) suggestion generation. It deliberately does NOT touch mic/
// system-audio transcription — that's the separate Start/Stop Listening
// control — and it's not a concealment mechanism: the badge in the overlay
// header makes it obvious to the user themselves when it's on.
let privacyModeEnabled = false;

function togglePrivacyMode() {
  privacyModeEnabled = !privacyModeEnabled;
  overlayWindow?.webContents.send('hotkey:privacy-mode-changed', privacyModeEnabled);
  refreshTray();
}

// Hides the overlay from screen-share/recording tools (OS content protection).
// OFF by default and deliberately never persisted: it should only be on when
// everyone on the call has agreed, launch by launch, not as a setting someone
// forgets. A header badge shows whenever it's on.
let contentProtectionEnabled = false;

function toggleContentProtection() {
  contentProtectionEnabled = !contentProtectionEnabled;
  overlayWindow?.setContentProtection(contentProtectionEnabled);
  overlayWindow?.webContents.send('hotkey:content-protection-changed', contentProtectionEnabled);
  refreshTray();
}

// ---- Hand gestures (opt-in, off by default -- see src/renderer/gestures.js) ----
// The camera is only ever granted to our own overlay page, and only while the
// user has switched gestures on (the renderer flips this flag over IPC). It is
// in-memory only: a fresh or recreated window starts with it off and the
// renderer re-enables it from the user's saved choice.
let gesturesEnabled = false;
// System-audio capture is a getUserMedia() call with a desktop *video* track
// (dropped immediately), so camera-style 'video' requests are also allowed for
// a few seconds right after the renderer asks for the desktop audio source.
let desktopCaptureArmedUntil = 0;
const DESKTOP_CAPTURE_ARM_MS = 15_000;

const RENDERER_INDEX = path.join(__dirname, '..', 'renderer', 'index.html');
const GESTURE_VENDOR_DIR = path.join(__dirname, '..', 'renderer', 'vendor', 'mediapipe');
const GESTURE_MODEL_PATH = path.join(GESTURE_VENDOR_DIR, 'gesture_recognizer.task');
const GESTURE_MODEL_MIN_BYTES = 1_000_000;
const GESTURE_MODEL_MAX_BYTES = 64 * 1024 * 1024;
const GESTURE_WASM_FILES = ['vision_bundle.mjs', 'vision_wasm_internal.js', 'vision_wasm_internal.wasm'];

function samePath(a, b) {
  const na = path.normalize(a);
  const nb = path.normalize(b);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}

// True only for our own overlay window showing our own local index.html.
function isOwnOverlayPage(webContents, url) {
  if (!webContents || !overlayWindow || overlayWindow.isDestroyed()) return false;
  if (webContents.id !== overlayWindow.webContents.id) return false;
  try {
    const u = new URL(url || webContents.getURL());
    if (u.protocol !== 'file:') return false;
    return samePath(fileURLToPath(u), RENDERER_INDEX);
  } catch (err) {
    return false;
  }
}

function videoCaptureAllowed() {
  return gesturesEnabled || Date.now() < desktopCaptureArmedUntil;
}

// mediaTypes: ['audio'] for the mic; ['audio', 'video'] / ['video'] for system
// audio (desktop capture) and the webcam.
function mediaRequestAllowed(webContents, details) {
  if (!isOwnOverlayPage(webContents, details && details.requestingUrl)) return false;
  const types = Array.isArray(details && details.mediaTypes) ? details.mediaTypes : [];
  if (types.length && types.every((t) => t === 'audio')) return true;
  return videoCaptureAllowed();
}

function cameraAccessStatus() {
  // 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'.
  // Only macOS and Windows expose an OS-level camera switch to apps.
  if (process.platform !== 'win32' && process.platform !== 'darwin') return 'unknown';
  try {
    return systemPreferences.getMediaAccessStatus('camera');
  } catch (err) {
    return 'unknown';
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    return -1;
  }
}

function gestureStatus() {
  return {
    enabled: gesturesEnabled,
    camera: cameraAccessStatus(),
    platform: process.platform,
    modelPresent: fileSize(GESTURE_MODEL_PATH) >= GESTURE_MODEL_MIN_BYTES,
    runtimePresent: GESTURE_WASM_FILES.every((f) => fileSize(path.join(GESTURE_VENDOR_DIR, f)) > 0),
  };
}

const FULL_MIN_SIZE = { width: 360, height: 480 };
const COMPACT_MIN_SIZE = { width: 260, height: 90 };
let compactMode = false;
let preCompactSize = null; // { width, height } to restore when leaving compact mode
let compactHeight = 170; // remembered while the app runs if the user resizes the bar

function setCompact(enabled) {
  const win = overlayWindow;
  if (!win || win.isDestroyed()) return false;
  if (enabled === compactMode) return compactMode;
  const b = win.getBounds();
  if (enabled) {
    preCompactSize = { width: b.width, height: b.height };
    compactMode = true;
    win.setMinimumSize(COMPACT_MIN_SIZE.width, COMPACT_MIN_SIZE.height);
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: compactHeight });
  } else {
    compactMode = false;
    const size = preCompactSize || DEFAULT_BOUNDS;
    preCompactSize = null;
    // Grow first, then restore the full-size minimum (the other order would
    // make Electron snap the size on its own).
    win.setBounds({
      x: b.x,
      y: b.y,
      width: Math.max(size.width, FULL_MIN_SIZE.width),
      height: Math.max(size.height, FULL_MIN_SIZE.height),
    });
    win.setMinimumSize(FULL_MIN_SIZE.width, FULL_MIN_SIZE.height);
  }
  win.webContents.send('window:compact-changed', compactMode);
  return compactMode;
}

function createOverlayWindow() {
  // A (re)created window always starts at full size.
  compactMode = false;
  preCompactSize = null;
  // ...and with the camera closed until its renderer opts back in.
  gesturesEnabled = false;
  const saved = loadSavedBounds();
  overlayWindow = new BrowserWindow({
    width: saved ? saved.width : DEFAULT_BOUNDS.width,
    height: saved ? saved.height : DEFAULT_BOUNDS.height,
    minWidth: FULL_MIN_SIZE.width,
    minHeight: FULL_MIN_SIZE.height,
    x: saved ? saved.x : 60,
    y: saved ? saved.y : 60,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer's voice-activity detection samples audio levels every
      // ~40 ms; Chromium would otherwise throttle that to ~1/s (and worse
      // after a few minutes) whenever the overlay is hidden, which delays
      // chunk cuts while you keep talking with Echo hidden.
      backgroundThrottling: false,
    },
  });

  // Off by default -- see toggleContentProtection above.
  overlayWindow.setContentProtection(contentProtectionEnabled);
  if (contentProtectionEnabled && process.platform === 'darwin') {
    app.dock.hide();
  }

  // Echo renderer errors/warnings to the terminal (npm start) as
  // "[renderer error] ..." / "[renderer warning] ..." (or a numeric level on
  // older Electron) so a broken script is visible without DevTools.
  overlayWindow.webContents.on('console-message', (...args) => {
    // Electron <=34: (event, level, message, line, sourceId); newer: (event) with details on the event.
    const details = args[0] && typeof args[0].message === 'string' ? args[0] : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
    const level = details.level;
    if (level === 'error' || level === 3 || level === 2 || level === 'warning') {
      console.log(`[renderer ${level}] ${details.message} (${details.sourceId || ''}:${details.lineNumber || ''})`);
    }
  });

  // 'screen-saver' level keeps it above most fullscreen apps/games on Windows.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(RENDERER_INDEX);

  // This window only ever shows its own local index.html: block new windows
  // and navigation (e.g. from a prompt-injected link in an AI answer).
  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlayWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  overlayWindow.on('resize', () => scheduleSaveBounds(overlayWindow));
  overlayWindow.on('move', () => scheduleSaveBounds(overlayWindow));

  // Lets the hand-gesture loop release the camera while Echo is hidden or
  // minimized (document.visibilityState doesn't change on every platform).
  const sendVisibility = (visible) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('window:visibility-changed', visible);
    }
  };
  overlayWindow.on('hide', () => sendVisibility(false));
  overlayWindow.on('minimize', () => sendVisibility(false));
  overlayWindow.on('show', () => sendVisibility(true));
  overlayWindow.on('restore', () => sendVisibility(true));

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  // If the renderer process dies, recreate the window instead of leaving a
  // blank one (the tray icon and hotkeys keep working).
  overlayWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] Overlay renderer process gone:', details.reason);
    const dead = overlayWindow;
    overlayWindow = null;
    try {
      dead?.destroy();
    } catch (err) {
      // Already gone — nothing to clean up.
    }
    createOverlayWindow();
  });
}

// Snap the window back to the primary display if it no longer overlaps any
// connected display (e.g. a monitor was unplugged).
function ensureWindowOnScreen(win) {
  const bounds = win.getBounds();
  const onAnyDisplay = screen.getAllDisplays().some((d) => {
    const r = d.workArea;
    return (
      bounds.x < r.x + r.width &&
      bounds.x + bounds.width > r.x &&
      bounds.y < r.y + r.height &&
      bounds.y + bounds.height > r.y
    );
  });
  if (!onAnyDisplay) {
    resetWindowPosition(win);
  }
}

function resetWindowPosition(win) {
  if (compactMode) setCompact(false);
  const primary = screen.getPrimaryDisplay().workArea;
  const bounds = {
    x: primary.x + 60,
    y: primary.y + 60,
    width: DEFAULT_BOUNDS.width,
    height: DEFAULT_BOUNDS.height,
  };
  win.setBounds(bounds);
  saveBounds(bounds); // this becomes the new remembered baseline too
}

// The one "bring it back" path (tray icon, Ctrl+Shift+Space, tray menu):
// recreate if destroyed, un-minimize, snap on-screen, show + focus.
function showOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
    return;
  }
  if (overlayWindow.isMinimized()) overlayWindow.restore();
  ensureWindowOnScreen(overlayWindow);
  overlayWindow.show();
  overlayWindow.focus();
}

function toggleOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    showOverlay();
    return;
  }
  if (overlayWindow.isVisible() && !overlayWindow.isMinimized()) {
    overlayWindow.hide();
  } else {
    showOverlay();
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show / Hide', click: () => toggleOverlay() },
    {
      label: 'Privacy Mode',
      type: 'checkbox',
      checked: privacyModeEnabled,
      click: () => togglePrivacyMode(),
    },
    {
      label: 'Hide from Screen Share',
      type: 'checkbox',
      checked: contentProtectionEnabled,
      click: () => toggleContentProtection(),
    },
    {
      label: 'Reset window position',
      click: () => {
        if (overlayWindow && !overlayWindow.isDestroyed()) resetWindowPosition(overlayWindow);
        showOverlay();
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

// Rebuild the tray menu/tooltip after Privacy Mode or screen-share changes.
function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(
    privacyModeEnabled
      ? 'Echo — Privacy Mode active (Ctrl+Shift+P to turn off)'
      : 'Echo — click to show/hide (Ctrl+Shift+Space)'
  );
}

function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png');
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  refreshTray();

  // Left-click (Windows/Linux) also toggles it — the menu above covers the rest.
  tray.on('click', () => toggleOverlay());
}

function registerShortcuts() {
  // Show/hide the whole overlay — also the main "I lost it" recovery hotkey:
  // it un-minimizes, snaps back on-screen if stranded, and focuses.
  globalShortcut.register('CommandOrControl+Shift+Space', () => toggleOverlay());

  // Ask the assistant to generate a suggestion right now.
  globalShortcut.register('CommandOrControl+Return', () => {
    overlayWindow?.webContents.send('hotkey:generate');
  });

  // Clear the running transcript.
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    overlayWindow?.webContents.send('hotkey:clear');
  });

  // Toggle click-through so the overlay never blocks clicks on what's under it.
  globalShortcut.register('CommandOrControl+Shift+X', () => {
    if (!overlayWindow) return;
    clickThroughEnabled = !clickThroughEnabled;
    overlayWindow.setIgnoreMouseEvents(clickThroughEnabled, { forward: true });
    overlayWindow.webContents.send('hotkey:click-through-changed', clickThroughEnabled);
  });

  // Quick screen capture (grabs whatever source was last selected, or the primary screen).
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    overlayWindow?.webContents.send('hotkey:capture-screen');
  });

  // Summarize the session so far (summary, decisions, action items, unresolved questions).
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    overlayWindow?.webContents.send('hotkey:summarize');
  });

  // Toggle "Focus" mode — the suggestion panel fills the whole overlay.
  globalShortcut.register('CommandOrControl+Shift+E', () => {
    overlayWindow?.webContents.send('hotkey:toggle-expand');
  });

  // Toggle Privacy / Presentation Mode — pauses screen capture and
  // automatic suggestion generation (manual Generate still works).
  globalShortcut.register('CommandOrControl+Shift+P', () => togglePrivacyMode());

  // Toggle hiding the overlay from screen-share/recording tools. Off by
  // default every launch -- see toggleContentProtection above for why.
  globalShortcut.register('CommandOrControl+Shift+H', () => toggleContentProtection());

  // Toggle the slim "compact bar" (only the latest answer is shown).
  globalShortcut.register('CommandOrControl+Shift+K', () => setCompact(!compactMode));

  // Toggle the diagnostics panel (recent request latency/failures, current state).
  globalShortcut.register('CommandOrControl+Shift+D', () => {
    overlayWindow?.webContents.send('hotkey:diagnostics');
  });
}

app.whenReady().then(() => {
  // Permissions: deny by default. Our own overlay page gets the mic and
  // system audio without a prompt (so getUserMedia doesn't stall), the
  // webcam ONLY while hand gestures are switched on, and clipboard writes
  // for the Copy buttons. Nothing else, and nothing for any other origin.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission === 'media') {
      callback(mediaRequestAllowed(webContents, details));
      return;
    }
    if (permission === 'clipboard-sanitized-write') {
      callback(isOwnOverlayPage(webContents, details && details.requestingUrl));
      return;
    }
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    const url = details && details.requestingUrl;
    if (permission === 'media') {
      if (!isOwnOverlayPage(webContents, url)) return false;
      return details.mediaType === 'video' ? videoCaptureAllowed() : true;
    }
    if (permission === 'clipboard-sanitized-write') return isOwnOverlayPage(webContents, url);
    return false;
  });

  createOverlayWindow();
  createTray();
  registerShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlayWindow();
  });
});

// The tray is the way to quit; only quit on window-all-closed without one.
app.on('window-all-closed', () => {
  if (!tray) {
    globalShortcut.unregisterAll();
    if (process.platform !== 'darwin') app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// ---- IPC: renderer -> main ----

// Electron only carries an error's message across ipcRenderer.invoke, so
// err.code ('NO_KEY', 'BAD_KEY', 'RATE_LIMIT', 'OFFLINE', ...) and err.status
// are appended as a "[[echo:{...}]]" marker; renderer.js (normalizeIpcError)
// strips it and restores the fields.
function tagIpcError(err) {
  if (!err || typeof err !== 'object') return new Error(String(err));
  const meta = {};
  if (err.code) meta.code = String(err.code);
  if (err.status) meta.status = Number(err.status);
  if (!meta.code && !meta.status) return err;
  return new Error(`${err.message || 'Error'} [[echo:${JSON.stringify(meta)}]]`);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw tagIpcError(err);
    }
  });
}

// Every handler validates its payload (defence in depth): a malformed or
// oversized payload fails with a clear error instead of deep inside fetch.

const MAX_BASE64_AUDIO_CHARS = 8 * 1024 * 1024; // ~6MB of raw audio, generous for a <=12 s opus chunk
const MAX_BASE64_IMAGE_CHARS = 20 * 1024 * 1024; // ~15MB raw, generous for a full-res screenshot
const MAX_TEXT_CHARS = 200_000; // question/instruction/clipboard sanity cap
// The WHOLE session transcript goes over IPC (summaries use all of it; ai.js
// caps what goes into a suggest/ask prompt at ai.MAX_PROMPT_TRANSCRIPT_CHARS,
// dropping the oldest lines first). ~1M chars is many hours of talk.
const MAX_TRANSCRIPT_CHARS = 1_000_000;

function assertOptionalString(value, name, maxLen = MAX_TEXT_CHARS) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') throw new Error(`Invalid ${name}.`);
  if (value.length > maxLen) throw new Error(`${name} is too long.`);
}

function assertImage(image) {
  if (image === undefined || image === null) return;
  if (typeof image !== 'object') throw new Error('Invalid image payload.');
  if (image.base64 !== undefined) {
    if (typeof image.base64 !== 'string' || image.base64.length > MAX_BASE64_IMAGE_CHARS) {
      throw new Error('Invalid or oversized image data.');
    }
  }
  assertOptionalString(image.mimeType, 'image.mimeType', 200);
  assertOptionalString(image.name, 'image.name', 500);
}

// ---- Multiple screenshots ----
// The renderer sends up to MAX_IMAGES screenshots as an `images` array of
// { mimeType, base64, name }. Captures are already downscaled/JPEG'd in
// screen:capture. Gemini caps an inline (non-File-API) request at ~20 MB,
// and smaller uploads are simply faster -- so before sending, the combined
// base64 is checked against a budget and, if needed, re-encoded smaller in
// steps. If even the smallest step doesn't fit, fail with a clear message.
const MAX_IMAGES = 4;
const CAPTURE_MAX_EDGE = 1280; // px, long edge
const CAPTURE_JPEG_QUALITY = 70; // nativeImage.toJPEG takes 0-100
const MAX_TOTAL_IMAGE_BASE64_CHARS = 6_000_000; // ~4.5 MB of JPEG, well under Gemini's request limit
const IMAGE_SHRINK_STEPS = [
  { maxEdge: 1024, quality: 55 },
  { maxEdge: 800, quality: 45 },
  { maxEdge: 640, quality: 35 },
];

function downscaleToJpeg(img, maxEdge, quality) {
  const { width, height } = img.getSize();
  const longEdge = Math.max(width, height);
  let out = img;
  if (longEdge > maxEdge) {
    const scale = maxEdge / longEdge;
    out = img.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'good',
    });
  }
  return out.toJPEG(quality);
}

function totalBase64Chars(images) {
  return images.reduce((n, im) => n + (im.base64 ? im.base64.length : 0), 0);
}

// Validates + normalizes the images payload, then makes sure it fits the
// upload budget. Returns an array (or undefined when there's nothing to send).
function prepareImages(images) {
  let list = images;
  if (list === undefined || list === null) list = [];
  if (!Array.isArray(list)) throw new Error('Invalid images payload.');
  if (list.length > MAX_IMAGES) {
    throw new Error(`Too many screenshots (max ${MAX_IMAGES}) - remove some.`);
  }
  list.forEach(assertImage);
  list = list
    .filter((im) => im && typeof im.base64 === 'string' && im.base64)
    .map((im) => ({ mimeType: im.mimeType || 'image/png', base64: im.base64, name: im.name }));
  if (!list.length) return undefined;
  if (totalBase64Chars(list) <= MAX_TOTAL_IMAGE_BASE64_CHARS) return list;

  for (const step of IMAGE_SHRINK_STEPS) {
    const shrunk = list.map((im) => {
      const img = nativeImage.createFromBuffer(Buffer.from(im.base64, 'base64'));
      if (img.isEmpty()) throw new Error('One of the screenshots could not be read - remove it and try again.');
      return {
        mimeType: 'image/jpeg',
        base64: downscaleToJpeg(img, step.maxEdge, step.quality).toString('base64'),
        name: im.name,
      };
    });
    if (totalBase64Chars(shrunk) <= MAX_TOTAL_IMAGE_BASE64_CHARS) return shrunk;
  }
  const err = new Error('Too many or too large screenshots - remove some.');
  err.code = 'IMAGES_TOO_LARGE';
  throw err;
}

// Returns a desktop source id the renderer can use to capture system (loopback) audio.
handle('desktop:get-audio-source', async () => {
  desktopCaptureArmedUntil = Date.now() + DESKTOP_CAPTURE_ARM_MS;
  const sources = await desktopCapturer.getSources({ types: ['screen'], fetchWindowIcons: false });
  if (!sources.length) {
    throw new Error('No screen sources available for system-audio capture.');
  }
  return sources[0].id;
});

// One audio chunk (an utterance cut at a pause by the renderer's VAD, at
// most ~12 s) -> Groq Whisper, with the user's own key (ai.js).
handle('stt:transcribe', async (_evt, { base64, mimeType, speaker } = {}) => {
  if (base64 !== undefined && (typeof base64 !== 'string' || base64.length > MAX_BASE64_AUDIO_CHARS)) {
    throw new Error('Invalid or oversized audio chunk.');
  }
  assertOptionalString(mimeType, 'mimeType', 200);
  if (speaker !== 'You' && speaker !== 'Them') {
    throw new Error('Invalid speaker.');
  }
  const text = await ai.transcribeAudio({ base64, mimeType });
  return { text, speaker };
});

// ---- Answers: streaming + cancellation ----
// Each suggest/ask request carries a renderer-made requestId. While Gemini
// streams, every piece of text is forwarded as an 'ai:chunk' event
// ({ requestId, text }); the invoke() promise itself is the "done" (resolves
// with the full answer) or "error" (rejects) signal.
//
// Every request gets its own AbortController (ai-requests.js). A new
// *explicit* suggestion (Generate / hotkey / Regenerate / Shorten / Expand)
// supersedes every suggestion still in flight; a new *automatic* one only
// supersedes older automatic ones, so it never kills an answer the user
// asked for. Aborting cancels the underlying HTTP request.
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PREVIOUS_ANSWERS = 20;
const aiRequests = createRequestRegistry();

function validateRequestId(requestId) {
  if (requestId === undefined || requestId === null) return null;
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) throw new Error('Invalid requestId.');
  return requestId;
}

function validateQuality(quality) {
  if (quality === undefined || quality === null) return 'auto';
  if (typeof quality !== 'string' || !ai.QUALITY_SETTINGS.has(quality)) throw new Error('Invalid quality setting.');
  return quality;
}

// Settings > Answer style: 'script' (full spoken sentences) or 'cues'.
function validateAnswerStyle(style) {
  if (style === undefined || style === null) return 'script';
  if (typeof style !== 'string' || !ai.ANSWER_STYLES.has(style)) throw new Error('Invalid answer style.');
  return style;
}

// [{ kind: 'suggestion'|'chat', question, text }] -- answers already shown
// this session, so follow-ups ("expand on that") have something to refer to.
function validatePreviousAnswers(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX_PREVIOUS_ANSWERS) throw new Error('Invalid previousAnswers.');
  return list.map((a) => {
    if (!a || typeof a !== 'object') throw new Error('Invalid previousAnswers.');
    assertOptionalString(a.question, 'previousAnswers.question', 4000);
    assertOptionalString(a.text, 'previousAnswers.text', 20_000);
    return { kind: a.kind === 'chat' ? 'chat' : 'suggestion', question: a.question || '', text: a.text || '' };
  });
}

function chunkForwarder(evt, requestId) {
  if (!requestId) return undefined; // no id: no streaming events
  return (text) => {
    if (evt.sender && !evt.sender.isDestroyed()) evt.sender.send('ai:chunk', { requestId, text });
  };
}

handle('ai:suggest', async (evt, { requestId, kind, transcript, mode, instruction, question, previousAnswers, quality, answerStyle, images } = {}) => {
  const id = validateRequestId(requestId);
  assertOptionalString(transcript, 'transcript', MAX_TRANSCRIPT_CHARS);
  assertOptionalString(mode, 'mode', 50);
  assertOptionalString(instruction, 'instruction', 4000);
  assertOptionalString(question, 'question', 4000);
  const prior = validatePreviousAnswers(previousAnswers);
  const q = validateQuality(quality);
  const style = validateAnswerStyle(answerStyle);
  const requestKind = kind === 'auto' ? 'auto' : 'explicit';
  // Privacy Mode: never send screenshots, even if the renderer still had some.
  const preparedImages = privacyModeEnabled ? undefined : prepareImages(images);

  const req = aiRequests.start('suggest', id, requestKind);
  try {
    const query = question || instruction || extractSearchQuery(transcript);
    const knowledgeSnippets = knowledge.searchKnowledge(query);
    return await ai.generateSuggestion({
      transcript,
      mode,
      instruction,
      question,
      previousAnswers: prior,
      quality: q,
      answerStyle: style,
      images: preparedImages,
      knowledgeSnippets,
      // Lets a superseding request actually cancel this HTTP request.
      signal: req.signal,
      onChunk: chunkForwarder(evt, id),
    });
  } finally {
    req.done();
  }
});

handle('ai:ask', async (evt, { requestId, transcript, question, mode, previousAnswers, quality, images } = {}) => {
  const id = validateRequestId(requestId);
  assertOptionalString(transcript, 'transcript', MAX_TRANSCRIPT_CHARS);
  assertOptionalString(question, 'question', 4000);
  assertOptionalString(mode, 'mode', 50);
  if (!question || !question.trim()) throw new Error('Type a question first.');
  const prior = validatePreviousAnswers(previousAnswers);
  const q = validateQuality(quality);
  const preparedImages = privacyModeEnabled ? undefined : prepareImages(images);
  const knowledgeSnippets = knowledge.searchKnowledge(question);

  const req = aiRequests.start('ask', id, 'explicit');
  try {
    return await ai.askFollowUp({
      transcript,
      question,
      mode,
      previousAnswers: prior,
      quality: q,
      images: preparedImages,
      knowledgeSnippets,
      signal: req.signal,
      onChunk: chunkForwarder(evt, id),
    });
  } finally {
    req.done();
  }
});

handle('ai:summarize', async (_evt, { transcript } = {}) => {
  assertOptionalString(transcript, 'transcript', MAX_TRANSCRIPT_CHARS);
  return ai.summarizeSession({ transcript });
});

// ---- API keys (see keyStore.js) ----
// The renderer can save or remove keys, but can never read one back: every
// handler here returns only keyStore.getStatus() (booleans + where each key
// came from).

handle('keys:status', async () => keyStore.getStatus());

handle('keys:save', async (_evt, { groq, gemini } = {}) => {
  assertOptionalString(groq, 'Groq key', 400);
  assertOptionalString(gemini, 'Gemini key', 400);
  return keyStore.saveKeys({ groq, gemini });
});

handle('keys:remove', async () => keyStore.removeKeys());

// Cheap, token-free check that each key is accepted by its provider.
handle('keys:test', async () => ai.testKeys());

// Opens one of the allowlisted "get a free key" pages in the real browser.
handle('external:open', async (_evt, { page } = {}) => {
  if (typeof page !== 'string' || !Object.prototype.hasOwnProperty.call(EXTERNAL_PAGES, page)) {
    throw new Error('Unknown page.');
  }
  await shell.openExternal(EXTERNAL_PAGES[page]);
  return { ok: true };
});

// ---- Screen-share/recording visibility (see toggleContentProtection above) ----

handle('content-protection:status', async () => ({ enabled: contentProtectionEnabled }));
handle('content-protection:toggle', async () => {
  toggleContentProtection();
  return { enabled: contentProtectionEnabled };
});

// Saves the summary via a native save dialog; the renderer never supplies a path.
handle('summary:export', async (_evt, { content } = {}) => {
  assertOptionalString(content, 'content', 500_000);
  if (!overlayWindow) return { canceled: true };

  const { canceled, filePath } = await dialog.showSaveDialog(overlayWindow, {
    title: 'Export Session Summary',
    defaultPath: `session-summary-${new Date().toISOString().slice(0, 10)}.md`,
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Text', extensions: ['txt'] },
    ],
  });
  if (canceled || !filePath) return { canceled: true };

  await fs.promises.writeFile(filePath, content || '', 'utf-8');
  return { canceled: false, filePath };
});

// ---- Personal knowledge base (see src/main/knowledge.js) ----

handle('knowledge:status', async () => knowledgeStatus);

handle('knowledge:reload', async () => {
  knowledgeStatus = knowledge.loadKnowledgeBase();
  return knowledgeStatus;
});

handle('knowledge:open-folder', async () => {
  await shell.openPath(knowledge.KNOWLEDGE_DIR);
  return { ok: true };
});

// Copies picked .txt/.md files into the knowledge folder (renaming on a name
// clash, never overwriting), then reloads.
handle('knowledge:add-files', async () => {
  if (!overlayWindow) return { added: [], canceled: true };
  const { canceled, filePaths } = await dialog.showOpenDialog(overlayWindow, {
    title: 'Add knowledge files',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Text / Markdown', extensions: ['txt', 'md'] }],
  });
  if (canceled || !filePaths.length) return { added: [], canceled: true };

  const added = [];
  for (const srcPath of filePaths) {
    let destName = path.basename(srcPath);
    let destPath = path.join(knowledge.KNOWLEDGE_DIR, destName);
    if (fs.existsSync(destPath)) {
      const ext = path.extname(destName);
      const base = destName.slice(0, destName.length - ext.length);
      let n = 1;
      do {
        destName = `${base} (${n})${ext}`;
        destPath = path.join(knowledge.KNOWLEDGE_DIR, destName);
        n += 1;
      } while (fs.existsSync(destPath));
    }
    try {
      fs.copyFileSync(srcPath, destPath);
      added.push(destName);
    } catch (err) {
      console.error(`[knowledge] Could not copy "${srcPath}":`, err.message);
    }
  }

  knowledgeStatus = knowledge.loadKnowledgeBase();
  return { added, canceled: false, status: knowledgeStatus };
});

// ---- Screen capture (for "what's on my screen" context, not audio) ----

// Every open screen + window, for the source dropdown (the renderer uses id + name).
handle('screen:list-sources', async () => {
  if (privacyModeEnabled) {
    throw new Error('Screen capture is disabled while Privacy Mode is active.');
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 220, height: 140 },
    fetchWindowIcons: false,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name || (s.id.startsWith('screen') ? 'Screen' : 'Window'),
    thumbnailDataUrl: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
  }));
});

// A larger, fresh capture of one specific source, used as the actual AI context image.
// Grabbed at up to 2560x1600, then downscaled to CAPTURE_MAX_EDGE on the long
// edge and JPEG-compressed so several screenshots fit comfortably in one
// Gemini request while code/error text stays legible.
handle('screen:capture', async (_evt, { sourceId } = {}) => {
  if (privacyModeEnabled) {
    throw new Error('Screen capture is disabled while Privacy Mode is active.');
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 2560, height: 1600 },
    fetchWindowIcons: false,
  });
  if (!sources.length) throw new Error('No screen/window sources available to capture.');

  const source = sourceId ? sources.find((s) => s.id === sourceId) : sources[0];
  if (!source) throw new Error('That screen/window is no longer available. Refresh the source list.');
  if (source.thumbnail.isEmpty()) throw new Error('Captured image was empty — try again.');

  const base64 = downscaleToJpeg(source.thumbnail, CAPTURE_MAX_EDGE, CAPTURE_JPEG_QUALITY).toString('base64');
  const dataUrl = `data:image/jpeg;base64,${base64}`;
  return { name: source.name, mimeType: 'image/jpeg', base64, dataUrl };
});

// Non-secret config for the diagnostics panel (model names only, never keys).
handle('config:status', async () => ({ groqModel: ai.groqModel(), geminiModel: ai.geminiModel() }));

// Lets a freshly (re)loaded renderer pick up Privacy Mode if it's already on.
handle('privacy:status', async () => ({ enabled: privacyModeEnabled }));

// Compact mode: shrink the overlay to a slim bar that only shows the latest
// answer. Keeps the window's position and width; remembers the full-size
// height so toggling back restores it exactly.
handle('window:set-compact', async (_evt, { enabled } = {}) => setCompact(!!enabled));

// ---- Hand gestures (opt-in) ----
// The renderer reports the user's toggle; the permission handlers above only
// let the webcam through while this is on. Returns the OS camera status so the
// UI can explain a Windows/macOS-level block instead of failing silently.
handle('gestures:set-enabled', async (_evt, { enabled } = {}) => {
  gesturesEnabled = enabled === true;
  if (gesturesEnabled && process.platform === 'darwin' && cameraAccessStatus() === 'not-determined') {
    try {
      await systemPreferences.askForMediaAccess('camera');
    } catch (err) { /* status below says what happened */ }
  }
  return gestureStatus();
});
handle('gestures:status', async () => gestureStatus());

// The ~8 MB model is read here and handed over as bytes: the renderer never
// passes a path, and nothing is fetched from the network at runtime.
handle('gestures:load-model', async () => {
  const size = fileSize(GESTURE_MODEL_PATH);
  if (size < GESTURE_MODEL_MIN_BYTES || size > GESTURE_MODEL_MAX_BYTES) {
    throw Object.assign(new Error('Gesture model missing - run npm install'), { code: 'GESTURE_MODEL_MISSING' });
  }
  return new Uint8Array(await fs.promises.readFile(GESTURE_MODEL_PATH));
});

// Clipboard fallback for Copy: navigator.clipboard refuses to write when the
// overlay doesn't have focus (e.g. a hand gesture while you're in another app).
handle('clipboard:write-text', async (_evt, { text } = {}) => {
  if (typeof text !== 'string') throw new Error('Invalid text.');
  if (text.length > MAX_TEXT_CHARS) throw new Error('text is too long.');
  clipboard.writeText(text);
  return true;
});

// Minimize = hide: with skipTaskbar a minimized window has no way back, so
// both buttons hide it (the tray icon / Ctrl+Shift+Space bring it back).
ipcMain.on('window:hide', () => overlayWindow?.hide());
ipcMain.on('window:minimize', () => overlayWindow?.hide());
