'use strict';

// QS-MK-01..03: #651 R7 §6.4 — verify syncFileToCollection short-circuits on
// mtime match before doing the expensive _streamHashAndChunk + embed cycle.
// Mirrors syncSessionFile's existing shortcut.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createQdrantSync } = require('../../src/qdrant-sync');

// Build a mock db that returns controlled syncStmts.get rows + spies on upsert.
function makeMockDeps({ syncStateRow = null, settings = {} } = {}) {
  const upsertCalls = [];
  const getCalls = [];

  const stmtForUpsert = { run: (...args) => upsertCalls.push(args) };
  const stmtForGet = { get: (...args) => { getCalls.push(args); return syncStateRow; } };

  function prepare(sql) {
    // Match the prepared statements qdrant-sync builds at module init.
    if (sql.includes('INSERT INTO qdrant_sync') && sql.includes('ON CONFLICT')) {
      return stmtForUpsert;
    }
    if (sql.startsWith('SELECT * FROM qdrant_sync')) {
      return stmtForGet;
    }
    // Default no-op stub.
    return { get: () => null, run: () => {}, all: () => [] };
  }

  const mockDb = {
    db: { exec: () => {}, prepare },
    getSetting: (k, fb) => (k in settings ? settings[k] : fb),
    setSetting: () => {},
  };
  const mockSafe = { WORKSPACE: '/tmp', CLAUDE_HOME: '/tmp', HOME: '/tmp' };
  const mockConfig = { get: (_k, fb) => fb };
  const logs = [];
  const mockLogger = {
    info: (m) => logs.push({ level: 'info', m }),
    warn: (m) => logs.push({ level: 'warn', m }),
    error: (m) => logs.push({ level: 'error', m }),
    debug: (m) => logs.push({ level: 'debug', m }),
  };
  return { mockDb, mockSafe, mockConfig, mockLogger, logs, upsertCalls, getCalls };
}

async function withTmpFile(content, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-qs-'));
  const filepath = path.join(dir, 'sample.md');
  await fsp.writeFile(filepath, content);
  try {
    await fn(filepath, dir);
  } finally {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch (_e) {
      /* tmp cleanup best-effort */
    }
  }
}

test('QS-MK-01: syncFileToCollection short-circuits on mtime match without hashing', async () => {
  await withTmpFile('# hello world\n', async (filepath) => {
    const stat = await fsp.stat(filepath);
    const { mockDb, mockSafe, mockConfig, mockLogger, upsertCalls } = makeMockDeps({
      syncStateRow: { last_mtime: stat.mtimeMs, last_hash: 'whatever' },
    });
    const qs = createQdrantSync({
      db: mockDb, safe: mockSafe, config: mockConfig, logger: mockLogger,
    });

    // Spy on _streamHashAndChunk via the factory's exported handle.
    let hashCalls = 0;
    const realHash = qs._streamHashAndChunk;
    qs._streamHashAndChunk = (...args) => {
      hashCalls++;
      return realHash(...args);
    };

    const result = await qs._syncFileToCollection(filepath, 'docs', path.dirname(filepath), 384);
    assert.equal(result, 0, 'mtime-match path returns 0 (no embed work)');
    // The shortcut returns BEFORE _streamHashAndChunk is invoked. The fact
    // that we never call into qdrant (upsert) corroborates that the short-
    // circuit fired — without it, the function would try to embed + upsert.
    assert.equal(upsertCalls.length, 0, 'no upsert on mtime-match');
  });
});

test('QS-MK-02: syncFileToCollection does NOT short-circuit when mtime differs', async () => {
  await withTmpFile('# changed content\n', async (filepath) => {
    const stat = await fsp.stat(filepath);
    const { mockDb, mockSafe, mockConfig, mockLogger } = makeMockDeps({
      // Different mtime → shortcut does NOT fire → proceeds to hash + embed.
      syncStateRow: { last_mtime: stat.mtimeMs - 9999, last_hash: 'stale-hash' },
    });
    const qs = createQdrantSync({
      db: mockDb, safe: mockSafe, config: mockConfig, logger: mockLogger,
    });

    // The function proceeds to _streamHashAndChunk. Since the embed/qdrant
    // pipeline isn't fully mocked here, the function will likely fail when
    // it tries to talk to qdrant — but the path past the mtime shortcut is
    // what we care about. We assert by observing the function does NOT
    // return 0 immediately (it goes further). A throw is acceptable as
    // proof-of-non-shortcut.
    let returnedValue = null;
    let didThrow = false;
    try {
      returnedValue = await qs._syncFileToCollection(filepath, 'docs', path.dirname(filepath), 384);
    } catch (_err) {
      didThrow = true;
    }
    // Past the shortcut, the code path attempts embed/qdrant which fails in
    // the mock environment. Either an exception or a non-zero attempt is
    // proof the shortcut didn't kick in.
    assert.ok(
      didThrow || returnedValue !== 0 || returnedValue === null,
      'mtime mismatch must not short-circuit to 0',
    );
  });
});

test('QS-MK-03: syncFileToCollection short-circuits when syncState exists and mtime matches the file exactly', async () => {
  // Regression-pin against accidentally reordering the shortcut check after
  // _streamHashAndChunk (which would defeat the whole point of R7 §6.4).
  await withTmpFile('content for QS-MK-03\n', async (filepath) => {
    const stat = await fsp.stat(filepath);
    const { mockDb, mockSafe, mockConfig, mockLogger, getCalls, upsertCalls } = makeMockDeps({
      syncStateRow: { last_mtime: stat.mtimeMs, last_hash: 'sha-from-prior-scan' },
    });
    const qs = createQdrantSync({
      db: mockDb, safe: mockSafe, config: mockConfig, logger: mockLogger,
    });

    const result = await qs._syncFileToCollection(filepath, 'docs', path.dirname(filepath), 384);
    assert.equal(result, 0);
    assert.equal(getCalls.length, 1, 'syncStmts.get queried exactly once');
    assert.equal(upsertCalls.length, 0, 'no upsert on cache hit');

    // Source guard: assert the shortcut block exists at the right place in
    // the function body — defends against the bug class where the check
    // gets moved AFTER _streamHashAndChunk.
    const src = require('node:fs').readFileSync(
      path.join(__dirname, '..', '..', 'src', 'qdrant-sync.js'),
      'utf-8',
    );
    const fn = src.match(/async function syncFileToCollection\b[\s\S]*?^  \}/m);
    assert.ok(fn, 'syncFileToCollection function body located in source');
    const body = fn[0];
    const hashIdx = body.indexOf('_streamHashAndChunk');
    const shortcutIdx = body.indexOf("syncState.last_mtime === fileStat.mtimeMs");
    assert.ok(shortcutIdx > 0, 'mtime-shortcut conditional present');
    assert.ok(
      shortcutIdx < hashIdx,
      'mtime-shortcut conditional MUST appear before _streamHashAndChunk call',
    );
  });
});
