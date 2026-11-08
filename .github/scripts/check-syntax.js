#!/usr/bin/env node
// CI helper: runs `node --check` on every .js file under src/, scripts/ and
// test/ (skipping the generated src/renderer/vendor/ folder) so a syntax error
// in a file the tests don't load still fails the build. Node built-ins only.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DIRS = ['src', 'scripts', 'test'];
const SKIP = new Set([path.join(ROOT, 'src', 'renderer', 'vendor')]);

function walk(dir, out) {
  if (SKIP.has(dir) || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(path.join(ROOT, d), []));
let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    console.error(`Syntax error in ${path.relative(ROOT, file)}:\n${err.stderr || err.message}`);
  }
}
console.log(`node --check: ${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
