'use strict';

// #450: session_summarize threw "path argument must be string" when called
// without an explicit `project` arg. Live test exercises the no-project-arg
// path against each cli_type to pin parity.

const test = require('node:test');
const assert = require('node:assert/strict');
const { post } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

async function ensureProj(name) {
  dockerExec(`mkdir -p /data/workspace/${name}`);
  await post('/api/projects', { path: `/data/workspace/${name}`, name });
  return name;
}

async function spawn(cliType, name) {
  return post('/api/sessions', { project: 'issue450_proj', name, cli_type: cliType, hidden: false });
}

test('#450 session_summarize works without project arg for all 3 cli_types', async () => {
  await resetBaseline();
  await ensureProj('issue450_proj');

  const claudeSess = await spawn('claude', '450-claude');
  const geminiSess = await spawn('gemini', '450-gemini');
  const codexSess  = await spawn('codex',  '450-codex');
  assert.equal(claudeSess.status, 200);
  assert.equal(geminiSess.status, 200);
  assert.equal(codexSess.status,  200);

  await new Promise((r) => setTimeout(r, 1500));

  for (const [cli, sess] of [['claude', claudeSess], ['gemini', geminiSess], ['codex', codexSess]]) {
    const r = await post('/api/mcp/call', {
      tool: 'session_summarize',
      args: { session_id: sess.data.id },  // no `project` arg
    });
    // Must not 500 with "path argument must be string" — the bug we're pinning.
    assert.notEqual(r.status, 500, `${cli} summarize must not 500; got ${r.status}: ${JSON.stringify(r.data)}`);
    if (r.status !== 200) {
      // Acceptable: 404 if no transcript yet, but NOT a path error
      assert.ok(
        !(r.data?.error || '').match(/path.*must be of type string/i),
        `${cli} summarize must not return path-undefined error; got ${JSON.stringify(r.data)}`,
      );
    }
  }
});
