'use strict';

const {
  readFile,
  writeFile,
  stat,
  rm,
  join,
  basename,
  PROJECT_NAME_MAX_LEN,
  createTrustDir,
} = require('./_shared');

function register(app, {
  db,
  safe,
  fireEvent,
  logger,
  tmuxName,
  CLAUDE_HOME,
  WORKSPACE,
  trustGeminiProjectDirs,
  trustCodexProjectDirs,
  sessionUtils,
}) {
  // trustDir is provided by sessions module; we re-implement a local reference
  // here since cascadeCleanupProject needs it and we can't easily share the
  // closure from sessions. Duplicate of the sessions version intentionally to
  // keep modules independent. checkAuthStatus / trustDir are the only two
  // helpers that sessions re-exports.
  // Actually, cascadeCleanupProject only needs CLAUDE_HOME + readFile/writeFile;
  // it doesn't call the sessions trustDir function. We replicate the minimal
  // piece needed (delete from .claude.json) inline.

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
    // 6. #336 [A11] (Codex Phase 1 gate fold-back): remove the project's
    // own .mcp.json so reusing the path later doesn't preserve stale
    // project-scoped MCP server registrations from the old project. Also
    // strip the project from the workbench's mcp_project_enabled DB table
    // so the registry doesn't hold a stale reference.
    try {
      const projectMcpFile = join(project.path, '.mcp.json');
      await rm(projectMcpFile, { force: true });
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Failed to remove project .mcp.json', {
          module: 'routes', op: 'cascadeCleanupProject', err: err.message,
        });
      }
    }
    try {
      if (typeof db.clearProjectMcpEnabled === 'function') {
        db.clearProjectMcpEnabled(project.id);
      }
    } catch (err) {
      logger.warn('Failed to clear mcp_project_enabled rows', {
        module: 'routes', op: 'cascadeCleanupProject', err: err.message,
      });
    }
  }

  const trustDir = createTrustDir({ CLAUDE_HOME, logger });

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

  app.post('/api/projects/:name/remove', async (req, res) => {
    try {
      const project = db.getProject(req.params.name);
      if (!project) return res.status(404).json({ error: 'project not found' });
      await cascadeCleanupProject(project);
      db.deleteProject(project.id);
      // #372 [E2] (Claude R2 F1): invalidate per-CLI discovery caches —
      // cascade removed JSONLs/rollouts may still appear in the cached
      // discovery results until the 10s TTL expires otherwise.
      sessionUtils.invalidateDiscoveryCache();
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
    let cleanName = null;
    if (name !== undefined) {
      cleanName = String(name).trim();
      if (!cleanName) return res.status(400).json({ error: 'name cannot be empty' });
    }
    if (status !== undefined && !['active', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    // #332 [A7]: atomic rename — db.renameProgramSafe wraps the dup check and
    // UPDATE in one SQLite transaction so concurrent PUTs can't both win.
    let updated = program;
    if (cleanName !== null && cleanName !== program.name) {
      try {
        updated = db.renameProgramSafe(id, cleanName);
      } catch (e) {
        if (e.code === 'duplicate_name') {
          return res.status(409).json({ error: 'program with that name already exists' });
        }
        throw e;
      }
    }
    const otherFields = {};
    if (description !== undefined) otherFields.description = String(description);
    if (status !== undefined) otherFields.status = status;
    if (Object.keys(otherFields).length) {
      updated = db.updateProgram(id, otherFields);
    }
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
}

module.exports = { register };
