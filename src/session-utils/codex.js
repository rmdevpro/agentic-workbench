'use strict';

// H3: Codex session discovery, parsing, transcript reading, token usage.

const { join, basename } = require('path');
const { CODEX_ROLLOUT_UUID_RE } = require('../constants');

const _DISCOVERY_CACHE_TTL_MS = 10000;

module.exports = function createCodex({ db, safe, config, logger }) {
  let _cache = null;
  let _cacheTime = 0;

  function _extractCodexMessageText(entry) {
    if (entry.type !== 'response_item' || !entry.payload) return '';
    const role = entry.payload.role || '';
    if (role !== 'user' && role !== 'assistant') return '';
    const content = entry.payload.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(b => b.type === 'input_text' || b.type === 'text')
        .map(b => b.text || '')
        .join(' ');
    }
    return '';
  }

  /**
   * Parse a Codex rollout JSONL file for session metadata.
   */
  function parseCodexRolloutFile(filePath) {
    const fs = require('fs');
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      let name = null;
      let timestamp = null;
      let messageCount = 0;
      let model = null;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'response_item' && entry.payload) {
            const role = entry.payload.role || 'unknown';
            if (role === 'user' || role === 'assistant') messageCount++;
            if (!name && role === 'user') {
              let text = '';
              if (typeof entry.payload.content === 'string') {
                text = entry.payload.content;
              } else if (Array.isArray(entry.payload.content)) {
                text = entry.payload.content
                  .filter(b => b.type === 'input_text' || b.type === 'text')
                  .map(b => b.text || '')
                  .join(' ');
              }
              if (text) {
                name = text.substring(0, 80);
                if (text.length > 80) name += '...';
              }
            }
          }
          if (entry.type === 'turn_context' && entry.payload?.model) model = entry.payload.model;
          if (entry.timestamp) timestamp = entry.timestamp;
        } catch { /* skip malformed lines */ }
      }

      // #408 [Q5]: prefer file mtime when no later message-level timestamp found.
      let activityTimestamp = timestamp;
      try {
        const mtime = fs.statSync(filePath).mtime;
        const mtimeIso = mtime.toISOString();
        if (!activityTimestamp || new Date(mtimeIso) > new Date(activityTimestamp)) {
          activityTimestamp = mtimeIso;
        }
      } catch { /* file vanished */ }

      return { name: name || 'Untitled Session', timestamp: activityTimestamp || null, messageCount, model: model || null };
    } catch {
      return null;
    }
  }

  function _discoverCodexSessionsRaw() {
    const fs = require('fs');
    const home = safe.HOME;
    const results = [];
    try {
      const sessBase = join(home, '.codex', 'sessions');
      if (!fs.existsSync(sessBase)) return results;
      const walk = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith('.jsonl')) {
            const meta = parseCodexRolloutFile(full);
            if (meta) results.push({ filePath: full, ...meta });
          }
        }
      };
      walk(sessBase);
    } catch { /* no codex sessions */ }
    return results;
  }

  // #372 [E2]: TTL-cached discovery — 10s window deduplicates parallel polls.
  function discoverCodexSessions() {
    const now = Date.now();
    if (_cache && (now - _cacheTime) < _DISCOVERY_CACHE_TTL_MS) return _cache;
    _cache = _discoverCodexSessionsRaw();
    _cacheTime = now;
    return _cache;
  }

  function invalidateCodexCache() {
    _cache = null;
    _cacheTime = 0;
  }

  function _readCodexTranscript(sessionId, maxTranscriptChars, maxMessageChars) {
    const messages = [];
    let charCount = 0;

    const codexSessions = discoverCodexSessions();
    const session = db.getSession(sessionId);
    const cliSessId = session?.cli_session_id;

    let target = null;
    if (cliSessId) {
      target = codexSessions.find(c => {
        const rolloutName = basename(c.filePath, '.jsonl');
        const rolloutUuid = rolloutName.match(CODEX_ROLLOUT_UUID_RE);
        const rolloutId = rolloutUuid ? rolloutUuid[1] : rolloutName;
        return rolloutId === cliSessId;
      });
    }
    if (!target && codexSessions.length > 0) {
      target = codexSessions.sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tb - ta;
      })[0];
    }
    if (!target) return messages;

    try {
      const fs = require('fs');
      const content = fs.readFileSync(target.filePath, 'utf-8');
      const lines = content.trim().split('\n');
      for (let i = lines.length - 1; i >= 0 && charCount < maxTranscriptChars; i--) {
        if (!lines[i].trim()) continue;
        try {
          const entry = JSON.parse(lines[i]);
          const text = _extractCodexMessageText(entry);
          if (text) {
            const role = entry.payload?.role === 'user' ? 'user' : 'assistant';
            messages.unshift({ role, text: text.substring(0, maxMessageChars) });
            charCount += text.length;
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* unreadable */ }

    return messages;
  }

  function _getCodexTokenUsage(sessionId) {
    const codexSessions = discoverCodexSessions();
    const session = db.getSession(sessionId);
    const cliSessId = session?.cli_session_id;

    let target = null;
    if (cliSessId) {
      target = codexSessions.find(c => {
        const rolloutName = basename(c.filePath, '.jsonl');
        const rolloutUuid = rolloutName.match(CODEX_ROLLOUT_UUID_RE);
        const rolloutId = rolloutUuid ? rolloutUuid[1] : rolloutName;
        return rolloutId === cliSessId;
      });
    }
    if (!target) return { input_tokens: 0, model: null, max_tokens: null };

    try {
      const fs = require('fs');
      const content = fs.readFileSync(target.filePath, 'utf-8');
      const lines = content.trim().split('\n');
      let inputTokens = 0;
      let maxTokens = null;
      let model = target.model || null;
      let modelFromTurnCtx = false;

      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        try {
          const entry = JSON.parse(lines[i]);
          const p = entry.payload || {};
          if (entry.type === 'event_msg' && p.type === 'token_count') {
            const info = p.info || {};
            if (!inputTokens && info.last_token_usage && typeof info.last_token_usage.input_tokens === 'number') {
              inputTokens = info.last_token_usage.input_tokens;
            }
            if (maxTokens == null && typeof info.model_context_window === 'number') {
              maxTokens = info.model_context_window;
            }
          }
          if (maxTokens == null && entry.type === 'event_msg' && p.type === 'task_started' && typeof p.model_context_window === 'number') {
            maxTokens = p.model_context_window;
          }
          if (!modelFromTurnCtx && entry.type === 'turn_context' && p.model) {
            model = p.model;
            modelFromTurnCtx = true;
          }
          if (inputTokens && maxTokens != null && modelFromTurnCtx) break;
        } catch { /* skip malformed */ }
      }

      return { input_tokens: inputTokens, model, max_tokens: maxTokens };
    } catch {
      return { input_tokens: 0, model: target.model || null, max_tokens: null };
    }
  }

  function _searchCodexSessions(q, results) {
    const codexSessions = discoverCodexSessions();
    for (const cs of codexSessions) {
      try {
        const fs = require('fs');
        const content = fs.readFileSync(cs.filePath, 'utf-8');
        const lines = content.trim().split('\n');
        const matches = [];

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            const text = _extractCodexMessageText(entry);
            if (text && text.toLowerCase().includes(q)) {
              matches.push({ type: entry.payload?.role || 'unknown', text: text.substring(0, 200), timestamp: entry.timestamp });
            }
          } catch { /* skip malformed lines */ }
        }

        if (matches.length > 0) {
          results.push({
            session_id: cs.filePath,
            sessionId: cs.filePath,
            project: '(codex)',
            name: cs.name || 'Untitled',
            match_count: matches.length,
            matchCount: matches.length,
            snippets: matches.slice(0, 3).map(m => m.text),
            matches: matches.slice(0, 3),
            cli_type: 'codex',
          });
        }
      } catch { /* skip unreadable files */ }
    }
  }

  return {
    parseCodexRolloutFile,
    discoverCodexSessions,
    invalidateCodexCache,
    _readCodexTranscript,
    _getCodexTokenUsage,
    _searchCodexSessions,
    _extractCodexMessageText,
  };
};
