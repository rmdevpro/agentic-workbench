# Workbench UI Test Plan (Master)

**Status:** Active — Updated 2026-04-18
**Original Date:** 2026-04-13 (synthesized from Phase 6c multi-model review)
**Standard:** WPR-103 (Test Plan Standard) + WPR-105 (Test Code Standard)
**Application:** Workbench -- Agentic Workbench managing Claude/Gemini/Codex CLI sessions in tmux/Docker
**Scope:** UI/Browser testing (Gate C). Comprehensive coverage of every DOM element, every user interaction, every JS function, every terminal-mediated CLI function category.
**Tool:** Playwright (Chromium), headless
**Base URL:** `https://aristotle9-agentic-workbench.hf.space` (HF Space with password auth)
**Container user:** `workbench` (UID 1000)
**Workspace:** `/home/workbench/workspace`
**Synthesized from:** Claude, Gemini, Grok, GPT independent UI test plans
**Revised from:** Phase 6a/6b/6c multi-model reviews + 2026-04-18 feature update

## IMPORTANT: Changes Since Original Plan

This plan was originally written for a single-CLI (Claude) system with notes, messages, quorum, and smart compaction features. The following major changes have been made since:

### Removed Features (tests marked REMOVED)
- **Notes panel** — NTS-01..04, UI-E62, UI-E72-73, BRW-10, BRW-38. Project notes now in config modal.
- **Messages panel** — MSG-01..02, UI-E64, UI-E81-82, BRW-12. Replaced by tmux.
- **Quorum settings** — QRM-01..03, UI-E97-99. Quorum feature deleted.
- **Tasks toggle** — FTR-01, UI-E100. Dead UI removed.
- **Smart compaction** — CST-01..20, CLI-14, CLI-21, BRW-31. Feature removed entirely.
- **Terminal button** — UI-E19. Replaced by + dropdown.
- **Active dot** — UI-E27. Replaced by CLI type indicator (C/G/X).

### New Features (tests to add)
- **Multi-CLI sessions** — Claude, Gemini, Codex via + dropdown
- **4 settings tabs** — General, Claude Code, Vector Search, System Prompts
- **Qdrant vector search** — embedded, configurable per-collection
- **MCP management** — register/enable/disable per-project
- **Session lifecycle** — new/connect/restart via MCP tool
- **Tmux lifecycle** — periodic scan, idle timeouts, session limits
- **CLI type indicator** — C/G/X with per-CLI colors
- **Filter/sort dropdowns** — replaced filter buttons
- **45 MCP tools** — flat names grouped by domain: `file_*` (8), `session_*` (19), `project_*` (11), `task_*` (5), `log_*` (1)

---

## 0. Executive Summary

Workbench is a **UI-first system** (WPR-103 §12.1). Browser tests are the primary acceptance gate -- not backend API tests. The UI IS the product.

This plan targets comprehensive UI coverage through four interlocking inventories that make gaps structurally detectable:

1. **UI Element Inventory** (§5) -- Every DOM element with an `id`, semantic role, or interactive behavior (139 elements)
2. **JS Function Inventory** (§6) -- Every named function defined in `public/index.html` (54 functions)
3. **Workflow Inventory** (§8) -- Every end-to-end user journey through the UI (48 workflows)
4. **CLI Category Matrix** (§9) -- Representative samples from every CLI function category reachable through the terminal (21 scenarios)

Every inventory row maps 1:1 to test IDs and test files. Any unmapped row is a coverage gap. The traceability matrix (§16) cross-references all four inventories. The coverage gate (§19) enforces zero unmapped entries. The post-implementation audit (§22) closes any residual gaps by re-auditing the live codebase after test code is written.

**Total scenarios: 307** (213 component tests + 48 workflows + 21 CLI representatives + 20 stress tests + 4 hot-reload + 1 fresh-boot)

Server-side mock and live integration tests (Gates A and B) are defined in the existing test plan (Phase 0f). This plan covers Gate C (browser acceptance) only.

### 0.1 Capability Audit Summary (WPR-103 §4.1)

Every system capability reachable through the UI is categorized as REAL (tested against live container), MOCK (tested with intercepted routes via `page.route()`), or BOTH. See §5a for the full audit table. Zero NONE entries in the gating suite.

---

## 1. Engineering Requirements Gate

Before UI test execution begins, these prerequisites must pass.

### 1.1 Code Quality Prerequisites (Gates A & B)

Inherited from existing test plan. Gate C does not run until Gates A (mock/unit) and B (live integration) pass.

### 1.2 UI-Specific Engineering Checks

| ID | Check | Method | Pass Criteria |
|----|-------|--------|---------------|
| UI-ENG-01 | No silent catches in frontend | `grep` across `public/index.html` | Every `catch` block calls `console.error` or shows UI notification, OR is explicitly documented as intentionally silent with a code comment explaining why |
| UI-ENG-02 | Test code formatting | `prettier --check tests/browser/` | Zero formatting errors |
| UI-ENG-03 | Test code linting | `eslint tests/browser/` | Zero lint errors |
| UI-ENG-04 | Stable selectors | Code review | Tests use semantic locators or stable IDs, not brittle CSS paths |

### 1.3 Environment Readiness

- Fresh test container rebuilt from scratch (§4)
- App reachable at `https://aristotle9-agentic-workbench.hf.space`
- `/health` returns healthy (or known auth-degraded state)
- Seed project(s) and sessions available
- Claude CLI and tmux available in container
- Playwright browser launches successfully

### 1.4 Primer Utility Readiness

Before context threshold or autocompaction scenarios:
- `workbench_primer.py` can target a Workbench session JSONL (located in the container at its installed path; test helpers reference it via `docker exec`)
- Primer self-check confirms target token percentages are accurate
- Ability to re-prime an existing live session is verified

---

## 2. Test Strategy

### 2.0 Where tests run (host vs container)

**Run all UI tests against a deployed `${WORKBENCH_URL}` — never against an in-process app spun up from a workbench-host shell.** Two acceptable surfaces:

1. **Playwright MCP** (driven from inside Claude Code in this session) → pointed at a deployed Space URL or the irina dev container's URL. The MCP server drives Chromium against HTTP only, never imports server code — so `browser_navigate` / `browser_evaluate` calls against the Space are safe.
2. **Hymie / Hymie2** (remote desktops with real Firefox) → for headed/visual bugs that need actual rendering, also pointed at the deployed URL.

The hard constraint: never run `npm test`, `npm run test:coverage`, `npm run test:live`, `npm run test:browser`, `node --test`, or `c8` from the host shell of a machine that's actually running Workbench (e.g. M5, irina). Those commands import project modules into the host's Node process and end up using the live DB, live `secrets.env` (real webhooks, real API keys), and live tmux server. The Playwright *MCP* path is fine; the Playwright *npm wrapper* path is not.

The runbook's prerequisites section repeats this rule for an executor who skipped the plan.

### 2.1 Principle

Workbench is a UI-first IDE/workbench. Browser tests are the primary acceptance layer. Backend tests verify plumbing; UI tests verify the product works.

### 2.2 Three UI Testing Layers

**Layer U1: Element and Interaction Tests (Mock)**
Verify every visible control exists, is interactable, and performs its declared behavior. Mock backend responses via `page.route()` where needed to force specific UI states (error responses, network partitions, edge-case data). Tests in this layer intercept network requests and do not depend on live container state.

**Layer U2: Workflow Tests (Live)**
Verify realistic end-to-end user tasks through the UI against the live container. Gray-box verification confirms mutations reached the backend (database queries, API checks, container log inspection). Tests in this layer hit the real backend without route interception.

**Layer U3: Terminal-Mediated Functional Tests (Live)**
Verify CLI functions reachable through the Workbench terminal: slash commands, MCP tools, file operations, plan mode, compaction. Tests type commands into the terminal and assert observable outcomes (UI update, file creation, DB change, status bar change). Requires live container with real or stub Claude CLI.

### 2.3 Standing Requirements (All Browser Tests)

Every browser test MUST:

1. **Capture console errors** -- `page.on('console')` listener at setup. Any `console.error` or uncaught exception fails the test.
2. **Capture screenshot** -- At completion, save to `tests/browser/screenshots/{suite}--{test_name}.png`.
3. **Exercise real code** -- Tests run against the live application through Playwright, not local reimplementations.
4. **Use fixture data** -- Test data from `tests/fixtures/`, not hardcoded inline.
5. **Reset baseline** -- Call `resetBaseline(page)` from `tests/helpers/reset-state.js` in `beforeEach()`.

### 2.4 Terminal Content Assertion Method

xterm.js fragments text across `<span>` elements. DOM text selectors will fail. All terminal content assertions MUST use the xterm buffer API:

```javascript
const line = await page.evaluate(
  (row) => window.tabs.get(window.activeTabId)?.term.buffer.active
    .getLine(row)?.translateToString().trim(),
  rowNumber
);
```

### 2.5 Non-Deterministic Testing

Tests involving real Claude CLI output use behavioral assertions:
- Did the expected side effect occur? (file created, DB row written, token count changed)
- Did the response contain structured data in the expected format?
- LLM-as-judge for quality evaluation (judge rubric versioned at `tests/helpers/llm-judge-rubric.md`; Haiku rates output >= 3/5 on 5-point scale)

Standard gate tests use the stub Claude CLI (`tests/fixtures/stub-claude.sh`). Non-deterministic quality tests run separately (nightly/on-demand).

### 2.6 Watcher Timing Tolerance

File-system watchers on Docker-mounted volumes may exhibit higher latency. All watcher-dependent assertions use eventually-consistent polling with a **10s tolerance window** (configurable). A watcher event at 7s instead of 5s is not a failure; not arriving within 10s is.

---

## 3. Test Infrastructure

### 3.1 Isolation

Tests run against the `workbench-test` container on port 7867. Separate Docker Compose project name (`-p workbench-test`), separate network, separate volumes, separate config directory.

### 3.2 Playwright Configuration

`tests/browser/playwright.config.js`:
- Chromium, headless
- Default viewport: 1280x720 (with resize tests at 800x600 and 1920x1080)
- Timeout: 60s per test, 30s for element waits
- Screenshots: on
- Trace: retained on failure
- Base URL: `https://aristotle9-agentic-workbench.hf.space`
- Per-project timeout configuration: stress suite uses 5x timeout multiplier

### 3.3 Test Fixtures

| Fixture | Purpose | Location |
|---------|---------|----------|
| Stub Claude CLI | Configurable deterministic responses | `tests/fixtures/stub-claude.sh` |
| ANSI auth output | Auth URL detection with real escape sequences | `tests/fixtures/ansi-auth-url.txt` |
| Chunked WS frames | Auth URL fragmented across frames | `tests/fixtures/chunked-auth-frames.bin` |
| File tree fixture | Pre-created directory tree for drag-drop and file browser | Created in test workspace volume |
| Primed session JSONL | Pre-filled conversation for threshold tests | Generated by `workbench_primer.py` |
| Settings fixture | Known settings state for persistence tests | `tests/fixtures/settings.json` |
| Task fixtures | Seed tasks for CRUD testing | `tests/fixtures/tasks.json` |
| Message fixtures | Seed messages for message panel testing | `tests/fixtures/messages.json` |

### 3.4 Required Helpers

All shared utilities live in `tests/helpers/`:

| Helper | Purpose |
|--------|---------|
| `reset-state.js` | Baseline reset: close tabs, dismiss modals, clear localStorage, reset filter/sort, truncate test data, kill test tmux sessions |
| `terminal-helpers.js` | `sendTerminalText()`, `sendTerminalEnter()`, `getTerminalText()`, `waitForTerminalContains()`, `waitForTerminalConnected()` |
| `coverage-helpers.js` | `page.coverage` collection + aggregation |
| `wait-helpers.js` | `waitForStatusContextPercent()`, `waitForCompactionCompletion()`, eventually-consistent polling |
| `http-client.js` | Authenticated API calls for gray-box verification |
| `sqlite-helper.js` | `docker exec sqlite3` commands for direct DB verification |
| `visual-reviewer.js` | Screenshot LLM judge (Haiku) |
| `visual-review-rubric.md` | Versioned visual review criteria |
| `llm-judge-rubric.md` | Versioned LLM-as-judge rubric: judge model (Haiku), rating scale (1-5), minimum acceptable (3/5), evaluation dimensions |

### 3.4a Prescribed UI Test Methodology

UI tests follow one prescribed pattern, with one exception. Both surfaces drive the **deployed `${WORKBENCH_URL}`** (HF Space or irina dev container). Neither uses a synthetic stand-in for the CLI.

**Default — Playwright MCP (headless Chromium):**

- Driven from inside this Claude Code session via the Playwright MCP server. `browser_navigate` / `browser_evaluate` / `browser_click` / etc.
- Exercises the **full stack**: UI → WebSocket → tmux pane → real Claude / Gemini / Codex CLI → session JSONL → status-bar / sidebar updates.
- Used for every UI test that is not specifically about real-rendering or OAuth input. This is the default.

**Exception — Hymie / Hymie2 (real Firefox, headed):**

- For visual / rendering bugs that headless Chromium cannot accurately model (font metrics, scrollbar behavior, layout edge cases under real fonts).
- For CLI-input bugs (Ink keyboard handling, /login paste-back, anything that touches how a real terminal forwards keypresses to a TUI).
- Driven via the Hymie MCP tools (`mcp__hymie__*` / `mcp__hymie2__*`) against the same `${WORKBENCH_URL}`.

**Forbidden as test surfaces:**

- Synthetic CLI substitutes (e.g. spawning a `bash` session via `session_new {cli:"bash"}` to "test" `session_send_*` instead of using a real Claude/Gemini/Codex pane). The `session_*` tools are tested by driving real CLI sessions, not by sending text to a generic shell. If the live CLI isn't authenticated on the test host, fix that — don't substitute.
- Mocked WebSocket layers, mocked tmux, in-process app spun up next to the deployed one. The deployed Space/container is the only valid target.
- `npm run test:browser` from the host shell of any workbench-running machine (M5, irina). See §2.0.

The "no synthetic CLI" rule is part of the 100% feature-coverage gate (§3.7). A `session_*` test row that exercised a bash session instead of a real CLI does not count as covering that tool.

### 3.4b Verifiable surfaces — what a runbook entry's verify clauses can observe

Per STD-003 §12.4–§12.6, every runbook entry's verify clauses must name positive-affirmation observables, and the executor agent must affirm each line backed by a screenshot. In this product, "the UI" is the rendered web shell **plus** the CLI sessions running inside its terminal panes **plus** the workbench MCP tools the CLIs call. Three classes of observable count as verifiable UI surface:

**1. Rendered DOM / page state.** Modal headings, sidebar contents, file-tree state, status-bar values, button enabled/disabled, scroll position, theme variables applied. Screenshot the page; the affirmation names the exact text/state observed. Example: *"Modal heading reads exactly 'Create Task' and the Save button is enabled."*

**2. Multi-turn CLI chat with sensible replies.** The agent opens a Claude / Gemini / Codex session in a workbench tab, sends a verifiable prompt (e.g. "what is 7 times 8"), waits for the CLI to reply, and affirms the reply contains the expected answer (`56` with reasoning) — not echoed input, not boilerplate, not a login screen, not a frozen prompt. The affirmation references a screenshot of the terminal pane post-reply. See REG-148-01. Use this surface for any change that touches CLI plumbing (tmux, WebSocket, session resolver, JSONL writer, keepalive, gate, OAuth flow).

**3. CLI use of MCP tools with meaningful results.** The agent in a workbench CLI session invokes a workbench MCP tool (`file_search_code`, `task_add`, `session_summarize`, `gh_issue_view`, etc.) and the result demonstrates the tool ran end-to-end — the right rows changed, the right file was created, the right session got summarised, the right GitHub issue body was retrieved. The affirmation names the observable side effect AND screenshots either the CLI output panel or the workbench panel that reflects the change (Tasks panel showing the new row, Files panel showing the new file). Use this surface for changes touching MCP catalog, tool handlers, MCP-server registration, or any DB/filesystem operation reachable via a tool.

A single runbook entry may combine all three (e.g., a session-creation test that checks the sidebar updates AND the CLI replies AND a `task_add` from inside the chat appears in the Tasks panel). Verify clauses across these surfaces are weighted equally — a DOM-only entry isn't more "rigorous" than a CLI-chat entry; both are positive-affirmation observables of the same product.

What is NOT a verifiable UI surface (these are integration tests per STD-003 §2 — live tier — not UI tests):

- An HTTP route's response shape or status code (e.g. `GET /api/mcp/tools returns 51 names`)
- A database row count or column value (gray-box per STD-005 §7.1; supports a UI test but isn't one)
- A log line or metric counter
- A file's existence on the host filesystem (unless a panel reflects it)
- A WebSocket frame's payload

Heuristic for authors confused on whether a test is integration or UI: if a real user sitting in front of the rendered workbench cannot observe the assertion through the browser or terminal pane, it's an integration test, not a UI test.

The 3-CLI test review at the phase gate enforces this — a runbook entry whose verify clauses are actually integration assertions in disguise gets flagged for rewrite.

### 3.5 Baseline Reset Protocol

Every test starts from a known clean state:
- No stray modals or dynamic overlays open
- No stale extra tabs
- Right panel closed or in known state
- Filter/search/sort reset to defaults
- Browser localStorage cleared
- Test-created sessions/projects/tasks/messages cleaned

### 3.6 Visual Review Protocol (WPR-105 §4.5)

Every browser test produces a screenshot. After suite completion, automated visual review runs.

**Reviewer input:** Each screenshot + test code (what the test claims to verify)

**Visual review rubric** (versioned at `tests/helpers/visual-review-rubric.md`):
- Broken layout (overlapping, clipped, or missing elements)
- Wrong font sizes (too big, too small, inconsistent with settings)
- Error messages visible in terminal, status bar, or console
- Modals or overlays blocking content when they should not be
- Test data pollution (junk names, orphaned sessions, debug text)
- Empty areas where content should exist
- Unreadable text (contrast, color, truncation)
- Scrollbars where there should not be any, or missing where needed
- Inconsistent theme (dark elements in light theme or vice versa)

**Rating:** OK / WARNING / PROBLEM. PROBLEM findings = gate failure.

The rubric file is version-controlled so future reviewers use identical criteria.

### 3.7 Coverage Gating

Two thresholds, both applied independently — **both must pass.**

**Structural coverage (client-side JS):**
- Client-side JS coverage via `page.coverage.startJSCoverage()` / `stopJSCoverage()`
- Threshold: ≥ 90% line / 80% branch on client-side JS
- Coverage gate file (`z-coverage-gate.spec.js`) aggregates all reports and asserts thresholds
- All 54 registered JS functions must be exercised

**Feature coverage (UI surfaces): 100%, no exceptions.**
- Every UI element listed in §5 (sidebar, main area, status bar, right panel, settings modal, auth modal, dynamic overlays — 139 elements) must have at least one PASS row in a Playwright spec or in the runbook's UI phases.
- Every JS function in §6 (54 functions) must be exercised by name in at least one spec.
- Every workflow in §8 must have at least one passing end-to-end test.
- Every CLI category in §9 must have at least one terminal-mediated test that exercises the actual category.
- A UI surface without a UI test is a gate failure. "Mostly covered", "almost all elements", "~95%" are NOT acceptable wording — report the count of uncovered surfaces explicitly. The gate fails the moment any surface from the inventories has no PASS row.

The structural-coverage threshold (90/80) and the feature-coverage threshold (100%) are independent. A spec can boost structural coverage without hitting any new UI surface; it can hit a UI surface without raising structural coverage. The gate cares about both.

---

## 4. Fresh-Container Testing (WPR-103 §12b)

Every gating run starts from a torn-down, rebuilt container:

1. `docker compose -p workbench-test down -v`
2. `docker compose -p workbench-test build --no-cache`
3. `docker compose -p workbench-test up -d`
4. Poll health endpoint until ready
5. Run seed data scripts
6. Execute full test suite

**Fresh-boot verification (FR-01):**
- Open UI against fresh container
- Assert: empty state visible, "No projects" hint shown
- Assert: settings modal defaults correct (Theme: dark)
- Assert: `GET /api/mounts` populates Add Project file tree

---

## 5. UI Element Inventory

Every DOM element with an `id`, semantic role, or interactive behavior. Each maps to at least one test scenario. 139 elements total.

### 5.1 Sidebar (31 elements)

| ID | Element | Type | Tests |
|----|---------|------|-------|
| UI-E01 | `#sidebar` | Container | SB-01 |
| UI-E02 | `#sidebar-header` | Container | SB-01 |
| UI-E03 | `#sidebar-header h1` "Workbench" | Text | SB-01 |
| UI-E04 | `#sidebar-header` Add Project (+) button | Button | SB-02, AP-01..09 |
| UI-E05 | `#sidebar-header` Refresh button | Button | SB-03 |
| UI-E06 | `#filter-bar` | Container | FLT-01 |
| UI-E07 | `#session-filter` (dropdown) | Select | FLT-01..04 |
| UI-E08 | ~~filter buttons~~ | REMOVED | — |
| UI-E09 | ~~filter buttons~~ | REMOVED | — |
| UI-E10 | ~~filter buttons~~ | REMOVED | — |
| UI-E11 | `#session-sort` | Select | SRT-01..03 |
| UI-E12 | `#session-search` | Input | SCH-01..05 |
| UI-E13 | `#project-list` | Container | SB-01 |
| UI-E14 | `.project-group` | Container | SB-01, SB-13 |
| UI-E15 | `.project-header` | Clickable div | SB-04 |
| UI-E16 | `.project-header .arrow` | Indicator | SB-04 |
| UI-E17 | `.project-header .count` | Badge | SB-05, SB-13 |
| UI-E18 | `.project-header .new-btn` (+) | Button | NS-01..09 |
| UI-E19 | ~~`.project-header .term-btn`~~ REMOVED — terminal via + dropdown | — | NF-55 |
| UI-E20 | `.session-item` | Clickable div | SES-01..03, SB-12 |
| UI-E21 | `.session-name` | Text | SES-01, CFG-03 |
| UI-E22 | `.session-actions` | Container | SES-02 |
| UI-E23 | `.session-action-btn.rename` | Button | CFG-01..07 |
| UI-E24 | `.session-action-btn.archive` / `.unarchive` | Button | ARC-01..04 |
| UI-E25 | `.session-action-btn.summary` | Button | SUM-01..05 |
| UI-E26 | `.session-meta` | Container | SB-06 |
| UI-E27 | CLI type label (C/G/X) — replaces `.active-dot` | Indicator | SB-06, NF-57 |
| UI-E28 | `.session-meta .msg-count` | Badge | SB-06 |
| UI-E29 | `#sidebar-footer` | Container | SB-07 |
| UI-E30 | `#sidebar-footer` Settings button | Button | SET-01 |
| UI-E31 | `.session-item.open` | State | SB-12 |

### 5.2 Main Area (16 elements)

| ID | Element | Type | Tests |
|----|---------|------|-------|
| UI-E32 | `#main` | Container | LAY-01 |
| UI-E33 | `#tab-bar` | Container | TAB-01..07 |
| UI-E34 | `.tab` | Clickable div | TAB-02..05 |
| UI-E35 | `.tab.active` | State | TAB-03 |
| UI-E36 | `.tab .tab-status` | Indicator | TAB-06 |
| UI-E37 | `.tab .tab-status.connected` | State | TAB-06 |
| UI-E38 | `.tab .tab-status.disconnected` | State | TAB-06, RCN-01 |
| UI-E39 | `.tab .tab-status.connecting` | State | TAB-06 |
| UI-E40 | `.tab .tab-name` | Text | TAB-02 |
| UI-E41 | `.tab .tab-close` | Button | TAB-04 |
| UI-E42 | `#panel-toggle` | Button | PNL-01 |
| UI-E43 | `#terminal-area` | Container / Drop target | TIO-01, DND-01..04 |
| UI-E44 | `.terminal-pane` | Container | TIO-01 |
| UI-E45 | `.terminal-pane.active` | State | TIO-01, TAB-03 |
| UI-E46 | `#empty-state` | Container | EMP-01..02 |
| UI-E47 | `#status-bar` | Container | STB-01..10 |

### 5.3 Status Bar (10 elements)

| ID | Element | Type | Tests |
|----|---------|------|-------|
| UI-E48 | `.status-item` (Model) | Display | STB-02, STB-09 |
| UI-E49 | `.status-item` (Mode) | Display | STB-03 |
| UI-E50 | `.status-item` (Thinking) | Display | STB-04, STB-10 |
| UI-E51 | `.status-item` (Context) | Display | STB-05 |
| UI-E52 | `.context-bar` | Display | CTX-01..04 |
| UI-E53 | `.context-bar .fill` | Display | CTX-01..04 |
| UI-E54 | `.context-fill-green` | State | CTX-01 |
| UI-E55 | `.context-fill-amber` | State | CTX-02 |
| UI-E56 | `.context-fill-red` | State | CTX-03 |
| UI-E57 | `.status-item` (Connection) | Display | STB-06 |

### 5.4 Right Panel (25 elements)

| ID | Element | Type | Tests |
|----|---------|------|-------|
| UI-E58 | `#right-panel` | Container | PNL-00..02 |
| UI-E59 | `#right-panel.open` | State | PNL-01 |
| UI-E60 | `#panel-header` | Container | PNL-02 |
| UI-E61 | `.panel-tab[data-panel="files"]` | Button | PNL-02 |
| UI-E62 | ~~`.panel-tab[data-panel="notes"]`~~ REMOVED | — | — |
| UI-E63 | `.panel-tab[data-panel="tasks"]` | Button | PNL-02 |
| UI-E64 | ~~`.panel-tab[data-panel="messages"]`~~ REMOVED | — | — |
| UI-E65 | `#panel-content` | Container | PNL-03 |
| UI-E66 | `#panel-files` | Container | FIL-01..10 |
| UI-E67 | `#file-browser-tree` | Container | FIL-01, FIL-08 |
| UI-E68 | `#file-viewer` | Container | FIL-02, FIL-09 |
| UI-E69 | `#file-viewer-name` | Text | FIL-02 |
| UI-E70 | `#file-viewer-content` | Textarea (readonly) | FIL-02, FIL-09 |
| UI-E71 | File viewer close button | Button | FIL-03 |
| UI-E72 | ~~`#panel-notes`~~ REMOVED — notes in config modal | — | — |
| UI-E73 | ~~`#notes-editor`~~ REMOVED | — | — |
| UI-E74 | `#panel-tasks` | Container | TSK-01 |
| UI-E75 | `#task-list` | Container | TSK-01..06 |
| UI-E76 | `#add-task-input` | Input | TSK-02 |
| UI-E77 | `.task-item` | Container | TSK-03..06 |
| UI-E78 | `.task-checkbox` | Checkbox | TSK-03..04 |
| UI-E79 | `.task-text` | Text | TSK-03 |
| UI-E80 | `.task-delete` | Button | TSK-05 |
| UI-E81 | ~~`#panel-messages`~~ REMOVED | — | — |
| UI-E82 | ~~`#message-list`~~ REMOVED | — | — |

### 5.5 Settings Modal (28 elements)

| ID | Element | Type | Tests |
|----|---------|------|-------|
| UI-E83 | `#settings-modal` | Modal | SET-01..03 |
| UI-E84 | `#settings-modal.visible` | State | SET-01 |
| UI-E85 | `.settings-close` | Button | SET-02 |
| UI-E86 | `[data-settings-tab="general"]` | Tab button | SET-04, NF-39 |
| UI-E86a | `[data-settings-tab="claude"]` | Tab button (NEW) | NF-41 |
| UI-E86b | `[data-settings-tab="vector"]` | Tab button (NEW) | NF-43 |
| UI-E87 | `[data-settings-tab="prompts"]` | Tab button | SET-04 |
| UI-E88 | `#settings-general` | Container | SET-04 |
| UI-E88a | `#settings-claude` | Container (NEW) | NF-41 |
| UI-E88b | `#settings-vector` | Container (NEW) | NF-43 |
| UI-E89 | `#settings-prompts` | Container | SET-04 |
| UI-E90 | `#setting-theme` | Select | THM-01..04 |
| UI-E91 | `#setting-font-size` | Number input | FNT-01..02, VAL-06 |
| UI-E92 | `#setting-font-family` | Select | FNT-03..04 |
| UI-E93 | `#setting-model` | Select | MDL-01 |
| UI-E94 | `#setting-thinking` | Select | MDL-02 |
| UI-E95 | `#setting-keepalive-mode` | Select | KAL-01 |
| UI-E96 | `#setting-idle-minutes` | Number input | KAL-02 |
| UI-E97 | ~~`#setting-quorum-lead`~~ REMOVED | — | — |
| UI-E98 | ~~`#setting-quorum-fixed`~~ REMOVED | — | — |
| UI-E99 | ~~`#setting-quorum-additional`~~ REMOVED | — | — |
| UI-E100 | ~~`#setting-tasks`~~ REMOVED | — | — |
| UI-E101 | `#mcp-server-list` | Container | MCP-01..03 |
| UI-E102 | `#add-mcp-form` | Container | MCP-02 |
| UI-E103 | `#mcp-name` | Input | MCP-02, VAL-05 |
| UI-E104 | `#mcp-command` | Input | MCP-02 |
| UI-E105 | `#add-mcp-form` Add button | Button | MCP-02 |
| UI-E106 | `.mcp-server-item .remove` | Button | MCP-03 |
| UI-E107 | `#setting-global-claude-md` | Textarea | PRM-01 |
| UI-E108 | Global CLAUDE.md Save button | Button | PRM-01 |
| UI-E109 | `#setting-project-template` | Textarea | PRM-02 |
| UI-E110 | Project template Save button | Button | PRM-02 |

### 5.6 Auth Modal (7 elements)

| ID | Element | Type | Tests |
|----|---------|------|-------|
| UI-E111 | `#auth-modal` | Modal | AUTH-01..10 |
| UI-E112 | `#auth-modal.visible` | State | AUTH-02, AUTH-10 |
| UI-E113 | `#auth-modal .modal-close` | Button | AUTH-03 |
| UI-E114 | `#auth-link` | Link | AUTH-04 |
| UI-E115 | `#auth-code-input` | Input | AUTH-05 |
| UI-E116 | `#auth-code-submit` | Button | AUTH-05 |
| UI-E117 | `#auth-banner` (dynamic) | Banner | AUTH-06..07 |

### 5.7 Dynamic Overlays (22 elements)

| ID | Element | Type | Tests |
|----|---------|------|-------|
| UI-E118 | New session overlay | Modal | NS-01..09 |
| UI-E119 | `#new-session-name` | Session name input | NS-02 |
| UI-E120 | `#new-session-submit` ("Start Session") | Button | NS-03, NS-08 |
| UI-E121 | New session overlay close button (X) | Button | NS-09 |
| UI-E122 | New session overlay Cancel button | Button | NS-06 |
| UI-E123 | Session config overlay | Modal | CFG-01..07 |
| UI-E124 | `#cfg-name` | Input | CFG-02 |
| UI-E125 | `#cfg-state` | Select | CFG-02, ARC-03..04 |
| UI-E126 | `#cfg-notes` | Textarea | CFG-02 |
| UI-E127 | Config notes clear button | Button | CFG-06 |
| UI-E128 | Config name clear button | Button | CFG-05 |
| UI-E129 | Config Save button | Button | CFG-03 |
| UI-E130 | Config overlay close button (X) | Button | CFG-04 |
| UI-E131 | Summary overlay | Modal | SUM-01..05 |
| UI-E132 | `#summary-content` | Container | SUM-02 |
| UI-E133 | Summary overlay close button (X) | Button | SUM-05 |
| UI-E134 | Add project overlay | Modal | AP-01..10 |
| UI-E135 | `#jqft-tree` | Container | AP-02 |
| UI-E136 | `#picker-path` | Input | AP-03 |
| UI-E137 | `#picker-name` | Input | AP-03 |
| UI-E138 | Picker Add button | Button | AP-04 |
| UI-E139 | Add project overlay close button (X) | Button | AP-09 |

**Total: 139 UI elements. Every element maps to at least one test scenario.**

---

## 5a. Capability Audit (WPR-103 §4.1)

Every system capability reachable through the UI, categorized as REAL (tested against live container), MOCK (tested with mocked/intercepted responses), or BOTH.

| Capability | Category | Test Coverage | Notes |
|------------|----------|---------------|-------|
| Page load and layout rendering | REAL | LAY-01..05 | |
| Initialization sequence | REAL | INIT-01 | |
| Sidebar project/session list | REAL | SB-01..13 | |
| Session filter (active/all/archived/hidden) | REAL | FLT-01..04 | |
| Session sort (date/name/messages) | REAL | SRT-01..03 | |
| Session search | BOTH | SCH-01..04 (REAL), SCH-05 (MOCK) | MOCK for error path |
| Empty state display | REAL | EMP-01..02 | |
| Session opening/resume | BOTH | SES-01..03 (REAL), SES-04 (MOCK) | MOCK for error path |
| New session creation | REAL | NS-01..09 | |
| Tab management (create/switch/close) | REAL | TAB-01..07 | |
| Terminal I/O (xterm.js + WebSocket) | REAL | TIO-01..05 | |
| Open bash terminal | REAL | TRM-01..02 | |
| Session config (rename/state/notes) | REAL | CFG-01..07 | |
| Archive/unarchive/hide sessions | REAL | ARC-01..04 | |
| Session summary generation | BOTH | SUM-01..03, SUM-05 (REAL), SUM-04 (MOCK) | MOCK for error |
| Right panel toggle and tabs | REAL | PNL-00..05 | |
| File browser and viewer | BOTH | FIL-01..04, FIL-07..10 (REAL), FIL-05..06 (MOCK) | MOCK for fallback/error |
| Notes autosave | REAL | NTS-01..04 | |
| Task CRUD | REAL | TSK-01..06 | |
| Messages display | REAL | MSG-01..02 | |
| Settings modal (open/close/tabs) | REAL | SET-01..07 | |
| Theme switching | REAL | THM-01..04 | |
| Font size/family | REAL | FNT-01..04, VAL-06 | |
| Model/thinking/keepalive/quorum settings | REAL | MDL-01..02, KAL-01..02, QRM-01..03, FTR-01 | |
| MCP server management | BOTH | MCP-01..04 (REAL), VAL-05 (REAL) | |
| System prompts (CLAUDE.md, template) | REAL | PRM-01..03 | |
| Auth URL detection from terminal | MOCK | AUTH-01..02, AUTH-09 | Fixture-driven |
| Auth modal interaction | REAL | AUTH-03..05 | |
| Auth banner (valid/invalid) | MOCK | AUTH-06..07 | Route-intercepted |
| Auth detection suppression (already visible) | MOCK | AUTH-10 | |
| Add project (local directory) | REAL | AP-01..06, AP-09 | |
| Add project (git clone) | REAL | AP-07..08, AP-10 | |
| Status bar display | REAL | STB-01..10 | |
| Status bar model shortening | REAL | STB-09 | |
| Status bar thinking conditional | REAL | STB-10 | |
| Context bar colors | MOCK | CTX-01..04 | Injected token data |
| Drag and drop to terminal | REAL | DND-01..04 | |
| WebSocket reconnection | REAL | RCN-01..08 | |
| WebSocket `settings_update` handler | MOCK | RCN-09 | Injected WS message |
| WebSocket `error` message handler | MOCK | RCN-10 | Injected WS message |
| Auto-refresh timers | REAL | REF-01..04 | |
| Auto-refresh stability during modal | REAL | REF-04 | |
| Keyboard shortcuts | REAL | KEY-01..05 | |
| Input validation | BOTH | VAL-01..06 | |
| Temp session ID resolution | REAL | RACE-01..03 | |
| Modal overlap handling | REAL | MOD-01..04 | |
| Safe HTML rendering (escHtml) | REAL | ESC-01..04 | |
| Session lifecycle (tmux death) | REAL | LIFE-01 | |
| Button state recovery on error | MOCK | UI-ERR-01..02 | Route-intercepted |
| Network error propagation | MOCK | FAIL-01..02 | Route-intercepted |
| Token polling degraded state | MOCK | STB-08 | Route-intercepted |
| Context stress (progressive fill) | REAL | CST-01..04 | |
| Compaction pipeline stages | REAL | CST-05..08, CST-13..15 | |
| Compaction checker protocol | REAL | CST-19 | |
| Multi-cycle compaction | REAL | CST-09..11 | |
| Compaction lock contention | REAL | CST-20 | |
| Compaction cold recall | REAL | CST-12 | |
| Compaction failure paths | REAL | CST-16..18 | |
| Hot-reload (settings/config/prompts) | REAL | HR-01..04 | |
| Fresh-container boot state | REAL | FR-01 | |
| Slash commands (representative) | REAL | CLI-01..06 | |
| File operations via Claude | REAL | CLI-07..09 | |
| MCP tool invocation (representative) | REAL | CLI-10..14 | |
| Plan mode via terminal | REAL | CLI-15..17 | |
| Terminal input handling | REAL | CLI-18..20 | |
| Workbench JSON protocol parsing | REAL | CLI-21 | |

**Zero NONE entries.** All capabilities have test coverage.

---

## 6. JS Function Inventory

Every named function defined in `public/index.html`. Each maps to at least one test scenario. 54 functions total.

Note: Functions from server-side files (`mcp-server.js`, `server.js`, `scripts/prime-test-session.js`) are excluded from this inventory. This inventory covers browser-side code only.

| ID | Function | Tests |
|----|----------|-------|
| FN-01 | `loadState()` | SB-01, SB-03, REF-01, RACE-01, REF-04 |
| FN-02 | `renderSidebar()` | SB-01, SB-08, SB-13 |
| FN-03 | `setFilter(filter)` | FLT-01..04 |
| FN-04 | `openSession(session, projectName)` | SES-01..03, SB-12 |
| FN-05 | `createSession(projectName)` | NS-01..09 |
| FN-06 | `openTerminal(projectName)` | TRM-01..02 |
| FN-07 | `createTab(tabId, tmuxSession, name, project)` | TAB-01..02 |
| FN-08 | `switchTab(tabId)` | TAB-03 |
| FN-09 | `closeTab(tabId)` | TAB-04..05 |
| FN-10 | `showEmptyState()` | EMP-01..02 |
| FN-11 | `renderTabs()` | TAB-01 |
| FN-12 | `connectTab(tabId)` | TIO-01, RCN-01..10 |
| FN-13 | `renameSession(sessionId, currentName)` | CFG-01..04 |
| FN-14 | `saveSessionConfig(sessionId, overlayId)` | CFG-03 |
| FN-15 | `archiveSession(sessionId, archived)` | ARC-01..02 |
| FN-16 | `togglePanel()` | PNL-01 |
| FN-17 | `switchPanel(panel)` | PNL-02 |
| FN-18 | `getCurrentProject()` | PNL-00, PNL-03 |
| FN-19 | `loadPanelData()` | PNL-00, PNL-03..05 |
| FN-20 | `loadTasks(project)` | TSK-01 |
| FN-21 | `renderTasks(tasks)` | TSK-01 |
| FN-22 | `loadMessages(project)` | MSG-01 |
| FN-23 | `loadFiles()` | FIL-01, FIL-08, FIL-10 |
| FN-24 | `openFileBrowserFile(filePath)` | FIL-02, FIL-08 |
| FN-25 | `closeFileViewer()` | FIL-03 |
| FN-26 | `checkForAuthIssue(tabId, data)` | AUTH-01..02, AUTH-09, AUTH-10 |
| FN-27 | `showAuthModal(url, tabId)` | AUTH-02 |
| FN-28 | `dismissAuthModal()` | AUTH-03 |
| FN-29 | `submitAuthCode()` | AUTH-05 |
| FN-30 | `updateStatusBar()` | STB-01..10, RCN-09 |
| FN-31 | `pollTokenUsage()` | STB-05, STB-08, CTX-01 |
| FN-32 | `applyTheme(theme)` | THM-01..04 |
| FN-33 | `applyFontSize(size)` | FNT-01..02, VAL-06 |
| FN-34 | `applyFontFamily(family)` | FNT-03..04 |
| FN-35 | `loadAppearanceSettings()` | SET-05, REF-03 |
| FN-36 | `addProject()` | AP-01..10 |
| FN-37 | `pickerSelect(overlayId)` | AP-04 |
| FN-38 | `openSettings()` | SET-01 |
| FN-39 | `closeSettings()` | SET-02..03 |
| FN-40 | `saveSetting(key, value)` | SET-06, VAL-04, VAL-06 |
| FN-41 | `switchSettingsTab(tab)` | SET-04 |
| FN-42 | `saveGlobalClaudeMd()` | PRM-01 |
| FN-43 | `saveProjectTemplate()` | PRM-02 |
| FN-44 | `loadMcpServers()` | MCP-01 |
| FN-45 | `addMcpServer()` | MCP-02..04, VAL-05 |
| FN-46 | `removeMcpServer(name)` | MCP-03 |
| FN-47 | `checkAuth()` | AUTH-06..07, REF-02 |
| FN-48 | `showAuthBanner(reason)` | AUTH-06 |
| FN-49 | `hideAuthBanner()` | AUTH-07 |
| FN-50 | `timeAgo(timestamp)` | SB-06 |
| FN-51 | `escHtml(str)` | ESC-01..04 |
| FN-52 | `summarizeSession(sessionId, projectName, sessionName)` | SUM-01..05 |
| FN-53 | `renderSearchResults(results)` | SCH-03 |
| FN-54 | `db_getSetting(key)` | SET-05 |

---

## 7. Test Scenarios by Component

### 7.1 Layout and Page Load (`layout.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| LAY-01 | Page loads with all structural containers | Live | Navigate to `/` | `#sidebar`, `#main`, `#tab-bar`, `#terminal-area`, `#right-panel` exist. No console errors. |
| LAY-02 | Sidebar has correct min-width | Live | Load page | `#sidebar` computed width equals 280px |
| LAY-03 | Main area fills remaining space | Live | Load page | `#main` flex:1 fills horizontal space minus sidebar |
| LAY-04 | Body has no scroll | Live | Load page | `document.body` overflow hidden, no scrollbar |
| LAY-05 | Page title is "Workbench" | Live | Load page | `document.title === 'Workbench'` |

### 7.2 Initialization (`init.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| INIT-01 | Inline initialization sequence | Live | Page load on fresh container | `loadState()` called (fetch to `/api/state`); `loadAppearanceSettings()` called (fetch to `/api/settings`); `checkAuth()` called after 1s delay (fetch to `/api/auth/status`); `setInterval` timers registered for state refresh (30s) and auth check (60s). Verified via network request interception, not function references. |

### 7.3 Error Handling (`fetch-errors.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| FAIL-01 | Server error on `/api/state` during `loadState` | Mock | Mock `/api/state` to return 500 via `page.route()` | Error reaches `loadState`'s catch path; console.error logged (captured by listener); sidebar degrades gracefully (no crash, no blank screen). Test verifies the specific `loadState` call site, not a generic `fetchJSON` wrapper. |
| FAIL-02 | Network failure on API call | Mock | Mock network failure via `page.route()` abort | Error propagates; UI degrades gracefully (no crash, no blank screen) |

### 7.4 Sidebar and Projects (`sidebar.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| SB-01 | Sidebar renders project list from server | Live | Page load with seed data | `#project-list` contains `.project-group` elements matching `/api/state` count |
| SB-02 | Add project button exists and is clickable | Live | Click "+" in sidebar header | Add project overlay appears |
| SB-03 | Refresh button calls loadState | Live | Click refresh button | Fetch to `/api/state` made; sidebar re-renders |
| SB-04 | Project expand/collapse toggles session list | Live | Click `.project-header` | `.arrow` rotates, `.session-list` toggles `.collapsed`; click again reverses |
| SB-05 | Project header shows filtered count | Live | Set filter to "active" | `.count` badge shows number matching active sessions |
| SB-06 | Session metadata displays correctly | Live | Page load with seed sessions | `.session-meta` shows timeAgo string, msg-count, active-dot for active sessions |
| SB-07 | Sidebar footer contains settings button | Live | Page load | `#sidebar-footer` contains Settings button |
| SB-08 | Hash-based skip optimization | Live | Call `renderSidebar()` twice with unchanged state | Second call skips re-render (hash unchanged) |
| SB-09 | Missing project shows indicator | Live | Seed state with `missing: true` project | `.project-header.missing` rendered with reduced opacity |
| SB-10 | Missing session styling | Live | Seed state with `project_missing: true` session | `.session-item.missing` has opacity 0.5, cursor not-allowed |
| SB-11 | Clicking missing session shows alert | Live | Click `.session-item.missing` | Alert with "Project directory not found" |
| SB-12 | Open-but-not-focused session styling | Live | Open two sessions; second is active | First session's sidebar item has `.open` class and accent border; does NOT have `.active` class |
| SB-13 | Project group with zero matching sessions | Live | Seed project with only archived sessions; set filter to "active" | Project group renders with `.count` badge showing 0; no sessions visible under that group; project header still present and clickable |

### 7.5 Session Filter and Sort (`filter-sort.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| FLT-01 | Active filter is default | Live | Page load | `#session-filter` dropdown value is "active" |
| FLT-02 | "All" shows non-hidden sessions | Live | Select "all" in dropdown | Session count >= active count; hidden excluded |
| FLT-03 | Archived filter shows only archived | Live | Select "archived" | Only `.session-item.archived` visible |
| FLT-04 | Hidden filter shows only hidden | Live | Select "hidden" | Only hidden sessions visible |
| SRT-01 | Sort by name orders alphabetically | Live | Select "Name" | Session names in each project group are alphabetical |
| SRT-02 | Sort by messages orders by count | Live | Select "Messages" | Sessions ordered descending by msg-count |
| SRT-03 | Sort by date is default | Live | Page load | `#session-sort` value is "date" |

### 7.6 Session Search (`search.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| SCH-01 | Search input exists and is focusable | Live | Page load | `#session-search` exists, can receive focus |
| SCH-02 | Typing triggers debounced search | Live | Type "test" | After 300ms, fetch to `/api/search?q=test` |
| SCH-03 | Search results replace sidebar | Live | Type matching term | `#project-list` shows search result items with name, project, snippet |
| SCH-04 | Clearing search restores sidebar | Live | Clear input (< 2 chars) | Normal project/session list restored |
| SCH-05 | Search API failure | Mock | Mock `/api/search` to return 500 | No crash; sidebar remains in pre-search state or shows error indication |

### 7.7 Empty State (`empty-state.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| EMP-01 | Empty state shows when no tabs | Live | Page load without opening session | `#empty-state` visible with hint text |
| EMP-02 | Empty state returns after closing last tab | Live | Open session, close tab | `#empty-state` re-appears |

### 7.8 Session Opening (`session-open.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| SES-01 | Clicking session opens tab | Live | Click `.session-item` | POST to `/api/sessions/:id/resume`; tab created; terminal connects |
| SES-02 | Session actions appear on hover | Live | Hover `.session-item` | `.session-actions` visible with rename, archive, summary buttons |
| SES-03 | Re-clicking open session switches tab | Live | Click session already in tab | `switchTab()` called; no duplicate tab |
| SES-04 | Resume failure shows error | Mock | Mock `/api/sessions/:id/resume` to return 500 | Alert or error shown; no orphaned tab |

### 7.9 New Session Creation (`new-session.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| NS-01 | "+" opens new session modal | Live | Click `.new-btn` | Overlay with textarea, "Start Session", Cancel, Close (X) |
| NS-02 | Empty prompt rejected | Live | Click "Start Session" with empty textarea | Modal stays open, textarea focused |
| NS-03 | Valid prompt creates session | Live | Type prompt, click "Start Session" | POST to `/api/sessions`; overlay removed; tab created; sidebar refreshed |
| NS-04 | Ctrl+Enter submits | Live | Type prompt, Ctrl+Enter | Same as NS-03 |
| NS-05 | Rapid double-click prevention | Live | Click "+" twice rapidly | At most one overlay |
| NS-06 | Cancel closes modal | Live | Click Cancel | Overlay removed, no session created |
| NS-07 | Backdrop click closes | Live | Click outside modal content | Overlay removed |
| NS-08 | Submit shows "Creating..." state | Live | Submit valid prompt | Button text "Creating...", disabled |
| NS-09 | Close button (X) closes modal | Live | Click X button | Overlay removed, no session created |

### 7.10 Tab Management (`tabs.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| TAB-01 | Tab bar empty when no sessions | Live | Page load | Zero `.tab` elements |
| TAB-02 | Opening session creates tab | Live | Open session | `.tab` in tab bar with correct name |
| TAB-03 | Switching tabs changes active terminal | Live | Open 2 sessions, click second | Second tab active; its pane visible; first hidden |
| TAB-04 | Close button removes tab and disconnects WS | Live | Click `.tab-close` | Tab removed; pane removed; WebSocket closed |
| TAB-05 | Closing last tab shows empty state | Live | Close only tab | `#empty-state` appears; status bar hidden |
| TAB-06 | Tab status indicator reflects connection | Live | Open session | `.tab-status.connected` when WS open |
| TAB-07 | Rapid tab switching stability | Live | Open 3 sessions, switch 10x in 2s | No crash, no console errors, correct final state |

### 7.11 Terminal I/O (`terminal-io.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| TIO-01 | Terminal connects and receives output | Live | Open session with stub CLI | Terminal pane receives output (xterm buffer API) |
| TIO-02 | Typing sends data via WebSocket | Live | Focus terminal, type "echo hello" | WS sends typed characters; terminal echoes them |
| TIO-03 | Terminal resize on window resize | Live | Resize viewport to 1920x1080 | fitAddon.fit() called; resize message sent via WS |
| TIO-04 | Terminal resize when panel opens | Live | Toggle right panel | Terminal refits to smaller width after 250ms |
| TIO-05 | Binary data renders in terminal | Live | WS sends ArrayBuffer | `term.write(new Uint8Array(data))` processes without error |

### 7.12 Open Terminal (`open-terminal.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome | Gray-Box |
|----|----------|-------|-------|-------------------|----------|
| TRM-01 | Terminal via + dropdown creates bash session | Live | Click `+` on project header, select "Terminal" | POST to `/api/terminals`; new tab created | tmux session exists |
| TRM-02 | Terminal accepts shell commands | Live | Open terminal, type `ls` + Enter | Output shown in terminal | -- |

### 7.13 Session Config (`session-config.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome | Gray-Box |
|----|----------|-------|-------|-------------------|----------|
| CFG-01 | Config button opens overlay | Live | Click rename button | Config overlay with Name, State, Notes pre-populated | -- |
| CFG-02 | Config fields are editable | Live | Type new name, select state, type notes | Values change | -- |
| CFG-03 | Save persists to server | Live | Edit name, click Save | PUT to `/api/sessions/:id/config`; overlay removed; sidebar updated | DB `sessions` table updated |
| CFG-04 | Close button (X) dismisses overlay | Live | Click close button | Overlay removed, no save | -- |
| CFG-05 | Name clear button empties field | Live | Click clear button next to name input | Input cleared, refocused | -- |
| CFG-06 | Notes clear button empties field | Live | Click clear button next to notes textarea | Notes textarea cleared, refocused | -- |
| CFG-07 | Backdrop click dismisses overlay | Live | Click outside config modal content | Overlay removed, no save | -- |

### 7.14 Archive / Unarchive / Hidden State (`archive.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome | Gray-Box |
|----|----------|-------|-------|-------------------|----------|
| ARC-01 | Archive session | Live | Click archive on active session | PUT with `{archived: true}`; session moves to archived filter | DB state = `archived` |
| ARC-02 | Unarchive session | Live | Click unarchive on archived session | PUT with `{archived: false}`; session returns to active | DB state restored |
| ARC-03 | Set session to hidden via config | Live | Open config, select "hidden" in `#cfg-state`, save | Session disappears from active list; appears under Hidden filter | DB state = `hidden` |
| ARC-04 | Unhide session | Live | Change state from "hidden" back to "active" via config | Session returns to active list | DB state = `active` |

### 7.15 Session Summary (`summary.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| SUM-01 | Summary button opens overlay with spinner | Live | Click summary button | Summary overlay with "Generating summary..." spinner |
| SUM-02 | Summary content replaces spinner | Live | Wait for POST response | `#summary-content` shows text |
| SUM-03 | Summary closes on backdrop click | Live | Click outside content | Overlay removed |
| SUM-04 | Error displays error message | Mock | Summary endpoint returns error | Error text shown in `#summary-content` |
| SUM-05 | Close button (X) closes summary | Live | Click X button | Overlay removed |

### 7.16 Right Panel (`right-panel.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| PNL-00 | Panel opened with no active session | Live | Page load (no session opened); click `#panel-toggle`; click each panel tab | Panel opens; no crash; no console.error; each tab shows empty/placeholder state or is gracefully disabled; `getCurrentProject()` null case handled |
| PNL-01 | Toggle opens/closes panel | Live | Click `#panel-toggle` | `#right-panel` gains/loses `.open` class (width 320px / 0) |
| PNL-02 | Tabs switch visible section | Live | Click each tab | Corresponding panel-section visible; others hidden |
| PNL-03 | Panel data loads for active project | Live | Open session, open panel | `loadPanelData()` called with correct project |
| PNL-04 | Panel reloads on tab switch | Live | Open 2 sessions, switch with panel open | Content refreshes for new project |
| PNL-05 | Panel shows correct data after project switch | Live | Open session A, open panel with notes, switch to session B | Panel content reflects project B, no stale data from project A |

### 7.17 Files Panel (`files-panel.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| FIL-01 | File browser renders mount points | Live | Open panel, Files tab | `#file-browser-tree` shows mount sections from `/api/mounts` |
| FIL-02 | Click file opens viewer | Live | Click file in tree | `#file-viewer` visible; name and content populated |
| FIL-03 | File viewer close works | Live | Open file, click close | `#file-viewer` hidden; content cleared |
| FIL-04 | Mount header expand/collapse | Live | Click mount header | Arrow rotates; tree shows/hides |
| FIL-05 | Mounts fallback to workspace root | Mock | Mock `/api/mounts` to return `[]` | File browser still shows content from fallback `/workspace/projects` path |
| FIL-06 | File read error shows graceful UX | Mock | Mock `/api/file` to return 413 or 500 | Viewer shows error message or remains empty; no crash |
| FIL-07 | Switching files updates viewer correctly | Live | Click file A, then file B | Viewer shows file B name and content; no stale file A content |
| FIL-08 | Multi-depth tree expansion | Live | Expand mount section; expand directory; expand subdirectory; click file at depth 3 | All levels expand correctly; file content loads in viewer; tree state preserved |
| FIL-09 | File viewer is readonly | Live | Open file in viewer; attempt to type in `#file-viewer-content` | Content does not change; textarea `readonly` attribute enforced |
| FIL-10 | Multiple mount points render | Live | Seed container with two distinct mount paths | Both mount sections appear in `#file-browser-tree`; each expandable independently |

### 7.18 Notes Panel — REMOVED

Notes panel removed from right panel. Project notes are now in the project config modal. NTS-01..04 permanently removed.

### 7.19 Tasks Panel — Filesystem Tree (`task-tree.spec.js`, `multi-cli-and-editors.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome | Gray-Box |
|----|----------|-------|-------|-------------------|----------|
| TSK-01 | Task tree loads filesystem folders | Live | Open panel, Tasks tab | `#task-tree` shows folders from /api/mounts | -- |
| TSK-02 | Expand folder shows subfolders | Live | Click folder arrow | Subfolders and tasks appear; arrow rotates 90deg | -- |
| TSK-03 | Right-click folder shows context menu | Live | Right-click `.task-folder-label` | Menu with "Add Task" and "New Folder" | -- |
| TSK-04 | Add task via context menu | Live | Add Task → enter title | Task created in DB, appears in tree as `.task-node` | DB has new row |
| TSK-05 | Complete task via checkbox | Live | Click checkbox on `.task-node` | PUT to complete; status='done' in DB | -- |
| TSK-06 | Delete task via ✕ button | Live | Click `.task-delete` | DELETE; task removed from tree and DB | -- |
| TSK-07 | Right-click task shows context menu | Live | Right-click `.task-node` | Menu with Edit, Complete, Archive, Delete | -- |
| TSK-08 | Task badge count on folders | Live | Add tasks to folder | Badge shows count next to folder name | -- |
| TSK-09 | Expand state preserved on panel switch | Live | Expand folder, switch to Files, switch back | Folder still expanded | -- |

### 7.19b File Editors — Save/Save As (`multi-cli-and-editors.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome | Gray-Box |
|----|----------|-------|-------|-------------------|----------|
| EDT-01 | Editor toolbar present for text files | Live | Double-click .js/.md file | `.editor-toolbar` with Save and Save As buttons | -- |
| EDT-02 | Save disabled when clean | Live | Open file, check button | `.editor-save-btn` disabled, opacity 0.5 | -- |
| EDT-03 | Save enabled when dirty | Live | Edit file content | `.editor-save-btn` enabled, opacity 1 | -- |
| EDT-04 | Save persists file to disk | Live | Edit, click Save | File content on disk matches edit; dirty reset | -- |
| EDT-05 | Tab dirty indicator | Live | Edit file | `.tab-dirty` class on tab element | -- |
| EDT-06 | Close dirty tab shows confirm | Live | Edit, close tab | `confirm()` dialog, cancel keeps tab | -- |
| EDT-07 | No toolbar for images | Live | Open .png file | No `.editor-toolbar` in image pane | -- |
| EDT-08 | CodeMirror for code files | Live | Open .js file | `.cm-editor` rendered | -- |
| EDT-09 | Toast UI for markdown | Live | Open .md file | `.toastui-editor-defaultUI` rendered | -- |

### 7.19c Multi-CLI Sessions (`multi-cli-and-editors.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome | Gray-Box |
|----|----------|-------|-------|-------------------|----------|
| CLI-01 | + dropdown shows all CLI types | Live | Click + on project | C Claude, G Gemini, X Codex, Terminal | -- |
| CLI-02 | Create Claude session | Live | + → Claude → prompt → Start | Tab opens, terminal connects, cli_type='claude' | -- |
| CLI-03 | Create Gemini session | Live | POST /api/sessions cli_type=gemini | Session in state with cli_type='gemini', active | -- |
| CLI-04 | Create Codex session | Live | POST /api/sessions cli_type=codex | Codex CLI launches, session in state | -- |
| CLI-05 | Gemini session persists | Live | Create, wait 6s | Session not cleaned up by reconciler | -- |
| CLI-06 | CLI type indicators in sidebar | Live | Create mixed sessions | C/G/X badges with correct titles | -- |
| CLI-07 | Empty prompt rejected | Live | Submit with empty textarea | Modal stays, no session created | -- |
| CLI-08 | Sidebar click opens session | Live | Click session in sidebar | Tab opens, terminal connects | -- |
| CLI-09 | Connect by name query | Live | MCP connect action with query | Returns matching session | -- |
| CLI-10 | Restart preserves CLI type | Live | MCP restart Codex session | Returns restarted:true, cli:'codex' | -- |

### 7.19d System Prompts (`multi-cli-and-editors.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome | Gray-Box |
|----|----------|-------|-------|-------------------|----------|
| PMP-01 | CLAUDE.md seeded | Live | Read /data/.claude/CLAUDE.md | Has Identity, Purpose, Resources sections | -- |
| PMP-02 | GEMINI.md seeded | Live | Read /data/.claude/GEMINI.md | Has Identity, Purpose, Resources; identifies Gemini | -- |
| PMP-03 | AGENTS.md seeded | Live | Read /data/.claude/AGENTS.md | Has Identity, Purpose, Resources; identifies Codex | -- |
| PMP-04 | HHH purpose shared | Live | Read all three | All contain "helpful, harmless, and honest" | -- |

### 7.20 Messages Panel — REMOVED

Messages panel and inter-session messaging removed. Replaced by tmux (#51). MSG-01..02 permanently removed.

### 7.21 Settings Modal (`settings.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| SET-01 | Settings button opens modal | Live | Click Settings in footer | `#settings-modal` gets `.visible`; settings loaded |
| SET-02 | Close button dismisses | Live | Click `.settings-close` | `.visible` removed |
| SET-03 | Escape closes modal | Live | Press Escape | `.visible` removed |
| SET-04 | Tabs switch General/Claude Code/Vector Search/Prompts | Live | Click each tab | Corresponding section visible; others hidden. 4 tabs total. |
| SET-05 | Settings load from server | Live | Open settings | All selects/inputs populated from `/api/settings` |
| SET-06 | Settings persist via PUT | Live | Change theme | PUT to `/api/settings`; `_settingsCache` updated |
| SET-07 | Settings persist after reload | Live | Change theme, reload | Theme still applied |

### 7.22 Theme (`theme.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| THM-01 | Dark theme default | Live | Load page | `--bg-primary: #0d1117` |
| THM-02 | Light theme | Live | Select "Light" | `--bg-primary: #f5f5f5`; terminal theme updates |
| THM-03 | Workbench Dark | Live | Select "Workbench Dark" | `--bg-primary: #081220` |
| THM-04 | Workbench Light | Live | Select "Workbench Light" | `--bg-primary: #e8f0f8` |

### 7.23 Font Settings (`font.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| FNT-01 | Font size applies to terminal | Live | Change to 18 | Terminal fontSize is 18; fitAddon.fit() called |
| FNT-02 | Font size persists | Live | Change to 18 | PUT with `{key: "font_size", value: 18}` |
| FNT-03 | Font family applies | Live | Select "Fira Code" | Terminal fontFamily updated |
| FNT-04 | Font family persists | Live | Change family | PUT with key "font_family" |

### 7.24 Model and Behavior Settings (`model-settings.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| MDL-01 | Default model saves | Live | Select "Opus 4.6" | PUT with default_model |
| MDL-02 | Thinking level saves | Live | Select "High" | PUT with thinking_level |
| KAL-01 | Keepalive mode saves | Live | Select "browser" | PUT with keepalive_mode |
| KAL-02 | Idle timeout saves | Live | Change to 60 | PUT with keepalive_idle_minutes |
| QRM-01..03 | ~~Quorum settings~~ | REMOVED | — | Quorum feature deleted |
| FTR-01 | ~~Tasks toggle~~ | REMOVED | — | Dead UI removed |

### 7.25 MCP Server Management (`mcp-servers.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome | Gray-Box |
|----|----------|-------|-------|-------------------|----------|
| MCP-01 | Server list loads | Live | Open settings | List from `/api/mcp-servers` or "No MCP servers" | -- |
| MCP-02 | Add server | Live | Enter name+command, click Add | PUT; server in list; inputs cleared | `/api/mcp-servers` reflects addition |
| MCP-03 | Remove server | Live | Click remove on server | PUT without server; item removed | `/api/mcp-servers` reflects removal |
| MCP-04 | Empty name/command prevented | Live | Click Add with empty fields | No PUT made | -- |

### 7.26 System Prompts (`system-prompts.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome | Gray-Box |
|----|----------|-------|-------|-------------------|----------|
| PRM-01 | Save global CLAUDE.md | Live | Type content, click Save | PUT to `/api/claude-md/global` | GET returns saved content |
| PRM-02 | Save project template | Live | Type content, click Save | `saveSetting('default_project_claude_md', ...)` | -- |
| PRM-03 | CLAUDE.md loads on settings open | Live | Open settings, Prompts tab | Textarea populated | -- |

### 7.27 Auth Flow (`auth.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| AUTH-01 | Auth URL detection from terminal | Mock | Inject ANSI OAuth URL into `ptyOutputBuffer` | Clean URL extracted starting with `https://claude.com/cai/oauth/authorize?` |
| AUTH-02 | Auth modal appears with URL | Mock | Trigger detection | `#auth-modal` visible; `#auth-link` href correct |
| AUTH-03 | Auth modal close (button, backdrop, Escape) | Live | Each close method | `.visible` removed; `authModalVisible` false |
| AUTH-04 | Auth link attributes | Live | Inspect `#auth-link` | `target="_blank"`, `rel="noopener"` |
| AUTH-05 | Auth code submission | Live | Type code, Submit/Enter | Code + `\r` sent via WS; button "Authenticating..."; modal dismisses after 3s |
| AUTH-06 | Auth banner for invalid credentials | Mock | `/api/auth/status` returns `{valid: false}` | `#auth-banner` with warning and `/login` instruction |
| AUTH-07 | Auth banner hides for valid | Mock | `/api/auth/status` returns `{valid: true}` | `#auth-banner` removed |
| AUTH-08 | ANSI escape stripping | Mock | URL with `\x1b[0m` sequences | Clean URL without escapes |
| AUTH-09 | Auth URL detection across fragmented WS frames | Mock | Inject `chunked-auth-frames.bin` as successive WS message events into `ptyOutputBuffer`, fragmenting the URL across frame boundaries (e.g., split at `https://` or mid-hostname) | Buffer accumulates across frames; full URL extracted after final frame; `#auth-modal` appears with correct `href` |
| AUTH-10 | Auth detection suppressed when modal already visible | Mock | Show auth modal (AUTH-02); then inject a second auth URL into `ptyOutputBuffer` | No duplicate modal; `authModalVisible` guard prevents re-invocation; original modal remains intact with original URL |

### 7.28 Add Project (`add-project.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome | Gray-Box |
|----|----------|-------|-------|-------------------|----------|
| AP-01 | Add project overlay opens | Live | Click "+" in header | Overlay with tree, path, name, Add button | -- |
| AP-02 | Directory tree loads | Live | Overlay opens | jQuery FileTree initializes; directories shown | -- |
| AP-03 | Clicking directory populates fields | Live | Click directory | `#picker-path` and `#picker-name` filled | -- |
| AP-04 | Add button creates project | Live | Select directory, click Add | POST to `/api/projects`; overlay removed; sidebar refreshed | `/api/state` shows new project |
| AP-05 | Root path rejected | Live | Try to add "/" | Alert "Select a directory first" | -- |
| AP-06 | Backdrop click closes | Live | Click outside | Overlay removed | -- |
| AP-07 | Add project via git URL | Live | Type a git repo URL in `#picker-path`, click Add | POST to `/api/projects` with git URL; project appears in sidebar after clone | `/api/state` shows cloned project |
| AP-08 | Duplicate git clone rejected | Live | Add same git URL twice | Alert or error shown; no duplicate project | -- |
| AP-09 | Close button (X) closes overlay | Live | Click X button | Overlay removed, no project added | -- |
| AP-10 | Git clone failure shows error and allows retry | Live | Enter an invalid/unreachable git URL in `#picker-path`, click Add | Error shown (alert or inline); overlay remains open for correction; user can edit URL and retry without reopening the modal | -- |

### 7.29 Status Bar (`status-bar.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| STB-01 | Hidden when no tab active | Live | Page load | `#status-bar` not `.active` |
| STB-02 | Shows model name | Live | Open session | Status shows model name |
| STB-03 | Shows mode | Live | Open session | Mode value displayed |
| STB-04 | Thinking level when not "none" | Live | Set thinking to "high" | Status shows "Thinking: high" |
| STB-05 | Context usage display | Live | Open session with token data | Shows token count, percentage, filled bar |
| STB-06 | Connection status | Live | Open session | Shows "connected" |
| STB-07 | Updates on tab switch | Live | Open 2 sessions with different settings, switch tabs | Status bar model name, context percentage, and connection status each reflect the newly-active tab's values, distinct from the previous tab |
| STB-08 | Token polling degraded state | Mock | Mock `/api/sessions/:id/tokens` to return 500 | Status bar retains last known values or shows degraded indicator; no crash; no unhandled exception. Proves `pollTokenUsage()`'s silent catch is intentional, not a bug. |
| STB-09 | Model name shortening branches | Live | Open sessions with models containing "opus", "sonnet", "haiku", and an unrecognized model name | Status bar shows shortened form for known models (e.g., "Opus", "Sonnet", "Haiku") and a substring fallback for unrecognized model strings |
| STB-10 | Thinking item conditional display | Live | Open session with thinking level "none"; then switch to session with thinking "high" | Thinking status item omitted (not rendered) when "none"; visible with label when non-"none" |

### 7.30 Context Bar Colors (`context-colors.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| CTX-01 | Green below 60% | Mock | 50% usage | `.context-fill-green` |
| CTX-02 | Amber 60-84% | Mock | 70% usage | `.context-fill-amber` |
| CTX-03 | Red 85%+ | Mock | 90% usage | `.context-fill-red` |
| CTX-04 | Bar width matches percentage | Mock | 50% usage | `.fill` width: 50% |

### 7.31 Drag and Drop (`drag-drop.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| DND-01 | Drag-over adds indicator | Live | Drag over terminal area | `.drag-over` class added |
| DND-02 | Drag-leave removes indicator | Live | Drag out | `.drag-over` removed |
| DND-03 | Drop sends path to terminal | Live | Drop with text/plain data | Path sent via WS; terminal focused |
| DND-04 | File browser links draggable | Live | Hover file link | `draggable="true"` attribute set |

### 7.32 WebSocket and Reconnection (`reconnect.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| RCN-01 | Disconnect changes status | Live | Close WS | Tab status "disconnected"; heartbeat cleared |
| RCN-02 | Auto-reconnect with backoff | Live | Disconnect, wait | Reconnect attempted; delay doubles; caps at 30000ms |
| RCN-03 | Successful reconnect resets delay | Live | Reconnect succeeds | Delay reset to 1000; status "connected" |
| RCN-04 | "No tmux session" stops reconnect | Live | WS error with "No tmux session" | `noReconnect` true; no further attempts |
| RCN-05 | Heartbeat every 30s | Live | Open session, wait 31s | WS sends `{type: "ping"}` |
| RCN-06 | Token update via WS | Mock | WS receives `{type: "token_update"}` | `_statusData` updated; status bar refreshes |
| RCN-07 | Server restart recovery | Live | Open session, restart container | Tab reconnects after container returns |
| RCN-08 | Close tab cancels pending reconnect | Live | Disconnect, then close tab before reconnect fires | No reconnect attempt after tab closed; no console errors |
| RCN-09 | `settings_update` WS message updates status bar | Mock | Inject `{type: "settings_update", model: "opus-4", effortLevel: "high"}` via `page.evaluate` into active tab's WS `onmessage` handler | Status bar model name updates immediately to "opus-4" without page reload; `tab._settingsData` populated correctly. Distinct from HR-01 polling path -- this tests the file-watcher-triggered WS push. |
| RCN-10 | WS `type: 'error'` message handled gracefully | Mock | Inject `{type: "error", message: "test error"}` via `page.evaluate` into active tab's WS `onmessage` handler | No crash, no unhandled exception; UI remains interactive; console error captured if logged |

### 7.33 Auto-Refresh and Timers (`auto-refresh.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| REF-01 | loadState polls every 30s | Live | Verify REFRESH_MS and setInterval | Periodic `/api/state` fetch |
| REF-02 | checkAuth polls every 60s | Live | Verify setInterval(checkAuth, 60000) | Periodic `/api/auth/status` fetch |
| REF-03 | loadAppearanceSettings on init | Live | Page load | `/api/settings` fetched; theme/font applied |
| REF-04 | Auto-refresh while modal open | Live | Open settings modal; wait for `loadState` poll to fire (>30s or trigger manually) | Settings modal remains open and functional; no DOM corruption; sidebar updates behind the modal without dismissing it |

### 7.34 Keyboard Shortcuts (`keyboard.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| KEY-01 | Escape closes settings | Live | Open settings, Escape | Modal dismissed |
| KEY-02 | Escape closes auth modal | Live | Show auth, Escape | Modal dismissed |
| KEY-03 | Ctrl+Enter submits session | Live | Modal open, type, Ctrl+Enter | Session created |
| KEY-04 | Enter submits auth code | Live | Type code, Enter | `submitAuthCode()` called |
| KEY-05 | Enter adds task | Live | Type in task input, Enter | Task added |

### 7.35 Input Validation (`validation.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| VAL-01 | Long session name handling | Live | Paste 300-char name in config | UI truncates or handles gracefully |
| VAL-02 | Empty task no-op | Live | Press Enter with empty task input | No API call, list unchanged |
| VAL-03 | Invalid path in Add Project | Live | Type `/nonexistent`, click Add | Alert/error shown |
| VAL-04 | Invalid JSON in quorum additional juniors | Live | Enter `[not valid json]` in `#setting-quorum-additional`, trigger save (tab change or blur) | No silent acceptance; UI shows error feedback or server rejects with surfaced error; `quorum_additional_juniors` setting not corrupted; no crash |
| VAL-05 | MCP server duplicate name | Live | Add MCP server "test-server"; attempt to add another with same name "test-server" | Duplicate rejected with error feedback or second entry prevented; existing server not corrupted |
| VAL-06 | Font size extreme values | Live | Set font size to 0, then -1, then 999 via `#setting-font-size` | UI clamps, rejects, or ignores invalid values; terminal remains usable; no crash; no unreadable text |

### 7.36 Temp Session ID Resolution (`temp-id.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome | Gray-Box |
|----|----------|-------|-------|-------------------|----------|
| RACE-01 | Temp ID resolves to real session | Live | Create session; wait for `loadState` poll | Tab ID migrates from `new_*` to real UUID; pane and active state transfer cleanly | `/api/state` shows session with UUID |
| RACE-02 | Active tab preserved during migration | Live | Create session (becomes temp active tab); wait for resolution | `window.activeTabId` updates to real ID; terminal remains connected and interactive | -- |
| RACE-03 | Close temp tab before resolution | Live | Create session, immediately close tab | Tab removed cleanly; no orphan when real session appears in next `loadState` | No console errors |

### 7.37 Modal Overlap and Reentrancy (`modal-overlap.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| MOD-01 | Auth modal appears while settings open | Mock | Open settings; inject auth URL trigger | Both modals visible or auth modal stacks on top; closing auth leaves settings intact; no DOM corruption |
| MOD-02 | Escape closes topmost overlay only | Live | Open settings, trigger new-session overlay via page.evaluate | Escape removes topmost overlay; underlying modal remains |
| MOD-03 | Repeated open/close leaves no orphan DOM | Live | Open and close new-session overlay 5 times rapidly | Zero `[id^="new-session-overlay-"]` elements remain; no duplicate DOM nodes |
| MOD-04 | Dynamic overlay cleanup on navigation | Live | Open config overlay, then click different session | Config overlay removed before new session opens |

### 7.38 Safe HTML Rendering (`xss-safety.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| ESC-01 | Session name with HTML chars | Live | Create session with name `<img src=x onerror=alert(1)>` via API; reload | Sidebar shows literal text, no script execution; `escHtml()` sanitized |
| ESC-02 | Task text with HTML chars | Live | Add task with text `<script>alert(1)</script>` | Task list shows literal text, no script execution |
| ESC-03 | Search snippet with HTML chars | Live | Seed data containing HTML; search for it | Search results show literal text, no injection |
| ESC-04 | File name with HTML chars | Live | Create file with HTML in name; open file browser | File name rendered as text, not HTML |

### 7.39 Button State Recovery on Error (`error-recovery.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| UI-ERR-01 | "Creating..." recovers on session create failure | Mock | Mock POST `/api/sessions` to return 500; submit new session | Button text reverts from "Creating..." to "Start Session"; button re-enabled; modal stays open for retry |
| UI-ERR-02 | Summary spinner clears on error | Mock | Mock POST `/api/sessions/:id/summary` to return 500 | Spinner replaced with error message in `#summary-content`; overlay remains dismissible |

### 7.40 Session Lifecycle (`session-lifecycle.spec.js`)

| ID | Scenario | Layer | Input | Expected Outcome |
|----|----------|-------|-------|------------------|
| LIFE-01 | Tmux session killed externally while tab open | Live | Open session, `docker exec` kill the tmux session | Tab status changes to "disconnected"; reconnect attempts; eventually `noReconnect` triggers ("No tmux session"); tab remains closable; no console errors |

### 7.41 Recent UI Regressions (mcp-rework + issue fixes)

Coverage for UI-visible fixes shipped in the canonical branch on or after the MCP rework. Cross-referenced from runbook **Phase 15**.

| ID | Scenario | Layer | Issue | Expected Outcome |
|----|----------|-------|-------|------------------|
| UI-REG-220 | Auto-respawn keeps the same session_id; status bar tracks the live JSONL after kill+reattach | Live | #220 | Token count and message count update on the original session row, never silently re-key to a new UUID |
| UI-REG-223 | Primary action buttons readable in dark theme (Start Session / Add Project / Authenticate) | Visual | #223 | Background is `var(--btn-primary)` (#1f6feb), legible against `--bg-secondary`. No washed-out near-white blue. |
| UI-REG-224 | Click on folder icon area expands the directory | Live | #224 | `elementFromPoint(li.left + 8, mid)` returns `<a>`. Clicking the icon toggles `expanded` class on the LI. Same for the project picker (`#jqft-tree`). |
| UI-REG-225 | Default-model dropdown uses CLI aliases | Live | #225 | `#setting-model` options are `Opus`/`Sonnet`/`Haiku` only. No version numbers. Legacy DB values (`claude-sonnet-4-6`) display as the matching alias on load. |
| UI-REG-226 | Saved indicator flashes on each successful save | Live | #226 | After any successful `saveSetting()`, `#settings-saved-indicator` appears top-right of modal with `✓ Saved`, fades after ~1.5s. Failure path still surfaces via the error banner (no overlap). |
| UI-REG-227 | Session-name field replaces free-form prompt textarea | Live | #227 | New-session modal has single-line `#new-session-name` (label "Session name", maxlength 60). Submit body uses `name`, not `prompt`. Sidebar shows the typed name verbatim. |
| UI-REG-228-A | File tree does not collapse on tab close | Live | #228 | Open editor → close tab → tree state preserved. Pre-fix expanded directories collapsed every tab switch. |
| UI-REG-228-B | Manual ↻ button preserves expanded state | Live | #228 | Click `#panel-refresh-files`; after rebuild settles (~2s), the same expanded directories are expanded again. |
| UI-REG-MODE-REMOVED | Status bar no longer shows hardcoded "Mode: bypass" | Visual | mcp-rework | Bottom status bar contains only Model, optional Thinking, and Context items. No Mode item. |

### 7.42 MCP Tool Catalogue from the Browser

These are not new UI surfaces but are sanity checks that the front-end (and any future tool-list panel) reflects the new flat-tool world.

| ID | Scenario | Layer | Expected Outcome |
|----|----------|-------|------------------|
| UI-MCP-CAT-01 | `fetch('/api/mcp/tools')` from the page returns 45 names | Live | `tools.length === 45`; all flat-named (`file_*` / `session_*` / `project_*` / `task_*`); no double-prefix |
| UI-MCP-CAT-02 | Old action-router shape rejected | Live | `POST /api/mcp/call {tool:"workbench_files", args:{action:"list"}}` returns HTTP 404 with `Unknown tool: workbench_files` |

---

## 8. End-to-End Workflow Scenarios (`e2e-workflows.spec.js`)

Real user journeys exercising multiple components in sequence. Each maps to multiple UI elements and JS functions.

| ID | Workflow | Key Verifications |
|----|----------|-------------------|
| BRW-01 | Page load | Sidebar with projects; no errors |
| BRW-02 | Create session E2E | "+", prompt, Ctrl+Enter -> tab + terminal + sidebar |
| BRW-03 | Terminal I/O round-trip | Input sent, output received |
| BRW-04 | Multi-tab management | Correct pane per tab |
| BRW-05 | Close last tab | Empty state returns |
| BRW-06 | Session filtering | Counts change correctly per filter |
| BRW-07 | Session sorting | Order changes per sort criterion |
| BRW-08 | Session search | Search + click result opens session |
| BRW-09 | File browser | Expand tree, click file, content shown |
| BRW-10 | ~~Notes autosave~~ REMOVED | — |
| BRW-11 | Task CRUD | Add/complete/reopen/delete in sync |
| BRW-12 | ~~Messages display~~ REMOVED | — |
| BRW-13 | Theme change | CSS vars + terminal updated |
| BRW-14 | Font change | Terminal updated |
| BRW-15 | Settings persist | Change, reload -> persisted |
| BRW-16 | Session config | Rename, save -> sidebar + tab updated |
| BRW-17 | Session summary | Summary text shown in overlay |
| BRW-18 | Add project | Browse, select, add -> sidebar updated |
| BRW-19 | Status bar | All fields present with open session |
| BRW-20 | Context thresholds | Green/amber/red at correct percentages |
| BRW-21 | WS reconnection | Disconnect -> reconnects |
| BRW-22 | Server restart recovery | Tab reconnects after restart |
| BRW-23 | Rapid tab switching | 10x in 2s -> no crash |
| BRW-24 | Panel resize | Open/close panel -> terminal refits |
| BRW-25 | Empty state | Load with no sessions -> hint shown |
| BRW-26 | Long session name | 100-char name -> truncated with ellipsis |
| BRW-27 | Auth failure banner | Invalid auth -> banner with warning |
| BRW-28 | Auth modal + code | Inject OAuth URL -> modal + submission |
| BRW-29 | Drag-and-drop | Drag file to terminal -> path typed |
| BRW-30 | Double-click prevention | Rapid "+" clicks -> at most one modal |
| BRW-31 | ~~Compaction workflow~~ REMOVED | — |
| BRW-32 | Temp session lifecycle | Create -> temp tab -> poll -> UUID migration -> terminal interactive |
| BRW-33 | Auth recovery lifecycle | Banner shown -> OAuth URL detected -> modal -> code submitted -> banner clears on next poll |
| BRW-34 | Panel project switch | Open panel on project A -> switch to project B tab -> panel reloads with B data, no stale A content |
| BRW-35 | Modal overlap recovery | Open settings -> trigger auth modal -> close auth -> settings still functional -> close settings cleanly |
| BRW-36 | Tmux death recovery | Open session -> kill tmux externally -> UI shows disconnected -> no reconnect -> close tab -> no orphan state |
| BRW-37 | Multi-project terminal isolation | Open terminal on project A -> open terminal on project B -> verify each tab targets correct project -> close project A terminal -> project B terminal unaffected |
| BRW-38 | ~~Session notes vs project notes scope~~ REMOVED — notes panel deleted | — |
| BRW-39 | Hidden session full lifecycle | Active session -> set hidden via config -> disappears from active filter -> find under Hidden filter -> open hidden session (tab opens) -> unhide via config -> session returns to active filter -> tab coherence preserved |
| BRW-40 | Settings propagation to new session | Change default model and thinking level in settings -> create new session -> verify status bar shows the configured model and thinking level for the new session |

### 8.1 Usability Tests (`usability.spec.js`)

Natural workflow testing -- real tasks through the UI as a user would. Per WPR-103 §12.3, these prove the system works for its intended use case.

| ID | Task | Success Criteria |
|----|------|-----------------|
| USR-01 | Start a coding task | Session created, terminal active, sidebar updated |
| USR-02 | Organize sessions | Rename, archive, filter all work |
| USR-03 | Task management | Add/complete/delete tasks E2E |
| USR-04 | Customize appearance | Theme, font size, font family all change visibly |
| USR-05 | Browse files | Navigate tree, view file, close viewer |
| USR-06 | Review session summary | Summary shows meaningful content |
| USR-07 | Hide and recover session | Set session hidden via config, find it via Hidden filter, restore to active |

### 8.2 The Daily Developer Loop (`e2e-daily.spec.js`)

| ID | Steps | Verifications |
|----|-------|---------------|
| E2E-01 | Page loads -> "+" on project -> type prompt -> Ctrl+Enter -> wait for terminal -> type `ls -la` -> verify output -> open panel -> add note -> change font size -> disconnect network -> verify reconnecting UI -> reconnect -> verify recovery -> close tab | Full lifecycle: creation, interaction, settings, resilience, cleanup |

---

## 9. Claude Code CLI Function Testing (Terminal-Mediated)

Workbench wraps Claude Code sessions in tmux. Users interact with Claude through the terminal. This suite tests representative CLI functions from each category through the UI.

**Gate classification:** Non-Deterministic Quality suite (requires real API key, excluded from standard gate). Standard gate uses stub CLI for deterministic terminal I/O tests (TIO-01..05, TRM-01..02).

### 9.1 Slash Commands

| ID | Command | Verification |
|----|---------|-------------|
| CLI-01 | `/help` | Output contains command list |
| CLI-02 | `/status` | Output contains model name |
| CLI-03 | `/clear` | Conversation cleared |
| CLI-04 | `/compact` | Token usage decreases (before/after via API) |
| CLI-05 | `/model` | Model information displayed |
| CLI-06 | `/plan` | Plan mode entered, output visible |

### 9.2 File Operations via Claude

| ID | Prompt | Verification | Gray-Box |
|----|--------|-------------|----------|
| CLI-07 | "Read README.md" | Output contains file contents | -- |
| CLI-08 | "Create test-output.txt with 'hello'" | File creation acknowledged | `/api/file` or file browser confirms |
| CLI-09 | "Search for 'hello' in the project" | Matching files mentioned | -- |

### 9.3 MCP Tool Invocation

| ID | Tool | Verification | Gray-Box |
|----|------|-------------|----------|
| CLI-10 | `task_find` | Task list shown in terminal | -- |
| CLI-11 | `task_add` | Task added | Tasks API shows new task |
| CLI-12 | `session_find` | Search results shown | -- |
| CLI-13 | ~~`workbench_get_project_notes`~~ REMOVED | — | Notes endpoint deleted |
| CLI-14 | ~~`workbench_smart_compaction`~~ REMOVED | — | Feature deleted |

### 9.4 Session/Planning Behavior

| ID | Action | Verification |
|----|--------|-------------|
| CLI-15 | Enter plan mode from terminal | Plan mode output visible |
| CLI-16 | Update plan | Plan content updated |
| CLI-17 | Exit plan mode | Normal mode restored |

### 9.5 Terminal Input Handling

| ID | Action | Verification |
|----|--------|-------------|
| CLI-18 | Simple prompt text | Text sent through xterm |
| CLI-19 | Enter key submission | Command executed |
| CLI-20 | Drag-drop path then continue typing | Path inserted, further input accepted |

### 9.6 Workbench JSON Protocol

| ID | Action | Verification |
|----|--------|-------------|
| CLI-21 | Compaction checker JSON parsing | Inject synthetic checker output (e.g., `{"workbench": "ready_to_compact"}`) interleaved with normal text and ANSI codes into terminal | Parser extracts command correctly; no side effects on visible terminal output |

---

## 10. Context Stress Testing — REMOVED

Smart compaction feature removed from codebase (#32). All CST tests permanently removed. Context bar color tests (CTX-01..04) remain valid as they test UI rendering, not compaction.

### 10.1 Progressive Fill

| ID | Threshold | Target Tokens | Verification |
|----|-----------|---------------|-------------|
| CST-01 | 65% advisory | 130,000 | Context bar amber; status shows ~65% |
| CST-02 | 75% warning | 150,000 | Warning-level nudge in container logs |
| CST-03 | 85% urgent | 170,000 | Context bar red; urgent nudge |
| CST-04 | 90% auto-compact | 180,000 | Auto-compaction triggers; token count decreases |

### 10.2 Pipeline Stage Verification

| ID | Stage | Verification |
|----|-------|-------------|
| CST-05 | Monitoring detects threshold | Container log shows detection |
| CST-06 | Nudge file created | File exists in container |
| CST-07 | Nudge injected into session | JSONL contains nudge entry |
| CST-08 | CLI receives nudge | Terminal behavior changes |

### 10.3 Real Auto-Compaction Acceptance (CST-04 Detail)

When auto-compaction triggers at 90%:
1. Session is open in browser tab
2. Status bar reaches high usage (red)
3. Auto-compaction triggers without manual click
4. Terminal remains attached or recovers coherently
5. Session/tab identity in UI stays coherent
6. Post-compaction terminal still accepts input
7. Status/token state reflects post-compaction condition (drops significantly)
8. No browser-side crash, broken panel, or stuck reconnect loop

### 10.4 Multiple Cycles (WPR-103 §12a.3)

| ID | Test | Verification |
|----|------|-------------|
| CST-09 | Three fill-compact cycles | Each cycle: tokens drop; no state leaks |
| CST-10 | Lock released between cycles | Lock file not persisted |
| CST-11 | Nudge flags cleared | Re-triggerable on next fill |

### 10.5 Cold Recall (WPR-103 §12a.4)

| ID | Test | Verification |
|----|------|-------------|
| CST-12 | Post-compaction recall | Resume prompt references pre-compaction topic |

### 10.6 Per-Phase Gray-Box Verification

| ID | Phase | Verification |
|----|-------|-------------|
| CST-13 | Prep phase | Plan file updated with expected elements; prep prompt injected into session |
| CST-14 | Compact phase | `compact_boundary` marker appears in session JSONL; token count drops |
| CST-15 | Recovery phase | `recent_turns_*.md` file created; resume instructions followed; terminal interactive post-recovery |

### 10.7 Failure Paths

| ID | Test | Verification |
|----|------|-------------|
| CST-16 | Checker returns malformed JSON | Compaction degrades gracefully; terminal remains interactive; error logged |
| CST-17 | Checker returns error status | Compaction aborted cleanly; session remains usable |
| CST-18 | Max prep turns exceeded | Compaction times out; session remains interactive |

### 10.8 Compaction Protocol and Lock Behavior

| ID | Test | Verification |
|----|------|-------------|
| CST-19 | Checker protocol command variants | Inject checker output containing `read_plan_file` and `exit_plan_mode` commands (in addition to `ready_to_compact` tested in CST-04) | Each command triggers the expected pipeline behavior; plan file read when requested; plan mode exited when instructed; terminal remains coherent throughout |
| CST-20 | Double compaction trigger with lock contention | Trigger compaction at 90%; while compaction is in progress, trigger a second compaction request | Lock file prevents concurrent execution; second request is rejected or queued; first compaction completes normally; no data corruption or stuck state |

---

## 11. Hot-Reload Testing

| ID | Test | Verification |
|----|------|-------------|
| HR-01 | External settings change via DB (poll path) | Update setting in DB; wait for `loadState` poll interval (>30s) | UI reflects change without page refresh. Note: this tests the 30-second polling path specifically. The WS push path for settings changes is covered by RCN-09. |
| HR-02 | External session rename via DB | Update session name in DB; wait for loadState interval | Sidebar name updates |
| HR-03 | Config file hot-reload | Modify config in container | Next operation uses new values |
| HR-04 | Prompt file hot-reload | Modify prompt file in container | Next compaction uses updated text |

---

## 12. Gray-Box Verification Strategy

Browser assertions alone are insufficient for stateful mutations. For every UI state mutation, gray-box verification confirms the backend state matches.

| UI Action | DOM Assertion | Gray-Box Verification |
|-----------|---------------|-----------------------|
| Add task | Row in `#task-list` | `SELECT text FROM tasks` or GET `/api/projects/:name/tasks` |
| Archive session | `.archived` class | GET `/api/sessions/:id/config` state = archived |
| Hide session | Disappears from active filter | GET `/api/sessions/:id/config` state = hidden |
| Save notes | Textarea content | GET `/api/projects/:name/notes` returns content |
| Settings: font | Terminal applies font | GET `/api/settings` returns font_family |
| New terminal | Tab opens | `docker exec tmux ls` shows session |
| Create project | Project in sidebar | GET `/api/state` shows project |
| Create project (git) | Project in sidebar | GET `/api/state` shows project; cloned directory exists |
| Create session | Tab + terminal | GET `/api/state` shows session + tmux session exists |
| Temp ID resolution | Tab ID changes | GET `/api/state` shows real UUID matching tab |
| MCP add/remove | List updates | GET `/api/mcp-servers` reflects change |
| Global CLAUDE.md | Save confirmed | GET `/api/claude-md/global` returns content |
| File op from Claude | File browser shows file | GET `/api/file` confirms |
| Auto-compaction | Token bar drops | Token API shows reduced usage; terminal interactive |
| Compaction prep | Plan file exists | File check inside container |
| Compaction compact | Boundary in JSONL | JSONL contains `compact_boundary` marker |
| Compaction recovery | Recent turns file exists | File check inside container; file cleaned up after |
| Compaction lock | Lock file present during active compaction | File check; lock released after completion |

---

## 13. Runtime Issue Logging (WPR-103 §10)

| Severity | Criteria | Action |
|----------|----------|--------|
| Bug | Assertion fails; console.error caught | GitHub Issue with `bug` label; test fails |
| Warning | Unexpected non-breaking behavior; degraded quality | GitHub Issue with `warning` label; test passes |
| Performance | Page load > 5s, WS connect > 3s, poll response > 2s | GitHub Issue with `performance` label |

Playwright tests use a custom reporter. On failure: capture screenshot, DOM snapshot, network HAR, console output, and (if terminal involved) terminal text buffer. Issues filed via `gh` CLI with deduplication check (`gh issue list --label`).

---

## 14. Failure Investigation Strategy (WPR-103 §13)

1. **Capture evidence** -- Screenshot, console output, network/API responses, terminal buffer (if applicable), token usage before/after (if compaction involved)
2. **Root cause before fix** -- Trace the failure to its exact code path with evidence. Do not guess.
3. **Never weaken tests** -- The fix goes in the application code. No skips, no broadened assertions, no lowered thresholds.
4. **Fixes must be precise** -- Address root cause without side effects.
5. **Verify every fix** -- Deploy fix, run failing test, then run full suite.
6. **Flaky = bug** -- If xterm rendering latency causes intermittent failure, use `page.waitForFunction` to poll buffer state, not `page.waitForTimeout`.
7. **Second opinion on non-trivial bugs** -- Before committing to a root cause diagnosis for non-trivial bugs -- especially in xterm rendering, WebSocket lifecycle, temp ID resolution, and context management pipeline -- consult a second LLM with the evidence gathered. Present the failing test, the error output, the relevant code, and the proposed root cause. The second model may spot alternative explanations, challenge assumptions, or identify a deeper issue. (WPR-103 §13.3)

---

## 15. What Is Not Tested

### 15.1 Exclusions

| Area | Justification |
|------|---------------|
| OAuth redirect flow | Requires real navigation to claude.com; auth modal code extraction IS tested |
| Cross-browser compatibility | Developer tool; Chromium via Playwright is the acceptance target |
| xterm.js canvas internals | Tested via `term.buffer.active` text extraction, not canvas pixels |
| jQuery FileTree DOM internals | Click outcomes and API responses tested, not library internals. Generated file/directory row elements are tested through the behaviors they enable (FIL-01..10, AP-02..03, DND-04). Multi-depth expansion explicitly tested (FIL-08). |
| WebLinksAddon hyperlink behavior | Third-party xterm.js addon; click-through to external URLs not tested. Terminal text rendering IS tested via buffer API. |
| Mobile viewport | Desktop IDE workbench; mobile not targeted |
| Accessibility (WCAG) | Not in current requirements |
| Real multi-model quorum execution | Requires multiple API keys; settings persistence is tested |
| `expandedProjects` state persistence | In-memory `Set` that does not persist across reload. New projects start collapsed. This is current behavior, not a bug. If persistence is later required, it becomes a new feature with its own test. |
| Backend-only capabilities | Project removal API, webhooks settings, OpenAI-compat endpoints, external MCP routes, quorum execution, keepalive status endpoint -- these have no UI controls and are covered by Gate B (backend integration tests) |
| CSI mouse-tracking handler internals | Custom handlers block xterm.js mouse tracking sequences. These are defensive measures against Claude Code escape sequences. If malfunction occurs, it would manifest as broken text selection, which the visual review protocol catches. |
| `deleteSession()` (disabled) | Commented out per GitHub Issue #457. Hard deletion causes zombie sessions because `/api/state` re-syncs JSONL files on every call. Use archive/hidden state instead. No test coverage needed until re-enabled. |
| `/api/projects/:name/claude-md` (GET/PUT) | No UI control. Accessed via MCP tools only (`workbench_get_project_claude_md`, `workbench_set_project_claude_md`). Covered by Gate B (backend integration tests). |
| `/api/keepalive/status` | No UI control. Returns keepalive state for external monitoring. Covered by Gate B. |
| MCP tools not in CLI matrix | `workbench_set_project_notes`, `workbench_set_session_state`, `workbench_get_token_usage`, `workbench_update_settings`, `workbench_set_project_claude_md`, `workbench_get_project_claude_md`, `workbench_list_projects`, `workbench_list_sessions`, `workbench_summarize_session`, `workbench_read_plan`, `workbench_update_plan`, `workbench_send_message`, `workbench_complete_task` -- effects of these tools are testable through the UI (state changes visible in sidebar, plan files visible in file browser, tasks visible in panel) and they are fully covered by MCP integration tests in Gate B. The CLI matrix (§9) covers representative samples from each distinct tool category (read, write, search, compaction). |
| CSS hover states without behavioral change | `.session-item:hover` background, `.tab:hover` visual distinction, `.project-header:hover` -- these are visual-only states without functional behavior. The visual review protocol (§3.6) catches rendering issues. Hover states WITH behavior (SES-02: session actions appear on hover) are covered. |
| Exhaustive overlay combination testing | All 2-overlay combinations (auth×settings, auth×config, auth×summary, auth×new-session, auth×add-project) are not individually tested. MOD-01 tests the highest-risk case (auth during settings). The auth modal uses a separate DOM mechanism (static `#auth-modal`) from dynamic overlays (body-appended), making overlap behavior consistent across all combinations. |
| Exhaustive `connectTab()` WS message branches | JSON parse failure for non-JSON strings, binary payload after reconnect, `ws.onerror` vs `ws.onclose` distinction, resize when dimensions unavailable -- these are implementation-level branches tested indirectly through RCN-01..10 and TIO-01..05. Observable behaviors (reconnection, error handling, terminal I/O) are covered. |
| Pipeline performance measurement (WPR-103 §7.3) | Pipeline timing thresholds and performance metrics for the compaction pipeline are delegated to Phase 0f (Gate B, backend tests). This plan verifies pipeline correctness and stage completion, not performance benchmarks. |

### 15.2 Blockers

| Area | Blocker | Resolution |
|------|---------|------------|
| CLI-01..21 | Requires real API key | Non-Deterministic Quality suite (nightly/on-demand) |
| CST-09..20 multi-cycle, protocol, and failure | ~15 min runtime | Separate long-duration job |
| RCN-07 server restart | Requires Docker API access | Use `docker restart` via helper |
| AP-07 git clone | Requires accessible git repo from container | Use local bare repo fixture or mock git server |

---

## 16. Traceability Matrix

| Scenario | Test File | Layer | Status | Result | Last Run Date | Notes |
|----------|-----------|-------|--------|--------|---------------|-------|
| LAY-01..05 | `layout.spec.js` | Live | Not started | Not run | -- | -- |
| INIT-01 | `init.spec.js` | Live | Not started | Not run | -- | -- |
| FAIL-01..02 | `fetch-errors.spec.js` | Mock | Not started | Not run | -- | Route-intercepted |
| SB-01..13 | `sidebar.spec.js` | Live | Not started | Not run | -- | -- |
| FLT-01..04, SRT-01..03 | `filter-sort.spec.js` | Live | Not started | Not run | -- | -- |
| SCH-01..04 | `search.spec.js` | Live | Not started | Not run | -- | -- |
| SCH-05 | `search.spec.js` | Mock | Not started | Not run | -- | Error path |
| EMP-01..02 | `empty-state.spec.js` | Live | Not started | Not run | -- | -- |
| SES-01..03 | `session-open.spec.js` | Live | Not started | Not run | -- | -- |
| SES-04 | `session-open.spec.js` | Mock | Not started | Not run | -- | Error path |
| NS-01..09 | `new-session.spec.js` | Live | Not started | Not run | -- | -- |
| TAB-01..07 | `tabs.spec.js` | Live | Not started | Not run | -- | -- |
| TIO-01..05 | `terminal-io.spec.js` | Live | Not started | Not run | -- | -- |
| TRM-01..02 | `open-terminal.spec.js` | Live | Not started | Not run | -- | -- |
| CFG-01..07 | `session-config.spec.js` | Live | Not started | Not run | -- | -- |
| ARC-01..04 | `archive.spec.js` | Live | Not started | Not run | -- | -- |
| SUM-01..03, SUM-05 | `summary.spec.js` | Live | Not started | Not run | -- | -- |
| SUM-04 | `summary.spec.js` | Mock | Not started | Not run | -- | Error path |
| PNL-00..05 | `right-panel.spec.js` | Live | Not started | Not run | -- | -- |
| FIL-01..04, FIL-07..10 | `files-panel.spec.js` | Live | Not started | Not run | -- | -- |
| FIL-05..06 | `files-panel.spec.js` | Mock | Not started | Not run | -- | Fallback/error paths |
| NTS-01..04 | `notes-panel.spec.js` | Live | Not started | Not run | -- | -- |
| TSK-01..06 | `tasks-panel.spec.js` | Live | Not started | Not run | -- | -- |
| MSG-01..02 | `messages-panel.spec.js` | Live | Not started | Not run | -- | -- |
| SET-01..07 | `settings.spec.js` | Live | Not started | Not run | -- | -- |
| THM-01..04 | `theme.spec.js` | Live | Not started | Not run | -- | -- |
| FNT-01..04 | `font.spec.js` | Live | Not started | Not run | -- | -- |
| MDL-01..02, KAL-01..02, QRM-01..03, FTR-01 | `model-settings.spec.js` | Live | Not started | Not run | -- | -- |
| MCP-01..04 | `mcp-servers.spec.js` | Live | Not started | Not run | -- | -- |
| PRM-01..03 | `system-prompts.spec.js` | Live | Not started | Not run | -- | -- |
| AUTH-01..02, AUTH-06..10 | `auth.spec.js` | Mock | Not started | Not run | -- | Fixture/route-intercepted |
| AUTH-03..05 | `auth.spec.js` | Live | Not started | Not run | -- | -- |
| AP-01..10 | `add-project.spec.js` | Live | Not started | Not run | -- | -- |
| STB-01..10 | `status-bar.spec.js` | Live | Not started | Not run | -- | -- |
| STB-08 | `status-bar.spec.js` | Mock | Not started | Not run | -- | Degraded state |
| CTX-01..04 | `context-colors.spec.js` | Mock | Not started | Not run | -- | Injected token data |
| DND-01..04 | `drag-drop.spec.js` | Live | Not started | Not run | -- | -- |
| RCN-01..05, RCN-07..08 | `reconnect.spec.js` | Live | Not started | Not run | -- | -- |
| RCN-06, RCN-09..10 | `reconnect.spec.js` | Mock | Not started | Not run | -- | WS message injection |
| REF-01..04 | `auto-refresh.spec.js` | Live | Not started | Not run | -- | -- |
| KEY-01..05 | `keyboard.spec.js` | Live | Not started | Not run | -- | -- |
| VAL-01..06 | `validation.spec.js` | Live | Not started | Not run | -- | -- |
| RACE-01..03 | `temp-id.spec.js` | Live | Not started | Not run | -- | -- |
| MOD-01..04 | `modal-overlap.spec.js` | Live/Mock | Not started | Not run | -- | -- |
| ESC-01..04 | `xss-safety.spec.js` | Live | Not started | Not run | -- | -- |
| UI-ERR-01..02 | `error-recovery.spec.js` | Mock | Not started | Not run | -- | Route-intercepted |
| LIFE-01 | `session-lifecycle.spec.js` | Live | Not started | Not run | -- | -- |
| BRW-01..40 | `e2e-workflows.spec.js` | Live | Not started | Not run | -- | -- |
| USR-01..07 | `usability.spec.js` | Live | Not started | Not run | -- | -- |
| E2E-01 | `e2e-daily.spec.js` | Live | Not started | Not run | -- | -- |
| CLI-01..21 | `cli-functions.spec.js` | Live/ND | Not started | Not run | -- | Requires API key |
| CST-01..20 | `context-stress.spec.js` | Live/Stress | Not started | Not run | -- | ~15 min runtime |
| HR-01..04 | `hot-reload.spec.js` | Live | Not started | Not run | -- | -- |
| FR-01 | `fresh-boot.spec.js` | Live | Not started | Not run | -- | -- |

---

## 17. Test Suite Structure

```
tests/
  browser/
    playwright.config.js
    screenshots/                    # Auto-captured per test
    helpers/
      reset-state.js               # Baseline reset
      terminal-helpers.js           # xterm buffer reading
      coverage-helpers.js           # JS coverage collection
      wait-helpers.js               # Polling / eventually-consistent waits
      http-client.js               # Authenticated API calls
      sqlite-helper.js             # docker exec sqlite3 for gray-box
      visual-reviewer.js           # Screenshot LLM judge (Haiku)
      visual-review-rubric.md      # Versioned visual review criteria
      llm-judge-rubric.md          # Versioned LLM-as-judge rubric
    fixtures/
      stub-claude.sh               # Deterministic CLI stub
      ansi-auth-url.txt            # ANSI OAuth URL fixture
      chunked-auth-frames.bin      # Fragmented WS frames
      settings.json                # Known settings state
      tasks.json                   # Seed tasks
      messages.json                # Seed messages
    layout.spec.js                 # LAY-01..05
    init.spec.js                   # INIT-01
    fetch-errors.spec.js           # FAIL-01..02
    sidebar.spec.js                # SB-01..13
    filter-sort.spec.js            # FLT-01..04, SRT-01..03
    search.spec.js                 # SCH-01..05
    empty-state.spec.js            # EMP-01..02
    session-open.spec.js           # SES-01..04
    new-session.spec.js            # NS-01..09
    tabs.spec.js                   # TAB-01..07
    terminal-io.spec.js            # TIO-01..05
    open-terminal.spec.js          # TRM-01..02
    session-config.spec.js         # CFG-01..07
    archive.spec.js                # ARC-01..04
    summary.spec.js                # SUM-01..05
    right-panel.spec.js            # PNL-00..05
    files-panel.spec.js            # FIL-01..10
    notes-panel.spec.js            # NTS-01..04
    tasks-panel.spec.js            # TSK-01..06
    messages-panel.spec.js         # MSG-01..02
    settings.spec.js               # SET-01..07
    theme.spec.js                  # THM-01..04
    font.spec.js                   # FNT-01..04
    model-settings.spec.js         # MDL, KAL, QRM, FTR
    mcp-servers.spec.js            # MCP-01..04
    system-prompts.spec.js         # PRM-01..03
    auth.spec.js                   # AUTH-01..10
    add-project.spec.js            # AP-01..10
    status-bar.spec.js             # STB-01..10
    context-colors.spec.js         # CTX-01..04
    drag-drop.spec.js              # DND-01..04
    reconnect.spec.js              # RCN-01..10
    auto-refresh.spec.js           # REF-01..04
    keyboard.spec.js               # KEY-01..05
    validation.spec.js             # VAL-01..06
    temp-id.spec.js                # RACE-01..03
    modal-overlap.spec.js          # MOD-01..04
    xss-safety.spec.js             # ESC-01..04
    error-recovery.spec.js         # UI-ERR-01..02
    session-lifecycle.spec.js      # LIFE-01
    e2e-workflows.spec.js          # BRW-01..40
    e2e-daily.spec.js              # E2E-01
    usability.spec.js              # USR-01..07
    cli-functions.spec.js          # CLI-01..21
    context-stress.spec.js         # CST-01..20
    hot-reload.spec.js             # HR-01..04
    fresh-boot.spec.js             # FR-01
    z-coverage-gate.spec.js        # Coverage aggregation + threshold assertion
```

---

## 18. Implementation Priority

| Priority | Suite(s) | Rationale |
|----------|----------|-----------|
| 1 | Helpers + framework setup | Foundation: reset-state, terminal-helpers, coverage, visual-reviewer, visual-review-rubric, llm-judge-rubric |
| 2 | `layout.spec.js`, `init.spec.js`, `fetch-errors.spec.js` | Foundation: page loads, initialization, error propagation |
| 3 | `sidebar.spec.js`, `filter-sort.spec.js`, `search.spec.js` | Foundation: data from server to UI |
| 4 | `new-session.spec.js`, `session-open.spec.js`, `temp-id.spec.js` | Core: session creation, opening, ID resolution |
| 5 | `tabs.spec.js`, `empty-state.spec.js` | Core: tab management |
| 6 | `terminal-io.spec.js`, `open-terminal.spec.js` | Core: terminal IS the product |
| 7 | Panel suites (`right-panel`, `files-panel`, `notes-panel`, `tasks-panel`, `messages-panel`) | Panel features |
| 8 | Settings suites (`settings`, `theme`, `font`, `model-settings`) | Preferences |
| 9 | `session-config.spec.js`, `archive.spec.js`, `summary.spec.js` | Session management |
| 10 | `auth.spec.js`, `add-project.spec.js` | Auth and projects |
| 11 | `mcp-servers.spec.js`, `system-prompts.spec.js` | Advanced configuration |
| 12 | `status-bar.spec.js`, `context-colors.spec.js` | Status display |
| 13 | `reconnect.spec.js`, `auto-refresh.spec.js`, `drag-drop.spec.js`, `keyboard.spec.js` | Edge cases |
| 14 | `validation.spec.js`, `hot-reload.spec.js`, `modal-overlap.spec.js`, `xss-safety.spec.js`, `error-recovery.spec.js`, `session-lifecycle.spec.js` | Input validation, reactivity, safety, error recovery |
| 15 | `e2e-workflows.spec.js`, `e2e-daily.spec.js`, `usability.spec.js` | Integration workflows |
| 16 | `fresh-boot.spec.js` | Fresh container verification |
| 17 | `context-stress.spec.js` | Stress testing (most complex) |
| 18 | `cli-functions.spec.js` | Non-deterministic (requires API key) |
| 19 | `z-coverage-gate.spec.js` | Coverage aggregation and audit |

---

## 19. Test Execution Gates

### Gate C: Browser Acceptance (Standard)

**Prerequisites:** Gates A and B pass; fresh container deployed
**Runs:** All `tests/browser/*.spec.js` EXCEPT `cli-functions.spec.js` and `context-stress.spec.js`
**Pass criteria:**
- All tests pass (zero failures)
- Zero skipped tests
- Zero console.error across all tests
- Visual review: zero PROBLEM ratings
- Client-side JS coverage >= 90% line / 80% branch
- All 54 registered JS functions exercised
- All 139 UI elements mapped to passing tests
- Regression validation: 5 critical modules intentionally broken -- all corresponding tests must fail

### Non-Deterministic Quality Suite (Nightly/On-Demand)

**Runs:** `cli-functions.spec.js`, `usability.spec.js` (USR-01, USR-06, USR-07 with real Claude)
**Pass criteria:** Behavioral assertions pass; LLM judge ratings >= 3/5

### Context Stress Suite (Weekly/Pre-Release)

**Runs:** `context-stress.spec.js`
**Pass criteria:** All threshold tests pass; 3 compaction cycles complete; no state leaks; post-compaction recall verified; per-phase gray-box checks pass; failure paths degrade gracefully; checker protocol commands handled correctly; double-trigger lock contention resolved cleanly

---

## 20. Risk-Based Focus Areas

| Risk Area | Why High Risk | Test Scenarios | Additional Verification |
|-----------|---------------|----------------|------------------------|
| Session creation and ID resolution | Temp IDs resolve to UUIDs; race conditions with rapid clicks; migration must preserve active tab and terminal connection | NS-01..09, RACE-01..03, BRW-02, BRW-30, BRW-32 | Gray-box DB check; temp-to-UUID mapping verified |
| WebSocket lifecycle | Reconnection backoff, heartbeat, cleanup; rapid switching can leak panes; close-during-reconnect race; `settings_update` and `error` message types | RCN-01..10, TAB-04..07 | Connection state assertions; WS message injection |
| Context management pipeline | Multi-stage with thresholds, locks, nudges; state accumulation bugs; checker JSON parsing; protocol command variants; lock contention | CST-01..20, CTX-01..04, CLI-21 | Container logs, lock files, multiple cycles, per-phase gray-box, protocol command verification |
| Auth flow with ANSI parsing | Escape sequences, fragmented frames, large buffers before URL; duplicate detection suppression | AUTH-01..10 | Fixture-driven with real ANSI sequences; chunked frame fixture |
| State persistence | Settings, notes, tasks must survive reload; notes save must complete before project switch | SET-07, NTS-02, NTS-04, BRW-10, BRW-15 | Gray-box DB verification after reload |
| Autocompaction UI sync | Backend triggers compaction but UI status bar fails to reflect token drop | CST-04, CST-13..15, BRW-31 | Token API before/after, terminal interactivity post-compaction |
| xterm.js rendering fragmentation | Output arrives fragmented across WS frames; assertions fail on partial text | TIO-01..05, CLI-* | Buffer polling instead of immediate assertion |
| Modal overlap and DOM cleanup | Multiple overlay systems (static DOM modals, dynamic `document.body` appended overlays); concurrent modals risk DOM corruption | MOD-01..04, BRW-35 | Zero orphan DOM check after repeated open/close |
| HTML injection via user content | Session names, task text, search snippets rendered via `escHtml`; failure = XSS | ESC-01..04 | Literal text verification, no script execution |
| Panel with no active session | `getCurrentProject()` returns null before any session is opened; panel tabs may crash | PNL-00 | No console.error; graceful empty/placeholder state |
| Input validation edge cases | Invalid JSON in settings, extreme font sizes, duplicate MCP names | VAL-04..06 | No silent corruption; UI provides feedback |

---

## 21. Final Acceptance Criteria

This UI test plan is implemented when ALL of the following are true:

1. All 139 UI elements (§5) map to at least one passing test
2. All 54 JS functions (§6) are behaviorally exercised
3. All 48 workflows (§8) have passing tests
4. All CLI categories (§9) have representative coverage
5. Real autocompaction triggered using `workbench_primer.py` (CST-04)
6. Context threshold progression verified (CST-01..04)
7. At least 3 compaction cycles complete without state leaks (CST-09)
8. Per-phase compaction gray-box checks pass (CST-13..15)
9. Compaction failure paths degrade gracefully (CST-16..18)
10. Compaction checker protocol commands handled (CST-19)
11. Compaction lock contention handled (CST-20)
12. Zero skipped tests in gating suite
13. Zero console.error in any browser test
14. Every test captures a screenshot; visual review passes
15. Client-side JS coverage >= 90% line / 80% branch
16. Gray-box verification for all stateful mutations
17. Regression validation: 5 critical modules intentionally broken, all corresponding tests fail
18. Fresh-container gate passes
19. Post-implementation coverage audit finds zero unmapped UI controls
20. Traceability matrix contains zero blanks in test-mapping columns
21. No open critical issues
22. Capability audit (§5a) has zero NONE entries
23. Independent review of test code completed

---

## 22. Post-Implementation Coverage Audit

After all test code is written, a post-code audit must verify:

- Every clickable control in `public/index.html` is covered
- Every input/select/textarea is covered
- Every modal open/close path is covered (including X buttons, backdrop clicks, and Escape)
- Every tab/panel state transition is covered
- Every keyboard shortcut handled in browser JS is covered
- Every browser-side function with user impact is exercised
- Every terminal-mediated feature exposed to users is exercised from browser
- Every API endpoint reachable from UI has gray-box verification
- Dynamic elements generated by JS (search results, file tree items, mount sections) are covered through the behaviors that create them
- Both `.new-session-btn` and `.project-header .new-btn` entry points to `createSession()` are exercised (if both exist in the HTML)
- File tree multi-depth expansion tested at 3+ levels
- File viewer readonly enforcement verified
- Generated interactive elements (file/directory rows, mount headers) tested through click, expand, and drag behaviors

Any gap found in the post-code audit becomes a new test scenario. The suite is not complete until the audit finds zero gaps.

---

## Appendix A: Reviewer Sign-Off Checklist

Reviewer must explicitly confirm:

- [ ] Every button in `index.html` covered (including overlay X buttons, Cancel buttons, Clear buttons)
- [ ] Every input/select/textarea covered (including cfg-notes, cfg-name)
- [ ] Every modal open/close path covered (button, backdrop, Escape, X)
- [ ] Every right-panel tab covered (including no-session state)
- [ ] Every tab-bar interaction covered
- [ ] Every status-bar state covered (including `settings_update` WS path, model shortening, thinking conditional)
- [ ] Every auth-modal parsing path covered (including chunked frames, already-visible guard)
- [ ] At least one real terminal prompt flow covered
- [ ] Slash command category covered
- [ ] MCP tool category covered
- [ ] File operation category covered
- [ ] Real auto-compaction covered with primer
- [ ] Multi-cycle compaction covered
- [ ] Per-phase compaction gray-box verified
- [ ] Compaction checker protocol commands tested
- [ ] Compaction lock contention tested
- [ ] Zero unmapped inventory rows
- [ ] Gray-box verification for all mutations
- [ ] Fresh-container gate passes
- [ ] Temp session ID resolution covered
- [ ] Hidden session state workflow covered (full lifecycle)
- [ ] Git clone project path covered (including failure recovery)
- [ ] WS message types fully covered (`token_update`, `settings_update`, `error`)
- [ ] Modal overlap and reentrancy tested
- [ ] Safe HTML rendering (`escHtml`) explicitly tested
- [ ] Capability audit has zero NONE entries
- [ ] Panel with no active session tested
- [ ] Input validation edge cases covered (invalid JSON, extreme values, duplicates)
- [ ] Multi-project terminal isolation workflow tested
- [ ] Settings propagation to new session tested
- [ ] File tree multi-depth expansion tested

---

## Appendix B: API Endpoints Exercised Through UI

Every backend API reachable through UI actions. All are verified via gray-box or behavioral assertions.

| Endpoint | UI Trigger | Test Coverage |
|----------|-----------|---------------|
| GET `/api/state` | Page load, refresh, 30s timer | SB-01, SB-03, REF-01, RACE-01, REF-04 |
| POST `/api/projects` | Add project (local dir or git URL) | AP-04, AP-07, AP-10 |
| POST `/api/sessions` | New session modal | NS-03 |
| POST `/api/terminals` | ">_" button | TRM-01 |
| POST `/api/sessions/:id/resume` | Click session | SES-01 |
| GET/PUT `/api/sessions/:id/config` | Config modal | CFG-01..07 |
| PUT `/api/sessions/:id/name` | Rename flow (if used by `renameSession`) | CFG-03 |
| PUT `/api/sessions/:id/archive` | Archive button | ARC-01..02 |
| ~~GET/PUT `/api/projects/:name/notes`~~ REMOVED | — | — |
| GET/POST `/api/projects/:name/tasks` | Tasks panel | TSK-01..02 |
| PUT `/api/tasks/:id/complete` | Task checkbox | TSK-03 |
| PUT `/api/tasks/:id/reopen` | Task checkbox | TSK-04 |
| DELETE `/api/tasks/:id` | Task delete | TSK-05 |
| ~~GET `/api/projects/:name/messages`~~ REMOVED | — | — |
| GET/PUT `/api/settings` | Settings modal | SET-05..06, VAL-04, VAL-06 |
| GET/PUT `/api/claude-md/global` | System prompts | PRM-01 |
| GET/PUT `/api/mcp-servers` | MCP management | MCP-01..03, VAL-05 |
| GET `/api/search` | Search input | SCH-02..05 |
| POST `/api/sessions/:id/summary` | Summary button | SUM-01..02 |
| GET `/api/sessions/:id/tokens` | Status polling | STB-05, STB-08, CTX-01 |
| GET `/api/auth/status` | Auth polling | AUTH-06..07, REF-02 |
| GET `/api/file` | File viewer | FIL-02, FIL-06, FIL-08 |
| POST `/api/jqueryfiletree` | File tree (jQuery FileTree POST) | FIL-01, AP-02 |
| GET `/api/browse` | Directory browsing (if used by addProject) | AP-02 |
| GET `/api/mounts` | File browser root | FIL-01, FIL-05, FIL-10 |
| WS `/ws/:tmuxSession` | Terminal tabs | TIO-01..05, RCN-01..10 |

**Footnotes:**
- `/api/projects/:name/claude-md` (GET/PUT) -- No UI control. Accessed via MCP tools only. Covered by Gate B (backend integration tests).
- `/api/keepalive/status` -- No UI control. Returns keepalive state for external monitoring. Covered by Gate B.

---

## Appendix C: Reviewer Feedback Disposition

This appendix documents how each reviewer finding was dispositioned during revision.

### Phase 6a: Claude (Sonnet) Review -- Findings Accepted

| ID | Finding | Action Taken |
|----|---------|-------------|
| R-01 | `fetchJSON` and `main` not in FN inventory | **Reversed in Phase 6b.** Gemini review proved these are server-side functions (`mcp-server.js` and `scripts/prime-test-session.js`), not browser code. FN-55 and FN-56 removed. INIT-01 rewritten to describe inline initialization. |
| R-02 | Second-opinion requirement absent from failure strategy | Added §14 item 7 per WPR-103 §13.3 |
| R-03 | Traceability matrix missing columns | Added "Last Run Date" and "Notes" columns to §16 |
| R-04 | `.session-item.open` state not tested | Added SB-12 and UI-E31 |
| R-05 | "Hidden" session state workflow not tested | Added ARC-03, ARC-04 |
| R-06 | Git clone path not covered | Added AP-07, AP-08 |
| R-08 | Appendix B HTTP method error | Corrected to POST for `/api/jqueryfiletree`; added `/api/browse` |
| R-09 | `/api/sessions/:id/name` not accounted for | Added to Appendix B |
| R-10 | NS-01/NS-08 button label wrong | Corrected to "Start Session" |
| R-11 | WebLinks addon not in exclusions | Added to §15.1 |
| R-12 | `expandedProjects` non-persistence undocumented | Added to §15.1 |

### Phase 6a: Claude (Sonnet) Review -- Findings Not Accepted

| ID | Finding | Rationale for Rejection |
|----|---------|------------------------|
| R-07 | Auth banner reason-specific tests (AUTH-06a..06e) | Code verification confirms `showAuthBanner()` does not branch on the `reason` parameter. The function displays the same generic banner regardless of reason. Testing multiple reason values would test the backend API, not the UI. The UI behavior (banner appears/disappears) is already fully covered by AUTH-06 and AUTH-07. |
| R-13 | CSI handler test gap | Added to §15.1 exclusions with justification instead. The handlers are defensive third-party integration code; malfunction would manifest as visible rendering issues caught by the visual review protocol. |

### Phase 6a: GPT Review -- Findings Accepted

| Finding | Action Taken |
|---------|-------------|
| Temp session ID migration workflow missing | Added RACE-01..03 (§7.36), BRW-32, and temp-id.spec.js |
| Hidden session workflow incomplete | Added ARC-03, ARC-04, USR-07 |
| Panel project-switch stale data | Added PNL-05 and BRW-34 |
| `/api/state` failure not tested | Covered by FAIL-01 (fetchJSON 500 path) and FAIL-02 (network failure) |
| `/api/mounts` empty fallback | Added FIL-05 |
| Search API failure | Added SCH-05 |
| Session resume failure | Added SES-04 |
| Close tab cancels reconnect | Added RCN-08 |
| Notes save race on project switch | Added NTS-04 |
| Config notes clear button | Added CFG-06, UI-E127 |
| Modal close buttons not individually tested | Added NS-09, SUM-05, AP-09 with corresponding UI elements |
| "100% coverage" claim too strong | Reframed to "comprehensive coverage" with post-code audit as the completeness mechanism |

### Phase 6a: GPT Review -- Findings Not Accepted

| Finding | Rationale for Rejection |
|---------|------------------------|
| Anonymous event handler inventory (5th inventory) | WPR-103 Abstraction Level section: "Name the behavior being tested, not the function or method." Anonymous event handlers are implementation details. They are tested through the behaviors they enable (DND-01..04 test drag events, KEY-01..05 test keydown, NTS-03 tests debounce, etc.). An inventory of anonymous handlers conflates test specification with code structure. |
| Exhaustive state-transition combinations (archived+open, hidden+open, etc.) | The plan tests each state independently (open, active, archived, hidden, missing) and the most important combinations (SB-12 for open-not-active). Combinatorial explosion of all pairs is not justified by risk analysis. The post-code audit (§22) catches any combination that proves important during implementation. |
| Exhaustive race condition scenarios (search out-of-order, double-click complete, task mutation races, etc.) | The plan covers the highest-risk race conditions: temp ID migration (RACE-01..03), reconnect-during-close (RCN-08), rapid tab switching (TAB-07), double-click prevention (BRW-30), and notes save race (NTS-04). The remaining scenarios are theoretical and would require complex test infrastructure (request interception with controlled timing). Cost-benefit does not justify them for a standard gate. |
| Full smart-compaction state machine as UI tests | Most pipeline stages (checker initialization, prep-to-agent prompt injection, plan file localization, git-commit injection, recovery checker prompt) are backend implementation details invisible to the browser. This is a Gate C (UI) plan, not a Gate B (integration) plan. The UI-visible stages ARE tested: threshold detection (CST-01..04), nudge creation (CST-05..08), compaction trigger (CST-04), recovery (CST-12, CST-15), and failure paths (CST-16..18). Per-phase gray-box checks (CST-13..15) verify the key artifacts. |
| Backend-only capability exclusions (OpenAI-compat, webhooks, quorum execution, etc.) | These have no UI controls. They are Gate B concerns. Added a single line to §15.1 exclusions rather than individual entries. |
| Hover state testing for sidebar elements | CSS hover states without behavioral changes are visual concerns, not functional test scenarios. The visual review protocol (§3.6) catches rendering issues from hover. Hover states WITH behavior (SES-02, session actions appear on hover) are already covered. |

### Phase 6a: Grok Review -- Findings Accepted

| Finding | Action Taken |
|---------|-------------|
| Workbench JSON parser protocol test | Added CLI-21 |
| Per-phase compaction gray-box checks | Added CST-13..15 |
| Compaction failure path tests | Added CST-16..18 |
| Visual review rubric should be versioned | Added `visual-review-rubric.md` to helpers directory; updated §3.6 |
| Traceability matrix row-per-item (aspirational) | Noted as post-implementation task; §22 audit covers this |

### Phase 6b: Claude (Sonnet 4.6) Review -- Findings Accepted

| ID | Finding | Action Taken |
|----|---------|-------------|
| GAP-01 | `settings_update` WS handler not tested | Added RCN-09: WS message injection test for settings_update path |
| GAP-02 | WS `type: 'error'` handler not tested | Added RCN-10: WS error message injection test |
| GAP-03 | `deleteSession()` disabled, not in §15 | Added to §15.1 with Issue #457 reference |
| GAP-04 | MCP tool CLI matrix missing categories | Documented remaining tools as §15.1 exclusion with justification (effects testable via UI; fully covered by Gate B) |
| GAP-05 | `/api/projects/:name/claude-md` absent from Appendix B | Added footnote to Appendix B |
| GAP-06 | `/api/keepalive/status` absent from §15 / Appendix B | Added to §15.1 exclusions and Appendix B footnotes |
| OBS-02 | FAIL-01 assertion precision | Clarified FAIL-01 to name `loadState` as the specific call site under test |
| OBS-03 | `pollTokenUsage` silent catch untested | Added STB-08: token polling degraded-state scenario |

### Phase 6b: Claude (Sonnet 4.6) Review -- Not Accepted (Implementation Notes)

| ID | Finding | Rationale |
|----|---------|-----------|
| OBS-01 | Double monkey-patch on `switchTab` | Implementation awareness note for test code author, not a plan change. TAB-03 and PNL-04 cover the observable behaviors. |
| OBS-04 | Stress suite timeout configuration | Added per-project timeout support to §3.2 Playwright config. No test scenario change needed. |
| OBS-05 | `.new-session-btn` vs `.new-btn` dual entry points | Added to §22 post-code audit checklist. Cannot be resolved until implementation. |

### Phase 6b: Gemini Review -- Findings Accepted

| Finding | Action Taken |
|---------|-------------|
| FN-55 (`fetchJSON`) and FN-56 (`main()`) are server-side, not browser functions | **Critical correction.** Verified: `fetchJSON` at line 3110 of flat code is in `mcp-server.js` (server-side). `main()` at line 9629 is in `scripts/prime-test-session.js`. Neither exists in `public/index.html`. Removed both from JS Function Inventory. Function count: 56 -> 54. |
| INIT-01 references non-existent `main()` function | Rewritten to describe the inline initialization sequence at the bottom of `public/index.html`'s `<script>` block: `loadState()`, `setInterval(loadState, REFRESH_MS)`, `setTimeout(checkAuth, 1000)`, `setInterval(checkAuth, 60000)`, `loadAppearanceSettings()`. Verified by direct network request observation, not function call monitoring. |
| New session overlay Cancel button missing from UI element inventory | Added UI-E122 |
| Session config overlay Close (X) button missing from UI element inventory | Added UI-E130 |
| Session config name Clear button missing from UI element inventory | Added UI-E128 |
| Session config backdrop click not tested | Added CFG-07 |
| Mock vs. Live categorization missing per-scenario | Added "Layer" column (Mock/Live) to all scenario tables in §7. Added Mock/Live designation to traceability matrix rows in §16. Each scenario's layer assignment follows the three-layer strategy defined in §2.2. |
| Capability Audit with REAL/MOCK/NONE format missing | Added §5a: consolidated capability audit table with REAL/MOCK/BOTH designations per WPR-103 §4.1. Zero NONE entries. |

### Phase 6b: Grok Review -- Findings Accepted

| Finding | Action Taken |
|---------|-------------|
| Formal Capability Audit table | Added §5a (aligns with Gemini finding) |
| LLM judge rubric should be versioned and extracted | Added `llm-judge-rubric.md` to §3.4 helpers table; referenced from §2.5 |

### Phase 6b: GPT (Grok raw response) Review -- Findings Accepted

| Finding | Action Taken |
|---------|-------------|
| Modal overlap and reentrancy not tested | Added MOD-01..04 in `modal-overlap.spec.js`. Covers auth-during-settings, Escape priority, DOM orphan cleanup, and overlay cleanup on navigation. Added BRW-35 workflow. |
| Button state recovery on error not tested | Added UI-ERR-01 ("Creating..." recovery) and UI-ERR-02 (summary spinner clearance) in `error-recovery.spec.js` |
| `escHtml` only indirectly covered | Added ESC-01..04 in `xss-safety.spec.js`. Explicitly tests session names, task text, search snippets, and file names with HTML injection attempts. `escHtml` (FN-51) now has direct test coverage. |
| File viewer switching not tested | Added FIL-06 (error handling) and FIL-07 (file switching) |
| Tmux killed externally not tested | Added LIFE-01 in `session-lifecycle.spec.js` and BRW-36 workflow |

### Phase 6b: GPT (Grok raw response) Review -- Findings Not Accepted

| Finding | Rationale for Rejection |
|---------|------------------------|
| Exhaustive Claude Code slash command coverage (/login, /agents, /memory, /resume, /extract) | This is a Gate C (UI) plan. These slash commands are Claude Code features, not Workbench features. Workbench's responsibility is to pass terminal I/O correctly (tested by TIO-01..05) and to detect specific patterns like auth URLs (AUTH-01..08) and compaction JSON (CLI-21). The slash commands themselves are tested by Claude Code's own test suite. The CLI matrix covers representative categories. |
| Full MCP tool coverage (all 16+ tools) | Effects of all MCP tools are visible through existing UI tests (sidebar state, task panel, notes panel, file browser). The remaining tools are fully covered by Gate B MCP integration tests. Adding terminal-mediated tests for every tool would duplicate Gate B coverage with significantly higher cost (non-deterministic, API-key dependent). Documented in §15.1. |
| Terminal fragmentation edge cases (multiline paste, typing while streaming, reconnect with scrollback) | These are xterm.js library behaviors, not Workbench application code. Workbench's terminal integration is tested through TIO-01..05 and the buffer API assertion pattern (§2.4). xterm.js's handling of partial lines and concurrent I/O is the library's responsibility. |
| Performance/usability edge cases (many open tabs, long sidebar, small viewport) | These are performance testing concerns, not functional test scenarios. The plan covers viewport resize (TIO-03: 1920x1080) and the visual review protocol catches layout issues. Dedicated performance testing is out of scope for Gate C functional acceptance. |
| All API error paths individually (malformed JSON, every endpoint's 500) | Representative error paths are covered: FAIL-01 (server 500), FAIL-02 (network failure), SES-04 (resume 500), SCH-05 (search 500), SUM-04 (summary error), FIL-05 (mounts empty), FIL-06 (file read error), STB-08 (token poll 500), UI-ERR-01 (create session 500), UI-ERR-02 (summary 500). Testing every endpoint's error individually would produce diminishing returns; the error handling pattern is consistent across call sites. |
| `timeAgo()` unit-level boundary testing | `timeAgo` is a pure formatting function with no side effects. It is exercised through SB-06 (session metadata display). Unit-level boundary testing (future timestamps, exact thresholds) belongs in Gate A mock tests, not Gate C browser tests. |
| `db_getSetting()` explicit exercise | This is an internal caching function. It is exercised implicitly by every test that reads settings (SET-05, THM-01..04, FNT-01..04, REF-03). Adding explicit tests for the cache mechanism would test implementation internals, not UI behavior. |
| State-transition matrix (formal) | The plan covers key states independently and in risk-proportional combinations. A formal state-transition matrix for all lifecycle states (session x tab x panel x modal) would produce hundreds of combinations. The post-code audit (§22) catches important combinations that emerge during implementation. |
| Browser `alert()` dialog Playwright handling | Playwright captures `dialog` events by default. The plan tests alert-producing paths (SB-11, AP-05, AP-08, SES-04). The `page.on('dialog')` handler is part of the baseline reset protocol (§3.5). Adding dedicated alert-handling tests would test Playwright's dialog API, not Workbench's behavior. |
| Compaction during auth/reconnect/tab-switch | Extremely unlikely edge cases with enormous test infrastructure cost. Each would require coordinating multiple async state machines simultaneously. The individual paths are thoroughly tested: compaction (CST-01..18), reconnection (RCN-01..10), auth (AUTH-01..08), tab switching (TAB-01..07). Cross-product testing of all combinations is not justified by risk analysis. |

### Phase 6c: Claude (Sonnet 4.6) Review -- Findings Accepted

| ID | Finding | Action Taken |
|----|---------|-------------|
| GAP-01 | `chunked-auth-frames.bin` fixture orphaned -- no test uses it | Added AUTH-09: fragmented WS frame auth URL detection using the existing fixture |
| GAP-02 | Right panel behavior with no active session untested | Added PNL-00: panel opened with no active session, exercises `getCurrentProject()` null path |
| GAP-03 | Invalid JSON in quorum additional juniors untested | Added VAL-04: invalid JSON input validation for `#setting-quorum-additional` |
| OBS-01 | HR-01 conflates poll and WS push paths | Clarified HR-01 description to specify poll-path testing; noted WS push path covered by RCN-09 |
| OBS-02 | STB-07 assertion underspecified | Clarified STB-07 to name specific fields (model name, context percentage, connection status) |
| OBS-04 | WPR-103 §7.3 pipeline performance measurement not explicitly delegated | Added explicit delegation note to §15.1 exclusions |

### Phase 6c: Claude (Sonnet 4.6) Review -- Observations Noted for Implementation

| ID | Finding | Disposition |
|----|---------|-------------|
| OBS-03 | Context color boundary conditions (exact 60%/85% thresholds) | Low risk; visual review protocol catches wrong colors. Test code author should add CTX-05/06 at exact thresholds if implementation logic is non-trivial. |
| OBS-05 | `pong` WS message handling not explicitly tested | Low risk; broken pong would surface as connection instability caught by RCN-01..08. Test code author should be aware pong path is exercised incidentally. |

### Phase 6c: Gemini Review -- Findings Accepted

No new gaps identified. Plan approved unconditionally. Noted strengths: MOD-02 as test-driven architecture (Escape for dynamic overlays will intentionally fail against current code, forcing a fix per WPR-103 §13.4), terminal buffer API assertion pattern, and `workbench_primer.py` stress testing approach.

### Phase 6c: Grok (Synthesized Multi-Model) Review -- Findings Accepted

| Finding | Action Taken |
|---------|-------------|
| `workbench_primer.py` not in test infrastructure directory structure | Added documentation note to §1.4 specifying primer is referenced via `docker exec` from its container installation path |

### Phase 6c: Grok (Synthesized Multi-Model) Review -- Observations Noted

| Finding | Disposition |
|---------|-------------|
| Visual review protocol meta-test | Non-blocking. Can be added as a meta-test in coverage gate during implementation. The visual review process running and producing a report is a CI concern, not a test plan scenario. |
| RACE-04 (close temp tab before resolution) | Already covered by RACE-03: "Create session, immediately close tab." Identical scenario. |

### Phase 6c: GPT Review -- Findings Accepted

| Finding | Action Taken |
|---------|-------------|
| Invalid JSON in quorum additional juniors (§3.5) | Added VAL-04 (aligns with Claude GAP-03) |
| MCP server duplicate name handling (§3.5) | Added VAL-05: duplicate name collision behavior |
| Font size extreme values (§3.5) | Added VAL-06: 0, -1, 999 edge values |
| File viewer readonly enforcement (§3.4) | Added FIL-09: verify `readonly` attribute prevents editing |
| Multi-depth file tree expansion (§3.1) | Added FIL-08: 3-level expansion test |
| Multiple mount points rendering (§4.3) | Added FIL-10: two distinct mount paths rendered |
| Project terminal isolation workflow (§5.1) | Added BRW-37: multi-project terminal tab isolation |
| Session notes vs project notes scope (§5.2) | Added BRW-38: session-private notes vs project notes separation |
| Hidden session full lifecycle workflow (§5.4) | Added BRW-39: active → hide → find → open → unhide → active, chained end-to-end |
| Settings propagation to new session (§5.5) | Added BRW-40: settings changes reflected in newly created session |
| Compaction checker protocol command variants (§6.4) | Added CST-19: `read_plan_file` and `exit_plan_mode` checker commands |
| Compaction double-trigger lock behavior (§6.4) | Added CST-20: lock contention during concurrent compaction |
| Status bar model shortening branches (§3.2) | Added STB-09: opus/sonnet/haiku/unknown model name shortening |
| Status bar thinking conditional display (§3.2) | Added STB-10: thinking item omitted when "none", shown when non-"none" |
| Git clone failure recovery (§5.3) | Added AP-10: invalid URL error with modal staying open for retry |
| Auto-refresh while modal open (§7.2) | Added REF-04: loadState poll during open settings modal |
| Project group with zero filtered sessions (§4.4) | Added SB-13: empty project group after filter applied |

### Phase 6c: GPT Review -- Findings Not Accepted

| Finding | Rationale for Rejection |
|---------|------------------------|
| jQuery FileTree generated element inventory (§3.1) | WPR-103 Abstraction Level: "Name the behavior being tested, not the function or method." Generated file/directory row elements are third-party library output. The behaviors they enable ARE tested: click-to-open (FIL-02, FIL-08), expand/collapse (FIL-04, FIL-08), drag source (DND-04), and multi-depth expansion (FIL-08). Adding inventory rows for library-generated DOM nodes conflates the UI Element Inventory (which catalogs application-defined elements) with library internals. The post-code audit (§22) explicitly checks generated interactive elements. |
| All `updateStatusBar()` branches individually (§3.2) | STB-09 covers the model shortening branches (the highest-risk conditional logic). STB-10 covers the thinking conditional. Remaining branches (context text formatting at small vs large values, max token formatting) produce visual differences caught by the visual review protocol. Adding test scenarios for every formatting branch crosses into unit-level function testing, not UI behavioral testing. |
| All overlay×overlay combinations (§3.3) | MOD-01 tests the highest-risk case (auth modal during settings). The auth modal uses a static DOM element (`#auth-modal`) separate from dynamic body-appended overlays, making its overlap behavior consistent regardless of which overlay is underneath. Testing all 10+ pairwise overlay combinations would produce diminishing returns with high test infrastructure cost. Added to §15.1 exclusions with justification. |
| All `checkForAuthIssue()` branches (§4.1: no URL, malformed URL, stale buffer, multiple URLs) | The negative cases (no URL in buffer, malformed URL) are the default state of every test that doesn't trigger the auth modal. AUTH-10 tests the "already visible" guard. The remaining branches (stale buffer from prior tab, multiple URLs) are theoretical edge cases with no known failure history. The function's regex pattern either matches or doesn't; partial matches don't produce dangerous behavior. |
| All `connectTab()` WS message branches (§4.2) | These are implementation-level branches (JSON parse failure for non-JSON, binary payload, `onerror` vs `onclose` distinction). Observable WS behaviors are tested through RCN-01..10 and TIO-01..05. Adding tests for each internal message-handling branch crosses into unit testing, not UI behavioral testing. Added to §15.1 exclusions. |
| All `loadFiles()` branches (§4.3: repeated call no-op, event delegation, drop rel trim, simultaneous mounts) | `fileBrowserInitialized` guard is an optimization detail. Event delegation for `mouseenter` is tested through DND-04. Simultaneous open mounts is tested through FIL-10. The remaining branches (drop rel attribute whitespace, mount section first-expand-only) are implementation details with no user-visible risk. |
| All `renderSidebar()` branch combinations (§4.4) | Hash-skip optimization (SB-08), missing project (SB-09, SB-10), open-not-active (SB-12), and empty-after-filter (SB-13) cover the risk-bearing branches. Exhaustive combination testing (archived+missing+hidden class combinations, auto-expand on first load only) produces combinatorial explosion without proportional risk coverage. |
| Full terminal reachability audit as separate inventory (§9.1) | The CLI Category Matrix (§9) already serves this purpose. It categorizes terminal-reachable functions into slash commands, file operations, MCP tools, planning, and input handling, with representative coverage from each. Creating a second parallel inventory would duplicate the matrix without adding scenarios. The distinction between "UI-visible" and "terminal-only" is already captured by the three-layer strategy (§2.2): U3 is explicitly terminal-mediated. |
| All MCP tools through terminal (§6.2, §8.2) | This is a Gate C (UI) plan. MCP tools are backend services tested in Gate B. The terminal passes I/O correctly (TIO-01..05); the MCP server processes commands correctly (Gate B). Testing every MCP tool through the terminal would duplicate Gate B with non-deterministic, API-key-dependent tests. The CLI matrix covers representative categories. Effects of all MCP tools are visible through existing UI tests. |
| All slash commands relevant to product workflows (§6.1, §6.3) | Same rationale as above. `/login`, `/agents`, `/resume`, and other Claude Code commands are Claude Code features, not Workbench features. Workbench's responsibility is terminal I/O correctness and pattern detection (auth URLs, compaction JSON). The slash commands themselves are tested by Claude Code's own test suite. |
| Full compaction checker state machine (§6.4: every protocol command, no-output path, cleanup timing, tmux death during compaction) | CST-19 adds `read_plan_file` and `exit_plan_mode` to the tested protocol commands. CST-16..18 cover failure paths (malformed JSON, error status, timeout). CST-20 covers lock contention. The remaining commands (`resume_complete` is implicitly tested by CST-12/CST-15 recovery verification) and edge cases (tmux death during prep, cleanup file delay) are backend pipeline details invisible to the browser. |
| All race conditions (§7.1: search+refresh, collapse+refresh, session open+modal, notes save+tab close, task add+project switch, summary+archive, reconnect timer+temp ID, auth submit+tab close) | The plan covers the highest-risk race conditions identified by risk analysis: temp ID migration (RACE-01..03), reconnect-during-close (RCN-08), rapid tab switching (TAB-07), double-click prevention (BRW-30), notes save race (NTS-04), and auto-refresh during modal (REF-04). The remaining scenarios are theoretical combinations with no known failure history and would require complex test infrastructure with precise timing control. |
| All polling×modal interaction combinations (§7.2) | REF-04 tests the principle (loadState during settings modal). The polling mechanism is the same for all modals; the DOM isolation between the sidebar (which refreshes) and modal overlays (which are separate DOM subtrees) is architecturally consistent. Testing every modal type during every poll type would produce 15+ scenarios with identical behavior. |
| "Guarantees complete coverage" language change (§13) | The plan already uses "comprehensive coverage" (§0, Executive Summary) rather than "100% coverage" or "guarantees complete coverage." The completeness mechanism is the post-code audit (§22), which closes any gaps found after test code is written. This is a structural guarantee -- any unmapped inventory row is a visible gap -- which is stronger than claiming exhaustive branch coverage. |

---

*End of plan*
