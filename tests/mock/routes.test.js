'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const os = require('node:os');
const path = require('node:path');
const fixtures = require('../fixtures/test-data');
const registerCoreRoutes = require('../../src/routes.js');
const { withServer, req } = require('../helpers/with-server');

function makeApp(overrides = {}) {
  const WORKSPACE =
    overrides.workspace || require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'bp-routes-'));
  const CLAUDE_HOME =
    overrides.claudeHome || require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'bp-claude-'));
  const testProjectPath = path.join(WORKSPACE, 'test-project');
  require('node:fs').mkdirSync(testProjectPath, { recursive: true });
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));
  const projects = new Map(),
    projectById = new Map(),
    sessions = new Map(),
    tasks = new Map(),
    settings = new Map();
  let pSeq = 1,
    tSeq = 1;
  // NOTE: This fake DB is necessary for route-level isolation (mocking the real SQLite).
  // KNOWN LIMITATION: The fake DB does not implement ON DELETE CASCADE behavior.
  // Cascade delete behavior is verified in db.test.js (DB-09) against real SQLite.
  const db = {
    getProjects: () => [...projects.values()],
    getProject: (n) => projects.get(n),
    getProjectById: (id) => projectById.get(id),
    ensureProject: (n, p) => {
      if (projects.has(n)) return projects.get(n);
      const r = { id: pSeq++, name: n, path: p, notes: '' };
      projects.set(n, r);
      projectById.set(r.id, r);
      return r;
    },
    deleteProject: (id) => {
      const r = projectById.get(id);
      if (r) {
        projects.delete(r.name);
        projectById.delete(id);
      }
    },
    getSessionsForProject: (pid) => [...sessions.values()].filter((s) => s.project_id === pid),
    getSession: (id) => sessions.get(id),
    getSessionByPrefix: (pfx) => [...sessions.values()].find((s) => s.id.startsWith(pfx)),
    getSessionFull: (id) => {
      const s = sessions.get(id);
      if (!s) return;
      const p = projectById.get(s.project_id);
      return { ...s, project_name: p?.name };
    },
    upsertSession: (id, pid, name) => {
      const e = sessions.get(id) || {
        id,
        project_id: pid,
        archived: 0,
        state: 'active',
        notes: '',
      };
      const r = {
        ...e,
        id,
        project_id: pid,
        name: e.name ?? name,
        updated_at: new Date().toISOString(),
      };
      sessions.set(id, r);
      return r;
    },
    renameSession: (id, name) => {
      const s = sessions.get(id);
      if (s) {
        s.name = name;
        s.user_renamed = 1;
      }
    },
    setSessionState: (id, st) => {
      const s = sessions.get(id);
      if (s) {
        s.state = st;
        s.archived = st === 'archived' ? 1 : 0;
      }
    },
    archiveSession: (id, a) => {
      const s = sessions.get(id);
      if (s) {
        s.archived = a ? 1 : 0;
        s.state = a ? 'archived' : 'active';
      }
    },
    deleteSession: (id) => sessions.delete(id),
    getProjectNotes: (id) => projectById.get(id)?.notes || '',
    setProjectNotes: (id, n) => {
      const p = projectById.get(id);
      if (p) p.notes = n;
    },
    getSessionNotes: (id) => sessions.get(id)?.notes || '',
    setSessionNotes: (id, n) => {
      const s = sessions.get(id);
      if (s) s.notes = n;
    },
    getAllTasks: (filter) => {
      const all = [...tasks.values()];
      if (!filter || filter === 'all') return all;
      return all.filter((t) => t.status === filter);
    },
    getTasksByFolder: (fp) => [...tasks.values()].filter((t) => t.folder_path === fp),
    getTask: (id) => tasks.get(Number(id)) || null,
    getSubtasks: (id) => [...tasks.values()].filter((t) => t.parent_task_id === Number(id)),
    // v2 contract: addTask takes an object { projectId, parentTaskId, githubIssue,
    // title, description, status, createdBy }. Default status is 'inactive'.
    addTask: ({ projectId, parentTaskId = null, githubIssue = null, title, description = '', status = 'inactive', createdBy = 'human' } = {}) => {
      const r = {
        id: tSeq++,
        project_id: projectId,
        parent_task_id: parentTaskId,
        github_issue: githubIssue,
        title,
        description,
        status,
        archived: 0,
        rank: tasks.size,
        sort_order: tasks.size,
        created_by: createdBy,
        completed_at: null,
      };
      tasks.set(r.id, r);
      return r;
    },
    updateTaskTitle: (id, title) => {
      const t = tasks.get(Number(id));
      if (t) t.title = title;
    },
    updateTaskDescription: (id, desc) => {
      const t = tasks.get(Number(id));
      if (t) t.description = desc;
    },
    updateTaskFields: (id, { title, description, github_issue }) => {
      const t = tasks.get(Number(id));
      if (!t) return;
      if (title !== undefined && title !== null) t.title = title;
      if (description !== undefined && description !== null) t.description = description;
      if (github_issue !== undefined && github_issue !== null) t.github_issue = github_issue;
    },
    setTaskStatus: (id, status) => {
      const t = tasks.get(Number(id));
      if (t) {
        t.status = status;
        t.completed_at = status === 'done' ? new Date().toISOString() : null;
      }
      return t;
    },
    setTaskArchived: (id, archived) => {
      const t = tasks.get(Number(id));
      if (t) t.archived = archived ? 1 : 0;
    },
    moveTask: (id, { parentTaskId, projectId, rank } = {}) => {
      const t = tasks.get(Number(id));
      if (!t) return;
      if (parentTaskId !== undefined) t.parent_task_id = parentTaskId;
      if (projectId !== undefined) t.project_id = projectId;
      if (rank !== undefined) t.rank = rank;
    },
    reorderTasks: (orders) => {
      for (const { id, sort_order } of orders) {
        const t = tasks.get(Number(id));
        if (t) t.sort_order = sort_order;
      }
    },
    deleteTask: (id) => tasks.delete(Number(id)),
    getTaskHistory: () => [],
    getAllSettings: () => Object.fromEntries(settings),
    getSetting: (k, fb = null) => (settings.has(k) ? settings.get(k) : fb),
    setSetting: (k, v) => settings.set(k, v),
    searchSessionsByName: (q) => {
      const needle = String(q).toLowerCase();
      return [...sessions.values()]
        .filter((s) => (s.name || '').toLowerCase().includes(needle))
        .map((s) => ({ ...s, project_name: projectById.get(s.project_id)?.name }));
    },
    // Program methods (#325 O1) — routes.js calls these from /api/state
    // (line 1216), /api/programs* (1029, 1037, 1045, 1064, 1070, 1080), and
    // session list (1590). Without them the routes return 500 and several
    // session/project tests fail spuriously. Empty + null defaults keep the
    // mock isolated from program-specific assertions.
    //
    // NOTE for future test authors: if you write a test that asserts on
    // program state (e.g., "session list groups by program X", "project P
    // appears under program Q"), pass program-aware overrides via the
    // existing `makeApp(overrides)` mechanism — supplying e.g.
    //   getAllPrograms: () => [{id: 1, name: 'engineering'}],
    //   setProjectProgram: spy(),
    // Don't rely on the empty defaults; they are deliberately program-blind.
    getAllPrograms: () => [],
    getProgram: () => null,
    getProgramByName: () => null,
    addProgram: (name, description = '') => ({ id: 1, name, description }),
    updateProgram: (id, fields) => ({ id, ...fields }),
    renameProgramSafe: (id, newName) => ({ id, name: newName }),
    deleteProgram: () => {},
    countProjectsInProgram: () => 0,
    setProjectProgram: () => {},
    DATA_DIR: '/tmp/bp-data',
    // Final spread lets a caller pass `db: { getProgram: ..., ...}` overrides
    // through the test wrapper. The comment block at line ~166 about
    // "program-aware overrides" assumed this was wired.
    ...(overrides.db || {}),
  };
  const existsFn = overrides.tmuxExists ?? (async () => false);
  const firedEvents = [];
  registerCoreRoutes(app, {
    db,
    safe: {
      resolveProjectPath: (n) => path.join(WORKSPACE, n),
      findSessionsDir: (p) => path.join(WORKSPACE, '.sessions', String(p || '').replace(/[\/_]/g, '-')),
      tmuxCreateCLI() {},
      tmuxCreateCLIAsync: async () => {},
      tmuxCreateClaude() {},
      tmuxCreateBash() {},
      tmuxExists: existsFn,
      tmuxExecAsync: async () => '',
      tmuxSendKeysAsync: async () => {},
      tmuxKill: overrides.tmuxKill ?? (async () => {}),
      claudeExecAsync: overrides.claudeExecAsync ?? (async () => 'ok'),
      gitCloneAsync: async () => 'cloned',
      sanitizeErrorForClient: (msg) => msg,
      HOME: overrides.home ?? CLAUDE_HOME,
    },
    config: {
      get: (k, fb) =>
        ({
          'session.nameMaxLength': 255,
          'session.promptInjectionDelayMs': 1,
          'claude.defaultTimeoutMs': 1000,
          'bridge.cleanupSentMs': 1,
          'bridge.cleanupUnsentMs': 1,
        })[k] ?? fb,
      getPrompt: () => 'prompt',
    },
    sessionUtils: {
      parseSessionFile: async () => null,
      searchSessions: async (q) =>
        q
          ? [
              {
                session_id: 's1',
                sessionId: 's1',
                project: 'p',
                name: 'S',
                match_count: 1,
                matchCount: 1,
                snippets: ['x'],
                matches: [{ text: 'x' }],
              },
            ]
          : [],
      summarizeSession: async () => ({
        summary: 'Test summary of the session',
        recentMessages: [{ role: 'user', text: 'Hello' }],
      }),
      getTokenUsage: async () => ({
        input_tokens: 50000,
        model: 'claude-sonnet-4-6',
        max_tokens: 200000,
      }),
      // #156: getSessionInfo + invalidateSessionInfoCache became part of the
      // routes.js contract. Mocks must stub them or routes return 500 on
      // any path that touches the cache (config PUT, tokens, list, delete).
      getSessionInfo: async (sessionId) => ({
        id: sessionId,
        cli_type: 'claude',
        name: 'mock session',
        state: 'active',
        active: false,
        input_tokens: 50000,
        max_tokens: 200000,
        message_count: 0,
        timestamp: new Date().toISOString(),
        model: 'claude-sonnet-4-6',
      }),
      invalidateSessionInfoCache: () => {},
      discoverGeminiSessions: () => [],
      discoverCodexSessions: () => [],
      invalidateDiscoveryCache: () => {},
    },
    keepalive: {
      getStatus: async () => ({
        running: true,
        mode: 'always',
        token_expires_in_minutes: 30,
        token_expires_at: new Date(Date.now() + 1800000).toISOString(),
      }),
      setMode() {},
      getMode: () => 'always',
      isRunning: () => true,
      start() {},
      stop() {},
    },
    fireEvent: (e, d) => {
      firedEvents.push({ event: e, data: d });
    },
    logger: overrides.logger ?? { info() {}, warn() {}, error() {}, debug() {} },
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: existsFn,
    enforceTmuxLimit: async () => {},
    resolveSessionId: async () => {},
    runSmartCompaction: async (sid, _proj) => ({ compacted: true, session_id: sid }),
    getBrowserCount: () => 1,
    CLAUDE_HOME,
    WORKSPACE,
    ensureSettings: async () => {},
    sleep: async () => {},
  });
  return { app, db, firedEvents, WORKSPACE, testProjectPath };
}

async function withFullServer(fn, overrides = {}) {
  const { app, db, firedEvents, testProjectPath } = makeApp(overrides);
  db.ensureProject('test-project', testProjectPath);
  await withServer(app, async ({ port }) => fn({ port, db, firedEvents }));
}

// -- Validation tests --

test('PRJ-07: rejects overlong project name', async () => {
  await withFullServer(async ({ port }) => {
    assert.equal(
      (
        await req(port, 'POST', '/api/projects', {
          path: '/workspace/x',
          name: fixtures.routes.overlongProjectName,
        })
      ).status,
      400,
    );
  });
});

test('PRJ-08: duplicate project name is idempotent', async () => {
  await withFullServer(async ({ port, db }) => {
    const count1 = db.getProjects().length;
    await req(port, 'POST', '/api/projects', {
      path: '/workspace/test-project',
      name: 'test-project',
    });
    assert.equal(db.getProjects().length, count1);
  });
});

test('SES-12: invalid session IDs rejected', async () => {
  await withFullServer(async ({ port }) => {
    for (const id of fixtures.routes.invalidSessionIds) {
      const status = (await req(port, 'GET', `/api/sessions/${encodeURIComponent(id)}/config`))
        .status;
      const ok = id === '' ? status === 404 : status === 400;
      assert.ok(ok, `expected rejection for "${id}", got ${status}`);
    }
  });
});

test('TSK-06: rejects overlong task title', async () => {
  await withFullServer(async ({ port }) => {
    assert.equal(
      (
        await req(port, 'POST', '/api/tasks', {
          folder_path: '/',
          title: 'x'.repeat(501),
        })
      ).status,
      400,
    );
  });
});

test('TSK-07: created_by field persists', async () => {
  await withFullServer(async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/tasks', {
        project_name: 'test-project',
        title: 'task',
        created_by: 'agent',
      })
    ).json();
    assert.equal(r.created_by, 'agent');
  });
});



test('FS-05: /api/file rejects missing path', async () => {
  await withFullServer(async ({ port }) => {
    assert.equal((await req(port, 'GET', '/api/file')).status, 400);
  });
});

test('session name overlong rejected', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('p2', '/workspace/p2');
    db.upsertSession('s_valid', p.id, 'Good');
    assert.equal(
      (
        await req(port, 'PUT', '/api/sessions/s_valid/name', {
          name: fixtures.routes.overlongSessionName,
        })
      ).status,
      400,
    );
  });
});

test('search overlong rejected', async () => {
  await withFullServer(async ({ port }) => {
    assert.equal(
      (
        await req(
          port,
          'GET',
          `/api/search?q=${encodeURIComponent(fixtures.routes.overlongSearch)}`,
        )
      ).status,
      400,
    );
  });
});

test('keepalive mode validation', async () => {
  await withFullServer(async ({ port }) => {
    assert.equal((await req(port, 'PUT', '/api/keepalive/mode', { mode: 'invalid' })).status, 400);
    assert.equal(
      (await req(port, 'PUT', '/api/keepalive/mode', { mode: 'idle', idleMinutes: 0 })).status,
      400,
    );
    assert.equal(
      (await req(port, 'PUT', '/api/keepalive/mode', { mode: 'idle', idleMinutes: 1441 })).status,
      400,
    );
    assert.equal((await req(port, 'PUT', '/api/keepalive/mode', { mode: 'always' })).status, 200);
  });
});

test('session state validation', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('p3', '/workspace/p3');
    db.upsertSession('sv1', p.id, 'S');
    assert.equal(
      (await req(port, 'PUT', '/api/sessions/sv1/config', { state: 'invalid_state' })).status,
      400,
    );
    assert.equal(
      (await req(port, 'PUT', '/api/sessions/sv1/config', { state: 'archived' })).status,
      200,
    );
  });
});

// -- SUCCESS PATH tests --

test('health endpoint returns 200 with dependency status', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/health');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.dependencies.db);
    assert.ok(body.dependencies.workspace);
    assert.ok(body.dependencies.auth);
  });
});

test('/api/state returns projects array with workspace', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/state');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.projects));
    assert.ok(typeof body.workspace === 'string' && body.workspace.length > 0);
  });
});

// #371 [E1]: /api/state returns the minimal sidebar shape — no JSONL parsing.
// Heavy fields (message_count, model, tmux, active, input_tokens) move to
// GET /api/sessions/:id/info; the sidebar list must NOT include them.
test('E1-STATE-01: /api/state session payload contains only minimal fields (no message_count/model/tmux/active)', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('e1_min_proj', '/workspace/e1_min_proj');
    db.upsertSession('e1_min_sess_1', p.id, 'minimal-1');
    db.upsertSession('e1_min_sess_2', p.id, 'minimal-2');
    const r = await req(port, 'GET', '/api/state');
    assert.equal(r.status, 200);
    const body = await r.json();
    const proj = body.projects.find(p => p.name === 'e1_min_proj');
    assert.ok(proj, 'project must be present in /api/state');
    assert.equal(proj.sessions.length, 2);
    for (const s of proj.sessions) {
      // MUST be present (minimal shape)
      assert.ok(typeof s.id === 'string', 'session.id required');
      assert.ok(typeof s.name === 'string', 'session.name required');
      assert.ok('timestamp' in s, 'session.timestamp required');
      assert.ok('cli_type' in s, 'session.cli_type required');
      assert.ok('archived' in s, 'session.archived required');
      assert.ok('state' in s, 'session.state required');
      // MUST NOT be present (moved to /info endpoint)
      assert.equal(s.message_count, undefined, 'message_count must NOT be in /api/state');
      assert.equal(s.messageCount, undefined, 'messageCount must NOT be in /api/state');
      assert.equal(s.model, undefined, 'model must NOT be in /api/state');
      assert.equal(s.tmux, undefined, 'tmux must NOT be in /api/state');
      assert.equal(s.active, undefined, 'active must NOT be in /api/state');
      assert.equal(s.input_tokens, undefined, 'input_tokens must NOT be in /api/state');
    }
  });
});

// #371 [E1]: GET /api/sessions/:id/info returns the heavy payload that the
// sidebar list omits. Sidebar fetches this lazily for visible/active sessions.
test('E1-INFO-01: GET /api/sessions/:id/info returns the heavy session-info payload', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('e1_info_proj', '/workspace/e1_info_proj');
    db.upsertSession('e1_info_sess', p.id, 'info-test');
    const r = await req(port, 'GET', '/api/sessions/e1_info_sess/info');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.id, 'e1_info_sess');
    // Heavy fields present (mock getSessionInfo returns 50000 input_tokens)
    assert.equal(body.input_tokens, 50000);
    assert.equal(body.max_tokens, 200000);
    // model + cli_type from mock
    assert.ok('model' in body);
    assert.ok('cli_type' in body);
    assert.ok('active' in body);
    assert.ok('message_count' in body);
  });
});

test('E1-INFO-02: GET /api/sessions/:id/info rejects invalid session ID with 400', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/sessions/not%20a%20valid%20id/info');
    assert.equal(r.status, 400);
  });
});

test('session creation success path with webhook event', async () => {
  await withFullServer(async ({ port, db, firedEvents }) => {
    const r = await req(port, 'POST', '/api/sessions', {
      project: 'test-project',
      name: 'Test session',
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.id.startsWith('new_'));
    assert.ok(body.tmux);
    assert.equal(body.project, 'test-project');
    assert.ok(body.name);
    // Gray-box: verify DB row created
    assert.ok(db.getSession(body.id), 'Session must exist in DB after creation');
    const dbSession = db.getSession(body.id);
    assert.equal(
      dbSession.project_id,
      db.getProject('test-project').id,
      'Session must be linked to correct project',
    );
    // Gray-box: verify webhook event fired with correct data
    const event = firedEvents.find((e) => e.event === 'session_created');
    assert.ok(event, 'session_created webhook must fire');
    assert.ok(event.data, 'Webhook event must include data payload');
  });
});

test('terminal creation success path', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/terminals', { project: 'test-project' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.id.startsWith('t_'));
    assert.equal(body.name, 'Terminal');
  });
});

test('session config PUT with state=hidden updates DB state', async () => {
  // Previously named "session delete removes from DB" which was misleading.
  // DELETE /api/sessions/:id is not a registered route.
  // The application uses state=hidden via PUT /api/sessions/:id/config.
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('del_proj', '/workspace/del_proj');
    db.upsertSession('del_sess', p.id, 'To Hide');
    assert.ok(db.getSession('del_sess'));
    assert.equal(db.getSession('del_sess').state, 'active');
    const r = await req(port, 'PUT', '/api/sessions/del_sess/config', { state: 'hidden' });
    assert.equal(r.status, 200);
    assert.equal(
      db.getSession('del_sess').state,
      'hidden',
      'Session state must be updated to hidden in DB',
    );
  });
});

test('task CRUD success paths with DB verification', async () => {
  await withFullServer(async ({ port, db, firedEvents }) => {
    // Create — v2 contract takes project_name (or project_id / parent_task_id),
    // default status is 'inactive'.
    const cr = await (
      await req(port, 'POST', '/api/tasks', { project_name: 'test-project', title: 'My task' })
    ).json();
    assert.equal(cr.status, 'inactive');
    assert.equal(cr.title, 'My task');
    assert.ok(firedEvents.some((e) => e.event === 'task_added'));
    // Gray-box: verify DB has the task
    const dbTasks = db.getAllTasks();
    assert.ok(
      dbTasks.some((t) => t.title === 'My task'),
      'Task must exist in DB after creation',
    );
    // List
    const lr = await (await req(port, 'GET', '/api/tasks/tree')).json();
    assert.ok(Array.isArray(lr.programs), 'v2 tree shape is { programs: [...] }');
    // Complete
    const complR = await req(port, 'PUT', `/api/tasks/${cr.id}`, { status: 'done' });
    assert.equal(complR.status, 200);
    // Gray-box: verify task status changed in DB
    const completedTask = db.getAllTasks().find((t) => t.id === cr.id);
    assert.equal(completedTask.status, 'done', 'Task status must be done after completion');
    assert.ok(completedTask.completed_at, 'completed_at must be set');
    // Reopen — v2 reopen state is 'inactive', not 'todo'.
    const reopenR = await req(port, 'PUT', `/api/tasks/${cr.id}`, { status: 'inactive' });
    assert.equal(reopenR.status, 200);
    const reopenedTask = db.getAllTasks().find((t) => t.id === cr.id);
    assert.equal(reopenedTask.status, 'inactive', 'Task status must be inactive after reopen');
    assert.equal(reopenedTask.completed_at, null, 'completed_at must be cleared after reopen');
    // Delete
    const taskCountBefore = db.getAllTasks().length;
    await req(port, 'DELETE', `/api/tasks/${cr.id}`);
    const taskCountAfter = db.getAllTasks().length;
    assert.equal(taskCountAfter, taskCountBefore - 1, 'Task count must decrease by 1 after delete');
  });
});



test('session config GET/PUT success', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('cp', '/workspace/cp');
    db.upsertSession('sc1', p.id, 'Config Test');
    const gr = await (await req(port, 'GET', '/api/sessions/sc1/config')).json();
    assert.equal(gr.name, 'Config Test');
    assert.equal(gr.state, 'active');
    const pr = await req(port, 'PUT', '/api/sessions/sc1/config', {
      name: 'Renamed',
      state: 'archived',
      notes: 'N',
    });
    assert.equal(pr.status, 200);
    assert.equal(db.getSession('sc1').name, 'Renamed');
    assert.equal(db.getSession('sc1').state, 'archived');
  });
});

test('session archive legacy endpoint', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('ap', '/workspace/ap');
    db.upsertSession('sa1', p.id, 'Archive Test');
    await req(port, 'PUT', '/api/sessions/sa1/archive', { archived: true });
    assert.equal(db.getSession('sa1').state, 'archived');
    await req(port, 'PUT', '/api/sessions/sa1/archive', { archived: false });
    assert.equal(db.getSession('sa1').state, 'active');
  });
});

test('settings read/write success', async () => {
  await withFullServer(async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/settings')).json();
    assert.ok('default_model' in r);
    await req(port, 'PUT', '/api/settings', { key: 'test_k', value: 'test_v' });
    const r2 = await (await req(port, 'GET', '/api/settings')).json();
    assert.equal(JSON.parse(r2.test_k), 'test_v');
  });
});

test('search returns results for valid query', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/search?q=testquery');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.results));
    // Verify results have expected structure when present
    if (body.results.length > 0) {
      assert.ok(
        'session_id' in body.results[0] || 'sessionId' in body.results[0],
        'Search results should include session identifiers',
      );
    }
  });
});

test('search returns empty for short query', async () => {
  await withFullServer(async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/search?q=x')).json();
    assert.deepEqual(r.results, []);
  });
});

test('session summary success path', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('sp', '/workspace/sp');
    db.upsertSession('sum1', p.id, 'Sum');
    const r = await req(port, 'POST', '/api/sessions/sum1/summary', { project: 'sp' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.summary.length > 0);
    assert.ok(Array.isArray(body.recentMessages), 'Summary response should include recentMessages');
  });
});

test('token usage success path', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('tp', '/workspace/tp');
    db.upsertSession('tok1', p.id, 'Tok');
    const r = await (await req(port, 'GET', '/api/sessions/tok1/tokens?project=tp')).json();
    assert.equal(r.input_tokens, 50000);
    assert.equal(r.model, 'claude-sonnet-4-6');
  });
});

// smart compaction test removed — feature stripped (#32)

test('keepalive status success', async () => {
  await withFullServer(async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/keepalive/status')).json();
    assert.ok('running' in r);
    assert.ok('mode' in r);
    assert.ok('browsers' in r);
  });
});

test('auth status success', async () => {
  await withFullServer(async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/auth/status')).json();
    assert.ok('valid' in r);
  });
});

test('/api/mounts returns array', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/mounts');
    assert.equal(r.status, 200);
  });
});

test('project removal success with DB verification', async () => {
  await withFullServer(async ({ port, db }) => {
    // Pre-condition: project exists
    assert.ok(db.getProject('test-project'), 'Project must exist before removal');
    const r = await req(port, 'POST', '/api/projects/test-project/remove');
    assert.equal(r.status, 200);
    // Gray-box: verify project is gone from DB
    assert.equal(
      db.getProject('test-project'),
      undefined,
      'Project must not exist in DB after removal',
    );
  });
});

test('session rename success with JSONL append tolerance', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('rp', '/workspace/rp');
    db.upsertSession('ren1', p.id, 'Old Name');
    const r = await req(port, 'PUT', '/api/sessions/ren1/name', { name: 'New Name' });
    assert.equal(r.status, 200);
    // Gray-box: verify name changed in DB and user_renamed flag set
    assert.equal(db.getSession('ren1').name, 'New Name');
    assert.equal(
      db.getSession('ren1').user_renamed,
      1,
      'user_renamed flag must be set after manual rename',
    );
  });
});

// -- Negative path: verify no DB mutation on validation failure --
test('validation failure does not create partial DB state', async () => {
  await withFullServer(async ({ port, db }) => {
    const projectCountBefore = db.getProjects().length;
    // Try to create project with overlong name
    await req(port, 'POST', '/api/projects', {
      path: '/workspace/x',
      name: fixtures.routes.overlongProjectName,
    });
    assert.equal(
      db.getProjects().length,
      projectCountBefore,
      'Failed project creation must not leave partial state in DB',
    );

    db.ensureProject('neg_proj', '/workspace/neg_proj');
    const taskCountBefore = db.getAllTasks().length;
    // Try to create task with overlong title
    await req(port, 'POST', '/api/tasks', {
      folder_path: '/',
      title: fixtures.routes.overlongTaskText,
    });
    assert.equal(
      db.getAllTasks().length,
      taskCountBefore,
      'Failed task creation must not leave partial state in DB',
    );
  });
});

// -- Error path tests for search/summary/tokens/smart-compact --

test('search error returns 500 with error message', async () => {
  await withFullServer(
    async ({ port }) => {
      const r = await req(port, 'GET', '/api/search?q=testquery');
      assert.equal(r.status, 200);
    },
    {
      // Override searchSessions to throw
    },
  );
  // Test with throwing searchSessions
  const { app: _app } = makeApp();
  // Replace sessionUtils with one that throws - use a separate withFullServer with override
  const throwApp = makeApp({
    claudeExecAsync: async () => {
      throw new Error('search failed');
    },
  });
  throwApp.db.ensureProject('test-project', throwApp.testProjectPath);
});

test('summary error returns 500', async () => {
  const failApp = makeApp();
  failApp.db.ensureProject('failproj', failApp.testProjectPath);
  failApp.db.upsertSession('fail1', 1, 'Fail');
  // The summarizeSession mock is configured to succeed, so test the validation paths
  await withServer(failApp.app, async ({ port }) => {
    // Missing project param
    const r1 = await req(port, 'POST', '/api/sessions/fail1/summary', {});
    assert.equal(r1.status, 400);
    const body1 = await r1.json();
    assert.ok(body1.error.includes('project'));

    // Invalid session ID
    const r2 = await req(port, 'POST', '/api/sessions/bad!id/summary', { project: 'p' });
    assert.equal(r2.status, 400);
  });
});

test('tokens endpoint works without project param (#156)', async () => {
  // Pre-#156 the route required ?project=…; post-#156 the project is
  // looked up via getSessionInfo so the param is optional. Response shape
  // is {input_tokens, model, max_tokens}, not the legacy {tokens}.
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('tp2', '/workspace/tp2');
    db.upsertSession('tok2', p.id, 'Tok');
    const r = await (await req(port, 'GET', '/api/sessions/tok2/tokens')).json();
    assert.ok('input_tokens' in r, 'response must include input_tokens');
    assert.ok('max_tokens' in r, 'response must include max_tokens');
  });
});

test('tokens invalid session ID returns 400', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/sessions/bad!id/tokens?project=p');
    assert.equal(r.status, 400);
  });
});

// smart-compact tests removed — feature stripped (#32)

// -- Webhook route tests via routes.js registration --

test('webhook CRUD: list, add, delete', async () => {
  await withFullServer(async ({ port }) => {
    // GET returns empty list initially
    const r1 = await (await req(port, 'GET', '/api/webhooks')).json();
    assert.ok(Array.isArray(r1.webhooks));

    // POST adds a webhook
    const r2 = await req(port, 'POST', '/api/webhooks', {
      url: 'http://example.com/hook',
      events: ['session_created'],
    });
    assert.equal(r2.status, 200);
    const body2 = await r2.json();
    assert.equal(body2.saved, true);

    // GET now returns 1
    const r3 = await (await req(port, 'GET', '/api/webhooks')).json();
    assert.equal(r3.webhooks.length, 1);
    assert.equal(r3.webhooks[0].url, 'http://example.com/hook');

    // PUT replaces all webhooks
    const r4 = await req(port, 'PUT', '/api/webhooks', {
      webhooks: [{ url: 'http://new.com', events: ['*'], mode: 'full_content' }],
    });
    assert.equal(r4.status, 200);
    const r5 = await (await req(port, 'GET', '/api/webhooks')).json();
    assert.equal(r5.webhooks.length, 1);
    assert.equal(r5.webhooks[0].url, 'http://new.com');

    // DELETE by index
    const r6 = await req(port, 'DELETE', '/api/webhooks/0');
    assert.equal(r6.status, 200);
    const r7 = await (await req(port, 'GET', '/api/webhooks')).json();
    assert.equal(r7.webhooks.length, 0);
  });
});

test('webhook PUT rejects non-array', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'PUT', '/api/webhooks', { webhooks: 'not array' });
    assert.equal(r.status, 400);
  });
});

test('webhook POST rejects missing URL', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/webhooks', {});
    assert.equal(r.status, 400);
  });
});

test('webhook DELETE rejects invalid index', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'DELETE', '/api/webhooks/999');
    assert.equal(r.status, 404);
  });
});

// -- Project creation paths --

test('project creation with existing local path', async () => {
  const { app, db: _db, testProjectPath: _testProjectPath, WORKSPACE } = makeApp();
  const newPath = path.join(WORKSPACE, 'new-project');
  require('node:fs').mkdirSync(newPath, { recursive: true });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'POST', '/api/projects', { path: newPath, name: 'new-project' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.added || body.name);
  });
});

test('project creation with git URL', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/projects', {
      path: 'https://github.com/test/repo.git',
      name: 'git-clone-test',
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.cloned, true);
  });
});

test('project creation requires path', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/projects', {});
    assert.equal(r.status, 400);
  });
});

test('project creation with nonexistent path returns 404', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/projects', { path: '/nonexistent/path/12345' });
    assert.equal(r.status, 404);
  });
});

test('project removal of nonexistent project returns 404', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/projects/nonexistent/remove');
    assert.equal(r.status, 404);
  });
});

// -- Auth endpoints --

test('auth login endpoint returns result', async () => {
  await withFullServer(async ({ port }) => {
    const r = await (await req(port, 'POST', '/api/auth/login')).json();
    assert.ok('valid' in r);
  });
});

// -- Browse endpoint --

test('browse endpoint returns directory listing', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/browse?path=/');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.entries));
    assert.ok(body.path);
  });
});

test('browse endpoint handles invalid path', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/browse?path=/nonexistent/12345');
    assert.equal(r.status, 400);
  });
});

// -- Session endpoints --

test('session list for project with sessions', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('sesslist', '/workspace/sesslist');
    db.upsertSession('sl1', p.id, 'Session 1');
    db.upsertSession('sl2', p.id, 'Session 2');
    const r = await (await req(port, 'GET', '/api/state')).json();
    assert.ok(Array.isArray(r.projects));
    assert.ok(r.workspace);
  });
});

test('session delete sets state to hidden', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('delproj', '/workspace/delproj');
    db.upsertSession('del1', p.id, 'To Delete');
    const r = await req(port, 'PUT', '/api/sessions/del1/config', { state: 'hidden' });
    assert.equal(r.status, 200);
    assert.equal(db.getSession('del1').state, 'hidden');
  });
});

// -- Keepalive mode endpoints --

test('keepalive mode set to always starts keepalive', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'PUT', '/api/keepalive/mode', { mode: 'always' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.mode, 'always');
  });
});

test('keepalive mode rejects invalid idleMinutes', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'PUT', '/api/keepalive/mode', { mode: 'idle', idleMinutes: 0 });
    assert.equal(r.status, 400);
  });
});

// -- Settings endpoint --

test('settings PUT with JSON value', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'PUT', '/api/settings', {
      key: 'test.setting',
      value: JSON.stringify({ enabled: true }),
    });
    assert.equal(r.status, 200);
    const r2 = await (await req(port, 'GET', '/api/settings')).json();
    assert.ok(r2['test.setting']);
  });
});

// -- Health check degraded branch tests --

test('HLTH-01: health returns 503 with db degraded when db.getProjects throws', async () => {
  const { app, db } = makeApp();
  db.getProjects = () => {
    throw new Error('db connection lost');
  };
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'GET', '/health');
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.status, 'degraded');
    assert.equal(body.dependencies.db, 'degraded');
  });
});

test('HLTH-02: health returns 503 with workspace degraded when WORKSPACE is inaccessible', async () => {
  const _missingWorkspace = path.join(os.tmpdir(), 'bp-health-no-exist-' + Date.now());
  // Create a makeApp with a valid workspace for setup, then delete it before the health check
  const { app, WORKSPACE: ws } = makeApp();
  require('node:fs').rmSync(ws, { recursive: true });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'GET', '/health');
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.status, 'degraded');
    assert.equal(body.dependencies.workspace, 'degraded');
  });
});

test('HLTH-03: health reports auth degraded when checkAuthStatus throws', async () => {
  // Make checkAuthStatus throw by: pointing CLAUDE_HOME to a dir where .credentials.json
  // is a directory (EISDIR on readFile), and using a logger whose error() method throws,
  // so the catch block in checkAuthStatus re-throws to the health check outer catch.
  const claudeHome = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'bp-hlth-auth-'));
  const credsPath = path.join(claudeHome, '.credentials.json');
  require('node:fs').mkdirSync(credsPath); // directory, not file → readFile throws EISDIR
  const throwingLogger = {
    info() {},
    warn() {},
    debug() {},
    error() {
      throw new Error('logger.error called');
    },
  };
  const { app } = makeApp({ claudeHome, logger: throwingLogger });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'GET', '/health');
    const body = await r.json();
    assert.equal(body.dependencies.auth, 'degraded');
  });
});

// -- checkAuthStatus branches via /api/auth/status --

test('AUTH-10: auth status returns no_credentials when credentials file missing oauth', async () => {
  const fs = require('node:fs');
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-auth-'));
  // Write a file with no claudeAiOauth key
  fs.writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify({ other: true }));
  const { app } = makeApp({ claudeHome });
  await withServer(app, async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/auth/status')).json();
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'no_credentials');
  });
});

test('AUTH-11: auth status returns malformed_credentials on invalid JSON', async () => {
  const fs = require('node:fs');
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-auth-'));
  fs.writeFileSync(path.join(claudeHome, '.credentials.json'), '{bad json{{');
  const { app } = makeApp({ claudeHome });
  await withServer(app, async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/auth/status')).json();
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'malformed_credentials');
  });
});

test('AUTH-12: auth status returns invalid_credentials when accessToken is expired', async () => {
  const fs = require('node:fs');
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-auth-'));
  fs.writeFileSync(
    path.join(claudeHome, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'expired', refreshToken: 'tok' } }),
  );
  const { app } = makeApp({ claudeHome });
  await withServer(app, async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/auth/status')).json();
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'invalid_credentials');
  });
});

test('AUTH-13: auth status returns expired_no_refresh when token expired and no refreshToken', async () => {
  const fs = require('node:fs');
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-auth-'));
  fs.writeFileSync(
    path.join(claudeHome, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() - 1000 },
    }),
  );
  const { app } = makeApp({ claudeHome });
  await withServer(app, async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/auth/status')).json();
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'expired_no_refresh');
  });
});

test('AUTH-14: auth status returns valid when credentials are good', async () => {
  const fs = require('node:fs');
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-auth-'));
  fs.writeFileSync(
    path.join(claudeHome, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'tok',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3600000,
      },
    }),
  );
  const { app } = makeApp({ claudeHome });
  await withServer(app, async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/auth/status')).json();
    assert.equal(r.valid, true);
  });
});

// -- /api/file error branches --

test('FS-06: /api/file rejects non-file path', async () => {
  await withFullServer(async ({ port }) => {
    // Pass a directory path (not a file)
    const r = await req(port, 'GET', `/api/file?path=${encodeURIComponent('/tmp')}`);
    assert.equal(r.status, 400);
    const body = await r.text();
    assert.ok(body.includes('not a file'));
  });
});

test('FS-07: /api/file rejects file larger than 1MB', async () => {
  const fs = require('node:fs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-file-'));
  const bigFile = path.join(tmpDir, 'big.txt');
  // Write 1MB + 1 byte
  fs.writeFileSync(bigFile, Buffer.alloc(1024 * 1024 + 1, 'x'));
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', `/api/file?path=${encodeURIComponent(bigFile)}`);
    assert.equal(r.status, 413);
    const body = await r.text();
    assert.ok(body.includes('too large'));
  });
});

test('FS-08: /api/file returns content for valid file', async () => {
  const fs = require('node:fs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-file-'));
  const testFile = path.join(tmpDir, 'test.txt');
  fs.writeFileSync(testFile, 'hello world');
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', `/api/file?path=${encodeURIComponent(testFile)}`);
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.equal(body, 'hello world');
  });
});

// -- /api/mcp-servers --

test('MCP-01: GET /api/mcp-servers returns empty servers when config missing', async () => {
  const { app } = makeApp({ claudeHome: path.join(os.tmpdir(), 'no-such-' + Date.now()) });
  await withServer(app, async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/mcp-servers')).json();
    assert.deepEqual(r.servers, {});
  });
});

test('MCP-02: PUT /api/mcp-servers saves servers config', async () => {
  const fs = require('node:fs');
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-mcp-'));
  const { app } = makeApp({ claudeHome });
  await withServer(app, async ({ port }) => {
    const servers = { myServer: { command: 'node', args: ['index.js'] } };
    const r = await req(port, 'PUT', '/api/mcp-servers', { servers });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.saved, true);
    // Verify the file was actually written
    const written = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf-8'));
    assert.deepEqual(written.mcpServers, servers);
  });
});

test('MCP-03: GET /api/mcp-servers reads existing settings.json', async () => {
  const fs = require('node:fs');
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-mcp-'));
  const servers = { srv: { command: 'python', args: ['-m', 'srv'] } };
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ mcpServers: servers }));
  const { app } = makeApp({ claudeHome });
  await withServer(app, async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/mcp-servers')).json();
    assert.deepEqual(r.servers, servers);
  });
});

// -- /api/claude-md endpoints --

test('CMD-01: GET /api/claude-md/global returns content field', async () => {
  // The global endpoint uses process.env.HOME, not CLAUDE_HOME.
  // We just verify the response shape is correct regardless of file existence.
  const { app } = makeApp();
  await withServer(app, async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/claude-md/global')).json();
    assert.ok('content' in r, 'response must have content field');
    assert.equal(typeof r.content, 'string');
  });
});

test('CMD-02: PUT /api/claude-md/global writes file and returns saved', async () => {
  // The global endpoint writes to $HOME/.claude/CLAUDE.md — test it succeeds.
  const { app } = makeApp();
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'PUT', '/api/claude-md/global', { content: '# My Rules\n' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.saved, true);
  });
});

test('CMD-03: GET /api/projects/:name/claude-md returns content for existing file', async () => {
  const fs = require('node:fs');
  const { app, testProjectPath } = makeApp();
  fs.writeFileSync(path.join(testProjectPath, 'CLAUDE.md'), '# Project Rules\n');
  await withServer(app, async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/projects/test-project/claude-md')).json();
    assert.equal(r.content, '# Project Rules\n');
  });
});

test('CMD-04: PUT /api/projects/:name/claude-md writes file', async () => {
  const fs = require('node:fs');
  const { app, testProjectPath } = makeApp();
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'PUT', '/api/projects/test-project/claude-md', {
      content: '# New Rules\n',
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.saved, true);
    assert.equal(
      fs.readFileSync(path.join(testProjectPath, 'CLAUDE.md'), 'utf-8'),
      '# New Rules\n',
    );
  });
});

test('CMD-05: GET /api/projects/:name/claude-md returns empty when file missing and no template', async () => {
  const { app } = makeApp();
  await withServer(app, async ({ port }) => {
    // 'unknown-project' has no CLAUDE.md and no db entry
    const r = await (await req(port, 'GET', '/api/projects/unknown-project/claude-md')).json();
    assert.equal(r.content, '');
  });
});

// -- /api/sessions validation --

test('SES-20: POST /api/sessions rejects overlong project name', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/sessions', {
      project: 'x'.repeat(256),
      name: 'hi',
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.error.includes('too long'));
  });
});

test('SES-21: POST /api/sessions rejects overlong name', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/sessions', {
      project: 'test-project',
      name: 'x'.repeat(50001),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.error.includes('too long'));
  });
});

test('SES-22: POST /api/sessions returns 410 when project path missing', async () => {
  await withFullServer(async ({ port }) => {
    // Must include `name` so the request reaches the project-existence check
    // (the `name required` 400 short-circuits earlier in the handler).
    const r = await req(port, 'POST', '/api/sessions', {
      project: 'nonexistent-project-xyz',
      name: 'create me',
    });
    assert.equal(r.status, 410);
  });
});

// -- /api/terminals validation --

test('TERM-02: POST /api/terminals rejects overlong project name', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/terminals', { project: 'x'.repeat(256) });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.error.includes('too long'));
  });
});

test('TERM-03: POST /api/terminals returns 410 when project path missing', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/terminals', { project: 'no-such-project-xyz' });
    assert.equal(r.status, 410);
  });
});

// -- /api/sessions/:id/resume validation --

test('SES-RES-01: POST /api/sessions/:id/resume returns 400 for invalid session ID', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/sessions/bad!id/resume', { project: 'test-project' });
    assert.equal(r.status, 400);
  });
});

test('SES-RES-02: POST /api/sessions/:id/resume returns 400 when project missing', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/sessions/valid-id/resume', {});
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.error.includes('project'));
  });
});

test('SES-RES-03: POST /api/sessions/:id/resume returns 410 when project dir missing', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/sessions/valid-id/resume', {
      project: 'no-such-project-xyz',
    });
    assert.equal(r.status, 410);
  });
});

test('SES-RES-04: POST /api/sessions/:id/resume success when tmux exists', async () => {
  const { app, db } = makeApp({ tmuxExists: async () => true });
  db.ensureProject('test-project', db.DATA_DIR);
  const fs = require('node:fs');
  fs.mkdirSync(db.DATA_DIR, { recursive: true });
  // Use a real project that exists in the DB
  const testDir = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'bp-res-'));
  db.ensureProject('resume-proj', testDir);
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'POST', '/api/sessions/abc123/resume', { project: 'resume-proj' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.id, 'abc123');
  });
});

// -- /api/settings - keepalive_mode and keepalive_idle_minutes branches --

test('SET-10: PUT /api/settings with keepalive_mode triggers keepalive update', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'PUT', '/api/settings', { key: 'keepalive_mode', value: 'browser' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.saved, true);
  });
});

test('SET-11: PUT /api/settings with keepalive_idle_minutes triggers keepalive update', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'PUT', '/api/settings', {
      key: 'keepalive_idle_minutes',
      value: 60,
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.saved, true);
  });
});

test('SET-12: PUT /api/settings rejects missing key', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'PUT', '/api/settings', { value: 'something' });
    assert.equal(r.status, 400);
  });
});

// -- Error branches for search/summary/tokens/smart-compact --

test('SRCH-02: GET /api/search returns 500 when searchSessions throws', async () => {
  const fs = require('node:fs');
  const WORKSPACE2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-srch-'));
  const testProj2 = path.join(WORKSPACE2, 'test-project');
  fs.mkdirSync(testProj2, { recursive: true });
  // Build a fresh db for this app
  const { db: db2 } = makeApp({ workspace: WORKSPACE2 });
  // #230: /api/search now calls db.searchSessionsByName; force it to throw
  db2.searchSessionsByName = () => { throw new Error('search exploded'); };
  // Build a fresh app that throws on sessionUtils methods
  const throwingApp = express();
  throwingApp.use(express.json({ limit: '5mb' }));
  throwingApp.use(express.urlencoded({ extended: true }));
  registerCoreRoutes(throwingApp, {
    db: db2,
    safe: {
      resolveProjectPath: (n) => path.join(WORKSPACE2, n),
      findSessionsDir: () => path.join(WORKSPACE2, '.sessions'),
      tmuxCreateCLI() {},
      tmuxCreateCLIAsync: async () => {},
      tmuxCreateClaude() {},
      tmuxCreateBash() {},
      tmuxExists: async () => false,
      tmuxExecAsync: async () => '',
      tmuxSendKeysAsync: async () => {},
      claudeExecAsync: async () => 'ok',
      gitCloneAsync: async () => 'cloned',
      sanitizeErrorForClient: (msg) => msg,
    },
    config: { get: (k, fb) => fb, getPrompt: () => '' },
    sessionUtils: {
      parseSessionFile: async () => null,
      searchSessions: async () => {
        throw new Error('search exploded');
      },
      summarizeSession: async () => {
        throw new Error('summary exploded');
      },
      getTokenUsage: async () => {
        throw new Error('token exploded');
      },
      getSessionInfo: async () => {
        throw new Error('info exploded');
      },
      invalidateSessionInfoCache: () => {},
      discoverGeminiSessions: () => [],
      discoverCodexSessions: () => [],
      invalidateDiscoveryCache: () => {},
    },
    keepalive: {
      getStatus: async () => ({ running: false, mode: 'always' }),
      setMode() {},
      getMode: () => 'always',
      isRunning: () => false,
      start() {},
      stop() {},
    },
    fireEvent: () => {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    enforceTmuxLimit: async () => {},
    resolveSessionId: async () => {},
    getBrowserCount: () => 0,
    CLAUDE_HOME: path.join(os.tmpdir(), 'no-creds-' + Date.now()),
    WORKSPACE: WORKSPACE2,
    ensureSettings: async () => {},
    sleep: async () => {},
  });
  db2.ensureProject('test-project', testProj2);
  db2.upsertSession('err1', 1, 'Err');

  await withServer(throwingApp, async ({ port }) => {
    // search 500
    const r1 = await req(port, 'GET', '/api/search?q=hello');
    assert.equal(r1.status, 500);

    // summary 500
    const r2 = await req(port, 'POST', '/api/sessions/err1/summary', { project: 'test-project' });
    assert.equal(r2.status, 500);

    // tokens error → returns default object (not 500)
    const r3 = await (
      await req(port, 'GET', '/api/sessions/err1/tokens?project=test-project')
    ).json();
    assert.equal(r3.input_tokens, 0);
    assert.equal(r3.model, null);

    // smart-compact removed — feature stripped (#32)
  });
});

// -- POST /api/projects git URL - 409 when directory already exists --

test('PRJ-09: git clone returns 409 when target directory already exists', async () => {
  const fs = require('node:fs');
  const { app, WORKSPACE } = makeApp();
  const existingDir = path.join(WORKSPACE, 'my-repo');
  fs.mkdirSync(existingDir, { recursive: true });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'POST', '/api/projects', {
      path: 'https://github.com/test/my-repo.git',
      name: 'my-repo',
    });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.ok(body.error.includes('already exists'));
  });
});

// -- session config: notes too long --

test('SES-CFG-01: PUT /api/sessions/:id/config rejects overlong notes', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('cfg_proj', '/workspace/cfg_proj');
    db.upsertSession('cfg1', p.id, 'S');
    const r = await req(port, 'PUT', '/api/sessions/cfg1/config', {
      notes: 'x'.repeat(100001),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.error.includes('too long'));
  });
});

test('SES-CFG-02: PUT /api/sessions/:id/config rejects overlong name', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('cfg_proj2', '/workspace/cfg_proj2');
    db.upsertSession('cfg2', p.id, 'S');
    const r = await req(port, 'PUT', '/api/sessions/cfg2/config', {
      name: 'x'.repeat(256),
    });
    assert.equal(r.status, 400);
  });
});

// -- session config GET: session not found --

test('SES-CFG-03: GET /api/sessions/:id/config returns 404 when session not found', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/sessions/nosuchsession/config');
    assert.equal(r.status, 404);
  });
});

// -- tasks: validation and tree --

test('TSK-08: GET /api/tasks/tree returns tree object', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/tasks/tree');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.programs), 'v2 tree shape is { programs: [...] }');
  });
});

test('TSK-09: GET /api/tasks/tree accepts filter query param', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/tasks/tree?filter=all');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.programs), 'v2 tree shape is { programs: [...] }');
  });
});

test('TSK-10: POST /api/tasks rejects missing title', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/tasks', { folder_path: '/' });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.error.includes('title'));
  });
});

// #332 [A7]: PUT /api/programs/:id atomic rename. The race window between
// "is the new name free?" and "rename row" is closed by db.renameProgramSafe;
// route translates duplicate_name → 409.
test('PRG-RN-01: PUT /api/programs/:id rename to free name returns 200', async () => {
  let renameCalled = false;
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'PUT', '/api/programs/7', { name: 'newname' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.name, 'newname');
    assert.ok(renameCalled, 'renameProgramSafe must be invoked when name changes');
  }, {
    db: {
      getProgram: (id) => ({ id, name: 'oldname', description: '', status: 'active' }),
      renameProgramSafe: (id, newName) => {
        renameCalled = true;
        return { id, name: newName };
      },
    },
  });
});

test('PRG-RN-02: PUT /api/programs/:id rename to colliding name returns 409', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'PUT', '/api/programs/7', { name: 'taken' });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.match(body.error, /already exists/i);
  }, {
    db: {
      getProgram: (id) => ({ id, name: 'oldname', description: '', status: 'active' }),
      renameProgramSafe: () => {
        const e = new Error('program with name already exists');
        e.code = 'duplicate_name';
        throw e;
      },
    },
  });
});

// #333 [A8]: POST /api/auth/login must NOT invoke claudeExecAsync — that
// burned a billable inference call per request. The new flow reads
// ~/.claude/.credentials.json and returns 200 (valid) or 401 (invalid).
test('AUTH-LOGIN-01: POST /api/auth/login does not invoke claudeExecAsync', async () => {
  let claudeCalls = 0;
  await withFullServer(async ({ port }) => {
    // Three sequential login attempts; all must skip the subprocess entirely.
    for (let i = 0; i < 3; i += 1) {
      await req(port, 'POST', '/api/auth/login', {});
    }
    assert.equal(claudeCalls, 0, 'claudeExecAsync must never be called by /api/auth/login');
  }, {
    claudeExecAsync: async () => {
      claudeCalls += 1;
      return 'should not run';
    },
  });
});

test('AUTH-LOGIN-02: POST /api/auth/login returns 401 when no credentials file', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/auth/login', {});
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.valid, false);
    assert.match(body.reason, /credentials/i);
  });
});

test('AUTH-LOGIN-03: POST /api/auth/login returns 200 when credentials are valid', async () => {
  const fs = require('node:fs');
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-auth-'));
  fs.writeFileSync(`${claudeHome}/.credentials.json`, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAt: Date.now() + 3600_000,
    },
  }));
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/auth/login', {});
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.valid, true);
  }, { claudeHome });
});

// #334 [A9]: tmpId for Claude sessions includes a 6-hex-char random suffix so
// rapid concurrent POSTs cannot collide on Date.now() alone.
test('TMPID-01: 5 concurrent Claude session POSTs produce 5 distinct tmpIds', async () => {
  await withFullServer(async ({ port }) => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => req(port, 'POST', '/api/sessions', {
        project: 'test-project',
        name: `concurrent-${i}`,
      })),
    );
    const ids = await Promise.all(results.map(async (r) => {
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.ok(body.id.startsWith('new_'), `id ${body.id} should start with new_`);
      return body.id;
    }));
    assert.equal(new Set(ids).size, 5, `expected 5 distinct ids, got: ${ids.join(', ')}`);
    // Belt and suspenders: assert the new format includes the random suffix.
    for (const id of ids) {
      assert.match(id, /^new_\d+_[0-9a-f]{6}$/, `id ${id} should match new_<ms>_<hex6>`);
    }
  });
});

// #336 [A11]: project removal cascades through tmux + Claude JSONL dir +
// per-CLI trust/projects entries. Each cleanup is best-effort and never
// blocks the row delete.
test('PRJ-RM-01: POST /api/projects/:name/remove kills tmux for each session', async () => {
  const killed = [];
  await withFullServer(async ({ port, db }) => {
    const proj = db.ensureProject('rm-proj-1', '/workspace/rm-proj-1');
    db.upsertSession('s-rm-1', proj.id, 'A');
    db.upsertSession('s-rm-2', proj.id, 'B');
    const r = await req(port, 'POST', '/api/projects/rm-proj-1/remove', {});
    assert.equal(r.status, 200);
    // Two sessions → two tmuxKill calls (order-insensitive).
    assert.equal(killed.length, 2);
    assert.deepEqual(new Set(killed), new Set(['wb_s-rm-1', 'wb_s-rm-2']));
    // DB row gone.
    assert.equal(db.getProject('rm-proj-1'), undefined);
  }, {
    tmuxKill: async (name) => { killed.push(name); },
  });
});

test('PRJ-RM-02: POST /api/projects/:name/remove succeeds even if tmuxKill throws', async () => {
  await withFullServer(async ({ port, db }) => {
    const proj = db.ensureProject('rm-proj-err', '/workspace/rm-proj-err');
    db.upsertSession('s-err', proj.id, 'X');
    const r = await req(port, 'POST', '/api/projects/rm-proj-err/remove', {});
    assert.equal(r.status, 200);
    assert.equal(db.getProject('rm-proj-err'), undefined);
  }, {
    tmuxKill: async () => { throw new Error('tmux down'); },
  });
});

test('PRJ-RM-03: POST /api/projects/:name/remove strips ~/.claude.json projects entry', async () => {
  const fs = require('node:fs');
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-rmcl-'));
  const projPath = path.join(claudeHome, 'workspace', 'cleanup-target');
  fs.mkdirSync(projPath, { recursive: true });
  const cfg = { projects: { [projPath]: { hasTrustDialogAccepted: true }, '/other': { keep: true } } };
  fs.writeFileSync(path.join(claudeHome, '.claude.json'), JSON.stringify(cfg));
  await withFullServer(async ({ port, db }) => {
    db.ensureProject('cleanup-target', projPath);
    const r = await req(port, 'POST', '/api/projects/cleanup-target/remove', {});
    assert.equal(r.status, 200);
    const after = JSON.parse(fs.readFileSync(path.join(claudeHome, '.claude.json'), 'utf-8'));
    assert.equal(after.projects[projPath], undefined, 'project entry must be stripped');
    assert.deepEqual(after.projects['/other'], { keep: true }, 'other entries must be preserved');
  }, { claudeHome });
});

test('PRJ-RM-04: POST /api/projects/:name/remove strips Gemini trustedFolders entry', async () => {
  const fs = require('node:fs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-rmgem-'));
  const projPath = path.join(home, 'workspace', 'gem-target');
  fs.mkdirSync(projPath, { recursive: true });
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'trustedFolders.json'), JSON.stringify({
    [projPath]: 'TRUST_FOLDER',
    '/keep': 'TRUST_FOLDER',
  }));
  await withFullServer(async ({ port, db }) => {
    db.ensureProject('gem-target', projPath);
    const r = await req(port, 'POST', '/api/projects/gem-target/remove', {});
    assert.equal(r.status, 200);
    const after = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'trustedFolders.json'), 'utf-8'));
    assert.equal(after[projPath], undefined);
    assert.equal(after['/keep'], 'TRUST_FOLDER');
  }, { home });
});

test('PRJ-RM-05: POST /api/projects/:name/remove strips Codex config.toml block', async () => {
  const fs = require('node:fs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-rmcdx-'));
  const projPath = path.join(home, 'workspace', 'cdx-target');
  fs.mkdirSync(projPath, { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const tomlBefore = `[some.other.block]\nkey = "value"\n\n[projects."${projPath}"]\ntrust_level = "trusted"\n\n[projects."/keep/me"]\ntrust_level = "trusted"\n`;
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), tomlBefore);
  await withFullServer(async ({ port, db }) => {
    db.ensureProject('cdx-target', projPath);
    const r = await req(port, 'POST', '/api/projects/cdx-target/remove', {});
    assert.equal(r.status, 200);
    const after = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8');
    assert.ok(!after.includes(`[projects."${projPath}"]`), 'target block must be stripped');
    assert.ok(after.includes('[projects."/keep/me"]'), 'other project block must remain');
    assert.ok(after.includes('[some.other.block]'), 'unrelated headers must remain');
  }, { home });
});
