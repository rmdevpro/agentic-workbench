'use strict';

// A8 #333: /api/auth/login uses checkAuthStatus() (file mtime + parse) instead
// of `claude --print`. No tokens burned, response in <100ms.
//
// Codex R2 finding: A8-LIVE-02/03 mutated /data/.claude/.credentials.json
// directly — not safe against a shared deployment. The matrix's accepted
// disposition for A8 is "code inspection + sub-100ms response timing".
// This file now aligns the tests with that disposition:
//   - A8-LIVE-01: timing probe (read-only, no mutation) — KEPT.
//   - A8-LIVE-02 (NEW): code-inspection assertion that the auth handler
//     does NOT call `claude --print` or claudeExecAsync. This is the
//     canonical proof of A8's "no token burn" property.
//   - A8-LIVE-03 (REMOVED): the prior credential-wipe test was removed
//     because it's replaced by the safer code-inspection at A8-LIVE-02.
//     Anyone wanting to behaviorally test the no-creds branch in an
//     isolated test container can use the resetBaseline-guarded helper
//     pattern (WORKBENCH_TEST_SANDBOX=1).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { post } = require('../helpers/http-client');

test('A8-LIVE-01: POST /api/auth/login responds in <100ms (no CLI fork — read-only)', async () => {
  // Run twice — first call may have cold caches. Take the second.
  await post('/api/auth/login');
  const t0 = Date.now();
  const r = await post('/api/auth/login');
  const elapsed = Date.now() - t0;
  // 200 (valid creds) or 401 (no/stale creds) — either way, the operation
  // must complete fast because it is just a file stat + JSON parse, not a
  // claude --print fork. Pre-fix, this called claudeExecAsync which spawned
  // a Claude CLI subprocess (~1-2s + a billable inference token).
  assert.ok([200, 401].includes(r.status), `expected 200 or 401, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.ok(elapsed < 100, `login must complete in <100ms (file-stat fast path), took ${elapsed}ms`);
});

test('A8-LIVE-02: code inspection — /api/auth/login handler does NOT call claudeExecAsync or `claude --print`', () => {
  // Per the A8 disposition (matrix Facilitator Audit): canonical proof
  // that the no-token-burn property holds is that the handler doesn't
  // spawn the Claude CLI. This is a structural assertion against the
  // production source — safer than mutating real credentials, and
  // catches future regressions where someone accidentally restores
  // the CLI fork pattern.
  // G0 decomposed src/routes.js into domain modules; /api/auth/login is now
  // in src/routes/auth.js. Read that file instead of the thin dispatcher.
  const routesSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'routes', 'auth.js'),
    'utf-8',
  );
  // Find the /api/auth/login handler block. Allow either app.post or
  // app.get pattern (current code uses app.post).
  const handlerMatch = routesSrc.match(
    /app\.(?:post|get)\(['"]\/api\/auth\/login['"][\s\S]*?\n\s*\}\);/,
  );
  assert.ok(handlerMatch, '/api/auth/login handler must be present in src/routes.js');
  const handlerBody = handlerMatch[0];
  assert.ok(
    !/claudeExecAsync\s*\(/.test(handlerBody),
    '/api/auth/login handler must NOT call claudeExecAsync (would burn Claude tokens). Found in handler body.',
  );
  assert.ok(
    !/claude.*--print/.test(handlerBody),
    '/api/auth/login handler must NOT spawn `claude --print` (would burn Claude tokens).',
  );
  // Positive: handler should call checkAuthStatus (the file-stat fast path).
  assert.ok(
    /checkAuthStatus\s*\(/.test(handlerBody) || /readFile\s*\(/.test(handlerBody),
    '/api/auth/login handler must use the file-stat path (checkAuthStatus or readFile).',
  );
});
