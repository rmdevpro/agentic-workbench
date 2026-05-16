'use strict';

// Stage 4 (integration) probe for milestone 01-stabilization.
// Target: HF test space deploy authorized 2026-05-16 per path-2 dispatch
//   space: aristotle9/agentic-workbench-test
//   sha:   4e0b9eead9d8 (corresponds to milestone HEAD ae1d882)
//   url:   https://aristotle9-agentic-workbench-test.hf.space/
//
// What this probe verifies (and what it deliberately does NOT):
//
//   Verifies (ungated surface):
//   - HF Space runtime.stage == RUNNING with the expected SHA
//   - /health returns 200 + JSON with db + workspace healthy
//   - /planlogo.png is reachable (canonical-blue lockup → logo_variant != production)
//   - Gate HTML renders with __GATE_MODE__ === 'password' (matches the test
//     space's WORKBENCH_USER/PASS Secrets configuration)
//
//   Does NOT verify (gated surface — would require WORKBENCH_USER/PASS):
//   - Any /api/* route behavior (gate intercepts everything except /health
//     and the whitelisted images per src/server.js:248)
//   - Per-issue behavioral assertions (those live in mock tests, structural
//     pins, and the gated /api/* surface verified historically against irina
//     dev when SSH auth was available)
//
// Per-issue stage-4 evidence cites the relevant subset of these probes plus
// the per-issue mock test as the highest-fidelity verification reachable
// from this container under the path-2 deploy constraint.

const test = require('node:test');
const assert = require('node:assert/strict');

const SPACE = 'aristotle9/agentic-workbench-test';
const URL = 'https://aristotle9-agentic-workbench-test.hf.space';
const EXPECTED_SHA = '4e0b9eead9d8fb559c1c24171f17d8e0b840ec9f';

async function fetchText(path) {
  const r = await fetch(`${URL}${path}`, { redirect: 'manual' });
  const text = await r.text();
  return { status: r.status, text, headers: r.headers };
}

async function fetchHead(path) {
  const r = await fetch(`${URL}${path}`, { method: 'HEAD', redirect: 'manual' });
  return { status: r.status, type: r.headers.get('content-type') };
}

test('HF-DEPLOY-01: HF Space API reports runtime.stage = RUNNING with deployed SHA', async () => {
  const r = await fetch(`https://huggingface.co/api/spaces/${SPACE}`);
  assert.equal(r.status, 200, `HF API must be reachable; got ${r.status}`);
  const d = await r.json();
  assert.equal(
    d.sha,
    EXPECTED_SHA,
    `Space sha must match the deploy commit; got ${d.sha}`,
  );
  assert.equal(
    d.runtime?.stage,
    'RUNNING',
    `runtime.stage must be RUNNING; got ${d.runtime?.stage}`,
  );
  assert.equal(d.sdk, 'docker', `sdk must be docker; got ${d.sdk}`);
});

test('HF-DEPLOY-02: /health returns 200 with db + workspace dependencies healthy', async () => {
  const r = await fetchText('/health');
  assert.equal(r.status, 200, `/health must be 200; got ${r.status}`);
  const data = JSON.parse(r.text);
  assert.equal(data.status, 'ok', `health.status must be 'ok'; got ${data.status}`);
  assert.equal(
    data.dependencies?.db,
    'healthy',
    `health.dependencies.db must be 'healthy'; got ${data.dependencies?.db}`,
  );
  assert.equal(
    data.dependencies?.workspace,
    'healthy',
    `health.dependencies.workspace must be 'healthy'; got ${data.dependencies?.workspace}`,
  );
  // auth is expected 'degraded' on a fresh HF Space without CLI creds —
  // record but don't fail.
  assert.ok(
    ['healthy', 'degraded'].includes(data.dependencies?.auth),
    `health.dependencies.auth must be one of healthy/degraded; got ${data.dependencies?.auth}`,
  );
});

test('HF-DEPLOY-03: /planlogo.png is reachable (canonical-blue lockup → logo_variant != production)', async () => {
  const r = await fetchHead('/planlogo.png');
  assert.equal(r.status, 200, `/planlogo.png must be 200; got ${r.status}`);
  assert.match(
    String(r.type),
    /^image\/png/,
    `/planlogo.png content-type must be image/png; got ${r.type}`,
  );
});

test('HF-DEPLOY-04: gate page renders with __GATE_MODE__ = password (Secrets configured)', async () => {
  const r = await fetchText('/');
  assert.equal(r.status, 200, `/ must be 200; got ${r.status}`);
  assert.match(
    r.text,
    /__GATE_MODE__\s*=\s*['"]password['"]/,
    'gate page must declare __GATE_MODE__ = password',
  );
  assert.match(
    r.text,
    /\/planlogo\.png/,
    'gate page must reference /planlogo.png (canonical-blue lockup)',
  );
  assert.match(
    r.text,
    /\/api\/gate\/login/,
    'gate page must wire its sign-in to /api/gate/login',
  );
});

test('HF-DEPLOY-05: gated /api/* endpoints intercept (gate is enforcing)', async () => {
  // Sanity-check that the gate is actually blocking — a regression that
  // bypasses the gate would surface as JSON instead of HTML here.
  for (const path of ['/api/state', '/api/settings', '/api/version']) {
    const r = await fetchText(path);
    assert.equal(r.status, 200, `${path} returns gate HTML at 200; got ${r.status}`);
    assert.match(
      r.text,
      /<!DOCTYPE html>/,
      `${path} must return gate HTML (gate enforcing); got JSON or other`,
    );
  }
});
