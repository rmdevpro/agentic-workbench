'use strict';

// Mock-server tests for the flat MCP API. Hits the in-process Express app via
// supertest-style helpers (no docker, no live workbench). Live integration
// coverage lives in tests/live/mcp-tools.test.js.
//
// Tool count is derived from the handlers map in mcp-tools.js (the source of
// truth) so adding/removing a tool updates both the handler and TOOL_NAMES
// at once and the test follows. Hardcoded counts here would be a tripwire
// that surfaces as a "16 mock failures" red CI when tools land — see #325.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerMcpRoutes, handlers, TOOL_NAMES } = require('../../src/mcp-tools.js');
const { withServer, req } = require('../helpers/with-server');

const KNOWN_DOMAINS = ['file', 'session', 'project', 'task', 'log', 'gh'];

function startMcpApp() {
  const app = express();
  app.use(express.json());
  registerMcpRoutes(app);
  return app;
}

async function call(port, body) {
  const r = await req(port, 'POST', '/api/mcp/call', body);
  const json = await r.json().catch(() => ({}));
  return { status: r.status, body: json };
}

test('MCP catalogue: tools/list returns the full handler-exposed set', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'GET', '/api/mcp/tools');
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.tools.length, TOOL_NAMES.length);
    assert.deepEqual([...json.tools].sort(), [...TOOL_NAMES].sort());
    for (const n of json.tools) {
      const domain = n.split('_')[0];
      assert.ok(
        KNOWN_DOMAINS.includes(domain),
        `tool ${n} has unknown domain prefix "${domain}"; add to KNOWN_DOMAINS or rename`,
      );
    }
  });
});

test('MCP catalogue: handlers map and TOOL_NAMES are in sync', () => {
  assert.deepEqual([...TOOL_NAMES].sort(), Object.keys(handlers).sort());
  const grouped = TOOL_NAMES.reduce((acc, n) => {
    const d = n.split('_')[0];
    acc[d] = (acc[d] || 0) + 1;
    return acc;
  }, {});
  for (const d of Object.keys(grouped)) {
    assert.ok(
      KNOWN_DOMAINS.includes(d),
      `unknown domain prefix "${d}" with ${grouped[d]} tools`,
    );
  }
});

test('MCP unknown tool returns 404', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, { tool: 'nonexistent_tool', args: {} });
    assert.equal(r.status, 404);
  });
});

test('MCP missing required arg returns 400 (file_read needs path)', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, { tool: 'file_read', args: {} });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /path required/i);
  });
});

test('MCP path traversal blocked (file_read ../etc/passwd)', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, { tool: 'file_read', args: { path: '../../../etc/passwd' } });
    assert.equal(r.status, 403);
  });
});

test('MCP invalid task_id returns 400', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, { tool: 'task_get', args: { task_id: 'abc' } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /task_id/i);
  });
});

test('MCP invalid session_id format returns 400', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, { tool: 'session_info', args: { session_id: 'has spaces and !@#' } });
    assert.equal(r.status, 400);
  });
});

test('MCP session_send_key rejects non-whitelisted key', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, {
      tool: 'session_send_key',
      args: { session_id: 'a'.repeat(20), key: 'NotARealKey' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /invalid key/i);
  });
});

test('MCP session_wait rejects seconds <= 0', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, { tool: 'session_wait', args: { seconds: 0 } });
    assert.equal(r.status, 400);
  });
});
