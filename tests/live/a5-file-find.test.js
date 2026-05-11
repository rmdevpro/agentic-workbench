'use strict';

// A5 #330: file_find via execFile (not shell concat) + file_type validation
// + context_lines clamping. Verified via the real MCP HTTP endpoint on M5.

const test = require('node:test');
const assert = require('node:assert/strict');
const { post } = require('../helpers/http-client');
const { dockerExec } = require('../helpers/reset-state');

// #447: A5-LIVE-04 needs at least one .js file containing `module.exports`
// in the search root. Empty workspace (sandbox default) → 0 matches → fail.
// Seed a deterministic fixture under /data/workspace/ before this file runs.
test.before(() => {
  dockerExec("mkdir -p /data/workspace/a5-fixture && printf 'module.exports = { ok: true };\\n' > /data/workspace/a5-fixture/sample.js");
});

test('A5-LIVE-01: file_find rejects file_type with shell metachars (400)', async () => {
  const r = await post('/api/mcp/call', {
    tool: 'file_find',
    args: { pattern: 'workbench', file_type: 'js;rm -rf /' },
  });
  assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.match(r.data.error, /file_type/i);
});

test('A5-LIVE-02: file_find rejects backtick injection (400)', async () => {
  const r = await post('/api/mcp/call', {
    tool: 'file_find',
    args: { pattern: 'workbench', file_type: '`whoami`' },
  });
  assert.equal(r.status, 400);
});

test('A5-LIVE-03: file_find rejects $-substitution injection (400)', async () => {
  const r = await post('/api/mcp/call', {
    tool: 'file_find',
    args: { pattern: 'workbench', file_type: 'js$(whoami)' },
  });
  assert.equal(r.status, 400);
});

test('A5-LIVE-04: file_find with valid extension returns matches', async () => {
  const r = await post('/api/mcp/call', {
    tool: 'file_find',
    args: { pattern: 'module.exports', file_type: 'js' },
  });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.equal(r.data.result.pattern, 'module.exports');
  assert.ok(Array.isArray(r.data.result.matches), 'matches must be an array');
  assert.ok(r.data.result.matches.length > 0, 'should have at least one match in workspace');
});

test('A5-LIVE-05: file_find clamps oversized context_lines without error', async () => {
  const r = await post('/api/mcp/call', {
    tool: 'file_find',
    args: { pattern: 'workbench', context_lines: 999 },
  });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.ok(Array.isArray(r.data.result.matches));
});

test('A5-LIVE-06: file_find clamps negative context_lines to 0', async () => {
  const r = await post('/api/mcp/call', {
    tool: 'file_find',
    args: { pattern: 'workbench', context_lines: -10 },
  });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.result.matches));
});
