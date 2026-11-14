// Lets the main-process unit tests run without the Electron binary, so CI
// never depends on GitHub's release-download servers. Outside Electron,
// require('electron') only returns the binary's path -- and since Electron 42
// it first downloads the binary if it's missing -- so tests never used the
// real APIs anyway. Require this file before any src/main module.
'use strict';

const Module = require('node:module');
const os = require('node:os');

const electronStub = {
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isAsyncEncryptionAvailable: async () => false },
};

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, ...rest);
};

module.exports = electronStub;
