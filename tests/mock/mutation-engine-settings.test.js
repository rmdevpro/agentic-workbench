'use strict';

// ME-MK-19..22: #651 commit 7c — codex_api_key save fans out to every Codex
// session via stateEngine.updateSession({codex_api_key_set}).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { withServer, req } = require('../helpers/with-server');
const { register } = require('../../src/routes/settings');

function makeRecorder() {
  const calls = [];
  return {
    calls,
    upsertProject(p) { calls.push({ method: 'upsertProject', args: [p] }); },
    removeProject(p) { calls.push({ method: 'removeProject', args: [p] }); },
    upsertSession(s) { calls.push({ method: 'upsertSession', args: [s] }); },
    updateSession(id, fields) { calls.push({ method: 'updateSession', args: [id, fields] }); },
    removeSession(id) { calls.push({ method: 'removeSession', args: [id] }); },
    upsertProgram(p) { calls.push({ method: 'upsertProgram', args: [p] }); },
    removeProgram(id) { calls.push({ method: 'removeProgram', args: [id] }); },
  };
}

function makeStubDb({ sessions = [] } = {}) {
  const settings = {};
  return {
    getAllSettings: () => settings,
    setSetting: (k, v) => { settings[k] = v; },
    getSetting: (k, def) => (settings[k] !== undefined ? settings[k] : def),
    getProjects: () => [{ id: 1, name: 'p1', path: '/p1', state: 'active' }],
    getSessionsForProject: () => sessions,
  };
}

function mountSettings({ stateEngine, db }) {
  const app = express();
  app.use(express.json());
  register(app, {
    db,
    safe: { WORKSPACE: '/data/workspace' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    getBrowserCount: () => 0,
    CLAUDE_HOME: '/tmp',
    WORKSPACE: '/data/workspace',
    keepalive: { setMode() {}, isRunning: () => true, start() {}, stop() {} },
    registerGeminiMcp: async () => {},
    registerCodexProvider: async () => {},
    registerCodexAuth: async () => {},
    qdrantSync: {
      buildCandidateConfig: async (key, value) => ({ model: 'openai', key, value }),
      validateProviderConfig: async () => ({ ok: true }),
      reapplyConfig: async () => {},
    },
    stateEngine,
  });
  return app;
}

// ── ME-MK-19: codex_api_key save → every Codex session updated ─────────────

test('ME-MK-19: PUT /api/settings codex_api_key fan-out updates every Codex session', async () => {
  const stateEngine = makeRecorder();
  const db = makeStubDb({
    sessions: [
      { id: 'sess-claude', cli_type: 'claude' },
      { id: 'sess-codex-1', cli_type: 'codex' },
      { id: 'sess-gemini', cli_type: 'gemini' },
      { id: 'sess-codex-2', cli_type: 'codex' },
    ],
  });
  const app = mountSettings({ stateEngine, db });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'PUT', '/api/settings', { key: 'codex_api_key', value: 'sk-test' });
    assert.equal(r.status, 200);
    const updates = stateEngine.calls.filter((c) => c.method === 'updateSession');
    // Only Codex sessions
    assert.equal(updates.length, 2);
    assert.deepEqual(updates.map((u) => u.args[0]).sort(), ['sess-codex-1', 'sess-codex-2']);
    for (const u of updates) {
      assert.deepEqual(u.args[1], { codex_api_key_set: true });
    }
  });
});

test('ME-MK-20: PUT /api/settings codex_api_key empty value publishes codex_api_key_set:false', async () => {
  const stateEngine = makeRecorder();
  const db = makeStubDb({
    sessions: [{ id: 'sess-codex-only', cli_type: 'codex' }],
  });
  const app = mountSettings({ stateEngine, db });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'PUT', '/api/settings', { key: 'codex_api_key', value: '' });
    assert.equal(r.status, 200);
    const updates = stateEngine.calls.filter((c) => c.method === 'updateSession');
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].args[1], { codex_api_key_set: false });
  });
});

test('ME-MK-21: PUT /api/settings non-codex_api_key keys fire NO updateSession', async () => {
  const stateEngine = makeRecorder();
  const db = makeStubDb({
    sessions: [{ id: 'sess-codex', cli_type: 'codex' }],
  });
  const app = mountSettings({ stateEngine, db });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'PUT', '/api/settings', { key: 'default_model', value: 'opus' });
    assert.equal(r.status, 200);
    const updates = stateEngine.calls.filter((c) => c.method === 'updateSession');
    assert.equal(updates.length, 0, 'unrelated settings must not fan out to sessions');
  });
});

test('ME-MK-22: stateEngine absent — codex_api_key save still completes', async () => {
  const db = makeStubDb({
    sessions: [{ id: 'sess-codex', cli_type: 'codex' }],
  });
  const app = mountSettings({ stateEngine: undefined, db });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'PUT', '/api/settings', { key: 'codex_api_key', value: 'sk-test' });
    assert.equal(r.status, 200, 'no engine — handler must still return 200');
  });
});
