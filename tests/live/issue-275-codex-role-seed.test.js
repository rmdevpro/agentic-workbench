'use strict';

// #275: Codex role-seed Phase 1 used to hang >120s under the workbench HTTP
// path. Root cause: `child_process.execFile` silently ignores the `stdio`
// option, so codex inherited an open stdin pipe and blocked on
// "Reading additional input from stdin..." for the entire HTTP timeout
// window. Fix (commit `893baaf`): take the promisified return's `.child`
// handle and call `stdin.end()` to signal EOF.
//
// This test exercises the role-seed code path (only reached when `role` is
// provided on POST /api/sessions). The previously-cited test on #275
// (`tests/live/issue-437-session-list-parity.test.js`) creates a codex
// session WITHOUT role, bypassing `_seedRole` entirely (finding #579).
// This dedicated test seeds a role file via dockerExec and asserts the
// session creation completes within a bounded window — a hang regression
// would blow past the 60s ceiling and fail the bounded fetch.

const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE_URL } = require('../helpers/http-client');
const { post } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

async function ensureProj(name) {
  dockerExec(`mkdir -p /data/workspace/${name}`);
  await post('/api/projects', { path: `/data/workspace/${name}`, name });
  return name;
}

async function postWithTimeout(path, body, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const data = await r.json().catch(() => null);
    return { status: r.status, data };
  } finally {
    clearTimeout(t);
  }
}

test('#275: codex session with role seeds within 60s (regression of >120s hang)', async () => {
  await resetBaseline();
  const proj = await ensureProj('issue275_proj');

  // The role-seed path in routes/sessions.js only runs `_seedRole` when the
  // role file at `${KB_PATH}/roles/<role>.md` exists; if missing it falls
  // back to no-role spawn (which would mask the hang). Seed a minimal role
  // file via dockerExec to guarantee the try-branch runs.
  const rolePath = '/data/knowledge-base/roles/issue-275-test.md';
  dockerExec(`mkdir -p /data/knowledge-base/roles`);
  dockerExec(`sh -c "printf 'You are the issue-275 test role. Acknowledge briefly and stop.\\n' > ${rolePath}"`);

  const t0 = Date.now();
  let r;
  try {
    r = await postWithTimeout(
      '/api/sessions',
      {
        project: proj,
        name: '275-codex-role',
        prompt: '275-codex-role',
        cli_type: 'codex',
        role: 'issue-275-test',
      },
      60000,
    );
  } catch (e) {
    if (e.name === 'AbortError') {
      assert.fail(
        `session create did not return within 60s (aborted at ${Date.now() - t0}ms) — ` +
        `pre-#275 fix this would hang >120s on codex stdin read`,
      );
    }
    throw e;
  }
  const elapsed = Date.now() - t0;

  assert.equal(r.status, 200, `session create must return 200; got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.ok(r.data && r.data.id, `response must include session id; got ${JSON.stringify(r.data)}`);
  assert.ok(elapsed < 60000, `session create must complete within 60s; took ${elapsed}ms`);
});
