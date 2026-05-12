'use strict';

const {
  readdir,
  stat,
  join,
  execFileAsync,
  KB_PATH,
  KB_UPSTREAM_URL,
  KB_UPSTREAM_OWNER_REPO,
  gitAuth,
} = require('./_shared');

function register(app, {
  db,
  logger,
  kbWatcher,
}) {
  // ── KB helpers ───────────────────────────────────────────────────────────────
  // KB_PATH and KB_UPSTREAM_URL imported from _shared.
  const KB_UPSTREAM = KB_UPSTREAM_URL;

  // #317: KB account is just a row in git_accounts with isKB=true. Lookup by
  // path prefix (e.g., 'github.com/jmdrumsgarrison-ux'). The token stays in
  // DB; URLs do NOT carry it. Auth happens per-call via http.extraheader.
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

  // ── POST /api/kb/init ─────────────────────────────────────────────────────

  app.post('/api/kb/init', async (req, res) => {
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
    const kbRepoUrl = db.getSetting('kb_repo_url', `"${KB_UPSTREAM_URL}"`);
    try {
      await execFileAsync('git', ['clone', kbRepoUrl, KB_PATH]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: `Clone failed: ${err.message}` });
    }
  });

  // ── GET /api/kb/status ────────────────────────────────────────────────────

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
      const forkRes = await fetch(`https://api.${host}/repos/${KB_UPSTREAM_OWNER_REPO}/forks`, {
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

  // ── GET /api/kb/roles ─────────────────────────────────────────────────────

  app.get('/api/kb/roles', async (req, res) => {
    const rolesDir = join(KB_PATH, 'roles');
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

  // ── GET /api/issues ───────────────────────────────────────────────────────
  // #314: list GitHub issues for a repo, scoped via the path-keyed account
  // token (#317). Used by the task editor's issue picker. Caches per-repo
  // for 60s to keep typing-storm-friendly without rate-limit pressure.
  const _issuesCache = new Map(); // key: repo+state → { fetchedAt, items }
  const _ISSUES_TTL_MS = 60 * 1000;
  app.get('/api/issues', async (req, res) => {
    const repo = String(req.query.repo || '');  // 'owner/name' (defaults to github.com) or 'host/owner/name' (explicit host)
    const state = String(req.query.state || 'open').toLowerCase();
    const q = String(req.query.q || '').toLowerCase();

    // #328 [A3]: accept extended 3-part form for GitHub Enterprise repos.
    //   owner/name             → host = github.com (back-compat)
    //   host/owner/name        → explicit host (e.g. enterprise.example.com/owner/repo)
    const repoParts = repo.split('/').filter(Boolean);
    let ghHost, owner, name;
    if (repoParts.length === 2) {
      ghHost = 'github.com';
      [owner, name] = repoParts;
    } else if (repoParts.length === 3) {
      [ghHost, owner, name] = repoParts;
    } else {
      return res.status(400).json({ error: 'repo must be owner/name or host/owner/name' });
    }
    const path = `${ghHost}/${owner}`;
    const account = gitAuth.accountForPath(db, path);
    if (!account) return res.status(404).json({ error: `no_account_for_path: ${path}` });

    // #328 [A3]: derive the GraphQL API URL from the host. github.com uses
    // a separate api.* hostname; GitHub Enterprise serves GraphQL at the
    // same host under /api/graphql.
    const apiUrl = ghHost === 'github.com'
      ? 'https://api.github.com/graphql'
      : `https://${ghHost}/api/graphql`;

    const cacheKey = `${repo}\x00${state}`;
    const cached = _issuesCache.get(cacheKey);
    let items;
    if (cached && Date.now() - cached.fetchedAt < _ISSUES_TTL_MS) {
      items = cached.items;
    } else {
      const stateFilter = state === 'all' ? '[OPEN, CLOSED]' : state === 'closed' ? '[CLOSED]' : '[OPEN]';
      // #328 [A3]: GraphQL variables for owner/name. Previous code used
      // string interpolation — a repo or owner with a `"` in its name
      // broke the query (and would also be an injection vector if repo
      // input weren't already path-validated upstream).
      const query = `query($o: String!, $n: String!) {
        repository(owner: $o, name: $n) {
          issues(states: ${stateFilter}, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes { number title state labels(first: 5) { nodes { name color } } updatedAt }
          }
        }
      }`;
      const variables = { o: owner, n: name };
      try {
        const ghRes = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${account.token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'workbench/issues-picker',
          },
          body: JSON.stringify({ query, variables }),
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
        // #328 [A3]: include the API host in the error so GHES routing
        // bugs are visible (Node's fetch wraps the underlying network
        // error in a `cause` chain that doesn't surface in err.message).
        const causeMsg = err.cause && err.cause.message ? `: ${err.cause.message}` : '';
        return res.status(502).json({ error: `GitHub API request to ${apiUrl} failed: ${err.message}${causeMsg}` });
      }
    }
    if (q) items = items.filter(i => i.title.toLowerCase().includes(q));
    res.json({ repo, owner, name, count: items.length, items });
  });
}

module.exports = { register };
