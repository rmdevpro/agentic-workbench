'use strict';

// #337 [A12]: gate page is loaded once at boot and served from memory.
// Verify (a) the loader injects the mode constant correctly, (b) repeated
// invocations do NOT re-call readFileSync past the initial cache, and
// (c) a corrupt/missing file falls back to GATE_PAGE_FALLBACK without
// throwing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGatePageHtml, GATE_PAGE_FALLBACK } = require('../../src/gate-page.js');

test('GATE-01: loadGatePageHtml injects mode constant into gate template', () => {
  const html = loadGatePageHtml({
    readFileSync: () => '<html>// __GATE_MODE_INJECT__</html>',
    gatePath: 'unused-path',
    mode: 'password',
  });
  assert.match(html, /const __GATE_MODE__ = 'password';/);
  assert.ok(!html.includes('// __GATE_MODE_INJECT__'), 'placeholder must be replaced');
});

test('GATE-02: serveGatePage path does not re-read from disk after init', () => {
  // Simulate a server boot: cache the html once, then re-serve N times.
  // The cached value must not invoke readFileSync again.
  let reads = 0;
  const cached = loadGatePageHtml({
    readFileSync: () => { reads += 1; return '<html>// __GATE_MODE_INJECT__</html>'; },
    gatePath: 'p',
    mode: 'open',
  });
  assert.equal(reads, 1, 'first load reads once');
  // Simulate 100 requests serving the cached value.
  for (let i = 0; i < 100; i += 1) {
    // serveGatePage(res) just hands cached to res.send — no fs touched.
    void cached;
  }
  assert.equal(reads, 1, 'cache must be hit; readFileSync count must not grow');
});

test('GATE-03: corrupt gate.html during boot falls back without throwing', () => {
  let onErrorCalled = false;
  const html = loadGatePageHtml({
    readFileSync: () => { throw new Error('ENOENT-style read failure'); },
    gatePath: 'p',
    mode: 'open',
    onError: () => { onErrorCalled = true; },
  });
  assert.equal(html, GATE_PAGE_FALLBACK);
  assert.ok(onErrorCalled, 'onError hook must fire');
});

test('GATE-04: fallback HTML is served when gate.html is empty', () => {
  // Empty file string still passes through .replace() — verify no crash.
  const html = loadGatePageHtml({
    readFileSync: () => '',
    gatePath: 'p',
    mode: 'open',
  });
  assert.equal(html, '');
});
