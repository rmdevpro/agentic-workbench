'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createSessionResolver = require('../../src/session-resolver.js');

function makeResolver({ filesByDir = new Map(), tmuxAlive = new Set(), configValues = {} } = {}) {
  const sessions = new Map();
  const db = {
    sessions,    db: { transaction: (fn) => fn },

    getProjects: () => [{ id: 1, name: 'proj', path: '/workspace/proj' }],
    getSessionsForProject: (pid) => [...sessions.values()].filter((s) => s.project_id === pid),
    getSession: (id) => sessions.get(id),
    upsertSession: (id, pid, name) => {
      const e = sessions.get(id) || {};
      const r = {
        id,
        project_id: pid,
        name: e.name ?? name,
        notes: e.notes || '',
        state: e.state || 'active',
        user_renamed: e.user_renamed || 0,
      };
      sessions.set(id, r);
      return r;
    },
    renameSession: (id, name) => {
      const r = sessions.get(id);
      if (r) {
        r.name = name;
        r.user_renamed = 1;
      }
    },
    setSessionNotes: (id, notes) => {
      const r = sessions.get(id);
      if (r) r.notes = notes;
    },
    setSessionState: (id, state) => {
      const r = sessions.get(id);
      if (r) r.state = state;
    },
    deleteSession: (id) => sessions.delete(id),
  };
  const renameCalls = [];
  const safe = {
    findSessionsDir: () => '/sessions/_workspace_proj',
    tmuxExecAsync: async (args) => {
      if (args[0] === 'rename-session') {
        renameCalls.push(args);
        return '';
      }
      throw new Error('unexpected');
    },
  };
  const sleepCalls = [];
  const resolver = createSessionResolver({
    db,
    safe,
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async (n) => tmuxAlive.has(n),
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    config: { get: (k, fb) => configValues[k] ?? fb },
  });
  const readdirMock = async (dir) => {
    if (!filesByDir.has(dir)) {
      const e = new Error('ENOENT');
      e.code = 'ENOENT';
      throw e;
    }
    const v = filesByDir.get(dir);
    return typeof v === 'function' ? v() : v;
  };
  return { resolver, db, renameCalls, sleepCalls, readdirMock };
}

test('RES-02: resolution preserves name, notes, state', async (t) => {
  const dir = '/sessions/_workspace_proj';
  const env = makeResolver({
    filesByDir: new Map([[dir, ['real123.jsonl']]]),
    configValues: { 'resolver.maxAttempts': 1, 'resolver.sleepMs': 1 },
  });
  env.db.sessions.set('new_1', {
    id: 'new_1',
    project_id: 1,
    name: 'Custom',
    notes: 'note',
    state: 'hidden',
    user_renamed: 1,
  });
  t.mock.method(require('node:fs/promises'), 'readdir', env.readdirMock);
  await env.resolver.resolveSessionId('new_1', {
    tmux: 'wb_new_1',
    sessionsDir: dir,
    existingFiles: new Set(),
    projectId: 1,
  });
  const real = env.db.getSession('real123');
  assert.equal(real.name, 'Custom');
  assert.equal(real.notes, 'note');
  assert.equal(real.state, 'hidden');
  assert.equal(env.db.getSession('new_1'), undefined);
});

test('RES-03: duplicate resolution suppressed', async (t) => {
  const dir = '/sessions/_workspace_proj';
  let reads = 0;
  const env = makeResolver({
    filesByDir: new Map([
      [
        dir,
        () => {
          reads++;
          return ['r.jsonl'];
        },
      ],
    ]),
    configValues: { 'resolver.maxAttempts': 1, 'resolver.sleepMs': 1 },
  });
  env.db.sessions.set('new_1', {
    id: 'new_1',
    project_id: 1,
    name: 'T',
    notes: '',
    state: 'active',
    user_renamed: 0,
  });
  t.mock.method(require('node:fs/promises'), 'readdir', env.readdirMock);
  await Promise.all([
    env.resolver.resolveSessionId('new_1', {
      tmux: 'wb_new_1',
      sessionsDir: dir,
      existingFiles: new Set(),
      projectId: 1,
    }),
    env.resolver.resolveSessionId('new_1', {
      tmux: 'wb_new_1',
      sessionsDir: dir,
      existingFiles: new Set(),
      projectId: 1,
    }),
  ]);
  assert.equal(reads, 1);
});

test('RES-04: timeout with dead tmux deletes temp session', async (t) => {
  const dir = '/sessions/_workspace_proj';
  const env = makeResolver({
    filesByDir: new Map([[dir, []]]),
    configValues: { 'resolver.maxAttempts': 2, 'resolver.sleepMs': 1 },
  });
  env.db.sessions.set('new_1', {
    id: 'new_1',
    project_id: 1,
    name: 'T',
    notes: '',
    state: 'active',
    user_renamed: 0,
  });
  t.mock.method(require('node:fs/promises'), 'readdir', env.readdirMock);
  await env.resolver.resolveSessionId('new_1', {
    tmux: 'wb_new_1',
    sessionsDir: dir,
    existingFiles: new Set(),
    projectId: 1,
  });
  assert.equal(env.db.getSession('new_1'), undefined);
});

test('RES-05: timeout with live tmux keeps temp session', async (t) => {
  const dir = '/sessions/_workspace_proj';
  const env = makeResolver({
    filesByDir: new Map([[dir, []]]),
    tmuxAlive: new Set(['wb_new_1']),
    configValues: { 'resolver.maxAttempts': 2, 'resolver.sleepMs': 1 },
  });
  env.db.sessions.set('new_1', {
    id: 'new_1',
    project_id: 1,
    name: 'T',
    notes: '',
    state: 'active',
    user_renamed: 0,
  });
  t.mock.method(require('node:fs/promises'), 'readdir', env.readdirMock);
  await env.resolver.resolveSessionId('new_1', {
    tmux: 'wb_new_1',
    sessionsDir: dir,
    existingFiles: new Set(),
    projectId: 1,
  });
  assert.ok(env.db.getSession('new_1'));
});

test('RES-07: startup removes orphans when no sessions dir', async (t) => {
  const env = makeResolver({
    filesByDir: new Map(),
    configValues: { 'resolver.maxAttempts': 1, 'resolver.sleepMs': 1 },
  });
  env.db.sessions.set('new_1', {
    id: 'new_1',
    project_id: 1,
    name: 'T',
    notes: '',
    state: 'active',
    user_renamed: 0,
  });
  t.mock.method(require('node:fs/promises'), 'readdir', env.readdirMock);
  await env.resolver.resolveStaleNewSessions();
  assert.equal(env.db.getSession('new_1'), undefined);
});

test('RES-08: concurrent JSONL creation resolves to first file', async (t) => {
  const dir = '/sessions/_workspace_proj';
  const env = makeResolver({
    filesByDir: new Map([[dir, ['file_a.jsonl', 'file_b.jsonl']]]),
    configValues: { 'resolver.maxAttempts': 1, 'resolver.sleepMs': 1 },
  });
  env.db.sessions.set('new_1', {
    id: 'new_1',
    project_id: 1,
    name: 'T',
    notes: '',
    state: 'active',
    user_renamed: 0,
  });
  t.mock.method(require('node:fs/promises'), 'readdir', env.readdirMock);
  await env.resolver.resolveSessionId('new_1', {
    tmux: 'wb_new_1',
    sessionsDir: dir,
    existingFiles: new Set(),
    projectId: 1,
  });
  assert.ok(env.db.getSession('file_a'));
  assert.equal(env.db.getSession('new_1'), undefined);
});

test('RES-09: resolveSessionId handles tmux rename failure (no server running)', async (t) => {
  const dir = '/sessions/_workspace_proj';
  const sessions = new Map();
  const db = {
    sessions,    db: { transaction: (fn) => fn },

    getProjects: () => [{ id: 1, name: 'proj', path: '/workspace/proj' }],
    getSessionsForProject: (pid) => [...sessions.values()].filter((s) => s.project_id === pid),
    getSession: (id) => sessions.get(id),
    upsertSession: (id, pid, name) => {
      const r = { id, project_id: pid, name, notes: '', state: 'active', user_renamed: 0 };
      sessions.set(id, r);
      return r;
    },
    renameSession: (id, name) => {
      const r = sessions.get(id);
      if (r) {
        r.name = name;
        r.user_renamed = 1;
      }
    },
    setSessionNotes: (id, notes) => {
      const r = sessions.get(id);
      if (r) r.notes = notes;
    },
    setSessionState: (id, state) => {
      const r = sessions.get(id);
      if (r) r.state = state;
    },
    deleteSession: (id) => sessions.delete(id),
  };
  const resolver = createSessionResolver({
    db,
    safe: {
      findSessionsDir: () => dir,
      tmuxExecAsync: async () => {
        throw new Error('no server running');
      },
    },
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    sleep: async () => {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    config: { get: (k, fb) => ({ 'resolver.maxAttempts': 1, 'resolver.sleepMs': 1 })[k] ?? fb },
  });
  sessions.set('new_t1', {
    id: 'new_t1',
    project_id: 1,
    name: 'T',
    notes: '',
    state: 'active',
    user_renamed: 0,
  });
  t.mock.method(require('node:fs/promises'), 'readdir', async () => ['real1.jsonl']);
  await resolver.resolveSessionId('new_t1', {
    tmux: 'wb_new_t1',
    sessionsDir: dir,
    existingFiles: new Set(),
    projectId: 1,
  });
  // Resolution should succeed despite rename failure
  assert.ok(db.getSession('real1'), 'Should resolve to real1');
  assert.equal(db.getSession('new_t1'), undefined);
});

test('RES-10: resolveSessionId handles tmux rename failure (other error)', async (t) => {
  const dir = '/sessions/_workspace_proj';
  const sessions = new Map();
  const db = {
    sessions,    db: { transaction: (fn) => fn },

    getSession: (id) => sessions.get(id),
    upsertSession: (id, pid, name) => {
      const r = { id, project_id: pid, name, notes: '', state: 'active', user_renamed: 0 };
      sessions.set(id, r);
      return r;
    },
    renameSession: () => {},
    setSessionNotes: () => {},
    setSessionState: () => {},
    deleteSession: (id) => sessions.delete(id),
  };
  const resolver = createSessionResolver({
    db,
    safe: {
      findSessionsDir: () => dir,
      tmuxExecAsync: async () => {
        throw new Error('session not found: wb_new_t2');
      },
    },
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    sleep: async () => {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    config: { get: (k, fb) => ({ 'resolver.maxAttempts': 1, 'resolver.sleepMs': 1 })[k] ?? fb },
  });
  sessions.set('new_t2', {
    id: 'new_t2',
    project_id: 1,
    name: 'T',
    notes: '',
    state: 'active',
    user_renamed: 0,
  });
  t.mock.method(require('node:fs/promises'), 'readdir', async () => ['real2.jsonl']);
  await resolver.resolveSessionId('new_t2', {
    tmux: 'wb_new_t2',
    sessionsDir: dir,
    existingFiles: new Set(),
    projectId: 1,
  });
  assert.ok(db.getSession('real2'), 'Should resolve despite rename error');
});

test('RES-11: resolveStaleNewSessions resolves stale sessions at startup', async (t) => {
  const dir = '/sessions/_workspace_proj';
  const env = makeResolver({
    filesByDir: new Map([[dir, ['real_abc.jsonl']]]),
    configValues: { 'resolver.maxAttempts': 1, 'resolver.sleepMs': 1 },
  });
  env.db.sessions.set('new_stale1', {
    id: 'new_stale1',
    project_id: 1,
    name: 'Stale',
    notes: 'preserved',
    state: 'archived',
    user_renamed: 1,
  });
  t.mock.method(require('node:fs/promises'), 'readdir', env.readdirMock);
  await env.resolver.resolveStaleNewSessions();
  assert.ok(env.db.getSession('real_abc'), 'Should resolve to real session');
  assert.equal(env.db.getSession('real_abc').name, 'Stale', 'Should preserve name');
  assert.equal(env.db.getSession('real_abc').notes, 'preserved', 'Should preserve notes');
  assert.equal(env.db.getSession('real_abc').state, 'archived', 'Should preserve state');
  assert.equal(env.db.getSession('new_stale1'), undefined, 'Stale session should be deleted');
});

test('RES-12: resolveStaleNewSessions skips if real session already exists', async (t) => {
  const dir = '/sessions/_workspace_proj';
  const env = makeResolver({
    filesByDir: new Map([[dir, ['existing.jsonl']]]),
    configValues: { 'resolver.maxAttempts': 1, 'resolver.sleepMs': 1 },
  });
  // Both the stale new_ and the real session exist
  env.db.sessions.set('new_dup', {
    id: 'new_dup',
    project_id: 1,
    name: 'Dup',
    notes: '',
    state: 'active',
    user_renamed: 0,
  });
  env.db.sessions.set('existing', {
    id: 'existing',
    project_id: 1,
    name: 'Already Here',
    notes: '',
    state: 'active',
    user_renamed: 0,
  });
  t.mock.method(require('node:fs/promises'), 'readdir', env.readdirMock);
  await env.resolver.resolveStaleNewSessions();
  // new_dup should be cleaned up, existing should remain unchanged
  assert.equal(env.db.getSession('new_dup'), undefined, 'Stale session should be removed');
  assert.equal(
    env.db.getSession('existing').name,
    'Already Here',
    'Existing session should be unchanged',
  );
});

test('RES-13: resolveStaleNewSessions cleans up orphans without unmatched JSONLs', async (t) => {
  const dir = '/sessions/_workspace_proj';
  const env = makeResolver({
    filesByDir: new Map([[dir, ['known.jsonl']]]),
    configValues: { 'resolver.maxAttempts': 1, 'resolver.sleepMs': 1 },
  });
  // The new_ session and the known session both exist — no unmatched JSONLs
  env.db.sessions.set('new_orphan', {
    id: 'new_orphan',
    project_id: 1,
    name: 'Orphan',
    notes: '',
    state: 'active',
    user_renamed: 0,
  });
  env.db.sessions.set('known', {
    id: 'known',
    project_id: 1,
    name: 'Known',
    notes: '',
    state: 'active',
    user_renamed: 0,
  });
  t.mock.method(require('node:fs/promises'), 'readdir', env.readdirMock);
  await env.resolver.resolveStaleNewSessions();
  // No unmatched files → orphan gets cleaned up
  assert.equal(env.db.getSession('new_orphan'), undefined, 'Orphan should be cleaned up');
  assert.ok(env.db.getSession('known'), 'Known session should remain');
});

test('RES-14: resolveStaleNewSessions handles readdir non-ENOENT error', async (t) => {
  const dir = '/sessions/_workspace_proj';
  const errors = [];
  const sessions = new Map();
  const db = {
    sessions,    db: { transaction: (fn) => fn },

    getProjects: () => [{ id: 1, name: 'proj', path: '/workspace/proj' }],
    getSessionsForProject: (pid) => [...sessions.values()].filter((s) => s.project_id === pid),
    getSession: (id) => sessions.get(id),
    upsertSession: (id, pid, name) => {
      sessions.set(id, { id, project_id: pid, name, notes: '', state: 'active', user_renamed: 0 });
    },
    deleteSession: (id) => sessions.delete(id),
  };
  const resolver = createSessionResolver({
    db,
    safe: { findSessionsDir: () => dir, tmuxExecAsync: async () => '' },
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    sleep: async () => {},
    logger: { info() {}, warn() {}, error: (msg, _meta) => errors.push(msg), debug() {} },
    config: { get: (k, fb) => ({ 'resolver.maxAttempts': 1, 'resolver.sleepMs': 1 })[k] ?? fb },
  });
  sessions.set('new_err', {
    id: 'new_err',
    project_id: 1,
    name: 'T',
    notes: '',
    state: 'active',
    user_renamed: 0,
  });
  t.mock.method(require('node:fs/promises'), 'readdir', async () => {
    throw new Error('permission denied');
  });
  await resolver.resolveStaleNewSessions();
  assert.ok(
    errors.some((e) => /Cannot read sessions dir/i.test(e)),
    'Should log error for non-ENOENT',
  );
});

test('RES-15: resolveSessionId handles readdir non-ENOENT error during polling', async (t) => {
  const dir = '/sessions/_workspace_proj';
  let callCount = 0;
  const env = makeResolver({ configValues: { 'resolver.maxAttempts': 2, 'resolver.sleepMs': 1 } });
  env.db.sessions.set('new_poll_err', {
    id: 'new_poll_err',
    project_id: 1,
    name: 'T',
    notes: '',
    state: 'active',
    user_renamed: 0,
  });
  t.mock.method(require('node:fs/promises'), 'readdir', async () => {
    callCount++;
    if (callCount === 1) throw new Error('disk error');
    return ['resolved.jsonl'];
  });
  await env.resolver.resolveSessionId('new_poll_err', {
    tmux: 'wb_new_poll_err',
    sessionsDir: dir,
    existingFiles: new Set(),
    projectId: 1,
  });
  // Should have retried and resolved on second attempt
  assert.ok(env.db.getSession('resolved'), 'Should resolve after transient error');
});

// #338 [A13]: discoverCliSessionId now uses fsp/promises throughout. End-to-end
// test against a real tmpdir to confirm the async paths still see new files.
test('RES-16: discoverCliSessionId resolves Gemini session id from new chat file', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-resgem-'));
  const chatsDir = path.join(home, '.gemini', 'tmp', 'cwdhash', 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });

  const sessions = new Map();
  const cliSessionIds = new Map();
  const db = {
    sessions,
    setCliSessionId: (id, cliId) => cliSessionIds.set(id, cliId),
    getSessionsForProject: () => [],
    getSession: (id) => sessions.get(id),
    upsertSession: () => {},
    renameSession: () => {},
    setSessionNotes: () => {},
    setSessionState: () => {},
    deleteSession: () => {},
    getProjects: () => [],
  };
  let sleepCalls = 0;
  const chatFile = path.join(chatsDir, 'session-abc.json');
  const resolver = require('../../src/session-resolver.js')({
    db,
    safe: { HOME: home, findSessionsDir: () => '/unused' },
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => true,
    // Drop the new chat file during the FIRST sleep so the poll loop sees
    // it as a "new file" relative to the empty snapshot.
    sleep: async () => {
      sleepCalls += 1;
      if (sleepCalls === 1) {
        fs.writeFileSync(chatFile, JSON.stringify({ sessionId: 'gem-cli-id-abc123' }));
      }
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    config: { get: (_k, fb) => fb },
  });

  await resolver.discoverCliSessionId('wb-sess-1', 'gemini');
  assert.equal(cliSessionIds.get('wb-sess-1'), 'gem-cli-id-abc123');
});
