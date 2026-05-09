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

test('A6-LIVE-04: gh_cmd valid argv form passes shape validation (rejects only missing repo, not shape)', async () => {
  // Without `repo` the route returns 400 "repo or path required" — that's a
  // *different* 400 than the argv-shape rejections. Verify the error string
  // is about repo/path, NOT about command shape, which proves the argv
  // validation accepted ['version'].
  const r = await post('/api/mcp/call', {
    tool: 'gh_cmd',
    args: { command: ['version'] },
  });
  // Either 400 (missing repo, which is correct) or 200 (succeeded against
  // some default) — the failure mode we care about is shape rejection.
  if (r.status === 400) {
    assert.doesNotMatch(r.data.error, /command must be an array|every command element/i, `400 reason must NOT be argv-shape: ${r.data.error}`);
    assert.match(r.data.error, /repo|path/i, `expected repo/path required error, got: ${r.data.error}`);
  }
});

test('A6-LIVE-05: gh_cmd valid argv with repo passes validation (reaches gh subprocess)', async () => {
  // Now provide repo. gh may auth-fail, but the response must not be a
  // shape-validation 400.
  const r = await post('/api/mcp/call', {
    tool: 'gh_cmd',
    args: { command: ['version'], repo: 'rmdevpro/agentic-workbench' },
  });
  if (r.status === 400) {
    assert.doesNotMatch(r.data.error, /command must be an array|every command element/i, `400 reason must NOT be argv-shape: ${r.data.error}`);
  }
  // Any non-shape outcome is acceptable: 200 (success), 502 (gh auth fail), etc.
});
