'use strict';

// #462: Behavioral test — per-request claimedGemini/claimedCodex Sets shared
// across all projects in one /api/state response. A single disk session must
// only be claimed by the first project that processes it, not by subsequent
// projects in the same request.
//
// #463: Behavioral test — buildSessionList timestamp priority. Claude sessions
// must use db.getSessionMeta.timestamp (real last-message time); Gemini/Codex
// must use discovery file timestamp when it is newer than db.updated_at.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const Database = require('better-sqlite3');
const { withServer, req } = require('../helpers/with-server');
const registerCoreRoutes = require('../../src/routes');
const safe = require('../../src/safe-exec');
const config = require('../../src/config');

// ── Shared DB + app factory ───────────────────────────────────────────────────

function makeStateTestApp(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-state-'));
  const WORKSPACE = path.join(tmpDir, 'workspace');
  const CLAUDE_HOME = path.join(tmpDir, 'claude');
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.mkdirSync(CLAUDE_HOME, { recursive: true });

  const dbFile = path.join(tmpDir, 'test.db');
  const rawDb = new Database(dbFile);
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL UNIQUE,
      notes TEXT DEFAULT '',
      state TEXT DEFAULT 'active',
      program_id INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT,
      cli_type TEXT DEFAULT 'claude',
      cli_session_id TEXT DEFAULT NULL,
      state TEXT DEFAULT 'active',
      archived INTEGER DEFAULT 0,
      notes TEXT DEFAULT '',
      user_renamed INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      file_path TEXT,
      timestamp TEXT,
      message_count INTEGER DEFAULT 0,
      model TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
  `);

  // Minimal DB wrapper used by registerCoreRoutes
  const db = {
    getProjects: () => rawDb.prepare('SELECT * FROM projects WHERE state != ?').all('archived'),
    getProject: (n) => rawDb.prepare('SELECT * FROM projects WHERE name = ?').get(n),
    getProjectById: (id) => rawDb.prepare('SELECT * FROM projects WHERE id = ?').get(id),
    ensureProject: (n, p) => {
      rawDb.prepare('INSERT OR IGNORE INTO projects (name, path) VALUES (?, ?)').run(n, p);
      return rawDb.prepare('SELECT * FROM projects WHERE name = ?').get(n);
    },
    getSessionsForProject: (pid) => rawDb.prepare('SELECT * FROM sessions WHERE project_id = ?').all(pid),
    getSession: (id) => rawDb.prepare('SELECT * FROM sessions WHERE id = ?').get(id),
    getSessionFull: (id) => {
      const s = rawDb.prepare('SELECT s.*, p.name AS project_name FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = ?').get(id);
      return s;
    },
    upsertSession: (id, pid, name) => {
      rawDb.prepare('INSERT OR IGNORE INTO sessions (id, project_id, name, updated_at) VALUES (?, ?, ?, datetime(\'now\'))').run(id, pid, name);
    },
    setCliSessionId: (id, cliSessionId) => {
      rawDb.prepare('UPDATE sessions SET cli_session_id = ? WHERE id = ?').run(cliSessionId, id);
    },
    getSessionMeta: (id) => rawDb.prepare('SELECT * FROM session_meta WHERE session_id = ?').get(id),
    deleteSession: (id) => rawDb.prepare('DELETE FROM sessions WHERE id = ?').run(id),
    renameSession: () => {},
    setSessionState: () => {},
    setSessionNotes: () => {},
    getSessionNotes: () => '',
    getAllSettings: () => ({}),
    getSetting: (k, fb = null) => {
      const r = rawDb.prepare('SELECT value FROM settings WHERE key = ?').get(k);
      return r ? r.value : fb;
    },
    setSetting: () => {},
    getAllPrograms: () => [],
    getProgram: () => null,
    getProgramByName: () => null,
    addProgram: () => ({ id: 1, name: 'test' }),
    updateProgram: (id, f) => ({ id, ...f }),
    deleteProgram: () => {},
    countProjectsInProgram: () => 0,
    setProjectProgram: () => {},
    renameProgramSafe: (id, n) => ({ id, name: n }),
    getProjectNotes: () => '',
    setProjectNotes: () => {},
    setProjectState: () => {},
    renameProject: () => {},
    DATA_DIR: '/tmp',
    // test helpers: expose rawDb for assertions
    _raw: rawDb,
    ...(overrides.db || {}),
  };

  // Custom sessionUtils with injectable mocks for discovery
  const sessionUtils = {
    parseSessionFile: async () => null,  // no real JSONL files in test
    discoverGeminiSessions: overrides.discoverGeminiSessions || (() => []),
    discoverCodexSessions: overrides.discoverCodexSessions || (() => []),
    getSessionInfo: async () => null,
    invalidateSessionInfoCache: () => {},
    invalidateDiscoveryCache: () => {},
    // other methods unused by /api/state
    ...((overrides.sessionUtils) || {}),
  };

  const app = express();
  app.use(express.json());

  registerCoreRoutes(app, {
    db,
    safe: {
      ...safe,
      WORKSPACE,
      resolveProjectPath: (n) => path.join(WORKSPACE, n),
      findSessionsDir: () => path.join(tmpDir, 'no-sessions'),   // empty — no JSONLs
      tmuxExists: async () => false,
      tmuxExecAsync: async () => '',
      tmuxSendKeysAsync: async () => {},
      tmuxKill: async () => {},
    },
    config,
    sessionUtils,
    keepalive: { getStatus: async () => ({}), setMode() {}, getMode: () => 'always', isRunning: () => false, start() {}, stop() {} },
    fireEvent: () => {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    enforceTmuxLimit: async () => {},
    resolveSessionId: async () => {},
    getBrowserCount: () => 0,
    CLAUDE_HOME,
    WORKSPACE,
    ensureSettings: async () => {},
    sleep: async () => {},
  });

  return { app, db, rawDb, WORKSPACE, CLAUDE_HOME, tmpDir };
}

// Helper: insert a project + session directly into the raw DB
function plantProject(rawDb, { name, path: projPath, sessions = [] }) {
  rawDb.prepare('INSERT INTO projects (name, path) VALUES (?, ?)').run(name, projPath);
  const proj = rawDb.prepare('SELECT * FROM projects WHERE name = ?').get(name);
  for (const s of sessions) {
    rawDb.prepare(
      'INSERT INTO sessions (id, project_id, name, cli_type, cli_session_id, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(s.id, proj.id, s.name || s.id, s.cli_type || 'claude', s.cli_session_id || null, s.updated_at || '2026-01-01T00:00:00.000Z', s.created_at || '2026-01-01T00:00:00.000Z');
    if (s.meta) {
      rawDb.prepare('INSERT INTO session_meta (session_id, timestamp, message_count, model) VALUES (?, ?, ?, ?)').run(s.id, s.meta.timestamp || null, s.meta.message_count || 0, s.meta.model || '');
    }
  }
  return proj;
}

// ── #462 — per-request claimed Set behavioral tests ──────────────────────────

test('#462-CLAIM-01: single disk Gemini session claimed by first project, not second', async () => {
  const diskSession = { sessionId: 'gem-disk-abc', filePath: '/fake/gem-disk-abc.jsonl', timestamp: '2026-01-02T00:00:00.000Z' };

  const { app, rawDb, WORKSPACE } = makeStateTestApp({
    discoverGeminiSessions: () => [diskSession],
  });

  // Two projects, each with 1 unbound Gemini session (no cli_session_id)
  const pathA = path.join(WORKSPACE, 'proj-a');
  const pathB = path.join(WORKSPACE, 'proj-b');
  fs.mkdirSync(pathA, { recursive: true });
  fs.mkdirSync(pathB, { recursive: true });
  plantProject(rawDb, { name: 'proj-a', path: pathA, sessions: [{ id: 'sess-ga', cli_type: 'gemini' }] });
  plantProject(rawDb, { name: 'proj-b', path: pathB, sessions: [{ id: 'sess-gb', cli_type: 'gemini' }] });

  await withServer(app, async ({ port }) => {
    const r = await req(port, 'GET', '/api/state');
    assert.equal(r.status, 200);
    await r.json(); // consume response
  });

  // After the /api/state call, the disk session must be claimed by exactly ONE session.
  const sessA = rawDb.prepare('SELECT cli_session_id FROM sessions WHERE id = ?').get('sess-ga');
  const sessB = rawDb.prepare('SELECT cli_session_id FROM sessions WHERE id = ?').get('sess-gb');

  const claimedCount = [sessA.cli_session_id, sessB.cli_session_id].filter(v => v === 'gem-disk-abc').length;
  assert.equal(claimedCount, 1,
    `disk session 'gem-disk-abc' must be claimed by exactly 1 session across both projects; ` +
    `got sessA=${sessA.cli_session_id}, sessB=${sessB.cli_session_id}`);
});

test('#462-CLAIM-02: three projects — single disk file claimed by exactly one, others remain unbound', async () => {
  const diskSession = { sessionId: 'gem-disk-xyz', filePath: '/fake/gem-disk-xyz.jsonl', timestamp: '2026-01-02T00:00:00.000Z' };

  const { app, rawDb, WORKSPACE } = makeStateTestApp({
    discoverGeminiSessions: () => [diskSession],
  });

  for (const label of ['alpha', 'beta', 'gamma']) {
    const p = path.join(WORKSPACE, label);
    fs.mkdirSync(p, { recursive: true });
    plantProject(rawDb, { name: label, path: p, sessions: [{ id: `sess-${label}`, cli_type: 'gemini' }] });
  }

  await withServer(app, async ({ port }) => {
    const r = await req(port, 'GET', '/api/state');
    assert.equal(r.status, 200);
    await r.json();
  });

  const counts = ['alpha', 'beta', 'gamma'].map(l => {
    const row = rawDb.prepare('SELECT cli_session_id FROM sessions WHERE id = ?').get(`sess-${l}`);
    return row.cli_session_id;
  });
  const claimed = counts.filter(v => v === 'gem-disk-xyz').length;
  assert.equal(claimed, 1,
    `disk session claimed by ${claimed} sessions across 3 projects; expected exactly 1. ` +
    `Values: ${JSON.stringify(counts)}`);
});

test('#462-CLAIM-03: two disk files — each project claims its own unambiguously', async () => {
  const diskSessions = [
    { sessionId: 'gem-file-1', filePath: '/fake/gem-file-1.jsonl', timestamp: '2026-01-01T01:00:00.000Z' },
    { sessionId: 'gem-file-2', filePath: '/fake/gem-file-2.jsonl', timestamp: '2026-01-01T02:00:00.000Z' },
  ];

  const { app, rawDb, WORKSPACE } = makeStateTestApp({
    discoverGeminiSessions: () => diskSessions,
  });

  for (const label of ['p1', 'p2']) {
    const p = path.join(WORKSPACE, label);
    fs.mkdirSync(p, { recursive: true });
    plantProject(rawDb, { name: label, path: p, sessions: [{ id: `sess-${label}`, cli_type: 'gemini' }] });
  }

  await withServer(app, async ({ port }) => {
    await (await req(port, 'GET', '/api/state')).json();
  });

  const ids = ['p1', 'p2'].map(l => rawDb.prepare('SELECT cli_session_id FROM sessions WHERE id = ?').get(`sess-${l}`).cli_session_id);
  // Both sessions should have distinct cli_session_ids
  assert.ok(ids[0] !== null && ids[1] !== null, `both sessions should get a cli_session_id; got ${JSON.stringify(ids)}`);
  assert.notEqual(ids[0], ids[1], `each session must claim a different disk file; both got ${ids[0]}`);
});

// ── #463 — buildSessionList timestamp priority behavioral tests ───────────────

test('#463-TS-01: Claude session — response uses session_meta.timestamp not db.updated_at', async () => {
  const META_TS = '2026-05-10T12:00:00.000Z';   // real last-message time
  const DB_UPDATED = '2026-05-12T00:00:00.000Z'; // db.updated_at (always bumped by poll)
  // META_TS < DB_UPDATED, but META_TS must win because it is the real activity time

  const { app, rawDb, WORKSPACE } = makeStateTestApp();

  const projPath = path.join(WORKSPACE, 'claude-proj');
  fs.mkdirSync(projPath, { recursive: true });
  plantProject(rawDb, {
    name: 'claude-proj', path: projPath,
    sessions: [{
      id: 'claude-sess-1', cli_type: 'claude',
      updated_at: DB_UPDATED,
      meta: { timestamp: META_TS, message_count: 5, model: 'claude-sonnet' },
    }],
  });

  await withServer(app, async ({ port }) => {
    const body = await (await req(port, 'GET', '/api/state')).json();
    const project = body.projects.find(p => p.name === 'claude-proj');
    assert.ok(project, 'claude-proj must appear in /api/state response');
    const session = project.sessions.find(s => s.id === 'claude-sess-1');
    assert.ok(session, 'claude-sess-1 must appear in project sessions');
    assert.equal(session.timestamp, META_TS,
      `Claude session must use session_meta.timestamp (${META_TS}) not db.updated_at (${DB_UPDATED}). Got: ${session.timestamp}`);
  });
});

test('#463-TS-02: Gemini session — uses discovery timestamp when newer than db.updated_at', async () => {
  const DB_UPDATED = '2026-05-01T00:00:00.000Z';  // stale — frozen at session creation
  const DISK_TS = '2026-05-10T15:00:00.000Z';     // newer: file was written during conversation

  const { app, rawDb, WORKSPACE } = makeStateTestApp({
    discoverGeminiSessions: () => [{
      sessionId: 'gem-sess-id-1',
      filePath: '/fake/gem-sess-id-1.jsonl',
      timestamp: DISK_TS,
    }],
  });

  const projPath = path.join(WORKSPACE, 'gemini-proj');
  fs.mkdirSync(projPath, { recursive: true });
  plantProject(rawDb, {
    name: 'gemini-proj', path: projPath,
    sessions: [{ id: 'sess-gem-1', cli_type: 'gemini', cli_session_id: 'gem-sess-id-1', updated_at: DB_UPDATED }],
  });

  await withServer(app, async ({ port }) => {
    const body = await (await req(port, 'GET', '/api/state')).json();
    const project = body.projects.find(p => p.name === 'gemini-proj');
    const session = project?.sessions?.find(s => s.id === 'sess-gem-1');
    assert.ok(session, 'sess-gem-1 must appear in response');
    assert.equal(session.timestamp, DISK_TS,
      `Gemini session with cli_session_id must use discovery timestamp (${DISK_TS}) when newer than db.updated_at (${DB_UPDATED}). Got: ${session.timestamp}`);
  });
});

test('#463-TS-03: Gemini session — keeps db.updated_at when disk timestamp is older', async () => {
  const DB_UPDATED = '2026-05-10T15:00:00.000Z';  // newer
  const DISK_TS = '2026-05-01T00:00:00.000Z';     // older — stale cache hit

  const { app, rawDb, WORKSPACE } = makeStateTestApp({
    discoverGeminiSessions: () => [{
      sessionId: 'gem-sess-old',
      filePath: '/fake/gem-sess-old.jsonl',
      timestamp: DISK_TS,
    }],
  });

  const projPath = path.join(WORKSPACE, 'gemini-stale');
  fs.mkdirSync(projPath, { recursive: true });
  plantProject(rawDb, {
    name: 'gemini-stale', path: projPath,
    sessions: [{ id: 'sess-gem-stale', cli_type: 'gemini', cli_session_id: 'gem-sess-old', updated_at: DB_UPDATED }],
  });

  await withServer(app, async ({ port }) => {
    const body = await (await req(port, 'GET', '/api/state')).json();
    const project = body.projects.find(p => p.name === 'gemini-stale');
    const session = project?.sessions?.find(s => s.id === 'sess-gem-stale');
    assert.ok(session, 'sess-gem-stale must appear in response');
    assert.equal(session.timestamp, DB_UPDATED,
      `When disk timestamp (${DISK_TS}) is older than db.updated_at (${DB_UPDATED}), db.updated_at must win. Got: ${session.timestamp}`);
  });
});

test('#463-TS-04: sessions sorted newest-first in response', async () => {
  const TS_NEWER = '2026-05-10T20:00:00.000Z';
  const TS_OLDER = '2026-05-10T10:00:00.000Z';

  const { app, rawDb, WORKSPACE } = makeStateTestApp();

  const projPath = path.join(WORKSPACE, 'sort-proj');
  fs.mkdirSync(projPath, { recursive: true });
  plantProject(rawDb, {
    name: 'sort-proj', path: projPath,
    sessions: [
      { id: 'sess-older', cli_type: 'claude', updated_at: TS_OLDER, meta: { timestamp: TS_OLDER } },
      { id: 'sess-newer', cli_type: 'claude', updated_at: TS_NEWER, meta: { timestamp: TS_NEWER } },
    ],
  });

  await withServer(app, async ({ port }) => {
    const body = await (await req(port, 'GET', '/api/state')).json();
    const project = body.projects.find(p => p.name === 'sort-proj');
    assert.ok(project, 'sort-proj must appear');
    assert.equal(project.sessions[0].id, 'sess-newer',
      `sessions must be sorted newest-first; first was ${project.sessions[0].id}`);
    assert.equal(project.sessions[1].id, 'sess-older',
      `second session must be the older one; got ${project.sessions[1].id}`);
  });
});
