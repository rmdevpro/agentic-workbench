'use strict';

// A17 #342: WORKBENCH_SESSION_ID env var injected at session spawn for all
// 3 CLIs. Verify the env var is visible in the tmux pane process tree.

const test = require('node:test');
const assert = require('node:assert/strict');
const { post, createSession } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

function envForTmux(tmuxName) {
  // Find any process inside the tmux pane and read its environ.
  // tmux pid → child pids → /proc/<pid>/environ
  try {
    const tmuxPidRaw = dockerExec(`tmux list-panes -t ${tmuxName} -F "#{pane_pid}" 2>/dev/null | head -1`).trim();
    if (!tmuxPidRaw) return null;
    const tmuxPid = Number(tmuxPidRaw);
    if (!tmuxPid) return null;
    const environ = dockerExec(`cat /proc/${tmuxPid}/environ 2>/dev/null | tr '\\0' '\\n' | grep WORKBENCH_SESSION_ID || echo ''`).trim();
    return environ;
  } catch {
    return null;
  }
}

async function ensureProj(name) {
  dockerExec(`mkdir -p /data/workspace/${name}`);
  await post('/api/projects', { path: `/data/workspace/${name}`, name });
  return name;
}

test('A17-LIVE-01: Claude session has WORKBENCH_SESSION_ID in pane environ', async () => {
  await resetBaseline();
  await ensureProj('a17_claude');
  const s = await createSession('a17_claude', 'a17-claude');
  assert.equal(s.status, 200, JSON.stringify(s.data));
  await new Promise((r) => setTimeout(r, 1500));
  const env = envForTmux(s.data.tmux);
  assert.ok(
    env && env.startsWith('WORKBENCH_SESSION_ID='),
    `Claude pane env must contain WORKBENCH_SESSION_ID. tmux=${s.data.tmux} env=${env}`,
  );
  assert.equal(env.split('=')[1], s.data.id, `WORKBENCH_SESSION_ID must equal session id. got: ${env}`);
});

test('A17-LIVE-02: Gemini session has WORKBENCH_SESSION_ID in pane environ', async () => {
  await resetBaseline();
  await ensureProj('a17_gemini');
  const s = await post('/api/sessions', { project: 'a17_gemini', name: 'a17-gemini', prompt: 'a17-gemini', cli: 'gemini' });
  assert.equal(s.status, 200);
  await new Promise((r) => setTimeout(r, 1500));
  const env = envForTmux(s.data.tmux);
  assert.ok(env && env.startsWith('WORKBENCH_SESSION_ID='), `Gemini pane env must contain WORKBENCH_SESSION_ID. tmux=${s.data.tmux} env=${env}`);
  assert.equal(env.split('=')[1], s.data.id);
});

test('A17-LIVE-03: Codex session has WORKBENCH_SESSION_ID in pane environ', async () => {
  await resetBaseline();
  await ensureProj('a17_codex');
  const s = await post('/api/sessions', { project: 'a17_codex', name: 'a17-codex', prompt: 'a17-codex', cli: 'codex' });
  assert.equal(s.status, 200);
  await new Promise((r) => setTimeout(r, 1500));
  const env = envForTmux(s.data.tmux);
  assert.ok(env && env.startsWith('WORKBENCH_SESSION_ID='), `Codex pane env must contain WORKBENCH_SESSION_ID. tmux=${s.data.tmux} env=${env}`);
  assert.equal(env.split('=')[1], s.data.id);
});
