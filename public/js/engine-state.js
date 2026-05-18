'use strict';

// #651 commit 9: client-side mirror of the server State Engine. Connects
// to /ws/state, holds a local in-memory model, applies incoming diffs,
// and notifies subscribers on every state change. Drop-in for the
// existing /api/state polling loop in app.js — once commit 12 wires the
// subscribers, the periodic poll is removed.
//
// Loaded into the page via <script src="js/engine-state.js"></script> and
// requirable from Node tests via the UMD wrapper at the bottom.

(function (global) {

  function applyDiff(state, diff) {
    if (!diff || !diff.kind) return;
    if (diff.kind === 'project:add') {
      // Defensive: if the path already exists (warm-after-snapshot race),
      // upsert instead of double-add.
      const i = state.projects.findIndex((p) => p.path === diff.path);
      if (i >= 0) Object.assign(state.projects[i], diff.project);
      else state.projects.push(diff.project);
      return;
    }
    if (diff.kind === 'project:update') {
      const p = state.projects.find((x) => x.path === diff.path);
      if (p && diff.fields) Object.assign(p, diff.fields);
      return;
    }
    if (diff.kind === 'project:remove') {
      const i = state.projects.findIndex((x) => x.path === diff.path);
      if (i >= 0) state.projects.splice(i, 1);
      return;
    }
    if (diff.kind === 'session:add') {
      const p = state.projects.find((x) => x.path === diff.project_path);
      if (!p) return;
      p.sessions = p.sessions || [];
      const i = p.sessions.findIndex((s) => s.id === diff.id);
      if (i >= 0) Object.assign(p.sessions[i], diff.session);
      else p.sessions.push(diff.session);
      return;
    }
    if (diff.kind === 'session:update') {
      const p = state.projects.find((x) => x.path === diff.project_path);
      if (!p || !p.sessions) return;
      const s = p.sessions.find((x) => x.id === diff.id);
      if (s && diff.fields) Object.assign(s, diff.fields);
      return;
    }
    if (diff.kind === 'session:remove') {
      const p = state.projects.find((x) => x.path === diff.project_path);
      if (!p || !p.sessions) return;
      p.sessions = p.sessions.filter((x) => x.id !== diff.id);
      return;
    }
    if (diff.kind === 'program:upsert') {
      const i = state.programs.findIndex((x) => x.id === diff.id);
      if (i >= 0) state.programs[i] = diff.program;
      else state.programs.push(diff.program);
      return;
    }
    if (diff.kind === 'program:remove') {
      const i = state.programs.findIndex((x) => x.id === diff.id);
      if (i >= 0) state.programs.splice(i, 1);
      return;
    }
  }

  function createEngineStateClient({
    url = (typeof location !== 'undefined' ? `ws://${location.host}/ws/state` : null),
    WebSocketCtor = (typeof WebSocket !== 'undefined' ? WebSocket : null),
    backoffInitialMs = 1000,
    backoffMaxMs = 30000,
    logger = { warn() {}, info() {}, debug() {} },
    onConnect = null,
    onDisconnect = null,
  } = {}) {
    if (!WebSocketCtor) {
      throw new Error('engine-state: no WebSocket constructor available');
    }
    if (!url) {
      throw new Error('engine-state: no URL provided');
    }

    const state = {
      projects: [],
      programs: [],
      workspace: null,
      warming: true,
      lastSeq: 0,
      connected: false,
    };
    const subscribers = new Set();
    let ws = null;
    let backoff = backoffInitialMs;
    let stopped = false;
    let reconnectTimer = null;

    function notify(event) {
      for (const fn of subscribers) {
        try { fn(event, state); }
        catch (err) { logger.warn('engine-state subscriber threw', { err: err.message }); }
      }
    }

    function handleMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'state:snapshot') {
        state.projects = (msg.snapshot && msg.snapshot.projects) || [];
        state.programs = (msg.snapshot && msg.snapshot.programs) || [];
        state.workspace = (msg.snapshot && msg.snapshot.workspace) || null;
        state.warming = !!msg.warming;
        state.lastSeq = msg.seq || 0;
        notify({ type: 'snapshot' });
        return;
      }
      if (msg.type === 'state:diff') {
        applyDiff(state, msg.diff);
        state.lastSeq = msg.seq || state.lastSeq;
        notify({ type: 'diff', diff: msg.diff });
        return;
      }
      if (msg.type === 'state:heartbeat') {
        state.lastSeq = msg.seq || state.lastSeq;
        // No model change; subscribers don't need to know
        return;
      }
      // pong is a response to client-initiated ping; ignored at this layer
    }

    function connect() {
      if (stopped) return;
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) return; // CONNECTING/OPEN
      ws = new WebSocketCtor(url);
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); }
        catch (err) {
          logger.debug('engine-state: malformed message', { err: err.message });
          return;
        }
        handleMessage(msg);
      };
      ws.onopen = () => {
        backoff = backoffInitialMs;
        state.connected = true;
        notify({ type: 'connected' });
        if (onConnect) try { onConnect(); } catch (_e) { /* swallow */ }
      };
      ws.onclose = () => {
        state.connected = false;
        notify({ type: 'disconnected' });
        if (onDisconnect) try { onDisconnect(); } catch (_e) { /* swallow */ }
        if (stopped) return;
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, backoffMaxMs);
      };
      ws.onerror = (_err) => {
        // close will fire — let the close handler schedule reconnect
      };
    }

    function disconnect() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) {
        try { ws.close(); } catch (_e) { /* ok */ }
        ws = null;
      }
    }

    function subscribe(fn) {
      if (typeof fn !== 'function') throw new TypeError('subscribe expects a function');
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    }

    function getState() { return state; }

    // Exposed for testing: lets the test drive a fake-WS open/message/close
    function _injectMessage(msg) { handleMessage(msg); }

    function ping() {
      if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_e) { /* ok */ }
      }
    }

    return {
      connect, disconnect, subscribe, getState, ping,
      _injectMessage, _applyDiff: (d) => applyDiff(state, d),
    };
  }

  const exports = { createEngineStateClient, applyDiff };
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  else global.EngineState = exports;

})(typeof window !== 'undefined' ? window : globalThis);
