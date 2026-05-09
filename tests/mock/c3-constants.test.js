'use strict';

// C3 #345: centralise hardcoded paths/URLs/regex into src/constants.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const constants = require('../../src/constants.js');

test('C3-CONST-01: src/constants.js exports KB_PATH, KB_UPSTREAM_URL, CODEX_ROLLOUT_UUID_RE', () => {
  assert.equal(constants.KB_PATH, '/data/knowledge-base');
  assert.ok(/^https:\/\/github.com\/rmdevpro\/workbench-kb/.test(constants.KB_UPSTREAM_URL));
  assert.ok(constants.CODEX_ROLLOUT_UUID_RE instanceof RegExp);
});

function grepCount(pattern, paths) {
  try {
    const out = execSync(
      `grep -rln ${JSON.stringify(pattern)} ${paths.map((p) => path.join(REPO_ROOT, p)).join(' ')}`,
      { encoding: 'utf-8' },
    );
    return out.split('\n').filter(Boolean);
  } catch (e) {
    if (e.status === 1) return [];
    throw e;
  }
}

test('C3-CONST-02: literal "/data/knowledge-base" appears only in src/constants.js (or its tests)', () => {
  const hits = grepCount('/data/knowledge-base', ['src', 'public']);
  // Allow constants.js. Filter out anything else.
  const offenders = hits.filter((p) => !p.endsWith('src/constants.js'));
  assert.equal(offenders.length, 0, `unexpected /data/knowledge-base literals outside constants.js: ${offenders.join(', ')}`);
});

test('C3-CONST-03: regex source for CODEX_ROLLOUT_UUID_RE has the expected shape', () => {
  // Documented: matches Codex rollout filenames like
  //   rollout-2026-04-30T12-34-56-<uuid>.jsonl
  // Constants.js owns the canonical regex; consumers import.
  assert.ok(constants.CODEX_ROLLOUT_UUID_RE.test('rollout-2026-05-09T01-23-45-abcdef01-2345-6789-abcd-ef0123456789'));
  assert.ok(!constants.CODEX_ROLLOUT_UUID_RE.test('not-a-rollout'));
});
