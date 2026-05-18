'use strict';

// #587: the prior `setInterval(loadState, REFRESH_MS)` fired regardless of
// whether a WS-triggered loadState had just run, producing redundant /api/state
// fetches; `window._loadStateRef` was referenced by terminal.js WS-push
// handlers but never assigned, so server-pushed updates silently no-op'd.
// The fix wires a self-rescheduling `scheduleLoadState()` and assigns it to
// `window._loadStateRef` so WS pushes reset the baseline timer.
// These pins keep the contract from regressing to the broken pattern.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = path.join(__dirname, '..', '..', 'public', 'js', 'app.js');
const TERMINAL_JS = path.join(__dirname, '..', '..', 'public', 'js', 'terminal.js');
const APP = fs.readFileSync(APP_JS, 'utf-8');
const TERMINAL = fs.readFileSync(TERMINAL_JS, 'utf-8');

test('I587-01: app.js does NOT use bare setInterval(loadState, …) — self-rescheduling pattern only', () => {
  // Strip `//` line comments so we don't match the historical-context comment
  // that intentionally cites the removed pattern.
  const stripped = APP.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(
    !/setInterval\s*\(\s*loadState\s*,/.test(stripped),
    'app.js must not call setInterval(loadState, …) — the F-3 audit fix replaced that with scheduleLoadState self-reschedule'
  );
});

test('I587-02: app.js defines scheduleLoadState() and self-reschedules via setTimeout', () => {
  // The function must exist and end its body with a self-reschedule via setTimeout.
  const m = APP.match(/(?:async\s+)?function\s+scheduleLoadState\s*\([\s\S]*?\n\}/);
  assert.ok(m, 'app.js must define scheduleLoadState()');
  assert.ok(
    /setTimeout\s*\(\s*scheduleLoadState\s*,/.test(m[0]),
    'scheduleLoadState body must self-reschedule via setTimeout(scheduleLoadState, …)'
  );
});

test('I587-03: window._loadStateRef = scheduleLoadState is wired (WS pushes can reset the baseline)', () => {
  assert.ok(
    /window\._loadStateRef\s*=\s*scheduleLoadState/.test(APP),
    'app.js must assign window._loadStateRef = scheduleLoadState so terminal.js WS-push handlers route through it'
  );
});

test('I587-04: terminal.js WS-push handlers call window._loadStateRef (not a one-off setTimeout/loadState)', () => {
  assert.ok(
    /window\._loadStateRef\s*\(/.test(TERMINAL),
    'terminal.js must invoke window._loadStateRef() so WS pushes share the rescheduling timer with the baseline'
  );
});
