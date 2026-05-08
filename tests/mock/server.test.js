'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const fixtures = require('../fixtures/test-data');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

test('ENG-20: all application modules importable', () => {
  const modules = [
    'config',
    'logger',
    'db',
    'safe-exec',
    'session-utils',
    'tmux-lifecycle',
    'session-resolver',
    'watchers',
    'ws-terminal',
    'keepalive',
    'webhooks',
    'shared-state',
    'mcp-tools',
  ];
  for (const m of modules)
    assert.doesNotThrow(() => require(path.join(SRC, m)), `Failed to require ${m}`);
});

test('ENG-04: package.json dependencies are exact-version pinned', async () => {
  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  for (const group of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(pkg[group] || {})) {
      assert.ok(!/^[~^><=]/.test(version), `${name} uses range prefix: ${version}`);
    }
  }
});

test('ENG-09: no bare catch {} blocks in application code', () => {
  const files = [
    'server.js',
    'routes.js',
    'watchers.js',
    'tmux-lifecycle.js',
    'ws-terminal.js',
    'session-resolver.js',
    'session-utils.js',
    'safe-exec.js',
    'keepalive.js',
    'config.js',
    'logger.js',
    'db.js',
    'shared-state.js',
    'mcp-tools.js',
    'mcp-server.js',
    'webhooks.js',
  ];
  for (const file of files) {
    const fp = path.join(SRC, file);
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, 'utf-8');
    const matches = content.match(/catch\s*\(\s*\w*\s*\)\s*\{\s*\}/g);
    assert.equal(matches, null, `${file} contains bare catch {}: ${matches?.join(', ')}`);
  }
});

test('ENG-12: no blocking I/O in async functions', () => {
  const asyncFiles = [
    'watchers.js',
    'session-resolver.js',
    'keepalive.js',
    'routes.js',
  ];
  for (const file of asyncFiles) {
    const content = fs.readFileSync(path.join(SRC, file), 'utf-8');
    const syncCalls = content.match(/\breadFileSync\b|\bwriteFileSync\b|\bexecSync\b/g);
    if (syncCalls && file !== 'config.js') {
      assert.fail(`${file} contains blocking I/O call: ${syncCalls.join(', ')}`);
    }
  }
});

test('SRV-05: uncaught exception exits with structured error', async () => {
  await fsp.mkdir(fixtures.paths.workspace, { recursive: true });
  await fsp.mkdir(fixtures.paths.claudeHome, { recursive: true });

  const tmpData = require('os').tmpdir() + '/bp-srv05-' + Date.now();
  await fsp.mkdir(tmpData, { recursive: true });

  try {
    const trigger = path.join(ROOT, 'tests', 'fixtures', 'trigger-uncaught.js');
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: '0',
        NODE_OPTIONS: `--require ${trigger}`,
        WORKSPACE: fixtures.paths.workspace,
        CLAUDE_HOME: fixtures.paths.claudeHome,
        WORKBENCH_DATA: tmpData,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += String(c);
    });
    const code = await new Promise((r) => child.on('exit', r));
    assert.notEqual(code, 0);
    assert.match(stderr, /test-uncaught-exception/);
  } finally {
    await fsp.rm(tmpData, { recursive: true, force: true });
  }
});
