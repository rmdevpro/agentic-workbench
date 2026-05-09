'use strict';

// C2 #344: 26 orphan config keys externalised to defaults.json.
// Verify every key from the issue body has an entry in the file.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'defaults.json'), 'utf-8'));

function get(obj, dottedPath) {
  return dottedPath.split('.').reduce((cur, k) => (cur == null ? cur : cur[k]), obj);
}

const REQUIRED_KEYS = [
  // keepalive (7)
  ['keepalive.refreshThreshold', 0.85],
  ['keepalive.checkRangeLow', 0.65],
  ['keepalive.checkRangeHigh', 0.85],
  ['keepalive.fallbackIntervalMs', 1800000],
  ['keepalive.queryTimeoutMs', 30000],
  ['keepalive.authBrokenThreshold', 3],
  ['keepalive.credsWatchIntervalMs', 60000],
  // claude (1)
  ['claude.defaultTimeoutMs', 120000],
  // session (3)
  ['session.summaryModel', 'haiku'],
  ['session.summaryMaxTranscriptChars', 40000],
  ['session.summaryMaxMessageChars', 1500],
  // ws (4)
  ['ws.bufferHighWaterMark', 1048576],
  ['ws.bufferLowWaterMark', 262144],
  ['ws.pingIntervalMs', 30000],
  ['ws.scrollbackReplayLines', 5000],
  // resolver (2)
  ['resolver.maxAttempts', 30],
  ['resolver.sleepMs', 2000],
  // qdrant (3 + ignorePatternsDefault)
  ['qdrant.debounceMs', 10000],
  ['qdrant.chunkWindow', 3],
  ['qdrant.chunkOverlap', 1],
  // routes (2)
  ['routes.nonClaudeCacheTtlMs', 10000],
  ['routes.nonClaudeMatchWindowMs', 60000],
  // mcp (2)
  ['mcp.fileFindTimeoutMs', 10000],
  ['mcp.fileFindMaxBuffer', 16777216],
];

test('C2-CONFIG-01: all 24 numeric/scalar orphan keys present with expected values', () => {
  for (const [keyPath, expected] of REQUIRED_KEYS) {
    const v = get(defaults, keyPath);
    assert.ok(v !== undefined, `defaults.json missing key: ${keyPath}`);
    assert.equal(v, expected, `defaults.json[${keyPath}] = ${v}, expected ${expected}`);
  }
});

test('C2-CONFIG-02: qdrant.url present', () => {
  const v = get(defaults, 'qdrant.url');
  assert.ok(typeof v === 'string' && v.length > 0, `qdrant.url must be a non-empty string. got: ${JSON.stringify(v)}`);
});

test('C2-CONFIG-03: qdrant.ignorePatternsDefault is an array', () => {
  const v = get(defaults, 'qdrant.ignorePatternsDefault');
  assert.ok(Array.isArray(v), `qdrant.ignorePatternsDefault must be an array. got: ${typeof v}`);
  assert.ok(v.length > 0, 'qdrant.ignorePatternsDefault must not be empty');
});

test('C2-CONFIG-04: defaults.json is valid JSON (parses without error)', () => {
  // Re-parse to confirm; if this test runs, the top-level parse already succeeded.
  assert.ok(typeof defaults === 'object' && defaults !== null);
});
