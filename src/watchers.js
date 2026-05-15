'use strict';

const fsp = require('fs/promises');
const fs = require('fs');
const { join, basename } = require('path');
const { CODEX_ROLLOUT_UUID_RE } = require('./constants');

module.exports = function createWatchers({
  db,
  safe,
  config,
  sessionUtils,
  sessionWsClients,
  tmuxName,
  tmuxExists,
  CLAUDE_HOME,
  logger,
}) {
  const jsonlWatchPaths = new Map();
  const jsonlDebounceTimers = new Map();

  // #143: shared file-attach helper. Used for Claude (file path is deterministic
  // from session id) and Gemini/Codex (file path is resolved via discover-*
  // helpers once cli_session_id is set).
  function _attachJsonlWatcher(tmuxSession, filePath, session, project) {
    jsonlWatchPaths.set(tmuxSession, {
      jsonlPath: filePath,
      sessionId: session.id,
      projectPath: project.path,
      projectName: project.name,
    });

    fs.watchFile(filePath, { persistent: false, interval: 2000 }, () => {
      const entry = jsonlWatchPaths.get(tmuxSession);
      if (!entry) return;

      if (jsonlDebounceTimers.has(tmuxSession)) clearTimeout(jsonlDebounceTimers.get(tmuxSession));
      jsonlDebounceTimers.set(
        tmuxSession,
        setTimeout(async () => {
          jsonlDebounceTimers.delete(tmuxSession);
          try {
            const usage = await sessionUtils.getTokenUsage(entry.sessionId, entry.projectPath);
            const ws = sessionWsClients.get(tmuxSession);
            if (ws && ws.readyState === 1 /* WebSocket.OPEN */) {
              ws.send(JSON.stringify({ type: 'token_update', data: usage }));
            }
            // Simple 75% nudge — replaces smart compaction
            const pct = usage.max_tokens > 0 ? (usage.input_tokens / usage.max_tokens) * 100 : 0;
            checkContextUsage(entry.sessionId, pct);
          } catch (err) {
            if (err.code === 'ENOENT') {
              logger.debug('JSONL file removed during watcher callback', {
                module: 'watchers',
                sessionId: entry.sessionId.substring(0, 8),
              });
              return;
            }
            logger.error('JSONL watcher callback error', {
              module: 'watchers',
              op: 'startJsonlWatcher',
              err: err.message,
            });
          }
        }, 500),
      );
    });
  }

  // #143: Gemini/Codex don't write a JSONL with a deterministic name — their
  // session file is at ~/.gemini/tmp/<cwd-hash>/chats/<cli_session_id>.json or
  // ~/.codex/sessions/<rollup>/<rollout>.jsonl, and cli_session_id isn't set
  // until the CLI writes its first message and the discoverer binds it to the
  // workbench session row. Poll up to 60s for both cli_session_id AND the file
  // to appear, then attach the watcher. Without this, Gemini/Codex sessions
  // appear frozen in the UI (no live token updates).
  function _resolveAndWatchNonClaude(tmuxSession, sessionId, project, cliType, attempt) {
    const fresh = db.getSession(sessionId);
    if (!fresh) return;
    let filePath = null;
    if (fresh.cli_session_id) {
      try {
        if (cliType === 'gemini') {
          const found = sessionUtils.discoverGeminiSessions().find(s => s.sessionId === fresh.cli_session_id);
          filePath = found?.filePath || null;
        } else if (cliType === 'codex') {
          const found = sessionUtils.discoverCodexSessions().find(s => {
            const rolloutName = basename(s.filePath, '.jsonl');
            const m = rolloutName.match(CODEX_ROLLOUT_UUID_RE);
            return (m ? m[1] : rolloutName) === fresh.cli_session_id;
          });
          filePath = found?.filePath || null;
        }
      } catch (err) {
        logger.debug('Non-Claude session file resolution error', { module: 'watchers', err: err.message });
      }
    }
    if (filePath) {
      _attachJsonlWatcher(tmuxSession, filePath, fresh, project);
      return;
    }
    if (attempt >= 20) {
      logger.debug('JSONL watcher gave up resolving non-Claude session file', {
        module: 'watchers', sessionId: sessionId.substring(0, 8), cliType,
      });
      return;
    }
    setTimeout(() => _resolveAndWatchNonClaude(tmuxSession, sessionId, project, cliType, attempt + 1), 3000);
  }

  function startJsonlWatcher(tmuxSession) {
    const prefix = tmuxSession.replace(/^wb_/, '');
    if (prefix.startsWith('new_') || prefix.startsWith('t_')) return;

    const session = db.getSessionByPrefix(prefix);
    if (!session) return;

    const project = db.getProjectById(session.project_id);
    if (!project) return;

    const cliType = session.cli_type || 'claude';

    if (cliType === 'claude') {
      const jsonlPath = join(safe.findSessionsDir(project.path), `${session.id}.jsonl`);
      _attachJsonlWatcher(tmuxSession, jsonlPath, session, project);
      return;
    }

    if (cliType === 'gemini' || cliType === 'codex') {
      _resolveAndWatchNonClaude(tmuxSession, session.id, project, cliType, 0);
      return;
    }
    // bash and others — no session-file watcher needed (no token tracking).
  }

  function stopJsonlWatcher(tmuxSession) {
    const entry = jsonlWatchPaths.get(tmuxSession);
    if (entry) {
      fs.unwatchFile(entry.jsonlPath);
      jsonlWatchPaths.delete(tmuxSession);
    }
    if (jsonlDebounceTimers.has(tmuxSession)) {
      clearTimeout(jsonlDebounceTimers.get(tmuxSession));
      jsonlDebounceTimers.delete(tmuxSession);
    }
  }

  let settingsWatcherActive = false;
  function startSettingsWatcher() {
    if (settingsWatcherActive) return;
    const settingsPath = join(CLAUDE_HOME, 'settings.json');
    fs.watchFile(settingsPath, { persistent: false, interval: 5000 }, async () => {
      try {
        const data = JSON.parse(await fsp.readFile(settingsPath, 'utf-8'));
        const update = JSON.stringify({
          type: 'settings_update',
          model: data.model || null,
          effortLevel: data.effortLevel || null,
        });
        for (const ws of sessionWsClients.values()) {
          if (ws.readyState === 1) ws.send(update);
        }
      } catch (err) {
        if (err.code === 'ENOENT') {
          /* expected: settings file may not exist yet */
        } else if (err instanceof SyntaxError) {
          logger.warn('Settings file contains invalid JSON', {
            module: 'watchers',
            op: 'startSettingsWatcher',
          });
        } else {
          logger.error('Settings watcher error', {
            module: 'watchers',
            op: 'startSettingsWatcher',
            err: err.message,
          });
        }
      }
    });
    settingsWatcherActive = true;
  }

  // Simple context usage nudge — fires once per session at 75%
  const nudgeSent = new Set();
  function checkContextUsage(sessionId, pct) {
    if (nudgeSent.has(sessionId)) return;
    const threshold = config.get('session.nudgeThresholdPercent', 75);
    if (pct >= threshold) {
      nudgeSent.add(sessionId);
      const tmux = tmuxName(sessionId);
      tmuxExists(tmux).then(exists => {
        if (exists) {
          safe.tmuxSendKeysAsync(tmux, config.getPrompt('session-nudge', { PERCENT: pct.toFixed(0) }));
        }
      });
    }
  }

  async function registerMcpServer() {
    const settingsFile = join(CLAUDE_HOME, 'settings.json');
    let cfg = {};
    try {
      cfg = JSON.parse(await fsp.readFile(settingsFile, 'utf-8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        /* expected: settings file not yet created — will be initialized */
      } else if (err instanceof SyntaxError) {
        logger.error(
          'settings.json is corrupt — cannot register MCP server without overwriting user config',
          { module: 'watchers', op: 'registerMcpServer' },
        );
        return;
      } else {
        logger.warn('Failed to read settings.json for MCP', {
          module: 'watchers',
          op: 'registerMcpServer',
          err: err.message,
        });
      }
    }

    if (!cfg.mcpServers) cfg.mcpServers = {};
    const expectedArgs = [join(__dirname, 'mcp-server.js')];
    const existing = cfg.mcpServers.workbench;
    const isStale = existing && (
      !existing.command ||
      (existing.args && existing.args[0] !== expectedArgs[0])
    );

    if (!existing || isStale) {
      cfg.mcpServers.workbench = {
        command: 'node',
        args: expectedArgs,
      };
      try {
        await fsp.writeFile(settingsFile, JSON.stringify(cfg, null, 2));
        logger.info('Registered Workbench MCP server', { module: 'watchers' });
      } catch (err) {
        logger.error('Could not write MCP configuration', {
          module: 'watchers',
          op: 'registerMcpServer',
          err: err.message,
        });
      }
    }

    // #572: also patch the user-scope ~/.claude/.claude.json's
    // mcpServers.workbench block. entrypoint.sh seeds this via
    // `claude mcp add-json --scope user`, but if a prior workbench build
    // wrote a stale args path (e.g., /app/mcp-server.js before the C0
    // src/ refactor moved the file to /app/src/mcp-server.js), Claude
    // surfaces a "Conflicting scopes" warning because user and project
    // scopes disagree on the workbench server's endpoint. Repair the same
    // way settings.json above is repaired: read, detect stale args path,
    // rewrite. Idempotent — no-op when already canonical.
    const claudeJsonFile = join(CLAUDE_HOME, '.claude.json');
    let claudeJsonCfg = null;
    try {
      claudeJsonCfg = JSON.parse(await fsp.readFile(claudeJsonFile, 'utf-8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        return; // no .claude.json yet — entrypoint will seed it
      }
      if (err instanceof SyntaxError) {
        logger.error(
          '.claude.json is corrupt — skipping user-scope MCP repair',
          { module: 'watchers', op: 'registerMcpServer' },
        );
        return;
      }
      logger.warn('Failed to read .claude.json for user-scope MCP repair', {
        module: 'watchers',
        op: 'registerMcpServer',
        err: err.message,
      });
      return;
    }

    if (!claudeJsonCfg.mcpServers) claudeJsonCfg.mcpServers = {};
    const userExisting = claudeJsonCfg.mcpServers.workbench;
    const userIsStale = userExisting && (
      !userExisting.command ||
      (Array.isArray(userExisting.args) && userExisting.args[0] !== expectedArgs[0])
    );
    if (!userExisting || userIsStale) {
      claudeJsonCfg.mcpServers.workbench = {
        command: 'node',
        args: expectedArgs,
      };
      try {
        await fsp.writeFile(claudeJsonFile, JSON.stringify(claudeJsonCfg, null, 2));
        if (userIsStale) {
          logger.info('Repaired stale Workbench MCP server entry in user-scope .claude.json', {
            module: 'watchers',
            op: 'registerMcpServer',
            previousArgs: userExisting.args,
            expectedArgs,
          });
        } else {
          logger.info('Seeded Workbench MCP server in user-scope .claude.json', {
            module: 'watchers',
            op: 'registerMcpServer',
          });
        }
      } catch (err) {
        logger.error('Could not write user-scope .claude.json MCP entry', {
          module: 'watchers',
          op: 'registerMcpServer',
          err: err.message,
        });
      }
    }
  }

  async function registerGeminiMcp() {
    const HOME = safe.HOME;
    const geminiSettingsFile = join(HOME, '.gemini', 'settings.json');
    let cfg = {};
    try {
      cfg = JSON.parse(await fsp.readFile(geminiSettingsFile, 'utf-8'));
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) {
        logger.warn('Failed to read Gemini settings.json', { module: 'watchers', err: err.message });
      }
    }

    if (!cfg.mcpServers) cfg.mcpServers = {};
    const expectedArgs = [join(__dirname, 'mcp-server.js')];
    const existing = cfg.mcpServers.workbench;
    const isStale = existing && (
      !existing.command ||
      (existing.args && existing.args[0] !== expectedArgs[0])
    );

    let needsWrite = false;
    if (!existing || isStale) {
      cfg.mcpServers.workbench = { command: 'node', args: expectedArgs };
      needsWrite = true;
    }

    // Seed selectedType so the CLI doesn't open its auth-method menu when
    // GEMINI_API_KEY is already in env. The CLI gates that menu on
    // settings.merged.security.auth.selectedType === undefined; just exporting
    // the env var isn't enough. Only write when undefined — preserve any
    // manual choice (e.g. user ran /auth and picked oauth-personal).
    if (process.env.GEMINI_API_KEY) {
      if (!cfg.security) cfg.security = {};
      if (!cfg.security.auth) cfg.security.auth = {};
      if (cfg.security.auth.selectedType === undefined) {
        cfg.security.auth.selectedType = 'gemini-api-key';
        needsWrite = true;
      }
    }

    if (needsWrite) {
      try {
        await fsp.mkdir(join(HOME, '.gemini'), { recursive: true });
        await fsp.writeFile(geminiSettingsFile, JSON.stringify(cfg, null, 2));
        logger.info('Updated Gemini settings.json', { module: 'watchers' });
      } catch (err) {
        logger.error('Could not write Gemini config', { module: 'watchers', err: err.message });
      }
    }
  }

  // Configure Codex CLI to use OPENAI_API_KEY from env without launching the
  // ChatGPT OAuth flow. The default `openai` model_provider does not honor
  // env-var auth — per OpenAI's own docs, the supported way is a custom
  // model_provider block in ~/.codex/config.toml with `env_key` and
  // `requires_openai_auth = false`. The key never lands in any file we write.
  // Idempotent: skip if our [model_providers.openai-api] block is already
  // present (preserves user choice).
  async function registerCodexProvider() {
    const HOME = safe.HOME;
    const codexConfigFile = join(HOME, '.codex', 'config.toml');
    if (!process.env.OPENAI_API_KEY) return;

    let content = '';
    try {
      content = await fsp.readFile(codexConfigFile, 'utf-8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Failed to read codex config.toml for provider seed', { module: 'watchers', err: err.message });
        return;
      }
    }

    if (content.includes('[model_providers.openai-api]')) return;

    const providerBlock = `\n[model_providers.openai-api]\nname = "OpenAI (API key from env)"\nbase_url = "https://api.openai.com/v1"\nwire_api = "responses"\nenv_key = "OPENAI_API_KEY"\nrequires_openai_auth = false\n`;

    // TOML rule: top-level keys must come before any [section]. Split the
    // existing file at its first section so we can update model_provider in
    // the top-level area without accidentally rewriting a section key.
    const sectionStart = content.search(/^\[/m);
    const splitAt = sectionStart >= 0 ? sectionStart : content.length;
    const topLevel = content.slice(0, splitAt);
    const sections = content.slice(splitAt);

    const mpRegex = /^model_provider\s*=\s*"[^"]*"\s*$/m;
    const newTopLevel = mpRegex.test(topLevel)
      ? topLevel.replace(mpRegex, 'model_provider = "openai-api"')
      : `model_provider = "openai-api"\n${topLevel ? '\n' + topLevel : ''}`;

    const newContent = (newTopLevel + sections).trimEnd() + '\n' + providerBlock;

    try {
      await fsp.mkdir(join(HOME, '.codex'), { recursive: true });
      await fsp.writeFile(codexConfigFile, newContent);
      logger.info('Configured Codex API-key provider in config.toml', { module: 'watchers' });
    } catch (err) {
      logger.error('Could not write Codex provider config', { module: 'watchers', err: err.message });
    }
  }

  // #309: seed Codex's API-key-form auth.json when an OPENAI_API_KEY is
  // available and no auth.json exists yet. Codex's `codex login --with-api-key`
  // is a one-shot CLI that reads the key from stdin and writes
  //   { "auth_mode": "apikey", "OPENAI_API_KEY": "sk-..." }
  // and exits. Without this, the absence of an API-key-form auth.json (or the
  // presence of a stale chatgpt-form one with expired tokens) causes
  // codex_apps MCP and per-turn discoverable-tool calls to 401-loop, driving
  // a 25 MB/sec write storm via Codex's TRACE-logging + inotify watcher
  // rooted at $HOME=/data.
  //
  // Guard: only seed when auth.json is absent. That preserves any prior user
  // choice (live OAuth, manual /login, anything else). If the user wants to
  // re-seed they can delete auth.json (or run `codex logout`).
  async function registerCodexAuth() {
    const HOME = safe.HOME;
    const authFile = join(HOME, '.codex', 'auth.json');
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return;
    try {
      await fsp.access(authFile);
      // File exists — preserve user's prior choice. No-op.
      return;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Failed to stat codex auth.json', { module: 'watchers', err: err.message });
        return;
      }
      // ENOENT — fall through to seed.
    }
    try {
      await fsp.mkdir(join(HOME, '.codex'), { recursive: true });
    } catch (err) {
      logger.warn('Could not create ~/.codex dir', { module: 'watchers', err: err.message });
      return;
    }
    // Spawn codex login --with-api-key, write key to stdin, close. Codex
    // writes auth.json itself; workbench is the caller, not the writer.
    // Per `reference_execfile_drops_stdio.md`: must use spawn (not execFile)
    // for stdio control.
    const { spawn } = require('child_process');
    await new Promise((resolve) => {
      const child = spawn('codex', ['login', '--with-api-key'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (b) => { stdout += b.toString(); });
      child.stderr?.on('data', (b) => { stderr += b.toString(); });
      child.on('error', (err) => {
        logger.warn('codex login --with-api-key spawn failed', { module: 'watchers', err: err.message });
        resolve();
      });
      child.on('close', (code) => {
        if (code === 0) {
          logger.info('Seeded Codex auth.json via `codex login --with-api-key`', { module: 'watchers' });
        } else {
          logger.warn('codex login --with-api-key exited non-zero', {
            module: 'watchers', code, stdout: stdout.slice(0, 200), stderr: stderr.slice(0, 200),
          });
        }
        resolve();
      });
      try {
        child.stdin.write(apiKey + '\n');
      } catch (err) {
        logger.warn('codex login stdin write failed', { module: 'watchers', err: err.message });
      } finally {
        child.stdin.end();
      }
    });
  }

  async function registerCodexMcp() {
    const HOME = safe.HOME;
    const codexConfigFile = join(HOME, '.codex', 'config.toml');
    const expectedArgsPath = join(__dirname, 'mcp-server.js');
    const expectedBlock = `\n[mcp_servers.workbench]\ncommand = "node"\nargs = ["${expectedArgsPath}"]\n`;
    try {
      let content = '';
      try {
        content = await fsp.readFile(codexConfigFile, 'utf-8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }

      // #565: the prior existence-only check left stale args paths in place
      // when an older workbench build had seeded e.g. `mcp-stdio-server.js`.
      // Parse the existing block (if any) and rewrite when the args path
      // doesn't match the current source layout. Mirrors the Claude /
      // Gemini stale-detection at lines ~225 and ~265.
      const blockHeader = '[mcp_servers.workbench]';
      const headerIdx = content.indexOf(blockHeader);
      if (headerIdx >= 0) {
        // Block spans from the header to the next top-level `[...]` section
        // or EOF, whichever comes first.
        const after = content.slice(headerIdx + blockHeader.length);
        const nextHeaderMatch = after.match(/\n\[[^\]]+\]/);
        const blockEnd = nextHeaderMatch
          ? headerIdx + blockHeader.length + nextHeaderMatch.index
          : content.length;
        const existingBlock = content.slice(headerIdx, blockEnd);
        if (existingBlock.includes(expectedArgsPath)) return; // already correct
        // Stale: strip the existing block + any leading blank line, then
        // append the correct one. Preserve everything else in the TOML.
        let prefix = content.slice(0, headerIdx);
        if (prefix.endsWith('\n')) prefix = prefix.slice(0, -1);
        const suffix = content.slice(blockEnd);
        const repaired = prefix + suffix + expectedBlock;
        await fsp.mkdir(join(HOME, '.codex'), { recursive: true });
        await fsp.writeFile(codexConfigFile, repaired);
        logger.info('Repaired stale Workbench MCP server entry for Codex', {
          module: 'watchers',
          op: 'registerCodexMcp',
          expectedArgsPath,
        });
        return;
      }

      // No existing block — append fresh.
      await fsp.mkdir(join(HOME, '.codex'), { recursive: true });
      await fsp.appendFile(codexConfigFile, expectedBlock);
      logger.info('Registered Workbench MCP server for Codex', { module: 'watchers' });
    } catch (err) {
      logger.error('Could not write Codex MCP config', { module: 'watchers', err: err.message });
    }
  }

  // #143: mirror of trustProjectDirs but for Gemini. Gemini stores trusted
  // directories in ~/.gemini/trustedFolders.json as a flat object:
  // `{"<exact-path>": "TRUST_FOLDER" | "TRUST_PARENT" | "DO_NOT_TRUST"}`.
  // Without this, spawning a Gemini session in a workbench project that's
  // never been opened in Gemini before pops up a trust dialog and blocks the
  // automation. Trust is per-exact-path (NOT recursive), so every Workbench
  // project needs its own entry.
  async function trustGeminiProjectDirs() {
    const HOME = safe.HOME;
    const trustFile = join(HOME, '.gemini', 'trustedFolders.json');
    let cfg = {};
    try {
      cfg = JSON.parse(await fsp.readFile(trustFile, 'utf-8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        /* expected: first run — file does not exist yet, will be created */
      } else if (err instanceof SyntaxError) {
        logger.error(
          'trustedFolders.json is corrupt JSON — skipping trustGeminiProjectDirs to preserve file for inspection',
          { module: 'watchers', op: 'trustGeminiProjectDirs' },
        );
        return;
      } else {
        logger.warn('Failed to read Gemini trustedFolders.json', {
          module: 'watchers', op: 'trustGeminiProjectDirs', err: err.message,
        });
      }
    }

    let changed = false;
    let addedCount = 0;
    for (const project of db.getProjects()) {
      const p = project.path;
      if (cfg[p] !== 'TRUST_FOLDER') {
        cfg[p] = 'TRUST_FOLDER';
        changed = true;
        addedCount++;
      }
    }
    if (!changed) return;
    try {
      await fsp.mkdir(join(HOME, '.gemini'), { recursive: true });
      await fsp.writeFile(trustFile, JSON.stringify(cfg, null, 2));
      logger.info('Trusted Gemini project directories', { module: 'watchers', count: addedCount });
    } catch (err) {
      logger.error('Failed to update Gemini trust', {
        module: 'watchers', op: 'trustGeminiProjectDirs', err: err.message,
      });
    }
  }

  // #143: settings hot-reload for Gemini. Mirrors startSettingsWatcher (Claude)
  // but watches ~/.gemini/settings.json. On change, broadcasts a generic
  // cli_settings_changed message so the UI can react. Without this, edits to
  // Gemini settings (e.g. via the workbench Settings panel writing
  // gemini_api_key, or external `gemini config` runs) don't propagate to
  // running workbench tabs until the next page reload.
  let geminiSettingsWatcherActive = false;
  function startGeminiSettingsWatcher() {
    if (geminiSettingsWatcherActive) return;
    const HOME = safe.HOME;
    const path = join(HOME, '.gemini', 'settings.json');
    fs.watchFile(path, { persistent: false, interval: 5000 }, () => {
      const update = JSON.stringify({ type: 'cli_settings_changed', cli: 'gemini' });
      for (const ws of sessionWsClients.values()) {
        if (ws.readyState === 1) ws.send(update);
      }
    });
    geminiSettingsWatcherActive = true;
  }

  // #143: settings hot-reload for Codex. Watches ~/.codex/config.toml.
  let codexSettingsWatcherActive = false;
  function startCodexSettingsWatcher() {
    if (codexSettingsWatcherActive) return;
    const HOME = safe.HOME;
    const path = join(HOME, '.codex', 'config.toml');
    fs.watchFile(path, { persistent: false, interval: 5000 }, () => {
      const update = JSON.stringify({ type: 'cli_settings_changed', cli: 'codex' });
      for (const ws of sessionWsClients.values()) {
        if (ws.readyState === 1) ws.send(update);
      }
    });
    codexSettingsWatcherActive = true;
  }

  // #204: mirror of trustProjectDirs but for Codex. Codex stores trusted
  // directories in /data/.codex/config.toml as `[projects."<exact-path>"]`
  // blocks with `trust_level = "trusted"`. Trust is per-exact-path (NOT
  // recursive), so trusting /data/workspace doesn't trust subdirectories —
  // every Workbench project needs its own block. Without this, spawning a
  // Codex session in a project that's never been opened in Codex before
  // pops up a trust dialog and blocks the test/automation.
  async function trustCodexProjectDirs() {
    const HOME = safe.HOME;
    const codexConfigFile = join(HOME, '.codex', 'config.toml');
    let content = '';
    try {
      content = await fsp.readFile(codexConfigFile, 'utf-8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Failed to read codex config.toml', { module: 'watchers', op: 'trustCodexProjectDirs', err: err.message });
        return;
      }
      /* expected: first run — file does not exist yet, will be created */
    }

    // Escape the project path for embedding inside a TOML basic-string
    // (the part between the quotes in `[projects."..."]`). TOML basic-string
    // escapes \ → \\ and " → \". Without this, a path with " or \ would
    // produce invalid TOML and break Codex config parsing entirely.
    const escapeTomlBasicString = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    let appended = '';
    let appendedCount = 0;
    for (const project of db.getProjects()) {
      const p = project.path;
      const escaped = escapeTomlBasicString(p);
      // Match `[projects."<p>"]` literally — TOML keys are exact strings.
      const blockMarker = `[projects."${escaped}"]`;
      if (content.includes(blockMarker)) continue;
      appended += `\n${blockMarker}\ntrust_level = "trusted"\n`;
      appendedCount++;
    }
    if (!appended) return;
    try {
      await fsp.mkdir(join(HOME, '.codex'), { recursive: true });
      await fsp.appendFile(codexConfigFile, appended);
      logger.info('Trusted Codex project directories', { module: 'watchers', count: appendedCount });
    } catch (err) {
      logger.error('Failed to update codex trust', { module: 'watchers', op: 'trustCodexProjectDirs', err: err.message });
    }
  }

  async function trustProjectDirs() {
    const configFile = join(CLAUDE_HOME, '.claude.json');
    let cfg = {};
    try {
      cfg = JSON.parse(await fsp.readFile(configFile, 'utf-8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        /* expected: first run — config file does not exist yet, will be created */
      } else if (err instanceof SyntaxError) {
        logger.error(
          '.claude.json is corrupt JSON — skipping trustProjectDirs to preserve file for inspection',
          { module: 'watchers', op: 'trustProjectDirs' },
        );
        return;
      } else {
        logger.warn('Failed to read .claude.json', {
          module: 'watchers',
          op: 'trustProjectDirs',
          err: err.message,
        });
      }
    }

    if (!cfg.projects) cfg.projects = {};
    let changed = false;
    for (const project of db.getProjects()) {
      const p = project.path;
      if (!cfg.projects[p]) cfg.projects[p] = {};
      if (!cfg.projects[p].hasTrustDialogAccepted) {
        cfg.projects[p].hasTrustDialogAccepted = true;
        cfg.projects[p].enabledMcpjsonServers = [];
        cfg.projects[p].disabledMcpjsonServers = [];
        changed = true;
      }
    }
    if (changed) {
      try {
        await fsp.writeFile(configFile, JSON.stringify(cfg, null, 2));
        logger.info('Trusted project directories', { module: 'watchers' });
      } catch (err) {
        logger.error('Failed to update trust projects', {
          module: 'watchers',
          op: 'trustProjectDirs',
          err: err.message,
        });
      }
    }
  }

  // #286: register the statusLine collector so Claude pipes its live
  // session JSON (including the plan-effective context_window_size) to
  // a script we control. Idempotent: skip if our entry is already there
  // and pointing at the right path.
  async function registerClaudeStatusLine() {
    const settingsFile = join(CLAUDE_HOME, 'settings.json');
    let cfg = {};
    try {
      cfg = JSON.parse(await fsp.readFile(settingsFile, 'utf-8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        /* will create below */
      } else if (err instanceof SyntaxError) {
        logger.error('settings.json is corrupt — cannot register statusLine without overwriting user config', { module: 'watchers', op: 'registerClaudeStatusLine' });
        return;
      } else {
        logger.warn('Failed to read settings.json for statusLine', { module: 'watchers', err: err.message });
      }
    }

    const expectedCommand = `node ${join(__dirname, '..', 'scripts', 'statusline-collector.js')}`;
    const existing = cfg.statusLine;
    const isStale = existing && (existing.command !== expectedCommand || existing.type !== 'command');

    if (!existing || isStale) {
      cfg.statusLine = { type: 'command', command: expectedCommand };
      try {
        await fsp.mkdir(CLAUDE_HOME, { recursive: true });
        await fsp.writeFile(settingsFile, JSON.stringify(cfg, null, 2));
        logger.info('Registered Claude statusLine', { module: 'watchers' });
      } catch (err) {
        logger.error('Could not write statusLine to settings.json', { module: 'watchers', err: err.message });
      }
    }
  }

  async function ensureSettings() {
    const settingsFile = join(CLAUDE_HOME, 'settings.json');
    try {
      await fsp.stat(settingsFile);
    } catch (err) {
      if (err.code === 'ENOENT') {
        try {
          await fsp.mkdir(CLAUDE_HOME, { recursive: true });
          await fsp.writeFile(
            settingsFile,
            JSON.stringify({ skipDangerousModePermissionPrompt: true }, null, 2),
          );
        } catch (innerErr) {
          logger.error('Could not ensure base settings file', {
            module: 'watchers',
            op: 'ensureSettings',
            err: innerErr.message,
          });
        }
      } else {
        logger.error('Unexpected error checking settings file', {
          module: 'watchers',
          op: 'ensureSettings',
          err: err.message,
        });
      }
    }
  }

  // #451: Install workbench `/session` slash command equivalents for Gemini
  // and Codex on every boot. Idempotent: only writes when file is absent
  // (preserves user customizations).
  //
  // Claude has a native `/session` skill installed via the workbench's skill
  // mechanism (separate path); these two helpers cover the Gemini + Codex
  // equivalents so the keystroke UX is parallel across all 3 CLIs.
  //
  // Gemini: TOML files in ~/.gemini/commands/session/ become /session:transition
  //   and /session:resume via the subdir → :namespace convention.
  // Codex: Markdown files in ~/.codex/prompts/ become /prompts:session-transition
  //   and /prompts:session-resume (fixed `prompts:` namespace prefix). NOTE:
  //   Codex CLI v0.130.0 doesn't load these — feature gap tracked in #449.
  //   Install them anyway so they're ready when the Codex side works.
  //
  // Both slash commands are thin wrappers that call the workbench MCP tool;
  // the workbench dispatches per cli_type and returns the right per-CLI
  // checklist prompt. The `!{echo $WORKBENCH_SESSION_ID}` shell substitution
  // in the Gemini TOML pins the session_id at command-render time (verified
  // necessary during #446 e2e — Gemini doesn't reliably read the env var
  // itself from the prompt text).
  async function registerGeminiSessionCommands() {
    const HOME = safe.HOME;
    const dir = join(HOME, '.gemini', 'commands', 'session');
    const transitionPath = join(dir, 'transition.toml');
    const resumePath = join(dir, 'resume.toml');
    const transitionToml =
      'description = "Workbench: end-of-session transition checklist (pre-/compress)"\n' +
      'prompt = """\n' +
      'Call the workbench MCP tool session_prepare_pre_compact with session_id = "!{echo -n $WORKBENCH_SESSION_ID}". Then follow the returned checklist exactly. Do not list or pick from sessions — the session_id above is your own session.\n' +
      '"""\n';
    const resumeToml =
      'description = "Workbench: restore context after /compress"\n' +
      'prompt = """\n' +
      'Call the workbench MCP tool session_resume_post_compact with session_id = "!{echo -n $WORKBENCH_SESSION_ID}". Then follow the returned resume instructions exactly. Do not list or pick from sessions — the session_id above is your own session.\n' +
      '"""\n';
    try {
      await fsp.mkdir(dir, { recursive: true });
      // Idempotent: only write if missing
      for (const [path, content] of [[transitionPath, transitionToml], [resumePath, resumeToml]]) {
        try {
          await fsp.access(path);
          continue; // already exists, preserve user customizations
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        await fsp.writeFile(path, content);
      }
      logger.info('Registered Gemini /session slash commands', { module: 'watchers' });
    } catch (err) {
      logger.error('Could not write Gemini session commands', { module: 'watchers', err: err.message });
    }
  }

  // Codex skill mechanism — `$skill-name` invocation in the composer, or the
  // `/skills` picker. SKILL.md files live at ~/.agents/skills/<name>/SKILL.md
  // (user-level). This replaces the original ~/.codex/prompts/ path: the
  // custom-prompts mechanism is deprecated by OpenAI and verified non-functional
  // in Codex CLI v0.130.0 — typing /prompts:session-transition returned
  // "Unrecognized command" despite the files being installed. Skills work in
  // the same version. Tracked: #449.
  async function registerCodexSessionSkills() {
    const HOME = safe.HOME;
    const transitionDir = join(HOME, '.agents', 'skills', 'session-transition');
    const resumeDir = join(HOME, '.agents', 'skills', 'session-resume');
    const transitionSkill =
      '---\n' +
      'name: session-transition\n' +
      'description: Workbench end-of-session transition checklist. Use this skill before running /compact to capture state in the plan file at ~/.codex/plans/<session-id>.md plus GH issue updates and memory updates.\n' +
      '---\n' +
      '\n' +
      'Call the workbench MCP tool session_prepare_pre_compact with session_id set to the value of the WORKBENCH_SESSION_ID environment variable in your shell context. Use a shell tool to read that env var if needed (echo $WORKBENCH_SESSION_ID). Then follow the returned checklist exactly.\n';
    const resumeSkill =
      '---\n' +
      'name: session-resume\n' +
      'description: Workbench restore context after compaction. Use this skill immediately after /compact to read the tail file written by the workbench and restore prior session state.\n' +
      '---\n' +
      '\n' +
      'Call the workbench MCP tool session_resume_post_compact with session_id set to the value of the WORKBENCH_SESSION_ID environment variable in your shell context. Use a shell tool to read that env var if needed (echo $WORKBENCH_SESSION_ID). Then follow the returned resume instructions exactly.\n';
    try {
      await fsp.mkdir(transitionDir, { recursive: true });
      await fsp.mkdir(resumeDir, { recursive: true });
      for (const [path, content] of [
        [join(transitionDir, 'SKILL.md'), transitionSkill],
        [join(resumeDir, 'SKILL.md'), resumeSkill],
      ]) {
        try {
          await fsp.access(path);
          continue;
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        await fsp.writeFile(path, content);
      }
      logger.info('Registered Codex session-transition + session-resume skills', { module: 'watchers' });
    } catch (err) {
      logger.error('Could not write Codex session skills', { module: 'watchers', err: err.message });
    }
  }

  return {
    startJsonlWatcher,
    stopJsonlWatcher,
    startSettingsWatcher,
    startGeminiSettingsWatcher,
    startCodexSettingsWatcher,
    registerMcpServer,
    registerClaudeStatusLine,
    registerGeminiMcp,
    registerCodexMcp,
    registerGeminiSessionCommands,
    registerCodexSessionSkills,
    registerCodexProvider,
    registerCodexAuth,
    trustProjectDirs,
    trustGeminiProjectDirs,
    trustCodexProjectDirs,
    ensureSettings,
  };
};
