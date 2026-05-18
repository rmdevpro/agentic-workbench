'use strict';

const registerSessions = require('./routes/sessions');
const registerProjects = require('./routes/projects');
const { registerMcpRoutes } = require('./mcp-tools');
const { registerWebhookRoutes } = require('./webhooks');
const registerFiles = require('./routes/files');
const registerKb = require('./routes/kb');
const registerTasks = require('./routes/tasks');
const registerGitAccounts = require('./routes/git-accounts');
const registerSettings = require('./routes/settings');
const registerAuth = require('./routes/auth');
const registerHealth = require('./routes/health');
const registerState = require('./routes/state');

function registerCoreRoutes(app, deps) {
  const sessionsHandle = registerSessions.register(app, deps);
  const { checkAuthStatus, trustDir, reconcileStaleSessionsForProject, buildSessionList } =
    sessionsHandle;

  // #651 commit 5: /api/state lives in its own domain module. Receives the
  // discovery helpers from sessions.register() so the handler is behaviour-
  // equivalent to the previous implementation in sessions.js.
  registerState.register(app, deps, {
    reconcileStaleSessionsForProject,
    buildSessionList,
  });

  registerProjects.register(app, deps);
  registerFiles.register(app, deps);
  registerKb.register(app, deps);
  registerTasks.register(app, deps);
  registerGitAccounts.register(app, deps);
  registerSettings.register(app, deps);

  const { setCheckAuthStatus } = registerAuth.register(app, deps);
  setCheckAuthStatus(checkAuthStatus);

  registerHealth.register(app, deps, checkAuthStatus);

  registerMcpRoutes(app);
  registerWebhookRoutes(app);

  return { checkAuthStatus, trustDir };
}

module.exports = registerCoreRoutes;
