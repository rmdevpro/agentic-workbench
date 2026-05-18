'use strict';

// #597: persisted `tabOrders` localStorage existed (written by
// _persistTabOrders) but app.js init never read it back, so a page reload
// dropped every open CLI session tab. The fix adds restoreOpenTabsFromOrder()
// to iterate persisted ids and call openSession for each, after the first
// loadState() resolves. These pins keep the restore call from being silently
// removed in a future refactor.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'app.js'), 'utf-8');

test('I597-01: app.js defines restoreOpenTabsFromOrder()', () => {
  assert.ok(
    /function\s+restoreOpenTabsFromOrder\s*\(/.test(APP),
    'app.js must define restoreOpenTabsFromOrder() — the entry point for the reload-restores-tabs fix'
  );
});

test('I597-02: restoreOpenTabsFromOrder reads persisted tabOrders and reopens sessions', () => {
  const m = APP.match(/function\s+restoreOpenTabsFromOrder\s*\([\s\S]*?\n\}/);
  assert.ok(m, 'restoreOpenTabsFromOrder must exist');
  const body = m[0];
  assert.ok(
    /tabOrders/.test(body),
    'restoreOpenTabsFromOrder must reference tabOrders (the localStorage-backed state)'
  );
  // Must reopen sessions somehow — either via openSession, createTab, or
  // a similar entry. Look for one of the known entry points.
  assert.ok(
    /openSession\s*\(|createTab\s*\(/.test(body),
    'restoreOpenTabsFromOrder must call openSession/createTab to actually reopen the persisted tabs'
  );
});

test('I597-03: init invokes restoreOpenTabsFromOrder AFTER the first loadState', () => {
  // The init flow wraps loadState + restore in an async IIFE; the awaited
  // loadState must precede the restore call.
  const restoreIdx = APP.indexOf('restoreOpenTabsFromOrder()');
  assert.notEqual(restoreIdx, -1, 'init must invoke restoreOpenTabsFromOrder()');
  // Find the loadState() invocation that precedes the call.
  const head = APP.slice(0, restoreIdx);
  const loadStateBeforeRestore = /(?:await\s+)?loadState\s*\(\s*\)/.test(head);
  assert.ok(
    loadStateBeforeRestore,
    'restoreOpenTabsFromOrder() must be called after loadState() so projectState is populated when the restore runs'
  );
});
