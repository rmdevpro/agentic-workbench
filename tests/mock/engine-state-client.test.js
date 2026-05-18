'use strict';

// ES-MK-01..10: #651 commit 9 — client-side State Engine mirror.
// Drives the mirror with a stub WebSocket and asserts diff application,
// subscriber notification, snapshot handling, and reconnect behaviour.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createEngineStateClient, applyDiff } = require('../../public/js/engine-state.js');

// Fake WebSocket. Tracks instances so tests can simulate open/close.
class FakeWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  // Browser API
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose();
  }
  // Test helpers
  _open() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }
  _recv(msg) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) });
  }
  _err(err) {
    if (this.onerror) this.onerror(err);
  }
}
FakeWebSocket.instances = [];

function freshFake() {
  FakeWebSocket.instances = [];
  return FakeWebSocket;
}

// ── Pure helper: applyDiff ────────────────────────────────────────────────────

test('ES-MK-01: applyDiff project:add appends and project:remove removes', () => {
  const state = { projects: [], programs: [] };
  applyDiff(state, { kind: 'project:add', path: '/p1', project: { path: '/p1', name: 'p1', sessions: [] } });
  assert.equal(state.projects.length, 1);
  applyDiff(state, { kind: 'project:remove', path: '/p1' });
  assert.equal(state.projects.length, 0);
});

test('ES-MK-02: applyDiff session:add then session:update preserves project membership', () => {
  const state = { projects: [{ path: '/p1', sessions: [] }], programs: [] };
  applyDiff(state, { kind: 'session:add', project_path: '/p1', id: 's1', session: { id: 's1', name: 'orig' } });
  applyDiff(state, { kind: 'session:update', project_path: '/p1', id: 's1', fields: { name: 'updated' } });
  assert.equal(state.projects[0].sessions.length, 1);
  assert.equal(state.projects[0].sessions[0].name, 'updated');
});

test('ES-MK-03: applyDiff session:remove drops the session from the project', () => {
  const state = {
    projects: [{ path: '/p1', sessions: [{ id: 's1' }, { id: 's2' }] }],
    programs: [],
  };
  applyDiff(state, { kind: 'session:remove', project_path: '/p1', id: 's1' });
  assert.equal(state.projects[0].sessions.length, 1);
  assert.equal(state.projects[0].sessions[0].id, 's2');
});

test('ES-MK-04: applyDiff program:upsert replaces vs adds', () => {
  const state = { projects: [], programs: [] };
  applyDiff(state, { kind: 'program:upsert', id: 5, program: { id: 5, name: 'a' } });
  applyDiff(state, { kind: 'program:upsert', id: 5, program: { id: 5, name: 'b' } });
  assert.equal(state.programs.length, 1);
  assert.equal(state.programs[0].name, 'b');
});

// ── Mirror lifecycle ──────────────────────────────────────────────────────────

test('ES-MK-05: connect → onmessage state:snapshot populates state and notifies', () => {
  const Fake = freshFake();
  const client = createEngineStateClient({ url: 'ws://x/ws/state', WebSocketCtor: Fake });
  const events = [];
  client.subscribe((e) => events.push(e.type));
  client.connect();
  const ws = Fake.instances[0];
  ws._open();
  ws._recv({
    type: 'state:snapshot',
    version: 1,
    seq: 5,
    at: 1,
    warming: false,
    snapshot: { projects: [{ path: '/p', name: 'p', sessions: [] }], programs: [], workspace: '/data/workspace' },
  });
  const s = client.getState();
  assert.equal(s.workspace, '/data/workspace');
  assert.equal(s.projects.length, 1);
  assert.equal(s.lastSeq, 5);
  assert.equal(s.warming, false);
  assert.ok(events.includes('connected'));
  assert.ok(events.includes('snapshot'));
});

test('ES-MK-06: state:diff applies and increments lastSeq', () => {
  const Fake = freshFake();
  const client = createEngineStateClient({ url: 'ws://x/ws/state', WebSocketCtor: Fake });
  client.connect();
  const ws = Fake.instances[0];
  ws._open();
  ws._recv({ type: 'state:snapshot', version: 1, seq: 1, at: 1, snapshot: { projects: [{ path: '/p', sessions: [] }], programs: [] } });
  ws._recv({ type: 'state:diff', version: 1, seq: 2, at: 2, diff: { kind: 'project:update', path: '/p', fields: { name: 'renamed' } } });
  const s = client.getState();
  assert.equal(s.projects[0].name, 'renamed');
  assert.equal(s.lastSeq, 2);
});

test('ES-MK-07: state:heartbeat updates lastSeq but does not notify subscribers', () => {
  const Fake = freshFake();
  const client = createEngineStateClient({ url: 'ws://x/ws/state', WebSocketCtor: Fake });
  const events = [];
  client.subscribe((e) => events.push(e.type));
  client.connect();
  const ws = Fake.instances[0];
  ws._open();
  // Drop connect+snapshot
  ws._recv({ type: 'state:snapshot', version: 1, seq: 1, at: 1, snapshot: { projects: [], programs: [] } });
  events.length = 0;
  ws._recv({ type: 'state:heartbeat', version: 1, seq: 7, at: 7 });
  assert.equal(client.getState().lastSeq, 7);
  assert.equal(events.length, 0, 'heartbeat does not notify subscribers');
});

test('ES-MK-08: malformed message → no crash, no state change', () => {
  const Fake = freshFake();
  const client = createEngineStateClient({ url: 'ws://x/ws/state', WebSocketCtor: Fake });
  client.connect();
  const ws = Fake.instances[0];
  ws._open();
  // simulate the onmessage path with a non-JSON payload
  if (ws.onmessage) ws.onmessage({ data: 'not json {{{' });
  assert.equal(client.getState().lastSeq, 0, 'state untouched');
});

test('ES-MK-09: close → reconnect creates a new WebSocket', async () => {
  const Fake = freshFake();
  const client = createEngineStateClient({
    url: 'ws://x/ws/state',
    WebSocketCtor: Fake,
    backoffInitialMs: 10,
    backoffMaxMs: 20,
  });
  client.connect();
  const first = Fake.instances[0];
  first._open();
  first.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(Fake.instances.length >= 2, 'a new WebSocket was created after close');
  client.disconnect();
});

test('ES-MK-10: disconnect stops the reconnect loop', async () => {
  const Fake = freshFake();
  const client = createEngineStateClient({
    url: 'ws://x/ws/state',
    WebSocketCtor: Fake,
    backoffInitialMs: 10,
    backoffMaxMs: 20,
  });
  client.connect();
  const first = Fake.instances[0];
  first._open();
  client.disconnect();
  first.close(); // simulate the close that disconnect triggered
  const countAfterDisconnect = Fake.instances.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(Fake.instances.length, countAfterDisconnect, 'no new sockets after disconnect()');
});
