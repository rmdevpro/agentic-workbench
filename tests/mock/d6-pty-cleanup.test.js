'use strict';

// D6 #355: PTY registry + process exit hook.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ws-terminal.js'), 'utf-8');

test('D6-PTY-01: ws-terminal.js maintains a PTY registry Map', () => {
  assert.match(SRC, /_ptyRegistry\s*=\s*new\s+Map\(\)/, 'must use a Map for the registry');
  assert.match(SRC, /_registerPty\(/, 'register helper must exist');
  assert.match(SRC, /_deregisterPty\(/, 'deregister helper must exist');
});

test('D6-PTY-02: process.on(exit) + SIGTERM + SIGINT hooks bound to cleanup', () => {
  assert.match(SRC, /process\.on\('exit',\s*_cleanupAllPtys\)/);
  // SIGTERM/SIGINT must call cleanup AND then exit (Codex gate finding):
  // adding any listener overrides Node's default signal-termination
  // behaviour, so a handler that doesn't exit hangs the container.
  assert.match(SRC, /process\.on\('SIGTERM',[\s\S]*?_cleanupAllPtys\(\)[\s\S]*?process\.exit\(143\)/);
  assert.match(SRC, /process\.on\('SIGINT',[\s\S]*?_cleanupAllPtys\(\)[\s\S]*?process\.exit\(130\)/);
});

test('D6-PTY-03: _cleanupAllPtys iterates registry and calls kill() on each', () => {
  // Body must iterate _ptyRegistry and invoke .kill() on each entry, with
  // try/catch so an already-dead PTY does not crash the loop.
  const body = SRC.match(/function _cleanupAllPtys\(\)[\s\S]+?\n  \}/);
  assert.ok(body, 'cleanup function must be present');
  assert.match(body[0], /for \(const.*_ptyRegistry/, 'iterates registry');
  assert.match(body[0], /\.kill\(\)/, 'calls kill on each pty');
  assert.match(body[0], /try\s*\{[\s\S]*?\}\s*catch/, 'kill is wrapped in try/catch');
});

test('D6-PTY-04: idempotent global guard prevents double-binding the listeners', () => {
  // global.__wbWsTerminalCleanupBound flag prevents binding the same handlers
  // multiple times when ws-terminal is wired more than once (e.g. test reuses).
  assert.match(SRC, /global\.__wbWsTerminalCleanupBound/);
});
