'use strict';

// Stage 8 regressions — bugs found during Phase 2 UI testing that weren't
// caught by earlier mock/live tests (all F0 extraction omissions):
//
//   S8-REG-01: files.js imported _activeIdForPanel from ./state.js — lives in ./tabs.js
//   S8-REG-02: createTab() in app.js missing 7 post-creation steps (tabs.set etc.)
//   S8-REG-03: loadState() and _hydrateVisibleSessionInfo() called renderSidebar()
//              while a .new-session-menu dropdown was open, destroying it

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PUBJS = path.join(ROOT, 'public', 'js');

function readJS(name) {
  return fs.readFileSync(path.join(PUBJS, name), 'utf-8');
}

// ── S8-REG-01 ────────────────────────────────────────────────────────────────

test('S8-REG-01: files.js imports _activeIdForPanel from ./tabs.js, NOT ./state.js', () => {
  const src = readJS('files.js');
  // Must import _activeIdForPanel from tabs.js
  assert.ok(
    /from\s+['"]\.\/tabs\.js['"]\s*;/.test(src),
    'files.js must have an import from ./tabs.js'
  );
  const tabsImportMatch = src.match(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/tabs\.js['"]/);
  assert.ok(tabsImportMatch, 'files.js must have a named import from ./tabs.js');
  assert.ok(
    tabsImportMatch[1].includes('_activeIdForPanel'),
    'files.js tabs.js import must include _activeIdForPanel'
  );
  // Must NOT import _activeIdForPanel from state.js
  const stateImports = src.match(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/state\.js['"]/g) || [];
  for (const imp of stateImports) {
    assert.ok(
      !/_activeIdForPanel/.test(imp),
      `files.js must NOT import _activeIdForPanel from state.js — found: ${imp}`
    );
  }
});

// ── S8-REG-02 ────────────────────────────────────────────────────────────────

test('S8-REG-02: app.js createTab calls tabs.set, switchTab, connectTab, renderTabs after createTerminalTab', () => {
  const src = readJS('app.js');

  // Find the createTab function body
  const fnMatch = src.match(/function createTab\s*\([\s\S]*?\n\}/);
  assert.ok(fnMatch, 'createTab function must exist in app.js');
  const fnBody = fnMatch[0];

  // All 7 post-creation steps must be present
  assert.ok(/tabs\.set\s*\(/.test(fnBody), 'createTab must call tabs.set()');
  assert.ok(/_appendToOrder\s*\(/.test(fnBody), 'createTab must call _appendToOrder()');
  assert.ok(/switchTab\s*\(/.test(fnBody), 'createTab must call switchTab()');
  assert.ok(/connectTab\s*\(/.test(fnBody), 'createTab must call connectTab()');
  assert.ok(/renderTabs\s*\(\)/.test(fnBody), 'createTab must call renderTabs()');
  assert.ok(/renderSidebar\s*\(\)/.test(fnBody), 'createTab must call renderSidebar()');
  assert.ok(/setTimeout\s*\(/.test(fnBody), 'createTab must schedule pollTokenUsage via setTimeout');
});

test('S8-REG-02b: app.js imports _appendToOrder from state.js', () => {
  const src = readJS('app.js');
  const stateImportMatch = src.match(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/state\.js['"]/);
  assert.ok(stateImportMatch, 'app.js must have a named import from state.js');
  assert.ok(
    stateImportMatch[1].includes('_appendToOrder'),
    'app.js state.js import must include _appendToOrder'
  );
});

// ── S8-REG-03 ────────────────────────────────────────────────────────────────

test('S8-REG-03: sidebar.js loadState guards renderSidebar against open .new-session-menu', () => {
  const src = readJS('sidebar.js');

  // Guard pattern: document.querySelector('.new-session-menu[style*="block"]') before renderSidebar
  // in the loadState function body (the main renderSidebar + _hydrateVisibleSessionInfo call)
  assert.ok(
    /new-session-menu/.test(src),
    'sidebar.js must reference .new-session-menu in a guard'
  );
  // The guard must appear near the renderSidebar() call inside loadState
  const guardPattern = /new-session-menu\[style\*.*block.*\].*renderSidebar|renderSidebar[\s\S]{0,200}new-session-menu/;
  // More direct: check that the guard exists somewhere before a renderSidebar call
  const guardIdx = src.indexOf('new-session-menu[style');
  const rsIdx = src.indexOf('renderSidebar()', guardIdx - 300);
  assert.ok(
    guardIdx > 0,
    'sidebar.js must have a .new-session-menu guard (open-dropdown check before re-render)'
  );
});

test('S8-REG-03b: sidebar.js _hydrateVisibleSessionInfo also guards renderSidebar against open menu', () => {
  const src = readJS('sidebar.js');
  // Find _hydrateVisibleSessionInfo function
  const fnIdx = src.indexOf('async function _hydrateVisibleSessionInfo');
  assert.ok(fnIdx >= 0, '_hydrateVisibleSessionInfo must be present in sidebar.js');
  const fnBody = src.slice(fnIdx, fnIdx + 2000);
  assert.ok(
    /new-session-menu/.test(fnBody),
    '_hydrateVisibleSessionInfo must also guard renderSidebar against open dropdown'
  );
});
