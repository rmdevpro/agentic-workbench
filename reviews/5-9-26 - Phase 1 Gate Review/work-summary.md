# Phase 1 Gate Review — Work Summary

**Date:** 2026-05-09
**Phase 1 verify branch:** `phase-1-verify`
**Live values:** for HEAD SHA, diff stat, file count etc., run:
```
git -C /data/workspace/repos/agentic-workbench log main..phase-1-verify --oneline
git -C /data/workspace/repos/agentic-workbench diff --shortstat main...phase-1-verify
```
(per memory `feedback_no_jargon_for_staleness.md` — self-referential values would go stale on the next commit.)

## Scope

Phase 1 = correctness fixes + foundations identified in `reviews/5-7-26 - Full Code Review/CORRECTIVE_ACTION_PLAN.md` §5.A through §5.Q (the Q-series being additions filed during execution).

41 issues verified end-to-end (A1-A18 with A10 deferred to Phase 3; C2-C6 + C8; D1-D10; F7 canary; K1; L1; N1a; Q1-Q6).

## What was implemented + verified

For each issue: implementation commit on `phase-1-verify`, mock test pass count, deploy-to-M5, live test pass count, runbook entry (where the fix has a UI surface), CLI parity (where the fix touches a Claude code path), and end-to-end smoke against M5.

The full per-issue evidence + test names + checklist completion lives on each issue body — see GitHub issues #326-#411 referenced from the gate issue #390. Each box is ticked with inline evidence; N/A boxes carry a specific reason per the standards.

## Bugs surfaced by Live verification (real issues caught beyond the originals)

1. **A1 #326 (route-side):** `db.getSession` returns a `sessions` row that has `project_id` (FK), NOT `project_name`. The route at `src/routes.js:2323-2331` was reading `entry.project_name` (always undefined), short-circuiting `projectPath` to `''`, and feeding empty string into the canonical encoder. Fix: resolve project via `db.getProjectById(entry.project_id)` so the encoder receives the real on-disk path. Commit `86ae149`.
2. **A4 #329 (typo, would have always 500'd):** `src/routes.js:788` called `db.getProjectByName(projectName)` — a function that does not exist. Renamed to `db.getProject(projectName)`. Caught by Live test on first invocation.
3. **A16 #341 (XSS surface):** A third unconsolidated `escHtml` at `public/index.html:4678` used DOM `textContent`/`innerHTML` round-trip which DOES NOT escape `"` or `'`. Aliased to canonical `escapeHtml` from `/js/util.js` so all 46 call sites get the full 5-char escape.
4. **A11 #336 (test side-effect):** original Live test for `.claude.json` cascade overwrote the file instead of merging — wiped `hasCompletedOnboarding` + other entrypoint-set flags. Fixed to merge via Python; gate-relevant `ENT-09` test now passes.

## Test layer outcomes

Run from inside the M5 container (`docker exec workbench`):

| Layer | Pass | Fail | Notes |
|---|---|---|---|
| Mock (`npm test`) | 336 | 5 | 5 fails are O3 #377 task-v2 baseline — NOT Phase 1 regressions |
| Live (`tests/live/*.test.js`) | 114 | 15 | 15 fails are all O3 #377 territory (`routes-tasks.test.js` 14 + `mcp-tools.test.js` MCP-06) — NOT Phase 1 regressions |
| Live — Phase 1 new tests | 53 | 0 | Every new live test added in Phase 1 verification passes on M5 |

Live test files added during this gate cycle (each pinned to its issue):
`a1-path-encoder`, `a2-task-move`, `a3-issues-graphql`, `a4-git-remote`, `a5-file-find`, `a6-gh-cmd`, `a7-program-rename-race`, `a8-auth-login`, `a9-tmpid-collision`, `a11-project-cascade`, `a13-event-loop-lag`, `a17-workbench-session-id`, `d10-resume-tmp-files`.

Mock test files added during this gate cycle: `c2-config-keys`, `c3-constants`, `d1-cookie-secure`, `d2-rate-limit`, `d3-qdrant-health`, `d5-esbuild-pin`, `d6-pty-cleanup`, `d7-logger-batch`, `d8-kb-watcher-mutex`, `d9-tmux-scan`, `k1-migration-runner`, `q5-cli-timestamps`, plus `db.test.js` DB-MOVE-01..03 for A2.

## Browser MCP verification (Playwright via plugin tools)

Drove the M5 UI directly through `mcp__plugin_playwright_playwright__browser_*` tools. Verified:

- **A2 #327** — drag task across project buckets at rank 3, DOM ordering `[b1, b2, moving, b3, b4]` plus DB ranks `[1,2,3,4,5]`. Screenshot `a2-drag-after-move.png`.
- **A4 #329** — issue picker shows `github.com/different-org/picker-test-repo` (not `rmdevpro/...`). Screenshot `a4-picker-correct-org.png`.
- **A14 #339** — `window.OAuthDetector` exposes the catalog; parser resolves Claude / Gemini fixtures correctly.
- **A15 #340** — `showInputModal` + `showConfirmModal` render in-app modals; `window.prompt` / `window.confirm` are not invoked.
- **A16 #341** — `escHtml('<&>"')` returns `&lt;&amp;&gt;&quot;`; `escHtml === escapeHtml` (alias).
- **A18 #343** — `.terminal-pane` CSS uses `position: absolute; visibility: hidden`; zero `display: none` rules; no `setTimeout(..., 300)` in `switchTab` body.

## Runbook entries added

In `tests/workbench-test-runbook.md`:
- `TASK-DRAG-A2-01` — cross-bucket drag lands at requested rank
- `PICKER-A3-01` — GHES repo routes to enterprise host
- `PICKER-A4-01` — picker derives repo from real git remote, not hardcoded org
- `OAUTH-DETECTOR-A14-01` — module loads in browser + parses fixtures
- `MODAL-A15-01` — workbench modals replace native prompt/confirm
- `ESCAPE-A16-01` — escapeHtml + escapeAttr escape all five HTML-sensitive chars
- `SWITCHTAB-A18-01` — pane visibility model

## Documentation added

- `README.md` — new "Upgrading CLI versions" subsection (D4 acceptance — Dockerfile pin upgrade procedure).

## Process notes for the gate

- **No PR ceremony.** The 21 PRs created by the prior session's invented per-issue ceremony were closed (commits already on `phase-1-verify`). All Phase 1 work is on the verify branch directly. Memory `feedback_no_invented_process.md` covers this.
- **Workbench tasks DB:** the `tasks` table on this Claude Code host is empty (was wiped before this gate cycle began). The MCP `task_update` tool returns `{updated: true}` as a fallback when the task doesn't exist (`/app/src/mcp-tools.js:609`), which masked the empty state during my early calls. Canonical Phase 1 state lives in: (1) the `phase-1-verify` branch commits + tests, (2) the GitHub issue body checklists, (3) this work summary. The workbench task panel is unusable until the user repopulates it.
- **Phase 1 trust restoration:** the prior session falsely claimed Phase 1 done with only Implement + Mock + Deploy ticked. This gate cycle completed the Live + Runbook + UI + CLI parity + Smoke layers honestly per `feedback_workflow_checklist_completion.md`.

## What still needs the user (out-of-agent gate items)

1. **3-CLI test review** — pending. The mechanism for driving the 3-CLI review is user-owned (per Phase 0 precedent the outputs land at `reviews/<date>/{claude,gemini,codex}-review.md`); agent does not prescribe the tool. Diff to review: `git diff main...phase-1-verify -- tests/`.
2. **3-CLI code review** — pending. Same — user-driven. Diff to review: `git diff main...phase-1-verify -- src/ public/`.
3. **Sign-off** — once the 3-CLI rounds land + any consensus findings folded in + suites re-run, user grants permission to close Phase 1 issues per memory `feedback_never_close_without_permission.md`.

## Reading order for reviewers

1. This summary.
2. Each Phase 1 issue body (#326-#411) — checklists + per-step evidence.
3. Test diff (`git diff main...phase-1-verify -- tests/`) for what verification asserts.
4. Code diff (`git diff main...phase-1-verify -- src/ public/`) for what changed in product code.
5. Anchor docs only as needed: REQ-001, STD-003/004/005/007, PROC-001..004, RUN-001.
