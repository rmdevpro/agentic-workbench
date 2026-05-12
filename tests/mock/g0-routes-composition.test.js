'use strict';

// G0 #365: src/routes.js decomposed into 9 domain modules under src/routes/.
// Verifies the composition layer shape, that all domain modules are hoisted
// to module scope, and that createTrustDir is consolidated in _shared.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROUTES_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes.js'), 'utf-8');

const DOMAIN_MODULES = [
  'routes/sessions',
  'routes/projects',
  'routes/files',
  'routes/kb',
  'routes/tasks',
  'routes/git-accounts',
  'routes/settings',
  'routes/auth',
  'routes/health',
];

test('G0-COMP-01: routes.js exports a single function (thin composition layer)', () => {
  const mod = require('../../src/routes');
  assert.equal(typeof mod, 'function',
    'routes.js must export a single registerCoreRoutes function');
});

test('G0-COMP-02: all 9 domain modules are required at module scope', () => {
  for (const m of DOMAIN_MODULES) {
    assert.ok(
      ROUTES_SRC.includes(`require('./${m}')`),
      `routes.js must require('./${m}') at module scope`,
    );
  }
});

test('G0-COMP-03: routes.js requires mcp-tools and webhooks at module scope (fix #458)', () => {
  assert.ok(ROUTES_SRC.includes("require('./mcp-tools')"),
    "routes.js must require('./mcp-tools') at module scope");
  assert.ok(ROUTES_SRC.includes("require('./webhooks')"),
    "routes.js must require('./webhooks') at module scope");
});

test('G0-COMP-04: registerCoreRoutes wires checkAuthStatus through to auth module', () => {
  assert.ok(/setCheckAuthStatus\b/.test(ROUTES_SRC),
    'routes.js must call setCheckAuthStatus to thread checkAuthStatus into auth module');
});

test('G0-COMP-05: registerCoreRoutes returns checkAuthStatus and trustDir', () => {
  assert.ok(/return\s*\{\s*checkAuthStatus/.test(ROUTES_SRC),
    'registerCoreRoutes must return { checkAuthStatus, trustDir }');
});

test('G0-COMP-06: each domain module has a register(app, deps) export', () => {
  const modPaths = DOMAIN_MODULES.map(m => path.join(__dirname, '..', '..', 'src', m + '.js'));
  for (const p of modPaths) {
    const src = fs.readFileSync(p, 'utf-8');
    assert.ok(
      /function register\s*\(app/.test(src) || /register\s*:\s*function/.test(src) || /module\.exports\s*=\s*\{[\s\S]*register/.test(src),
      `${path.basename(p)} must export a register(app, deps) function`,
    );
  }
});

test('G0-COMP-07: createTrustDir is exported from _shared.js (fix #454)', () => {
  const shared = require('../../src/routes/_shared');
  assert.equal(typeof shared.createTrustDir, 'function',
    '_shared.js must export createTrustDir factory function');
});

test('G0-COMP-08: createTrustDir factory accepts CLAUDE_HOME and logger and returns async function', () => {
  const { createTrustDir } = require('../../src/routes/_shared');
  const fn = createTrustDir({
    CLAUDE_HOME: '/tmp/test-claude-home',
    logger: { error() {}, warn() {}, info() {}, debug() {} },
  });
  assert.equal(typeof fn, 'function', 'createTrustDir must return a function');
  // The returned function is async; verify by checking its constructor name
  assert.equal(fn.constructor.name, 'AsyncFunction', 'trustDir function must be async');
});

test('G0-COMP-09: routes directory contains all 9 expected domain module files', () => {
  const dir = path.join(__dirname, '..', '..', 'src', 'routes');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.startsWith('_'));
  const expected = ['sessions.js', 'projects.js', 'files.js', 'kb.js', 'tasks.js',
    'git-accounts.js', 'settings.js', 'auth.js', 'health.js'];
  for (const f of expected) {
    assert.ok(files.includes(f), `src/routes/${f} must exist`);
  }
});
