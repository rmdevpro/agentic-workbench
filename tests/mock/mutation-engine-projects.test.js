'use strict';

// ME-MK-10..18: #651 commit 7b — every DB mutation in src/routes/projects.js
// publishes the matching update through the State Engine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { withServer, req } = require('../helpers/with-server');
const { register } = require('../../src/routes/projects');

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

function makeStubDb({ programs = [], projects = [] } = {}) {
  const projMap = new Map(projects.map((p) => [p.name, p]));
  const progMap = new Map(programs.map((p) => [p.id, p]));
  return {
    ensureProject: (name, path) => {
      const p = projMap.get(name) || { id: projMap.size + 1, name, path, state: 'active', program_id: null };
      projMap.set(name, p);
      return p;
    },
    getProject: (name) => projMap.get(name) || null,
    deleteProject: (id) => {
      for (const [k, v] of projMap) if (v.id === id) projMap.delete(k);
    },
    setProjectProgram: (id, programId) => {
      for (const v of projMap.values()) {
        if (v.id === id) { v.program_id = programId; return v; }
      }
      return null;
    },
    renameProject: (id, name) => {
      // Snapshot keys before mutating — iterating a live Map that we then
      // .set() into would revisit the new entry forever.
      for (const k of Array.from(projMap.keys())) {
        const v = projMap.get(k);
        if (v && v.id === id) {
          v.name = name;
          projMap.delete(k);
          projMap.set(name, v);
        }
      }
    },
    setProjectState: (id, state) => {
      for (const v of projMap.values()) if (v.id === id) v.state = state;
    },
    setProjectNotes: () => {},
    getSessionsForProject: () => [],
    clearProjectMcpEnabled: () => {},
    addProgram: (name, description) => {
      const p = { id: progMap.size + 1, name, description, status: 'active' };
      progMap.set(p.id, p);
      return p;
    },
    getProgram: (id) => progMap.get(id) || null,
    getProgramByName: (name) => Array.from(progMap.values()).find((p) => p.name === name) || null,
    deleteProgram: (id) => progMap.delete(id),
    renameProgramSafe: (id, name) => {
      const p = progMap.get(id);
      if (!p) return null;
      p.name = name;
      return p;
    },
    updateProgram: (id, fields) => {
      const p = progMap.get(id);
      if (!p) return null;
      Object.assign(p, fields);
      return p;
    },
    getAllPrograms: () => Array.from(progMap.values()),
    countProjectsInProgram: () => 0,
    getMcpServers: () => [],
    getEnabledMcpForProject: () => [],
    getMcpServer: () => null,
    enableMcpForProject: () => {},
    disableMcpForProject: () => {},
    getProjects: () => Array.from(projMap.values()),
    _projMap: projMap,
    _progMap: progMap,
  };
}

function makeStubSafe(tmpDir) {
  return {
    HOME: tmpDir,
    resolveProjectPath: (n) => path.join(tmpDir, n),
    findSessionsDir: (p) => path.join(p, 'sessions'),
    tmuxKill: async () => {},
    gitCloneAsync: async () => {},
    sanitizeErrorForClient: (s) => s,
  };
}

function mountProjects({ stateEngine, db, tmpDir }) {
  const app = express();
  app.use(express.json());
  // CLAUDE_HOME must exist on disk: trustDir writes .claude.json into it,
  // and routes/projects.js doesn't catch trustDir errors (the production
  // path's CLAUDE_HOME always exists).
  const claudeHome = path.join(tmpDir, 'claude-home');
  fs.mkdirSync(claudeHome, { recursive: true });
  // Express 4 async handlers — surface unhandled rejections so a hang here
  // shows up as a failing test instead of a hung listener.
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err && err.message || String(err) });
  });
  register(app, {
    db,
    safe: makeStubSafe(tmpDir),
    fireEvent: () => {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    stateEngine,
    tmuxName: (id) => `wb-${id}`,
    CLAUDE_HOME: claudeHome,
    WORKSPACE: tmpDir,
    sessionUtils: { invalidateDiscoveryCache: () => {} },
  });
  return app;
}

// Shared tmp project path; the POST handler stats this so it must exist.
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'me-mk-proj-'));
}

// ── ME-MK-10: POST /api/projects (direct path) ─────────────────────────────────

test('ME-MK-10: POST /api/projects with on-disk path fires upsertProject', async () => {
  const tmpDir = makeTmpDir();
  const stateEngine = makeRecorder();
  const db = makeStubDb();
  const app = mountProjects({ stateEngine, db, tmpDir });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'POST', '/api/projects', { path: tmpDir, name: 'p1' });
    assert.equal(r.status, 200);
    const upserts = stateEngine.calls.filter((c) => c.method === 'upsertProject');
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].args[0].path, tmpDir);
    assert.equal(upserts[0].args[0].name, 'p1');
    assert.equal(upserts[0].args[0].state, 'active');
  });
});

// ── ME-MK-11: POST /:name/remove ───────────────────────────────────────────────

test('ME-MK-11: POST /api/projects/:name/remove fires removeProject(path)', async () => {
  const tmpDir = makeTmpDir();
  const stateEngine = makeRecorder();
  const proj = { id: 1, name: 'p1', path: tmpDir, state: 'active', program_id: null };
  const db = makeStubDb({ projects: [proj] });
  const app = mountProjects({ stateEngine, db, tmpDir });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'POST', '/api/projects/p1/remove', {});
    assert.equal(r.status, 200);
    const removes = stateEngine.calls.filter((c) => c.method === 'removeProject');
    assert.equal(removes.length, 1);
    assert.equal(removes[0].args[0], tmpDir);
  });
});

// ── ME-MK-12: PUT /:name/program ───────────────────────────────────────────────

test('ME-MK-12: PUT /api/projects/:name/program fires upsertProject({program_id})', async () => {
  const tmpDir = makeTmpDir();
  const stateEngine = makeRecorder();
  const proj = { id: 1, name: 'p1', path: tmpDir, state: 'active', program_id: null };
  const prog = { id: 7, name: 'prog7', status: 'active' };
  const db = makeStubDb({ projects: [proj], programs: [prog] });
  const app = mountProjects({ stateEngine, db, tmpDir });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'PUT', '/api/projects/p1/program', { program_id: 7 });
    assert.equal(r.status, 200);
    const ups = stateEngine.calls.filter((c) => c.method === 'upsertProject');
    assert.equal(ups.length, 1);
    assert.equal(ups[0].args[0].path, tmpDir);
    assert.equal(ups[0].args[0].program_id, 7);
  });
});

// ── ME-MK-13: POST /api/programs ───────────────────────────────────────────────

test('ME-MK-13: POST /api/programs fires upsertProgram', async () => {
  const tmpDir = makeTmpDir();
  const stateEngine = makeRecorder();
  const db = makeStubDb();
  const app = mountProjects({ stateEngine, db, tmpDir });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'POST', '/api/programs', { name: 'newprog' });
    assert.equal(r.status, 200);
    const ups = stateEngine.calls.filter((c) => c.method === 'upsertProgram');
    assert.equal(ups.length, 1);
    assert.equal(ups[0].args[0].name, 'newprog');
  });
});

// ── ME-MK-14: PUT /api/programs/:id rename ─────────────────────────────────────

test('ME-MK-14: PUT /api/programs/:id rename fires upsertProgram with new name', async () => {
  const tmpDir = makeTmpDir();
  const stateEngine = makeRecorder();
  const prog = { id: 5, name: 'old', status: 'active' };
  const db = makeStubDb({ programs: [prog] });
  const app = mountProjects({ stateEngine, db, tmpDir });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'PUT', '/api/programs/5', { name: 'newname' });
    assert.equal(r.status, 200);
    const ups = stateEngine.calls.filter((c) => c.method === 'upsertProgram');
    assert.ok(ups.length >= 1, 'at least one upsertProgram');
    assert.equal(ups[ups.length - 1].args[0].name, 'newname');
  });
});

// ── ME-MK-15: DELETE /api/programs/:id ─────────────────────────────────────────

test('ME-MK-15: DELETE /api/programs/:id fires removeProgram', async () => {
  const tmpDir = makeTmpDir();
  const stateEngine = makeRecorder();
  const prog = { id: 9, name: 'doomed', status: 'active' };
  const db = makeStubDb({ programs: [prog] });
  const app = mountProjects({ stateEngine, db, tmpDir });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'DELETE', '/api/programs/9', {});
    assert.equal(r.status, 200);
    const rms = stateEngine.calls.filter((c) => c.method === 'removeProgram');
    assert.equal(rms.length, 1);
    assert.equal(rms[0].args[0], 9);
  });
});

// ── ME-MK-16: PUT /:name/config rename + state ─────────────────────────────────

test('ME-MK-16: PUT /api/projects/:name/config rename → upsertProject({name})', async () => {
  const tmpDir = makeTmpDir();
  const stateEngine = makeRecorder();
  const proj = { id: 1, name: 'p1', path: tmpDir, state: 'active', program_id: null };
  const db = makeStubDb({ projects: [proj] });
  const app = mountProjects({ stateEngine, db, tmpDir });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'PUT', '/api/projects/p1/config', { name: 'p1-renamed', state: 'archived' });
    assert.equal(r.status, 200);
    const ups = stateEngine.calls.filter((c) => c.method === 'upsertProject');
    assert.equal(ups.length, 2);
    assert.deepEqual(ups[0].args[0], { path: tmpDir, name: 'p1-renamed' });
    assert.deepEqual(ups[1].args[0], { path: tmpDir, state: 'archived' });
  });
});

// ── ME-MK-17: engine absent ────────────────────────────────────────────────────

test('ME-MK-17: stateEngine absent — POST /api/projects still succeeds and DB write completes', async () => {
  const tmpDir = makeTmpDir();
  const db = makeStubDb();
  const app = mountProjects({ stateEngine: undefined, db, tmpDir });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'POST', '/api/projects', { path: tmpDir, name: 'no-engine' });
    assert.equal(r.status, 200);
    assert.ok(db.getProject('no-engine'), 'DB write must complete even when engine is absent');
  });
});

// ── ME-MK-18: engine throws ────────────────────────────────────────────────────

test('ME-MK-18: stateEngine method throws — handler returns 200, DB write completes', async () => {
  const tmpDir = makeTmpDir();
  const stateEngine = {
    upsertProject() { throw new Error('engine boom'); },
    removeProject() { throw new Error('engine boom'); },
    upsertProgram() { throw new Error('engine boom'); },
    removeProgram() { throw new Error('engine boom'); },
  };
  const db = makeStubDb();
  const app = mountProjects({ stateEngine, db, tmpDir });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'POST', '/api/projects', { path: tmpDir, name: 'boom-survives' });
    assert.equal(r.status, 200, 'engine failure must not break the REST contract');
    assert.ok(db.getProject('boom-survives'), 'DB write must complete before engine call');
  });
});
