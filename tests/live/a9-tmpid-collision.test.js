'use strict';

// A9 #334: Session tmpId for Claude/Gemini/Codex includes a 6-hex-char
// crypto suffix so 5 concurrent POSTs in <1ms wall time still produce
// distinct ids.

const test = require('node:test');
const assert = require('node:assert/strict');
const { post } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

async function ensureProj(name) {
  const path = `/data/workspace/${name}`;
  dockerExec(`mkdir -p ${path}`);
  await post('/api/projects', { path, name });
  return name;
}

async function rapidFireSessions(project, cli, n = 5) {
  // Promise.all to truly fire in parallel
  const promises = [];
  for (let i = 0; i < n; i++) {
    promises.push(post('/api/sessions', { project, name: `${cli}-rapid-${i}`, prompt: `${cli}-rapid-${i}`, cli }));
  }
  return Promise.all(promises);
}

test('A9-LIVE-01: 5 concurrent Claude POSTs produce 5 distinct session ids', async () => {
  await resetBaseline();
  await ensureProj('a9_claude_proj');
  const results = await rapidFireSessions('a9_claude_proj', 'claude', 5);
  const ids = results.map((r) => r.data && r.data.id).filter(Boolean);
  assert.equal(ids.length, 5, `all 5 must succeed: ${JSON.stringify(results.map((r) => r.data))}`);
  assert.equal(new Set(ids).size, 5, `all 5 ids must be distinct, got ${JSON.stringify(ids)}`);
});

test('A9-LIVE-02: 5 concurrent Gemini POSTs produce 5 distinct session ids', async () => {
  await resetBaseline();
  await ensureProj('a9_gemini_proj');
  const results = await rapidFireSessions('a9_gemini_proj', 'gemini', 5);
  const ids = results.map((r) => r.data && r.data.id).filter(Boolean);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5, `gemini ids must be distinct, got ${JSON.stringify(ids)}`);
});

test('A9-LIVE-03: 5 concurrent Codex POSTs produce 5 distinct session ids', async () => {
  await resetBaseline();
  await ensureProj('a9_codex_proj');
  const results = await rapidFireSessions('a9_codex_proj', 'codex', 5);
  const ids = results.map((r) => r.data && r.data.id).filter(Boolean);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5, `codex ids must be distinct, got ${JSON.stringify(ids)}`);
});

test('A9-LIVE-04: tmpId format includes the 6-hex-char crypto suffix', async () => {
  await resetBaseline();
  await ensureProj('a9_format_proj');
  const r = await post('/api/sessions', { project: 'a9_format_proj', name: 'format-test', prompt: 'format-test' });
  assert.equal(r.status, 200);
  // Format expected: new_<timestamp>_<6 hex chars>
  assert.match(
    r.data.id,
    /^new_\d+_[0-9a-f]{6}$/,
    `id must match new_<ts>_<6hex> shape, got: ${r.data.id}`,
  );
});
