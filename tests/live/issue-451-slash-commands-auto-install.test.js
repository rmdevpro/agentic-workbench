'use strict';

// #451: workbench auto-installs /session slash command equivalents for
// Gemini (TOML) and Codex (Markdown) at boot. This test verifies the files
// land at the conventional paths inside the deployed container.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dockerExec } = require('../helpers/reset-state');

function fileExists(path) {
  try {
    return dockerExec(`test -f ${path} && echo yes || echo no`).trim() === 'yes';
  } catch {
    return false;
  }
}

function readFile(path) {
  try {
    return dockerExec(`cat ${path}`);
  } catch {
    return '';
  }
}

test('#451 Gemini /session:transition + /session:resume TOML files installed', () => {
  // The watcher installs into safe.HOME which is /data inside the container.
  const transitionPath = '/data/.gemini/commands/session/transition.toml';
  const resumePath = '/data/.gemini/commands/session/resume.toml';
  assert.ok(fileExists(transitionPath), `${transitionPath} must exist`);
  assert.ok(fileExists(resumePath), `${resumePath} must exist`);

  const transition = readFile(transitionPath);
  const resume = readFile(resumePath);
  assert.match(transition, /session_prepare_pre_compact/, 'transition.toml must invoke session_prepare_pre_compact');
  assert.match(transition, /!\{echo -n \$WORKBENCH_SESSION_ID\}/, 'transition.toml must use shell substitution');
  assert.match(resume, /session_resume_post_compact/);
  assert.match(resume, /!\{echo -n \$WORKBENCH_SESSION_ID\}/);
});

test('#451 Codex /prompts:session-transition + /prompts:session-resume MD files installed', () => {
  const transitionPath = '/data/.codex/prompts/session-transition.md';
  const resumePath = '/data/.codex/prompts/session-resume.md';
  assert.ok(fileExists(transitionPath), `${transitionPath} must exist`);
  assert.ok(fileExists(resumePath), `${resumePath} must exist`);

  const transition = readFile(transitionPath);
  const resume = readFile(resumePath);
  assert.match(transition, /^---\ndescription:/, 'transition.md must have YAML frontmatter');
  assert.match(transition, /session_prepare_pre_compact/);
  assert.match(transition, /WORKBENCH_SESSION_ID/);
  assert.match(resume, /^---\ndescription:/);
  assert.match(resume, /session_resume_post_compact/);
});
