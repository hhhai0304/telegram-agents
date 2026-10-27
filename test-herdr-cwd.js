#!/usr/bin/env node
'use strict';
/* Unit tests for choosing a herdr pane's own cwd (herdr.js paneCwd).
 * No network, no CLIs needed. Run: node test-herdr-cwd.js */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { paneCwd } = require('./herdr.js');

let n = 0;
function test(name, fn) { n++; try { fn(); console.log(`ok ${n} - ${name}`); } catch (e) { console.log(`not ok ${n} - ${name}\n  ${e.message}`); process.exitCode = 1; } }

const home = os.homedir();
const tmpRoot = fs.realpathSync(os.tmpdir());
const made = [];
function dir(base, prefix) { const d = fs.mkdtempSync(path.join(base, prefix)); made.push(d); return d; }

// A job's temp workdir disappears; a pane saved on it would come back as
// restore_error, so the pane starts from home instead.
test('a temp workdir never becomes the pane cwd', () => {
  assert.strictEqual(paneCwd(dir(tmpRoot, 'tga-forum-')), home);
  assert.strictEqual(paneCwd(tmpRoot), home);
});
test('a durable directory is kept as it is', () => {
  assert.strictEqual(paneCwd(home), home);
  assert.strictEqual(paneCwd(path.join(home, 'dev')), fs.realpathSync(path.join(home, 'dev')));
});
test('a path outside the temp root is not mistaken for one inside it', () => {
  // A sibling that shares the temp root's name prefix is a different directory.
  const base = dir(home, '.tga-cwd-');
  const fakeTmp = dir(base, 'tmp');
  const sibling = dir(base, 'tmp-sibling-');
  const saved = os.tmpdir;
  os.tmpdir = () => fakeTmp;
  try {
    assert.strictEqual(paneCwd(fakeTmp), home); // inside the temp root
    assert.strictEqual(paneCwd(sibling), fs.realpathSync(sibling)); // prefix only, not inside
  } finally {
    os.tmpdir = saved;
  }
});
test('a relative cwd resolves before it is judged', () => {
  assert.strictEqual(paneCwd('.'), fs.realpathSync(process.cwd()));
});
test('a missing or empty cwd falls back to home', () => {
  assert.strictEqual(paneCwd(''), home);
  assert.strictEqual(paneCwd(undefined), home);
  assert.strictEqual(paneCwd(null), home);
  assert.strictEqual(paneCwd(path.join(tmpRoot, 'tga-gone-does-not-exist')), home);
});

for (const d of made) fs.rmSync(d, { recursive: true, force: true });
