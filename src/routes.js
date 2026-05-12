'use strict';

const registerSessions = require('./routes/sessions');
const registerProjects = require('./routes/projects');
const registerFiles = require('./routes/files');
const registerKb = require('./routes/kb');
const registerTasks = require('./routes/tasks');
const registerGitAccounts = require('./routes/git-accounts');
const registerSettings = require('./routes/settings');
const registerAuth = require('./routes/auth');
const registerHealth = require('./routes/health');

function registerCoreRoutes(app, deps) {
  const { checkAuthStatus, trustDir } = registerSessions.register(app, deps);

  registerProjects.register(app, deps);
  registerFiles.register(app, deps);
  registerKb.register(app, deps);
  registerTasks.register(app, deps);
  registerGitAccounts.register(app, deps);
  registerSettings.register(app, deps);

  const { setCheckAuthStatus } = registerAuth.register(app, deps);
  setCheckAuthStatus(checkAuthStatus);

  registerHealth.register(app, deps, checkAuthStatus);

  const { registerMcpRoutes } = require('./mcp-tools');
  const { registerWebhookRoutes } = require('./webhooks');
  registerMcpRoutes(app);
  registerWebhookRoutes(app);

  return { checkAuthStatus, trustDir };
}

module.exports = registerCoreRoutes;
