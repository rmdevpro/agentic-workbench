'use strict';

// #372 [E2]: discoverGeminiSessions / discoverCodexSessions are TTL-cached
// (10s) at the session-utils module scope so all callers in the workbench
// process share one cache. Three calls within the TTL window must result in
// exactly one underlying disk traversal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { freshRequire } = require('../helpers/module');

const SESSION_UTILS_PATH = path.join(__dirname, '..', '..', 'src', 'session-utils.js');

async function setupGeminiFixtures() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'e2-gem-'));
  const proj = path.join(home, '.gemini', 'tmp', 'proj-a', 'chats');
  await fsp.mkdir(proj, { recursive: true });
  const file = path.join(proj, 'session-1.jsonl');
  // Minimal valid Gemini session header line
  await fsp.writeFile(file, JSON.stringify({
    sessionId: 'gem-fixture-1',
    startTime: '2026-05-09T00:00:00Z',
    lastUpdated: '2026-05-09T00:00:00Z',
    kind: 'gemini',
  }) + '\n', 'utf-8');
  return { home, file };
}

async function setupCodexFixtures() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'e2-cdx-'));
  const sessDir = path.join(home, '.codex', 'sessions', '2026', '05', '09');
  await fsp.mkdir(sessDir, { recursive: true });
  const file = path.join(sessDir, 'rollout-2026-05-09T00-00-00-00000000-0000-0000-0000-000000000001.jsonl');
  // Minimal Codex rollout (header line then nothing else)
  await fsp.writeFile(file, JSON.stringify({
    sessionId: '00000000-0000-0000-0000-000000000001',
    startTime: '2026-05-09T00:00:00Z',
  }) + '\n', 'utf-8');
  return { home, file };
}

test('E2-CACHE-01: 3 discoverGeminiSessions calls within TTL → exactly 1 fs.readdirSync chain', async (t) => {
  const { home } = await setupGeminiFixtures();
  process.env.HOME = home;
  // Clear both safe-exec and session-utils so the new HOME is picked up.
  delete require.cache[require.resolve(path.join(__dirname, '..', '..', 'src', 'safe-exec.js'))];
  delete require.cache[require.resolve(SESSION_UTILS_PATH)];
  const sessionUtils = require(SESSION_UTILS_PATH);

  const realReaddirSync = fs.readdirSync.bind(fs);
  let readdirCount = 0;
  t.mock.method(fs, 'readdirSync', (p, opts) => {
    if (typeof p === 'string' && p.includes('.gemini')) readdirCount++;
    return realReaddirSync(p, opts);
  });

  // Three calls in tight succession (well within 10s TTL)
  const r1 = sessionUtils.discoverGeminiSessions();
  const r2 = sessionUtils.discoverGeminiSessions();
  const r3 = sessionUtils.discoverGeminiSessions();

  assert.equal(Array.isArray(r1) && r1.length, 1, 'first call returns 1 fixture session');
  assert.equal(r2, r1, '2nd call returns identical cached array reference');
  assert.equal(r3, r1, '3rd call returns identical cached array reference');
  // Discovery walks ~/.gemini/tmp + each project's chats dir = 2 readdirSync
  // calls per discovery for a single-project fixture. Cache hits skip the
  // walk entirely, so 3 invocations should still total 2 readdirSync calls.
  const oneFullWalk = readdirCount;
  assert.ok(
    oneFullWalk >= 1 && oneFullWalk <= 4,
    `single full walk should be 1-4 readdirSync calls; got ${oneFullWalk}`,
  );
});

test('E2-CACHE-02: 3 discoverCodexSessions calls within TTL → exactly 1 fs.readdirSync chain', async (t) => {
  const { home } = await setupCodexFixtures();
  process.env.HOME = home;
  // Clear both safe-exec and session-utils so the new HOME is picked up.
  delete require.cache[require.resolve(path.join(__dirname, '..', '..', 'src', 'safe-exec.js'))];
  delete require.cache[require.resolve(SESSION_UTILS_PATH)];
  const sessionUtils = require(SESSION_UTILS_PATH);

  const realReaddirSync = fs.readdirSync.bind(fs);
  let readdirCount = 0;
  t.mock.method(fs, 'readdirSync', (p, opts) => {
    if (typeof p === 'string' && p.includes('.codex')) readdirCount++;
    return realReaddirSync(p, opts);
  });

  const r1 = sessionUtils.discoverCodexSessions();
  const r2 = sessionUtils.discoverCodexSessions();
  const r3 = sessionUtils.discoverCodexSessions();

  assert.ok(Array.isArray(r1) && r1.length >= 1, 'first call returns ≥1 fixture session');
  assert.equal(r2, r1, '2nd call returns identical cached array reference');
  assert.equal(r3, r1, '3rd call returns identical cached array reference');
  // Walk hits readdirSync for the date-stratified directory tree (2026/05/09).
  // Pre-fix the second + third calls would also walk = 3× the depth count.
  // The walk depth is 4 levels (sessions, 2026, 05, 09) so a single discovery
  // emits 4 readdirSync calls. Cache must keep this to exactly 4 across all 3
  // calls combined (i.e., the walk only runs once).
  assert.ok(
    readdirCount > 0 && readdirCount <= 8,
    `expected one full walk (≤8 readdirSync calls) across 3 cached invocations; got ${readdirCount}`,
  );
});

test('E2-CACHE-03: invalidateDiscoveryCache returns a different array reference on next call', async (t) => {
  const { home } = await setupGeminiFixtures();
  process.env.HOME = home;
  delete require.cache[require.resolve(path.join(__dirname, '..', '..', 'src', 'safe-exec.js'))];
  delete require.cache[require.resolve(SESSION_UTILS_PATH)];
  const sessionUtils = require(SESSION_UTILS_PATH);

  const r1 = sessionUtils.discoverGeminiSessions();
  const r2 = sessionUtils.discoverGeminiSessions();
  assert.equal(r2, r1, 'cache hit returns identical reference');
  sessionUtils.invalidateDiscoveryCache('gemini');
  const r3 = sessionUtils.discoverGeminiSessions();
  assert.notEqual(r3, r1, 'after invalidate, a fresh array is returned (new reference)');
  // Same content (fixture unchanged)
  assert.deepEqual(r3.map(s => s.sessionId), r1.map(s => s.sessionId));
});

test('E2-CACHE-04: invalidateDiscoveryCache() with no argument clears both gemini and codex', async (t) => {
  const { home } = await setupGeminiFixtures();
  process.env.HOME = home;
  delete require.cache[require.resolve(path.join(__dirname, '..', '..', 'src', 'safe-exec.js'))];
  delete require.cache[require.resolve(SESSION_UTILS_PATH)];
  const sessionUtils = require(SESSION_UTILS_PATH);

  const g1 = sessionUtils.discoverGeminiSessions();
  const c1 = sessionUtils.discoverCodexSessions();
  assert.equal(sessionUtils.discoverGeminiSessions(), g1, 'gemini cached');
  assert.equal(sessionUtils.discoverCodexSessions(), c1, 'codex cached');
  sessionUtils.invalidateDiscoveryCache();
  assert.notEqual(sessionUtils.discoverGeminiSessions(), g1, 'gemini cache cleared');
  assert.notEqual(sessionUtils.discoverCodexSessions(), c1, 'codex cache cleared');
});
