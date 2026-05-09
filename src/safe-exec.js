'use strict';

const childProcess = require('child_process');
const { execFileSync } = childProcess;
const crypto = require('crypto');
const fs = require('fs');
const { writeFile: writeFileAsync, unlink: unlinkAsync } = require('fs/promises');
const { resolve, join } = require('path');
const os = require('os');
const logger = require('./logger');

function execFileAsync(cmd, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    childProcess.execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err) rejectPromise(err);
      else resolvePromise({ stdout, stderr });
    });
  });
}

const HOME = process.env.HOME || '/data';
const CLAUDE_HOME = process.env.CLAUDE_HOME || join(HOME, '.claude');
const WORKSPACE = process.env.WORKSPACE || join(HOME, 'workspace');

function resolveProjectPath(project) {
  return resolve(WORKSPACE, project);
}

function sanitizeTmuxName(name) {
  return name.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

// #156: canonical tmux session-name derivation. Single source of truth so that
// any module reasoning about a session's tmux pane (session-utils, tmux-lifecycle,
// routes, ws-terminal) gets the same name without re-implementing the format.
function tmuxNameFor(sessionId) {
  const hash = crypto.createHash('md5').update(sessionId).digest('hex').substring(0, 4);
  return sanitizeTmuxName(`wb_${sessionId.substring(0, 12)}_${hash}`);
}

function shellEscape(arg) {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Synchronous tmux exec — used internally only by functions that compose
 * multiple fast tmux commands atomically (tmuxCreateClaude, tmuxCreateBash).
 * These are sub-millisecond operations for atomic session setup.
 */
function tmuxExecSync(args, options = {}) {
  return execFileSync('tmux', args, {
    encoding: 'utf-8',
    stdio: options.stdio || 'pipe',
    timeout: options.timeout || 10000,
    env: process.env,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
  });
}

/**
 * #241: capture a tmux pane's full scrollback buffer (preserving ANSI escape
 * sequences for color/style) so a reconnecting WebSocket can replay history
 * before the live PTY attach starts streaming. Returns the captured bytes as
 * a string; returns '' if the session doesn't exist or capture fails.
 */
function tmuxCaptureScrollback(tmuxSession, lines = 10000) {
  const safeName = sanitizeTmuxName(tmuxSession);
  try {
    return tmuxExecSync(
      ['capture-pane', '-p', '-e', '-J', '-S', `-${lines}`, '-t', safeName],
      { timeout: 5000 },
    );
  } catch {
    return '';
  }
}

/**
 * Async tmux exec — used by all callers in async contexts.
 */
async function tmuxExecAsync(args, options = {}) {
  const { stdout } = await execFileAsync('tmux', args, {
    encoding: 'utf-8',
    stdio: options.stdio || 'pipe',
    timeout: options.timeout || 10000,
    env: process.env,
  });
  return stdout;
}

function claudeExecAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      'claude',
      [...args],
      {
        encoding: 'utf-8',
        timeout: options.timeout || 120000,
        cwd: options.cwd || WORKSPACE,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, TERM: 'xterm-256color' },
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

async function tmuxExists(name) {
  const safeName = sanitizeTmuxName(name);
  try {
    await tmuxExecAsync(['has-session', '-t', safeName]);
    return true;
  } catch (_err) {
    /* any tmux error (session not found, server not running) means session doesn't exist */
    return false;
  }
}

// Build the per-CLI args to resume an existing session. Single source of truth
// for both explicit resume (POST /api/sessions/:id/resume) and the auto-respawn
// path in ws-terminal.js — those two MUST behave identically. Returns
// { args, missing } where `missing: true` means we expected a session file
// to exist for resume but it doesn't (caller should refuse to spawn rather
// than silently start a fresh session keyed under the same workbench row).
async function buildResumeArgs(session, projectPath) {
  const cliType = session.cli_type || 'claude';
  const sessionId = session.id;

  // Temporary IDs are pre-resume by definition (session was just created and
  // has no JSONL yet) — fresh launch is correct.
  if (sessionId.startsWith('new_') || sessionId.startsWith('t_')) {
    return { args: [], missing: false };
  }

  if (cliType === 'claude') {
    // For Claude the workbench session id IS the JSONL filename. Refuse to
    // spawn if the file is gone (e.g., wiped /data after a rebuild without
    // restored backup). Otherwise --resume <id> is required so a respawn
    // continues writing into the same JSONL the workbench is tracking.
    const jsonlPath = join(findSessionsDir(projectPath), `${sessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) {
      return { args: null, missing: true, expectedPath: jsonlPath };
    }
    return { args: ['--resume', sessionId], missing: false };
  }

  if (cliType === 'gemini') {
    const cliSessId = session.cli_session_id;
    if (!cliSessId) return { args: ['--resume', 'latest'], missing: false };
    try {
      // execFileAsync is defined at module top.
      const { stdout } = await execFileAsync('gemini', ['--list-sessions'], { cwd: projectPath });
      // Line format: "  <index>. <title> (<time>) [<session-id>]"
      for (const line of stdout.split('\n')) {
        const m = line.match(/^\s+(\d+)\.\s+.*\[([^\]]+)\]/);
        if (m && m[2] === cliSessId) {
          return { args: ['--resume', m[1]], missing: false };
        }
      }
    } catch (_err) { /* fall through to latest */ }
    return { args: ['--resume', 'latest'], missing: false };
  }

  if (cliType === 'codex') {
    // Codex resumes via its rollout id (codex --session-id), stored as
    // cli_session_id in the workbench DB. If we don't have one yet, launch
    // fresh — codex will record a rollout on first run.
    const cliSessId = session.cli_session_id;
    return { args: cliSessId ? ['resume', cliSessId] : [], missing: false };
  }

  return { args: [], missing: false };
}

function tmuxCreateCLI(sessionName, cwd, cliType, args = []) {
  const safeName = sanitizeTmuxName(sessionName);
  const escapedCwd = shellEscape(cwd);

  let binary;
  let cliArgs = [...args];
  let envParts = [`export HOME=${shellEscape(HOME)}`];

  switch (cliType) {
    case 'claude':
      binary = 'claude';
      cliArgs = ['--dangerously-skip-permissions', ...cliArgs];
      envParts.push(`export CLAUDE_HOME=${shellEscape(CLAUDE_HOME)}`);
      envParts.push(`export CLAUDE_CONFIG_DIR=${shellEscape(CLAUDE_HOME)}`);
      break;
    case 'gemini':
      binary = 'gemini';
      if (process.env.GEMINI_API_KEY) envParts.push(`export GEMINI_API_KEY=${shellEscape(process.env.GEMINI_API_KEY)}`);
      break;
    case 'codex':
      binary = 'codex';
      if (process.env.OPENAI_API_KEY) envParts.push(`export OPENAI_API_KEY=${shellEscape(process.env.OPENAI_API_KEY)}`);
      break;
    case 'bash':
      binary = 'bash';
      envParts.push(`export CLAUDE_HOME=${shellEscape(CLAUDE_HOME)}`);
      envParts.push(`export CLAUDE_CONFIG_DIR=${shellEscape(CLAUDE_HOME)}`);
      break;
    default:
      throw new Error(`Unknown CLI type: ${cliType}`);
  }

  const escapedArgs = cliArgs.map((a) => shellEscape(a)).join(' ');
  const envExports = envParts.join(' && ');
  const cmd = `cd ${escapedCwd} && ${envExports} && exec ${binary}${escapedArgs ? ' ' + escapedArgs : ''}`;
  tmuxExecSync(['new-session', '-d', '-s', safeName, '-x', '200', '-y', '50', cmd], {
    timeout: 30000,
  });
  tmuxExecSync(['set-option', '-t', safeName, 'mouse', 'off']);
  tmuxExecSync(['set-option', '-t', safeName, 'history-limit', '10000']);
  // Pass through DCS/OSC escape sequences (notably OSC 8 hyperlinks emitted by
  // Claude Code and other CLIs) so xterm.js receives them intact (#240).
  tmuxExecSync(['set-option', '-t', safeName, 'allow-passthrough', 'on']);
  // tmux 3.4+ supports OSC 8 hyperlinks but only forwards them when the
  // configured terminal advertises the `hyperlinks` feature. Append it to
  // terminal-features for any terminal type so xterm.js gets the OSC 8
  // sequence and can wire up clickable links (#240).
  tmuxExecSync(['set-option', '-t', safeName, '-as', 'terminal-features', ',*:hyperlinks']);
}

// Backward-compatible wrappers
function tmuxCreateClaude(sessionName, cwd, claudeArgs = []) {
  tmuxCreateCLI(sessionName, cwd, 'claude', claudeArgs);
}
function tmuxCreateGemini(sessionName, cwd, geminiArgs = []) {
  tmuxCreateCLI(sessionName, cwd, 'gemini', geminiArgs);
}
function tmuxCreateCodex(sessionName, cwd, codexArgs = []) {
  tmuxCreateCLI(sessionName, cwd, 'codex', codexArgs);
}
function tmuxCreateBash(sessionName, cwd) {
  tmuxCreateCLI(sessionName, cwd, 'bash');
}

async function tmuxKill(sessionName) {
  const safeName = sanitizeTmuxName(sessionName);
  try {
    await tmuxExecAsync(['kill-session', '-t', safeName]);
  } catch (err) {
    if (
      err.message &&
      (err.message.includes('session not found') ||
        err.message.includes('no server running') ||
        err.message.includes('error connecting to'))
    ) {
      /* expected: session already gone or tmux server not running */
    } else {
      logger.debug('tmuxKill unexpected error', {
        module: 'safe-exec',
        tmuxSession: safeName,
        err: err.message,
      });
    }
  }
}

/**
 * Async version of tmuxSendKeys — writes text to a temp file, loads it into
 * tmux paste buffer, pastes into session, and sends Enter.
 * Uses async fs and tmux operations to avoid blocking the event loop.
 */
async function tmuxSendKeysAsync(sessionName, text) {
  const safeName = sanitizeTmuxName(sessionName);
  const tmpFile = join(
    os.tmpdir(),
    `tmux_paste_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.txt`,
  );
  await writeFileAsync(tmpFile, text);
  try {
    await tmuxExecAsync(['load-buffer', tmpFile]);
    await tmuxExecAsync(['paste-buffer', '-t', safeName]);
    await tmuxExecAsync(['send-keys', '-t', safeName, 'Enter']);
  } finally {
    try {
      await unlinkAsync(tmpFile);
    } catch (cleanupErr) {
      if (cleanupErr.code !== 'ENOENT') {
        logger.debug('tmuxSendKeysAsync cleanup failed', {
          module: 'safe-exec',
          err: cleanupErr.message,
        });
      }
    }
  }
}

/**
 * Paste-only counterpart to tmuxSendKeysAsync. Loads the text into a tmux
 * buffer and pastes it into the target pane WITHOUT a trailing Enter — caller
 * decides whether/when to submit via tmuxSendKeyAsync(name, 'Enter'). Matches
 * the planned `workbench_sessions send_text` MCP action shape.
 */
async function tmuxSendTextAsync(sessionName, text) {
  const safeName = sanitizeTmuxName(sessionName);
  const tmpFile = join(
    os.tmpdir(),
    `tmux_paste_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.txt`,
  );
  await writeFileAsync(tmpFile, text);
  try {
    await tmuxExecAsync(['load-buffer', tmpFile]);
    await tmuxExecAsync(['paste-buffer', '-t', safeName]);
  } finally {
    try {
      await unlinkAsync(tmpFile);
    } catch (cleanupErr) {
      if (cleanupErr.code !== 'ENOENT') {
        logger.debug('tmuxSendTextAsync cleanup failed', {
          module: 'safe-exec',
          err: cleanupErr.message,
        });
      }
    }
  }
}

/**
 * Async version of tmuxSendKey — sends a named key to a tmux session.
 */
async function tmuxSendKeyAsync(sessionName, keyName) {
  const safeName = sanitizeTmuxName(sessionName);
  await tmuxExecAsync(['send-keys', '-t', safeName, keyName]);
}

async function gitCloneAsync(url, targetPath) {
  if (!url.match(/^https?:\/\//) && !url.match(/^git@/)) {
    throw new Error('Invalid git URL');
  }
  const { stdout } = await execFileAsync('git', ['clone', url, targetPath], {
    encoding: 'utf-8',
    timeout: 120000,
  });
  return stdout;
}

function grepSearchAsync(pattern, cwd, glob) {
  return new Promise((resolve) => {
    const args = ['-rn'];
    if (glob) args.push('--include=' + glob);
    args.push('--', pattern, '.');
    childProcess.execFile(
      'grep',
      args,
      {
        cwd,
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout) => {
        if (err || !stdout) resolve('No matches found');
        else resolve(stdout.split('\n').slice(0, 50).join('\n') || 'No matches found');
      },
    );
  });
}

function curlFetchAsync(url) {
  return new Promise((resolve) => {
    childProcess.execFile(
      'curl',
      ['-sL', '--max-time', '10', url],
      {
        encoding: 'utf-8',
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout) => {
        if (err || !stdout) resolve(`Error: failed to fetch ${url}`);
        else resolve(stdout.substring(0, 20000));
      },
    );
  });
}

function findSessionsDir(projectPath) {
  // Claude Code's projects-subdir encoding replaces BOTH '/' AND '_' with '-'.
  // Replacing only '/' produces a path that doesn't exist for any project whose
  // path contains an underscore (e.g. /data/workspace/repos/agentic_workbench
  // → -data-workspace-repos-agentic-workbench, with hyphen, not underscore).
  // Watchers / session-meta lookups would silently miss the JSONL otherwise.
  const encoded = projectPath.replace(/[\/_]/g, '-');
  return join(CLAUDE_HOME, 'projects', encoded);
}

// #189/#190: keep client-visible error messages informative without leaking
// URL-embedded credentials. Operator-side logs still see the raw message.
// Order matters: user:pass@ runs first (more specific), then bare token@.
// Query-string secret params get their value redacted but param name kept
// so users can still see the structure of the failing URL.
// NOTE: regex uses `g` flag — only used with String.replace() which resets
// lastIndex; do NOT reuse with .test()/.exec() without resetting first.
// `m` flag enables ^ matching start-of-line in multi-line error messages.
// Known scope limitation: URL fragments (#access_token=...) not redacted.
const _SECRET_QUERY_PARAMS = /(^|[?&])(api_key|token|auth|key|secret|password|access_token|refresh_token|api-key|x-api-key|apikey)=([^&\s]*)/gim;
function sanitizeErrorForClient(msg, maxLen = 1000) {
  if (typeof msg !== 'string') return '';
  return msg
    .replace(/\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@')
    .replace(/\b(https?:\/\/)[^/\s:@]+@/gi, '$1***@')
    .replace(_SECRET_QUERY_PARAMS, '$1$2=***')
    .substring(0, maxLen);
}

module.exports = {
  WORKSPACE,
  CLAUDE_HOME,
  HOME,
  resolveProjectPath,
  sanitizeTmuxName,
  tmuxNameFor,
  shellEscape,
  sanitizeErrorForClient,
  claudeExecAsync,
  tmuxExecAsync,
  tmuxCaptureScrollback,
  tmuxExists,
  buildResumeArgs,
  tmuxCreateCLI,
  tmuxCreateClaude,
  tmuxCreateGemini,
  tmuxCreateCodex,
  tmuxCreateBash,
  tmuxKill,
  tmuxSendKeysAsync,
  tmuxSendTextAsync,
  tmuxSendKeyAsync,
  gitCloneAsync,
  grepSearchAsync,
  curlFetchAsync,
  findSessionsDir,
};
