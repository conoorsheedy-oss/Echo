// Lets the main-process unit tests run without the Electron binary, so CI can
// install with ELECTRON_SKIP_BINARY_DOWNLOAD=1 and never depend on GitHub's
// release-download servers. Outside Electron, require('electron') only returns
// the binary's path (and throws if the binary wasn't downloaded), so tests
// never used the real APIs anyway. Require this file before any src/main module.
'use strict';

const Module = require('node:module');
const os = require('node:os');

const electronStub = {
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
};

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, ...rest);
};

module.exports = electronStub;
