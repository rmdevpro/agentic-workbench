'use strict';

// #341 [A16]: escape helpers consolidated into public/js/util.js. Verify
// the canonical implementations correctly escape every special character
// for both body text and attribute contexts.

const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, escapeAttr, fetchWithRetry, computeReorderedTabOrder } = require('../../public/js/util.js');

test('UTL-01: escapeHtml escapes <, &, >, "', () => {
  assert.equal(escapeHtml('<&>"'), '&lt;&amp;&gt;&quot;');
});

test('UTL-02: escapeHtml escapes single quote as &#39;', () => {
  assert.equal(escapeHtml("It's"), 'It&#39;s');
});

test('UTL-03: escapeHtml handles null/undefined to empty string', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('UTL-04: escapeHtml leaves safe strings untouched', () => {
  assert.equal(escapeHtml('Hello World 123'), 'Hello World 123');
});

test('UTL-05: escapeAttr escapes the quote character used in HTML attrs', () => {
  // The point of escapeAttr is to make a string safe inside `"..."`.
  const dangerous = 'foo" onclick="alert(1)';
  const safe = escapeAttr(dangerous);
  assert.ok(!safe.includes('"'), 'escaped output must not contain a literal "');
  assert.match(safe, /&quot;/);
});

test('UTL-06: escapeAttr escapes < and > (defense-in-depth)', () => {
  // Some browsers / parsers tolerate < inside attributes; escape anyway.
  assert.equal(escapeAttr('<>'), '&lt;&gt;');
});

test('UTL-07: escapeHtml of a complete XSS payload is inert', () => {
  const xss = '<script>alert("x")</script>';
  const safe = escapeHtml(xss);
  assert.ok(!safe.includes('<script>'));
  assert.ok(!safe.includes('</script>'));
  assert.match(safe, /&lt;script&gt;/);
});

// #564: fetchWithRetry — short-window retry helper for transient network
// flake. Below, the global `fetch` is monkey-patched per test to simulate
// success / sequential failures / total-failure scenarios. The helper is
// the only retry layer in loadState's /api/state call after #564.

function _withFetchStub(stub, fn) {
  const orig = global.fetch;
  global.fetch = stub;
  return Promise.resolve(fn()).finally(() => { global.fetch = orig; });
}

test('UTL-08: fetchWithRetry returns the first successful response without retrying', async () => {
  let calls = 0;
  const stub = async () => { calls++; return { ok: true, status: 200, body: 'ok' }; };
  await _withFetchStub(stub, async () => {
    const r = await fetchWithRetry('/api/state', {}, { attempts: 3, backoffMs: 1 });
    assert.equal(r.status, 200);
    assert.equal(calls, 1, `must not retry on success; got ${calls} fetch calls`);
  });
});

test('UTL-09: fetchWithRetry retries on TypeError and succeeds before exhaustion', async () => {
  let calls = 0;
  const stub = async () => {
    calls++;
    if (calls < 3) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200 };
  };
  await _withFetchStub(stub, async () => {
    const r = await fetchWithRetry('/api/state', {}, { attempts: 3, backoffMs: 1 });
    assert.equal(r.status, 200);
    assert.equal(calls, 3, `must retry until success; got ${calls} fetch calls`);
  });
});

test('UTL-10: fetchWithRetry throws after exhausting all attempts', async () => {
  let calls = 0;
  const stub = async () => { calls++; throw new TypeError('Failed to fetch'); };
  await _withFetchStub(stub, async () => {
    await assert.rejects(
      fetchWithRetry('/api/state', {}, { attempts: 3, backoffMs: 1 }),
      /Failed to fetch/,
    );
    assert.equal(calls, 3, `must attempt N times before giving up; got ${calls} fetch calls`);
  });
});

test('UTL-11: fetchWithRetry does NOT retry on HTTP 5xx (response returned, not thrown)', async () => {
  let calls = 0;
  const stub = async () => { calls++; return { ok: false, status: 503 }; };
  await _withFetchStub(stub, async () => {
    const r = await fetchWithRetry('/api/state', {}, { attempts: 3, backoffMs: 1 });
    assert.equal(r.status, 503);
    assert.equal(calls, 1, `5xx responses must not trigger retry; got ${calls} fetch calls`);
  });
});

// #522: computeReorderedTabOrder is the pure helper behind the tab-bar drop
// handler. Tab-type agnostic: applies identically to CLI session tabs and
// file/doc tabs. The previous inline drop handler silently no-op'd when the
// drop landed on bar background (no target tab); the helper now appends to
// end in that case, which matches user intent ("move this tab to the end").
//
// Test inputs use both CLI-shaped ids (`27fd8149-...`) and file-shaped ids
// (`file-1234567890`) to pin that both types follow the same code path —
// the doc-tab framing of #522 implies they shouldn't, but inspection of the
// helper confirms they do. If a runtime divergence is reported again, it
// is in event handling, not in this array surgery.

test('UTL-13: computeReorderedTabOrder — drop before target reorders correctly (CLI tabs)', () => {
  const cur = ['a-uuid-1', 'b-uuid-2', 'c-uuid-3'];
  const result = computeReorderedTabOrder(cur, 'c-uuid-3', 'a-uuid-1', true);
  assert.deepEqual(result, ['c-uuid-3', 'a-uuid-1', 'b-uuid-2'], `drop-before should insert before target; got ${JSON.stringify(result)}`);
});

test('UTL-14: computeReorderedTabOrder — drop after target reorders correctly (file tabs)', () => {
  const cur = ['file-1', 'file-2', 'file-3'];
  const result = computeReorderedTabOrder(cur, 'file-1', 'file-3', false);
  assert.deepEqual(result, ['file-2', 'file-3', 'file-1'], `drop-after should insert after target; got ${JSON.stringify(result)}`);
});

test('UTL-15: computeReorderedTabOrder — drop on empty bar (no targetTabId) appends to end', () => {
  // Previously this case silently did nothing — the dragged tab stayed put.
  // The fix appends to end of the panel's order, matching user intent.
  const cur = ['a', 'b', 'c'];
  const result = computeReorderedTabOrder(cur, 'b', null, true);
  assert.deepEqual(result, ['a', 'c', 'b'], `no-target drop should append; got ${JSON.stringify(result)}`);
});

test('UTL-16: computeReorderedTabOrder — drop on self is a no-op (returns equivalent order)', () => {
  const cur = ['a', 'b', 'c'];
  const result = computeReorderedTabOrder(cur, 'b', 'b', true);
  assert.deepEqual(result, ['a', 'c', 'b'], `self-target falls through to append-to-end; got ${JSON.stringify(result)}`);
});

test('UTL-17: computeReorderedTabOrder — dragged id not in current order is inserted relative to target', () => {
  // Useful when a tab is freshly created and the order array hasn't caught
  // up yet (e.g., persisted localStorage from a previous session). The fresh
  // tab is dropped relative to the target, not appended.
  const result = computeReorderedTabOrder(['a', 'b'], 'new-tab', 'a', false);
  assert.deepEqual(result, ['a', 'new-tab', 'b'], `dropped-after-a should land at index 1; got ${JSON.stringify(result)}`);
});

test('UTL-18: computeReorderedTabOrder — handles null/empty currentOrder', () => {
  assert.deepEqual(computeReorderedTabOrder(null, 'a', null, true), ['a']);
  assert.deepEqual(computeReorderedTabOrder([], 'a', 'b', true), ['a']);
});

test('UTL-12: fetchWithRetry honors custom attempts/backoff settings', async () => {
  let calls = 0;
  const stub = async () => { calls++; throw new TypeError('boom'); };
  const t0 = Date.now();
  await _withFetchStub(stub, async () => {
    await assert.rejects(
      fetchWithRetry('/api/state', {}, { attempts: 4, backoffMs: 20 }),
      /boom/,
    );
  });
  const elapsed = Date.now() - t0;
  assert.equal(calls, 4, `attempts:4 must trigger exactly 4 fetch calls; got ${calls}`);
  // 3 inter-attempt gaps × 20ms = 60ms minimum; allow generous ceiling.
  assert.ok(elapsed >= 60, `must wait between attempts (≥60ms for 3 gaps × 20ms); took ${elapsed}ms`);
});
