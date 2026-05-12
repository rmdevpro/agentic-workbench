'use strict';

const {
  readdir,
  readFile,
  writeFile,
  stat,
  mkdir,
  access,
  rename,
  rm,
  join,
  basename,
  express,
  fsp,
  KB_PATH,
} = require('./_shared');

function register(app, {
  safe,
  logger,
}) {
  // ── GET /api/mounts ────────────────────────────────────────────────────────

  app.get('/api/mounts', async (req, res) => {
    const mounts = [];
    // Always include the workspace
    const workspace = safe.WORKSPACE;
    mounts.push({ path: workspace });
    // Knowledge Base at KB_PATH (auto-cloned on startup if absent)
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
      const destPath = join(destination, basename(source));
      await rename(source, destPath);
      res.json({ ok: true, path: destPath });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── POST /api/files/list ───────────────────────────────────────────────────

  app.post('/api/files/list', async (req, res) => {
    const dirPath = req.body.path;
    if (!dirPath) return res.status(400).json({ error: 'path required' });
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

  // ── POST /api/mkdir ────────────────────────────────────────────────────────

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

  // ── POST /api/upload ───────────────────────────────────────────────────────

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
}

module.exports = { register };
