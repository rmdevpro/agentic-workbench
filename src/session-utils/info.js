'use strict';

// H4: getSessionInfo aggregator + unified _sessionInfoCache + getTokenUsage dispatcher.

const { join, basename } = require('path');
const { CODEX_ROLLOUT_UUID_RE } = require('../constants');

const SESSION_INFO_TTL_MS = 2000;

module.exports = function createInfo({ db, safe, config, logger, claudeJsonl, gemini, codex }) {
  const _sessionInfoCache = new Map();

  function invalidateSessionInfoCache(sessionId) {
    if (sessionId) {
      _sessionInfoCache.delete(`${sessionId}:0`);
      _sessionInfoCache.delete(`${sessionId}:1`);
    } else {
      _sessionInfoCache.clear();
    }
  }

  async function getTokenUsage(sessionId, project) {
    if (sessionId.startsWith('new_')) return { input_tokens: 0, model: null, max_tokens: null };
    const session = db.getSession(sessionId);
    const cliType = session?.cli_type || 'claude';
    if (cliType === 'gemini') return gemini._getGeminiTokenUsage(sessionId);
    if (cliType === 'codex') return codex._getCodexTokenUsage(sessionId);
    return claudeJsonl._getClaudeTokenUsage(sessionId, project);
  }

  async function getSessionInfo(sessionId, opts = {}) {
    if (!sessionId) return null;
    const includeTokens = opts.includeTokens !== false;
    const cacheKey = `${sessionId}:${includeTokens ? 1 : 0}`;
    const cached = _sessionInfoCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SESSION_INFO_TTL_MS) return cached.value;

    const dbRow = db.getSessionFull(sessionId);
    if (!dbRow) {
      _sessionInfoCache.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }

    const cliType = dbRow.cli_type || 'claude';
    let fileMeta = null;
    let tokens = { input_tokens: 0, model: null, max_tokens: null };

    if (cliType === 'claude') {
      const sDir = claudeJsonl.sessionsDir(dbRow.project_path);
      const jsonlFile = join(sDir, `${sessionId}.jsonl`);
      fileMeta = await claudeJsonl.parseSessionFile(jsonlFile);
      if (includeTokens) tokens = await getTokenUsage(sessionId, dbRow.project_name);
    } else if (cliType === 'gemini') {
      if (dbRow.cli_session_id) {
        const sessions = gemini.discoverGeminiSessions();
        const target = sessions.find(g => g.sessionId === dbRow.cli_session_id);
        if (target) {
          fileMeta = { name: target.name, timestamp: target.timestamp, messageCount: target.messageCount, model: target.model };
        }
      }
      if (includeTokens) tokens = gemini._getGeminiTokenUsage(sessionId);
    } else if (cliType === 'codex') {
      if (dbRow.cli_session_id) {
        const sessions = codex.discoverCodexSessions();
        const target = sessions.find(c => {
          const rolloutName = basename(c.filePath, '.jsonl');
          const m = rolloutName.match(CODEX_ROLLOUT_UUID_RE);
          return (m ? m[1] : rolloutName) === dbRow.cli_session_id;
        });
        if (target) {
          fileMeta = { name: target.name, timestamp: target.timestamp, messageCount: target.messageCount, model: target.model };
        }
      }
      if (includeTokens) tokens = codex._getCodexTokenUsage(sessionId);
    }

    // #286: for Claude, prefer the CLI's own live statusLine state file.
    let liveStatusModel = null;
    if (cliType === 'claude') {
      const live = claudeJsonl._readClaudeStatusLineState(sessionId);
      if (live && live.context_window) {
        const cw = live.context_window;
        const merged = { ...tokens };
        if (typeof cw.context_window_size === 'number') merged.max_tokens = cw.context_window_size;
        if (typeof cw.current_usage === 'number') {
          merged.input_tokens = cw.current_usage;
        } else if (cw.current_usage && typeof cw.current_usage === 'object') {
          const u = cw.current_usage;
          merged.input_tokens = (u.input_tokens || 0) +
            (u.cache_creation_input_tokens || 0) +
            (u.cache_read_input_tokens || 0);
        } else if (typeof cw.total_input_tokens === 'number') {
          merged.input_tokens = cw.total_input_tokens;
        }
        if (live.model && live.model.id) {
          merged.model = live.model.id;
          liveStatusModel = live.model.id;
        }
        tokens = merged;
      }
    }

    const tmux = safe.tmuxNameFor(sessionId);
    const active = await safe.tmuxExists(tmux);

    const info = {
      id: dbRow.id,
      project_id: dbRow.project_id,
      project_name: dbRow.project_name,
      project_path: dbRow.project_path,
      cli_type: cliType,
      cli_session_id: dbRow.cli_session_id || null,
      name: dbRow.name || fileMeta?.name || 'Untitled Session',
      state: dbRow.state || (dbRow.archived ? 'archived' : 'active'),
      archived: !!dbRow.archived,
      model_override: dbRow.model_override || null,
      model: dbRow.model_override || liveStatusModel || fileMeta?.model || tokens.model || null,
      input_tokens: tokens.input_tokens || 0,
      max_tokens: typeof tokens.max_tokens === 'number' ? tokens.max_tokens : null,
      message_count: fileMeta?.messageCount || 0,
      timestamp: fileMeta?.timestamp || dbRow.updated_at,
      notes: dbRow.notes || '',
      created_at: dbRow.created_at,
      updated_at: dbRow.updated_at,
      tmux,
      active,
    };

    _sessionInfoCache.set(cacheKey, { ts: Date.now(), value: info });
    return info;
  }

  return { getSessionInfo, getTokenUsage, invalidateSessionInfoCache };
};
