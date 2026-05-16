'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createWsTerminal = require('../../src/ws-terminal.js');

class FakePty {
  constructor() {
    this.pid = 1234;
    this.paused = false;
    this.killed = false;
    this.resizeCalls = [];
    this.writeCalls = [];
    this.dataHandler = null;
    this.exitHandler = null;
  }
  onData(fn) {
    this.dataHandler = fn;
  }
  emitData(d) {
    if (this.dataHandler) this.dataHandler(d);
  }
  onExit(fn) {
    this.exitHandler = fn;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  resize(c, r) {
    this.resizeCalls.push([c, r]);
  }
  write(d) {
    this.writeCalls.push(d);
  }
  kill() {
    this.killed = true;
  }
}

function makeWs() {
  const h = {};
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    isAlive: true,
    on(e, fn) {
      h[e] = fn;
    },
    send(p) {
      this.sent.push(p);
    },
    close() {
      this.readyState = 3;
      if (h.close) h.close();
    },
    terminate() {
      this.readyState = 3;
      if (h.close) h.close();
    },
    ping() {
      this.pinged = true;
    },
    trigger(e, p) {
      if (h[e]) h[e](p);
    },
  };
}

function makeEnv(overrides = {}) {
  let bc = 0;
  const kaCalls = [];
  const swc = new Map();
  const fp = overrides.fakePty || new FakePty();
  const env = {
    safe: { sanitizeTmuxName: (v) => v.replace(/[^a-zA-Z0-9_-]/g, '_') },
    keepalive: {
      onBrowserConnect: () => kaCalls.push('connect'),
      onBrowserDisconnect: (n) => kaCalls.push(['disconnect', n]),
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    config: {
      get: (k, fb) =>
        ({ 'ws.bufferHighWaterMark': 1024, 'ws.bufferLowWaterMark': 512, 'ws.pingIntervalMs': 50 })[
          k
        ] ?? fb,
    },
    sessionWsClients: swc,
    getBrowserCount: () => bc,
    incrementBrowserCount: () => ++bc,
    decrementBrowserCount: () => {
      if (bc > 0) bc--;
      return bc;
    },
    tmuxExists: async () => overrides.tmuxExists ?? true,
    cancelTmuxCleanup: () => {
      env.cancelled = true;
    },
    scheduleTmuxCleanup: (n) => {
      env.scheduled = n;
    },
    startJsonlWatcher: (n) => {
      env.startedWatcher = n;
    },
    stopJsonlWatcher: (n) => {
      env.stoppedWatcher = n;
    },
    spawnPty: () => {
      if (overrides.spawnThrows) throw new Error('spawn failed');
      return fp;
    },
  };
  env.terminal = createWsTerminal(env);
  env.kaCalls = kaCalls;
  env.fakePty = fp;
  env.getBrowserCount = () => bc;
  return env;
}

test('WS-01: nonexistent tmux session sends error and closes', async () => {
  const env = makeEnv({ tmuxExists: false });
  const ws = makeWs();
  await env.terminal.handleTerminalConnection(ws, 'nonexistent');
  assert.ok(ws.sent.some((s) => s.includes('No tmux session')));
  assert.equal(ws.readyState, 3);
});

test('WS-04: resize message resizes PTY', async () => {
  const env = makeEnv();
  const ws = makeWs();
  await env.terminal.handleTerminalConnection(ws, 'wb_test');
  ws.trigger('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })));
  assert.deepEqual(env.fakePty.resizeCalls, [[120, 40]]);
});

test('WS-05: backpressure pauses PTY at high watermark', async () => {
  const env = makeEnv();
  const ws = makeWs();
  await env.terminal.handleTerminalConnection(ws, 'wb_test');
  ws.bufferedAmount = 2000;
  env.fakePty.emitData('x'.repeat(100));
  assert.equal(env.fakePty.paused, true);
});

test('WS-07 / WS-11: disconnect kills PTY, updates browser count, schedules cleanup, updates keepalive', async () => {
  const env = makeEnv();
  const ws = makeWs();
  await env.terminal.handleTerminalConnection(ws, 'wb_test');
  assert.equal(env.getBrowserCount(), 1);
  ws.trigger('close');
  assert.equal(env.fakePty.killed, true);
  assert.equal(env.stoppedWatcher, 'wb_test');
  assert.equal(env.scheduled, 'wb_test');
  assert.equal(env.getBrowserCount(), 0);
  assert.deepEqual(env.kaCalls, ['connect', ['disconnect', 0]]);
});

test('WS-10: PTY spawn failure closes WS without crash', async () => {
  const env = makeEnv({ spawnThrows: true });
  const ws = makeWs();
  await env.terminal.handleTerminalConnection(ws, 'wb_test');
  assert.equal(ws.readyState, 3);
});

test('WS-08: token_update forwarded to WS client', async () => {
  const env = makeEnv();
  const ws = makeWs();
  await env.terminal.handleTerminalConnection(ws, 'wb_test');
  assert.equal(env.sessionWsClients.get('wb_test'), ws);
});

test('WS: PTY data forwarded to websocket', async () => {
  const env = makeEnv();
  const ws = makeWs();
  await env.terminal.handleTerminalConnection(ws, 'wb_test');
  env.fakePty.emitData('hello terminal');
  assert.ok(ws.sent.includes('hello terminal'));
});

test('WS: websocket message written to PTY', async () => {
  const env = makeEnv();
  const ws = makeWs();
  await env.terminal.handleTerminalConnection(ws, 'wb_test');
  ws.trigger('message', Buffer.from('user input'));
  assert.ok(env.fakePty.writeCalls.includes('user input'));
});

test('WS: ping message gets pong response', async () => {
  const env = makeEnv();
  const ws = makeWs();
  await env.terminal.handleTerminalConnection(ws, 'wb_test');
  ws.trigger('message', Buffer.from(JSON.stringify({ type: 'ping' })));
  assert.ok(
    ws.sent.some((s) => {
      try {
        return JSON.parse(s).type === 'pong';
      } catch {
        return false;
      }
    }),
  );
});

test('WS-06: heartbeat ping sent on interval, terminates unresponsive connection', async () => {
  // pingIntervalMs is 50ms in makeEnv config
  const env = makeEnv();
  const ws = makeWs();
  await env.terminal.handleTerminalConnection(ws, 'wb_test');

  // After one interval, server should ping the client
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(ws.pinged, true, 'Server should ping after interval');
  assert.equal(ws.isAlive, false, 'isAlive should be set to false before ping');

  // Simulate pong response (resets isAlive)
  ws.trigger('pong');
  assert.equal(ws.isAlive, true, 'Pong should set isAlive back to true');

  // Now simulate no pong — next interval should terminate
  ws.pinged = false;
  await new Promise((r) => setTimeout(r, 70));
  // isAlive was set to false by first interval tick, pong reset it
  // second tick: isAlive is true (we just set it), so it sets false and pings again
  assert.equal(ws.pinged, true, 'Should ping again on next interval');

  // Now DON'T respond with pong — next tick should terminate
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(ws.readyState, 3, 'Unresponsive connection should be terminated');
});

test('WS: error event kills PTY', async () => {
  const env = makeEnv();
  const ws = makeWs();
  await env.terminal.handleTerminalConnection(ws, 'wb_test');
  ws.trigger('error', new Error('test error'));
  assert.equal(env.fakePty.killed, true, 'Error should kill the PTY');
});

// #483: scrollback capture race fix. Without initialDims the capture is taken
// at the tmux pane's last-known size and the PTY spawns at the historical
// hardcoded 120x40 default — preserves prior behavior for clients that don't
// send dims in the WS URL. With initialDims the handler resizes the tmux
// window to those dims BEFORE capture so the captured bytes' visual layout
// matches what xterm will render them at; PTY then spawns at the matching
// dims (no longer hardcoded 120x40).

function makeEnvWithDimsSpies(overrides = {}) {
  const tmuxExecCalls = [];
  const captureCalls = [];
  const spawnCalls = [];
  // #483 stage-2 strengthening: shared call-order log so WS-13 can assert
  // resize-window fires temporally BEFORE capture (not just that both fire).
  const callOrder = [];
  const env = {
    safe: {
      sanitizeTmuxName: (v) => v.replace(/[^a-zA-Z0-9_-]/g, '_'),
      tmuxCaptureScrollback: (name, lines) => {
        captureCalls.push({ name, lines });
        callOrder.push('capture');
        return 'CAPTURED-BYTES';
      },
      tmuxExecAsync: async (args) => {
        tmuxExecCalls.push(args);
        if (Array.isArray(args) && args[0] === 'resize-window') callOrder.push('resize');
        return '';
      },
    },
    keepalive: { onBrowserConnect() {}, onBrowserDisconnect() {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    config: {
      get: (k, fb) => ({ 'ws.bufferHighWaterMark': 1024, 'ws.bufferLowWaterMark': 512,
                          'ws.pingIntervalMs': 50, 'ws.scrollbackReplayLines': 10000 })[k] ?? fb,
    },
    sessionWsClients: new Map(),
    getBrowserCount: () => 0,
    incrementBrowserCount: () => 1,
    decrementBrowserCount: () => 0,
    tmuxExists: async () => true,
    cancelTmuxCleanup() {},
    scheduleTmuxCleanup() {},
    startJsonlWatcher() {},
    stopJsonlWatcher() {},
    spawnPty: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      callOrder.push('spawn');
      return new FakePty();
    },
    ...overrides,
  };
  env.terminal = createWsTerminal(env);
  env.spies = { tmuxExecCalls, captureCalls, spawnCalls, callOrder };
  return env;
}

test('WS-12: #483 — no initialDims falls back to hardcoded 120x40 and skips pre-resize', async () => {
  const env = makeEnvWithDimsSpies();
  const ws = makeWs();
  await env.terminal.handleTerminalConnection(ws, 'wb_test');
  assert.equal(env.spies.tmuxExecCalls.length, 0, 'no resize-window should fire without initialDims');
  assert.equal(env.spies.spawnCalls.length, 1, 'PTY spawn should still happen');
  const opts = env.spies.spawnCalls[0].opts;
  assert.equal(opts.cols, 120, `PTY cols should be 120 default; got ${opts.cols}`);
  assert.equal(opts.rows, 40, `PTY rows should be 40 default; got ${opts.rows}`);
  // Capture should still happen (using the pane's existing size).
  assert.equal(env.spies.captureCalls.length, 1, 'capture should fire once');
  assert.ok(ws.sent.includes('CAPTURED-BYTES'), 'capture bytes should reach the client');
});

test('WS-13: #483 — with initialDims, tmux resize-window fires BEFORE capture and PTY spawns at those dims', async () => {
  const env = makeEnvWithDimsSpies();
  const ws = makeWs();
  // Capture call-order via interleaved indexing on the same arrays.
  // resize-window must precede capture; spawnPty receives matching dims.
  await env.terminal.handleTerminalConnection(ws, 'wb_test', { cols: 200, rows: 60 });
  assert.equal(env.spies.tmuxExecCalls.length, 1, 'one resize-window invocation expected');
  const resizeArgs = env.spies.tmuxExecCalls[0];
  assert.deepEqual(
    resizeArgs,
    ['resize-window', '-t', 'wb_test', '-x', '200', '-y', '60'],
    `resize-window args must match initialDims; got ${JSON.stringify(resizeArgs)}`,
  );
  assert.equal(env.spies.captureCalls.length, 1, 'capture should fire once after resize');
  assert.equal(env.spies.spawnCalls.length, 1, 'PTY spawn should fire once');
  const opts = env.spies.spawnCalls[0].opts;
  assert.equal(opts.cols, 200, `PTY cols should match initialDims; got ${opts.cols}`);
  assert.equal(opts.rows, 60, `PTY rows should match initialDims; got ${opts.rows}`);
  // #483 stage-2 strengthening: pin temporal ordering, not just counts.
  // The bug was capture-before-resize; assertion below would have caught it.
  const resizeIdx = env.spies.callOrder.indexOf('resize');
  const captureIdx = env.spies.callOrder.indexOf('capture');
  assert.notEqual(resizeIdx, -1, 'resize must appear in call order');
  assert.notEqual(captureIdx, -1, 'capture must appear in call order');
  assert.ok(resizeIdx < captureIdx,
    `resize-window must fire BEFORE capture; got order ${JSON.stringify(env.spies.callOrder)}`);
});

test('WS-14: #483 — resize-window failure is non-fatal (capture + PTY still proceed)', async () => {
  // Failing tmuxExecAsync (e.g. session detached or tmux glitch) must not
  // block the connection. Capture + spawn proceed; only the pre-resize is
  // skipped (PTY attach will resize tmux on its own).
  const env = makeEnvWithDimsSpies({
    safe: {
      sanitizeTmuxName: (v) => v.replace(/[^a-zA-Z0-9_-]/g, '_'),
      tmuxCaptureScrollback: () => 'CAPTURED-BYTES',
      tmuxExecAsync: async () => { throw new Error('resize-window failed'); },
    },
  });
  const ws = makeWs();
  await env.terminal.handleTerminalConnection(ws, 'wb_test', { cols: 100, rows: 30 });
  assert.equal(env.spies.spawnCalls.length, 1, 'PTY spawn should still occur on resize failure');
  const opts = env.spies.spawnCalls[0].opts;
  assert.equal(opts.cols, 100, `PTY cols should still match initialDims; got ${opts.cols}`);
  assert.equal(opts.rows, 30, `PTY rows should still match initialDims; got ${opts.rows}`);
  assert.ok(ws.sent.includes('CAPTURED-BYTES'), 'capture should still proceed');
});
