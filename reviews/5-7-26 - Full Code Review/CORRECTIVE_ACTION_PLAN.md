# Corrective Action Plan — Agentic Workbench Review Remediation

**Date drafted:** 2026-05-08
**Source reviews:** `review/CODEX_CODE_REVIEW.md`, `review/GEMINI_CODE_REVIEW.md`, `review/CLAUDE_CODE_REVIEW.md`
**Status:** v2 — incorporates reviewer feedback from §10 (Gemini), §11 (Claude), and `review/CODEX_CODE_REVIEW.md` cross-review reconciliation addendum (Codex). Reviewer feedback sections preserved as audit trail. Net changes summarized in §12.

---

## 1. Purpose

Document the corrective actions required to close findings from the three independent code reviews. Each action is specified with file scope, intended change, acceptance criteria, effort estimate, and dependency relationships. This plan does not file issues — issue filing follows critique and user approval.

The plan is exhaustive: every finding across the three reviews is either listed as an action or listed in §3 (Deferred Set) with reasoning.

## 2. Inputs

| Review | Length | Findings | Notable contributions |
|---|---|---|---|
| Codex | 675 lines | 20 numbered findings | Caught the task reparent/rank correctness bug (ordering between rank and reparent ops); identified Gemini JSON/JSONL inconsistency between session-utils and qdrant-sync |
| Gemini | 1065 lines | 5-part audit + appendix | Diagnosed 16 mock test failures with named root causes; flagged 49 ESLint errors in tests/; flagged main-thread blocking in OAuth stream parser |
| Claude | 1182 lines | 71 prioritized findings | Caught the `routes.js:2165` path-encoding mismatch; consolidated sync-FS-in-async-paths table; reconciled README claims against code reality |

## 3. Deferred Set

Each item is documented with the effort estimate and the reason for deferral. Reviewers should challenge any deferral they consider unjustified.

### 3.1. Frontend framework migration to React/Vue

- **Source:** Gemini §1.6, Phase 4.
- **Effort:** Multiple months.
- **Reason:** The single-user trust model (AD-001) does not require a reactive framework. Action F0 (frontend modularization into 14 ES modules + CSS extraction) captures the testability and maintainability wins without the migration cost. The framework migration remains a viable future change.

### 3.2. Replace `/api/state` polling with WebSocket push

- **Source:** Gemini §1.3, Claude §9.
- **Effort:** 1-2 weeks plus stabilization.
- **Reason:** Actions E1 + E2 (payload-trim + unified discovery cache) together address the latency. Action **E3** (new — added in v2) addresses the *correctness* concern Gemini raised in §10.1: optimistic-mutation collisions with polling responses are fixed by pausing the poll while pending mutations are in flight, without requiring the push architecture. Per Claude §11.1, E1 alone may not reach <1s on M5; the realistic target is E1+E2 together.
- **Re-evaluate:** if E1+E2+E3 do not meet the latency or correctness bar in production, push moves out of the deferred set.

### 3.3. JSON-stringified settings → relational tables

- **Source:** Gemini §3.1.3, Claude §11.1.
- **Effort:** 1 week per table plus migration risk.
- **Reason:** The lost-update anomaly is theoretical under the single-user trust model for `git_accounts` (single-user, no auto-sync). However Claude §11.1 flags two settings with higher contention risk than `git_accounts` — these are the next-easiest relational migrations once K1 (migration runner) lands. Order is: **K1 → relational `webhooks` → relational `vector_collection_*` settings → re-evaluate remaining JSON-stringified settings.** The path-keyed `git_accounts` table demonstrates the shape.
- **Hard dependency:** K1 (numbered DB migration runner) MUST land before any relational migration.

### 3.4. `task-service.js` extraction

- **Source:** Codex §19, addendum.
- **Effort:** 3-4 days.
- **Reason:** Codex recommends extracting an authoritative `task-service.js` boundary because task validation is split between routes and db today. Action A2 (atomicity fix) is the minimum-viable correctness in lieu. The full task-service extraction folds naturally into the routes decomposition (G5 routes/tasks.js child) once the atomicity fix has landed; it does not need a standalone phase. If after G5 the validation drift remains painful, file as a follow-up. Not in current scope.

### 3.5. OAuth detector → backend Node worker thread

- **Source:** Gemini §1.5.
- **Effort:** 4-5 days plus protocol design.
- **Reason:** Gemini's recommended end-state is a backend worker-thread parser emitting structured `{type: "auth_required", url}` WebSocket messages. Action A14 (extract to a frontend ES module with fixture-based tests) is the first step; it makes the parser testable and the patterns grep-friendly without changing where it runs. The worker-thread move is deferred. **Re-evaluate:** if main-thread regex blocking shows up as observed UI lag in production after F0 lands, file the worker-thread move as a follow-up.

## 4. Acceptance and Verification Standards

All actions, regardless of size, must satisfy:

- **Engineering standards:** `Admin/docs/requirements/REQ-001-base-engineering.md`, `STD-004-code-standard.md`, `STD-005-test-code-standard.md`.
- **Test execution policy:** `Admin/docs/process/PROC-004-test-execution-policy.md` — mock + live + browser tiers as applicable.
- **UI-touching changes:** verified via browser-driven Playwright tests, not host-side `curl`/`docker exec` (memory `feedback_ui_tests_headless_only.md`).
- **Deployment:** RUN-001 canonical sequence, M5/dev only unless explicitly authorized.
- **No silent workarounds:** memory `feedback_no_silent_workarounds.md`.
- **Tests verify actual results:** memory `feedback_tests_must_show_actual_results.md` — `{ok:true}` is necessary but not sufficient.

## 5. Action Ledger

Actions are grouped by type, not by phase. Sequencing recommendations appear in §6.

### A. Narrow correctness fixes

#### A1. routes.js:2165 path-encoding mismatch

- **Files:** `src/routes.js:2165`.
- **Change:** Replace inline `replace(/[^a-zA-Z0-9]/g, '-')` with `safe.findSessionsDir(projectPath)`. The canonical encoder uses `[\/_]`, which differs in handling of `.`, `~`, `+`, space.
- **Acceptance:** Live test (new) — create a project whose **path** contains `.`, `~`, and `+` (e.g., a project pointing at `/data/workspace/foo.bar/sub_dir+with-stuff`); start a Claude session; GET `/api/sessions/:id/session` and assert the returned path matches the actual file Claude writes at `~/.claude/projects/<encoded-path>/<sessionId>.jsonl`. The fix must exercise the path encoder, not just the project-name field. (Per Claude §11.2.)
- **Effort:** 1 hour.
- **Dependencies:** None.
- **Source:** Claude High #1.

#### A2. Task reparent/rank atomicity

- **Files:** `src/db.js` (add `moveTask`), `src/routes.js:1718-1723`, `src/mcp-tools.js:722-732`.
- **Change:** Add `db.moveTask(id, { parentTaskId, projectId, rank })` that performs reparent + rank assignment + source-bucket densification + destination-bucket densification in one transaction. Update HTTP `PATCH /api/tasks/:id` and MCP `task_move` to call it. Remove the separate `reparentTask` + `setTaskRank` two-step.
- **Acceptance:** Browser test (new) — drag task from project A bucket to project B bucket between rank 2 and rank 3; verify the task lands at rank 3 in B (not appended to end). Mock test — call `db.moveTask(id, {parentTaskId: null, projectId: 5, rank: 2})` with a target bucket that has 5 existing items; assert target bucket is `[1,2,moved,3,4]` after.
- **Effort:** 3 hours.
- **Dependencies:** Should land **before G5** (routes/tasks.js extraction) so the route fix doesn't have to migrate during decomposition. If L1 lands first the MCP-side fix lands in the (then-unified) handler module rather than two locations — preferred order is A2 + L1 in parallel, then G5. (Per Claude §11.4.)
- **Source:** Codex Finding #5.

#### A3. /api/issues GraphQL string concatenation

- **Files:** `src/routes.js:709-715`.
- **Change:** Use GraphQL variables for `owner` and `name` (`query($o:String!, $n:String!) { repository(owner:$o, name:$n) { ... } }`). Derive the API host from the configured `git_account.path` (parse host segment) so GitHub Enterprise paths route to the correct GraphQL endpoint.
- **Acceptance:** Live test — repo with `"` in the name resolves correctly. Live test — credential configured for an enterprise host (`enterprise.example.com/owner`) routes the GraphQL request to `enterprise.example.com/api/graphql`, not `api.github.com`.
- **Effort:** 2 hours.
- **Dependencies:** None.
- **Source:** Claude Med #18, Med #19.

#### A4. Frontend issue picker hardcodes rmdevpro/

- **Files:** `public/index.html:3334`, `src/routes.js` (new endpoint `/api/projects/:name/git-remote`).
- **Change:** Add backend endpoint that runs `git remote get-url origin` for the project, parses owner/name via `git-auth.pathFromUrl`, returns `{owner, name, host}`. Frontend issue picker calls this endpoint instead of deriving from path.
- **Acceptance:** Browser test — clone a repo from a different org into the workspace; open the issue picker for a task in that project; verify GitHub issues from the correct org load.
- **Effort:** 3 hours.
- **Dependencies:** None.
- **Source:** Claude High #6.

#### A5. file_find arg interpolation

- **Files:** `src/mcp-tools.js:157-180`.
- **Change:** Replace `execSync('grep ' + grepArgs.join(' '))` with `execFile('grep', argv)`. Validate `args.file_type` matches `/^[a-zA-Z0-9_+-]+$/`; coerce `args.context_lines` to bounded integer 0..10.
- **Acceptance:** Mock test — call with `file_type: "js;rm -rf /"` and verify 400 rejection. Call with `file_type: "tsx"` and verify normal grep result. Mock test — call with `context_lines: 999`; assert it is clamped to ≤10. (Note per Claude §11.2: `args.pattern` is already shell-escaped at the existing call site, so a `pattern: "$(echo HACK)"` test is a regression-coverage entry only, not the proof of fix.)
- **Effort:** 2 hours.
- **Dependencies:** None.
- **Source:** Claude Med #17, Codex §10.

#### A6. gh_cmd command argument validation

- **Files:** `src/mcp-tools.js:825-875`.
- **Change:** Reject non-array `command` and non-string array elements with `ToolError 400`. Cap stdout/stderr at 200KB chunked (currently buffers fully then truncates).
- **Acceptance:** Mock test — `command: "ls -la"` (string, not array) returns 400. `command: ["log", {}]` returns 400. `command: ["log", "-n", "5"]` works. Mock test — gh subprocess that emits >200KB to stdout returns truncated output without OOM.
- **Effort:** 2 hours.
- **Dependencies:** None.
- **Source:** Claude Low #55.

#### A7. /api/programs PUT name uniqueness transaction

- **Files:** `src/db.js`, `src/routes.js:1043-1066`.
- **Change:** Wrap `getProgramByName(clean)` check + `renameProgram` update in a single transaction so concurrent renames cannot race.
- **Acceptance:** Live test — fire two concurrent PUTs renaming different programs to the same name; assert exactly one returns 409, the other 200.
- **Effort:** 1 hour.
- **Dependencies:** None.
- **Source:** Claude Low #61.

#### A8. /api/auth/login uses real Claude query

- **Files:** `src/routes.js:1101-1110`.
- **Change:** Replace `claude --print 'test'` token-burning check with `checkAuthStatus()` (already exists at L186 — reads `~/.claude/.credentials.json` mtime + parses).
- **Acceptance:** Mock test — stub `safe.claudeExecAsync` and assert it is never invoked across N login attempts. Live test — login attempt while authenticated returns 200 in <100ms (the original problem was the slow Claude round-trip). Login attempt with stale credentials returns 401. (Per Claude §11.2: the original "check Claude usage logs" approach required anthropic.com billing access; stub-and-assert-never-called is the right verification.)
- **Effort:** 1 hour.
- **Dependencies:** None.
- **Source:** Claude Low #62.

#### A9. Claude tmpId collision under rapid creation

- **Files:** `src/routes.js:1284-1289`.
- **Change:** Append `crypto.randomBytes(3).toString('hex')` suffix to `new_${Date.now()}` for parity with the MCP-side path at `mcp-tools.js:213`.
- **Acceptance:** Mock test — call `POST /api/sessions` 5x in a tight loop within 1ms wall time; assert all 5 tmpIds are distinct.
- **Effort:** 30 minutes.
- **Dependencies:** None.
- **Source:** Claude Low #63.

#### A10. Gemini JSON/JSONL parser inconsistency

- **Files:** `src/qdrant-sync.js:588-614, 927-930`, `src/session-utils.js:733-866`.
- **Change:** Extract Gemini transcript parser into a shared module that handles both `.json` and `.jsonl` shapes. Both qdrant scan paths and session-utils discovery use it.
- **Acceptance:** Live test — Gemini session produces a `.jsonl` transcript; verify it appears in both `/api/state` session list AND in `/api/qdrant/status` collection point count.
- **Effort:** 4 hours.
- **Dependencies:** **After H2** (Gemini child of session-utils decomposition), per Claude §11.4. If A10 lands before H2, the shared parser has to be re-extracted during decomposition; if after, it lands directly in `session-utils/gemini.js` and is consumed from `qdrant-sync` from there.
- **Source:** Codex §13.

#### A11. /api/projects/:name/remove cascade

- **Files:** `src/routes.js:1003-1013`.
- **Change:** On project delete, kill running tmux sessions for the project, unregister project-scoped MCP entries, delete session JSONLs (or move to an archive directory).
- **Acceptance:** Live test — create project, start a Claude session, delete project; verify tmux session is gone (`tmux ls` does not list it), `~/.claude/projects/<encoded>/` directory is gone, project's `.mcp.json` registrations are removed from any global config (claude, gemini, codex).
- **Effort:** 4-5 hours (per Claude §11.3: tmux kill ~1hr + JSONL deletion without breaking session-resolver invariants ~1hr + unregistering project-scoped MCP from each of three CLI configs ~1-2hrs).
- **Dependencies:** None.
- **Source:** Claude Low #60.

#### A12. server.js gate page sync read

- **Files:** `src/server.js:143-149`.
- **Change:** Cache gate-page content at module load, not per-request. Wrap in a try/catch that falls back to a hardcoded minimal page on read failure.
- **Acceptance:** Mock test — verify `serveGatePage` does not call `readFileSync` after module init. Mock test — replace gate.html with a corrupt fixture during boot; verify server starts and serves the fallback page.
- **Effort:** 1 hour.
- **Dependencies:** None.
- **Source:** Claude §2.1 L143-149.

#### A13. session-resolver async conversion

- **Files:** `src/session-resolver.js:209-329`.
- **Change:** Replace sync `readdirSync`/`existsSync`/`readFileSync` with `fs/promises` equivalents. Keep the polling cadence; just stop blocking the event loop while polling.
- **Acceptance:** Live test — start a Gemini session and a Claude session simultaneously; measure event-loop lag during the resolver's 60s polling window via `perf_hooks.monitorEventLoopDelay`. Lag p95 must be < 50ms.
- **Effort:** 3 hours.
- **Dependencies:** None.
- **Source:** Claude High #3.

#### A14. Frontend OAuth stream parser extraction

- **Files:** `public/index.html:4800-4820` (extract), `public/js/oauth-detector.js` (new), `tests/browser/oauth-detector.test.js` (new).
- **Change:** Extract `checkForAuthIssue` and the URL/endMarker pattern table into a standalone module. Add fixture-based tests for each of Claude, Gemini, Codex's current OAuth output. Patterns become a data table that's grep-friendly.
- **Acceptance:** Mock test — feed each fixture transcript byte-by-byte; verify the modal-trigger event fires exactly once at the right point, with the URL extracted correctly. The test reproduces the substring brittleness as a known limitation comment in the module.
- **Effort:** ~9-13 hours: 4 hours for the extraction + scaffolding + 2-3 hours per CLI for fixture capture (run each CLI's `/login` flow under instrumentation, capture the output stream, redact the URL, commit). Per Claude §11.2: the original 4-hour estimate did not include fixture-capture cost.
- **Dependencies:** Best done as the **F7 canary** for F0 (frontend modularization) — proves the modular split works before larger children (F4-F14) are extracted. Per Gemini §10.3 / Claude §11.6, F7 is a Phase 2 canary candidate.
- **Source:** Gemini §1.5; Claude does not address parsing fragility directly.

#### A15. Save As / confirm / alert / prompt sweep

- **Files:** `public/index.html:1515-1530, 3277, 3770-3798, ~6 more sites`.
- **Change:** Replace each `window.prompt`/`alert`/`confirm` for primary CRUD with the workbench's existing modal pattern (✎ pencil + center-popup modal). Reuse the auth modal's overlay pattern for one-shot text input.
- **Acceptance:** Browser test — Save As on a file produces the workbench modal, not a browser native prompt. Browser test — delete confirmation produces the workbench modal. Repeat for each migrated site.
- **Effort:** 1 day.
- **Dependencies:** Easier after Action F0; can also be done first as motivation for F0's modal-utility module.
- **Source:** Claude Med #42, Med #43.

#### A16. Two escapeHtml implementations

- **Files:** `public/index.html:4583, 5853`.
- **Change:** Consolidate into one `escapeHtml(text)` function. Add a separate `escapeAttr(value)` for attribute contexts (which are subtly different — quotes matter). Replace all call sites with the typed helper. Document the distinction in a code comment.
- **Acceptance:** Mock test — `escapeHtml('<&>"')` returns `&lt;&amp;&gt;&quot;`. Browser test — render a session name containing all four special characters and verify the rendered DOM textContent matches the input.
- **Effort:** 2 hours.
- **Dependencies:** Folds into Action F0 (becomes part of the `app/util.js` module).
- **Source:** Claude Med #44.

#### A17. WORKBENCH_SESSION_ID env var injection at session spawn

- **Files:** `src/safe-exec.js:180-228` (`tmuxCreateCLI`).
- **Change:** Inject `WORKBENCH_SESSION_ID=<workbench-session-id>` as an env var into every CLI launch (Claude, Gemini, Codex). The CLIs do not currently consume this — the change is forward-compatibility plus a grep-able marker for `ps` / `/proc/<pid>/environ` introspection. Once any CLI starts echoing this in its first log line, `session-resolver` can use it as a deterministic identity binding instead of the mtime-based heuristic. Until then, it is at least a recoverable signal for diagnosis.
- **Acceptance:** Mock test — `tmuxCreateCLI` invocation contains `WORKBENCH_SESSION_ID=<id>` in the spawn env. Live test — start a Claude/Gemini/Codex session; `cat /proc/<tmux-pid>/environ` shows the variable.
- **Effort:** 2 hours.
- **Dependencies:** None.
- **Source:** Gemini §3.3 (per Claude §11.5 missing-actions list).

#### A18. Frontend layout thrashing in switchTab

- **Files:** `public/index.html:2100-2130`, `public/index.html` CSS block (will move to `public/css/main.css` per F0).
- **Change:** Replace `display: none` toggling for inactive terminal panes with `position: absolute; top: -9999px; visibility: hidden;`. Active panes use `position: relative; visibility: visible;`. This preserves the layout bounding box so xterm.js can measure dimensions immediately, eliminating the `requestAnimationFrame` + 300ms `setTimeout` double-fit hack.
- **Acceptance:** Browser test — switch between two terminal tabs ten times; assert no visible "jumping" via screenshot diff. Browser test — measure `switchTab` duration; assert <50ms p95 (current includes 300ms timeout). Remove the `setTimeout(..., 300)` line in `switchTab` as proof of fix.
- **Effort:** 4 hours.
- **Dependencies:** Easier after F0+F5 (frontend modularization, tabs module). Can land before as a CSS-only change.
- **Source:** Gemini §1.4 (per Claude §11.5 missing-actions list).

### B. Cleanup / dead-code removal

#### B1. Delete src/voice.js + tests + references

- **Files:** Delete `src/voice.js`, `tests/mock/voice.test.js`. Update `tests/mock/server.test.js` references. Update README architecture section.
- **Change:** Voice was removed at server-side comment time but the file remained.
- **Acceptance:** `grep -ri "voice" src/ tests/ public/ config/` returns zero hits OR the surviving references are explicitly listed in the PR description as historical context (e.g., test plan removal note). Test suite passes. README architecture lists no voice module. (Per Claude §11.2: original src/-only grep missed `tests/workbench-test-runbook.md:3721` and `tests/mock/server.test.js`.)
- **Effort:** 30 minutes.
- **Dependencies:** None.
- **Source:** Claude Critical (dead code) §2.19; Codex §8 (with explicit user note "voice IS removed").

#### B2. Delete jQuery + jqueryfiletree dependencies

- **Files:** `package.json:21-22`, `package-lock.json`, `public/index.html` (remove `<script>` tags), comment cleanup in `src/routes.js:22-25`.
- **Change:** The custom `createFileTree` (public/index.html:3897+) replaced jqueryFileTree. jQuery has zero remaining feature usage.
- **Acceptance:** `grep -r "jquery" public/index.html src/` returns zero hits except the deleted-in-this-PR cleanup comments. Frontend boots without errors. File tree still works.
- **Effort:** 1 hour.
- **Dependencies:** None.
- **Source:** Claude Low #51.

#### B3. Delete scripts/prime-test-session.js

- **Files:** Delete `scripts/prime-test-session.js`.
- **Change:** Stale: references removed `prompt` API field, references `hopper` user instead of `workbench`, depends on smart-compaction (removed in test plan v7.0).
- **Acceptance:** File deleted. No callers (`grep -r "prime-test-session"` returns zero). CI green.
- **Effort:** 15 minutes.
- **Dependencies:** None.
- **Source:** Claude Med #48.

#### B4. Delete .dockerignore exclusions for non-existent files

- **Files:** `.dockerignore:11-12`.
- **Change:** Remove `CLAUDE_PENANCE.txt`, `compaction-*.md`, `smart-compaction-*.md` exclusions (referenced files no longer exist).
- **Acceptance:** `.dockerignore` contains no exclusions for files not present in the repo.
- **Effort:** 10 minutes.
- **Dependencies:** None.
- **Source:** Claude §1.4 L11-12.

### C. Hygiene sweeps

#### C1. .dockerignore exclusions that break local builds

- **Files:** `.dockerignore:7-8`.
- **Change:** Add `!public/*.png` after the `*.png` exclusion. Add `!tests/fixtures/*.txt` after the `*.txt` exclusion. Verify with `docker compose up --build` locally that the gate page renders with logos and the fixture-backed tests pass.
- **Acceptance:** Local `docker compose up --build` produces an image where `/workbench-preview.png`, `/planlogo.png`, all logo PNGs are present at expected paths. `tests/fixtures/ansi-auth-url.txt` is present in container.
- **Effort:** 30 minutes.
- **Dependencies:** None.
- **Source:** Claude High #15, High #16.

#### C2. Externalize orphan config keys

- **Files:** `config/defaults.json`. Code modules consuming the keys remain unchanged.
- **Change:** Add the following keys that are currently read by code with code-side fallback only:
  - `keepalive.refreshThreshold` (0.85)
  - `keepalive.checkRangeLow` (0.65)
  - `keepalive.checkRangeHigh` (0.85)
  - `keepalive.fallbackIntervalMs` (1800000)
  - `keepalive.queryTimeoutMs` (30000)
  - `keepalive.authBrokenThreshold` (3)
  - `keepalive.credsWatchIntervalMs` (60000)
  - `claude.defaultTimeoutMs` (120000)
  - `session.summaryModel` ("haiku")
  - `session.summaryMaxTranscriptChars` (40000)
  - `session.summaryMaxMessageChars` (1500)
  - `ws.bufferHighWaterMark` (1048576)
  - `ws.bufferLowWaterMark` (262144)
  - `ws.pingIntervalMs` (30000)
  - `ws.scrollbackReplayLines` (5000)
  - `resolver.maxAttempts` (30)
  - `resolver.sleepMs` (2000)
  - `qdrant.url` (`http://127.0.0.1:6333`)
  - `qdrant.debounceMs` (10000)
  - `qdrant.chunkWindow` (3)
  - `qdrant.chunkOverlap` (1)
  - `routes.nonClaudeCacheTtlMs` (10000) — was `NONCLAUD_CACHE_TTL` at `routes.js:344`
  - `routes.nonClaudeMatchWindowMs` (60000) — was hardcoded 60s session matching window at `routes.js:382-387`
  - `mcp.fileFindTimeoutMs` (10000) — was hardcoded grep timeout at `mcp-tools.js:169`
  - `mcp.fileFindMaxBuffer` (16777216) — was hardcoded 16MB buffer at `mcp-tools.js:169`
  - `qdrant.ignorePatternsDefault` (array) — was hardcoded ignore-pattern defaults at `qdrant-sync.js:58`
- **Acceptance:** Each key has an entry in `defaults.json`. Restart the server with the file's value modified for one key and verify the new value takes effect. Document each key's purpose in a comment.
- **Effort:** 3 hours.
- **Dependencies:** Phase 1 (per Claude §11.4 — should land before A actions that read these keys, so subsequent actions read from defaults.json rather than code-side fallbacks).
- **Source:** Claude High #12, §1.7; Codex §16 added the last 5 keys (per Claude §11.5 missing-actions list).

#### C3. Hardcoded constants → src/constants.js

- **Files:** New `src/constants.js`. Update `src/server.js`, `src/routes.js`, `src/kb-watcher.js`, `public/index.html` to import from it.
- **Change:** Centralize:
  - `KB_PATH = '/data/knowledge-base'`
  - `KB_UPSTREAM_URL = 'https://github.com/rmdevpro/workbench-kb'`
  - Codex rollout UUID regex
  - Tmux name format slice indices (expose as `safe.tmuxNamePrefix(name)` instead — fold into Action C4 instead).
- **Acceptance:** `grep -rn '/data/knowledge-base' src/ public/` returns hits only in `src/constants.js`. `grep -rn 'rollout-' src/` shows the regex appears only in `src/constants.js`. Server boots and KB clone/sync still works.
- **Effort:** 3 hours.
- **Dependencies:** None.
- **Source:** Claude §7.3.

#### C4. Tmux name parsing helper

- **Files:** `src/safe-exec.js` (new function), `src/ws-terminal.js:57`.
- **Change:** Add `safe.tmuxNamePrefix(name)` that returns the 12-char id-derived prefix. ws-terminal calls it instead of slicing.
- **Acceptance:** Mock test — `tmuxNamePrefix(tmuxNameFor('abc-123'))` returns the same prefix as `tmuxNameFor('abc-123').slice(3, 15)`. ws-terminal auto-respawn still works.
- **Effort:** 1 hour.
- **Dependencies:** None.
- **Source:** Claude Med #33.

#### C5. Inline require() hoist

- **Files:** `src/routes.js`, `src/mcp-tools.js`, `src/safe-exec.js` (the inline calls listed in Claude review §7.4).
- **Change:** Move all in-function `require()` calls to module top. Exception: lazy requires that exist specifically to break circular imports (none currently identified).
- **Acceptance:** AST-based check (small `acorn` script in `tests/lint/`) — parse each `src/*.js` file; assert all `CallExpression(callee=Identifier "require")` nodes have a `Program`-level ancestor `VariableDeclaration` (i.e., are top-level). 30 lines of acorn code; deterministic. (Per Claude §11.2: the original grep regex would miss `let r = require(...)`, `var r = require(...)`, conditional, and nested-function requires.) All tests pass.
- **Effort:** 3 hours (AST script + sweep).
- **Dependencies:** None. Easier to verify after G0+children land, since each domain file's imports become small and reviewable. Should precede N1's hard-error tier (per Claude §11.4) — running `eqeqeq`/`prefer-const` rules without first cleaning inline requires risks lint-rule additions surfacing inline-require breakage as collateral.
- **Source:** Claude §7.4.

#### C6. Trivial cleanup batch

- **Files:** `public/gate.html:188`, `src/server.js:29`, `src/db.js:257`.
- **Change:**
  - `public/gate.html:188` — replace hardcoded duplicate-Space ID `aristotle9/agentic-workbench` with a build-time constant or env var so renaming the upstream Space doesn't break the gate page.
  - `src/server.js:29` — drop the `|| 3000` fallback; PORT is mandatory (Dockerfile sets 7860).
  - `src/db.js:257` — replace misleading "tasks table not yet created" catch comment; the CREATE TABLE block above runs first, so this catch is never hit on a fresh DB.
- **Acceptance:** Each change reviewed in isolation per file. No behavior change expected.
- **Effort:** 1 hour total.
- **Dependencies:** None.
- **Source:** Claude Trivial #69, #70, #71 (per §11.5 missing-actions list).

#### C7. Test artifact gitignore + missing fixtures

- **Files:** `.gitignore`, `tests/fixtures/`.
- **Change:**
  - Add `tests/coverage-results-*.txt`, `tests/runbook-results-*.md` to `.gitignore`. Move existing committed transient artifacts to a date-named results subdirectory (`tests/results-archive/`) or delete if no longer referenced. The runbook results are 100KB+ each — they should not live in main.
  - Capture the 5 documented-but-missing fixtures referenced by the test plan §3.3: `ansi-auth-url.txt`, `chunked-auth-frames.bin`, file-tree fixture, primed-JSONL, settings.json. Either commit real fixtures or update the test plan to reflect the fixtures-generated-inline reality.
- **Acceptance:** `git status` after a fresh test run shows no transient artifact additions. `tests/fixtures/` content matches what the test plan documents (or vice versa).
- **Effort:** 3 hours.
- **Dependencies:** None.
- **Source:** Claude §5 (per §11.5 missing-actions list).

#### C8. Legacy helpers in safe-exec.js

- **Files:** `src/safe-exec.js:345-383, 438-439` (`grepSearchAsync`, `curlFetchAsync`).
- **Change:** Codex §18 noted these helpers are referenced only by tests, with no current product call sites. Either delete them and their tests, or move to `tests/fixtures/legacy-helpers.js` clearly labeled as test-only.
- **Acceptance:** `grep -rn 'grepSearchAsync\|curlFetchAsync' src/ public/` returns zero hits in product code. Test suite passes.
- **Effort:** 1 hour.
- **Dependencies:** None.
- **Source:** Codex §18 (per Claude §11.5 missing-actions list).

### D. Operational hygiene

#### D1. Cookie secure flag for non-HTTPS

- **Files:** `src/server.js:158`.
- **Change:** Set `secure: true` when `req.headers['x-forwarded-proto'] === 'https'` OR `process.env.NODE_ENV === 'production'`. Document the HF Space case (HTTPS-forced) and the local-compose case (HTTP, no gate so cookie issuance never happens).
- **Acceptance:** Live test on HF — login response sets `Set-Cookie ... Secure`. Live test on local compose with no gate — endpoint never reaches cookie-issue path.
- **Effort:** 1 hour.
- **Dependencies:** None.
- **Source:** Claude §2.1 L158.

#### D2. Rate limit /api/gate/login

- **Files:** `src/server.js` (auth gate).
- **Change:** Add per-IP token bucket: 10 attempts/minute. After failure, `await new Promise(r => setTimeout(r, 500))` before responding. No bucket needed for successful logins.
- **Acceptance:** Live test — fire 15 wrong-password requests in 5 seconds; verify 5 of them get 429. Then wait 60s; fire 1 more wrong-password request; verify it returns 401 (not 429) — proves the bucket resets. (Per Claude §11.2: original acceptance allowed a broken implementation that bans the IP forever to pass.)
- **Effort:** 2 hours.
- **Dependencies:** None.
- **Source:** Claude §2.1 L154-162.

#### D3. Qdrant background-launch health monitoring

- **Files:** `entrypoint.sh:98-101`.
- **Change:** Pipe Qdrant stderr through a `qdrant: ` prefix. Add a one-shot health check at startup that hits `:6333/health` after 5 seconds and logs failure to the workbench logger via a marker file.
- **Acceptance:** Live test — kill `qdrant` binary in the image with chmod -x; restart container; verify the workbench server starts (existing behavior) AND that there's a clear log line indicating Qdrant failed to start.
- **Effort:** 2 hours.
- **Dependencies:** None.
- **Source:** Claude §1.3 L98-101.

#### D4. Pin CLI versions

- **Files:** `Dockerfile:28`.
- **Change:** Pin `@anthropic-ai/claude-code`, `@google/gemini-cli`, `@openai/codex` to specific versions. Add a section to README documenting the upgrade procedure (test in M5 before bumping, regression-test the OAuth flow per CLI).
- **Acceptance:** `Dockerfile` shows pinned versions. README has an "Upgrading CLI versions" subsection. Image builds reproducibly.
- **Effort:** 1 hour for the pin; 1 hour for README.
- **Dependencies:** Verify each pinned version in M5 before merging.
- **Source:** Claude High #14.

#### D5. Pin esbuild as devDependency

- **Files:** `package.json`, `scripts/build-editor.js`.
- **Change:** Move esbuild from on-demand `npx` to a devDependency. `scripts/build-editor.js` calls `node_modules/.bin/esbuild` directly.
- **Acceptance:** `npm run build:editor` produces the bundle without network access.
- **Effort:** 30 minutes.
- **Dependencies:** None.
- **Source:** Claude §4.1.

#### D6. Centralized PTY registry + cleanup hook

- **Files:** `src/ws-terminal.js`, `src/server.js`.
- **Change:** Maintain a `Map<sessionId, ptyProcess>` registry. Register on PTY spawn, deregister on PTY exit/close. Add `process.on('exit')` and `process.on('SIGTERM')` hooks that iterate the registry and call `.kill()` on each PTY before the Node process exits, preventing orphaned tmux-attached PTY processes after a crash or restart.
- **Acceptance:** Live test — spawn 3 sessions; SIGTERM the Node process; assert no PTY processes remain in `ps -ef | grep "tmux attach"`. Live test — uncaught exception path: trigger a synthetic crash; verify same cleanup runs.
- **Effort:** 4 hours.
- **Dependencies:** None.
- **Source:** Gemini §10.2 (per Gemini's reviewer feedback).

#### D7. Logger batched persistence

- **Files:** `src/logger.js:43-66`.
- **Change:** Batch log persistence: buffer log lines in memory; flush via single multi-row INSERT every 250ms or 100 lines, whichever comes first. Or filter persistence to INFO+ (drop DEBUG from persistence). Or both. Pick whichever is simpler given the audit requirement (logs feed the in-app log viewer).
- **Acceptance:** Mock test — emit 1000 DEBUG log lines in a tight loop; assert SQLite INSERT count is ≤10 (batched) or ≤0 (filtered). Live test — log viewer in UI still shows the most recent N entries within 1s of being emitted.
- **Effort:** 4 hours.
- **Dependencies:** None.
- **Source:** Claude §2.15 (per §11.5 missing-actions list).

#### D8. KB watcher mutex split

- **Files:** `src/kb-watcher.js:44-47`.
- **Change:** Replace the single `busy` flag with two separate mutex flags (`pushBusy`, `pullBusy`). Periodic pull no longer drops on commit-in-progress; commit no longer drops on pull-in-progress; instead each waits on its own mutex. Prevents pull starvation under sustained commit chains.
- **Acceptance:** Mock test — simulate 10 rapid commits with a periodic pull scheduled mid-burst; assert the pull eventually runs (not dropped). Live test — make 5 KB changes in 10 seconds; verify periodic pull runs at next interval.
- **Effort:** 2 hours.
- **Dependencies:** None.
- **Source:** Claude §2.18 (per §11.5 missing-actions list).

#### D9. tmux-lifecycle scan optimization

- **Files:** `src/tmux-lifecycle.js:96-99`.
- **Change:** Eliminate the second-pass per-session `tmuxExists` check. Either treat the original list as authoritative (idle-killed sessions are filtered before the limit cap), or batch the check via a single `tmux ls` call and parse the output.
- **Acceptance:** Mock test — at MAX_TMUX_SESSIONS=50, assert scan completes in <500ms (current scales N exec calls). Live test — 50 active sessions, scan-cycle time stable.
- **Effort:** 2 hours.
- **Dependencies:** None.
- **Source:** Claude Low #53 (per §11.5 missing-actions list).

#### D10. /tmp resume tail file cleanup

- **Files:** `src/mcp-tools.js:319-343` (`session_resume_post_compact`).
- **Change:** Either rotate by writing to a single per-session file that overwrites (no timestamp suffix), or schedule a cleanup that deletes `/tmp/workbench-resume-*.txt` files older than 24 hours on every call.
- **Acceptance:** Live test — call `session_resume_post_compact` 100 times in a session; assert `/tmp/workbench-resume-*.txt` count stays bounded (≤1 if rotating, ≤24h-window if cleaning).
- **Effort:** 2 hours.
- **Dependencies:** None.
- **Source:** Claude Low #54 (per §11.5 missing-actions list).

### E. Performance reductions

#### E1. /api/state payload reduction

- **Files:** `src/routes.js:1135-1222`, `public/index.html:1325-1645` (`renderSidebar`).
- **Change:** Sidebar payload returns minimal fields per session: `{id, name, timestamp, cli_type, archived, state, project_missing}`. Token info, plan info, statusline state are NOT in this payload. A new endpoint `GET /api/sessions/:id/info` returns the heavy `getSessionInfo` payload, called only for the active session and visible sessions.
- **Acceptance:** Live test — `/api/state` p95 latency on M5 drops from current ~5-7s to under 1s for a workspace with 5 projects × 10 sessions. Browser test — sidebar renders correctly. Browser test — switching to a session triggers a `/api/sessions/:id/info` fetch and the status bar populates.
- **Effort:** 1 day.
- **Dependencies:** Easier after Action H1 (session-utils decomposition) if discovery caching is unified, but doable now.
- **Source:** Gemini §1.3 (alternative to push), Claude §9.

#### E2. session-utils unified discovery cache

- **Files:** `src/session-utils.js` (or its decomposed children after Action H1).
- **Change:** Single per-CLI cache for `discoverGeminiSessions` and `discoverCodexSessions`. TTL 10s. All callers (routes.js `_getNonClaudeMetadata`, session-utils internal helpers, qdrant-sync) share the same cache.
- **Acceptance:** Mock test — call `discoverGeminiSessions` from three different consumers within 5 seconds; verify the underlying disk read fires once. Live test — `/api/state` followed by status-bar token poll uses one disk read for Gemini discovery, not two.
- **Effort:** 4 hours.
- **Dependencies:** Best done with Action H1.
- **Source:** Claude §7.5.

#### E3. Optimistic-mutation poll-collision fix

- **Files:** `public/index.html` (or `public/js/state.js` after F0+F2), `public/js/api-client.js` after F0+F3.
- **Change:** Replace the time-based `PENDING_LOCK_MS = 7000` mutation lock with a request-based pause. While any optimistic mutation is in-flight, suppress `loadState` polling responses from overwriting state. Resume polling either on mutation completion or on explicit invalidation (e.g., archive completes → fetch latest state once → resume normal polling). Reuses the existing `_pending*` Maps as the in-flight signal rather than the timeout.
- **Acceptance:** Browser test — archive a session; while the request is in-flight, force a `loadState` response to arrive (mock or by triggering the poll); verify the optimistic UI does not flicker back to the unarchived state and back. Mock test — `_pending*.size > 0` causes `loadState` response to be deferred until pending clears (or until the pending mutation's promise rejects, in which case rollback occurs).
- **Effort:** 1 day.
- **Dependencies:** Easier after F0+F2+F3. Can be done before F0 with a smaller, in-place refactor of the existing `_pending*` mechanism. (Per Gemini §10.1: the v1 deferral of WebSocket push left this correctness gap unaddressed; this action closes it without requiring push.)
- **Source:** Gemini §1.3 + §10.1 reviewer feedback.

#### E4. Vector sync streaming for large files

- **Files:** `src/qdrant-sync.js` (`syncFileToCollection`).
- **Change:** Replace `fs.readFileSync` (and any future `fs.promises.readFile` of full files) with `fs.createReadStream` combined with `readline` interface. For chunked text strategies, accumulate `CHUNK_WINDOW` worth of content before emitting. For JSONL transcripts, the line-iterator shape is the natural fit. Eliminates the OOM risk on the 10MB ceiling Gemini flagged in §3.2.2.
- **Acceptance:** Mock test — feed a 9.9MB synthetic file; verify peak heap delta during embedding remains <50MB (current full-load can spike to ~30MB strings × 2-3 copies = ~90MB transient). Live test — embed an actual large session transcript on M5; observe Node heap via `process.memoryUsage()` before/after.
- **Effort:** 1 day.
- **Dependencies:** Folds into J1 (qdrant-sync factory-DI conversion) or after.
- **Source:** Gemini §3.2.2 + §10.2 reviewer feedback.

### F. Frontend modularization (parent + 14 children + 1 CSS extraction)

#### F0. Parent: Frontend monolith decomposition

- **Files:** `public/index.html` shrinks from 5,908 lines to a thin shell that loads ESM modules. New directory `public/js/`. New directory `public/css/`.
- **Change:** Extract the inline `<script>` block into 14 ES modules with explicit imports. Extract the inline `<style>` block into `public/css/main.css`. Use `<script type="module" src="js/app.js">` as the entrypoint. No build step required (browsers support ES modules natively); a future bundler can be added without forcing a refactor.
- **Acceptance:** All existing browser tests pass. The page loads. Full UI smoke including: tabs, terminal, file editor, file tree, settings, KB, git accounts, tasks, issue picker, OAuth modal, error banner, side panel.
- **Effort:** 3-4 weeks total at one engineer (per Claude §11.3: 14 children × 1.5 days each = 21 days = ~4 weeks; parallelizable across two engineers once F1/F2/F3 land). The original "1-2 weeks" estimate undercounted per-child UI test fix-time.
- **Dependencies:** **F2 (state.js) is a hard prerequisite** for F4-F14 (per Gemini §10.3: the heavy global state coupling means extracting state without first establishing F2 will break implicit initialization-order dependencies). F1+F2+F3 are the foundation that all other F-children depend on.
- **Canary:** F7 (oauth-detector.js) is the recommended first child to extract after F1+F2+F3 (per Claude §11.6 — F7 has zero deps on F4-F14 and is fixture-testable in isolation, proving the modular split works before larger components are extracted).
- **F8 caveat:** Gemini §10.1 notes F8 (file-tree.js) preserves the custom DOM-diffing logic that justified the framework-migration recommendation. Because we are deferring framework migration (§3.1), F8 must include extensive tests (the diffing logic stays brittle in isolation). Per Claude §11.1: any F-child that proves persistently brittle (likely F5 tabs, F6 terminal, or F8 file-tree) is a candidate for late-stage targeted port to lit-html or Preact at the *child* level, without committing the rest of the UI.
- **Source:** All three reviews. Codex §2, Gemini Phase 4 (without framework), Claude §3.3.

The 14 child modules:

| ID | Module | Approx. lines | Pulls from index.html | Notes |
|---|---|---|---|---|
| F1 | `js/util.js` | ~150 | escape helpers, `timeAgo`, `db_getSetting`, formatters | Foundation for F4-F14 |
| F2 | `js/state.js` | ~250 | `projectState`, `programState`, `tabs` Map, `expanded*` sets, pending-edits maps, optimistic-mutation lock | Foundation |
| F3 | `js/api-client.js` | ~200 | All `fetch('/api/...')` calls; centralized error handling, redact tokens in client logs | Foundation |
| F4 | `js/sidebar.js` | ~400 | `loadState`, `renderSidebar`, project/program/session row builders, hash-diff invalidation | Depends F1, F2, F3 |
| F5 | `js/tabs.js` | ~500 | `createTab`, `switchTab`, `closeTab`, `_makeTabEl`, `renderTabs`, drop-zone wiring, `moveTabToPanel` | Depends F1, F2 |
| F6 | `js/terminal.js` | ~600 | xterm setup, link handler, mouse-tracking blockers, `connectTab` WebSocket lifecycle, scrollback replay | Depends F2, F5 |
| F7 | `js/oauth-detector.js` | ~150 | `checkForAuthIssue` + URL/endMarker patterns | Standalone; fixtures-tested. Folds Action A14. |
| F8 | `js/file-tree.js` | ~400 | `createFileTree` and its DOM-diffing helpers | Depends F1 |
| F9 | `js/files.js` | ~450 | File editor tabs, `openFileTab`, `saveFileTab`, Save As modal | Depends F1, F2, F5, F8 |
| F10 | `js/tasks.js` | ~400 | Task tree render, task-detail modal, drag/drop, status lifecycle | Depends F1, F2, F3 |
| F11 | `js/issue-picker.js` | ~150 | GitHub issue picker modal | Depends F3, F10 |
| F12 | `js/settings.js` | ~600 | Settings modal, KB tab, vector tab, git-accounts tab | Depends F1, F3 |
| F13 | `js/auth.js` | ~250 | Auth modal, OAuth submit, banner | Depends F1, F3, F7 |
| F14 | `js/error-banner.js` | ~200 | `showErrorBanner`, `showAuthBanner`, error-log polling | Depends F1, F3 |

Each child PR's acceptance: the corresponding feature works end-to-end via real browser test (per `feedback_ui_tests_headless_only.md`). Mock tests are added where the module has pure logic (oauth-detector, util, file-tree).

### G. Routes.js decomposition (parent + 9 children)

#### G0. Parent: Routes decomposition

- **Files:** `src/routes.js` shrinks to a thin composition layer (~50 lines) that imports and wires nine domain modules. New directory `src/routes/`.
- **Change:** Each domain module exports `register(app, deps)`. Async conversion of sync FS in async paths happens within each domain PR (folded in, not a separate sweep).
- **Acceptance:** Full live + browser test suite green after each child PR.
- **Effort:** ~2 weeks total (per Claude §11.3: G1 alone is 1.5-2 days because `_seedRole` extraction is non-trivial). Each child 0.5-1 day except G1 (1.5-2 days).
- **Dependencies:** A2 + L1 should land before G1/G5 to avoid migrating fixes during decomposition (per Claude §11.4).
- **Source:** All three reviews.

The 9 child modules:

| ID | Module | Routes | Approx LOC |
|---|---|---|---|
| G1 | `routes/sessions.js` | `/api/sessions*`, `/api/terminals`, `/api/state`, `/api/search`, `/api/sessions/:id/{summary,tokens,session,restart,send_text,send_key,resume,name,config,archive}` + `_seedRole` extracted to `src/session-seeder.js` (folds old plan #31). **MUST also migrate `tmux new-session` from `execSync` to async pattern** (per Gemini §10.2 reviewer feedback — current `execSync` blocks the event loop during tmux spawn under heavy I/O load, disconnecting all WebSocket clients). **Effort: 1.5-2 days (per Claude §11.3).** | ~700 |
| G2 | `routes/projects.js` | `/api/projects*`, `/api/programs*`, `/api/projects/:name/{config,program,claude-md,remove}` | ~250 |
| G3 | `routes/files.js` | `/api/browse`, `/api/file*`, `/api/file-raw`, `/api/file-new`, `/api/rename`, `/api/move`, `/api/files/list`, `/api/mkdir`, `/api/upload` | ~250 |
| G4 | `routes/kb.js` | `/api/kb/*`. Folds the inline KB clone + sync poller from `src/server.js:379-424` into `src/kb-watcher.js` (Action M1). | ~200 |
| G5 | `routes/tasks.js` | `/api/tasks*`, `/api/tasks/:id/comments`, `buildProjectTaskTree`, `_projectHasRepoPath` (cached) | ~250 |
| G6 | `routes/git-accounts.js` | `/api/git-accounts*`, `/api/issues` | ~150 |
| G7 | `routes/settings.js` | `/api/settings`, `/api/cli-credentials`, `/api/mcp-servers`, `/api/qdrant/*` | ~250 |
| G8 | `routes/auth.js` | `/api/auth/*`, `/api/keepalive/*`, `/api/logs*` | ~150 |
| G9 | `routes/health.js` | `/health`, `/api/health` | ~30 |

### H. session-utils.js decomposition (parent + 5 children)

#### H0. Parent: session-utils decomposition

- **Files:** `src/session-utils.js` becomes a factory that composes five sub-modules. New directory `src/session-utils/`.
- **Change:** Conversion to factory-DI happens at the parent boundary: the module exports a `createSessionUtils({ db, safe, config, logger })` factory; sub-modules receive these as constructor params. Async conversion of sync FS happens per child.
- **Acceptance:** Live test suite green. Mock unit tests can substitute db/safe mocks now that DI is restored.
- **Effort:** **2 weeks total** (per Claude §11.3). H0 parent — 1.5 days **with a transitional re-export adapter** so existing `require('./session-utils')` call sites continue working during the migration. Each child 0.5-1 day. The adapter approach avoids simultaneous edits to ~6 consumer files and live-test-green-on-first-pass risk.
- **Dependencies:** Action E2 (unified discovery cache) folds in here. A10 (Gemini parser unification) should land **after** H2 (per Claude §11.4).
- **Source:** Claude §10.3, §10.2.

The 5 child modules:

| ID | Module | Pulls from |
|---|---|---|
| H1 | `session-utils/claude-jsonl.js` | `parseSessionFile`, Claude token usage, `getSessionSlug`, statusline state read |
| H2 | `session-utils/gemini.js` | Gemini discovery, transcript reading, token usage, JSON+JSONL parser (folds Action A10) |
| H3 | `session-utils/codex.js` | Same shape as gemini |
| H4 | `session-utils/info.js` | `getSessionInfo` aggregator + unified `_sessionInfoCache` (with projection helpers per Action E1) |
| H5 | `session-utils/search.js` | `searchSessions`, `summarizeSession` |

### I. watchers.js decomposition (parent + 5 children)

#### I0. Parent: watchers decomposition

- **Files:** `src/watchers.js` becomes a factory composing two `watchers/*` modules and three `cli-config/*` modules.
- **Change:** Two concerns separated: file watchers (jsonl, settings) under `src/watchers/`; CLI config seeding (per-CLI MCP registration, trust, provider config) under `src/cli-config/`. The CLI-config modules are reusable from places other than the watcher (currently only watchers use them, but that's accidental coupling).
- **Acceptance:** Live test — start a Claude session, verify JSONL watcher fires token-usage updates. Live test — restart container, verify all three CLI configs are seeded idempotently.
- **Effort:** 4 days total.
- **Source:** Claude §2.10.

The 5 child modules:

| ID | Module |
|---|---|
| I1 | `watchers/jsonl.js` |
| I2 | `watchers/settings.js` |
| I3 | `cli-config/claude.js` |
| I4 | `cli-config/gemini.js` |
| I5 | `cli-config/codex.js` |

### J. qdrant-sync factory-DI conversion

#### J1. qdrant-sync factory-DI conversion + streaming

- **Files:** `src/qdrant-sync.js`, `src/server.js` (wiring update).
- **Change:** Convert to `createQdrantSync({ db, safe, config, logger })`. Async-convert the sync FS uses in async paths (`_readCodexKey`, `existsSync` in scan, `readFileSync` in scan callbacks). **Replace `fs.readFileSync` for file content reads with `fs.createReadStream` per Action E4** — bare async conversion (`fs.promises.readFile`) still loads up to 10MB into V8 heap, leaving the OOM risk Gemini §3.2.2 flagged. Streaming + chunked emission is required.
- **Acceptance:** Mock test — start the module with mock deps, fire a settings change, verify `reapplyConfig` runs without touching disk. Mock test — see E4 acceptance (peak heap delta on 9.9MB file). Live test — vector sync continues to work end-to-end on M5.
- **Effort:** 3 days (factory-DI 2 days + streaming refactor 1 day).
- **Dependencies:** Folds Action E4 (vector sync streaming). Could fold the qdrant-sync decomposition (Codex §12 proposes 7 sub-modules) into this, but that's deferred to a follow-up — the factory-DI conversion + streaming is the immediate work.
- **Source:** Claude §10.2; Gemini §3.2.2 + §10.2 reviewer feedback.

### K. DB migration runner

#### K1. Numbered migration runner

- **Files:** New `src/db/migrations/`. `src/db.js:14-97`.
- **Change:** Replace 20+ try/catch ALTER blocks with a `schema_migrations` table (id INTEGER PRIMARY KEY, applied_at TEXT). Migrations live in `src/db/migrations/00N-name.js`, each exporting `up(db)`. On boot, run any not-yet-applied migrations in order.
- **Acceptance:** Mock test — fresh DB has no `schema_migrations` rows; boot applies all migrations; second boot applies none. Mock test — partially-applied DB (skip the latest migration) boots and applies only the missing ones. Live test — capture `sqlite3 .schema` output before the migration-runner change; boot M5 with the new code; capture `.schema` after; assert byte-identical (per Claude §11.2: "no changes" without byte-level proof allows silent drift). Live test — verify `schema_migrations` table is populated with inferred-already-applied IDs after first boot against the existing DB.
- **Effort:** 3 days (per Claude §11.3: writing the runner is 4-6 hrs, the risky part is the existing-DB seed inference — verifying each existing migration's idempotency case, capturing the schema, regression-testing).
- **Dependencies:** **Should land in Phase 1** (per Claude §11.6). No A action touches db.js *schema*; sliding K1 to Phase 1 has zero downside and unlocks future schema work (relational settings migrations per §3.3 cannot land without K1).
- **Source:** Claude §2.2 L14-97, §10.4.

### L. MCP catalog single source of truth

#### L1. Export TOOLS from mcp-tools.js

- **Files:** `src/mcp-tools.js`, `src/mcp-server.js:46-280`.
- **Change:** Define each tool's schema alongside its handler in `mcp-tools.js`. Export an array `TOOLS = [{ name, description, inputSchema, handler }]`. `mcp-server.js` imports the array and uses it for `tools/list`. Both registrations are now in one place.
- **Acceptance (primary):** Snapshot test — capture `tools/list` response BEFORE the change (full JSON), capture AFTER, assert `deep-equal`. Mock test — add a stub `handlers.test_canary = ...` to `mcp-tools.js` WITHOUT editing `mcp-server.js`; assert `tools/list` includes `test_canary`. **(Acceptance secondary):** Live test — Claude/Gemini/Codex agents can call all current tools by name. (Per Claude §11.2: original "agents can call all 51 tools" was a smoke test; deep-equal snapshot is the proof of fix.)
- **Effort:** 4 hours.
- **Dependencies:** Should land **before G1/G5** so A2's MCP-side fix lands in the unified handler module (per Claude §11.4).
- **Source:** Codex §10, Claude Med #32.

### M. KB lifecycle migration to kb-watcher

#### M1. Move KB clone + sync poller from server.js startup

- **Files:** `src/server.js:377-424`, `src/kb-watcher.js`.
- **Change:** `kb-watcher.js` exports a single `start(deps)` function that handles: clone-if-missing, upstream-remote setup, periodic pull, identity setup, file watcher, push debouncer. `server.js` startup does one call.
- **Acceptance:** Mock test — kb-watcher can be started with a fake `/data/knowledge-base` path; verify clone happens once, then watcher attaches, then pull schedule is set. Live test — restart M5 with KB present and KB absent; both paths work as before.
- **Effort:** 1 day.
- **Dependencies:** Folds with Action G4 (`routes/kb.js` extraction).
- **Source:** Claude §2.1 L255-434, §10.6.

### N. Tooling and standards

#### N1a. ESLint rules + Prettier (warnings tier)

- **Files:** `eslint.config.js`, `package.json`.
- **Change:** Add ESLint rules `no-unsafe-optional-chaining`, `no-unused-expressions`, `eqeqeq`, `prefer-const`, `no-var` configured as **warnings** (not errors). Add `package.json` script `"lint:format": "prettier --check ."`. Add `package.json` script `"lint:all": "npm run lint && npm run lint:format"`.
- **Acceptance:** `npm run lint:all` runs and surfaces all violations as warnings without blocking CI. Number of warnings recorded as the baseline for N1b.
- **Effort:** 4 hours.
- **Dependencies:** None.
- **Source:** Claude High #13, §1.6 + §11.3 reviewer feedback (split into warnings tier + errors tier).

#### N1b. ESLint rules — escalate to errors after cleanup

- **Files:** `eslint.config.js`, plus per-file fixes for surfaced violations.
- **Change:** After C5 (inline-require hoist) and after a Prettier sweep across the codebase, fix all warnings surfaced by N1a then escalate the rules from `warn` to `error` in `eslint.config.js`. CI now blocks on these rules.
- **Acceptance:** `npm run lint` exits 0 against the current codebase. CI blocks PRs that introduce regressions.
- **Effort:** 1-2 days (depends on warning count from N1a baseline; likely tens-to-hundreds of `==`/`var`/`let-where-const` violations to fix).
- **Dependencies:** **Blocked by N1a** (need warning baseline). **Blocked by C5** (per Claude §11.4: enforcing `eqeqeq`/`prefer-const` while inline `require()` calls exist surfaces lint-rule additions as collateral on existing inline-require breakage).
- **Source:** Claude §11.3 reviewer feedback.

#### N2. ESLint stops ignoring public/**

- **Files:** `eslint.config.js:97`.
- **Change:** Remove `public/**` from `ignores`. Configure browser globals + `script.type=module` for the new `public/js/*.js` files.
- **Acceptance:** `npm run lint` passes against `public/js/`. CI catches `no-unused-vars` and `no-undef` violations in frontend code.
- **Effort:** 2 hours.
- **Dependencies:** Blocked by Action F0 progress — needs at least F1, F2, F3 (foundation modules) extracted to be useful. File the action now, mark blocked-by F0.
- **Source:** Claude Low #52.

#### N3. Match c8 thresholds to test plan

- **Files:** `package.json:9`. Optionally `tests/workbench-test-plan-backend.md`.
- **Change:** Either raise c8 thresholds to `--lines 85 --branches 85` to match the documented mock ≥85% gate, OR amend the test plan to state the actual gate. Pick one and align.
- **Acceptance:** `npm run test:coverage` blocks at the same threshold the test plan documents. STD-003 §2.6 satisfied.
- **Effort:** 1 hour for config + however long it takes to actually reach 85/85 if currently below (coverage-gap closure is out of scope here).
- **Dependencies:** **Blocked by coverage gap audit (out of scope here, must be filed separately if a gap exists).** Per Claude §11.4: without the explicit blocker annotation, N3 looks like a 1-hour config change. It is only 1 hour if current coverage already meets 85/85.
- **Source:** Claude High #11.

#### N4. ESLint test-globals override

- **Files:** `eslint.config.js`.
- **Change:** Add globals declaration for `tests/browser/**/*.spec.js`: `page`, `browser`, `openFileTab`, `switchPanel`, `setTaskFilter`, etc. Run lint and confirm the 49 errors disappear.
- **Acceptance:** `npm run lint` passes against `tests/browser/`. The previously-failing 49 lint errors are gone.
- **Effort:** 1 hour.
- **Dependencies:** None.
- **Source:** Gemini §4.2.2.

### O. Test reconciliation

#### O1. Mock test failures fix

- **Files:** Mock fixtures, `tests/mock/routes.test.js`, `tests/mock/mcp-tools.test.js`, `package.json` devDependencies.
- **Change:** (a) Add `chokidar` to devDependencies. (b) Add `getAllPrograms: () => []` (or a configurable mock) to the mock db fixture in `tests/fixtures/test-data.js`. (c) Replace hardcoded `expect(tools.length).toBe(44)` with `expect(tools.length).toBe(Object.keys(handlers).length)` derived from the source-of-truth handlers map (or a snapshot test that fails when the count changes, prompting a deliberate update).
- **Acceptance:** `npm run test` shows 0 failures. The MCP count assertion stays valid as tools are added or removed.
- **Effort:** 3 hours.
- **Dependencies:** None.
- **Source:** Gemini §4.2.1.

#### O2. Browser spec rewrites for task v2 selectors

- **Files:** `tests/browser/task-tree.spec.js`, `tests/browser/multi-cli-and-editors.spec.js`.
- **Change:** Replace `.task-node` with `.task-row`, `expandedTaskFolders` with `expandedTaskProjects`, `#add-task-input` with the v2 add-task affordance, `todo` filter with `inactive`/`open` filter.
- **Acceptance:** Browser test suite passes against current production UI on M5.
- **Effort:** 1 day.
- **Dependencies:** None.
- **Source:** Codex §7.

#### O3. Live test rewrites for task v2 API shape

- **Files:** `tests/live/routes-tasks.test.js`, `tests/mock/db.test.js` (positional `db.addTask` → object form), `tests/browser/multi-cli-and-editors.spec.js:263-272` (MCP `task_add` argument shape).
- **Change:** Posts include `{project_id, title, ...}` instead of `{folder_path, title}`. `db.addTask({project_id, title, ...})` instead of `db.addTask('/workspace/proj', ...)`.
- **Acceptance:** Mock + live test suites green.
- **Effort:** 1 day.
- **Dependencies:** None.
- **Source:** Codex §7.

#### O4. Test plan + traceability matrix update

- **Files:** `tests/workbench-test-plan-ui.md`, `tests/workbench-test-plan-backend.md`, `tests/traceability-matrix.md`.
- **Change:** Replace task v1 (folder-path) language and selectors with v2 (project + parent_task_id + status enum + archived). Update the traceability matrix coverage row for task domain.
- **Acceptance:** STD-003 standards check passes. Plan and runbook describe the same UI the user sees.
- **Effort:** 1 day.
- **Dependencies:** Best after O2 + O3 land so the doc reflects the final test code.
- **Source:** Codex §7.

### P. README rewrite

#### P1. README reconciliation

- **Files:** `README.md`.
- **Change:** Specific updates:
  - Architecture section: route count `40+` → `72`. Add `kb-watcher.js` and `git-auth.js` to module list. Remove `voice.js` reference (Action B1 deletes it).
  - Configuration section: drop `TMUX_CLEANUP_MINUTES`, `bridge.cleanupSentMs`, `bridge.cleanupUnsentMs`. Add the keys externalized in Action C2.
  - MCP tools section: drop `workbench_read_plan`, `workbench_update_plan` (deleted in v7.0).
  - Deployment guide pointer: fix path from `config/docs/sdlc/guides/workbench-deployment.md` to `Admin/docs/guides/workbench-deployment.md`. Document the Admin repo dependency.
  - Drop `Issue_Log.md` reference (file does not exist).
  - Drop `WPR-104` and `ERQ-001` references; replace with the actual REQ/STD/PROC IDs.
  - Add a "Container privileges" line documenting passwordless sudo (Dockerfile L43) — single-user transparency, not a security finding.
  - Add an "Upgrading CLI versions" subsection (paired with Action D4).
- **Acceptance:** README accurately describes the current code. No claims that grep cannot verify against the source. STD-007 satisfied.
- **Effort:** 4 hours.
- **Dependencies:** Best after Actions B1, C2, D4. Other items can be done concurrently.
- **Source:** Claude §6.1.

## 6. Sequencing (revised per reviewer feedback)

The plan is phased by dependency, not by time. Within a phase, actions are parallelizable. Per Codex's reviewer feedback ("the plan should not try to fix every category of debt in parallel"), this revision tightens the ordering so structural changes follow correctness fixes follow stabilization.

**Phase 0 — Stabilize the model** (per Codex addendum Phase 0):
- B1, B2, B3, B4 (delete dead code so refactors aren't measured against stale expectations)
- O1 (fix mock test failures so CI is green; can't refactor monoliths against a red pipeline)
- N4 (test globals — clears 49 lint errors)
- C1 (.dockerignore for assets — local docker builds work)
- C7 (gitignore artifacts + missing fixtures)
- P1 stub: confirm voice-removed in README; defer full README rewrite to Phase 5

**Phase 1 — Concrete correctness fixes + foundations** (parallelizable):
- All A1-A18 actions (correctness fixes — narrow, reviewable, prove independently)
- C2 (externalize orphan config keys — Phase 1 per Claude §11.4 so subsequent actions read defaults.json)
- C3, C4, C6, C8 (hygiene sweeps; C5 inline-require lands here too)
- D1-D10 (operational hygiene including new D6-D10 from reviewer feedback)
- L1 (MCP catalog SSoT — must precede G1/G5 per Claude §11.4)
- **K1 (DB migration runner — moved from old Phase 2 per Claude §11.6).** Unblocks future schema work and §3.3 deferred relational migrations.
- N1a (ESLint warnings tier)
- F7 (oauth-detector.js extraction as F0 canary — proves the modular split shape per Claude §11.6)

**Phase 2 — Structural refactors, foundation modules** (parallelizable across module families):
- F0 + F1, F2, F3 (frontend foundation: util, state, api-client). **F2 is hard prerequisite for F4-F14 per Gemini §10.3.**
- G0 + G1, G2, G5 (routes: sessions including async tmux + _seedRole extraction; projects; tasks). **A2 + L1 must have landed before G1/G5.**
- H0 + H1 (session-utils Claude branch with transitional adapter)
- M1 (KB lifecycle migration)
- J1 (qdrant-sync factory-DI + streaming)
- E3 (optimistic-poll correctness — closes the §3.2 deferral correctness gap per Gemini §10.1)

**Phase 3 — Structural completion**:
- F4-F6, F8-F14 (frontend remaining modules)
- G3, G4, G6-G9 (routes remaining domains)
- H2-H5 (session-utils Gemini, Codex, info, search modules)
- I0 + I1-I5 (watchers decomposition)
- A10 (Gemini parser unification — must wait for H2 per Claude §11.4)
- A18 (switchTab layout thrashing — easier after F0+F5)

**Phase 4 — Performance + final tooling**:
- E1, E2 (performance reductions)
- E4 — folded into J1 (vector sync streaming)
- N1b (ESLint errors tier — blocked by C5 + N1a baseline)
- N2 (lint public/** — unblocked once F0+F1+F2+F3 land)
- N3 (c8 threshold alignment — blocked by separate coverage-gap audit)
- O2, O3, O4 (test reconciliation — easier once F0/G0 land)
- D5 (esbuild devDep)

**Phase 5 — Documentation**:
- P1 (README rewrite — last so the document reflects everything)

**Critical sequencing dependencies (per Claude §11.4 / §11.6):**
- A2 → before G1 + G5
- L1 → before G1 + G5
- C2 → Phase 1 (early)
- K1 → Phase 1 (sliding earlier than v1)
- N1a → before N1b
- C5 → before N1b
- N3 → blocked by coverage audit
- A10 → after H2
- F7 → Phase 1 canary, before F4-F14
- F2 → hard prerequisite for F4-F14
- §3.3 relational migrations → blocked by K1

## 7. Tracking

Once approved, this plan converts to GitHub issues with the following structure:

- 1 parent issue per Action with multiple parts (F0, G0, H0, I0).
- 1 issue per child module (F1-F14, G1-G9, H1-H5, I1-I5).
- 1 issue per single-action item (A1-A16, B1-B4, C1-C5, D1-D5, E1-E2, J1, K1, L1, M1, N1-N4, O1-O4, P1).

Total parent-only: ~34 issues. Total including children: ~62 issues.

Each issue body cites the action ID in this plan, the source review section, and the acceptance criteria as a checklist.

## 8. Out of Scope for This Plan

- **New features.** Plan is remediation-only.
- **Production cutover changes.** This plan deploys to M5/dev only per the standing rule. A separate plan would be needed for any prod rollout.
- **Test code coverage closure.** N3 may surface a gap if current coverage is below 85/85; closing the gap (writing new tests) is its own scope.
- **Bug investigations not raised by the three reviews.** If new bugs surface during execution, they get filed separately and may or may not be added to this plan.

## 9. Critique Targets

Reviewers should specifically attack:

- **Skip set decisions.** Are §3.1, §3.2, §3.3 correctly deferred?
- **Action shape.** Is any action under-scoped (won't actually solve the underlying issue)? Over-scoped (does more than necessary)?
- **Acceptance criteria.** Are any of them weak? Could a "passing" PR still leave the bug unfixed?
- **Effort estimates.** Are any wildly off?
- **Dependencies.** Are any blocked-by relationships missing? Are any false dependencies asserted?
- **Sequencing.** Is the phase order sensible, or does it create inevitable rework?
- **Missing actions.** Did all three reviews' findings get covered? Are any silently dropped?
- **Audit trail.** Does each action cite a specific source (review section + page)?

End of plan.

## 10. Gemini Reviewer Feedback

**Critique Date:** 2026-05-08
**Reviewer:** Gemini

Overall, the Corrective Action Plan is exceptionally well-structured, pragmatic, and accurately synthesizes the highest-priority items from all three reviews. However, there are a few critical omissions and scoping issues that need to be addressed before execution.

### 10.1 Critique of Skip Set Decisions (§3)
*   **§3.1 Frontend framework migration deferred:** Agree. The proposed F0 (ES module extraction) is a massive step forward. However, because we are deferring a framework, the custom DOM-diffing logic in `createFileTree` will remain. We must ensure F8 (`js/file-tree.js`) includes extensive tests, as this brittle logic will now be isolated but still fundamentally complex.
*   **§3.2 Replace `/api/state` polling deferred:** Disagree with the reasoning. Action E1 reduces the *latency* of the poll, but it does not fix the *correctness* issue identified in the Gemini review (Part 1.3). Because the frontend relies on polling, optimistic UI updates (like archiving a session) will still collide with incoming polling responses, causing UI jitter and state rollbacks. If WebSockets are deferred, a specific action must be added to implement a robust query-invalidation pattern (e.g., pausing the poll while optimistic mutations are pending).

### 10.2 Missing Actions & Under-Scoped Items
*   **Missing OOM Fix for Vector Sync:** Action J1 mandates converting `readFileSync` to async in `qdrant-sync.js`. However, simply changing `fs.readFileSync` to `fs.promises.readFile` still loads the entire file (up to 10MB) into the V8 heap at once before chunking. To prevent memory exhaustion, an explicit action must be added to rewrite `syncFileToCollection` to use `fs.createReadStream` and process chunks iteratively.
*   **Under-scoped `execSync` removal:** Action A5 fixes the `execSync` in `file_find`, but there is no explicit action targeting the `execSync` used in `routes.js` to spawn `tmux` sessions (`tmux new-session`). If this blocks, it starves the event loop. Action G1 (session routes decomposition) must explicitly mandate migrating this `tmux` spawn to an asynchronous pattern.
*   **Process Leak Management:** None of the actions address the potential for orphaned `tmux attach-session` PTY processes if the Node.js server crashes (identified in Gemini review Part 4.4). An action should be added to implement a centralized PTY registry and a `process.on('exit')` cleanup hook in `ws-terminal.js`.

### 10.3 Critique of Sequencing (§6)
*   **Phase 1 is solid:** Prioritizing test suite repairs (O1, N4, A1-A16) is exactly right. We cannot refactor the monoliths if the CI pipeline is red.
*   **Dependency Warning on F0 (Frontend):** F0 attempts to extract 14 modules. Given the heavy global state coupling, extracting F2 (`state.js`) will likely break components that rely on implicit initialization orders. F2 should be treated as a Phase 1 prerequisite for all other F-series actions.

**Conclusion:** Add three new actions (Optimistic UI Sync Fix, Vector Stream Refactor, PTY Cleanup Hook) and amend G1 to explicitly remove the `tmux` `execSync`.

---

## 11. Claude Reviewer Feedback

**Reviewer:** Claude Sonnet 4.6 (one of the three source reviews; reviewing the synthesis here).
**Date:** 2026-05-08.
**Method:** Read the plan in full, cross-checked against `CODEX_CODE_REVIEW.md`, `GEMINI_CODE_REVIEW.md`, and my own `CLAUDE_CODE_REVIEW.md` (in `/data/workspace/repos/agentic-workbench/review/`). Treat the trust model from Claude §0 as authoritative — that's already reflected in the plan's framing (no "security phase").

The plan is solid overall. Critique below targets the items §9 explicitly invites.

### 10.1 Skip-set decisions (§3)

- **§3.1 (frontend framework migration) — agree.** F0+children captures ~80% of the maintainability win at a fraction of the cost. Concrete escape hatch: any of F4-F14 that proves persistently brittle in production (likely F5 tabs, F6 terminal) could be ported to lit-html or Preact at the *child* level after F0 lands, without committing the rest of the UI.
- **§3.2 (WebSocket push) — agree.** E1 is the right first step. One nit: the plan says E1 yields "~80% of the latency improvement"; my review of the `/api/state` hot path (Claude §9) suggested most of the cost is the per-session `getSessionInfo` walk, not the round-trip. E2 (unified discovery cache) probably contributes more than the payload trim. Worth noting that E1 alone may not get to <1s; E1+E2 together is the realistic target.
- **§3.3 (JSON-stringified settings → relational) — qualified agree.** The lost-update concern is theoretical for `git_accounts` under the single-user trust model. But two of the JSON-stringified settings have higher contention risk than `git_accounts`:
  - **`webhooks` table** (`webhooks.js:8-20`): the CRUD endpoints are fire-and-forget, no client-side serialization, and rapid sequential PUT/DELETE/POST can race even single-user (a user clicking "delete webhook" while a webhook fire is iterating the array).
  - **`vector_collection_*` settings**: the qdrant `reapplyConfig` reads + the user's settings save can interleave on rapid provider changes.
  Recommend the plan note these as the next-easiest relational migrations once K1 (migration runner) lands. K1 strictly enables §3.3 — note that dependency in the deferral.

### 10.2 Acceptance criteria that don't actually verify the fix

These should be tightened before issues are filed. The plan's own §4 says "tests verify actual results, `{ok:true}` is necessary but not sufficient" — but several acceptance criteria fall into that pattern.

- **A1 path-encoding.** "Create a project named `foo.bar+baz`" — but the bug is in the *path* encoder (`safe.findSessionsDir(projectPath)`), not the *name* encoder. The route at `routes.js:2165` operates on `safe.resolveProjectPath(project)` which produces a path. Fix the test: use a project whose **path** contains `.`, `~`, or `+` (e.g., create the project pointing at `/data/workspace/foo.bar/sub_dir+with-stuff`). A name-only test may not exercise the encoder at all.
- **A5 file_find — pattern test is a false-positive.** The acceptance "call with `pattern: \"$(echo HACK)\"` and verify the literal string is searched" — but `args.pattern` is **already** shell-escaped at `mcp-tools.js:166` via `safe.shellEscape(args.pattern)`. The current code already passes that test. The actual fix is for `file_type` and `context_lines`. Drop the `pattern` test, or move it to a "regression — already escaped" coverage entry. Keep the `file_type: "js;rm -rf /"` test, that one is the real one.
- **A8 /api/auth/login — token-burning verification is fragile.** "Check the Claude usage logs before/after" requires access to anthropic.com billing. Replace with: stub `safe.claudeExecAsync` in the mock test and assert it is never invoked. Live test asserts <100ms response (the original problem was the slow Claude round-trip).
- **A14 OAuth detector — fixture cost is buried.** "Feed each fixture transcript byte-by-byte" implies the fixtures already exist. They don't — capturing each CLI's current OAuth output is a separate effort (instrument an actual `/login` flow per CLI; redact the URL; commit). That's another 2-3 hours per CLI before the test scaffolding starts. The 4-hour estimate covers the extraction but not the fixture capture.
- **B1 voice deletion — grep scope incomplete.** Acceptance grep covers `src/`. Codex §8 also lists `tests/workbench-test-runbook.md:3721` and "tests/mock/server.test.js references voice.js". Expand the acceptance to `grep -r "voice" src/ tests/ public/ config/` returns zero hits, OR explicitly list the surviving allowed references (the test plan removal note is fine to keep as historical context).
- **C5 inline-require hoist — grep is fragile.** The acceptance regex tries to detect in-body requires by line-prefix matching `const`. Misses `let r = require(...)`, `var r = require(...)`, conditional requires, and nested-function requires. Better: parse `src/*.js` with `acorn` or `@babel/parser` and walk the AST, asserting all `CallExpression(callee=Identifier "require")` nodes have a `Program`-level ancestor `VariableDeclaration` (i.e., top-level). 30 lines of acorn code; 100% reliable. Or: drop the grep test and rely on a code-review checklist.
- **D2 rate limit — no reset verification.** Acceptance fires 15 in 5s and asserts 5 are 429. But doesn't verify the bucket resets — a broken implementation that leaves the IP banned forever would still pass. Add: "wait 60s, fire 1 more wrong-password request, verify it returns 401 (not 429) — bucket reset works."
- **K1 migration runner — "no changes" is unverified.** "Live test — current production DB on M5 boots without changes" — but the test doesn't define what "no changes" means in observable terms. Better: snapshot the schema with `sqlite3 .schema` before and after; assert byte-identical. Verify that `schema_migrations` is populated with the inferred-already-applied migration IDs (you have to seed it on first run for an existing DB; that's the risky part of this migration).
- **L1 MCP catalog SSoT — "agents can call all 51 tools" is too loose.** "Live test — Claude/Gemini/Codex agents can call all 51 tools by name" reads like a smoke test. Better: snapshot the `tools/list` response shape before the change, snapshot after, assert deep-equal. The point of L1 is that adding a tool doesn't require touching mcp-server.js; assert that explicitly with a "regression — adding a stub tool" test (same as the bullet already says, but frame the snapshot as the primary acceptance, not the secondary).

### 10.3 Effort estimates that look wrong

These are "wildly off" candidates per §9.

- **G1 (`routes/sessions.js` + `_seedRole` extraction) at 0.5-1 day — too tight.** `_seedRole` is 157 lines of three-CLI orchestration with inline `require()` for six modules. Extracting to `src/session-seeder.js` with per-CLI strategies (the plan's stated shape) is half a day by itself. The route-level integration plus the test pass for each CLI's seed flow is the rest. **Realistic: 1.5-2 days.**
- **H0 + H1 at "1 week total, each child 0.5-1 day" — too tight at the parent boundary.** The factory-DI conversion at the parent affects every consumer of `session-utils` (routes.js several, mcp-tools.js, watchers.js, qdrant-sync.js, server.js). Coordinated rename without a transitional adapter would mean simultaneous edits to ~6 files and live test green-on-first-pass. **Realistic: 1.5 days for H0 (with a transitional re-export adapter), then 0.5-1 day per child.** Total 2 weeks.
- **K1 migration runner at 2 days — too tight given the existing-DB seed problem.** Writing the runner is 4-6 hours. The risky part is "first boot against an existing M5 DB infers the already-applied migration set without re-applying any of them." That requires thinking about each existing migration's idempotency case (most are already idempotent — `ALTER TABLE … DEFAULT 'x'` on an existing column is harmless — but worth verifying per migration). **Realistic: 3 days including the existing-DB regression test.**
- **N1 ESLint rules + Prettier at 4 hours — much too tight.** Adding `eqeqeq`, `prefer-const`, `no-var` rules to a codebase that's never enforced them will surface dozens-to-hundreds of violations. Either:
  - **(option A)** Run Prettier across the codebase first (mass auto-format diff is its own ~1 day of review), then add the rules. **Realistic: 2 days for the full sweep + lint rule addition.**
  - **(option B)** Add the rules as warnings (not errors) initially, plan a second action to escalate to errors after a cleanup sweep. The plan's effort estimate fits option B but the action body says "passes on the current codebase" implying option A. Pick one explicitly.
- **A11 project remove cascade at 3 hours — possibly too tight.** Killing tmux sessions is straightforward (1 hr); deleting JSONL files cleanly without breaking session-resolver invariants needs care (1 hr); unregistering project-scoped MCP without leaving stale `.mcp.json` references in claude/gemini/codex configs is the unbounded part (1-2 hrs depending on how many config files reference the project's MCP entries). **Realistic: 4-5 hours.**
- **F0 "1-2 weeks total" — generous parent, tight children.** Each F-child has a UI feature that needs full browser-test pass per `feedback_ui_tests_headless_only.md`. Per-child: 0.5 day extraction + 0.5 day test pass + 0.5 day fix-the-regressions-found = 1.5 days. 14 children × 1.5 = 21 days = ~4 weeks at one engineer. **Realistic: 3-4 weeks for F0+all children, parallelizable across two engineers if the foundation modules (F1-F3) land first.**

### 10.4 Dependencies the plan doesn't track

- **A2 (task reparent atomicity) ↔ G1 (sessions extraction) and L1 (MCP SSoT).** A2's change touches both `routes.js:1718-1723` and `mcp-tools.js:722-732`. If A2 lands before G1, both call sites move to a shared `db.moveTask`. If G1 lands first, A2 has to apply its fix in two locations (one in the new `routes/sessions.js`, one still in `mcp-tools.js`). Cleanest: A2 → L1 → G1 (so the MCP catalog has the fixed handler before the routes split), or A2 + L1 in parallel before G1. **Add explicit `before G1` annotation on A2 and L1.**
- **N1 (ESLint rules) → C5 (inline-require hoist).** Adding `eqeqeq`/`prefer-const` rules without first running C5 risks lint failures masquerading as broken-by-rule-add. C5 should land before N1's hard-error tier. Or N1 splits into N1a (rules as warnings, no break) and N1b (escalate after cleanup).
- **N3 (c8 thresholds) → coverage-gap-closure precursor.** The plan acknowledges this in N3's body ("if 85/85 is not currently met, the threshold change must be paired with coverage-gap closures (separate scope)"). Make this an explicit dependency: "Blocked by — coverage audit (out of scope here, must be filed separately if gap exists)."
- **C2 (externalize orphan config keys) ↔ A1-A16 actions that read those keys.** If A8 (auth login fix) lands and then C2 changes the default for `keepalive.queryTimeoutMs`, A8's behavior changes silently. Low risk but worth flagging: C2 should land Phase 1 (it's a pure config-file-additions change) so subsequent actions read from defaults.json, not code-side fallbacks.
- **A10 (Gemini parser unification) on H1.** The plan says "can be done before or after H1." If before, the shared parser lands in qdrant-sync OR session-utils, then H1 has to re-extract. If after, the shared parser lands in `session-utils/gemini.js` directly. **Recommend: A10 *after* H1.**

### 10.5 Findings silently dropped from the plan

These are issues from at least one of the three source reviews that don't appear as actions or in §3 (Deferred Set). Each should be either added as an action or added to §3 with reasoning.

**From Claude review:**
- `logger.js:43-66` — per-line SQLite INSERT, no batching. Under DEBUG-level qdrant retry storms or settings hot-reload, this is measurable disk write IOPS. Either add as action E3 or defer with reasoning ("DEBUG isn't on by default; not surfacing under normal load").
- `kb-watcher.js:44-47` — single `busy` mutex for both commit-and-push and periodic pull. Pull starvation under sustained commit chains. Add as small operational action or defer.
- `tmux-lifecycle.js:96-99` — per-session `tmuxExists` second pass adds N exec calls per scan. Negligible at MAX_TMUX_SESSIONS=10, measurable at MAX_TMUX_SESSIONS=50 (the test:live env). Add as a short hygiene action.
- `mcp-tools.js:319-343` — `session_resume_post_compact` writes `/tmp/workbench-resume-*.txt` with no cleanup. Long-running containers accumulate. Add as small action.
- `tests/coverage-results-*.txt`, `tests/runbook-results-*.md` — committed transient artifacts (the runbook results are 100KB+ each, three of them). Either add to `.gitignore` or move to a results subdirectory. One-line action.
- `tests/fixtures/` — 5 of 8 documented fixtures missing per the test plan. Either the plan is aspirational or the fixtures are missing. Add as a test reconciliation action or update the plan.
- `public/gate.html:188` hardcoded duplicate-Space ID; `server.js:29` PORT default 3000; `db.js:257` misleading catch comment. Trivial; group into one "trivial cleanup" action or skip explicitly.

**From Codex review:**
- §16 — Codex listed specific tunables that C2 doesn't capture: `routes.js:344` `NONCLAUD_CACHE_TTL`, `routes.js:382-387` 60s session matching window, `mcp-tools.js:169` grep timeout/maxBuffer (16MB), `qdrant-sync.js:58` ignore-pattern defaults. The plan's C2 captures qdrant.url/debounce/chunk* but misses these four. **Add to C2.**
- §18 — `safe-exec.js` `grepSearchAsync` (L345-364) and `curlFetchAsync` (L367-383). Codex flagged these as unused legacy helpers retained for tests. Worth a grep-and-decide action: if no product call site, delete or move to test-fixtures.
- §19 — task validation split between routes/db (cross-domain rules in routes.js, invariants in db.js). Codex recommended a `task-service.js` boundary. The plan does not include this; effectively deferred. Worth one line in §3 explicitly: "task-service extraction is deferred; A2 atomicity fix is the minimum-viable correctness in lieu."
- §20 — session parsing/discovery in five places. H1-H3 unifies session-utils internally and A10 unifies the Gemini parser, but `session-resolver.js` still has its own discovery logic. Either H2/H3 absorb session-resolver's discovery, or note the deferral.

**From Gemini review:**
- §1.4 — Layout thrashing in `switchTab` (the 300ms `setTimeout` hack double-fitting xterm). Gemini's recommended fix (absolute positioning for inactive panes) is concrete and small. Real perf issue on tab switch. **Add as small frontend action.**
- §1.5 — Gemini's recommendation for OAuth was "move parsing to a Node.js worker thread" (backend). The plan's A14 extracts to a frontend module but stays on the main thread. The plan should explicitly state the worker-thread move is deferred (and why — frontend extraction first to make the regex tractable, worker-thread later if main-thread blocking is observed in production).
- §3.3 — Polling race in `session-resolver` (mtime-based heuristic that can bind two parallel sessions to the wrong JSONL). Gemini's recommended fix: inject `WORKBENCH_SESSION_ID` env var into the CLI launch and have CLIs echo it. The CLI side is upstream-blocked, but the env var injection is workbench-side. Worth a small action that injects the env var even if the CLIs don't yet consume it (forward-compat) — at minimum it's a marker in the spawn for grep-based identification.

### 10.6 Sequencing concerns

- **Phase 1 includes A2, but A2's correctness fix touches both routes.js and mcp-tools.js.** If A2 lands week 1 and G1 starts week 2, A2's route-side change has to migrate into `routes/sessions.js` without disturbing the fix. Easy mechanical move, but worth flagging as a soft sequencing dependency. Same for L1 (MCP catalog SSoT) — landing L1 in Phase 1 means A2's mcp-tools.js change touches the (now-unified) handler module instead of two locations.
- **K1 in Phase 2 is correct but earlier is better.** No A action touches db.js *schema* (the A actions touch db.js *queries*), so K1 doesn't strictly block any A. But once K1 lands, every future schema change becomes a numbered migration, and the existing 20+ try/catch ALTERs become legacy. Sliding K1 into Phase 1 has zero downside and unlocks future work.
- **N3 (c8 thresholds) in Phase 4 is right but the plan should make the dependency explicit.** "Blocked by: coverage gap audit, separate scope" — without that annotation, N3 looks like a 1-hour config change.
- **F0 children sequencing within Phase 2/3.** The plan correctly identifies F1, F2, F3 as foundation. Within F4-F14, F7 (oauth-detector) is the easiest standalone (zero deps on F4-F14) and could land alongside F1-F3 as a canary that proves the modular split works. Worth noting F7 as Phase 2 even though its dependencies are F1+F2+F3.

### 10.7 Audit trail

- **A2 source citation says "Codex #5; Claude §2.3 L1718-1723".** My review at §2.3 (`routes.js`) flags the PUT handler as 124 lines doing 8 things, but the *atomicity* bug (rank applied before reparent, reparent always appends) is uniquely Codex's catch. Claude's §2.3 mentions L1718-1723 only in passing about handler size. **Suggest:** trim the citation to "Codex Finding #5" and drop the Claude reference.
- **A14 citation: "Gemini §1.5; Claude does not address parsing fragility directly."** Accurate. Good.
- **L1 citation: "Codex §10, Claude Med #32."** Match ✓.
- **General:** the plan cites my review by section ID and by the prioritized-list issue number (e.g., "Claude High #6"). Both work. The format is consistent.

### 10.8 Overall assessment

The plan is the right shape. It correctly:
- Treats the trust model as the security framing (no security phase, security items reclassified as code quality).
- Defers the two highest-cost recommendations (framework migration, push architecture) with concrete cheaper alternatives that capture most of the value.
- Decomposes the two biggest files (routes.js, public/index.html) into parents with named children rather than treating them as monolithic refactors.
- Sequences DB migration runner before structural changes so future schema work is cheaper.
- Pairs documentation rewrite (P1) at the end so the README reflects the post-refactor reality.

What needs tightening before issues are filed:
- **Acceptance criteria** — about a third of them either don't actually verify the fix (A1, A5 pattern test, A8) or are too loose to gate a PR (B1 grep scope, C5 grep, K1 "no changes," L1 "agents can call all tools"). Section 10.2 lists each.
- **Effort estimates** — at least six are tight by 50-100% (G1, H0, K1, N1, A11, F0). Section 10.3 lists with revised numbers.
- **Missing actions** — about 15 findings from the three source reviews don't appear as actions or in §3. Section 10.5 lists them. Most are small (one-line action or one-line deferral); the meaningful gaps are Codex §16 missing four C2 entries, Gemini §1.4 layout thrashing fix, and Gemini §3.3 session-resolver mtime race.
- **Sequencing** — A2 should land before or alongside L1 to avoid two-location fixes; K1 should slide to Phase 1; F7 is a Phase-2 canary candidate. Section 10.6.
- **Dependencies** — A2 → G1, N1 → C5, N3 → coverage audit, A10 → H1. Section 10.4. None are blockers; they prevent rebase pain.

Net: with the §10.2 acceptance criteria tightened, the §10.5 dropped findings either added or explicitly deferred, and the §10.3 effort estimates revised, this plan is ready to convert to issues.

— end of Claude reviewer feedback

---

## 10b. Codex Reviewer Feedback (reference)

Codex chose to add their feedback inside their own review file rather than this plan. See:
- `review/CODEX_CODE_REVIEW.md` §"Cross-Review Reconciliation Addendum" (line 671) — adds findings A1-A8 (high-priority items Codex picked up from cross-reading the other two reviews).
- `review/CODEX_CODE_REVIEW.md` §"Revised Corrective Action Plan" (line 839) — Codex's preferred phase ordering.
- `review/CODEX_CODE_REVIEW.md` §"Codex Reviewer Feedback on the Corrective Action Plan" (line 905) — Codex's critique of the v1 ordering ("the plan should not try to fix every category of debt in parallel").

The §6 sequencing in this v2 plan reflects Codex's stricter ordering (Phase 0 stabilization, Phase 1 correctness fixes, Phase 2 route decomposition, etc.) per their addendum.

---

## 12. Net Changes from v1 to v2

This section enumerates the substantive changes made in response to reviewer feedback. Section §10 (Gemini), §11 (Claude), and §10b (Codex pointer) preserve the original feedback as audit trail.

### 12.1 New actions added (response to "missing actions" critiques)

- **A17** — `WORKBENCH_SESSION_ID` env var injection at session spawn (Gemini §3.3).
- **A18** — `switchTab` layout thrashing fix (absolute-position pattern; Gemini §1.4).
- **C6** — Trivial cleanup batch (gate.html duplicate-Space ID, server.js PORT 3000, db.js misleading catch comment; Claude §11.5).
- **C7** — Test artifact gitignore + missing fixtures (Claude §11.5).
- **C8** — Legacy helpers in safe-exec.js — `grepSearchAsync`, `curlFetchAsync` (Codex §18, per Claude §11.5).
- **D6** — Centralized PTY registry + `process.on('exit')` cleanup hook (Gemini §10.2 reviewer feedback).
- **D7** — Logger batched persistence (Claude §2.15, per §11.5).
- **D8** — KB watcher mutex split (Claude §2.18, per §11.5).
- **D9** — tmux-lifecycle scan optimization (Claude Low #53, per §11.5).
- **D10** — `/tmp` resume-tail file cleanup (Claude Low #54, per §11.5).
- **E3** — Optimistic-mutation poll-collision fix (Gemini §10.1 reviewer pushback on §3.2 deferral).
- **E4** — Vector sync streaming for large files (Gemini §3.2.2 + §10.2 reviewer feedback). Folded into J1.
- **N1b** — ESLint rules escalation to errors (split from N1; Claude §11.3).

### 12.2 Existing actions modified (acceptance, effort, dependencies)

- **A1** — Acceptance criterion fixed: project **path** (not name) must contain `.~+` (Claude §11.2).
- **A2** — Source citation trimmed to "Codex Finding #5" (Claude §11.7); explicit dependency on G5 + L1 added.
- **A5** — Acceptance updated: `pattern` test removed (already escaped); `context_lines` clamp test added (Claude §11.2).
- **A8** — Acceptance updated: stub `claudeExecAsync`, assert never invoked (Claude §11.2).
- **A10** — Dependency tightened: must land **after H2**, not "before or after" (Claude §11.4).
- **A11** — Effort revised 3 → 4-5 hours (Claude §11.3).
- **A14** — Effort revised 4 → 9-13 hours including fixture capture (Claude §11.2).
- **B1** — Acceptance grep scope expanded to `tests/`, `public/`, `config/` (Claude §11.2).
- **C2** — Extended with 5 missing tunables Codex §16 flagged (Claude §11.5). Sequenced to Phase 1.
- **C5** — Acceptance: AST-based check via `acorn`, not grep (Claude §11.2). Effort 2 → 3 hours.
- **D2** — Acceptance: bucket-reset verification added (Claude §11.2).
- **F0** — Effort revised 1-2 weeks → 3-4 weeks at one engineer (Claude §11.3). F2 marked hard prerequisite for F4-F14 (Gemini §10.3). F7 promoted as Phase 1 canary (Claude §11.6). F8 escape-hatch noted.
- **G0** — Effort revised ~1 week → ~2 weeks. G1 specifically called out as 1.5-2 days (Claude §11.3).
- **G1** — Mandate added: migrate `tmux new-session` from `execSync` to async (Gemini §10.2 reviewer feedback).
- **H0** — Effort revised 1 week → 2 weeks. Transitional re-export adapter approach mandated (Claude §11.3).
- **J1** — Renamed to "factory-DI conversion + streaming"; folds E4. Effort 2 → 3 days.
- **K1** — Acceptance: byte-identical `sqlite3 .schema` snapshot (Claude §11.2). Effort 2 → 3 days. Sequenced to **Phase 1** (Claude §11.6).
- **L1** — Acceptance: snapshot deep-equal as primary, smoke test as secondary (Claude §11.2). Dependency on G1/G5 added.
- **N1** → split into **N1a** (warnings tier) + **N1b** (errors tier after C5 + cleanup).
- **N3** — Dependency made explicit: blocked by separate coverage-gap audit (Claude §11.4).

### 12.3 Deferred Set (§3) updates

- **§3.2** (`/api/state` polling) — Updated reasoning to reflect E1+E2 (not E1 alone) is the realistic latency target. New action E3 closes the correctness gap Gemini flagged.
- **§3.3** (relational settings) — Added explicit ordering: K1 → relational `webhooks` → relational `vector_collection_*`. Higher-contention tables prioritized over `git_accounts` per Claude §11.1.
- **§3.4 (NEW)** — `task-service.js` extraction deferral (Codex §19); A2 is the minimum-viable correctness in lieu.
- **§3.5 (NEW)** — OAuth detector → backend worker thread deferred (Gemini §1.5); A14 frontend extraction is the first step.

### 12.4 Sequencing (§6) restructured

- Added **Phase 0 — Stabilize the model** (per Codex addendum): deletes, fixture/CI green, .dockerignore.
- **K1** moved from old Phase 2 to Phase 1 (Claude §11.6).
- **F7** added as Phase 1 canary (Claude §11.6).
- **C2** moved to Phase 1 explicitly (Claude §11.4).
- Critical sequencing dependencies enumerated as a flat list at the bottom of §6.

### 12.5 What did not change

- Skip set §3.1 (framework migration) — all three reviewers agreed.
- Trust model framing (no security phase) — Claude §11.1 explicitly endorsed.
- Issue-tracking shape (~34 parent + ~62 with children) — unchanged at the parent level. Net additions: 13 new actions (A17, A18, C6-C8, D6-D10, E3, E4, N1b). Issue total: ~45 parent issues, ~73 with children.

### 12.6 Items that still need user decisions

These are choices the reviewers surfaced but the plan does not yet resolve:

- **N1a vs N1b split or single action.** Plan adopted the split per Claude §11.3. Alternative: keep single N1 with explicit "warnings first, escalate to errors after a sweep" milestone. Pick before filing.
- **Issue filing strategy.** Plan says "parent + children" for the four big decompositions (F0, G0, H0, I0). Reviewers did not push back on this. Confirm before filing.
- **Phase 0 scope.** Codex's addendum suggests Phase 0 is "decide and freeze review scope" before any implementation. The plan adopted Phase 0 as "stabilize the model" which is similar but not identical. Confirm Phase 0 boundary before filing.

— end of v2 plan
