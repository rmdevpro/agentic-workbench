# Remediation Execution Summary

**Date:** 2026-05-08
**Source plan:** `CORRECTIVE_ACTION_PLAN.md` (v2, incorporates reviewer feedback)
**Reviews:** `review/CODEX_CODE_REVIEW.md`, `review/GEMINI_CODE_REVIEW.md`, `review/CLAUDE_CODE_REVIEW.md`
**Issue mapping:** `REMEDIATION_ISSUE_MAP.txt`

## What was filed

- **62 GitHub issues** filed in `rmdevpro/agentic-workbench`: **#318–#379**
- **62 Workbench tasks** created (project_id 39, path `/data/workspace/repos/agentic-workbench`): task IDs **#179–#240**
- Each task title is `[#GH-NUM] <ACTION-ID>: <TITLE>` for easy lookup. Each task description cites the plan section, source review, phase, and effort.
- Decomposition parents (F0, G0, H0, I0) include their children as checklists in the issue body — children land as PRs against the parent issue, not as separate issues.

## Quick navigation

| Phase | Actions | GH issue range |
|---|---|---|
| Phase 0 — Stabilize | B1-B4, O1, N4, C1, C7 | #318-#325 |
| Phase 1 — Correctness + foundations | A1-A18, C2-C6, C8, D1-D10, K1, L1, N1a, F7 | #326-#363 |
| Phase 2 — Structural foundations | F0, G0, H0, J1, M1, E3 | #364-#369 |
| Phase 3 — Structural completion | I0 (A10, A18 already in Phase 1 batch) | #370 |
| Phase 4 — Performance + tooling | E1, E2, N1b, N2, N3, O2, O3, O4 | #371-#378 |
| Phase 5 — Documentation | P1 | #379 |

## Required reading before execution

These are non-negotiable per project CLAUDE.md. Read fully into context, no summarization, no searching:

1. `CLAUDE.md` (project) — project rules + anchor doc list.
2. `Admin/docs/requirements/REQ-001-base-engineering.md` — engineering requirements.
3. `Admin/docs/standards/STD-003-test-plan-standard.md`, `STD-004-code-standard.md`, `STD-005-test-code-standard.md`, `STD-007-readme-standard.md`.
4. `Admin/docs/process/PROC-001-debugging-guide.md` — debugging workflow (start of any bug investigation).
5. `Admin/docs/process/PROC-002-small-feature-guide.md` — feature workflow (start of any new feature work).
6. `Admin/docs/process/PROC-003-runbook-execution-guide.md` — for UI test runbook.
7. `Admin/docs/process/PROC-004-test-execution-policy.md` — which tests run and when.
8. `Admin/docs/runbooks/RUN-001-deployment.md` — canonical deploy procedure.
9. `Admin/docs/guides/workbench-deployment.md` — deployment architecture, `/data` volume convention.
10. `README.md` — architecture, modules, config reference.
11. `tests/workbench-test-plan-backend.md` — backend test plan.
12. `tests/workbench-test-plan-ui.md` — UI test plan.
13. `tests/workbench-test-runbook.md` — UI runbook.
14. `tests/traceability-matrix.md` — coverage status.
15. `MEMORY.md` — auto-memory index (`/data/.claude/projects/-data-workspace-repos-agentic-workbench/memory/`).

## Execution rules (do not deviate without user approval)

These are codified in saved memory and CLAUDE.md.

- **Deployment.** RUN-001 canonical sequence only. **M5/dev only** unless explicitly authorized; never irina/prod. (memory `feedback_deploy_run001.md`)
- **UI tests.** Real `browser_click`/`browser_drag` against deployed UI. **Never** substitute `browser_evaluate` fetch queries, `curl`, `docker exec`, or `tmux send-keys` for UI testing. (memory `feedback_ui_tests_headless_only.md`)
- **MCP tools.** Any new tool requires both a handler in `src/mcp-tools.js` AND a schema entry in `src/mcp-server.js`'s T() registry. Action L1 (#361) eliminates this drift permanently. (memory `feedback_mcp_dual_declaration.md`)
- **Tests verify actual results.** `{ok:true}` HTTP/MCP response is necessary but not sufficient. Every test must assert on the observable effect (screen content, DOM state, file change). (memory `feedback_tests_must_show_actual_results.md`)
- **No silent workarounds.** Tool fails → file an issue → continue via non-masking signal. Never fall back to deprecated tools quietly. (memory `feedback_no_silent_workarounds.md`)
- **Inline-poll background work.** When work is running in background, stay engaged with checks; never rely on Monitor alone. (memory `feedback_inline_poll_never_background_wait.md`)
- **PROC-001 always.** Reproduce → Record → 3-CLI RCA → Fix → Verify. (memory `feedback_proc01_always.md`)
- **No multiple-choice questions to user.** Never use AskUserQuestion with options. (memory `feedback_no_multiple_choice.md`)
- **Read issue bodies, never just titles.** Body always trumps title. (memory `feedback_read_issue_bodies.md`)

## Critical sequencing dependencies

Per plan §6 + Claude §11.4 / §11.6. **Land in this order to avoid rework:**

```
Phase 0 (parallel): B1, B2, B3, B4, O1, N4, C1, C7
   ↓
Phase 1 (parallel except where noted):
   • C2 (early — externalize config keys before A actions read them)
   • A1-A18 (correctness fixes, parallelizable)
   • C3, C4, C5, C6, C8 (hygiene)
   • D1-D10 (operational)
   • K1 (DB migration runner — unlocks §3.3 deferred relational work)
   • L1 (MCP catalog SSoT — must precede G1, G5)
   • N1a (lint warnings tier — baseline for N1b)
   • F7 (oauth-detector canary — proves F0 modular shape)
   ↓
Phase 2 (structural foundations):
   • F0 + F1, F2, F3 (frontend foundation; F2 hard prerequisite for F4-F14)
   • G0 + G1, G2, G5 (routes; A2 + L1 must have landed)
   • H0 + H1 (session-utils Claude branch with transitional adapter)
   • J1 (qdrant-sync factory-DI + streaming)
   • M1 (KB lifecycle migration)
   • E3 (optimistic-poll correctness)
   ↓
Phase 3 (completion):
   • F4-F6, F8-F14 (frontend remaining)
   • G3, G4, G6-G9 (routes remaining)
   • H2-H5 (session-utils remaining)
   • I0 + I1-I5 (watchers decomposition)
   • A10 (after H2)
   • A18 (after F0+F5)
   ↓
Phase 4 (performance + tooling):
   • E1 + E2 (performance — together hit M5 p95 <1s target)
   • N1b (lint errors tier — blocked by N1a + C5)
   • N2 (lint public/** — blocked by F0 progress)
   • N3 (c8 thresholds — blocked by separate coverage-gap audit; see existing #229)
   • O2, O3, O4 (test reconciliation)
   • D5 (esbuild devDep — folds in here too)
   ↓
Phase 5 (documentation):
   • P1 (README rewrite — last so it reflects everything)
```

## Hard dependencies (one-line summary)

| Dependency | Reason |
|---|---|
| A2 + L1 → before G1 + G5 | Avoids migrating fixes during decomposition |
| C2 → Phase 1 (early) | A actions should read defaults.json, not code-side fallbacks |
| N1a → N1b | Need warning baseline before escalating to errors |
| C5 → N1b | Inline-require breakage shouldn't surface as lint-rule collateral |
| K1 → §3.3 deferred relational migrations | Migration runner enables future schema work |
| F2 → F4-F14 | Heavy global state coupling (Gemini §10.3) |
| F7 canary → F4-F14 | Proves modular split shape |
| A10 → H2 | Avoids re-extracting Gemini parser during decomposition |
| A18 → F0+F5 | Easier after frontend modularization |
| H0 transitional adapter → H1-H5 | Avoids simultaneous edits to ~6 consumer files |
| N3 → coverage gap audit (#229 separate) | Threshold change is 1hr; gap closure is separate scope |
| N2 → F0 (F1+F2+F3 minimum) | Can't lint public/** until modules exist as real .js files |

## Effort summary (single engineer)

| Phase | Actions | Estimated effort |
|---|---|---|
| Phase 0 | 8 | ~1 day |
| Phase 1 (A actions) | 18 | ~5-6 days |
| Phase 1 (C2-C6, C8) | 6 | ~1.5 days |
| Phase 1 (D1-D10) | 10 | ~3 days |
| Phase 1 (K1, L1, N1a, F7) | 4 | ~5 days (K1=3d, F7=1.5d, L1=4hr, N1a=4hr) |
| Phase 2 | 6 | F0 begins (3-4w total), G0 begins (~2w), H0 begins (~2w), J1 (3d), M1 (1d), E3 (1d) |
| Phase 3 | 1 + completion of F/G/H | I0 (4d) + finishing F4-F14, G3-G9, H2-H5 |
| Phase 4 | 8 | E1+E2 (~1.5d combined), N1b (1-2d), O2/O3/O4 (3d), D5 (30min), N2/N3 small |
| Phase 5 | 1 | P1 (4hr) |
| **Total** | **62** | **~9-12 weeks single engineer**, parallelizable across two engineers once F1+F2+F3 land |

## Skip set (NOT being executed)

Per plan §3:

- **§3.1.** Frontend framework migration to React/Vue. Months of work; F0 captures ~80% of the maintainability win. Re-evaluate per F-child if any prove persistently brittle (likely F5/F6/F8 are candidates for late-stage targeted lit-html or Preact port).
- **§3.2.** WebSocket push for `/api/state`. E1 + E2 + **E3** (the new optimistic-poll fix from Gemini's pushback) close the latency and correctness gaps. Re-evaluate if production data shows neither is enough.
- **§3.3.** JSON-stringified settings → relational tables. Single-user trust model makes lost-update theoretical. K1 unblocks future relational migrations; webhooks + vector_collection_* are the next-easiest candidates per Claude §11.1 if a real concurrency need arises.
- **§3.4.** `task-service.js` extraction. Codex §19. A2 atomicity fix (#327) is minimum-viable correctness. Folds naturally into G5 if the validation drift remains painful.
- **§3.5.** OAuth detector → Node worker thread. Gemini §1.5. A14/F7 (#363) extracts to a frontend ES module first; worker-thread move deferred until main-thread blocking is observed in production.

## Ready-to-start work right now

**Best Phase 0 starters** (all independent, 10min-3hr each):

1. **B3** (#320) — delete `scripts/prime-test-session.js` (15 min, smallest)
2. **B4** (#321) — delete .dockerignore exclusions for non-existent files (10 min)
3. **N4** (#324) — ESLint test-globals override (1 hr, clears 49 lint errors immediately)
4. **B1** (#318) — delete src/voice.js + tests (30 min)
5. **C1** (#322) — .dockerignore PNG/TXT for local docker builds (30 min)
6. **B2** (#319) — delete jQuery + jqueryfiletree deps (1 hr)
7. **O1** (#325) — fix 16 mock test failures (3 hr)
8. **C7** (#323) — test artifact .gitignore + missing fixtures (3 hr)

**Best Phase 1 quick wins** (independent, 30min-3hr):

- **A9** (#334) — Claude tmpId collision fix (30 min)
- **A12** (#337) — server.js gate page sync read cache (1 hr)
- **A7** (#332) — /api/programs PUT name uniqueness in transaction (1 hr)
- **A8** (#333) — /api/auth/login stop burning tokens (1 hr)
- **D5** (#354) — pin esbuild as devDep (30 min)
- **C6** (#348) — trivial cleanup batch (1 hr)
- **C8** (#349) — legacy safe-exec helpers cleanup (1 hr)
- **L1** (#361) — MCP catalog SSoT (4 hr; unlocks G1/G5)
- **A1** (#326) — routes.js path-encoding mismatch (1 hr; real silent bug)

## Open user decisions (per plan §12.6)

These are choices reviewers surfaced but the plan does not yet resolve. Decide before starting Phase 1 work:

1. **N1a vs N1b split or single action.** Plan adopted the split per Claude §11.3. Alternative: keep single N1 with explicit "warnings first, escalate to errors after a sweep" milestone.
2. **F0 child PRs against parent issue, vs separate child issues.** Plan §7 originally said separate child issues; v2 took the parent-with-checklist approach. Confirm before F0/G0/H0/I0 begin.
3. **Phase 0 boundary.** Codex's addendum suggests Phase 0 is "decide and freeze review scope." The plan adopted Phase 0 as "stabilize the model" — similar but not identical.

## Files of record

- `CORRECTIVE_ACTION_PLAN.md` — v2 plan with reviewer feedback in §10 (Gemini), §11 (Claude), §10b (Codex pointer to review file), §12 net changes from v1.
- `REMEDIATION_ISSUE_MAP.txt` — flat mapping `<ACTION-ID> <GH-NUM> <TITLE>` for the 62 issues.
- `REMEDIATION_EXECUTION_SUMMARY.md` — this document.
- `review/CODEX_CODE_REVIEW.md` — Codex review + cross-review reconciliation addendum (§§A1-A8) + revised plan + reviewer feedback at line 905.
- `review/GEMINI_CODE_REVIEW.md` — Gemini 5-part audit with appendix.
- `review/CLAUDE_CODE_REVIEW.md` — Claude 12-section structural review.

## Execution checklist for the next engineer (or session)

1. Read everything in §"Required reading" above — fully into context, no summarization.
2. Resolve the §"Open user decisions" with the user.
3. Pick a Phase 0 starter from §"Ready-to-start work right now."
4. Follow PROC-002 (small feature) or PROC-001 (bug fix) per the action's nature.
5. For each action: branch → implement → test (mock + live + browser as applicable) → deploy to M5 via RUN-001 → verify acceptance criteria → PR linked to the GH issue.
6. Update task status in workbench MCP (`task_update`) when each lands.
7. Comment on the GH issue with verification evidence before close. **Never close issues without user permission** (memory `feedback_never_close_without_permission.md`).
8. After closing, mark the corresponding workbench task as `done` via `task_update`.

## Phase Gate Tests

Each phase ends with a gate run that verifies cumulative state before the next phase starts. Per-action acceptance is necessary but not sufficient — the gate proves the integrated state.

### Universal gate elements (run for every phase unless noted)

- **Mock suite:** `npm run test` and `npm run test:coverage`. **0 failures.** Coverage thresholds per N3 (#375) once aligned; until then, the documented ≥85% mock target per saved memory `feedback_coverage_gate.md`. **Don't round.**
- **Live suite:** `npm run test:live` against M5/dev. **0 failures, 0 skips** per saved memory `feedback_coverage_gate.md` (Live + UI are 100%) and existing #260 ("no test ever skipped — scope matrix decides what runs, every selected test must pass").
- **CLI parity:** every Claude-targeting test that has a Gemini/Codex counterpart in the suite must also pass for those CLIs (saved memory `feedback_test_all_clis.md`).
- **Lint + format:** `npm run lint` and `npm run lint:format` (after N1a #362 lands). 0 errors; warning count must not regress against the previous phase's baseline.
- **Authoritative scope reference:** `Admin/docs/process/PROC-004-test-execution-policy.md` defines which gates (A / B / C) run for which scope. The per-phase notes below specify the gate label; PROC-004 is the source of truth for scenario lists.

### Phase 0 — Stabilize (gate: BASELINE)

**Goal:** CI green, lint clean, local docker builds work. Make refactoring possible.

| Check | Command / source | Pass criterion |
|---|---|---|
| Mock suite | `npm run test` | 0 failures (was 16 before O1 #325 — the gate proves O1 worked) |
| Lint baseline | `npm run lint` over `tests/browser/` | 0 errors (was 49 — proves N4 #324 worked) |
| Local docker build | `docker compose up --build` on a workstation | Image contains `/workbench-preview.png`, `/planlogo.png`, all logo PNGs; `tests/fixtures/ansi-auth-url.txt` present (proves C1 #322 + C7 #323) |
| Live suite | `npm run test:live` on M5 | 0 failures (no live behavior changes in Phase 0; gate confirms no regression) |
| Voice deletion | `grep -ri "voice" src/ tests/ public/ config/` | Returns zero hits OR explicitly listed surviving references (proves B1 #318) |
| Frontend smoke | Manual on M5: load workbench, open a tab, file editor opens | No console errors; file tree still works (proves B2 #319 jQuery removal) |

UI runbook scope: skip (no UI behavior changed). If anything in #318-325 touched a UI surface unintentionally, fall back to smoke only.

**Rollback rule:** if mock or lint baseline is not 0, revert the offending action's PR; fix; re-run; do not start Phase 1.

### Phase 1 — Correctness + foundations (gate: GATE B + targeted browser tests)

**Goal:** every silently-misrouting bug fixed; foundation modules in place; no regressions.

| Check | Command / source | Pass criterion |
|---|---|---|
| Mock + live | full | 0 failures, 0 skips |
| Browser tests for fixed bugs | Playwright on M5 | Per-action acceptance for A1-A18, F7 — see issue bodies. Specifically: A1 (#326) project-path-with-`.~+` test, A2 (#327) drag rank-3 in B not appended, A4 (#329) picker resolves cross-org, A11 (#336) project remove cascade, A15 (#340) modal replaces prompt at each migrated site, F7 (#363) OAuth fixtures fire modal exactly once per CLI |
| K1 schema check (#360) | `sqlite3 .schema` snapshot before/after on M5 | Byte-identical |
| L1 catalog SSoT (#361) | `tools/list` JSON snapshot before/after | Deep-equal |
| D2 rate limit reset (#351) | 15 wrong passwords in 5s, then wait 60s, fire 1 more | First 5 of last 10 are 429; final attempt is 401 (not 429) |
| D6 PTY cleanup hook (#355) | spawn 3 sessions, SIGTERM Node | `ps -ef \| grep "tmux attach"` returns zero PTYs |
| Event-loop lag | A13 #338 perf check during 60s resolver polling on M5 | p95 < 50ms via `perf_hooks.monitorEventLoopDelay` |
| /api/state baseline | curl M5 `/api/state` 10 times | p95 capture as baseline for Phase 4 E1+E2 verification |
| Lint + warnings baseline | `npm run lint` post-N1a (#362) | 0 errors; **record warning count** as baseline for N1b (#373) |
| MCP tools count | stdio JSON-RPC `tools/list` against `/app/mcp-server.js` on M5 | Reports correct count derived from handlers map (proves L1 + O1 fix to the count assertion) |
| CLI parity | every test for Claude session creation must pass for Gemini + Codex | Per `feedback_test_all_clis.md` |

UI runbook scope: **Gate B** per PROC-004 (or its successor). Reasoning: Phase 1 touches handler logic, route paths, and UI modal patterns — Gate B's session/file/task/settings coverage is the appropriate scope.

**Manual smoke:** 10-minute hands-on by user on M5 — log in, open Claude/Gemini/Codex sessions, create a task, drag-reorder, edit a file, settings tab.

**Rollback rule:** any failure in browser-test-fixed-bugs section rolls back the offending action's PR. Mock/live failures gate Phase 2 entirely until cleared.

### Phase 2 — Structural foundations (gate: GATE A regression)

**Goal:** the four big decompositions begin without breaking any existing behavior. Foundation modules (F1-F3, G1-G2-G5 partial, H0+H1, J1, M1, E3) integrated.

| Check | Command / source | Pass criterion |
|---|---|---|
| Mock + live | full | 0 failures, 0 skips |
| Browser tests | full | 0 failures |
| **Gate A UI runbook** on M5 | `tests/workbench-test-runbook.md` per PROC-003 + PROC-004 Gate A scope | All scenarios pass; failures recorded with RCA before advancing |
| H0 transitional adapter (#366) | `grep -rn "require.*session-utils" src/` | Existing call sites still work via adapter; new H1-H5 imports also work |
| J1 streaming heap test (#367) | Mock: feed 9.9MB synthetic file to `syncFileToCollection` | Peak heap delta <50MB (was unbounded with full readFileSync) |
| /api/state still works | curl M5 `/api/state` after G1 lands | Returns valid response; sidebar render unchanged |
| E3 optimistic-poll (#369) | Browser: archive a session while forcing a `loadState` response mid-flight | UI does not flicker back-to-archived state and back |
| M5 startup time | restart M5; measure server.js startup duration | No regression vs Phase 1 baseline (M1 #368 + factory-DI conversions shouldn't slow startup) |
| Memory profile | `process.memoryUsage()` after 1hr idle on M5 | No leak vs Phase 1 baseline |
| WebSocket reconnect | drop+reconnect on M5 active terminal tab | Auto-respawn works; scrollback replays; no orphan PTY |

UI runbook scope: **Gate A** (full regression) per PROC-004. Phase 2's structural changes warrant the broadest scope.

**Manual smoke:** 30-minute hands-on by user — full feature exercise across all three CLIs.

**Rollback rule:** Gate A regressions roll back the offending decomposition child PR. The decomposition parents (F0, G0, H0, J1, M1, E3) cannot be marked done until all in-Phase-2 children land cleanly.

### Phase 3 — Structural completion (gate: GATE A regression + perf snapshot)

**Goal:** all decomposition children landed; codebase shape matches plan; no regressions.

| Check | Command / source | Pass criterion |
|---|---|---|
| Mock + live + browser | full | 0 failures, 0 skips |
| **Gate A UI runbook** | full | All scenarios pass |
| Frontend modular smoke | Network tab on M5: page load fires N module fetches | All 14 F-children load (or are bundled if a future build step lands); zero console errors |
| Inline-handler audit | `grep -rn 'onclick="' public/` | Counts must drop substantially vs Phase 0 baseline (per Claude §3.2 — inline handlers couple markup to function names) |
| File monoliths shrunk | `wc -l src/routes.js public/index.html src/session-utils.js src/watchers.js` | routes.js ~50, index.html <500 (mostly markup), session-utils.js becomes a factory thinly wrapping submodules, watchers.js becomes a factory thinly wrapping submodules |
| A18 switchTab (#343) | Browser: switch tabs 10x, screenshot diff | No visual jumping; switchTab duration <50ms p95 |
| A10 Gemini parser (#335) | Live: Gemini session writing .jsonl appears in qdrant point count | Verified via `/api/qdrant/status` |
| /api/state perf snapshot | M5 p95 over 100 calls | Capture for comparison to Phase 4 (E1+E2 will improve from this baseline) |
| MCP tools count | `tools/list` snapshot | Matches L1's deep-equal baseline plus any tools added by decompositions |

UI runbook scope: **Gate A** (full regression).

**Manual smoke:** 30-minute hands-on by user.

**Rollback rule:** any regression rolls back the specific child PR. Phase 3 cannot be marked complete until all decomposition trees (F0, G0, H0, I0) are fully populated and tested.

### Phase 4 — Performance + tooling (gate: GATE A + performance acceptance)

**Goal:** /api/state hits p95 <1s; lint at error tier; tests reflect product (task v2).

| Check | Command / source | Pass criterion |
|---|---|---|
| Mock + live + browser | full | 0 failures, 0 skips |
| **Gate A UI runbook** | full | All scenarios pass |
| /api/state perf | M5 p95 over 100 calls with 5 projects × 10 sessions | **<1s p95** (the E1 + E2 target) |
| Memory profile | 1hr idle + 1hr active on M5 | No leak vs Phase 3 baseline; no regression |
| Lint errors tier (#373) | `npm run lint` | **0 errors** (was warnings under N1a) |
| Lint scope public/** (#374) | `npm run lint` includes public/js/* | 0 errors |
| c8 thresholds (#375) | `npm run test:coverage` | Blocks at threshold matching test plan; STD-003 §2.6 satisfied |
| Task v2 test reconciliation | mock + live + browser task tests | All pass against current product (no .task-node, no folder_path posts) |
| Test plan + traceability matrix | manual review per STD-003 | Plan describes UI the user actually sees |

UI runbook scope: **Gate A** (full regression).

**Manual smoke:** 30-minute hands-on by user. Specifically time-the-sidebar load on a populated workspace.

**Rollback rule:** /api/state p95 ≥1s rolls back to E1+E2 — possibly trigger §3.2 deferral re-evaluation (push architecture). Lint errors blocking valid code rolls back the rule that's surfacing the false positive (or splits N1b into smaller tiers).

### Phase 5 — Documentation (gate: doc check)

**Goal:** README accurately reflects all Phase 0-4 changes.

| Check | Command / source | Pass criterion |
|---|---|---|
| Markdown lint | `prettier --check README.md` | 0 errors |
| Link check | manual or `markdown-link-check README.md` | All internal links resolve to actual paths/issues |
| Module list | `grep -rn '^\\* ' README.md` (architecture section) | Lists kb-watcher.js, git-auth.js; does not list voice.js |
| Config keys | cross-reference against `config/defaults.json` | Every key in defaults.json is described OR explicitly noted as internal-default |
| Removed references | grep README for `Issue_Log.md`, `WPR-104`, `ERQ-001`, `workbench_read_plan`, `workbench_update_plan`, `TMUX_CLEANUP_MINUTES`, `bridge.cleanupSentMs`, `bridge.cleanupUnsentMs` | Zero hits |
| Container privileges note | grep for "passwordless sudo" or "root-equivalent" | Hit (transparency for the deployment characteristic at Dockerfile L43) |
| Upgrading CLI versions subsection | grep for "Upgrading CLI versions" | Hit (paired with D4 #353) |
| STD-007 compliance | manual review per STD-007 | Satisfied |

UI runbook scope: skip (doc-only).

**Rollback rule:** doc inaccuracies amend in place; never close P1 (#379) until you can grep-verify every claim in README against source.

### Cross-phase rules

- **No issue close until phase gate passes.** Per saved memory `feedback_never_close_without_permission.md`, issues stay open until user says close. Phase gate is the prerequisite for asking.
- **Coverage gate is absolute** (memory `feedback_coverage_gate.md`): Live + UI are 100%, mock ≥85%. No feature ever goes untested. Don't round.
- **Test all CLIs** (memory `feedback_test_all_clis.md`): every Claude-targeting test must also run with Gemini + Codex.
- **UI tests are headless browser only** (memory `feedback_ui_tests_headless_only.md`): never substitute SSH / docker exec / curl as a UI test.
- **No silent workarounds** (memory `feedback_no_silent_workarounds.md`): if a tool fails during gate execution, file an issue immediately and fall through to the documented alternative — do not deprecate-tool fallback quietly.
- **Deploy rule** (memory `feedback_deploy_run001.md`): every gate runs against M5/dev, never irina/prod. Canonical RUN-001 sequence only.

### Phase gate run cost (single engineer)

| Phase | Gate effort |
|---|---|
| Phase 0 | ~2 hours (mock + lint + docker build verification) |
| Phase 1 | ~1 day (Gate B runbook + per-action browser tests + perf baseline) |
| Phase 2 | ~1.5 days (Gate A full regression + structural verification + memory profile) |
| Phase 3 | ~1.5 days (Gate A full regression + frontend modular smoke) |
| Phase 4 | ~1 day (Gate A + perf acceptance verification) |
| Phase 5 | ~2 hours (doc check) |
| **Total gate effort** | **~5-6 engineer-days across all phases** |

Add this to the §"Effort summary" total: ~9-12 weeks of execution work + ~5-6 days of phase-gate runs.

— end of execution summary

