'use strict';

// ME-MK-01..09: #651 commit 7a — every DB mutation in src/routes/sessions.js
// publishes the matching update through the State Engine.
//
// The engine is the in-memory model behind /api/state's fast path; if a
// mutation site forgets to fire its engine call, the engine goes stale on
// writes and the WS subscriber channel (commit 8) starts diverging from the
// DB. These tests pin every mutation site so the regression can't recur.
//
// Each test wires a stub stateEngine that records calls, mounts the sessions
// route, fires a real HTTP request, and asserts the recorded calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { withServer, req } = require('../helpers/with-server');
const { register } = require('../../src/routes/sessions');

function makeRecorder() {
  const calls = [];
  return {
    calls,
    upsertProject(p) { calls.push({ method: 'upsertProject', args: [p] }); },
    removeProject(path) { calls.push({ method: 'removeProject', args: [path] }); },
    upsertSession(s) { calls.push({ method: 'upsertSession', args: [s] }); },
    updateSession(id, fields) { calls.push({ method: 'updateSession', args: [id, fields] }); },
    removeSession(id) { calls.push({ method: 'removeSession', args: [id] }); },
    upsertProgram(p) { calls.push({ method: 'upsertProgram', args: [p] }); },
    removeProgram(id) { calls.push({ method: 'removeProgram', args: [id] }); },
  };
}

function makeStubDb({ project = null, sessions = {} } = {}) {
  const proj = project || { id: 1, name: 'p1', path: '/p1', state: 'active', program_id: null };
  const stored = { ...sessions };
  return {
    getProject: (name) => (name === proj.name ? proj : null),
    getProjectById: (id) => (id === proj.id ? proj : null),
    getSession: (id) => stored[id] || null,
    getSessionFull: (id) => (stored[id] ? { ...stored[id], project_name: proj.name, project_path: proj.path } : null),
    ensureProject: (name, path) => { proj.name = name; proj.path = path; return proj; },
    upsertSession: (id, project_id, name, cli_type) => {
      stored[id] = { id, project_id, name, cli_type, state: 'active' };
    },
    renameSession: (id, name) => { if (stored[id]) stored[id].name = name; },
    setSessionState: (id, state) => { if (stored[id]) stored[id].state = state; },
    setSessionNotes: (id, notes) => { if (stored[id]) stored[id].notes = notes; },
    deleteSession: (id) => { delete stored[id]; },
    setCliSessionId: (id, cli) => { if (stored[id]) stored[id].cli_session_id = cli; },
    getSessionMeta: () => null,
    getSetting: () => '"sonnet"',
    searchSessionsByName: () => [],
    _stored: stored,
    _project: proj,
  };
}

function makeStubSafe() {
  return {
    resolveProjectPath: (name) => `/${name}`,
    findSessionsDir: (p) => `${p}/sessions`,
    tmuxExists: async () => false,
    tmuxKill: async () => {},
    tmuxCreateCLIAsync: async () => {},
    tmuxSendKeysAsync: async () => {},
    tmuxSendTextAsync: async () => {},
    tmuxSendKeyAsync: async () => {},
    tmuxExecAsync: async () => {},
    buildResumeArgs: async () => ({ args: [], missing: false, expectedPath: '' }),
    sanitizeErrorForClient: (s) => s,
  };
}

function makeStubSessionUtils() {
  return {
    discoverGeminiSessions: () => [],
    discoverCodexSessions: () => [],
    invalidateDiscoveryCache: () => {},
    invalidateSessionInfoCache: () => {},
    summarizeSession: async () => ({ summary: '', recentMessages: [] }),
    getSessionInfo: async () => null,
  };
}

function mountSessions({ stateEngine, db, safe = makeStubSafe(), sessionUtils = makeStubSessionUtils() } = {}) {
  const app = express();
  app.use(express.json());
  // ENOENT-safe stat — we use a /tmp dir that does exist so POST /sessions
  // doesn't 410 on the project-dir check.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmpProjDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mk-proj-'));
  if (db && db._project) db._project.path = tmpProjDir;
  register(app, {
    db,
    safe,
    config: { get: (_k, def) => def, getPrompt: () => 'p' },
    sessionUtils,
    keepalive: {},
    fireEvent: () => {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    stateEngine,
    tmuxName: (id) => `wb-${id}`,
    tmuxExists: async () => false,
    enforceTmuxLimit: async () => {},
    resolveSessionId: () => {},
    getBrowserCount: () => 0,
    CLAUDE_HOME: '/tmp/claude-home',
    WORKSPACE: '/data/workspace',
    ensureSettings: async () => {},
    sleep: async () => {},
  });
  return { app, tmpProjDir };
}

// ── ME-MK-01: POST /api/sessions publishes upsertProject + upsertSession ────

test('ME-MK-01: POST /api/sessions fires stateEngine.upsertSession with project_path', async () => {
  const stateEngine = makeRecorder();
  const db = makeStubDb();
  const { app } = mountSessions({ stateEngine, db });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'POST', '/api/sessions', {
      project: 'p1',
      name: 'My new session',
      cli_type: 'gemini',
    });
    assert.equal(r.status, 200, await r.text());
    const upserts = stateEngine.calls.filter((c) => c.method === 'upsertSession');
    assert.equal(upserts.length, 1, 'exactly one session upsert per POST');
    const [s] = upserts[0].args;
    assert.equal(s.project_path, db._project.path, 'project_path must be the proj.path');
    assert.equal(s.cli_type, 'gemini');
    assert.equal(s.name, 'My new session');
    assert.equal(s.state, 'active');
    assert.ok(s.id, 'session id must be set');
    // Project must be published BEFORE the session (engine.upsertSession asserts project exists)
    const projUpsert = stateEngine.calls.findIndex((c) => c.method === 'upsertProject');
    const sessUpsert = stateEngine.calls.findIndex((c) => c.method === 'upsertSession');
    assert.ok(projUpsert >= 0 && projUpsert < sessUpsert, 'upsertProject must come before upsertSession');
  });
});

test('ME-MK-02: POST /api/sessions with hidden=true fires updateSession with state hidden', async () => {
  const stateEngine = makeRecorder();
  const db = makeStubDb();
  const { app } = mountSessions({ stateEngine, db });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'POST', '/api/sessions', {
      project: 'p1', name: 'hidden one', cli_type: 'codex', hidden: true,
    });
    assert.equal(r.status, 200);
    const stateUpdate = stateEngine.calls.find(
      (c) => c.method === 'updateSession' && c.args[1] && c.args[1].state === 'hidden'
    );
    assert.ok(stateUpdate, 'hidden=true must fire updateSession({state:"hidden"})');
  });
});

// ── ME-MK-03: PUT /api/sessions/:id/name ──────────────────────────────────────

test('ME-MK-03: PUT /api/sessions/:id/name fires updateSession({name})', async () => {
  const stateEngine = makeRecorder();
  const db = makeStubDb({
    sessions: { 'abc12345-1111-2222-3333-444455556666': { id: 'abc12345-1111-2222-3333-444455556666', name: 'old' } },
  });
  const { app } = mountSessions({ stateEngine, db });
  await withServer(app, async ({ port }) => {
    const r = await req(
      port, 'PUT',
      '/api/sessions/abc12345-1111-2222-3333-444455556666/name',
      { name: 'new name' }
    );
    assert.equal(r.status, 200, await r.text());
    const update = stateEngine.calls.find((c) => c.method === 'updateSession');
    assert.ok(update, 'updateSession must be called');
    assert.equal(update.args[0], 'abc12345-1111-2222-3333-444455556666');
    assert.deepEqual(update.args[1], { name: 'new name' });
  });
});

// ── ME-MK-04: PUT /api/sessions/:id/config — all 3 fields ─────────────────────

test('ME-MK-04: PUT /api/sessions/:id/config with name+state+notes fires three updateSession calls', async () => {
  const stateEngine = makeRecorder();
  const db = makeStubDb({
    sessions: { 'def12345-1111-2222-3333-444455556666': { id: 'def12345-1111-2222-3333-444455556666' } },
  });
  const { app } = mountSessions({ stateEngine, db });
  await withServer(app, async ({ port }) => {
    const r = await req(
      port, 'PUT',
      '/api/sessions/def12345-1111-2222-3333-444455556666/config',
      { name: 'cfg', state: 'archived', notes: 'note text' }
    );
    assert.equal(r.status, 200);
    const updates = stateEngine.calls.filter((c) => c.method === 'updateSession');
    assert.equal(updates.length, 3, 'three updateSession calls (one per field)');
    assert.deepEqual(updates[0].args[1], { name: 'cfg' });
    assert.deepEqual(updates[1].args[1], { state: 'archived', archived: true });
    assert.deepEqual(updates[2].args[1], { notes: 'note text' });
  });
});

test('ME-MK-05: PUT /api/sessions/:id/config with only state=active sets archived=false', async () => {
  const stateEngine = makeRecorder();
  const db = makeStubDb({
    sessions: { 'aaa12345-1111-2222-3333-444455556666': { id: 'aaa12345-1111-2222-3333-444455556666' } },
  });
  const { app } = mountSessions({ stateEngine, db });
  await withServer(app, async ({ port }) => {
    const r = await req(
      port, 'PUT',
      '/api/sessions/aaa12345-1111-2222-3333-444455556666/config',
      { state: 'active' }
    );
    assert.equal(r.status, 200);
    const updates = stateEngine.calls.filter((c) => c.method === 'updateSession');
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].args[1], { state: 'active', archived: false });
  });
});

// ── ME-MK-06: PUT /api/sessions/:id/archive ───────────────────────────────────

test('ME-MK-06: PUT /api/sessions/:id/archive archived=true fires updateSession({state:archived,archived:true})', async () => {
  const stateEngine = makeRecorder();
  const db = makeStubDb({
    sessions: { 'bbb12345-1111-2222-3333-444455556666': { id: 'bbb12345-1111-2222-3333-444455556666' } },
  });
  const { app } = mountSessions({ stateEngine, db });
  await withServer(app, async ({ port }) => {
    const r = await req(
      port, 'PUT',
      '/api/sessions/bbb12345-1111-2222-3333-444455556666/archive',
      { archived: true }
    );
    assert.equal(r.status, 200);
    const update = stateEngine.calls.find((c) => c.method === 'updateSession');
    assert.ok(update);
    assert.deepEqual(update.args[1], { state: 'archived', archived: true });
  });
});

test('ME-MK-07: PUT /api/sessions/:id/archive archived=false fires updateSession({state:active,archived:false})', async () => {
  const stateEngine = makeRecorder();
  const db = makeStubDb({
    sessions: { 'ccc12345-1111-2222-3333-444455556666': { id: 'ccc12345-1111-2222-3333-444455556666' } },
  });
  const { app } = mountSessions({ stateEngine, db });
  await withServer(app, async ({ port }) => {
    const r = await req(
      port, 'PUT',
      '/api/sessions/ccc12345-1111-2222-3333-444455556666/archive',
      { archived: false }
    );
    assert.equal(r.status, 200);
    const update = stateEngine.calls.find((c) => c.method === 'updateSession');
    assert.ok(update);
    assert.deepEqual(update.args[1], { state: 'active', archived: false });
  });
});

// ── ME-MK-08: engine absent → no crash, DB writes still succeed ─────────────────

test('ME-MK-08: stateEngine absent — handlers do not crash and DB writes complete', async () => {
  const db = makeStubDb({
    sessions: { 'ddd12345-1111-2222-3333-444455556666': { id: 'ddd12345-1111-2222-3333-444455556666' } },
  });
  // Mount without stateEngine
  const { app } = mountSessions({ stateEngine: undefined, db });
  await withServer(app, async ({ port }) => {
    const r = await req(
      port, 'PUT',
      '/api/sessions/ddd12345-1111-2222-3333-444455556666/name',
      { name: 'no-engine' }
    );
    assert.equal(r.status, 200);
    assert.equal(db._stored['ddd12345-1111-2222-3333-444455556666'].name, 'no-engine',
      'DB write must succeed even when engine is absent');
  });
});

// ── ME-MK-09: engine throws → DB writes still complete and 200 returns ──────────

test('ME-MK-09: stateEngine method throws — handler still returns 200 and DB write completes', async () => {
  const calls = [];
  const stateEngine = {
    upsertSession() { throw new Error('engine boom'); },
    updateSession(id, fields) {
      calls.push({ id, fields });
      throw new Error('engine boom');
    },
    removeSession() { throw new Error('engine boom'); },
    upsertProject() { throw new Error('engine boom'); },
    removeProject() { throw new Error('engine boom'); },
    upsertProgram() {},
    removeProgram() {},
  };
  const db = makeStubDb({
    sessions: { 'eee12345-1111-2222-3333-444455556666': { id: 'eee12345-1111-2222-3333-444455556666' } },
  });
  const { app } = mountSessions({ stateEngine, db });
  await withServer(app, async ({ port }) => {
    const r = await req(
      port, 'PUT',
      '/api/sessions/eee12345-1111-2222-3333-444455556666/name',
      { name: 'engine-throws' }
    );
    assert.equal(r.status, 200, 'engine failure must NOT propagate to client (DB is source of truth)');
    assert.equal(db._stored['eee12345-1111-2222-3333-444455556666'].name, 'engine-throws',
      'DB write must complete before engine call (engine update lands after DB)');
    assert.equal(calls.length, 1, 'updateSession was attempted exactly once');
  });
});
