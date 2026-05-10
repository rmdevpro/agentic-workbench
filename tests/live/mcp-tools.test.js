'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, post } = require('../helpers/http-client');
const { resetBaseline } = require('../helpers/reset-state');
const { queryCount } = require('../helpers/db-query');

test('MCP-01: GET /api/mcp/tools lists the flat tool catalog', async () => {
  const r = await get('/api/mcp/tools');
  assert.equal(r.status, 200);
  // Catalog grew from 44 → 51 (gh_ tools added). Just assert non-empty +
  // shape so the test doesn't tripwire on every catalog addition; the
  // mock-layer CATALOG-01..03 tests pin exact parity with handlers.
  assert.ok(r.data.tools.length >= 44, `expected ≥44 tools, got ${r.data.tools.length}`);
  for (const name of r.data.tools) {
    assert.ok(/^(file|session|project|task|log|gh)_/.test(name), `tool name not flat: ${name}`);
  }
});

test('MCP-06: task_add increments DB row count and task_find surfaces it (v2 contract)', async () => {
  await resetBaseline();
  // #388 v2 contract: task_add now requires project_id / project_name / parent_task_id;
  // folder_path is no longer accepted. Create a project first to scope the task to.
  await post('/api/projects', { path: '/data/workspace/wb-seed', name: 'wb-seed' });
  const countBefore = queryCount('tasks', "project_id = (SELECT id FROM projects WHERE name = 'wb-seed')");

  const addResult = await post('/api/mcp/call', {
    tool: 'task_add',
    args: { project_name: 'wb-seed', title: 'mcp-task-test' },
  });
  assert.ok(addResult.data.result, `task_add returned no result: ${JSON.stringify(addResult.data)}`);
  // v2 task_add returns the inserted row including project_id
  assert.ok(addResult.data.result.project_id, `task_add result must include project_id: ${JSON.stringify(addResult.data.result)}`);

  const countAfter = queryCount('tasks', "project_id = (SELECT id FROM projects WHERE name = 'wb-seed')");
  assert.equal(
    countAfter,
    countBefore + 1,
    `DB task count must increment by 1 after task_add (before: ${countBefore}, after: ${countAfter})`,
  );

  // task_list was consolidated into task_find in 980bb6c; v2 contract uses project_id.
  // project_find takes a `pattern` regex (not a `name` filter), so resolve via
  // project_get which takes the project name directly.
  const projectGetRow = await post('/api/mcp/call', {
    tool: 'project_get',
    args: { project: 'wb-seed' },
  });
  const projectId = projectGetRow.data.result?.id;
  assert.ok(projectId, `project_get for wb-seed must return id: ${JSON.stringify(projectGetRow.data)}`);
  const listed = await post('/api/mcp/call', {
    tool: 'task_find',
    args: { project_id: projectId },
  });
  assert.ok(listed.data.result.tasks.some((t) => t.title === 'mcp-task-test'));
});

test('MCP-07: task_find 404s on bogus project_id/project_name (R5-N1 _resolveProject pin)', async () => {
  // R6-N1 belt-and-suspenders: R5-N1 (commit 85f09ff) routed task_find through
  // _resolveProject for parity with task_add. _resolveProject throws ToolError 404
  // when the requested project doesn't exist; this test pins both code paths so
  // a future refactor that silently falls back to getAllTasks (the pre-R5-N1
  // behavior) would fail loudly.
  const byId = await post('/api/mcp/call', {
    tool: 'task_find',
    args: { project_id: 999999 },
  });
  assert.equal(byId.status, 404, `bogus project_id must 404; got ${byId.status}`);
  assert.match(byId.data.error || '', /project_id 999999 not found/);

  const byName = await post('/api/mcp/call', {
    tool: 'task_find',
    args: { project_name: '__no-such-project__' },
  });
  assert.equal(byName.status, 404, `bogus project_name must 404; got ${byName.status}`);
  assert.match(byName.data.error || '', /project "__no-such-project__" not found/);
});

test('MCP unknown tool returns 404', async () => {
  const r = await post('/api/mcp/call', { tool: 'nonexistent_tool', args: {} });
  assert.equal(r.status, 404);
});
