'use strict';

const fsp = require('fs/promises');
const fs = require('fs');
const { basename, join } = require('path');
const { CODEX_ROLLOUT_UUID_RE } = require('./constants');

module.exports = function createSessionResolver({
  db,
  safe,
  tmuxName,
  tmuxExists,
  sleep,
  logger,
  config,
}) {
  const pendingResolutions = new Map();
  const maxAttempts = config ? config.get('resolver.maxAttempts', 30) : 30;
  const sleepMs = config ? config.get('resolver.sleepMs', 2000) : 2000;

  async function resolveSessionId(tmpId, { tmux, sessionsDir, existingFiles, projectId, cliType }) {
    if (pendingResolutions.has(tmpId)) return;

    // Non-Claude CLIs don't create JSONL files — but we discover their CLI session IDs
    if (cliType && cliType !== 'claude') {
      discoverCliSessionId(tmpId, cliType).catch(err => {
        logger.error('CLI session ID discovery failed', {
          module: 'session-resolver', workbenchId: tmpId.substring(0, 12), err: err.message,
        });
      });
      return;
    }

    pendingResolutions.set(tmpId, true);

    try {
      for (let i = 0; i < maxAttempts; i++) {
        await sleep(sleepMs);
        try {
          const currentFiles = await fsp.readdir(sessionsDir);
          const newFiles = currentFiles.filter(
            (f) => f.endsWith('.jsonl') && !existingFiles.has(f),
          );
          if (newFiles.length >= 1) {
            const realId = basename(newFiles[0], '.jsonl');
            logger.info('Session ID resolved', {
              module: 'session-resolver',
              from: tmpId.substring(0, 12),
              to: realId.substring(0, 8),
            });

            // #147: wrap insert(real) + metadata copies + delete(temp) in a single
            // transaction so /api/state can never observe both rows simultaneously.
            // 3-CLI RCA on the duplicate-session symptom converged on this race.
            const tmpSession = db.getSession(tmpId);
            db.db.transaction(() => {
              db.upsertSession(realId, projectId, tmpSession?.name || null, tmpSession?.cli_type || 'claude');
              if (tmpSession?.user_renamed) db.renameSession(realId, tmpSession.name);
              if (tmpSession?.notes) db.setSessionNotes(realId, tmpSession.notes);
              if (tmpSession?.state && tmpSession.state !== 'active')
                db.setSessionState(realId, tmpSession.state);
              db.deleteSession(tmpId);
            })();

            try {
              await safe.tmuxExecAsync(['rename-session', '-t', tmux, tmuxName(realId)]);
            } catch (renameErr) {
              if (
                renameErr.message &&
                (renameErr.message.includes('no server running') ||
                  renameErr.message.includes('error connecting to'))
              ) {
                /* expected: tmux server may have stopped */
              } else {
                logger.debug('tmux rename skipped (session may be dead)', {
                  module: 'session-resolver',
                  err: renameErr.message,
                });
              }
            }
            return;
          }
        } catch (err) {
          if (err.code === 'ENOENT') {
            if (i === 0) {
              logger.info('Waiting for sessions dir / JSONL to appear', {
                module: 'session-resolver',
                tmpId: tmpId.substring(0, 12),
              });
            }
            /* expected: sessions directory not created yet by claude CLI */
          } else {
            logger.error('Error scanning sessions dir', {
              module: 'session-resolver',
              op: 'resolveSessionId',
              err: err.message,
            });
          }
        }
      }

      logger.warn('Session resolution timed out — JSONL never appeared', {
        module: 'session-resolver',
        tmpId: tmpId.substring(0, 12),
        projectId,
      });
      if (!(await tmuxExists(tmux))) {
        db.deleteSession(tmpId);
        logger.info('Cleaned up orphaned temp session (tmux dead)', {
          module: 'session-resolver',
          tmpId: tmpId.substring(0, 12),
        });
      } else {
        logger.info('tmux still running; leaving temp session for later resolution', {
          module: 'session-resolver',
          tmpId: tmpId.substring(0, 12),
        });
      }
    } finally {
      pendingResolutions.delete(tmpId);
    }
  }

  async function resolveStaleNewSessions() {
    const dbProjects = db.getProjects();
    for (const dbProj of dbProjects) {
      const sessions = db.getSessionsForProject(dbProj.id);
      const staleSessions = sessions.filter((s) => s.id.startsWith('new_'));
      if (staleSessions.length === 0) continue;

      const sessionsDir = safe.findSessionsDir(dbProj.path);
      let files;
      try {
        files = await fsp.readdir(sessionsDir);
      } catch (err) {
        if (err.code === 'ENOENT') {
          /* expected: project has no sessions dir yet — clean up all stale entries */
          for (const stale of staleSessions) {
            logger.info('Startup: removing orphaned temp session (no sessions dir)', {
              module: 'session-resolver',
              staleId: stale.id.substring(0, 15),
            });
            db.deleteSession(stale.id);
          }
        } else {
          logger.error('Cannot read sessions dir for stale check', {
            module: 'session-resolver',
            op: 'resolveStaleNewSessions',
            err: err.message,
          });
        }
        continue;
      }
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
      const dbSessionIds = new Set(sessions.map((s) => s.id));
      const unresolvedJsonls = jsonlFiles.filter((f) => !dbSessionIds.has(basename(f, '.jsonl')));

      for (const stale of staleSessions) {
        // Non-Claude CLIs don't create JSONL files — don't match them to orphans
        if (stale.cli_type && stale.cli_type !== 'claude') {
          logger.info('Startup: keeping non-Claude temp session', {
            module: 'session-resolver',
            staleId: stale.id.substring(0, 15),
            cli: stale.cli_type,
          });
          continue;
        }
        if (unresolvedJsonls.length > 0) {
          const jsonlFile = unresolvedJsonls.shift();
          const realId = basename(jsonlFile, '.jsonl');

          if (db.getSession(realId)) {
            logger.info('Startup: real session already exists, removing stale entry', {
              module: 'session-resolver',
              staleId: stale.id.substring(0, 15),
              realId: realId.substring(0, 8),
            });
            db.deleteSession(stale.id);
            continue;
          }

          logger.info('Startup: resolved stale session', {
            module: 'session-resolver',
            from: stale.id.substring(0, 15),
            to: realId.substring(0, 8),
          });
          // #147: same atomic-handoff transaction as resolveSessionId.
          db.db.transaction(() => {
            db.upsertSession(realId, dbProj.id, stale.name || null, stale.cli_type || 'claude');
            if (stale.user_renamed) db.renameSession(realId, stale.name);
            if (stale.notes) db.setSessionNotes(realId, stale.notes);
            if (stale.state && stale.state !== 'active') db.setSessionState(realId, stale.state);
            db.deleteSession(stale.id);
          })();
        } else {
          logger.info('Startup: removing orphaned temp session', {
            module: 'session-resolver',
            staleId: stale.id.substring(0, 15),
          });
          db.deleteSession(stale.id);
        }
      }
    }
  }

  /**
   * Discover the CLI's internal session ID for a Gemini or Codex session.
   * Polls for up to 60s looking for a new session file to appear after creation.
   */
  async function discoverCliSessionId(workbenchSessionId, cliType) {
    if (pendingResolutions.has(workbenchSessionId)) return;
    pendingResolutions.set(workbenchSessionId, true);

    const home = safe.HOME;
    const maxWait = 30; // 30 attempts × 2s = 60s

    try {
      // Snapshot existing session files before the CLI creates a new one
      let existingFiles = new Set();

      if (cliType === 'gemini') {
        const geminiBase = join(home, '.gemini', 'tmp');
        try {
          const dirs = fs.readdirSync(geminiBase, { withFileTypes: true });
          for (const d of dirs) {
            if (!d.isDirectory()) continue;
            const chatsDir = join(geminiBase, d.name, 'chats');
            try {
              const files = fs.readdirSync(chatsDir);
              files.forEach(f => existingFiles.add(join(chatsDir, f)));
            } catch { /* no chats dir */ }
          }
        } catch { /* no gemini dir */ }
      }

      if (cliType === 'codex') {
        const sessBase = join(home, '.codex', 'sessions');
        try {
          const walk = (dir) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
              const full = join(dir, e.name);
              if (e.isDirectory()) walk(full);
              else existingFiles.add(full);
            }
          };
          if (fs.existsSync(sessBase)) walk(sessBase);
        } catch { /* no codex sessions */ }
      }

      for (let i = 0; i < maxWait; i++) {
        await sleep(sleepMs);

        if (cliType === 'gemini') {
          const geminiBase = join(home, '.gemini', 'tmp');
          try {
            const dirs = fs.readdirSync(geminiBase, { withFileTypes: true });
            for (const d of dirs) {
              if (!d.isDirectory()) continue;
              const chatsDir = join(geminiBase, d.name, 'chats');
              try {
                const allFiles = await fsp.readdir(chatsDir);
                const files = allFiles.filter(f => f.endsWith('.json'));
                for (const f of files) {
                  const fullPath = join(chatsDir, f);
                  if (existingFiles.has(fullPath)) continue;
                  // New file found — read its sessionId
                  try {
                    const data = JSON.parse(await fsp.readFile(fullPath, 'utf-8'));
                    if (data.sessionId) {
                      logger.info('Gemini CLI session ID discovered', {
                        module: 'session-resolver',
                        workbenchId: workbenchSessionId.substring(0, 12),
                        cliSessionId: data.sessionId.substring(0, 12),
                      });
                      db.setCliSessionId(workbenchSessionId, data.sessionId);
                      return;
                    }
                  } catch { /* parse error */ }
                }
              } catch { /* no chats dir */ }
            }
          } catch { /* no gemini dir */ }
        }

        if (cliType === 'codex') {
          const sessBase = join(home, '.codex', 'sessions');
          try {
            if (fs.existsSync(sessBase)) {
              const walk = (dir) => {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const e of entries) {
                  const full = join(dir, e.name);
                  if (e.isDirectory()) {
                    const found = walk(full);
                    if (found) return found;
                  } else if (e.name.endsWith('.jsonl') && !existingFiles.has(full)) {
                    // New rollout file — extract UUID from filename for resume
                    // Codex files: /sessions/YYYY/MM/DD/rollout-{timestamp}-{uuid}.jsonl
                    const name = basename(e.name, '.jsonl');
                    const uuidMatch = name.match(CODEX_ROLLOUT_UUID_RE);
                    return uuidMatch ? uuidMatch[1] : name;
                  }
                }
                return null;
              };
              const codexId = walk(sessBase);
              if (codexId) {
                logger.info('Codex CLI session ID discovered', {
                  module: 'session-resolver',
                  workbenchId: workbenchSessionId.substring(0, 12),
                  cliSessionId: codexId.substring(0, 12),
                });
                db.setCliSessionId(workbenchSessionId, codexId);
                return;
              }
            }
          } catch { /* scan error */ }
        }
      }

      logger.warn('CLI session ID discovery timed out', {
        module: 'session-resolver',
        workbenchId: workbenchSessionId.substring(0, 12),
        cliType,
      });
    } finally {
      pendingResolutions.delete(workbenchSessionId);
    }
  }

  return {
    resolveSessionId,
    resolveStaleNewSessions,
    discoverCliSessionId,
    __getPendingResolutions: () => pendingResolutions,
  };
};
