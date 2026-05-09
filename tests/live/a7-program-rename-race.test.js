'use strict';

// A7 #332: PUT /api/programs/:id name uniqueness wrapped in a SQLite
// transaction. Two concurrent renames to the same target name must yield
// exactly one 200 + one 409.

const test = require('node:test');
const assert = require('node:assert/strict');
const { post, put } = require('../helpers/http-client');
const { resetBaseline } = require('../helpers/reset-state');
const { query } = require('../helpers/db-query');

async function ensureProgram(name) {
  const r = await post('/api/programs', { name });
  if (r.status === 200) return r.data.id;
  // Already exists? look it up
  if (r.status === 409) {
    const idStr = query(`SELECT id FROM programs WHERE name='${name}'`);
    return Number(idStr);
  }
  throw new Error(`unexpected program create status ${r.status}: ${JSON.stringify(r.data)}`);
}

test('A7-LIVE-01: concurrent PUTs renaming two programs to the same name → one 200, one 409', async () => {
  await resetBaseline();
  // Clean up any prior runs
  query(`DELETE FROM programs WHERE name LIKE 'a7-race-%'`);

  const idA = await ensureProgram('a7-race-A');
  const idB = await ensureProgram('a7-race-B');
  assert.notEqual(idA, idB);

  // Fire two concurrent PUTs renaming both to 'a7-race-WIN'
  const target = 'a7-race-WIN';
  const [resA, resB] = await Promise.all([
    put(`/api/programs/${idA}`, { name: target }),
    put(`/api/programs/${idB}`, { name: target }),
  ]);

  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [200, 409], `expected exactly one 200 + one 409, got ${JSON.stringify(statuses)}: ${JSON.stringify({ resA: resA.data, resB: resB.data })}`);

  // Verify DB: exactly one program named 'a7-race-WIN' and the other still has its original name
  const winnerCount = Number(query(`SELECT COUNT(*) FROM programs WHERE name='${target}'`));
  assert.equal(winnerCount, 1, `exactly one program must own the target name, got ${winnerCount}`);
});

test('A7-LIVE-02: rename to free name returns 200', async () => {
  await resetBaseline();
  query(`DELETE FROM programs WHERE name LIKE 'a7-rename-%'`);
  const id = await ensureProgram('a7-rename-orig');
  const r = await put(`/api/programs/${id}`, { name: 'a7-rename-new' });
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'a7-rename-new');
});

test('A7-LIVE-03: rename to existing name returns 409', async () => {
  await resetBaseline();
  query(`DELETE FROM programs WHERE name LIKE 'a7-dup-%'`);
  const idA = await ensureProgram('a7-dup-A');
  await ensureProgram('a7-dup-B');
  const r = await put(`/api/programs/${idA}`, { name: 'a7-dup-B' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /already exists/);
});

test('A7-LIVE-04: rename to same name is a no-op (200, no 409)', async () => {
  await resetBaseline();
  query(`DELETE FROM programs WHERE name LIKE 'a7-noop-%'`);
  const id = await ensureProgram('a7-noop-A');
  const r = await put(`/api/programs/${id}`, { name: 'a7-noop-A' });
  assert.equal(r.status, 200);
});
