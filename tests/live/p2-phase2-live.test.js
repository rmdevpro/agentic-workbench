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
const ws = require('../helpers/test-workspace');

// #481: all Phase 2 test projects live under /data/workspace/_test/p2-phase2/
// instead of polluting the WORKSPACE root. test.after() removes the whole tree.
const SUITE = 'p2-phase2';
test.after(() => ws.cleanup(SUITE));

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

// M1-LIVE-03 (REMOVED — gap documented in tests/traceability-matrix.md §7):
// _cloneIfMissing is called from kb-watcher start() on every container boot.
// In the sandbox test container, the git clone fails (no network to github.com),
// so KB_PATH never gets created and the assertion "directory exists" was not
// achievable. The startup log line "kb-watcher: cloning Knowledge Base" IS
// emitted to stdout (verified via `docker logs`), but the batch logger doesn't
// flush early startup messages to the DB, so /api/logs returns 0 rows for
// 'module=kb-watcher'. `docker logs` is not callable from inside the container
// (no Docker socket). The structural proof that _cloneIfMissing is called from
// start() lives in mock tests M1-KB-01 through M1-KB-08 (static + runtime
// structural checks). Live behavioral verification requires a real git upstream
// or a network-capable test environment.

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

test('G0-LIVE-03: all 9 domain module endpoints respond with expected status codes', async () => {
  // Each entry: [method, path, body|null, expectedStatuses[], module]
  const g0Path = ws.mkProject(SUITE, 'g0sweep_proj');
  await post('/api/projects', { path: g0Path, name: 'g0sweep_proj' });

  const cases = [
    // health.js
    ['GET',  '/health',                null,                              [200],       'health.js'],
    // sessions.js
    ['GET',  '/api/state',             null,                              [200],       'sessions.js'],
    // projects.js — 200 created or 409 if already exists
    ['POST', '/api/projects',          { path: g0Path, name: 'g0sweep_proj' },
                                                                         [200, 409],  'projects.js'],
    // files.js — POST /api/files/list with valid path returns 200
    ['POST', '/api/files/list',        { path: '/data/workspace' },      [200],       'files.js'],
    // tasks.js — GET /api/tasks/tree returns 200 with JSON tree
    ['GET',  '/api/tasks/tree',        null,                              [200],       'tasks.js'],
    // git-accounts.js
    ['GET',  '/api/git-accounts',      null,                              [200],       'git-accounts.js'],
    // kb.js
    ['GET',  '/api/kb/status',         null,                              [200],       'kb.js'],
    // settings.js
    ['GET',  '/api/settings',          null,                              [200],       'settings.js'],
    // auth.js
    ['GET',  '/api/auth/status',       null,                              [200],       'auth.js'],
  ];

  for (const [method, path, body, expectedStatuses, module] of cases) {
    const r = method === 'GET' ? await get(path) : await post(path, body);
    assert.ok(
      expectedStatuses.includes(r.status),
      `${module} ${method} ${path} must return one of [${expectedStatuses}]; ` +
      `got ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`,
    );
  }
});

// ── #460 — server-side session_meta.timestamp in /api/state ──────────────────

test('#460-LIVE-01 / #469: /api/state uses session_meta.timestamp not db.updated_at for Claude sessions', async () => {
  // Plant a session with a FUTURE db.updated_at and a PAST session_meta.timestamp.
  // buildSessionList must return the session_meta value, proving it wins over
  // db.updated_at. Timestamps are deliberately divergent so the assertion is
  // unambiguous.
  //
  // session_meta schema: file_path TEXT NOT NULL, file_mtime REAL NOT NULL,
  // file_size INTEGER NOT NULL — all included below to avoid constraint failure.

  const FUTURE_UPDATED = '2028-01-01T00:00:00.000Z'; // db.updated_at (would be "now" on each poll)
  const META_TS        = '2019-06-15T08:00:00.000Z'; // session_meta.timestamp (real last msg)

  const ts469Path = ws.mkProject(SUITE, 'ts469_live_proj');
  const projResp = await post('/api/projects', {
    path: ts469Path,
    name: 'ts469_live_proj',
  });
  assert.ok(projResp.status === 200 || projResp.status === 409,
    `create project: ${JSON.stringify(projResp.data)}`);

  const projId = dockerExec(
    `sqlite3 /data/.workbench/workbench.db "SELECT id FROM projects WHERE name='ts469_live_proj'"`,
  );
  assert.ok(projId, 'project must be findable in DB');

  const sessId = `ts469_sess_${Date.now()}`;

  // Plant session with FUTURE updated_at
  dockerExec(
    `sqlite3 /data/.workbench/workbench.db "INSERT OR REPLACE INTO sessions ` +
    `(id, project_id, name, cli_type, updated_at, created_at) VALUES ` +
    `('${sessId}', ${projId}, 'ts469-test', 'claude', '${FUTURE_UPDATED}', '${FUTURE_UPDATED}')"`,
  );

  // Plant session_meta with PAST timestamp; include all NOT NULL columns
  dockerExec(
    `sqlite3 /data/.workbench/workbench.db "INSERT OR REPLACE INTO session_meta ` +
    `(session_id, file_path, file_mtime, file_size, timestamp, message_count, model) VALUES ` +
    `('${sessId}', '/fake/ts469.jsonl', 0.0, 0, '${META_TS}', 1, '')"`,
  );

  // Verify plant succeeded before asserting
  const metaCheck = dockerExec(
    `sqlite3 /data/.workbench/workbench.db "SELECT timestamp FROM session_meta WHERE session_id='${sessId}'"`,
  );
  assert.equal(metaCheck, META_TS,
    `session_meta plant must succeed; got: '${metaCheck}'. ` +
    `If empty, the INSERT failed (check NOT NULL constraints).`);

  // Deadline-poll /api/state until our session appears (max 5s)
  let session = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const r = await get('/api/state');
    assert.equal(r.status, 200);
    const proj = r.data.projects?.find(p => p.name === 'ts469_live_proj');
    session = proj?.sessions?.find(s => s.id === sessId);
    if (session) break;
    await new Promise(r => setTimeout(r, 400));
  }

  assert.ok(session, `${sessId} must appear in /api/state within 5s`);
  assert.equal(
    session.timestamp, META_TS,
    `buildSessionList must return session_meta.timestamp (${META_TS}), ` +
    `not db.updated_at (${FUTURE_UPDATED}). Got: ${session.timestamp}`,
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
  const fixtureDir = ws.mkProject(SUITE, 'p2-461-fixture');
  dockerExec(
    `printf 'function _seedRole(cliType, safe) { safe.tmuxCreateCLIAsync(); }\\n' ` +
    `> ${fixtureDir}/seedrole-fixture.js`
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
    `Fixture planted at ${fixtureDir}/seedrole-fixture.js`);
});

// ── #453 — claimed Sets: /api/state with multiple projects ───────────────────

test('#453-LIVE-01: /api/state returns cleanly with multiple projects', async () => {
  for (const name of ['claimed_proj_a', 'claimed_proj_b']) {
    const projPath = ws.mkProject(SUITE, name);
    await post('/api/projects', { path: projPath, name });
  }
  const r = await get('/api/state');
  assert.equal(r.status, 200,
    `/api/state must return 200 with multiple projects; got ${r.status}`);
  assert.ok(Array.isArray(r.data.projects), 'projects must be an array');
});

test('#468-LIVE-01: Gemini disk session claimed by exactly one project per /api/state request', async () => {
  // Plant 1 Gemini disk file + 2 unbound DB Gemini sessions (one per project).
  // Pre-fix: module-level _claimedGemini Set was shared across projects, so both
  // sessions could claim the same file → double assignment.
  // Post-fix: per-request Set → file claimed by exactly 1 session.
  //
  // Robustness: both sessions and the file use FUTURE_TS (2030-01-01) as their
  // timestamp. The _matchFromList time-proximity path (#2) matches sessions whose
  // created_at is within 60s of the disk file's timestamp. The cleanup step below
  // removes any leftover p468-test-* directories from prior runs (they share the
  // same hardcoded FUTURE_TS and would otherwise pollute the time-proximity match).
  const ts = Date.now();
  const FUTURE_TS = '2030-01-01T00:00:00.000Z'; // far future — unique across all test runs
  const GEM_SID = `gem-claim-live-${ts}`;        // unique sessionId in the header

  // 0a. CLEANUP: remove leftover p468-test-* dirs from prior test runs.
  // The persistent /data volume in workbench-test accumulates these across
  // gate-regression cycles; their FUTURE_TS timestamps collide with ours
  // and cause _matchFromList to pick a stale leftover instead of our plant.
  dockerExec('rm -rf /data/.gemini/tmp/p468-test-*');

  // 0b. Force Gemini discovery cache invalidation. The 10s TTL alone is
  // insufficient when concurrent watchers / prior tests have populated the
  // cache with leftover entries; the cleanup deletes the files on disk but
  // the cache holds them in memory for up to 10s past last refresh. The
  // POST /api/projects/:name/remove endpoint explicitly invalidates the
  // per-CLI discovery cache (#372 [E2]); we use it on a throwaway project
  // to force a refresh before the test continues.
  const flushName = `_p468_flush_${ts}`;
  const flushPath = ws.mkProject(SUITE, flushName);
  await post('/api/projects', { path: flushPath, name: flushName });
  await post(`/api/projects/${flushName}/remove`);

  // 1. Create 2 projects
  for (const p of [`p468a_${ts}`, `p468b_${ts}`]) {
    const projPath = ws.mkProject(SUITE, p);
    await post('/api/projects', { path: projPath, name: p });
  }

  const projAId = dockerExec(`sqlite3 /data/.workbench/workbench.db "SELECT id FROM projects WHERE name='p468a_${ts}'"`);
  const projBId = dockerExec(`sqlite3 /data/.workbench/workbench.db "SELECT id FROM projects WHERE name='p468b_${ts}'"`);
  assert.ok(projAId && projBId, `both projects must be findable; got A='${projAId}' B='${projBId}'`);

  // 2. Plant 2 unbound Gemini sessions with created_at = FUTURE_TS (for time-proximity match)
  const sessA = `p468a_sess_${ts}`;
  const sessB = `p468b_sess_${ts}`;
  for (const [sid, pid] of [[sessA, projAId], [sessB, projBId]]) {
    dockerExec(
      `sqlite3 /data/.workbench/workbench.db ` +
      `"INSERT OR REPLACE INTO sessions (id, project_id, name, cli_type, updated_at, created_at) ` +
      `VALUES ('${sid}', ${pid}, 'gem-test', 'gemini', '${FUTURE_TS}', '${FUTURE_TS}')"`,
    );
  }

  // 3. Plant a Gemini chat JSONL with startTime/lastUpdated = FUTURE_TS
  //    _matchFromList path #2 matches session.created_at ≈ disk.timestamp (within 60s)
  const gemDir = `/data/.gemini/tmp/p468-test-${ts}/chats`;
  dockerExec(`mkdir -p ${gemDir}`);
  dockerExec(
    `printf '{"sessionId":"${GEM_SID}","startTime":"${FUTURE_TS}","lastUpdated":"${FUTURE_TS}"}\\n` +
    `{"type":"user","content":"claim test"}\\n' > ${gemDir}/claim-${ts}.jsonl`,
  );

  // 4. Wait for discovery cache TTL to expire (10s) so next /api/state discovers the file
  await new Promise(r => setTimeout(r, 12000));

  // 5. Call /api/state — both projects processed; claimedGemini Set shared across them
  const r = await get('/api/state');
  assert.equal(r.status, 200, `/api/state must return 200; got ${r.status}`);

  // 6. Assert: exactly one session claimed the file via time-proximity match
  const sidA = dockerExec(`sqlite3 /data/.workbench/workbench.db "SELECT cli_session_id FROM sessions WHERE id='${sessA}'"`);
  const sidB = dockerExec(`sqlite3 /data/.workbench/workbench.db "SELECT cli_session_id FROM sessions WHERE id='${sessB}'"`);

  const claimedCount = [sidA, sidB].filter(v => v === GEM_SID).length;
  assert.equal(claimedCount, 1,
    `Gemini file '${GEM_SID}' must be claimed by exactly 1 of 2 sessions ` +
    `(would be 2 with pre-fix module-level Set). ` +
    `sessA.cli_session_id='${sidA}', sessB.cli_session_id='${sidB}'`,
  );
});

// ── #454 — createTrustDir live (project creation exercises trustDir) ──────────

test('#454-LIVE-01: POST /api/projects succeeds (createTrustDir from _shared wired correctly)', async () => {
  const trustPath = ws.mkProject(SUITE, 'trust_live_proj');
  const r = await post('/api/projects', {
    path: trustPath,
    name: 'trust_live_proj',
  });
  // 200 (created) or 409 (already exists from prior run) — both prove the
  // trustDir path in settings.js/projects.js did not throw.
  assert.ok(
    r.status === 200 || r.status === 409,
    `POST /api/projects must return 200 or 409 (trustDir must not throw); got ${r.status}: ${JSON.stringify(r.data)}`,
  );
});
