'use strict';

// #253: the session_send_text MCP catalog entry must advertise the 32 KiB
// size limit + recommend file-pointer indirection for larger inputs, so
// MCP callers (CLIs + agents) know not to inline-paste mega-strings.
// This pin keeps the size-limit text from being silently dropped by a
// future catalog reflow.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CATALOG = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'mcp-catalog.js'), 'utf-8');

// Walk forward from the T('session_send_text', start to find the matching
// argument-closing quote. The description contains nested `{key:"Enter"}`
// double-quotes so a simple non-quote character class doesn't work.
function _sendTextDescription() {
  const startMarker = "T('session_send_text', '";
  const start = CATALOG.indexOf(startMarker);
  assert.notEqual(start, -1, 'mcp-catalog.js must register session_send_text via T(…)');
  const after = start + startMarker.length;
  // The argument string is single-quoted. Walk until we see the next
  // unescaped single-quote that's immediately followed by `,` (the comma
  // terminating the description arg).
  for (let i = after; i < CATALOG.length; i++) {
    if (CATALOG[i] === "'" && CATALOG[i - 1] !== '\\' && CATALOG[i + 1] === ',') {
      return CATALOG.slice(after, i);
    }
  }
  throw new Error('Could not find terminating quote for session_send_text description');
}

test('I253-01: session_send_text catalog entry advertises 32 KiB size limit', () => {
  const description = _sendTextDescription();
  assert.match(
    description,
    /SIZE LIMIT:\s*32\s*KiB/i,
    'session_send_text description must call out the 32 KiB size limit'
  );
  assert.match(
    description,
    /32768\s*chars/i,
    'session_send_text description must include the char count (32768) so MCP clients can validate'
  );
});

test('I253-02: description recommends file-pointer indirection for larger inputs', () => {
  const description = _sendTextDescription();
  assert.match(
    description,
    /(write to a file|reference (?:a |the )?file|file.*reference)/i,
    'session_send_text description must point callers at file-pointer indirection for larger inputs'
  );
});
