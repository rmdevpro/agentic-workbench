'use strict';

// K1 #360: numbered DB migration runner anchored at 001-baseline.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshRequire } = require('../helpers/module');

const DB_PATH = path.join(__dirname, '..', '..', 'src', 'db.js');
const MIG_DIR = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');

async function withDb(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-k1-'));
  const prev = process.env.WORKBENCH_DATA;
  process.env.WORKBENCH_DATA = dir;
  try {
    const db = freshRequire(DB_PATH);
    await fn(db);
  } finally {
    if (prev === undefined) delete process.env.WORKBENCH_DATA;
    else process.env.WORKBENCH_DATA = prev;
  }
}

test('K1-MIG-01: schema_migrations table exists after boot', async () => {
  await withDb(async (db) => {
    const rows = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").all();
    assert.equal(rows.length, 1, 'schema_migrations table must exist');
  });
});

test('K1-MIG-02: 001-baseline migration is recorded after boot', async () => {
  await withDb(async (db) => {
    const ids = db.db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id);
    assert.ok(ids.includes('001-baseline'), `schema_migrations must include 001-baseline. got: ${JSON.stringify(ids)}`);
  });
});

test('K1-MIG-03: second boot does not re-apply migrations', async () => {
  await withDb(async (db) => {
    const idsAfterFirstBoot = db.db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id);
    // Force reload — second boot
    delete require.cache[require.resolve(DB_PATH)];
    const db2 = require(DB_PATH);
    const idsAfterSecondBoot = db2.db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id);
    assert.deepEqual(idsAfterSecondBoot, idsAfterFirstBoot, 'second boot must not add or duplicate migration rows');
  });
});

test('K1-MIG-04: migrations dir contains numbered files matching the runner pattern', () => {
  const files = fs.readdirSync(MIG_DIR);
  assert.ok(files.length > 0, 'migrations dir must not be empty');
  for (const f of files) {
    assert.match(f, /^\d{3}-[\w-]+\.js$/, `migration filename must match NNN-name.js: ${f}`);
    const mig = require(path.join(MIG_DIR, f));
    assert.equal(typeof mig.up, 'function', `migration ${f} must export up(db)`);
  }
});
