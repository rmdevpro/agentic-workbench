'use strict';

// #275: Codex role-seed Phase 1 hung >120s because `child_process.execFile`
// silently ignores `opts.stdio` (only `spawn` honors it), leaving the codex
// child blocked on a never-closed stdin pipe. The fix wraps the promisified
// execFile in a `seedExec` helper that grabs `.child.stdin` and calls
// `.end()` to signal EOF. These pins keep the seedExec contract from being
// quietly dropped or regressed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SEEDER = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'session-seeder.js'), 'utf-8');

test('I275-01: session-seeder defines a seedExec helper', () => {
  assert.ok(
    /\bseedExec\b\s*=\s*(?:\([^)]*\)|function)/.test(SEEDER),
    'src/session-seeder.js must define seedExec — the wrapper that fixes the execFile stdin-leak'
  );
});

test('I275-02: seedExec closes stdin via the promisified return\'s .child.stdin.end()', () => {
  // Find the seedExec body (one-line or multi-line).
  const m = SEEDER.match(/seedExec\s*=\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\s*\}/);
  assert.ok(m, 'seedExec must be defined as an arrow function block in src/session-seeder.js');
  const body = m[0];
  assert.ok(
    /\.child\b/.test(body) && /\.stdin\b/.test(body) && /\.end\s*\(\s*\)/.test(body),
    'seedExec body must call .child.stdin.end() on the promisified execFile return — without it the codex child hangs >120s on the open stdin pipe'
  );
});

test('I275-03: all 3 CLI seed paths route through seedExec (symmetric defense)', () => {
  // The bug class affects any execFile caller; the fix applies symmetrically
  // to Claude, Gemini, and Codex seed paths.
  for (const cli of ['claude', 'gemini', 'codex']) {
    const re = new RegExp(`seedExec\\s*\\(\\s*['"]${cli}['"]`);
    assert.ok(
      re.test(SEEDER),
      `session-seeder must invoke seedExec('${cli}', …) — the fix applies symmetrically to all 3 CLI seed paths`
    );
  }
});
