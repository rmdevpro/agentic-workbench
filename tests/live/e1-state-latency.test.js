'use strict';

// #371 [E1]: /api/state payload reduction. Pre-fix the handler called
// getSessionInfo for every session in DB, parsing N JSONLs synchronously
// per poll → 5-7s p95 on M5 with O(50) sessions. Post-fix the sidebar list
// is built from db rows + cached discovery only — no JSONL parses. The
// heavy fields (message_count, model, input_tokens) move to GET
// /api/sessions/:id/info, called lazily by the frontend.

const test = require('node:test');
const assert = require('node:assert/strict');
const { get } = require('../helpers/http-client');

test('E1-LIVE-01: /api/state p95 latency < 1.5s on M5 (down from 5-7s pre-fix)', async () => {
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    const r = await get('/api/state');
    samples.push(Date.now() - t0);
    assert.equal(r.status, 200, `sample ${i + 1} failed with status ${r.status}`);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)] || samples[samples.length - 1];
  const median = samples[Math.floor(samples.length / 2)];
  // Pre-fix: 5000-7000 ms. Post-fix target: <1000 ms. Allow 1500ms upper
  // bound to absorb shared-host noise on M5 (qdrant + workbench + ssh
  // multiplex on the same box).
  assert.ok(
    p95 < 1500,
    `/api/state p95 must be <1500 ms (pre-fix was 5000-7000 ms; target <1000 ms). Got p95=${p95}ms median=${median}ms samples=${JSON.stringify(samples)}`,
  );
});

test('E1-LIVE-02: GET /api/sessions/:id/info returns heavy payload for a real session', async () => {
  // Find any active session in /api/state, then fetch /info for it
  const stateRes = await get('/api/state');
  assert.equal(stateRes.status, 200);
  const state = stateRes.data;
  let firstSession = null;
  for (const p of state.projects || []) {
    if (p.sessions && p.sessions.length > 0) { firstSession = p.sessions[0]; break; }
  }
  assert.ok(firstSession, 'expected at least one session in /api/state');
  // Confirm minimal shape
  assert.equal(firstSession.message_count, undefined, 'message_count must NOT be in /api/state');
  assert.equal(firstSession.model, undefined, 'model must NOT be in /api/state');
  // Now fetch /info — must contain the heavy fields
  const infoRes = await get(`/api/sessions/${encodeURIComponent(firstSession.id)}/info`);
  assert.equal(infoRes.status, 200);
  const info = infoRes.data;
  assert.equal(info.id, firstSession.id);
  assert.ok('message_count' in info, 'message_count present in /info response');
  assert.ok('input_tokens' in info, 'input_tokens present in /info response');
  assert.ok('model' in info, 'model present in /info response');
});
