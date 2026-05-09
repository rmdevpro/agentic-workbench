'use strict';

// A4 #329: /api/projects/:name/git-remote returns {host, owner, name, repo, remote}
// derived from `git remote get-url origin`, replacing the frontend's
// hardcoded rmdevpro/<repo> heuristic.

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, post } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

async function ensureGitRepoProject(name, origin) {
  const path = `/data/workspace/${name}`;
  dockerExec(`rm -rf ${path} && mkdir -p ${path} && cd ${path} && git init -q && git remote add origin ${origin}`);
  const r = await post('/api/projects', { path, name });
  assert.ok([200, 409].includes(r.status), `project create: ${JSON.stringify(r.data)}`);
  return name;
}

test('A4-LIVE-01: /git-remote returns host/owner/name from real git remote (rmdevpro)', async () => {
  await resetBaseline();
  await ensureGitRepoProject('a4_test_rmdev', 'https://github.com/rmdevpro/some-repo.git');
  const r = await get('/api/projects/a4_test_rmdev/git-remote');
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.equal(r.data.host, 'github.com');
  assert.equal(r.data.owner, 'rmdevpro');
  assert.equal(r.data.name, 'some-repo');
  assert.equal(r.data.repo, 'github.com/rmdevpro/some-repo');
});

test('A4-LIVE-02: /git-remote works for a different org (proves it is not hardcoded)', async () => {
  await resetBaseline();
  await ensureGitRepoProject('a4_other_org', 'https://github.com/other-org/some-other-repo.git');
  const r = await get('/api/projects/a4_other_org/git-remote');
  assert.equal(r.status, 200);
  assert.equal(r.data.host, 'github.com');
  assert.equal(r.data.owner, 'other-org', `owner must be derived from real remote, not hardcoded. got: ${r.data.owner}`);
  assert.equal(r.data.name, 'some-other-repo');
});

test('A4-LIVE-03: /git-remote works for GitHub Enterprise host', async () => {
  await resetBaseline();
  await ensureGitRepoProject('a4_ghes', 'https://enterprise.example.com/some-team/internal-repo.git');
  const r = await get('/api/projects/a4_ghes/git-remote');
  assert.equal(r.status, 200);
  assert.equal(r.data.host, 'enterprise.example.com');
  assert.equal(r.data.owner, 'some-team');
  assert.equal(r.data.name, 'internal-repo');
  assert.equal(r.data.repo, 'enterprise.example.com/some-team/internal-repo');
});

test('A4-LIVE-04: /git-remote works for SSH-style remote', async () => {
  await resetBaseline();
  await ensureGitRepoProject('a4_ssh', 'git@github.com:some-org/repo-name.git');
  const r = await get('/api/projects/a4_ssh/git-remote');
  assert.equal(r.status, 200);
  assert.equal(r.data.host, 'github.com');
  assert.equal(r.data.owner, 'some-org');
  assert.equal(r.data.name, 'repo-name');
});

test('A4-LIVE-05: project without origin remote → 404 no_git_remote', async () => {
  await resetBaseline();
  const path = '/data/workspace/a4_no_remote';
  dockerExec(`rm -rf ${path} && mkdir -p ${path} && cd ${path} && git init -q`);
  await post('/api/projects', { path, name: 'a4_no_remote' });
  const r = await get('/api/projects/a4_no_remote/git-remote');
  assert.equal(r.status, 404);
  assert.equal(r.data.error, 'no_git_remote');
});

test('A4-LIVE-06: unknown project → 404 project not found', async () => {
  const r = await get('/api/projects/this-project-does-not-exist/git-remote');
  assert.equal(r.status, 404);
  assert.match(r.data.error, /not found/);
});
