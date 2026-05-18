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
    for (const project of projects.values()) {
      out.projects.push({
        name: project.name,
        path: project.path,
        sessions: Array.from(project.sessions.values()),
        missing: project.missing || false,
        state: project.state || 'active',
        program_id: project.program_id ?? null,
      });
    }
    for (const program of programs.values()) {
      out.programs.push(program);
    }
    return out;
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
    if (!projects.has(path)) return false;
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
      _publish({
        kind: 'session:update',
        id: session.id,
        project_path: session.project_path,
        fields: session,
      });
    } else {
      project.sessions.set(session.id, { ...session });
      _publish({
        kind: 'session:add',
        id: session.id,
        project_path: session.project_path,
        session: { ...session },
      });
    }
  }

  function updateSession(sessionId, partialFields) {
    for (const project of projects.values()) {
      const s = project.sessions.get(sessionId);
      if (s) {
        Object.assign(s, partialFields);
        _publish({
          kind: 'session:update',
          id: sessionId,
          project_path: project.path,
          fields: partialFields,
        });
        return true;
      }
    }
    return false;
  }

  function removeSession(sessionId) {
    for (const project of projects.values()) {
      if (project.sessions.delete(sessionId)) {
        _publish({
          kind: 'session:remove',
          id: sessionId,
          project_path: project.path,
        });
        return true;
      }
    }
    return false;
  }

  function getSession(sessionId) {
    for (const project of projects.values()) {
      const s = project.sessions.get(sessionId);
      if (s) return s;
    }
    return null;
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
      send({
        type: 'state:snapshot',
        version: 1,
        seq: nextSeq++,
        at: clock(),
        snapshot: snapshot(),
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
