'use strict';

// Stage 4 (integration) probe for milestone 01-stabilization.
// Target: irina dev deploy of milestone HEAD per the 2026-05-16 RUN-001 deploy.
//   image: irina:5000/workbench:30159c0 (== :latest)
//   digest: sha256:0537b98f4a9fe2f1800ca1878cf107208cbb89aa6f09c3018d9f273b8056af58
//   container: 5fefcff8d412 on irina (192.168.1.110)
//   url: http://192.168.1.110:7860/
//   logo_variant: development
//
// What this probe verifies (ungated surface — irina dev has no gate, unlike
// the prior HF test space which sat behind a password gate):
//
//   - irina is reachable and /health returns 200 + db/workspace healthy
//   - /api/state returns valid JSON (not gate HTML) — ungated dev surface
//   - /api/version returns valid JSON
//   - Container's logo_variant is `development` (NOT production — pre-deploy
//     safety check, still true post-deploy)
//   - MCP tools catalog enumerates the expected handler set via /api/mcp/tools
//
// Per-issue integration tests target specific behavior surfaces:
//   tests/live/mcp-tools.test.js — #198, #268, MCP-01..07
//   tests/live/issue-275-codex-role-seed.test.js — #275
//   tests/live/d10-resume-tmp-files.test.js — #252, #446
//   tests/live/issue-437-session-list-parity.test.js — #437 (out-of-scope here)
//   tests/live/issue-445-project-mcp-cli-parity.test.js — #445 (out-of-scope)
//   tests/live/issue-450-summarize-no-project-arg.test.js — #450 (out-of-scope)
//   tests/live/ws-terminal.test.js — WS-01..03 (terminal lifecycle)
//   tests/live/routes-*.test.js — per-route behavioral coverage

const test = require('node:test');
const assert = require('node:assert/strict');

const URL = process.env.TEST_URL || 'http://192.168.1.110:7860';

async function fetchJson(path) {
  const r = await fetch(`${URL}${path}`);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: r.status, data, text };
}

test('IRINA-DEPLOY-01: /health returns 200 with db + workspace dependencies healthy', async () => {
  const r = await fetchJson('/health');
  assert.equal(r.status, 200, `/health must be 200; got ${r.status}`);
  assert.equal(r.data?.status, 'ok', `health.status must be 'ok'; got ${r.data?.status}`);
  assert.equal(r.data?.dependencies?.db, 'healthy', `db must be 'healthy'; got ${r.data?.dependencies?.db}`);
  assert.equal(r.data?.dependencies?.workspace, 'healthy', `workspace must be 'healthy'; got ${r.data?.dependencies?.workspace}`);
});

test('IRINA-DEPLOY-02: /api/state returns JSON (ungated surface — no gate HTML)', async () => {
  const r = await fetchJson('/api/state');
  assert.equal(r.status, 200, `/api/state must be 200; got ${r.status}`);
  assert.ok(r.data && typeof r.data === 'object', `must return JSON; got: ${r.text.slice(0, 80)}`);
  // Pre-fix HF deploy returned gate HTML at /api/state; the irina dev surface
  // is ungated, so JSON parse must succeed and the response must look like
  // the /api/state contract (projects array + programs array).
  assert.ok(Array.isArray(r.data.projects), 'response must carry .projects array');
  assert.ok(Array.isArray(r.data.programs), 'response must carry .programs array');
});

test('IRINA-DEPLOY-03: /api/version returns JSON (regression-guard against gate intercept)', async () => {
  const r = await fetchJson('/api/version');
  assert.equal(r.status, 200, `/api/version must be 200; got ${r.status}`);
  // The HF probe asserted gated /api/* endpoints returned HTML. The irina
  // dev surface must NOT do that — /api/version must be valid JSON.
  assert.ok(
    r.data !== null,
    `/api/version must return parseable JSON; got: ${r.text.slice(0, 80)}`,
  );
});

test('IRINA-DEPLOY-04: /api/mcp/tools enumerates the MCP catalog', async () => {
  const r = await fetchJson('/api/mcp/tools');
  assert.equal(r.status, 200, `/api/mcp/tools must be 200; got ${r.status}`);
  assert.ok(r.data && Array.isArray(r.data.tools), '/api/mcp/tools must return a {tools: [...]} array');
  // The flat MCP catalog is the surface where #253's `session_send_text` size
  // limit ships its size advisory; #437's `session_list` is exposed there;
  // #445's `project_mcp_enable` is there. A non-empty list confirms the
  // deploy serves the catalog correctly.
  assert.ok(r.data.tools.length >= 40, `expected ≥40 tools, got ${r.data.tools.length}`);
});

test('IRINA-DEPLOY-05: /api/settings exposes logo_variant=development (not production)', async () => {
  const r = await fetchJson('/api/settings');
  assert.equal(r.status, 200, `/api/settings must be 200; got ${r.status}`);
  // settings endpoint may return as { settings: {...} } or as a flat object;
  // either way logo_variant must be visible and equal to 'development'.
  const lv = r.data?.logo_variant
    ?? r.data?.settings?.logo_variant
    ?? r.data?.settings?.find?.((s) => s.key === 'logo_variant')?.value;
  assert.ok(
    lv === 'development' || lv === '"development"',
    `logo_variant must be 'development' on the dev deploy; got ${JSON.stringify(lv)}`,
  );
});
