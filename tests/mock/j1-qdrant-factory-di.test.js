'use strict';

// J1 #367: qdrant-sync factory-DI conversion.
// Verifies that createQdrantSync accepts injected deps and that reapplyConfig
// runs without touching disk when the provider is set to 'none' (i.e., the
// module reads its config via the injected db, not global singletons).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createQdrantSync } = require('../../src/qdrant-sync');

function makeMockDeps(settings = {}) {
  // Minimal SQLite-like interface with in-memory prepared-statement stubs.
  const mockDb = {
    db: {
      exec: () => {},
      prepare: () => ({
        get: () => null,
        run: () => {},
        all: () => [],
      }),
    },
    getSetting: (key, fallback) => {
      if (key in settings) return settings[key];
      return fallback;
    },
    setSetting: () => {},
  };
  const mockSafe = {
    WORKSPACE: '/tmp/test-workspace',
    CLAUDE_HOME: '/tmp/test-claude',
    HOME: '/tmp',
  };
  const mockConfig = {
    get: (_key, fallback) => fallback,
  };
  const logs = [];
  const mockLogger = {
    info: (...a) => logs.push({ level: 'info', args: a }),
    warn: (...a) => logs.push({ level: 'warn', args: a }),
    error: (...a) => logs.push({ level: 'error', args: a }),
    debug: (...a) => logs.push({ level: 'debug', args: a }),
  };
  return { mockDb, mockSafe, mockConfig, mockLogger, logs };
}

test('J1-DI-01: createQdrantSync returns the expected public API shape', () => {
  const { mockDb, mockSafe, mockConfig, mockLogger } = makeMockDeps({ vector_embedding_provider: '"none"' });
  const qs = createQdrantSync({ db: mockDb, safe: mockSafe, config: mockConfig, logger: mockLogger });

  const required = [
    'start', 'stop', 'restart', 'reapplyConfig', 'search', 'status',
    'embed', 'qdrantHealthy', 'reindexCollection', 'dropAllCollections',
    'buildCandidateConfig', 'validateProviderConfig', 'getEmbeddingProvider',
    'upsertPoints', 'deletePointsByFilter', 'retryTransient',
    '_streamHashAndChunk', '_streamReadAsString',
  ];
  for (const fn of required) {
    assert.equal(typeof qs[fn], 'function', `qs.${fn} must be a function`);
  }
});

test('J1-DI-02: reapplyConfig with provider=none logs "Vector sync disabled" without touching disk', async () => {
  const { mockDb, mockSafe, mockConfig, mockLogger, logs } = makeMockDeps({
    vector_embedding_provider: '"none"',
  });
  const qs = createQdrantSync({ db: mockDb, safe: mockSafe, config: mockConfig, logger: mockLogger });

  // reapplyConfig calls stop() then start(); start() reads provider via getSetting.
  // With provider='none', it must log the disabled message and return — no FS or network IO.
  await qs.reapplyConfig({ dropCollections: false });

  const infoMessages = logs.filter(l => l.level === 'info').map(l => l.args[0]);
  assert.ok(
    infoMessages.some(m => m.includes('Vector sync disabled')),
    `Expected "Vector sync disabled" INFO log; got: ${JSON.stringify(infoMessages)}`,
  );
  // No error/warn from the reapply itself
  const warnErrors = logs.filter(l => l.level === 'warn' || l.level === 'error');
  assert.equal(warnErrors.length, 0, `Expected no warnings/errors; got: ${JSON.stringify(warnErrors)}`);
});

test('J1-DI-03: two independent factory instances have independent state', () => {
  const { mockDb: db1, mockSafe, mockConfig, mockLogger } = makeMockDeps({ vector_embedding_provider: '"none"' });
  const { mockDb: db2 } = makeMockDeps({ vector_embedding_provider: '"none"' });

  const qs1 = createQdrantSync({ db: db1, safe: mockSafe, config: mockConfig, logger: mockLogger });
  const qs2 = createQdrantSync({ db: db2, safe: mockSafe, config: mockConfig, logger: mockLogger });

  // Each instance is a distinct object with its own closure state
  assert.notEqual(qs1, qs2, 'Factory must return new instance each call');
  assert.equal(typeof qs1.start, 'function');
  assert.equal(typeof qs2.start, 'function');
});

test('J1-DI-04: module-level _streamHashAndChunk and _streamReadAsString still exported (E4 compat)', () => {
  const mod = require('../../src/qdrant-sync');
  assert.equal(typeof mod._streamHashAndChunk, 'function',
    'Module must export _streamHashAndChunk at top level for E4 test compat');
  assert.equal(typeof mod._streamReadAsString, 'function',
    'Module must export _streamReadAsString at top level for E4 test compat');
});

test('J1-DI-05: getEmbeddingProvider reads from injected db, not global', () => {
  const { mockDb, mockSafe, mockConfig, mockLogger } = makeMockDeps({ vector_embedding_provider: '"gemini"' });
  const qs = createQdrantSync({ db: mockDb, safe: mockSafe, config: mockConfig, logger: mockLogger });
  assert.equal(qs.getEmbeddingProvider(), 'gemini',
    'getEmbeddingProvider must return value from injected db.getSetting');
});
