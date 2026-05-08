'use strict';

const {
  readdir,
  readFile,
  writeFile,
  stat,
  unlink,
  mkdir,
  appendFile,
  access,
} = require('fs/promises');
const { join, basename, resolve: pathResolve } = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const crypto = require('crypto');

const express = require('express');
const { registerMcpRoutes } = require('./mcp-tools');
const { registerWebhookRoutes } = require('./webhooks');
// File-tree directory listing endpoint. Returns folder-first sorted JSON
// for the vanilla-JS tree component in public/index.html.

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PROJECT_NAME_MAX_LEN = 255;
const SESSION_NAME_MAX_LEN = 255;
const PROMPT_MAX_LEN = 50000;
const MESSAGE_CONTENT_MAX_LEN = 100000;
const SEARCH_QUERY_MAX_LEN = 200;
const TASK_TITLE_MAX_LEN = 500;
const TASK_DESC_MAX_LEN = 10000;
const TASK_FOLDER_MAX_LEN = 1000;
const NOTES_MAX_LEN = 100000;
const VALID_STATES = ['active', 'archived', 'hidden'];

function validateSessionId(sessionId) {
  if (!sessionId) return false;
  if (sessionId.startsWith('new_') || sessionId.startsWith('t_')) return true;
  return SESSION_ID_PATTERN.test(sessionId);
}

// #181: parse a relative ('1h' / '24h' / '7d' / '15m') or absolute ISO8601 'since'
// query param into an ISO timestamp. Returns ISO string suitable for SQLite TEXT
// timestamp comparison.
function _parseSince(input) {
  if (!input) return new Date(Date.now() - 3600 * 1000).toISOString();
  const m = /^(\d+)([smhd])$/.exec(String(input).trim());
  if (m) {
    const n = parseInt(m[1], 10);
    const mult = { s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 86400 * 1000 }[m[2]];
    return new Date(Date.now() - n * mult).toISOString();
  }
  // Try as ISO timestamp
  const d = new Date(input);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  // Fallback to 1h
  return new Date(Date.now() - 3600 * 1000).toISOString();
}

// Phase 1 + Phase 2 role seeding. Runs CLI non-interactively in plan/exec mode
// to seed the role into the session, then launches interactive via tmux.
//
// The role file content is INLINED into the prompt rather than asking the CLI
// to read it from disk. Gemini's workspace sandbox refuses reads outside the
// project's cwd (the role lives in /data/knowledge-base/roles/, well outside
// /data/workspace/<project>), and Codex has the same scoping. Inlining works
// for all three CLIs uniformly.
async function _seedRole(cliType, rolePath, projectPath, cliArgs, existingFiles, sessDir, tmpId, proj, db, tmux, logger) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);
  const { readdir: readdirFs, readFile: readFileFs } = require('fs/promises');
  const { basename: basenameFs } = require('path');

  // Read the role content up-front; bail to caller's catch if missing.
  const roleContent = await readFileFs(rolePath, 'utf-8');
  const rolePrompt =
    `You are being assigned a role for this session. The role definition is below — adopt it as your role and copy the content verbatim into your plan so it persists across the session.\n\n` +
    `=== ROLE: ${basenameFs(rolePath, '.md')} ===\n` +
    `${roleContent}\n` +
    `=== END ROLE ===`;

  // child_process.execFile silently ignores the `stdio` option (only spawn
  // honors it), so a previous attempt to set stdio:['ignore','pipe','pipe']
  // was a no-op and Codex would block forever on "Reading additional input
  // from stdin...". Send EOF on the child's stdin pipe immediately after
  // start so the child sees stdin close and proceeds.
  const seedExec = (cmd, args, cwd) => {
    const p = execFileAsync(cmd, args, { cwd });
    if (p.child && p.child.stdin) p.child.stdin.end();
    return p;
  };

  if (cliType === 'claude') {
    // Phase 1: non-interactive plan mode — seeds role into plan file
    await seedExec('claude', [
      '-p', '--permission-mode', 'plan',
      rolePrompt,
    ], projectPath);
    // Find the new JSONL created by Phase 1
    const afterFiles = await readdirFs(sessDir).catch(() => []);
    const newJSONL = afterFiles.find(f => f.endsWith('.jsonl') && !existingFiles.has(f));
    const phase1Id = newJSONL ? basenameFs(newJSONL, '.jsonl') : null;
    // Phase 2: resume interactively with bypass
    const resumeArgs = phase1Id
      ? ['--resume', phase1Id, '--dangerously-skip-permissions', ...cliArgs]
      : ['--dangerously-skip-permissions', ...cliArgs];
    require('./safe-exec').tmuxCreateCLI(tmux, projectPath, 'claude', resumeArgs);
    if (phase1Id) {
      // Register the real session ID so the resolver maps it correctly
      db.upsertSession(phase1Id, proj.id, null, 'claude');
    }

  } else if (cliType === 'gemini') {
    // Snapshot existing chat files BEFORE Phase 1 so we can identify the
    // new one (Phase 1 creates exactly one chat file). Sort-by-timestamp
    // picked stale files when many old chats existed in unrelated projects.
    const { discoverGeminiSessions } = require('./session-utils');
    const beforeGemini = new Set(discoverGeminiSessions().map(s => s.filePath));
    // Phase 1: non-interactive plan mode
    await seedExec('gemini', [
      '--approval-mode', 'plan',
      '-p', rolePrompt,
    ], projectPath);
    // Phase 2: resume latest interactively (no yolo)
    require('./safe-exec').tmuxCreateCLI(tmux, projectPath, 'gemini', ['--resume', 'latest']);
    // Find the new chat file produced by Phase 1 — diff against snapshot.
    try {
      const after = discoverGeminiSessions();
      const created = after.find(s => !beforeGemini.has(s.filePath));
      if (created?.sessionId) db.setCliSessionId(tmpId, created.sessionId);
    } catch (e) { logger.warn('Gemini cli_session_id capture failed', { module: 'routes', err: e.message }); }

  } else if (cliType === 'codex') {
    // Snapshot existing rollouts BEFORE Phase 1 — same reasoning as Gemini.
    const { discoverCodexSessions } = require('./session-utils');
    const beforeCodex = new Set((discoverCodexSessions ? discoverCodexSessions() : []).map(s => s.filePath));
    // Single non-interactive step — role seeded as initial context.
    // --skip-git-repo-check: Codex refuses to run outside a git repo by
    // default, but workbench projects aren't required to be git repos.
    await seedExec('codex', [
      'exec', '--skip-git-repo-check', rolePrompt,
    ], projectPath);
    // Find the rollout file produced by Phase 1 — diff against snapshot.
    const after = discoverCodexSessions ? discoverCodexSessions() : [];
    const created = after.find(s => !beforeCodex.has(s.filePath));
    const rolloutId = created?.filePath
      ? (() => { const m = basenameFs(created.filePath, '.jsonl').match(/([0-9a-f-]{36})$/i); return m ? m[1] : null; })()
      : null;
    const resumeArgs = rolloutId ? ['resume', rolloutId] : [];
    require('./safe-exec').tmuxCreateCLI(tmux, projectPath, 'codex', resumeArgs);
    if (rolloutId) db.setCliSessionId(tmpId, rolloutId);
  }
}

function registerCoreRoutes(
  app,
  {
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
    registerGeminiMcp,
    registerCodexProvider,
    registerCodexAuth,
    trustGeminiProjectDirs,
    trustCodexProjectDirs,
    kbWatcher,
    sleep,
  },
) {
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

  // Caches to avoid re-reading session files on every /api/state call
  let _geminiSessionsCache = null;
  let _geminiCacheTime = 0;
  let _codexSessionsCache = null;
  let _codexCacheTime = 0;
  const NONCLAUD_CACHE_TTL = 10000; // 10s

  function _getGeminiSessions() {
    const now = Date.now();
    if (_geminiSessionsCache && (now - _geminiCacheTime) < NONCLAUD_CACHE_TTL) return _geminiSessionsCache;
    _geminiSessionsCache = sessionUtils.discoverGeminiSessions();
    _geminiCacheTime = now;
    return _geminiSessionsCache;
  }

  function _getCodexSessions() {
    const now = Date.now();
    if (_codexSessionsCache && (now - _codexCacheTime) < NONCLAUD_CACHE_TTL) return _codexSessionsCache;
    _codexSessionsCache = sessionUtils.discoverCodexSessions();
    _codexCacheTime = now;
    return _codexSessionsCache;
  }

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
      const sorted = _getGeminiSessions().sort((a, b) => {
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
      const sorted = _getCodexSessions().sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return ta - tb;
      });
      return _matchFromList(sorted, _claimedCodex, session,
        (d) => {
          // Codex files: /sessions/YYYY/MM/DD/rollout-{timestamp}-{uuid}.jsonl
          // Extract the UUID from the filename for resume
          const name = basename(d.filePath, '.jsonl');
          const uuidMatch = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
          return uuidMatch ? uuidMatch[1] : name;
        },
        (sess, match) => {
          const name = basename(match.filePath, '.jsonl');
          const uuidMatch = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
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
    // pointer before getSessionInfo() fetches per-session metadata. Claude sessions
    // don't need this (file naming = session id directly).
    for (const s of dbSessions) {
      const cliType = s.cli_type || 'claude';
      if (cliType !== 'claude' && !s.cli_session_id) {
        _getNonClaudeMetadata(s);
      }
    }

    const sessions = [];
    for (const s of dbSessions) {
      // includeTokens=false: sidebar list doesn't show per-session token counts;
      // only the active-session status bar polls /tokens which uses includeTokens=true.
      // Avoids N JSONL re-reads per /api/state poll.
      const info = await sessionUtils.getSessionInfo(s.id, { includeTokens: false });
      if (!info) continue;
      sessions.push({
        id: info.id,
        name: info.name,
        timestamp: info.timestamp,
        messageCount: info.message_count,
        model: info.model || '',
        tmux: info.tmux,
        active: info.active,
        state: info.state,
        cli_type: info.cli_type,
        archived: info.archived,
      });
    }
    sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return sessions;
  }

  // ── GET /api/mounts ────────────────────────────────────────────────────────

  app.get('/api/mounts', async (req, res) => {
    const mounts = [];
    // Always include the workspace
    const workspace = safe.WORKSPACE;
    mounts.push({ path: workspace });
    // Knowledge Base at /data/knowledge-base (auto-cloned on startup if absent)
    const KB_PATH = '/data/knowledge-base';
    try {
      await stat(KB_PATH);
      mounts.push({ path: KB_PATH, label: 'Knowledge Base' });
    } catch (_err) {
      /* not yet cloned — omit until available */
    }
    // Add any directories under /mnt
    try {
      const entries = await readdir('/mnt', { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) mounts.push({ path: '/mnt/' + e.name });
      }
    } catch (_err) {
      /* /mnt may not exist */
    }
    res.json(mounts);
  });

  // ── POST /api/kb/init ─────────────────────────────────────────────────────

  app.post('/api/kb/init', async (req, res) => {
    const KB_PATH = '/data/knowledge-base';
    // Check if already initialized
    try {
      await stat(join(KB_PATH, '.git'));
      return res.json({ ok: true, alreadyInitialized: true });
    } catch (_err) { /* not yet cloned */ }
    // Check if path exists but is not a git repo
    try {
      await stat(KB_PATH);
      return res.status(409).json({ error: 'Path exists but is not a git repository' });
    } catch (_err) { /* path does not exist, safe to clone */ }
    const kbRepoUrl = db.getSetting('kb_repo_url', '"https://github.com/rmdevpro/workbench-kb"');
    try {
      await execFileAsync('git', ['clone', kbRepoUrl, KB_PATH]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: `Clone failed: ${err.message}` });
    }
  });

  // ── KB helpers ───────────────────────────────────────────────────────────────

  const KB_PATH = '/data/knowledge-base';
  const KB_UPSTREAM = 'https://github.com/rmdevpro/workbench-kb';

  // #317: KB account is just a row in git_accounts with isKB=true. Lookup by
  // path prefix (e.g., 'github.com/jmdrumsgarrison-ux'). The token stays in
  // DB; URLs do NOT carry it. Auth happens per-call via http.extraheader.
  const gitAuth = require('./git-auth');
  function getKbAccount() { return gitAuth.kbAccount(db); }
  // Plain origin URL — token NOT embedded. Auth flows through extraheader at
  // git invocation time.
  function kbOriginUrl(account, repoName) {
    // path is e.g. 'github.com/jmdrumsgarrison-ux' → host = 'github.com', user = 'jmdrumsgarrison-ux'
    const i = (account.path || '').indexOf('/');
    if (i < 0) return null;
    const host = account.path.slice(0, i);
    const user = account.path.slice(i + 1);
    return `https://${host}/${user}/${repoName}`;
  }
  // Older callers passed account with .host / .username; also expose a legacy
  // shim for the fork API (which still needs host).
  function kbAccountHost(account) {
    const i = (account.path || '').indexOf('/');
    return i < 0 ? null : account.path.slice(0, i);
  }
  function kbAccountUsername(account) {
    const i = (account.path || '').indexOf('/');
    return i < 0 ? null : account.path.slice(i + 1);
  }

  // ── GET /api/kb/status ────────────────────────────────────────────────────
  // Source of truth is the kb-watcher's in-memory snapshot, refreshed
  // on demand. Includes ahead/behind vs origin AND vs upstream so the
  // UI can show both directions of sync state.

  app.get('/api/kb/status', async (req, res) => {
    if (!kbWatcher) return res.json({ initialized: false });
    try {
      const status = await kbWatcher.refreshStatus();
      res.json(status);
    } catch (err) {
      res.json({ initialized: true, error: err.message });
    }
  });

  // ── POST /api/kb/push ─────────────────────────────────────────────────────
  // Manual flush: commit any pending changes and push to origin (the user's
  // fork). Useful when the user wants immediate sync rather than waiting for
  // the debounce timer.
  app.post('/api/kb/push', async (req, res) => {
    if (!kbWatcher) return res.status(503).json({ error: 'KB watcher not initialized' });
    try {
      const status = await kbWatcher.pushNow();
      res.json({ ok: true, status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/kb/fork ─────────────────────────────────────────────────────

  app.post('/api/kb/fork', async (req, res) => {
    const account = getKbAccount();
    if (!account) return res.status(400).json({ error: 'No KB git account configured' });
    let repoName;
    try { repoName = JSON.parse(db.getSetting('kb_repo_name', '"blueprint_workbench_kb"')); } catch (_e) { repoName = 'blueprint_workbench_kb'; }

    // Fork via GitHub API
    const host = kbAccountHost(account);
    const username = kbAccountUsername(account);
    if (!host || !username) return res.status(500).json({ error: `KB account has invalid path: ${account.path}` });
    try {
      const forkRes = await fetch(`https://api.${host}/repos/rmdevpro/workbench-kb/forks`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${account.token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: repoName, default_branch_only: true }),
      });
      if (!forkRes.ok) {
        const body = await forkRes.json().catch(() => ({}));
        return res.status(502).json({ error: body.message || `GitHub API error ${forkRes.status}` });
      }
    } catch (err) {
      return res.status(502).json({ error: `GitHub API request failed: ${err.message}` });
    }

    // Point local clone at fork and add upstream remote.
    // #317: origin URL is plain (no embedded creds) — auth flows through
    // http.extraheader at clone/push/fetch time.
    const originUrl = kbOriginUrl(account, repoName);
    const publicUrl = originUrl;
    const authArgs = gitAuth.gitAuthArgs(account.token);
    try {
      await stat(join(KB_PATH, '.git'));
      // Repo exists — update remotes
      await execFileAsync('git', ['-C', KB_PATH, 'remote', 'set-url', 'origin', originUrl]);
      try {
        await execFileAsync('git', ['-C', KB_PATH, 'remote', 'add', 'upstream', KB_UPSTREAM]);
      } catch (_e) {
        await execFileAsync('git', ['-C', KB_PATH, 'remote', 'set-url', 'upstream', KB_UPSTREAM]);
      }
    } catch (_err) {
      // Not yet cloned — clone the fork. extraheader injects auth for this call only.
      await execFileAsync('git', [...authArgs, 'clone', originUrl, KB_PATH]);
      await execFileAsync('git', ['-C', KB_PATH, 'remote', 'add', 'upstream', KB_UPSTREAM]);
    }

    db.setSetting('kb_repo_url', JSON.stringify(publicUrl));
    // After a fork, the watcher needs to pick up the new origin URL on its
    // next operation. A status refresh re-reads remotes; a stop+start would
    // also work. The kb-watcher reads remotes on every operation, so a
    // refresh here is sufficient.
    if (kbWatcher) {
      try { await kbWatcher.refreshStatus(); } catch { /* best-effort */ }
    }
    res.json({ ok: true, forkUrl: publicUrl });
  });

  // ── POST /api/kb/sync-upstream ────────────────────────────────────────────
  // Pulls upstream changes (fast-forward only) into the user's fork.
  // Implementation lives in kb-watcher; this endpoint is a manual trigger
  // that complements the periodic poll.

  app.post('/api/kb/sync-upstream', async (req, res) => {
    if (!kbWatcher) return res.status(503).json({ error: 'KB watcher not initialized' });
    try {
      const status = await kbWatcher.syncUpstreamNow();
      if (status.lastError) {
        return res.status(409).json({ error: status.lastError, status });
      }
      res.json({ ok: true, status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/issues ───────────────────────────────────────────────────────
  // #314: list GitHub issues for a repo, scoped via the path-keyed account
  // token (#317). Used by the task editor's issue picker. Caches per-repo
  // for 60s to keep typing-storm-friendly without rate-limit pressure.
  const _issuesCache = new Map(); // key: repo+state → { fetchedAt, items }
  const _ISSUES_TTL_MS = 60 * 1000;
  app.get('/api/issues', async (req, res) => {
    const repo = String(req.query.repo || '');  // 'owner/name'
    const state = String(req.query.state || 'open').toLowerCase();
    const q = String(req.query.q || '').toLowerCase();
    const m = /^([^/]+)\/([^/]+)$/.exec(repo);
    if (!m) return res.status(400).json({ error: 'repo must be owner/name' });
    const [, owner, name] = m;
    const path = `github.com/${owner}`;
    const account = gitAuth.accountForPath(db, path);
    if (!account) return res.status(404).json({ error: `no_account_for_path: ${path}` });

    const cacheKey = `${repo}\x00${state}`;
    const cached = _issuesCache.get(cacheKey);
    let items;
    if (cached && Date.now() - cached.fetchedAt < _ISSUES_TTL_MS) {
      items = cached.items;
    } else {
      const stateFilter = state === 'all' ? '[OPEN, CLOSED]' : state === 'closed' ? '[CLOSED]' : '[OPEN]';
      const query = `query { repository(owner: "${owner}", name: "${name}") {
        issues(states: ${stateFilter}, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes { number title state labels(first: 5) { nodes { name color } } updatedAt }
        }
      } }`;
      try {
        const ghRes = await fetch(`https://api.github.com/graphql`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${account.token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'workbench/issues-picker',
          },
          body: JSON.stringify({ query }),
        });
        if (ghRes.status === 401 || ghRes.status === 403) {
          return res.status(401).json({ error: 'auth_rejected', path, status: ghRes.status });
        }
        if (!ghRes.ok) {
          const body = await ghRes.text();
          return res.status(502).json({ error: `GitHub API ${ghRes.status}: ${body.slice(0, 200)}` });
        }
        const json = await ghRes.json();
        items = (json.data?.repository?.issues?.nodes || []).map(i => ({
          number: i.number,
          title: i.title,
          state: i.state,
          labels: (i.labels?.nodes || []).map(l => ({ name: l.name, color: l.color })),
          updated_at: i.updatedAt,
        }));
        _issuesCache.set(cacheKey, { fetchedAt: Date.now(), items });
      } catch (err) {
        return res.status(502).json({ error: `GitHub API request failed: ${err.message}` });
      }
    }
    if (q) items = items.filter(i => i.title.toLowerCase().includes(q));
    res.json({ repo, owner, name, count: items.length, items });
  });

  // ── GET /api/git-accounts ─────────────────────────────────────────────────
  // #317: account management endpoints. Token never returned in responses.
  app.get('/api/git-accounts', (req, res) => {
    res.json({ accounts: gitAuth.resolveAccounts(db).map(gitAuth.publicView) });
  });
  app.post('/api/git-accounts', (req, res) => {
    const { path, token, isKB, default: isDefault, name } = req.body || {};
    if (!path) return res.status(400).json({ error: 'path required' });
    if (!token) return res.status(400).json({ error: 'token required' });
    try {
      const a = gitAuth.addAccount(db, { path, token, isKB: !!isKB, isDefault: !!isDefault, name });
      res.json(gitAuth.publicView(a));
    } catch (e) {
      if (e.code === 'duplicate_path') return res.status(409).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });
  app.put('/api/git-accounts/:id', (req, res) => {
    try {
      const a = gitAuth.updateAccount(db, req.params.id, {
        token: req.body?.token,
        isKB: req.body?.isKB,
        isDefault: req.body?.default,
        name: req.body?.name,
        path: req.body?.path,
      });
      res.json(gitAuth.publicView(a));
    } catch (e) {
      if (e.code === 'not_found') return res.status(404).json({ error: e.message });
      if (e.code === 'duplicate_path') return res.status(409).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });
  app.delete('/api/git-accounts/:id', (req, res) => {
    try {
      gitAuth.removeAccount(db, req.params.id);
      res.json({ removed: true, id: req.params.id });
    } catch (e) {
      if (e.code === 'not_found') return res.status(404).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/browse ────────────────────────────────────────────────────────
  // AD-001: No path containment checks. Workbench provides full filesystem access.

  app.get('/api/browse', async (req, res) => {
    try {
      const targetPath = (req.query.path || '/').replace(/\/+/g, '/') || '/';
      const entries = await readdir(targetPath, { withFileTypes: true });
      const dirs = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          dirs.push({ name: entry.name, type: 'directory' });
        } else if (entry.isSymbolicLink()) {
          try {
            const realStat = await stat(join(targetPath, entry.name));
            if (realStat.isDirectory()) dirs.push({ name: entry.name, type: 'directory' });
          } catch (symErr) {
            if (symErr.code !== 'ENOENT')
              logger.debug('Symlink stat failed', { module: 'routes', err: symErr.message });
            /* expected: dangling symlink */
          }
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ path: targetPath, parent: join(targetPath, '..'), entries: dirs });
    } catch (err) {
      res.status(400).json({ error: `Cannot browse: ${err.message}` });
    }
  });

  // ── GET /api/file ──────────────────────────────────────────────────────────
  // AD-001: No path containment checks. Workbench provides full filesystem access.

  app.get('/api/file', async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) return res.status(400).send('path required');
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return res.status(400).send('not a file');
      if (fileStat.size > 1024 * 1024) return res.status(413).send('file too large (>1MB)');
      const content = await readFile(filePath, 'utf-8');
      res.type('text/plain').send(content);
    } catch (err) {
      res.status(400).send(`Cannot read file: ${err.message}`);
    }
  });

  app.put('/api/file', express.text({ limit: '2mb' }), async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) return res.status(400).json({ error: 'path required' });
      await writeFile(filePath, req.body);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/file-raw', async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) return res.status(400).send('path required');
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return res.status(400).send('not a file');
      // No size cap. res.sendFile() streams from disk — server memory isn't
      // at risk regardless of file size. Earlier 10 MB / 50 MB caps were
      // defensive cargo-cult that silently broke the file viewer for
      // legitimate large training/composite PNGs without preventing any
      // threat that other paths (terminal sessions in the same UI) don't
      // already permit.
      res.sendFile(filePath);
    } catch (err) {
      res.status(400).send(`Cannot read file: ${err.message}`);
    }
  });

  app.post('/api/file-new', async (req, res) => {
    try {
      const filePath = req.body.path;
      if (!filePath) return res.status(400).json({ error: 'path required' });
      const { access } = require('fs/promises');
      try { await access(filePath); return res.status(409).json({ error: 'file already exists' }); } catch {}
      await writeFile(filePath, '');
      res.json({ ok: true, path: filePath });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/rename', async (req, res) => {
    try {
      const { oldPath, newPath } = req.body;
      if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath required' });
      const { rename } = require('fs/promises');
      await rename(oldPath, newPath);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/file', async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) return res.status(400).json({ error: 'path required' });
      const { rm } = require('fs/promises');
      await rm(filePath, { recursive: true });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/move', async (req, res) => {
    try {
      const { source, destination } = req.body;
      if (!source || !destination) return res.status(400).json({ error: 'source and destination required' });
      const { rename } = require('fs/promises');
      const { basename, join } = require('path');
      const destPath = join(destination, basename(source));
      await rename(source, destPath);
      res.json({ ok: true, path: destPath });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── POST /api/files/list ───────────────────────────────────────────────────
  // Lists a directory's immediate children. Folder-first, case-insensitive
  // alpha within each group. Used by the FileTree component in
  // public/index.html. Returns JSON, no HTML, no encoding gotchas.

  app.post('/api/files/list', async (req, res) => {
    const dirPath = req.body.path;
    if (!dirPath) return res.status(400).json({ error: 'path required' });
    const fsp = require('fs/promises');
    try {
      const dirents = await fsp.readdir(dirPath, { withFileTypes: true });
      const cmp = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      const dirs = dirents.filter(e => e.isDirectory()).sort(cmp).map(e => ({ name: e.name, kind: 'directory' }));
      const files = dirents.filter(e => !e.isDirectory()).sort(cmp).map(e => ({ name: e.name, kind: 'file' }));
      res.json({ path: dirPath, entries: [...dirs, ...files] });
    } catch (err) {
      const status = err.code === 'ENOENT' ? 404 : err.code === 'EACCES' ? 403 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  // ── POST /api/projects ─────────────────────────────────────────────────────

  app.post('/api/projects', async (req, res) => {
    try {
      let { path: projectPath, name } = req.body;
      if (!projectPath) return res.status(400).json({ error: 'path required' });
      if (name && name.length > PROJECT_NAME_MAX_LEN)
        return res.status(400).json({ error: `name too long (max ${PROJECT_NAME_MAX_LEN})` });
      // #193: don't collapse slashes in URLs — that turns https:// into https:/
      // and the URL-validation downstream rejects with a misleading "Invalid git
      // URL" error. Only normalize slashes for filesystem paths.
      const isUrl = projectPath.startsWith('http://') || projectPath.startsWith('https://') || projectPath.startsWith('git@');
      projectPath = projectPath.replace(/\/$/, '');
      if (!isUrl) projectPath = projectPath.replace(/\/+/g, '/') || '/';

      if (projectPath.startsWith('http') || projectPath.startsWith('git@')) {
        const repoName = name || projectPath.split('/').pop().replace('.git', '');
        const targetPath = join(WORKSPACE, repoName);
        try {
          await stat(targetPath);
          return res.status(409).json({ error: 'Directory already exists' });
        } catch (statErr) {
          if (statErr.code !== 'ENOENT') throw statErr;
          /* expected: directory does not exist yet */
        }
        try {
          await safe.gitCloneAsync(projectPath, targetPath);
        } catch (gitErr) {
          logger.warn('Git clone failed', {
            module: 'routes',
            url: projectPath.substring(0, 100),
            err: gitErr.message?.substring(0, 1000),
          });
          return res
            .status(400)
            .json({ error: `Git clone failed: ${safe.sanitizeErrorForClient(gitErr.message)}` });
        }
        db.ensureProject(repoName, targetPath);
        await trustDir(targetPath);
        if (trustGeminiProjectDirs) await trustGeminiProjectDirs().catch(() => {});
        if (trustCodexProjectDirs) await trustCodexProjectDirs().catch(() => {});
        return res.json({ name: repoName, path: targetPath, cloned: true });
      }

      try {
        await stat(projectPath);
      } catch (statErr) {
        if (statErr.code === 'ENOENT')
          return res.status(404).json({ error: 'Path does not exist' });
        throw statErr;
      }
      const projectName = name || basename(projectPath);
      db.ensureProject(projectName, projectPath);
      await trustDir(projectPath);
      if (trustGeminiProjectDirs) await trustGeminiProjectDirs().catch(() => {});
      if (trustCodexProjectDirs) await trustCodexProjectDirs().catch(() => {});
      return res.json({ name: projectName, path: projectPath, added: true });
    } catch (err) {
      logger.error('Error adding project', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // #336 [A11]: project removal cascades through every artifact the project
  // touched — tmux processes, Claude session JSONLs on disk, and the per-CLI
  // trust/projects entries in ~/.claude.json, ~/.gemini/trustedFolders.json,
  // and ~/.codex/config.toml. Each cleanup is best-effort: a failure on any
  // single step is logged and skipped so DB state stays consistent (the row
  // still gets removed). Cascade rows in mcp_project_enabled drop via the
  // FK ON DELETE CASCADE on db.deleteProject.
  async function cascadeCleanupProject(project) {
    const HOME = safe.HOME;
    // 1. Kill any running tmux sessions for this project.
    try {
      const sessions = db.getSessionsForProject(project.id) || [];
      for (const s of sessions) {
        try {
          await safe.tmuxKill(tmuxName(s.id));
        } catch (err) {
          logger.warn('tmuxKill failed during project cascade', {
            module: 'routes', op: 'cascadeCleanupProject',
            project: project.name, session: s.id, err: err.message,
          });
        }
      }
    } catch (err) {
      logger.warn('Failed to enumerate sessions for cascade', {
        module: 'routes', op: 'cascadeCleanupProject', err: err.message,
      });
    }
    // 2. Delete Claude JSONL session dir.
    try {
      const sessDir = safe.findSessionsDir(project.path);
      const { rm } = require('fs/promises');
      await rm(sessDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn('Failed to delete Claude sessions dir', {
        module: 'routes', op: 'cascadeCleanupProject', err: err.message,
      });
    }
    // 3. Remove project from ~/.claude.json projects[].
    try {
      const configFile = join(CLAUDE_HOME, '.claude.json');
      const cfg = JSON.parse(await readFile(configFile, 'utf-8'));
      if (cfg.projects && cfg.projects[project.path]) {
        delete cfg.projects[project.path];
        await writeFile(configFile, JSON.stringify(cfg, null, 2));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Failed to clean .claude.json projects entry', {
          module: 'routes', op: 'cascadeCleanupProject', err: err.message,
        });
      }
    }
    // 4. Remove project from ~/.gemini/trustedFolders.json.
    try {
      const trustFile = join(HOME, '.gemini', 'trustedFolders.json');
      const cfg = JSON.parse(await readFile(trustFile, 'utf-8'));
      if (cfg[project.path] !== undefined) {
        delete cfg[project.path];
        await writeFile(trustFile, JSON.stringify(cfg, null, 2));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Failed to clean Gemini trustedFolders entry', {
          module: 'routes', op: 'cascadeCleanupProject', err: err.message,
        });
      }
    }
    // 5. Remove [projects."<path>"] block from ~/.codex/config.toml.
    try {
      const codexConfigFile = join(HOME, '.codex', 'config.toml');
      const content = await readFile(codexConfigFile, 'utf-8');
      const escapeTomlBasicString = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const blockMarker = `[projects."${escapeTomlBasicString(project.path)}"]`;
      if (content.includes(blockMarker)) {
        // Strip the block + its body (everything until the next [...] header
        // or end-of-file). TOML key blocks are flat, so this is greedy across
        // the immediate trust_level / etc. lines belonging to this header.
        const lines = content.split('\n');
        const out = [];
        let skipping = false;
        for (const line of lines) {
          if (line.trim() === blockMarker) { skipping = true; continue; }
          if (skipping && /^\s*\[/.test(line)) { skipping = false; }
          if (!skipping) out.push(line);
        }
        await writeFile(codexConfigFile, out.join('\n'));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Failed to clean Codex config.toml block', {
          module: 'routes', op: 'cascadeCleanupProject', err: err.message,
        });
      }
    }
  }

  app.post('/api/projects/:name/remove', async (req, res) => {
    try {
      const project = db.getProject(req.params.name);
      if (!project) return res.status(404).json({ error: 'project not found' });
      await cascadeCleanupProject(project);
      db.deleteProject(project.id);
      res.json({ removed: req.params.name });
    } catch (err) {
      logger.error('Error removing project', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── Programs (parent folder for projects) ─────────────────────────────────
  app.put('/api/projects/:name/program', (req, res) => {
    const project = db.getProject(req.params.name);
    if (!project) return res.status(404).json({ error: 'project not found' });
    const { program_id } = req.body || {};
    if (program_id != null && !db.getProgram(Number(program_id)))
      return res.status(404).json({ error: 'program not found' });
    const updated = db.setProjectProgram(project.id, program_id);
    fireEvent('project_program_changed', { project: project.name, program_id: updated.program_id });
    res.json(updated);
  });

  app.get('/api/programs', (req, res) => {
    const filter = req.query.filter || 'all';
    res.json({ programs: db.getAllPrograms(filter) });
  });

  app.post('/api/programs', (req, res) => {
    const { name, description } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    const cleanName = String(name).trim();
    if (cleanName.length > 60) return res.status(400).json({ error: 'name too long (max 60)' });
    if (db.getProgramByName(cleanName)) return res.status(409).json({ error: 'program with that name already exists' });
    const program = db.addProgram(cleanName, description ? String(description) : '');
    fireEvent('program_added', { program_id: program.id, name: program.name });
    res.json(program);
  });

  app.put('/api/programs/:id', (req, res) => {
    const id = Number(req.params.id);
    const program = db.getProgram(id);
    if (!program) return res.status(404).json({ error: 'program not found' });
    const { name, description, status } = req.body || {};
    const fields = {};
    if (name !== undefined) {
      const clean = String(name).trim();
      if (!clean) return res.status(400).json({ error: 'name cannot be empty' });
      if (clean !== program.name) {
        const dup = db.getProgramByName(clean);
        if (dup && dup.id !== id) return res.status(409).json({ error: 'program with that name already exists' });
      }
      fields.name = clean;
    }
    if (description !== undefined) fields.description = String(description);
    if (status !== undefined) {
      if (!['active', 'archived'].includes(status))
        return res.status(400).json({ error: 'invalid status' });
      fields.status = status;
    }
    const updated = db.updateProgram(id, fields);
    res.json(updated);
  });

  app.delete('/api/programs/:id', (req, res) => {
    const id = Number(req.params.id);
    const program = db.getProgram(id);
    if (!program) return res.status(404).json({ error: 'program not found' });
    const projectsCount = db.countProjectsInProgram(id);
    db.deleteProgram(id);
    fireEvent('program_deleted', { program_id: id, name: program.name, orphaned_projects: projectsCount });
    res.json({ deleted: true, orphaned_projects: projectsCount });
  });

  app.get('/api/programs/:id/project-count', (req, res) => {
    const id = Number(req.params.id);
    const program = db.getProgram(id);
    if (!program) return res.status(404).json({ error: 'program not found' });
    const total = db.countProjectsInProgram(id);
    // Status breakdown — useful for the delete-confirmation message
    const projects = db.getProjects().filter(p => p.program_id === id);
    const counts = { active: 0, archived: 0 };
    for (const p of projects) {
      if (p.state === 'archived') counts.archived++;
      else counts.active++;
    }
    res.json({ program, total, counts });
  });

  // ── Auth endpoints ─────────────────────────────────────────────────────────

  app.get('/api/auth/status', async (req, res) => {
    try {
      res.json(await checkAuthStatus());
    } catch (err) {
      res.json({ valid: false, reason: err.message });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      await safe.claudeExecAsync(['--print', 'test'], { timeout: 10000 });
      res.json({ valid: true });
    } catch (err) {
      res.json({ valid: false, reason: err.message });
    }
  });

  // ── Keepalive endpoints ────────────────────────────────────────────────────

  app.get('/api/keepalive/status', async (req, res) => {
    const status = await keepalive.getStatus();
    res.json({ ...status, browsers: getBrowserCount() });
  });

  app.put('/api/keepalive/mode', (req, res) => {
    const { mode, idleMinutes } = req.body;
    if (!['always', 'browser', 'idle'].includes(mode))
      return res.status(400).json({ error: 'mode must be always, browser, or idle' });
    if (
      idleMinutes !== undefined &&
      (typeof idleMinutes !== 'number' || idleMinutes < 1 || idleMinutes > 1440)
    ) {
      return res.status(400).json({ error: 'idleMinutes must be a number between 1 and 1440' });
    }
    keepalive.setMode(mode, idleMinutes);
    if (mode === 'always' && !keepalive.isRunning()) keepalive.start();
    if (mode === 'browser' && getBrowserCount() === 0) keepalive.stop();
    res.json({ mode: keepalive.getMode(), running: keepalive.isRunning() });
  });

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

  // ── GET /api/kb/roles ─────────────────────────────────────────────────────

  app.get('/api/kb/roles', async (req, res) => {
    const rolesDir = '/data/knowledge-base/roles';
    try {
      const files = await readdir(rolesDir);
      const roles = files
        .filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
        .map(f => ({
          name: f.replace(/\.md$/, ''),
          label: f.replace(/\.md$/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        }));
      res.json(roles);
    } catch (_err) {
      res.json([]);
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
      const tmpId = cliType === 'claude'
        ? `new_${Date.now()}`
        : require('crypto').randomUUID();
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
        const rolePath = `/data/knowledge-base/roles/${role}.md`;
        try {
          await stat(rolePath);
          await _seedRole(cliType, rolePath, projectPath, cliArgs, existingFiles, sessDir, tmpId, proj, db, tmux, logger);
        } catch (roleErr) {
          logger.warn('Role seeding failed — launching without role', { module: 'routes', role, err: roleErr.message });
          safe.tmuxCreateCLI(tmux, projectPath, cliType, cliArgs);
        }
      } else {
        safe.tmuxCreateCLI(tmux, projectPath, cliType, cliArgs);
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
      safe.tmuxCreateCLI(tmux, projectPath, 'bash');
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
        safe.tmuxCreateCLI(tmux, projectPath, session.cli_type || 'claude', resumeArgs);
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

  // ── Tasks ─────────────────────────────────────────────────────────────────

  // ── Tasks v2 — project-based, subtasks, status lifecycle, rank ──────────
  // Per #303 / #304 / #305 / #306 / #302 / #307. Folder-path tasks were
  // replaced by project-anchored tasks with parent_task_id for hierarchy.

  function _projectHasRepoPath(projectPath) {
    if (!projectPath) return false;
    const fs = require('fs');
    const path = require('path');
    let cur = projectPath;
    while (cur && cur !== '/' && cur.length > 1) {
      try { if (fs.existsSync(path.join(cur, '.git'))) return true; } catch { /* ignore */ }
      cur = path.dirname(cur);
    }
    return false;
  }

  // Build a tree shaped { programs: [ { id, name, projects: [ { id, name, path, has_repo, tasks: [ { ..., subtasks: [...] } ] } ] } ] }
  // Tasks within each project are top-level (parent_task_id IS NULL); subtasks
  // are nested recursively under their parent.
  function buildProjectTaskTree({ filter = 'open', showArchived = false } = {}) {
    const programs = db.getAllPrograms('all');
    const projects = db.getProjects();
    let tasks;
    if (filter === 'open') {
      // Open = any non-terminal status
      tasks = db.getAllTasks('all').filter(t => ['inactive', 'active', 'blocked'].includes(t.status));
    } else if (filter === 'archived-flag') {
      // Show only archived tasks (archived=1) — different from old 'archived' status
      tasks = db.getAllTasks('all').filter(t => !!t.archived);
    } else {
      tasks = filter === 'all' ? db.getAllTasks('all') : db.getAllTasks(filter);
    }
    // For archived-flag mode, don't filter out archived. Otherwise, hide them by default.
    if (filter !== 'archived-flag' && !showArchived) tasks = tasks.filter(t => !t.archived);
    const projTasks = new Map(); // project_id -> task array
    for (const t of tasks) {
      if (!projTasks.has(t.project_id)) projTasks.set(t.project_id, []);
      projTasks.get(t.project_id).push(t);
    }
    // For each project, build the subtask tree
    function nestSubtasks(taskArr) {
      const byParent = new Map();
      for (const t of taskArr) {
        const k = t.parent_task_id ?? 0;
        if (!byParent.has(k)) byParent.set(k, []);
        byParent.get(k).push(t);
      }
      function decorate(parentId) {
        const arr = (byParent.get(parentId) || []).sort((a, b) => (a.rank || 0) - (b.rank || 0));
        return arr.map(t => ({ ...t, subtasks: decorate(t.id) }));
      }
      return decorate(0);
    }
    const programMap = new Map();
    for (const p of programs) programMap.set(p.id, { id: p.id, name: p.name, status: p.status, projects: [] });
    const orphanProjects = []; // projects with program_id null
    for (const proj of projects) {
      const projNode = {
        id: proj.id,
        name: proj.name,
        path: proj.path,
        program_id: proj.program_id,
        has_repo: _projectHasRepoPath(proj.path),
        tasks: nestSubtasks(projTasks.get(proj.id) || []),
      };
      if (proj.program_id != null && programMap.has(proj.program_id)) {
        programMap.get(proj.program_id).projects.push(projNode);
      } else {
        orphanProjects.push(projNode);
      }
    }
    const programList = Array.from(programMap.values()).filter(pr => pr.projects.length > 0);
    if (orphanProjects.length) {
      programList.push({ id: null, name: 'Unassigned', status: 'active', projects: orphanProjects });
    }
    return { programs: programList };
  }

  app.get('/api/tasks/tree', (req, res) => {
    const filter = req.query.filter || 'open';
    const showArchived = req.query.show_archived === '1';
    res.json(buildProjectTaskTree({ filter, showArchived }));
  });

  app.post('/api/tasks', (req, res) => {
    const { project_id, parent_task_id, github_issue, title, description, status, created_by } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    if (title.length > TASK_TITLE_MAX_LEN) return res.status(400).json({ error: 'title too long' });
    if (description && description.length > TASK_DESC_MAX_LEN) return res.status(400).json({ error: 'description too long' });
    let project = null;
    if (project_id != null) project = db.getProjectById(Number(project_id));
    if (!project && parent_task_id != null) {
      const parent = db.getTask(Number(parent_task_id));
      if (parent) project = db.getProjectById(parent.project_id);
    }
    if (!project) return res.status(400).json({ error: 'project_id or valid parent_task_id required' });
    const issue = github_issue ? String(github_issue).trim() : null;
    if (!issue && _projectHasRepoPath(project.path)) {
      return res.status(400).json({ error: `github_issue required for tasks in repo-backed project "${project.name}"` });
    }
    if (parent_task_id != null) {
      const parent = db.getTask(Number(parent_task_id));
      if (!parent) return res.status(404).json({ error: 'parent_task_id not found' });
      if (parent.project_id !== project.id) {
        return res.status(400).json({ error: 'parent_task_id must be in the same project' });
      }
    }
    try {
      const task = db.addTask({
        projectId: project.id,
        parentTaskId: parent_task_id == null ? null : Number(parent_task_id),
        githubIssue: issue,
        title,
        description: description || '',
        status: status || 'inactive',
        createdBy: created_by || 'human',
      });
      fireEvent('task_added', { task_id: task.id, project_id: project.id, title });
      res.json(task);
    } catch (e) {
      if (e.code === 'task_validation') return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  app.get('/api/tasks/:id', (req, res) => {
    const task = db.getTask(Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'task not found' });
    const history = db.getTaskHistory(task.id);
    const subtasks = db.getSubtasks(task.id);
    res.json({ ...task, history, subtasks });
  });

  app.put('/api/tasks/:id', (req, res) => {
    const id = Number(req.params.id);
    const task = db.getTask(id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const { title, description, github_issue, status, archived, rank, parent_task_id, project_id } = req.body || {};
    try {
      if (title !== undefined) {
        if (!title || title.length > TASK_TITLE_MAX_LEN) return res.status(400).json({ error: 'invalid title' });
      }
      if (description !== undefined && description.length > TASK_DESC_MAX_LEN) return res.status(400).json({ error: 'description too long' });
      if (title !== undefined || description !== undefined || github_issue !== undefined) {
        db.updateTaskFields(id, { title, description, github_issue });
      }
      if (status !== undefined) db.setTaskStatus(id, status);
      if (archived !== undefined) db.setTaskArchived(id, !!archived);
      if (rank !== undefined) db.setTaskRank(id, Number(rank));
      if (parent_task_id !== undefined || project_id !== undefined) {
        db.reparentTask(id, {
          parentTaskId: parent_task_id === undefined ? null : parent_task_id,
          projectId: project_id,
        });
      }
      res.json(db.getTask(id));
    } catch (e) {
      if (e.code === 'task_validation') return res.status(400).json({ error: e.message });
      if (e.code === 'not_found') return res.status(404).json({ error: e.message });
      throw e;
    }
  });

  app.delete('/api/tasks/:id', (req, res) => {
    db.deleteTask(Number(req.params.id));
    res.json({ deleted: true });
  });

  // ── Task comments ────────────────────────────────────────────────────────
  app.post('/api/tasks/:id/comments', (req, res) => {
    const id = Number(req.params.id);
    const task = db.getTask(id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const { body, created_by } = req.body || {};
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body required' });
    if (body.length > TASK_DESC_MAX_LEN) return res.status(400).json({ error: 'body too long' });
    const comment = db.addTaskComment(id, String(body).trim(), created_by || 'human');
    fireEvent('task_comment_added', { task_id: id, comment_id: comment.id });
    res.json(comment);
  });

  // ── Inter-session messages ────────────────────────────────────────────────

  // Inter-session messaging removed — tmux handles agent communication natively.
  // See issue #51 for the tmux-based agent mesh architecture.

  // ── Settings ──────────────────────────────────────────────────────────────

  app.get('/api/settings', (req, res) => {
    const settings = db.getAllSettings();
    const defaults = {
      default_model: 'sonnet',
      thinking_level: 'none',
      keepalive_mode: 'always',
      keepalive_idle_minutes: 30,
      oauth_detection: { claude: true, gemini: false, codex: false },
      vector_embedding_provider: 'none',
      vector_custom_url: '',
      vector_custom_key: '',
      vector_collection_documents: { enabled: true, dims: 384, patterns: ['*.md', '*.txt', '*.pdf', '*.rst', '*.adoc'] },
      vector_collection_code: { enabled: true, dims: 384, patterns: ['*.js', '*.ts', '*.py', '*.go', '*.rs', '*.java', '*.sh', 'Dockerfile', 'Makefile', '*.yml', '*.yaml', '*.json'] },
      vector_collection_claude: { enabled: true, dims: 384 },
      vector_collection_gemini: { enabled: true, dims: 384 },
      vector_collection_codex: { enabled: true, dims: 384 },
      vector_ignore_patterns: 'node_modules/**\n.git/**\n*.lock\n*.min.js\ndist/**\nbuild/**',
      vector_additional_paths: [],
      kb_repo_url: 'https://github.com/rmdevpro/workbench-kb',
      kb_repo_name: 'blueprint_workbench_kb',
      kb_sync_interval_minutes: 5,
    };
    res.json({ ...defaults, ...settings });
  });

  app.put('/api/settings', async (req, res) => {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });

    // #291: Additional Paths is for directories OUTSIDE the workspace.
    // Reject only NEWLY-introduced redundant paths so pre-existing entries
    // (added before this validation) don't block all future saves —
    // the user removes those via the per-row × button.
    if (key === 'vector_additional_paths') {
      const arr = Array.isArray(value) ? value : [];
      const ws = safe.WORKSPACE;
      const isRedundant = (p) => {
        if (typeof p !== 'string' || !p.trim()) return false;
        const norm = pathResolve(p);
        return norm === ws || norm.startsWith(ws + '/');
      };
      let prev = [];
      try {
        const raw = db.getSetting('vector_additional_paths', '[]');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) prev = parsed;
      } catch { /* fall through with prev = [] */ }
      const newlyAdded = arr.filter(p => !prev.includes(p));
      const offending = newlyAdded.filter(isRedundant);
      if (offending.length) {
        return res.status(400).json({
          error: `Paths under ${ws} are already scanned (Additional Paths is for paths outside the workspace): ${offending.join(', ')}`,
        });
      }
    }

    // #180: validate API key / provider changes synchronously before persisting,
    // so a bad key doesn't leave the runtime silently broken. Skip validation when
    // the user is clearing the setting (empty value) — that's a deliberate reset.
    const VALIDATED_KEYS = new Set([
      'gemini_api_key', 'codex_api_key', 'huggingface_api_key',
      'vector_embedding_provider', 'vector_custom_url', 'vector_custom_key',
    ]);
    if (VALIDATED_KEYS.has(key) && value) {
      // 'none' means "disable embeddings entirely" — no live config to validate
      const skipValidation = key === 'vector_embedding_provider' && value === 'none';
      if (!skipValidation) {
        const qdrant = require('./qdrant-sync');
        const cfg = qdrant.buildCandidateConfig(key, value);
        const result = await qdrant.validateProviderConfig(cfg);
        if (!result.ok) {
          logger.warn('Settings validation failed', { module: 'routes', settingKey: key, provider: cfg.model, err: result.error });
          return res.status(400).json({ error: `API key validation failed: ${result.error}`, provider: cfg.model });
        }
      }
    }

    db.setSetting(key, JSON.stringify(value));

    // Update process env when API keys change so new CLI sessions get them
    if (key === 'gemini_api_key') {
      process.env.GEMINI_API_KEY = value || '';
      // Reseed ~/.gemini/settings.json so the CLI doesn't open the auth menu
      // on the next session. Idempotent; preserves any existing selectedType.
      registerGeminiMcp().catch(err =>
        logger.warn('registerGeminiMcp after gemini_api_key save failed', { module: 'routes', err: err.message })
      );
    }
    if (key === 'codex_api_key') {
      process.env.OPENAI_API_KEY = value || '';
      // Seed ~/.codex/config.toml with the api-key provider so the CLI
      // reads OPENAI_API_KEY from env on the next session instead of
      // launching ChatGPT OAuth. Idempotent; preserves any user choice.
      registerCodexProvider().catch(err =>
        logger.warn('registerCodexProvider after codex_api_key save failed', { module: 'routes', err: err.message })
      );
      // #309: seed auth.json (API-key form) so codex_apps MCP and discoverable
      // tool calls don't 401-loop on a stale chatgpt-form auth.json. Guarded
      // by absent-file check inside registerCodexAuth so prior user choice
      // (live OAuth or otherwise) is preserved.
      if (value) {
        registerCodexAuth().catch(err =>
          logger.warn('registerCodexAuth after codex_api_key save failed', { module: 'routes', err: err.message })
        );
      }
    }
    if (key === 'huggingface_api_key') {
      // qdrant-sync's HF embedding provider reads process.env.HF_TOKEN
      process.env.HF_TOKEN = value || '';
    }

    if (key === 'keepalive_mode') {
      const idleMins = db.getSetting('keepalive_idle_minutes', '30');
      keepalive.setMode(value, parseInt(idleMins, 10));
      if (value === 'always' && !keepalive.isRunning()) keepalive.start();
      if (value === 'browser' && getBrowserCount() === 0) keepalive.stop();
    }
    if (key === 'keepalive_idle_minutes') {
      const mode = db.getSetting('keepalive_mode', '"always"');
      try {
        keepalive.setMode(JSON.parse(mode), parseInt(value, 10));
      } catch (parseErr) {
        if (parseErr instanceof SyntaxError) {
          logger.debug('Invalid keepalive_mode JSON in settings', { module: 'routes' });
        } else {
          throw parseErr;
        }
      }
    }
    // Single qdrant lifecycle hook for any settings change. reapplyConfig
    // is internally serialized (coalesces rapid successive calls into one
    // trailing apply), so consecutive PUTs from the user — e.g., save key,
    // then switch provider — won't race overlapping stop/start/scan cycles.
    if ([
      'vector_embedding_provider',
      'vector_custom_url', 'vector_custom_key',
      'gemini_api_key', 'codex_api_key', 'huggingface_api_key',
    ].includes(key)) {
      const qdrant = require('./qdrant-sync');
      qdrant.reapplyConfig({ dropCollections: key === 'vector_embedding_provider' })
        .catch(err =>
          logger.warn('qdrant.reapplyConfig after settings change failed', { module: 'routes', settingKey: key, err: err.message })
        );
    }
    res.json({ saved: true });
  });

  // ── CLI Credentials Check ─────────────────────────────────────────────────

  app.get('/api/cli-credentials', async (req, res) => {
    const fsp = require('fs/promises');
    const { join } = require('path');
    const home = safe.HOME;

    // Gemini: check for credentials file OR GOOGLE_API_KEY in env OR key in DB settings
    const geminiCredFile = join(home, '.gemini', 'gemini-credentials.json');
    let hasGemini = !!process.env.GOOGLE_API_KEY ||
      !!process.env.GEMINI_API_KEY ||
      !!db.getSetting('gemini_api_key', '');
    if (!hasGemini) {
      try { await fsp.access(geminiCredFile); hasGemini = true; }
      catch { /* no creds file */ }
    }

    // Codex: check auth.json for OPENAI_API_KEY
    let hasOpenai = !!process.env.OPENAI_API_KEY || !!db.getSetting('codex_api_key', '');
    if (!hasOpenai) {
      try {
        const codexAuth = JSON.parse(await fsp.readFile(join(home, '.codex', 'auth.json'), 'utf-8'));
        hasOpenai = !!codexAuth.OPENAI_API_KEY;
      } catch { /* no auth file */ }
    }

    // HuggingFace: env var or DB setting
    const hasHuggingface = !!process.env.HF_TOKEN || !!db.getSetting('huggingface_api_key', '');

    res.json({ gemini: hasGemini, openai: hasOpenai, huggingface: hasHuggingface });
  });

  // ── Logs (#181) ───────────────────────────────────────────────────────────

  // GET /api/logs?level=ERROR&module=qdrant-sync&since=1h&limit=200
  // since: '1h' / '24h' / '7d' / ISO8601 timestamp. Default: last 1h.
  app.get('/api/logs', (req, res) => {
    const { level, module: mod } = req.query;
    const parsed = parseInt(req.query.limit, 10);
    const limit = Math.max(1, Math.min(Number.isFinite(parsed) ? parsed : 200, 5000));
    const since = _parseSince(req.query.since || '1h');
    const rows = db.queryLogs({ level, module: mod, since, limit });
    res.json({ since, count: rows.length, rows });
  });

  // GET /api/logs/summary?since=1h — used by the UI banner.
  app.get('/api/logs/summary', (req, res) => {
    const since = _parseSince(req.query.since || '1h');
    const errorCount = db.errorCountSince(since);
    const topError = errorCount > 0 ? db.topErrorSince(since) : null;
    res.json({ since, errorCount, topError });
  });

  // ── Qdrant / Vector Search ────────────────────────────────────────────────

  app.get('/api/qdrant/status', async (req, res) => {
    try {
      const qdrantSync = require('./qdrant-sync');
      const statusData = await qdrantSync.status();
      res.json(statusData);
    } catch (err) {
      res.json({ available: false, error: err.message });
    }
  });

  app.post('/api/qdrant/reindex', async (req, res) => {
    const { collection } = req.body;
    if (!collection) return res.status(400).json({ error: 'collection required' });
    try {
      const qdrantSync = require('./qdrant-sync');
      qdrantSync.reindexCollection(collection).catch(err =>
        logger.error('Reindex error', { module: 'routes', collection, err: err.message })
      );
      res.json({ started: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── CLAUDE.md management ──────────────────────────────────────────────────

  app.get('/api/claude-md/global', async (req, res) => {
    try {
      const file = join(process.env.HOME || '/data', '.claude', 'CLAUDE.md');
      const content = await readFile(file, 'utf-8');
      res.json({ content });
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.json({ content: '' });
      } else {
        logger.warn('Error reading global CLAUDE.md', { module: 'routes', err: err.message });
        res.json({ content: '' });
      }
    }
  });

  app.put('/api/claude-md/global', async (req, res) => {
    try {
      const file = join(process.env.HOME || '/data', '.claude', 'CLAUDE.md');
      await writeFile(file, req.body.content || '');
      res.json({ saved: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:name/claude-md', async (req, res) => {
    try {
      const dbProj = db.getProject(req.params.name);
      const projectPath = dbProj ? dbProj.path : join(WORKSPACE, req.params.name);
      const file = join(projectPath, 'CLAUDE.md');
      let content = '';
      try {
        content = await readFile(file, 'utf-8');
      } catch (readErr) {
        if (readErr.code === 'ENOENT') {
          const template = db.getSetting('default_project_claude_md', '""');
          try {
            content = JSON.parse(template);
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) {
              logger.debug('Invalid default_project_claude_md JSON', { module: 'routes' });
              content = '';
            } else {
              throw parseErr;
            }
          }
          if (content) await writeFile(file, content);
        } else {
          throw readErr;
        }
      }
      res.json({ content });
    } catch (err) {
      logger.error('Error reading project CLAUDE.md', { module: 'routes', err: err.message });
      res.json({ content: '' });
    }
  });

  app.put('/api/projects/:name/claude-md', async (req, res) => {
    try {
      const dbProj = db.getProject(req.params.name);
      const projectPath = dbProj ? dbProj.path : join(WORKSPACE, req.params.name);
      const file = join(projectPath, 'CLAUDE.md');
      await writeFile(file, req.body.content || '');
      res.json({ saved: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── MCP Servers config ────────────────────────────────────────────────────

  app.get('/api/mcp-servers', async (req, res) => {
    try {
      const configFile = join(CLAUDE_HOME, 'settings.json');
      const raw = await readFile(configFile, 'utf-8');
      const cfg = JSON.parse(raw);
      res.json({ servers: cfg.mcpServers || {} });
    } catch (err) {
      if (err.code === 'ENOENT' || err instanceof SyntaxError) {
        res.json({ servers: {} });
      } else {
        logger.error('Error reading MCP servers config', { module: 'routes', err: err.message });
        res.json({ servers: {} });
      }
    }
  });

  app.put('/api/mcp-servers', async (req, res) => {
    try {
      const { servers } = req.body;
      const configFile = join(CLAUDE_HOME, 'settings.json');
      let cfg = {};
      try {
        cfg = JSON.parse(await readFile(configFile, 'utf-8'));
      } catch (readErr) {
        if (readErr.code !== 'ENOENT' && !(readErr instanceof SyntaxError)) throw readErr;
        /* expected: fresh config or corrupt — start clean */
      }
      cfg.mcpServers = servers || {};
      await writeFile(configFile, JSON.stringify(cfg, null, 2));
      res.json({ saved: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Search ────────────────────────────────────────────────────────────────

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
      const entry = db.getSession(sessionId);
      const project = entry ? entry.project_name : (req.body.project || '');
      const projectHash = (project ? safe.resolveProjectPath(project) : '').replace(/[^a-zA-Z0-9]/g, '-');
      const sessionFile = join(CLAUDE_HOME, 'projects', projectHash, `${sessionId}.jsonl`);

      if (mode === 'info') {
        let exists = false;
        try { await stat(sessionFile); exists = true; } catch {}
        return res.json({ sessionId, sessionFile, exists });
      }
      if (mode === 'resume') {
        let tail = '';
        let lineCount = 0;
        try {
          const content = await readFile(sessionFile, 'utf-8');
          const lines = content.trim().split('\n').filter(Boolean);
          const kept = lines.slice(-tailLines);
          tail = kept.join('\n');
          lineCount = kept.length;
        } catch (err) {
          tail = '(could not read session file: ' + err.message + ')';
        }
        const tailPath = join('/tmp', `workbench-resume-${sessionId}-${Date.now()}.txt`);
        await writeFile(tailPath, tail, 'utf-8');
        const byteCount = Buffer.byteLength(tail, 'utf-8');
        return res.json({
          prompt: config.getPrompt('session-resume', {
            TAIL_PATH: tailPath,
            LINE_COUNT: String(lineCount),
            BYTE_COUNT: String(byteCount),
          }),
        });
      }
      if (mode === 'transition') {
        return res.json({ prompt: config.getPrompt('session-transition', {}) });
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
      safe.tmuxCreateCLI(tmux, cwd, cliType, restartArgs || []);
      res.json({ ok: true, sessionId, tmux });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Tmux input primitives ────────────────────────────────────────────────
  // Generic delivery of text/keys to a session's tmux pane via server-side
  // load-buffer/paste-buffer/send-keys. Robust to a closed terminal WS on
  // the client (e.g. browser tab backgrounded during OAuth flow). Shape
  // mirrors the `session_send_text` / `session_send_key` MCP tools, which
  // share the same underlying safe-exec primitives.

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

  // ── File operations ─────────────────────────────────────────────────────

  app.post('/api/mkdir', async (req, res) => {
    try {
      const dirPath = req.body.path;
      if (!dirPath || dirPath === '/') return res.status(400).json({ error: 'path required' });
      await mkdir(dirPath, { recursive: true });
      res.json({ ok: true, path: dirPath });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/upload', express.raw({ type: 'application/octet-stream', limit: '50mb' }), async (req, res) => {
    try {
      const targetDir = req.headers['x-upload-dir'];
      const fileName = req.headers['x-upload-filename'];
      if (!targetDir || !fileName) return res.status(400).json({ error: 'x-upload-dir and x-upload-filename headers required' });
      const filePath = join(targetDir, basename(fileName));
      await writeFile(filePath, req.body);
      res.json({ ok: true, path: filePath });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Project config ──────────────────────────────────────────────────────

  app.get('/api/projects/:name/config', (req, res) => {
    const project = db.getProject(req.params.name);
    if (!project) return res.status(404).json({ error: 'project not found' });
    res.json({ name: project.name, state: project.state || 'active', notes: project.notes || '', path: project.path });
  });

  app.put('/api/projects/:name/config', (req, res) => {
    const project = db.getProject(req.params.name);
    if (!project) return res.status(404).json({ error: 'project not found' });
    const { name, state, notes } = req.body;
    if (name && name !== project.name) db.renameProject(project.id, name);
    if (state) db.setProjectState(project.id, state);
    if (notes !== undefined) db.setProjectNotes(project.id, notes);
    res.json({ ok: true });
  });

  // ── Health endpoint ───────────────────────────────────────────────────────

  app.get('/health', async (req, res) => {
    const deps = { db: 'unknown', workspace: 'unknown', auth: 'unknown' };
    let healthy = true;
    try {
      db.getProjects();
      deps.db = 'healthy';
    } catch (err) {
      deps.db = 'degraded';
      healthy = false;
      logger.warn('Health check: db degraded', { module: 'routes', err: err.message });
    }
    try {
      await access(WORKSPACE);
      deps.workspace = 'healthy';
    } catch (err) {
      deps.workspace = 'degraded';
      healthy = false;
      logger.warn('Health check: workspace degraded', { module: 'routes', err: err.message });
    }
    try {
      const auth = await checkAuthStatus();
      deps.auth = auth.valid ? 'healthy' : 'degraded';
      // Auth is informational only — does not affect overall healthy status
    } catch (_err) {
      deps.auth = 'degraded';
    }
    res
      .status(healthy ? 200 : 503)
      .json({ status: healthy ? 'ok' : 'degraded', dependencies: deps });
  });

  // ── Register sub-route modules ────────────────────────────────────────────

  registerMcpRoutes(app);
  registerWebhookRoutes(app);

  return { checkAuthStatus, trustDir };
}

module.exports = registerCoreRoutes;
