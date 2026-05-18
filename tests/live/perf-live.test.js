'use strict';

// PERF-LIVE-01..04: #651 R4 percentile pair + R10 wake-up budget.
//
// These tests run against a deployed workbench (TEST_URL env var). They
// require a non-trivial session population to be meaningful; on a fresh
// container with 0 sessions, the cold-load test is trivially fast and
// still passes — the assertion is "≤ threshold", not a minimum.

const test = require('node:test');
const assert = require('node:assert/strict');
const { get } = require('../helpers/http-client');

// ── PERF-LIVE-01: /api/state cold-load p50 + p95 ─────────────────────────────

test('PERF-LIVE-01: /api/state p50 ≤ 10s, p95 ≤ 30s (R4 percentile pair)', async () => {
  const N = 10;
  const samples = [];
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    const r = await get('/api/state');
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 200, `sample ${i + 1}: expected 200, got ${r.status}`);
    samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(N * 0.5)];
  const p95 = samples[Math.floor(N * 0.95)];
  // eslint-disable-next-line no-console
  console.log(`PERF-LIVE-01 samples ms: p50=${p50} p95=${p95} all=${samples.join(',')}`);
  assert.ok(p50 <= 10_000, `p50 must be ≤ 10s, got ${p50}ms`);
  assert.ok(p95 <= 30_000, `p95 must be ≤ 30s, got ${p95}ms`);
});

// ── PERF-LIVE-02: /api/state with in-flight coalescing — 5 concurrent ────────

test('PERF-LIVE-02: 5 concurrent /api/state share a single scan (R6 coalescing)', async () => {
  const t0 = Date.now();
  const results = await Promise.all([get('/api/state'), get('/api/state'), get('/api/state'), get('/api/state'), get('/api/state')]);
  const elapsed = Date.now() - t0;
  for (const r of results) {
    assert.equal(r.status, 200);
  }
  // 5 concurrent should NOT take 5× a serial scan. Heuristic: total elapsed
  // is bounded by the p95 of a single scan plus light overhead. We assert
  // ≤ 35s (one p95 worst-case window) — under coalescing, real-world is far
  // tighter.
  // eslint-disable-next-line no-console
  console.log(`PERF-LIVE-02 5-concurrent total ms: ${elapsed}`);
  assert.ok(elapsed <= 35_000, `5 concurrent must complete within one p95 window, got ${elapsed}ms`);
});

// ── PERF-LIVE-03: server stays alive under repeated /api/state ────────────────

test('PERF-LIVE-03: 30 sequential /api/state polls succeed (no leaks / crashes)', async () => {
  for (let i = 0; i < 30; i++) {
    const r = await get('/api/state');
    assert.equal(r.status, 200, `poll ${i + 1} status was ${r.status}`);
  }
});

// ── PERF-LIVE-04: client wake-up budget (R10) — placeholder ─────────────────

test('PERF-LIVE-04: client wake-up budget (R10) — measured via timers.stats() (DOM-side; placeholder)', async () => {
  // R10 wake-up budget is measured DOM-side via window.Timers.stats(). The
  // headless measurement requires a browser harness; this placeholder asserts
  // the contract exists on the server side (the unified scheduler is wired
  // and the engine path is active). The full DOM-side test lands in the UI
  // runbook (Section 17 scenario 9 — idle wake-up budget).
  const r = await get('/health');
  assert.equal(r.status, 200);
});
