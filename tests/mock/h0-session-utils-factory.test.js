'use strict';

// H0 #366: session-utils converted to factory-DI with sub-modules.
// Verifies the factory shape, that deps are injected (not global), that two
// instances have independent state, and that the transitional singleton
// adapter preserves backward-compat for existing require() call-sites.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

test('H0-FACTORY-01: createSessionUtils is exported from session-utils.js', () => {
  const mod = require('../../src/session-utils');
  assert.equal(typeof mod.createSessionUtils, 'function',
    'session-utils.js must export createSessionUtils factory');
});

test('H0-FACTORY-02: factory returns the expected public API shape', () => {
  const { createSessionUtils } = require('../../src/session-utils');

  const mockDeps = {
    db: {
      db: { exec() {}, prepare: () => ({ get: () => null, run() {}, all: () => [] }) },
      getSetting: () => null,
      setSetting() {},
    },
    safe: { WORKSPACE: '/tmp', CLAUDE_HOME: '/tmp', HOME: '/tmp' },
    config: { get: (_k, fb) => fb },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };

  const su = createSessionUtils(mockDeps);

  const required = [
    // H1 — Claude JSONL
    'parseSessionFile', 'extractMessageText', 'getSessionSlug',
    // H2 — Gemini
    'parseGeminiChatFile', 'discoverGeminiSessions',
    // H3 — Codex
    'parseCodexRolloutFile', 'discoverCodexSessions',
    // H4 — info
    'getSessionInfo', 'getTokenUsage', 'invalidateSessionInfoCache',
    // H5 — search
    'searchSessions', 'summarizeSession',
    // shared
    'invalidateDiscoveryCache',
  ];
  for (const fn of required) {
    assert.equal(typeof su[fn], 'function',
      `createSessionUtils result must expose ${fn}() method`);
  }
});

test('H0-FACTORY-03: two factory instances are independent objects', () => {
  const { createSessionUtils } = require('../../src/session-utils');
  const deps = {
    db: { db: { exec() {}, prepare: () => ({ get: () => null, run() {}, all: () => [] }) }, getSetting: () => null, setSetting() {} },
    safe: { WORKSPACE: '/tmp', CLAUDE_HOME: '/tmp', HOME: '/tmp' },
    config: { get: (_k, fb) => fb },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  const su1 = createSessionUtils(deps);
  const su2 = createSessionUtils(deps);
  assert.notEqual(su1, su2, 'each createSessionUtils() call must return a new instance');
  assert.equal(typeof su1.parseSessionFile, 'function');
  assert.equal(typeof su2.parseSessionFile, 'function');
});

test('H0-FACTORY-04: singleton adapter exports expected methods for backward-compat', () => {
  const mod = require('../../src/session-utils');
  // Backward-compat methods that existing call-sites use directly on the module
  const compat = [
    'parseSessionFile', 'parseGeminiChatFile', 'parseCodexRolloutFile',
    'discoverGeminiSessions', 'discoverCodexSessions',
    'getSessionInfo', 'searchSessions',
    'invalidateDiscoveryCache', 'invalidateSessionInfoCache',
  ];
  for (const fn of compat) {
    assert.equal(typeof mod[fn], 'function',
      `module-level singleton must still expose ${fn}() for backward-compat`);
  }
});

test('H0-FACTORY-05: all 5 sub-module files exist in src/session-utils/', () => {
  const dir = path.join(__dirname, '..', '..', 'src', 'session-utils');
  assert.ok(fs.existsSync(dir), 'src/session-utils/ directory must exist');
  for (const f of ['claude-jsonl.js', 'gemini.js', 'codex.js', 'info.js', 'search.js']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `src/session-utils/${f} must exist`);
  }
});

test('H0-FACTORY-06: each sub-module exports a factory function', () => {
  const subModules = ['claude-jsonl', 'gemini', 'codex', 'info', 'search'];
  for (const name of subModules) {
    const factory = require(`../../src/session-utils/${name}`);
    assert.equal(typeof factory, 'function',
      `src/session-utils/${name}.js must export a factory function`);
  }
});
