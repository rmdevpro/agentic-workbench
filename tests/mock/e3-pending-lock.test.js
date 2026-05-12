'use strict';

// #369 [E3]: optimistic-mutation lock is the in-flight PUT signal — NOT
// a fixed PENDING_LOCK_MS=7000 timeout. The pending entry is set before
// fetch and cleared on resolution (success or failure).
//
// E3-PEND-01/02: still verified against public/index.html (thin shell — must
// NOT re-introduce the timeout pattern).
// E3-PEND-03/04: F0 (#364) extracted the inline <script> to public/js/app.js
// and public/js/sidebar.js. The _pending* Maps and E3 lock comments now live
// in app.js. Tests updated to check the new canonical location.
// Behavioral test runs in the live Playwright suite (E3-LIVE-01).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML = path.join(__dirname, '..', '..', 'public', 'index.html');
const APP_JS = path.join(__dirname, '..', '..', 'public', 'js', 'app.js');

test('E3-PEND-01: PENDING_LOCK_MS constant is removed (no fixed timeout for the pending lock)', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf-8');
  assert.equal(
    /const\s+PENDING_LOCK_MS\s*=/.test(src),
    false,
    'public/index.html should not declare a PENDING_LOCK_MS constant — the in-flight PUT signal is the lock',
  );
});

test('E3-PEND-02: no setTimeout schedules the clearing of any _pending* Map entry', () => {
  // F0: the inline script is now in app.js; check both files.
  const sources = [INDEX_HTML, APP_JS].map(f => fs.readFileSync(f, 'utf-8')).join('\n');
  const stRe = /setTimeout\s*\(\s*\(\s*\)\s*=>\s*(?:\{([\s\S]*?)\}|([^,]+))\s*,/g;
  const offenders = [];
  let m;
  while ((m = stRe.exec(sources)) !== null) {
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

test('E3-PEND-03: each _pending* Map.set is paired with a Map.delete in app.js (F0 relocated)', () => {
  // F0 (#364): _pending* Maps moved from index.html inline script to app.js.
  const src = fs.readFileSync(APP_JS, 'utf-8');
  const setCount = (src.match(/_pending(Program|Project|Session)[A-Za-z]*\.set\s*\(/g) || []).length;
  const deleteCount = (src.match(/_pending(Program|Project|Session)[A-Za-z]*\.delete\s*\(/g) || []).length;
  assert.ok(setCount >= 3,
    `expected ≥3 _pendingX.set call-sites in app.js (one per mutation type); got ${setCount}`);
  assert.ok(
    deleteCount >= setCount,
    `expected at least one .delete per .set (success or rollback path). got set=${setCount} delete=${deleteCount}`,
  );
});

test('E3-PEND-04: E3 lock-semantics comment is present in app.js (F0 relocated)', () => {
  // F0 (#364): inline script with E3 comment moved to app.js.
  const src = fs.readFileSync(APP_JS, 'utf-8');
  assert.ok(
    /#287\/#369/.test(src) || /#369/.test(src),
    'app.js should carry an #369 reference documenting the in-flight PUT signal lock semantics',
  );
});
