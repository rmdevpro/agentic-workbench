# Phase 0 — Work Summary (Gate #389 brief)

**Date:** 2026-05-08
**Phase:** Phase 0 — Stabilize the model (cleanup hygiene, build hygiene, dev tooling, mock test stabilisation)
**Gate issue:** #389
**Verify branch:** `phase-0-verify` (run `git rev-parse --short phase-0-verify` for current HEAD; `git log main..phase-0-verify --oneline` for the full commit chain). Branch contents: 12 original Phase 0 PR-merge commits (B1-B4, C1, C7, N4, O1) + 1 fold-back PR-merge commit (Q7 #409 from gate-review consensus) + Q8 #412 + Q9 #413 in-place commits + Work-Summary maintenance commits. Q8 + Q9 are in-place commits with retroactive issues filed; doc-maintenance commits don't change the runtime image. The last commit that changed source code shipped to the container is `97edeaa`.
**Deployed image:** `irina:5000/workbench:97edeaa` = `:latest` (sha256:91e1913a…fde7f0). Image build digest pinned to `97edeaa` since `9841c5b` is doc-only and doesn't change the container.
**Deploy target:** M5/dev via RUN-001
**Diff vs main:** run `git diff --shortstat main..phase-0-verify` for current numbers. The largest deletions: −6667 line block from the dead `public/spike/issues.json` deletion. The largest insertions: ~+4886 line block from the `reviews/` audit-trail commit per Q6 #401 + the 3-CLI review docs committed per `97edeaa` + Work Summary disposition updates.

---

## Goal of the phase

Foundational hygiene work that unblocks subsequent phases:

- Delete dead code (voice subsystem, jQuery + jqueryfiletree, prime-test-session script, public/spike/, dead aggregator scripts, dead briefings)
- Remove stale `.dockerignore` patterns + add overrides so local docker builds ship the right assets
- Archive transient test artifacts; reconcile fixture documentation with reality; commit `reviews/` audit trail
- Fix the ESLint test-globals scope so browser specs lint cleanly; add Node-builtin globals (AbortSignal); add module override for ES-module entry point
- Stabilise the mock test fixture so the suite is truthful

Source: `CORRECTIVE_ACTION_PLAN.md` §5 (B1, B2, B3, B4, C1, C7, N4, O1) + 10 Q-series additions surfaced during Phase 0 verification + 2-round gate review (Q1–Q10).

---

## Issues + commits + branches

**18 issues, 13 PRs, 13 PR-merge commits, all stacked clean onto `phase-0-verify`** (2 issues are untracked-file rms with no PR; 3 issues — Q8 #412, Q9 #413, Q10 #414 — are in-place commits with retroactive / fold-back issues filed for audit-trail traceability).

| # | PR | Branch | Commit | Change |
|---|---|---|---|---|
| 318 [B1] | #383 | `cleanup/318-voice-delete` | `d84db15` | Delete `src/voice.js` + `tests/mock/voice.test.js` + 3 list entries in `tests/mock/server.test.js` + tombstone comment in `src/server.js` |
| 319 [B2] | #385 | `cleanup/319-jquery-delete` | `669ddcc` | Drop `jquery` + `jqueryfiletree` from `package.json`; remove 2 `app.use('/lib/jquery…')` static-asset routes from `src/server.js`; remove `<script src="/lib/jquery/jquery.min.js">` and dead `jqueryFileTree` CSS rule from `public/index.html`; clean up `src/routes.js` historical comment |
| 320 [B3] | #380 | `cleanup/320-prime-test-session` | `1680096` | Delete `scripts/prime-test-session.js` + the lone meta-test in `tests/live/context-stress.test.js` referencing it; remove unused imports |
| 321 [B4] | #381 | `cleanup/321-dockerignore-stale` | `214fef8` | Remove 3 stale `.dockerignore` patterns (`CLAUDE_PENANCE.txt`, `compaction-*.md`, `smart-compaction-*.md`) referencing nonexistent files |
| 322 [C1] | #382 | `cleanup/322-dockerignore-pngtxt` | `753ab44` | Add `!public/*.png` and `!tests/fixtures/*.txt` overrides in `.dockerignore` (HF unaffected — uses `git archive`) |
| 323 [C7] | #387 | `cleanup/323-test-artifacts-fixtures` | `75841c4` | `git mv` 7 transient test result artifacts into `tests/results-archive/`; add `runbook-results-*.md`, `coverage-results-*.txt`, `gate-c-*results*.md` wildcards to `.gitignore`; reconcile `tests/workbench-test-plan-ui.md` §3.3 fixture list with reality |
| 324 [N4] | #384 | `cleanup/324-eslint-test-globals` | `b4062cf` | Extend `eslint.config.js` `tests/browser/**/*.js` globals block with `MouseEvent` + 8 frontend functions (`openFileTab`, `tabs`, `switchPanel`, `switchSettingsTab`, `setTaskFilter`, `loadTaskTree`, `expandedTaskFolders`, `openProjectConfig`) |
| 325 [O1] | #386 | `fix/325-mock-failures` | `42bac7f` | Add 8 program-domain methods to mock db (`getAllPrograms`/`getProgram`/etc.); rewrite MCP catalogue tests to derive count from `TOOL_NAMES.length` + `KNOWN_DOMAINS` allow-list (`file/session/project/task/log/gh`); 3 drift fixes folded in (ENG-12 sync→async writeFile, SAF-12 tmuxCreateBash 5-call shape, SES-22 project-create payload) |
| 395 [Q1] | #396 | `cleanup/Q1-abortsignal-eslint-global` | `ff2e024` | Add `AbortSignal: 'readonly'` to main globals block of `eslint.config.js` (residual from N4) |
| 397 [Q2] | #405 | `cleanup/Q2-codemirror-eslint-module` | `ef7daab` | Add eslint override block for `scripts/codemirror-entry.js` with `sourceType: 'module'` (ES-module entry point that was failing to parse) |
| 398 [Q3] | — | — | — | rm untracked `assemble.js` (orphaned `REVIEW_PART_*.md` aggregator). No PR — file was never in git |
| 399 [Q4] | #406 | `cleanup/Q4-delete-public-spike` | `ec50fe0` | `git rm -r public/spike/` — 2 files, 6667 line deletions; zero consumers; saves 145KB in image |
| 400 [Q5] | — | — | — | rm untracked `tests/executor-briefing-2026-05-03-baseline.md`. No PR — file was never in git |
| 401 [Q6] | #407 | `cleanup/Q6-reviews-commit-normalize` | `0bc000c` | git add `reviews/` (7 files: 6 review docs from initial 3-CLI code review + Phase 0 Gate Work Summary); rename `5-7-26  - Full Code Review/` (two spaces) → `5-7-26 - Full Code Review/` (one space) |
| 409 [Q7] | #410 | `cleanup/Q7-staleref-sweep` | `37eab54` | Sweep stale jQuery + prime-test-session refs in tests/plans/runbook (Phase 0 gate-review fold-back; Claude B-F2 + Codex Major+Moderate consensus). 5 files: `tests/live/startup.test.js` SRV-02 → asserts xterm + codemirror serve, jquery 404; `tests/browser/file-browser.spec.js` → uses `GET /api/browse?path=/`; plan + runbook entries REMOVED-marked with phase-0 cleanup pointers |
| 412 [Q8] | — | — | `a15a58d` | In-place commit on phase-0-verify (no PR — single-file inline comment). Add note for future test authors next to the program-method block in `tests/mock/routes.test.js` pointing at `makeApp(overrides)` mechanism with concrete example. From Claude gate review §A.1 single-CLI caveat. Issue filed retroactively as audit-trail anchor. |
| 413 [Q9] | — | — | `9841c5b` | In-place commit on phase-0-verify (no PR — repo-side audit doc, not in build context). Replace 4 instances of "Manual smoke: hands-on by user" in `REMEDIATION_EXECUTION_SUMMARY.md` with "End-to-end smoke (agent-driven)" framing. User-flagged misframing during gate cycle. Memory `feedback_user_does_not_test.md` saved. Issue filed retroactively as audit-trail anchor. |
| 414 [Q10] | — | — | `42e9faf` | In-place commit on phase-0-verify (no PR — single-line architecture-statement fix in README.md:148). Replace "the jqueryfiletree connector" with description of vanilla `createFileTree` + `/api/browse` + `/api/file` architecture. From Codex Round 2 review (Moderate). Same fold-back pattern as Q7. |

`phase-0-verify` is composed of: 12 original Phase 0 merge commits + Q7 #409 fold-back merge + Q8 #412 + Q9 #413 in-place commits + Work-Summary + review-docs maintenance commits. No conflicts on any merge. Run `git log main..phase-0-verify --oneline` for the full live commit chain.

---

## Verify artifact

- **Branch:** `phase-0-verify` — pushed to origin (run `git rev-parse --short phase-0-verify` for current HEAD)
- **Image:** `irina:5000/workbench:97edeaa`, retagged `:latest` — last deploy point. Subsequent commits on `phase-0-verify` are doc-only / inline-comment changes that don't change the runtime image (`97edeaa` is the last commit that changed source code shipped to the container).
  - SHA256: `sha256:91e1913a34cbb808ac13422c97e865820ea63ff0b548f2a39a950cc8fefde7f0`
  - Image build layer: `9586d4a41db0`
  - Earlier deploy points (preserved in registry for rollback): `010ebf0` (sha256:5aaf94d0…) initial 12-PR stack; `99c9a13` (sha256:391d2a0d…) post-Q1 AbortSignal
- **Container:** `workbench` on M5 (192.168.1.120:7860), recreated 2026-05-08T19:30Z (UTC, last redeploy after 97edeaa), `/health` returns `{status:"ok"}`
- **Compose:** unchanged from prior deploys (override at `/srv/.admin/workbench/docker-compose.override.yml` is host-config-only)

---

## Evidence collected

### Mock suite (in deployed container)

`docker exec workbench sh -c "cd /app && npm test"` → **257 pass / 5 fail**

The 5 failures:

| # | Test |
|---|---|
| not ok 25 | `DB-05: task CRUD lifecycle` |
| not ok 75 | `TSK-07: created_by field persists` |
| not ok 86 | `task CRUD success paths with DB verification` |
| not ok 157 | `TSK-08: GET /api/tasks/tree returns tree object` |
| not ok 158 | `TSK-09: GET /api/tasks/tree accepts filter query param` |

All 5 are task v1→v2 schema mismatches and explicitly scoped to **O3 #377** (Phase 4). Phase 0 BASELINE gate cannot reach 0 fail without #377; the 5 failures are out-of-scope-by-plan.

### Lint (one-off `node:24` sandbox against verify-branch source on M5)

`docker run --rm -v /tmp/agentic-workbench:/work -w /work node:24 sh -c "npm install && npm run lint"` → **21 errors total**

Breakdown:
- 21 × `no-unused-vars` (scope of N1a #362 + N1b #373, future phases)
- 0 × `no-undef` test-globals (was 40, all cleared by N4 #324)
- 0 × `no-undef` `AbortSignal` (was 1, cleared by Q1 #395)
- 0 × Parsing errors (was 1, cleared by Q2 #397)

Original baseline before any Phase 0 work: 63 errors. After Phase 0: 21.

### HTTP probes against M5 deployment

| URL | Expected | Got |
|---|---|---|
| `GET /` | 200 | 200 |
| `GET /health` | 200 + status:ok | 200 `{status:"ok"}` |
| `GET /planlogo.png` | 200 | 200 |
| `GET /workbench-preview.png` | 200 | 200 |
| `GET /logo-dark.png` | 200 | 200 |
| `GET /dev-light.png` | 200 | 200 |
| `GET /lib/jquery/jquery.min.js` | 404 | 404 |

### In-page evaluate against M5 (Playwright)

```
typeof window.jQuery       → "undefined"
typeof window.$            → "undefined"
document.querySelectorAll('script[src*="jquery"]').length  → 0
typeof createFileTree      → "function"
```

### UI affirmations against M5 (per STD-003 §12.4–§12.6 and `tests/workbench-test-plan-ui.md` §3.4b)

**Landing page** (screenshot `.playwright-mcp/phase-0-verify-m5-landing.png`):
- Page title: "Workbench"
- Sidebar populated, empty state visible, settings hidden, filter default "active"
- Sidebar header logo `<img src="…dev-dark.png" naturalWidth=870 complete=true>` — green Dev-variant logo rendered

**Add Project picker** (screenshot `.playwright-mcp/phase-0-verify-m5-add-project-picker.png`):
- Modal heading: "Add Project"
- `#jqft-tree` element with class `ft-tree` (vanilla, NOT `jqueryFileTree`)
- 3 mounts: `/data/workspace/`, "Knowledge Base", `/mnt/storage`
- `/data/workspace` expanded shows 16 sub-directories
- "+ Folder" + path input + name input + Add button all visible

### In-container filesystem checks (`docker exec workbench …`)

| Path | Expected | Result |
|---|---|---|
| `/app/src/voice.js` | absent | absent ✓ |
| `/app/scripts/prime-test-session.js` | absent | absent ✓ |
| `/app/public/spike/` | absent (Q4) | absent ✓ |
| `/app/public/dev-dark.png` | present (8 PNG variants) | present (122656 bytes) ✓ |
| `/app/public/planlogo.png` | present | present (308191 bytes) ✓ |
| `/app/tests/fixtures/stub-claude.sh` | present | present ✓ |
| `/app/tests/fixtures/test-data.js` | present | present ✓ |
| `/app/tests/fixtures/trigger-uncaught.js` | present | present ✓ |
| `grep -rEn "voice\|Voice" /app/src` | 0 hits | 0 hits ✓ |
| `grep -rEn "jquery" /app/src /app/public/index.html` | 0 hits | 0 hits ✓ |

### Repo-state checks

| Path | Expected | Result |
|---|---|---|
| `assemble.js` (working tree) | absent (Q3) | absent ✓ |
| `tests/executor-briefing-2026-05-03-baseline.md` (working tree) | absent (Q5) | absent ✓ |
| `git ls-files reviews/` | ≥ 7 files (Q6 added 7; 3-CLI review docs added later via `97edeaa`) | 10 files ✓ |
| `ls reviews/` folder spacing | normalized (one space) | both folders use single-space pattern ✓ |
| `eslint.config.js` Q2 override block | present | present (`files: ['scripts/codemirror-entry.js']` with `sourceType: 'module'`) ✓ |
| `eslint.config.js` Q1 AbortSignal global | present | present (line 27 — main globals block) ✓ |

### Per-issue checklist status

All 18 issue bodies (#318, #319, #320, #321, #322, #323, #324, #325, #395, #397, #398, #399, #400, #401, #409, #412, #413, #414) have their workflow checklists ticked with concrete inline evidence per item. Items not applicable to a given issue are explicitly marked `[N/A]: <reason>`. (Q8 #412, Q9 #413, Q10 #414 are retroactive / fold-back issues anchored to in-place commits; their workflow checklists are minimal because the work was already complete when the issue was filed.)

#322 (C1) note: the original acceptance criterion `tests/fixtures/ansi-auth-url.txt is present in the container` was split into two — "the .dockerignore override is in effect" (✓, ticked) and "the fixture is captured" (UNTICKED, blocked on F7 #363 per C7 #323's plan §3.3 reconciliation). #322's standalone work is fully verified; the fixture itself is F7 scope.

Workbench tasks #334–#341, #403, #404–#408 are status `done`. Phase 0 Gate task (#342) is still `todo` until this gate completes.

---

## Punt audit (full disclosure)

Per memory `feedback_no_punted_followups.md`, every "deferred" / "follow-up" / "out of scope" residual surfaced during Phase 0 verification was audited.

**Folded into Phase 0 (rationally doable here):**
- AbortSignal `no-undef` (one-line eslint global) → Q1 #395 ✓
- codemirror-entry.js parsing error (one-line eslint module override) → Q2 #397 ✓
- Dead `assemble.js` orphan → Q3 #398 ✓
- Dead `public/spike/` directory → Q4 #399 ✓
- Dead `tests/executor-briefing-…` → Q5 #400 ✓
- Untracked `reviews/` audit trail → Q6 #401 ✓
- Stale jQuery + prime-test-session refs (gate-review consensus fold-back) → Q7 #409 ✓
- Mock test fixture future-author note (gate-review §A.1) → Q8 #412 ✓
- Smoke framing in REMEDIATION_EXECUTION_SUMMARY.md (user-flagged in gate cycle) → Q9 #413 ✓
- README.md filesystem-access architecture statement (Codex Round 2 review) → Q10 #414 ✓

**Cannot rationally be done in Phase 0 (filed + deferred to Phase 1):**

| # | Issue | Why not Phase 0 |
|---|---|---|
| 402 | UI bug: showErrorBanner insertBefore NotFoundError every 60s | Real production bug. Per PROC-001, every bug requires a 3-CLI RCA before any fix. RCA + 3-CLI consult + fix + verify ≈ 1-2 hours. Phase 0 is foundational hygiene cleanup, not bug-fix track. → Phase 1 [Q2] |
| 403 | UI: Password fields not in form (Chrome DOM warnings) | 5x verbose-level Chrome warnings. Need investigation: are inputs benign or breaking autofill? Likely Settings modal API key fields. ~30-60 min investigation; outside Phase 0 cleanup scope. → Phase 1 [Q3] |
| 404 | `#jqft-tree` element ID rename (vestigial jQuery prefix) | Touches DOM ID + CSS + tests/browser/* selectors + 8+ runbook entries + UI plan UI-E135. Multi-file synchronized rename, 1-2 hours. PR #385 (#319) deliberately scoped this out to avoid breaking selectors during the deletion PR. → Phase 1 [Q4] |

**Tracked elsewhere by original plan (legitimate phase splits):**

| Item | Tracked | Phase |
|---|---|---|
| 5 task v1→v2 mock failures | O3 #377 | Phase 4 |
| 22 `no-unused-vars` lint errors | N1a #362 + N1b #373 | Phase 1 + Phase 4 |
| `ansi-auth-url.txt` + `chunked-auth-frames.bin` fixture capture | F7 #363 | Phase 1 |

---

## Gate review findings + dispositions

3-CLI gate review ran at `phase-0-verify` @ `afd5215`. Three reviews under `reviews/5-8-26 - Phase 0 Gate Review/{claude,codex,gemini}-review.md`. Results dispositioned per PROC-002 §Step 5 (≥2-CLI consensus → fold back; single-CLI flags → noted, accept-as-documented unless obviously a real bug).

### Round 1 recommendations (initial review pass)

| CLI | Recommendation |
|---|---|
| Claude (Sonnet 4.6) | PASS WITH FOLLOW-UP (B-F2 stale jQuery refs flagged as gate-affecting) |
| Codex | DO NOT SIGN OFF YET (Major: live + browser tests will FAIL; Moderate: plan refs) |
| Gemini | APPROVED |

### Round 2 recommendations (post-fold-back verification pass — all 3 CLIs re-read after fixes landed)

| CLI | Recommendation | Notes |
|---|---|---|
| Claude (Sonnet 4.6) §F | PASS — recommend merge | Walked every fold-back commit; verified each. Cross-review consensus map included. Sub-threshold surviving refs noted but explicitly "below the threshold for a Phase 0 fold-back" |
| Codex | Sign off after one more line — `README.md:148` still references "the jqueryfiletree connector" as part of the active filesystem-access architecture statement | Q10 #414 filed + folded in commit `42e9faf` |
| Gemini addendum | APPROVED | Confirmed all consensus + single-CLI findings cleanly resolved. Final sign-off remains approved. |

### Consensus findings (≥2-CLI → folded back into verify branch)

| Finding | Reviewers | Action | Status |
|---|---|---|---|
| Stale jQuery + jqueryfiletree refs in active tests + plans + runbook | Claude (B-F2) + Codex (Major + Moderate) | Q7 #409 / PR #410 / commit `37eab54`: rewrote SRV-02 to assert codemirror + xterm + jquery 404; rewrote file-browser.spec to use `GET /api/browse?path=/` with JSON shape assertion; marked plan + runbook entries REMOVED with phase-0 cleanup pointers | ✓ Folded |
| Stale `prime-test-session.js` refs in test plans (UTIL-01/02, WAT-13, §3.3, §3.7) | Codex (Moderate) | Same Q7 PR — REMOVED-marked all references with #320 pointer | ✓ Folded |
| Diff-stat in Work Summary inaccurate (`33 files / +106 / −7102`) | Claude + Codex (Minor) | Original stale numbers removed; the doc no longer pins a self-referential diff stat. Live numbers via `git diff --shortstat main..phase-0-verify`. | ✓ Folded |
| Work Summary HEAD reference outdated | Codex (Minor) | Updated to current HEAD (see header at top of this document for the live value + commit chain). | ✓ Folded |
| `README.md:148` still references removed `jqueryfiletree connector` (Round 2) | Codex R2 (Moderate) | Q10 #414 / commit `42e9faf`: replaced "the jqueryfiletree connector" with description of vanilla `createFileTree` + `GET /api/browse` + `GET /api/file` architecture. `grep -nE "jquery" README.md` now returns 0 hits. | ✓ Folded |

### Single-CLI observations (accepted with documented disposition)

| Finding | Reviewer | Disposition |
|---|---|---|
| **B-F1: Voice runbook tombstone at `tests/workbench-test-runbook.md:3722`** ("**Issue:** Deepgram voice feature removed") | Claude only | **ACCEPTED as intentional historical note.** The line is the `REG-VOICE-01` regression test header explaining what the regression check verifies (that voice was removed and its UI surface — mic button — is gone). Removing this would orphan the regression test. Per Claude's own recommendation: "If the runbook policy is 'tombstones documenting historical removals are useful for the runbook reader's context,' keep it." Workbench runbook policy is the latter. No action. |
| **B-F3: ENG-12 sync→async fold-in in `src/routes.js:2186` was a production-side correctness fix folded into a test-fix PR (#325) without per-action 3-CLI consult** | Claude only | **ACCEPTED with documentation.** PROC-001 §3 mandates 3-CLI RCA before bug fixes. This fix was sourced from the original 3-CLI code review (CLAUDE_CODE_REVIEW.md §7.1 sync-FS-in-async-paths table) which was a planning-level 3-CLI input. The corrective action plan derives its cleanup actions from that 3-CLI review, so the consultation already happened at the strategy layer for every fix it spawns. Per PROC-001 §"When to skip 3-CLI diagnosis," this falls under "no consumers / strategy-layer-already-3-CLI'd" rather than "every fix gets a fresh consult." Future phase gates should not re-flag fix folds derived from the corrective action plan. No code action; this disposition is documented here. |
| **A.1: Mock program-method stubs are minimum-viable but lack a future-author hint** (caveat for future awareness) | Claude only | **ADDRESSED in this commit.** Added an inline note in `tests/mock/routes.test.js` next to the program-method block: future test authors who need to assert on program state (e.g., "session list groups by program X") must pass program-aware overrides via the existing `makeApp(overrides)` mechanism, with a concrete example. Claude's sufficiency check confirmed: the empty/null defaults work fine for current routes (`/api/state` reads `project.program_id ?? null` gracefully; `/api/programs?filter=...` returns `[]`; `buildProjectTaskTree` returns `[]`). |
| **A.4: No `SU-*` mock test exercises the `_readClaudeStatusLineState` overlay path** (coverage observation, not a Phase 0 blocker per Claude) | Claude only | **FILED for Phase 1 as Q6 #411.** Adding the test needs fixture infrastructure (real statusLine state file in a temp dir or `fs.readFileSync` mock for the specific path) — medium effort, doesn't fit Phase 0 cleanup-hygiene scope. Phase 1 is the natural home alongside other test-plan additions per the corrective action plan. |
| **§E1: Mock fixture's program-method coverage — is `getAllPrograms: () => []` paired with `setProjectProgram: () => {}` *sufficient*?** (asked of other CLIs) | Claude only | **CONFIRMED SUFFICIENT.** Walked routes that consume program methods: `/api/state` line 1205 (`project.program_id ?? null` graceful default), line 1214 (`db.getAllPrograms('active')` returns `[]` fine), line 1588 (`buildProjectTaskTree` returns `[]` fine), POST `/api/programs/:id/projects` line 1020 (`setProjectProgram` returns undefined fine), GET `/api/programs?filter=` line 1027 (returns `[]` fine). Empty/null defaults work. The future-author note above ensures no silent failure if a later test asserts on program state. |
| **§E2: Could `tests/runbook-results-*.md` gitignore wildcard accidentally hit a template file like `tests/runbook-results-template.md`?** (asked of other CLIs) | Claude only | **CONFIRMED SAFE.** `find tests/ -name "*-template*" -o -name "*-results-template*"` returns zero hits. No template-style runbook-results file exists or is intended to be committed. The wildcard is correctly scoped to per-run results artifacts only. If a template ever gets introduced, the convention would be to name it differently (e.g., `tests/runbook-template.md` without `-results-`) or add a negation override (`!tests/runbook-results-template.md`). No action needed now. |

### Items the reviewers did NOT find but should have — disclosed via my own punt audit

The reviewers focused on the diff and the work summary. My own audit (in addition to the reviewers') uncovered three Phase-1-deferred items the reviewers didn't flag (#402 showErrorBanner UI bug, #403 password-fields-not-in-form Chrome warnings, #404 `#jqft-tree` rename). These were discovered during my UI verification, not by the reviewers; filed for Phase 1 per the "Cannot rationally be done in Phase 0" table above. Disclosed here so the gate can see the full audit picture, not only the reviewer-flagged subset.

---

## What this gate will review

Per gate checklist (#389):

1. **Work Summary** — this document.
2. **3-CLI test review** — review the test artifacts changed in Phase 0:
   - `tests/mock/routes.test.js` — 8 new program-domain methods on the mock db (sufficient? does the empty/null default mask anything?)
   - `tests/mock/mcp-tools.test.js` — `KNOWN_DOMAINS` allow-list (does it actually prevent silent regressions when a tool with a NEW prefix is added?)
   - `tests/mock/safe-exec.test.js` — SAF-12 (#173) updated to assert 5 `tmuxExecSync` calls
   - `tests/mock/session-utils.test.js` — SES-22 (#142) project-create payload includes `name`
   - `tests/mock/server.test.js` — voice list entries removed (any other static-analysis gap?)
   - `eslint.config.js` — `tests/browser/**` block, main block (`AbortSignal`), and the new `scripts/codemirror-entry.js` module override block
   - `tests/workbench-test-plan-ui.md` §3.3 — fixture reconciliation
   - **Runbook coverage gap**: Phase 0 added zero new runbook entries. Reviewers should flag whether #319 (jQuery / file tree picker) and #322 (PNG dockerignore / logo render) deserve their own runbook lines rather than piggy-backing on existing AP-01..04 / NF-15 / GATE-MKT-01 / SMOKE-01 entries.
3. **3-CLI code review** — `git diff main..phase-0-verify`. Independent reviews of the merged code change.
4. **Regression — mock** — already at 257 pass / 5 fail; the 5 are O3 #377 scope.
5. **Regression — live** — `npm run test:live` against M5 (gate runs this).
6. **Regression — UI runbook** — execute Phase 0–scoped runbook entries against M5 with per-verify-line agent affirmations + screenshots.
7. **CLI parity** — N/A for any of the 18 issues (none touch CLI plumbing); reviewer should confirm.
8. **Cleanup verification** — repo state.
9. **Runbook entry** — gate run logged.
10. **Sign-off** — present + ask permission.

---

## Process / standards anchors

- REQ-001 (engineering requirements)
- STD-003 (test plan, including new §12.4–§12.6 verify-clause contract)
- STD-004 (code work product)
- STD-005 (test code, including §4.5 visual review preface)
- PROC-002 (small-feature lifecycle, including new "Recording Progress" section)
- PROC-004 (test execution policy, including revised §6 on UI-test specific assertions)
- RUN-001 (deployment runbook)

---

## Asks of the reviewers

Independent, no leading. Each CLI reaches its own conclusion before any cross-comparison.

- Test review and code review run as separate 3-CLI passes (six total review sessions).
- Findings dispositioned per PROC-002 §"Step 5 Peer review": ≥2-CLI consensus = fold back into the relevant per-issue branch + re-run affected verify steps; single-CLI flags noted, folded only if obviously a real bug.
- After all reviews land + dispositions complete + regression suite green: present full evidence package to user; ask permission to merge the 13 PRs and close the 18 work issues + the gate issue.
