// The only bridge between the overlay page and the main process. Exposed as
// window.assistant (renderer.js wraps it as `api`). Every invoke() channel has
// a validating handler in main.js; nothing here can read an API key.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('assistant', {
  getDesktopAudioSourceId: () => ipcRenderer.invoke('desktop:get-audio-source'),
  transcribeChunk: (payload) => ipcRenderer.invoke('stt:transcribe', payload),
  // Deepgram live streams (Settings > Speech-to-text > Deepgram); the socket
  // and key live in main (src/main/deepgram.js). speaker: 'You' | 'Them'.
  startSttStream: (speaker) => ipcRenderer.invoke('stt:stream-start', { speaker }),
  stopSttStream: (speaker) => ipcRenderer.invoke('stt:stream-stop', { speaker }),
  // pcm: Uint8Array of 16 kHz mono Int16 samples (~100 ms). Fire-and-forget.
  sendSttAudio: (speaker, pcm) => ipcRenderer.send('stt:stream-audio', speaker, pcm),
  onSttEvent: (cb) => ipcRenderer.on('stt:stream-event', (_e, payload) => cb(payload)),
  // payload.images: optional array (max 4) of { mimeType, base64, name } screenshots.
  // payload.requestId (optional, [A-Za-z0-9_-]{1,64}): text streams back as
  // onAiChunk({ requestId, text }) events; the promise resolves with the full
  // answer when done (or rejects on error / when superseded).
  generateSuggestion: (payload) => ipcRenderer.invoke('ai:suggest', payload),
  askFollowUp: (payload) => ipcRenderer.invoke('ai:ask', payload),
  onAiChunk: (cb) => ipcRenderer.on('ai:chunk', (_e, payload) => cb(payload)),
  summarizeSession: (transcript) => ipcRenderer.invoke('ai:summarize', { transcript }),
  exportSummary: (content) => ipcRenderer.invoke('summary:export', { content }),
  getConfigStatus: () => ipcRenderer.invoke('config:status'),
  getPrivacyStatus: () => ipcRenderer.invoke('privacy:status'),

  listScreenSources: () => ipcRenderer.invoke('screen:list-sources'),
  captureScreen: (sourceId) => ipcRenderer.invoke('screen:capture', { sourceId }),

  getKnowledgeStatus: () => ipcRenderer.invoke('knowledge:status'),
  reloadKnowledge: () => ipcRenderer.invoke('knowledge:reload'),
  openKnowledgeFolder: () => ipcRenderer.invoke('knowledge:open-folder'),
  addKnowledgeFiles: () => ipcRenderer.invoke('knowledge:add-files'),

  // Your own API keys (see src/main/keyStore.js). Write-only from here:
  // status returns booleans + source ('saved' | 'env' | null), never a key.
  getKeyStatus: () => ipcRenderer.invoke('keys:status'),
  saveKeys: (keys) => ipcRenderer.invoke('keys:save', keys),
  removeKeys: () => ipcRenderer.invoke('keys:remove'),
  testKeys: () => ipcRenderer.invoke('keys:test'),
  // page: 'groq' | 'gemini' | 'deepgram' -- main maps it to an allowlisted URL.
  openKeyPage: (page) => ipcRenderer.invoke('external:open', { page }),

  // Screen-share/recording visibility -- off by default, explicit opt-in (see main.js)
  getContentProtectionStatus: () => ipcRenderer.invoke('content-protection:status'),
  toggleContentProtection: () => ipcRenderer.invoke('content-protection:toggle'),
  onContentProtectionChanged: (cb) => ipcRenderer.on('hotkey:content-protection-changed', (_e, val) => cb(val)),

  // Hand gestures -- opt-in, off by default (see src/renderer/gestures.js).
  // main.js only lets the webcam through while this is switched on.
  setGesturesEnabled: (enabled) => ipcRenderer.invoke('gestures:set-enabled', { enabled: enabled === true }),
  getGestureStatus: () => ipcRenderer.invoke('gestures:status'),
  // The bundled model's bytes (no path or URL ever comes from the page).
  loadGestureModel: () => ipcRenderer.invoke('gestures:load-model'),
  onWindowVisibilityChanged: (cb) => ipcRenderer.on('window:visibility-changed', (_e, visible) => cb(visible)),
  // Clipboard fallback when the overlay isn't focused (navigator.clipboard refuses then).
  copyText: (text) => ipcRenderer.invoke('clipboard:write-text', { text }),

  hideWindow: () => ipcRenderer.send('window:hide'),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  setCompact: (enabled) => ipcRenderer.invoke('window:set-compact', { enabled }),
  onCompactChanged: (cb) => ipcRenderer.on('window:compact-changed', (_e, val) => cb(val)),

  onGenerateHotkey: (cb) => ipcRenderer.on('hotkey:generate', cb),
  onClearHotkey: (cb) => ipcRenderer.on('hotkey:clear', cb),
  onClickThroughChanged: (cb) => ipcRenderer.on('hotkey:click-through-changed', (_e, val) => cb(val)),
  onCaptureScreenHotkey: (cb) => ipcRenderer.on('hotkey:capture-screen', cb),
  onSummarizeHotkey: (cb) => ipcRenderer.on('hotkey:summarize', cb),
  onToggleExpandHotkey: (cb) => ipcRenderer.on('hotkey:toggle-expand', cb),
  onPrivacyModeChanged: (cb) => ipcRenderer.on('hotkey:privacy-mode-changed', (_e, val) => cb(val)),
  onDiagnosticsHotkey: (cb) => ipcRenderer.on('hotkey:diagnostics', cb),
});
