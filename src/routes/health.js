'use strict';

const { access } = require('./_shared');

function register(app, {
  db,
  logger,
  WORKSPACE,
}, checkAuthStatus) {
  // ── GET /health ───────────────────────────────────────────────────────────

  app.get('/health', async (req, res) => {
    const deps = { db: 'unknown', workspace: 'unknown', auth: 'unknown' };
    let healthy = true;
    try {
      db.getProjects();
      deps.db = 'healthy';
    } catch (err) {
      deps.db = 'degraded';
      healthy = false;
      logger.warn('Health check: db degraded', { module: 'routes', err: err.message });
    }
    try {
      await access(WORKSPACE);
      deps.workspace = 'healthy';
    } catch (err) {
      deps.workspace = 'degraded';
      healthy = false;
      logger.warn('Health check: workspace degraded', { module: 'routes', err: err.message });
    }
    try {
      const auth = await checkAuthStatus();
      deps.auth = auth.valid ? 'healthy' : 'degraded';
      // Auth is informational only — does not affect overall healthy status
    } catch (_err) {
      deps.auth = 'degraded';
    }
    res
      .status(healthy ? 200 : 503)
      .json({ status: healthy ? 'ok' : 'degraded', dependencies: deps });
  });
}

module.exports = { register };
