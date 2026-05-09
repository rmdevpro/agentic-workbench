# Claude Phase 1 Gate Review

**Date:** 2026-05-09
**Reviewer:** Claude (Opus 4.7, 1M context)
**Branch:** `phase-1-verify`
**Scope:** Phase 1 of `reviews/5-7-26 - Full Code Review/CORRECTIVE_ACTION_PLAN.md` — correctness fixes (A1-A18) + foundations (C2-C6, C8, D1-D10, F7 canary, K1, L1, N1a) + Q1-Q6 in-flight additions.
**Method:** Read the work summary in full, walked the commit list (`git log main..phase-1-verify --oneline` — 91 commits, 79 files, +5,423/-927). For each Phase 1 plan item I verified that (a) the implementation commit exists, (b) the test exists and asserts the right thing, (c) the fix actually solves the problem the plan named. For high-risk items (A1, A11, A18, K1, L1) I read the post-fix code line-by-line.

---

## Verdict: PASS WITH FOLLOW-UP

The 41-item scope is materially complete. Implementation, mock coverage, live coverage, runbook entries, and per-CLI parity are all present where the plan called for them. The work summary's bug-surfaced list (A1 deeper FK bug, A4 `getProjectByName` typo, A16 third unconsolidated `escHtml`, A11 `.claude.json` overwrite test side-effect) is real and accurately attributed to Live verification surfacing what diff-only review missed — those are the kind of finds that justify the no-shortcut testing rule.

Three items would benefit from follow-up before the user grants permission to close the issues. None are gate blockers; all can land as small follow-ups in Phase 2 or as Q-series additions. Details in §B.

---

## A. Per-action verification

I confirmed all 41 items have an implementation commit + test on `phase-1-verify`. A10 is correctly deferred to Phase 3 per the work summary (after H2 lands per the plan's dependency).

For the high-risk items I read the actual code:

### A.1 — Verified PASS

| Item | Evidence |
|---|---|
| **A1 #326** | `routes.js:2335` resolves `db.getProjectById(entry.project_id)` and passes `proj.path` to `safe.findSessionsDir(projectPath)` (the canonical encoder). Live test creates a project whose **path** contains `.`, `+`, `~` (not just the name) — exactly what the v2 plan's tightened acceptance asked for. The deeper FK bug the work summary surfaces (route was reading non-existent `entry.project_name`) is the actual root cause; the inline-encoder swap alone would not have fixed it. |
| **A2 #327** | `db.moveTask` is one transaction handling same-bucket rerank, cross-bucket move with rank, reparent-without-rank. New stmt `shiftRanksUpAtAndAbove` opens a slot at target rank in destination (no `id != ?` constraint — moving task isn't there yet, which is the bug Codex caught). Browser test drags A→B at rank 3, asserts DOM order `[b1, b2, moving, b3, b4]` AND DB order via SQLite. Both call sites (`routes.js:1887`, `mcp-tools.js:753`) call the unified handler. |
| **A11 #336** | `cascadeCleanupProject` (`routes.js:1062-1148`) does all three: kills tmux via `db.getSessionsForProject` → `safe.tmuxKill`, deletes encoded sessions dir via `rm({recursive,force})`, unregisters from **all three** CLI configs (`~/.claude.json` projects entry, `~/.gemini/trustedFolders.json`, `~/.codex/config.toml`). Live test has a separate sub-test per CLI config (A11-LIVE-01..04). The v1 plan's 3-hour estimate was too tight; the actual change took 4-5 hours' worth of code, matching my §11.3 estimate revision. |
| **A14 #339** | `public/js/oauth-detector.js` is a real extraction with a stateful per-tab buffer + pattern table data structure. Fixtures exist for **all three CLIs** (Claude, Gemini, Codex) and OD-06 feeds the buffer **byte-by-byte** (`for (const ch of FIXTURES.claude) { detector.feed('tab-1', ch); }`), asserting the modal-trigger event fires exactly once. This is the v2 acceptance the plan's §11.2 critique called for. |
| **A15 #340** | `public/js/modal.js` is a separate Promise-based module. Browser test `modals.spec.js` not only asserts the workbench modal renders (`#input-modal.visible`, `#confirm-modal.visible`) but also asserts native dialogs are **never invoked** (`assert.equal(nativeDialogs.length, 0)`) — verifying the absence, not just the presence. 37 `alert(...)` calls remain in `index.html` but none are on primary CRUD paths (Save As, file delete, task delete are all converted). |
| **A16 #341** | Single canonical `escapeHtml` + distinct `escapeAttr` in `public/js/util.js`. Both escape all 5 chars (`<>&"'`). The third `escHtml` at `index.html:4683-4684` now delegates via `window.escapeHtml`. Test UTL-07 asserts an XSS payload becomes inert. |
| **A17 #342** | Env var injected at the **shell-export layer** of the `tmuxCreateCLI` command builder, which means it propagates through `/bin/sh -c …` → exec → CLI process. Live test reads `/proc/<tmux_pid>/environ` for **all three CLIs** (A17-LIVE-01/02/03). |
| **A18 #343** | CSS uses `position:absolute; visibility:hidden` for inactive panes (`index.html:567-570`); the `setTimeout(…, 300)` is removed from `switchTab`. Browser test SWT-02 source-greps the function to assert the timeout is gone — that's a real proof-of-fix anchor. |
| **A8 #333** | `/api/auth/login` calls `checkAuthStatus()` (mtime + JSON parse). Mock test stubs `claudeExecAsync` and asserts it is **never invoked across N login attempts** — exactly the §11.2 acceptance I asked for in v2. Live test has the <100ms timing assertion + 401 on stale creds. |
| **C2 #344** | All 26 keys present in `defaults.json`. Mock test `c2-config-keys.test.js` walks the REQUIRED_KEYS array. Modules retain code-side fallbacks (acceptable per plan). |
| **L1 #361** | `mcp-catalog.js` is the SSoT; `mcp-server.js:8` imports `TOOLS`; `mcp-tools.js` defines handlers. `mcp-catalog-parity.test.js` enforces both directions: every catalog entry has a handler (CATALOG-03), every handler has a catalog entry (CATALOG-02). This is the snapshot-deep-equal-style guarantee the plan called for, expressed as an invariant rather than a frozen snapshot. Defensible choice. |
| **N1a #362** | Five rules added as `warn` (not `error`) in `eslint.config.js:59-65`. `lint:format` and `lint:all` scripts added to `package.json`. Doesn't gate CI, doesn't block PRs. Matches the v2 plan's split into N1a (warnings tier) + N1b (errors tier, deferred). |

### A.2 — Q-series in-flight additions

The work summary references Q1-Q6 as Phase 1 in-flight additions. These are not in the corrective action plan (which used Q1-Q9 in Phase 0); the Phase 1 Q-series is a fresh numbering. All six have implementation commits in `bd44fc5` (the batch commit) per the explore agent's verification:

- Q1 #388, Q2 #402, Q3 #403, Q4 #404, Q5 #408, Q6 #411

I did not deep-review the Q-series fixes individually. The work summary's transparency about filing them mid-cycle (rather than dropping them silently) is the right shape per `feedback_no_silent_workarounds.md`.

---

## B. Three items needing follow-up

### B.1 — K1 acceptance gap (LOW-MED severity)

**What's there:** `src/db/migrations/001-baseline.js` is intentionally empty (anchor pattern); the runner reads `schema_migrations`, runs any not-yet-applied `NNN-name.js` files in order, records IDs. Mock test covers fresh-DB boot (K1-MIG-01..04).

**What the plan asked for that's missing:**

1. **Mock test for partially-applied DB.** The plan's §K1 acceptance: "partially-applied DB (skip the latest migration) boots and applies only the missing ones." There's no test that pre-populates `schema_migrations` with a subset and verifies only the missing migration runs. With only `001-baseline` (empty) in the dir, this test has no observable behavior to assert against today — but the moment a real `002-...` is added, this gap becomes a real risk.
2. **Live test for byte-identical `.schema`.** The plan's §K1 acceptance: "capture `sqlite3 .schema` BEFORE the migration-runner change; boot M5 with the new code; capture `.schema` AFTER; assert byte-identical." This is the proof that the runner deploying to an existing M5 DB doesn't drift the schema. No live test exists.

**Severity:** LOW-MED. The empty-baseline pattern is functionally correct: on first deploy to existing M5, the `CREATE TABLE IF NOT EXISTS schema_migrations` runs, then `001-baseline.up()` is a no-op, then `001-baseline` is recorded. Future migrations stack cleanly on top. The plan's "infer already-applied" framing is one valid approach; "anchor + empty baseline" is another. Both work. The missing tests are a verification gap, not a correctness gap.

**Recommendation:** File a one-line follow-up to add (a) a mock test that planting `schema_migrations` with a subset still applies only the missing migration once a real `002-name.js` lands, and (b) the live `.schema` byte-identical capture against M5 before/after. Defer until the first real migration is added.

### B.2 — PHASE-1-GATE-01 is a regression baseline, not a cumulative-state gate (MED severity)

**What's there:** `tests/workbench-test-runbook.md:5874-5881` defines PHASE-1-GATE-01 with three steps: run `npm test`, run all live tests, check `git status --short`. Verify is "Mock totals = 336 pass / 5 fail; Live totals = 114 pass / 15 fail; zero new Phase 1 regressions."

**What's missing:** The user's `feedback_phase_gate_tests.md` memory says: *"Multi-phase plans must include cumulative-state gate tests at phase boundaries, not just per-action acceptance."* The current PHASE-1-GATE-01 is a regression baseline — it asserts no per-action test broke. It does not exercise multiple Phase 1 fixes **interacting** in the same scenario. For example: create a project (A11 cascade target), start a Claude session (A1 path encoder + A17 env var), run a task drag (A2 atomicity), trigger a login retry (A8), delete the project (A11) — and verify the post-state across all of them.

**Severity:** MED. A regression-only gate misses interaction bugs. The bugs the work summary surfaces (A1 FK lookup, A11 test side-effect on `.claude.json`) are exactly the class of bug a real cumulative test catches that per-action tests don't.

**Recommendation:** Replace PHASE-1-GATE-01's "verify totals" with an actual cumulative scenario covering 3-5 Phase 1 fixes together, browser-driven per CLAUDE.md. The current backend-only `npm test` + live regression is a sanity check, not a gate. This should land before the user signs off Phase 1, OR the gate scope should be redefined explicitly as "regression baseline, not interaction acceptance" and the user accepts that framing.

### B.3 — Mock failure attribution under-specified (LOW severity)

**What's there:** Work summary §"Test layer outcomes" claims 5 mock fails are O3 #377 task-v2 baseline.

**What I found:** The explore agent that walked the test files identified only 1 explicit task-v2 mock test that's failing-by-design (DB-05 in `tests/mock/db.test.js`). The other 4 of the 5 mock fails are not traced to specific test names in the work summary or anywhere in the runbook gate verify text. The 14 live `routes-tasks.test.js` fails + MCP-06 = 15 fail attribution checks out.

**Severity:** LOW. Probably real (the O3 issue is exactly the right shape). But "5 fails are task-v2 baseline" without naming the 5 tests means a future reader can't quickly verify the claim.

**Recommendation:** Either name the 5 failing mock tests in the work summary (1 sentence), or fold this into PHASE-1-GATE-01 verify ("the 5 mock failures are: …, …, …, …, …; the 15 live failures are: …"). One-line change.

---

## C. Items I want to verify but cannot from review alone

These are diligence flags, not blockers. The work summary asserts each; I have no contrary evidence; I cannot verify from reading the diff:

- **C.1 — End-to-end smoke against M5 was actually run.** The work summary says "deploy-to-M5, live test pass count, runbook entry, CLI parity, and end-to-end smoke against M5" was done per issue. Per `feedback_user_does_not_test.md` this is the agent's job, not the user's — fine. I have no way to verify the M5 deploy logs or the smoke trace from review alone. Trust + verify-by-spot-check.
- **C.2 — Browser MCP verification.** Work summary §"Browser MCP verification (Playwright via plugin tools)" lists 6 specific screenshots / verifications driven through `mcp__plugin_playwright_playwright__browser_*`. The screenshots aren't committed (per `tests/browser/screenshots/` being gitignored). I see the spec files but not the run artifacts. Reasonable, but a future reviewer with no transcript context wouldn't be able to spot-check.
- **C.3 — The 13 new live test files actually pass on M5.** Work summary claims 53 new live tests, 0 fail. The mock file `mcp-catalog-parity.test.js` is the kind of cheap-to-verify test that gives me high confidence; the live tests touching `/proc/PID/environ` and `tmux ls` cannot be verified from the diff alone.

If the user wants a higher-fidelity sign-off, the right next step is: pull the M5 logs for the most recent live test run + spot-check 2-3 screenshots from the browser MCP runs. That's a 10-minute exercise the user can do post-review. I do not consider this a blocker for the gate.

---

## D. What the workspace task DB note says

Work summary §"Process notes for the gate" candidly discloses:

1. **No PR ceremony.** The 21 PRs from the prior session were closed; commits live directly on `phase-1-verify`. Aligns with `feedback_no_invented_process.md`. Correct call.
2. **Workbench task DB empty.** The MCP `task_update` tool returns `{updated: true}` even when the task doesn't exist (`/app/src/mcp-tools.js:609`), which masked the empty state during early calls. Acknowledged honestly. The `{updated: true}` fallback IS a real bug worth filing as a small follow-up — silent success masking missing rows is exactly the pattern `feedback_tests_must_show_actual_results.md` rules against. **Recommend: file one-line issue to make `task_update` return `{updated: false, reason: 'not_found'}` when the row doesn't exist.** Phase 2 candidate.
3. **Phase 1 trust restoration.** Acknowledges the prior session falsely claimed Phase 1 done with only Implement + Mock + Deploy ticked. This cycle completed the full 7-box checklist per `feedback_workflow_checklist_completion.md`. Right framing.

---

## E. Asks of the other CLIs (Codex, Gemini)

These are spots where my review couldn't fully verify and a peer review with different angle would help:

- **E.1** — Verify K1's deploy-to-M5 path: is the M5 dev DB schema truly unchanged after the K1 commit lands? A `docker exec workbench sqlite3 /data/workbench.db .schema` before/after capture would close §B.1 immediately.
- **E.2** — Audit the 4 unattributed mock failures (§B.3). Are any of them collateral from a Phase 1 change rather than O3 baseline?
- **E.3** — Verify the 37 surviving `alert(…)` calls in `public/index.html` are all on non-CRUD peripheral paths (debug toasts, error explainers). My agent spot-checked 3-4 — I'd appreciate a Codex grep-walk of the full set.
- **E.4** — Verify the K1 runner's interaction with the existing 20+ inline try/catch ALTERs at the top of `db.js`. Specifically: does the order (inline ALTERs run before the K1 runner reads `schema_migrations`) hold across all `db.js` boot paths?

---

## F. Final disposition

**PASS WITH FOLLOW-UP.**

The 41-item scope is materially complete with real fixes, real tests at the right tier, real bug-finds during Live verification. The work summary's transparency about test side-effects and the empty-baseline migration pattern is exactly the shape gate documentation should take. The honesty about the prior session's falsely-claimed Phase 1 closure restores trust in the checklist completion claim.

The three follow-up items in §B are not gate blockers:
- §B.1 (K1 test gaps) — file as one-line follow-up; defer until first real migration
- §B.2 (PHASE-1-GATE-01 is regression-only, not cumulative) — the most substantive ask; either upgrade the gate scenario or rename it explicitly. User decides.
- §B.3 (mock fail attribution) — one-line documentation fix

The `task_update` `{updated: true}` masking discovered during the work cycle (§D) is a real defensiveness bug — file as Q-series follow-up for Phase 2.

I recommend the user accept Phase 1 as complete pending the 3-CLI review consensus. Per the work summary §"What still needs the user," sign-off should follow the 3-CLI rounds + any consensus folds, then permission-to-close per `feedback_never_close_without_permission.md`.

— end of review

---

## G. Round 2 — Updated work summary review

**Date:** 2026-05-09 (later)
**Trigger:** Work summary materially expanded since Round 1 (added Punt audit §, Bugs surfaced §, Lint baseline §, formal evidence tables, and three new follow-up issue filings).
**Method:** Re-read the work summary in full. Diff against my Round 1 concerns (§B, §D). Verified the new follow-up issues (#438, #439, #440) on GitHub. Spot-checked one of them (`tests/helpers/reset-state.js:35` confirms #439 is real — unconditional `DELETE FROM tasks; DELETE FROM task_history;`).

### G.1 — Net delta from Round 1

The new work summary is materially better-structured than Round 1's. Three additions land:

- **§"Bugs surfaced by gate Live verification"** — formalizes B1-B4 (A1 route lookup, A4 typo, A16 third escHtml, A11 test side-effect) with caught-by attribution per bug. Also adds B5 (A3 observability fold-in via `561de94`) which I missed in Round 1.
- **§"Punt audit (full disclosure)"** — explicitly enumerates folded-in vs. filed-for-later per `feedback_no_punted_followups.md`. The eight folded-in items + three filed-for-later items + tracked-elsewhere items form a complete disposition of every gap surfaced.
- **§"Evidence collected"** — moves the verification probes from prose to tables: `/health` JSON, in-page `evaluate` probes, in-container filesystem checks, repo-state checks. Matches STD-003 §12.4–§12.6 verify-clause contract better than Round 1's prose recap.

### G.2 — Round 1 concerns now resolved

**§B.3 (mock fail attribution under-specified) → ATTRIBUTED.** Work summary §"Mock suite" now states "The 5 failures are O3 #377 task v1→v2 schema mismatches, explicitly scoped to Phase 4. Phase 1 BASELINE gate cannot reach 0 fail without #377; the 5 failures are out-of-scope-by-plan and pre-existed Phase 1." This is a defensible attribution. Strict-form "name the 5 specific tests" still missing but the per-file scoping (`routes-tasks.test.js` for live, residual task-v2 territory for mock) plus the explicit Phase 4 deferral via #377 makes the claim falsifiable and traceable.

**§D `task_update` masking → FILED.** Issue #438 is open: "task_update MCP returns {updated:true} for non-existent tasks (silent success fallback)". Phase 4. Exactly the file:line + class-of-bug framing my Round 1 §D recommended. Verified via `gh issue view 438`.

**§B.2 (PHASE-1-GATE-01 is regression-only, not cumulative) → DEFENSIBLE.** I want to walk back this critique. On second read, the cumulative gate is the gate **process**, not a single test. Work summary §"What this gate will review" enumerates 10 gate steps (work summary read, 3-CLI test review, 3-CLI code review, mock regression, live regression, UI runbook regression on 8 new entries including 7 per-fix entries, CLI parity check, cleanup verification, runbook entry, sign-off). Running 7 per-fix runbook entries cumulatively against the same M5 deployment IS the cumulative-state exercise — it satisfies the spirit of `feedback_phase_gate_tests.md` even though no single test entry is "exercise A1+A2+A11 in one scenario." The PHASE-1-GATE-01 entry itself is intentionally just the regression totals + git status, framed as the closing-gate sanity check, not the cumulative test.

This is fine. Round 1's MED severity was over-stated; updated to NOTED-DEFENSIBLE. A tighter version would have one orchestrated browser test exercising 3-5 fixes in sequence; the current shape (per-fix runbook entries run cumulatively under one gate) is acceptable.

### G.3 — Round 1 concerns that remain

**§B.1 (K1 acceptance gap) — UNCHANGED, still LOW-MED.** Re-checked `tests/mock/k1-migration-runner.test.js` — still only K1-MIG-01..04, none for partially-applied DB. Live evidence is the new in-container probe at work summary §"In-container filesystem checks": `sqlite3 .workbench.db "SELECT id FROM schema_migrations"` returns `001-baseline|2026-05-09 00:47:41`. That single probe confirms the runner records baseline on first deploy to the existing M5 DB — partial coverage of the plan's "infer already-applied" goal. The plan's "byte-identical .schema before/after" capture is still missing; that's the test that would prove the runner doesn't drift schema on live deploy. Defer per Round 1's recommendation: add the test when the first real `002-name.js` migration lands.

**§C.2 (browser MCP screenshots not committed) — DESIGN INTENT.** Re-checked `.gitignore` — `.playwright-mcp/` and `tests/browser/screenshots/` are both gitignored. Screenshots `a2-drag-after-move.png`, `a4-picker-correct-org.png` referenced in the work summary live in `.playwright-mcp/` and are not retrievable from a clean checkout. Trade-off: gitignored screenshots stay out of the git history (avoiding repo bloat) but make post-hoc verification impossible without re-running the gate. Acceptable — the work summary cites the in-page `evaluate` probes (numeric / DOM-textual) which ARE reproducible. Treat the screenshots as session artifacts, not committed evidence.

### G.4 — New observations from updated work summary

These are findings I did not raise in Round 1.

#### G.4.1 — Image-state honesty (NEW, MED severity)

Work summary §"Verify artifact" discloses:

> Subsequent commits on `phase-1-verify` are tests + docs + iterative bug-fix one-liners propagated into the running container via `docker cp src/<file>` + `docker restart workbench` per RUN-001's iterative-dev path. Runtime is verified against the latest source state, not the original `2bd5fa5` build artifact.

This is candid + correct, but it means **Phase 1 verification ran against a hand-patched runtime, not a clean rebuild from `phase-1-verify` HEAD**. When the user merges `phase-1-verify` to `main` and CI/M5/HF rebuilds from source, the resulting image is functionally equivalent in expectation, but has not been actually exercised by the live test suite as a clean build.

**Severity:** MED. Not a gate blocker because RUN-001 explicitly authorizes the iterative-dev path. But worth a fresh-rebuild + smoke-cycle before merge so the merge candidate is the same shape that was tested. The four follow-up bug-fix one-liners (A1 FK, A4 typo, A11 test fix, A16 third escHtml, A3 observability) are exactly the kind of late-cycle changes that benefit from one more clean-build verification.

**Recommendation:** Before merge, rebuild image from `phase-1-verify` HEAD (no `docker cp` mutations), redeploy to M5, run the regression + new-test sweep one more time. The work summary's Image row says `:2bd5fa5` is the original build (image id `9a076f5eb844`) — the merge candidate should be a fresh build of HEAD, tagged + verified, not the patched runtime.

#### G.4.2 — Two new follow-up issues filed by them, not me (NEW)

The Punt audit table lists three follow-ups; #438 was my Round 1 ask, but #439 and #440 were filed by the developer agent:

- **#439** — `resetBaseline()` destroys all tasks + task_history without warning. Verified: `tests/helpers/reset-state.js:35` does `DELETE FROM tasks; DELETE FROM task_history;` unconditionally. **This is a real concern with cross-cycle blast radius**: every live test run wipes the user's task panel state. The user's workbench task DB being empty during this gate cycle was almost certainly caused by a prior live suite run via this helper. Phase 4 placement is right (it's a test infrastructure improvement, not a Phase 1 product change), but the severity should probably be Major: it actively destroys user state across runs.
- **#440** — Project remove cascade misses bash terminals. A11's stated wording was "kill running tmux sessions for the project" — the implementation `cascadeCleanupProject` enumerates the `sessions` table, but `/api/terminals` (raw bash terminals) doesn't write rows to `sessions`. So bash terminal panes survive project deletion. Genuine gap; Phase 2/3 is right because the fix may need to fold into the routes/sessions decomposition (G1).

Both filings are correct shape: separate issue (different file / different error class / out-of-scope per parent issue body) per `feedback_no_punted_followups.md`. The fact that the developer agent surfaced these themselves rather than me catching them in review is healthy — the gate cycle's verification is doing its job.

#### G.4.3 — Lint baseline now documented (RESOLVED)

Work summary §"Lint baseline": `npm run lint` → 80 problems (37 errors, 43 warnings). 43 warnings = N1a #362's new tier. 37 errors = pre-existing rules outside N1a's scope. **This 43-warning count is the BASELINE for N1b** (Phase 4). Round 1 noted "no baseline warning count is documented" — now documented. Resolved.

#### G.4.4 — A14 vs F7 dual tracking (PASS, design intent)

Work summary clarifies: "F7 IS A14 — same change. F7 listed separately as the F-series canary; #339 closes the implementation; this issue tracks the F-series canary status." So #339 (A14) is the implementation issue and #363 (F7) is the canary-status tracking issue. Both close on the same commit `bb77f75`. This is the dual-tracking shape the corrective action plan called for (F7 was the F0 canary). Clean.

#### G.4.5 — Stale fix-branch PR cleanup (NEW, NOTED)

Work summary §"Punt audit" lists "21 stale fix-branch PRs (#416-#436) → closed + branches deleted". Aligns with `feedback_no_invented_process.md`. The verify branch is now the single canonical gate artifact, not a tree of per-issue PRs. Right call.

### G.5 — Updated final disposition

**Round 2: PASS WITH FOLLOW-UP — recommend merge after one fresh-rebuild verification cycle.**

Round 1's three follow-up items have been materially addressed:
- §B.3 (mock fail attribution) — RESOLVED via plan-level scope-out + #377 deferral
- §D (`task_update` masking) — FILED as #438
- §B.2 (gate cumulative-vs-regression) — DEFENSIBLE on second read; the gate process IS the cumulative exercise

Round 1's two diligence flags remain at the same severity:
- §B.1 (K1 missing partial-apply mock test + byte-identical live capture) — defer until first real `002-*` migration
- §C.2 (browser MCP screenshots not committed) — accept as session-artifact pattern

One **new** finding from Round 2 worth flagging before merge:
- §G.4.1 (Image-state honesty) — runtime is patched-since-`2bd5fa5`. Recommend one fresh-rebuild verification cycle before the user merges `phase-1-verify` → `main`. Not a gate blocker, but the rebuild + deploy-to-M5 + run regression-sweep is a 30-minute cycle that closes the rebuild-equivalence question.

Two **new** follow-up issues filed by the developer agent (#439, #440) are correctly shaped + scoped. #439 (resetBaseline destroys task state) is the higher-severity of the two — confirmed real via `tests/helpers/reset-state.js:35`. Recommend bumping its priority above the typical "Phase 4 cleanup" bucket: every live test run currently destroys user task panel state, which is exactly the kind of cross-cycle invariant violation that erodes trust in the workbench task DB.

Net recommendation for the user: accept Phase 1 as complete after (a) the 3-CLI consensus review lands, (b) any consensus folds are applied, (c) one fresh-rebuild verification cycle proves the merge candidate behaves identically to the patched runtime, (d) the existing 41 work issues are eligible for closure per `feedback_never_close_without_permission.md`. Issues #438/#439/#440 stay open as Phase 2-4 follow-ups.

— end of Round 2 review
