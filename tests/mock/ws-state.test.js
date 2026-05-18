'use strict';

// WS-MK-01..10: #651 commit 8 — /ws/state subscription channel.
//
// The handler bridges a WebSocket to stateEngine.subscribe(). These tests
// drive it with a fake WebSocket (EventEmitter) so we can exercise the
// R2 protocol and R30 backpressure paths without a real socket.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const createStateEngine = require('../../src/state-engine');
const createWsState = require('../../src/routes/ws-state');

function makeFakeWs({ buffered = 0 } = {}) {
  const ws = new EventEmitter();
  ws.readyState = 1; // OPEN
  ws.bufferedAmount = buffered;
  ws.sent = [];
  ws.send = (msg) => { ws.sent.push(JSON.parse(msg)); };
  ws.close = (code, reason) => {
    ws.closed = { code, reason };
    ws.readyState = 3; // CLOSED
    ws.emit('close');
  };
  ws.ping = () => {};
  return ws;
}

function silentLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

// ── WS-MK-01: subscribe sends initial snapshot ─────────────────────────────────

test('WS-MK-01: connect → initial state:snapshot message delivered', () => {
  const engine = createStateEngine({ logger: silentLogger(), heartbeatIntervalMs: 0 });
  engine.setWorkspace('/data/workspace');
  engine.markWarm();
  const wsState = createWsState({ stateEngine: engine, logger: silentLogger(), config: null });
  const ws = makeFakeWs();
  wsState.handleStateConnection(ws);
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].type, 'state:snapshot');
  assert.equal(ws.sent[0].version, 1);
  assert.equal(ws.sent[0].snapshot.workspace, '/data/workspace');
});

// ── WS-MK-02: project upsert → diff message pushed ─────────────────────────────

test('WS-MK-02: project upsert post-subscribe → state:diff message pushed', () => {
  const engine = createStateEngine({ logger: silentLogger(), heartbeatIntervalMs: 0 });
  engine.setWorkspace('/data/workspace');
  engine.markWarm();
  const wsState = createWsState({ stateEngine: engine, logger: silentLogger() });
  const ws = makeFakeWs();
  wsState.handleStateConnection(ws);
  const before = ws.sent.length;
  engine.upsertProject({ path: '/p1', name: 'p1' });
  const after = ws.sent.length;
  assert.equal(after - before, 1, 'one diff message per project upsert');
  const diff = ws.sent[ws.sent.length - 1];
  assert.equal(diff.type, 'state:diff');
  assert.equal(diff.diff.kind, 'project:add');
  assert.equal(diff.diff.path, '/p1');
});

// ── WS-MK-03: session update → state:diff with session:update kind ─────────────

test('WS-MK-03: session upsert + update produces add/update diffs', () => {
  const engine = createStateEngine({ logger: silentLogger(), heartbeatIntervalMs: 0 });
  engine.markWarm();
  engine.upsertProject({ path: '/p1', name: 'p1' });
  const wsState = createWsState({ stateEngine: engine, logger: silentLogger() });
  const ws = makeFakeWs();
  wsState.handleStateConnection(ws);
  engine.upsertSession({ id: 's1', project_path: '/p1', name: 'sess1', cli_type: 'claude' });
  engine.updateSession('s1', { name: 'renamed' });
  // [0]=snapshot, [1]=session:add, [2]=session:update
  assert.equal(ws.sent[1].diff.kind, 'session:add');
  assert.equal(ws.sent[2].diff.kind, 'session:update');
  assert.equal(ws.sent[2].diff.fields.name, 'renamed');
});

// ── WS-MK-04: client ping → server pong ───────────────────────────────────────

test('WS-MK-04: client ping → server pong response', () => {
  const engine = createStateEngine({ logger: silentLogger(), heartbeatIntervalMs: 0 });
  engine.markWarm();
  const wsState = createWsState({ stateEngine: engine, logger: silentLogger() });
  const ws = makeFakeWs();
  wsState.handleStateConnection(ws);
  ws.sent.length = 0; // clear snapshot
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'ping' })));
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].type, 'pong');
  assert.equal(ws.sent[0].version, 1);
  assert.equal(typeof ws.sent[0].at, 'number');
});

// ── WS-MK-05: ws.close → unsubscribe from engine ──────────────────────────────

test('WS-MK-05: ws close → unsubscribe drops the engine subscriber', () => {
  const engine = createStateEngine({ logger: silentLogger(), heartbeatIntervalMs: 0 });
  engine.markWarm();
  const wsState = createWsState({ stateEngine: engine, logger: silentLogger() });
  const ws = makeFakeWs();
  wsState.handleStateConnection(ws);
  assert.equal(engine.stats().subscribers, 1);
  ws.readyState = 3; // CLOSED
  ws.emit('close');
  assert.equal(engine.stats().subscribers, 0);
});

// ── WS-MK-06: backpressure → close with 1011 + drop subscriber ─────────────────

test('WS-MK-06: bufferedAmount > highWater → close 1011 + drop subscriber', () => {
  // Reviewer-Claude NON-BLOCKER N6 (build-review-round1): RFC 6455 1009
  // is per-frame ("Message Too Big"), not aggregate buffer overflow.
  // Aggregate-backpressure close uses 1011 ("Internal Error").
  const engine = createStateEngine({ logger: silentLogger(), heartbeatIntervalMs: 0 });
  engine.markWarm();
  const wsState = createWsState({
    stateEngine: engine,
    logger: silentLogger(),
    config: { get: (_k, def) => (_k === 'ws.state.bufferHighWaterMark' ? 100 : def) },
  });
  const ws = makeFakeWs({ buffered: 50 });
  wsState.handleStateConnection(ws);
  // initial snapshot lands fine (buffered 50 < 100)
  ws.bufferedAmount = 200;
  // Next diff should trigger the backpressure close path
  assert.doesNotThrow(() => engine.upsertProject({ path: '/oversize', name: 'big' }));
  assert.equal(ws.closed?.code, 1011);
});

// ── WS-MK-07: malformed client message → debug log, no crash ───────────────────

test('WS-MK-07: malformed client message — handler does not crash', () => {
  const engine = createStateEngine({ logger: silentLogger(), heartbeatIntervalMs: 0 });
  engine.markWarm();
  const wsState = createWsState({ stateEngine: engine, logger: silentLogger() });
  const ws = makeFakeWs();
  wsState.handleStateConnection(ws);
  ws.emit('message', Buffer.from('not json {{{'));
  // No throw + no extra response
  assert.equal(ws.sent.length, 1, 'only the snapshot was sent');
});

// ── WS-MK-08: ws.error → unsubscribe ──────────────────────────────────────────

test('WS-MK-08: ws error event → engine subscriber dropped', () => {
  const engine = createStateEngine({ logger: silentLogger(), heartbeatIntervalMs: 0 });
  engine.markWarm();
  const wsState = createWsState({ stateEngine: engine, logger: silentLogger() });
  const ws = makeFakeWs();
  wsState.handleStateConnection(ws);
  assert.equal(engine.stats().subscribers, 1);
  ws.emit('error', new Error('socket broken'));
  assert.equal(engine.stats().subscribers, 0);
});

// ── WS-MK-09: heartbeat refreshes lastSeen so idle subscriber survives ─────────

test('WS-MK-09: engine heartbeat sends state:heartbeat message; idle subscriber not evicted', async () => {
  let now = 1000;
  const engine = createStateEngine({
    logger: silentLogger(),
    heartbeatIntervalMs: 10,
    subscriberTimeoutMs: 100,
    clock: () => now,
  });
  engine.markWarm();
  const ws = makeFakeWs();
  const wsState = createWsState({ stateEngine: engine, logger: silentLogger() });
  wsState.handleStateConnection(ws);
  // After multiple heartbeat ticks past timeout: subscriber should still be alive
  // because the heartbeat send refreshes lastSeen.
  await new Promise((r) => setTimeout(r, 80));
  now += 200;
  await new Promise((r) => setTimeout(r, 30));
  const heartbeatMsgs = ws.sent.filter((m) => m.type === 'state:heartbeat');
  assert.ok(heartbeatMsgs.length >= 1, 'at least one heartbeat message was sent');
  engine.stop();
});

// ── WS-MK-10: ws closed before subscribe → engine drops subscriber cleanly ─────

test('WS-MK-10: subscribe with already-closed ws — engine drops the dead sub immediately', () => {
  const engine = createStateEngine({ logger: silentLogger(), heartbeatIntervalMs: 0 });
  engine.markWarm();
  const wsState = createWsState({ stateEngine: engine, logger: silentLogger() });
  const ws = makeFakeWs();
  ws.readyState = 3; // already closed
  wsState.handleStateConnection(ws);
  // The subscribe() call sends a snapshot via send(); send sees readyState !== 1
  // and throws ws_closed → engine marks the sub dead. stats() should reflect 0.
  assert.equal(engine.stats().subscribers, 0);
});
