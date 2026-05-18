'use strict';

// #651 commit 8: /ws/state subscription channel (R29 — separate endpoint
// from /ws/terminal). Protocol per R2: every message is JSON with
// { type, version: 1, seq, at, ... }.
//
// On connect: stateEngine.subscribe(send) returns the current snapshot
//             via `{ type: 'state:snapshot', ... }`.
// Live updates: `{ type: 'state:diff', diff: { kind, ... } }`.
// Idle:        `{ type: 'state:heartbeat' }` from the engine timer.
// Client→server: `{ type: 'ping' }` → server responds with
//             `{ type: 'pong', at }` so a client can measure RTT.
//
// Backpressure: each subscriber's `send` writes to ws.send(). If
// ws.bufferedAmount exceeds the configured high-water mark, we mark the
// subscriber dead (R30: drop oldest by closing — the client reconnects
// and gets a fresh snapshot, which is the equivalent of "drop oldest" for
// a snapshot+diff protocol).

module.exports = function createWsState({ stateEngine, logger, config }) {
  const log = logger || { info() {}, warn() {}, error() {}, debug() {} };
  const cfg = config || { get: (_k, def) => def };
  const bufferHighWater = cfg.get('ws.state.bufferHighWaterMark', 1_048_576);
  const PROTOCOL_VERSION = 1;

  function handleStateConnection(ws) {
    let unsubscribe = null;
    let closed = false;

    function send(message) {
      if (closed || ws.readyState !== 1 /* OPEN */) {
        throw new Error('ws_closed');
      }
      // R30 backpressure guard: if the socket can't keep up with engine
      // diffs, the subscriber is dead from our perspective. The client
      // reconnects (and re-subscribes to a fresh snapshot) which is the
      // snapshot+diff equivalent of drop-oldest.
      if (ws.bufferedAmount > bufferHighWater) {
        log.warn('ws-state: subscriber over high-water mark, closing', {
          module: 'ws-state',
          bufferedAmount: ws.bufferedAmount,
          highWater: bufferHighWater,
        });
        try { ws.close(1009 /* Message Too Big */, 'backpressure'); } catch (_e) { /* ok */ }
        throw new Error('ws_backpressure');
      }
      ws.send(JSON.stringify(message));
    }

    try {
      unsubscribe = stateEngine.subscribe(send);
    } catch (err) {
      log.warn('ws-state: subscribe failed', { module: 'ws-state', err: err.message });
      try { ws.close(1011 /* Internal Error */, 'subscribe_failed'); } catch (_e) { /* ok */ }
      return;
    }

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        log.debug('ws-state: malformed client message', { module: 'ws-state', err: err.message });
        return;
      }
      if (msg && msg.type === 'ping') {
        try {
          send({ type: 'pong', version: PROTOCOL_VERSION, at: Date.now() });
        } catch (_e) {
          /* already closed; engine subscriber cleanup will catch up */
        }
      }
    });

    function cleanup() {
      if (closed) return;
      closed = true;
      if (unsubscribe) {
        try { unsubscribe(); } catch (err) {
          log.debug('ws-state: unsubscribe error', { module: 'ws-state', err: err.message });
        }
      }
    }

    ws.on('close', cleanup);
    ws.on('error', (err) => {
      log.debug('ws-state: connection error', { module: 'ws-state', err: err.message });
      cleanup();
    });
  }

  return { handleStateConnection };
};
