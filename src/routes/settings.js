'use strict';

const {
  readFile,
  writeFile,
  join,
  fsp,
  pathResolve,
  KB_UPSTREAM_URL,
  _parseSince,
} = require('./_shared');

function register(app, {
  db,
  safe,
  logger,
  getBrowserCount,
  CLAUDE_HOME,
  WORKSPACE,
  keepalive,
  registerGeminiMcp,
  registerCodexProvider,
  registerCodexAuth,
  qdrantSync,
  stateEngine,
}) {
  // #651 commit 7c: settings changes that affect per-session state must
  // publish through the State Engine. Today the only such setting is
  // codex_api_key (toggles `codex_api_key_set` on every Codex session);
  // #657 commit 18 will refine this into a proper `auth_mode` per session.
  function _se(method, ...args) {
    if (!stateEngine) return;
    try {
      stateEngine[method](...args);
    } catch (err) {
      logger.warn('state-engine call failed', {
        module: 'routes', op: method, err: err.message,
      });
    }
  }

  function _publishCodexApiKeyChange(keySet) {
    if (!stateEngine) return;
    try {
      const projects = db.getProjects ? db.getProjects() : [];
      for (const proj of projects) {
        const sessions = (db.getSessionsForProject && db.getSessionsForProject(proj.id)) || [];
        for (const s of sessions) {
          if ((s.cli_type || 'claude') === 'codex') {
            _se('updateSession', s.id, { codex_api_key_set: !!keySet });
          }
        }
      }
    } catch (err) {
      logger.warn('codex_api_key state-engine fan-out failed', {
        module: 'routes', err: err.message,
      });
    }
  }
  // ── GET /api/settings ──────────────────────────────────────────────────────

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
      kb_repo_url: KB_UPSTREAM_URL,
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
        const qdrant = qdrantSync;
        const cfg = await qdrant.buildCandidateConfig(key, value);
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
      // #651 commit 7c: publish the codex_api_key change to every Codex
      // session so the engine + WS subscribers see the auth surface flip.
      // #657 commit 18 will replace this stub with full auth_mode semantics.
      _publishCodexApiKeyChange(!!value);
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
      const qdrant = qdrantSync;
      qdrant.reapplyConfig({ dropCollections: key === 'vector_embedding_provider' })
        .catch(err =>
          logger.warn('qdrant.reapplyConfig after settings change failed', { module: 'routes', settingKey: key, err: err.message })
        );
    }
    res.json({ saved: true });
  });

  // ── CLI Credentials Check ─────────────────────────────────────────────────

  app.get('/api/cli-credentials', async (req, res) => {
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
      const projectPath = dbProj ? dbProj.path : join(WORKSPACE || safe.WORKSPACE || '', req.params.name);
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
      const projectPath = dbProj ? dbProj.path : join(WORKSPACE || safe.WORKSPACE || '', req.params.name);
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
}

module.exports = { register };
