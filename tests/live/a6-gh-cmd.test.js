'use strict';

// A6 #331: gh_cmd argv-shape validation + chunked output cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const { post } = require('../helpers/http-client');

test('A6-LIVE-01: gh_cmd rejects string command (400 + descriptive error)', async () => {
  const r = await post('/api/mcp/call', {
    tool: 'gh_cmd',
    args: { command: 'ls -la', repo: 'rmdevpro/agentic-workbench' },
  });
  assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.match(r.data.error, /command must be an array/i);
});

test('A6-LIVE-02: gh_cmd rejects array with non-string element (400)', async () => {
  const r = await post('/api/mcp/call', {
    tool: 'gh_cmd',
    args: { command: ['log', {}], repo: 'rmdevpro/agentic-workbench' },
  });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /string/i);
});

test('A6-LIVE-03: gh_cmd rejects array with number element (400)', async () => {
  const r = await post('/api/mcp/call', {
    tool: 'gh_cmd',
    args: { command: ['log', 42], repo: 'rmdevpro/agentic-workbench' },
  });
  assert.equal(r.status, 400);
});

test('A6-LIVE-04: gh_cmd valid argv form does not 400 (proves shape passed validation)', async () => {
  // gh may not be authenticated in the container — that is fine; we are
  // verifying the request reached the gh subprocess (i.e., did NOT 400 on
  // shape). Whatever exit code gh returns is acceptable here.
  const r = await post('/api/mcp/call', {
    tool: 'gh_cmd',
    args: { command: ['version'] },
  });
  assert.notEqual(r.status, 400, `valid argv must not 400: ${JSON.stringify(r.data)}`);
});
