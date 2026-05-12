'use strict';

// Phase 2 reviewer findings: structural and behavioural checks for
// #453, #454, #455, #456, #460, #461.
//
// #452/#457 (window exports) and #459 (duplicate window.openSettings) are
// frontend-only; covered by stage-8 UI tests, not mock tests.
//
// #458 (require-hoist) is already covered by tests/mock/require-hoist.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { withServer, req } = require('../helpers/with-server');
const { registerMcpRoutes } = require('../../src/mcp-tools.js');

const SESSIONS_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'routes', 'sessions.js'), 'utf-8');
const SEEDER_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'session-seeder.js'), 'utf-8');

// ── #453 — per-request claimed Sets ─────────────────────────────────────────

test('#453-01: buildSessionList signature accepts claimedGemini and claimedCodex parameters', () => {
  // Static: verify the function signature captures both sets as parameters
  // rather than reading module-level state. The race condition existed because
  // module-level Sets were shared across concurrent /api/state polls.
  assert.ok(
    /async function buildSessionList\s*\(dbSessions,\s*_sessDir,\s*claimedGemini,\s*claimedCodex\)/.test(SESSIONS_SRC),
    'buildSessionList must accept claimedGemini and claimedCodex as parameters',
  );
});

test('#453-02: /api/state handler allocates claimedGemini and claimedCodex Sets before project loop', () => {
  // The fix requires the Sets to be allocated once per request so they span
  // all projects. The old fix (inside buildSessionList) re-allocated per project.
  const stateHandlerIdx = SESSIONS_SRC.indexOf("app.get('/api/state'");
  assert.ok(stateHandlerIdx >= 0, '/api/state handler must be present');
  const handlerBody = SESSIONS_SRC.slice(stateHandlerIdx, stateHandlerIdx + 1500);

  assert.ok(
    /const claimedGemini\s*=\s*new Set\(\)/.test(handlerBody),
    'claimedGemini must be allocated inside the /api/state handler before the project loop',
  );
  assert.ok(
    /const claimedCodex\s*=\s*new Set\(\)/.test(handlerBody),
    'claimedCodex must be allocated inside the /api/state handler before the project loop',
  );
  // The old module-level Sets must not exist
  assert.ok(
    !/^  const _claimedGemini\s*=\s*new Set/m.test(SESSIONS_SRC),
    'module-level _claimedGemini Set must not exist (race condition eliminated)',
  );
  assert.ok(
    !/^  const _claimedCodex\s*=\s*new Set/m.test(SESSIONS_SRC),
    'module-level _claimedCodex Set must not exist (race condition eliminated)',
  );
});

// ── #454 — createTrustDir consolidated ──────────────────────────────────────

test('#454-01: createTrustDir is exported from _shared.js', () => {
  const shared = require('../../src/routes/_shared');
  assert.equal(typeof shared.createTrustDir, 'function',
    '_shared.js must export createTrustDir');
});

test('#454-02: sessions.js uses createTrustDir from _shared, not inline definition', () => {
  assert.ok(
    /createTrustDir/.test(SESSIONS_SRC),
    'sessions.js must reference createTrustDir',
  );
  // Inline implementation removed: the old lock variable was _trustDirLock
  assert.ok(
    !/let _trustDirLock/.test(SESSIONS_SRC),
    'sessions.js must not contain inline _trustDirLock (now in _shared.createTrustDir)',
  );
});

test('#454-03: projects.js uses createTrustDir from _shared, not inline definition', () => {
  const projSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'routes', 'projects.js'), 'utf-8');
  assert.ok(
    /createTrustDir/.test(projSrc),
    'projects.js must reference createTrustDir',
  );
  assert.ok(
    !/let _trustDirLock/.test(projSrc),
    'projects.js must not contain inline _trustDirLock (now in _shared.createTrustDir)',
  );
});

// ── #455 — _seedRole DI ─────────────────────────────────────────────────────

test('#455-01: _seedRole accepts safe as its final injected parameter', () => {
  // Prior to the fix, _seedRole called safeExec directly (hardcoded require).
  // After fix: last parameter is `safe`, which is passed from the call site.
  assert.ok(
    /async function _seedRole\s*\([^)]*,\s*safe\s*\)/.test(SEEDER_SRC),
    '_seedRole must have safe as its final parameter',
  );
});

test('#455-02: session-seeder.js does not require safe-exec directly', () => {
  assert.ok(
    !SEEDER_SRC.includes("require('./safe-exec')"),
    "session-seeder.js must not require('./safe-exec') directly; safe is injected",
  );
});

test('#455-03: sessions.js passes safe to _seedRole call site', () => {
  const callSiteMatch = SESSIONS_SRC.match(/_seedRole\([^)]+\)/);
  assert.ok(callSiteMatch, 'sessions.js must call _seedRole');
  assert.ok(
    /,\s*safe\s*\)/.test(callSiteMatch[0]),
    `_seedRole call site in sessions.js must pass safe as the last argument. Got: ${callSiteMatch[0]}`,
  );
});

// ── #456 — _lockedAppend removed ────────────────────────────────────────────

test('#456-01: _lockedAppend is not defined in sessions.js', () => {
  assert.ok(
    !/_lockedAppend/.test(SESSIONS_SRC),
    'sessions.js must not contain _lockedAppend (dead code removed)',
  );
});

test('#456-02: fileLocks Map is not defined in sessions.js', () => {
  assert.ok(
    !/const fileLocks\s*=\s*new Map/.test(SESSIONS_SRC),
    'sessions.js must not contain fileLocks Map (removed with _lockedAppend)',
  );
});

// ── #460 — sidebar timestamp / buildSessionList uses session_meta ────────────

test('#460-01: buildSessionList reads db.getSessionMeta for Claude session timestamps', () => {
  // The fix ensures the sidebar shows real last-activity timestamps for Claude
  // sessions instead of db.updated_at (which is bumped to NOW on every poll).
  assert.ok(
    /db\.getSessionMeta\s*\(s\.id\)/.test(SESSIONS_SRC),
    'buildSessionList must call db.getSessionMeta(s.id) for Claude timestamp lookup',
  );
});

test('#460-02: buildSessionList uses file discovery timestamps for Gemini/Codex sessions', () => {
  assert.ok(
    /_getGeminiTs\b/.test(SESSIONS_SRC),
    'buildSessionList must define/call _getGeminiTs for Gemini file timestamp lookup',
  );
  assert.ok(
    /_getCodexTs\b/.test(SESSIONS_SRC),
    'buildSessionList must define/call _getCodexTs for Codex file timestamp lookup',
  );
});

// ── #461 — file_find ERE flag ────────────────────────────────────────────────

function startMcpApp() {
  const app = express();
  app.use(express.json());
  registerMcpRoutes(app);
  return app;
}

async function call(port, body) {
  const r = await req(port, 'POST', '/api/mcp/call', body);
  const json = await r.json().catch(() => ({}));
  return { status: r.status, body: json };
}

test('#461-01: file_find with a pattern containing literal parentheses does not crash grep', async () => {
  // Before the fix (-E flag missing), BRE mode treated \( as an unmatched group opener
  // and grep exited with "Unmatched ( or \(", producing a 500 from the tool.
  // After the fix, -E (ERE) treats \( as a literal '(' — succeeds, matches == array.
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, {
      tool: 'file_find',
      args: { pattern: String.raw`_seedRole\(cliType`, file_type: 'js' },
    });
    assert.equal(r.status, 200,
      `file_find with paren pattern must return 200, not 500 (got: ${r.status}). ` +
      `body: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body.result?.matches),
      'result.matches must be an array even when pattern contains escaped parens');
  });
});

test('#461-02: file_find with Object.defineProperty paren pattern returns match array', async () => {
  // Second real-world pattern from the issue: the sessionSortBy defineProperty call
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, {
      tool: 'file_find',
      args: { pattern: String.raw`Object\.defineProperty\(window` },
    });
    assert.equal(r.status, 200,
      `file_find with Object.defineProperty paren pattern must return 200 (got: ${r.status})`);
    assert.ok(Array.isArray(r.body.result?.matches),
      'result.matches must be an array for ERE pattern');
  });
});

test('#461-03: file_find grep args include -E flag (ERE mode)', () => {
  // Static: verify the handler builds grep args with -E so paren patterns
  // are always treated as ERE (literal \( = literal paren, not BRE group).
  const mcpSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'mcp-tools.js'), 'utf-8');
  const fileFindIdx = mcpSrc.indexOf('file_find');
  assert.ok(fileFindIdx >= 0, 'mcp-tools.js must contain file_find handler');
  // Extract a reasonable window around the handler
  const window2k = mcpSrc.slice(fileFindIdx, fileFindIdx + 2000);
  assert.ok(
    /'-E'/.test(window2k) || /"-E"/.test(window2k),
    "file_find handler must pass '-E' to grep for ERE mode",
  );
});

// ── #466 — writeFile in _shared + settings.js fallback chain ─────────────────

test('#466-01: writeFile is exported from _shared.js', () => {
  const shared = require('../../src/routes/_shared');
  assert.equal(typeof shared.writeFile, 'function',
    '_shared.js must export writeFile (fs/promises.writeFile); sessions.js and settings.js depend on it');
});

test('#466-02: sessions.js imports writeFile from _shared (regression guard)', () => {
  // The writeFile import was accidentally dropped in the #454 fix and caused
  // SESSION-03 to fail. This static check pins it so the regression can't recur.
  assert.ok(
    /writeFile,/.test(SESSIONS_SRC) || /writeFile\b/.test(SESSIONS_SRC.slice(0, 600)),
    'sessions.js must destructure writeFile from _shared in its top-level require',
  );
  // The actual import block
  const importBlock = SESSIONS_SRC.slice(0, SESSIONS_SRC.indexOf("require('./_shared')") + 40);
  assert.ok(
    /\bwriteFile\b/.test(importBlock),
    'writeFile must appear in the _shared destructuring block at the top of sessions.js',
  );
});

test('#466-03: settings.js claude-md routes use WORKSPACE with safe.WORKSPACE fallback', () => {
  const settingsSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'routes', 'settings.js'), 'utf-8');
  // The fix (#463/#454 regression) introduced WORKSPACE || safe.WORKSPACE || '' fallback
  // so that both prod (WORKSPACE from deps) and test (safe.WORKSPACE from safe-exec) work.
  assert.ok(
    /WORKSPACE \|\| safe\.WORKSPACE/.test(settingsSrc) || /WORKSPACE,/.test(settingsSrc.slice(0, 500)),
    'settings.js must accept WORKSPACE from register() deps; claude-md routes must not rely solely on safe.WORKSPACE',
  );
  // The WORKSPACE param must be in the register() destructuring
  const registerBlock = settingsSrc.slice(settingsSrc.indexOf('function register('), settingsSrc.indexOf(') {') + 5);
  assert.ok(
    /\bWORKSPACE\b/.test(registerBlock),
    'settings.js register() must destructure WORKSPACE from deps',
  );
});
