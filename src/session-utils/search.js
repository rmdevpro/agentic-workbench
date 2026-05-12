'use strict';

// H5: searchSessions and summarizeSession.

const { readdir, readFile } = require('fs/promises');
const { join, basename } = require('path');

module.exports = function createSearch({ db, safe, config, logger, claudeJsonl, gemini, codex }) {
  const WORKSPACE = safe.WORKSPACE;

  async function searchSessions(query, projectFilter, maxResults = 15) {
    const q = query.toLowerCase();
    const results = [];
    const dbProjects = db.getProjects();

    // Search Claude JSONL sessions
    for (const dbProj of dbProjects) {
      if (projectFilter && dbProj.name !== projectFilter) continue;
      const sDir = claudeJsonl.sessionsDir(dbProj.path);
      try {
        const files = await readdir(sDir);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          const sessionId = basename(file, '.jsonl');
          const content = await readFile(join(sDir, file), 'utf-8');
          const matches = [];
          let firstName = null;

          for (const line of content.split('\n')) {
            try {
              const e = JSON.parse(line);
              if (!firstName && e.type === 'user' && e.message?.content) {
                const t = typeof e.message.content === 'string'
                  ? e.message.content
                  : e.message.content[0]?.text || '';
                firstName = t.substring(0, 80);
              }
              const text = claudeJsonl.extractMessageText(e);
              if (text && text.toLowerCase().includes(q)) {
                matches.push({ type: e.type, text: text.substring(0, 200), timestamp: e.timestamp });
              }
            } catch (parseErr) {
              if (!(parseErr instanceof SyntaxError)) {
                logger.debug('Unexpected error parsing JSONL line in searchSessions', {
                  module: 'session-utils/search', err: parseErr.message,
                });
              }
            }
          }

          if (matches.length > 0) {
            const cached = db.getSessionMeta(sessionId);
            const sessionName = cached?.name || firstName || 'Untitled';
            results.push({
              session_id: sessionId,
              sessionId,
              project: dbProj.name,
              name: sessionName,
              match_count: matches.length,
              matchCount: matches.length,
              snippets: matches.slice(0, 3).map(m => m.text),
              matches: matches.slice(0, 3),
              cli_type: 'claude',
            });
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.error('Error reading sessions dir in searchSessions', {
            module: 'session-utils/search', project: dbProj.name, err: err.message,
          });
        }
      }
    }

    // Search Gemini and Codex sessions
    if (!projectFilter) {
      gemini._searchGeminiSessions(q, results);
      codex._searchCodexSessions(q, results);
    }

    return results.sort((a, b) => b.match_count - a.match_count).slice(0, maxResults);
  }

  async function summarizeSession(sessionId, project) {
    const session = db.getSession(sessionId);
    const cliType = session?.cli_type || 'claude';

    let projectPath = '';
    if (project) {
      const dbProj = db.getProject(project);
      projectPath = dbProj ? dbProj.path : join(WORKSPACE, project);
    } else if (session?.project_id) {
      const dbProj = db.getProjectById(session.project_id);
      projectPath = dbProj?.path || '';
    }

    const maxTranscriptChars = config.get('session.summaryMaxTranscriptChars', 1500);
    const maxMessageChars = config.get('session.summaryMaxMessageChars', 500);
    let messages = [];

    if (cliType === 'gemini') {
      messages = gemini._readGeminiTranscript(sessionId, maxTranscriptChars, maxMessageChars);
    } else if (cliType === 'codex') {
      messages = codex._readCodexTranscript(sessionId, maxTranscriptChars, maxMessageChars);
    } else {
      // Claude: read from JSONL
      const sDir = claudeJsonl.sessionsDir(projectPath);
      const jsonlFile = join(sDir, `${sessionId}.jsonl`);
      try {
        const content = await readFile(jsonlFile, 'utf-8');
        const lines = content.trim().split('\n');
        let charCount = 0;
        for (let i = lines.length - 1; i >= 0 && charCount < maxTranscriptChars; i--) {
          try {
            const entry = JSON.parse(lines[i]);
            const text = claudeJsonl.extractMessageText(entry);
            if (text) {
              messages.unshift({ role: entry.type, text: text.substring(0, maxMessageChars) });
              charCount += text.length;
            }
          } catch (parseErr) {
            if (!(parseErr instanceof SyntaxError)) {
              logger.debug('Unexpected error parsing JSONL line in summarizeSession', {
                module: 'session-utils/search', err: parseErr.message,
              });
            }
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.error('Error reading session file for summary', {
            module: 'session-utils/search', sessionId: sessionId.substring(0, 8), err: err.message,
          });
        }
      }
    }

    if (messages.length === 0) return { summary: 'Empty session.', recent_messages: [], recentMessages: [] };

    const cliLabel = cliType === 'gemini' ? 'Gemini' : cliType === 'codex' ? 'Codex' : 'Claude';
    const transcript = messages.map(m => `${m.role === 'user' ? 'Human' : cliLabel}: ${m.text}`).join('\n\n');

    const prompt = config.getPrompt('summarize-session', { TRANSCRIPT: transcript });
    const summaryModel = config.get('session.summaryModel', 'claude-sonnet-4-6');
    const claudeTimeout = config.get('claude.defaultTimeoutMs', 120000);

    try {
      const summary = (
        await safe.claudeExecAsync(
          ['--print', '--no-session-persistence', '--model', summaryModel, prompt],
          { cwd: projectPath, timeout: claudeTimeout },
        )
      ).trim();
      const recent = messages.slice(-3);
      return { summary, recent_messages: recent, recentMessages: recent };
    } catch (err) {
      const stderr = err.stderr?.toString().substring(0, 1000);
      logger.error('Failed to generate session summary', {
        module: 'session-utils/search', sessionId: sessionId.substring(0, 8), err: err.message, stderr,
      });
      const recent = messages.slice(-3);
      return {
        summary: 'Failed to generate summary: ' + (stderr || err.message?.substring(0, 1000) || 'unknown error'),
        recent_messages: recent,
        recentMessages: recent,
      };
    }
  }

  return { searchSessions, summarizeSession };
};
