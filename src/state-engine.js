'use strict';

const { EventEmitter } = require('node:events');

const MAX_BYTES_DEFAULT = 5 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS_DEFAULT = 30_000;
const SUBSCRIBER_TIMEOUT_MS_DEFAULT = 90_000;

class MemoryBoundExceededError extends Error {
  constructor(actual, max) {
    super(`State snapshot exceeds memory bound: ${actual} bytes > ${max} max`);
    this.code = 'STATE_MEMORY_BOUND_EXCEEDED';
    this.actual = actual;
    this.max = max;
  }
}

function createStateEngine({
  logger,
  maxBytes = MAX_BYTES_DEFAULT,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS_DEFAULT,
  subscriberTimeoutMs = SUBSCRIBER_TIMEOUT_MS_DEFAULT,
  clock = () => Date.now(),
} = {}) {
  const log = logger || { info() {}, warn() {}, error() {} };

  let workspace = null;
  const projects = new Map();
  const programs = new Map();
  // Reviewer-Codex NON-BLOCKER (build-review-round1): updateSession was
  // O(total sessions) because it scanned every project. Watcher-driven
  // token-update events fire hot, so we maintain a sessionId → projectPath
  // index that makes updateSession / removeSession / getSession O(1).
  const sessionIndex = new Map();

  let warming = true;
  let warmStartedAt = null;
  let warmCompletedAt = null;

  const subscribers = new Map();
  let nextSubscriberId = 1;
  let nextSeq = 1;

  let _heartbeatTimer = null;

  const emitter = new EventEmitter();

  function _require(obj, ...keys) {
    for (const k of keys) {
      if (obj == null || obj[k] == null) {
        throw new TypeError(`state-engine: missing required field: ${k}`);
      }
    }
  }

  function setWorkspace(path) {
    workspace = path;
  }

  function startWarm() {
    warmStartedAt = clock();
    warming = true;
  }

  function markWarm() {
    if (!warming) return;
    warming = false;
    warmCompletedAt = clock();
    emitter.emit('warm');
  }

  function isWarming() {
    return warming;
  }

  function getWarmProgress() {
    return {
      warming,
      started_at: warmStartedAt,
      completed_at: warmCompletedAt,
    };
  }

  function snapshot() {
    const out = {
      projects: [],
      programs: [],
      workspace,
    };
    // Reviewer-Gemini NON-BLOCKER N7 (build-review-round1): legacy _scanState
    // sorts projects by most-recent session timestamp. Mirror that here so
    // the sidebar order doesn't visibly shift when engine warms / falls
    // back / takes over. Session-level ordering is preserved as-stored.
    for (const project of projects.values()) {
      const sessionsArr = Array.from(project.sessions.values());
      out.projects.push({
        name: project.name,
        path: project.path,
        sessions: sessionsArr,
        missing: project.missing || false,
        state: project.state || 'active',
        program_id: project.program_id ?? null,
      });
    }
    out.projects.sort((a, b) => {
      const at = _maxTimestamp(a.sessions);
      const bt = _maxTimestamp(b.sessions);
      return bt - at;
    });
    for (const program of programs.values()) {
      out.programs.push(program);
    }
    return out;
  }

  function _maxTimestamp(sessions) {
    if (!sessions || sessions.length === 0) return 0;
    let max = 0;
    for (const s of sessions) {
      const t = s && s.timestamp ? new Date(s.timestamp).getTime() : 0;
      if (Number.isFinite(t) && t > max) max = t;
    }
    return max;
  }

  function serializeSnapshot() {
    const snap = snapshot();
    const serialized = JSON.stringify(snap);
    const bytes = Buffer.byteLength(serialized, 'utf-8');
    if (bytes > maxBytes) {
      throw new MemoryBoundExceededError(bytes, maxBytes);
    }
    return { snap, serialized, bytes };
  }

  function _publish(diff) {
    const seq = nextSeq++;
    const message = {
      type: 'state:diff',
      version: 1,
      seq,
      at: clock(),
      diff,
    };
    for (const [id, sub] of subscribers) {
      if (sub.dead) continue;
      try {
        sub.send(message);
        sub.lastSeen = clock();
      } catch (err) {
        log.warn('state-engine: subscriber send failed; marking dead', {
          module: 'state-engine',
          subscriberId: id,
          err: err.message,
        });
        sub.dead = true;
      }
    }
    _cleanupDeadSubscribers();
  }

  function upsertProject(project) {
    _require(project, 'path');
    const existing = projects.get(project.path);
    if (existing) {
      if (project.name != null) existing.name = project.name;
      if (project.missing != null) existing.missing = !!project.missing;
      if (project.state != null) existing.state = project.state;
      if (project.program_id !== undefined) existing.program_id = project.program_id;
      _publish({ kind: 'project:update', path: project.path, fields: project });
    } else {
      projects.set(project.path, {
        name: project.name || project.path,
        path: project.path,
        missing: project.missing || false,
        state: project.state || 'active',
        program_id: project.program_id ?? null,
        sessions: new Map(),
      });
      const created = projects.get(project.path);
      _publish({
        kind: 'project:add',
        path: project.path,
        project: { ...created, sessions: [] },
      });
    }
  }

  function removeProject(path) {
    const project = projects.get(path);
    if (!project) return false;
    // Drop the project's sessions from the index too, so updateSession()
    // on a now-orphan session id returns false instead of finding a stale
    // pointer.
    for (const sessId of project.sessions.keys()) {
      sessionIndex.delete(sessId);
    }
    projects.delete(path);
    _publish({ kind: 'project:remove', path });
    return true;
  }

  function upsertSession(session) {
    _require(session, 'id', 'project_path');
    const project = projects.get(session.project_path);
    if (!project) {
      throw new Error(
        `state-engine: cannot upsert session ${session.id}: project ${session.project_path} not in engine`,
      );
    }
    const existing = project.sessions.get(session.id);
    if (existing) {
      Object.assign(existing, session);
      sessionIndex.set(session.id, session.project_path);
      _publish({
        kind: 'session:update',
        id: session.id,
        project_path: session.project_path,
        fields: session,
      });
    } else {
      project.sessions.set(session.id, { ...session });
      sessionIndex.set(session.id, session.project_path);
      _publish({
        kind: 'session:add',
        id: session.id,
        project_path: session.project_path,
        session: { ...session },
      });
    }
  }

  function updateSession(sessionId, partialFields) {
    const projectPath = sessionIndex.get(sessionId);
    if (!projectPath) return false;
    const project = projects.get(projectPath);
    if (!project) {
      // Index points to a path that no longer holds the project — stale entry.
      sessionIndex.delete(sessionId);
      return false;
    }
    const s = project.sessions.get(sessionId);
    if (!s) {
      sessionIndex.delete(sessionId);
      return false;
    }
    Object.assign(s, partialFields);
    _publish({
      kind: 'session:update',
      id: sessionId,
      project_path: project.path,
      fields: partialFields,
    });
    return true;
  }

  function removeSession(sessionId) {
    const projectPath = sessionIndex.get(sessionId);
    if (!projectPath) return false;
    const project = projects.get(projectPath);
    sessionIndex.delete(sessionId);
    if (!project) return false;
    if (project.sessions.delete(sessionId)) {
      _publish({
        kind: 'session:remove',
        id: sessionId,
        project_path: project.path,
      });
      return true;
    }
    return false;
  }

  function getSession(sessionId) {
    const projectPath = sessionIndex.get(sessionId);
    if (!projectPath) return null;
    const project = projects.get(projectPath);
    if (!project) return null;
    return project.sessions.get(sessionId) || null;
  }

  function upsertProgram(program) {
    _require(program, 'id');
    programs.set(program.id, { ...program });
    _publish({ kind: 'program:upsert', id: program.id, program: { ...program } });
  }

  function removeProgram(programId) {
    if (!programs.has(programId)) return false;
    programs.delete(programId);
    _publish({ kind: 'program:remove', id: programId });
    return true;
  }

  function subscribe(send) {
    if (typeof send !== 'function') {
      throw new TypeError('state-engine: subscribe(send) — send must be a function');
    }
    const id = nextSubscriberId++;
    const sub = { send, lastSeen: clock(), dead: false };
    subscribers.set(id, sub);

    try {
      // R34 parity with HTTP /api/state: refuse to push a snapshot that
      // exceeds the bound. WS subscribers receive a sized-out error frame
      // and the engine drops them — the client surfaces the same "too big"
      // affordance HTTP would have given via 507.
      const snap = snapshot();
      const serialized = JSON.stringify(snap);
      const bytes = Buffer.byteLength(serialized, 'utf-8');
      if (bytes > maxBytes) {
        log.warn('state-engine: subscriber snapshot exceeds memory bound', {
          module: 'state-engine',
          subscriberId: id,
          actual_bytes: bytes,
          max_bytes: maxBytes,
        });
        try {
          send({
            type: 'state:error',
            version: 1,
            seq: nextSeq++,
            at: clock(),
            error: 'memory_bound_exceeded',
            actual_bytes: bytes,
            max_bytes: maxBytes,
          });
        } catch (_innerErr) { /* drop sub anyway */ }
        sub.dead = true;
        subscribers.delete(id);
        return () => unsubscribe(id);
      }
      send({
        type: 'state:snapshot',
        version: 1,
        seq: nextSeq++,
        at: clock(),
        snapshot: snap,
        warming,
      });
      sub.lastSeen = clock();
    } catch (err) {
      log.warn('state-engine: initial snapshot send failed', {
        module: 'state-engine',
        subscriberId: id,
        err: err.message,
      });
      sub.dead = true;
      // Initial-send failure means the subscriber never became viable;
      // remove it immediately so stats() and subsequent _publish loops
      // don't carry the dead reference until the next heartbeat tick.
      subscribers.delete(id);
    }

    if (!_heartbeatTimer && heartbeatIntervalMs > 0) {
      _startHeartbeat();
    }
    return () => unsubscribe(id);
  }

  function unsubscribe(id) {
    const sub = subscribers.get(id);
    if (sub) {
      sub.dead = true;
      subscribers.delete(id);
    }
    if (subscribers.size === 0) _stopHeartbeat();
  }

  function touchSubscriber(id) {
    const sub = subscribers.get(id);
    if (sub && !sub.dead) sub.lastSeen = clock();
  }

  function _cleanupDeadSubscribers() {
    for (const [id, sub] of subscribers) {
      if (sub.dead) subscribers.delete(id);
    }
    if (subscribers.size === 0) _stopHeartbeat();
  }

  function _startHeartbeat() {
    _heartbeatTimer = setInterval(() => {
      const now = clock();
      // R30: send a keepalive ping to every live subscriber on each
      // heartbeat tick. A successful send refreshes sub.lastSeen so idle
      // (no-diff) subscribers don't get falsely evicted; a failing send
      // marks the subscriber dead, which the eviction loop below collects.
      // Without this ping, the time-based eviction triggers within
      // (subscriberTimeoutMs + heartbeatIntervalMs) of any quiet period.
      for (const [id, sub] of subscribers) {
        if (sub.dead) continue;
        try {
          sub.send({
            type: 'state:heartbeat',
            version: 1,
            seq: nextSeq++,
            at: clock(),
          });
          sub.lastSeen = clock();
        } catch (err) {
          log.warn('state-engine: heartbeat send failed; marking dead', {
            module: 'state-engine',
            subscriberId: id,
            err: err.message,
          });
          sub.dead = true;
        }
      }
      for (const [id, sub] of subscribers) {
        if (sub.dead || now - sub.lastSeen > subscriberTimeoutMs) {
          log.info('state-engine: evicting stale subscriber', {
            module: 'state-engine',
            subscriberId: id,
            idle_ms: now - sub.lastSeen,
          });
          sub.dead = true;
          subscribers.delete(id);
        }
      }
      if (subscribers.size === 0) _stopHeartbeat();
    }, heartbeatIntervalMs);
    if (_heartbeatTimer.unref) _heartbeatTimer.unref();
  }

  function _stopHeartbeat() {
    if (_heartbeatTimer) {
      clearInterval(_heartbeatTimer);
      _heartbeatTimer = null;
    }
  }

  function on(event, handler) {
    emitter.on(event, handler);
  }

  function off(event, handler) {
    emitter.off(event, handler);
  }

  function stop() {
    _stopHeartbeat();
    for (const id of Array.from(subscribers.keys())) unsubscribe(id);
  }

  function stats() {
    let totalSessions = 0;
    for (const p of projects.values()) totalSessions += p.sessions.size;
    return {
      projects: projects.size,
      programs: programs.size,
      sessions: totalSessions,
      subscribers: subscribers.size,
      warming,
      seq: nextSeq,
    };
  }

  return {
    setWorkspace,
    startWarm,
    markWarm,
    isWarming,
    getWarmProgress,
    snapshot,
    serializeSnapshot,
    upsertProject,
    removeProject,
    upsertSession,
    updateSession,
    removeSession,
    getSession,
    upsertProgram,
    removeProgram,
    subscribe,
    unsubscribe,
    touchSubscriber,
    on,
    off,
    stop,
    stats,
    MemoryBoundExceededError,
  };
}

module.exports = createStateEngine;
module.exports.createStateEngine = createStateEngine;
module.exports.MemoryBoundExceededError = MemoryBoundExceededError;
module.exports.MAX_BYTES_DEFAULT = MAX_BYTES_DEFAULT;
