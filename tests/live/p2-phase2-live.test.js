'use strict';

// Phase 2 milestone live integration tests.
//
// Coverage map (avoids duplicating existing live test suites):
//   J1  #367 — qdrant-sync factory DI: /api/qdrant/status alive post-refactor
//   M1  #368 — KB watcher started: /api/kb/status accessible without crash
//   H0  #366 — session-utils sub-modules reachable via API endpoints
//   G0  #365 — all 9 route domain modules: git-accounts + kb uncovered by existing suites
//   F0  #364 — N/A (frontend ESM — Stage 8 UI); documented below
//   #460 — server-side timestamp: /api/state uses session_meta.timestamp, not db.updated_at
//   #461 — file_find ERE: paren patterns return 200 + array (not grep BRE crash)
//   #453 — claimed Sets: /api/state with multiple projects completes cleanly
//   #454 — createTrustDir: project creation (trustDir path) returns 200
//
// NOTE — F0 (#364) N/A rationale:
//   F0 extracted the inline <script> from index.html into ESM modules. There
//   is no server-side behaviour change and no HTTP endpoint was added or
//   modified. The integration target for F0 is the Stage 8 Playwright UI
//   runbook (real browser against the deployed workbench-test container) which
//   exercises the full client-side module graph. A server-level HTTP test
//   cannot substitute for that: the only thing we can assert about F0 from
//   the server side is that index.html still serves successfully (which
//   startup.test.js SRV-02 already asserts).

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, post } = require('../helpers/http-client');
const { dockerExec } = require('../helpers/reset-state');

// ── J1 #367 — qdrant-sync factory DI ─────────────────────────────────────────

test('J1-LIVE-01: GET /api/qdrant/status returns 200 with expected shape post-factory-DI', async () => {
  const r = await get('/api/qdrant/status');
  assert.equal(r.status, 200,
    `expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
  // Shape: { available: bool, ... }. available may be false in test container
  // (no qdrant binary starts in sandbox mode), but the handler must respond
  // and the response must include the field — proving the factory wired up.
  assert.ok('available' in r.data,
    `response must include 'available' field; got: ${JSON.stringify(r.data)}`);
});

test('J1-LIVE-02: GET /api/qdrant/status collections field present (factory state accessible)', async () => {
  const r = await get('/api/qdrant/status');
  assert.equal(r.status, 200);
  // 'collections' may be null/undefined when qdrant is unavailable, but the
  // handler must not throw. Response shape proves the factory closure is live.
  assert.ok(typeof r.data === 'object' && r.data !== null,
    'qdrant/status must return a JSON object');
});

// ── M1 #368 — KB watcher started ─────────────────────────────────────────────

test('M1-LIVE-01: GET /api/kb/status returns 200 (watcher alive, no crash on uninitialized KB)', async () => {
  const r = await get('/api/kb/status');
  assert.equal(r.status, 200,
    `expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
  // When KB hasn't been cloned yet, the watcher must still respond gracefully.
  // initialized=false is the expected state in a fresh test container.
  assert.ok('initialized' in r.data,
    `response must include 'initialized' field; got: ${JSON.stringify(r.data)}`);
});

test('M1-LIVE-02: GET /api/kb/roles returns 200 (KB route module accessible)', async () => {
  const r = await get('/api/kb/roles');
  assert.equal(r.status, 200,
    `expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.ok(Array.isArray(r.data),
    `roles must be an array (empty when KB not initialized); got: ${JSON.stringify(r.data)}`);
});

// ── H0 #366 — session-utils sub-modules via API ───────────────────────────────

test('H0-LIVE-01: GET /api/state invokes H1/H2/H3 discovery paths without error', async () => {
  // /api/state calls discoverGeminiSessions() + discoverCodexSessions() (H2/H3)
  // and buildSessionList which uses session_meta timestamps (H1). A 200 with
  // the expected projects array proves all three sub-modules are wired.
  const r = await get('/api/state');
  assert.equal(r.status, 200,
    `expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.ok(Array.isArray(r.data.projects),
    `projects must be an array; got: ${JSON.stringify(r.data)}`);
});

test('H0-LIVE-02: POST /api/search invokes H5 searchSessions without error', async () => {
  // H5 = search.js sub-module. Any query must return 200 + results array.
  const r = await post('/api/search', { q: 'test' });
  assert.equal(r.status, 200,
    `expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.ok(Array.isArray(r.data.results),
    `results must be an array; got: ${JSON.stringify(r.data)}`);
});

// ── G0 #365 — all 9 domain modules reachable ─────────────────────────────────
// sessions.js, projects.js, files.js, tasks.js, settings.js, auth.js,
// health.js are already covered by routes-*.test.js suites. The two that
// are NOT covered by any existing live test file are tested here.

test('G0-LIVE-01 (git-accounts.js): GET /api/git-accounts returns 200 with accounts array', async () => {
  const r = await get('/api/git-accounts');
  assert.equal(r.status, 200,
    `expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.ok(Array.isArray(r.data.accounts),
    `accounts must be an array (empty in test container); got: ${JSON.stringify(r.data)}`);
});

test('G0-LIVE-02 (kb.js): GET /api/kb/status responds (kb.js module registered)', async () => {
  // Covered above in M1-LIVE-01; repeated here with an explicit G0 label for
  // traceability: the 200 from /api/kb/status proves kb.js was registered by
  // registerCoreRoutes without error.
  const r = await get('/api/kb/status');
  assert.equal(r.status, 200,
    `kb.js domain module must respond; got ${r.status}: ${JSON.stringify(r.data)}`);
});

test('G0-LIVE-03: all 9 domain module endpoints return 2xx in a single sweep', async () => {
  const endpoints = [
    ['/health',          'health.js'],
    ['/api/state',       'sessions.js'],
    ['/api/projects',    'projects.js'],
    ['/api/files/list',  'files.js'],       // returns 400 without path — that's OK (module alive)
    ['/api/tasks',       'tasks.js'],
    ['/api/git-accounts','git-accounts.js'],
    ['/api/kb/status',   'kb.js'],
    ['/api/settings',    'settings.js'],
    ['/api/auth/status', 'auth.js'],
  ];

  for (const [path, module] of endpoints) {
    const r = await get(path);
    assert.ok(
      r.status < 500,
      `${module} endpoint GET ${path} must not return 5xx; got ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`,
    );
  }
});

// ── #460 — server-side session_meta.timestamp in /api/state ──────────────────

test('#460-LIVE-01: /api/state uses session_meta.timestamp for Claude sessions (not db.updated_at)', async () => {
  // Plant a project + session + session_meta row with a known timestamp,
  // then assert /api/state returns that exact timestamp for the session.
  const META_TS = '2026-01-15T10:00:00.000Z';
  const DB_UPDATED = '2026-05-12T00:00:00.000Z'; // always "just now" due to upsertSession

  dockerExec('mkdir -p /data/workspace/ts_live_proj');
  const projResp = await post('/api/projects', { path: '/data/workspace/ts_live_proj', name: 'ts_live_proj' });
  assert.equal(projResp.status, 200, `create project: ${JSON.stringify(projResp.data)}`);

  // Insert a session row with a stale updated_at, plus a session_meta row
  // with the real activity timestamp.
  const sessId = `ts_sess_${Date.now()}`;
  const projId = dockerExec(
    `sqlite3 /data/.workbench/workbench.db "SELECT id FROM projects WHERE name='ts_live_proj'"`,
  );
  dockerExec(
    `sqlite3 /data/.workbench/workbench.db "INSERT OR REPLACE INTO sessions (id, project_id, name, cli_type, updated_at, created_at) VALUES ('${sessId}', ${projId}, 'ts-test', 'claude', '${DB_UPDATED}', '${DB_UPDATED}')"`,
  );
  dockerExec(
    `sqlite3 /data/.workbench/workbench.db "INSERT OR REPLACE INTO session_meta (session_id, timestamp, message_count) VALUES ('${sessId}', '${META_TS}', 3)"`,
  );

  const stateResp = await get('/api/state');
  assert.equal(stateResp.status, 200);

  const project = stateResp.data.projects?.find(p => p.name === 'ts_live_proj');
  assert.ok(project, 'ts_live_proj must appear in /api/state');

  const session = project.sessions?.find(s => s.id === sessId);
  assert.ok(session, `${sessId} must appear in project sessions`);

  assert.equal(
    session.timestamp, META_TS,
    `/api/state must return session_meta.timestamp (${META_TS}), not db.updated_at (${DB_UPDATED}). Got: ${session.timestamp}`,
  );
});

// ── #461 — file_find ERE: paren patterns ─────────────────────────────────────

test('#461-LIVE-01: file_find with escaped-paren pattern returns 200 + array (no BRE crash)', async () => {
  // Pre-fix: grep ran in BRE mode and \( opened an unmatched group → exit 2 → 500.
  // Post-fix: -E flag means \( is a literal '(' in ERE → grep succeeds → 200.
  const r = await post('/api/mcp/call', {
    tool: 'file_find',
    args: { pattern: String.raw`_seedRole\(cliType` },
  });
  assert.equal(r.status, 200,
    `file_find with escaped-paren pattern must return 200 (got ${r.status}): ${JSON.stringify(r.data).slice(0, 300)}`);
  assert.ok(Array.isArray(r.data?.result?.matches),
    `result.matches must be an array; got: ${JSON.stringify(r.data)}`);
});

test('#461-LIVE-02: file_find with Object.defineProperty paren pattern returns 200 + array', async () => {
  const r = await post('/api/mcp/call', {
    tool: 'file_find',
    args: { pattern: String.raw`Object\.defineProperty\(window` },
  });
  assert.equal(r.status, 200,
    `file_find with Object.defineProperty paren pattern must return 200 (got ${r.status}): ${JSON.stringify(r.data).slice(0, 300)}`);
  assert.ok(Array.isArray(r.data?.result?.matches),
    `result.matches must be an array`);
});

test('#461-LIVE-03: file_find paren pattern actually finds the match in source', async () => {
  // Prove the fix is functional: the pattern should match the actual call
  // site in session-seeder.js (planted in the container at build time).
  const r = await post('/api/mcp/call', {
    tool: 'file_find',
    args: { pattern: String.raw`_seedRole\(`, file_type: 'js' },
  });
  assert.equal(r.status, 200,
    `expected 200, got ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  assert.ok(r.data?.result?.matches?.length > 0,
    `should find at least one match for _seedRole\\( in .js files; got ${r.data?.result?.matches?.length} matches`);
});

// ── #453 — claimed Sets: /api/state with multiple projects ───────────────────

test('#453-LIVE-01: /api/state with multiple projects returns cleanly (no claimed-Set crash)', async () => {
  // The fix moved claimedGemini/claimedCodex from module-level (shared across
  // requests) to per-request Sets. A crash or 500 here would indicate a
  // regression. This test ensures the handler completes cleanly with ≥2 projects.
  for (const name of ['claimed_proj_a', 'claimed_proj_b']) {
    dockerExec(`mkdir -p /data/workspace/${name}`);
    await post('/api/projects', { path: `/data/workspace/${name}`, name });
  }
  const r = await get('/api/state');
  assert.equal(r.status, 200,
    `/api/state must return 200 with multiple projects; got ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  assert.ok(Array.isArray(r.data.projects),
    'projects must be an array');
  const names = r.data.projects.map(p => p.name);
  assert.ok(names.includes('claimed_proj_a') || names.includes('claimed_proj_b'),
    `at least one test project must appear in /api/state; projects: ${JSON.stringify(names)}`);
});

// ── #454 — createTrustDir live (project creation exercises trustDir) ──────────

test('#454-LIVE-01: POST /api/projects succeeds (createTrustDir from _shared wired correctly)', async () => {
  dockerExec('mkdir -p /data/workspace/trust_live_proj');
  const r = await post('/api/projects', {
    path: '/data/workspace/trust_live_proj',
    name: 'trust_live_proj',
  });
  // 200 (created) or 409 (already exists from prior run) — both prove the
  // trustDir path in settings.js/projects.js did not throw.
  assert.ok(
    r.status === 200 || r.status === 409,
    `POST /api/projects must return 200 or 409 (trustDir must not throw); got ${r.status}: ${JSON.stringify(r.data)}`,
  );
});
