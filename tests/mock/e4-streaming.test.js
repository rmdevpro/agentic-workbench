'use strict';

// #443 [E4]: qdrant-sync embedding/sync path must use createReadStream
// + readline to avoid loading large files into V8 heap as a single
// String. Acceptance: feed a 9.9MB synthetic file; peak heap delta
// during the chunking phase stays under 50MB.
//
// Codex R2 fix: this test now exercises the production qdrant-sync
// `_streamHashAndChunk()` directly, instead of reimplementing the
// streaming loop locally (which only proved that streaming would have
// stayed within budget IF the production code did the same thing —
// not that the production code itself does).
//
// To import qdrant-sync without triggering its DB/qdrant init paths,
// the module is loaded from disk; only the streaming helper is invoked.
// The helper is a pure function over (filePath) that does no DB or
// network IO, so a fresh require with the right env is sufficient.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const QDRANT_SYNC_PATH = path.join(__dirname, '..', '..', 'src', 'qdrant-sync.js');

async function setupLargeFile(sizeBytes) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'e4-'));
  const file = path.join(dir, 'large.md');
  // Build a markdown file with sections totaling approximately sizeBytes.
  // Write incrementally so we don't shadow the streaming bug we test.
  const ws = fs.createWriteStream(file);
  let written = 0;
  let section = 0;
  const sectionTargetBytes = 200 * 1024;
  while (written < sizeBytes) {
    section++;
    const heading = `\n## Section ${section}\n\n`;
    ws.write(heading);
    written += heading.length;
    let secWritten = 0;
    while (secWritten < sectionTargetBytes && written < sizeBytes) {
      const line = `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Section ${section} line content padding. ${'x'.repeat(80)}\n`;
      ws.write(line);
      secWritten += line.length;
      written += line.length;
    }
  }
  await new Promise((resolve, reject) => { ws.end((err) => err ? reject(err) : resolve()); });
  return { dir, file };
}

test('E4-STREAM-01: production _streamHashAndChunk on 9.9MB file → heap delta < 50 MB (real code path)', async (t) => {
  const SIZE = 9.9 * 1024 * 1024;
  const { dir, file } = await setupLargeFile(SIZE);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  // Load the production module. _streamHashAndChunk is a leaf helper that
  // does no DB/network IO so a fresh require is safe (no init side
  // effects beyond module-level requires of fs/path/crypto/safe-exec).
  const qdrantSync = require(QDRANT_SYNC_PATH);
  assert.equal(typeof qdrantSync._streamHashAndChunk, 'function',
    'qdrant-sync must export _streamHashAndChunk for test coverage (E4 fix)');

  // Sample heap before. Force GC to a baseline if available (--expose-gc);
  // otherwise the delta is still meaningful — the streaming hot path is
  // what we're measuring against the post-GC steady state.
  if (typeof global.gc === 'function') global.gc();
  const heapBaseline = process.memoryUsage().heapUsed;
  let peakHeap = heapBaseline;

  // Probe heap during the streaming run. node:test doesn't expose hooks
  // into the awaited iteration, so spawn a periodic sampler that runs in
  // parallel with the streaming call. setInterval ticks at 25ms; the
  // 9.9MB file's chunk loop typically takes 50-200ms, so we get 2-8
  // samples covering the active window.
  const samplerHandle = setInterval(() => {
    const cur = process.memoryUsage().heapUsed;
    if (cur > peakHeap) peakHeap = cur;
  }, 25);

  let result;
  try {
    result = await qdrantSync._streamHashAndChunk(file);
  } finally {
    clearInterval(samplerHandle);
  }
  // Take one final sample just after the call returns.
  const postCall = process.memoryUsage().heapUsed;
  if (postCall > peakHeap) peakHeap = postCall;

  // Assertions on the production return value (same shape syncFileToCollection
  // depends on)
  assert.ok(typeof result.hash === 'string' && result.hash.length === 32,
    `expected 32-char md5 hash; got ${typeof result.hash} length ${result.hash?.length}`);
  assert.ok(Array.isArray(result.chunks),
    'expected chunks array');
  assert.ok(result.chunks.length >= 30,
    `expected ≥30 chunks from 9.9MB / 200KB-per-section input; got ${result.chunks.length}`);
  for (const c of result.chunks) {
    assert.ok(typeof c.text === 'string' && c.text.length > 0, 'chunk.text non-empty');
    assert.ok(c.metadata && typeof c.metadata.section === 'string', 'chunk.metadata.section is string');
  }

  const heapDelta = peakHeap - heapBaseline;
  const heapDeltaMB = heapDelta / (1024 * 1024);

  // Acceptance: peak heap delta < 50 MB on a 9.9 MB input. Pre-fix
  // shape (single readFile + chunkDocument over the whole text) would
  // briefly hold the full file content as a String in heap.
  assert.ok(
    heapDeltaMB < 50,
    `peak heap delta during _streamHashAndChunk must be <50 MB on a 9.9 MB file; got ${heapDeltaMB.toFixed(2)} MB`,
  );
});

test('E4-STREAM-02: qdrant-sync source uses createReadStream + _streamHashAndChunk (regression guard)', () => {
  // Static check: source file uses createReadStream and declares
  // _streamHashAndChunk. The behavioral test above proves the real
  // code path works; this guard catches accidental regression to a
  // readFile-based implementation in a future refactor.
  const src = fs.readFileSync(QDRANT_SYNC_PATH, 'utf-8');
  assert.ok(/createReadStream/.test(src),
    'src/qdrant-sync.js must import or use createReadStream');
  assert.ok(/_streamHashAndChunk\b/.test(src),
    'src/qdrant-sync.js must declare _streamHashAndChunk');
  assert.ok(
    !/syncFileToCollection[\s\S]{1,2000}await\s+readFile\s*\(/.test(src),
    'syncFileToCollection must NOT use bare await readFile() — use _streamHashAndChunk',
  );
});

test('E4-STREAM-03: _streamReadAsString is exported and produces same content as readFile (real code path)', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'e4-srs-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, 'session.jsonl');
  const content = '{"sessionId":"abc","kind":"gemini","startTime":"2026-05-09T00:00:00Z"}\n{"type":"user","content":"hi"}\n';
  await fsp.writeFile(file, content);

  const qdrantSync = require(QDRANT_SYNC_PATH);
  assert.equal(typeof qdrantSync._streamReadAsString, 'function',
    'qdrant-sync must export _streamReadAsString for test coverage (E4 fix)');

  const got = await qdrantSync._streamReadAsString(file);
  assert.equal(got, content, 'streamed read must produce identical content to file');
});
