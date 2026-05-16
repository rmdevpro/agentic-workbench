'use strict';

// #585: renderSidebar() previously rebuilt the sidebar's full innerHTML on every
// state diff, stalling the main thread under realistic session counts (#484
// typing pauses). The fix replaces the rebuild with a keyed reconciler so DOM
// nodes survive across renders and only mutable cells are touched. These tests
// pin the structural contract so a future "simplify back to innerHTML" doesn't
// silently re-introduce the stall.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SIDEBAR = path.join(__dirname, '..', '..', 'public', 'js', 'sidebar.js');
const SRC = fs.readFileSync(SIDEBAR, 'utf-8');

test('I585-01: renderSidebar() body does NOT clear the container via innerHTML = "" (full-rebuild path is gone)', () => {
  const m = SRC.match(/export function renderSidebar\s*\([\s\S]*?\n\}/);
  assert.ok(m, 'renderSidebar must still exist as an exported function');
  const body = m[0];
  assert.ok(
    !/container\.innerHTML\s*=\s*['"]['"]/.test(body),
    'renderSidebar must not clear #project-list via innerHTML = "" (that is the #484 stall vector — use _reconcileKeyed instead)'
  );
});

test('I585-02: a keyed reconciler helper is defined (_reconcileKeyed) and uses data-rk for stable identity', () => {
  assert.ok(/function _reconcileKeyed\s*\(/.test(SRC), 'sidebar.js must define _reconcileKeyed');
  assert.ok(/dataset\.rk/.test(SRC), '_reconcileKeyed must key children by dataset.rk');
});

test('I585-03: renderSidebar invokes _reconcileKeyed for the top-level container (programs are reconciled, not rebuilt)', () => {
  const m = SRC.match(/export function renderSidebar\s*\([\s\S]*?\n\}/);
  assert.ok(m, 'renderSidebar must exist');
  const body = m[0];
  assert.ok(
    /_reconcileKeyed\s*\(\s*container\s*,/.test(body),
    'renderSidebar must call _reconcileKeyed(container, ...) so program nodes survive across renders'
  );
});

test('I585-04: project-group + program-section have create/update split (create attaches handlers once; update mutates only cells)', () => {
  for (const name of ['_createProjectGroup', '_updateProjectGroup', '_createProgramSection', '_updateProgramSection', '_createSessionItem', '_updateSessionItem']) {
    assert.ok(
      new RegExp(`function ${name}\\s*\\(`).test(SRC),
      `sidebar.js must define ${name} (create/update split is what lets handlers attach once and persist across renders)`
    );
  }
});

test('I585-05: session-item event handlers read item._session / item._project (current state, not stale closure)', () => {
  // Find the createSessionItem body
  const m = SRC.match(/function _createSessionItem\s*\([\s\S]*?\n\}/);
  assert.ok(m, '_createSessionItem must be present');
  const body = m[0];
  // Click + action handlers must each look up current state on the node — not
  // capture a per-render `session` / `project` (the bug the keyed approach is
  // meant to avoid). Concretely: every handler should reference item._session
  // or item._project, never an outer-scope `session`/`project` parameter.
  assert.ok(/item\._session/.test(body), 'session-item handlers must read item._session for current state');
  assert.ok(/item\._project/.test(body), 'session-item handlers must read item._project for current state');
});

test('I585-06: project-group reconciles its session-list children via _reconcileKeyed (sessions survive across renders)', () => {
  const m = SRC.match(/function _updateProjectGroup\s*\([\s\S]*?\n\}/);
  assert.ok(m, '_updateProjectGroup must exist');
  const body = m[0];
  assert.ok(/_reconcileKeyed\s*\(/.test(body), '_updateProjectGroup must call _reconcileKeyed to update its session-list children');
  // session id is the stable key
  assert.ok(/session\.id/.test(body), '_updateProjectGroup reconcile must use session.id as the key');
});
