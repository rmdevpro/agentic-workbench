'use strict';

function register(app, {
  keepalive,
  getBrowserCount,
}) {
  // checkAuthStatus is provided by the sessions module (returned from its register()).
  // The auth routes here call it via a deferred function reference set by routes.js.
  // We use a holder pattern so auth.js doesn't circularly depend on sessions.js.
  let _checkAuthStatus = async () => ({ valid: false, reason: 'not_initialized' });

  function setCheckAuthStatus(fn) {
    _checkAuthStatus = fn;
  }

  // ── Auth endpoints ─────────────────────────────────────────────────────────

  app.get('/api/auth/status', async (req, res) => {
    try {
      res.json(await _checkAuthStatus());
    } catch (err) {
      res.json({ valid: false, reason: err.message });
    }
  });

  // #333 [A8]: stop burning Claude tokens to verify login state. Reads
  // ~/.claude/.credentials.json instead of running `claude --print`, which
  // consumed an inference call (and a billable token) on every check.
  // Returns 200 when the cached creds are valid, 401 otherwise — same body
  // shape as before so existing UI code keeps working.
  app.post('/api/auth/login', async (req, res) => {
    try {
      const status = await _checkAuthStatus();
      if (status.valid) return res.json(status);
      return res.status(401).json(status);
    } catch (err) {
      return res.status(401).json({ valid: false, reason: err.message });
    }
  });

  // ── Keepalive endpoints ────────────────────────────────────────────────────

  app.get('/api/keepalive/status', async (req, res) => {
    const status = await keepalive.getStatus();
    res.json({ ...status, browsers: getBrowserCount() });
  });

  app.put('/api/keepalive/mode', (req, res) => {
    const { mode, idleMinutes } = req.body;
    if (!['always', 'browser', 'idle'].includes(mode))
      return res.status(400).json({ error: 'mode must be always, browser, or idle' });
    if (
      idleMinutes !== undefined &&
      (typeof idleMinutes !== 'number' || idleMinutes < 1 || idleMinutes > 1440)
    ) {
      return res.status(400).json({ error: 'idleMinutes must be a number between 1 and 1440' });
    }
    keepalive.setMode(mode, idleMinutes);
    if (mode === 'always' && !keepalive.isRunning()) keepalive.start();
    if (mode === 'browser' && getBrowserCount() === 0) keepalive.stop();
    res.json({ mode: keepalive.getMode(), running: keepalive.isRunning() });
  });

  return { setCheckAuthStatus };
}

module.exports = { register };
