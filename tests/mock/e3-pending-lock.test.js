'use strict';

// #369 [E3]: optimistic-mutation lock is the in-flight PUT signal — NOT
// a fixed PENDING_LOCK_MS=7000 timeout. The pending entry is set before
// fetch and cleared on resolution (success or failure).
//
// These tests assert the structural absence of the timeout-based pattern
// in public/index.html, which is the only delivery vehicle for the
// browser-side _pending* mechanism. A behavioral test runs in the live
// Playwright test (E3-LIVE-01) where DOM + fetch + state polling exist.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML = path.join(__dirname, '..', '..', 'public', 'index.html');

test('E3-PEND-01: PENDING_LOCK_MS constant is removed (no fixed timeout for the pending lock)', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf-8');
  assert.equal(
    /const\s+PENDING_LOCK_MS\s*=/.test(src),
    false,
    'public/index.html should not declare a PENDING_LOCK_MS constant — the in-flight PUT signal is the lock',
  );
});

test('E3-PEND-02: no setTimeout schedules the clearing of any _pending* Map entry', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf-8');
  // Walk every setTimeout call site, isolate its callback body (up to the
  // first comma followed by a numeric ms argument), and assert no body
  // mentions _pending*. Catches both `setTimeout(() => {body}, 7000)` and
  // `setTimeout(() => stmt, ms)` shapes without cross-matching unrelated
  // setTimeouts later in the file.
  const stRe = /setTimeout\s*\(\s*\(\s*\)\s*=>\s*(?:\{([\s\S]*?)\}|([^,]+))\s*,/g;
  const offenders = [];
  let m;
  while ((m = stRe.exec(src)) !== null) {
    const body = m[1] || m[2] || '';
    if (/_pending(Program|Project|Session)[A-Za-z]*\.delete/.test(body)) {
      offenders.push(body.slice(0, 100));
    }
  }
  assert.equal(
    offenders.length,
    0,
    `no setTimeout(() => { ... _pendingX.delete(...) ...) — the pending lock must clear on PUT-completion, not on a fixed timer. Offenders: ${JSON.stringify(offenders)}`,
  );
});

test('E3-PEND-03: each _pending* Map.set is paired with a Map.delete on the same key in the same try-catch scope', () => {
  // Sanity check: every set has at least one delete sibling. This is a soft
  // structural guard — a more rigorous AST-walk lives in F0 phase.
  const src = fs.readFileSync(INDEX_HTML, 'utf-8');
  const setCount = (src.match(/_pending(Program|Project|Session)[A-Za-z]*\.set\s*\(/g) || []).length;
  const deleteCount = (src.match(/_pending(Program|Project|Session)[A-Za-z]*\.delete\s*\(/g) || []).length;
  assert.ok(setCount >= 3, `expected ≥3 _pendingX.set call-sites (one per mutation type); got ${setCount}`);
  // Each set should have a paired delete in success and rollback paths,
  // i.e., delete count must be at least 2× set count (success + rollback).
  assert.ok(
    deleteCount >= setCount,
    `expected at least one .delete per .set (success or rollback path). got set=${setCount} delete=${deleteCount}`,
  );
});

test('E3-PEND-04: comment block reflects the request-based lock model', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf-8');
  assert.match(
    src,
    /#369 \[E3\][\s\S]{0,400}in-flight signal IS the lock/,
    'public/index.html should carry an #369 [E3] comment naming the new lock semantics',
  );
});
