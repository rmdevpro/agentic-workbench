'use strict';

// #595: switchTab left the bottom status bar showing the prior tab's model /
// context / connection state because _updateStatusBarRef was only called from
// pollTokenUsage, ws.onopen, and the WS token_update / settings_update
// handlers — never from the tab-switch path itself. The fix adds
// `_updateStatusBarRef && _updateStatusBarRef(panel)` to switchTab so the
// bar refreshes synchronously when the active tab changes. These pins keep
// the call site from being silently dropped in a future refactor.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TABS = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'tabs.js'), 'utf-8');

function _switchTabBody() {
  // switchTab is `export function switchTab(…) { … }` or `function switchTab(…) { … }`.
  const m = TABS.match(/(?:export\s+)?function\s+switchTab\s*\([\s\S]*?\n\}/);
  assert.ok(m, 'tabs.js must define switchTab()');
  return m[0];
}

test('I595-01: switchTab() invokes _updateStatusBarRef so the bottom bar follows the active tab', () => {
  const body = _switchTabBody();
  assert.ok(
    /_updateStatusBarRef\s*(?:&&|\?\.)/.test(body) || /_updateStatusBarRef\s*\(/.test(body),
    'switchTab must call _updateStatusBarRef(panel) — without it, the status bar stays on the previous tab\'s state'
  );
});

test('I595-02: tabs.js declares + wires _updateStatusBarRef via the factory dep-injection pattern', () => {
  assert.ok(
    /let\s+[^;]*\b_updateStatusBarRef\b/.test(TABS),
    'tabs.js must declare _updateStatusBarRef in the forward-decl block (so initTabsDeps can assign it)'
  );
  assert.ok(
    /_updateStatusBarRef\s*=\s*deps\.updateStatusBar/.test(TABS),
    'tabs.js initTabsDeps must wire _updateStatusBarRef = deps.updateStatusBar'
  );
});
