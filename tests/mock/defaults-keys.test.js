'use strict';

// #344 [C2]: structural validation that the 26 keys called out in the issue
// are present in config/defaults.json with the documented values. If a key
// regresses (typo, accidental delete, value drift) the test fails before
// the runtime quietly falls back to the code-side default.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const defaults = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'defaults.json'), 'utf-8'),
);

function get(obj, dotPath) {
  return dotPath.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

const REQUIRED = [
  ['keepalive.refreshThreshold', 0.85],
  ['keepalive.checkRangeLow', 0.65],
  ['keepalive.checkRangeHigh', 0.85],
  ['keepalive.fallbackIntervalMs', 1800000],
  ['keepalive.queryTimeoutMs', 30000],
  ['keepalive.authBrokenThreshold', 3],
  ['keepalive.credsWatchIntervalMs', 60000],
  ['claude.defaultTimeoutMs', 120000],
  ['session.summaryModel', 'haiku'],
  ['session.summaryMaxTranscriptChars', 40000],
  ['session.summaryMaxMessageChars', 1500],
  ['ws.bufferHighWaterMark', 1048576],
  ['ws.bufferLowWaterMark', 262144],
  ['ws.pingIntervalMs', 30000],
  ['ws.scrollbackReplayLines', 5000],
  ['resolver.maxAttempts', 30],
  ['resolver.sleepMs', 2000],
  ['qdrant.debounceMs', 10000],
  ['qdrant.chunkWindow', 3],
  ['qdrant.chunkOverlap', 1],
  ['routes.nonClaudeCacheTtlMs', 10000],
  ['routes.nonClaudeMatchWindowMs', 60000],
  ['mcp.fileFindTimeoutMs', 10000],
  ['mcp.fileFindMaxBuffer', 16777216],
];

for (const [keyPath, expectedValue] of REQUIRED) {
  test(`DEF-${keyPath}: present in defaults.json with value ${JSON.stringify(expectedValue)}`, () => {
    const actual = get(defaults, keyPath);
    assert.equal(actual, expectedValue, `${keyPath} should be ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actual)}`);
  });
}

test('DEF-qdrant.url: present (operator-tunable, default value not pinned)', () => {
  assert.equal(typeof get(defaults, 'qdrant.url'), 'string');
});

test('DEF-qdrant.ignorePatternsDefault: array with the 6 standard patterns', () => {
  const v = get(defaults, 'qdrant.ignorePatternsDefault');
  assert.ok(Array.isArray(v), `must be an array, got ${typeof v}`);
  for (const expected of ['node_modules/**', '.git/**', '*.lock', '*.min.js', 'dist/**', 'build/**']) {
    assert.ok(v.includes(expected), `must include ${expected}; got ${JSON.stringify(v)}`);
  }
});
