# Workbench Test Plan (Backend — Gates A & B)

**Status:** Active — Updated 2026-04-18
**Original Date:** 2026-04-10
**Revision:** 7.0 (updated for feature changes: removed quorum, openai-compat, smart compaction, messages, notes endpoints, plan tools; added multi-CLI, Qdrant vector search, MCP management, session lifecycle)
**Standard:** WPR-103 (State 4 Test Plan Work Product Standard)
**Application:** Workbench -- Agentic Workbench managing Claude/Gemini/Codex CLI sessions in tmux/Docker
**Engineering Requirements:** ERQ-001
**Synthesized from:** Independent plans by Claude, Gemini, Grok, GPT

## IMPORTANT: Changes Since Revision 6.0

### Removed modules (tests marked REMOVED)
- `quorum.js` — entire module deleted, QRM tests removed
- `openai-compat.js` — entire module deleted, OAI tests removed
- `mcp-external.js` — entire module deleted
- Smart compaction — CMP tests for compaction pipeline removed
- Messages system — send/get/mark-read functions and table removed from db.js
- Notes endpoints — `/api/projects/:name/notes` and `/api/sessions/:id/notes` GET/PUT removed from routes.js
- Plan tools — `workbench_read_plan`, `workbench_update_plan` removed from mcp-tools.js
- `workbench_send_message`, `workbench_get_project_notes`, `workbench_get_session_notes`, `workbench_ask_cli`, `workbench_ask_quorum`, `workbench_smart_compaction` — all removed

### Changed modules
- `mcp-tools.js` — 44 flat tools grouped by domain: `file_*` (8), `session_*` (19), `project_*` (11), `task_*` (5), `log_*` (1)
- `mcp-server.js` — tool definitions updated to match
- `db.js` — added `cli_type` column, `mcp_registry` and `mcp_project_enabled` tables, `searchSessionsByName()`
- `safe-exec.js` — added `tmuxCreateGemini()`, `tmuxCreateCodex()`, user `workbench` (was `hopper`)
- `routes.js` — **Phase 2 (G0):** decomposed from ~5,800-line monolith into a thin composition layer that wires per-domain handlers from `src/routes/`. `POST /api/sessions` accepts `cli_type`, resume launches correct CLI.
- `session-utils.js` — **Phase 2 (H0):** decomposed into a `createSessionUtils()` factory that composes sub-modules in `src/session-utils/`. Backward-compat shim preserves the existing import surface.
- `qdrant-sync.js` — **Phase 2 (J1):** converted to factory-DI pattern.
- `tmux-lifecycle.js` — periodic scan, idle timeouts, session limits
- `server.js` — **Phase 2 (M1):** KB-watcher clone-if-missing and chokidar lifecycle extracted to `kb-watcher.js`. MAX_TMUX_SESSIONS default 10, periodic scan startup.

### New modules (Phase 2)
- `src/routes/{auth,health,projects,sessions,tasks,files,kb,settings,git-accounts}.js` — domain handlers (G0)
- `src/routes/_shared.js` — common helpers, including `createTrustDir()` factory
- `src/session-utils/{claude-jsonl,gemini,codex,info,search}.js` — session helpers (H0)
- `kb-watcher.js` — KB clone-if-missing + chokidar watcher + Qdrant sync poller (M1)

### Path changes
- Container user: `workbench` (was `hopper`)
- Workspace: `/home/workbench/workspace` (was `/mnt/workspace`)
- No `CLAUDE_HOME` override — uses `$HOME/.claude` naturally

### Phase 2 test classes
- **Mock structural** (`tests/mock/`):
  - `g0-routes-composition.test.js` — G0-RT-01..09 — verifies thin composer wiring, all domain modules present, `createTrustDir` factory exported
  - `h0-session-utils-factory.test.js` — H0-SU-01..06 — verifies `createSessionUtils` factory API, backward-compat adapter
  - `m1-kb-watcher-clone.test.js` — M1-KB-01..08 — verifies `_cloneIfMissing` declared, ordered before watcher, git clone present
  - `p2-reviewer-fixes.test.js` — covers reviewer findings #453, #454, #455, #456, #460, #461, #466
  - `p2-timestamp-claim-behavioral.test.js` — behavioral tests for #462 (per-request claimed Sets), #463/#465 (timestamp priority), #467 (Codex-specific)
  - `p2-stage8-regressions.test.js` — S8-REG-01/02/03 — structural guards for three F0 regressions found during Stage 8 (wrong `_activeIdForPanel` import, missing `createTab` registration steps, missing open-dropdown guard in `renderSidebar`)
- **Live behavioral** (`tests/live/p2-phase2-live.test.js`):
  - G0-LIVE-01/02/03 — domain handlers reachable end-to-end via HTTP
  - H0-LIVE-01/02 — session-utils factory exposes the expected API surface
  - J1-LIVE-01/02 — qdrant-sync factory wired correctly
  - M1-LIVE-01/02 — `/api/kb/status` + `/api/kb/roles` respond without crash
  - #460-LIVE-01 — `session_meta.timestamp` wins over `db.updated_at` for Claude sessions
  - #461-LIVE-01/02/03 — `file_find` paren patterns (ERE fix)
  - #468-LIVE-01 — Gemini session disambiguation via per-request claimed Set
  - #453-LIVE-01, #454-LIVE-01 — reviewer fix behavioral confirmation
  - A8-LIVE-01/02 — `/api/auth/login` no-CLI-fork fast path (code inspection now reads `src/routes/auth.js` after G0)
**Reviewed by (R1):** Claude (Sonnet 4.6), Gemini, Grok, GPT
**Reviewed by (R2):** Claude (Sonnet 4.6), Gemini, Grok, GPT
**Review disposition:** R1 incorporated into Revision 2.0/3.0; R2 incorporated into Revision 4.0; see Appendix A and Appendix B
**Reviewed by (R3):** Claude (Sonnet 4.6), Gemini, Grok, GPT
**Review disposition:** R3 incorporated into Revision 5.0; see Appendix C

---

## 0. Executive Summary

Workbench is a UI-first agentic workbench that manages Claude, Gemini, and Codex CLI sessions through tmux, WebSockets, SQLite persistence, file watchers, MCP tooling (3 consolidated tools), Qdrant vector search, keepalive token management, health monitoring, and project-scoped MCP server management.

This test plan is built to satisfy WPR-103 and explicitly addresses the systemic failures documented in the review findings -- a prior 785-test suite with 98.3% pass rate that caught zero of 38 filed bugs. The root causes were: tests reimplementing application logic locally instead of importing real code, browser tests verifying DOM presence instead of behavior, multi-stage pipelines never exercised end-to-end, and silent error swallowing in 22 bare `catch {}` blocks.

This plan enforces:

- Every test imports and exercises real application code (Guidepost #1)
- Browser tests assert behavioral outcomes, not DOM presence (Guidepost #2)
- Pipelines tested stage-by-stage then end-to-end (Guidepost #3)
- Error paths made observable before testing (Guidepost #4)
- Fresh container on every gating run (Guidepost #5)
- Threshold testing at each level independently with 3+ cycles, including below-threshold boundary tests (Guidepost #6)
- Gray-box verification beyond API responses (Guidepost #7)
- No skipped tests for design changes -- rewrite instead (Guidepost #8)
- Independent review of all test code (Guidepost #9)
- All browser tests capture and fail on console errors (Guidepost #10)
- Every browser test produces a screenshot for automated visual review (Guidepost #11)
- Regression validation: intentionally broken code must cause test failures (Guidepost #12)
- Test data from shared fixtures, not hardcoded inline (Guidepost #13)

Because Workbench is a UI-first system, **browser tests are the primary acceptance gate**, supported by mock/unit tests and live integration tests.

Coverage completeness is verified by structural coverage tooling (`c8`) per WPR-103 §2.6, which measures line and branch coverage across the mock test suite. This replaces the former manual capability audit process.

---

## 1. Engineering Requirements Gate (ERQ-001)

Before functional testing begins, verify compliance with all ERQ-001 requirements. These are prerequisites, not optional. **All checks run against a fresh container rebuilt from scratch (WPR-103 §12b).**

### 1.1 Code Quality (ERQ-001 Section 1)

| ID | Check | Method | Pass Criteria |
|----|-------|--------|---------------|
| ENG-01 | Code formatting | Run project formatter (ESLint/Prettier) | Zero formatting errors |
| ENG-02 | Code linting | `npm run lint` (ESLint) | Zero lint errors or warnings |
| ENG-03 | Unit test execution | `npm test` | All tests pass, exit code 0 |
| ENG-04 | Version pinning | Inspect `package.json` | All dependencies use exact versions (no `^`, `~`, `>=`) |

### 1.2 Security Posture (ERQ-001 Section 2)

| ID | Check | Method | Pass Criteria |
|----|-------|--------|---------------|
| ENG-05 | No hardcoded secrets | `grep -rn` for common secret patterns (`API_KEY=`, `Bearer `, base64 tokens) across source, Dockerfiles, compose files | Zero matches in committed code |
| ENG-06 | Input validation | Two-part gate: (1) Automated — parameterized tests in §6.2 exercise input validation for all route handlers and MCP tools. (2) Manual review — one reviewer with backend experience reviews all 42 route handlers and 19 MCP tools against the input validation checklist below. Reviewer signs off with name + date in the traceability matrix. | All external inputs validated before use |
| ENG-07 | Null/None checking | Two-part gate: (1) Automated — ESLint `no-unsafe-optional-chaining` and `no-unused-expressions` rules enabled. (2) Manual review — same reviewer as ENG-06 reviews attribute access on nullable values. | All nullable values guarded |

**ENG-06/ENG-07 Manual Review Checklist:**

| # | Check |
|---|-------|
| 1 | Every `req.params.*`, `req.body.*`, `req.query.*` access has type/presence validation |
| 2 | Every MCP tool `arguments.*` access has type/presence validation |
| 3 | Filesystem paths derived from user input are validated before use (plan endpoints only per AD-001) |
| 4 | Numeric parameters are parsed and range-checked |
| 5 | String parameters have length limits enforced |

**Reviewer:** Must be a model that did not write the application code. Sign-off recorded as `ENG-06: [reviewer] [date]` and `ENG-07: [reviewer] [date]` in traceability matrix Notes column.

### 1.3 Logging and Observability (ERQ-001 Section 3)

| ID | Check | Method | Pass Criteria |
|----|-------|--------|---------------|
| ENG-08 | Structured JSON logging | Inspect `logger.js` output | JSON format, ISO 8601 timestamps, level field, one object per line |
| ENG-09 | No bare catch-all | Scan for bare `catch {}` or `catch (e) {}` with no body | Zero bare catch blocks. All 22 must be replaced with specific, contextual handling + structured logging |
| ENG-09a | Frontend error observability | Scan `public/index.html` for bare `catch {}` blocks | All frontend catch blocks must emit observable signals (console.error at minimum) so browser tests can detect and assert on error conditions. Silent catches make browser error-path tests impossible (Guidepost #4) |
| ENG-10 | Resource management | Code review of DB connections, file handles | All resources closed via try/finally, context managers, or equivalent |
| ENG-11 | Pipeline observability | Verify compaction verbose mode toggleable via config | `compaction.verbose` config option functions correctly |

**ENG-09 Remediation Authorization:** If the application code (WPR-104) still contains bare `catch {}` blocks when WPR-105 implementation begins, the test code author is explicitly authorized to refactor those blocks to throw/log observable errors in the same PR that adds the test. This is required by Guidepost #4 and must not block test implementation.

### 1.4 Async Correctness (ERQ-001 Section 4)

| ID | Check | Method | Pass Criteria |
|----|-------|--------|---------------|
| ENG-12 | No blocking I/O in async | Code review of all `async` functions | No `fs.readFileSync`, `execSync`, or other blocking calls in async paths |

### 1.5 Communication (ERQ-001 Section 5)

| ID | Check | Method | Pass Criteria |
|----|-------|--------|---------------|
| ENG-13 | Health endpoint | `GET /health` | Returns 200 with per-dependency status when healthy, 503 when unhealthy. Auth status is informational only (does not flip HTTP status) |

### 1.6 Resilience (ERQ-001 Section 6)

| ID | Check | Method | Pass Criteria |
|----|-------|--------|---------------|
| ENG-14 | Graceful degradation | Kill DB, verify server stays up | Server responds 503 on /health, does not crash |
| ENG-15 | Independent startup | Start server without DB file | Server binds port, reports degraded |
| ENG-16 | Idempotency | Call `ensureProject` twice with same data | No duplicate rows, no errors |
| ENG-17 | Fail fast on bad config | Corrupt `defaults.json`, start server | Process exits immediately with clear parse error message |

### 1.7 Configuration (ERQ-001 Section 7)

| ID | Check | Method | Pass Criteria |
|----|-------|--------|---------------|
| ENG-18 | Hot-reload config | Change `defaults.json` at runtime | Next operation uses new values without restart |
| ENG-19 | Externalized config | Automated scan: grep for hardcoded numeric/string constants that appear in `defaults.json`. Manual review for remaining config surface | All tuning parameters, prompts, thresholds, timeouts externalized in config |

### 1.8 Testability (Guidepost #10)

| ID | Check | Method | Pass Criteria |
|----|-------|--------|---------------|
| ENG-20 | Module importability | Attempt `require()` of each of the 14 application modules from a test harness | Every module can be imported and its exports exercised without launching the full server. Any module that cannot be imported must be refactored before test code can be written |

**Gate Failure Criteria:** Any violation blocks WPR-105 test code acceptance. No "we'll fix it later" exceptions.

---

## 2. Test Strategy: Two Layers

Per WPR-103 §2, the test plan defines a two-layer strategy. Each layer has sub-categories for practical execution.

### 2.0 Where tests run (host vs container)

**Tests must execute inside the deployed `${WORKBENCH_CONTAINER}` (or an HF Space's container), never on the host machine's shell.** Workbench dev/prod hosts (M5, irina, others) hold the live SQLite database, the live `secrets.env` (with real Slack/GitHub webhook URLs and API keys), an active qdrant instance, and a running tmux server. Importing any project module from the host shell shares all of those with the test process.

Concrete rules:

- **Disallowed on the host shell of any workbench-running machine:** `npm test`, `npm run test:coverage`, `npm run test:live`, `npm run test:browser`, `node --test`, `c8`, `nyc`, ad-hoc `node -e` that `require()`s any project module. This includes "mock" tests — they still bring up the in-process Express app and fire real webhooks. A prior incident on the prod host nearly killed the active conversation when an "in-process" test mutated the live DB and webhook targets.
- **Allowed:** Any of those commands run *inside* the container — e.g. `ssh ${WORKBENCH_HOST} 'docker exec -i ${WORKBENCH_CONTAINER} sh -c "cd /app && npm run test:coverage"'`. The container has its own DB, isolated webhooks (or a stub via test config), and its own tmux server.
- **Browser tests** can be exercised via the Playwright MCP server (driven from inside Claude Code) pointed at a deployed `${WORKBENCH_URL}` — an HF Space or the irina dev container. Playwright drives Chromium against HTTP and never imports server code, so MCP-mediated `browser_*` calls against the Space URL are safe. The `npm run test:browser` wrapper, by contrast, IS forbidden on the host shell — it spins up via Node.
- **Headed / visual checks** use Hymie or Hymie2 (remote desktops with real Firefox) against the deployed URL — required for bugs that depend on actual rendering rather than a headless DOM snapshot.
- **Coverage runs** the same way — inside the container, never on the host. The c8 thresholds in `package.json` (`--lines 80 --branches 70`) gate container-internal runs only.

If a test step or harness instruction in this plan implies a `node` command, assume "inside the container" unless it explicitly says otherwise.

### Layer 1: Mock Tests (Unit)

**Framework:** `node:test` (built-in) with mocks for external dependencies.

**Mock boundary -- what IS mocked:**
- tmux execution (`execFile` calls)
- Claude CLI calls
- PTY spawn (node-pty)
- File system events (where necessary for timing control)
- Timers (`Date.now()`, `setTimeout`) — use `test.mock.timers` for long-duration tests (e.g., MSG-07 1-hour bridge cleanup, WS-06 30s heartbeat)
- HTTP fetch calls (webhooks, embedding APIs)
- WebSocket connections
- Logger output streams

**Mock injection strategy:** Where the application uses dependency injection factories (e.g., `createCompaction({ safe, db, ... })`), mock tests must inject fake objects at the module boundary (e.g., passing a mocked `safe` object to `createCompaction`) rather than globally patching Node native internals. Where DI is not available, `test.mock.method()` on the imported module is acceptable. Global `child_process` patching is a last resort.

**What is NOT mocked:**
- Application logic -- all imports are real code from the application (Guidepost #1)
- Configuration parsing (real `config.js` with test config files)
- Input validation logic
- JSONL parsing
- Data shaping and state transitions

**Coverage:** Every exported function from every module. Every error path (including all 22 former bare-catch remediation paths), edge case, state transition, JSON parsing, token calculation, and input validation branch.

**12 modules each get dedicated test files:** `config.test.js`, `logger.test.js`, `db.test.js`, `safe-exec.test.js`, `session-utils.test.js`, `tmux-lifecycle.test.js`, `session-resolver.test.js`, `watchers.test.js`, `ws-terminal.test.js`, `keepalive.test.js`, `webhooks.test.js`, `server.test.js`. (Removed: `compaction.test.js`, `quorum.test.js`. Added coverage needed: `qdrant-sync.test.js`, `mcp-tools.test.js`.)

**`routes.test.js` scope:** This file contains route-level input validation tests only (missing params, invalid types, boundary values, path traversal). Domain logic tests belong in their domain files (e.g., session CRUD logic in `session-utils.test.js`). Scenarios assigned: ENG-06, ENG-07, PRJ-07, PRJ-08, SES-12, TSK-06, TSK-07, MSG-04..07, RTE-01, RTE-02, FS-06.

### Layer 2: Live Tests (Deployed Infrastructure)

**Framework:** Custom Node.js test harness for API tests, Playwright for browser tests.

**"Deployed" means:** Workbench running inside its Docker container (`docker-compose.test.yml`), with:
- Real SQLite database (fresh per gating run)
- Real filesystem (workspace volume)
- Real tmux sessions
- Real WebSocket connections
- Real browser (Chromium via Playwright)

**LLM stubbing for standard gating:** The `claude` CLI binary inside the test container is shadowed by a shell script that mimics Claude's filesystem behavior (creating JSONL files, responding to `--print`) unless running in the explicit "Non-Deterministic Quality" suite. This avoids API costs and non-determinism for the gating suite while still enabling optional authenticated smoke tests.

**Sub-categories:**

| Sub-category | What | When |
|-------------|------|------|
| Live/Integration | API endpoint tests against running container | Every gating run |
| Live/Browser | Playwright tests — primary acceptance gate | Every gating run |
| Live/Non-Deterministic | Real Claude CLI for quality evaluation | Nightly/manual |
| Live/Blocked External | Requires external API keys (GPT, Gemini) | Manual only |

### 2.1 Scenario Labeling

Every scenario is marked as **MOCK**, **LIVE**, **BROWSER**, or a combination. BROWSER is a sub-category of LIVE (runs against deployed infrastructure). In the traceability matrix, BROWSER is a distinct layer tag for filtering purposes.

### 2.2 Gating vs Non-Deterministic Suite Classification

| Suite | Claude CLI | When |
|-------|-----------|------|
| **Gate A: Mock/Unit** | N/A (mocked) | Always |
| **Gate B: Live Integration** | Stub script | Always |
| **Gate C: Browser Acceptance** | Stub script | Always |
| **Non-Deterministic Quality** | Real Claude API | On schedule or demand |
| **Blocked External** | N/A | When external API keys available |

**Scenarios requiring real Claude CLI (excluded from standard gate, included only in Non-Deterministic Quality suite):**

| Scenario ID | Reason |
|------------|--------|
| SES-10 | AI-generated session summary quality evaluation |
| CMP-42 | Git commit during prep phase (live portion) |
| ~~CMP-43~~ REMOVED | ~~Live smart compaction~~ |
| CMP-44 | Multiple compaction cycles with real compaction |
| CMP-45 | Compaction verbose mode with real pipeline |
| CST-09 | Cold recall quality evaluation |
| USR-06 | Session summary usability (judge >= 4/5) |
| QRM-09, QRM-10 | Quorum with real Claude juniors |

All other "Live" scenarios use the stub CLI and are part of the standard gating suite.

### 2.3 UI-* vs BRW-* Relationship

The plan contains two sets of browser scenario IDs:

- **UI-01 through UI-56 (§4.1.30–4.1.37):** Capability-level entries — one per discrete UI element or behavior. These are the canonical IDs for traceability.
- **BRW-01 through BRW-31 (§12.3):** Workflow-level entries — end-to-end user tasks that exercise multiple UI capabilities in sequence.

Where a BRW scenario exercises the same behavior as a UI scenario, the BRW test satisfies both. The traceability matrix maps both IDs to the same test file. A UI capability not exercised by any BRW workflow gets its own standalone test.

### 2.4 Standing Test Requirements

The following apply to all tests regardless of layer:

1. **Fixture-driven inputs:** Test data comes from shared fixture files or factories (`tests/fixtures/`), not hardcoded inline in test bodies. This enables reuse across test modules and makes test data maintenance tractable.

2. **Browser console capture (all browser tests):** Every Playwright test must attach a `page.on('console')` listener at setup. Any `console.error` or uncaught exception fails the test regardless of what else the test verifies. This is non-negotiable per WPR-105 review criteria.

3. **Real code imports:** Every test file must import from the application. No local reimplementation of business logic inside test files. If a test would still pass with the application code deleted, it is not a test.

---

## 3. Test Infrastructure

### 3.1 Isolation Strategy

| Concern | Production | Test |
|---------|-----------|------|
| Docker Compose project name | `workbench` | `workbench-test` |
| Network | `default` | `workbench-test_default` |
| Data volumes | `joshua26_workspace`, `joshua26_storage` | `workbench-test_workspace`, `workbench-test_storage` |
| Port binding | `7866:3000` | `7867:3000` |
| Database | `/data/.workbench/workbench.db` | Fresh DB per gating run |
| Container name | `workbench-workbench-1` | `workbench-test` |
| Environment | `WORKBENCH_DATA=/data/.workbench` | `WORKBENCH_DATA=/data/.workbench` |
| Outbound internet | Unrestricted | Blocked or routed to local stub server |
| MAX_TMUX_SESSIONS | 5 (default) | 10 (explicit in compose) |

A dedicated `docker-compose.test.yml` override file provides these isolation settings. No test points at production `.workbench`, `.claude`, workspace, or DB. The compose file is a prerequisite artifact that must be created before the first gating run.

**Outbound network isolation:** The `workbench-test` container must not make outbound internet requests during Gate B. DNS resolution for external hosts is blocked at the Docker network level or routed to a local stub. This ensures the gating suite never flakes due to external API latency or availability.

### 3.2 Configuration

| Component | Test Value | Rationale |
|-----------|-----------|-----------|
| Claude CLI model | `claude-haiku-4-5-20251001` | Fastest, cheapest for test automation |
| Compaction checker model | `claude-haiku-4-5-20251001` | Same |
| Summary model | `claude-haiku-4-5-20251001` | Same |
| Quorum lead model | `claude-haiku-4-5-20251001` | Same |
| MAX_TMUX_SESSIONS | 10 | Sufficient for tests, prevents runaway |
| TMUX_CLEANUP_MINUTES | 2 | Fast cleanup in test |
| Compaction thresholds | Default (65/75/85/90) | Test at documented thresholds |
| Keepalive mode | `always` | Ensure token stays fresh during test |

### 3.3 Data Loading

| Data | Source | Loading Method | Idempotency |
|------|--------|---------------|-------------|
| Test project | Local directory in test workspace | `POST /api/projects` with existence check | `ensureProject` is idempotent by design |
| ~~Test sessions~~ | ~~`scripts/prime-test-session.js`~~ REMOVED in #320 (Phase 0). Smart-compaction was removed in test plan v7.0; the priming script's only consumer was the smart-compaction stress tests, so both went together. Tests that need synthetic session data now generate it inline via `tests/fixtures/test-data.js` factories. | — |
| Seed tasks | `POST /api/projects/:name/tasks` | Created per test, cleaned up after | Each test uses unique task text |
| Compaction test data | Synthetic JSONL sized to trigger thresholds | `docker cp` prior to test | Script checks existing state |
| Webhook targets | Local HTTP echo server | Started as part of test harness | Stateless echo server |

**~~`prime-test-session.js` location~~** — REMOVED in #320 (Phase 0). See note in §3.3 above.

### 3.4 Test Fixtures

Deterministic fixtures are required for scenarios involving non-deterministic or timing-sensitive inputs:

| Fixture | Purpose | Format |
|---------|---------|--------|
| Stub Claude CLI responses | Session creation, summary | Shell script with configurable response files |
| ANSI-polluted PTY output | Auth URL detection (BRW-28, AUTH-ANSI-01..03) | Raw text files with real terminal control characters, cursor repositioning, color codes |
| Chunked WebSocket frames | Auth URL arriving fragmented across frames | Binary frame fixtures |
| Malformed JSONL | Concurrent write corruption, truncated lines | `.jsonl` files with known defects |
| Checker hallucination responses | Conversational text around JSON, wrong schema JSON | Text fixtures for `parseWorkbench` |
| File tree fixture | Drag-and-drop tests | Pre-created directory tree in test workspace |
| Stateful mock sequences | CMP-42 git commit path, compaction phase transitions | Ordered response arrays for sequential `capturePaneAsync` returns |
| xterm.js terminal content | Browser tests needing terminal text assertions | Use `page.evaluate(() => term.buffer.active.getLine(row).translateToString())` via the exposed xterm instance, not DOM text selectors. xterm.js fragments text across spans; DOM assertions will fail |

All fixtures live in `tests/fixtures/` and are imported by test modules. No test hardcodes data inline (§2.4).

### 3.5 Stack Lifecycle

For every gating run:

1. **Teardown:** `docker compose -p workbench-test down -v` (remove containers and volumes)
2. **Rebuild:** `docker compose -p workbench-test build --no-cache`
3. **Start:** `docker compose -p workbench-test up -d`
4. **Health wait:** Poll `GET http://localhost:7867/health` every 2s, timeout 120s. Require all dependency statuses healthy. Additionally verify: tmux is executable (`docker exec ... tmux -V`), `claude` stub/binary is on PATH, settings.json exists, workspace is writable
5. **Seed data:** Run data loading scripts against live container
6. **Run mock tests:** `npm test`
7. **Run live integration tests:** `npm run test:live`
8. **Run browser tests:** `npm run test:browser`
9. **Collect artifacts:** Docker logs, screenshots (every browser test per §3.12), DB snapshots, coverage reports
10. **Leave running** for debugging; explicit teardown before next gating run

**Watcher timing tolerance:** File-system watchers on Docker-mounted volumes may exhibit higher latency than native filesystem events. All watcher-dependent assertions (WAT-01, WAT-05, SET-03, SET-05, CFG-07, CFG-08, §11 hot-reload) must use eventually-consistent polling with a tolerance window (default 10s, configurable) rather than precise timing assertions. A watcher event arriving at 7s instead of 5s is not a failure; a watcher event not arriving within 10s is.

**Iterative development:** During iterative development, the fresh-container sequence (steps 1–4) may be skipped to speed iteration. The full sequence is mandatory for the final gating run only. The standard allows leaving the stack running for iteration (WPR-103 §2.4).

### 3.6 MCP Stdio Server Testing Methodology

The MCP stdio server (`mcp-server.js`) communicates via stdin/stdout, not HTTP. Tests are structured as follows:

- **Mock tests:** Import `mcp-server.js` functions directly, mock the HTTP fetch calls to Workbench's internal API
- **Live tests:** Spawn `mcp-server.js` as a child process via `child_process.spawn` inside the test container using `docker exec`. Write JSON-RPC messages to stdin, read responses from stdout. The stdio server calls Workbench's HTTP API internally, so the live Workbench container must be running

### 3.7 ~~prime-test-session.js Self-Test~~ — REMOVED

This section was removed in #320 (Phase 0) along with `scripts/prime-test-session.js` itself. Smart-compaction tests (the script's only consumer) were removed in test plan v7.0. UTIL-01 and UTIL-02 are no longer applicable.

### 3.8 Test Tooling

| Category | Tool |
|---|---|
| Test runner | `node:test` |
| Structural coverage | `c8` |
| Browser automation | `playwright` |
| HTTP testing | `fetch` (native) |
| Mocking | `node:test` mock API |
| Linting | `eslint` |
| Formatting | `prettier` |

### 3.9 Coverage Gating

Three thresholds, applied independently. **All three must pass for the gate to clear.**

| Layer | Threshold | Measurement |
|---|---|---|
| Mock (structural) | **≥ 85% lines, ≥ 70% branches** | `c8` over `tests/mock/*.test.js`, run inside the deployed container. Tracks how much of the codebase is exercised by the unit suite. |
| Live (feature) | **100% of features** | Every API endpoint, every MCP tool (currently 45), every backend feature in §15 must have at least one PASS row in `tests/live/`. Functional coverage, not line coverage. |
| UI (feature) | **100% of features** | Every UI surface in §5 of the UI plan, every user-visible feature, every settings field, every dialog must have at least one PASS row in `tests/browser/` (or runbook UI phase). |

**The "100% feature coverage" gate is not negotiable.** A feature without a live AND a UI test (where each layer applies) is a coverage failure. Don't ship features without both.

The 85% mock threshold reflects that some defensive branches and trivial error paths aren't worth dedicated unit tests. The 100% feature thresholds reflect repeated incidents (most cited: a 785-test suite that caught zero of 38 filed bugs — see §0) where line coverage was high but features still shipped broken because the tests covered the easy paths and skipped user-visible ones.

Reporting rule: report the actual count, not a rounded percentage. "44 of 45 MCP tools have a live PASS row, 1 outstanding" beats "~98% covered" — the gate fails the moment you can name an untested feature.

### 3.10 Baseline Reset Protocol

**Purpose:** Prevent inter-test state poisoning during a single gating run. A fresh container ensures clean state at the start, but tests within a run can accumulate state that affects later tests.

**Implementation:** A shared `tests/helpers/reset-state.js` module provides a `resetBaseline()` function called by every live and browser test suite in `beforeEach()` or equivalent setup hooks.

**What it resets:**

| Layer | Reset Actions |
|-------|--------------|
| Live/API | Delete test-created sessions (by naming convention `test_*`), delete test-created tasks, delete test-created projects (except seed project), truncate messages table, remove bridge files, kill orphaned `wb_test_*` tmux sessions |
| Browser | All of the above, plus: dismiss open modals/overlays, close all tabs except first, navigate to base URL, clear `localStorage` test keys |

**Principle:** Every test must succeed or fail on its own merit, never because a previous test left debris.

### 3.11 Stub Claude CLI Contract

The stub CLI is the most critical test infrastructure artifact for the standard gate. It must replicate the following behaviors:

| Behavior | Stub Implementation |
|----------|-------------------|
| JSONL creation | Write a `.jsonl` file with valid structure including assistant usage blocks after invocation |
| Session resolution | Create file within the polling window so `session-resolver.js` can find it |
| Usage blocks | Include realistic `input_tokens`/`output_tokens` values in assistant message usage |
| `--print` response | Return non-empty text to stdout |
| Compaction checker replies | Return valid `{"workbench": "..."}` JSON lines from configurable response files |
| Auth prompt emission | Write ANSI-formatted OAuth URL to stdout (for auth flow tests) |
| Exit codes | Exit 0 on success, non-zero on configured failure |
| Configurable responses | Read response from `$STUB_RESPONSE_FILE` environment variable or fixture path |

The stub is a shell script at `tests/fixtures/stub-claude.sh`, volume-mounted into the test container and placed on PATH before the real `claude` binary.

### 3.12 Visual Review Protocol

Per WPR-105 §4.5, every browser test must produce a screenshot for automated visual review.

**Screenshot capture:** Every browser test captures a screenshot at completion, saved to `tests/browser/screenshots/`. Filename format: `{suite}--{test_name}.png`.

**Automated visual review:** After the browser test suite completes, a script invokes a lightweight model (`claude-haiku-4-5-20251001`) to review each screenshot against:

1. **Test-specific expectations** — the reviewer reads the test code to understand what the test claims to verify, then checks the screenshot matches that intent.

2. **Generic visual checklist:**
   - Broken layout (overlapping, clipped, or missing elements)
   - Wrong font sizes (too big, too small, inconsistent)
   - Error messages visible in terminal, status bar, or console
   - Modals or overlays blocking content unexpectedly
   - Test data pollution (junk names, orphaned sessions, debug text)
   - Empty areas where content should exist
   - Unreadable text (contrast, truncation)
   - Scrollbar anomalies
   - Inconsistent theme

**Rating:** Each screenshot receives OK, WARNING, or PROBLEM. Problems are filed as GitHub Issues. The visual review is part of Gate C — browser tests do not pass the gate if visual PROBLEM findings exist.

---

## 4. Coverage Targets

**Target: zero NONE entries.** All capabilities must be REAL or MOCK. All statuses are currently NONE because this is a new test suite being built from scratch. Each NONE entry becomes a test scenario to implement.

Coverage completeness is enforced by structural coverage tooling (`c8`) per §3.9, which provides an objective, automated measure of line and branch coverage across the mock test suite.

**Master Capability Domains (aggregated across four independent model plans):**

1. Server lifecycle and composition (`server.js`)
2. Configuration load and hot-reload (`config.js`)
3. Structured logging (`logger.js`)
4. SQLite persistence and schema (`db.js`)
5. Safe execution wrappers (`safe-exec.js`)
6. Session metadata parsing, search, summary, token usage (`session-utils.js`)
7. Tmux lifecycle and cleanup (`tmux-lifecycle.js`)
8. Temp-session resolution (`session-resolver.js`)
9. File watchers and settings watchers (`watchers.js`)
10. WebSocket terminal bridge (`ws-terminal.js`)
11. Smart compaction orchestration (`compaction.js`)
12. Core HTTP routes (`routes.js`)
13. MCP internal tools (`mcp-tools.js`)
14. MCP external/admin tools (`mcp-external.js`)
15. MCP stdio server (`mcp-server.js`)
16. ~~OpenAI-compatible~~ REMOVED
17. ~~Quorum~~ REMOVED
18. Qdrant vector search (`qdrant-sync.js`) — NEW
18. Webhooks (`webhooks.js`)
19. Browser UI shell and workflows (`public/index.html`)
20. Health and degradation semantics
21. Auth/login UX and keepalive (`keepalive.js`)
22. Docker entrypoint and container bootstrap
23. Context stress and compaction threshold pipeline
24. Shared state management (`shared-state.js`)

### 4.1 Capability Inventory

#### 4.1.1 Server Lifecycle (`server.js`)

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| SRV-01 | Server starts and binds to PORT | Live | NONE |
| SRV-02 | Static file serving (public/, xterm, codemirror) | Live | NONE |
| SRV-03 | WebSocket upgrade on `/ws/:tmuxSession` | Live | NONE |
| SRV-04 | Startup sequence (config init, watcher start, orphan cleanup) | Live | NONE |
| SRV-05 | Graceful error handling (uncaughtException exits, unhandledRejection logs) | Mock | NONE |
| SRV-06 | MAX_TMUX_SESSIONS enforcement | Mock + Live | NONE |
| SRV-07 | TMUX_CLEANUP_DELAY scheduling | Mock | NONE |

#### 4.1.2 Configuration (`config.js`)

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| CFG-01 | Sync defaults load on require | Mock | NONE |
| CFG-02 | Fail-fast on corrupt defaults.json | Mock + Live | NONE |
| CFG-03 | Missing defaults file (no crash, empty cache) | Mock | NONE |
| CFG-04 | Dot-path fallback behavior | Mock | NONE |
| CFG-05 | Prompt template loading with variable substitution | Mock | NONE |
| CFG-06 | Missing prompt file (empty string, warning) | Mock | NONE |
| CFG-07 | Hot-reload of defaults.json | Live | NONE |
| CFG-08 | Hot-reload of prompt template files | Live | NONE |
| CFG-09 | Hot-reload retains last good state on corrupt JSON | Mock | NONE |

#### 4.1.3 Logger (`logger.js`)

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| LOG-01 | JSON output format with timestamp, level, message, context | Mock | NONE |
| LOG-02 | ERROR level writes to stderr | Mock | NONE |
| LOG-03 | LOG_LEVEL environment variable filtering | Mock | NONE |
| LOG-04 | Reserved fields not overwritten by context | Mock | NONE |

#### 4.1.4 Database (`db.js`)

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| DB-01 | Schema creation (6 tables) on fresh DB | Mock + Live | NONE |
| DB-02 | Idempotent migrations (ALTER TABLE) | Mock | NONE |
| DB-03 | Project CRUD (ensure, get, delete) | Mock + Live | NONE |
| DB-04 | Session CRUD (upsert, get, rename, delete, state change) | Mock + Live | NONE |
| DB-05 | Task CRUD (add, complete, reopen, delete, list) | Mock + Live | NONE |
| DB-06 | Message CRUD (send, get unread, get recent, mark read) | Mock + Live | NONE |
| DB-07 | Settings CRUD (get, set, getAll with JSON/raw fallback) | Mock + Live | NONE |
| DB-08 | Session meta cache (upsert, get, clean stale) | Mock | NONE |
| DB-09 | Foreign key cascade (delete project cascades) | Mock + Live | NONE |
| DB-10 | Session lookup by prefix | Mock | NONE |
| DB-11 | Session full retrieval with project join | Mock | NONE |
| DB-12 | Concurrent write safety (WAL mode, `lockedAppend` serialization) | Mock + Live | NONE |

#### 4.1.5 Safe Execution (`safe-exec.js`)

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| SAF-01 | `resolveProjectPath` joins WORKSPACE correctly | Mock | NONE |
| SAF-02 | `sanitizeTmuxName` strips non-alphanumeric | Mock | NONE |
| SAF-03 | `shellEscape` prevents injection | Mock | NONE |
| SAF-04 | `claudeExecAsync` timeout handling | Mock | NONE |
| SAF-05 | `tmuxExecAsync` error propagation | Mock | NONE |
| SAF-06 | `findSessionsDir` encodes project path correctly | Mock | NONE |
| SAF-07 | `gitCloneAsync` with valid/invalid URLs | Mock | NONE |
| SAF-08 | `tmuxKill` ignores expected missing-session errors | Mock | NONE |
| SAF-09 | `tmuxSendKeysAsync` temp-file lifecycle (write, load, paste, Enter, cleanup) | Mock | NONE |
| SAF-10 | `grepSearchAsync` returns capped results with fallback | Mock | NONE |
| SAF-11 | `curlFetchAsync` truncation and fallback | Mock | NONE |

#### 4.1.6 Session Utilities (`session-utils.js`)

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| SU-01 | Parse JSONL metadata (name, timestamp, messageCount) | Mock | NONE |
| SU-02 | Cache hit avoids reparse (mtime/size unchanged) | Mock | NONE |
| SU-03 | Summary entry overrides name | Mock | NONE |
| SU-04 | Malformed JSONL lines tolerated | Mock | NONE |
| SU-05 | Search sessions across projects | Live | NONE |
| SU-06 | Search respects project filter | Live | NONE |
| SU-07 | Summarize session uses configured model/prompt | Mock | NONE |
| SU-08 | Summarize session fallback on Claude failure | Mock | NONE |
| SU-09 | Token usage extraction from last assistant usage block | Mock | NONE |
| SU-10 | Token usage ignores synthetic/system models | Mock | NONE |
| SU-11 | Token max switches by model context size | Mock | NONE |
| SU-12 | Session slug extraction | Mock | NONE |

#### 4.1.7 Tmux Lifecycle (`tmux-lifecycle.js`)

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| TMX-01 | Tmux session name generation (`wb_` + 12 chars) | Mock | NONE |
| TMX-02 | Tmux session existence check | Mock + Live | NONE |
| TMX-03 | Tmux session creation (Claude) | Live | NONE |
| TMX-04 | Tmux session creation (bash) | Live | NONE |
| TMX-05 | Tmux session kill | Live | NONE |
| TMX-06 | Scheduled cleanup after idle timeout | Mock | NONE |
| TMX-07 | Cancel scheduled cleanup on reconnect | Mock | NONE |
| TMX-08 | Enforce MAX_TMUX_SESSIONS limit (kill oldest) | Mock + Live | NONE |
| TMX-09 | Clean orphaned sessions at startup | Live | NONE |
| TMX-10 | Clean stale bridge files at startup (>2hr old) | Mock | NONE |
| TMX-11 | Send keys to tmux session (buffer paste) | Live | NONE |
| TMX-12 | Send named key (e.g., BTab) | Live | NONE |

#### 4.1.8 Session Resolver (`session-resolver.js`)

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| RES-01 | Temp session resolves to new JSONL file (DB migration + tmux rename) | Mock + Live | NONE |
| RES-02 | Resolution preserves notes/rename/state | Mock | NONE |
| RES-03 | Pending resolution idempotency (duplicate requests suppressed) | Mock | NONE |
| RES-04 | Timeout with dead tmux deletes temp session | Mock | NONE |
| RES-05 | Timeout with live tmux leaves temp session | Mock | NONE |
| RES-06 | Startup stale temp-session reconciliation | Mock + Live | NONE |
| RES-07 | Startup removes orphaned temp sessions when no sessions dir | Mock | NONE |
| RES-08 | Concurrent JSONL creation race (multiple `.jsonl` files from concurrent Claude processes) | Mock | NONE |

#### 4.1.9 Watchers (`watchers.js`)

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| WAT-01 | JSONL watcher starts on session open, pushes token updates via WS | Live | NONE |
| WAT-02 | JSONL watcher triggers compaction-check callback | Live | NONE |
| WAT-03 | JSONL watcher debounces rapid changes | Mock | NONE |
| WAT-04 | Stop watcher removes fs watch and timer | Mock | NONE |
| WAT-05 | Settings watcher detects changes (5s poll), broadcasts via WS | Live | NONE |
| WAT-06 | Settings watcher tolerates ENOENT and malformed JSON | Live | NONE |
| WAT-07 | Compaction monitor scans sessions not already watched | Live | NONE |
| WAT-08 | `registerMcpServer` writes expected config (creates/updates path) | Live | NONE |
| WAT-09 | `trustProjectDirs` marks all DB project paths trusted | Live | NONE |
| WAT-10 | `ensureSettings` bootstraps settings file | Live | NONE |
| WAT-11 | JSONL watcher stop on session close | Live | NONE |
| WAT-12 | Watcher survives session resolution rename (old watcher stops, new path watched) | Mock + Live | NONE |
| WAT-13 | Large JSONL parse resilience — watcher handles sudden large file without OOM/crash | Live | NONE |

#### 4.1.10 WebSocket Terminal (`ws-terminal.js`)

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| WS-01 | WebSocket connection to terminal (reject nonexistent tmux) | Live | NONE |
| WS-02 | PTY spawn via node-pty (tmux attach) | Live | NONE |
| WS-03 | Bidirectional data flow (input/output) | Live | NONE |
| WS-04 | Terminal resize handling | Mock + Live | NONE |
| WS-05 | Backpressure (pause PTY at 1MB buffer, resume at 512KB) | Mock | NONE |
| WS-06 | Ping/pong heartbeat (30s interval) | Mock + Live | NONE |
| WS-07 | Cleanup on disconnect (PTY kill, browser count, schedule cleanup) | Mock + Live | NONE |
| WS-08 | Token usage forwarded via WS | Mock + Live | NONE |
| WS-09 | Settings updates forwarded via WS | Mock + Live | NONE |
| WS-10 | PTY spawn failure handling (node-pty fails to attach) | Mock | NONE |
| WS-11 | Browser connect/disconnect updates keepalive hooks | Mock | NONE |

Note: Browser-side auto-reconnect with exponential backoff is covered by UI-55 / BRW-21 in the Browser layer, not here. WS-10 tests the server-side PTY failure path.

#### 4.1.11 Authentication & Keepalive (`keepalive.js`)

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| AUTH-01 | Auth status check (credential validation) | Live | NONE |
| AUTH-02 | Auth login trigger | Live | NONE |
| AUTH-03 | `GET /api/keepalive/status` returns token expiry, mode, and state | Live | NONE |
| AUTH-04 | `PUT /api/keepalive/mode` validates mode is one of `['always', 'browser', 'idle']` (400 on invalid) | Live | NONE |
| AUTH-05 | `PUT /api/keepalive/mode` validates `idleMinutes` is number between 1 and 1440 (400 on out-of-range) | Live | NONE |
| KA-01 | Credentials expiry parsing | Mock | NONE |
| KA-02 | Missing credentials file returns zero expiry | Mock | NONE |
| KA-03 | Malformed credentials logs warning and degrades gracefully | Mock | NONE |
| KA-04 | Schedule from remaining expiry (randomized range) | Mock | NONE |
| KA-05 | Expired token triggers immediate refresh | Mock | NONE |
| KA-06 | Refresh alternates question/fact turns | Mock | NONE |
| KA-07 | Keepalive start/stop semantics | Mock | NONE |
| KA-08 | Browser mode starts/stops with browser count | Mock | NONE |
| KA-09 | Idle mode timeout shutdown | Mock | NONE |
| KA-10 | Status payload formatting (token expiry, mode) | Mock + Live | NONE |

#### 4.1.12 Smart Compaction Pipeline (`compaction.js`)

This is the highest-risk subsystem. It requires both granular stage tests and full end-to-end verification.

**Helper/parser tests:**

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| CMP-01 | ANSI escape code stripping | Mock | NONE |
| CMP-02 | Workbench JSON parsing (valid line) | Mock | NONE |
| CMP-03 | Workbench JSON parsing (malformed) | Mock | NONE |
| CMP-03a | Workbench JSON parsing (hallucinated conversational text around JSON, valid JSON with wrong schema) | Mock | NONE |
| CMP-04 | Agent message extraction removes workbench lines | Mock | NONE |

**Context setup tests:**

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| CMP-05 | Context tail file generation from JSONL | Mock | NONE |
| CMP-06 | Tail generation tolerates malformed lines | Mock | NONE |
| CMP-07 | Missing history creates placeholder tail file | Mock | NONE |

**Checker/session helper tests:**

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| CMP-08 | Checker command composition (resume/no-resume) | Mock | NONE |
| CMP-09 | Checker session ID resolution heuristic | Mock | NONE |
| CMP-10 | Read latest assistant text from JSONL | Mock | NONE |

**PREP phase tests:**

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| CMP-11 | Enter plan mode success | Mock | NONE |
| CMP-12 | Enter plan mode timeout | Mock | NONE |
| CMP-13 | Plan file copy success | Mock | NONE |
| CMP-14 | Prep phase successful ready-to-compact path (8-element checklist complete) | Mock | NONE |
| CMP-15 | Prep phase checker init failure | Mock | NONE |
| CMP-16 | Prep phase handles `read_plan_file` | Mock | NONE |
| CMP-17 | Prep phase handles `exit_plan_mode` and git prompt | Mock | NONE |
| CMP-18 | Prep phase returns tmux-died error | Mock | NONE |
| CMP-19 | Prep phase max-turns reached (10 turns) | Mock | NONE |

**COMPACT phase tests:**

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| CMP-20 | Compact sends /compact command | Mock | NONE |
| CMP-21 | Compact detects prompt return and completes | Mock | NONE |
| CMP-22 | Compact logs progress while waiting | Mock | NONE |
| CMP-23 | Compact handles dead tmux session | Mock | NONE |
| CMP-24 | Compact timeout handling (300s default) | Mock | NONE |

**RECOVERY phase tests:**

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| CMP-25 | Recovery sends resume prompt | Mock | NONE |
| CMP-26 | Recovery completes on `resume_complete` | Mock | NONE |
| CMP-27 | Recovery max-turn behavior (6 turns) | Mock | NONE |

**Threshold and nudge tests:**

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| CMP-28 | No action for `new_` temp sessions | Mock | NONE |
| CMP-29 | Advisory threshold (65%) sends nudge once | Mock + Live | NONE |
| CMP-30 | Warning threshold (75%) sends nudge once | Mock + Live | NONE |
| CMP-31 | Urgent threshold (85%) sends nudge once | Mock + Live | NONE |
| CMP-32 | Auto threshold (90%) schedules auto-compaction once | Mock + Live | NONE |
| CMP-33 | State map eviction behavior | Mock | NONE |
| CMP-34 | JSONL missing during compaction-needs check tolerated | Mock | NONE |
| CMP-46 | Auto-compaction timer is `.unref()`'d (does not prevent process exit) | Mock | NONE |
| CMP-47 | Below-threshold 64% — no nudge triggered | Mock | NONE |
| CMP-48 | Below-threshold 74% — no nudge triggered | Mock | NONE |
| CMP-49 | Below-threshold 84% — no nudge triggered | Mock | NONE |
| CMP-50 | Below-threshold 89% — no auto-compaction triggered | Mock | NONE |

**Orchestration tests:**

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| CMP-35 | Full orchestration success (PREP -> COMPACT -> RECOVERY) | Mock | NONE |
| CMP-36 | Invalid session ID rejected | Mock | NONE |
| CMP-37 | Temp session returns non-compacted | Mock | NONE |
| CMP-38 | Session-not-running returns non-compacted | Mock | NONE |
| CMP-39 | Compaction lock prevents concurrent second run | Mock | NONE |
| CMP-40 | Cleanup timer removes tail file | Mock + Live | NONE |
| CMP-41 | Prompt template variable substitution (PERCENT, AUTO_THRESHOLD, CONVERSATION_TAIL_FILE) | Mock | NONE |
| CMP-42 | Git commit during prep phase | Mock + Live | NONE |

**Live integration tests:**

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| CMP-43 | ~~Live smart compaction~~ REMOVED | — | — |
| CMP-44 | Multiple compaction cycles reset threshold state correctly | Live (Non-Det) | NONE |
| CMP-45 | Compaction verbose mode emits detailed stage logs | Live (Non-Det) | NONE |

#### 4.1.13 Project Management

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| PRJ-01 | Add project (local path) | Live | NONE |
| PRJ-02 | Add project (git clone) | Live | NONE |
| PRJ-03 | Remove project | Live | NONE |
| PRJ-04 | List projects via `/api/state` | Live | NONE |
| PRJ-05 | Project notes CRUD | Live | NONE |
| PRJ-06 | Project CLAUDE.md read/write (with template bootstrap) | Live | NONE |
| PRJ-07 | Project path validation (rejects invalid paths) | Mock | NONE |
| PRJ-08 | Duplicate project name handling (idempotent) | Mock | NONE |

#### 4.1.14 Global CLAUDE.md

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| GCM-01 | `GET /api/claude-md/global` returns content or empty string on ENOENT | Live | NONE |
| GCM-02 | `PUT /api/claude-md/global` writes content, returns `{saved: true}` | Live | NONE |

#### 4.1.15 Session Management

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| SES-01 | Create Claude session (with prompt) | Live | NONE |
| SES-02 | Create Claude session (without prompt) | Live | NONE |
| SES-03 | Create bash terminal session | Live | NONE |
| SES-04 | Resume/reattach session | Live | NONE |
| SES-05 | Rename session (writes to JSONL) | Live | NONE |
| SES-06 | Session state transitions (active/archived/hidden) via config and archive endpoint | Live | NONE |
| SES-07 | Session config CRUD (name, state, notes) | Live | NONE |
| SES-08 | Session notes CRUD | Live | NONE |
| SES-09 | Session search (full-text across JSONL) | Live | NONE |
| SES-10 | AI-generated session summary | Live (Non-Det) | NONE |
| SES-11 | Token usage retrieval | Live | NONE |
| SES-12 | Session ID validation (rejects invalid format, path traversal) | Mock | NONE |
| SES-13 | Session ID resolution (temp ID to real JSONL) | Mock + Live | NONE |
| SES-14 | Stale session resolution at startup | Mock | NONE |
| SES-15 | JSONL parsing (name, timestamp, messageCount extraction) | Mock | NONE |
| SES-16 | Session metadata caching (session_meta table) | Mock | NONE |
| SES-17 | Session list building with JSONL enrichment | Live | NONE |
| SES-18 | Prompt injection delay (`session.promptInjectionDelayMs`) | Live | NONE |
| SES-19 | Session slug extraction from JSONL | Mock | NONE |
| SES-20 | Rename with missing JSONL silently tolerates ENOENT | Mock + Live | NONE |
| SES-21 | Deleted/archived session does not reappear in `/api/state` (anti-zombie) | Live | NONE |
| SES-22 | DELETE /api/sessions/:id explicit CRUD (200, DB absent, tmux absent) | Mock + Live | NONE |

#### 4.1.16 Task System

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| TSK-01 | Add task to project | Live | NONE |
| TSK-02 | Complete task | Live | NONE |
| TSK-03 | Reopen task | Live | NONE |
| TSK-04 | Delete task | Live | NONE |
| TSK-05 | List tasks for project | Live | NONE |
| TSK-06 | Task text validation (max 1000 chars) | Mock | NONE |
| TSK-07 | Task created_by field | Mock | NONE |

#### 4.1.17 Messaging System — REMOVED

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| MSG-01 | ~~Send inter-session message~~ REMOVED | — | — |
| MSG-02 | ~~Bridge file delivery to tmux session~~ REMOVED | — | — |
| MSG-03 | ~~Get recent messages~~ REMOVED | — | — |
| MSG-04 | ~~Message content validation (max 100KB)~~ REMOVED | — | — |
| MSG-05 | ~~Unread message retrieval~~ REMOVED | — | — |
| MSG-06 | ~~Mark message read~~ REMOVED | — | — |
| MSG-07 | ~~Bridge file cleanup (delivered: 5s, undelivered: 1hr)~~ REMOVED | — | — |

#### 4.1.18 Settings System

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| SET-01 | Get all settings (with defaults merge) | Live | NONE |
| SET-02 | Update individual setting | Live | NONE |
| SET-03 | Settings watcher broadcasts via WebSocket | Live | NONE |
| SET-04 | Default values from `config/defaults.json` | Mock | NONE |
| SET-05 | Hot-reload of config files (5s poll) | Live | NONE |
| SET-06 | Prompt template loading with variable substitution | Mock | NONE |
| SET-07 | Config `get()` with dot-path traversal | Mock | NONE |
| SET-08 | Config fail-fast on corrupt JSON | Mock | NONE |

#### 4.1.19 Filesystem Operations

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| FS-01 | List mounts (`/api/mounts`) | Live | NONE |
| FS-02 | Browse directories (`/api/browse`, hides dot dirs) | Live | NONE |
| FS-03 | Read file contents (`/api/file`, max 1MB) | Live | NONE |
| FS-04 | jQuery File Tree connector | Live | NONE |
| FS-05 | File size limit enforcement (1MB → 413) | Mock + Live | NONE |
| FS-06 | Path traversal prevention on plan endpoints only. Per AD-001, `/api/file` and `/api/browse` intentionally provide full filesystem access | Mock + Live | NONE |

#### 4.1.20 MCP Tools (Internal -- `mcp-tools.js`)

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| MCP-01 | List internal MCP tools (`GET /api/mcp/tools`) | Live | NONE |
| MCP-02 | Call internal MCP tool (`POST /api/mcp/call`) | Live | NONE |
| MCP-03 | Plan path traversal protection (symlink-safe, realpath) | Mock + Live | NONE |
| MCP-04 | MCP session ID validation | Mock | NONE |
| MCP-05 | MCP task ID validation | Mock | NONE |
| MCP-06a | `workbench_search_sessions` — valid query returns results, empty query returns empty | Live | NONE |
| MCP-06b | `workbench_summarize_session` — valid session returns summary text | Live | NONE |
| MCP-06c | `workbench_list_sessions` — returns session list for project | Live | NONE |
| MCP-06d | ~~`workbench_get_project_notes`~~ REMOVED | — | — |
| MCP-06e | ~~`workbench_get_session_notes`~~ REMOVED | — | — |
| MCP-06f | `workbench_get_tasks` — returns task list | Live | NONE |
| MCP-06g | `workbench_add_task` — creates task, verify DB row | Live | NONE |
| MCP-06h | `workbench_complete_task` — marks complete | Live | NONE |
| MCP-06i | `workbench_get_project_claude_md` — returns CLAUDE.md content | Live | NONE |
| MCP-06j | ~~`workbench_read_plan`~~ REMOVED | — | — |
| MCP-06k | ~~`workbench_update_plan`~~ REMOVED | — | — |
| MCP-06l | `workbench_set_session_config` — updates config, verify DB | Live | NONE |
| MCP-06m | `workbench_reopen_task` — reopens completed task | Live | NONE |
| MCP-06n | `workbench_delete_task` — deletes task, verify DB | Live | NONE |
| MCP-06o | `workbench_set_project_notes` — sets notes, verify DB | Live | NONE |
| MCP-06p | `workbench_set_session_notes` — sets session notes | Live | NONE |
| MCP-06q | `workbench_get_token_usage` — returns token usage data | Live | NONE |
| MCP-07 | Content-length limits enforced | Live | NONE |
| MCP-08 | ~~`workbench_send_message`~~ REMOVED | — | — |
| MCP-09 | ~~`workbench_smart_compaction`~~ REMOVED | — | — |
| MCP-10 | ~~`workbench_ask_quorum`~~ REMOVED | — | — |

#### 4.1.21 MCP Tools (External/Admin -- `mcp-external.js`) — REMOVED

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| MCX-01 | ~~List external tools (internal + admin)~~ REMOVED | — | — |
| MCX-02 | ~~Fallback to admin-only when internal fetch fails~~ REMOVED | — | — |
| MCX-03 | ~~External call proxies internal tools~~ REMOVED | — | — |
| MCX-04 | ~~`workbench_create_session` admin tool~~ REMOVED | — | — |
| MCX-05 | ~~`workbench_set_session_state` admin tool~~ REMOVED | — | — |
| MCX-06 | ~~`workbench_get_token_usage` admin tool~~ REMOVED | — | — |
| MCX-07 | ~~`workbench_set_project_notes` admin tool~~ REMOVED | — | — |
| MCX-08 | ~~`workbench_set_project_claude_md` admin tool~~ REMOVED | — | — |
| MCX-09 | ~~`workbench_list_projects` admin tool~~ REMOVED | — | — |
| MCX-10 | ~~`workbench_update_settings` admin tool (with key validation)~~ REMOVED | — | — |
| MCX-11 | ~~Unknown tool name returns error~~ REMOVED | — | — |

#### 4.1.22 MCP Servers API

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| MCS-API-01 | `GET /api/mcp-servers` returns servers object from settings.json | Live | NONE |
| MCS-API-02 | `GET /api/mcp-servers` returns `{servers: {}}` on ENOENT or malformed JSON | Live | NONE |
| MCS-API-03 | `PUT /api/mcp-servers` merges `mcpServers` into settings.json (does not overwrite) | Live | NONE |

#### 4.1.23 MCP Stdio Server (`mcp-server.js`)

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| MCS-01 | JSON-RPC `initialize` returns protocol version | Mock + Live | NONE |
| MCS-02 | `tools/list` returns all 44 flat tools grouped by file_/session_/project_/task_ prefix | Mock | NONE |
| MCS-03 | `tools/call` delegates to Workbench HTTP API | Live | NONE |
| MCS-04a | `file_list` | Live | PASS |
| MCS-04b | `file_read` | Live | PASS |
| MCS-04c | `file_find` | Live | PASS |
| MCS-04d | `file_create` | Live | PASS |
| MCS-04e | `file_update` | Live | PASS |
| MCS-04f | `file_delete` | Live | PASS |
| MCS-04g | `file_search_documents` | Live | PASS |
| MCS-04h | `file_search_code` | Live | PASS |
| MCS-04i | `session_list` | Live | PASS |
| MCS-04j | `session_new` (claude) | Live | PASS |
| MCS-04k | `session_new` (gemini) | Live | PASS |
| MCS-04l | `session_new` (codex) | Live | PASS |
| MCS-04m | `session_connect` (by id) | Live | PASS |
| MCS-04n | `session_connect` (by query) | Live | PASS |
| MCS-04o | `session_restart` | Live | PASS |
| MCS-04p | `session_config` | Live | PASS |
| MCS-04q | `session_info` | Live | PASS |
| MCS-04r | `session_summarize` | Live | PASS |
| MCS-04s | `session_prepare_pre_compact` | Live | PASS |
| MCS-04t | `session_resume_post_compact` | Live | PASS |
| MCS-04u | `session_find` (claude filter) | Live | PASS |
| MCS-04v | `session_find` (all CLIs) | Live | PASS |
| MCS-04w | `session_search` | Live | PASS |
| MCS-04x | `project_mcp_register` | Live | PASS |
| MCS-04y | `project_mcp_unregister` | Live | PASS |
| MCS-04z | `project_mcp_enable` | Live | PASS |
| MCS-04aa | `project_mcp_disable` | Live | PASS |
| MCS-04ab | `project_mcp_list` | Live | PASS |
| MCS-04ac | `project_mcp_list_enabled` | Live | PASS |
| MCS-04ad | `task_find` | Live | PASS |
| MCS-04ae | `task_add` | Live | PASS |
| MCS-04af | `task_update {status:'done'}` | Live | PASS |
| MCS-04ag | `task_update {status:'todo'}` | Live | PASS |
| MCS-04ah | `task_update {status:'archived'}` | Live | PASS |
| MCS-04ai | `task_move` | Live | PASS |
| MCS-04aj | `task_update` | Live | PASS |
| MCS-05 | Invalid tool name returns error | Mock | NONE |
| MCS-06 | Malformed JSON-RPC request handling | Mock | NONE |
| MCS-07 | `notifications/initialized` no-op | Live | NONE |

#### 4.1.24 OpenAI-Compatible API — REMOVED

`openai-compat.js` deleted. OAI-01..11 permanently removed.

#### 4.1.25 Quorum System — REMOVED

`quorum.js` deleted. QRM-01..15 permanently removed.

#### 4.1.25a Qdrant Vector Search (`qdrant-sync.js`) — NEW

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| QDR-01 | Qdrant health check | Live | NONE |
| QDR-02 | Collection creation with per-collection dims | Live | NONE |
| QDR-03 | Document file sync (scan, embed, upsert) | Live | NONE |
| QDR-04 | Session file sync (JSONL parsing, chunking, embed) | Live | NONE |
| QDR-05 | Vector search returns ranked results | Live | NONE |
| QDR-06 | Configurable glob patterns and ignore patterns | Mock | NONE |
| QDR-07 | Multi-provider embedding (HF, Gemini, OpenAI, Custom) | Mock | NONE |
| QDR-08 | Reindex collection (delete + recreate + rescan) | Live | NONE |
| QDR-09 | File watcher debounced sync | Live | NONE |
| QDR-10 | Graceful degradation when Qdrant unavailable | Mock | NONE |

Previously in this section:

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| QRM-01 | Quorum settings parse (defaults/raw JSON fallback) | Mock | NONE |
| QRM-02 | `read_file` path containment | Mock | NONE |
| QRM-03 | `list_files` path containment + 100-entry limit | Mock | NONE |
| QRM-04 | `search_files` delegates to grep wrapper | Mock | NONE |
| QRM-05 | `web_search` and `web_fetch` formatting/failure handling | Mock | NONE |
| QRM-06 | Claude CLI junior agent path | Mock | NONE |
| QRM-07 | OpenAI-compatible junior with tool-call loop (max 10 turns) | Mock | NONE |
| QRM-08 | Lead synthesis path | Mock | NONE |
| QRM-09 | `askQuorum` writes artifact files and returns metadata | Live (Non-Det) | NONE |
| QRM-10 | ~~`/api/quorum/ask`~~ REMOVED | — | — |
| QRM-11 | File read truncation at 10KB | Mock | NONE |
| QRM-12 | One junior fails, lead still synthesizes remaining | Mock | NONE |
| QRM-13 | All juniors fail, returns error without crash | Mock | NONE |
| QRM-14 | Malformed tool-call args from OpenAI-compatible junior | Mock | NONE |
| QRM-15 | ~~Stub-based quorum~~ REMOVED | — | — |

#### 4.1.26 Webhooks (`webhooks.js`)

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| WHK-01 | List webhooks | Live | NONE |
| WHK-02 | Add webhook | Live | NONE |
| WHK-03 | Replace all webhooks | Live | NONE |
| WHK-04 | Delete webhook by index | Live | NONE |
| WHK-05 | Fire `session_created` event | Live | NONE |
| WHK-06 | Fire `task_added` event | Live | NONE |
| WHK-07 | ~~Fire `message_sent` event~~ REMOVED — messages deleted | — | — |
| WHK-08 | `event_only` mode (IDs only, no content) | Mock + Live | NONE |
| WHK-09 | `full_content` mode (complete payload) | Mock + Live | NONE |
| WHK-10 | Webhook delivery failure (non-200 target, no crash) | Mock | NONE |
| WHK-11 | Event filtering by event list and wildcard | Mock | NONE |

#### 4.1.27 Entrypoint Script

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| ENT-01 | Docker socket group matching (dynamic GID) | Live | NONE |
| ENT-02 | User drop from root to workbench via gosu | Live | NONE |
| ENT-03 | Data directory creation | Live | NONE |
| ENT-04 | CLAUDE_HOME symlink setup | Live | NONE |
| ENT-05 | Settings.json creation with defaults | Live | NONE |
| ENT-06 | MCP server registration (Workbench + Playwright) | Live | NONE |
| ENT-07 | Skill installation from config/skills | Live | NONE |
| ENT-08 | Credential verification | Live | NONE |
| ENT-09 | Onboarding flags set | Live | NONE |
| ENT-10 | Ownership fix to workbench user | Live | NONE |
| ENT-11 | Docker socket owned by root emits warning (no docker group GID match) | Live | NONE |
| ENT-12 | Startup with missing `tmux` binary — server starts degraded, session creation returns clear error | Live | NONE |

#### 4.1.28 Health Endpoint

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| HLT-01 | Returns 200 when all dependencies healthy | Live | NONE |
| HLT-02 | Returns 503 when any dependency unhealthy | Live | NONE |
| HLT-03 | Reports per-dependency status (db, workspace, auth) | Live | NONE |
| HLT-04 | Auth degraded does not flip HTTP status alone | Live | NONE |
| HLT-05 | DB unhealthy + workspace healthy → 503, workspace status still reported | Live | NONE |
| HLT-06 | Workspace unhealthy + DB healthy → 503 | Live | NONE |
| HLT-07 | Multiple dependencies unhealthy → 503, all statuses reported | Live | NONE |

#### 4.1.29 Routes — Concurrency & Edge Cases

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| RTE-01 | `lockedAppend` serializes concurrent writes to same JSONL file | Mock + Live | NONE |
| RTE-02 | Session rename with missing JSONL (ENOENT silently tolerated, DB succeeds) | Mock + Live | NONE |

#### 4.1.30 UI -- Sidebar & Navigation

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| UI-01 | Sidebar renders project list | Browser | NONE |
| UI-02 | Sidebar renders session list under each project | Browser | NONE |
| UI-03 | Session filter (Active/All/Archived/Hidden) | Browser | NONE |
| UI-04 | Session sort (Date/Name/Messages) | Browser | NONE |
| UI-05 | Session search (debounced, renders results) | Browser | NONE |
| UI-06 | Add project button opens directory picker | Browser | NONE |
| UI-07 | Settings button opens settings modal | Browser | NONE |
| UI-08 | Project expand/collapse | Browser | NONE |
| UI-09 | Auto-expand projects with active sessions | Browser | NONE |

#### 4.1.31 UI -- Terminal & Tabs

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| UI-10 | Click session opens tab with terminal | Browser | NONE |
| UI-11 | Tab switching changes active terminal | Browser | NONE |
| UI-12 | Tab close disconnects WS and disposes terminal | Browser | NONE |
| UI-13 | Tab status indicators (connected/disconnected/connecting) | Browser | NONE |
| UI-14 | Terminal resize on window/pane resize | Browser | NONE |
| UI-15 | Terminal input/output works (type command, see response) | Browser | NONE |
| UI-16 | Create new Claude session from project | Browser | NONE |
| UI-17 | Create new bash terminal from project | Browser | NONE |
| UI-18 | New session modal with prompt textarea and Ctrl+Enter submit | Browser | NONE |
| UI-19 | File drag-and-drop onto terminal | Browser | NONE |
| UI-20 | Multiple simultaneous terminal tabs | Browser | NONE |

#### 4.1.32 UI -- Right Panel

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| UI-21 | Panel toggle (show/hide) | Browser | NONE |
| UI-22 | Files tab: jQuery File Tree browsing | Browser | NONE |
| UI-23 | Files tab: open file shows content | Browser | NONE |
| UI-24 | ~~Notes tab: auto-save textarea~~ REMOVED | — | — |
| UI-25 | Tasks tab: add/complete/reopen/delete tasks | Browser | NONE |
| UI-26 | ~~Messages tab: view and send inter-session messages~~ REMOVED | — | — |
| UI-27 | Panel data loads for active session's project | Browser | NONE |

#### 4.1.33 UI -- Status Bar

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| UI-28 | Model name display | Browser | NONE |
| UI-29 | Mode display (bypass) | Browser | NONE |
| UI-30 | Context usage bar (green/amber/red thresholds) | Browser | NONE |
| UI-31 | Context percentage display | Browser | NONE |
| UI-32 | Connection status indicator | Browser | NONE |
| UI-33 | Token polling updates status bar | Browser | NONE |

#### 4.1.34 UI -- Settings Modal

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| UI-34 | Theme switching (dark/light/workbench-dark/workbench-light) | Browser | NONE |
| UI-35 | Terminal font size adjustment | Browser | NONE |
| UI-36 | Terminal font family selection | Browser | NONE |
| UI-37 | Default model configuration | Browser | NONE |
| UI-38 | Thinking level configuration | Browser | NONE |
| UI-39 | Keepalive mode configuration | Browser | NONE |
| UI-40 | ~~Quorum configuration (lead, fixed junior, additional juniors)~~ REMOVED | — | — |
| UI-41 | MCP server management (add/remove) | Browser | NONE |
| UI-42 | Settings persist after modal close and page reload | Browser | NONE |

#### 4.1.35 UI -- Auth Flow

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| UI-43 | Auth banner shows when credentials invalid | Browser | NONE |
| UI-44 | Auth modal displays OAuth URL | Browser | NONE |
| UI-45 | Auth code submission | Browser | NONE |
| UI-46 | Auth modal auto-detection of CLI auth prompt in terminal output | Browser | NONE |
| UI-47 | Auth banner hides after successful auth | Browser | NONE |

#### 4.1.36 UI -- Session Management

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| UI-48 | Session config modal (name, state, notes) | Browser | NONE |
| UI-49 | Session summary overlay (AI-generated) | Browser | NONE |
| UI-50 | Session archive/unarchive toggle | Browser | NONE |
| UI-51 | Session rename persists to JSONL | Browser | NONE |

#### 4.1.37 UI -- Auto-Refresh & Real-Time

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| UI-52 | `loadState()` polls every 30 seconds | Browser | NONE |
| UI-53 | `checkAuth()` polls every 60 seconds | Browser | NONE |
| UI-54 | WebSocket heartbeat every 30 seconds | Browser | NONE |
| UI-55 | Auto-reconnect with exponential backoff (max 30s) | Browser | NONE |
| UI-56 | Hash-based skip optimization in sidebar render | Browser | NONE |

#### 4.1.38 Context Stress Testing

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| CST-01 | Progressive fill: advisory threshold (65%) triggers nudge | Live | NONE |
| CST-02 | Progressive fill: warning threshold (75%) triggers nudge | Live | NONE |
| CST-03 | Progressive fill: urgent threshold (85%) triggers nudge | Live | NONE |
| CST-04 | Progressive fill: auto threshold (90%) triggers compaction | Live | NONE |
| CST-05 | Pipeline stage verification: each of 8 stages independently confirmed | Live | NONE |
| CST-06 | Multi-cycle: 3 full fill→compact→verify cycles at 90% | Live | NONE |
| CST-07 | State leak: lock released after each cycle | Live | NONE |
| CST-08 | State leak: nudge flags cleared between cycles | Live | NONE |
| CST-09 | Cold recall: post-compaction prompt references pre-compaction topic (Non-Det) | Live | NONE |
| CST-10 | Cold recall stub: resume prompt content references pre-compaction topic from topic pivot | Live | NONE |

#### 4.1.39 Utility Self-Tests

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| ~~UTIL-01~~ REMOVED in #320 (Phase 0) — `prime-test-session.js` deleted | — | — |
| ~~UTIL-02~~ REMOVED in #320 (Phase 0) — `prime-test-session.js` deleted | — | — |

#### 4.1.40 Auth Modal Parsing

| ID | Capability | Layer | Status |
|----|-----------|-------|--------|
| AUTH-ANSI-01 | OAuth URL with ANSI codes — stripped and extracted | Mock | NONE |
| AUTH-ANSI-02 | URL fragmented across 3+ WS frames — buffer accumulates, URL detected | Mock | NONE |
| AUTH-ANSI-03 | 4KB+ output before URL — buffer eviction doesn't truncate URL | Mock | NONE |

### 4.2 Configuration Coverage Matrix

Every configuration option that affects behavior must be tested.

| Config Key / Env Var | Behavior Affected | Test ID(s) | Layer |
|---------------------|-------------------|-----------|-------|
| `PORT` / env `PORT` | Server bind address | SRV-01 | Live |
| `MAX_TMUX_SESSIONS` | Session limit enforcement | TMX-08, SRV-06 | Mock + Live |
| `TMUX_CLEANUP_MINUTES` | Idle session cleanup delay | TMX-06, SRV-07 | Mock |
| `compaction.thresholds.advisory` | 65% nudge trigger | CMP-29, CMP-47, CST-01 | Mock + Live |
| `compaction.thresholds.warning` | 75% nudge trigger | CMP-30, CMP-48, CST-02 | Mock + Live |
| `compaction.thresholds.urgent` | 85% nudge trigger | CMP-31, CMP-49, CST-03 | Mock + Live |
| `compaction.thresholds.auto` | 90% auto-compact trigger | CMP-32, CMP-50, CST-04 | Mock + Live |
| `compaction.verbose` | Verbose logging toggle | CMP-45, ENG-11 | Live |
| `compaction.pollIntervalMs` | Compact phase poll rate | CMP-22 | Mock |
| `compaction.compactTimeoutMs` | Compact phase timeout | CMP-24 | Mock |
| `compaction.promptPattern` | Prompt detection regex | CMP-21 | Mock |
| `keepalive.fallbackIntervalMin/Max` | Refresh schedule range | KA-04 | Mock |
| `keepalive.mode` | Start/stop behavior | KA-07, KA-08, KA-09 | Mock |
| `session.nameMaxLength` | Rename validation | SES-05 | Live |
| `session.promptMaxLength` | Prompt size limit | SES-01 | Live |
| `session.promptInjectionDelayMs` | Prompt injection timing | SES-18 | Live |
| `bridges.deliveredCleanupMs` | Bridge cleanup after delivery | MSG-07 | Mock |
| `bridges.undeliveredCleanupMs` | Bridge cleanup undelivered | MSG-07 | Mock |
| `polling.tokenUsageIntervalMs` | Token poll frequency | UI-33 | Browser |
| `tmux.windowWidth` / `tmux.windowHeight` | Tmux window dimensions | TMX-03 | Live |
| `LOG_LEVEL` env var | Log filtering | LOG-03 | Mock |
| `WORKSPACE` env var | Project path root | SAF-01 | Mock |
| `WORKBENCH_DATA` env var | Storage directory | ENT-03 | Live |

---

## 5. Test Cases by Component

This section defines specific scenarios, inputs, expected outcomes, and gray-box verification for each major component.

### 5.1 Server Lifecycle

**SRV-01: Server binds and serves**
- Input: Start container, send `GET /health`
- Expected: 200 OK with JSON body containing `status: "ok"`
- Layer: Live
- Gray-box: Container log shows "Server listening on port 3000"

**SRV-02: Static file serving**
- Input: `GET /` (serves index.html), `GET /lib/xterm/lib/xterm.js`, `GET /lib/codemirror/codemirror-bundle.js`. Regression check: `GET /lib/jquery/jquery.min.js` must return 404 (route deleted in #319 Phase 0)
- Expected: 200 OK with correct content-type for each
- Layer: Live
- Note: Verify actual routes match `server.js` static mappings before test implementation

**SRV-03: WebSocket upgrade**
- Input: Create session, connect WS to `/ws/:tmuxSession`
- Expected: 101 Switching Protocols, bidirectional data flows
- Layer: Live
- Gray-box: `tmux list-sessions` shows session exists inside container

**SRV-04: Startup sequence**
- Input: Start fresh container, wait for health
- Expected: Config initialized, watchers started, orphan cleanup completed
- Layer: Live
- Gray-box: Container log shows startup messages. Settings file exists. No orphaned `wb_*` tmux sessions

**SRV-05: Graceful error handling**
- Input: Spawn `server.js` as a child process with `NODE_OPTIONS='--require ./tests/fixtures/trigger-uncaught.js'`. The fixture schedules `setTimeout(() => { throw new Error('test-uncaught-exception') }, 2000)` after the server starts. This injects a real uncaught exception without modifying application code.
- Expected: Process exits with non-zero code, stderr contains structured error log with the thrown message
- Layer: Mock (child process, no container needed)
- Gray-box: Verify exit code and stderr output

**SRV-06: MAX_TMUX_SESSIONS enforcement**
- Input: Create MAX+1 sessions
- Expected: Oldest idle session killed, new session created
- Layer: Live
- Gray-box: `tmux list-sessions` count never exceeds MAX

**SRV-07: TMUX_CLEANUP_DELAY scheduling**
- Input: Disconnect from session, mock timer advancement
- Expected: Session killed after delay
- Layer: Mock (use `test.mock.timers`)

### 5.2 Configuration

**CFG-01:** `require('./config')` with valid defaults → `config.get('key')` returns value. Mock.

**CFG-02:** Malformed `defaults.json` → process exits code 1, JSON error on stderr. Mock + Live.

**CFG-03:** Missing `defaults.json` → no crash, `config.get()` returns undefined. Mock.

**CFG-04:** `config.get('a.b.c')` where `c` missing → returns undefined. Mock.

**CFG-05:** Template with `{{PERCENT}}`, pass `{ PERCENT: 85 }` → output contains "85". Mock.

**CFG-06:** `config.getPrompt('nonexistent')` → returns empty string, logs warning. Mock. Gray-box: logger receives warning.

**CFG-07:** Modify `defaults.json` at runtime → new value within 5s. Live.

**CFG-08:** Modify prompt template at runtime → next `getPrompt()` returns updated text. Live.

**CFG-09:** Overwrite valid defaults with invalid JSON → config retains previous values, logs warning. Mock.

### 5.3 Logger

**LOG-01:** `logger.info('test', { key: 'value' })` → stdout JSON with ISO 8601 timestamp, level, message, key. Mock.

**LOG-02:** `logger.error('fail')` → stderr receives the line. Mock.

**LOG-03:** `LOG_LEVEL=ERROR` → info suppressed, error emitted. Mock.

**LOG-04:** Context with `{ timestamp: 'fake', level: 'fake' }` → real values in output. Mock.

### 5.4 Database

**DB-01:** Fresh DB → 6 tables, correct columns, WAL enabled. Live. Gray-box: `PRAGMA table_info(...)`, `PRAGMA journal_mode`.

**DB-02:** Run migrations twice → no errors, no duplicate columns. Mock.

**DB-03:** `ensureProject` / `getProject` / `deleteProject` → CRUD works. Mock + Live. Gray-box: `SELECT` confirms.

**DB-04:** Session upsert/get/rename/delete/state-change → each persists. Mock + Live.

**DB-05:** Task add/complete/reopen/delete/list → each persists. Mock + Live.

**DB-06:** Message send/getUnread/getRecent/markRead → each persists. Mock + Live.

**DB-07:** Settings set/get/getAll with JSON and raw fallback → round-trip. Mock + Live.

**DB-08:** Session meta upsert/get/cleanStale → cache works. Mock.

**DB-09:** Delete project with children → all cascaded. Live. Gray-box: count rows before/after.

**DB-10:** `getSessionByPrefix('abc')` with `abc123`, `abc456` → returns matches. Mock.

**DB-11:** `getSessionWithProject(id)` → returns joined data. Mock.

**DB-12:** Two simultaneous `lockedAppend` to same file → both complete, no corruption. Mock + Live. Gray-box: read file, verify both entries.

### 5.5 Safe Execution

| ID | Input | Expected | Layer |
|----|-------|----------|-------|
| SAF-01 | `resolveProjectPath('myproj')` | `path.join(WORKSPACE, 'myproj')` | Mock |
| SAF-02 | `sanitizeTmuxName("a/b;c d")` | `abcd` | Mock |
| SAF-03 | `shellEscape("'; rm -rf /; '")` | Safely escaped | Mock |
| SAF-04 | `claudeExecAsync` with timeout, mock never resolves | Timeout error | Mock |
| SAF-05 | `tmuxExecAsync('bad')` mock exit 1 | Rejects with stderr | Mock |
| SAF-06 | `findSessionsDir('my/project')` | Correct encoded path | Mock |
| SAF-07 | `gitCloneAsync` valid/invalid | Resolves/rejects | Mock |
| SAF-08 | `tmuxKill('nonexistent')` | Resolves (ignores missing) | Mock |
| SAF-09 | `tmuxSendKeysAsync(session, longText)` | Temp file → load → paste → Enter → cleanup | Mock |
| SAF-10 | `grepSearchAsync('pattern', path, max)` | Capped array; empty on error | Mock |
| SAF-11 | `curlFetchAsync(url)` | Truncated body; error message on failure | Mock |

### 5.6 Session Utilities

| ID | Input | Expected | Layer |
|----|-------|----------|-------|
| SU-01 | JSONL with 3 user messages + name entry | `{ name, timestamp, messageCount: 3 }` | Mock |
| SU-02 | Parse twice, file unchanged | Second call cached (fs.readFile called once) | Mock |
| SU-03 | JSONL with summary after name | Summary overrides name | Mock |
| SU-04 | JSONL with corrupted lines | Valid lines parsed, bad skipped | Mock |
| SU-05 | `GET /api/search?q=keyword` across 2 projects | Matches from both | Live |
| SU-06 | `GET /api/search?q=keyword&project=proj1` | Matches only from proj1 | Live |
| SU-07 | `summarizeSession` with mock Claude | Returns text, uses configured model | Mock |
| SU-08 | `summarizeSession` with mock failure | Returns fallback, no throw | Mock |
| SU-09 | JSONL with assistant usage block | Extracts input/output tokens | Mock |
| SU-10 | JSONL with system/synthetic models | Ignores non-user models | Mock |
| SU-11 | `claude-sonnet-4-6` vs `claude-opus-4-6` | Correct maxTokens per model | Mock |
| SU-12 | Filename `abc123-def456.jsonl` | Correct slug extraction | Mock |

### 5.7 Session Resolver

**RES-01:** Create session (`new_123`), JSONL appears → DB migrates, tmux renames. Live. Gray-box: DB + `tmux ls`.

**RES-02:** Set notes/rename before resolution → preserved after. Mock.

**RES-03:** Trigger resolution twice concurrently → only one runs. Mock.

**RES-04:** No JSONL, dead tmux → temp deleted from DB after maxAttempts. Mock.

**RES-05:** No JSONL, live tmux → temp retained. Mock.

**RES-06:** Startup with stale `new_*` → resolver cleans dead, resolves live. Mock + Live.

**RES-07:** `new_*` in DB, no sessions dir → orphan removed. Mock.

**RES-08:** Two JSONL files appear simultaneously → correct one selected. Mock.

### 5.8 Watchers

**WAT-01:** Open WS, write JSONL → `token_update` on WS. Live.

**WAT-02:** Write JSONL, observe that `checkCompactionNeeds` is called with the session's token usage data. Live. Gray-box: container logs show compaction check entry; if threshold exceeded, verify bridge file or nudge behavior.

**WAT-03:** Write JSONL 10x in 100ms → callback fires once. Mock.

**WAT-04:** Start then stop watcher → handle closed, timer cleared. Mock.

**WAT-05:** Modify settings file → `settings_update` on WS within 5s. Live.

**WAT-06:** Delete settings file while watching → no crash, detects recreated. Live. Gray-box: logs show ENOENT.

**WAT-07:** Multiple sessions open, one already watched by a per-session watcher → compaction monitor scan finds and starts watching sessions not already covered. Live. Gray-box: container logs show monitor starting watchers for uncovered sessions.

**WAT-08:** `registerMcpServer` → settings.json updated. Live. Gray-box: read and verify.

**WAT-09:** Call `trustProjectDirs` with 3 projects in DB → all 3 project paths appear in `settings.json` `trustedDirs` array. Live. Gray-box: read settings.json, verify all paths present.

**WAT-10:** Fresh container with no `settings.json` → `ensureSettings` creates the file with expected default structure. Live. Gray-box: read file, verify JSON parses and contains expected keys.

**WAT-11:** Close WS connection for a session → JSONL watcher for that session stops. Live. Gray-box: subsequent JSONL writes do not produce `token_update` on any WS.

**WAT-12:** Watcher on `new_123`, resolve to UUID → old stops, new starts. Mock + Live.

**~~WAT-13~~** REMOVED in #320 (Phase 0). Original test depended on `scripts/prime-test-session.js` (deleted) and the smart-compaction priming flow (removed in test plan v7.0). The "watcher handles large JSONL parse without OOM" property is now exercised indirectly by the live `tests/live/context-stress.test.js` suite.

### 5.9 WebSocket Terminal

**WS-01:** Connect to nonexistent session → connection closed with error. Live.

**WS-05:** Flood > 1MB → PTY paused, resumes at 512KB. Mock.

**WS-06:** Advance timer 30s → ping sent. Mock.

**WS-10:** Mock `node-pty.spawn` throws → error logged, WS closed, no crash. Mock.

**WS-02: PTY spawn via node-pty**
- Input: Create session, connect WS to `/ws/:tmuxSession`
- Expected: PTY spawned attached to tmux session, bidirectional data flows
- Layer: Live
- Gray-box: `docker exec workbench-test tmux list-sessions` shows session; container logs show PTY spawn entry

**WS-03: Bidirectional data flow**
- Input: Connect WS, send keystrokes, read output
- Expected: Input appears in tmux capture-pane; command output received on WS
- Layer: Live
- Gray-box: `docker exec workbench-test tmux capture-pane -t <session> -p` shows typed input

**WS-04: Terminal resize handling**
- Input: Send resize message `{type: "resize", cols: 120, rows: 40}` over WS
- Expected: PTY dimensions updated, subsequent output wraps at new width
- Layer: Mock — inject mock PTY, verify `pty.resize(cols, rows)` called with correct values. Live — send resize, verify `docker exec workbench-test tmux display -t <session> -p '#{pane_width} #{pane_height}'` reflects new dimensions

**WS-07: Cleanup on disconnect**
- Input: Connect WS, then close connection
- Expected: Three side effects occur: (1) PTY process killed, (2) browser count decremented in sharedState, (3) cleanup timer scheduled for tmux session
- Layer: Mock — inject mock PTY (verify `.kill()` called), mock sharedState (verify `browserCount` decremented), mock timer (verify `setTimeout` scheduled with cleanup delay). Live — disconnect WS, verify: `docker exec workbench-test tmux list-sessions` still shows session (cleanup is delayed, not immediate), container logs show disconnect cleanup entry
- Gray-box: Container logs for PTY kill, tmux ls for session presence, internal state for browser count. This scenario tests three independent side effects; each must be verified separately

**WS-08: Token usage forwarded via WS**
- Input: While WS connected, trigger JSONL watcher update (write to session JSONL)
- Expected: `token_update` message received on WS with usage data
- Layer: Mock — inject mock `sessionWsClients` map with a fake WS client, trigger the forwarding function, verify the client received `token_update` JSON. Live — connect WS, write JSONL, verify WS receives `token_update`

**WS-09: Settings updates forwarded via WS**
- Input: While WS connected, trigger settings watcher (modify settings.json)
- Expected: `settings_update` message received on WS
- Layer: Mock — inject mock `sessionWsClients` map, trigger settings broadcast, verify client received `settings_update` JSON. Live — connect WS, modify settings via API, verify WS receives `settings_update` within tolerance window (§3.5)

**WS-11: Browser connect/disconnect updates keepalive hooks**
- Input: Connect WS (browser count 0→1), then disconnect (1→0)
- Expected: Connect triggers keepalive start (if mode is `browser`), disconnect triggers keepalive stop
- Layer: Mock — inject mock sharedState with `browserCount: 0`, mock keepalive module. Connect: verify `browserCount` incremented to 1 and `keepalive.start()` called. Disconnect: verify `browserCount` decremented to 0 and `keepalive.stop()` called

### 5.10 Smart Compaction Pipeline (Highest Risk)

#### 5.10.1 Compaction Checker 8-Element Checklist

| # | Element | Checker Signal | Verification |
|---|---------|---------------|-------------|
| 1 | Plan mode entered | `{"workbench": "enter_plan_mode"}` | Tmux capture shows plan mode |
| 2 | Plan file copied | `{"workbench": "read_plan_file"}` | Plan file exists |
| 3 | Context tail built | `recent_turns.md` created | File exists, size > 0 |
| 4 | Unsaved work checked | Checker assesses state | Response references work state |
| 5 | Git status checked | Checker evaluates changes | Response references git state |
| 6 | Git commit (if needed) | `{"workbench": "exit_plan_mode"}` → git → re-enter | Log shows git prompt |
| 7 | Agent state preserved | Checker confirms resumability | Response contains state summary |
| 8 | Ready to compact | `{"workbench": "ready_to_compact"}` | `parseWorkbench` returns it |

**CMP-03a:** Hallucinated checker output (conversational text wrapping JSON, wrong schema) → retries or aborts, no infinite loop. Mock.

**CMP-29..32:** Prime to 66%/76%/86%/91% (must pass UTIL-01/02 first) → correct nudge/auto-compact. Live. Gray-box: bridge file text, state map.

**CMP-35:** Full PREP→COMPACT→RECOVERY at 90% → all stages complete. Mock + Live.
- Mock gray-box: Verify state machine transitions (PREP resolves with `ready_to_compact`, COMPACT resolves with completion signal, RECOVERY resolves with `resume_complete`, lock released, tail file cleanup scheduled). Verify correct functions called in sequence.
- Live gray-box: Verify filesystem artifacts (plan file exists, `recent_turns.md` exists, tail file cleaned up after delay, container logs show all 3 phases with timing).

**CMP-39:** Deferred Promise holds lock → second call rejected. Mock. Note: mock MUST inject controllable delay.

**CMP-42:** Stateful `capturePaneAsync` mock returns sequential states → state machine transitions correctly. Live portion: Non-Deterministic suite. Mock: verify code path.

**CMP-46:** Auto-compaction timer is `.unref()`'d → timer does not prevent Node process exit. Mock: verify `.unref()` called on returned timer.

**CMP-47..50 (Below-threshold boundary tests):**

| ID | Input | Expected | Layer |
|----|-------|----------|-------|
| CMP-47 | Token usage at 64% | No nudge triggered, no bridge file written | Mock |
| CMP-48 | Fresh session (no prior threshold crossings). Token usage at 74% | No nudge of any kind — session has never crossed 65%, so no advisory was sent; 74% is below 75% warning threshold | Mock |
| CMP-49 | Token usage at 84% | No urgent nudge | Mock |
| CMP-50 | Token usage at 89% | No auto-compaction scheduled | Mock |

These tests verify that the threshold if-else-if chain does not trigger actions below the configured boundary. Combined with CMP-29..32 (above-threshold), this provides full boundary coverage.

### 5.11 Authentication & Keepalive

**AUTH-03:** `GET /api/keepalive/status` → 200 with `tokenExpiry`, `mode`, `state`. Live.

**AUTH-04/05:** Invalid mode, out-of-range idleMinutes → 400. Live.

| ID | Input | Expected | Layer |
|----|-------|----------|-------|
| KA-01 | `.credentials.json` with future expiry | Parsed Date, correct TTL | Mock |
| KA-02 | Missing file | Zero expiry | Mock |
| KA-03 | Invalid JSON | Warning logged, zero expiry | Mock |
| KA-04 | Token 30min remaining | Schedule in randomized range | Mock |
| KA-05 | Expired token | Immediate refresh | Mock |
| KA-06 | 3 refresh cycles | Alternating prompts | Mock |
| KA-07 | start/stop | Timer set/cleared | Mock |
| KA-08 | Browser count 0→1→0 | Starts on connect, stops on disconnect | Mock |
| KA-09 | Idle 5min, no activity | Shuts down | Mock |
| KA-10 | Status payload | Has tokenExpiry, mode, state | Mock + Live |

### 5.12 Tmux Lifecycle

| ID | Input | Expected | Layer | Gray-box |
|----|-------|----------|-------|----------|
| TMX-01 | Name generator | Matches `/^wb_[a-z0-9]{12}$/` | Mock | |
| TMX-02 | Existence check | Returns boolean | Mock | |
| TMX-03 | Create Claude session | Tmux created | Live | `tmux ls` |
| TMX-04 | Create bash session | Tmux created | Live | `tmux ls` |
| TMX-05 | Kill session | Removed | Live | `tmux ls` |
| TMX-06 | Disconnect + timer advance | Cleanup fires | Mock | |
| TMX-07 | Reconnect before timer | Timer cancelled | Mock | |
| TMX-08 | MAX+2 sessions | Two oldest killed | Live | `tmux ls` count |
| TMX-09 | Fresh container + orphans | Orphans killed | Live | `tmux ls` |
| TMX-10 | Stale bridge files | Removed | Mock | |
| TMX-11 | Send text | Appears in capture-pane | Live | `tmux capture-pane` |
| TMX-12 | Send named key | Processed | Live | |

### 5.13 Webhooks

| ID | Input | Expected | Layer | Gray-box |
|----|-------|----------|-------|----------|
| WHK-01 | `GET /api/webhooks` | Array of webhooks | Live | |
| WHK-02 | `POST /api/webhooks` | Added, in subsequent GET | Live | Settings file |
| WHK-03 | `PUT /api/webhooks` | All replaced | Live | Settings file |
| WHK-04 | `DELETE /api/webhooks/0` / out-of-bounds | Removed / 404 | Live | |
| WHK-05 | Echo + create session | Echo receives `session_created` | Live | Echo log |
| WHK-06 | Echo + add task | Echo receives `task_added` | Live | Echo log |
| WHK-07 | Echo + send message | Echo receives `message_sent` | Live | Echo log |
| WHK-08 | `event_only` mode | IDs only | Mock + Live | |
| WHK-09 | `full_content` mode | Full data | Mock + Live | |
| WHK-10 | Unreachable URL | Error logged, no crash | Mock | |
| WHK-11 | Filter `["task_added"]`, fire `session_created` | Not triggered | Mock | |

### 5.14 OpenAI-Compatible API

| ID | Input | Expected | Layer |
|----|-------|----------|-------|
| OAI-01 | `GET /v1/models` | 200 with model array | Live |
| OAI-02 | Non-streaming completion | 200 with choices | Live |
| OAI-03 | Streaming completion | SSE events + `[DONE]` | Live |
| OAI-04 | `bp:session-id` model | Routed to session | Live |
| OAI-05 | `X-Workbench-Session` header | Routed to session | Live |
| OAI-06 | `X-Workbench-Project` header | Uses project | Live |
| OAI-07 | Prompt > 100KB | 400 | Mock |
| OAI-08 | Invalid model name | Error/default | Mock |
| OAI-09 | Empty/no-user messages | 400 | Live |
| OAI-10 | No project header | Uses default | Live |
| OAI-11 | Claude exec throws | `server_error` | Mock + Live |

### 5.15 Quorum System

| ID | Input | Expected | Layer |
|----|-------|----------|-------|
| QRM-01 | Valid config | Parsed settings | Mock |
| QRM-02 | `../../../etc/passwd` | Path rejected | Mock |
| QRM-03 | 200 files | Capped at 100 | Mock |
| QRM-04 | `search_files('pattern')` | Delegates to grep | Mock |
| QRM-05 | `web_search` failure | Formatted error | Mock |
| QRM-06 | Claude junior | CLI called correctly | Mock |
| QRM-07 | OpenAI junior 11 tool calls | Stops at 10 | Mock |
| QRM-08 | Lead with 2 juniors | Synthesized | Mock |
| QRM-09 | E2E consultation | Artifacts on disk | Live (Non-Det) |
| QRM-10 | Route validation | 200 on valid input | Live (Non-Det) |
| QRM-11 | 20KB file | Truncated at 10KB | Mock |
| QRM-12 | 1 of 3 juniors fails | Lead uses remaining 2 | Mock |
| QRM-13 | All juniors fail | Error, no crash | Mock |
| QRM-14 | Malformed tool-call args | Handled gracefully | Mock |
| QRM-15 | ~~Stub-based quorum~~ REMOVED | — | — |

### 5.16 MCP Stdio Server

See §3.6 for methodology. Mock tests import functions; live tests use `child_process.spawn`.

**MCS-01:** `initialize` → response with `protocolVersion`, `capabilities`. Mock + Live.

**MCS-02:** `tools/list` → 14 tools with name, description, inputSchema. Mock.

**MCS-06:** Invalid JSON / nonexistent method → error responses, server continues. Mock.

### 5.17 Global CLAUDE.md

**GCM-01:** GET when exists / missing → content / empty string (not 404). Live. Gray-box: file matches.

**GCM-02:** PUT `{ content: "# Test" }` → `{saved: true}`, file written. Live. Gray-box: read file.

### 5.18 MCP Servers API

**MCS-API-01:** GET with valid settings → `{servers: {...}}`. Live.

**MCS-API-02:** GET with missing/malformed settings → `{servers: {}}`. Live.

**MCS-API-03:** PUT new server with existing → merged, not overwritten. Live. Gray-box: read settings.json.

### 5.19 Project Management

| ID | Input | Expected | Layer | Gray-box |
|----|-------|----------|-------|----------|
| PRJ-01 | `POST { path: "/workspace/myproj" }` | 200, project created | Live | DB row |
| PRJ-02 | `POST { gitUrl: "..." }` | 200, cloned and registered | Live | Dir + DB |
| PRJ-03 | `DELETE /api/projects/myproj` | 200, DB removed, dir stays | Live | DB absent, dir exists |
| PRJ-04 | `GET /api/state` with 2 projects | Both with metadata | Live | DB count |
| PRJ-05 | PUT/GET notes | Persisted and retrievable | Live | DB select |
| PRJ-06 | GET/PUT CLAUDE.md | Template/content | Live | File on disk |
| PRJ-07 | `POST { path: "/nonexistent" }` | 400 | Mock | |
| PRJ-08 | POST twice same path | Idempotent | Mock | DB: single row |

### 5.20 Session Management

**SES-01:** Create with prompt → 200, `new_*` ID, tmux created. Live. Gray-box: DB + `tmux ls`.

**SES-06:** State transitions active→archived→hidden→active → each persists. Also test via `PUT /api/sessions/:id/archive` to verify both endpoints. Live. Gray-box: DB select.

**SES-12:** `../../etc/passwd`, `invalid!chars` → 400/404. Mock.

**SES-20:** Delete JSONL, then rename → DB succeeds, ENOENT tolerated. Mock + Live. Gray-box: DB name changed, no error in logs.

**SES-21:** Delete a session, then archive another → `GET /api/state` returns neither the deleted session nor any phantom/zombie entries. Live. Gray-box: DB count matches API response count; no stale `new_*` IDs appear after deletion.

**SES-22:** `DELETE /api/sessions/:id` → 200 with expected body. Mock: validate route handler calls DB delete function. Live: call DELETE, verify 200 response, then gray-box: `docker exec ... sqlite3 ... "SELECT count(*) FROM sessions WHERE id = '<id>'"` returns 0, `docker exec ... tmux list-sessions` does not include the session, `GET /api/state` excludes the deleted session.

### 5.21 Task System

| ID | Input | Expected | Layer | Gray-box |
|----|-------|----------|-------|----------|
| TSK-01 | POST task | 200, id + status:pending | Live | DB |
| TSK-02 | PUT complete | 200, completed_at set | Live | DB |
| TSK-03 | PUT reopen | 200, completed_at cleared | Live | DB |
| TSK-04 | DELETE | 200, removed | Live | DB |
| TSK-05 | GET list | Array for project | Live | |
| TSK-06 | Text > 1000 chars | 400 | Mock | |
| TSK-07 | created_by field | Persisted | Mock | DB |

### 5.22 Messaging System — REMOVED

| ID | Input | Expected | Layer | Gray-box |
|----|-------|----------|-------|----------|
| MSG-01 | ~~POST message~~ REMOVED | — | — | — |
| MSG-02 | ~~Message to active session~~ REMOVED | — | — | — |
| MSG-03 | ~~GET recent~~ REMOVED | — | — | — |
| MSG-04 | ~~Content > 100KB~~ REMOVED | — | — | — |
| MSG-05 | ~~GET unread~~ REMOVED | — | — | — |
| MSG-06 | ~~PUT mark read~~ REMOVED | — | — | — |
| MSG-07 | ~~Cleanup timers~~ REMOVED | — | — | — |

### 5.23 Settings System

| ID | Input | Expected | Layer | Gray-box |
|----|-------|----------|-------|----------|
| SET-01 | GET settings | Merged defaults + overrides | Live | |
| SET-02 | PUT theme=light | 200, persisted | Live | DB |
| SET-03 | Update + WS connected | `settings_update` within 5s | Live | WS log |
| SET-04 | `config.get('defaultModel')` | Returns default | Mock | |
| SET-05 | Modify file, wait 5s | Watcher broadcasts | Live | |
| SET-06 | Template `{{VAR}}` | Substituted | Mock | |
| SET-07 | `config.get('a.b.c')` | Nested value | Mock | |
| SET-08 | Corrupt defaults.json | Exit code 1 | Mock | |

### 5.24 Filesystem Operations

| ID | Input | Expected | Layer |
|----|-------|----------|-------|
| FS-01 | `GET /api/mounts` | Mount array | Live |
| FS-02 | `GET /api/browse?path=/workspace` | Dir listing, dot dirs hidden | Live |
| FS-03 | `GET /api/file` valid + outside workspace | 200 for both (AD-001) | Live |
| FS-04 | `GET /api/browse?path=...` | JSON `{path, parent, entries: [{name, type}]}` (replaces removed `POST /api/jqueryFileTree`) | Live |
| FS-05 | File > 1MB | 413 | Mock + Live |
| FS-06 | ~~`workbench_update_plan` with `../`~~ REMOVED — plan tools deleted | — | — |

### 5.25 Health Endpoint

| ID | Input | Expected | Layer |
|----|-------|----------|-------|
| HLT-01 | All healthy | 200 | Live |
| HLT-02a | DB file removed: `docker exec workbench-test rm /data/.workbench/workbench.db` | 503, health response body shows db status unhealthy | Live |
| HLT-02b | DB file unreadable: `docker exec workbench-test chmod 000 /data/.workbench/workbench.db` (restore with `chmod 644` after test) | 503, health response body shows db status unhealthy | Live |
| HLT-03 | Any state | db, workspace, auth fields present | Live |
| HLT-04 | Invalid credentials | 200, auth degraded | Live |
| HLT-05 | DB down, workspace up | 503, workspace healthy | Live |
| HLT-06 | Workspace path gone | 503 | Live |
| HLT-07 | DB + workspace down | 503, both reported | Live |

### 5.26 Entrypoint Script

| ID | Input | Expected | Layer | Gray-box |
|----|-------|----------|-------|----------|
| ENT-01 | Docker socket mounted | GID matches | Live | `stat -c %g` |
| ENT-02 | Fresh container | Process runs as `workbench` user (not root) after gosu | Live | `whoami` inside running container returns `workbench` |
| ENT-03 | Fresh container | Dirs created | Live | `ls -la` |
| ENT-04 | Fresh container | `$CLAUDE_HOME` points to symlinked location | Live | `readlink $CLAUDE_HOME` or `ls -la` shows symlink |
| ENT-05 | No prior settings | `settings.json` defaults | Live | Read + verify |
| ENT-06 | Fresh container | Workbench and Playwright MCP servers registered in `settings.json` `mcpServers` | Live | Read `settings.json`, verify both server entries with correct command/args |
| ENT-07 | `config/skills` directory contains skill files | Skills installed into `$CLAUDE_HOME` | Live | Verify skill files exist in expected location after startup |
| ENT-08 | Fresh container with credentials mounted | Credential file exists and is valid | Live | `docker exec` reads credential file, verifies JSON structure |
| ENT-09 | Fresh container | Onboarding flags set | Live | Read `.claude.json` |
| ENT-10 | Fresh container | workspace owned by `workbench` user | Live | `stat -c %U` on `/home/workbench/workspace` |
| ENT-11 | Root-only socket GID | Warning logged | Live | Container logs |
| ENT-12 | `tmux` hidden via PATH override | Server starts degraded, session creation → clear error | Live | API error response |

**ENT-12 execution method:** Run ENT-12 at the END of the fresh-container suite. Override PATH to hide tmux: `docker exec workbench-test env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin node -e "..."` (omit the directory containing tmux from PATH), or use a compose override that mounts a no-op stub at the tmux path. Do NOT rename or move the real tmux binary — if the test harness crashes mid-test, the container must remain usable. If ENT-12 fails or the harness crashes, the container must be torn down and rebuilt before any subsequent test run.

### 5.27 Auth Modal (Browser)

**BRW-28:** Stub CLI writes ANSI-laden OAuth URL to tmux → modal pops up → code submitted via send-keys. Browser. Gray-box: `tmux capture-pane` shows auth code.

**AUTH-ANSI-01:** OAuth URL with ANSI codes → stripped and extracted. Mock.

**AUTH-ANSI-02:** URL fragmented across 3+ WS frames → buffer accumulates, URL detected. Mock.

**AUTH-ANSI-03:** 4KB+ output before URL → buffer eviction doesn't truncate URL. Mock.

### 5.28 Routes — Concurrency & Edge Cases

**RTE-01:** Two concurrent `lockedAppend` to same file → both entries present, no corruption. Mock + Live. Gray-box: parse file.

**RTE-02:** Delete JSONL, call rename → DB succeeds, ENOENT tolerated. Mock + Live. Gray-box: DB name, no error log.

### 5.29 MCP Internal Tools (Individual)

| ID | Tool | Input | Expected | Gray-Box |
|----|------|-------|----------|----------|
| MCP-06a | `workbench_search_sessions` | `{query: "test"}` / `{query: ""}` | Results array / empty array | — |
| MCP-06b | `workbench_summarize_session` | Valid session ID | Non-empty summary text | — |
| MCP-06c | `workbench_list_sessions` | Valid project name | Session array for project | — |
| MCP-06d | ~~`workbench_get_project_notes`~~ REMOVED | — | — | — |
| MCP-06e | ~~`workbench_get_session_notes`~~ REMOVED | — | — | — |
| MCP-06f | `workbench_get_tasks` | Valid project | Task array | — |
| MCP-06g | `workbench_add_task` | `{project, text}` | Task created | DB: `SELECT count(*) FROM tasks` incremented by 1 |
| MCP-06h | `workbench_complete_task` | Valid task ID | Task completed | DB: `completed_at IS NOT NULL` |
| MCP-06i | `workbench_get_project_claude_md` | Valid project | CLAUDE.md content | — |
| MCP-06j | ~~`workbench_read_plan`~~ REMOVED | — | — | — |
| MCP-06k | ~~`workbench_update_plan`~~ REMOVED | — | — | — |
| MCP-06l | `workbench_set_session_config` | `{id, name: "new-name"}` | Config updated | DB: session name matches |
| MCP-06m | `workbench_reopen_task` | Completed task ID | Task reopened | DB: `completed_at IS NULL` |
| MCP-06n | `workbench_delete_task` | Valid task ID | Task deleted | DB: `SELECT count(*) FROM tasks WHERE id = ?` returns 0 |
| MCP-06o | `workbench_set_project_notes` | `{project, notes}` | Notes saved | DB: notes match |
| MCP-06p | `workbench_set_session_notes` | `{session, notes}` | Notes saved | DB: notes match |
| MCP-06q | `workbench_get_token_usage` | Valid session | Token usage data | — |

---

## 6. Endpoint and Tool Testing: Full Parameter Variation

### 6.1 Validation Matrix

| Variation | What to test |
|-----------|-------------|
| Missing required params | Omit each required field individually |
| Invalid types | String where number expected, vice versa |
| Boundary values | Empty string, max-length string, zero, negative numbers |
| Path traversal | `../` in path parameters (plan endpoints only per AD-001) |
| Oversized payloads | Bodies exceeding documented limits |
| Invalid IDs | Non-existent IDs, malformed IDs, SQL injection attempts |
| Concurrent requests | Two simultaneous creates, two simultaneous updates |

### 6.2 Specific Parameter Variation Tests

| Endpoint | Variation | Expected |
|----------|-----------|----------|
| `POST /api/projects` | Name > 255 chars | 400 |
| `POST /api/projects` | Name with path separators | 400 |
| `POST /api/sessions` | Missing `project` | 400 |
| `POST /api/sessions` | Prompt > 50000 chars | 400 |
| `POST /api/sessions` | Non-existent project | 404 |
| `POST /api/terminals` | Missing `project` | 400 |
| `POST /api/terminals` | Non-existent project | 404 |
| `PUT /api/sessions/:id/name` | Name > 255 chars | 400 |
| `GET /api/search` | Query > 200 chars | 400 |
| `GET /api/search` | Empty/short query (< 2 chars) | 200 `{ results: [] }` |
| `GET /api/file` | Path outside workspace | 200 (AD-001) |
| `GET /api/file` | File > 1MB | 413 |
| `POST /api/mcp/call` | Unknown tool | Error response |
| ~~`workbench_update_plan` path traversal~~ REMOVED | — | — |
| ~~`workbench_update_plan` content limit~~ REMOVED | — | — |
| `POST /v1/chat/completions` | Empty messages | 400 |
| `POST /v1/chat/completions` | Missing model | 200 (defaults) |
| `POST /v1/chat/completions` | Prompt > 100KB | 400 |
| ~~`POST /api/quorum/ask`~~ REMOVED | — | — |
| `PUT /api/settings` | Non-existent key | 200 (created — settings is a flexible KV store) |
| `DELETE /api/webhooks/:index` | Out of bounds | 404 |
| `POST /api/projects/:name/tasks` | Text > 1000 chars | 400 |
| `POST /api/projects/:name/messages` | Content > 100KB | 400 |
| `PUT /api/keepalive/mode` | Invalid mode | 400 |
| `PUT /api/keepalive/mode` | `idleMinutes: 0` | 400 |
| `PUT /api/keepalive/mode` | `idleMinutes: 1441` | 400 |
| `PUT /api/keepalive/mode` | `mode: "always"` | 200 |

### 6.3 Negative Gray-Box Verification

For every error-path test (4xx/5xx responses), verify no partial state was written:

| Error Path | Gray-Box Assertion |
|-----------|-------------------|
| Session creation fails (400) | No orphaned DB row, no orphaned tmux session |
| Task creation fails (400) | No task row in DB |
| Project creation fails (400) | No project row in DB |
| Message send fails (400) | No message row, no bridge file |
| Plan update fails (403) | No file written to disk |

---

## 7. Pipeline End-to-End Verification

### 7.1 Smart Compaction Pipeline

#### 7.1.1 Stage Verification

| Stage | Trigger | Completion Indicator | Verification Method |
|-------|---------|---------------------|-------------------|
| Threshold detection | JSONL watcher | `checkCompactionNeeds` returns level | Mock: synthetic token data |
| Nudge delivery | 65%/75%/85% crossed | Bridge file written | Live: verify bridge file |
| Auto-compact trigger | 90% crossed | `runSmartCompaction` called | Live: verify start |
| Lock acquisition | `runSmartCompaction` | Lock present | Mock: verify lock |
| PREP phases | Lock acquired | 8-element checklist (§5.10.1) | Live: tmux capture |
| COMPACT | Prep complete | /compact sent, prompt returns | Live: tmux capture |
| RECOVERY | Compact done | Resume sent, `resume_complete` | Live: checker response |
| Lock release | Pipeline complete | Lock absent | Mock: verify cleared |

#### 7.1.2 Completion Detection

- **Polled:** `capturePaneAsync`
- **Interval:** `compaction.pollIntervalMs` (3000ms default)
- **Timeout:** `compaction.compactTimeoutMs` (300s default)
- **Stall:** No change for 3 consecutive polls
- **Pattern:** `compaction.promptPattern`

#### 7.1.3 Performance Measurement

| Metric | Source | Collection |
|--------|--------|-----------|
| Total duration | `orchestrateCompaction` timer | Log entry |
| Phase durations | Phase timers | Log entries |
| Checker turns | Counter | Logged |
| Context size | `recent_turns` file size | File stat |
| Token usage before/after | `getTokenUsage` | API calls |

### 7.2 Session ID Resolution Pipeline

| Stage | Trigger | Indicator | Verification |
|-------|---------|-----------|-------------|
| Temp ID assigned | Session created | DB `new_*` row | DB query |
| JSONL scan | Polling (2s, 30 max) | New file found | Filesystem |
| DB migration | JSONL found | ID updated | DB query |
| Tmux rename | DB updated | Session name changed | `tmux ls` |
| Cleanup | Complete | Pending removed | Internal state |

### 7.3 Keepalive Token Refresh Pipeline

| Stage | Trigger | Indicator | Verification |
|-------|---------|-----------|-------------|
| Schedule | TTL below threshold | Timer set | Log |
| Query | Timer fires | CLI invoked | Log |
| Refresh | Query completes | New expiry | `.credentials.json` |
| Reschedule | Refresh done | New timer | Log |

### 7.4 Watcher Pipeline

| Stage | Trigger | Indicator | Verification |
|-------|---------|-----------|-------------|
| WS opens | Tab opened | Watcher installed | Internal state |
| File changes | Claude output | fs.watch fires | Event |
| Debounce | Rapid changes | Single callback | Mock: single call |
| Token computed | Debounce fires | Usage extracted | API response |
| WS pushed | Usage computed | `token_update` sent | WS client |
| Compaction check | Usage updated | `checkCompactionNeeds` called | Mock: verify |

---

## 8. Non-Deterministic System Testing

### 8.1 Behavioral Assertions

| Operation | Behavioral Assertion |
|-----------|---------------------|
| Session summary | Non-empty text, length > 50 |
| Keepalive query | Non-empty response within timeout |
| Compaction prep | Valid workbench JSON commands |
| Compaction recovery | New assistant output in tmux |
| Quorum | Non-empty synthesis, artifact files exist |
| OpenAI-compat | Choices with content |

### 8.2 Quality Evaluation (LLM-as-Judge)

| Operation | Judge | Rubric | Scale | Warning | Bug | Samples |
|-----------|-------|--------|-------|---------|-----|---------|
| Session summary | claude-haiku-4-5 | Accuracy of description | 1-5 | < 4 | < 3 | 3 |
| Compaction recall | claude-haiku-4-5 | Awareness of pre-compaction context | 1-5 | < 4 | < 3 | 3 |
| Quorum synthesis | claude-haiku-4-5 | Coherence of synthesis | 1-5 | < 4 | < 3 | 3 |

**Procedure:** 3 samples per scenario, median score. Judge input: prompt + output + context. Judge output: score + rationale. Both stored as artifacts.

### 8.3 Agent Tool Side-Effect Testing

Count-before/count-after pattern for every side-effecting tool:

| Tool | Side Effect | Verification |
|------|------------|-------------|
| `workbench_create_session` | Tmux + DB | Count before/after |
| `workbench_add_task` | DB row | Count before/after |
| ~~`workbench_send_message`~~ REMOVED | — | — |
| ~~`workbench_update_plan`~~ REMOVED | — | — |
| `workbench_set_project_notes` | DB notes | Read before/after |
| ~~`workbench_smart_compaction`~~ REMOVED | — | — |

---

## 9. Gray-Box Verification Strategy

### 9.1 Database Queries

**Access:** `docker exec workbench-test sqlite3 /data/.workbench/workbench.db "..."`.

| Verification | Table | Query |
|-------------|-------|-------|
| Project created | `projects` | `SELECT * FROM projects WHERE name = ?` |
| Session state | `sessions` | `SELECT state FROM sessions WHERE id = ?` |
| Task lifecycle | `tasks` | `SELECT status, completed_at FROM tasks WHERE id = ?` |
| Message delivery | `messages` | `SELECT * FROM messages WHERE project_id = ?` |
| Settings | `settings` | `SELECT value FROM settings WHERE key = ?` |
| Meta cached | `session_meta` | `SELECT * FROM session_meta WHERE session_id = ?` |
| Session resolved | `sessions` | `SELECT id FROM sessions WHERE id NOT LIKE 'new_%'` |
| Notes persisted | `sessions` | `SELECT notes FROM sessions WHERE id = ?` |

### 9.2 Container Log Inspection

**Access:** `docker logs workbench-test --since <timestamp>`.

| Pattern | Meaning | When |
|---------|---------|------|
| `"Server listening on port 3000"` | Startup complete | Container start |
| `"level":"ERROR"` | Error | After every test (must be empty unless expected) |
| `"uncaughtException"` | Fatal | NEVER during normal tests |
| `"unhandledRejection"` | Promise failure | NEVER during normal tests |

### 9.3 Filesystem Inspection

| Check | Path | When |
|-------|------|------|
| JSONL created | `/storage/sessions/<path>/*.jsonl` | Session creation |
| Bridge written/cleaned | `/storage/bridges/` | Message send/cleanup |
| Plan file | `/storage/plans/` | Plan update |
| Settings.json | `$CLAUDE_HOME/settings.json` | Startup |
| Quorum files | Round directory | Quorum ask |

### 9.4 Tmux Inspection

| Check | Command |
|-------|---------|
| Session exists | `docker exec workbench-test tmux list-sessions` |
| Pane content | `docker exec workbench-test tmux capture-pane -t <session> -p` |
| Session count | `docker exec workbench-test tmux list-sessions \| wc -l` |

### 9.5 WebSocket Inspection

Verify: `token_update`, `settings_update`, `pong`, PTY data.

### 9.6 Browser Test Gray-Box Requirements

Every browser mutation test must verify actual state:

| Browser Scenario | Mutation | Gray-Box Check |
|-----------------|----------|---------------|
| BRW-02 | Session created | DB: new session row |
| BRW-10 | ~~Notes saved~~ REMOVED | ~~DB: notes match~~ |
| BRW-11 | Tasks CRUD | DB: task state after each op |
| BRW-12 | ~~Message sent~~ REMOVED | ~~DB: message row~~ |
| BRW-13 | Theme changed | DB: theme setting |
| BRW-14 | Font changed | DB: setting + tmux pane dimensions |
| BRW-15 | Settings persist | DB: value after reload |
| BRW-16 | Session config | DB: session row |
| BRW-18 | Project added | DB: project row |
| BRW-29 | Drag-and-drop | Tmux: capture-pane shows path |
| BRW-30 | Double-click | DB: exactly one session row created |
| BRW-31 | ~~Compaction workflow~~ REMOVED | ~~DB: token usage reduced post-compaction~~ |

### 9.7 Negative Gray-Box for Error Paths

Every 4xx/5xx test verifies no partial state written (§6.3).

---

## 10. Runtime Issue Logging

### 10.1 Severity Categories

| Category | Criteria | Labels |
|----------|----------|--------|
| Hard failure | Assertion fails | `bug`, `severity:high` |
| Regression | Previously passing now fails | `bug`, `regression`, `severity:high` |
| Security | Validation bypass | `bug`, `security`, `severity:critical` |
| Warning | Non-fatal degraded behavior | `warning`, `investigation` |
| Performance | Outside expected range | `performance` |

### 10.2 Severity Thresholds

| Dimension | Acceptable | Warning | Bug |
|-----------|-----------|---------|-----|
| API response | < 2s | 2-10s | > 10s |
| Compaction duration | < 3 min | 3-5 min | > 5 min |
| LLM judge score | >= 4/5 | 3/5 | < 3/5 |
| Event loop block | < 50ms | 50-100ms | > 100ms |
| Memory | < 512MB | 512MB-1GB | > 1GB |

### 10.3 Issue Format

```
Title: [TEST-{ID}] {brief description}
Labels: {labels}
Body: scenario, expected, actual, evidence, hypothesis, reproduction steps
```

### 10.4 Issue Workflow

- **Filing mode:** Issues are only auto-filed during formal gating runs (Gate A/B/C). During iterative development and local test runs, findings are logged to stdout/file only — no GitHub issues created. This prevents issue churn from repeated development iterations.
- Hard failures auto-filed by test harness during formal gate runs. Warnings filed manually after review — never auto-filed
- **Dedup keys:** Before filing, search `gh issue list --label bug,warning,performance --state open` for existing issues matching the test ID. Add comment to existing if duplicate. Dedup key format: `[TEST-{ID}]` in title
- Traceability: update matrix Notes with issue number (e.g., `#123`)

---

## 11. Hot-Reload Testing

### 11.1 Configuration Hot-Reload

| Change | Verification |
|--------|-------------|
| `compaction.thresholds.advisory` 65→50 | Next check uses 50 |
| `keepalive.fallbackIntervalMin` | Next cycle uses new value |
| Prompt template edit | Next use returns new text |
| `session.nameMaxLength` | Next rename enforces new limit |

### 11.2 Settings Hot-Reload

| Change | Verification |
|--------|-------------|
| Theme via API | `settings_update` on WS within 5s |
| Default model via API | Next session uses new model |

### 11.3 Negative Hot-Reload

| Change | Verification |
|--------|-------------|
| Malformed defaults.json | Retains last good (CFG-09), logs warning |
| Malformed settings.json | No crash, retains last good |
| Rapid config flips (5x in 2s) | Final state matches last write |

---

## 12. UI Testing

### 12.1 UI-First Gate Criteria

Workbench is UI-first. The gate **must not pass** on backend tests alone. Gate C (Browser Acceptance) is **authoritative for release readiness**.

### 12.2 Multi-Model UI Audit

Multiple independent models each enumerate every clickable element, every input field, every state transition, every edge case, every race condition, and every failure recovery scenario applied to `public/index.html`. The master UI test list is the aggregation of all models' findings.

**Execution status:** The UI-01..56 scenarios in §4.1.30–37 were derived from the 4-model plan synthesis. If additional UI capabilities are discovered during implementation, they are added to §4.1 and the traceability matrix before WPR-105 implementation begins.

### 12.3 Automated Browser Tests (Playwright)

All tests use Playwright with Chromium at `http://localhost:7867/`.

**Standing requirements for all browser tests:**
- `page.on('console')` listener attached; `console.error` or uncaught exception fails the test (§2.4)
- Screenshot captured at test completion per §3.12
- Baseline reset per §3.10

#### Core Workflows

| ID | Workflow | Behavioral Assertion | Gray-Box |
|----|----------|---------------------|----------|
| BRW-01 | Page load | Sidebar visible, projects listed, no console errors | — |
| BRW-02 | Create session | "+", prompt, Ctrl+Enter → tab, WS, sidebar | DB row |
| BRW-03 | Terminal I/O | Type → response echoed | — |
| BRW-04 | Tab management | 3 sessions, switch → correct shown | — |
| BRW-05 | Close tab | Tab removed, WS closed | Tmux cleanup |
| BRW-06 | Session filter | Archived → only archived shown | — |
| BRW-07 | Session sort | By messages → reordered | — |
| BRW-08 | Session search | Term → matches shown | — |
| BRW-09 | Files panel | Expand → click → content | — |
| BRW-10 | ~~Notes autosave~~ REMOVED | ~~Type → persisted~~ | ~~DB notes~~ |
| BRW-11 | Tasks CRUD | Add/complete/reopen/delete | DB state |
| BRW-12 | ~~Messages~~ REMOVED | ~~Send → in list~~ | ~~DB row~~ |
| BRW-13 | Theme change | Change → CSS updates | DB setting |
| BRW-14 | Font change | Size → terminal updates | DB + tmux dims |
| BRW-15 | Settings persist | Change → reload → still applied | DB value |
| BRW-16 | Session config | Edit name/state → sidebar reflects | DB row |
| BRW-17 | Session summary | Click → non-empty overlay | — |
| BRW-18 | Add project | Select dir → in sidebar | DB row |
| BRW-19 | Status bar | Token poll → model, %, status shown | — |
| BRW-20 | Context bar colors | Green/amber/red at thresholds | — |

#### Edge Cases

| ID | Scenario | Behavioral Assertion |
|----|----------|---------------------|
| BRW-21 | WS disconnect / reconnect | Disconnected indicator → backoff → resumes |
| BRW-22 | Server restart | Tabs reconnect |
| BRW-23 | Rapid tab switching | 10x in 2s, no crash |
| BRW-24 | Panel resize | Terminal resizes, no overflow |
| BRW-25 | Empty state | Appropriate UI |
| BRW-26 | Long session name | Truncated in sidebar, full in tooltip |
| BRW-27 | Auth failure | Banner appears |
| BRW-28 | Auth modal | See §5.27 |
| BRW-29 | Drag-and-drop | Path typed into terminal |
| BRW-30 | Double-click prevention | Rapid "+"/Ctrl+Enter → one session, no dup modals. Gray-box: DB has exactly one new session row, `tmux ls` count incremented by exactly one |
| BRW-31 | ~~Compaction user workflow~~ REMOVED | ~~Terminal visible, context bar shows high usage, compaction triggers (via stub), session resumes to usable state, terminal remains interactive, session identity coherent in sidebar~~ | ~~Gray-box: token usage decreased post-compaction~~ |

### 12.4 Real-World Usability Tests

| ID | Task | Success Criteria |
|----|------|-----------------|
| USR-01 | Add project → create session → list files → archive | All through UI |
| USR-02 | Two sessions, switch between them, verify sidebar state | Both sessions visible in sidebar |
| USR-03 | Change theme + font, verify persistence | Survives reload |
| USR-04 | Search across sessions | Results returned, click opens |
| USR-05 | Tasks CRUD, verify persistence | Survives reload |
| USR-06 | Session summary quality | Judge >= 4/5 (Non-Det) |

---

## 12a. Context Stress Testing

### 12a.1 Progressive Fill

Must pass UTIL-01/02 first.

| ID | Threshold | Expected | Verification |
|----|-----------|----------|-------------|
| CST-01 | 65% | Advisory nudge | Bridge file text |
| CST-02 | 75% | Warning nudge | Bridge file text |
| CST-03 | 85% | Urgent nudge | Bridge file text |
| CST-04 | 90% | Auto-compaction | Pipeline executes |

### 12a.2 Pipeline Stage Verification (CST-05)

8 stages verified independently per §5.10.1.

### 12a.3 Multiple Cycles (CST-06, CST-07, CST-08)

3 full cycles at 90% with topic pivots. Verify: lock released (CST-07), nudge flags cleared (CST-08), token reduced, context cleaned.

### 12a.4 Cold Recall

**CST-09 (Non-Det):** Post-compaction prompt references pre-compaction topic. Judge >= 4/5.

**CST-10 (Gate stub):** Resume prompt content references pre-compaction topic from topic pivot. Distinct from CMP-25/26 which only verify a prompt was sent.

---

## 12b. Fresh-Container Testing

### Required Sequence

1. `docker compose -p workbench-test down -v`
2. `docker compose -p workbench-test build --no-cache`
3. `docker compose -p workbench-test up -d`
4. Health wait (120s timeout) + infrastructure checks
5. Verify startup files
6. Run complete suite

### Fresh-Container Checks

| ID | Check | Why |
|----|-------|-----|
| FRS-01 | DB from scratch | Migration bugs |
| FRS-02 | Dirs created | Missing mkdir |
| FRS-03 | Settings defaults | Config dependency |
| FRS-04 | MCP registered | Registration dependency |
| FRS-05 | Credentials valid | Credential setup |
| FRS-06 | First session works | Startup races |
| FRS-07 | No orphan tmux | Cleanup bugs |
| FRS-08 | File browser fresh | Pre-existing files |
| FRS-09 | Trust dirs bootstrap | Config dependency |
| FRS-10 | Onboarding flags | Onboarding dependency |

---

## 13. Failure Investigation Strategy

### 13.1 Root Cause Before Fix

1. Read full error + stack trace
2. Read container logs for time window
3. Read source code path
4. Reproduce in isolation
5. Identify exact line
6. Understand WHY
7. Only then propose fix

### 13.2 Full Analysis Before Action

500 → read server logs. Unexpected data → query DB. UI fail → screenshot + console. Pipeline timeout → check each stage.

### 13.3 Second Opinion

For non-trivial bugs: present evidence to a second LLM (different model family), document feedback. This aligns with WPR-103 §13.3 which requires second opinions "before committing to a root cause diagnosis for non-trivial bugs." Non-trivial means any bug that is not immediately obvious from the error message alone — ambiguous root causes, multi-component interactions, or anything requiring more than a single-file fix.

### 13.4 Never Weaken Tests

Prohibited: lowering thresholds, broadening matches, adding skip, reclassifying as flaky.

**Quarantine:** No skips in gating suite. Outside gate: linked issue + 7-day expiry + owner. Auto-fail if unresolved.

### 13.5 No Hacks

No regex hacks, no silent swallowing, no unrelated behavior changes, no removing validation.

### 13.6 Verify Every Fix

Deploy → run failing test → run full suite → rerun fresh-container if startup-related.

### 13.7 Error-Path Coverage Obligation

Every error handling path in the application code (catch blocks, error callbacks, rejection handlers, fallback branches) must have at least one test that triggers the error condition and verifies the observable outcome (log entry, error response, state change, graceful degradation). The 22 formerly bare `catch {}` blocks identified in §1.3 ENG-09 are the minimum set; structural coverage tooling (§3.9) will identify additional untested error paths via branch coverage analysis. The test code author must trace each catch/error handler in the application and ensure a corresponding test exists. This is a WPR-105 review criterion — test code will not pass review without error-path coverage.

---

## 14. What Is Not Tested

### 14.1 Exclusions

| Area | Justification |
|------|---------------|
| Claude CLI internals | Third-party |
| tmux internals | Third-party |
| xterm.js rendering | Third-party |
| jQuery File Tree internals | Third-party |
| node-pty internals | Third-party |
| SQLite engine | Third-party |
| Docker engine | Third-party |
| Anthropic billing | Out of scope |
| Cross-browser | Controlled Chromium environment |
| Multi-user | Single-user by design |
| Network chaos | Out of scope |
| Accessibility | Future REQ |
| i18n | Not in requirements |
| `/api/file` path containment | AD-001: full access by design |
| Playwright MCP server (`@playwright/mcp@latest`) | Third-party MCP server; registration is tested (ENT-06) but internal behavior is out of scope |
| `shared-state.js` standalone | Leaf module managing WS client maps and browser count. Covered implicitly by WS-07, WS-11, KA-08 which exercise its API through the modules that consume it. No standalone scenarios required |
| Prometheus/metrics endpoint | Application does not expose a `/metrics` endpoint. Application-level performance is measured via log parsing (§7.1.3) |
| Route authentication (bearer tokens, API keys) | Workbench is a single-user local workbench; HTTP routes do not enforce bearer token authentication. Auth state is managed via CLI credentials and the keepalive system (§4.1.11). No API key or session token is required for HTTP route access |

**Implementation note — `lockedAppend` (RTE-01):** Review of the application code reveals that `lockedAppend` is defined in `routes.js` but may not be called on all write paths (some paths use raw `appendFile`). The test author must verify during implementation that `lockedAppend` is actually invoked on the path under test. If the application code contains an unused `lockedAppend` with an unprotected `appendFile` call on the same path, this is an application bug — file it as a GitHub Issue and fix the application code before the concurrency test can pass. This does not block test plan acceptance.

### 14.2 Blockers

| Area | Blocker | Mitigation | Gate Impact |
|------|---------|-----------|-------------|
| OAuth E2E | No auth server | Test detection via stub | Does not block release |
| ~~Multi-model quorum~~ REMOVED | — | — | — |
| Playwright MCP | Not in container | Verify registration (ENT-06) | Does not block release |
| `/clear` ID mutation | Anthropic #37451 | kill/restart workaround | Does not block release |

---

## 15. Traceability Matrix

Single source of truth. Updated on every write/run. One row per scenario.

### Format

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|

### 15.1 Engineering Gate

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| ENG-01 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| ENG-02 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| ENG-03 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| ENG-04 | Mock | tests/mock/server.test.js | Not started | - | Not run | |
| ENG-05 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| ENG-06 | Mock + Manual | tests/mock/routes.test.js | Not started | - | Not run | Sign-off required |
| ENG-07 | Mock + Manual | tests/mock/routes.test.js | Not started | - | Not run | Sign-off required |
| ENG-08 | Mock | tests/mock/logger.test.js | Not started | - | Not run | |
| ENG-09 | Mock | tests/mock/server.test.js | Not started | - | Not run | |
| ENG-09a | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | |
| ENG-10 | Mock | tests/mock/server.test.js | Not started | - | Not run | |
| ENG-11 | Live | tests/live/compaction-integration.test.js | Not started | - | Not run | |
| ENG-12 | Mock | tests/mock/server.test.js | Not started | - | Not run | |
| ENG-13 | Live | tests/live/routes-health.test.js | Not started | - | Not run | |
| ENG-14 | Live | tests/live/routes-health.test.js | Not started | - | Not run | |
| ENG-15 | Live | tests/live/routes-health.test.js | Not started | - | Not run | |
| ENG-16 | Mock | tests/mock/db.test.js | Not started | - | Not run | |
| ENG-17 | Mock + Live | tests/mock/config.test.js | Not started | - | Not run | |
| ENG-18 | Live | tests/live/watchers.test.js | Not started | - | Not run | |
| ENG-19 | Mock + Manual | tests/mock/config.test.js | Not started | - | Not run | |
| ENG-20 | Mock | tests/mock/server.test.js | Not started | - | Not run | |

### 15.2 Server Lifecycle

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| SRV-01 | Live | tests/live/startup.test.js | Not started | - | Not run | |
| SRV-02 | Live | tests/live/startup.test.js | Not started | - | Not run | |
| SRV-03 | Live | tests/live/ws-terminal.test.js | Not started | - | Not run | |
| SRV-04 | Live | tests/live/startup.test.js | Not started | - | Not run | |
| SRV-05 | Mock | tests/mock/server.test.js | Not started | - | Not run | |
| SRV-06 | Mock + Live | tests/mock/server.test.js, tests/live/startup.test.js | Not started | - | Not run | |
| SRV-07 | Mock | tests/mock/server.test.js | Not started | - | Not run | |

### 15.3 Configuration

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| CFG-01 | Mock | tests/mock/config.test.js | Not started | - | Not run | |
| CFG-02 | Mock + Live | tests/mock/config.test.js | Not started | - | Not run | |
| CFG-03 | Mock | tests/mock/config.test.js | Not started | - | Not run | |
| CFG-04 | Mock | tests/mock/config.test.js | Not started | - | Not run | |
| CFG-05 | Mock | tests/mock/config.test.js | Not started | - | Not run | |
| CFG-06 | Mock | tests/mock/config.test.js | Not started | - | Not run | |
| CFG-07 | Live | tests/live/watchers.test.js | Not started | - | Not run | |
| CFG-08 | Live | tests/live/watchers.test.js | Not started | - | Not run | |
| CFG-09 | Mock | tests/mock/config.test.js | Not started | - | Not run | |

### 15.4 Logger

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| LOG-01 | Mock | tests/mock/logger.test.js | Not started | - | Not run | |
| LOG-02 | Mock | tests/mock/logger.test.js | Not started | - | Not run | |
| LOG-03 | Mock | tests/mock/logger.test.js | Not started | - | Not run | |
| LOG-04 | Mock | tests/mock/logger.test.js | Not started | - | Not run | |

### 15.5 Database

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| DB-01 | Mock + Live | tests/mock/db.test.js, tests/live/startup.test.js | Not started | - | Not run | |
| DB-02 | Mock | tests/mock/db.test.js | Not started | - | Not run | |
| DB-03 | Mock + Live | tests/mock/db.test.js, tests/live/routes-projects.test.js | Not started | - | Not run | |
| DB-04 | Mock + Live | tests/mock/db.test.js, tests/live/routes-sessions.test.js | Not started | - | Not run | |
| DB-05 | Mock + Live | tests/mock/db.test.js, tests/live/routes-tasks.test.js | Not started | - | Not run | |
| DB-06 | Mock + Live | tests/mock/db.test.js, tests/live/routes-messages.test.js | Not started | - | Not run | |
| DB-07 | Mock + Live | tests/mock/db.test.js, tests/live/routes-settings.test.js | Not started | - | Not run | |
| DB-08 | Mock | tests/mock/db.test.js | Not started | - | Not run | |
| DB-09 | Mock + Live | tests/mock/db.test.js, tests/live/routes-projects.test.js | Not started | - | Not run | |
| DB-10 | Mock | tests/mock/db.test.js | Not started | - | Not run | |
| DB-11 | Mock | tests/mock/db.test.js | Not started | - | Not run | |
| DB-12 | Mock + Live | tests/mock/db.test.js, tests/live/routes-sessions.test.js | Not started | - | Not run | |

### 15.6 Safe Execution

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| SAF-01 | Mock | tests/mock/safe-exec.test.js | Not started | - | Not run | |
| SAF-02 | Mock | tests/mock/safe-exec.test.js | Not started | - | Not run | |
| SAF-03 | Mock | tests/mock/safe-exec.test.js | Not started | - | Not run | |
| SAF-04 | Mock | tests/mock/safe-exec.test.js | Not started | - | Not run | |
| SAF-05 | Mock | tests/mock/safe-exec.test.js | Not started | - | Not run | |
| SAF-06 | Mock | tests/mock/safe-exec.test.js | Not started | - | Not run | |
| SAF-07 | Mock | tests/mock/safe-exec.test.js | Not started | - | Not run | |
| SAF-08 | Mock | tests/mock/safe-exec.test.js | Not started | - | Not run | |
| SAF-09 | Mock | tests/mock/safe-exec.test.js | Not started | - | Not run | |
| SAF-10 | Mock | tests/mock/safe-exec.test.js | Not started | - | Not run | |
| SAF-11 | Mock | tests/mock/safe-exec.test.js | Not started | - | Not run | |

### 15.7 Session Utilities

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| SU-01 | Mock | tests/mock/session-utils.test.js | Not started | - | Not run | |
| SU-02 | Mock | tests/mock/session-utils.test.js | Not started | - | Not run | |
| SU-03 | Mock | tests/mock/session-utils.test.js | Not started | - | Not run | |
| SU-04 | Mock | tests/mock/session-utils.test.js | Not started | - | Not run | |
| SU-05 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| SU-06 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| SU-07 | Mock | tests/mock/session-utils.test.js | Not started | - | Not run | |
| SU-08 | Mock | tests/mock/session-utils.test.js | Not started | - | Not run | |
| SU-09 | Mock | tests/mock/session-utils.test.js | Not started | - | Not run | |
| SU-10 | Mock | tests/mock/session-utils.test.js | Not started | - | Not run | |
| SU-11 | Mock | tests/mock/session-utils.test.js | Not started | - | Not run | |
| SU-12 | Mock | tests/mock/session-utils.test.js | Not started | - | Not run | |

### 15.8 Tmux Lifecycle

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| TMX-01 | Mock | tests/mock/tmux-lifecycle.test.js | Not started | - | Not run | |
| TMX-02 | Mock + Live | tests/mock/tmux-lifecycle.test.js | Not started | - | Not run | |
| TMX-03 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| TMX-04 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| TMX-05 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| TMX-06 | Mock | tests/mock/tmux-lifecycle.test.js | Not started | - | Not run | |
| TMX-07 | Mock | tests/mock/tmux-lifecycle.test.js | Not started | - | Not run | |
| TMX-08 | Mock + Live | tests/mock/tmux-lifecycle.test.js, tests/live/routes-sessions.test.js | Not started | - | Not run | |
| TMX-09 | Live | tests/live/startup.test.js | Not started | - | Not run | |
| TMX-10 | Mock | tests/mock/tmux-lifecycle.test.js | Not started | - | Not run | |
| TMX-11 | Live | tests/live/ws-terminal.test.js | Not started | - | Not run | |
| TMX-12 | Live | tests/live/ws-terminal.test.js | Not started | - | Not run | |

### 15.9 Session Resolver

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| RES-01 | Mock + Live | tests/mock/session-resolver.test.js, tests/live/routes-sessions.test.js | Not started | - | Not run | |
| RES-02 | Mock | tests/mock/session-resolver.test.js | Not started | - | Not run | |
| RES-03 | Mock | tests/mock/session-resolver.test.js | Not started | - | Not run | |
| RES-04 | Mock | tests/mock/session-resolver.test.js | Not started | - | Not run | |
| RES-05 | Mock | tests/mock/session-resolver.test.js | Not started | - | Not run | |
| RES-06 | Mock + Live | tests/mock/session-resolver.test.js, tests/live/startup.test.js | Not started | - | Not run | |
| RES-07 | Mock | tests/mock/session-resolver.test.js | Not started | - | Not run | |
| RES-08 | Mock | tests/mock/session-resolver.test.js | Not started | - | Not run | |

### 15.10 Watchers

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| WAT-01 | Live | tests/live/watchers.test.js | Not started | - | Not run | |
| WAT-02 | Live | tests/live/watchers.test.js | Not started | - | Not run | |
| WAT-03 | Mock | tests/mock/watchers.test.js | Not started | - | Not run | |
| WAT-04 | Mock | tests/mock/watchers.test.js | Not started | - | Not run | |
| WAT-05 | Live | tests/live/watchers.test.js | Not started | - | Not run | |
| WAT-06 | Live | tests/live/watchers.test.js | Not started | - | Not run | |
| WAT-07 | Live | tests/live/watchers.test.js | Not started | - | Not run | |
| WAT-08 | Live | tests/live/watchers.test.js | Not started | - | Not run | |
| WAT-09 | Live | tests/live/watchers.test.js | Not started | - | Not run | |
| WAT-10 | Live | tests/live/watchers.test.js | Not started | - | Not run | |
| WAT-11 | Live | tests/live/watchers.test.js | Not started | - | Not run | |
| WAT-12 | Mock + Live | tests/mock/watchers.test.js, tests/live/watchers.test.js | Not started | - | Not run | |
| WAT-13 | Live | tests/live/watchers.test.js | Not started | - | Not run | |

### 15.11 WebSocket Terminal

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| WS-01 | Live | tests/live/ws-terminal.test.js | Not started | - | Not run | |
| WS-02 | Live | tests/live/ws-terminal.test.js | Not started | - | Not run | |
| WS-03 | Live | tests/live/ws-terminal.test.js | Not started | - | Not run | |
| WS-04 | Mock + Live | tests/mock/ws-terminal.test.js, tests/live/ws-terminal.test.js | Not started | - | Not run | |
| WS-05 | Mock | tests/mock/ws-terminal.test.js | Not started | - | Not run | |
| WS-06 | Mock + Live | tests/mock/ws-terminal.test.js | Not started | - | Not run | |
| WS-07 | Mock + Live | tests/mock/ws-terminal.test.js, tests/live/ws-terminal.test.js | Not started | - | Not run | |
| WS-08 | Mock + Live | tests/mock/ws-terminal.test.js, tests/live/ws-terminal.test.js | Not started | - | Not run | |
| WS-09 | Mock + Live | tests/mock/ws-terminal.test.js, tests/live/ws-terminal.test.js | Not started | - | Not run | |
| WS-10 | Mock | tests/mock/ws-terminal.test.js | Not started | - | Not run | |
| WS-11 | Mock | tests/mock/ws-terminal.test.js | Not started | - | Not run | |
| WS-12 | Mock | tests/mock/ws-terminal.test.js | Written | - | Not run | #483 — no `initialDims` falls back to hardcoded 120×40 and skips pre-resize |
| WS-13 | Mock | tests/mock/ws-terminal.test.js | Written | - | Not run | #483 — with `initialDims`, tmux `resize-window` fires BEFORE capture and PTY spawns at those dims |
| WS-14 | Mock | tests/mock/ws-terminal.test.js | Written | - | Not run | #483 — `resize-window` failure is non-fatal (capture + PTY still proceed) |

### 15.12 Authentication & Keepalive

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| AUTH-01 | Live | tests/live/routes-auth.test.js | Not started | - | Not run | |
| AUTH-02 | Live | tests/live/routes-auth.test.js | Not started | - | Not run | |
| AUTH-03 | Live | tests/live/routes-auth.test.js | Not started | - | Not run | |
| AUTH-04 | Live | tests/live/routes-auth.test.js | Not started | - | Not run | |
| AUTH-05 | Live | tests/live/routes-auth.test.js | Not started | - | Not run | |
| KA-01 | Mock | tests/mock/keepalive.test.js | Not started | - | Not run | |
| KA-02 | Mock | tests/mock/keepalive.test.js | Not started | - | Not run | |
| KA-03 | Mock | tests/mock/keepalive.test.js | Not started | - | Not run | |
| KA-04 | Mock | tests/mock/keepalive.test.js | Not started | - | Not run | |
| KA-05 | Mock | tests/mock/keepalive.test.js | Not started | - | Not run | |
| KA-06 | Mock | tests/mock/keepalive.test.js | Not started | - | Not run | |
| KA-07 | Mock | tests/mock/keepalive.test.js | Not started | - | Not run | |
| KA-08 | Mock | tests/mock/keepalive.test.js | Not started | - | Not run | |
| KA-09 | Mock | tests/mock/keepalive.test.js | Not started | - | Not run | |
| KA-10 | Mock + Live | tests/mock/keepalive.test.js, tests/live/routes-auth.test.js | Not started | - | Not run | |

### 15.13 Smart Compaction

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| CMP-01 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-02 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-03 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-03a | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-04 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-05 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-06 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-07 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-08 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-09 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-10 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-11 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-12 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-13 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-14 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-15 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-16 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-17 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-18 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-19 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-20 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-21 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-22 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-23 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-24 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-25 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-26 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-27 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-28 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-29 | Mock + Live | tests/mock/compaction.test.js, tests/live/compaction-integration.test.js | Not started | - | Not run | |
| CMP-30 | Mock + Live | tests/mock/compaction.test.js, tests/live/compaction-integration.test.js | Not started | - | Not run | |
| CMP-31 | Mock + Live | tests/mock/compaction.test.js, tests/live/compaction-integration.test.js | Not started | - | Not run | |
| CMP-32 | Mock + Live | tests/mock/compaction.test.js, tests/live/compaction-integration.test.js | Not started | - | Not run | |
| CMP-33 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-34 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-35 | Mock + Live | tests/mock/compaction.test.js, tests/live/compaction-integration.test.js | Not started | - | Not run | |
| CMP-36 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-37 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-38 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-39 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-40 | Mock + Live | tests/mock/compaction.test.js, tests/live/compaction-integration.test.js | Not started | - | Not run | |
| CMP-41 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-42 | Mock + Live | tests/mock/compaction.test.js, tests/live/compaction-integration.test.js | Not started | - | Not run | Live: Non-Det |
| CMP-43 | Live | tests/live/compaction-integration.test.js | Not started | - | Not run | Non-Det |
| CMP-44 | Live | tests/live/compaction-integration.test.js | Not started | - | Not run | Non-Det |
| CMP-45 | Live | tests/live/compaction-integration.test.js | Not started | - | Not run | Non-Det |
| CMP-46 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | |
| CMP-47 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | Below-threshold boundary |
| CMP-48 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | Below-threshold boundary |
| CMP-49 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | Below-threshold boundary |
| CMP-50 | Mock | tests/mock/compaction.test.js | Not started | - | Not run | Below-threshold boundary |

### 15.14 Project Management

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| PRJ-01 | Live | tests/live/routes-projects.test.js | Not started | - | Not run | |
| PRJ-02 | Live | tests/live/routes-projects.test.js | Not started | - | Not run | |
| PRJ-03 | Live | tests/live/routes-projects.test.js | Not started | - | Not run | |
| PRJ-04 | Live | tests/live/routes-projects.test.js | Not started | - | Not run | |
| PRJ-05 | Live | tests/live/routes-projects.test.js | Not started | - | Not run | |
| PRJ-06 | Live | tests/live/routes-projects.test.js | Not started | - | Not run | |
| PRJ-07 | Mock | tests/mock/routes.test.js | Not started | - | Not run | |
| PRJ-08 | Mock | tests/mock/routes.test.js | Not started | - | Not run | |

### 15.15 Global CLAUDE.md

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| GCM-01 | Live | tests/live/routes-projects.test.js | Not started | - | Not run | |
| GCM-02 | Live | tests/live/routes-projects.test.js | Not started | - | Not run | |

### 15.16 Session Management

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| SES-01 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| SES-02 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| SES-03 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| SES-04 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| SES-05 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| SES-06 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| SES-07 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| SES-08 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| SES-09 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| SES-10 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | Non-Det |
| SES-11 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| SES-12 | Mock | tests/mock/routes.test.js | Not started | - | Not run | |
| SES-13 | Mock + Live | tests/mock/session-resolver.test.js, tests/live/routes-sessions.test.js | Not started | - | Not run | |
| SES-14 | Mock | tests/mock/session-resolver.test.js | Not started | - | Not run | |
| SES-15 | Mock | tests/mock/session-utils.test.js | Not started | - | Not run | |
| SES-16 | Mock | tests/mock/session-utils.test.js | Not started | - | Not run | |
| SES-17 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| SES-18 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | |
| SES-19 | Mock | tests/mock/session-utils.test.js | Not started | - | Not run | |
| SES-20 | Mock + Live | tests/mock/session-utils.test.js, tests/live/routes-sessions.test.js | Not started | - | Not run | |
| SES-21 | Live | tests/live/routes-sessions.test.js | Not started | - | Not run | Anti-zombie |
| SES-22 | Mock + Live | tests/mock/routes.test.js, tests/live/routes-sessions.test.js | Not started | - | Not run | |

### 15.17 Task System

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| TSK-01 | Live | tests/live/routes-tasks.test.js | Not started | - | Not run | |
| TSK-02 | Live | tests/live/routes-tasks.test.js | Not started | - | Not run | |
| TSK-03 | Live | tests/live/routes-tasks.test.js | Not started | - | Not run | |
| TSK-04 | Live | tests/live/routes-tasks.test.js | Not started | - | Not run | |
| TSK-05 | Live | tests/live/routes-tasks.test.js | Not started | - | Not run | |
| TSK-06 | Mock | tests/mock/routes.test.js | Not started | - | Not run | |
| TSK-07 | Mock | tests/mock/routes.test.js | Not started | - | Not run | |

### 15.18 Messaging System — REMOVED

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| MSG-01 | Live | tests/live/routes-messages.test.js | REMOVED | - | - | Messages system deleted |
| MSG-02 | Live | tests/live/routes-messages.test.js | REMOVED | - | - | Messages system deleted |
| MSG-03 | Live | tests/live/routes-messages.test.js | REMOVED | - | - | Messages system deleted |
| MSG-04 | Mock | tests/mock/routes.test.js | REMOVED | - | - | Messages system deleted |
| MSG-05 | Mock | tests/mock/routes.test.js | REMOVED | - | - | Messages system deleted |
| MSG-06 | Mock | tests/mock/routes.test.js | REMOVED | - | - | Messages system deleted |
| MSG-07 | Mock | tests/mock/routes.test.js | REMOVED | - | - | Messages system deleted |

### 15.19 Settings System

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| SET-01 | Live | tests/live/routes-settings.test.js | Not started | - | Not run | |
| SET-02 | Live | tests/live/routes-settings.test.js | Not started | - | Not run | |
| SET-03 | Live | tests/live/routes-settings.test.js | Not started | - | Not run | |
| SET-04 | Mock | tests/mock/config.test.js | Not started | - | Not run | |
| SET-05 | Live | tests/live/routes-settings.test.js | Not started | - | Not run | |
| SET-06 | Mock | tests/mock/config.test.js | Not started | - | Not run | |
| SET-07 | Mock | tests/mock/config.test.js | Not started | - | Not run | |
| SET-08 | Mock | tests/mock/config.test.js | Not started | - | Not run | |

### 15.20 Filesystem Operations

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| FS-01 | Live | tests/live/routes-filesystem.test.js | Not started | - | Not run | |
| FS-02 | Live | tests/live/routes-filesystem.test.js | Not started | - | Not run | |
| FS-03 | Live | tests/live/routes-filesystem.test.js | Not started | - | Not run | |
| FS-04 | Live | tests/live/routes-filesystem.test.js | Not started | - | Not run | |
| FS-05 | Mock + Live | tests/mock/routes.test.js, tests/live/routes-filesystem.test.js | Not started | - | Not run | |
| FS-06 | Mock + Live | tests/mock/mcp-tools.test.js, tests/live/mcp-tools.test.js | Not started | - | Not run | |

### 15.21 MCP Tools (Internal — 44 flat tools)

After the `mcp-rework` (commits `ce1b624` + `2f062f5`), the `workbench` MCP server exposes 44 flat tools across four domains: `file_*` (8), `session_*` (19), `project_*` (11), `task_*` (5), `log_*` (1). Tests live across three layers:

- **Mock** — `tests/mock/mcp-tools.test.js`. Catalogue size, dispatch, validation/error mapping. 9 tests, all pass with `node --test`.
- **Live integration** — `tests/live/mcp-tools.test.js` and the runbook **Phase 14** matrix. One happy-path row per tool, exercised via `POST /api/mcp/call` against a deployed `${WORKBENCH_CONTAINER}`.
- **Live e2e** — runbook **Phase 14b** (`MCP-E2E-01..05`). Drives real CLI panes via `session_*` tools end-to-end for Claude/Gemini/Codex.

| ID | Layer | Coverage | Test artefact |
|----|-------|----------|---------------|
| MCP-CAT-MOCK | Mock | Catalogue size = 45, group counts (file:8, session:19, project:12, task:6), every name flat | tests/mock/mcp-tools.test.js |
| MCP-CAT-INT | Live | `GET /api/mcp/tools` returns 45, all flat-named | runbook MCP-CAT-00 |
| MCP-CAT-STDIO | Live | `mcp-server.js` stdio: initialize → `serverInfo.name="workbench"`; tools/list → 44 tools, no `workbench_` double-prefix | runbook MCP-CAT-01 |
| MCP-F-01..08 | Live | Each `file_*` tool happy path | runbook Phase 14 file_* matrix |
| MCP-S-01..19 | Live | Each `session_*` tool happy path (S-14..19 are tmux interaction) | runbook Phase 14 session_* matrix |
| MCP-P-01..12 | Live | Each `project_*` tool happy path (incl. sys_prompt_*, mcp_*) | runbook Phase 14 project_* matrix |
| MCP-T-01..06 | Live | Each `task_*` tool happy path (status transitions via task_update) | runbook Phase 14 task_* matrix |
| MCP-NEG-01..10 | Mock + Live | Error mapping: 404 unknown / 400 validation / 403 traversal / 410 dead session / 409 conflict | runbook Phase 14 negative-path matrix |
| MCP-E2E-01..05 | Live e2e | Drive Claude/Gemini/Codex through full prompt→read cycle via `session_*` only. Hidden-default + override. | runbook Phase 14b |

**Coverage assertion (gate):** every one of the 44 tool names must appear at least once in the Live or Live-e2e matrices with a PASS row before the rework can merge to main. Mock catalogue is automated on every commit and is non-negotiable as a precondition.

### 15.22 MCP Tools (External/Admin) — REMOVED

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| MCX-01 | Live | tests/live/mcp-external.test.js | REMOVED | - | - | mcp-external.js deleted |
| MCX-02 | Mock | tests/mock/mcp-external.test.js | REMOVED | - | - | mcp-external.js deleted |
| MCX-03 | Live | tests/live/mcp-external.test.js | REMOVED | - | - | mcp-external.js deleted |
| MCX-04 | Live | tests/live/mcp-external.test.js | REMOVED | - | - | mcp-external.js deleted |
| MCX-05 | Live | tests/live/mcp-external.test.js | REMOVED | - | - | mcp-external.js deleted |
| MCX-06 | Live | tests/live/mcp-external.test.js | REMOVED | - | - | mcp-external.js deleted |
| MCX-07 | Live | tests/live/mcp-external.test.js | REMOVED | - | - | mcp-external.js deleted |
| MCX-08 | Live | tests/live/mcp-external.test.js | REMOVED | - | - | mcp-external.js deleted |
| MCX-09 | Live | tests/live/mcp-external.test.js | REMOVED | - | - | mcp-external.js deleted |
| MCX-10 | Live | tests/live/mcp-external.test.js | REMOVED | - | - | mcp-external.js deleted |
| MCX-11 | Mock | tests/mock/mcp-external.test.js | REMOVED | - | - | mcp-external.js deleted |

### 15.23 MCP Servers API

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| MCS-API-01 | Live | tests/live/routes-settings.test.js | Not started | - | Not run | |
| MCS-API-02 | Live | tests/live/routes-settings.test.js | Not started | - | Not run | |
| MCS-API-03 | Live | tests/live/routes-settings.test.js | Not started | - | Not run | |

### 15.24 MCP Stdio Server

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| MCS-01 | Mock + Live | tests/mock/mcp-tools.test.js, tests/live/mcp-server.test.js | Not started | - | Not run | |
| MCS-02 | Mock | tests/mock/mcp-tools.test.js | Not started | - | Not run | |
| MCS-03 | Live | tests/live/mcp-server.test.js | Not started | - | Not run | |
| MCS-04a | Live | tests/live/mcp-server.test.js | Not started | - | Not run | |
| MCS-04b | Live | tests/live/mcp-server.test.js | Not started | - | Not run | |
| MCS-04c | Live | tests/live/mcp-server.test.js | Not started | - | Not run | |
| MCS-04d | Live | tests/live/mcp-server.test.js | Not started | - | Not run | |
| MCS-04e | Live | tests/live/mcp-server.test.js | Not started | - | Not run | |
| MCS-04f | Live | tests/live/mcp-server.test.js | Not started | - | Not run | |
| MCS-04g | Live | tests/live/mcp-server.test.js | Not started | - | Not run | |
| MCS-04h | Live | tests/live/mcp-server.test.js | Not started | - | Not run | |
| MCS-04i | Live | tests/live/mcp-server.test.js | Not started | - | Not run | |
| MCS-04j | Live | tests/live/mcp-server.test.js | Not started | - | Not run | |
| MCS-04k | Live | tests/live/mcp-server.test.js | Not started | - | Not run | |
| MCS-04l | Live | tests/live/mcp-server.test.js | Not started | - | Not run | |
| MCS-04m | Live | tests/live/mcp-server.test.js | Not started | - | Not run | |
| MCS-04n | Live | tests/live/mcp-server.test.js | Not started | - | Not run | |
| MCS-05 | Mock | tests/mock/mcp-tools.test.js | Not started | - | Not run | |
| MCS-06 | Mock | tests/mock/mcp-tools.test.js | Not started | - | Not run | |
| MCS-07 | Live | tests/live/mcp-server.test.js | Not started | - | Not run | |

### 15.25 OpenAI-Compatible API

OAI-01..11: REMOVED — openai-compat.js deleted.

### 15.26 Quorum System

QRM-01..15: REMOVED — quorum.js deleted.

### 15.27 Webhooks

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| WHK-01 | Live | tests/live/webhooks.test.js | Not started | - | Not run | |
| WHK-02 | Live | tests/live/webhooks.test.js | Not started | - | Not run | |
| WHK-03 | Live | tests/live/webhooks.test.js | Not started | - | Not run | |
| WHK-04 | Live | tests/live/webhooks.test.js | Not started | - | Not run | |
| WHK-05 | Live | tests/live/webhooks.test.js | Not started | - | Not run | |
| WHK-06 | Live | tests/live/webhooks.test.js | Not started | - | Not run | |
| WHK-07 | Live | tests/live/webhooks.test.js | Not started | - | Not run | |
| WHK-08 | Mock + Live | tests/mock/webhooks.test.js, tests/live/webhooks.test.js | Not started | - | Not run | |
| WHK-09 | Mock + Live | tests/mock/webhooks.test.js, tests/live/webhooks.test.js | Not started | - | Not run | |
| WHK-10 | Mock | tests/mock/webhooks.test.js | Not started | - | Not run | |
| WHK-11 | Mock | tests/mock/webhooks.test.js | Not started | - | Not run | |

### 15.28 Entrypoint Script

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| ENT-01 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| ENT-02 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| ENT-03 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| ENT-04 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| ENT-05 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| ENT-06 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| ENT-07 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| ENT-08 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| ENT-09 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| ENT-10 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| ENT-11 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| ENT-12 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | Runs last; see §5.26 |

### 15.29 Health Endpoint

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| HLT-01 | Live | tests/live/routes-health.test.js | Not started | - | Not run | |
| HLT-02a | Live | tests/live/routes-health.test.js | Not started | - | Not run | DB file removed |
| HLT-02b | Live | tests/live/routes-health.test.js | Not started | - | Not run | DB file unreadable |
| HLT-03 | Live | tests/live/routes-health.test.js | Not started | - | Not run | |
| HLT-04 | Live | tests/live/routes-health.test.js | Not started | - | Not run | |
| HLT-05 | Live | tests/live/routes-health.test.js | Not started | - | Not run | |
| HLT-06 | Live | tests/live/routes-health.test.js | Not started | - | Not run | |
| HLT-07 | Live | tests/live/routes-health.test.js | Not started | - | Not run | |

### 15.30 Routes — Concurrency & Edge Cases

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| RTE-01 | Mock + Live | tests/mock/routes.test.js, tests/live/routes-sessions.test.js | Not started | - | Not run | |
| RTE-02 | Mock + Live | tests/mock/routes.test.js, tests/live/routes-sessions.test.js | Not started | - | Not run | |

### 15.31 UI — Browser Capabilities

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| UI-01 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | via BRW-01 |
| UI-02 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | via BRW-01 |
| UI-03 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | via BRW-06 |
| UI-04 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | via BRW-07 |
| UI-05 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | via BRW-08 |
| UI-06 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | via BRW-18 |
| UI-07 | Browser | tests/browser/settings.spec.js | Not started | - | Not run | via BRW-13 |
| UI-08 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | |
| UI-09 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | |
| UI-10 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | via BRW-02 |
| UI-11 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | via BRW-04 |
| UI-12 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | via BRW-05 |
| UI-13 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | |
| UI-14 | Browser | tests/browser/reconnect.spec.js | Not started | - | Not run | via BRW-24 |
| UI-15 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | via BRW-03 |
| UI-16 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | via BRW-02 |
| UI-17 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | |
| UI-18 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | via BRW-02 |
| UI-19 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | via BRW-29 |
| UI-20 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | via BRW-04 |
| UI-21 | Browser | tests/browser/right-panel.spec.js | Not started | - | Not run | |
| UI-22 | Browser | tests/browser/file-browser.spec.js | Not started | - | Not run | via BRW-09 |
| UI-23 | Browser | tests/browser/file-browser.spec.js | Not started | - | Not run | via BRW-09 |
| UI-24 | Browser | tests/browser/right-panel.spec.js | REMOVED | - | - | Notes tab removed |
| UI-25 | Browser | tests/browser/right-panel.spec.js | Not started | - | Not run | via BRW-11 |
| UI-26 | Browser | tests/browser/right-panel.spec.js | REMOVED | - | - | Messages tab removed |
| UI-27 | Browser | tests/browser/right-panel.spec.js | Not started | - | Not run | |
| UI-28 | Browser | tests/browser/status-bar.spec.js | Not started | - | Not run | via BRW-19 |
| UI-29 | Browser | tests/browser/status-bar.spec.js | Not started | - | Not run | |
| UI-30 | Browser | tests/browser/status-bar.spec.js | Not started | - | Not run | via BRW-20 |
| UI-31 | Browser | tests/browser/status-bar.spec.js | Not started | - | Not run | via BRW-19 |
| UI-32 | Browser | tests/browser/status-bar.spec.js | Not started | - | Not run | |
| UI-33 | Browser | tests/browser/status-bar.spec.js | Not started | - | Not run | |
| UI-34 | Browser | tests/browser/settings.spec.js | Not started | - | Not run | via BRW-13 |
| UI-35 | Browser | tests/browser/settings.spec.js | Not started | - | Not run | via BRW-14 |
| UI-36 | Browser | tests/browser/settings.spec.js | Not started | - | Not run | |
| UI-37 | Browser | tests/browser/settings.spec.js | Not started | - | Not run | |
| UI-38 | Browser | tests/browser/settings.spec.js | Not started | - | Not run | |
| UI-39 | Browser | tests/browser/settings.spec.js | Not started | - | Not run | |
| UI-40 | Browser | tests/browser/settings.spec.js | REMOVED | - | - | Quorum removed |
| UI-41 | Browser | tests/browser/settings.spec.js | Not started | - | Not run | |
| UI-42 | Browser | tests/browser/settings.spec.js | Not started | - | Not run | via BRW-15 |
| UI-43 | Browser | tests/browser/auth-modal.spec.js | Not started | - | Not run | via BRW-27 |
| UI-44 | Browser | tests/browser/auth-modal.spec.js | Not started | - | Not run | via BRW-28 |
| UI-45 | Browser | tests/browser/auth-modal.spec.js | Not started | - | Not run | via BRW-28 |
| UI-46 | Browser | tests/browser/auth-modal.spec.js | Not started | - | Not run | via BRW-28 |
| UI-47 | Browser | tests/browser/auth-modal.spec.js | Not started | - | Not run | |
| UI-48 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | via BRW-16 |
| UI-49 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | via BRW-17 |
| UI-50 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | |
| UI-51 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | |
| UI-52 | Browser | tests/browser/status-bar.spec.js | Not started | - | Not run | |
| UI-53 | Browser | tests/browser/status-bar.spec.js | Not started | - | Not run | |
| UI-54 | Browser | tests/browser/status-bar.spec.js | Not started | - | Not run | |
| UI-55 | Browser | tests/browser/reconnect.spec.js | Not started | - | Not run | via BRW-21 |
| UI-56 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | |

### 15.32 Browser Workflows

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| BRW-01 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | |
| BRW-02 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | |
| BRW-03 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | |
| BRW-04 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | |
| BRW-05 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | |
| BRW-06 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | |
| BRW-07 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | |
| BRW-08 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | |
| BRW-09 | Browser | tests/browser/file-browser.spec.js | Not started | - | Not run | |
| BRW-10 | Browser | tests/browser/right-panel.spec.js | REMOVED | - | - | Notes autosave removed |
| BRW-11 | Browser | tests/browser/right-panel.spec.js | Not started | - | Not run | |
| BRW-12 | Browser | tests/browser/right-panel.spec.js | REMOVED | - | - | Messages removed |
| BRW-13 | Browser | tests/browser/settings.spec.js | Not started | - | Not run | |
| BRW-14 | Browser | tests/browser/settings.spec.js | Not started | - | Not run | |
| BRW-15 | Browser | tests/browser/settings.spec.js | Not started | - | Not run | |
| BRW-16 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | |
| BRW-17 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | |
| BRW-18 | Browser | tests/browser/sidebar-and-tabs.spec.js | Not started | - | Not run | |
| BRW-19 | Browser | tests/browser/status-bar.spec.js | Not started | - | Not run | |
| BRW-20 | Browser | tests/browser/status-bar.spec.js | Not started | - | Not run | |
| BRW-21 | Browser | tests/browser/reconnect.spec.js | Not started | - | Not run | |
| BRW-22 | Browser | tests/browser/reconnect.spec.js | Not started | - | Not run | |
| BRW-23 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | |
| BRW-24 | Browser | tests/browser/reconnect.spec.js | Not started | - | Not run | |
| BRW-25 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | |
| BRW-26 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | |
| BRW-27 | Browser | tests/browser/auth-modal.spec.js | Not started | - | Not run | |
| BRW-28 | Browser | tests/browser/auth-modal.spec.js | Not started | - | Not run | |
| BRW-29 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | |
| BRW-30 | Browser | tests/browser/session-workflows.spec.js | Not started | - | Not run | |
| BRW-31 | Browser | tests/browser/session-workflows.spec.js | REMOVED | - | - | Compaction UX removed |

### 15.33 Usability Tests

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| USR-01 | Browser | tests/browser/usability.spec.js | Not started | - | Not run | |
| USR-02 | Browser | tests/browser/usability.spec.js | Not started | - | Not run | |
| USR-03 | Browser | tests/browser/usability.spec.js | Not started | - | Not run | |
| USR-04 | Browser | tests/browser/usability.spec.js | Not started | - | Not run | |
| USR-05 | Browser | tests/browser/usability.spec.js | Not started | - | Not run | |
| USR-06 | Browser | tests/browser/usability.spec.js | Not started | - | Not run | Non-Det |

### 15.34 Context Stress

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| CST-01 | Live | tests/live/context-stress.test.js | Not started | - | Not run | |
| CST-02 | Live | tests/live/context-stress.test.js | Not started | - | Not run | |
| CST-03 | Live | tests/live/context-stress.test.js | Not started | - | Not run | |
| CST-04 | Live | tests/live/context-stress.test.js | Not started | - | Not run | |
| CST-05 | Live | tests/live/context-stress.test.js | Not started | - | Not run | |
| CST-06 | Live | tests/live/context-stress.test.js | Not started | - | Not run | |
| CST-07 | Live | tests/live/context-stress.test.js | Not started | - | Not run | |
| CST-08 | Live | tests/live/context-stress.test.js | Not started | - | Not run | |
| CST-09 | Live | tests/live/context-stress.test.js | Not started | - | Not run | Non-Det |
| CST-10 | Live | tests/live/context-stress.test.js | Not started | - | Not run | |

### 15.35 Utility Self-Tests

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| UTIL-01 | Live | tests/live/context-stress.test.js | Not started | - | Not run | |
| UTIL-02 | Live | tests/live/context-stress.test.js | Not started | - | Not run | |

### 15.36 Auth Modal Parsing

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| AUTH-ANSI-01 | Mock | tests/mock/auth-parsing.test.js | Not started | - | Not run | |
| AUTH-ANSI-02 | Mock | tests/mock/auth-parsing.test.js | Not started | - | Not run | |
| AUTH-ANSI-03 | Mock | tests/mock/auth-parsing.test.js | Not started | - | Not run | |

### 15.37 Frontend Utility Helpers (`public/js/util.js`)

The pure helpers exported from `public/js/util.js` are unit-testable as mocks under `tests/mock/util.test.js` (no DOM, no fetch unless stubbed). Existing UTL-01..07 cover the HTML escapers; milestone 01-stabilization adds two new helpers.

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| UTL-01..07 | Mock | tests/mock/util.test.js | Written | - | Not run | `escapeHtml`, `escapeAttr` HTML-escaping suite (pre-existing) |
| UTL-08 | Mock | tests/mock/util.test.js | Written | - | Not run | #564 — `fetchWithRetry` returns first successful response without retrying |
| UTL-09 | Mock | tests/mock/util.test.js | Written | - | Not run | #564 — `fetchWithRetry` retries on `TypeError` and succeeds before exhaustion |
| UTL-10 | Mock | tests/mock/util.test.js | Written | - | Not run | #564 — `fetchWithRetry` throws after exhausting all attempts |
| UTL-11 | Mock | tests/mock/util.test.js | Written | - | Not run | #564 — `fetchWithRetry` does NOT retry on HTTP 5xx (response returned, not thrown) |
| UTL-12 | Mock | tests/mock/util.test.js | Written | - | Not run | #564 — `fetchWithRetry` honors custom `attempts`/`backoffMs` settings |
| UTL-13 | Mock | tests/mock/util.test.js | Written | - | Not run | #522 — `computeReorderedTabOrder` drop-before-target reorders correctly (CLI tabs) |
| UTL-14 | Mock | tests/mock/util.test.js | Written | - | Not run | #522 — `computeReorderedTabOrder` drop-after-target reorders correctly (file tabs) |
| UTL-15 | Mock | tests/mock/util.test.js | Written | - | Not run | #522 — `computeReorderedTabOrder` drop on empty bar (no `targetTabId`) appends to end |
| UTL-16 | Mock | tests/mock/util.test.js | Written | - | Not run | #522 — `computeReorderedTabOrder` drop on self is a no-op |
| UTL-17 | Mock | tests/mock/util.test.js | Written | - | Not run | #522 — `computeReorderedTabOrder` dragged id not in `currentOrder` is inserted relative to target |
| UTL-18 | Mock | tests/mock/util.test.js | Written | - | Not run | #522 — `computeReorderedTabOrder` handles null/empty `currentOrder` |

### 15.38 Milestone 01-stabilization MCP-tool regressions

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| REG-META-04-mock | Mock | tests/mock/mcp-tools.test.js | Written | - | Not run | #198 — `session_config` returns full session metadata after write (read-after-write) |
| REG-META-04-mock-404 | Mock | tests/mock/mcp-tools.test.js | Written | - | Not run | #198 — `session_config` 404s on missing session (read-after-write contract) |
| REG-META-04-live-claude | Live | tests/live/mcp-tools.test.js | Written | - | Not run | #198 — `session_config` per-CLI parity, claude variant (notes/name reflected in response) |
| REG-META-04-live-gemini | Live | tests/live/mcp-tools.test.js | Written | - | Not run | #198 — `session_config` per-CLI parity, gemini variant |
| REG-META-04-live-codex | Live | tests/live/mcp-tools.test.js | Written | - | Not run | #198 — `session_config` per-CLI parity, codex variant |
| MCP-EXPORT-EMPTY-mock | Mock | tests/mock/mcp-tools.test.js | Written | - | Not run | #268 — `session_export` empty-transcript shape on fresh Claude session |
| MCP-EXPORT-EMPTY-mock-404 | Mock | tests/mock/mcp-tools.test.js | Written | - | Not run | #268 — `session_export` 404s on truly-invalid `session_id` (Case B preserved) |
| MCP-EXPORT-EMPTY-live | Live | tests/live/mcp-tools.test.js | Written | - | Not run | #268 — fresh Claude session returns `{format, content:'', session_id, note:'no transcript'}` |
| MCP-EXPORT-INVALID-live | Live | tests/live/mcp-tools.test.js | Written | - | Not run | #268 — invalid `session_id` still 404s (Case B preserved) |
| CODEX-SEED-275 | Live | tests/live/issue-275-codex-role-seed.test.js | Written | - | Not run | #275 — codex role-seed Phase 1 completes within bounded time via workbench HTTP path |

### 15.39 Fresh-Container Checks

| ID | Layer | Test File | Status | Last Run | Result | Notes |
|----|-------|-----------|--------|----------|--------|-------|
| FRS-01 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| FRS-02 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| FRS-03 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| FRS-04 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| FRS-05 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| FRS-06 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| FRS-07 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| FRS-08 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| FRS-09 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |
| FRS-10 | Live | tests/live/fresh-container.test.js | Not started | - | Not run | |

### Totals

~378 scenarios — Mock ~130, Live ~140, Browser ~70, Mock+Live ~28, Non-Det ~10. All: Not started.

---

## 16. Test Suite Structure

### 16.1 Mock (`tests/mock/`)

`config.test.js`, `logger.test.js`, `db.test.js`, `safe-exec.test.js`, `session-utils.test.js`, `tmux-lifecycle.test.js`, `session-resolver.test.js`, `watchers.test.js`, `ws-terminal.test.js`, `keepalive.test.js`, `webhooks.test.js`, `server.test.js`, `auth-parsing.test.js`, `mcp-tools.test.js`, `routes.test.js` (removed: compaction, quorum, mcp-external, openai-compat)

### 16.2 Live (`tests/live/`)

`startup.test.js`, `routes-filesystem.test.js`, `routes-projects.test.js`, `routes-sessions.test.js`, `routes-tasks.test.js`, `routes-settings.test.js`, `routes-auth.test.js`, `routes-health.test.js`, `mcp-tools.test.js`, `mcp-server.test.js`, `webhooks.test.js`, `watchers.test.js`, `ws-terminal.test.js`, `fresh-container.test.js` (removed: routes-messages, mcp-external, openai-compat, quorum, compaction-integration, context-stress)

### 16.3 Browser (`tests/browser/`)

`sidebar-and-tabs.spec.js`, `session-workflows.spec.js`, `right-panel.spec.js`, `settings.spec.js`, `file-browser.spec.js`, `auth-modal.spec.js`, `status-bar.spec.js`, `reconnect.spec.js`, `usability.spec.js`

### 16.4 Shared

| Path | Purpose |
|------|---------|
| `tests/fixtures/` | All test data: JSONL samples, ANSI fixtures, stub responses, config overrides |
| `tests/fixtures/stub-claude.sh` | Claude CLI stub script (§3.11) |
| `tests/fixtures/trigger-uncaught.js` | Preload script for SRV-05 |
| `tests/helpers/reset-state.js` | Baseline reset module (§3.10) |
| `tests/helpers/db-query.js` | SQLite gray-box query helpers |
| `tests/helpers/ws-client.js` | WebSocket test client |
| `tests/helpers/http-client.js` | HTTP client configured for test port |
| `tests/browser/screenshots/` | Screenshot output directory (§3.12) |
| ~~`scripts/prime-test-session.js`~~ REMOVED in #320 (Phase 0) | — |

---

## 17. Implementation Priority

Numbered from most foundational to most complex. Dependencies noted.

1. **Engineering gate + fresh-container startup** — No dependencies. Must pass before all else.
2. **Config, logger, safe-exec mock tests** — Foundation modules with no internal deps.
3. **DB mock tests** — Depends on config (#2).
4. **Session-utils, session-resolver, tmux-lifecycle mock tests** — Depends on DB (#3).
5. **Core routes live tests (sessions, projects, tasks, messages, settings)** — Depends on running container (#1) and foundational modules (#2-4).
6. **WebSocket terminal** — Depends on sessions (#5) and tmux (#4).
7. **Browser UI core workflows (primary gate)** — Depends on live routes (#5) and WS (#6).
8. **MCP tools (3 consolidated), MCP stdio, Qdrant sync** — Depends on routes (#5).
9. **Watchers, keepalive, and hot-reload** — Depends on config (#2) and sessions (#5).
10. **Compaction stage tests (highest risk)** — Depends on watchers (#9) and session-utils (#4).
11. **Webhooks** — Depends on routes (#5).
12. **Context stress multi-cycle** — Depends on compaction (#10) and UTIL-01/02.
13. **Non-deterministic quality suite** — Last; requires real API keys.

---

## 18. Test Execution Gates

### 18.0 Tools Per Phase

| Phase | Tool | Purpose |
|---|---|---|
| Gate A: Engineering | `eslint` | Linting compliance |
| Gate A: Engineering | `prettier --check .` | Formatting compliance |
| Gate A: Mock/Unit | `node --test tests/mock/*.test.js` | Run mock test suite |
| Gate A: Coverage | `c8 node --test tests/mock/*.test.js` | Structural coverage report (80% line / 70% branch) |
| Gate B: Container | `docker compose -f docker-compose.test.yml up -d --build` | Deploy test container |
| Gate B: Live | `TEST_URL=http://<host>:<port> node --test --test-concurrency=1 tests/live/*.test.js` | Integration tests against deployed container |
| Gate C: Browser | `playwright` via Malory MCP | Browser automation tests against deployed container |
| Gate C: UI Coverage | `page.coverage.startJSCoverage()` / `page.coverage.stopJSCoverage()` | Client-side JS coverage — shows which frontend functions/handlers were exercised |
| Gate C: Screenshots | Malory `browser_screenshot` | Capture screenshots per WPR-105 §4.5 |
| Post-gate: Server Coverage | `c8 report` | Server-side coverage report artifact |
| Post-gate: UI Coverage | Playwright coverage report | Client-side coverage report artifact |

### 18.1 Gate Definitions

| Gate | Scope | Pass Criteria | Blocks |
|------|-------|---------------|--------|
| **Gate A: Mock/Unit** | All mock test files in `tests/mock/` | All tests pass, zero skips, coverage meets §3.9 threshold | Deployment to test environment |
| **Gate B: Live Integration** | All live test files in `tests/live/` | All tests pass, zero skips | Promotion to production |
| **Gate C: Browser Acceptance** | All browser test files in `tests/browser/` | All tests pass, zero skips, no visual PROBLEM findings (§3.12), browser console clean | Promotion to production |

Gate A must pass before Gate B and C are attempted. Gate B and Gate C run against the same deployed test container. All three gates must pass before promotion. **Gate C is authoritative for release readiness** because Workbench is UI-first.

### 18.2 Non-Blocking Suites

| Suite | When | Action on Failure |
|-------|------|-------------------|
| Non-Deterministic Quality | On schedule or manual demand | File GitHub Issue, does not block deployment |
| Blocked External | When external API keys available | File GitHub Issue, does not block deployment |

### 18.3 Flaky Test Escalation

1st occurrence: investigate root cause. 2nd occurrence: file issue with `flaky` label. 3rd occurrence: escalate to test architect. Never mark expected-flaky.

---

## 19. Risk-Based Focus Areas

### 19.1 Smart Compaction Pipeline

- **Why high risk:** Most stateful subsystem in Workbench. Multi-stage pipeline (PREP → COMPACT → RECOVERY) with an 8-element checklist, lock management, threshold state maps, timer scheduling, non-deterministic checker output, and file lifecycle (tail files, plan copies). A bug here can silently corrupt a user's session context or leave compaction stuck indefinitely.
- **Test scenarios:** CMP-01 through CMP-50 (51 scenarios including CMP-03a), CST-01 through CST-10 (10 scenarios). 61 total — the largest single-component allocation.
- **Additional verification:** 3 full fill→compact→verify cycles (CST-06). Stage-by-stage gray-box verification of all 8 checklist elements (§5.10.1). Lock leak detection (CST-07). Nudge flag reset verification (CST-08). Cold recall quality evaluation via LLM judge (CST-09). Below-threshold boundary tests (CMP-47..50). Stateful mock sequences for `capturePaneAsync` to exercise the state machine (CMP-42). User-visible compaction workflow in browser (BRW-31).

### 19.2 Session Resolution

- **Why high risk:** Temp-to-real session ID migration involves concurrent filesystem polling, database updates, and tmux renames. Race conditions between concurrent JSONL creation (RES-08), duplicate resolution suppression (RES-03), and startup reconciliation (RES-06) can orphan sessions or lose user data.
- **Test scenarios:** RES-01 through RES-08 (8 scenarios), SES-13, SES-14, SES-20, SES-21.
- **Additional verification:** Concurrent resolution suppression (RES-03). Race with two simultaneous JSONL files (RES-08). Startup cleanup of stale temps with both dead and live tmux sessions (RES-06). ENOENT tolerance during rename (SES-20, RTE-02). Anti-zombie verification (SES-21).

### 19.3 WebSocket Terminal Bridge

- **Why high risk:** Real-time UX path. Backpressure mishandling can freeze terminals. Heartbeat failures can silently disconnect users. PTY spawn failures can crash the server. Browser count tracking affects keepalive scheduling.
- **Test scenarios:** WS-01 through WS-11 (11 scenarios), UI-55, BRW-21, BRW-22.
- **Additional verification:** Backpressure threshold testing (WS-05: pause at 1MB, resume at 512KB). PTY spawn failure isolation (WS-10). Reconnect with exponential backoff (BRW-21). Server restart recovery (BRW-22).

### 19.4 Browser UI

- **Why high risk:** Primary product surface. The prior test suite had 785 tests at 98.3% pass rate that caught zero of 38 filed bugs because tests verified DOM presence instead of behavior.
- **Test scenarios:** UI-01 through UI-56 (56 scenarios), BRW-01 through BRW-31 (31 workflows), USR-01 through USR-06 (6 usability). 93 total browser-layer scenarios.
- **Additional verification:** Console error capture on every test. Screenshot capture and visual review on every test (§3.12). Gray-box verification for every mutation (§9.6). Behavioral assertions only — no standalone presence checks for mutations (Guidepost #2). Double-click prevention (BRW-30). Rapid tab switching stress (BRW-23). Compaction UX workflow (BRW-31).

### 19.5 Watchers and Hot-Reload

- **Why high risk:** Silent regressions. A broken watcher produces no error — it simply stops updating. A hot-reload failure retains stale config without any visible symptom until the stale value causes a downstream failure.
- **Test scenarios:** WAT-01 through WAT-13 (13 scenarios), CFG-07 through CFG-09, SET-03, SET-05, §11 hot-reload scenarios.
- **Additional verification:** Watcher survival across session resolution rename (WAT-12). Large JSONL parse resilience (WAT-13). Negative hot-reload with corrupt JSON (§11.3). Rapid config flips (§11.3).

### 19.6 MCP and OpenAI Integration Contracts

- **Why high risk:** External integration surfaces. MCP tools are the programmatic API for Claude sessions inside Workbench. OpenAI-compat routes are the API for external clients. Contract violations break all downstream consumers silently.
- **Test scenarios:** MCP-01 through MCP-10 + MCP-06a..q (27 scenarios), MCX-01 through MCX-11 (11 scenarios), MCS-01 through MCS-07 + MCS-04a..n (21 scenarios), OAI-01 through OAI-11 (11 scenarios). 70 total.
- **Additional verification:** Per-tool decomposition (MCP-06a..q, MCS-04a..n) ensures no tool is tested only as part of a list. Side-effect verification via count-before/count-after (§8.3). Stdio server tested via child process spawn (§3.6).

---

## 20. Final Acceptance Criteria

1. Structural coverage meets threshold (§3.9): 80% line, 70% branch — verified by `c8` coverage report
2. Traceability matrix fully populated with test files and results
3. Zero NONE coverage entries (or explicitly justified exclusions in §14)
4. Engineering gate passes (ENG-01..20)
5. Fresh-container passes (FRS-01..10)
6. Browser suite passes (BRW-01..31, USR-01..06)
7. Compaction stress: 3 full cycles at 90%
8. All side-effecting routes/tools have gray-box verification
9. No open critical/high GitHub Issues
10. No skipped tests in gating suite
11. All execution gates passing (§18)
12. Independent review of test code completed
13. **Regression validation:** For at least 3 critical modules (compaction, session-resolver, ws-terminal), temporarily break the application code (e.g., comment out a key line, return incorrect value) and confirm the corresponding tests fail. A test suite that passes against broken code is worthless. This is a gate condition.
14. **Visual review:** All browser test screenshots reviewed per §3.12, zero PROBLEM findings
15. **Browser console clean:** No uncaught exceptions or console.error entries in any browser gating run

---

## Appendix A: R1 Review Disposition Summary

### Accepted

| Source | Finding | Resolution |
|--------|---------|-----------|
| Claude C-2 | §5 sparse for most capabilities | Expanded §5 to cover all components with per-scenario detail |
| Claude C-3 | MCP-06/MCS-04 collapse 20+ tools | Decomposed to MCP-06a..q and MCS-04a..n |
| Claude C-4 | §12a scenarios missing from traceability | Added CST-01..10, UTIL-01..02 with matrix entries |
| Claude C-5 | WS-10 misclassified | WS-10 now tests server-side PTY failure (Mock). Browser reconnect → UI-55/BRW-21 |
| Claude H-1 | SRV-05 "test endpoint" | Removed; child process only |
| Claude H-2 | ENG-06/07 manual gate undefined | Added checklist, reviewer procedure, sign-off |
| Claude H-3 | No CI enforcement | Added §18 |
| Claude H-4 | prime-test-session.js self-test | ~~Added UTIL-01/02 (§3.7)~~ — REMOVED in #320 (Phase 0); `scripts/prime-test-session.js`, UTIL-01/02, and §3.7 were all retired together. |
| Claude H-5 | No concurrent write test | Added DB-12, RTE-01 |
| Claude M-1 | MCS stdio methodology | Added §3.6 |
| Claude M-3 | BRW-01 console error unspecified | Added console capture spec in §12.3 |
| Claude M-5 | BRW-14 missing tmux dimension | Added to §9.6 |
| Claude M-6 | UI-*/BRW-* overlap | Added §2.3 explaining relationship |
| Claude S-1 | §5.6 title mismatch | Fixed: SU-* in §5.6, RES-* in §5.7 |
| Claude S-2 | §13 numbering | Renumbered to 13.1-13.6 |
| Claude S-3 | CST-10 stub distinct from CMP-25/26 | CST-10 verifies topic reference |
| Gemini 2.3 | Negative gray-box for error paths | Added §6.3, §9.7 |
| Gemini 3.1 | lockedAppend concurrency | Added RTE-01 |
| Gemini 3.2 | Silent ENOENT during rename | Added SES-20, RTE-02 |
| Gemini 3.3 | Double-click prevention | Added BRW-30 |
| Gemini 3.5 | Auto-compaction timer unref | Added CMP-46 |
| Gemini 4.1 | Stateful capturePaneAsync mock | Specified in §5.10 CMP-42, §3.4 |
| Gemini 4.3 | MAX_TMUX_SESSIONS config discrepancy | Documented as 10 in test config |
| GPT | Response contract validation | Addressed via per-tool decomposition (MCP-06a..q) |
| GPT | Config coverage matrix | Added §4.2 |
| GPT | Quorum failure modes | Added QRM-12..14 |
| GPT | Health degradation matrix | Added HLT-05..07 |
| GPT | CI enforcement | Added §18 |
| GPT | Quarantine policy | Added to §13.4 |
| GPT | Missing container edge cases | Added ENT-11, ENT-12 |

### Rejected

| Source | Finding | Reason |
|--------|---------|--------|
| Gemini 2.1 | Container rebuild between Live and Browser | Live tests and browser tests against same container is correct — they test different layers of the same deployment |
| Gemini 3.4 | Quorum sequential timing assertion | Performance characteristics are out of scope for functional testing |
| GPT | Reduce scenario count | ~375 is appropriate for 14 modules + 42 routes + 19 tools + full UI |
| GPT | Normalize capability/scenario/acceptance IDs | Current structure is practical for module-at-a-time implementation |
| GPT | Reviewer alters every test file | Changed to sampling protocol for critical tests |
| GPT | No unconditional waits too strict | Clarified: bounded polling with condition acceptable |
| Claude M-2 | CMP-42 standard gate tmux capture | Mock with stateful capturePaneAsync already covers the state machine |
| Claude M-4 | `/api/sessions/:id/archive` unclear | Consolidated into SES-06 |

---

## Appendix B: R2 Review Disposition Summary

### Accepted

| Source | Finding | Resolution |
|--------|---------|-----------|
| Claude CRIT-01 | Traceability matrix only 14 of ~360 rows | Full matrix populated in §15 (all ~375 rows) |
| Claude MAJ-01 | WAT-02, WAT-07, WAT-09, WAT-10, WAT-11 missing from §5 | Added scenario detail in §5.8 |
| Claude MAJ-02 | SRV-05 injection mechanism unspecified | Specified `NODE_OPTIONS --require` preload approach in §5.1 |
| Claude MAJ-03 | No below-threshold compaction tests | Added CMP-47..50 in §4.1.12 and §5.10 |
| Claude MAJ-04 | Second-opinion threshold narrowed below WPR-103 | Aligned with "non-trivial bugs" in §13.3 |
| Claude MAJ-05 | PUT /api/settings unknown key ambiguous | Resolved: 200 (created) — settings is a flexible KV store (§6.2) |
| Claude MAJ-06 | No live test isolation reset protocol | Added §3.10 baseline reset protocol with `reset-state.js` |
| Claude MAJ-07 | WPR-105 visual review protocol absent | Added §3.12 visual review protocol |
| Claude MAJ-08 | Regression/mutation validation absent | Added to §20 item 13 |
| Claude MAJ-09 | Quorum zero live coverage in standard gate | Added QRM-15 stub-based live scenario |
| Claude MIN-01 | AUTH-ANSI-01..03 missing from traceability | Added to §15.36 |
| Claude MIN-02 | `shared-state.js` not addressed | Added to §14.1 exclusions with justification |
| Claude MIN-04 | Screenshot capture failure-only | Changed §3.5 step 9 to capture every browser test |
| Claude MIN-05 | `prime-test-session.js` path unspecified | ~~Added path and invocation detail to §3.3~~ — REMOVED in #320 (Phase 0); the §3.3 priming guidance and the script itself were retired with smart-compaction (test plan v7.0). |
| Claude MIN-06 | §4.2 references §6.2 instead of scenario ID | Replaced with SES-01 reference |
| Claude MIN-07 | ENT-02, 04, 06, 07, 08, 10 lack §5 detail | Added scenario detail in §5.26 |
| Claude MIN-08 | ENT-12 mechanism unspecified | Added execution method in §5.26 |
| Claude MIN-09 | Browser console capture not universal | Added standing requirement in §2.4 and §12.3 |
| Claude MIN-10 | Keepalive browser-mode not live-tested | Assessed: mock coverage (KA-08) is sufficient; live integration path is exercised indirectly by WS-07/WS-11. Added to §14.1 justification |
| Gemini 1.1 | Missing visual verification pipeline | Added §3.12 |
| Gemini 1.2 | Missing inter-test baseline resets | Added §3.10 |
| Gemini 1.3 | Watcher overload on large JSONL | Added WAT-13 |
| Gemini 2.1 | DI-based mock boundaries | Added mock injection strategy to Layer 1 definition in §2 |
| Gemini 2.2 | Outbound internet blocked for test container | Added to §3.1 isolation strategy |
| Gemini 2.3 | Bare catch remediation authorization | Added authorization directive to §1.3 |
| Gemini 3.1 | Playwright MCP to exclusions | Added to §14.1 |
| Gemini 3.2 | BRW-30 DB row count assertion | Strengthened gray-box in §12.3 and §9.6 |
| Gemini 3.3 | Traceability matrix test file column | Addressed: full matrix has file assignments |
| Grok | Regression validation missing | Added to §20 item 13 |
| Grok | Browser console capture missing | Added §2.4 standing requirement |
| Grok | Fixture-driven inputs not mentioned | Added §2.4 standing requirement |
| Grok | Numbered module priority with dependencies | Added dependency notes to §17 |
| GPT | Regression validation sampling | Added to §20 item 13 |
| GPT | Browser console clean requirement | Added §2.4 and §20 item 15 |
| GPT | Compaction usability browser test | Added BRW-31 |
| GPT | `/api/state` anti-zombie scenario | Added SES-21 |
| GPT | Stub CLI contract underspecified | Added §3.11 |
| GPT | Testability gate | Added ENG-20 module importability check |

### Rejected

| Source | Finding | Reason |
|--------|---------|--------|
| GPT | Separate capability audit from scenario catalog | §4 tables serve dual purpose (capability inventory + coverage status), which is efficient and traceable. Adding a separate capability-only section would duplicate information without adding value |
| GPT | All NONE statuses are structurally weak | This is a new test suite — all statuses are correctly NONE because no tests exist yet. The plan explicitly targets zero NONE entries |
| GPT | Judge model (Haiku) too weak for quality evaluation | Haiku is sufficient for structured rubric evaluation with defined dimensions and scale. The judge evaluates against explicit criteria, not generating creative content. Cost/speed tradeoff is appropriate for a test harness |
| Grok | Move context stress to nightly/on-demand | Context stress (CST-01..08, CST-10) uses stub CLI and deterministic fixtures. Only CST-09 (cold recall quality) requires real CLI and is already Non-Det. The stub-based stress tests are practical for standard gating |
| Grok | Replace ENG-06/07 manual review with automated lint + sampling | Automated lint rules catch syntax-level issues but not semantic validation gaps (e.g., missing range checks on numeric params). Manual review is supplemental governance, not substitute coverage. Both are required |
| GPT | Capability inventory and scenario inventory conflated | Some entries in §4.1 read as scenario mechanics rather than pure capabilities. This is intentional — the combined table provides a single authoritative reference for both what the system does and how it will be tested, avoiding cross-referencing overhead |
| Gemini | Fresh-container rebuild impractical for iterative dev | Added clarification in §3.5: fresh-container is mandatory for final gating only; iterative development can skip it |

---

## Appendix C: R3 Review Disposition Summary

### Accepted

| Source | Finding | Resolution |
|--------|---------|-----------|
| Claude CRIT-02 | §5 missing detail for WS-02..04, WS-07..09, WS-11 | Added full scenario detail in §5.9 with inputs, expected outcomes, gray-box checks |
| Claude MAJ-01 | No explicit DELETE session CRUD test | Added SES-22 with mock + live, DB + tmux + API gray-box |
| Claude MAJ-03 | HLT-02 "corrupt DB" underspecified | Split into HLT-02a (file removed) and HLT-02b (file unreadable) with exact commands |
| Claude MAJ-04 | WS lacks mock coverage for core behaviors | Added mock layer to WS-04, WS-07, WS-08, WS-09; mock setup specified in §5.9 |
| Claude MAJ-05 | No metrics endpoint exclusion | Added to §14.1 exclusions |
| Claude MAJ-06 | CMP-48 state-dependency ambiguity | Specified "fresh session, no prior threshold crossings" as initial state |
| Claude MIN-01 | ENT-12 no failure recovery plan | Added crash recovery note to §5.26 |
| Claude MIN-02 | SRV-02 inputs don't match actual routes | (Historical) Fixed to `/`, `/lib/xterm/xterm.js`, `/lib/jquery/jquery.min.js`. Subsequently updated in #319 Phase 0 (jquery deleted) — current inputs are `/`, `/lib/xterm/lib/xterm.js`, `/lib/codemirror/codemirror-bundle.js` with `/lib/jquery/jquery.min.js` asserted 404 as a regression check. |
| Claude MIN-03 | MAX_TMUX_SESSIONS not in compose | Added to §3.1 isolation table |
| Claude MIN-04 | MCP-06a..q missing §5 detail | Added §5.29 with per-tool table including gray-box for MCP-06g, 06k, 06n |
| Claude MIN-05 | FS-05 layer conflict | Resolved to Mock + Live |
| Claude MIN-06 | §12.2 UI audit no execution status | Added deferral note with artifact storage plan |
| Claude MIN-07 | No route auth exclusion | Added to §14.1 |
| Claude MIN-08 | CMP-35 gray-box mock vs live ambiguity | Split gray-box requirements by layer |
| Gemini | `lockedAppend` dead-code trap | Added implementation note to §14.1 warning test authors |
| Gemini | Playwright xterm.js buffer extraction | Added fixture entry in §3.4 with correct extraction method |
| Gemini | Host vs container tmux commands | Fixed §9.4 to use `docker exec` prefix |
| Gemini | `prime-test-session.js` automation + append mode | ~~Updated §3.3 to require programmatic execution and `--append` mode~~ — REMOVED in #320 (Phase 0); the script and §3.3 priming guidance no longer exist. |
| Gemini | WAT-13 V8 crash risk | Covered by existing scenario; test author warned via WAT-13 description |
| GPT/Grok | ENT-12 brittle tmux binary mutation | Changed to PATH override method in §5.26 |
| GPT/Grok | Watcher timing tolerance | Added tolerance window note in §3.5 |
| GPT/Grok | Issue filing noise risk | Added formal gate mode constraint and dedup keys in §10.4 |
| GPT/Grok | Error-path inventory requirement | Added §13.7 error-path coverage obligation |

### Rejected

| Source | Finding | Reason |
|--------|---------|--------|
| Claude MAJ-02, GPT/Grok | Decompose routes.test.js | The file serves a clear purpose: route-level input validation. All assigned scenarios are validation-related. Domain logic tests are already in domain files. Added scope clarification note to §2 Layer 1 rather than restructuring |
| GPT/Grok | Externalize traceability matrix to CSV/JSON | WPR-103 §15 requires the matrix in the plan. The inline matrix is the authoritative format. An operational artifact can be derived from it by the test code author, but the plan must contain the definitive version |
| GPT/Grok | Split plan into multiple files | WPR-103 requires specific content, not a specific file structure. A single self-contained document is more useful for WPR-105 implementers than one with external references. The plan's size (~380 scenarios across 14 modules, 42 routes, 19 tools, and full browser UI) is proportionate to the system's complexity |
| GPT/Grok | Reduce screenshot review burden (batch/sample) | WPR-105 §4.5 requires visual verification for every browser test. The plan complies; reducing coverage would violate the standard. Operational optimization (batching, "visual intent" comments) is a WPR-105 implementation detail, not a plan concern |
| GPT/Grok | Compaction tests may be prematurely concrete if architecture changes | The plan tests the current implementation contract. If the compaction architecture changes, the plan is updated — this is the normal lifecycle. Deferring coverage because the architecture "might" change would leave the highest-risk subsystem untested |
| Gemini | Bash stub CLI should be rewritten in Node.js | The bash stub is simpler, has fewer dependencies, and is easier to volume-mount. Using `safe.findSessionsDir` would create a circular dependency between test infrastructure and application code. The stub contract (§3.11) defines the required behaviors; the implementation language is a WPR-105 decision |
| GPT/Grok | Split capability inventory from implementation-mechanic tests | The combined §4 tables serve dual purpose (capability inventory + coverage status), which is efficient and traceable. Entries like CMP-46 (`.unref()`) and CMP-47..50 (below-threshold) are testable behaviors, not implementation mechanics |
| GPT/Grok | §1 should split automated vs manual engineering checks | The current structure is clear: ENG-01..05 and ENG-08..20 are automated; ENG-06/07 have explicit "Two-part gate" labels distinguishing automated from manual. Adding a sub-section split adds structural overhead without clarity |

---

*End of test plan (Revision 6.0). Single source of truth for WPR-105 test code implementation. Coverage completeness verified by structural coverage tooling (c8) per WPR-103 §2.6.*
