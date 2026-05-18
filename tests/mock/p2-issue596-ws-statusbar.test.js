'use strict';

// #596: pre-fix, terminal.js called _updateStatusBarRef inside ws.onopen
// (connect) and inside the token_update / settings_update WS handlers but
// not in ws.onclose or ws.onerror. Result: a disconnect left the bottom
// status bar showing 'connected' until the next loadState tick. The fix
// adds the call to both onclose and onerror so the indicator tracks WS
// state transitions symmetrically. These pins keep that symmetry from
// quietly regressing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TERMINAL = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'terminal.js'), 'utf-8');

function _handlerBody(eventName) {
  // Match `ws.onX = (…) => { … }` or `ws.onX = function (…) { … }`.
  const re = new RegExp(`ws\\.${eventName}\\s*=\\s*(?:function\\s*\\([^)]*\\)|\\([^)]*\\)\\s*=>)\\s*\\{[\\s\\S]*?\\n\\s*\\};?`);
  const m = TERMINAL.match(re);
  assert.ok(m, `terminal.js must assign ws.${eventName}`);
  return m[0];
}

test('I596-01: ws.onopen calls _updateStatusBarRef (baseline — was already wired)', () => {
  const body = _handlerBody('onopen');
  assert.ok(
    /_updateStatusBarRef\s*(?:&&|\?\.)/.test(body) || /_updateStatusBarRef\s*\(/.test(body),
    'ws.onopen must call _updateStatusBarRef — the symmetric anchor that #596 brings onclose/onerror up to'
  );
});

test('I596-02: ws.onclose calls _updateStatusBarRef (#596 fix)', () => {
  const body = _handlerBody('onclose');
  assert.ok(
    /_updateStatusBarRef\s*(?:&&|\?\.)/.test(body) || /_updateStatusBarRef\s*\(/.test(body),
    '#596: ws.onclose must call _updateStatusBarRef so the status bar reflects the disconnect immediately'
  );
});

test('I596-03: ws.onerror calls _updateStatusBarRef (#596 fix)', () => {
  const body = _handlerBody('onerror');
  assert.ok(
    /_updateStatusBarRef\s*(?:&&|\?\.)/.test(body) || /_updateStatusBarRef\s*\(/.test(body),
    '#596: ws.onerror must call _updateStatusBarRef so a transport error doesn\'t leave the bar stuck on \'connected\''
  );
});
