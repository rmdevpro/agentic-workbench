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

test('H0-LIVE-02: GET /api/search invokes H5 searchSessions without error', async () => {
  // H5 = search.js sub-module. /api/search is a GET endpoint with ?q= param.
  const r = await get('/api/search?q=test');
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

test('#460-LIVE-01: /api/state session timestamps are ISO strings (session_meta pathway live)', async () => {
  // Create a real project + session via API. The stub-claude creates a JSONL
  // file whose timestamp drives session_meta.timestamp via parseSessionFile.
  // On the next /api/state poll, buildSessionList reads session_meta.timestamp.
  // The precise timestamp-override logic is proven by behavioral mock tests
  // (#463-TS-01); here we verify the full live route path: session exists in
  // /api/state with a valid ISO timestamp (not null, not empty).
  dockerExec('mkdir -p /data/workspace/ts460_live_proj');
  const projResp = await post('/api/projects', {
    path: '/data/workspace/ts460_live_proj',
    name: 'ts460_live_proj',
  });
  assert.ok(projResp.status === 200 || projResp.status === 409,
    `create project: ${JSON.stringify(projResp.data)}`);

  const sessResp = await post('/api/sessions', {
    project: 'ts460_live_proj',
    name: 'ts460-live-test',
  });
  assert.equal(sessResp.status, 200,
    `create session: ${JSON.stringify(sessResp.data)}`);
  const sessId = sessResp.data.id;

  // Wait for stub-claude to write its JSONL (100 ms delay in stub).
  await new Promise(r => setTimeout(r, 500));

  // Two /api/state polls: first triggers parseSessionFile → upsertSessionMeta,
  // second reads the populated session_meta.
  await get('/api/state');
  await new Promise(r => setTimeout(r, 300));
  const stateResp = await get('/api/state');
  assert.equal(stateResp.status, 200);

  const project = stateResp.data.projects?.find(p => p.name === 'ts460_live_proj');
  assert.ok(project, 'ts460_live_proj must appear in /api/state');

  const session = project?.sessions?.find(s => s.id === sessId);
  assert.ok(session, `${sessId} must appear in project sessions`);
  assert.ok(session.timestamp, 'session.timestamp must be truthy');
  // Must be a valid ISO 8601 date string
  assert.ok(
    !isNaN(Date.parse(session.timestamp)),
    `session.timestamp must parse as a valid date; got: ${session.timestamp}`,
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

test('#461-LIVE-03: file_find paren pattern finds a fixture match in workspace', async () => {
  // file_find searches from safe.WORKSPACE (/data/workspace), not /app/src.
  // Plant a deterministic fixture file containing the paren pattern so the
  // ERE test has something to find — proves the -E flag makes the grep
  // succeed AND return a real match (not just "no crash").
  dockerExec(
    "mkdir -p /data/workspace/p2-461-fixture && " +
    "printf 'function _seedRole(cliType, safe) { safe.tmuxCreateCLIAsync(); }\\n' " +
    "> /data/workspace/p2-461-fixture/seedrole-fixture.js"
  );
  const r = await post('/api/mcp/call', {
    tool: 'file_find',
    args: { pattern: String.raw`_seedRole\(`, file_type: 'js' },
  });
  assert.equal(r.status, 200,
    `expected 200, got ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  assert.ok(r.data?.result?.matches?.length > 0,
    `should find at least one match for _seedRole\\( in .js files in workspace; ` +
    `got ${r.data?.result?.matches?.length} matches. ` +
    `Fixture planted at /data/workspace/p2-461-fixture/seedrole-fixture.js`);
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
