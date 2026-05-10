'use strict';

// #446: session_prepare_pre_compact + session_resume_post_compact were
// Claude-only pre-fix. Live test spawns one of each cli_type, then asserts:
//   - prepare returns CLI-appropriate prompt (per per-CLI dispatch)
//   - resume returns 404 with a clean per-CLI message when no transcript
//     exists yet (the "no silent failures" pin)

const test = require('node:test');
const assert = require('node:assert/strict');
const { post } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

async function ensureProj(name) {
  dockerExec(`mkdir -p /data/workspace/${name}`);
  await post('/api/projects', { path: `/data/workspace/${name}`, name });
  return name;
}

test('#446 session_prepare_pre_compact returns CLI-appropriate prompt for all 3 cli_types', async () => {
  await resetBaseline();
  const proj = await ensureProj('issue446_prep');
  const claude = await post('/api/sessions', { project: proj, name: '446-prep-c', prompt: 'p', cli_type: 'claude' });
  const gemini = await post('/api/sessions', { project: proj, name: '446-prep-g', prompt: 'p', cli_type: 'gemini' });
  const codex  = await post('/api/sessions', { project: proj, name: '446-prep-x', prompt: 'p', cli_type: 'codex'  });
  assert.equal(claude.status, 200, `claude spawn: ${JSON.stringify(claude.data)}`);
  assert.equal(gemini.status, 200, `gemini spawn: ${JSON.stringify(gemini.data)}`);
  assert.equal(codex.status,  200, `codex spawn: ${JSON.stringify(codex.data)}`);

  const claudeR = await post('/api/mcp/call', { tool: 'session_prepare_pre_compact', args: { session_id: claude.data.id } });
  assert.equal(claudeR.status, 200, JSON.stringify(claudeR.data));
  assert.match(claudeR.data.result, /\/compact/i, 'Claude prompt must reference /compact');

  const geminiR = await post('/api/mcp/call', { tool: 'session_prepare_pre_compact', args: { session_id: gemini.data.id } });
  assert.equal(geminiR.status, 200, JSON.stringify(geminiR.data));
  assert.match(geminiR.data.result, /\/compress/i, 'Gemini prompt must reference /compress');

  const codexR = await post('/api/mcp/call', { tool: 'session_prepare_pre_compact', args: { session_id: codex.data.id } });
  assert.equal(codexR.status, 200, JSON.stringify(codexR.data));
  assert.match(codexR.data.result, /Codex CLI does NOT/i, 'Codex prompt must call out the no-compaction caveat');
  assert.match(codexR.data.result, /start a NEW Codex session/i, 'Codex prompt must direct user to a new session');
  assert.match(codexR.data.result, /Do NOT run `\/clear`/, 'Codex prompt must explicitly warn against /clear');
});

test('#446 session_resume_post_compact 404s cleanly with per-CLI message when no transcript', async () => {
  await resetBaseline();
  const proj = await ensureProj('issue446_resume');
  const gemini = await post('/api/sessions', { project: proj, name: '446-resume-g', prompt: 'p', cli_type: 'gemini' });
  const codex  = await post('/api/sessions', { project: proj, name: '446-resume-x', prompt: 'p', cli_type: 'codex'  });
  assert.equal(gemini.status, 200);
  assert.equal(codex.status,  200);

  // Stub Gemini/Codex CLIs in the test container don't actually write a
  // transcript on spawn. Pre-fix the call would silently set the tail to
  // "(could not read session file)"; the parity fix throws a clean 404 with
  // the per-CLI message — that's what we pin.
  const geminiR = await post('/api/mcp/call', { tool: 'session_resume_post_compact', args: { session_id: gemini.data.id, tail_lines: 5 } });
  assert.equal(geminiR.status, 404, `gemini resume: ${JSON.stringify(geminiR.data)}`);
  assert.match(geminiR.data.error || '', /Gemini transcript/i, 'Gemini 404 must mention Gemini transcript');

  const codexR = await post('/api/mcp/call', { tool: 'session_resume_post_compact', args: { session_id: codex.data.id, tail_lines: 5 } });
  assert.equal(codexR.status, 404, `codex resume: ${JSON.stringify(codexR.data)}`);
  assert.match(codexR.data.error || '', /Codex transcript/i, 'Codex 404 must mention Codex transcript');
});

test('#446 session_prepare_pre_compact requires session_id (no implicit Claude default)', async () => {
  // Pre-fix the handler took no args and always returned the Claude prompt.
  // The contract change (require session_id) is intentional — without it the
  // dispatch can't know which CLI is calling. Pin the contract.
  const r = await post('/api/mcp/call', { tool: 'session_prepare_pre_compact', args: {} });
  assert.equal(r.status, 400, `expected 400 without session_id; got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.match(r.data.error || '', /session_id/i);
});
