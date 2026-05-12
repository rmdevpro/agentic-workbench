'use strict';

const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { join } = require('path');

const logger = require('./logger');
const sharedState = require('./shared-state');
const db = require('./db');
const safe = require('./safe-exec');
const config = require('./config');
const sessionUtils = require('./session-utils');
const { fireEvent } = require('./webhooks');

const createKeepalive = require('./keepalive');
const createTmuxLifecycle = require('./tmux-lifecycle');
const createSessionResolver = require('./session-resolver');
const createWatchers = require('./watchers');
const createKbWatcher = require('./kb-watcher');
const createWsTerminal = require('./ws-terminal');
const registerCoreRoutes = require('./routes');
const { createQdrantSync } = require('./qdrant-sync');

// ── Configuration ───────────────────────────────────────────────────────────

// #348 [C6]: 7860 default matches the Dockerfile + HF spec instead of the
// legacy 3000 dev port. PORT=0 is preserved as the "OS-assign a port" sentinel
// for tests, so we check for explicit-undefined rather than falsiness.
const PORT = process.env.PORT !== undefined && process.env.PORT !== ''
  ? parseInt(process.env.PORT, 10)
  : 7860;
const CLAUDE_HOME = safe.CLAUDE_HOME;
const WORKSPACE = safe.WORKSPACE;
// Tmux lifecycle thresholds now live in config/defaults.json under "tmux.*".

// ── Global error handlers ───────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — exiting', {
    module: 'server',
    err: err.message,
    stack: err.stack ? err.stack.substring(0, 500) : undefined,
  });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', {
    module: 'server',
    err: reason instanceof Error ? reason.message : String(reason),
  });
});

// ── Construct modules with explicit deps ────────────────────────────────────

const keepalive = createKeepalive({ safe, config, logger });

const tmux = createTmuxLifecycle({ safe, config, logger });

const resolver = createSessionResolver({
  db,
  safe,
  config,
  tmuxName: tmux.tmuxName,
  tmuxExists: tmux.tmuxExists,
  sleep: tmux.sleep,
  logger,
});

const watchers = createWatchers({
  db,
  safe,
  config,
  sessionUtils,
  sessionWsClients: sharedState.sessionWsClients,
  tmuxName: tmux.tmuxName,
  tmuxExists: tmux.tmuxExists,
  CLAUDE_HOME,
  logger,
});

const kbWatcher = createKbWatcher({ db, logger, config });

const qdrantSync = createQdrantSync({ db, safe, config, logger });

const terminal = createWsTerminal({
  safe,
  keepalive,
  logger,
  config,
  sessionWsClients: sharedState.sessionWsClients,
  getBrowserCount: sharedState.getBrowserCount,
  incrementBrowserCount: sharedState.incrementBrowserCount,
  decrementBrowserCount: sharedState.decrementBrowserCount,
  tmuxExists: tmux.tmuxExists,
  cancelTmuxCleanup: tmux.cancelTmuxCleanup,
  scheduleTmuxCleanup: tmux.scheduleTmuxCleanup,
  startJsonlWatcher: watchers.startJsonlWatcher,
  stopJsonlWatcher: watchers.stopJsonlWatcher,
  db,
});

// Smart compaction removed — no kill callback needed

// ── Express setup ───────────────────────────────────────────────────────────

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Auth gate — auto-detects public HF Spaces + password mode ─────────────
let authMode = 'open'; // 'template' | 'password' | 'open'
const sessionTokens = new Set();

const GATE_USER = process.env.WORKBENCH_USER;
const GATE_PASS = process.env.WORKBENCH_PASS;

async function detectAuthMode() {
  // Password auth takes priority — if credentials are set, use them regardless of Space visibility
  if (GATE_USER && GATE_PASS) {
    authMode = 'password';
    return;
  }
  const spaceId = process.env.SPACE_ID;
  if (spaceId) {
    try {
      const headers = {};
      if (process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
      const res = await fetch(`https://huggingface.co/api/spaces/${spaceId}`, { headers });
      const data = await res.json();
      if (data.error || !data.private) { authMode = 'template'; return; }
    } catch {
      authMode = 'template'; return; // fail safe: assume public
    }
  }
  authMode = 'open';
}

function parseCookie(req, name) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

// #337 [A12]: cache the raw gate-page TEMPLATE at module load (one disk
// read), but inject the current authMode per-request via renderGatePage().
// Previous shape cached the rendered HTML with `mode: authMode` at boot,
// when authMode is still the initial 'open' value — `detectAuthMode()` runs
// later in startup, and the periodic re-detect at L306 can also flip it.
// Caching the rendered HTML meant password/template deployments served the
// wrong `__GATE_MODE__`. Codex Phase 1 gate review (High) flagged this.
const { loadGatePageTemplate, renderGatePage } = require('./gate-page');
const GATE_PAGE_TEMPLATE = loadGatePageTemplate({
  readFileSync: fs.readFileSync,
  gatePath: join(__dirname, '..', 'public', 'gate.html'),
  // No logger yet at boot. Use stderr so the operator still sees it in
  // `docker logs` if the file is missing or corrupt.
  onError: (err) => process.stderr.write(`[server.js] gate.html read failed at boot, falling back: ${err.message}\n`),
});

function serveGatePage(res) {
  res.type('html').send(renderGatePage(GATE_PAGE_TEMPLATE, authMode));
}

// #351 [D2]: per-IP token bucket for /api/gate/login. 10 attempts/minute,
// refill 1/6s. Rate-limit response is 429; failed-but-not-rate-limited gets a
// 500 ms async pause before responding to slow brute-force loops.
const _loginBuckets = new Map(); // ip → { tokens, lastRefill }
function _consumeLoginBucket(ip) {
  const now = Date.now();
  const refillRateMs = 6000; // 1 token per 6 seconds = 10/min steady state
  const cap = 10;
  let b = _loginBuckets.get(ip);
  if (!b) { b = { tokens: cap, lastRefill: now }; _loginBuckets.set(ip, b); }
  const elapsed = now - b.lastRefill;
  const refill = Math.floor(elapsed / refillRateMs);
  if (refill > 0) {
    b.tokens = Math.min(cap, b.tokens + refill);
    b.lastRefill = b.lastRefill + refill * refillRateMs;
  }
  if (b.tokens <= 0) return false;
  b.tokens -= 1;
  return true;
}

// Login endpoint for password mode
app.post('/api/gate/login', async (req, res) => {
  if (authMode !== 'password') return res.status(404).json({ error: 'not found' });
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (!_consumeLoginBucket(ip)) {
    return res.status(429).json({ error: 'too many attempts' });
  }
  const { username, password } = req.body;
  if (username === GATE_USER && password === GATE_PASS) {
    const token = crypto.randomBytes(32).toString('hex');
    sessionTokens.add(token);
    // #350 [D1]: secure: true when behind HTTPS (HF Spaces forwards x-forwarded-proto)
    // OR in production. Local docker-compose (HTTP, no gate) never reaches this path.
    const isHttps = req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
    res.cookie('wb_session', token, { httpOnly: true, sameSite: 'lax', secure: isHttps });
    res.json({ success: true });
  } else {
    // #351 [D2]: 500ms async pause on failed login to slow brute-force.
    await new Promise(r => setTimeout(r, 500));
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.use((req, res, next) => {
  if (authMode === 'open') return next();

  // Allow health checks
  if (req.path === '/api/health' || req.path === '/health') return next();
  // Allow gate assets
  if (['/workbench-preview.png', '/planlogo.png', '/favicon.ico'].includes(req.path)) return next();

  // Password mode: check session cookie
  if (authMode === 'password') {
    const token = parseCookie(req, 'wb_session');
    if (token && sessionTokens.has(token)) return next();
  }

  // Serve gate page
  serveGatePage(res);
});

app.use(express.static(join(__dirname, '..', 'public')));
app.use('/lib/xterm', express.static(join(__dirname, '..', 'node_modules/@xterm/xterm')));
app.use('/lib/xterm-fit', express.static(join(__dirname, '..', 'node_modules/@xterm/addon-fit')));
app.use(
  '/lib/xterm-web-links',
  express.static(join(__dirname, '..', 'node_modules/@xterm/addon-web-links')),
);
app.use('/lib/codemirror', express.static(join(__dirname, '..', 'public/lib/codemirror')));
app.use('/lib/toastui-editor', express.static(join(__dirname, '..', 'public/lib/toastui-editor')));

// ── Route registration ──────────────────────────────────────────────────────

const { checkAuthStatus } = registerCoreRoutes(app, {
  db,
  safe,
  config,
  sessionUtils,
  keepalive,
  fireEvent,
  logger,
  tmuxName: tmux.tmuxName,
  tmuxExists: tmux.tmuxExists,
  enforceTmuxLimit: tmux.enforceTmuxLimit,
  resolveSessionId: resolver.resolveSessionId,
  getBrowserCount: sharedState.getBrowserCount,
  CLAUDE_HOME,
  WORKSPACE,
  ensureSettings: watchers.ensureSettings,
  registerGeminiMcp: watchers.registerGeminiMcp,
  registerCodexProvider: watchers.registerCodexProvider,
  registerCodexAuth: watchers.registerCodexAuth,
  trustGeminiProjectDirs: watchers.trustGeminiProjectDirs,
  trustCodexProjectDirs: watchers.trustCodexProjectDirs,
  kbWatcher,
  qdrantSync,
  sleep: tmux.sleep,
});

// ── WebSocket upgrade handler ───────────────────────────────────────────────

function handleUpgrade(req, socket, head) {
  if (authMode === 'template') { socket.destroy(); return; }
  if (authMode === 'password') {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/wb_session=([a-f0-9]+)/);
    if (!match || !sessionTokens.has(match[1])) { socket.destroy(); return; }
  }
  const url = new URL(req.url, `http://${req.headers.host}`);

  const match = url.pathname.match(/^\/ws\/(.+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => terminal.handleTerminalConnection(ws, match[1]));
}

server.on('upgrade', handleUpgrade);

// ── Exports for testing ─────────────────────────────────────────────────────

module.exports = {
  parseSessionFile: sessionUtils.parseSessionFile,
  checkAuthStatus,
  tmuxName: tmux.tmuxName,
  tmuxExists: tmux.tmuxExists,
  sleep: tmux.sleep,
};

// ── Startup sequence ────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    try {
      await config.init();
      await detectAuthMode();
      logger.info('Auth mode detected', { module: 'server', authMode });
      // Re-check auth mode every 5 minutes (handles Space visibility changes)
      setInterval(detectAuthMode, 5 * 60 * 1000).unref();

      await watchers.ensureSettings();

      await tmux.cleanOrphanedTmuxSessions();
      // Bridge file cleanup removed — messaging replaced by tmux (#51)

      resolver.resolveStaleNewSessions().catch((err) =>
        logger.error('Startup stale-session resolution error', {
          module: 'server',
          err: err.message,
        }),
      );

      server.listen(PORT, '0.0.0.0', () => {
        logger.info('Workbench running', { module: 'server', port: PORT });
        keepalive.start();
        tmux.startPeriodicScan();
        watchers.startSettingsWatcher();
        watchers.startGeminiSettingsWatcher();
        watchers.startCodexSettingsWatcher();

        // Load API keys from DB settings into process env for CLI sessions
        try {
          const geminiKey = db.getSetting('gemini_api_key', '');
          if (geminiKey) {
            try { process.env.GEMINI_API_KEY = JSON.parse(geminiKey); } catch { process.env.GEMINI_API_KEY = geminiKey; }
          }
          const codexKey = db.getSetting('codex_api_key', '');
          if (codexKey) {
            try { process.env.OPENAI_API_KEY = JSON.parse(codexKey); } catch { process.env.OPENAI_API_KEY = codexKey; }
          }
          const hfKey = db.getSetting('huggingface_api_key', '');
          if (hfKey) {
            try { process.env.HF_TOKEN = JSON.parse(hfKey); } catch { process.env.HF_TOKEN = hfKey; }
          }
        } catch (err) {
          logger.warn('Failed to load API keys from settings', { module: 'server', err: err.message });
        }

        watchers.registerMcpServer().catch((err) =>
          logger.error('Post-startup MCP registration failed (Claude)', {
            module: 'server',
            err: err.message,
          }),
        );
        watchers.registerClaudeStatusLine().catch((err) =>
          logger.error('Post-startup Claude statusLine registration failed', {
            module: 'server',
            err: err.message,
          }),
        );
        kbWatcher.start().catch((err) =>
          logger.error('Post-startup KB watcher start failed', {
            module: 'server',
            err: err.message,
          }),
        );
        watchers.registerGeminiMcp().catch((err) =>
          logger.error('Post-startup MCP registration failed (Gemini)', {
            module: 'server',
            err: err.message,
          }),
        );
        watchers.registerCodexMcp().catch((err) =>
          logger.error('Post-startup MCP registration failed (Codex)', {
            module: 'server',
            err: err.message,
          }),
        );
        // #451: install workbench /session slash command equivalents for
        // Gemini (TOML) and Codex (Markdown) on every boot. Idempotent.
        watchers.registerGeminiSessionCommands().catch((err) =>
          logger.error('Post-startup Gemini session commands failed', {
            module: 'server',
            err: err.message,
          }),
        );
        watchers.registerCodexSessionSkills().catch((err) =>
          logger.error('Post-startup Codex session skills failed', {
            module: 'server',
            err: err.message,
          }),
        );
        watchers.registerCodexProvider().catch((err) =>
          logger.error('Post-startup Codex provider config failed', {
            module: 'server',
            err: err.message,
          }),
        );
        // #309: seed API-key-form auth.json after the provider config is set,
        // so the absence-guard's check is correct relative to the latest env.
        watchers.registerCodexAuth().catch((err) =>
          logger.error('Post-startup Codex auth seed failed', {
            module: 'server',
            err: err.message,
          }),
        );
        watchers.trustProjectDirs().catch((err) =>
          logger.error('Post-startup trust project dirs failed', {
            module: 'server',
            err: err.message,
          }),
        );
        watchers.trustCodexProjectDirs().catch((err) =>
          logger.error('Post-startup trust Codex project dirs failed', {
            module: 'server',
            err: err.message,
          }),
        );
        watchers.trustGeminiProjectDirs().catch((err) =>
          logger.error('Post-startup trust Gemini project dirs failed', {
            module: 'server',
            err: err.message,
          }),
        );

        // Start Qdrant vector sync (non-blocking — skips if Qdrant unavailable)
        qdrantSync.start().catch((err) =>
          logger.error('Qdrant sync startup error', {
            module: 'server',
            err: err.message,
          }),
        );

        // Auto-clone Knowledge Base on first run (non-blocking)
        const { execFile } = require('child_process');
        const { promisify } = require('util');
        const execFileAsync = promisify(execFile);
        const { KB_PATH, KB_UPSTREAM_URL } = require('./constants');
        const { stat: fsStat } = require('fs/promises');
        fsStat(KB_PATH).catch(async () => {
          const rawUrl = db.getSetting('kb_repo_url', `"${KB_UPSTREAM_URL}"`);
          let kbRepoUrl;
          try { kbRepoUrl = JSON.parse(rawUrl); } catch { kbRepoUrl = rawUrl; }
          logger.info('Cloning Knowledge Base', { module: 'server', url: kbRepoUrl });
          try {
            await execFileAsync('git', ['clone', kbRepoUrl, KB_PATH]);
            // Always set up `upstream` pointing at the public KB so
            // `Sync from upstream` works whether or not the user has forked.
            // After fork, /api/kb/fork rewrites `origin` and leaves `upstream`
            // unchanged.
            await execFileAsync('git', ['-C', KB_PATH, 'remote', 'add', 'upstream', KB_UPSTREAM_URL]).catch(() => {});
            logger.info('Knowledge Base cloned', { module: 'server' });
          } catch (err) {
            logger.error('Knowledge Base clone failed', { module: 'server', err: err.message });
          }
        });

        // KB polling sync — fetch + ff-merge on configurable interval
        let _kbSyncTimer = null;
        function startKbSyncPoller() {
          if (_kbSyncTimer) clearInterval(_kbSyncTimer);
          let rawInterval = db.getSetting('kb_sync_interval_minutes', '5');
          let minutes;
          try { minutes = parseInt(JSON.parse(rawInterval), 10); } catch { minutes = 5; }
          if (!minutes || minutes < 1) minutes = 5;
          _kbSyncTimer = setInterval(async () => {
            try {
              await fsStat(join(KB_PATH, '.git'));
            } catch (_e) { return; }
            // #317: KB account lookup via the centralized helper. Token used
            // per-call via http.extraheader; never embedded in remote URL.
            const gitAuth = require('./git-auth');
            const acc = gitAuth.kbAccount(db);
            if (!acc) return;
            const authArgs = gitAuth.gitAuthArgs(acc.token || '');
            try {
              await execFileAsync('git', ['-C', KB_PATH, ...authArgs, 'fetch', 'origin']);
              await execFileAsync('git', ['-C', KB_PATH, 'merge', '--ff-only', 'origin/main']);
              logger.debug('KB sync: pulled from origin', { module: 'server' });
            } catch (err) {
              logger.warn('KB sync: ff-merge skipped', { module: 'server', err: err.message });
            }
          }, minutes * 60 * 1000);
        }
        startKbSyncPoller();
      });
    } catch (err) {
      logger.error('Fatal startup error', {
        module: 'server',
        err: err.message,
        stack: err.stack ? err.stack.substring(0, 500) : undefined,
      });
      process.exit(1);
    }
  })();
}
