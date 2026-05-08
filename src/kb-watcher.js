'use strict';

// #271/#290: KB git watcher.
//
// Pattern modeled on Obsidian Git plugin / Foam / Logseq:
//   chokidar → debounce → simple-git commit + push (origin = user's fork)
//   periodic upstream pull via `git fetch upstream && git merge --ff-only`
//
// Config (config/defaults.json under "kb"):
//   debounceMs           how long to coalesce file events before committing
//   pullIntervalMs       how often to fetch+merge from upstream
//   commitAuthorName     git author for auto-commits (workbench-bot by default)
//   commitAuthorEmail
//
// Status is published via setStatus(...) so the existing /api/kb/status
// endpoint can surface ahead/behind vs origin AND vs upstream, plus the
// most recent error message if a push or pull failed.

const chokidar = require('chokidar');
const simpleGit = require('simple-git');
const { join } = require('path');
const { stat } = require('fs/promises');
const gitAuth = require('./git-auth');
const { KB_PATH, KB_UPSTREAM_URL } = require('./constants');

module.exports = function createKbWatcher({ db, logger, config }) {
  // #317: KB ops authenticate via http.extraheader — token never embedded in
  // remote URL. _kbAuthArgs() returns the per-call git args that inject the
  // header, looked up fresh each time so token rotation takes effect without
  // restart.
  function _kbAuthArgs() {
    const acc = gitAuth.kbAccount(db);
    return gitAuth.gitAuthArgs(acc?.token || '');
  }
  const debounceMs = config.get('kb.debounceMs', 8000);
  const pullIntervalMs = config.get('kb.pullIntervalMs', 5 * 60 * 1000);
  const commitAuthorName = config.get('kb.commitAuthorName', 'Workbench Bot');
  const commitAuthorEmail = config.get('kb.commitAuthorEmail', 'workbench-bot@local');

  let watcher = null;
  let pendingPaths = new Set();
  let pendingTimer = null;
  let pullTimer = null;
  let busy = false;
  let lastStatus = {
    initialized: false,
    ahead: 0,                    // commits ahead of origin/main (pushable)
    behind: 0,                   // commits behind origin/main
    upstreamAhead: 0,            // commits in origin/main not yet rebased onto upstream
    upstreamBehind: 0,           // upstream changes not yet pulled
    lastSync: null,
    lastPushAt: null,
    lastPullAt: null,
    lastError: null,
    originUrl: null,
  };

  function setStatus(patch) {
    lastStatus = { ...lastStatus, ...patch };
  }

  function getStatus() {
    return { ...lastStatus };
  }

  async function _git() {
    return simpleGit({ baseDir: KB_PATH });
  }

  async function _kbExists() {
    try { await stat(join(KB_PATH, '.git')); return true; }
    catch { return false; }
  }

  async function _ensureGitIdentity() {
    const g = await _git();
    try {
      await g.addConfig('user.name', commitAuthorName, false, 'local');
      await g.addConfig('user.email', commitAuthorEmail, false, 'local');
      // Avoid push.default complaints; "current" pushes only the checked-out branch.
      await g.addConfig('push.default', 'current', false, 'local');
    } catch (err) {
      logger.warn('kb-watcher: addConfig failed', { err: err.message });
    }
  }

  async function _refreshAheadBehind() {
    if (!await _kbExists()) {
      setStatus({ initialized: false });
      return;
    }
    const g = await _git();
    setStatus({ initialized: true });
    try {
      const remotes = await g.getRemotes(true);
      const origin = remotes.find(r => r.name === 'origin')?.refs?.fetch || null;
      // Strip token if embedded — UI consumes the bare URL.
      const sanitizedOrigin = origin ? origin.replace(/:\/\/[^@]+@/, '://') : null;
      setStatus({ originUrl: sanitizedOrigin });

      // ahead/behind vs origin/main
      try {
        const [ahead, behind] = await Promise.all([
          g.raw(['rev-list', '--count', 'origin/main..HEAD']).then(s => parseInt(s.trim(), 10) || 0).catch(() => 0),
          g.raw(['rev-list', '--count', 'HEAD..origin/main']).then(s => parseInt(s.trim(), 10) || 0).catch(() => 0),
        ]);
        setStatus({ ahead, behind });
      } catch (err) {
        logger.debug('kb-watcher: ahead/behind vs origin failed', { err: err.message });
      }

      // ahead/behind vs upstream/main
      try {
        const hasUpstream = remotes.some(r => r.name === 'upstream');
        if (hasUpstream) {
          const [uAhead, uBehind] = await Promise.all([
            g.raw(['rev-list', '--count', 'upstream/main..HEAD']).then(s => parseInt(s.trim(), 10) || 0).catch(() => 0),
            g.raw(['rev-list', '--count', 'HEAD..upstream/main']).then(s => parseInt(s.trim(), 10) || 0).catch(() => 0),
          ]);
          setStatus({ upstreamAhead: uAhead, upstreamBehind: uBehind });
        } else {
          setStatus({ upstreamAhead: 0, upstreamBehind: 0 });
        }
      } catch (err) {
        logger.debug('kb-watcher: ahead/behind vs upstream failed', { err: err.message });
      }
    } catch (err) {
      logger.warn('kb-watcher: status refresh failed', { err: err.message });
    }
  }

  function _commitMessageFor(paths) {
    const rel = [...paths].map(p => p.replace(KB_PATH + '/', '')).filter(Boolean);
    if (rel.length === 0) return 'kb: changes';
    if (rel.length === 1) return `kb: update ${rel[0]}`;
    if (rel.length <= 3) return `kb: update ${rel.join(', ')}`;
    return `kb: update ${rel.length} files`;
  }

  async function _commitAndPush() {
    if (busy) return;
    busy = true;
    const paths = [...pendingPaths];
    pendingPaths.clear();
    try {
      if (!await _kbExists()) return;
      const g = await _git();
      // Stage everything that's changed (not just the files we observed —
      // chokidar can miss rapid sequences and we want a clean working tree).
      await g.add(['-A']);
      const status = await g.status();
      if (!status.files.length) {
        // Nothing to commit. Could happen if events fired but nothing
        // observable changed (e.g. mtime-only).
        await _refreshAheadBehind();
        return;
      }
      const msg = _commitMessageFor(paths);
      await g.commit(msg);
      logger.info('kb-watcher: committed', { msg, files: status.files.length });
      // Try to push to origin/main. If push fails (e.g. behind), keep the
      // commit local; status surfaces ahead/behind so the UI can show it.
      // #317: auth via extraheader — origin URL is plain, no embedded token.
      try {
        await g.raw([..._kbAuthArgs(), 'push', 'origin', 'main']);
        setStatus({ lastPushAt: new Date().toISOString(), lastError: null });
        logger.info('kb-watcher: pushed', { msg });
      } catch (pushErr) {
        const errMsg = pushErr.message || String(pushErr);
        setStatus({ lastError: `Push failed: ${errMsg}` });
        logger.warn('kb-watcher: push failed', { err: errMsg });
      }
      await _refreshAheadBehind();
    } catch (err) {
      const errMsg = err.message || String(err);
      setStatus({ lastError: `Commit failed: ${errMsg}` });
      logger.error('kb-watcher: commit/push failed', { err: errMsg });
    } finally {
      busy = false;
      // If more events accumulated while we were committing, schedule a
      // follow-up pass.
      if (pendingPaths.size > 0) {
        _scheduleCommit();
      }
    }
  }

  function _scheduleCommit() {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      _commitAndPush();
    }, debounceMs);
  }

  async function _periodicPull() {
    if (busy) return;
    if (!await _kbExists()) return;
    busy = true;
    try {
      const g = await _git();
      const remotes = await g.getRemotes(true);
      const hasUpstream = remotes.some(r => r.name === 'upstream');
      if (!hasUpstream) {
        // Self-heal: add upstream pointing at the canonical public KB so
        // pulls work without the user having to run sync-upstream first.
        try { await g.addRemote('upstream', KB_UPSTREAM_URL); }
        catch (_e) { /* race or already there */ }
      }
      // simple-git's .fetch('upstream') was observed to no-op silently
      // on this codebase — refs/remotes/upstream/main was never populated
      // and the subsequent merge --ff-only failed with "upstream/main not
      // something we can merge". Use raw() to invoke `git fetch upstream`
      // directly so the underlying git binary handles the refspec.
      try {
        // upstream is the public KB; no auth needed for read.
        await g.raw(['fetch', 'upstream']);
      } catch (err) {
        setStatus({ lastError: `Fetch upstream failed: ${err.message}` });
        return;
      }
      // Fast-forward only — never auto-resolve conflicts.
      try {
        await g.raw(['merge', '--ff-only', 'upstream/main']);
        setStatus({ lastPullAt: new Date().toISOString(), lastSync: new Date().toISOString(), lastError: null });
      } catch (err) {
        // Non-FF means user has divergent local commits; surface and stop.
        const errMsg = err.message || String(err);
        setStatus({ lastError: `Pull (ff-only) failed: ${errMsg}` });
        logger.info('kb-watcher: pull skipped (non-ff)', { err: errMsg });
      }
      await _refreshAheadBehind();
      // After a pull (which may have fast-forwarded our local main past
      // origin/main on the user's fork), push the result so origin matches.
      // #317: auth via extraheader on the push.
      if (lastStatus.ahead > 0) {
        try {
          await g.raw([..._kbAuthArgs(), 'push', 'origin', 'main']);
          setStatus({ lastPushAt: new Date().toISOString() });
          await _refreshAheadBehind();
        } catch (pushErr) {
          setStatus({ lastError: `Post-pull push failed: ${pushErr.message}` });
        }
      }
    } finally {
      busy = false;
    }
  }

  async function start() {
    if (watcher) return; // idempotent
    if (!await _kbExists()) {
      logger.info(`kb-watcher: not starting — ${KB_PATH} is not a git repo yet`);
      return;
    }
    await _ensureGitIdentity();
    await _refreshAheadBehind();
    watcher = chokidar.watch(KB_PATH, {
      ignored: (p) => p.includes(`${KB_PATH}/.git`),
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    watcher.on('add', p => { pendingPaths.add(p); _scheduleCommit(); });
    watcher.on('change', p => { pendingPaths.add(p); _scheduleCommit(); });
    watcher.on('unlink', p => { pendingPaths.add(p); _scheduleCommit(); });
    watcher.on('addDir', p => { pendingPaths.add(p); _scheduleCommit(); });
    watcher.on('unlinkDir', p => { pendingPaths.add(p); _scheduleCommit(); });
    watcher.on('error', err => logger.warn('kb-watcher: chokidar error', { err: err.message }));
    pullTimer = setInterval(_periodicPull, pullIntervalMs);
    // Kick off an initial pull so the status is fresh on startup.
    _periodicPull().catch(() => {});
    logger.info('kb-watcher: started', { debounceMs, pullIntervalMs });
  }

  async function stop() {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
    if (watcher) { await watcher.close(); watcher = null; }
  }

  // Manual triggers exposed for routes.js so the user can force a sync.
  async function syncUpstreamNow() { await _periodicPull(); return getStatus(); }
  async function pushNow() {
    // Force a flush of any pending changes.
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (pendingPaths.size === 0) {
      // Even with no pending changes, the user may have committed locally
      // via something else and want to push. Do that.
      if (!await _kbExists()) return getStatus();
      const g = await _git();
      try {
        // #317: auth via extraheader.
        await g.raw([..._kbAuthArgs(), 'push', 'origin', 'main']);
        setStatus({ lastPushAt: new Date().toISOString(), lastError: null });
      } catch (err) {
        setStatus({ lastError: `Push failed: ${err.message}` });
      }
      await _refreshAheadBehind();
      return getStatus();
    }
    await _commitAndPush();
    return getStatus();
  }
  async function refreshStatus() { await _refreshAheadBehind(); return getStatus(); }

  return { start, stop, getStatus, refreshStatus, syncUpstreamNow, pushNow };
};
