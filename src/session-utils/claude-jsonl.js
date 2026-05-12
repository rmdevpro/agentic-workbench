'use strict';

// H1: Claude JSONL parsing, statusline state, Claude token usage, session slug.

const { readFile, stat } = require('fs/promises');
const { join, basename } = require('path');

module.exports = function createClaudeJsonl({ db, safe, config, logger }) {
  const CLAUDE_HOME = safe.CLAUDE_HOME;
  const WORKSPACE = safe.WORKSPACE;

  function sessionsDir(projectPath) {
    return safe.findSessionsDir(projectPath);
  }

  // #286: read Claude's live session state written by the statusLine collector.
  function _readClaudeStatusLineState(sessionId) {
    if (!sessionId) return null;
    try {
      const fs = require('fs');
      const statePath = join(CLAUDE_HOME, `statusline-state-${sessionId}.json`);
      const raw = fs.readFileSync(statePath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      logger.warn('statusline-state read failed', {
        module: 'session-utils/claude-jsonl', sessionId: sessionId.substring(0, 8), err: err.message,
      });
      return null;
    }
  }

  async function parseSessionFile(filepath) {
    try {
      const sessionId = basename(filepath, '.jsonl');
      const fileStat = await stat(filepath);
      const mtime = fileStat.mtimeMs;
      const size = fileStat.size;

      const cached = db.getSessionMeta(sessionId);
      if (cached && cached.file_mtime === mtime && cached.file_size === size) {
        return {
          name: cached.name || 'Untitled Session',
          timestamp: cached.timestamp || new Date().toISOString(),
          messageCount: cached.message_count || 0,
          model: cached.model || null,
        };
      }

      const content = await readFile(filepath, 'utf-8');
      const lines = content.trim().split('\n');
      let name = null;
      let timestamp = null;
      let messageCount = 0;
      let model = null;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (!name && entry.type === 'user' && entry.message?.content) {
            const text = typeof entry.message.content === 'string'
              ? entry.message.content
              : entry.message.content[0]?.text || '';
            name = text.substring(0, 80);
            if (text.length > 80) name += '...';
          }
          if (entry.type === 'summary' && entry.summary) {
            name = entry.summary.substring(0, 80);
          }
          if (entry.type === 'user' || entry.type === 'assistant') {
            messageCount++;
          }
          if (entry.type === 'assistant' && entry.message?.model) {
            model = entry.message.model;
          }
          if (entry.timestamp) {
            timestamp = entry.timestamp;
          }
        } catch (parseErr) {
          if (!(parseErr instanceof SyntaxError)) {
            logger.debug('Unexpected error parsing JSONL line in parseSessionFile', {
              module: 'session-utils/claude-jsonl', err: parseErr.message,
            });
          }
        }
      }

      const result = {
        name: name || 'Untitled Session',
        timestamp: timestamp || new Date().toISOString(),
        messageCount,
        model: model || null,
      };

      db.upsertSessionMeta(sessionId, filepath, mtime, size, result.name, result.timestamp, result.messageCount, result.model || '');
      return result;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      logger.error('Unexpected error in parseSessionFile', { module: 'session-utils/claude-jsonl', err: err.message });
      return null;
    }
  }

  function extractMessageText(entry) {
    if (entry.type !== 'user' && entry.type !== 'assistant') return '';
    const content = entry.message?.content;
    if (typeof content === 'string') return content;
    return content?.[0]?.text || '';
  }

  async function _getClaudeTokenUsage(sessionId, project) {
    const dbProj = db.getProject(project);
    const projectPath = dbProj ? dbProj.path : join(WORKSPACE, project);
    const sDir = sessionsDir(projectPath);
    const jsonlFile = join(sDir, `${sessionId}.jsonl`);

    try {
      const content = await readFile(jsonlFile, 'utf-8');
      const lines = content.trim().split('\n');
      let inputTokens = 0;
      let model = null;

      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'assistant' && entry.message?.usage) {
            const m = entry.message.model || '';
            if (m.includes('synthetic') || m.includes('system')) continue;
            const usage = entry.message.usage;
            const total = (usage.input_tokens || 0) +
              (usage.cache_read_input_tokens || 0) +
              (usage.cache_creation_input_tokens || 0);
            if (total === 0) continue;
            inputTokens = total;
            model = m || null;
            break;
          }
        } catch (parseErr) {
          if (!(parseErr instanceof SyntaxError)) {
            logger.debug('Unexpected error parsing JSONL line in _getClaudeTokenUsage', {
              module: 'session-utils/claude-jsonl', err: parseErr.message,
            });
          }
        }
      }

      return { input_tokens: inputTokens, model, max_tokens: null };
    } catch (err) {
      if (err.code === 'ENOENT') return { input_tokens: 0, model: null, max_tokens: null };
      logger.error('Unexpected error in _getClaudeTokenUsage', {
        module: 'session-utils/claude-jsonl', sessionId: sessionId.substring(0, 8), err: err.message,
      });
      return { input_tokens: 0, model: null, max_tokens: null };
    }
  }

  async function getSessionSlug(sessionId, projectPath) {
    const jsonlFile = join(sessionsDir(projectPath), `${sessionId}.jsonl`);
    try {
      const content = await readFile(jsonlFile, 'utf-8');
      for (const line of content.split('\n')) {
        try {
          const entry = JSON.parse(line);
          if (entry.slug) return entry.slug;
        } catch (parseErr) {
          if (!(parseErr instanceof SyntaxError)) {
            logger.debug('Unexpected error parsing JSONL line in getSessionSlug', {
              module: 'session-utils/claude-jsonl', err: parseErr.message,
            });
          }
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.error('Unexpected error in getSessionSlug', {
          module: 'session-utils/claude-jsonl', sessionId: sessionId.substring(0, 8), err: err.message,
        });
      }
    }
    return null;
  }

  return {
    parseSessionFile,
    extractMessageText,
    getSessionSlug,
    _readClaudeStatusLineState,
    _getClaudeTokenUsage,
    sessionsDir,
    CLAUDE_HOME,
  };
};
