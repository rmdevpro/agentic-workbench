'use strict';

// SR-MK-01..03: #651 commit 5 — routes/state.js. Verifies in-flight
// coalescing (R6), warming-503 (R28), and memory-507 (R34) cases for the
// extracted /api/state handler. Behavioural parity with the old in-place
// handler in routes/sessions.js is exercised by the live test plan
// (STATE-LIVE-01..10) — these mock tests pin the new control paths.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { register } = require('../../src/routes/state');

function makeStubDeps({ projects = [], programs = [], sessions = {} } = {}) {
  return {
    db: {
      getProjects: () => projects,
      getProject: () => null,
      getSessionsForProject: (id) => sessions[id] || [],
      getSession: () => null,
      upsertSession: () => {},
      getAllPrograms: () => programs,
    },
    safe: {
      findSessionsDir: (p) => `/nonexistent/${p}/sessions`,
    },
    sessionUtils: {
      parseSessionFile: async () => null,
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    WORKSPACE: '/data/workspace',
  };
}

function makeHelpers() {
  let reconcileCalls = 0;
  let buildCalls = 0;
  return {
    reconcileStaleSessionsForProject: async () => {
      reconcileCalls++;
    },
    buildSessionList: async (dbSessions) => {
      buildCalls++;
      return (dbSessions || []).map((s) => ({ ...s, timestamp: '2026-05-18T00:00:00Z' }));
    },
    counts: () => ({ reconcileCalls, buildCalls }),
  };
}

async function fetchPath(app, urlPath) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const http = require('http');
      const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          server.close();
          let json = null;
          try {
            json = JSON.parse(body);
          } catch (_e) {
            /* not JSON */
          }
          resolve({ status: res.statusCode, body, json });
        });
      });
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
    });
  });
}

test('SR-MK-01: in-flight coalescing — concurrent GET /api/state share one scan', async () => {
  const app = express();
  const deps = makeStubDeps({
    projects: [
      { id: 1, name: 'p1', path: '/p1', state: 'active', program_id: null },
      { id: 2, name: 'p2', path: '/p2', state: 'active', program_id: null },
    ],
  });
  const helpers = makeHelpers();
  const handle = register(app, deps, helpers);

  // Fire 5 concurrent /api/state calls; they should share one scan.
  // Easiest way to confirm: call _coalescedScan directly five times and
  // count reconcile/build calls.
  const results = await Promise.all([
    handle._coalescedScan(),
    handle._coalescedScan(),
    handle._coalescedScan(),
    handle._coalescedScan(),
    handle._coalescedScan(),
  ]);
  for (const r of results) {
    assert.equal(r.projects.length, 2);
  }
  const c = helpers.counts();
  // Without coalescing, helpers would run 5×2 = 10 times each. With
  // coalescing, exactly 1×2 = 2.
  assert.equal(c.reconcileCalls, 2, 'reconcile called per project, once per coalesced scan');
  assert.equal(c.buildCalls, 2, 'buildSessionList called per project, once per coalesced scan');
});

test('SR-MK-02: stateEngine warming → 503 with progress', async () => {
  const app = express();
  const deps = makeStubDeps();
  const helpers = makeHelpers();
  // Inject a warming stateEngine — the route should short-circuit to 503
  // without touching the DB path.
  deps.stateEngine = {
    isWarming: () => true,
    getWarmProgress: () => ({ warming: true, started_at: 1, completed_at: null }),
    serializeSnapshot: () => {
      throw new Error('should not be called when warming');
    },
  };
  register(app, deps, helpers);
  const { status, json } = await fetchPath(app, '/api/state');
  assert.equal(status, 503);
  assert.equal(json.warming, true);
  assert.equal(helpers.counts().reconcileCalls, 0, 'DB-walk skipped when engine is warming');
});

test('SR-MK-03: stateEngine memory-bound exceeded → 507 with actual + max bytes', async () => {
  const app = express();
  const deps = makeStubDeps();
  const helpers = makeHelpers();
  class MemErr extends Error {
    constructor() {
      super('exceeded');
      this.code = 'STATE_MEMORY_BOUND_EXCEEDED';
      this.actual = 6_000_000;
      this.max = 5_242_880;
    }
  }
  deps.stateEngine = {
    isWarming: () => false,
    serializeSnapshot: () => {
      throw new MemErr();
    },
  };
  register(app, deps, helpers);
  const { status, json } = await fetchPath(app, '/api/state');
  assert.equal(status, 507);
  assert.equal(json.error, 'state snapshot exceeds memory bound');
  assert.equal(json.actual_bytes, 6_000_000);
  assert.equal(json.max_bytes, 5_242_880);
});

test('SR-MK-04: stateEngine present + warm → snapshot served (no DB-walk)', async () => {
  const app = express();
  const deps = makeStubDeps();
  const helpers = makeHelpers();
  const snap = { projects: [], programs: [], workspace: '/data/workspace' };
  deps.stateEngine = {
    isWarming: () => false,
    serializeSnapshot: () => ({ snap, serialized: JSON.stringify(snap), bytes: 80 }),
  };
  register(app, deps, helpers);
  const { status, json } = await fetchPath(app, '/api/state');
  assert.equal(status, 200);
  assert.deepEqual(json, snap);
  assert.equal(helpers.counts().reconcileCalls, 0, 'DB-walk skipped when engine is warm');
});

test('SR-MK-05: no stateEngine → falls back to DB-walk (legacy parity)', async () => {
  const app = express();
  const deps = makeStubDeps({
    projects: [{ id: 1, name: 'p', path: '/p', state: 'active', program_id: null }],
  });
  const helpers = makeHelpers();
  // No stateEngine dep
  register(app, deps, helpers);
  const { status, json } = await fetchPath(app, '/api/state');
  assert.equal(status, 200);
  assert.equal(json.projects.length, 1);
  assert.equal(json.workspace, '/data/workspace');
  assert.equal(helpers.counts().reconcileCalls, 1, 'fell back to DB-walk');
});
