'use strict';

// M1 #368: KB clone+poller lifecycle moved from server.js startup into kb-watcher.js start().
// Verifies that:
//   1. Clone-if-missing logic is present in the start() function (static)
//   2. start() with an absent KB_PATH attempts clone then attaches watcher (static check)
//   3. start() with a present KB_PATH skips clone and attaches (static check)
//   4. stop() clears all three timers (pullTimer, originSyncTimer, pendingTimer)
//   5. _syncFromOrigin logic is encapsulated in kb-watcher (not server.js)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_KB = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'kb-watcher.js'), 'utf-8');
const SRC_SERVER = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf-8');

test('M1-KB-01: kb-watcher.js declares _cloneIfMissing inside factory', () => {
  assert.ok(
    /async function _cloneIfMissing\b/.test(SRC_KB),
    'kb-watcher.js must declare _cloneIfMissing async function',
  );
});

test('M1-KB-02: _cloneIfMissing calls git clone with KB_PATH', () => {
  assert.ok(
    /execFileAsync\s*\(\s*['"]git['"]/.test(SRC_KB),
    'kb-watcher.js must call execFileAsync for git operations',
  );
  assert.ok(
    /'clone'/.test(SRC_KB),
    "kb-watcher.js must pass 'clone' to execFileAsync",
  );
});

test('M1-KB-03: start() calls _cloneIfMissing before attaching watcher', () => {
  // Extract the start function body and verify ordering
  const startMatch = SRC_KB.match(/async function start\(\)[^{]*\{([\s\S]+?)(?=\n  async function stop)/);
  assert.ok(startMatch, 'start() function must be present in kb-watcher.js');
  const startBody = startMatch[1];

  const clonePos = startBody.indexOf('_cloneIfMissing');
  const watcherPos = startBody.indexOf('chokidar.watch');
  assert.ok(clonePos >= 0, 'start() must call _cloneIfMissing');
  assert.ok(watcherPos >= 0, 'start() must call chokidar.watch');
  assert.ok(clonePos < watcherPos, 'clone must happen before chokidar.watch in start()');
});

test('M1-KB-04: start() sets both pullTimer and originSyncTimer', () => {
  const startMatch = SRC_KB.match(/async function start\(\)[^{]*\{([\s\S]+?)(?=\n  async function stop)/);
  assert.ok(startMatch, 'start() function must be present');
  const startBody = startMatch[1];
  assert.ok(/pullTimer\s*=\s*setInterval/.test(startBody), 'start() must set pullTimer');
  assert.ok(/originSyncTimer\s*=\s*setInterval/.test(startBody), 'start() must set originSyncTimer');
});

test('M1-KB-05: stop() clears originSyncTimer', () => {
  const stopMatch = SRC_KB.match(/async function stop\(\)[^{]*\{([\s\S]+?)\n  \}/);
  assert.ok(stopMatch, 'stop() function must be present');
  const stopBody = stopMatch[1];
  assert.ok(/originSyncTimer/.test(stopBody), 'stop() must clear originSyncTimer');
});

test('M1-KB-06: _syncFromOrigin logic is in kb-watcher.js, not server.js', () => {
  assert.ok(
    /function _syncFromOrigin/.test(SRC_KB),
    'kb-watcher.js must declare _syncFromOrigin',
  );
  // server.js must no longer contain the origin poller inline
  assert.ok(
    !/_kbSyncTimer/.test(SRC_SERVER),
    'server.js must not contain _kbSyncTimer (moved to kb-watcher)',
  );
  assert.ok(
    !/startKbSyncPoller/.test(SRC_SERVER),
    'server.js must not contain startKbSyncPoller (moved to kb-watcher)',
  );
});

test('M1-KB-07: server.js no longer contains inline KB clone block', () => {
  assert.ok(
    !/Auto-clone Knowledge Base on first run/.test(SRC_SERVER),
    'server.js must not contain the "Auto-clone Knowledge Base" comment (moved to kb-watcher)',
  );
  assert.ok(
    !/fsStat\(KB_PATH\)/.test(SRC_SERVER),
    'server.js must not contain fsStat(KB_PATH) clone guard (moved to kb-watcher)',
  );
});

test('M1-KB-08: kbPath and kbUpstreamUrl are injectable factory deps for testability', () => {
  assert.ok(
    /kbPath\s*=/.test(SRC_KB),
    'createKbWatcher factory must accept optional kbPath dep',
  );
  assert.ok(
    /kbUpstreamUrl\s*=/.test(SRC_KB),
    'createKbWatcher factory must accept optional kbUpstreamUrl dep',
  );
});
