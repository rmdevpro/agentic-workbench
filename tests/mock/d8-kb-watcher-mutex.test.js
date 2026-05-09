'use strict';

// D8 #357: kb-watcher split single `busy` into pushBusy + pullBusy so a
// periodic pull can run alongside an in-flight commit (and vice versa).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'kb-watcher.js'), 'utf-8');

test('D8-KB-01: kb-watcher declares separate pushBusy + pullBusy state', () => {
  assert.match(SRC, /let pushBusy\s*=\s*false/);
  assert.match(SRC, /let pullBusy\s*=\s*false/);
});

test('D8-KB-02: push path guards on pushBusy only (not pullBusy)', () => {
  // Find the push function body and verify it only checks pushBusy.
  const pushFn = SRC.match(/async function _commitAndPush[\s\S]+?\n  \}/);
  assert.ok(pushFn, '_commitAndPush function must be present');
  assert.match(pushFn[0], /if \(pushBusy\) return/);
  assert.ok(!/if \(pullBusy\)/.test(pushFn[0]), `_commitAndPush must not gate on pullBusy. excerpt: ${pushFn[0].slice(0, 200)}`);
});

test('D8-KB-03: pull path guards on pullBusy only (not pushBusy)', () => {
  const pullFn = SRC.match(/async function _periodicPull[\s\S]+?\n  \}/);
  assert.ok(pullFn, '_periodicPull function must be present');
  assert.match(pullFn[0], /if \(pullBusy\) return/);
  assert.ok(!/if \(pushBusy\)/.test(pullFn[0]), `_periodicPull must not gate on pushBusy. excerpt: ${pullFn[0].slice(0, 200)}`);
});

test('D8-KB-04: both paths set + clear their respective busy flags', () => {
  // Each path must set its flag true at start, false in finally.
  assert.match(SRC, /pushBusy\s*=\s*true/);
  assert.match(SRC, /pushBusy\s*=\s*false/);
  assert.match(SRC, /pullBusy\s*=\s*true/);
  assert.match(SRC, /pullBusy\s*=\s*false/);
});
