'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const tailParse = require('../../src/session-utils/tail-parse.js');

async function mkTmpFile(content = '') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-tp-'));
  const filepath = path.join(dir, 'session.jsonl');
  await fsp.writeFile(filepath, content);
  return filepath;
}

test('TP-MK-01: decideParseMode returns full for no cache', () => {
  const decision = tailParse.decideParseMode(null, { mtimeMs: 100, size: 50 });
  assert.equal(decision.mode, 'full');
  assert.equal(decision.reason, 'no-cache');
});

test('TP-MK-02: decideParseMode returns cached on mtime+size match', () => {
  const decision = tailParse.decideParseMode(
    { file_mtime: 100, file_size: 50, last_byte_offset: 50 },
    { mtimeMs: 100, size: 50 },
  );
  assert.equal(decision.mode, 'cached');
});

test('TP-MK-03: decideParseMode returns tail on size growth', () => {
  const decision = tailParse.decideParseMode(
    { file_mtime: 100, file_size: 50, last_byte_offset: 50 },
    { mtimeMs: 200, size: 100 },
  );
  assert.equal(decision.mode, 'tail');
  assert.equal(decision.fromOffset, 50);
  assert.equal(decision.toOffset, 100);
});

test('TP-MK-04: decideParseMode returns full on truncate (size shrank)', () => {
  const decision = tailParse.decideParseMode(
    { file_mtime: 100, file_size: 100, last_byte_offset: 100 },
    { mtimeMs: 200, size: 50 },
  );
  assert.equal(decision.mode, 'full');
  assert.equal(decision.reason, 'truncate');
});

test('TP-MK-05: decideParseMode returns full on rotate (mtime out-of-order)', () => {
  const decision = tailParse.decideParseMode(
    { file_mtime: 200, file_size: 50, last_byte_offset: 50 },
    { mtimeMs: 100, size: 100 },
  );
  assert.equal(decision.mode, 'full');
  assert.equal(decision.reason, 'rotate');
});

test('TP-MK-06: readTail reads bytes [from, to) only', async () => {
  const filepath = await mkTmpFile('line1\nline2\nline3\n');
  const tail = await tailParse.readTail(filepath, 6, 12);
  assert.equal(tail, 'line2\n');
});

test('TP-MK-07: readTail returns "" when from >= to', async () => {
  const filepath = await mkTmpFile('content');
  const empty = await tailParse.readTail(filepath, 5, 5);
  assert.equal(empty, '');
  const negative = await tailParse.readTail(filepath, 5, 3);
  assert.equal(negative, '');
});

test('TP-MK-08: splitTailIntoLines handles partial trailing line correctly', () => {
  // No trailing newline → last fragment is a partial line
  const r1 = tailParse.splitTailIntoLines('line1\nline2\npartial');
  assert.deepEqual(r1.lines, ['line1', 'line2']);
  assert.equal(r1.trailingPartial, 'partial');

  // Trailing newline → no partial
  const r2 = tailParse.splitTailIntoLines('line1\nline2\n');
  assert.deepEqual(r2.lines, ['line1', 'line2']);
  assert.equal(r2.trailingPartial, '');

  // priorTrailingPartial is prepended
  const r3 = tailParse.splitTailIntoLines('rest\nline2\n', 'partial-');
  assert.deepEqual(r3.lines, ['partial-rest', 'line2']);
  assert.equal(r3.trailingPartial, '');
});

test('TP-MK-09: decideParseMode falls back to full when cursor sits beyond EOF', () => {
  const decision = tailParse.decideParseMode(
    { file_mtime: 100, file_size: 200, last_byte_offset: 200 },
    { mtimeMs: 100, size: 150 },
  );
  assert.equal(decision.mode, 'full');
  // size shrank → truncate beats cursor-beyond-eof in priority
  assert.equal(decision.reason, 'truncate');

  // Cursor genuinely beyond EOF (size grew but cursor exceeds it — shouldn't
  // happen in practice but the helper handles it)
  const decision2 = tailParse.decideParseMode(
    { file_mtime: 100, file_size: 50, last_byte_offset: 999 },
    { mtimeMs: 200, size: 100 },
  );
  assert.equal(decision2.mode, 'full');
  assert.equal(decision2.reason, 'cursor-beyond-eof');
});

test('TP-MK-10 (extra): tail-parse round-trip — read bytes that grew, parse new line', async () => {
  // Setup: write initial content
  const filepath = await mkTmpFile('{"type":"user","message":{"content":"hello"}}\n');
  const initialStat = await fsp.stat(filepath);

  // Append a new line (simulates an additional turn arriving)
  const newLine = '{"type":"assistant","message":{"content":"hi","model":"claude-x"}}\n';
  await fsp.appendFile(filepath, newLine);
  const grownStat = await fsp.stat(filepath);

  // The decision is tail-parse from initialStat.size
  const decision = tailParse.decideParseMode(
    {
      file_mtime: initialStat.mtimeMs,
      file_size: initialStat.size,
      last_byte_offset: initialStat.size,
    },
    grownStat,
  );
  assert.equal(decision.mode, 'tail');

  // Read the tail and confirm it's exactly the appended bytes
  const tail = await tailParse.readTail(filepath, decision.fromOffset, decision.toOffset);
  assert.equal(tail, newLine);

  // Split + parse the new line
  const { lines } = tailParse.splitTailIntoLines(tail);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.type, 'assistant');
  assert.equal(parsed.message.model, 'claude-x');
});
