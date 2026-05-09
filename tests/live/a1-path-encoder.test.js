'use strict';

// A1 #326: /api/sessions/:id/session must use canonical findSessionsDir
// encoder ([\/_] → '-'), preserving '.', '+', '~' in the path. The previous
// inline regex /[^a-zA-Z0-9]/g mangled all of those, returning exists:false
// even when the JSONL existed on disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const { post, createSession } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

// Canonical encoder mirrored from src/safe-exec.js:findSessionsDir
function encode(projectPath) {
  return projectPath.replace(/[\/_]/g, '-');
}

async function verifyPathEncoderForCli(cli, projectPath, projectName) {
  // Plant the project directory in the container.
  dockerExec(`mkdir -p ${JSON.stringify(projectPath)}`);
  // Register the project (POST /api/projects).
  const projResp = await post('/api/projects', { path: projectPath, name: projectName });
  assert.equal(projResp.status, 200, `project create must succeed for ${cli}: ${JSON.stringify(projResp.data)}`);

  // Spawn a session of the requested CLI.
  const sess = await createSession(projectName, `a1-${cli}-test`);
  assert.equal(sess.status, 200, `${cli} session create must return 200, got ${sess.status}: ${JSON.stringify(sess.data)}`);
  const sessionId = sess.data.id;
  assert.ok(sessionId, `${cli} session must have id`);

  // Wait briefly so the JSONL has a chance to be created on disk by the CLI.
  await new Promise((r) => setTimeout(r, 1500));

  // Hit the route under test.
  const info = await post(`/api/sessions/${sessionId}/session`, { project: projectName, mode: 'info' });
  assert.equal(info.status, 200, `${cli} /session must return 200`);

  // Assert path uses canonical encoder, not the buggy [^a-zA-Z0-9]/g regex.
  const expectedDir = `/data/.claude/projects/${encode(projectPath)}`;
  assert.equal(
    info.data.sessionFile,
    `${expectedDir}/${sessionId}.jsonl`,
    `${cli} sessionFile must use canonical encoder. Expected ${expectedDir}/${sessionId}.jsonl, got ${info.data.sessionFile}`,
  );

  // The buggy encoder would produce ALL non-alphanumeric → '-'. Assert the
  // canonical-only path components are preserved (proves we are not running
  // the buggy regex even by coincidence).
  if (projectPath.includes('.')) assert.ok(info.data.sessionFile.includes('.'), `${cli} '.' must survive encoder`);
  if (projectPath.includes('+')) assert.ok(info.data.sessionFile.includes('+'), `${cli} '+' must survive encoder`);

  // Plant a stub JSONL where Claude/Gemini/Codex would land it, then assert
  // the route reports exists:true. (Real CLIs may not flush by the time we
  // poll; planting the file decouples this assertion from CLI internals.)
  dockerExec(`mkdir -p ${JSON.stringify(expectedDir)}`);
  dockerExec(`printf '{"type":"user","message":{"role":"user","content":"hi"}}\\n' > ${JSON.stringify(`${expectedDir}/${sessionId}.jsonl`)}`);
  const info2 = await post(`/api/sessions/${sessionId}/session`, { project: projectName, mode: 'info' });
  assert.equal(info2.data.exists, true, `${cli} exists must be true once JSONL is on disk at canonical path`);

  // Resume mode must read the planted content (proves the resolved path is
  // the path the route actually reads from).
  const resume = await post(`/api/sessions/${sessionId}/session`, { project: projectName, mode: 'resume', tailLines: 5 });
  assert.equal(resume.status, 200, `${cli} resume must return 200`);
  assert.ok(resume.data.prompt, `${cli} resume must produce a prompt`);
}

test('A1-LIVE-01: Claude session — /api/sessions/:id/session returns canonical-encoded path for project with . _ + chars', async () => {
  await resetBaseline();
  await verifyPathEncoderForCli('claude', '/data/workspace/foo.bar/sub_dir+with-stuff', 'a1_claude_proj');
});

test('A1-LIVE-02: Gemini session — same path encoder behavior', async () => {
  await resetBaseline();
  // Gemini sessions use the same /api/sessions endpoint with cli=gemini.
  dockerExec('mkdir -p /data/workspace/foo.bar/gem+sub_dir');
  const projResp = await post('/api/projects', { path: '/data/workspace/foo.bar/gem+sub_dir', name: 'a1_gemini_proj' });
  assert.equal(projResp.status, 200);
  const sess = await post('/api/sessions', { project: 'a1_gemini_proj', name: 'a1-gemini-test', prompt: 'a1-gemini-test', cli: 'gemini' });
  assert.equal(sess.status, 200, `gemini session create: ${JSON.stringify(sess.data)}`);
  const sessionId = sess.data.id;
  await new Promise((r) => setTimeout(r, 1500));
  const info = await post(`/api/sessions/${sessionId}/session`, { project: 'a1_gemini_proj', mode: 'info' });
  assert.equal(info.status, 200);
  assert.equal(
    info.data.sessionFile,
    `/data/.claude/projects/${encode('/data/workspace/foo.bar/gem+sub_dir')}/${sessionId}.jsonl`,
    `gemini sessionFile must match canonical encoder. Got ${info.data.sessionFile}`,
  );
});

test('A1-LIVE-03: Codex session — same path encoder behavior', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /data/workspace/foo.bar/cod+sub_dir');
  const projResp = await post('/api/projects', { path: '/data/workspace/foo.bar/cod+sub_dir', name: 'a1_codex_proj' });
  assert.equal(projResp.status, 200);
  const sess = await post('/api/sessions', { project: 'a1_codex_proj', name: 'a1-codex-test', prompt: 'a1-codex-test', cli: 'codex' });
  assert.equal(sess.status, 200, `codex session create: ${JSON.stringify(sess.data)}`);
  const sessionId = sess.data.id;
  await new Promise((r) => setTimeout(r, 1500));
  const info = await post(`/api/sessions/${sessionId}/session`, { project: 'a1_codex_proj', mode: 'info' });
  assert.equal(info.status, 200);
  assert.equal(
    info.data.sessionFile,
    `/data/.claude/projects/${encode('/data/workspace/foo.bar/cod+sub_dir')}/${sessionId}.jsonl`,
    `codex sessionFile must match canonical encoder. Got ${info.data.sessionFile}`,
  );
});
