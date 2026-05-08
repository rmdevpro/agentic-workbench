'use strict';

const ptyDefault = require('node-pty');

module.exports = function createWsTerminal({
  safe,
  keepalive,
  logger,
  config,
  sessionWsClients,
  getBrowserCount: _getBrowserCount,
  incrementBrowserCount,
  decrementBrowserCount,
  tmuxExists,
  cancelTmuxCleanup,
  scheduleTmuxCleanup,
  startJsonlWatcher,
  stopJsonlWatcher,
  spawnPty,
  // #157: db is needed to look up the workbench session by tmuxName prefix so we
  // can auto-respawn a dead tmux pane (project_path + cli_type) when a tab tries
  // to reattach after idle-cleanup or container restart killed it.
  db,
}) {
  const highWater = config ? config.get('ws.bufferHighWaterMark', 1048576) : 1048576;
  const lowWater = config ? config.get('ws.bufferLowWaterMark', 524288) : 524288;
  const pingIntervalMs = config ? config.get('ws.pingIntervalMs', 30000) : 30000;
  const ptySpawn = spawnPty || ptyDefault.spawn;

  function dbgTab(event, extra) {
    if (!(config && config.get('debug.tabSwitching', false))) return;
    logger.info(`[tab-dbg] ${event}`, { module: 'ws-terminal', ...extra, mapSize: sessionWsClients.size, mapKeys: [...sessionWsClients.keys()] });
  }

  // #157 (3-CLI review): in-flight respawn map keyed by tmuxSession. Rapid parallel
  // reconnects to the same dead pane all wait on the same promise instead of each
  // calling tmuxCreateCLI (which would double-spawn or race the existence check).
  const _respawnsInFlight = new Map();

  async function handleTerminalConnection(ws, tmuxSession) {
    tmuxSession = safe.sanitizeTmuxName(tmuxSession);
    dbgTab('connect:enter', { tmuxSession });

    if (!(await tmuxExists(tmuxSession))) {
      // #157: tab is reconnecting to a session whose tmux pane is gone (idle
      // cleanup, container restart, etc.). Try to respawn instead of forcing
      // the user to close + relaunch the tab. tmuxName format: wb_<id12>_<hash>
      let respawned = false;
      if (db && tmuxSession.startsWith('wb_')) {
        // 3-CLI review concern: dedupe rapid parallel reconnects. If a respawn is
        // already in flight for this tmuxSession, wait on its promise instead of
        // starting a second tmuxCreateCLI race.
        let inFlight = _respawnsInFlight.get(tmuxSession);
        if (!inFlight) {
          inFlight = (async () => {
            try {
              const idPrefix = tmuxSession.slice(3, 15);
              const sessRow = db.getSessionByPrefix(idPrefix);
              if (!sessRow || !sessRow.project_path) return false;
              // 3-CLI review concern: validate the prefix lookup actually points
              // back to THIS tmuxSession (defense vs prefix collisions across
              // session ids that share their first 12 chars).
              const expectedTmux = safe.tmuxNameFor(sessRow.id);
              if (expectedTmux !== tmuxSession) {
                logger.warn('Auto-respawn: prefix-matched session does not derive same tmuxName', {
                  module: 'ws-terminal', tmuxSession, expectedTmux, sessionId: sessRow.id,
                });
                return false;
              }
              dbgTab('connect:respawning-tmux', { tmuxSession, sessionId: sessRow.id, cli: sessRow.cli_type });
              // Re-check just before spawn (race against another reconnect that
              // might have created the pane between our first check and this one).
              if (await tmuxExists(tmuxSession)) return true;
              // CRITICAL: must pass --resume <id> (or codex resume <id>) so the
              // respawned CLI continues writing into the SAME JSONL the workbench
              // tracks. Empty args here was the bug that silently re-keyed
              // session af3c11be → 1649f318 across the M5 cutover (no --resume,
              // Claude minted a new UUID, status bar/qdrant/sidebar all started
              // measuring the dead JSONL instead of the live one).
              const { args: resumeArgs, missing, expectedPath } = await safe.buildResumeArgs(sessRow, sessRow.project_path);
              if (missing) {
                logger.warn('Refusing to auto-respawn session — JSONL missing on disk', {
                  module: 'ws-terminal', tmuxSession, sessionId: sessRow.id.substring(0, 12), expectedPath,
                });
                return false;
              }
              safe.tmuxCreateCLI(tmuxSession, sessRow.project_path, sessRow.cli_type || 'claude', resumeArgs, { workbenchSessionId: sessRow.id });
              // Confirm pane is up before attaching (tmuxCreateCLI uses execFileSync
              // but tmux server may need a beat to register).
              for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 100));
                if (await tmuxExists(tmuxSession)) {
                  logger.info('Auto-respawned dead tmux session for reconnecting tab', {
                    module: 'ws-terminal', tmuxSession, sessionId: sessRow.id.substring(0, 12), cli: sessRow.cli_type,
                  });
                  return true;
                }
              }
              return false;
            } catch (err) {
              logger.warn('Auto-respawn failed', { module: 'ws-terminal', tmuxSession, err: err.message });
              return false;
            } finally {
              _respawnsInFlight.delete(tmuxSession);
            }
          })();
          _respawnsInFlight.set(tmuxSession, inFlight);
        }
        respawned = await inFlight;
      }
      if (!respawned) {
        dbgTab('connect:no-tmux-session', { tmuxSession });
        ws.send(JSON.stringify({ type: 'error', message: `No tmux session: ${tmuxSession}` }));
        ws.close();
        return;
      }
    }

    // #241: replay the tmux pane's scrollback BEFORE attaching the PTY so a
    // reconnecting browser sees history above the visible viewport. tmux
    // attach-session only redraws the visible pane on its own; without this
    // the user loses everything they could previously scroll up to. We send
    // the captured bytes first so they land in xterm's scrollback, then the
    // PTY's tmux attach-session redraws the visible pane on top.
    try {
      const replayLines = config ? config.get('ws.scrollbackReplayLines', 10000) : 10000;
      const captured = safe.tmuxCaptureScrollback(tmuxSession, replayLines);
      if (captured && ws.readyState === ws.OPEN) {
        ws.send(captured);
      }
    } catch (err) {
      // Capture failure is non-fatal — log and proceed with the live attach.
      logger.warn('Scrollback replay capture failed', { module: 'ws-terminal', tmuxSession, err: err.message });
    }

    // NOTE: node-pty.spawn() is synchronous by design (native addon fork).
    // This is the standard pattern used by VS Code terminal, xterm.js, and all
    // major Node.js terminal emulators. The spawn is fast (fork+exec) and does
    // not block the event loop for meaningful durations.
    // TODO(async): ERQ-001 §4.1 — if a non-blocking PTY library becomes available, migrate.
    let ptyProcess;
    try {
      ptyProcess = ptySpawn('tmux', ['attach-session', '-t', tmuxSession], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
    } catch (err) {
      logger.error('Failed to spawn PTY process', {
        module: 'ws-terminal',
        op: 'handleTerminalConnection',
        tmuxSession,
        err: err.message,
      });
      ws.close();
      return;
    }

    const browserCount = incrementBrowserCount();
    keepalive.onBrowserConnect();
    cancelTmuxCleanup(tmuxSession);
    logger.info('PTY attached to tmux session', {
      module: 'ws-terminal',
      tmuxSession,
      pid: ptyProcess.pid,
      browsers: browserCount,
    });

    const prevWs = sessionWsClients.get(tmuxSession);
    sessionWsClients.set(tmuxSession, ws);
    dbgTab('connect:registered', { tmuxSession, overwritingPrevWs: !!prevWs, ptyPid: ptyProcess.pid });
    startJsonlWatcher(tmuxSession);

    let isPaused = false;
    let checkBufferInterval = null;
    ws.isAlive = true;

    ptyProcess.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
        if (ws.bufferedAmount > highWater && !isPaused) {
          isPaused = true;
          ptyProcess.pause();
          checkBufferInterval = setInterval(() => {
            if (ws.bufferedAmount < lowWater) {
              ptyProcess.resume();
              isPaused = false;
              clearInterval(checkBufferInterval);
              checkBufferInterval = null;
            } else if (ws.readyState !== ws.OPEN) {
              clearInterval(checkBufferInterval);
              checkBufferInterval = null;
            }
          }, 100);
        }
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      logger.info('PTY exited', { module: 'ws-terminal', tmuxSession, exitCode });
      if (ws.readyState === ws.OPEN) {
        ws.send('\r\n\x1b[33m[Session detached]\x1b[0m\r\n');
        ws.close();
      }
    });

    ws.on('message', (data) => {
      const msg = data.toString();
      if (msg.startsWith('{')) {
        try {
          const ctrl = JSON.parse(msg);
          if (ctrl.type === 'resize') {
            // Always consume resize frames. Invalid dims (null / zero /
            // non-numeric) must NOT fall through to ptyProcess.write —
            // that would dump the JSON onto the CLI's stdin as if the user
            // typed it (bug #162).
            if (
              Number.isFinite(ctrl.cols) &&
              Number.isFinite(ctrl.rows) &&
              ctrl.cols > 0 &&
              ctrl.rows > 0
            ) {
              ptyProcess.resize(ctrl.cols, ctrl.rows);
            } else {
              logger.warn('Ignoring resize frame with invalid dims', {
                module: 'ws-terminal',
                tmuxSession,
                cols: ctrl.cols,
                rows: ctrl.rows,
              });
            }
            return;
          }
          if (ctrl.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
          }
          /* unknown control frame type — fall through and treat as typed text */
        } catch (_parseErr) {
          /* expected: not all messages starting with '{' are valid JSON control frames */
          logger.debug('Non-JSON-control message received', { module: 'ws-terminal', tmuxSession });
        }
      }
      try {
        ptyProcess.write(msg);
      } catch (err) {
        logger.error('Failed to write to PTY', {
          module: 'ws-terminal',
          op: 'ws.on(message)',
          tmuxSession,
          err: err.message,
        });
      }
    });

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    const pingInterval = setInterval(() => {
      if (ws.isAlive === false) {
        logger.info('WebSocket connection timeout — closing', {
          module: 'ws-terminal',
          tmuxSession,
        });
        return ws.terminate();
      }
      ws.isAlive = false;
      if (ws.readyState === ws.OPEN) ws.ping();
    }, pingIntervalMs);

    ws.on('close', (code, reason) => {
      dbgTab('ws:close', { tmuxSession, code, reason: reason?.toString?.() });
      clearInterval(pingInterval);
      if (checkBufferInterval) clearInterval(checkBufferInterval);
      const remaining = decrementBrowserCount();
      keepalive.onBrowserDisconnect(remaining);
      logger.info('Browser disconnected from tmux', {
        module: 'ws-terminal',
        tmuxSession,
        browsers: remaining,
      });
      if (ptyProcess) ptyProcess.kill();
      const stillMapped = sessionWsClients.get(tmuxSession) === ws;
      sessionWsClients.delete(tmuxSession);
      dbgTab('ws:close:cleaned', { tmuxSession, stillMapped });
      stopJsonlWatcher(tmuxSession);
      scheduleTmuxCleanup(tmuxSession);
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error', {
        module: 'ws-terminal',
        op: 'ws.on(error)',
        tmuxSession,
        err: err.message,
      });
      if (ptyProcess) ptyProcess.kill();
    });
  }

  return { handleTerminalConnection };
};
