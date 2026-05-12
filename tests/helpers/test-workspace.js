'use strict';

// #481: test workspace isolation.
//
// All test projects/fixtures must live under /data/workspace/_test/<suite>/
// rather than at the WORKSPACE root, so:
//   1. They are visually distinct from user projects in the sidebar.
//   2. They're easy to clean up — one `rm -rf` per suite from after-hooks.
//   3. They don't accumulate across gate-regression cycles (the bug that
//      caused #478: leftover Gemini chats from prior runs polluting the
//      time-proximity match in #468-LIVE-01).
//
// Usage:
//   const ws = require('../helpers/test-workspace');
//   const SUITE = 'p2-phase2';
//
//   test.after(() => ws.cleanup(SUITE));
//
//   test('something', async () => {
//     const p = ws.mkProject(SUITE, 'myproj');           // creates /data/workspace/_test/p2-phase2/myproj
//     await post('/api/projects', { path: p, name: 'myproj' });
//     // ... use `p` wherever the path is needed ...
//   });

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const _IN_CONTAINER = fs.existsSync('/.dockerenv');
const ROOT = '/data/workspace/_test';

function _exec(cmd) {
  try {
    if (_IN_CONTAINER) {
      return execSync(cmd, { encoding: 'utf-8', timeout: 30000, shell: '/bin/sh' }).trim();
    }
    const CONTAINER = process.env.TEST_CONTAINER || 'workbench-test';
    return execSync(`docker exec -u workbench ${CONTAINER} ${cmd}`, { encoding: 'utf-8', timeout: 30000 }).trim();
  } catch { return ''; }
}

function _assertSuite(suite) {
  if (!suite || typeof suite !== 'string' || !/^[A-Za-z0-9_-]+$/.test(suite)) {
    throw new Error(`test-workspace: suite name must match [A-Za-z0-9_-]+; got '${suite}'`);
  }
}

// Returns the absolute path /data/workspace/_test/<suite>/<project> without
// creating the directory. Use for path-only assertions or planning.
function projectPath(suite, project) {
  _assertSuite(suite);
  if (!project || /[/]/.test(project)) {
    throw new Error(`test-workspace: project must be a single path segment; got '${project}'`);
  }
  return path.posix.join(ROOT, suite, project);
}

// Create the test project directory inside the container/sandbox and return
// its absolute path. Idempotent — safe to call multiple times for the same
// (suite, project) pair.
function mkProject(suite, project) {
  const p = projectPath(suite, project);
  _exec(`mkdir -p ${p}`);
  return p;
}

// Remove /data/workspace/_test/<suite>/ recursively. Call from test.after()
// so each suite cleans up its own dirs. Safe no-op if the dir doesn't exist.
function cleanup(suite) {
  _assertSuite(suite);
  _exec(`rm -rf ${ROOT}/${suite}`);
}

module.exports = { projectPath, mkProject, cleanup, ROOT };
