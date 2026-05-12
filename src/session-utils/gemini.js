'use strict';

// H2: Gemini session discovery, parsing, transcript reading, token usage.

const { join, basename } = require('path');

const _DISCOVERY_CACHE_TTL_MS = 10000;

module.exports = function createGemini({ db, safe, config, logger }) {
  let _cache = null;
  let _cacheTime = 0;

  function _geminiMaxTokens(model) {
    if (!model) return null;
    return String(model).toLowerCase().includes('gemini-') ? 1048576 : null;
  }

  function _extractGeminiMessageText(msg) {
    if (msg.type !== 'user' && msg.type !== 'gemini') return '';
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(p => typeof p === 'string' ? p : p.text || '').join(' ');
    return '';
  }

  /**
   * Parse a Gemini chat JSON/JSONL file for session metadata.
   */
  function parseGeminiChatFile(filePath) {
    const fs = require('fs');
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      let data;
      let messages;
      if (filePath.endsWith('.jsonl')) {
        const lines = content.split('\n').filter(l => l.trim());
        if (!lines.length) return null;
        data = JSON.parse(lines[0]);
        messages = lines.slice(1).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } else {
        data = JSON.parse(content);
        messages = data.messages || [];
      }
      let name = null;
      let timestamp = data.lastUpdated || data.startTime || null;
      let messageCount = 0;
      let model = null;
      const sessionId = data.sessionId || null;

      for (const msg of messages) {
        if (!name && msg.type === 'user') {
          const text = typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content.map(p => typeof p === 'string' ? p : p.text || '').join(' ')
              : '';
          if (text) {
            name = text.substring(0, 80);
            if (text.length > 80) name += '...';
          }
        }
        if (msg.type === 'user' || msg.type === 'gemini') messageCount++;
        if (msg.type === 'gemini' && msg.model) model = msg.model;
        if (msg.timestamp) timestamp = msg.timestamp;
      }

      // #408 [Q5]: prefer file mtime when no later message-level timestamp was found.
      let activityTimestamp = timestamp;
      try {
        const mtimeIso = fs.statSync(filePath).mtime.toISOString();
        if (!activityTimestamp || new Date(mtimeIso) > new Date(activityTimestamp)) {
          activityTimestamp = mtimeIso;
        }
      } catch { /* file vanished */ }

      return { name: name || 'Untitled Session', timestamp: activityTimestamp || null, messageCount, model: model || null, sessionId };
    } catch {
      return null;
    }
  }

  function _discoverGeminiSessionsRaw() {
    const fs = require('fs');
    const home = safe.HOME;
    const results = [];
    try {
      const geminiBase = join(home, '.gemini', 'tmp');
      const projectDirs = fs.readdirSync(geminiBase, { withFileTypes: true });
      for (const pDir of projectDirs) {
        if (!pDir.isDirectory()) continue;
        const chatsDir = join(geminiBase, pDir.name, 'chats');
        if (!fs.existsSync(chatsDir)) continue;
        const files = fs.readdirSync(chatsDir).filter(f => f.endsWith('.json') || f.endsWith('.jsonl'));
        for (const file of files) {
          const filePath = join(chatsDir, file);
          const meta = parseGeminiChatFile(filePath);
          if (meta) results.push({ filePath, ...meta });
        }
      }
    } catch { /* no gemini sessions */ }
    return results;
  }

  // #372 [E2]: TTL-cached discovery — 10s window deduplicates parallel polls.
  function discoverGeminiSessions() {
    const now = Date.now();
    if (_cache && (now - _cacheTime) < _DISCOVERY_CACHE_TTL_MS) return _cache;
    _cache = _discoverGeminiSessionsRaw();
    _cacheTime = now;
    return _cache;
  }

  function invalidateGeminiCache() {
    _cache = null;
    _cacheTime = 0;
  }

  function _readGeminiTranscript(sessionId, maxTranscriptChars, maxMessageChars) {
    const messages = [];
    let charCount = 0;

    const geminiSessions = discoverGeminiSessions();
    const session = db.getSession(sessionId);
    const cliSessId = session?.cli_session_id;

    let target = null;
    if (cliSessId) target = geminiSessions.find(g => g.sessionId === cliSessId);
    if (!target && geminiSessions.length > 0) {
      target = geminiSessions.sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tb - ta;
      })[0];
    }
    if (!target) return messages;

    try {
      const fs = require('fs');
      const data = JSON.parse(fs.readFileSync(target.filePath, 'utf-8'));
      const msgs = data.messages || [];
      for (let i = msgs.length - 1; i >= 0 && charCount < maxTranscriptChars; i--) {
        const text = _extractGeminiMessageText(msgs[i]);
        if (text) {
          const role = msgs[i].type === 'user' ? 'user' : 'assistant';
          messages.unshift({ role, text: text.substring(0, maxMessageChars) });
          charCount += text.length;
        }
      }
    } catch { /* unreadable */ }

    return messages;
  }

  function _getGeminiTokenUsage(sessionId) {
    const geminiSessions = discoverGeminiSessions();
    const session = db.getSession(sessionId);
    const cliSessId = session?.cli_session_id;

    let target = null;
    if (cliSessId) target = geminiSessions.find(g => g.sessionId === cliSessId);
    if (!target) return { input_tokens: 0, model: null, max_tokens: null };

    try {
      const fs = require('fs');
      const data = JSON.parse(fs.readFileSync(target.filePath, 'utf-8'));
      const messages = data.messages || [];
      let inputTokens = 0;
      let model = target.model || null;

      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.type !== 'gemini') continue;
        if (msg.tokens && typeof msg.tokens.input === 'number') {
          inputTokens = msg.tokens.input;
          if (msg.model) model = msg.model;
          break;
        }
        if (msg.usage) {
          inputTokens = msg.usage.input_tokens || msg.usage.prompt_token_count || 0;
          if (msg.model) model = msg.model;
          break;
        }
      }

      return { input_tokens: inputTokens, model, max_tokens: _geminiMaxTokens(model) };
    } catch {
      return { input_tokens: 0, model: target.model || null, max_tokens: _geminiMaxTokens(target.model) };
    }
  }

  function _searchGeminiSessions(q, results) {
    const geminiSessions = discoverGeminiSessions();
    for (const gs of geminiSessions) {
      try {
        const fs = require('fs');
        const content = fs.readFileSync(gs.filePath, 'utf-8');
        const data = JSON.parse(content);
        const messages = data.messages || [];
        const matches = [];

        for (const msg of messages) {
          const text = _extractGeminiMessageText(msg);
          if (text && text.toLowerCase().includes(q)) {
            matches.push({ type: msg.type, text: text.substring(0, 200), timestamp: msg.timestamp });
          }
        }

        if (matches.length > 0) {
          results.push({
            session_id: gs.sessionId || gs.filePath,
            sessionId: gs.sessionId || gs.filePath,
            project: '(gemini)',
            name: gs.name || 'Untitled',
            match_count: matches.length,
            matchCount: matches.length,
            snippets: matches.slice(0, 3).map(m => m.text),
            matches: matches.slice(0, 3),
            cli_type: 'gemini',
          });
        }
      } catch { /* skip unreadable files */ }
    }
  }

  return {
    parseGeminiChatFile,
    discoverGeminiSessions,
    invalidateGeminiCache,
    _readGeminiTranscript,
    _getGeminiTokenUsage,
    _searchGeminiSessions,
    _extractGeminiMessageText,
  };
};
