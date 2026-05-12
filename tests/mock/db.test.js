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
  // #480: addTask v2 contract — { projectId, title, createdBy }.
  // Status enum is inactive/active/blocked/done/cancelled (default inactive).
  // Lookup is by project_id (not folder_path); folder_path is set automatically
  // from the project's path via the addTaskV2 INSERT.
  await withDb(async (db) => {
    const proj = db.ensureProject('proj', '/workspace/proj');
    const t = db.addTask({ projectId: proj.id, title: 'Do it', createdBy: 'agent' });
    assert.equal(t.status, 'inactive');
    assert.equal(t.created_by, 'agent');
    assert.equal(t.folder_path, '/workspace/proj');
    db.setTaskStatus(t.id, 'done');
    const completed = db.getTasksByProject(proj.id)[0];
    assert.equal(completed.status, 'done');
    assert.ok(completed.completed_at);
    db.setTaskStatus(t.id, 'inactive');
    const reopened = db.getTasksByProject(proj.id)[0];
    assert.equal(reopened.status, 'inactive');
    assert.equal(reopened.completed_at, null);
    db.deleteTask(t.id);
    assert.equal(db.getTasksByProject(proj.id).length, 0);
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

test('DB-MOVE-01 [A2 #327]: moveTask cross-bucket inserts at target rank, [1,2,moved,3,4]', async () => {
  await withDb(async (db) => {
    const projA = db.ensureProject('A', '/workspace/A');
    const projB = db.ensureProject('B', '/workspace/B');
    // Seed bucket B with 4 tasks at ranks 1..4
    const b1 = db.addTask({ projectId: projB.id, title: 'b1' });
    const b2 = db.addTask({ projectId: projB.id, title: 'b2' });
    const b3 = db.addTask({ projectId: projB.id, title: 'b3' });
    const b4 = db.addTask({ projectId: projB.id, title: 'b4' });
    assert.deepEqual([b1.rank, b2.rank, b3.rank, b4.rank], [1, 2, 3, 4]);

    // Source task in bucket A
    const moving = db.addTask({ projectId: projA.id, title: 'moving' });

    // Move into bucket B at rank 3 — between b2 and b3
    const moved = db.moveTask(moving.id, { projectId: projB.id, rank: 3 });
    assert.equal(moved.project_id, projB.id);
    assert.equal(moved.rank, 3);

    // Assert final ordering in bucket B is [b1, b2, moved, b3, b4]
    const final = db.db
      .prepare('SELECT id, title, rank FROM tasks WHERE project_id = ? AND parent_task_id IS NULL ORDER BY rank ASC')
      .all(projB.id);
    assert.deepEqual(
      final.map((t) => t.title),
      ['b1', 'b2', 'moving', 'b3', 'b4'],
      `expected [b1,b2,moving,b3,b4], got ${JSON.stringify(final.map((t) => t.title))}`,
    );
    assert.deepEqual(
      final.map((t) => t.rank),
      [1, 2, 3, 4, 5],
      `ranks must densify to 1..5 after move`,
    );

    // Source bucket A must be empty (densified)
    const aFinal = db.db
      .prepare('SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND parent_task_id IS NULL').get(projA.id);
    assert.equal(aFinal.c, 0);
  });
});

test('DB-MOVE-02 [A2 #327]: moveTask same-bucket rerank densifies without shifting other buckets', async () => {
  await withDb(async (db) => {
    const proj = db.ensureProject('P', '/workspace/P');
    const t1 = db.addTask({ projectId: proj.id, title: 't1' });
    const t2 = db.addTask({ projectId: proj.id, title: 't2' });
    const t3 = db.addTask({ projectId: proj.id, title: 't3' });
    const t4 = db.addTask({ projectId: proj.id, title: 't4' });

    // Move t4 to rank 1 — should produce [t4, t1, t2, t3]
    db.moveTask(t4.id, { rank: 1 });
    const order = db.db
      .prepare('SELECT title FROM tasks WHERE project_id = ? AND parent_task_id IS NULL ORDER BY rank ASC')
      .all(proj.id)
      .map((t) => t.title);
    assert.deepEqual(order, ['t4', 't1', 't2', 't3']);
  });
});

test('DB-MOVE-03 [A2 #327]: moveTask atomic — failure does not leave partial state', async () => {
  await withDb(async (db) => {
    const projA = db.ensureProject('A', '/workspace/A');
    const t1 = db.addTask({ projectId: projA.id, title: 't1' });
    const t2 = db.addTask({ projectId: projA.id, title: 't2', parentTaskId: t1.id });
    // Attempting to reparent t1 under its own descendant t2 must throw cycle error.
    assert.throws(() => db.moveTask(t1.id, { parentTaskId: t2.id }), /cycle/);
    // State unchanged
    const state = db.db.prepare('SELECT id, parent_task_id, rank FROM tasks WHERE project_id = ? ORDER BY id').all(projA.id);
    assert.deepEqual(state, [
      { id: t1.id, parent_task_id: null, rank: 1 },
      { id: t2.id, parent_task_id: t1.id, rank: 1 },
    ]);
  });
});
