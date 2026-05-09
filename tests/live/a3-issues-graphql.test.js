'use strict';

// A3 #328: /api/issues uses GraphQL variables (not string concat) and
// derives the API host from the configured git_account.path so GHES repos
// route to https://<host>/api/graphql, not api.github.com.

const test = require('node:test');
const assert = require('node:assert/strict');
const { get } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');
const { query, queryJson } = require('../helpers/db-query');

function plantGitAccount({ host, username, token = 'dummy-token-not-used' }) {
  // git_accounts is a JSON-encoded value in settings. Read existing,
  // append, write back.
  const rows = queryJson(`SELECT value FROM settings WHERE key = 'git_accounts'`);
  const existing = rows.length ? JSON.parse(rows[0].value || '[]') : [];
  existing.push({ host, username, token, isKB: false, default: false, name: `${host}/${username}` });
  const json = JSON.stringify(existing).replace(/'/g, "''");
  query(`INSERT OR REPLACE INTO settings (key, value) VALUES ('git_accounts', '${json}')`);
}

function clearGitAccounts() {
  query(`DELETE FROM settings WHERE key = 'git_accounts'`);
}

test('A3-LIVE-01: GHES repo routes GraphQL request to enterprise host, not api.github.com', async () => {
  await resetBaseline();
  clearGitAccounts();
  plantGitAccount({ host: 'enterprise.example.com', username: 'test-owner' });

  // Call the endpoint with a 3-part repo (host/owner/name)
  const r = await get('/api/issues?repo=enterprise.example.com/test-owner/test-repo&state=open');

  // The server attempts to reach enterprise.example.com — that fails (no
  // such host on the test runner's network). The route returns 502 with the
  // error message reflecting the host attempted. We assert the host string.
  assert.equal(r.status, 502, `expected 502 (network failure to GHES host), got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.ok(
    /enterprise\.example\.com/.test(r.data.error || ''),
    `error message must reference enterprise.example.com (proves GHES host was used). got: ${r.data.error}`,
  );
  assert.ok(
    !/api\.github\.com/.test(r.data.error || ''),
    `error must NOT reference api.github.com (would prove route fell back to default github.com host). got: ${r.data.error}`,
  );
});

test('A3-LIVE-02: github.com repo (legacy 2-part form) still routes to api.github.com', async () => {
  await resetBaseline();
  clearGitAccounts();
  plantGitAccount({ host: 'github.com', username: 'test-owner' });

  const r = await get('/api/issues?repo=test-owner/test-repo&state=open');
  // Either 502 (token invalid) or 401 (auth_rejected) is fine — we just
  // need to verify the github.com path didn't raise a 400 ("repo must be
  // owner/name or host/owner/name") and didn't 500.
  assert.notEqual(r.status, 400, `got 400 for legacy form: ${JSON.stringify(r.data)}`);
  assert.notEqual(r.status, 500, `got 500 (unhandled): ${JSON.stringify(r.data)}`);
  // 401 (auth_rejected) is success-shape for "we hit api.github.com and got rejected"
  assert.ok([401, 502].includes(r.status), `expected 401 or 502, got ${r.status}: ${JSON.stringify(r.data)}`);
});

test('A3-LIVE-03: repo name containing a double-quote does not crash GraphQL build', async () => {
  await resetBaseline();
  clearGitAccounts();
  plantGitAccount({ host: 'github.com', username: 'test-owner' });

  // A `"` in the name would have produced a malformed GraphQL query under
  // the old string-concat code (`repository(owner: "test-owner", name: "fo"o")`).
  // With variables, the name string is passed as a JSON value and is
  // unaffected by content. Server should return a clean 401/502 not a 500.
  const r = await get(`/api/issues?repo=test-owner/${encodeURIComponent('fo"o')}&state=open`);
  assert.notEqual(r.status, 500, `quoted-name in repo must not crash server (would happen pre-A3). got: ${JSON.stringify(r.data)}`);
  assert.ok([401, 502].includes(r.status), `expected 401 or 502, got ${r.status}: ${JSON.stringify(r.data)}`);
});

test('A3-LIVE-04: invalid 1-part repo returns 400 (not 500)', async () => {
  await resetBaseline();
  const r = await get('/api/issues?repo=just-a-name&state=open');
  assert.equal(r.status, 400);
  assert.ok(/owner\/name/.test(r.data.error), `400 error should describe expected format. got: ${r.data.error}`);
});
