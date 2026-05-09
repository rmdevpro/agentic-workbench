# Codex Code Review — Phase 1 Gate

**Date:** 2026-05-09  
**Branch reviewed:** `phase-1-verify`  
**Review scope:** Manual review of the Phase 1 work described in `reviews/5-9-26 - Phase 1 Gate Review/work-summary.md`, with context from `reviews/5-7-26 - Full Code Review/CORRECTIVE_ACTION_PLAN.md`.

## Gate Recommendation

Do not sign off Phase 1 yet. Several Phase 1 acceptance items are incomplete or introduce regressions in gate-critical behavior.

## Findings

### High: Gate page caches the wrong auth mode

**File:** `src/server.js:154`, `src/server.js:303`

`GATE_PAGE_HTML` is rendered at module load with `mode: authMode`, while `authMode` is still the initial value `'open'`. The actual mode is detected later in startup by `detectAuthMode()`. That means password/template deployments can serve a gate page whose injected `__GATE_MODE__` is stale or wrong.

**Impact:** Public/template or password-gated deployments can render the wrong authentication UI even though server-side gating is active.

**Suggested fix:** Cache the raw template, not the rendered mode, or rebuild the cached rendered HTML immediately after `detectAuthMode()` and after the periodic auth-mode refresh.

### High: SIGTERM/SIGINT handlers can prevent process shutdown

**File:** `src/ws-terminal.js:47-51`

The new PTY cleanup hook installs `SIGTERM` and `SIGINT` listeners that only call `_cleanupAllPtys()`. In Node, adding a signal listener overrides the default signal behavior. Without an explicit `process.exit()` or re-signal after cleanup, container shutdown can hang instead of terminating the server.

**Impact:** Docker/HF shutdown and restart paths can leave the Workbench process alive or delay termination until an external hard kill.

**Suggested fix:** Move signal handling to server shutdown code, close the HTTP server/WebSocket server, clean PTYs, then explicitly exit. At minimum, the signal handlers must terminate after cleanup.

### High: A2 is incomplete for MCP task moves

**File:** `src/mcp-tools.js:700-718`, `src/mcp-catalog.js:184-188`

HTTP task updates now call `db.moveTask()`, but the MCP `task_move` handler still calls `db.reparentTask()`. The catalog also exposes no `rank` argument for `task_move`. As a result, MCP callers still cannot move a task across buckets into a requested rank.

**Impact:** The original A2 bug remains for MCP: cross-bucket moves through `task_move` append to the destination bucket rather than landing at the requested rank.

**Suggested fix:** Add `rank` to the `task_move` schema and route `task_move` through `db.moveTask()`. Add MCP coverage for cross-bucket rank placement, not only HTTP/UI coverage.

### Major: A5 still blocks the event loop

**File:** `src/mcp-tools.js:184-186`

The file search command changed from shell interpolation to `execFileSync`. That fixes shell argument construction, but it does not satisfy the corrective action requirement to use async `execFile`. This handler still runs synchronous process execution inside an async MCP path.

**Impact:** Large or slow searches can block the Node event loop and stall unrelated Workbench requests/WebSocket activity.

**Suggested fix:** Use async `execFile` or `spawn` with bounded output collection. Wire the already-added `mcp.fileFindTimeoutMs` and `mcp.fileFindMaxBuffer` config keys instead of hardcoded values.

### Major: A11 does not remove project-local MCP configuration

**File:** `src/routes.js:1062-1148`

The project removal cascade kills tmux sessions, deletes the Claude session directory, and removes entries from Claude/Gemini/Codex trust config. It does not remove or rewrite the deleted project directory's `.mcp.json`.

**Impact:** If the project path remains on disk and is later reused, stale project-scoped MCP server entries remain active in that directory. This falls short of the A11 acceptance item to unregister project-scoped MCP entries.

**Suggested fix:** Delete or rewrite `<project.path>/.mcp.json` during cascade cleanup, and add a live assertion that the file no longer contains project-enabled MCP registrations after project removal.

### Major: A15 modal sweep is incomplete

**File:** `public/index.html`

The new `showInputModal` and `showConfirmModal` helpers exist, but many primary UI flows still call native dialogs. Examples include project/program save errors, restart failures, task move/status/archive errors, issue picker errors, Save As failures, file save failures, upload failures, and Git account operations.

Representative remaining native dialog call sites:

- `public/index.html:1828`
- `public/index.html:1882`
- `public/index.html:3284`
- `public/index.html:3353`
- `public/index.html:3901`
- `public/index.html:3997`
- `public/index.html:5577`
- `public/index.html:5633`

**Impact:** The corrective action was a primary CRUD `prompt` / `alert` / `confirm` sweep. Adding modal helpers and converting only some prompt/confirm sites does not complete that sweep.

**Suggested fix:** Replace remaining primary-flow native dialogs with the Workbench modal/error-banner pattern, or explicitly narrow A15 and file the remaining sweep as follow-up work.

### Major: A14 uses synthetic OAuth fixtures

**File:** `tests/mock/oauth-detector.test.js:21-31`

The corrective action acceptance called for fixture-backed tests using captured current OAuth output for Claude, Gemini, and Codex. The committed tests use synthetic fixture strings.

**Impact:** The parser is tested structurally, but the key brittleness risk remains: current CLI OAuth output may drift from the hardcoded markers and the tests would not catch it.

**Suggested fix:** Commit redacted captured fixtures from actual CLI OAuth flows and feed those fixtures byte-by-byte through the detector.

### Minor: K1 is a baseline marker, not a full migration replacement

**File:** `src/db.js:14-97`, `src/db/migrations/001-baseline.js:8-10`

The branch adds `schema_migrations` and a runner, but leaves the existing ad hoc `ALTER TABLE` blocks in place. The only migration file is an intentionally empty `001-baseline`.

**Impact:** This may be acceptable as a Phase 1 foundation, but it does not fully satisfy the corrective action wording to replace the 20+ try/catch `ALTER` blocks.

**Suggested fix:** Either document K1 as a baseline-only foundation for future migrations, or complete the migration conversion so existing schema changes are represented by numbered migrations with existing-DB seed behavior.

## Summary

Phase 1 includes useful fixes, especially around HTTP task updates, issue picker routing, and some frontend modularization. The gate should remain open until the high and major findings above are addressed or explicitly re-scoped by the user.

---

# Codex Follow-up Review — Updated Work Summary

**Date:** 2026-05-09  
**Review scope:** Manual re-review after the updated `work-summary.md`. This pass focuses on whether the updated summary's claims match the current `phase-1-verify` source.

## Gate Recommendation

Do not sign off Phase 1 yet. The updated work summary is more complete, but several claims still do not match the code, and one new test-process risk is gate-blocking.

## Findings

### Critical: Browser test command silently passes when Playwright is absent

**Files:** `package.json:11`, `tests/browser/a2-task-drag.spec.js:9-14`, and the same guard pattern across browser specs

The updated summary says the `playwright` dev dependency was intentionally removed and browser verification is driven through plugin MCP tools. However, `package.json` still exposes `npm run test:browser`, and the browser specs still do:

```js
try {
  ({ chromium } = require('playwright'));
} catch {
  process.exit(0);
}
```

That pattern appears across the browser suite. With Playwright absent, the process exits 0 before registering/running tests. This is worse than a skip: it can make a browser gate look green while running no browser assertions.

**Impact:** A caller running the repository's own browser-test command can get a false pass. This conflicts with the project test policy's no-silent-skip posture and makes UI regression evidence non-reproducible from the repo.

**Suggested fix:** Either remove/disable `test:browser` and document that browser acceptance is plugin-MCP-only, or keep Playwright as a dev/test dependency and make missing Playwright a hard failure. Do not `process.exit(0)` from test files.

### High: Updated summary claims A2 MCP was fixed, but MCP still uses `reparentTask`

**Files:** `src/mcp-tools.js:700-718`, `src/mcp-catalog.js:184-188`

The updated summary says: "Routes + MCP `task_move` updated to call it." The code does not match that. `handlers.task_move` still calls `db.reparentTask()`, and the MCP catalog still does not expose a `rank` parameter for `task_move`.

**Impact:** The A2 correctness fix is only present for HTTP `task_update`; MCP `task_move` still appends when moving across buckets and has no way to express a requested rank. The summary overstates closure of issue #327.

**Suggested fix:** Change `task_move` to call `db.moveTask()` and add `rank` to the `task_move` schema. Add MCP-specific test coverage for "move from project A to project B at rank 3".

### High: Updated summary claims A5 uses `execFile`, but the code uses `execFileSync`

**Files:** `src/mcp-tools.js:8`, `src/mcp-tools.js:184-186`

The updated summary says "`file_find` uses `execFile`." The code imports `execFileSync` and calls it inside the async `file_find` handler. This fixes shell interpolation but leaves synchronous child-process execution in an async MCP request path.

**Impact:** A slow search still blocks the Node event loop. The original A5 acceptance called for `execFile`, not only shell-safe argv construction.

**Suggested fix:** Replace `execFileSync` with async `execFile` or `spawn`, bounded output collection, and config-driven timeout/buffer values from `mcp.fileFindTimeoutMs` and `mcp.fileFindMaxBuffer`.

### High: Gate page cached mode issue remains

**Files:** `src/server.js:154-158`, `src/server.js:302-306`

The updated summary still lists A12 as complete. The implementation still renders `GATE_PAGE_HTML` before `detectAuthMode()` runs. `authMode` is initialized to `'open'`, so the cached gate page receives the wrong injected mode for password/template deployments.

**Impact:** The server-side gate can be active while the client-side gate page renders the wrong mode.

**Suggested fix:** Render the mode-specific HTML after auth detection, or cache only the static template and inject the current mode per response without disk I/O.

### High: PTY cleanup signal handlers still prevent default termination

**Files:** `src/ws-terminal.js:47-51`

The updated summary lists D6 as complete, but the signal handlers still only call `_cleanupAllPtys()`. They do not exit or re-signal after cleanup.

**Impact:** `SIGTERM`/`SIGINT` no longer have Node's default termination behavior. Container shutdown can hang.

**Suggested fix:** Handle shutdown centrally in `server.js`, close HTTP/WebSocket resources, clean PTYs, then explicitly exit. If the handler remains in `ws-terminal.js`, it must terminate after cleanup.

### Major: A11 still does not remove project-local `.mcp.json`

**Files:** `src/routes.js:1055-1148`

The updated punt audit correctly files bash terminals as #440, but A11 still misses the explicit corrective-plan acceptance item about project-scoped MCP entries. `cascadeCleanupProject()` removes CLI trust/config entries, but not `<project.path>/.mcp.json`.

**Impact:** Reusing a deleted project's path can preserve stale MCP server registrations from the old project.

**Suggested fix:** Delete or rewrite the project `.mcp.json` as part of project removal and add a live assertion for it.

### Major: A14 still relies on synthetic OAuth fixtures

**File:** `tests/mock/oauth-detector.test.js:23-30`

The updated summary acknowledges real fixture capture as a live-test acceptance criterion, but the implemented test file still uses synthetic fixtures. The Browser MCP verification also says it parses "fixtures"; it does not prove those fixtures came from current CLI output.

**Impact:** The main brittleness risk remains: a CLI prompt/string change can break OAuth modal detection while these tests still pass.

**Suggested fix:** Commit redacted captured OAuth transcript snippets for Claude, Gemini, and Codex, then feed those exact files byte-by-byte through the detector.

### Major: `require-hoist` structural test is allowed to skip in the production container

**File:** `tests/mock/require-hoist.test.js:19-26`

The summary says production containers skip the structural check because `acorn` is a dev dependency. That means C5's acceptance test does not run in the same deployed-container mock suite used as gate evidence.

**Impact:** The gate's stated mock evidence includes a skipped acceptance check for C5. This may be acceptable if local/dev-dependency verification is separately recorded, but it should not be counted as a passing deployed-container mock assertion.

**Suggested fix:** Either run the C5 structural test in an environment with dev dependencies as part of the gate, or rewrite the check to avoid dev-only dependencies.

### Minor: K1 should be described as baseline-only

**Files:** `src/db.js:14-97`, `src/db/migrations/001-baseline.js:8-10`

The updated summary is clearer that `001-baseline.js` anchors the runner. The remaining issue is wording: the corrective plan said K1 would replace the existing `ALTER` blocks. This implementation establishes the future runner but intentionally keeps the legacy idempotent `ALTER` blocks.

**Impact:** Low immediate product risk, but the gate should not record this as full replacement of the legacy migration path.

**Suggested fix:** Re-scope K1 explicitly as "baseline runner installed; legacy ALTER migration conversion deferred" or complete the conversion.

## Summary

The updated work summary is stronger and adds useful punt-audit detail, but it still overclaims A2 and A5, and the browser test command can silently pass without running browser tests. I recommend holding the gate until the critical/high items are fixed or explicitly re-scoped by the user.

---

# Codex Third Review — Additional Updated Work Summary

**Date:** 2026-05-09  
**Review scope:** Manual re-review after the latest `work-summary.md` update and fold-back disposition section. I did not run tests and did not use CodeRabbit. I reread the work summary completely and manually inspected the source paths for the previously disputed fold-backs.

## Gate Recommendation

Pass with follow-up, not unconditional sign-off. The earlier Codex gate blockers I rechecked are now mostly represented in the source: A12 gate page mode injection, D6 signal exits, A2 MCP `task_move`, A5 async `file_find`, A11 `.mcp.json` / DB cleanup, A15 listed primary CRUD error modals, and removal of the npm `test:browser` entrypoint.

The remaining issues are either accepted/deferred by the updated summary or lower-severity cleanup from the fold-back. The branch still needs the pre-merge fresh image rebuild / redeploy / regression sweep described in the work summary before it should be merged, because the summary says the currently verified runtime includes `docker cp` mutations after the published image build.

## Findings

### Major: A14 still does not satisfy the original real-fixture acceptance

**File:** `tests/mock/oauth-detector.test.js:23`

The updated summary correctly changes the disposition to defer real OAuth transcript capture to #441, but the code still uses synthetic OAuth fixtures. The test itself states the fixtures are synthetic and that real fixture capture is still the live-test acceptance criterion.

**Impact:** The detector is covered for the expected parser shape, but not for current Claude / Gemini / Codex OAuth output. CLI prompt drift can still break production detection while these tests pass.

**Disposition:** Accept only if #441 remains an explicit Phase 2 gate item. Do not record A14 as fully satisfying the original captured-fixture acceptance.

### Major: C5 structural coverage is skipped in the production-container gate evidence

**File:** `tests/mock/require-hoist.test.js:19`

The `require-hoist` test skips when `acorn` is absent. The work summary documents this as intentional because production containers omit dev dependencies. That is an honest disposition, but it means the deployed-container mock evidence does not execute C5's structural acceptance check.

**Impact:** This is not a product runtime bug, but it is a gate-evidence gap against STD-005's no-skips posture. The C5 check should be proven in a dev/CI environment with dev dependencies, or the gate package should stop counting it as deployed-container coverage.

**Disposition:** Accept-with-documentation is reasonable, but only if the gate evidence clearly separates "skipped in prod container" from "passed locally/CI."

### Moderate: Fold-back leaves an unused `execFileSync` import in MCP tools

**File:** `src/mcp-tools.js:8`

The A5 fold-back correctly moved `file_find` to promisified async `execFile`, but `execFileSync` remains imported from `child_process`. I found no remaining `execFileSync` use in `src/mcp-tools.js` beyond the import and explanatory comments.

**Impact:** This is small, but it is exactly the kind of cleanup that can add or preserve `no-unused-vars` lint failures in a branch already carrying a lint-error baseline. It also makes the A5 code read as if sync child-process usage may still be active in this module.

**Suggested fix:** Remove `execFileSync` from the destructured import.

### Minor: `file_find` buffer-limit error still hardcodes 16 MB

**File:** `src/mcp-tools.js:191`, `src/mcp-tools.js:204`

`file_find` now reads `mcp.fileFindMaxBuffer` from config, but the `ENOBUFS` error message still says `find output exceeded 16 MB`. If an operator changes the configured buffer, the client-facing message becomes inaccurate.

**Impact:** Low product risk, but it undermines the C2/A5 goal of making the limit operationally tunable and observable.

**Suggested fix:** Build the message from `maxBuffer`, preferably formatting it as MiB or bytes.

## Resolved From Prior Codex Reviews

I rechecked the previous high-priority Codex findings against source and no longer consider these blockers:

- **A12 gate page mode:** `src/server.js` caches `GATE_PAGE_TEMPLATE` and calls `renderGatePage(GATE_PAGE_TEMPLATE, authMode)` per request.
- **D6 signal handling:** `src/ws-terminal.js` exits with `143` for `SIGTERM` and `130` for `SIGINT` after PTY cleanup.
- **A2 MCP task move:** `src/mcp-tools.js` now routes `task_move` through `db.moveTask(...)`, and `src/mcp-catalog.js` exposes `rank`.
- **A5 async search:** `src/mcp-tools.js` now awaits promisified `execFile`.
- **A11 MCP cleanup:** `src/routes.js` removes `<project.path>/.mcp.json` and calls `db.clearProjectMcpEnabled(project.id)`.
- **A15 listed primary CRUD alerts:** the eight call sites Codex listed have been converted to `window.showErrorModal(...)`.
- **Browser silent-green npm command:** `package.json` no longer exposes `test:browser`.

## Notes

Remaining native `alert()` calls still exist in `public/index.html`, but the updated summary narrows the fold-back to the eight primary CRUD call sites Codex listed. I am treating the rest as accepted scope control rather than a renewed blocker.

The updated summary's pre-merge action items are still important: rebuild the image from `phase-1-verify` HEAD, redeploy M5 from that image, rerun the agreed sweeps, and spot-check the browser MCP scenarios. I did not execute those steps in this review.
