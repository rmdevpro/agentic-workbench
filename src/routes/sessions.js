'use strict';

const {
  readdir,
  readFile,
  writeFile,
  stat,
  appendFile,
  access,
  join,
  basename,
  crypto,
  express,
  KB_PATH,
  CODEX_ROLLOUT_UUID_RE,
  SESSION_NAME_MAX_LEN,
  PROJECT_NAME_MAX_LEN,
  PROMPT_MAX_LEN,
  SEARCH_QUERY_MAX_LEN,
  NOTES_MAX_LEN,
  VALID_STATES,
  validateSessionId,
} = require('./_shared');

const { _seedRole } = require('../session-seeder');

function register(app, {
  db,
  safe,
  config,
  sessionUtils,
  keepalive,
  fireEvent,
  logger,
  tmuxName,
  tmuxExists,
  enforceTmuxLimit,
  resolveSessionId,
  getBrowserCount,
  CLAUDE_HOME,
  WORKSPACE,
  ensureSettings,
  trustGeminiProjectDirs,
  trustCodexProjectDirs,
  sleep,
}) {
  const fileLocks = new Map();
  async function _lockedAppend(path, data) {
    const current = fileLocks.get(path) || Promise.resolve();
    const next = current
      .then(() => appendFile(path, data))
      .catch((err) => {
        logger.error('Append write failed', {
          module: 'routes',
          op: 'lockedAppend',
          err: err.message,
          path,
        });
      })
      .finally(() => {
        if (fileLocks.get(path) === next) fileLocks.delete(path);
      });
    fileLocks.set(path, next);
    return next;
  }

  async function checkAuthStatus() {
    const credsFile = join(CLAUDE_HOME, '.credentials.json');
    try {
      const raw = await readFile(credsFile, 'utf-8');
      let creds;
      try {
        creds = JSON.parse(raw);
      } catch (parseErr) {
        if (parseErr instanceof SyntaxError)
          return { valid: false, reason: 'malformed_credentials' };
        throw parseErr;
      }
      const oauth = creds.claudeAiOauth;
      if (!oauth || !oauth.accessToken) return { valid: false, reason: 'no_credentials' };
      if (oauth.accessToken === 'expired' || oauth.refreshToken === 'expired')
        return { valid: false, reason: 'invalid_credentials' };
      if (!oauth.refreshToken) {
        const expiresAt = oauth.expiresAt || 0;
        if (Date.now() > expiresAt) return { valid: false, reason: 'expired_no_refresh' };
      }
      return { valid: true, expiresAt: oauth.expiresAt };
    } catch (err) {
      if (err.code === 'ENOENT') return { valid: false, reason: 'no_credentials_file' };
      logger.error('Unexpected error checking auth status', {
        module: 'routes',
        op: 'checkAuthStatus',
        err: err.message,
      });
      return { valid: false, reason: 'read_error' };
    }
  }

  let _trustDirLock = Promise.resolve();
  async function trustDir(dirPath) {
    const prev = _trustDirLock;
    let unlock;
    _trustDirLock = new Promise((r) => {
      unlock = r;
    });
    await prev;
    try {
      const configFile = join(CLAUDE_HOME, '.claude.json');
      let cfg = {};
      try {
        cfg = JSON.parse(await readFile(configFile, 'utf-8'));
      } catch (err) {
        if (err.code === 'ENOENT') {
          /* first run */
        } else if (err instanceof SyntaxError) {
          logger.error('.claude.json is corrupt — skipping trustDir', { module: 'routes' });
          return;
        } else {
          logger.warn('Failed to parse .claude.json', {
            module: 'routes',
            op: 'trustDir',
            err: err.message,
          });
        }
      }
      if (!cfg.projects) cfg.projects = {};
      if (cfg.projects[dirPath] && cfg.projects[dirPath].hasTrustDialogAccepted) {
        return;
      }
      cfg.projects[dirPath] = {
        hasTrustDialogAccepted: true,
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
      };
      await writeFile(configFile, JSON.stringify(cfg, null, 2));
    } finally {
      unlock();
    }
  }

  // ── Helper: reconcile stale sessions for a project ─────────────────────────

  async function reconcileStaleSessionsForProject(currentSessions, sessDir, projectId) {
    const staleTmps = currentSessions.filter((s) => s.id.startsWith('new_'));
    if (staleTmps.length === 0) return;

    const dbIds = new Set(currentSessions.map((s) => s.id));
    try {
      const files = await readdir(sessDir);
      const unmatched = files.filter(
        (f) => f.endsWith('.jsonl') && !dbIds.has(basename(f, '.jsonl')),
      );
      for (const tmp of staleTmps) {
        // Non-Claude CLIs don't create JSONL files — keep the new_* ID
        const cliType = tmp.cli_type || 'claude';
        if (cliType !== 'claude') {
          if (!(await safe.tmuxExists(tmuxName(tmp.id)))) {
            db.deleteSession(tmp.id);
          }
          continue;
        }
        if (unmatched.length > 0) {
          const realFile = unmatched.shift();
          const realId = basename(realFile, '.jsonl');
          db.upsertSession(realId, projectId, tmp.name || null, cliType);
          if (tmp.user_renamed) db.renameSession(realId, tmp.name);
          if (tmp.notes) db.setSessionNotes(realId, tmp.notes);
          if (tmp.state && tmp.state !== 'active') db.setSessionState(realId, tmp.state);
          db.deleteSession(tmp.id);
          const oldTmux = tmuxName(tmp.id);
          const newTmux = tmuxName(realId);
          try {
            await safe.tmuxExecAsync(['rename-session', '-t', oldTmux, newTmux]);
          } catch (renameErr) {
            if (
              renameErr.message &&
              (renameErr.message.includes('no server running') ||
                renameErr.message.includes('error connecting to'))
            ) {
              /* expected: tmux server not running */
            } else {
              logger.debug('tmux rename skipped during reconcile', {
                module: 'routes',
                err: renameErr.message,
              });
            }
          }
        } else if (!(await safe.tmuxExists(tmuxName(tmp.id)))) {
          db.deleteSession(tmp.id);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Error reconciling stale sessions', { module: 'routes', err: err.message });
      }
      /* expected for ENOENT: no sessions dir */
    }
  }

  // #372 [E2]: per-CLI discovery cache lives in session-utils now (10s TTL,
  // shared across all callers). Routes calls discoverGeminiSessions /
  // discoverCodexSessions directly; the cache dedupes parallel polls.
  const NONCLAUD_CACHE_TTL = 10000; // claim-reset window only

  // Track which disk sessions have been claimed so we don't double-assign
  const _claimedGemini = new Set();
  const _claimedCodex = new Set();
  let _claimResetTime = 0;

  function _resetClaims() {
    const now = Date.now();
    if (now - _claimResetTime > NONCLAUD_CACHE_TTL) {
      _claimedGemini.clear();
      _claimedCodex.clear();
      _claimResetTime = now;
    }
  }

  function _matchFromList(diskSessions, claimed, session, getIdFn, storeIdFn) {
    // 1. Match by cli_session_id
    if (session.cli_session_id) {
      const match = diskSessions.find(d => !claimed.has(d.filePath) && getIdFn(d) === session.cli_session_id);
      if (match) { claimed.add(match.filePath); return match; }
    }
    // 2. Match by creation time proximity (within 60s)
    if (session.created_at) {
      const created = new Date(session.created_at).getTime();
      const match = diskSessions.find(d => {
        if (claimed.has(d.filePath) || !d.timestamp) return false;
        return Math.abs(new Date(d.timestamp).getTime() - created) < 60000;
      });
      if (match) {
        claimed.add(match.filePath);
        if (!session.cli_session_id) storeIdFn(session, match);
        return match;
      }
    }
    // 3. Order-based: take the first unclaimed disk session
    const unclaimed = diskSessions.find(d => !claimed.has(d.filePath));
    if (unclaimed) {
      claimed.add(unclaimed.filePath);
      if (!session.cli_session_id) storeIdFn(session, unclaimed);
      return unclaimed;
    }
    return null;
  }

  // SIDE EFFECT: when this matches a disk session, it writes the resolved
  // cli_session_id back to the DB via setCliSessionId so subsequent fast-path
  // lookups (in session-utils.getSessionInfo) can find the file by ID directly.
  // Callers that just want the side-effect (buildSessionList pre-pass) can ignore
  // the return value.
  function _getNonClaudeMetadata(session) {
    const cliType = session.cli_type || 'claude';
    if (cliType === 'claude') return null;
    _resetClaims();

    if (cliType === 'gemini') {
      const sorted = sessionUtils.discoverGeminiSessions().sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return ta - tb;
      });
      return _matchFromList(sorted, _claimedGemini, session,
        (d) => d.sessionId,
        (sess, match) => {
          if (match.sessionId) {
            try { db.setCliSessionId(sess.id, match.sessionId); } catch { /* race ok */ }
          }
        }
      );
    }

    if (cliType === 'codex') {
      const sorted = sessionUtils.discoverCodexSessions().sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return ta - tb;
      });
      return _matchFromList(sorted, _claimedCodex, session,
        (d) => {
          // Codex files: /sessions/YYYY/MM/DD/rollout-{timestamp}-{uuid}.jsonl
          // Extract the UUID from the filename for resume
          const name = basename(d.filePath, '.jsonl');
          const uuidMatch = name.match(CODEX_ROLLOUT_UUID_RE);
          return uuidMatch ? uuidMatch[1] : name;
        },
        (sess, match) => {
          const name = basename(match.filePath, '.jsonl');
          const uuidMatch = name.match(CODEX_ROLLOUT_UUID_RE);
          const rolloutId = uuidMatch ? uuidMatch[1] : name;
          if (rolloutId && rolloutId !== 'sessions') {
            try { db.setCliSessionId(sess.id, rolloutId); } catch { /* race ok */ }
          }
        }
      );
    }

    return null;
  }

  async function buildSessionList(dbSessions, _sessDir) {
    // #156: disambiguation pre-pass — for non-Claude sessions whose cli_session_id
    // hasn't been stored yet, run the claim algorithm so the DB has the right
    // pointer before any per-session lazy /info fetch resolves the file by ID.
    for (const s of dbSessions) {
      const cliType = s.cli_type || 'claude';
      if (cliType !== 'claude' && !s.cli_session_id) {
        _getNonClaudeMetadata(s);
      }
    }

    // #371 [E1]: minimal sidebar payload — id, name, timestamp, cli_type,
    // archived, state. NO messageCount / model / tmux / active in this list:
    // those required N JSONL parses per /api/state poll (5-7s p95 on M5).
    // Heavy fields move to GET /api/sessions/:sessionId/info, called only for
    // the active session + visible sessions (project expanded). Sort by
    // db updated_at (the timestamp we have without parsing JSONLs).
    const sessions = dbSessions.map(s => ({
      id: s.id,
      name: s.name,
      timestamp: s.updated_at || s.created_at,
      cli_type: s.cli_type || 'claude',
      archived: s.state === 'archived',
      state: s.state,
    }));
    sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return sessions;
  }

  // ── GET /api/state ─────────────────────────────────────────────────────────

  app.get('/api/state', async (req, res) => {
    try {
      const projects = [];
      const dbProjects = db.getProjects();

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
              module: 'routes',
              project: projectName,
              err: err.message,
            });
            dirMissing = true;
          }
        }

        const sessDir = safe.findSessionsDir(projectPath);

        // #257: reconcile MUST run BEFORE the autonomous JSONL discovery below.
        // For MCP-spawned sessions there's no session-resolver running, so the
        // provisional `new_<ts>` row needs the reconciler to bind it to its
        // realID JSONL. If discovery runs first, it creates a separate realID
        // row using parseSessionFile-derived name (the prompt text), which then
        // makes the reconciler treat the JSONL as "claimed" — leaving the
        // provisional row as a permanent orphan in the sidebar AND mis-naming
        // the real row. Run reconcile first; discovery picks up any leftover
        // unbound JSONLs (e.g. sessions created via the CLI directly).
        const currentSessionsForReconcile = db.getSessionsForProject(project.id);
        await reconcileStaleSessionsForProject(currentSessionsForReconcile, sessDir, project.id);

        try {
          const sessionFiles = await readdir(sessDir);
          for (const file of sessionFiles) {
            if (!file.endsWith('.jsonl')) continue;
            const sessionId = basename(file, '.jsonl');
            // Skip JSONL files that belong to non-Claude sessions (Gemini/Codex UUIDs
            // may end up here as empty files — don't overwrite their DB records)
            const existing = db.getSession(sessionId);
            if (existing && existing.cli_type && existing.cli_type !== 'claude') continue;
            const fileMeta = await sessionUtils.parseSessionFile(join(sessDir, file));
            if (fileMeta) db.upsertSession(sessionId, project.id, fileMeta.name);
          }
        } catch (err) {
          if (err.code !== 'ENOENT') {
            logger.warn('Error reading sessions dir in state handler', {
              module: 'routes',
              project: projectName,
              err: err.message,
            });
          }
          /* expected for ENOENT: no sessions dir */
        }

        const dbSessions = db.getSessionsForProject(project.id);
        const sessions = await buildSessionList(dbSessions, sessDir);

        for (const s of sessions) {
          s.project_missing = dirMissing;
        }

        projects.push({ name: projectName, path: projectPath, sessions, missing: dirMissing, state: project.state || 'active', program_id: project.program_id ?? null });
      }

      projects.sort((a, b) => {
        const aTime = a.sessions[0]?.timestamp || '1970-01-01';
        const bTime = b.sessions[0]?.timestamp || '1970-01-01';
        return new Date(bTime) - new Date(aTime);
      });

      const programs = db.getAllPrograms('active');
      res.json({ projects, programs, workspace: WORKSPACE });
    } catch (err) {
      logger.error('Error listing state', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/search ────────────────────────────────────────────────────────

  app.get('/api/search', async (req, res) => {
    try {
      const { q } = req.query;
      if (!q || q.length < 2) return res.json({ results: [] });
      if (q.length > SEARCH_QUERY_MAX_LEN)
        return res.status(400).json({ error: `query too long (max ${SEARCH_QUERY_MAX_LEN})` });
      // #230: sidebar search filters by name only — UI renders r.name, so
      // transcript-content matches surface sessions whose names don't contain
      // the query and break user expectations.
      const rows = db.searchSessionsByName(q);
      const results = rows.map((s) => ({
        session_id: s.id,
        sessionId: s.id,
        project: s.project_name,
        name: s.name,
        match_count: 1,
        matchCount: 1,
        snippets: [s.name],
        matches: [{ type: 'name', text: s.name }],
        cli_type: s.cli_type || 'claude',
      }));
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/sessions ────────────────────────────────────────────────────

  app.post('/api/sessions', async (req, res) => {
    try {
      const { project, name, cli_type, hidden, role } = req.body;
      const cliType = cli_type || 'claude';
      const VALID_CLI_TYPES = ['claude', 'gemini', 'codex'];
      if (!VALID_CLI_TYPES.includes(cliType))
        return res.status(400).json({ error: `invalid cli_type: ${cliType}. Must be one of: ${VALID_CLI_TYPES.join(', ')}` });
      if (!project) return res.status(400).json({ error: 'project required' });
      if (project.length > PROJECT_NAME_MAX_LEN)
        return res
          .status(400)
          .json({ error: `project name too long (max ${PROJECT_NAME_MAX_LEN})` });
      if (!name || !String(name).trim())
        return res.status(400).json({ error: 'name required' });
      if (name.length > PROMPT_MAX_LEN)
        return res.status(400).json({ error: `name too long (max ${PROMPT_MAX_LEN})` });

      const dbProject = db.getProject(project);
      const projectPath = dbProject ? dbProject.path : safe.resolveProjectPath(project);
      try {
        await stat(projectPath);
      } catch (statErr) {
        if (statErr.code === 'ENOENT')
          return res.status(410).json({ error: 'Project directory not found' });
        throw statErr;
      }

      const sessDir = safe.findSessionsDir(projectPath);
      let existingFiles = new Set();
      try {
        const files = await readdir(sessDir);
        existingFiles = new Set(files.filter((f) => f.endsWith('.jsonl')));
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.warn('Error reading sessions dir for existing files', {
            module: 'routes',
            err: err.message,
          });
        }
      }

      // Claude sessions get a temp ID that resolves to a real UUID when the JSONL appears.
      // Non-Claude CLIs don't create JSONLs, so give them a permanent UUID up front.
      // #334 [A9]: append a 6-hex-char random suffix so two POSTs landing in
      // the same millisecond can't collide on tmpId. Parity with mcp-tools.js:213.
      const tmpId = cliType === 'claude'
        ? `new_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
        : crypto.randomUUID();
      const tmux = tmuxName(tmpId);

      await ensureSettings();
      await enforceTmuxLimit();

      // Launch the appropriate CLI
      const cliArgs = [];
      if (cliType === 'claude') {
        const model = db.getSetting('default_model', '"sonnet"');
        try {
          const m = JSON.parse(model);
          if (m) cliArgs.push('--model', m);
        } catch (parseErr) {
          if (parseErr instanceof SyntaxError) {
            logger.debug('Invalid default_model JSON in settings', { module: 'routes' });
          } else {
            throw parseErr;
          }
        }
      }

      const proj = db.ensureProject(project, projectPath);

      // Insert the session row up front so role seeding's setCliSessionId
      // UPDATEs (Codex rollout id, Gemini chat id) hit an existing row.
      // name is validated as required at the top of the handler — sanitize for storage.
      const nameMaxLen = config.get('session.nameMaxLength', 60);
      const sessionName = name.substring(0, nameMaxLen).replace(/\s+/g, ' ').trim();
      db.upsertSession(tmpId, proj.id, sessionName, cliType);
      if (hidden) db.setSessionState(tmpId, 'hidden');

      // Role seeding — two-phase launch when a role is selected
      if (role) {
        const rolePath = join(KB_PATH, 'roles', `${role}.md`);
        try {
          await stat(rolePath);
          await _seedRole(cliType, rolePath, projectPath, cliArgs, existingFiles, sessDir, tmpId, proj, db, tmux, logger);
        } catch (roleErr) {
          logger.warn('Role seeding failed — launching without role', { module: 'routes', role, err: roleErr.message });
          await safe.tmuxCreateCLIAsync(tmux, projectPath, cliType, cliArgs, { workbenchSessionId: tmpId });
        }
      } else {
        await safe.tmuxCreateCLIAsync(tmux, projectPath, cliType, cliArgs, { workbenchSessionId: tmpId });
      }

      // #372 [E2] (Claude R2 F1): invalidate the per-CLI discovery cache for
      // the spawned CLI so the next /api/state poll's discovery picks up the
      // freshly-created Gemini chat / Codex rollout file rather than waiting
      // for the 10s TTL to expire. No-op for Claude (Claude file naming is
      // session-id direct; doesn't go through the discovery cache).
      if (cliType === 'gemini' || cliType === 'codex') {
        sessionUtils.invalidateDiscoveryCache(cliType);
      }

      if (cliType === 'claude') {
        // Send a stand-by hint instead of treating the form value as a prompt.
        // Old behavior — pasting the user's free-form prompt verbatim — caused
        // Claude to start taking action on form submit (sometimes destructively).
        // Now the field is just a session title; we hand Claude a brief notice
        // that orients it without inviting action. The byproduct is the same:
        // Claude responds with a JSONL entry, which is what session-id
        // resolution is waiting on. Name is required, so this hint always fires
        // for Claude — closes the orphan-row window in #257.
        // Gemini/Codex still skipped — startup dialogs (trust, auth) would
        // consume any input. They get permanent UUIDs at creation anyway.
        const promptDelayMs = config.get('session.promptInjectionDelayMs', 2000);
        const hint = `The user has titled this session "${sessionName}". Stand by for their first message.`;
        setTimeout(async () => {
          try {
            if (!(await tmuxExists(tmux))) {
              logger.warn('Session died before standby hint could be sent', { module: 'routes', tmux, tmpId: tmpId.substring(0, 15) });
              return;
            }
            await safe.tmuxSendKeysAsync(tmux, hint);
          } catch (err) {
            logger.error('Failed to send standby hint', { module: 'routes', err: err.message });
          }
        }, promptDelayMs);
      }

      resolveSessionId(tmpId, { tmux, sessionsDir: sessDir, existingFiles, projectId: proj.id, cliType });
      fireEvent('session_created', { session_id: tmpId, project });
      res.json({ id: tmpId, tmux, project, name: sessionName });
    } catch (err) {
      logger.error('Error creating session', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/terminals ───────────────────────────────────────────────────

  app.post('/api/terminals', async (req, res) => {
    try {
      const { project } = req.body;
      if (!project) return res.status(400).json({ error: 'project required' });
      if (project.length > PROJECT_NAME_MAX_LEN)
        return res
          .status(400)
          .json({ error: `project name too long (max ${PROJECT_NAME_MAX_LEN})` });
      const dbProject = db.getProject(project);
      const projectPath = dbProject ? dbProject.path : safe.resolveProjectPath(project);
      try {
        await stat(projectPath);
      } catch (statErr) {
        if (statErr.code === 'ENOENT')
          return res.status(410).json({ error: 'Project directory not found' });
        throw statErr;
      }
      const termId = `t_${Date.now()}`;
      const tmux = tmuxName(termId);
      await enforceTmuxLimit();
      await safe.tmuxCreateCLIAsync(tmux, projectPath, 'bash', [], { workbenchSessionId: termId });
      res.json({ id: termId, tmux, project, name: 'Terminal' });
    } catch (err) {
      logger.error('Error creating terminal', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/sessions/:sessionId/resume ──────────────────────────────────

  app.post('/api/sessions/:sessionId/resume', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const { project } = req.body;
      if (!project) return res.status(400).json({ error: 'project required' });
      const dbProject = db.getProject(project);
      const projectPath = dbProject ? dbProject.path : safe.resolveProjectPath(project);
      try {
        await stat(projectPath);
      } catch (statErr) {
        if (statErr.code === 'ENOENT')
          return res.status(410).json({ error: 'Project directory not found' });
        throw statErr;
      }
      const tmux = tmuxName(sessionId);
      if (!(await safe.tmuxExists(tmux))) {
        await ensureSettings();
        const session = db.getSession(sessionId) || { id: sessionId, cli_type: 'claude' };
        const { args: resumeArgs, missing, expectedPath } = await safe.buildResumeArgs(session, projectPath);
        if (missing) {
          logger.warn('Refusing to resume session — JSONL missing', {
            module: 'routes', sessionId: sessionId.substring(0, 12), expectedPath,
          });
          return res.status(410).json({
            error: `Session file missing on disk (expected ${expectedPath}). Recover the file or recreate the session.`,
          });
        }
        await safe.tmuxCreateCLIAsync(tmux, projectPath, session.cli_type || 'claude', resumeArgs, { workbenchSessionId: session.id });
        // Wait for CLI to start — resume with JSONL loading takes longer than fresh start
        await sleep(3000);
        // Verify tmux actually started
        if (!(await tmuxExists(tmux))) {
          return res.status(503).json({ error: 'Session failed to start. The CLI may have exited.' });
        }
      }
      res.json({ id: sessionId, tmux, project });
    } catch (err) {
      logger.error('Error resuming session', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── PUT /api/sessions/:sessionId/name ─────────────────────────────────────

  app.put('/api/sessions/:sessionId/name', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const { name } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
      if (name.length > SESSION_NAME_MAX_LEN)
        return res.status(400).json({ error: `name too long (max ${SESSION_NAME_MAX_LEN})` });
      db.renameSession(sessionId, name.trim());
      sessionUtils.invalidateSessionInfoCache(sessionId);
      try {
        const session = db.getSessionFull(sessionId);
        if (session && session.project_name) {
          const projectPath = db.getProject(session.project_name)?.path;
          if (projectPath) {
            const sessDir = safe.findSessionsDir(projectPath);
            const jsonlFile = join(sessDir, `${sessionId}.jsonl`);
            const summaryEntry = JSON.stringify({
              type: 'summary',
              summary: name.trim(),
              timestamp: new Date().toISOString(),
            });
            try {
              await appendFile(jsonlFile, '\n' + summaryEntry);
            } catch (appendErr) {
              if (appendErr.code !== 'ENOENT') {
                logger.warn('Failed to append summary to JSONL', {
                  module: 'routes',
                  sessionId: sessionId.substring(0, 8),
                  err: appendErr.message,
                });
              }
              /* expected for ENOENT: session file may not exist */
            }
          }
        }
      } catch (outerErr) {
        logger.debug('Best-effort summary append failed', {
          module: 'routes',
          err: outerErr.message,
        });
      }
      res.json({ id: sessionId, name: name.trim() });
    } catch (err) {
      logger.error('Error renaming session', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── Session config ────────────────────────────────────────────────────────

  app.get('/api/sessions/:sessionId/config', (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const session = db.getSessionFull(sessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });
      res.json({
        id: session.id,
        name: session.name,
        state: session.state || (session.archived ? 'archived' : 'active'),
        notes: session.notes || '',
        project: session.project_name,
      });
    } catch (err) {
      logger.error('Error getting session config', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/sessions/:sessionId/config', (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const { name, state, notes } = req.body;
      if (name !== undefined) {
        if (name.length > SESSION_NAME_MAX_LEN)
          return res.status(400).json({ error: `name too long (max ${SESSION_NAME_MAX_LEN})` });
        db.renameSession(sessionId, name);
      }
      if (state !== undefined) {
        if (!VALID_STATES.includes(state))
          return res
            .status(400)
            .json({ error: `state must be one of: ${VALID_STATES.join(', ')}` });
        db.setSessionState(sessionId, state);
      }
      if (notes !== undefined) {
        if (notes.length > NOTES_MAX_LEN)
          return res.status(400).json({ error: `notes too long (max ${NOTES_MAX_LEN})` });
        db.setSessionNotes(sessionId, notes);
      }
      sessionUtils.invalidateSessionInfoCache(sessionId);
      res.json({ saved: true });
    } catch (err) {
      logger.error('Error updating session config', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── PUT /api/sessions/:sessionId/archive (legacy) ─────────────────────────

  app.put('/api/sessions/:sessionId/archive', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const { archived } = req.body;
      db.setSessionState(sessionId, archived ? 'archived' : 'active');
      sessionUtils.invalidateSessionInfoCache(sessionId);
      res.json({ id: sessionId, archived: !!archived });
    } catch (err) {
      logger.error('Error archiving session', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── Session summary ───────────────────────────────────────────────────────

  app.post('/api/sessions/:sessionId/summary', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const { project } = req.body;
      if (!project) return res.status(400).json({ error: 'project required' });
      const result = await sessionUtils.summarizeSession(sessionId, project);
      res.json({ summary: result.summary, recentMessages: result.recentMessages });
    } catch (err) {
      logger.error('Error generating summary', { module: 'routes', err: err.message });
      res.status(500).json({ error: safe.sanitizeErrorForClient(err.message) });
    }
  });

  // ── #371 [E1] Per-session info (heavy payload — JSONL parse) ──────────────

  app.get('/api/sessions/:sessionId/info', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const info = await sessionUtils.getSessionInfo(sessionId, { includeTokens: true });
      if (!info) return res.status(404).json({ error: 'session not found' });
      res.json({
        id: info.id,
        name: info.name,
        timestamp: info.timestamp,
        message_count: info.message_count,
        model: info.model || '',
        tmux: info.tmux,
        active: info.active,
        state: info.state,
        cli_type: info.cli_type,
        archived: info.archived,
        input_tokens: info.input_tokens,
        max_tokens: info.max_tokens,
      });
    } catch (err) {
      logger.error('Error getting session info', { module: 'routes', err: err.message });
      res.status(500).json({ error: safe.sanitizeErrorForClient(err.message) });
    }
  });

  // ── Token usage ───────────────────────────────────────────────────────────

  app.get('/api/sessions/:sessionId/tokens', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      // #156: route through getSessionInfo so the cache dedupes against parallel
      // sidebar polls. Project param is no longer needed (session_full has the path).
      const info = await sessionUtils.getSessionInfo(sessionId);
      if (!info) return res.json({ input_tokens: 0, model: null, max_tokens: null });
      res.json({ input_tokens: info.input_tokens, model: info.model, max_tokens: info.max_tokens });
    } catch (err) {
      logger.error('Error getting token usage', { module: 'routes', err: err.message });
      res.json({ input_tokens: 0, model: null, max_tokens: null });
    }
  });

  // ── Session management ───────────────────────────────────────────────────

  app.post('/api/sessions/:sessionId/session', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { mode = 'info', tailLines = 60 } = req.body;
      // #326 [A1]: Resolve the project's actual path (not name) so the
      // canonical findSessionsDir encoder sees the real on-disk path. The
      // sessions row only carries project_id; look the project up to get
      // its path. Falls back to req.body.project (treated as a name) only
      // when the session row is absent — matches the legacy client contract.
      const entry = db.getSession(sessionId);
      let projectPath = '';
      if (entry && entry.project_id) {
        const proj = db.getProjectById(entry.project_id);
        if (proj && proj.path) projectPath = proj.path;
      } else if (req.body.project) {
        const proj = db.getProject(req.body.project);
        projectPath = proj && proj.path ? proj.path : safe.resolveProjectPath(req.body.project);
      }
      const sessionFile = join(safe.findSessionsDir(projectPath), `${sessionId}.jsonl`);

      if (mode === 'info') {
        let exists = false;
        try { await stat(sessionFile); exists = true; } catch {}
        return res.json({ sessionId, sessionFile, exists });
      }
      if (mode === 'resume') {
        let tail = '';
        try {
          const content = await readFile(sessionFile, 'utf-8');
          const lines = content.trim().split('\n').filter(Boolean);
          tail = lines.slice(-tailLines).join('\n');
        } catch (err) {
          tail = '(could not read session file: ' + err.message + ')';
        }
        const tailPath = join('/tmp', `workbench-resume-${sessionId}-${Date.now()}.txt`);
        await writeFile(tailPath, tail, 'utf-8');
        return res.json({
          prompt: config.getPrompt('session-resume-claude', { TAIL_PATH: tailPath }),
        });
      }
      if (mode === 'transition') {
        return res.json({ prompt: config.getPrompt('session-transition-claude', {}) });
      }
      return res.status(400).json({ error: 'Unknown mode. Use info, transition, or resume.' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/sessions/:sessionId/restart', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const tmux = tmuxName(sessionId);
      if (await tmuxExists(tmux)) {
        await safe.tmuxKill(tmux);
      }
      const session = db.getSessionFull(sessionId) || db.getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });
      const cwd = session.project_path || WORKSPACE;
      const cliType = session.cli_type || 'claude';
      const { args: restartArgs } = await safe.buildResumeArgs(session, cwd);
      await safe.tmuxCreateCLIAsync(tmux, cwd, cliType, restartArgs || [], { workbenchSessionId: sessionId });
      res.json({ ok: true, sessionId, tmux });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Tmux input primitives ────────────────────────────────────────────────

  const SEND_TEXT_MAX_LEN = 8192;
  const ALLOWED_NAMED_KEYS = new Set([
    'Enter', 'Escape', 'Tab', 'Space', 'BSpace',
    'Up', 'Down', 'Left', 'Right',
    'Home', 'End', 'PageUp', 'PageDown',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  ]);
  function isValidKey(key) {
    if (typeof key !== 'string' || key.length === 0) return false;
    if (ALLOWED_NAMED_KEYS.has(key)) return true;
    // Single printable ASCII char (e.g. "1", "y", "n" for menu selection)
    return key.length === 1 && key.charCodeAt(0) >= 0x20 && key.charCodeAt(0) <= 0x7e;
  }

  app.post('/api/sessions/:sessionId/send_text', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const { text } = req.body;
      if (typeof text !== 'string' || text.length === 0)
        return res.status(400).json({ error: 'text required (non-empty string)' });
      if (text.length > SEND_TEXT_MAX_LEN)
        return res.status(400).json({ error: `text too long (max ${SEND_TEXT_MAX_LEN})` });
      const tmux = tmuxName(sessionId);
      if (!(await tmuxExists(tmux)))
        return res.status(410).json({ error: 'tmux session not running' });
      await safe.tmuxSendTextAsync(tmux, text);
      res.json({ ok: true });
    } catch (err) {
      logger.warn('send_text failed', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/sessions/:sessionId/send_key', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const { key } = req.body;
      if (!isValidKey(key))
        return res.status(400).json({ error: 'invalid key (must be a named key like Enter, or a single printable ASCII char)' });
      const tmux = tmuxName(sessionId);
      if (!(await tmuxExists(tmux)))
        return res.status(410).json({ error: 'tmux session not running' });
      await safe.tmuxSendKeyAsync(tmux, key);
      res.json({ ok: true });
    } catch (err) {
      logger.warn('send_key failed', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return { checkAuthStatus, trustDir };
}

module.exports = { register };
