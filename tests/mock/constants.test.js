'use strict';

// #345 [C3]: shared constants module — exposes KB_PATH, KB_UPSTREAM_URL,
// KB_UPSTREAM_OWNER_REPO, and CODEX_ROLLOUT_UUID_RE. Verify each is the
// expected shape so a typo in constants.js trips a test before the
// downstream call sites silently break.

const test = require('node:test');
const assert = require('node:assert/strict');
const constants = require('../../src/constants.js');

test('CONST-01: KB_PATH is the canonical /data/knowledge-base location', () => {
  assert.equal(constants.KB_PATH, '/data/knowledge-base');
});

test('CONST-02: KB_UPSTREAM_URL is the public workbench-kb repo', () => {
  assert.equal(constants.KB_UPSTREAM_URL, 'https://github.com/rmdevpro/workbench-kb');
});

test('CONST-03: KB_UPSTREAM_OWNER_REPO derived as owner/repo (no protocol, no .git suffix)', () => {
  assert.equal(constants.KB_UPSTREAM_OWNER_REPO, 'rmdevpro/workbench-kb');
});

test('CONST-04: CODEX_ROLLOUT_UUID_RE matches a real rollout filename UUID tail', () => {
  const sample = 'rollout-2025-04-22T19-30-00-deadbeef-1234-5678-9abc-def012345678';
  const m = sample.match(constants.CODEX_ROLLOUT_UUID_RE);
  assert.ok(m, 'regex must match a UUID-tailed rollout name');
  assert.equal(m[1], 'deadbeef-1234-5678-9abc-def012345678');
});

test('CONST-05: CODEX_ROLLOUT_UUID_RE returns null for non-UUID-tailed strings', () => {
  assert.equal('not-a-rollout'.match(constants.CODEX_ROLLOUT_UUID_RE), null);
  assert.equal('rollout-2025-04-22'.match(constants.CODEX_ROLLOUT_UUID_RE), null);
});

test('CONST-06: CODEX_ROLLOUT_UUID_RE is case-insensitive (early rollouts had upper-case hex)', () => {
  const sample = 'rollout-AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  const m = sample.match(constants.CODEX_ROLLOUT_UUID_RE);
  assert.ok(m);
  assert.equal(m[1].toUpperCase(), 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE');
});
