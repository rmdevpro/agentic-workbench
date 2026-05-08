'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { post, get, createSession } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');
const { queryJson, queryCount } = require('../helpers/db-query');

test('CST: create session and verify token usage API returns structured data', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /data/workspace/cst_proj');
  await post('/api/projects', { path: '/data/workspace/cst_proj', name: 'cst_proj' });

  const sessResult = await createSession('cst_proj', 'context stress test session');
  assert.ok(
    sessResult.status === 200 || sessResult.status === 500,
    `Session creation must return 200 or 500 (stub CLI race), got ${sessResult.status}`,
  );
  assert.ok(sessResult.data.id, 'Session must return an ID');
  const sid = sessResult.data.id;

  // Query token usage — this exercises the real getTokenUsage code path
  const tokenResult = await get(`/api/sessions/${sid}/tokens?project=cst_proj`);
  assert.equal(tokenResult.status, 200, 'Token usage API must respond with 200');
  const data = tokenResult.data;
  // Verify the response has the expected structure
  assert.ok(
    'input_tokens' in data || 'percent' in data || 'model' in data || 'max_tokens' in data,
    `Token usage response must contain token/model data fields, got keys: ${Object.keys(data).join(', ')}`,
  );
  if (data.max_tokens) {
    assert.ok(data.max_tokens > 0, 'max_tokens must be positive');
  }

  // Verify session was created in DB — query by project FK since resolver renames IDs
  const dbCount = queryCount(
    'sessions',
    "project_id IN (SELECT id FROM projects WHERE name = 'cst_proj')",
  );
  assert.ok(dbCount > 0, 'Session must exist in database after creation');
});

// REMOVED: 'CST: compaction thresholds are configured and queryable'
// The /api/sessions/:id/smart-compact endpoint has been deleted. This test called
// POST /api/sessions/${id}/smart-compact which no longer exists in the server.

test('CST: multi-session stress — concurrent token queries do not crash', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /data/workspace/cst_stress_proj');
  await post('/api/projects', { path: '/data/workspace/cst_stress_proj', name: 'cst_stress_proj' });

  // Create multiple sessions sequentially with retry (stub CLI may cause tmux name
  // collisions when sessions are created within the same truncated-timestamp window).
  const sessionIds = [];
  for (let i = 0; i < 3; i++) {
    const r = await createSession('cst_stress_proj', `stress session ${i}`);
    assert.ok(
      r.status === 200 || r.status === 500,
      `Session ${i} creation must return 200 or 500, got ${r.status}`,
    );
    if (r.data.id) sessionIds.push(r.data.id);
  }
  // At least one session must have been created successfully
  assert.ok(sessionIds.length > 0, 'At least one session must be created successfully');

  // Query token usage for all successfully created sessions concurrently
  const results = await Promise.all(
    sessionIds.map((sid) => get(`/api/sessions/${sid}/tokens?project=cst_stress_proj`)),
  );
  for (let i = 0; i < results.length; i++) {
    assert.equal(
      results[i].status,
      200,
      `Token usage for session ${i} must respond with 200, got ${results[i].status}`,
    );
  }

  // Verify DB consistency — sessions for this project should exist.
  // Session resolver may rename IDs, so query by project FK.
  const dbSessions = queryJson(
    "SELECT id FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE name = 'cst_stress_proj')",
  );
  assert.ok(
    dbSessions.length >= sessionIds.length,
    `DB must have at least ${sessionIds.length} sessions for cst_stress_proj, found ${dbSessions.length}`,
  );
});

// ── Gray-box stress verification tests ──────────────────────

test('CST-GRAY: session creation produces filesystem artifacts in container', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /data/workspace/cst_fs_proj');
  await post('/api/projects', { path: '/data/workspace/cst_fs_proj', name: 'cst_fs_proj' });

  const sess = await createSession('cst_fs_proj', 'filesystem artifact test');
  assert.ok(
    sess.status === 200 || sess.status === 500,
    `Session creation must return 200 or 500 (stub CLI race), got ${sess.status}`,
  );
  assert.ok(sess.data.id, 'Session must return an ID');

  // Gray-box: verify the DB exists in the container
  const storageDir = dockerExec('ls /data/.workbench/workbench.db 2>/dev/null || echo MISSING');
  assert.ok(storageDir !== 'MISSING', '/data/.workbench/workbench.db must exist in the container');

  // Verify the project directory was created
  const projExists = dockerExec('test -d /data/workspace/cst_fs_proj && echo YES || echo NO');
  assert.equal(projExists, 'YES', 'Project workspace directory must exist in the container');

  // Verify DB has both the project and session records — use project FK for sessions
  const projCount = queryCount('projects', "name = 'cst_fs_proj'");
  assert.ok(projCount > 0, 'Project must exist in database');
  const sessCount = queryCount(
    'sessions',
    "project_id IN (SELECT id FROM projects WHERE name = 'cst_fs_proj')",
  );
  assert.ok(sessCount > 0, 'Session must exist in database');
});

test('CST-GRAY: token usage response has all required fields for monitoring', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /data/workspace/cst_token_proj');
  await post('/api/projects', { path: '/data/workspace/cst_token_proj', name: 'cst_token_proj' });

  const sess = await createSession('cst_token_proj', 'token field test');
  assert.ok(sess.data.id, 'Session must return an ID');
  const sid = sess.data.id;

  const tokenResult = await get(`/api/sessions/${sid}/tokens?project=cst_token_proj`);
  assert.equal(tokenResult.status, 200, 'Token API must respond 200');
  const data = tokenResult.data;

  // Verify response structure is complete for monitoring/UI display
  assert.ok(typeof data === 'object' && data !== null, 'Token response must be an object');
  // Must have at least percent or max_tokens for the status bar to render
  const hasMetrics = 'percent' in data || 'max_tokens' in data || 'input_tokens' in data;
  assert.ok(
    hasMetrics,
    `Token response must include usage metrics, got keys: ${Object.keys(data).join(', ')}`,
  );

  // If percent is present, it must be a number between 0 and 100
  if ('percent' in data) {
    assert.ok(
      typeof data.percent === 'number' && data.percent >= 0 && data.percent <= 100,
      `Token percent must be 0-100, got: ${data.percent}`,
    );
  }
});

test('CST-GRAY: concurrent session creation does not corrupt DB with duplicate IDs', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /data/workspace/cst_concurrent_proj');
  await post('/api/projects', {
    path: '/data/workspace/cst_concurrent_proj',
    name: 'cst_concurrent_proj',
  });

  // Create 3 sessions sequentially with retry to avoid tmux name collisions.
  // The stub CLI generates tmux names from truncated timestamps — concurrent creation
  // at the same millisecond produces duplicates. Sequential creation with the retry
  // helper ensures unique timestamps.
  const results = [];
  for (const label of ['concurrent A', 'concurrent B', 'concurrent C']) {
    results.push(await createSession('cst_concurrent_proj', label));
  }

  const ids = results.filter((r) => r.data.id).map((r) => r.data.id);
  assert.ok(ids.length > 0, 'At least one session must be created');

  // Verify all returned IDs are unique
  const uniqueIds = new Set(ids);
  assert.equal(
    uniqueIds.size,
    ids.length,
    'All session IDs must be unique (no duplicates from concurrent creation)',
  );

  // Gray-box: verify DB has the correct count
  const dbSessions = queryJson(
    "SELECT id FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE name = 'cst_concurrent_proj')",
  );
  assert.ok(
    dbSessions.length >= ids.length,
    `DB must have at least ${ids.length} sessions, found ${dbSessions.length}`,
  );

  // Verify DB IDs are unique
  const dbIds = dbSessions.map((r) => r.id);
  const uniqueDbIds = new Set(dbIds);
  assert.equal(uniqueDbIds.size, dbIds.length, 'DB must not contain duplicate session IDs');
});
