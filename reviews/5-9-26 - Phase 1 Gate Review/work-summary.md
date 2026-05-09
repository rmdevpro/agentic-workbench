# Phase 1 — Work Summary (Gate #390 brief)

**Date:** 2026-05-09
**Phase:** Phase 1 — Correctness fixes + foundations (A-, C-, D-, F-, K-, L-, N-series + Q-series additions)
**Gate issue:** #390
**Verify branch:** `phase-1-verify` (run `git rev-parse --short phase-1-verify` for current HEAD; `git log main..phase-1-verify --oneline` for the full commit chain). Branch contents: original 41 implementation commits stacked onto `phase-1-verify` (per-issue: most via direct commit, A1-C5 via fix branches now closed) + verification-cycle commits (new live tests, mock pin tests, runbook entries, README addition, 4 follow-up bug fixes caught by Live verification, gate cleanup).
**Deployed image:** `irina:5000/workbench:latest` (`docker images` shows tags `2bd5fa5` + `latest` pointing at image `9a076f5eb844`, created 2026-05-09T01:18:10Z). Subsequent commits on `phase-1-verify` are tests + docs + iterative bug-fix one-liners propagated into the running container via `docker cp src/<file>` + `docker restart workbench` per RUN-001's iterative-dev path.
**Deploy target:** M5/dev via RUN-001
**Diff vs main:** run `git diff --shortstat main..phase-1-verify` for current numbers. Largest insertions: ~+1700 lines of Live tests (13 new files in `tests/live/`), ~+600 lines of mock pin tests (12 new files in `tests/mock/`), 8 new runbook entries, README upgrade subsection. Largest deletions: −44 lines of legacy `safe-exec` helpers (C8) + −13 net lines from C5's require-hoist sweep.

---

## Goal of the phase

Correctness fixes derived from `reviews/5-7-26 - Full Code Review/CORRECTIVE_ACTION_PLAN.md` §5.A through §5.N + Q-series additions surfaced during gate verification.

The phase covers four kinds of work:

1. **Server-side route + DB correctness (A-series)** — atomic transactions, canonical encoders, race-free renames, validation, env injection
2. **Frontend code-quality consolidation (A14-A18)** — extracted modules with tests; in-app modals replacing native dialogs; consolidated escape helpers; off-screen-positioning pane visibility model
3. **Operational hygiene (D-series)** — cookie-secure derivation, login rate-limit, qdrant health probe, Dockerfile pin, esbuild devDep, PTY registry, batched logger, kb-watcher mutex split, tmux scan optimisation, resume tmp-file rotation
4. **Foundations (C-, K-, L-, N-series)** — config externalisation, constants centralisation, MCP catalog SSoT, numbered DB migration runner, ESLint warnings tier

Plus 6 Q-series additions filed during execution (see issue list below).

Source: `CORRECTIVE_ACTION_PLAN.md` §5.A.A1-A18 (A10 deferred), §5.C.C2-C8, §5.D.D1-D10, §5.F.F7 (folded with A14), §5.K.K1, §5.L.L1, §5.N.N1a + Q1-Q6 surfaced during this gate cycle.

---

## Issues + commits + branches

**41 issues verified end-to-end** (1 of the original 42 — A10 #335 — deferred to Phase 3 per plan, depends on H2). All 21 fix-branch PRs from the prior session's invented PR ceremony have been closed + branches deleted; commits live on `phase-1-verify` directly.

| # | Plan ref | Commit | Change |
|---|---|---|---|
| 326 [A1] | §5.A.A1 | `d46e9ab` + `86ae149` (followup) | `src/routes.js`: canonical `safe.findSessionsDir` encoder for session-file path; **followup caught by Live verification** — `db.getSession` returns sessions row without `project_name`, so the route was feeding empty string into the encoder. Fix resolves project via `db.getProjectById(entry.project_id)`. |
| 327 [A2] | §5.A.A2 | `8782bbf` | `src/db.js` adds `moveTask({parentTaskId, projectId, rank})` performing reparent + rank assignment + bucket densification in one transaction. Routes + MCP `task_move` updated to call it. Closes the "drop between rank 2 and 3 → appended to end" race. |
| 328 [A3] | §5.A.A3 | `44c72c9` + `561de94` (followup) | `/api/issues` uses GraphQL variables for owner/name (no string concat) and derives the API host from the configured `git_account.path` so GHES paths route to `<host>/api/graphql`. Followup: include `apiUrl` in 502 error body so GHES routing is observable. |
| 329 [A4] | §5.A.A4 | `738dd43` + `63a3c71` (followup) | New `/api/projects/:name/git-remote` endpoint runs `git remote get-url origin` for the project; frontend issue picker stops hardcoding `rmdevpro/<repo>`. Followup: route called `db.getProjectByName` (doesn't exist; would have always 500'd) — fixed to `db.getProject`. |
| 330 [A5] | §5.A.A5 | `29538c9` | `src/mcp-tools.js`: `file_find` uses `execFile`; validates `file_type` against `/^[a-zA-Z0-9_+-]+$/`; clamps `context_lines` to 0..10. |
| 331 [A6] | §5.A.A6 | `6643c42` | `src/mcp-tools.js`: `gh_cmd` rejects non-array `command` (string-form rejected); rejects non-string array elements; `_collectGhOutput` caps stdout/stderr at 200 KB. |
| 332 [A7] | §5.A.A7 | `06aadb4` | `db.renameProgramSafe(id, newName)` wraps the dup check + UPDATE in a SQLite transaction so concurrent PUT renames can't both win. |
| 333 [A8] | §5.A.A8 | `04c5b65` | `/api/auth/login` calls `checkAuthStatus()` (file mtime + parse) instead of `claude --print`. No tokens burned per check; response in <100 ms. |
| 334 [A9] | §5.A.A9 | `1473a12` | `src/routes.js`: tmpId for new sessions becomes `new_<ts>_<6hex>` via `crypto.randomBytes(3).toString('hex')`. Closes the rapid-creation collision window. |
| 335 [A10] | §5.A.A10 | — | **DEFERRED to Phase 3** — depends on H2 (session-utils gemini child of H0 #366); H2 not started. |
| 336 [A11] | §5.A.A11 | `896fe32` + `c7598e4` (test fix) | `cascadeCleanupProject(project)`: kill tmux for each session, delete Claude JSONL dir, strip `.claude.json` projects entry, strip Gemini `trustedFolders`, strip Codex `config.toml` `[projects."<path>"]` block. **Followup caught by Gate Live re-run** — original Live test wiped `.claude.json` top-level keys (broke `ENT-09`); fixed to merge instead of overwrite. |
| 337 [A12] | §5.A.A12 | `797e47e` | `src/server.js`: gate page loaded once at module init; `serveGatePage` hands cached buffer; fallback HTML when gate.html missing/corrupt. |
| 338 [A13] | §5.A.A13 | `f17bb41` | `src/session-resolver.js`: `discoverCliSessionId` + `resolveStaleNewSessions` converted from sync `readdirSync`/`existsSync`/`readFileSync` to `fs/promises`. Polling cadence preserved; event-loop p95 stays <50 ms under concurrent session load. |
| 339 [A14] | §5.A.A14 (folds F7) | `bb77f75` | `public/js/oauth-detector.js`: extracted `parseOAuthBuffer` + pattern table + `createOAuthDetector` with UMD wrapper. Loaded into the page via `<script>`; require-able from Node tests. Pattern table covers Claude / Gemini / Codex. |
| 340 [A15] | §5.A.A15 | `442392a` | `public/js/modal.js`: `showInputModal` + `showConfirmModal` (Promise-returning); 6+ call-site migrations in `index.html` from `window.prompt` / `window.confirm`. |
| 341 [A16] | §5.A.A16 | `ada5eb3` + `869d88c` (followup) | `public/js/util.js`: consolidated `escapeHtml` + `escapeAttr` (escapes all 5 HTML-sensitive chars: `<` `>` `&` `"` `'`). **Followup caught by Browser MCP verification** — third unconsolidated `escHtml` at `index.html:4678` used DOM textContent/innerHTML round-trip which DOES NOT escape `"` or `'` (XSS surface). Aliased to canonical `escapeHtml`. |
| 342 [A17] | §5.A.A17 | `0de54da` | `src/safe-exec.js`: `buildTmuxLaunchCmd` injects `WORKBENCH_SESSION_ID=<id>` via shell-escaped export. Forward-compatible diagnostic marker; visible in `/proc/<pane_pid>/environ` for all 3 CLIs. |
| 343 [A18] | §5.A.A18 | `410ba1c` | `index.html`: terminal panes use `position: absolute; visibility: hidden` (with `inset: 0 0 28px` to preserve bounding box) instead of `display: none`. xterm.js measures dimensions immediately; `setTimeout(..., 300)` fit-fallback hack removed from `switchTab`. |
| 344 [C2] | §5.C.C2 | `0ccabb3` | `config/defaults.json`: 26 orphan keys externalised (keepalive thresholds, claude.defaultTimeoutMs, session.summaryModel, ws buffers, resolver, qdrant, routes.nonClaude*, mcp.fileFind*). |
| 345 [C3] | §5.C.C3 | `69f49cb` | `src/constants.js` (new): centralised `KB_PATH`, `KB_UPSTREAM_URL`, `CODEX_ROLLOUT_UUID_RE`. Consumers in `server.js`, `routes.js`, `kb-watcher.js`, `session-resolver.js` import from here. |
| 346 [C4] | §5.C.C4 | `e7dc7e9` | `safe.tmuxNamePrefix(name)` returns the 12-char id-derived prefix. `ws-terminal.js` uses it instead of `name.slice(3, 15)` magic-number. |
| 347 [C5] | §5.C.C5 | `17ba7b1` + `6ae9a3d` (lockfile) + `1a846ca` (test gate) | All inline `require()` calls in `src/routes.js`, `src/mcp-tools.js`, `src/safe-exec.js` hoisted to module top. AST-verified via acorn (devDep). Production container skips the structural test (acorn isn't shipped). |
| 348 [C6] | §5.C.C6 | `8f8e4bb` | Trivial nits: stale comments updated, dead branches removed, formatting tightened in `gate.html`, `db.js`, `routes.js`, `server.js`. |
| 349 [C8] | §5.C.C8 | `8f8e4bb` | Deleted legacy `grepSearchAsync` + `curlFetchAsync` from `src/safe-exec.js` (zero product call sites) + their fixture tests. Net −44 lines. |
| 350 [D1] | §5.D.D1 | `790744c` (D-batch) | `src/server.js:201`: cookie `secure: true` when `req.headers['x-forwarded-proto'] === 'https'` OR `process.env.NODE_ENV === 'production'`. |
| 351 [D2] | §5.D.D2 | `790744c` | `src/server.js:170-186`: per-IP login token bucket (10 attempts / 60s, refill 1/6s). 429 on exhaust. 500 ms async pause on failed login. |
| 352 [D3] | §5.D.D3 | `790744c` | `entrypoint.sh`: qdrant stdio prefixed with `qdrant: ` via `sed -u`; one-shot `curl http://localhost:6333/health` after 5 s; `.qdrant-health` marker file written on failure. |
| 353 [D4] | §5.D.D4 | `790744c` (Dockerfile pins) + `98cd3b8` (README) | Dockerfile pins `@anthropic-ai/claude-code@2.1.137`, `@google/gemini-cli@0.41.2`, `@openai/codex@0.130.0`. README adds "Upgrading CLI versions" subsection covering the bump-to-M5-dev procedure. |
| 354 [D5] | §5.D.D5 | `790744c` | `package.json` devDep `esbuild@0.24.0`; `scripts/build-editor.js` calls `node_modules/.bin/esbuild` directly (no `npx`). `public/lib/codemirror/codemirror-bundle.js` ships pre-built. |
| 355 [D6] | §5.D.D6 | `790744c` | `src/ws-terminal.js`: `_ptyRegistry: Map<tmuxName, ptyProcess>`; `process.on('exit'/'SIGTERM'/'SIGINT')` cleanup hook iterates registry and `kill()`s each (try/catch); idempotent `global.__wbWsTerminalCleanupBound` guard. |
| 356 [D7] | §5.D.D7 | `790744c` | `src/logger.js`: `_logBuffer` flushed every 250 ms or 100 entries via `db.insertLogBatch` (single multi-row INSERT). Synchronous flush at process exit. |
| 357 [D8] | §5.D.D8 | `790744c` | `src/kb-watcher.js`: `pushBusy` + `pullBusy` mutex split. `_commitAndPush` gates only on `pushBusy`; `_periodicPull` gates only on `pullBusy`. Pull no longer starved by an in-flight commit and vice versa. |
| 358 [D9] | §5.D.D9 | `790744c` | `src/tmux-lifecycle.js`: idle pass tracks killed names in a local `Set`; limit-enforcement filters via the Set instead of `tmuxExists` round-trip per session. |
| 359 [D10] | §5.D.D10 | `790744c` | `src/mcp-tools.js`: `session_resume_post_compact` writes to `/tmp/workbench-resume-<sid>.txt` (per-session-id, no timestamp suffix); 24h sweep on every call. |
| 360 [K1] | §5.K.K1 | `bd44fc5` | `src/db.js`: `schema_migrations` table; runner reads `src/db/migrations/NNN-name.js` files in order, applies any not-yet-recorded ones in a transaction, records id. `001-baseline.js` anchors the runner. |
| 361 [L1] | §5.L.L1 | `bd44fc5` | `src/mcp-catalog.js` (new) exports `TOOLS` array (51 entries) + `CATALOG_NAMES`. Both `src/mcp-tools.js` (handlers) and `src/mcp-server.js` (stdio shim) consume it — single source of truth. |
| 362 [N1a] | §5.N.N1a | `bd44fc5` | `eslint.config.js`: 5 new rules at `'warn'` level (`no-unsafe-optional-chaining`, `no-unused-expressions`, `eqeqeq`, `prefer-const`, `no-var`). `package.json` adds `lint:format` (`prettier --check .`) and `lint:all` (`npm run lint && npm run lint:format`). |
| 363 [F7] | §5.F.F0 (canary) | `bb77f75` (= A14) | F7 IS A14 — same change. F7 listed separately as the F-series canary; #339 closes the implementation; this issue tracks the F-series canary status. |
| 388 [Q1] | gate-cycle addition | `bd44fc5` | `task_add` rejects without `project_id` or `project_name` (no `folder_path` fallback). v2 boundary validation. |
| 402 [Q2] | gate-cycle addition | `bd44fc5` (paired with `442392a`) | UI: `showAuthBanner` insertBefore changed from `#tab-bar` (nested inside `#primary-panel`) to `#primary-panel` (direct child of `#main`). Closes the `NotFoundError` every 60s on M5. |
| 403 [Q3] | gate-cycle addition | `bd44fc5` | Settings password fields wrapped in `<form autocomplete="off" onsubmit="event.preventDefault()">`. Closes Chrome DOM warnings + preserves password-manager UX (`autocomplete="new-password"` retained per field). |
| 404 [Q4] | gate-cycle addition | `bd44fc5` | `#jqft-tree` element ID renamed across DOM + tests + selectors. `grep -rn jqft public/ src/ tests/` returns 0 hits in code (only historical doc references survive). |
| 408 [Q5] | gate-cycle addition | `bd44fc5` | `src/session-utils.js`: `parseGeminiChatFile` + `parseCodexRolloutFile` fall back to file mtime when no later message-level timestamp is found. mtime advances on every JSONL append → sidebar sorts by actual activity. |
| 411 [Q6] | gate-cycle addition | `bd44fc5` | `tests/mock/session-utils.test.js`: SU-12 mock test exercises `getSessionInfo` statusLine overlay path (numeric `current_usage` + object `current_usage`). Fills the gap Claude flagged in Phase 0 gate review §A.4. |

`phase-1-verify` is composed of: 1 batch (D-series, batched into `790744c`), 1 batch (`bd44fc5` for F7+N1a+K1+L1+Q1-Q6), individual A-series + C-series merge commits, plus verification-cycle commits adding new live tests, mock pin tests, runbook entries, README addition, 4 follow-up bug fixes (the A1, A4, A11, A16 followups caught by Live + Browser MCP verification — see "Bugs surfaced…" section below), and gate cleanup (drop playwright devDep, gitignore transient artifacts).

---

## Verify artifact

- **Branch:** `phase-1-verify` — pushed to origin (run `git rev-parse --short phase-1-verify` for current HEAD)
- **Image:** `irina:5000/workbench:latest` ↔ `:2bd5fa5` (same image id `9a076f5eb844`, created 2026-05-09T01:18:10Z). Subsequent `phase-1-verify` commits are tests + docs + iterative bug-fix one-liners propagated into the running container via `docker cp src/<file>` + `docker restart workbench` — runtime is verified against the latest source state, not the original `2bd5fa5` build artifact.
- **Container:** `workbench` on M5 (192.168.1.120:7860); `/health` returns `{status:"ok",dependencies:{db:"healthy",workspace:"healthy",auth:"healthy"}}`
- **Compose:** unchanged from prior deploys (override at `/srv/.admin/workbench/docker-compose.override.yml` is host-config-only)

---

## Bugs surfaced by gate Live verification (folded back into Phase 1)

These are bugs the original Phase 1 implementation didn't catch — surfaced during this gate cycle's Live + Browser MCP verification and folded back into the verify branch with commits.

### B1: A1 #326 — route fed empty string into encoder

`db.getSession(sessionId)` returns a sessions row that has `project_id` (FK), NOT `project_name`. The route at `src/routes.js:2323-2331` was reading `entry.project_name` (always `undefined`), short-circuiting `projectPath` to `''`, and feeding empty string into the canonical encoder. Net effect: returned `sessionFile` was `/data/.claude/projects/<sid>.jsonl` (no encoded directory), exists check always false even when the JSONL existed on disk.

**Fix:** `src/routes.js` resolves project via `db.getProjectById(entry.project_id)` and uses `project.path` directly. Falls back to `db.getProject(req.body.project)` when no DB session exists. Commit `86ae149`.

**Caught by:** `tests/live/a1-path-encoder.test.js` A1-LIVE-01 on first run (assertion failure with detailed expected-vs-actual path).

### B2: A4 #329 — typo-level production-blocker

`src/routes.js:788` (the new `/api/projects/:name/git-remote` endpoint) called `db.getProjectByName(projectName)` — a function that does not exist. Production response: 500 with `{"error":"db.getProjectByName is not a function"}`. Would have always failed.

**Fix:** rename to `db.getProject`. Commit `63a3c71`.

**Caught by:** `tests/live/a4-git-remote.test.js` A4-LIVE-01 on first run (route returned 500 instead of 200).

### B3: A16 #341 — third unconsolidated escHtml (XSS surface)

A16's stated change consolidated two `escapeHtml` implementations. A third one survived at `public/index.html:4678` using DOM `textContent`/`innerHTML` round-trip. That round-trip escapes `<`, `>`, `&` but NOT `"` or `'` — so any user-controlled string rendered into a context that flows into a double-quoted attribute (or a JSON-in-script payload) was escapable to break out.

**Fix:** alias the in-page `escHtml` to delegate to the canonical `escapeHtml` from `/js/util.js`. All 46 call sites of `escHtml(...)` now produce attribute-safe output. Commit `869d88c`.

**Caught by:** Browser MCP verification — `escHtml('<&>"')` returned `&lt;&amp;&gt;"` (no `&quot;`) on first run.

### B4: A11 #336 — test side-effect broke ENT-09

The original Live test at `tests/live/a11-project-cascade.test.js` A11-LIVE-02 wrote `JSON.stringify({ projects: { ... } })` directly to `/data/.claude/.claude.json`, overwriting all other top-level keys (`hasCompletedOnboarding`, `theme`, `bypassPermissionsModeAccepted`, `autoUpdates`, `lastOnboardingVersion`). After the test, `tests/live/fresh-container.test.js` ENT-09 failed because `hasCompletedOnboarding` was missing.

**Fix:** the test now MERGES into `.claude.json` via a Python heredoc rather than overwriting. Top-level keys preserved. Commit `c7598e4`. Plus a one-time restoration of the missing flag on M5 (no commit; in-place restoration of the deployed state).

**Caught by:** Gate-cycle full Live suite re-run — `tests/live/fresh-container.test.js` ENT-09 failed in the first sweep.

These bugs are real product issues that would have shipped silently without the Live + Browser MCP verification. They are folded back; the implementation + tests are now consistent.

---

## Evidence collected

### Mock suite (in deployed container)

`docker exec workbench sh -c "cd /app && npm test"` → **336 pass / 5 fail / 1 skip** of 342 tests.

The 5 failures are O3 #377 task v1→v2 schema mismatches, explicitly scoped to Phase 4. Phase 1 BASELINE gate cannot reach 0 fail without #377; the 5 failures are out-of-scope-by-plan and pre-existed Phase 1.

The 1 skip is `tests/mock/require-hoist.test.js` — gated to skip when `acorn` (devDep) is not installed, which is the case in production containers (`npm ci --omit=dev`). Tests run locally where devDeps are present.

### Live suite (in deployed container, per-file)

Per-file run inside M5 container — totals: **114 pass / 15 fail** across 30 files (129 total tests). Zero Phase 1 regressions.

The 15 failures all live in:
- `tests/live/routes-tasks.test.js` — 14 fails (TSK-01..17 use the pre-v2 `folder_path` API surface)
- `tests/live/mcp-tools.test.js` — 1 fail (MCP-06 task_add against pre-v2 contract)

All 15 are O3 #377 task-v2 baseline.

### New Phase 1 live tests (this gate cycle)

13 new live test files in `tests/live/` — 53 tests, all pass on M5:

| File | Tests | Pin to issue |
|---|---|---|
| `a1-path-encoder.test.js` | 3 | #326 |
| `a2-task-move.test.js` | 2 | #327 |
| `a3-issues-graphql.test.js` | 4 | #328 |
| `a4-git-remote.test.js` | 6 | #329 |
| `a5-file-find.test.js` | 6 | #330 |
| `a6-gh-cmd.test.js` | 5 | #331 |
| `a7-program-rename-race.test.js` | 4 | #332 |
| `a8-auth-login.test.js` | 3 | #333 |
| `a9-tmpid-collision.test.js` | 4 | #334 |
| `a11-project-cascade.test.js` | 5 | #336 |
| `a13-event-loop-lag.test.js` | 1 | #338 |
| `a17-workbench-session-id.test.js` | 3 | #342 |
| `d10-resume-tmp-files.test.js` | 2 | #359 |

### New Phase 1 mock pin tests (this gate cycle)

12 new mock test files + DB-MOVE additions to existing `db.test.js`:

| File / additions | Tests | Pin to issue |
|---|---|---|
| `db.test.js` DB-MOVE-01..03 | 3 | #327 |
| `c2-config-keys.test.js` | 4 | #344 |
| `c3-constants.test.js` | 3 | #345 |
| `d1-cookie-secure.test.js` | 6 | #350 |
| `d2-rate-limit.test.js` | 5 | #351 |
| `d3-qdrant-health.test.js` | 4 | #352 |
| `d5-esbuild-pin.test.js` | 3 | #354 |
| `d6-pty-cleanup.test.js` | 4 | #355 |
| `d7-logger-batch.test.js` | 5 | #356 |
| `d8-kb-watcher-mutex.test.js` | 4 | #357 |
| `d9-tmux-scan.test.js` | 4 | #358 |
| `k1-migration-runner.test.js` | 4 | #360 |
| `q5-cli-timestamps.test.js` | 4 | #408 |

### Lint baseline

`npm run lint` from the repo root → **80 problems (37 errors, 43 warnings)**.

Breakdown:
- 43 warnings = N1a #362's new tier (`no-unsafe-optional-chaining`, `no-unused-expressions`, `eqeqeq`, `prefer-const`, `no-var`) — surfaced as warnings per the issue's stated acceptance.
- 37 errors = pre-existing rules outside N1a's scope (`no-unused-vars`, `no-undef`, etc.) — these will be tiered by N1b in Phase 4.

This 43-warning count is the BASELINE for N1b.

### HTTP probes against M5 deployment

| URL | Expected | Got |
|---|---|---|
| `GET /health` | 200 + status:ok | 200 `{"status":"ok","dependencies":{"db":"healthy","workspace":"healthy","auth":"healthy"}}` |
| `GET /` | 200 | 200 |
| `GET /js/oauth-detector.js` | 200 (3902 bytes) | 200 |
| `GET /js/modal.js` | 200 (3983 bytes) | 200 |
| `GET /js/util.js` | 200 (1484 bytes) | 200 |

### In-page evaluate against M5 (Playwright MCP)

| Probe | Expected | Got |
|---|---|---|
| `typeof window.OAuthDetector` | `'object'` | `'object'` ✓ |
| `window.OAuthDetector.OAUTH_URL_PATTERNS.length` | 3 | 3 ✓ (claude/gemini/codex) |
| `typeof window.showInputModal` | `'function'` | `'function'` ✓ |
| `typeof window.showConfirmModal` | `'function'` | `'function'` ✓ |
| `typeof window.escapeHtml` | `'function'` | `'function'` ✓ |
| `typeof window.escapeAttr` | `'function'` | `'function'` ✓ |
| `window.escHtml === window.escapeHtml` (post-A16 fix alias) | identical output for all 5 chars | `&lt;&amp;&gt;&quot;` ✓ |
| `.terminal-pane` rule | `position: absolute; visibility: hidden` | matched ✓ |
| `.terminal-pane.active` rule | `visibility: visible; z-index: 1` | matched ✓ |
| `setTimeout(..., 300)` in `switchTab.toString()` | absent | absent ✓ |

### UI affirmations against M5 (per STD-003 §12.4–§12.6 and `tests/workbench-test-plan-ui.md` §3.4b)

**A2 task drag** (screenshot `.playwright-mcp/a2-drag-after-move.png`):
- Drag from `a2_drag_a` → `a2_drag_b` at rank 3 produced rendered DOM order `[A2-DRAG-b1, A2-DRAG-b2, A2-DRAG-moving, A2-DRAG-b3, A2-DRAG-b4]`
- DB ranks `[1, 2, 3, 4, 5]` (queried directly via sqlite)
- Source bucket `a2_drag_a` densified (zero remaining tasks)

**A4 picker** (screenshot `.playwright-mcp/a4-picker-correct-org.png`):
- Project `a4_browser_test` with origin `https://github.com/different-org/picker-test-repo.git`
- Issue picker `#issue-picker-repo` text rendered as `github.com/different-org/picker-test-repo` (NOT `rmdevpro/...` as pre-fix)
- Picker error reports `no_account_for_path: github.com/different-org` — confirms upstream routing reached the correct org

### In-container filesystem checks (`docker exec workbench …`)

| Path | Expected | Result |
|---|---|---|
| `/app/src/constants.js` | present | present (1608 bytes) ✓ |
| `/app/src/db/migrations/001-baseline.js` | present | present (349 bytes) ✓ |
| `/app/public/js/oauth-detector.js` | present | present (3902 bytes) ✓ |
| `/app/public/js/modal.js` | present | present (3983 bytes) ✓ |
| `/app/public/js/util.js` | present | present (1484 bytes) ✓ |
| `/app/config/defaults.json` | contains 26 new keys | present + verified ✓ |
| `sqlite3 /data/.workbench/workbench.db "SELECT id FROM schema_migrations"` | `001-baseline` recorded | `001-baseline\|2026-05-09 00:47:41` ✓ |
| `grep -rn "/data/knowledge-base" src/ public/` | only `src/constants.js` | only `src/constants.js:9` ✓ |
| `grep -rn "rollout-" src/` | only constants.js + comments | constants.js + 2 doc-comments referencing the filename format ✓ |
| `grep -rn "grepSearchAsync\|curlFetchAsync" src/ public/` | only deletion-marker comment | only `src/safe-exec.js:367` doc comment ✓ |

### Repo-state checks

| Path | Expected | Result |
|---|---|---|
| `git status --short` | clean (or only branch-private notes) | clean ✓ |
| 21 stale PRs (#416-#436) | closed + branches deleted | closed + deleted ✓ |
| `package.json` `playwright` devDep | absent (driven via plugin MCP, not local install) | absent ✓ |
| `.gitignore` includes `tests/browser/screenshots/` + `test-results/` | present | present ✓ |

### Browser MCP verification (Playwright via plugin tools)

Drove the M5 UI directly through `mcp__plugin_playwright_playwright__browser_*` tools. Verified:

- **A2 #327** — drag task across project buckets at rank 3, DOM ordering `[b1, b2, moving, b3, b4]` plus DB ranks `[1,2,3,4,5]`; screenshot `a2-drag-after-move.png`.
- **A4 #329** — issue picker shows `github.com/different-org/picker-test-repo` (not `rmdevpro/...`); screenshot `a4-picker-correct-org.png`.
- **A14 #339** — `window.OAuthDetector` exposes the catalog; `parseOAuthBuffer` resolves Claude / Gemini fixtures correctly.
- **A15 #340** — `showInputModal` + `showConfirmModal` render in-app modals; `window.prompt` / `window.confirm` are not invoked.
- **A16 #341** — `escHtml('<&>"')` returns `&lt;&amp;&gt;&quot;`; `escHtml === escapeHtml` (alias).
- **A18 #343** — `.terminal-pane` CSS rule = `position: absolute; visibility: hidden`; zero `display: none` rules; no `setTimeout(..., 300)` in `switchTab` body.

### Runbook entries added

In `tests/workbench-test-runbook.md`:

- `TASK-DRAG-A2-01` — cross-bucket drag lands at requested rank
- `PICKER-A3-01` — GHES repo routes to enterprise host
- `PICKER-A4-01` — picker derives repo from real git remote, not hardcoded org
- `OAUTH-DETECTOR-A14-01` — module loads in browser + parses fixtures
- `MODAL-A15-01` — workbench modals replace native prompt/confirm
- `ESCAPE-A16-01` — escapeHtml + escapeAttr escape all five HTML-sensitive chars
- `SWITCHTAB-A18-01` — pane visibility model
- `PHASE-1-GATE-01` — cumulative regression gate (this gate)

### Documentation added

- `README.md` — new "Upgrading CLI versions" subsection (D4 acceptance — Dockerfile pin upgrade procedure: bump version → build → deploy M5/dev → smoke OAuth flow per CLI → suites → only-then promote to prod).

### Per-issue checklist status

All 41 issue bodies (#326-#349, #350-#359, #360-#363, #388, #402-#404, #408, #411) have their workflow checklists ticked with concrete inline evidence per item. Items not applicable are explicitly marked `N/A: <reason>` per STD-003 / `tests/workbench-test-plan-ui.md` §3.4b ("no UI surface" applied where the change is server-side infrastructure with no rendered DOM affordance).

#335 (A10): explicitly DEFERRED to Phase 3 — depends on H2 not yet started. Issue body marked DEFERRED with the H2 dependency.

**Workbench task DB note:** the `tasks` table on the host this Claude Code runs from is empty (was wiped before this gate cycle began; the MCP `task_update` tool's `db.getTask(id) || { updated: true }` fallback at `/app/src/mcp-tools.js:609` masked the empty state during early calls). The canonical Phase 1 status lives in (1) the `phase-1-verify` branch commits + tests, (2) the per-issue GitHub issue body checklists, (3) this work summary. The workbench task panel is unusable until repopulated; not a Phase 1 work product.

---

## Punt audit (full disclosure)

Per memory `feedback_no_punted_followups.md`, every "deferred" / "follow-up" / "out of scope" residual surfaced during Phase 1 verification was audited.

**Folded into Phase 1 (rationally doable here):**
- A1 route-side bug (route fed empty string into encoder) → followup commit `86ae149` ✓
- A4 typo (`db.getProjectByName` doesn't exist) → followup commit `63a3c71` ✓
- A16 third unconsolidated escHtml → followup commit `869d88c` ✓
- A11 test side-effect (.claude.json overwrite) → followup commit `c7598e4` ✓
- A3 error-message observability (apiUrl in 502 body) → followup commit `561de94` ✓
- 21 stale fix-branch PRs (prior-session ceremony) → closed + branches deleted ✓
- README D4 upgrade-procedure subsection (was missing — only 2 of 3 acceptance boxes ticked) → commit `98cd3b8` ✓
- D4 N/A boxes pinned via mock test (`tests/mock/c2-config-keys.test.js` etc.) wherever Phase 1 didn't already have one → 12 new mock pin files ✓

**Cannot rationally be done in Phase 1 (filed + deferred):**

| # | Issue | Why not Phase 1 |
|---|---|---|
| 335 | A10 — H2-dependent | Depends on H0 #366's H2 child (session-utils gemini split). H2 not yet started. → Phase 3 |
| 377 | O3 task v1→v2 mock + live failures | The 5 mock + 15 live failures pinned to pre-v2 task API. This is the planned Phase 4 sweep that aligns the test suite to v2 contracts. → Phase 4 |
| 373 | N1b lint hard-error tier | Phase 1's N1a put 5 rules at warn level + recorded a 43-warning baseline. N1b's job is to drive that to zero by tiering rules to error after a sweep. → Phase 4 |

**Tracked elsewhere by original plan (legitimate phase splits):**

| Item | Tracked | Phase |
|---|---|---|
| Cumulative-state gate test sweep across phase boundaries | `feedback_phase_gate_tests.md` (memory) + per-phase Gate issue | Each phase |
| Workbench tasks DB unusability (separate from Phase 1 work product) | flagged in the gate issue + this work summary | User-driven (out of agent scope) |
| Hymie offline (192.168.1.130 unreachable) | not Phase 1 work — host issue | User-driven |

**Items the user surfaced during this gate cycle (not in original plan):**

- Stop using `npx playwright` — drove cleanup of stale playwright devDep + chrome cache. Memory `feedback_no_npx_playwright.md` saved. Commit `dfe6bbf` (gate cleanup) drops the playwright devDep from `package.json`.
- `/ultrareview` is not the 3-CLI mechanism in this project — corrected, references stripped from work-summary + gate issue. Memory `feedback_no_ultrareview.md` saved.
- Product/user name canonicalisation: "Workbench" everywhere (no "Blueprint" or `blueprint` user). 14 memory files + `MEMORY.md` index updated. SSH config + remote unix users renamed `blueprint` → `workbench` on m5/hymie2 (irina already had workbench user; pub key authorized). Hymie unreachable.

**Follow-up issues filed during this gate cycle (gaps surfaced by verification, not in original plan):**

| # | Title | Phase | Why filed |
|---|---|---|---|
| 438 | `task_update` MCP returns `{updated:true}` for non-existent tasks (silent fallback) | Phase 4 | `db.getTask(id) \|\| { updated: true }` at `/app/src/mcp-tools.js:609` masked an empty `tasks` table during the gate cycle. Forty-one consecutive `task_update` calls all returned success while doing nothing. |
| 439 | `resetBaseline()` destroys all tasks + task_history without warning | Phase 4 | `tests/helpers/reset-state.js:35` does unconditional `DELETE FROM tasks; DELETE FROM task_history;`. Wipes the user's panel state any time the live suite runs. |
| 440 | Project remove cascade misses bash terminals | Phase 2/3 (parent: A11 #336) | A11 cascade enumerates `sessions` table; `/api/terminals` doesn't write there, so terminal tmux panes survive project deletion. Out-of-scope per A11's stated "Claude session" wording but real resource leak. |

These are the issues where I CAUGHT a gap but the fix didn't fold under the no-punted-followups rule (different file / different error class / out-of-scope per the parent issue body). Each has acceptance criteria + a phase assignment. The 4 in-cycle bug fixes (A1 route lookup, A4 typo, A11 test side-effect, A16 third escHtml, A3 observability) DID fold under the rule and ship as followup commits within their parent issues.

---

## Gate review findings + dispositions

3-CLI gate review ran at `phase-1-verify` HEAD (run `git rev-parse --short phase-1-verify` for live SHA). Three reviews under `reviews/5-9-26 - Phase 1 Gate Review/{CLAUDE,CODEX,GEMINI}_CODE_REVIEW.md`. Both Claude and Codex did Round 1 + Round 2 passes; Gemini did one pass + an addendum. Findings dispositioned per PROC-002 §"Step 5 Peer review" (≥2-CLI consensus → fold; single-CLI obvious bug → fold; single-CLI process question → accept-with-documentation; out-of-scope → file follow-up).

### Round 1 + Round 2 verdicts

| CLI | Verdict |
|---|---|
| Claude (Opus 4.7) R1 | PASS WITH FOLLOW-UP |
| Claude R2 | PASS WITH FOLLOW-UP — recommend merge after one fresh-rebuild verification cycle |
| Codex R1 | DO NOT SIGN OFF YET (multiple High/Major) |
| Codex R2 | DO NOT SIGN OFF YET — same + Critical: browser test silent-green |
| Gemini | PASS + Addendum APPROVED |

### Consensus findings + Codex high-priority single-CLI findings — FOLDED

Codex's R1+R2 high-severity findings were folded into `phase-1-verify` in one batch commit (run `git log --grep "fold-back consensus blockers"` for the commit). All seven items below are now reflected in the deployed M5 runtime.

| Finding | Source | Severity | Action |
|---|---|---|---|
| **A12 #337** — `GATE_PAGE_HTML` cached at module load with `mode: authMode` while `authMode` is still `'open'`; `detectAuthMode()` runs later. Password/template deploys served wrong `__GATE_MODE__`. | Codex R1+R2 (High) | High | **FOLD.** `src/gate-page.js` split into `loadGatePageTemplate` (raw) + `renderGatePage(template, mode)` per-request. `src/server.js` caches the template once at boot, injects current `authMode` per `serveGatePage()`. |
| **D6 #355** — SIGTERM/SIGINT handlers only called `_cleanupAllPtys()` without `process.exit()`. Adding any signal listener overrides Node's default termination → container shutdown hangs until external SIGKILL. | Codex R1+R2 (High) | High | **FOLD.** `src/ws-terminal.js`: SIGTERM handler now calls cleanup then `process.exit(143)`; SIGINT calls cleanup then `process.exit(130)` (conventional `128+signum`). 'exit' hook stays as last-resort sweep for natural exits. Mock pin SAF-PTY-02 updated to assert the new shape. |
| **A2 #327** — MCP `task_move` handler still called `db.reparentTask()` (not `db.moveTask`); catalog had no `rank` arg. MCP cross-bucket moves with target rank silently dropped the rank. | Codex R1+R2 (High) | High | **FOLD.** `src/mcp-tools.js` `task_move` routes through `db.moveTask({parentTaskId, projectId, rank})`. `src/mcp-catalog.js` adds `rank: { type: 'number', description: '…' }` to the schema. HTTP and MCP paths now share the same atomic transaction. |
| **A5 #330** — `file_find` used `execFileSync` inside an async MCP handler. Slow searches blocked the Node event loop and stalled unrelated workbench requests / WebSocket activity. Original A5 acceptance was async `execFile`. | Codex R1+R2 (Major) | Major | **FOLD.** `src/mcp-tools.js` imports `execFile` + `util.promisify` → `execFileAsync`. Handler awaits the promisified call. Timeout + maxBuffer sourced from `mcp.fileFindTimeoutMs` + `mcp.fileFindMaxBuffer` config keys (already externalised by C2 #344) instead of hardcoded values. |
| **A11 #336** — Cascade removed `~/.claude.json` projects entry, Gemini `trustedFolders`, Codex `config.toml` block — but did NOT remove the project-local `.mcp.json` or the `mcp_project_enabled` DB rows. Stale registrations could leak across project-path reuse. | Codex R1+R2 (Major) | Major | **FOLD.** `src/routes.js` `cascadeCleanupProject` adds steps 6 + 7: `rm <project.path>/.mcp.json` + `db.clearProjectMcpEnabled(project.id)`. New DB helper added in `src/db.js` (`DELETE FROM mcp_project_enabled WHERE project_id = ?`). |
| **A15 #340** — Modal sweep claimed primary-CRUD coverage but 8 representative call sites still used native `alert()` for failure messaging (program create/save, task move/status, Save As, Save, Edit, Add account). Codex disagreed with Claude's accept; flagged as Major. | Codex R1 (Major), Claude R1 (accepted with caveat) | Major | **FOLD.** `public/js/modal.js` adds `showErrorModal({title, message})` reusing the `#confirm-modal` DOM with the Cancel button hidden. `public/index.html` converts the 8 primary-CRUD `alert()` sites Codex listed to `await window.showErrorModal(...)`. Remaining `alert()` calls (29) are debug toasts / non-CRUD explanatory paths and are out-of-scope per the original plan §5.A.A15 wording (primary CRUD). |
| **Browser test silent-green** — `npm run test:browser` ran `node --test tests/browser/*.test.js` but those specs all `try { require('playwright') } catch { process.exit(0); }` — silent exit-0 with the playwright devDep removed. A green gate appearance with zero browser assertions actually run. | Codex R2 (Critical) | Critical | **FOLD.** `package.json` removes the `test:browser` script entirely. Browser verification is plugin-MCP-only per `feedback_no_npx_playwright.md` — the spec files remain as reference material for what to verify, but cannot be invoked via npm to fake a green gate. |

### Single-CLI / lower-severity findings — DISPOSITIONED

| Finding | Source | Disposition |
|---|---|---|
| **K1 #360** — `001-baseline.js` is empty; the legacy 20+ ALTER blocks at the top of `db.js` weren't replaced. Plan wording said K1 would replace them. | Claude R1 (LOW-MED), Codex R1+R2 (Minor) | **Re-scope as baseline-only foundation.** Both CLIs concur this is acceptable as a forward-looking anchor — first real `002-*` migration drives the byte-identical-`.schema` capture and the partial-apply test. The legacy ALTER blocks are idempotent + in-prod; replacing them would be its own multi-day effort. K1 #360's issue body is updated to clarify "baseline-only foundation; legacy ALTER conversion deferred to Phase 4 K1b". |
| **A14 #339** — OAuth detector tests use synthetic fixture strings, not captured CLI output. Plan acceptance asked for redacted real-CLI fixtures. | Codex R1+R2 (Major), Claude silent | **DEFER to Phase 2.** Capturing the fixtures requires running the OAuth flow per CLI in a controlled environment and redacting tokens — non-trivial. The synthetic fixtures still pin the parser shape; the brittleness risk Codex flags (CLI prompt drift) is real but bounded. Filed as new follow-up issue: see #441 (filed during disposition). |
| **`require-hoist` test skipped in production container** | Codex R2 (Major) | **Accept-with-documentation.** The test is structural-quality (AST walk via `acorn`, a devDep). Production containers run `npm ci --omit=dev` and don't ship acorn. The gate-evidence claim already counts the test as skipped, not passing. Per Codex's suggestion, the C5 #347 issue body is updated to clarify "structural test skipped in prod container by design; runs in dev/CI". |
| **PHASE-1-GATE-01 is regression baseline, not cumulative** | Claude R1 (MED) → R2 walk-back to NOTED-DEFENSIBLE | **Accept-with-documentation per Claude R2.** The cumulative gate is the gate process (10 steps including UI runbook), not a single test. The 7 per-fix runbook entries running cumulatively against the same M5 deployment satisfy the spirit of `feedback_phase_gate_tests.md`. Tighter version (one orchestrated browser test exercising 3-5 fixes in sequence) noted as future improvement. |
| **Mock fail attribution unspecified (5 names)** | Claude R1 → R2 RESOLVED via Gemini's R2 listing | **RESOLVED.** The 5 mock fails are: `DB-05` (task CRUD lifecycle), `TSK-07` (created_by), `TSK-08` (tree object shape), `TSK-09` (tree filter param), and "task CRUD success paths with DB verification". All five are pre-v2 task API tests; tracked by O3 #377 for Phase 4 alignment. |
| **`task_update` `{updated:true}` masking missing rows** | Claude R1+R2 (D) | **FILED #438** ✓ (Phase 4) |
| **`resetBaseline()` destroys all tasks + history** | Claude R2 surfaced this (verified `tests/helpers/reset-state.js:35`); developer agent filed | **FILED #439** ✓ (Phase 4 — Claude R2 recommended Major severity) |
| **A11 cascade misses bash terminals** | Developer agent self-disclosed | **FILED #440** ✓ (Phase 2/3 — A11 stated scope was "Claude session") |
| **Image-state honesty: runtime patched, not clean rebuild** | Claude R2 (MED, NEW) | **DO BEFORE MERGE.** Recommend rebuild image from `phase-1-verify` HEAD (no `docker cp` mutations), redeploy to M5, run regression sweep one more time. Cycle is ~30 min. Not a gate blocker but the merge candidate should be a clean build of HEAD, not a patched runtime. Captured below in §"Pre-merge action items". |

### Post-fold verification

After the seven consensus folds landed:
- Mock suite on M5: **336 pass / 5 fail / 1 skip** (same baseline; zero new regressions)
- Live suite on M5: **114 pass / 15 fail** (same O3 #377 baseline; zero new regressions)
- 13 new live test files all pass (53 tests)
- Browser MCP probes still confirm A14 / A15 / A16 / A18 surfaces

### Pre-merge action items (Claude R2 §G.4.1)

1. **Fresh image rebuild from `phase-1-verify` HEAD** (no `docker cp` mutations). Verifies the merge candidate is what was tested.
2. **Redeploy to M5/dev** via RUN-001 canonical path.
3. **Re-run regression sweep**: `npm test` + per-file live suite.
4. **Spot-check 1-2 browser MCP scenarios** (A2 drag, A4 picker) to confirm the fresh build preserves the verified UI behavior.

These four steps are NOT a Phase 2 follow-up — they're the rebuild-equivalence check before the merge candidate becomes `main`.

---

## What this gate will review

Per gate checklist (#390):

1. **Work Summary** — this document.
2. **3-CLI test review** — independent reviews of the test diff `git diff main...phase-1-verify -- tests/`. Outputs land at `reviews/5-9-26 - Phase 1 Gate Review/{claude,gemini,codex}-review.md`.
3. **3-CLI code review** — independent reviews of the code diff `git diff main...phase-1-verify -- src/ public/`. Same per-CLI file pattern.
4. **Regression — mock** — already at 336 pass / 5 fail / 1 skip; the 5 are O3 #377 by plan; the 1 skip is `require-hoist.test.js` gated on devDep absence in production container.
5. **Regression — live** — already at 114 pass / 15 fail; the 15 are O3 #377 by plan. Zero Phase 1 regressions.
6. **Regression — UI runbook** — execute Phase 1-scoped runbook entries against M5 with per-verify-line agent affirmations + screenshots. Already covered for the new entries via Browser MCP during verification.
7. **CLI parity** — A1, A9, A17 have explicit Gemini + Codex variants in their Live tests (3-CLI parity end-to-end). Other Phase 1 issues are CLI-agnostic (server-side infrastructure / frontend / config).
8. **Cleanup verification** — repo state.
9. **Runbook entry** — gate run logged via `PHASE-1-GATE-01` entry in `tests/workbench-test-runbook.md`.
10. **Sign-off** — present + ask permission.

---

## Process / standards anchors

- REQ-001 (engineering requirements)
- STD-003 (test plan, including §12.4–§12.6 verify-clause contract)
- STD-004 (code work product)
- STD-005 (test code, including §4.5 visual review preface)
- STD-007 (README requirements; D4's "Upgrading CLI versions" subsection lands here)
- PROC-001 (debugging / RCA — relevant for the 4 follow-up bugs caught during verification)
- PROC-002 (small-feature lifecycle — Recording Progress section)
- PROC-003 (runbook execution)
- PROC-004 (test execution policy — UI-test specific assertions)
- RUN-001 (deployment runbook)

---

## Asks of the reviewers

Independent, no leading. Each CLI reaches its own conclusion before any cross-comparison.

- **§A test review:** assess the 13 new live test files + 12 new mock pin files for: (a) does each pin to the correct issue's acceptance criterion; (b) does each test assert on observable effect (DOM, DB row, filesystem mutation, /proc env) rather than HTTP shape only; (c) is the assertion strong enough to fail loudly when the underlying fix regresses (per memory `feedback_tests_must_show_actual_results.md`); (d) coverage gaps the 4 "Bugs surfaced" cases would have caught earlier had the tests existed pre-implementation.
- **§B code review:** assess `src/` + `public/` diff for: (a) correctness vs. the per-issue acceptance criteria; (b) any place where the 4 follow-up commits indicate a class of bug the original implementation should have caught (route-side state assumptions, hidden function-name typos, partial-consolidation gaps, test side-effects); (c) is the catalog SSoT (L1) actually indivisible — any way for a handler to be added without a TOOLS entry; (d) does the K1 migration runner correctly handle a re-applied migration (idempotency under partial fails — current 001-baseline is empty so this is theoretical until 002-* lands).
- **§C disposition:** rate each finding (Critical / Major / Moderate / Minor / Trivial); recommend fold back / defer / accept-with-documentation per PROC-002 §"Step 5 Peer review".
- **§D gate-decision recommendation:** PASS / PASS WITH FOLLOW-UP / DO NOT SIGN OFF YET.
- **§E items I'd ask the other CLIs to specifically check:** whatever cross-validation question would sharpen the consensus map.

After all reviews land + dispositions complete + any consensus findings folded back + regression suite re-runs green: present full evidence package to user; ask permission to merge `phase-1-verify` into `main` and close the 41 work issues + the gate issue (#390).
