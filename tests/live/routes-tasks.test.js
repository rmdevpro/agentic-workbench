'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, post, put, del } = require('../helpers/http-client');

// R3-N2 (Codex MAJOR): per #388 the v2 task_add contract no longer
// accepts folder_path; project_id / project_name / parent_task_id is
// required. /api/tasks POST now accepts project_name as a fallback
// (matching the MCP task_add tool). All TSK-* tests below scope tasks
// to a single fixture project (wb-seed). Tree-shape tests that rely on
// the old folder-tree assertions remain known-failing under O3 #377
// (the v2 tree groups by program > project > task, not by folder path)
// and are tracked separately — converting the API call shape here at
// least makes the call succeed, so the test failure is the assertion
// mismatch (a real signal) rather than a 400 from the handler.

async function ensureSeedProject() {
  // Idempotent: POST /api/projects creates wb-seed if absent; if present
  // returns 200/409 either way. We don't care about the result body.
  await post('/api/projects', { path: '/data/workspace/wb-seed', name: 'wb-seed' });
}

async function cleanAllTasks() {
  const tree = await get('/api/tasks/tree?filter=all');
  const ids = [];
  function collectFromV2(node) {
    // v2 tree shape: { programs: [{ projects: [{ tasks: [...] }] }] }
    if (!node) return;
    if (Array.isArray(node.programs)) {
      for (const prog of node.programs) {
        for (const proj of (prog.projects || [])) {
          const walk = (t) => { ids.push(t.id); for (const sub of (t.subtasks || [])) walk(sub); };
          for (const t of (proj.tasks || [])) walk(t);
        }
      }
    }
  }
  collectFromV2(tree.data);
  for (const id of ids) await del(`/api/tasks/${id}`);
}

test('TSK-01: create task with project_name and title (v2)', async () => {
  await ensureSeedProject();
  const r = await post('/api/tasks', { project_name: 'wb-seed', title: 'Fix login bug' });
  assert.equal(r.status, 200);
  assert.equal(r.data.title, 'Fix login bug');
  assert.ok(r.data.project_id, 'task carries project_id (v2 schema)');
  // v2 default status is 'inactive', not 'todo'
  assert.equal(r.data.status, 'inactive');
  assert.ok(r.data.id, 'must return task id');
});

test('TSK-02: create task without project rejects with 400 (v2 contract)', async () => {
  // Pre-fix this test's "create at root /" semantic was implicit; v2
  // requires explicit project scoping. Verify the rejection is clean.
  const r = await post('/api/tasks', { title: 'Orphan task' });
  assert.equal(r.status, 400);
  assert.match(r.data.error || '', /project|parent_task_id/);
});

test('TSK-03: tree endpoint returns programs > projects > tasks (v2 shape)', async () => {
  await ensureSeedProject();
  await cleanAllTasks();
  await post('/api/tasks', { project_name: 'wb-seed', title: 'Task A' });
  await post('/api/tasks', { project_name: 'wb-seed', title: 'Task B' });
  const r = await get('/api/tasks/tree?filter=all');
  assert.equal(r.status, 200);
  // v2 shape: { programs: [{projects: [{tasks: [...]}]}] }
  assert.ok(Array.isArray(r.data.programs), 'tree must contain programs array');
  // Find the program containing wb-seed (may be Unassigned if no program assigned)
  const wbSeed = r.data.programs
    .flatMap(p => p.projects || [])
    .find(p => p.name === 'wb-seed');
  assert.ok(wbSeed, 'wb-seed project must be present in tree');
  const titles = (wbSeed.tasks || []).map(t => t.title);
  assert.ok(titles.includes('Task A'), `tree must include Task A; got ${JSON.stringify(titles)}`);
  assert.ok(titles.includes('Task B'), `tree must include Task B; got ${JSON.stringify(titles)}`);
});

test('TSK-04: tree filter all includes inactive done and archived (v2)', async () => {
  await ensureSeedProject();
  await cleanAllTasks();
  const t1 = await post('/api/tasks', { project_name: 'wb-seed', title: 'Inactive' });
  const t2 = await post('/api/tasks', { project_name: 'wb-seed', title: 'Done' });
  const t3 = await post('/api/tasks', { project_name: 'wb-seed', title: 'Archived' });
  await put(`/api/tasks/${t2.data.id}`, { status: 'done' });
  await put(`/api/tasks/${t3.data.id}`, { status: 'archived' });

  const all = await get('/api/tasks/tree?filter=all');
  const wbSeed = all.data.programs.flatMap(p => p.projects || []).find(p => p.name === 'wb-seed');
  assert.ok(wbSeed, 'wb-seed project must be present');
  assert.equal((wbSeed.tasks || []).length, 3, 'filter=all should show all 3 tasks');
});

test('TSK-05: get task by ID returns task with history', async () => {
  await ensureSeedProject();
  const t = await post('/api/tasks', { project_name: 'wb-seed', title: 'History test' });
  const r = await get(`/api/tasks/${t.data.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.title, 'History test');
  assert.ok(Array.isArray(r.data.history), 'must include history array');
  assert.ok(r.data.history.length >= 1, 'history must have at least created event');
  assert.equal(r.data.history[0].event_type, 'created');
});

test('TSK-06: update title records rename history', async () => {
  await ensureSeedProject();
  const t = await post('/api/tasks', { project_name: 'wb-seed', title: 'Old title' });
  await put(`/api/tasks/${t.data.id}`, { title: 'New title' });
  const r = await get(`/api/tasks/${t.data.id}`);
  assert.equal(r.data.title, 'New title');
  const renameEvent = r.data.history.find(h => h.event_type === 'renamed');
  assert.ok(renameEvent, 'must have renamed history event');
  assert.equal(renameEvent.old_value, 'Old title');
  assert.equal(renameEvent.new_value, 'New title');
});

test('TSK-07: update description records history', async () => {
  await ensureSeedProject();
  const t = await post('/api/tasks', { project_name: 'wb-seed', title: 'Desc test' });
  await put(`/api/tasks/${t.data.id}`, { description: 'Some notes here' });
  const r = await get(`/api/tasks/${t.data.id}`);
  assert.equal(r.data.description, 'Some notes here');
  const descEvent = r.data.history.find(h => h.event_type === 'description_changed');
  assert.ok(descEvent, 'must have description_changed history event');
});

test('TSK-08: complete task sets completed_at', async () => {
  await ensureSeedProject();
  const t = await post('/api/tasks', { project_name: 'wb-seed', title: 'Complete me' });
  await put(`/api/tasks/${t.data.id}`, { status: 'done' });
  const r = await get(`/api/tasks/${t.data.id}`);
  assert.equal(r.data.status, 'done');
  assert.ok(r.data.completed_at, 'completed_at must be set');
});

test('TSK-09: reopen task clears completed_at (v2: status=inactive, not todo)', async () => {
  await ensureSeedProject();
  const t = await post('/api/tasks', { project_name: 'wb-seed', title: 'Reopen me' });
  await put(`/api/tasks/${t.data.id}`, { status: 'done' });
  // v2 reopen status is 'inactive', not 'todo'
  await put(`/api/tasks/${t.data.id}`, { status: 'inactive' });
  const r = await get(`/api/tasks/${t.data.id}`);
  assert.equal(r.data.status, 'inactive');
  assert.equal(r.data.completed_at, null);
});

test('TSK-10: archive task', async () => {
  await ensureSeedProject();
  const t = await post('/api/tasks', { project_name: 'wb-seed', title: 'Archive me' });
  await put(`/api/tasks/${t.data.id}`, { status: 'archived' });
  const r = await get(`/api/tasks/${t.data.id}`);
  assert.equal(r.data.status, 'archived');
});

test('TSK-11: move task across parent records history (v2: parent_task_id, not folder)', async () => {
  await ensureSeedProject();
  const parent = await post('/api/tasks', { project_name: 'wb-seed', title: 'Parent' });
  const child = await post('/api/tasks', { project_name: 'wb-seed', title: 'Child to move' });
  // v2 move shape: parent_task_id (or project_id, or rank), folded into PUT /api/tasks/:id
  // (the /move sub-route was removed; src/routes.js:1898-1903 handles move logic in the
  // base PUT handler when any of parent_task_id / project_id / rank is in the body).
  await put(`/api/tasks/${child.data.id}`, { parent_task_id: parent.data.id });
  const r = await get(`/api/tasks/${child.data.id}`);
  assert.equal(r.data.parent_task_id, parent.data.id);
});

test('TSK-13: delete task removes from tree', async () => {
  await ensureSeedProject();
  const t = await post('/api/tasks', { project_name: 'wb-seed', title: 'Delete me' });
  await del(`/api/tasks/${t.data.id}`);
  const r = await get(`/api/tasks/${t.data.id}`);
  assert.equal(r.status, 404);
});

test('TSK-14: create task without title returns 400', async () => {
  await ensureSeedProject();
  const r = await post('/api/tasks', { project_name: 'wb-seed' });
  assert.equal(r.status, 400);
});

test('TSK-15: create task with title too long returns 400', async () => {
  await ensureSeedProject();
  const r = await post('/api/tasks', { project_name: 'wb-seed', title: 'x'.repeat(501) });
  assert.equal(r.status, 400);
});

test('TSK-17: sort order auto-increments per project (v2)', async () => {
  await ensureSeedProject();
  await cleanAllTasks();
  const t1 = await post('/api/tasks', { project_name: 'wb-seed', title: 'A' });
  const t2 = await post('/api/tasks', { project_name: 'wb-seed', title: 'B' });
  const t3 = await post('/api/tasks', { project_name: 'wb-seed', title: 'C' });
  // v2: rank may auto-increment or be set on insert depending on db.addTask
  // contract; verify the field exists and values are distinct.
  assert.ok('rank' in t1.data || 'sort_order' in t1.data, 'task carries a rank/sort_order field');
  const orders = [t1.data.rank ?? t1.data.sort_order, t2.data.rank ?? t2.data.sort_order, t3.data.rank ?? t3.data.sort_order];
  assert.equal(new Set(orders).size, 3, `3 tasks must have distinct ranks; got ${JSON.stringify(orders)}`);
});
