# Phase 0 — Work Summary (Gate #389 brief)

**Date:** 2026-05-08
**Phase:** Phase 0 — Stabilize the model (cleanup hygiene, build hygiene, dev tooling, mock test stabilisation)
**Gate issue:** #389
**Verify branch:** `phase-0-verify` @ `010ebf0`
**Deployed image:** `irina:5000/workbench:010ebf0` = `:latest` (sha256:5aaf94d0…b6c35)
**Deploy target:** M5/dev via RUN-001
**Diff vs main:** 33 files changed, +106 / −7102 (the −6667 line block is the dead `public/spike/issues.json` deletion)

---

## Goal of the phase

Foundational hygiene work that unblocks subsequent phases:

- Delete dead code (voice subsystem, jQuery + jqueryfiletree, prime-test-session script, public/spike/, dead aggregator scripts, dead briefings)
- Remove stale `.dockerignore` patterns + add overrides so local docker builds ship the right assets
- Archive transient test artifacts; reconcile fixture documentation with reality; commit `reviews/` audit trail
- Fix the ESLint test-globals scope so browser specs lint cleanly; add Node-builtin globals (AbortSignal); add module override for ES-module entry point
- Stabilise the mock test fixture so the suite is truthful

Source: `CORRECTIVE_ACTION_PLAN.md` §5 (B1, B2, B3, B4, C1, C7, N4, O1) + 6 Q-series additions surfaced during Phase 0 verification (Q1–Q6).

---

## Issues + commits + branches

**14 issues, 12 PRs, 12 commits, all stacked clean onto `phase-0-verify`** (2 issues are untracked-file rms with no PR).

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

`phase-0-verify` HEAD = `010ebf0` (sequence of 12 merge commits, no conflicts on any merge).

---

## Verify artifact

- **Branch:** `phase-0-verify` @ `010ebf0` — pushed to origin
- **Image:** `irina:5000/workbench:010ebf0`, retagged `:latest`
  - SHA256: `sha256:5aaf94d0ca171919116b05e502b3352e9278c6b59bf556dcf2b5ce10238b6c35`
  - Image build layer: `746f3345c8a3`
- **Container:** `workbench` on M5 (192.168.1.120:7860), recreated 2026-05-08T19:25Z (UTC), `/health` returns `{status:"ok"}`
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
| `git ls-files reviews/` | 7 files (Q6) | 7 files ✓ |
| `ls reviews/` folder spacing | normalized (one space) | both folders use single-space pattern ✓ |
| `eslint.config.js` Q2 override block | present | present (`files: ['scripts/codemirror-entry.js']` with `sourceType: 'module'`) ✓ |
| `eslint.config.js` Q1 AbortSignal global | present | present (line 27 — main globals block) ✓ |

### Per-issue checklist status

All 14 issue bodies (#318, #319, #320, #321, #322, #323, #324, #325, #395, #397, #398, #399, #400, #401) have their workflow checklists ticked with concrete inline evidence per item. Items not applicable to a given issue are explicitly marked `[N/A]: <reason>`.

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
3. **3-CLI code review** — `git diff main..phase-0-verify` (33 files, +106/−7102). Independent reviews of the merged code change.
4. **Regression — mock** — already at 257 pass / 5 fail; the 5 are O3 #377 scope.
5. **Regression — live** — `npm run test:live` against M5 (gate runs this).
6. **Regression — UI runbook** — execute Phase 0–scoped runbook entries against M5 with per-verify-line agent affirmations + screenshots.
7. **CLI parity** — N/A for any of the 14 issues (none touch CLI plumbing); reviewer should confirm.
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
- After all reviews land + dispositions complete + regression suite green: present full evidence package to user; ask permission to merge the 12 PRs and close the 14 work issues + the gate issue.
