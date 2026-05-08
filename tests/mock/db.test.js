'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { freshRequire } = require('../helpers/module');

const DB_PATH = path.join(__dirname, '..', '..', 'src', 'db.js');

async function withDb(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-db-'));
  const prev = process.env.WORKBENCH_DATA;
  process.env.WORKBENCH_DATA = dir;
  try {
    const db = freshRequire(DB_PATH);
    await fn(db, dir);
  } finally {
    if (prev === undefined) delete process.env.WORKBENCH_DATA;
    else process.env.WORKBENCH_DATA = prev;
  }
}

test('DB-01: schema creates 6 tables with WAL mode', async () => {
  await withDb(async (db) => {
    const tables = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const t of ['projects', 'sessions', 'tasks', 'settings', 'session_meta']) {
      assert.ok(tables.includes(t), `missing table ${t}`);
    }
    assert.equal(String(db.db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
  });
});

test('DB-02: migrations are idempotent', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-db-mig-'));
  const prev = process.env.WORKBENCH_DATA;
  process.env.WORKBENCH_DATA = dir;
  try {
    const db1 = freshRequire(DB_PATH);
    const cols1 = db1.db
      .prepare('PRAGMA table_info(sessions)')
      .all()
      .map((r) => r.name);
    const db2 = freshRequire(DB_PATH);
    const cols2 = db2.db
      .prepare('PRAGMA table_info(sessions)')
      .all()
      .map((r) => r.name);
    assert.deepEqual(cols2.sort(), cols1.sort());
  } finally {
    if (prev === undefined) delete process.env.WORKBENCH_DATA;
    else process.env.WORKBENCH_DATA = prev;
  }
});

test('DB-03 / ENG-16: ensureProject is idempotent and CRUD works', async () => {
  await withDb(async (db) => {
    const a = db.ensureProject('proj', '/workspace/proj');
    const b = db.ensureProject('proj', '/workspace/proj');
    assert.equal(a.id, b.id);
    assert.equal(db.db.prepare('SELECT count(*) as c FROM projects WHERE name=?').get('proj').c, 1);
    assert.ok(db.getProject('proj'));
    db.deleteProject(a.id);
    assert.equal(db.getProject('proj'), undefined);
  });
});

test('DB-04: session CRUD and state transitions', async () => {
  await withDb(async (db) => {
    const p = db.ensureProject('proj', '/workspace/proj');
    db.upsertSession('s1', p.id, 'Name');
    assert.equal(db.getSession('s1').name, 'Name');
    db.renameSession('s1', 'New');
    assert.equal(db.getSession('s1').name, 'New');
    db.setSessionState('s1', 'archived');
    assert.equal(db.getSession('s1').state, 'archived');
    db.setSessionState('s1', 'hidden');
    assert.equal(db.getSession('s1').state, 'hidden');
    db.setSessionState('s1', 'active');
    assert.equal(db.getSession('s1').archived, 0);
    assert.equal(db.getSession('s1').state, 'active');
    db.deleteSession('s1');
    assert.equal(db.getSession('s1'), undefined);
  });
});

test('DB-05: task CRUD lifecycle', async () => {
  await withDb(async (db) => {
    const t = db.addTask('/workspace/proj', 'Do it', '', null, 'agent');
    assert.equal(t.status, 'todo');
    assert.equal(t.created_by, 'agent');
    assert.equal(t.folder_path, '/workspace/proj');
    db.updateTaskStatus(t.id, 'done');
    const completed = db.getTasksByFolder('/workspace/proj')[0];
    assert.equal(completed.status, 'done');
    assert.ok(completed.completed_at);
    db.updateTaskStatus(t.id, 'todo');
    const reopened = db.getTasksByFolder('/workspace/proj')[0];
    assert.equal(reopened.status, 'todo');
    assert.equal(reopened.completed_at, null);
    db.deleteTask(t.id);
    assert.equal(db.getTasksByFolder('/workspace/proj').length, 0);
  });
});

test('DB-07: settings JSON and raw fallback', async () => {
  await withDb(async (db) => {
    db.setSetting('j', JSON.stringify({ a: 1 }));
    db.setSetting('r', 'plain');
    const all = db.getAllSettings();
    assert.deepEqual(all.j, { a: 1 });
    assert.equal(all.r, 'plain');
    assert.equal(db.getSetting('j'), JSON.stringify({ a: 1 }));
    assert.equal(db.getSetting('missing', 'def'), 'def');
  });
});

test('DB-08: session meta upsert/get/cleanStale', async () => {
  await withDb(async (db) => {
    db.upsertSessionMeta('s1', '/tmp/a.jsonl', 1, 10, 'One', '2026-01-01', 5);
    db.upsertSessionMeta('s2', '/tmp/b.jsonl', 2, 20, 'Two', '2026-01-02', 6);
    assert.equal(db.getSessionMeta('s1').name, 'One');
    assert.equal(db.getSessionMeta('s1').message_count, 5);
    db.cleanStaleMeta(new Set(['s2']));
    assert.equal(db.getSessionMeta('s1'), undefined);
    assert.equal(db.getSessionMeta('s2').name, 'Two');
  });
});

test('DB-09: delete project cascades sessions', async () => {
  await withDb(async (db) => {
    const p = db.ensureProject('proj', '/workspace/proj');
    db.upsertSession('s1', p.id, 'S');
    assert.ok(db.db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c > 0);
    db.deleteProject(p.id);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);
  });
});

test('DB-10: getSessionByPrefix returns matching session', async () => {
  await withDb(async (db) => {
    const p = db.ensureProject('proj', '/workspace/proj');
    db.upsertSession('abc123def', p.id, 'One');
    const r = db.getSessionByPrefix('abc');
    assert.ok(r);
    assert.equal(r.id, 'abc123def');
    assert.equal(r.project_name, 'proj');
  });
});

test('DB-11: getSessionFull joins project name', async () => {
  await withDb(async (db) => {
    const p = db.ensureProject('proj', '/workspace/proj');
    db.upsertSession('s1', p.id, 'S');
    const full = db.getSessionFull('s1');
    assert.equal(full.project_name, 'proj');
    assert.equal(full.id, 's1');
  });
});

test('DB-12: concurrent upsertSession calls do not corrupt', async () => {
  await withDb(async (db) => {
    const p = db.ensureProject('proj', '/workspace/proj');
    db.upsertSession('s1', p.id, 'First');
    db.upsertSession('s1', p.id, 'Second');
    const s = db.getSession('s1');
    assert.ok(s);
    assert.equal(s.name, 'First');
  });
});

// #332 [A7]: renameProgramSafe atomically validates uniqueness and renames.
test('DB-PRG-01: renameProgramSafe renames a program when target name is free', async () => {
  await withDb(async (db) => {
    const a = db.addProgram('alpha');
    const out = db.renameProgramSafe(a.id, 'gamma');
    assert.equal(out.name, 'gamma');
    assert.equal(db.getProgram(a.id).name, 'gamma');
    assert.equal(db.getProgramByName('alpha'), undefined);
  });
});

test('DB-PRG-02: renameProgramSafe throws duplicate_name when another row owns the name', async () => {
  await withDb(async (db) => {
    const a = db.addProgram('alpha');
    db.addProgram('beta');
    let caught = null;
    try {
      db.renameProgramSafe(a.id, 'beta');
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'expected throw');
    assert.equal(caught.code, 'duplicate_name');
    // Ensure the rename did NOT take effect — transaction rolled back.
    assert.equal(db.getProgram(a.id).name, 'alpha');
  });
});

test('DB-PRG-03: renameProgramSafe is a no-op when newName equals current', async () => {
  await withDb(async (db) => {
    const a = db.addProgram('alpha');
    const out = db.renameProgramSafe(a.id, 'alpha');
    assert.equal(out.name, 'alpha');
  });
});
