'use strict';

const {
  execFileAsync,
  gitAuth,
} = require('./_shared');

function register(app, {
  db,
  logger,
}) {
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

  // ── GET /api/projects/:name/git-remote ────────────────────────────────────
  // #329 [A4]: derive {host, owner, name, repo} from `git remote get-url origin`
  // for the named project. Used by the frontend issue picker so it stops
  // hardcoding `rmdevpro/<repo>`. The returned `repo` is in the 3-part form
  // `host/owner/name` consumable by /api/issues directly.

  app.get('/api/projects/:name/git-remote', async (req, res) => {
    try {
      const projectName = req.params.name;
      const project = db.getProject(projectName);
      if (!project) return res.status(404).json({ error: 'project not found' });
      let remoteUrl;
      try {
        const { stdout } = await execFileAsync('git', ['-C', project.path, 'remote', 'get-url', 'origin'], { timeout: 5000 });
        remoteUrl = stdout.trim();
      } catch (err) {
        return res.status(404).json({ error: 'no_git_remote', detail: err.message.slice(0, 200) });
      }
      const parts = gitAuth.repoPartsFromUrl(remoteUrl);
      if (!parts) return res.status(422).json({ error: 'unparseable_remote_url', remote: remoteUrl });
      const repo = `${parts.host}/${parts.owner}/${parts.name}`;
      res.json({ host: parts.host, owner: parts.owner, name: parts.name, repo, remote: remoteUrl });
    } catch (err) {
      logger.error('git-remote endpoint error', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { register };
