'use strict';

// A11 #336: deleting a project cascades through tmux + JSONL + per-CLI configs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { post } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

function fileExists(path) {
  try {
    const out = dockerExec(`test -e ${path} && echo YES || echo NO`).trim();
    return out === 'YES';
  } catch {
    return false;
  }
}

function tmuxHas(name) {
  try {
    const list = dockerExec('tmux ls -F "#{session_name}" 2>/dev/null || true');
    return list.split('\n').includes(name);
  } catch {
    return false;
  }
}

function readFile(path) {
  try { return dockerExec(`cat ${path} 2>/dev/null || echo ""`); } catch { return ''; }
}

test('A11-LIVE-01: project remove kills tmux session for each session in the project', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /data/workspace/a11_tmux_proj');
  await post('/api/projects', { path: '/data/workspace/a11_tmux_proj', name: 'a11_tmux_proj' });
  // Create two terminal sessions (don't try to spawn real Claude — that's slow + auth-dependent)
  const t1 = await post('/api/terminals', { project: 'a11_tmux_proj' });
  const t2 = await post('/api/terminals', { project: 'a11_tmux_proj' });
  assert.equal(t1.status, 200);
  assert.equal(t2.status, 200);
  // Wait for tmux sessions to actually exist
  await new Promise((r) => setTimeout(r, 1500));
  const before1 = tmuxHas(t1.data.tmux);
  const before2 = tmuxHas(t2.data.tmux);
  assert.ok(before1, `tmux ${t1.data.tmux} must exist before delete`);
  assert.ok(before2, `tmux ${t2.data.tmux} must exist before delete`);

  // Delete project
  const r = await post('/api/projects/a11_tmux_proj/remove', {});
  assert.equal(r.status, 200, `delete failed: ${JSON.stringify(r.data)}`);
  // Wait for tmux kill to propagate
  await new Promise((rs) => setTimeout(rs, 800));
  assert.ok(!tmuxHas(t1.data.tmux), `tmux ${t1.data.tmux} must be killed after delete (still in tmux ls)`);
  assert.ok(!tmuxHas(t2.data.tmux), `tmux ${t2.data.tmux} must be killed after delete (still in tmux ls)`);
});

test('A11-LIVE-02: project remove strips ~/.claude.json projects entry', async () => {
  await resetBaseline();
  const projPath = '/data/workspace/a11_claude_cfg';
  dockerExec(`mkdir -p ${projPath}`);
  await post('/api/projects', { path: projPath, name: 'a11_claude_cfg' });

  // Plant a .claude.json with this project + a keep entry
  const claudePath = '/data/.claude/.claude.json';
  const before = JSON.stringify({ projects: { [projPath]: { trusted: true }, '/keep/this': { keep: true } } });
  dockerExec(`echo '${before}' > ${claudePath}`);

  const r = await post('/api/projects/a11_claude_cfg/remove', {});
  assert.equal(r.status, 200);

  const afterJson = JSON.parse(readFile(claudePath));
  assert.equal(afterJson.projects[projPath], undefined, `~/.claude.json must drop ${projPath} entry. got: ${JSON.stringify(afterJson.projects)}`);
  assert.deepEqual(afterJson.projects['/keep/this'], { keep: true }, 'other entries must survive');
});

test('A11-LIVE-03: project remove strips Gemini trustedFolders entry', async () => {
  await resetBaseline();
  const projPath = '/data/workspace/a11_gem_cfg';
  dockerExec(`mkdir -p ${projPath} && mkdir -p /data/.gemini`);
  await post('/api/projects', { path: projPath, name: 'a11_gem_cfg' });

  const trustedPath = '/data/.gemini/trustedFolders.json';
  const before = JSON.stringify({ [projPath]: 'TRUST_FOLDER', '/keep/path': 'TRUST_FOLDER' });
  dockerExec(`echo '${before}' > ${trustedPath}`);

  const r = await post('/api/projects/a11_gem_cfg/remove', {});
  assert.equal(r.status, 200);

  const after = JSON.parse(readFile(trustedPath));
  assert.equal(after[projPath], undefined);
  assert.equal(after['/keep/path'], 'TRUST_FOLDER');
});

test('A11-LIVE-04: project remove strips Codex config.toml block', async () => {
  await resetBaseline();
  const projPath = '/data/workspace/a11_codex_cfg';
  dockerExec(`mkdir -p ${projPath} && mkdir -p /data/.codex`);
  await post('/api/projects', { path: projPath, name: 'a11_codex_cfg' });

  const tomlPath = '/data/.codex/config.toml';
  const beforeToml = `[some.unrelated]\nfoo = "bar"\n\n[projects."${projPath}"]\ntrust_level = "trusted"\n\n[projects."/keep/me"]\ntrust_level = "trusted"\n`;
  // Use sh -c with heredoc through dockerExec
  dockerExec(`bash -c 'cat > ${tomlPath} <<EOF\n${beforeToml}EOF'`);

  const r = await post('/api/projects/a11_codex_cfg/remove', {});
  assert.equal(r.status, 200);

  const afterToml = readFile(tomlPath);
  assert.ok(!afterToml.includes(`[projects."${projPath}"]`), `target block must be stripped from config.toml. got:\n${afterToml}`);
  assert.ok(afterToml.includes(`[projects."/keep/me"]`), 'unrelated project block must remain');
  assert.ok(afterToml.includes('[some.unrelated]'), 'unrelated header must remain');
});

test('A11-LIVE-05: project remove succeeds even when none of the cleanup targets exist', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /data/workspace/a11_minimal');
  await post('/api/projects', { path: '/data/workspace/a11_minimal', name: 'a11_minimal' });
  // No tmux sessions, no config files — delete should still succeed
  const r = await post('/api/projects/a11_minimal/remove', {});
  assert.equal(r.status, 200);
});
