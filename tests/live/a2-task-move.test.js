'use strict';

// A2 #327: db.moveTask atomic reparent + rank assignment.
// Pre-fix: PATCH/PUT /api/tasks/:id with {project_id, rank} did
// setTaskRank then reparentTask — appending to end of new bucket.
// Post-fix: lands at the requested rank inside the new bucket.

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, post, put } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');
const { queryJson } = require('../helpers/db-query');

async function ensureProject(name, path) {
  dockerExec(`mkdir -p ${path}`);
  const r = await post('/api/projects', { path, name });
  if (r.status !== 200 && r.status !== 409) {
    throw new Error(`project create failed for ${name}: ${r.status} ${JSON.stringify(r.data)}`);
  }
  const rows = queryJson(`SELECT id, name, path FROM projects WHERE name = '${name}'`);
  if (!rows.length) throw new Error(`project ${name} not found in DB`);
  return rows[0];
}

async function addTask(projectId, title) {
  const r = await post('/api/tasks', { project_id: projectId, title, status: 'todo' });
  assert.equal(r.status, 200, `addTask ${title}: ${JSON.stringify(r.data)}`);
  return r.data;
}

async function getTopLevelTasksForProject(projectId) {
  const r = await get('/api/tasks/tree?filter=open&show_archived=1');
  assert.equal(r.status, 200);
  // tree is an array of project nodes; find ours
  const proj = r.data.find((p) => p.id === projectId || p.project_id === projectId);
  if (!proj) {
    // Fallback: query each task individually via /api/tasks/:id is not feasible without ids;
    // use the response shape variation by walking the tree
    for (const node of r.data) {
      if (node.tasks) {
        const fil = node.tasks.filter((t) => t.project_id === projectId && (t.parent_task_id == null || t.parent_task_id === 0));
        if (fil.length) return fil.sort((a, b) => a.rank - b.rank);
      }
    }
    return [];
  }
  return (proj.tasks || []).filter((t) => t.parent_task_id == null || t.parent_task_id === 0).sort((a, b) => a.rank - b.rank);
}

test('A2-LIVE-01: PUT /api/tasks/:id cross-bucket move lands at requested rank, not appended', async () => {
  await resetBaseline();
  const projA = await ensureProject('a2_proj_a', '/data/workspace/a2_proj_a');
  const projB = await ensureProject('a2_proj_b', '/data/workspace/a2_proj_b');

  // Seed bucket B with 4 tasks at ranks 1..4
  const b1 = await addTask(projB.id, 'a2-b1');
  const b2 = await addTask(projB.id, 'a2-b2');
  const b3 = await addTask(projB.id, 'a2-b3');
  const b4 = await addTask(projB.id, 'a2-b4');
  assert.deepEqual([b1.rank, b2.rank, b3.rank, b4.rank], [1, 2, 3, 4]);

  // Source task in bucket A
  const moving = await addTask(projA.id, 'a2-moving');

  // Cross-bucket move: project_id=B, rank=3 (between b2 and b3)
  const moveResp = await put(`/api/tasks/${moving.id}`, { project_id: projB.id, rank: 3 });
  assert.equal(moveResp.status, 200, `move PUT failed: ${JSON.stringify(moveResp.data)}`);
  assert.equal(moveResp.data.project_id, projB.id, 'project must be reparented');
  assert.equal(moveResp.data.rank, 3, `rank must be 3 (requested), not appended. got ${moveResp.data.rank}`);

  // Now fetch the bucket and verify [b1, b2, moving, b3, b4]
  const tasks = await getTopLevelTasksForProject(projB.id);
  const titles = tasks.map((t) => t.title);
  assert.deepEqual(
    titles,
    ['a2-b1', 'a2-b2', 'a2-moving', 'a2-b3', 'a2-b4'],
    `expected [a2-b1, a2-b2, a2-moving, a2-b3, a2-b4], got ${JSON.stringify(titles)}`,
  );
  const ranks = tasks.map((t) => t.rank);
  assert.deepEqual(ranks, [1, 2, 3, 4, 5], `ranks must be 1..5 contiguous after move, got ${JSON.stringify(ranks)}`);
});

test('A2-LIVE-02: same-bucket rerank (move t4 to rank 1) produces [t4, t1, t2, t3]', async () => {
  await resetBaseline();
  const proj = await ensureProject('a2_rerank_proj', '/data/workspace/a2_rerank_proj');
  const t1 = await addTask(proj.id, 'a2-rerank-t1');
  const t2 = await addTask(proj.id, 'a2-rerank-t2');
  const t3 = await addTask(proj.id, 'a2-rerank-t3');
  const t4 = await addTask(proj.id, 'a2-rerank-t4');

  const r = await put(`/api/tasks/${t4.id}`, { rank: 1 });
  assert.equal(r.status, 200);

  const tasks = await getTopLevelTasksForProject(proj.id);
  const titles = tasks.map((t) => t.title);
  assert.deepEqual(titles, ['a2-rerank-t4', 'a2-rerank-t1', 'a2-rerank-t2', 'a2-rerank-t3']);
});
