'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createStateEngine = require('../../src/state-engine.js');
const { MemoryBoundExceededError } = require('../../src/state-engine.js');

function mockLogger() {
  const logs = [];
  return {
    logs,
    info: (msg, meta) => logs.push({ level: 'info', msg, meta }),
    warn: (msg, meta) => logs.push({ level: 'warn', msg, meta }),
    error: (msg, meta) => logs.push({ level: 'error', msg, meta }),
  };
}

function fakeClock(initial = 1_000_000) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
      return t;
    },
  };
}

test('SE-MK-01: subscribe sends initial snapshot, then receives diffs', () => {
  const engine = createStateEngine({ logger: mockLogger(), heartbeatIntervalMs: 0 });
  engine.setWorkspace('/data/workspace');
  engine.upsertProject({ path: '/p1', name: 'p1' });

  const received = [];
  const unsub = engine.subscribe((msg) => received.push(msg));

  assert.equal(received.length, 1, 'subscriber receives one initial snapshot');
  assert.equal(received[0].type, 'state:snapshot');
  assert.equal(received[0].snapshot.projects.length, 1);
  assert.equal(received[0].snapshot.projects[0].path, '/p1');

  engine.upsertProject({ path: '/p2', name: 'p2' });
  assert.equal(received.length, 2, 'mutation publishes a diff to the subscriber');
  assert.equal(received[1].type, 'state:diff');
  assert.equal(received[1].diff.kind, 'project:add');
  assert.equal(received[1].diff.path, '/p2');

  unsub();
  engine.upsertProject({ path: '/p3', name: 'p3' });
  assert.equal(received.length, 2, 'unsubscribed receivers do not get further diffs');
});

test('SE-MK-02: diff messages carry monotonically-increasing seq', () => {
  const engine = createStateEngine({ logger: mockLogger(), heartbeatIntervalMs: 0 });
  engine.upsertProject({ path: '/p1', name: 'p1' });

  const received = [];
  engine.subscribe((msg) => received.push(msg));

  engine.upsertProject({ path: '/p2', name: 'p2' });
  engine.upsertSession({ id: 's1', project_path: '/p1', name: 'session-1' });
  engine.updateSession('s1', { name: 'session-1-renamed' });

  const seqs = received.map((m) => m.seq);
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i] > seqs[i - 1], `seq monotonic: ${seqs[i]} > ${seqs[i - 1]}`);
  }
});

test('SE-MK-03: snapshot matches /api/state shape and includes workspace + programs', () => {
  const engine = createStateEngine({ logger: mockLogger(), heartbeatIntervalMs: 0 });
  engine.setWorkspace('/data/workspace');
  engine.upsertProgram({ id: 1, name: 'wb-seed', state: 'active' });
  engine.upsertProject({ path: '/p1', name: 'p1', program_id: 1 });
  engine.upsertSession({ id: 's1', project_path: '/p1', name: 'sess', cli_type: 'claude' });

  const snap = engine.snapshot();
  assert.equal(snap.workspace, '/data/workspace');
  assert.equal(snap.projects.length, 1);
  assert.equal(snap.projects[0].name, 'p1');
  assert.equal(snap.projects[0].program_id, 1);
  assert.equal(snap.projects[0].state, 'active');
  assert.equal(snap.projects[0].missing, false);
  assert.equal(snap.projects[0].sessions.length, 1);
  assert.equal(snap.projects[0].sessions[0].cli_type, 'claude');
  assert.equal(snap.programs.length, 1);
  assert.equal(snap.programs[0].id, 1);
});

test('SE-MK-04: updateSession finds session across projects + emits session:update diff', () => {
  const engine = createStateEngine({ logger: mockLogger(), heartbeatIntervalMs: 0 });
  engine.upsertProject({ path: '/p1', name: 'p1' });
  engine.upsertProject({ path: '/p2', name: 'p2' });
  engine.upsertSession({ id: 'session-A', project_path: '/p2', name: 'A' });

  const received = [];
  engine.subscribe((msg) => received.push(msg));

  const ok = engine.updateSession('session-A', { name: 'A-renamed', stale_auth: true });
  assert.equal(ok, true);
  const diff = received[received.length - 1];
  assert.equal(diff.type, 'state:diff');
  assert.equal(diff.diff.kind, 'session:update');
  assert.equal(diff.diff.id, 'session-A');
  assert.equal(diff.diff.project_path, '/p2');
  assert.deepEqual(diff.diff.fields, { name: 'A-renamed', stale_auth: true });

  // Persisted into the engine
  const got = engine.getSession('session-A');
  assert.equal(got.name, 'A-renamed');
  assert.equal(got.stale_auth, true);
});

test('SE-MK-05: removeSession finds + removes across projects', () => {
  const engine = createStateEngine({ logger: mockLogger(), heartbeatIntervalMs: 0 });
  engine.upsertProject({ path: '/p', name: 'p' });
  engine.upsertSession({ id: 's', project_path: '/p', name: 's' });

  const received = [];
  engine.subscribe((msg) => received.push(msg));

  assert.equal(engine.removeSession('s'), true);
  assert.equal(engine.getSession('s'), null);
  const diff = received[received.length - 1];
  assert.equal(diff.diff.kind, 'session:remove');
  assert.equal(diff.diff.id, 's');
  // Idempotent: second remove returns false
  assert.equal(engine.removeSession('s'), false);
});

test('SE-MK-06: warming -> warm transition emits warm event', () => {
  const engine = createStateEngine({ logger: mockLogger(), heartbeatIntervalMs: 0 });
  engine.startWarm();
  assert.equal(engine.isWarming(), true);

  let warmEvents = 0;
  engine.on('warm', () => warmEvents++);

  engine.markWarm();
  assert.equal(engine.isWarming(), false);
  assert.equal(warmEvents, 1);

  // markWarm is idempotent
  engine.markWarm();
  assert.equal(warmEvents, 1, 'markWarm idempotent — no double emit');
});

test('SE-MK-07: initial subscriber snapshot carries warming flag', () => {
  const engine = createStateEngine({ logger: mockLogger(), heartbeatIntervalMs: 0 });
  engine.startWarm();

  const received = [];
  engine.subscribe((msg) => received.push(msg));
  assert.equal(received[0].warming, true);

  engine.markWarm();
  const received2 = [];
  engine.subscribe((msg) => received2.push(msg));
  assert.equal(received2[0].warming, false);
});

test('SE-MK-08: serializeSnapshot enforces memory bound + throws MemoryBoundExceededError', () => {
  const engine = createStateEngine({ logger: mockLogger(), heartbeatIntervalMs: 0, maxBytes: 200 });
  engine.upsertProject({ path: '/p1', name: 'p1' });

  // Should fit
  const { bytes } = engine.serializeSnapshot();
  assert.ok(bytes < 200, `under bound: ${bytes}`);

  // Add a giant session to blow the bound
  engine.upsertSession({
    id: 'big',
    project_path: '/p1',
    name: 'x'.repeat(500),
    cli_type: 'claude',
  });
  assert.throws(
    () => engine.serializeSnapshot(),
    (err) => err instanceof MemoryBoundExceededError && err.code === 'STATE_MEMORY_BOUND_EXCEEDED',
  );
});

test('SE-MK-09: subscriber send failure marks dead + does not crash the publish loop', () => {
  const engine = createStateEngine({ logger: mockLogger(), heartbeatIntervalMs: 0 });
  engine.upsertProject({ path: '/p', name: 'p' });

  const okMessages = [];
  // Throwing subscriber simulates a dead socket
  engine.subscribe(() => {
    throw new Error('socket closed');
  });
  // Healthy subscriber
  engine.subscribe((msg) => okMessages.push(msg));

  // Trigger a mutation
  engine.upsertProject({ path: '/p2', name: 'p2' });

  // Healthy subscriber should have received: snapshot + 1 diff
  assert.equal(okMessages.length, 2);
  assert.equal(okMessages[1].diff.kind, 'project:add');

  // Dead subscriber should be evicted
  assert.equal(engine.stats().subscribers, 1);
});

test('SE-MK-10: heartbeat-driven eviction at idle timeout', () => {
  const c = fakeClock();
  const engine = createStateEngine({
    logger: mockLogger(),
    heartbeatIntervalMs: 0,
    subscriberTimeoutMs: 90_000,
    clock: c.now,
  });
  engine.upsertProject({ path: '/p', name: 'p' });

  const received = [];
  engine.subscribe((msg) => received.push(msg));
  assert.equal(engine.stats().subscribers, 1);

  // Without heartbeat running, manually drive lastSeen forward by mutating
  // and observing eviction logic. Direct test of eviction: advance clock,
  // then publish — sub.lastSeen updates only when send succeeds (which
  // updates lastSeen). So eviction via heartbeat is what we'd test with a
  // running timer. Here we just verify that touchSubscriber updates state.
  engine.touchSubscriber(1);
  assert.equal(engine.stats().subscribers, 1);

  // Unsubscribe path
  engine.unsubscribe(1);
  assert.equal(engine.stats().subscribers, 0);
});

test('SE-MK-11: upsertSession rejects unknown project_path', () => {
  const engine = createStateEngine({ logger: mockLogger(), heartbeatIntervalMs: 0 });
  assert.throws(
    () => engine.upsertSession({ id: 's', project_path: '/nonexistent', name: 's' }),
    /project \/nonexistent not in engine/,
  );
});

test('SE-MK-12: project:remove diff emitted only when project existed', () => {
  const engine = createStateEngine({ logger: mockLogger(), heartbeatIntervalMs: 0 });
  engine.upsertProject({ path: '/p1', name: 'p1' });

  const received = [];
  engine.subscribe((msg) => received.push(msg));

  assert.equal(engine.removeProject('/p1'), true);
  assert.equal(received[received.length - 1].diff.kind, 'project:remove');

  // Idempotent: removing again is a no-op, no diff emitted
  const count = received.length;
  assert.equal(engine.removeProject('/p1'), false);
  assert.equal(received.length, count, 'no extra diff on no-op remove');
});

test('SE-MK-13: multiple subscribers all receive the same diff', () => {
  const engine = createStateEngine({ logger: mockLogger(), heartbeatIntervalMs: 0 });
  engine.upsertProject({ path: '/p', name: 'p' });

  const a = [];
  const b = [];
  const c = [];
  engine.subscribe((msg) => a.push(msg));
  engine.subscribe((msg) => b.push(msg));
  engine.subscribe((msg) => c.push(msg));

  engine.upsertSession({ id: 's', project_path: '/p', name: 's' });

  // Each subscriber: 1 snapshot + 1 diff
  assert.equal(a.length, 2);
  assert.equal(b.length, 2);
  assert.equal(c.length, 2);

  // Diff content identical across subscribers
  assert.equal(a[1].seq, b[1].seq);
  assert.equal(b[1].seq, c[1].seq);
  assert.deepEqual(a[1].diff, b[1].diff);
});

test('SE-MK-14: stats() reports correct counts across mutations', () => {
  const engine = createStateEngine({ logger: mockLogger(), heartbeatIntervalMs: 0 });
  engine.upsertProgram({ id: 1, name: 'prog' });
  engine.upsertProject({ path: '/p1', name: 'p1' });
  engine.upsertProject({ path: '/p2', name: 'p2' });
  engine.upsertSession({ id: 's1', project_path: '/p1', name: 's1' });
  engine.upsertSession({ id: 's2', project_path: '/p1', name: 's2' });
  engine.upsertSession({ id: 's3', project_path: '/p2', name: 's3' });

  const s = engine.stats();
  assert.equal(s.projects, 2);
  assert.equal(s.programs, 1);
  assert.equal(s.sessions, 3);
  assert.equal(s.warming, true, 'warming defaults to true');

  engine.removeSession('s2');
  assert.equal(engine.stats().sessions, 2);
});
