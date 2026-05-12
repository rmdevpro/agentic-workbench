'use strict';

// H0: session-utils factory with transitional re-export adapter.
//
// Existing require('./session-utils') call sites continue to work via the
// module-level singleton exported at the bottom. New code can inject deps
// via createSessionUtils({ db, safe, config, logger }).

const createClaudeJsonl = require('./session-utils/claude-jsonl');
const createGemini = require('./session-utils/gemini');
const createCodex = require('./session-utils/codex');
const createInfo = require('./session-utils/info');
const createSearch = require('./session-utils/search');

function createSessionUtils({ db, safe, config, logger }) {
  const claudeJsonl = createClaudeJsonl({ db, safe, config, logger });
  const geminiMod = createGemini({ db, safe, config, logger });
  const codexMod = createCodex({ db, safe, config, logger });
  const infoMod = createInfo({ db, safe, config, logger, claudeJsonl, gemini: geminiMod, codex: codexMod });
  const searchMod = createSearch({ db, safe, config, logger, claudeJsonl, gemini: geminiMod, codex: codexMod });

  // #372 [E2]: unified invalidation across both discovery caches.
  function invalidateDiscoveryCache(cliType) {
    if (!cliType || cliType === 'gemini') geminiMod.invalidateGeminiCache();
    if (!cliType || cliType === 'codex') codexMod.invalidateCodexCache();
  }

  return {
    // H1 — Claude JSONL
    sessionsDir: claudeJsonl.sessionsDir,
    parseSessionFile: claudeJsonl.parseSessionFile,
    extractMessageText: claudeJsonl.extractMessageText,
    getSessionSlug: claudeJsonl.getSessionSlug,
    _readClaudeStatusLineState: claudeJsonl._readClaudeStatusLineState,
    // H2 — Gemini
    parseGeminiChatFile: geminiMod.parseGeminiChatFile,
    discoverGeminiSessions: geminiMod.discoverGeminiSessions,
    _readGeminiTranscript: geminiMod._readGeminiTranscript,
    // H3 — Codex
    parseCodexRolloutFile: codexMod.parseCodexRolloutFile,
    discoverCodexSessions: codexMod.discoverCodexSessions,
    _readCodexTranscript: codexMod._readCodexTranscript,
    // H4 — info aggregator
    getSessionInfo: infoMod.getSessionInfo,
    getTokenUsage: infoMod.getTokenUsage,
    invalidateSessionInfoCache: infoMod.invalidateSessionInfoCache,
    // H5 — search
    searchSessions: searchMod.searchSessions,
    summarizeSession: searchMod.summarizeSession,
    // Shared
    invalidateDiscoveryCache,
    CLAUDE_HOME: claudeJsonl.CLAUDE_HOME,
  };
}

// Transitional singleton adapter — preserves the existing module-level API
// so all existing require('./session-utils') call sites work unmodified during
// the migration. Removed when G0/H0 consumer updates are complete.
const _db = require('./db');
const _safe = require('./safe-exec');
const _config = require('./config');
const _logger = require('./logger');

const _singleton = createSessionUtils({ db: _db, safe: _safe, config: _config, logger: _logger });

module.exports = { createSessionUtils, ..._singleton };
