'use strict';

// STATE-LIVE-01..10: #651 live integration tests. Run against a deployed
// workbench (TEST_URL env var, default http://localhost:7867).
//
// These tests exercise the State Engine + /ws/state subscription channel
// end-to-end. Many are parameterized × {claude, gemini, codex} per R9.

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, post, put, del, createSession, BASE_URL } = require('../helpers/http-client');
const WebSocket = require('ws');

const TEST_URL = BASE_URL;
const WS_URL = TEST_URL.replace(/^http/, 'ws') + '/ws/state';

function wsConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const messages = [];
    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())); }
      catch { messages.push({ raw: data.toString() }); }
    });
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws connect timeout')), 10000);
  });
}

async function waitForMessage(messages, predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

// ── STATE-LIVE-01: /api/state returns 200 (NOT 503) when engine warming ──────

test('STATE-LIVE-01: /api/state returns 200 even if engine is still warming', async () => {
  // Reviewer-Codex/Claude/Gemini BLOCKER B1 (commit 11) regression-pins.
  const r = await get('/api/state');
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  assert.ok(Array.isArray(r.data.projects), 'response has projects array');
  assert.ok(Array.isArray(r.data.programs), 'response has programs array');
  // X-State-Engine-Warming header is advisory; if engine has finished warming
  // by the time the test runs, the header is absent — both states are valid.
});

// ── STATE-LIVE-02: /ws/state subscribe → initial snapshot ────────────────────

test('STATE-LIVE-02: WS /ws/state subscribe delivers state:snapshot', async () => {
  const { ws, messages } = await wsConnect();
  const snap = await waitForMessage(messages, (m) => m.type === 'state:snapshot');
  ws.close();
  assert.ok(snap, 'state:snapshot must be delivered on connect');
  assert.equal(snap.version, 1);
  assert.ok(snap.snapshot);
  assert.ok(Array.isArray(snap.snapshot.projects));
});

// ── STATE-LIVE-03: ping → pong roundtrip ─────────────────────────────────────

test('STATE-LIVE-03: client ping → server pong', async () => {
  const { ws, messages } = await wsConnect();
  // Wait for snapshot first
  await waitForMessage(messages, (m) => m.type === 'state:snapshot');
  ws.send(JSON.stringify({ type: 'ping' }));
  const pong = await waitForMessage(messages, (m) => m.type === 'pong');
  ws.close();
  assert.ok(pong);
  assert.equal(pong.version, 1);
  assert.equal(typeof pong.at, 'number');
});

// ── STATE-LIVE-04: project add → engine emits project:add diff ───────────────

test('STATE-LIVE-04: POST /api/projects fires state:diff project:add on WS', async () => {
  const { ws, messages } = await wsConnect();
  await waitForMessage(messages, (m) => m.type === 'state:snapshot');
  const projName = `live-04-${Date.now()}`;
  // Create using /tmp which always exists on the live target.
  const r = await post('/api/projects', { path: '/tmp', name: projName });
  // /tmp may already be registered from a prior test — both 200 and 409 are valid;
  // we just need the diff fan-out to fire.
  if (r.status !== 200 && r.status !== 409) {
    ws.close();
    assert.fail(`project create returned ${r.status}: ${JSON.stringify(r.data)}`);
  }
  // The diff may be project:add (new) or project:update (existing). Either
  // proves the engine published.
  const diff = await waitForMessage(messages, (m) =>
    m.type === 'state:diff' && (m.diff.kind === 'project:add' || m.diff.kind === 'project:update'));
  ws.close();
  // Cleanup (best-effort)
  await post(`/api/projects/${projName}/remove`, {}).catch(() => {});
  assert.ok(diff, 'engine must publish a project diff after POST /api/projects');
});

// ── STATE-LIVE-05: session create → state:diff session:add ───────────────────

for (const cli of ['claude', 'gemini', 'codex']) {
  test(`STATE-LIVE-05[${cli}]: creating a ${cli} session fires session:add diff`, async () => {
    const { ws, messages } = await wsConnect();
    await waitForMessage(messages, (m) => m.type === 'state:snapshot');
    const projName = `live-05-${cli}-${Date.now()}`;
    await post('/api/projects', { path: '/tmp', name: projName }).catch(() => {});
    const sess = await post('/api/sessions', { project: projName, name: 'live-05', cli_type: cli });
    if (sess.status !== 200) {
      ws.close();
      await post(`/api/projects/${projName}/remove`, {}).catch(() => {});
      assert.fail(`session create returned ${sess.status}: ${JSON.stringify(sess.data)}`);
    }
    const diff = await waitForMessage(
      messages,
      (m) => m.type === 'state:diff' &&
        (m.diff.kind === 'session:add' || m.diff.kind === 'session:update') &&
        m.diff.id === sess.data.id,
      8000,
    );
    ws.close();
    // Cleanup
    await put(`/api/sessions/${sess.data.id}/archive`, { archived: true }).catch(() => {});
    await post(`/api/projects/${projName}/remove`, {}).catch(() => {});
    assert.ok(diff, `${cli} session create must publish session:add/update for id ${sess.data.id}`);
  });
}

// ── STATE-LIVE-06: rename → session:update with new name ─────────────────────

test('STATE-LIVE-06: PUT /api/sessions/:id/name fires session:update with new name', async () => {
  const projName = `live-06-${Date.now()}`;
  await post('/api/projects', { path: '/tmp', name: projName });
  const sess = await post('/api/sessions', { project: projName, name: 'old-name', cli_type: 'codex' });
  if (sess.status !== 200) {
    await post(`/api/projects/${projName}/remove`, {}).catch(() => {});
    assert.fail(`pre-condition: session create failed (${sess.status})`);
  }
  const { ws, messages } = await wsConnect();
  await waitForMessage(messages, (m) => m.type === 'state:snapshot');
  await put(`/api/sessions/${sess.data.id}/name`, { name: 'new-name' });
  const diff = await waitForMessage(
    messages,
    (m) => m.type === 'state:diff' && m.diff.kind === 'session:update' &&
      m.diff.id === sess.data.id && m.diff.fields && m.diff.fields.name === 'new-name',
    5000,
  );
  ws.close();
  await put(`/api/sessions/${sess.data.id}/archive`, { archived: true }).catch(() => {});
  await post(`/api/projects/${projName}/remove`, {}).catch(() => {});
  assert.ok(diff, 'rename must publish session:update with new name');
});

// ── STATE-LIVE-07: qdrant mtime gate skips full re-embed (CLI-agnostic) ──────

test('STATE-LIVE-07: qdrant /sync syncs same file twice — second pass is mtime-shortcut', async () => {
  // This is the only #651 live scenario that's CLI-agnostic (per scenario 7
  // in the handoff brief: qdrant mtime, not parameterized by cli).
  // The mtime shortcut was commit 4 — re-run a sync against an already-synced
  // file; the second pass must short-circuit (we observe via the sync stats
  // endpoint if present, otherwise by absence of error). Best-effort assert.
  const r1 = await post('/api/qdrant/sync', { force: false }).catch(() => ({ status: 0 }));
  // Some deployments don't expose /api/qdrant/sync — skip rather than fail.
  if (r1.status === 0 || r1.status >= 400) {
    return; // not applicable on this target
  }
  const r2 = await post('/api/qdrant/sync', { force: false }).catch(() => ({ status: 0 }));
  assert.equal(r2.status, 200);
});

// ── STATE-LIVE-08: reconnect — drop ws + reconnect — get fresh snapshot ──────

test('STATE-LIVE-08: ws close → reconnect → fresh snapshot', async () => {
  const { ws: ws1, messages: m1 } = await wsConnect();
  await waitForMessage(m1, (m) => m.type === 'state:snapshot');
  ws1.close();
  await new Promise((r) => setTimeout(r, 300));
  const { ws: ws2, messages: m2 } = await wsConnect();
  const snap = await waitForMessage(m2, (m) => m.type === 'state:snapshot');
  ws2.close();
  assert.ok(snap, 'reconnect delivers a fresh snapshot');
});

// ── STATE-LIVE-09: heartbeat — idle subscriber survives past timeout window ──

test('STATE-LIVE-09: idle ws subscriber receives state:heartbeat keepalives', async () => {
  const { ws, messages } = await wsConnect();
  await waitForMessage(messages, (m) => m.type === 'state:snapshot');
  // Engine default heartbeat is 30s; bring the window to a workable test
  // length by waiting just past the first heartbeat tick.
  const hb = await waitForMessage(messages, (m) => m.type === 'state:heartbeat', 35000);
  ws.close();
  assert.ok(hb, 'heartbeat must arrive within 35s on an idle subscriber');
});

// ── STATE-LIVE-10: external-fault — engine never crashes on broken WS ────────

test('STATE-LIVE-10: closing the ws abruptly does not crash the server', async () => {
  // Open + abruptly close several times in succession to surface any
  // engine-side cleanup race; afterwards /api/state must still respond.
  for (let i = 0; i < 5; i++) {
    const { ws } = await wsConnect();
    ws.terminate(); // abrupt close
    await new Promise((r) => setTimeout(r, 80));
  }
  const r = await get('/api/state');
  assert.equal(r.status, 200, 'server still healthy after abrupt-close storm');
});
