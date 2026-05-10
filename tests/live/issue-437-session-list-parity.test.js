'use strict';

// #437: session_list previously walked the Claude-only sessions/*.jsonl
// directory and never reported gemini or codex sessions. Live test spawns
// one of each cli_type via /api/sessions, then calls session_list (via the
// MCP route) and asserts every cli_type appears.

const test = require('node:test');
const assert = require('node:assert/strict');
const { post } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

async function ensureProj(name) {
  dockerExec(`mkdir -p /data/workspace/${name}`);
  await post('/api/projects', { path: `/data/workspace/${name}`, name });
  return name;
}

test('#437 session_list returns sessions for all 3 cli_types (claude+gemini+codex)', async () => {
  await resetBaseline();
  const proj = await ensureProj('issue437_proj');

  const claudeSess = await post('/api/sessions', { project: proj, name: '437-claude', prompt: '437-claude', cli: 'claude' });
  assert.equal(claudeSess.status, 200, `claude session create: ${JSON.stringify(claudeSess.data)}`);
  const geminiSess = await post('/api/sessions', { project: proj, name: '437-gemini', prompt: '437-gemini', cli: 'gemini' });
  assert.equal(geminiSess.status, 200, `gemini session create: ${JSON.stringify(geminiSess.data)}`);
  const codexSess  = await post('/api/sessions', { project: proj, name: '437-codex',  prompt: '437-codex',  cli: 'codex'  });
  assert.equal(codexSess.status, 200,  `codex session create: ${JSON.stringify(codexSess.data)}`);

  // Brief settle so DB rows are durable before the MCP call.
  await new Promise((r) => setTimeout(r, 500));

  const r = await post('/api/mcp/call', { tool: 'session_list', args: { project: proj } });
  assert.equal(r.status, 200, `session_list response: ${JSON.stringify(r.data)}`);
  const sessions = r.data.result.sessions;
  const types = new Set(sessions.map((s) => s.cli_type));
  assert.ok(types.has('claude'), `claude session must appear; cli_types=${[...types].join(',')}`);
  assert.ok(types.has('gemini'), `gemini session must appear; cli_types=${[...types].join(',')}`);
  assert.ok(types.has('codex'),  `codex session must appear; cli_types=${[...types].join(',')}`);
  assert.ok(sessions.length >= 3, `at least 3 sessions expected; got ${sessions.length}`);
});
