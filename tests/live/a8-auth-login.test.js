'use strict';

// A8 #333: /api/auth/login uses checkAuthStatus() (file mtime + parse) instead
// of `claude --print`. No tokens burned, response in <100ms.

const test = require('node:test');
const assert = require('node:assert/strict');
const { post } = require('../helpers/http-client');
const { dockerExec } = require('../helpers/reset-state');

test('A8-LIVE-01: POST /api/auth/login responds in <100ms (no CLI fork)', async () => {
  // Run twice — first call may have cold caches. Take the second.
  await post('/api/auth/login');
  const t0 = Date.now();
  const r = await post('/api/auth/login');
  const elapsed = Date.now() - t0;
  // 200 (valid creds) or 401 (no/stale creds) — either way, the operation
  // must complete fast because it is just a file stat + JSON parse, not a
  // claude --print fork. Pre-fix, this called claudeExecAsync which spawned
  // a Claude CLI subprocess (~1-2s + a billable inference token).
  assert.ok([200, 401].includes(r.status), `expected 200 or 401, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.ok(elapsed < 100, `login must complete in <100ms (file-stat fast path), took ${elapsed}ms`);
});

test('A8-LIVE-02: POST /api/auth/login with no credentials file returns 401', async () => {
  // Snapshot existing creds (if any), wipe, call, restore.
  let savedCreds = '';
  try {
    savedCreds = dockerExec('cat /data/.claude/.credentials.json 2>/dev/null || echo NO_CREDS');
  } catch { /* ignore */ }
  try {
    dockerExec('rm -f /data/.claude/.credentials.json');
    const r = await post('/api/auth/login');
    assert.equal(r.status, 401, `expected 401 with no creds, got ${r.status}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.valid, false);
  } finally {
    if (savedCreds && savedCreds !== 'NO_CREDS') {
      // Restore — write via heredoc-style command. Escape carefully.
      const b64 = Buffer.from(savedCreds).toString('base64');
      dockerExec(`echo ${b64} | base64 -d > /data/.claude/.credentials.json`);
    }
  }
});

test('A8-LIVE-03: POST /api/auth/login with stale creds returns 401 (not throwing CLI error)', async () => {
  // Plant a malformed/stale credentials file. Endpoint must return 401
  // cleanly — not 500 from CLI invocation.
  let saved = '';
  try {
    saved = dockerExec('cat /data/.claude/.credentials.json 2>/dev/null || echo NO_CREDS');
  } catch { /* ignore */ }
  try {
    dockerExec('echo "malformed-not-valid-json" > /data/.claude/.credentials.json');
    const r = await post('/api/auth/login');
    assert.equal(r.status, 401, `expected 401 with malformed creds, got ${r.status}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.valid, false);
  } finally {
    if (saved && saved !== 'NO_CREDS') {
      const b64 = Buffer.from(saved).toString('base64');
      dockerExec(`echo ${b64} | base64 -d > /data/.claude/.credentials.json`);
    } else {
      dockerExec('rm -f /data/.claude/.credentials.json');
    }
  }
});
