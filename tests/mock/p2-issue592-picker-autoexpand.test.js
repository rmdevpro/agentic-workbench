'use strict';

// #592: Add Project flow used to leave the destination program collapsed
// because pickerSelect didn't add it to `expandedPrograms` before triggering
// loadState. The CSS rule
//   .program-header.collapsed + .program-children { display: none; }
// then hid the newly-added project until the user manually expanded the
// program. The fix adds 12 lines inside pickerSelect that compute the
// destination key (`__unassigned__` for null program_id, else String(id))
// and add it to `expandedPrograms` + persist to localStorage. These pins
// keep the fix from quietly reverting.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'app.js'), 'utf-8');

function _pickerSelectBody() {
  // pickerSelect is `async function pickerSelect(…) { … }`. Grab through the
  // function's first closing `}` at its own indentation column.
  const m = APP.match(/async\s+function\s+pickerSelect\s*\([\s\S]*?\n\}/);
  assert.ok(m, 'app.js must define pickerSelect()');
  return m[0];
}

test('I592-01: pickerSelect adds the destination program to expandedPrograms', () => {
  const body = _pickerSelectBody();
  assert.ok(
    /expandedPrograms\.add\s*\(/.test(body),
    'pickerSelect must call expandedPrograms.add(…) so the destination program is auto-expanded after Add Project'
  );
});

test('I592-02: pickerSelect persists expandedPrograms to localStorage', () => {
  const body = _pickerSelectBody();
  assert.ok(
    /localStorage\.setItem\s*\(\s*['"]expandedPrograms['"]/.test(body),
    'pickerSelect must persist expandedPrograms to localStorage so the expansion survives reload'
  );
});

test('I592-03: pickerSelect handles unassigned (null program_id) via the __unassigned__ key', () => {
  const body = _pickerSelectBody();
  // Either an explicit `__unassigned__` literal or a conditional that routes
  // null program_id through that key.
  assert.ok(
    /__unassigned__/.test(body),
    'pickerSelect must use the __unassigned__ key when destination program_id is null, matching sidebar.js project-bucketing'
  );
});

test('I592-04: auto-expand happens BEFORE loadState (so the render sees the expanded key)', () => {
  const body = _pickerSelectBody();
  const addIdx = body.search(/expandedPrograms\.add\s*\(/);
  const loadIdx = body.search(/loadState\s*\(/);
  assert.notEqual(addIdx, -1, 'expandedPrograms.add(…) must be present');
  assert.notEqual(loadIdx, -1, 'loadState(…) must be invoked');
  assert.ok(
    addIdx < loadIdx,
    `expandedPrograms.add(…) must precede loadState(…) — found add@${addIdx} vs load@${loadIdx}`
  );
});
