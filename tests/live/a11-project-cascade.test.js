'use strict';

// A11 #336: deleting a project cascades through tmux + JSONL + per-CLI configs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { post } = require('../helpers/http-client');
const { createSession } = require('../helpers/http-client');
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

test('A11-LIVE-01: project remove kills tmux for each Claude session in the project', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /data/workspace/a11_tmux_proj');
  await post('/api/projects', { path: '/data/workspace/a11_tmux_proj', name: 'a11_tmux_proj' });
  // Create two Claude sessions (which write to the sessions table — that's
  // what the cascade enumerates).
  const s1 = await createSession('a11_tmux_proj', 'a11-session-1');
  const s2 = await createSession('a11_tmux_proj', 'a11-session-2');
  assert.equal(s1.status, 200, `session 1 create: ${JSON.stringify(s1.data)}`);
  assert.equal(s2.status, 200, `session 2 create: ${JSON.stringify(s2.data)}`);
  await new Promise((r) => setTimeout(r, 1500));
  const before1 = tmuxHas(s1.data.tmux);
  const before2 = tmuxHas(s2.data.tmux);
  assert.ok(before1, `tmux ${s1.data.tmux} must exist before delete`);
  assert.ok(before2, `tmux ${s2.data.tmux} must exist before delete`);

  const r = await post('/api/projects/a11_tmux_proj/remove', {});
  assert.equal(r.status, 200, `delete failed: ${JSON.stringify(r.data)}`);
  await new Promise((rs) => setTimeout(rs, 1200));
  assert.ok(!tmuxHas(s1.data.tmux), `tmux ${s1.data.tmux} must be killed after delete`);
  assert.ok(!tmuxHas(s2.data.tmux), `tmux ${s2.data.tmux} must be killed after delete`);
});

test('A11-LIVE-02: project remove strips ~/.claude.json projects entry', async () => {
  await resetBaseline();
  const projPath = '/data/workspace/a11_claude_cfg';
  dockerExec(`mkdir -p ${projPath}`);
  await post('/api/projects', { path: projPath, name: 'a11_claude_cfg' });

  // Plant the project + a keep entry into .claude.json's projects map
  // WITHOUT overwriting other top-level keys (hasCompletedOnboarding, theme,
  // bypassPermissionsModeAccepted, etc.) — those are set by entrypoint.sh
  // and other live tests (e.g. ENT-09) depend on them. Use a Python merge.
  const claudePath = '/data/.claude/.claude.json';
  const merge = [
    `import json`,
    `f='${claudePath}'`,
    `d=json.load(open(f))`,
    `d.setdefault('projects',{})`,
    `d['projects']['${projPath}']={'trusted':True}`,
    `d['projects']['/keep/this']={'keep':True}`,
    `json.dump(d,open(f,'w'))`,
  ].join(';');
  dockerExec(`python3 -c "${merge}"`);

  const r = await post('/api/projects/a11_claude_cfg/remove', {});
  assert.equal(r.status, 200);

  const afterJson = JSON.parse(readFile(claudePath));
  assert.equal(afterJson.projects[projPath], undefined, `~/.claude.json must drop ${projPath} entry. got: ${JSON.stringify(afterJson.projects)}`);
  assert.deepEqual(afterJson.projects['/keep/this'], { keep: true }, 'other entries must survive');
  // Top-level invariants must survive the cascade — pre-fix this test wiped them.
  assert.equal(afterJson.hasCompletedOnboarding, true, 'hasCompletedOnboarding must survive (set by entrypoint.sh; ENT-09 depends on it)');
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
