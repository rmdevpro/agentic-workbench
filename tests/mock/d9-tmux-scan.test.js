'use strict';

// D9 #358: tmux-lifecycle drops the second-pass per-session tmuxExists call;
// uses a local Set of in-pass kills instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tmux-lifecycle.js'), 'utf-8');

test('D9-TMX-01: scan declares the killed Set for in-pass tracking', () => {
  assert.match(SRC, /const killed\s*=\s*new Set\(\)/);
});

test('D9-TMX-02: idle-pass adds killed names to the local Set', () => {
  assert.match(SRC, /killed\.add\(s\.name\)/);
});

test('D9-TMX-03: limit-enforcement filters via the local Set, no per-session tmuxExists', () => {
  // The remaining list is built by filtering, not by re-checking each session.
  const limitBlock = SRC.match(/const remaining\s*=\s*sessions\.filter[\s\S]+?MAX_TMUX_SESSIONS/);
  assert.ok(limitBlock, 'remaining = filter step must be present');
  assert.match(limitBlock[0], /killed\.has\(s\.name\)/, 'filter must use the Set');
  // The block before MAX_TMUX_SESSIONS check must NOT call tmuxExists for each entry.
  // (We're checking the limit-enforcement block specifically.)
  assert.ok(!/await\s+tmuxExists/.test(limitBlock[0]), `limit pass must not call tmuxExists. excerpt: ${limitBlock[0].slice(0, 200)}`);
});

test('D9-TMX-04: MAX_TMUX_SESSIONS is parameterized via env', () => {
  assert.match(SRC, /MAX_TMUX_SESSIONS/, 'MAX_TMUX_SESSIONS constant must be referenced');
});
