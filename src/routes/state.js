'use strict';

// #651 commit 5: extract GET /api/state into its own domain module.
//
// Pure extraction from routes/sessions.js for stage-1 — handler body is
// behavior-equivalent to the previous implementation, with two additions:
//
//   1. In-flight coalescing (R6): concurrent callers share one Promise. Under
//      N browser tabs polling /api/state every 10 s, the server now does
//      ONE scan per fan-in window instead of N. Closes part of #638.
//
//   2. Optional state-engine fast-path: if a populated state-engine is
//      injected via deps.stateEngine and not in warming mode, serve from
//      its immutable snapshot. If the engine is still warming, return
//      503 {warming: true} per R28. If the engine throws
//      MemoryBoundExceededError (R34), return 507 with a truncation note.
//      When the engine is absent or warming, fall back to the legacy DB-walk
//      so the route keeps working through the cutover window.
//
// The mutation-source wire-up that populates the engine on every state
// change lives in a follow-on commit; until that lands, the engine snapshot
// is correct at boot but goes stale on writes. The default fall-through to
// the DB-walk keeps user-visible behaviour unchanged during that window.

const { readdir, stat } = require('fs/promises');
const { join, basename } = require('path');

function register(app, {
  db,
  safe,
  sessionUtils,
  logger,
  WORKSPACE,
  stateEngine,
}, helpers) {
  const reconcileStaleSessionsForProject = helpers?.reconcileStaleSessionsForProject;
  const buildSessionList = helpers?.buildSessionList;

  if (typeof reconcileStaleSessionsForProject !== 'function' ||
      typeof buildSessionList !== 'function') {
    throw new Error(
      'routes/state: registerSessions.register(...) must run first and return ' +
        '{reconcileStaleSessionsForProject, buildSessionList} so the /api/state ' +
        'handler can call them.',
    );
  }

  // ── In-flight coalescing primitive (R6) ────────────────────────────────────
  // A single Promise represents the current scan. New callers await it.
  let _inflight = null;

  async function _scanState() {
    const projects = [];
    const dbProjects = db.getProjects();
    const claimedGemini = new Set();
    const claimedCodex = new Set();

    for (const dbProject of dbProjects) {
      const projectName = dbProject.name;
      const projectPath = dbProject.path;
      const project = dbProject;

      let dirMissing = false;
      try {
        await stat(projectPath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          dirMissing = true;
        } else {
          logger.warn('Error checking project directory', {
            module: 'routes/state',
            project: projectName,
            err: err.message,
          });
          dirMissing = true;
        }
      }

      const sessDir = safe.findSessionsDir(projectPath);

      // #257: reconcile MUST run BEFORE autonomous JSONL discovery.
      const currentSessionsForReconcile = db.getSessionsForProject(project.id);
      await reconcileStaleSessionsForProject(currentSessionsForReconcile, sessDir, project.id);

      try {
        const sessionFiles = await readdir(sessDir);
        for (const file of sessionFiles) {
          if (!file.endsWith('.jsonl')) continue;
          const sessionId = basename(file, '.jsonl');
          const existing = db.getSession(sessionId);
          if (existing && existing.cli_type && existing.cli_type !== 'claude') continue;
          const fileMeta = await sessionUtils.parseSessionFile(join(sessDir, file));
          if (fileMeta) db.upsertSession(sessionId, project.id, fileMeta.name);
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.warn('Error reading sessions dir in state handler', {
            module: 'routes/state',
            project: projectName,
            err: err.message,
          });
        }
        /* expected for ENOENT: no sessions dir */
      }

      const dbSessions = db.getSessionsForProject(project.id);
      const sessions = await buildSessionList(dbSessions, sessDir, claimedGemini, claimedCodex);

      for (const s of sessions) {
        s.project_missing = dirMissing;
      }

      projects.push({
        name: projectName,
        path: projectPath,
        sessions,
        missing: dirMissing,
        state: project.state || 'active',
        program_id: project.program_id ?? null,
      });
    }

    projects.sort((a, b) => {
      const aTime = a.sessions[0]?.timestamp || '1970-01-01';
      const bTime = b.sessions[0]?.timestamp || '1970-01-01';
      return new Date(bTime) - new Date(aTime);
    });

    const programs = db.getAllPrograms('active');
    return { projects, programs, workspace: WORKSPACE };
  }

  function _coalescedScan() {
    if (_inflight) return _inflight;
    _inflight = _scanState().finally(() => {
      _inflight = null;
    });
    return _inflight;
  }

  // ── GET /api/state ─────────────────────────────────────────────────────────

  app.get('/api/state', async (req, res) => {
    // Fast path: serve from state-engine when populated.
    //
    // Reviewer-Codex BLOCKER (build-review-round1): if warmStateEngine
    // never reaches markWarm() (transient DB failure leaves the engine
    // permanently warming), this route would return 503 forever — breaking
    // the REST contract. Fix: warming is now ADVISORY, not authoritative.
    // We always fall back to the DB-walk when the engine isn't ready,
    // surfacing the warming hint via a response header so clients that care
    // can show a "loading" affordance without losing functionality.
    if (stateEngine && typeof stateEngine.isWarming === 'function' && !stateEngine.isWarming()) {
      try {
        // Reviewer-Claude NON-BLOCKER N2 (build-review-round1): serializeSnapshot
        // already stringified the snapshot to enforce the bound. res.json(snap)
        // would stringify it a second time — wasteful on the dominant hot path.
        // Send the pre-serialized JSON directly.
        const { serialized } = stateEngine.serializeSnapshot();
        return res.type('application/json').send(serialized);
      } catch (err) {
        // R34: snapshot exceeded the bound. Surface as 507 so clients know
        // to back off or request a paginated view.
        if (err && err.code === 'STATE_MEMORY_BOUND_EXCEEDED') {
          logger.warn('State snapshot exceeds memory bound', {
            module: 'routes/state',
            actual: err.actual,
            max: err.max,
          });
          return res.status(507).json({
            error: 'state snapshot exceeds memory bound',
            actual_bytes: err.actual,
            max_bytes: err.max,
          });
        }
        // Anything else from the engine path: fall through to the legacy
        // DB-walk rather than crashing the request.
        logger.warn('state-engine snapshot threw; falling back to DB-walk', {
          module: 'routes/state',
          err: err.message,
        });
        // fall through
      }
    }

    // Engine warming OR engine absent OR engine threw: DB-walk fallback.
    // The warming-progress header lets clients surface a loading hint
    // without the REST contract degrading.
    if (stateEngine && typeof stateEngine.isWarming === 'function' && stateEngine.isWarming()) {
      const progress = typeof stateEngine.getWarmProgress === 'function'
        ? stateEngine.getWarmProgress()
        : { warming: true };
      res.set('X-State-Engine-Warming', '1');
      if (progress.started_at != null) {
        res.set('X-State-Engine-Warm-Started-At', String(progress.started_at));
      }
    }

    try {
      const result = await _coalescedScan();
      res.json(result);
    } catch (err) {
      logger.error('Error listing state', { module: 'routes/state', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return { _coalescedScan, _scanState };
}

module.exports = { register };
