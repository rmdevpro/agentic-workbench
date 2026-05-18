'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const createWatchers = require('../../src/watchers.js');

// #586: mock chokidar lib. Captures every watch() call so tests can assert
// 1-watcher-per-dir refcounting + invoke add/change handlers manually.
function makeMockChokidar() {
  const watchers = [];
  return {
    watchers,
    watch(path /*, opts */) {
      const w = {
        _path: path,
        _closed: false,
        _handlers: { add: [], change: [], error: [] },
        on(event, fn) {
          if (this._handlers[event]) this._handlers[event].push(fn);
          return this;
        },
        close() { this._closed = true; return Promise.resolve(); },
        emit(event, payload) {
          (this._handlers[event] || []).forEach((fn) => fn(payload));
        },
      };
      watchers.push(w);
      return w;
    },
  };
}

function makeEnv(overrides = {}) {
  const watched = new Map(),
    unwatchCalls = [],
    timers = [];
  const origST = global.setTimeout,
    origCT = global.clearTimeout;
  global.setTimeout = (fn, ms) => {
    const h = { fn, ms, cleared: false };
    timers.push(h);
    return h;
  };
  global.clearTimeout = (h) => {
    if (h) h.cleared = true;
  };
  // Keep the fs.watchFile/unwatchFile patches in place because the settings
  // watchers (startSettingsWatcher / startGeminiSettingsWatcher / startCodexSettingsWatcher)
  // still use fs.watchFile (smaller blast radius — only 3 file handles total).
  const origW = fs.watchFile,
    origU = fs.unwatchFile;
  fs.watchFile = (p, o, l) => {
    watched.set(p, { options: o, listener: l });
  };
  fs.unwatchFile = (p) => {
    unwatchCalls.push(p);
    watched.delete(p);
  };

  const ccCalls = [];
  const swc = overrides.sessionWsClients || new Map();
  const _chokidar = overrides._chokidar || makeMockChokidar();
  const w = createWatchers({
    db: {
      getSessionByPrefix: (p) => overrides.sessionByPrefix?.[p],
      getProjectById: (id) => overrides.projectsById?.[id],
      getProjects: () => overrides.projects || [],
    },
    safe: { findSessionsDir: () => '/tmp/sessions' },
    config: { get: (k, fb) => fb },
    sessionUtils: {
      getTokenUsage: async () => ({
        input_tokens: 500,
        model: 'claude-sonnet-4-6',
        max_tokens: 200000,
      }),
    },
    sessionWsClients: swc,
    _checkCompactionNeeds_removed: async (...a) => {
      ccCalls.push(a);
    },
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: '/tmp/claude',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    _chokidar,
  });

  return {
    w,
    watched,
    unwatchCalls,
    timers,
    ccCalls,
    swc,
    _chokidar,
    cleanup() {
      fs.watchFile = origW;
      fs.unwatchFile = origU;
      global.setTimeout = origST;
      global.clearTimeout = origCT;
    },
  };
}

test('WAT-03: debounces rapid changes into one callback', async () => {
  const wsMessages = [];
  const ws = { readyState: 1, send: (m) => wsMessages.push(JSON.parse(m)) };
  const env = makeEnv({
    sessionByPrefix: { abc123: { id: 'abc123', project_id: 1 } },
    projectsById: { 1: { id: 1, name: 'p', path: '/workspace/p' } },
    sessionWsClients: new Map([['wb_abc123', ws]]),
  });
  try {
    env.w.startJsonlWatcher('wb_abc123');
    // #586: one chokidar watcher rooted at the parent dir; we simulate three
    // rapid `change` events on the routed file path.
    assert.equal(env._chokidar.watchers.length, 1, 'startJsonlWatcher must register exactly one chokidar watcher');
    const fw = env._chokidar.watchers[0];
    const filePath = '/tmp/sessions/abc123.jsonl';
    fw.emit('change', filePath);
    fw.emit('change', filePath);
    fw.emit('change', filePath);
    const active = env.timers.filter((t) => !t.cleared);
    assert.equal(active.length, 1);
    await active[0].fn();
    assert.equal(wsMessages.length, 1);
    assert.equal(wsMessages[0].type, 'token_update');
  } finally {
    env.cleanup();
  }
});

test('WAT-04: stopJsonlWatcher closes the chokidar watcher when its last session unsubscribes', () => {
  const env = makeEnv({
    sessionByPrefix: { abc: { id: 'abc', project_id: 1 } },
    projectsById: { 1: { id: 1, name: 'p', path: '/tmp' } },
  });
  try {
    env.w.startJsonlWatcher('wb_abc');
    const fw = env._chokidar.watchers[0];
    fw.emit('change', '/tmp/sessions/abc.jsonl');
    env.w.stopJsonlWatcher('wb_abc');
    assert.equal(fw._closed, true, '#586: dir watcher must close when its last session detaches');
    assert.equal(env.timers[0].cleared, true);
  } finally {
    env.cleanup();
  }
});

test('WAT: watcher does not start for new_ or t_ sessions', () => {
  const env = makeEnv({ sessionByPrefix: {} });
  try {
    env.w.startJsonlWatcher('wb_new_123');
    assert.equal(env._chokidar.watchers.length, 0);
    env.w.startJsonlWatcher('wb_t_456');
    assert.equal(env._chokidar.watchers.length, 0);
  } finally {
    env.cleanup();
  }
});

test('WAT: watcher does not start when session not in DB', () => {
  const env = makeEnv({ sessionByPrefix: {} });
  try {
    env.w.startJsonlWatcher('wb_unknown');
    assert.equal(env._chokidar.watchers.length, 0);
  } finally {
    env.cleanup();
  }
});

test('WAT: watcher does not start when project not in DB', () => {
  const env = makeEnv({
    sessionByPrefix: { xyz: { id: 'xyz', project_id: 99 } },
    projectsById: {},
  });
  try {
    env.w.startJsonlWatcher('wb_xyz');
    assert.equal(env._chokidar.watchers.length, 0, 'Should not watch when project missing');
  } finally {
    env.cleanup();
  }
});

test('WAT: stopJsonlWatcher is idempotent when no watcher exists', () => {
  const env = makeEnv({});
  try {
    // Should not throw — refcount has nothing to decrement.
    env.w.stopJsonlWatcher('wb_nonexistent');
    assert.equal(env._chokidar.watchers.length, 0);
  } finally {
    env.cleanup();
  }
});

test('WAT: JSONL watcher callback handles ENOENT gracefully', async () => {
  const ws = { readyState: 1, send: () => {} };
  const errors = [];
  const _chokidar = makeMockChokidar();
  const w2 = createWatchers({
    db: {
      getSessionByPrefix: (p) => ({ err1: { id: 'err1', project_id: 1 } })[p],
      getProjectById: (id) => ({ 1: { id: 1, name: 'p', path: '/tmp' } })[id],
      getProjects: () => [],
    },
    safe: { findSessionsDir: () => '/tmp/sessions' },
    config: { get: (k, fb) => fb },
    sessionUtils: {
      getTokenUsage: async () => {
        const e = new Error('gone');
        e.code = 'ENOENT';
        throw e;
      },
    },
    sessionWsClients: new Map([['wb_err1', ws]]),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: '/tmp/claude',
    logger: { info() {}, warn() {}, error: (msg) => errors.push(msg), debug() {} },
    _chokidar,
  });
  const env = makeEnv({});  // for timer patching
  try {
    w2.startJsonlWatcher('wb_err1');
    const fw = _chokidar.watchers[0];
    if (fw) {
      fw.emit('change', '/tmp/sessions/err1.jsonl');
      const active = env.timers.filter((t) => !t.cleared);
      if (active.length > 0) {
        // Should not throw — ENOENT is swallowed by the handler.
        await active[0].fn();
      }
    }
    assert.equal(errors.length, 0, 'ENOENT must not surface as an error log');
  } finally {
    env.cleanup();
  }
});

test('WAT-586-01: two sessions in the same project share a single chokidar watcher (refcounted)', () => {
  const env = makeEnv({
    sessionByPrefix: {
      a1: { id: 'a1', project_id: 1 },
      b2: { id: 'b2', project_id: 1 },
    },
    projectsById: { 1: { id: 1, name: 'p', path: '/workspace/p' } },
  });
  try {
    env.w.startJsonlWatcher('wb_a1');
    env.w.startJsonlWatcher('wb_b2');
    assert.equal(env._chokidar.watchers.length, 1,
      '#586: 2 sessions in the same project must share 1 chokidar watcher (not spawn 2)');
    // Detach a1 — watcher must stay open (b2 still subscribed)
    env.w.stopJsonlWatcher('wb_a1');
    assert.equal(env._chokidar.watchers[0]._closed, false,
      '#586: shared watcher must remain open while any session is still subscribed');
    // Detach b2 — watcher should now close
    env.w.stopJsonlWatcher('wb_b2');
    assert.equal(env._chokidar.watchers[0]._closed, true,
      '#586: shared watcher must close after the last session detaches');
  } finally {
    env.cleanup();
  }
});

test('WAT-586-02: routes change events to the right session by file path', async () => {
  const msgsA = []; const msgsB = [];
  const wsA = { readyState: 1, send: (m) => msgsA.push(JSON.parse(m)) };
  const wsB = { readyState: 1, send: (m) => msgsB.push(JSON.parse(m)) };
  const env = makeEnv({
    sessionByPrefix: {
      a1: { id: 'a1', project_id: 1 },
      b2: { id: 'b2', project_id: 1 },
    },
    projectsById: { 1: { id: 1, name: 'p', path: '/workspace/p' } },
    sessionWsClients: new Map([['wb_a1', wsA], ['wb_b2', wsB]]),
  });
  try {
    env.w.startJsonlWatcher('wb_a1');
    env.w.startJsonlWatcher('wb_b2');
    const fw = env._chokidar.watchers[0];
    // Change event on a1's file path — only a1's ws should receive token_update
    fw.emit('change', '/tmp/sessions/a1.jsonl');
    const active = env.timers.filter((t) => !t.cleared);
    assert.equal(active.length, 1, 'only one session\'s handler should be scheduled');
    await active[0].fn();
    assert.equal(msgsA.length, 1, 'a1 must receive token_update');
    assert.equal(msgsB.length, 0, 'b2 must NOT receive token_update for a1\'s change');
  } finally {
    env.cleanup();
  }
});

// ── startSettingsWatcher tests ─────────────────────────────────────────────

test('WAT-SW-01: startSettingsWatcher registers a file watcher', () => {
  const env = makeEnv({});
  try {
    env.w.startSettingsWatcher();
    assert.ok(env.watched.size >= 1, 'Should register settings watcher');
    // Calling again should be idempotent
    env.w.startSettingsWatcher();
    assert.ok(env.watched.size >= 1, 'Second call should be idempotent');
  } finally {
    env.cleanup();
  }
});

test('WAT-SW-02: settings watcher sends update to connected websockets', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const wsMessages = [];
  const ws = { readyState: 1, send: (m) => wsMessages.push(JSON.parse(m)) };
  const swc = new Map([['wb_s1', ws]]);

  const tmpClaudeHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'bp-wat-sw-'));
  await fsp.writeFile(
    path.join(tmpClaudeHome, 'settings.json'),
    JSON.stringify({ model: 'opus', effortLevel: 'high' }),
  );

  const env = makeEnv({ sessionWsClients: swc });
  // We need a watcher with the real CLAUDE_HOME pointing to our temp dir
  const w2 = createWatchers({
    db: { getSessionByPrefix: () => null, getProjectById: () => null, getProjects: () => [] },
    safe: { findSessionsDir: () => '/tmp/sessions' },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: swc,
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpClaudeHome,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  try {
    w2.startSettingsWatcher();
    // Find the watcher callback
    const settingsPath = path.join(tmpClaudeHome, 'settings.json');
    const watcher = env.watched.get(settingsPath);
    if (watcher) {
      await watcher.listener();
      assert.equal(wsMessages.length, 1, 'Should send one settings_update');
      assert.equal(wsMessages[0].type, 'settings_update');
      assert.equal(wsMessages[0].model, 'opus');
    }
  } finally {
    env.cleanup();
  }
});

test('WAT-SW-03: settings watcher handles invalid JSON gracefully', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const tmpClaudeHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'bp-wat-sw-bad-'));
  await fsp.writeFile(path.join(tmpClaudeHome, 'settings.json'), 'not valid json{');

  const swc = new Map();
  const env = makeEnv({ sessionWsClients: swc });
  const w2 = createWatchers({
    db: { getSessionByPrefix: () => null, getProjectById: () => null, getProjects: () => [] },
    safe: { findSessionsDir: () => '/tmp/sessions' },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: swc,
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpClaudeHome,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  try {
    w2.startSettingsWatcher();
    const settingsPath = path.join(tmpClaudeHome, 'settings.json');
    const watcher = env.watched.get(settingsPath);
    if (watcher) {
      // Should not throw
      await watcher.listener();
    }
  } finally {
    env.cleanup();
  }
});

// ── registerMcpServer tests ────────────────────────────────────────────────

test('WAT-MCP-01: registerMcpServer creates settings.json when not present', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const tmpClaudeHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'bp-wat-mcp-'));

  const env = makeEnv({});
  const w2 = createWatchers({
    db: { getSessionByPrefix: () => null, getProjectById: () => null, getProjects: () => [] },
    safe: { findSessionsDir: () => '/tmp/sessions' },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpClaudeHome,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  try {
    await w2.registerMcpServer();
    const content = JSON.parse(
      await fsp.readFile(path.join(tmpClaudeHome, 'settings.json'), 'utf-8'),
    );
    assert.ok(content.mcpServers.workbench, 'Should have workbench MCP server registered');
    assert.equal(content.mcpServers.workbench.command, 'node');
  } finally {
    env.cleanup();
  }
});

test('WAT-MCP-02: registerMcpServer skips when already registered correctly', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const tmpClaudeHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'bp-wat-mcp2-'));
  const expectedArgs = [path.join(__dirname, '../../src/mcp-server.js')];
  await fsp.writeFile(
    path.join(tmpClaudeHome, 'settings.json'),
    JSON.stringify({
      mcpServers: { workbench: { command: 'node', args: expectedArgs } },
    }),
  );

  const env = makeEnv({});
  const w2 = createWatchers({
    db: { getSessionByPrefix: () => null, getProjectById: () => null, getProjects: () => [] },
    safe: { findSessionsDir: () => '/tmp/sessions' },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpClaudeHome,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  try {
    await w2.registerMcpServer();
    // Should not have overwritten — file should still be the same
    const content = JSON.parse(
      await fsp.readFile(path.join(tmpClaudeHome, 'settings.json'), 'utf-8'),
    );
    assert.ok(content.mcpServers.workbench);
  } finally {
    env.cleanup();
  }
});

test('WAT-MCP-03: registerMcpServer handles corrupt settings.json', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const tmpClaudeHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'bp-wat-mcp3-'));
  await fsp.writeFile(path.join(tmpClaudeHome, 'settings.json'), 'corrupt{json');

  const errors = [];
  const env = makeEnv({});
  const w2 = createWatchers({
    db: { getSessionByPrefix: () => null, getProjectById: () => null, getProjects: () => [] },
    safe: { findSessionsDir: () => '/tmp/sessions' },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpClaudeHome,
    logger: { info() {}, warn() {}, error: (msg) => errors.push(msg), debug() {} },
  });
  try {
    await w2.registerMcpServer();
    // Should log an error about corrupt JSON and return without writing
    assert.ok(
      errors.some((e) => /corrupt/i.test(e)),
      'Should report corrupt settings',
    );
  } finally {
    env.cleanup();
  }
});

// ── trustProjectDirs tests ─────────────────────────────────────────────────

test('WAT-TPD-01: trustProjectDirs creates .claude.json when not present', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const tmpClaudeHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'bp-wat-tpd-'));

  const env = makeEnv({});
  const w2 = createWatchers({
    db: {
      getSessionByPrefix: () => null,
      getProjectById: () => null,
      getProjects: () => [{ path: '/workspace/proj1' }],
    },
    safe: { findSessionsDir: () => '/tmp/sessions' },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpClaudeHome,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  try {
    await w2.trustProjectDirs();
    const content = JSON.parse(
      await fsp.readFile(path.join(tmpClaudeHome, '.claude.json'), 'utf-8'),
    );
    assert.ok(content.projects['/workspace/proj1'], 'Should trust the project dir');
    assert.equal(content.projects['/workspace/proj1'].hasTrustDialogAccepted, true);
  } finally {
    env.cleanup();
  }
});

test('WAT-TPD-02: trustProjectDirs skips already trusted projects', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const tmpClaudeHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'bp-wat-tpd2-'));
  await fsp.writeFile(
    path.join(tmpClaudeHome, '.claude.json'),
    JSON.stringify({
      projects: { '/workspace/proj1': { hasTrustDialogAccepted: true } },
    }),
  );

  const env = makeEnv({});
  const w2 = createWatchers({
    db: {
      getSessionByPrefix: () => null,
      getProjectById: () => null,
      getProjects: () => [{ path: '/workspace/proj1' }],
    },
    safe: { findSessionsDir: () => '/tmp/sessions' },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpClaudeHome,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  try {
    await w2.trustProjectDirs();
    // Should not have modified the file (no new projects)
    const content = JSON.parse(
      await fsp.readFile(path.join(tmpClaudeHome, '.claude.json'), 'utf-8'),
    );
    assert.ok(content.projects['/workspace/proj1'].hasTrustDialogAccepted);
  } finally {
    env.cleanup();
  }
});

test('WAT-TPD-03: trustProjectDirs handles corrupt .claude.json', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const tmpClaudeHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'bp-wat-tpd3-'));
  await fsp.writeFile(path.join(tmpClaudeHome, '.claude.json'), 'bad json!!!');

  const errors = [];
  const env = makeEnv({});
  const w2 = createWatchers({
    db: {
      getSessionByPrefix: () => null,
      getProjectById: () => null,
      getProjects: () => [{ path: '/workspace/p' }],
    },
    safe: { findSessionsDir: () => '/tmp/sessions' },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpClaudeHome,
    logger: { info() {}, warn() {}, error: (msg) => errors.push(msg), debug() {} },
  });
  try {
    await w2.trustProjectDirs();
    assert.ok(
      errors.some((e) => /corrupt/i.test(e)),
      'Should report corrupt .claude.json',
    );
  } finally {
    env.cleanup();
  }
});

// ── ensureSettings tests ───────────────────────────────────────────────────

test('WAT-ES-01: ensureSettings creates settings.json when missing', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const tmpClaudeHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'bp-wat-es-'));

  const env = makeEnv({});
  const w2 = createWatchers({
    db: { getSessionByPrefix: () => null, getProjectById: () => null, getProjects: () => [] },
    safe: { findSessionsDir: () => '/tmp/sessions' },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpClaudeHome,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  try {
    await w2.ensureSettings();
    const content = JSON.parse(
      await fsp.readFile(path.join(tmpClaudeHome, 'settings.json'), 'utf-8'),
    );
    assert.equal(content.skipDangerousModePermissionPrompt, true);
  } finally {
    env.cleanup();
  }
});

test('WAT-ES-02: ensureSettings does nothing when settings.json already exists', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const tmpClaudeHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'bp-wat-es2-'));
  await fsp.writeFile(
    path.join(tmpClaudeHome, 'settings.json'),
    JSON.stringify({ customKey: true }),
  );

  const env = makeEnv({});
  const w2 = createWatchers({
    db: { getSessionByPrefix: () => null, getProjectById: () => null, getProjects: () => [] },
    safe: { findSessionsDir: () => '/tmp/sessions' },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpClaudeHome,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  try {
    await w2.ensureSettings();
    // File should still have customKey, not overwritten
    const content = JSON.parse(
      await fsp.readFile(path.join(tmpClaudeHome, 'settings.json'), 'utf-8'),
    );
    assert.equal(content.customKey, true);
  } finally {
    env.cleanup();
  }
});

// ── startCompactionMonitor tests ───────────────────────────────────────────

// ── trustProjectDirs error branch tests ───────────────────────────────────

test('WAT-TPD-04: trustProjectDirs warns on non-SyntaxError, non-ENOENT read failure', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const tmpClaudeHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'bp-wat-tpd4-'));

  const warns = [];
  const env = makeEnv({});
  const w2 = createWatchers({
    db: {
      getSessionByPrefix: () => null,
      getProjectById: () => null,
      getProjects: () => [{ path: '/workspace/p' }],
    },
    safe: { findSessionsDir: () => '/tmp/sessions' },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpClaudeHome,
    logger: { info() {}, warn: (msg) => warns.push(msg), error() {}, debug() {} },
  });

  // Patch fsp.readFile to throw a generic (non-ENOENT, non-SyntaxError) error
  const origReadFile = fsp.readFile;
  fsp.readFile = async (p, enc) => {
    if (typeof p === 'string' && p.endsWith('.claude.json')) {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      throw err;
    }
    return origReadFile(p, enc);
  };
  try {
    // Should not throw — just warn and continue (no write happens since no projects changed)
    await w2.trustProjectDirs();
    assert.ok(
      warns.some((w) => /Failed to read/i.test(w)),
      'Should warn about read failure',
    );
  } finally {
    fsp.readFile = origReadFile;
    env.cleanup();
  }
});

test('WAT-TPD-05: trustProjectDirs logs error on write failure', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const tmpClaudeHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'bp-wat-tpd5-'));

  const errors = [];
  const env = makeEnv({});
  const w2 = createWatchers({
    db: {
      getSessionByPrefix: () => null,
      getProjectById: () => null,
      // New project so changed=true and writeFile is attempted
      getProjects: () => [{ path: '/workspace/newproj' }],
    },
    safe: { findSessionsDir: () => '/tmp/sessions' },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpClaudeHome,
    logger: { info() {}, warn() {}, error: (msg) => errors.push(msg), debug() {} },
  });

  // Patch fsp.writeFile to fail when writing .claude.json
  const origWriteFile = fsp.writeFile;
  fsp.writeFile = async (p, data) => {
    if (typeof p === 'string' && p.endsWith('.claude.json')) {
      throw new Error('disk full');
    }
    return origWriteFile(p, data);
  };
  try {
    await w2.trustProjectDirs();
    assert.ok(
      errors.some((e) => /Failed to update trust/i.test(e)),
      'Should log error on write failure',
    );
  } finally {
    fsp.writeFile = origWriteFile;
    env.cleanup();
  }
});

// ── ensureSettings error branch tests ─────────────────────────────────────

test('WAT-ES-03: ensureSettings logs error on inner write failure (ENOENT path)', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  // Use a temp dir that does NOT have settings.json so stat throws ENOENT
  const tmpClaudeHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'bp-wat-es3-'));

  const errors = [];
  const env = makeEnv({});
  const w2 = createWatchers({
    db: { getSessionByPrefix: () => null, getProjectById: () => null, getProjects: () => [] },
    safe: { findSessionsDir: () => '/tmp/sessions' },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpClaudeHome,
    logger: { info() {}, warn() {}, error: (msg) => errors.push(msg), debug() {} },
  });

  // Patch fsp.writeFile to fail when writing settings.json
  const origWriteFile = fsp.writeFile;
  fsp.writeFile = async (p, data) => {
    if (typeof p === 'string' && p.endsWith('settings.json')) {
      throw new Error('no space left');
    }
    return origWriteFile(p, data);
  };
  try {
    await w2.ensureSettings();
    assert.ok(
      errors.some((e) => /Could not ensure base settings/i.test(e)),
      'Should log inner write failure',
    );
  } finally {
    fsp.writeFile = origWriteFile;
    env.cleanup();
  }
});

test('WAT-ES-04: ensureSettings logs error on non-ENOENT stat failure', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const tmpClaudeHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'bp-wat-es4-'));

  const errors = [];
  const env = makeEnv({});
  const w2 = createWatchers({
    db: { getSessionByPrefix: () => null, getProjectById: () => null, getProjects: () => [] },
    safe: { findSessionsDir: () => '/tmp/sessions' },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpClaudeHome,
    logger: { info() {}, warn() {}, error: (msg) => errors.push(msg), debug() {} },
  });

  // Patch fsp.stat to fail with a non-ENOENT error
  const origStat = fsp.stat;
  fsp.stat = async (p) => {
    if (typeof p === 'string' && p.endsWith('settings.json')) {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      throw err;
    }
    return origStat(p);
  };
  try {
    await w2.ensureSettings();
    assert.ok(
      errors.some((e) => /Unexpected error checking settings/i.test(e)),
      'Should log non-ENOENT stat error',
    );
  } finally {
    fsp.stat = origStat;
    env.cleanup();
  }
});

// ── #451: Gemini + Codex /session slash command installers ────────────────

test('WAT-451-01: registerGeminiSessionCommands writes TOML files to ~/.gemini/commands/session/', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const tmpHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'wat-451-gem-'));
  const w2 = createWatchers({
    db: { getSessionByPrefix: () => null, getProjectById: () => null, getProjects: () => [] },
    safe: { findSessionsDir: () => '/tmp/sessions', HOME: tmpHome },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpHome,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  await w2.registerGeminiSessionCommands();
  const transition = await fsp.readFile(path.join(tmpHome, '.gemini', 'commands', 'session', 'transition.toml'), 'utf-8');
  const resume = await fsp.readFile(path.join(tmpHome, '.gemini', 'commands', 'session', 'resume.toml'), 'utf-8');
  assert.match(transition, /session_prepare_pre_compact/, 'transition.toml must call session_prepare_pre_compact');
  assert.match(transition, /!\{echo -n \$WORKBENCH_SESSION_ID\}/, 'transition.toml must use shell substitution for session_id');
  assert.match(resume, /session_resume_post_compact/, 'resume.toml must call session_resume_post_compact');
  assert.match(resume, /!\{echo -n \$WORKBENCH_SESSION_ID\}/, 'resume.toml must use shell substitution for session_id');
});

test('WAT-451-02: registerGeminiSessionCommands is idempotent — preserves existing files', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const tmpHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'wat-451-gemi-'));
  const cmdDir = path.join(tmpHome, '.gemini', 'commands', 'session');
  await fsp.mkdir(cmdDir, { recursive: true });
  const userCustom = 'description = "user custom"\nprompt = "do something else"\n';
  await fsp.writeFile(path.join(cmdDir, 'transition.toml'), userCustom);

  const w2 = createWatchers({
    db: { getSessionByPrefix: () => null, getProjectById: () => null, getProjects: () => [] },
    safe: { findSessionsDir: () => '/tmp/sessions', HOME: tmpHome },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpHome,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  await w2.registerGeminiSessionCommands();
  const transition = await fsp.readFile(path.join(cmdDir, 'transition.toml'), 'utf-8');
  assert.equal(transition, userCustom, 'pre-existing transition.toml must NOT be overwritten');
  // resume.toml didn't exist — should be written
  const resume = await fsp.readFile(path.join(cmdDir, 'resume.toml'), 'utf-8');
  assert.match(resume, /session_resume_post_compact/);
});

test('WAT-451-03: registerCodexSessionSkills writes SKILL.md files to ~/.agents/skills/ (#449 corrected path)', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const tmpHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'wat-451-cod-'));
  const w2 = createWatchers({
    db: { getSessionByPrefix: () => null, getProjectById: () => null, getProjects: () => [] },
    safe: { findSessionsDir: () => '/tmp/sessions', HOME: tmpHome },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpHome,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  await w2.registerCodexSessionSkills();
  const transition = await fsp.readFile(path.join(tmpHome, '.agents', 'skills', 'session-transition', 'SKILL.md'), 'utf-8');
  const resume = await fsp.readFile(path.join(tmpHome, '.agents', 'skills', 'session-resume', 'SKILL.md'), 'utf-8');
  // SKILL.md frontmatter requires name + description
  assert.match(transition, /^---\nname: session-transition\n/, 'SKILL.md must declare name: session-transition');
  assert.match(transition, /description:/, 'SKILL.md must have description');
  assert.match(transition, /session_prepare_pre_compact/, 'SKILL.md must instruct MCP tool call');
  assert.match(transition, /WORKBENCH_SESSION_ID/, 'SKILL.md must reference the env var');
  assert.match(resume, /^---\nname: session-resume\n/);
  assert.match(resume, /session_resume_post_compact/);
});

test('WAT-451-04: registerCodexSessionSkills is idempotent — preserves existing files', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const tmpHome = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'wat-451-codi-'));
  const skillDir = path.join(tmpHome, '.agents', 'skills', 'session-transition');
  await fsp.mkdir(skillDir, { recursive: true });
  const userCustom = '---\nname: session-transition\ndescription: user custom\n---\n\ndo something else\n';
  await fsp.writeFile(path.join(skillDir, 'SKILL.md'), userCustom);

  const w2 = createWatchers({
    db: { getSessionByPrefix: () => null, getProjectById: () => null, getProjects: () => [] },
    safe: { findSessionsDir: () => '/tmp/sessions', HOME: tmpHome },
    config: { get: (k, fb) => fb },
    sessionUtils: { getTokenUsage: async () => ({}) },
    sessionWsClients: new Map(),
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    CLAUDE_HOME: tmpHome,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  await w2.registerCodexSessionSkills();
  const transition = await fsp.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
  assert.equal(transition, userCustom, 'pre-existing SKILL.md must NOT be overwritten');
  const resume = await fsp.readFile(path.join(tmpHome, '.agents', 'skills', 'session-resume', 'SKILL.md'), 'utf-8');
  assert.match(resume, /session_resume_post_compact/);
});

// startCompactionMonitor removed — smart compaction stripped (#32)
