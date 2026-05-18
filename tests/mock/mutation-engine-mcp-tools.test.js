'use strict';

// ME-MK-25..28: #651 commit 7e — session_new / session_config MCP handlers
// publish through stateEngine via the module-level setStateEngine setter.

const test = require('node:test');
const assert = require('node:assert/strict');
const mcpTools = require('../../src/mcp-tools');
const db = require('../../src/db');

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

// Seed a real project in the test DB so session_new can find it.
const PROJ_NAME = `me-mk-mcp-${Date.now()}`;
const PROJ_PATH = require('node:os').tmpdir();
// Wipe any prior test run's project row + sessions
try {
  const stale = db.getProject(PROJ_NAME);
  if (stale) {
    for (const s of (db.getSessionsForProject(stale.id) || [])) db.deleteSession(s.id);
    db.deleteProject(stale.id);
  }
} catch { /* fresh DB */ }
const proj = db.ensureProject(PROJ_NAME, PROJ_PATH);

// ── ME-MK-25: session_new publishes upsertProject + upsertSession ─────────────

test('ME-MK-25: session_new MCP handler fires stateEngine.upsertSession via setStateEngine', async () => {
  const stateEngine = makeRecorder();
  mcpTools.setStateEngine(stateEngine);
  try {
    // session_new spawns tmux as a side-effect; the test sandbox stubs tmux
    // (via the same safe-exec test stub the rest of the suite uses) so this
    // returns a session_id without leaving real processes behind.
    const result = await mcpTools.handlers.session_new({
      project: PROJ_NAME,
      name: 'me-mk-25 session',
      cli: 'codex',
    });
    assert.ok(result.session_id);
    const upserts = stateEngine.calls.filter((c) => c.method === 'upsertSession');
    assert.equal(upserts.length, 1, 'exactly one upsertSession per session_new');
    assert.equal(upserts[0].args[0].id, result.session_id);
    assert.equal(upserts[0].args[0].project_path, PROJ_PATH);
    assert.equal(upserts[0].args[0].cli_type, 'codex');
    assert.equal(upserts[0].args[0].name, 'me-mk-25 session');
    // Project published BEFORE session (engine.upsertSession asserts project exists)
    const projIdx = stateEngine.calls.findIndex((c) => c.method === 'upsertProject');
    const sessIdx = stateEngine.calls.findIndex((c) => c.method === 'upsertSession');
    assert.ok(projIdx >= 0 && projIdx < sessIdx, 'upsertProject must precede upsertSession');
    // hidden defaults to true (MCP-spawned)
    const stateUpdate = stateEngine.calls.find(
      (c) => c.method === 'updateSession' && c.args[1] && c.args[1].state === 'hidden'
    );
    assert.ok(stateUpdate, 'hidden default → updateSession({state:"hidden"})');
    // Clean up the session row so subsequent tests don't pile rows in test DB
    try { db.deleteSession(result.session_id); } catch { /* ok */ }
  } finally {
    mcpTools.setStateEngine(null);
  }
});

// ── ME-MK-26: session_config publishes per-field updateSession ─────────────────

test('ME-MK-26: session_config MCP handler fires updateSession per field', async () => {
  const stateEngine = makeRecorder();
  mcpTools.setStateEngine(stateEngine);
  try {
    // Seed a session row directly (skipping session_new) to test session_config.
    const sessId = `me-mk-26-${Date.now()}`;
    db.upsertSession(sessId, proj.id, 'pre', 'claude');
    try {
      await mcpTools.handlers.session_config({
        session_id: sessId, name: 'post', state: 'archived', notes: 'n',
      });
      const updates = stateEngine.calls.filter((c) => c.method === 'updateSession');
      assert.equal(updates.length, 3);
      assert.deepEqual(updates[0].args[1], { name: 'post' });
      assert.deepEqual(updates[1].args[1], { state: 'archived', archived: true });
      assert.deepEqual(updates[2].args[1], { notes: 'n' });
    } finally {
      db.deleteSession(sessId);
    }
  } finally {
    mcpTools.setStateEngine(null);
  }
});

// ── ME-MK-27: setStateEngine(null) → no-op ─────────────────────────────────────

test('ME-MK-27: setStateEngine(null) — handlers do not crash', async () => {
  mcpTools.setStateEngine(null);
  const sessId = `me-mk-27-${Date.now()}`;
  db.upsertSession(sessId, proj.id, 'pre', 'claude');
  try {
    await mcpTools.handlers.session_config({ session_id: sessId, name: 'post' });
  } finally {
    db.deleteSession(sessId);
  }
});

// ── ME-MK-28: engine throws — handler still completes ─────────────────────────

test('ME-MK-28: stateEngine throws — handler does not propagate the error', async () => {
  mcpTools.setStateEngine({
    upsertProject() { throw new Error('engine boom'); },
    upsertSession() { throw new Error('engine boom'); },
    updateSession() { throw new Error('engine boom'); },
    removeSession() {},
    removeProject() {},
    upsertProgram() {},
    removeProgram() {},
  });
  try {
    const sessId = `me-mk-28-${Date.now()}`;
    db.upsertSession(sessId, proj.id, 'pre', 'claude');
    try {
      // Should NOT throw despite the engine throwing
      await mcpTools.handlers.session_config({ session_id: sessId, name: 'post-throws' });
    } finally {
      db.deleteSession(sessId);
    }
  } finally {
    mcpTools.setStateEngine(null);
  }
});

// Cleanup the project row at the end of the file
test('ME-MK-mcp cleanup: drop the test project row', () => {
  try {
    const p = db.getProject(PROJ_NAME);
    if (p) {
      for (const s of (db.getSessionsForProject(p.id) || [])) db.deleteSession(s.id);
      db.deleteProject(p.id);
    }
  } catch { /* ok */ }
});
