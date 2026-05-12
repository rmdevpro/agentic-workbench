'use strict';

// Shared constants and helpers used by multiple route domain modules.
// This is NOT a factory — just plain exports.

const {
  readdir,
  readFile,
  writeFile,
  stat,
  unlink,
  mkdir,
  appendFile,
  access,
} = require('fs/promises');
const { join, basename, dirname, resolve: pathResolve } = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const crypto = require('crypto');

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const { rename, rm } = require('fs/promises');
const { KB_PATH, KB_UPSTREAM_URL, KB_UPSTREAM_OWNER_REPO, CODEX_ROLLOUT_UUID_RE } = require('../constants');
const gitAuth = require('../git-auth');
const sessionUtilsMod = require('../session-utils');
const { discoverGeminiSessions, discoverCodexSessions } = sessionUtilsMod;

// ── Validation constants ─────────────────────────────────────────────────────

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PROJECT_NAME_MAX_LEN = 255;
const SESSION_NAME_MAX_LEN = 255;
const PROMPT_MAX_LEN = 50000;
const MESSAGE_CONTENT_MAX_LEN = 100000;
const SEARCH_QUERY_MAX_LEN = 200;
const TASK_TITLE_MAX_LEN = 500;
const TASK_DESC_MAX_LEN = 10000;
const TASK_FOLDER_MAX_LEN = 1000;
const NOTES_MAX_LEN = 100000;
const VALID_STATES = ['active', 'archived', 'hidden'];

function validateSessionId(sessionId) {
  if (!sessionId) return false;
  if (sessionId.startsWith('new_') || sessionId.startsWith('t_')) return true;
  return SESSION_ID_PATTERN.test(sessionId);
}

// #181: parse a relative ('1h' / '24h' / '7d' / '15m') or absolute ISO8601 'since'
// query param into an ISO timestamp. Returns ISO string suitable for SQLite TEXT
// timestamp comparison.
function _parseSince(input) {
  if (!input) return new Date(Date.now() - 3600 * 1000).toISOString();
  const m = /^(\d+)([smhd])$/.exec(String(input).trim());
  if (m) {
    const n = parseInt(m[1], 10);
    const mult = { s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 86400 * 1000 }[m[2]];
    return new Date(Date.now() - n * mult).toISOString();
  }
  // Try as ISO timestamp
  const d = new Date(input);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  // Fallback to 1h
  return new Date(Date.now() - 3600 * 1000).toISOString();
}

// Factory: returns a trustDir(dirPath) function with CLAUDE_HOME + logger
// bound. Shared by sessions.js and projects.js (previously duplicated).
function createTrustDir({ CLAUDE_HOME, logger }) {
  let _lock = Promise.resolve();
  return async function trustDir(dirPath) {
    const prev = _lock;
    let unlock;
    _lock = new Promise((r) => { unlock = r; });
    await prev;
    try {
      const configFile = join(CLAUDE_HOME, '.claude.json');
      let cfg = {};
      try {
        cfg = JSON.parse(await readFile(configFile, 'utf-8'));
      } catch (err) {
        if (err.code === 'ENOENT') {
          /* first run */
        } else if (err instanceof SyntaxError) {
          logger.error('.claude.json is corrupt — skipping trustDir', { module: 'routes' });
          return;
        } else {
          logger.warn('Failed to parse .claude.json', {
            module: 'routes',
            op: 'trustDir',
            err: err.message,
          });
        }
      }
      if (!cfg.projects) cfg.projects = {};
      if (cfg.projects[dirPath] && cfg.projects[dirPath].hasTrustDialogAccepted) return;
      cfg.projects[dirPath] = {
        hasTrustDialogAccepted: true,
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
      };
      await writeFile(configFile, JSON.stringify(cfg, null, 2));
    } finally {
      unlock();
    }
  };
}

module.exports = {
  // fs/promises named imports
  readdir,
  readFile,
  writeFile,
  stat,
  unlink,
  mkdir,
  appendFile,
  access,
  rename,
  rm,
  // path helpers
  join,
  basename,
  dirname,
  pathResolve,
  // child_process
  execFile,
  execFileAsync,
  // crypto
  crypto,
  // express
  express,
  // fs (sync)
  fs,
  fsp,
  // constants / modules
  KB_PATH,
  KB_UPSTREAM_URL,
  KB_UPSTREAM_OWNER_REPO,
  CODEX_ROLLOUT_UUID_RE,
  gitAuth,
  discoverGeminiSessions,
  discoverCodexSessions,
  // validation constants
  SESSION_ID_PATTERN,
  PROJECT_NAME_MAX_LEN,
  SESSION_NAME_MAX_LEN,
  PROMPT_MAX_LEN,
  MESSAGE_CONTENT_MAX_LEN,
  SEARCH_QUERY_MAX_LEN,
  TASK_TITLE_MAX_LEN,
  TASK_DESC_MAX_LEN,
  TASK_FOLDER_MAX_LEN,
  NOTES_MAX_LEN,
  VALID_STATES,
  // helpers
  validateSessionId,
  _parseSince,
  createTrustDir,
};
