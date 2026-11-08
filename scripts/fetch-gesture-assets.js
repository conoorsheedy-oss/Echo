#!/usr/bin/env node
// Copies the MediaPipe Tasks Vision runtime out of node_modules and downloads
// the hand-gesture model, so the (opt-in) hand-gesture feature can load
// everything from the app's own folder at runtime -- no CDN, no remote fetch.
//
// Runs automatically after `npm install` (the "postinstall" script) and can be
// re-run by hand:   npm run gestures:fetch        (add -- --force to redo)
// `npm run dist` runs it with --strict, which exits 1 if anything is missing,
// so an installer is never built without the hand-gesture files.
//
// Writes into src/renderer/vendor/mediapipe/ (git-ignored; regenerated here):
//   vision_bundle.mjs                         <- @mediapipe/tasks-vision
//   vision_wasm_internal.js / .wasm           <- @mediapipe/tasks-vision/wasm
//   vision_wasm_nosimd_internal.js / .wasm    <- (fallback for CPUs w/o SIMD)
//   gesture_recognizer.task                   <- downloaded once from Google
//
// Never fails `npm install`: if something is missing (e.g. you're offline) it
// prints what to do and exits 0. The app shows "Gesture model missing - run
// npm install" in Settings until the files are there. Uses only Node built-ins.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'src', 'renderer', 'vendor', 'mediapipe');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const MODEL_FILE = 'gesture_recognizer.task';
const MIN_MODEL_BYTES = 1_000_000; // the real file is ~8 MB
const MAX_MODEL_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

// [file inside the npm package, minimum sane size in bytes]
const RUNTIME_FILES = [
  ['vision_bundle.mjs', 50_000],
  ['wasm/vision_wasm_internal.js', 50_000],
  ['wasm/vision_wasm_internal.wasm', 1_000_000],
  ['wasm/vision_wasm_nosimd_internal.js', 50_000],
  ['wasm/vision_wasm_nosimd_internal.wasm', 1_000_000],
];

const force = process.argv.includes('--force');
const strict = process.argv.includes('--strict');
let problems = 0;

function log(msg) {
  console.log(`[gesture-assets] ${msg}`);
}
function warn(msg) {
  problems += 1;
  console.warn(`[gesture-assets] WARNING: ${msg}`);
}
function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

function findPackageDir() {
  const direct = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision');
  if (fs.existsSync(path.join(direct, 'vision_bundle.mjs'))) return direct;
  try {
    // "main" is vision_bundle.cjs at the package root.
    return path.dirname(require.resolve('@mediapipe/tasks-vision', { paths: [ROOT] }));
  } catch {
    return null;
  }
}

function copyRuntime() {
  const pkgDir = findPackageDir();
  if (!pkgDir) {
    warn('@mediapipe/tasks-vision is not installed -- run `npm install` in the project folder.');
    return;
  }
  let version = '?';
  try {
    version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
  } catch { /* informational only */ }

  for (const [rel, minBytes] of RUNTIME_FILES) {
    const src = path.join(pkgDir, rel);
    const dest = path.join(OUT_DIR, path.basename(rel));
    const srcSize = sizeOf(src);
    if (srcSize < minBytes) {
      warn(`${rel} is missing or too small in @mediapipe/tasks-vision@${version} (${srcSize} bytes).`);
      continue;
    }
    if (!force && sizeOf(dest) === srcSize) {
      log(`ok       ${path.basename(rel)} (${mb(srcSize)}, already present)`);
      continue;
    }
    fs.copyFileSync(src, dest);
    log(`copied   ${path.basename(rel)} (${mb(srcSize)}) from @mediapipe/tasks-vision@${version}`);
  }
}

function download(url, dest, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      reject(new Error(`refusing non-HTTPS URL ${url}`));
      return;
    }
    const req = https.get(parsed, { headers: { 'User-Agent': 'echo-open-postinstall' } }, (res) => {
      const { statusCode = 0, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('too many redirects'));
          return;
        }
        resolve(download(new URL(headers.location, parsed).href, dest, redirectsLeft - 1));
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${statusCode}`));
        return;
      }
      const tmp = `${dest}.part`;
      const out = fs.createWriteStream(tmp);
      const hash = crypto.createHash('sha256');
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        if (received > MAX_MODEL_BYTES) {
          req.destroy(new Error(`download larger than ${mb(MAX_MODEL_BYTES)}, aborting`));
        }
      });
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => resolve({ tmp, received, sha256: hash.digest('hex') }));
      });
      res.on('error', reject);
      out.on('error', reject);
    });
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

function looksLikeModel(file) {
  // .task files are zip bundles ("PK\x03\x04"); an HTML error page or a
  // truncated download is what we're guarding against here.
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    return head[0] === 0x50 && head[1] === 0x4b;
  } catch {
    return false;
  }
}

async function fetchModel() {
  const dest = path.join(OUT_DIR, MODEL_FILE);
  const existing = sizeOf(dest);
  if (!force && existing >= MIN_MODEL_BYTES && looksLikeModel(dest)) {
    log(`ok       ${MODEL_FILE} (${mb(existing)}, already present)`);
    return;
  }
  if (process.env.ECHO_SKIP_GESTURE_MODEL === '1') {
    warn(`ECHO_SKIP_GESTURE_MODEL=1 -- not downloading ${MODEL_FILE}. Hand gestures stay unavailable until you run \`npm run gestures:fetch\`.`);
    return;
  }
  log(`download ${MODEL_FILE} from ${MODEL_URL}`);
  let result;
  try {
    result = await download(MODEL_URL, dest);
  } catch (err) {
    try { fs.unlinkSync(`${dest}.part`); } catch { /* nothing to clean up */ }
    warn(
      `could not download ${MODEL_FILE} (${err.message}). Hand gestures stay unavailable until it's there.\n` +
      '  Fix: when you are online, run `npm run gestures:fetch` -- or download the file from\n' +
      `  ${MODEL_URL}\n` +
      `  and save it as ${path.relative(ROOT, dest)}`
    );
    return;
  }
  if (result.received < MIN_MODEL_BYTES || !looksLikeModel(result.tmp)) {
    try { fs.unlinkSync(result.tmp); } catch { /* ignore */ }
    warn(`downloaded ${MODEL_FILE} doesn't look right (${result.received} bytes) -- discarded. Try \`npm run gestures:fetch\` again.`);
    return;
  }
  fs.renameSync(result.tmp, dest);
  log(`saved    ${MODEL_FILE} (${mb(result.received)}, sha256 ${result.sha256})`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log(`target   ${path.relative(ROOT, OUT_DIR)}`);
  copyRuntime();
  await fetchModel();
  if (problems) {
    log(`finished with ${problems} warning(s). Everything else in Echo works normally; only the opt-in hand gestures need these files.`);
  } else {
    log('all hand-gesture assets are in place.');
  }
  if (problems && strict) {
    console.error('[gesture-assets] --strict: refusing to continue without every hand-gesture file (see warnings above).');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  // Never break `npm install` over an optional feature.
  console.warn(`[gesture-assets] WARNING: ${err && err.message ? err.message : err}`);
  process.exitCode = strict ? 1 : 0;
});
