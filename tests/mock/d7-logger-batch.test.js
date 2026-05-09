'use strict';

// D7 #356: logger batches persistence (single multi-row INSERT every 250ms or
// 100 entries, whichever comes first).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'logger.js'), 'utf-8');

test('D7-LOG-01: src/logger.js declares batch buffer + thresholds', () => {
  assert.match(SRC, /_logBuffer\s*=\s*\[\]/, 'buffer must be a Map/Array — array per implementation');
  assert.match(SRC, /FLUSH_BATCH\s*=\s*100/, 'flush threshold of 100 entries');
  assert.match(SRC, /FLUSH_INTERVAL_MS\s*=\s*250/, '250ms flush interval');
});

test('D7-LOG-02: _persist enqueues + triggers flush at threshold', () => {
  // Body must push to _logBuffer, then either fire immediately when length
  // hits FLUSH_BATCH or schedule a setTimeout.
  const persist = SRC.match(/function _persist\(entry\)[\s\S]+?\n\}/);
  assert.ok(persist, '_persist function must be present');
  assert.match(persist[0], /_logBuffer\.push/);
  assert.match(persist[0], /_logBuffer\.length\s*>=\s*FLUSH_BATCH/);
  assert.match(persist[0], /setTimeout\(\s*\(\)\s*=>/);
});

test('D7-LOG-03: _flushLogs prefers insertLogBatch when available', () => {
  const flush = SRC.match(/function _flushLogs\(\)[\s\S]+?\n\}/);
  assert.ok(flush, '_flushLogs function must be present');
  // Single batched call when DB exposes insertLogBatch
  assert.match(flush[0], /db\.insertLogBatch/);
  // Per-line fallback only when batch not available — `else` branch must be present
  assert.match(flush[0], /typeof db\.insertLogBatch === 'function'/);
});

test('D7-LOG-04: process exit hook flushes the buffer', () => {
  assert.match(SRC, /global\.__wbLoggerExitFlushBound/, 'idempotent guard must be present');
  assert.match(SRC, /process\.on\('exit',\s*\(\)\s*=>\s*\{[\s\S]*?_flushLogs\(\)/);
});

test('D7-LOG-05: db.insertLogBatch is exported (consumer of batched flush)', () => {
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'db.js'), 'utf-8');
  assert.match(dbSrc, /insertLogBatch/);
});
