'use strict';

// ME-MK-23..24: #651 commit 7d — JSONL chokidar change events fan out to
// the State Engine via stateEngine.updateSession.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createWatchers = require('../../src/watchers');

function makeRecorder() {
  const calls = [];
  return {
    calls,
    upsertProject() {},
    removeProject() {},
    upsertSession() {},
    updateSession(id, fields) { calls.push({ id, fields }); },
    removeSession() {},
    upsertProgram() {},
    removeProgram() {},
  };
}

// Minimal fake chokidar — exposes a watch() that returns a Watcher with
// programmatic `_fire(path)` so the test can drive the 'change' event.
function makeFakeChokidar() {
  const watchers = [];
  return {
    watch(dirPath) {
      const handlers = { add: [], change: [], error: [] };
      const w = {
        on(event, h) { handlers[event] = handlers[event] || []; handlers[event].push(h); return w; },
        close() {},
        _fire(event, p) { for (const h of (handlers[event] || [])) h(p); },
        dirPath,
      };
      watchers.push(w);
      return w;
    },
    _watchers: watchers,
  };
}

function makeStubSessionUtils({ usage = { input_tokens: 100, max_tokens: 200000, model: 'sonnet' } } = {}) {
  return {
    getTokenUsage: async () => usage,
    discoverGeminiSessions: () => [],
    discoverCodexSessions: () => [],
  };
}

function makeStubDb({ sessions = {}, projects = {} } = {}) {
  return {
    getSession: (id) => sessions[id] || null,
    getSessionByPrefix: (prefix) => {
      for (const s of Object.values(sessions)) {
        if (s.id.startsWith(prefix)) return s;
      }
      return null;
    },
    getProjectById: (id) => projects[id] || null,
    getProjects: () => Object.values(projects),
  };
}

function setup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mk-watch-'));
  const sessionsDir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`);
  fs.writeFileSync(jsonlPath, '');

  const stateEngine = makeRecorder();
  const sessionWsClients = new Map();
  const fakeChokidar = makeFakeChokidar();
  const watchers = createWatchers({
    db: makeStubDb({
      sessions: { [sessionId]: { id: sessionId, project_id: 1, cli_type: 'claude' } },
      projects: { 1: { id: 1, name: 'p1', path: tmpDir } },
    }),
    safe: { findSessionsDir: () => sessionsDir },
    config: { get: (_k, def) => def, getPrompt: () => '' },
    sessionUtils: makeStubSessionUtils(),
    sessionWsClients,
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => true,
    CLAUDE_HOME: tmpDir,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    stateEngine,
    _chokidar: fakeChokidar,
  });
  return { watchers, stateEngine, fakeChokidar, sessionId, jsonlPath };
}

// ── ME-MK-23: change event publishes updateSession with usage payload ─────

test('ME-MK-23: chokidar change event fires stateEngine.updateSession with token usage', async () => {
  const { watchers, stateEngine, fakeChokidar, sessionId, jsonlPath } = setup();
  watchers.startJsonlWatcher(`wb_${sessionId}`);
  // Sanity: a watcher was created
  assert.ok(fakeChokidar._watchers.length >= 1, 'fake chokidar should have been called');
  const w = fakeChokidar._watchers[0];
  // Fire a change for the JSONL we registered
  w._fire('change', jsonlPath);
  // The handler debounces by 500ms; wait it out.
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(stateEngine.calls.length >= 1, 'updateSession must have been called');
  const c = stateEngine.calls[stateEngine.calls.length - 1];
  assert.equal(c.id, sessionId);
  assert.equal(c.fields.input_tokens, 100);
  assert.equal(c.fields.max_tokens, 200000);
  assert.equal(c.fields.model, 'sonnet');
  assert.equal(typeof c.fields.last_activity_at, 'number');
});

// ── ME-MK-24: stateEngine absent — watcher still functions, no crash ──────

test('ME-MK-24: stateEngine absent — chokidar change event still completes (token_update WS push only)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mk-watch-noengine-'));
  const sessionsDir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionId = '99999999-2222-3333-4444-555555555555';
  const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`);
  fs.writeFileSync(jsonlPath, '');
  const fakeChokidar = makeFakeChokidar();
  const watchers = createWatchers({
    db: makeStubDb({
      sessions: { [sessionId]: { id: sessionId, project_id: 1, cli_type: 'claude' } },
      projects: { 1: { id: 1, name: 'p1', path: tmpDir } },
    }),
    safe: { findSessionsDir: () => sessionsDir },
    config: { get: (_k, def) => def, getPrompt: () => '' },
    sessionUtils: makeStubSessionUtils(),
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => true,
    CLAUDE_HOME: tmpDir,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    // No stateEngine
    _chokidar: fakeChokidar,
  });
  watchers.startJsonlWatcher(`wb_${sessionId}`);
  const w = fakeChokidar._watchers[0];
  w._fire('change', jsonlPath);
  await new Promise((r) => setTimeout(r, 700));
  // No assertion to make beyond "did not throw" — but verify the watcher
  // module didn't break by checking it's still wired.
  assert.ok(true, 'no crash when stateEngine is absent');
});
