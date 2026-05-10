'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readdir } = require('fs/promises');
const { join, basename, resolve, dirname } = require('path');
const { execSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const safe = require('./safe-exec');
const sessionUtils = require('./session-utils');
const logger = require('./logger');
const db = require('./db');
const config = require('./config');
const qdrantSync = require('./qdrant-sync');

const WORKSPACE = safe.WORKSPACE;
const CLAUDE_HOME = safe.CLAUDE_HOME;
const HOME = safe.HOME;

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_CLI_TYPES = ['claude', 'gemini', 'codex'];
const VALID_CLI_TYPES_FOR_NEW = ['claude', 'gemini', 'codex', 'bash'];
const VALID_KEY_NAMES = new Set([
  'Enter', 'Escape', 'Tab', 'Space', 'BSpace',
  'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

class ToolError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function require_(args, ...keys) {
  for (const k of keys) {
    if (args[k] === undefined || args[k] === null || args[k] === '')
      throw new ToolError(`${k} required`);
  }
}

function validateSessionId(sessionId) {
  if (!sessionId) return false;
  if (sessionId.startsWith('new_') || sessionId.startsWith('t_')) return true;
  return SESSION_ID_PATTERN.test(sessionId);
}

function requireSessionId(args) {
  if (!validateSessionId(args.session_id))
    throw new ToolError('valid session_id required');
}

function requireTaskId(args) {
  if (args.task_id == null || !Number.isFinite(Number(args.task_id)))
    throw new ToolError('valid numeric task_id required');
  return Number(args.task_id);
}

function resolveWorkspacePath(relPath) {
  const full = relPath ? resolve(WORKSPACE, relPath) : WORKSPACE;
  if (!full.startsWith(WORKSPACE)) throw new ToolError('path traversal blocked', 403);
  return full;
}

async function _semanticSearch(collections, query, limit) {
  const qdrant = qdrantSync;
  if (qdrant.getEmbeddingProvider() === 'none') {
    return {
      configured: false,
      message: 'Vector search is disabled. Open Workbench Settings → Vector Search and pick an embedding provider (Gemini, OpenAI, HuggingFace, or Custom) — a matching API key in Settings → API Keys is required.',
      results: [],
    };
  }
  try {
    return await qdrant.search(query, collections, limit);
  } catch (err) {
    if (err.code === 'EMBEDDINGS_DISABLED') {
      return { configured: false, message: err.message, results: [] };
    }
    throw err;
  }
}

async function ensureSessionTmux(session, projectPath) {
  const tmux = safe.tmuxNameFor(session.id);
  if (!(await safe.tmuxExists(tmux))) {
    const cliType = session.cli_type || 'claude';
    const { args: resumeArgs, missing, expectedPath } = await safe.buildResumeArgs(session, projectPath);
    if (missing) {
      throw new ToolError(`Cannot reattach session ${session.id} — JSONL missing at ${expectedPath}`, 410);
    }
    safe.tmuxCreateCLI(tmux, projectPath, cliType, resumeArgs, { workbenchSessionId: session.id });
    await new Promise(r => setTimeout(r, 1000));
  }
  return tmux;
}

const SYS_PROMPT_FILES = { claude: 'CLAUDE.md', gemini: 'GEMINI.md', codex: 'AGENTS.md' };

const handlers = {};

// ── file_* ───────────────────────────────────────────────────────────────────

handlers.file_list = async (args) => {
  const target = resolveWorkspacePath(args.path || '');
  try {
    const entries = fs.readdirSync(target).map(name => {
      const isDir = fs.statSync(join(target, name)).isDirectory();
      return { name, type: isDir ? 'directory' : 'file' };
    });
    return { path: args.path || '/', entries };
  } catch (e) {
    if (e.code === 'ENOENT') throw new ToolError('directory not found', 404);
    throw e;
  }
};

handlers.file_read = async (args) => {
  require_(args, 'path');
  const filePath = resolveWorkspacePath(args.path);
  try {
    return { path: args.path, content: fs.readFileSync(filePath, 'utf-8') };
  } catch (e) {
    if (e.code === 'ENOENT') throw new ToolError('file not found', 404);
    throw e;
  }
};

handlers.file_create = async (args) => {
  require_(args, 'path', 'content');
  const filePath = resolveWorkspacePath(args.path);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) throw new ToolError('file already exists, use file_update', 409);
  fs.writeFileSync(filePath, args.content);
  return { created: args.path };
};

handlers.file_update = async (args) => {
  require_(args, 'path', 'content');
  const filePath = resolveWorkspacePath(args.path);
  if (!fs.existsSync(filePath)) throw new ToolError('file not found, use file_create', 404);
  fs.writeFileSync(filePath, args.content);
  return { updated: args.path };
};

handlers.file_delete = async (args) => {
  require_(args, 'path');
  const filePath = resolveWorkspacePath(args.path);
  try {
    fs.unlinkSync(filePath);
    return { deleted: args.path };
  } catch (e) {
    if (e.code === 'ENOENT') throw new ToolError('file not found', 404);
    throw e;
  }
};

const FILE_TYPE_PATTERN = /^[a-zA-Z0-9_+-]+$/;

handlers.file_find = async (args) => {
  require_(args, 'pattern');
  // #330 [A5]: clamp context_lines to a sane integer range. Anything
  // outside 0..10 is forced into bounds; non-numeric falls back to 2.
  let ctx = Number(args.context_lines);
  if (!Number.isFinite(ctx)) ctx = 2;
  ctx = Math.max(0, Math.min(10, Math.trunc(ctx)));
  // #330 [A5]: file_type goes verbatim into a grep --include pattern, so
  // reject anything that isn't a plain extension token. Blocks injection
  // like `file_type: "js;rm -rf /"` even though we now use execFile.
  if (args.file_type !== undefined && args.file_type !== null && args.file_type !== '') {
    if (!FILE_TYPE_PATTERN.test(String(args.file_type))) {
      throw new ToolError('file_type must match /^[a-zA-Z0-9_+-]+$/', 400);
    }
  }
  // -m 50: cap matches per file. Without this a common pattern like
  // "deployment" overflows the buffer in seconds on a busy workspace.
  // We post-slice to 200 lines anyway, so matches beyond that aren't useful.
  const grepArgs = ['-rn', '--color=never', `-C${ctx}`, '-m', '50'];
  if (args.file_type) grepArgs.push(`--include=*.${args.file_type}`);
  grepArgs.push('--', String(args.pattern), WORKSPACE);
  // #330 [A5] (Codex Phase 1 gate fold-back): async execFile, not
  // execFileSync. The prior shape ran a synchronous grep inside an async
  // MCP handler — a slow search blocked the Node event loop and stalled
  // unrelated workbench requests / WebSocket activity. Timeout + maxBuffer
  // sourced from defaults.json (mcp.fileFindTimeoutMs / mcp.fileFindMaxBuffer)
  // so operators can tune without code edits (C2 #344's externalised keys).
  const timeout = config.get('mcp.fileFindTimeoutMs', 10000);
  const maxBuffer = config.get('mcp.fileFindMaxBuffer', 16 * 1024 * 1024);
  try {
    const { stdout } = await execFileAsync('grep', grepArgs, {
      encoding: 'utf-8', timeout, maxBuffer,
    });
    const out = stdout.trim();
    const lines = out.split('\n').slice(0, 200);
    return { pattern: args.pattern, matches: lines.map(l => l.replace(WORKSPACE + '/', '')) };
  } catch (e) {
    // grep exits 1 when no matches — promisified execFile rejects with the
    // exit code on `e.code` (numeric). Treat as empty result.
    if (e.code === 1 || e.status === 1) return { pattern: args.pattern, matches: [] };
    if (e.code === 'ENOBUFS') {
      // Codex Phase 1 gate R3 fold-back: build the limit text from the
      // configured maxBuffer so operators tuning `mcp.fileFindMaxBuffer`
      // see the truth in the client error, not a stale literal.
      const limitText = (maxBuffer >= 1024 * 1024)
        ? `${(maxBuffer / 1024 / 1024).toFixed(0)} MB`
        : `${maxBuffer} bytes`;
      throw new ToolError(`find output exceeded ${limitText} — narrow your pattern or use file_type filter`, 413);
    }
    throw e;
  }
};

handlers.file_search_documents = async (args) => {
  require_(args, 'query');
  if (args.query.length < 2) throw new ToolError('query must be at least 2 characters');
  return await _semanticSearch(['documents'], args.query, args.limit || 10);
};

handlers.file_search_code = async (args) => {
  require_(args, 'query');
  if (args.query.length < 2) throw new ToolError('query must be at least 2 characters');
  return await _semanticSearch(['code'], args.query, args.limit || 10);
};

// ── session_* ────────────────────────────────────────────────────────────────

handlers.session_new = async (args) => {
  require_(args, 'project');
  require_(args, 'name');
  const name = String(args.name).trim();
  if (!name) throw new ToolError('name required', 400);
  const cliType = args.cli || 'claude';
  if (!VALID_CLI_TYPES_FOR_NEW.includes(cliType))
    throw new ToolError(`invalid cli: ${cliType}. Must be one of: ${VALID_CLI_TYPES_FOR_NEW.join(', ')}`);
  const proj = db.getProject(args.project);
  if (!proj) throw new ToolError('project not found', 404);
  if (cliType === 'bash') {
    const tmpId = crypto.randomUUID();
    const tmux = safe.tmuxNameFor(tmpId);
    safe.tmuxCreateBash(tmux, proj.path, { workbenchSessionId: tmpId });
    return { session_id: tmpId, tmux, project: args.project, cli: 'bash' };
  }
  const tmpId = cliType === 'claude'
    ? `new_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`
    : crypto.randomUUID();
  const tmux = safe.tmuxNameFor(tmpId);
  safe.tmuxCreateCLI(tmux, proj.path, cliType, [], { workbenchSessionId: tmpId });
  db.upsertSession(tmpId, proj.id, name, cliType);
  // MCP-spawned sessions default to hidden — agents creating sub-sessions
  // shouldn't clutter the human's sidebar. Pass hidden:false to override.
  if (args.hidden !== false) db.setSessionState(tmpId, 'hidden');
  return { session_id: tmpId, tmux, project: args.project, cli: cliType };
};

handlers.session_connect = async (args) => {
  let session;
  if (args.session_id) {
    requireSessionId(args);
    session = db.getSessionFull(args.session_id);
  } else if (args.query) {
    const matches = db.searchSessionsByName(args.query);
    if (matches.length === 0) throw new ToolError('no session found matching query', 404);
    session = matches[0];
  } else {
    throw new ToolError('session_id or query required');
  }
  if (!session) throw new ToolError('session not found', 404);
  const projectPath = session.project_path || safe.resolveProjectPath(session.project_name);
  const tmux = await ensureSessionTmux(session, projectPath);
  return {
    session_id: session.id,
    name: session.name,
    project: session.project_name,
    cli: session.cli_type || 'claude',
    tmux,
  };
};

handlers.session_restart = async (args) => {
  requireSessionId(args);
  const session = db.getSessionFull(args.session_id);
  if (!session) throw new ToolError('session not found', 404);
  const tmux = safe.tmuxNameFor(args.session_id);
  await safe.tmuxKill(tmux);
  const projectPath = session.project_path || safe.resolveProjectPath(session.project_name);
  const newTmux = await ensureSessionTmux(session, projectPath);
  return { session_id: session.id, tmux: newTmux, cli: session.cli_type || 'claude', restarted: true };
};

handlers.session_kill = async (args) => {
  requireSessionId(args);
  const tmux = safe.tmuxNameFor(args.session_id);
  await safe.tmuxKill(tmux);
  return { session_id: args.session_id, killed: true };
};

handlers.session_list = async (args) => {
  require_(args, 'project');
  const proj = db.getProject(args.project);
  if (!proj) throw new ToolError('project not found', 404);
  // #437: query the DB (which has rows for all 3 cli_types via db.upsertSession)
  // instead of walking <project>/.claude/sessions/ — that was Claude-only and
  // made gemini/codex sessions invisible to MCP clients. getSessionInfo
  // dispatches per cli_type for timestamp + message_count metadata; we skip
  // token reads (heavy, not needed for a list view).
  const dbRows = db.getSessionsForProject(proj.id) || [];
  const sessions = [];
  for (const row of dbRows) {
    const info = await sessionUtils.getSessionInfo(row.id, { includeTokens: false });
    if (info) {
      sessions.push({
        session_id: row.id,
        name: info.name || row.name || 'Untitled',
        cli_type: info.cli_type,
        timestamp: info.timestamp || row.updated_at || null,
        message_count: info.message_count || 0,
      });
    } else {
      // Brand-new session (DB row exists but per-CLI helper hasn't found a
      // file yet). Surface it anyway so the list reflects DB truth.
      sessions.push({
        session_id: row.id,
        name: row.name || 'Untitled',
        cli_type: row.cli_type || 'claude',
        timestamp: row.updated_at || null,
        message_count: 0,
      });
    }
  }
  return { sessions: sessions.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)) };
};

handlers.session_config = async (args) => {
  requireSessionId(args);
  if (args.name !== undefined) db.renameSession(args.session_id, args.name);
  if (args.state !== undefined) db.setSessionState(args.session_id, args.state);
  if (args.notes !== undefined) db.setSessionNotes(args.session_id, args.notes);
  return { saved: true };
};

handlers.session_summarize = async (args) => {
  requireSessionId(args);
  return await sessionUtils.summarizeSession(args.session_id, args.project);
};

handlers.session_prepare_pre_compact = async () => {
  return config.getPrompt('session-transition', {});
};

handlers.session_resume_post_compact = async (args) => {
  requireSessionId(args);
  const session = db.getSessionFull(args.session_id);
  const projectPath = session?.project_path || '';
  const sessDir = sessionUtils.sessionsDir(projectPath);
  const sessionFile = join(sessDir, `${args.session_id}.jsonl`);
  const tailLines = Math.max(1, Number.isFinite(args.tail_lines) ? args.tail_lines : 60);
  let tail = '';
  let lineCount = 0;
  try {
    const content = fs.readFileSync(sessionFile, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const kept = lines.slice(-tailLines);
    tail = kept.join('\n');
    lineCount = kept.length;
  } catch {
    tail = '(could not read session file)';
  }
  // Always write the tail to a file and return the path. Inline return blew
  // past the CLI's tool-result token cap on long sessions; the file path
  // pattern lets the model chunk-read with Read offset/limit at its own pace.
  // #359 [D10]: drop the timestamp suffix so each session_id reuses a single
  // file (overwrite-on-call). Also sweep stale resume files older than 24h on
  // every call so an offline session that never resumes doesn't leave a
  // permanent file on disk.
  const tailPath = join('/tmp', `workbench-resume-${args.session_id}.txt`);
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync('/tmp')) {
      if (!f.startsWith('workbench-resume-')) continue;
      const fp = join('/tmp', f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  fs.writeFileSync(tailPath, tail, 'utf-8');
  const byteCount = Buffer.byteLength(tail, 'utf-8');
  return config.getPrompt('session-resume', {
    TAIL_PATH: tailPath,
    LINE_COUNT: String(lineCount),
    BYTE_COUNT: String(byteCount),
  });
};

handlers.session_export = async (args) => {
  requireSessionId(args);
  const session = db.getSessionFull(args.session_id);
  if (!session) throw new ToolError('session not found', 404);
  const projectPath = session.project_path || '';
  const cliType = session.cli_type || 'claude';
  if (cliType === 'claude') {
    const sessDir = sessionUtils.sessionsDir(projectPath);
    const path = join(sessDir, `${args.session_id}.jsonl`);
    try { return { format: 'jsonl', path, content: fs.readFileSync(path, 'utf-8') }; }
    catch (e) { throw new ToolError(`session file not found: ${path}`, 404); }
  }
  // Gemini/Codex — return parsed transcript via summarizer's tail mechanism
  return await sessionUtils.summarizeSession(args.session_id, args.project);
};

handlers.session_info = async (args) => {
  requireSessionId(args);
  const info = await sessionUtils.getSessionInfo(args.session_id);
  if (!info) throw new ToolError('session not found', 404);
  return info;
};

handlers.session_find = async (args) => {
  require_(args, 'pattern');
  const cliFilter = args.cli ? args.cli.split(',').map(c => c.trim()) : VALID_CLI_TYPES;
  const results = {};
  for (const cli of cliFilter) {
    let searchDirs = [];
    switch (cli) {
      case 'claude': searchDirs = [join(CLAUDE_HOME, 'projects')]; break;
      case 'gemini': searchDirs = [join(HOME, '.gemini', 'tmp')]; break;
      case 'codex':  searchDirs = [process.env.CODEX_HOME || join(HOME, '.codex', 'sessions')]; break;
    }
    const matches = [];
    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const out = execSync(
          `grep -rn --color=never --include='*.jsonl' --include='*.json' -- ${safe.shellEscape(args.pattern)} ${safe.shellEscape(dir)}`,
          { encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 },
        ).trim();
        if (out) matches.push(...out.split('\n').slice(0, 50).map(l => l.replace(dir + '/', '')));
      } catch (e) {
        if (e.status !== 1) logger.error('Session grep error', { module: 'mcp-tools', cli, err: e.message });
      }
    }
    if (matches.length > 0) results[cli] = matches;
  }
  return { pattern: args.pattern, results };
};

handlers.session_search = async (args) => {
  require_(args, 'query');
  if (args.query.length < 2) throw new ToolError('query must be at least 2 characters');
  const cliFilter = args.cli ? args.cli.split(',').map(c => c.trim()) : VALID_CLI_TYPES;
  const collections = cliFilter.map(c => c + '_sessions');
  return await _semanticSearch(collections, args.query, args.limit || 10);
};

handlers.session_send_text = async (args) => {
  requireSessionId(args);
  require_(args, 'text');
  const tmux = safe.tmuxNameFor(args.session_id);
  if (!(await safe.tmuxExists(tmux))) throw new ToolError(`tmux session not running: ${tmux}`, 410);
  await safe.tmuxSendTextAsync(tmux, args.text);
  return { sent: true, tmux };
};

handlers.session_send_keys = async (args) => {
  requireSessionId(args);
  require_(args, 'text');
  const tmux = safe.tmuxNameFor(args.session_id);
  if (!(await safe.tmuxExists(tmux))) throw new ToolError(`tmux session not running: ${tmux}`, 410);
  await safe.tmuxExecAsync(['send-keys', '-t', tmux, args.text]);
  return { sent: true, tmux };
};

handlers.session_send_key = async (args) => {
  requireSessionId(args);
  require_(args, 'key');
  // Allow named keys from the whitelist OR a single printable ASCII char.
  const isNamed = VALID_KEY_NAMES.has(args.key);
  const isSingle = typeof args.key === 'string' && args.key.length === 1 && /^[\x20-\x7E]$/.test(args.key);
  if (!isNamed && !isSingle) throw new ToolError(`invalid key: ${args.key}`);
  const tmux = safe.tmuxNameFor(args.session_id);
  if (!(await safe.tmuxExists(tmux))) throw new ToolError(`tmux session not running: ${tmux}`, 410);
  await safe.tmuxSendKeyAsync(tmux, args.key);
  return { sent: true, key: args.key, tmux };
};

handlers.session_read_screen = async (args) => {
  requireSessionId(args);
  const tmux = safe.tmuxNameFor(args.session_id);
  if (!(await safe.tmuxExists(tmux))) throw new ToolError(`tmux session not running: ${tmux}`, 410);
  const lines = Math.max(1, Math.min(args.lines || 200, 1000));
  // #256: safe.tmuxExecAsync returns the captured stdout string directly, not
  // a {stdout} object. The previous destructuring `const {stdout} = ...` made
  // stdout undefined, which JSON.stringify then dropped — callers saw only
  // {tmux, lines}, never the actual screen content.
  const screen = await safe.tmuxExecAsync(['capture-pane', '-p', '-S', `-${lines}`, '-t', tmux]);
  return { tmux, lines, screen };
};

handlers.session_read_output = async (args) => {
  requireSessionId(args);
  const result = await sessionUtils.summarizeSession(args.session_id, args.project);
  return result;
};

handlers.session_wait = async (args) => {
  const seconds = Math.max(0, Math.min(Number(args.seconds) || 0, 60));
  if (!Number.isFinite(seconds) || seconds <= 0) throw new ToolError('seconds must be a positive number ≤ 60');
  await new Promise(r => setTimeout(r, seconds * 1000));
  return { waited_seconds: seconds };
};

// ── project_* ────────────────────────────────────────────────────────────────

function _projectShape(p) {
  return { id: p.id, name: p.name, path: p.path, notes: p.notes || '', state: p.state || 'active' };
}

handlers.project_find = async (args = {}) => {
  let projects = db.getProjects();
  if (args.pattern) {
    let re;
    try { re = new RegExp(args.pattern, 'i'); }
    catch (e) { throw new ToolError(`invalid regex: ${e.message}`); }
    projects = projects.filter(p => re.test(p.name) || re.test(p.notes || ''));
  }
  return { projects: projects.map(_projectShape) };
};

handlers.project_get = async (args) => {
  require_(args, 'project');
  const p = db.getProject(args.project);
  if (!p) throw new ToolError('project not found', 404);
  return _projectShape(p);
};

handlers.project_update = async (args) => {
  require_(args, 'project');
  const p = db.getProject(args.project);
  if (!p) throw new ToolError('project not found', 404);
  if (args.name !== undefined) db.renameProject(p.id, args.name);
  if (args.notes !== undefined) db.setProjectNotes(p.id, args.notes);
  if (args.state !== undefined) db.setProjectState(p.id, args.state);
  return _projectShape(db.getProjectById(p.id));
};

handlers.project_sys_prompt_get = async (args) => {
  require_(args, 'project', 'cli');
  const p = db.getProject(args.project);
  if (!p) throw new ToolError('project not found', 404);
  const filename = SYS_PROMPT_FILES[args.cli];
  if (!filename) throw new ToolError(`invalid cli: ${args.cli}. Must be claude, gemini, or codex`);
  const path = join(p.path, filename);
  let content = '';
  try { content = fs.readFileSync(path, 'utf-8'); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { project: args.project, cli: args.cli, file: filename, content };
};

handlers.project_sys_prompt_update = async (args) => {
  require_(args, 'project', 'cli', 'content');
  const p = db.getProject(args.project);
  if (!p) throw new ToolError('project not found', 404);
  const filename = SYS_PROMPT_FILES[args.cli];
  if (!filename) throw new ToolError(`invalid cli: ${args.cli}. Must be claude, gemini, or codex`);
  fs.writeFileSync(join(p.path, filename), args.content);
  return { project: args.project, cli: args.cli, file: filename, updated: true };
};

handlers.project_mcp_list = async () => {
  return { servers: db.getMcpServers() };
};

handlers.project_mcp_register = async (args) => {
  require_(args, 'mcp_name', 'mcp_config');
  const transport = args.mcp_transport || 'stdio';
  const cfgStr = typeof args.mcp_config === 'string' ? args.mcp_config : JSON.stringify(args.mcp_config);
  db.registerMcp(args.mcp_name, transport, cfgStr, args.mcp_description || '');
  return { registered: args.mcp_name };
};

handlers.project_mcp_unregister = async (args) => {
  require_(args, 'mcp_name');
  db.unregisterMcp(args.mcp_name);
  return { unregistered: args.mcp_name };
};

function _writeProjectMcpJson(proj) {
  const enabled = db.getEnabledMcpForProject(proj.id);
  const mcpJson = {};
  for (const s of enabled) {
    try { mcpJson[s.name] = JSON.parse(s.config); } catch { mcpJson[s.name] = s.config; }
  }
  fs.writeFileSync(join(proj.path, '.mcp.json'), JSON.stringify({ mcpServers: mcpJson }, null, 2));
}

async function _restartCallingSession(args, projectPath) {
  if (!args.session_id) return;
  const session = db.getSessionFull(args.session_id);
  if (!session) return;
  const tmux = safe.tmuxNameFor(args.session_id);
  await safe.tmuxKill(tmux);
  await ensureSessionTmux(session, session.project_path || projectPath);
}

handlers.project_mcp_enable = async (args) => {
  require_(args, 'mcp_name', 'project');
  const proj = db.getProject(args.project);
  if (!proj) throw new ToolError('project not found', 404);
  if (!db.getMcpServer(args.mcp_name)) throw new ToolError('MCP server not registered', 404);
  db.enableMcpForProject(proj.id, args.mcp_name);
  _writeProjectMcpJson(proj);
  await _restartCallingSession(args, proj.path);
  return { enabled: args.mcp_name, project: args.project };
};

handlers.project_mcp_disable = async (args) => {
  require_(args, 'mcp_name', 'project');
  const proj = db.getProject(args.project);
  if (!proj) throw new ToolError('project not found', 404);
  db.disableMcpForProject(proj.id, args.mcp_name);
  _writeProjectMcpJson(proj);
  await _restartCallingSession(args, proj.path);
  return { disabled: args.mcp_name, project: args.project };
};

handlers.project_mcp_list_enabled = async (args) => {
  require_(args, 'project');
  const proj = db.getProject(args.project);
  if (!proj) throw new ToolError('project not found', 404);
  return { servers: db.getEnabledMcpForProject(proj.id) };
};

// ── task_* (v2 — project-based, subtasks, status lifecycle, rank) ─────────

function _resolveProject(args) {
  if (args.project_id != null) {
    const p = db.getProjectById(Number(args.project_id));
    if (!p) throw new ToolError(`project_id ${args.project_id} not found`, 404);
    return p;
  }
  if (args.project_name) {
    const p = db.getProject(args.project_name);
    if (!p) throw new ToolError(`project "${args.project_name}" not found`, 404);
    return p;
  }
  return null;
}

// Determine whether a project's path lives inside a git repo. Used to enforce
// the "tasks in repo projects must have a github_issue" rule from #304.
function _projectHasRepo(projectPath) {
  if (!projectPath) return false;
  let cur = projectPath;
  while (cur && cur !== '/' && cur.length > 1) {
    try { if (fs.existsSync(path.join(cur, '.git'))) return true; } catch { /* ignore */ }
    cur = path.dirname(cur);
  }
  return false;
}

handlers.task_find = async (args = {}) => {
  let tasks;
  // R5-N1: parity with task_add — accept project_name as well as project_id.
  // _resolveProject throws ToolError 404 if project_name is given but missing,
  // matching task_add's contract.
  const project = _resolveProject(args);
  if (project) tasks = db.getTasksByProject(project.id);
  else tasks = db.getAllTasks(args.filter || 'inactive');
  if (args.pattern) {
    let re;
    try { re = new RegExp(args.pattern, 'i'); }
    catch (e) { throw new ToolError(`invalid regex: ${e.message}`); }
    tasks = tasks.filter(t => re.test(t.title || '') || re.test(t.description || ''));
  }
  if (args.parent_task_id !== undefined) {
    const p = args.parent_task_id;
    tasks = tasks.filter(t => (p == null ? t.parent_task_id == null : t.parent_task_id === Number(p)));
  }
  return { tasks };
};

handlers.task_get = async (args) => {
  const id = requireTaskId(args);
  const task = db.getTask(id);
  if (!task) throw new ToolError('task not found', 404);
  return task;
};

handlers.task_add = async (args) => {
  require_(args, 'title');
  if (args.title.length > 500) throw new ToolError('title max 500 chars');
  let project = _resolveProject(args);
  // If no project specified but a parent_task_id is, inherit project from parent
  let parentTaskId = args.parent_task_id == null ? null : Number(args.parent_task_id);
  if (!project && parentTaskId != null) {
    const parent = db.getTask(parentTaskId);
    if (!parent) throw new ToolError(`parent_task_id ${parentTaskId} not found`, 404);
    project = db.getProjectById(parent.project_id);
  }
  if (!project) throw new ToolError('project_id or project_name required (or a valid parent_task_id)', 400);
  // Enforce: tasks in repo-backed projects must have github_issue
  const githubIssue = args.github_issue || null;
  if (!githubIssue && _projectHasRepo(project.path)) {
    throw new ToolError(`github_issue required for tasks in repo-backed project "${project.name}" (path: ${project.path})`, 400);
  }
  // If parent_task_id given, parent must be in same project
  if (parentTaskId != null) {
    const parent = db.getTask(parentTaskId);
    if (!parent) throw new ToolError(`parent_task_id ${parentTaskId} not found`, 404);
    if (parent.project_id !== project.id) {
      throw new ToolError(`parent_task_id ${parentTaskId} is in project ${parent.project_id}, not ${project.id}`, 400);
    }
  }
  return db.addTask({
    projectId: project.id,
    parentTaskId,
    githubIssue,
    title: args.title,
    description: args.description || '',
    status: args.status || 'inactive',
    createdBy: 'agent',
  });
};

handlers.task_move = async (args) => {
  const id = requireTaskId(args);
  // task_move changes parent / project, optionally with a target rank in
  // the destination bucket. parent_task_id and/or project_id is required;
  // rank is optional (omit → append to end of new bucket; supply → atomic
  // insert at that rank).
  if (args.parent_task_id === undefined && args.project_id === undefined && args.rank === undefined) {
    throw new ToolError('task_move requires parent_task_id, project_id, or rank', 400);
  }
  try {
    // #327 [A2] (Codex Phase 1 gate fold-back): route through db.moveTask —
    // same atomic transaction the HTTP PUT /api/tasks/:id path uses. The
    // prior shape called db.reparentTask (which always appended to the
    // destination bucket and ignored rank), so MCP cross-bucket moves with
    // a target rank silently dropped the rank.
    const out = db.moveTask(id, {
      parentTaskId: args.parent_task_id === undefined ? null : args.parent_task_id,
      projectId: args.project_id,
      rank: args.rank,
    });
    return { moved: true, task: out };
  } catch (e) {
    if (e.code === 'task_validation') throw new ToolError(e.message, 400);
    if (e.code === 'not_found') throw new ToolError(e.message, 404);
    throw e;
  }
};

handlers.task_update = async (args) => {
  const id = requireTaskId(args);
  const task = db.getTask(id);
  if (!task) throw new ToolError('task not found', 404);
  // Field updates
  if (args.title !== undefined || args.description !== undefined || args.github_issue !== undefined) {
    db.updateTaskFields(id, {
      title: args.title,
      description: args.description,
      github_issue: args.github_issue,
    });
  }
  // Status change with validation
  if (args.status !== undefined) {
    try { db.setTaskStatus(id, args.status); }
    catch (e) {
      if (e.code === 'task_validation') throw new ToolError(e.message, 400);
      throw e;
    }
  }
  // Archive flag with validation
  if (args.archived !== undefined) {
    try { db.setTaskArchived(id, !!args.archived); }
    catch (e) {
      if (e.code === 'task_validation') throw new ToolError(e.message, 400);
      throw e;
    }
  }
  // #327 [A2]: atomic moveTask replaces the buggy two-step
  // setTaskRank → reparentTask which appended to the new bucket
  // instead of inserting at the requested rank.
  if (args.rank !== undefined || args.parent_task_id !== undefined || args.project_id !== undefined) {
    try {
      db.moveTask(id, {
        parentTaskId: args.parent_task_id,
        projectId: args.project_id,
        rank: args.rank,
      });
    } catch (e) {
      if (e.code === 'task_validation') throw new ToolError(e.message, 400);
      throw e;
    }
  }
  return db.getTask(id) || { updated: true };
};

handlers.task_comment_add = async (args) => {
  const id = requireTaskId(args);
  require_(args, 'body');
  const body = String(args.body).trim();
  if (!body) throw new ToolError('body required', 400);
  const task = db.getTask(id);
  if (!task) throw new ToolError('task not found', 404);
  return db.addTaskComment(id, body, args.created_by || 'agent');
};

handlers.task_delete = async (args) => {
  const id = requireTaskId(args);
  const task = db.getTask(id);
  if (!task) throw new ToolError('task not found', 404);
  db.deleteTask(id);
  return { deleted: true, task_id: id };
};

// ── gh_* (path-keyed GitHub credential management + gh shell-out) ────────
// #317: git_accounts is the single source of GitHub credentials. Token is
// looked up per-call from the path. AI never sees the token — handlers
// return public views that omit it.
const _gitAuth = require('./git-auth');
const _childProcess = require('child_process');

handlers.gh_account_list = async () => {
  const accounts = _gitAuth.resolveAccounts(db).map(_gitAuth.publicView);
  return { accounts };
};

handlers.gh_account_add = async (args) => {
  require_(args, 'path');
  require_(args, 'token');
  try {
    const a = _gitAuth.addAccount(db, {
      path: args.path,
      token: args.token,
      isKB: !!args.isKB,
      isDefault: !!args.default,
      name: args.name,
    });
    return _gitAuth.publicView(a);
  } catch (e) {
    if (e.code === 'duplicate_path') throw new ToolError(e.message, 409);
    throw e;
  }
};

handlers.gh_account_update = async (args) => {
  require_(args, 'id');
  try {
    const a = _gitAuth.updateAccount(db, args.id, {
      token: args.token,
      isKB: args.isKB,
      isDefault: args.default,
      name: args.name,
      path: args.path,
    });
    return _gitAuth.publicView(a);
  } catch (e) {
    if (e.code === 'not_found') throw new ToolError(e.message, 404);
    if (e.code === 'duplicate_path') throw new ToolError(e.message, 409);
    throw e;
  }
};

handlers.gh_account_remove = async (args) => {
  require_(args, 'id');
  try {
    _gitAuth.removeAccount(db, args.id);
    return { removed: true, id: args.id };
  } catch (e) {
    if (e.code === 'not_found') throw new ToolError(e.message, 404);
    throw e;
  }
};

// gh_cmd: spawn `gh` (or `git`) with the right token for the requested repo.
// args:
//   command: array of args, e.g. ['issue', 'list']
//   repo:    'owner/name' for path lookup (looked up as host + '/' + owner)
//   host:    default 'github.com'
// Token is injected via GH_TOKEN env (for `gh`) or via extraheader (for `git`).
// Token never appears in args or output. Stderr/stdout are captured.
// #331 [A6]: 200 KB cap per stream. Chunked at the data-handler so a runaway
// subprocess can't grow our buffers unbounded — every gh_cmd response holds
// at most 400 KB of subprocess output regardless of what the child emits.
const GH_STDOUT_CAP = 200_000;
const GH_STDERR_CAP = 200_000;

function _collectGhOutput(child, opts = {}) {
  const stdoutCap = opts.stdoutCap || GH_STDOUT_CAP;
  const stderrCap = opts.stderrCap || GH_STDERR_CAP;
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', b => {
      if (stdout.length >= stdoutCap) return;
      const remaining = stdoutCap - stdout.length;
      const chunk = b.toString();
      stdout += chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
    });
    child.stderr.on('data', b => {
      if (stderr.length >= stderrCap) return;
      const remaining = stderrCap - stderr.length;
      const chunk = b.toString();
      stderr += chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
    });
    child.on('error', err => reject(err));
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

handlers.gh_cmd = async (args) => {
  require_(args, 'command');
  // #331 [A6]: command must be a homogeneous string array. Strings ("gh log -n 5")
  // would invite shell parsing or argv-corruption; non-string elements would be
  // coerced silently.
  if (!Array.isArray(args.command)) {
    throw new ToolError('command must be an array of strings', 400);
  }
  if (!args.command.every(a => typeof a === 'string')) {
    throw new ToolError('every command element must be a string', 400);
  }
  const cmd = args.command;
  const useGit = !!args.use_git; // when true: use 'git' instead of 'gh'
  const host = args.host || 'github.com';
  let path = null;
  if (args.repo) {
    // 'owner/name' → lookup path is 'host/owner'
    const m = /^([^/]+)\/[^/]+$/.exec(String(args.repo));
    if (!m) throw new ToolError(`invalid repo: ${args.repo} (expected 'owner/name')`, 400);
    path = `${host}/${m[1]}`;
  } else if (args.path) {
    path = String(args.path);
  } else {
    throw new ToolError('repo or path required', 400);
  }
  const account = _gitAuth.accountForPath(db, path);
  if (!account) {
    throw new ToolError(`no_account_for_path: ${path}`, 404);
  }
  let bin, finalArgs, env;
  if (useGit) {
    bin = 'git';
    finalArgs = [..._gitAuth.gitAuthArgs(account.token), ...cmd];
    env = process.env;
  } else {
    bin = 'gh';
    finalArgs = cmd;
    env = { ...process.env, GH_TOKEN: account.token, GH_HOST: host };
  }
  const child = _childProcess.spawn(bin, finalArgs, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let collected;
  try {
    collected = await _collectGhOutput(child);
  } catch (err) {
    throw new ToolError(`spawn failed: ${err.message}`, 500);
  }
  const { code, stdout, stderr } = collected;
  // Distinguish auth errors from other failures.
  if (code === 0) {
    return { ok: true, code, stdout, stderr: stderr.slice(0, 8000), path };
  }
  if (/401|403|token_expired|Bad credentials/i.test(stderr)) {
    throw new ToolError(`auth_rejected for path ${path}: ${stderr.trim().slice(0, 500)}`, 401);
  }
  throw new ToolError(`gh_cmd exit ${code}: ${stderr.trim().slice(0, 500)}`, code === 1 ? 400 : 500);
};

// ── log_* ────────────────────────────────────────────────────────────────────

const SINCE_RE = /^(\d+)\s*([smhd])$/;

function _resolveSince(sinceArg) {
  if (!sinceArg) return null;
  const m = SINCE_RE.exec(String(sinceArg).trim());
  if (!m) {
    // Treat as ISO timestamp if not a relative form.
    const d = new Date(sinceArg);
    if (Number.isNaN(d.getTime())) throw new ToolError(`invalid since: ${sinceArg}. Use 1h / 30m / 24h / iso8601`);
    return d.toISOString();
  }
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms = unit === 's' ? n * 1000
    : unit === 'm' ? n * 60_000
    : unit === 'h' ? n * 3_600_000
    : n * 86_400_000;
  return new Date(Date.now() - ms).toISOString();
}

handlers.log_find = async (args = {}) => {
  if (args.level && !['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(args.level)) {
    throw new ToolError(`invalid level: ${args.level}. Must be DEBUG / INFO / WARN / ERROR`);
  }
  const sinceTs = _resolveSince(args.since);
  let rows = db.queryLogs({ level: args.level, module: args.module, since: sinceTs, limit: args.limit });
  if (args.pattern) {
    let re;
    try { re = new RegExp(args.pattern, 'i'); }
    catch (e) { throw new ToolError(`invalid regex: ${e.message}`); }
    rows = rows.filter(r => re.test(r.message || '') || re.test(r.context || ''));
  }
  return { count: rows.length, logs: rows };
};

// ── Dispatch + HTTP ──────────────────────────────────────────────────────────

const TOOL_NAMES = Object.keys(handlers);

async function dispatch(toolName, args) {
  const handler = handlers[toolName];
  if (!handler) throw new ToolError(`Unknown tool: ${toolName}`, 404);
  return await handler(args || {});
}

function registerMcpRoutes(app) {
  app.get('/api/mcp/tools', (req, res) => {
    res.json({ tools: TOOL_NAMES });
  });

  app.post('/api/mcp/call', async (req, res) => {
    const { tool, args } = req.body || {};
    try {
      const result = await dispatch(tool, args);
      res.json({ result });
    } catch (err) {
      const status = err.status
        || (err.code === 'ENOENT' ? 404
            : err instanceof SyntaxError ? 400
            : err.message?.includes('traversal') ? 403
            : 500);
      if (status === 500) {
        logger.error('MCP tool call error', { module: 'mcp-tools', tool, err: err.message });
      }
      res.status(status).json({ error: err.message });
    }
  });
}

// #361 [L1]: re-export the shared catalog so any consumer that has
// `require('./mcp-tools')` already sees both halves (handler + schema)
// from one place.
const { TOOLS, CATALOG_NAMES } = require('./mcp-catalog');

module.exports = {
  registerMcpRoutes, handlers, dispatch, TOOL_NAMES, ToolError, _collectGhOutput,
  TOOLS, CATALOG_NAMES,
};
