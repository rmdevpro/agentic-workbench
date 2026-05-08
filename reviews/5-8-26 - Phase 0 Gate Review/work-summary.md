# Phase 0 — Work Summary (Gate #389 brief)

**Date:** 2026-05-08
**Phase:** Phase 0 — Stabilize the model (cleanup hygiene, build hygiene, dev tooling, mock test stabilisation)
**Gate issue:** #389
**Verify branch:** `phase-0-verify` @ `99c9a13`
**Deployed image:** `irina:5000/workbench:99c9a13` = `:latest` (sha256:391d2a0d…f9539, layer `1a610b86395e`)
**Deploy target:** M5/dev via RUN-001
**Diff vs main:** 26 files changed, +99 / −425

---

## Goal of the phase

Foundational hygiene work that unblocks subsequent phases:

- Delete dead code (voice subsystem, jQuery, prime-test-session script)
- Remove stale `.dockerignore` patterns + add overrides so local docker builds ship the right assets
- Archive transient test artifacts; reconcile fixture documentation with reality
- Fix the ESLint test-globals scope so browser specs lint cleanly
- Stabilise the mock test fixture so the suite is truthful

Source: `CORRECTIVE_ACTION_PLAN.md` §5 — actions B1, B2, B3, B4, C1, C7, N4, O1, plus a Phase 0 Q1 plan addition (AbortSignal global) that surfaced during N4 verification.

---

## Issues + commits + branches

Nine issues, nine PRs, nine commits, all stacked clean onto `phase-0-verify`.

| # | PR | Branch | Commit | Change |
|---|---|---|---|---|
| 318 [B1] | #383 | `cleanup/318-voice-delete` | `d84db15` | Delete `src/voice.js` + `tests/mock/voice.test.js` + 3 list entries in `tests/mock/server.test.js` + tombstone comment in `src/server.js` |
| 319 [B2] | #385 | `cleanup/319-jquery-delete` | `669ddcc` | Drop `jquery` + `jqueryfiletree` from `package.json`; remove 2 `app.use('/lib/jquery…')` static-asset routes from `src/server.js`; remove `<script src="/lib/jquery/jquery.min.js">` and dead `jqueryFileTree` CSS rule from `public/index.html`; clean up `src/routes.js` historical comment |
| 320 [B3] | #380 | `cleanup/320-prime-test-session` | `1680096` | Delete `scripts/prime-test-session.js` + the lone meta-test in `tests/live/context-stress.test.js` referencing it; remove unused imports |
| 321 [B4] | #381 | `cleanup/321-dockerignore-stale` | `214fef8` | Remove 3 stale `.dockerignore` patterns (`CLAUDE_PENANCE.txt`, `compaction-*.md`, `smart-compaction-*.md`) referencing nonexistent files |
| 322 [C1] | #382 | `cleanup/322-dockerignore-pngtxt` | `753ab44` | Add `!public/*.png` and `!tests/fixtures/*.txt` overrides in `.dockerignore` so local docker builds include logos + fixtures (HF unaffected — uses `git archive`) |
| 323 [C7] | #387 | `cleanup/323-test-artifacts-fixtures` | `75841c4` | `git mv` 7 transient test result artifacts into `tests/results-archive/`; add `runbook-results-*.md`, `coverage-results-*.txt`, `gate-c-*results*.md` wildcards to `.gitignore`; reconcile `tests/workbench-test-plan-ui.md` §3.3 fixture list with reality |
| 324 [N4] | #384 | `cleanup/324-eslint-test-globals` | `b4062cf` | Extend `eslint.config.js` `tests/browser/**/*.js` globals block with `MouseEvent` + 8 frontend functions (`openFileTab`, `tabs`, `switchPanel`, `switchSettingsTab`, `setTaskFilter`, `loadTaskTree`, `expandedTaskFolders`, `openProjectConfig`) |
| 325 [O1] | #386 | `fix/325-mock-failures` | `42bac7f` | Add 8 program-domain methods to mock db in `tests/mock/routes.test.js` (`getAllPrograms`, `getProgram`, `getProgramByName`, `addProgram`, `updateProgram`, `deleteProgram`, `countProjectsInProgram`, `setProjectProgram`); rewrite MCP catalogue tests in `tests/mock/mcp-tools.test.js` to derive count from `TOOL_NAMES.length` + `KNOWN_DOMAINS` allow-list (`file/session/project/task/log/gh`); 3 drift fixes folded in (ENG-12 sync→async writeFile in `src/routes.js:2186`, SAF-12 tmuxCreateBash 5-call shape in `tests/mock/safe-exec.test.js`, SES-22 project-create payload in `tests/mock/session-utils.test.js`) |
| 395 [Q1] | #396 | `cleanup/Q1-abortsignal-eslint-global` | `ff2e024` | Add `AbortSignal: 'readonly'` to main globals block of `eslint.config.js` (line 26 next to `AbortController`). Plan addition outside original §5 — closes the residual `no-undef` PR #384 noted but punted |

`phase-0-verify` HEAD = `99c9a13` (sequence of 9 merge commits, no conflicts on any merge).

---

## Verify artifact

- **Branch:** `phase-0-verify` @ `99c9a13` — pushed to origin
- **Image:** `irina:5000/workbench:99c9a13`, retagged `:latest`
  - SHA256: `sha256:391d2a0d4e63a5df5d1d8221e014b04c3cbdaa628774b38d6c157a4afcaf9539`
  - Image layer: `1a610b86395e`
- **Container:** `workbench` on M5 (192.168.1.120:7860), recreated 2026-05-08T18:55Z (UTC), `/health` returns `{status:"ok"}`
- **Compose:** unchanged from prior deploy (compose file at `/srv/.admin/workbench/docker-compose.yml` matches verify-branch tree byte-for-byte)

---

## Evidence collected (per-issue checklist evidence)

### Mock suite (in deployed container `irina:5000/workbench:99c9a13`)

`docker exec workbench sh -c "cd /app && npm test"` → **257 pass / 5 fail**

The 5 failures are exactly:

| # | Test |
|---|---|
| not ok 25 | `DB-05: task CRUD lifecycle` |
| not ok 75 | `TSK-07: created_by field persists` |
| not ok 86 | `task CRUD success paths with DB verification` |
| not ok 157 | `TSK-08: GET /api/tasks/tree returns tree object` |
| not ok 158 | `TSK-09: GET /api/tasks/tree accepts filter query param` |

All 5 are task v1→v2 schema mismatches and explicitly scoped to **O3 #377** (Phase 4). Phase 0 BASELINE gate cannot reach 0 fail without #377; the 5 failures are out-of-scope-by-plan.

### Lint (one-off `node:24` sandbox against verify-branch source on M5)

The deployed prod container has no devDependencies, so lint is verified via a one-off `node:24` container against `/tmp/agentic-workbench` on M5 (legitimate alternate signal per PROC-004 Principle 3 — does not pollute the deployed container).

`docker run --rm -v /tmp/agentic-workbench:/work -w /work node:24 sh -c "npm install && npm run lint"` → **22 errors total**

Breakdown:
- 22 × `no-unused-vars` (scope of N1a #362 + N1b #373, future phases)
- 0 × `no-undef` test-globals (was 40, all cleared by N4)
- 0 × `no-undef` `AbortSignal` (was 1, cleared by Q1 #395)
- 1 parsing error in `scripts/codemirror-entry.js` ("'import' and 'export' may appear only with sourceType: module") — pre-existing, unrelated to Phase 0

(Original baseline before any Phase 0 work was 63 errors; after Phase 0 = 22.)

### HTTP probes against M5 deployment

| URL | Expected | Got |
|---|---|---|
| `GET /` | 200 | 200 |
| `GET /health` | 200 + status:ok | 200 `{status:"ok"}` |
| `GET /planlogo.png` | 200 | 200 |
| `GET /workbench-preview.png` | 200 | 200 |
| `GET /logo-dark.png` | 200 | 200 |
| `GET /dev-light.png` | 200 | 200 |
| `GET /lib/jquery/jquery.min.js` | 404 (route deleted) | 404 |

### In-page evaluate against M5 (Playwright)

```js
typeof window.jQuery       // "undefined"
typeof window.$            // "undefined"
document.querySelectorAll('script[src*="jquery"]').length  // 0
typeof createFileTree      // "function" (vanilla replacement loaded)
```

### UI affirmations against M5 (per STD-003 §12.4–§12.6 and `tests/workbench-test-plan-ui.md` §3.4b)

**Landing page** (screenshot `.playwright-mcp/phase-0-verify-m5-landing.png`):
- Page title reads exactly "Workbench"
- Sidebar populated with project list
- Empty state visible with text "Select a session or create a new one / Pick a project from the sidebar to get started"
- Settings modal hidden
- Filter dropdown defaults to "active"
- Sidebar header logo `<img>` has `src="http://192.168.1.120:7860/dev-dark.png"`, `naturalWidth=870`, `complete=true`
- "BLUEPRINT WORKBENCH Dev" green dev-variant logo rendered (not broken-image)

**Add Project picker** (screenshot `.playwright-mcp/phase-0-verify-m5-add-project-picker.png`):
- Modal heading reads exactly "Add Project"
- `#jqft-tree` element present with class `ft-tree` (vanilla, NOT `jqueryFileTree`)
- 3 mounts visible: `/data/workspace/`, "Knowledge Base", `/mnt/storage`
- Expanded `/data/workspace` renders 16 sub-directories: `cst_concurrent_proj`, `cst_fs_proj`, `cst_proj`, `cst_stress_proj`, `cst_token_proj`, `docs`, `repos`, `rol-test-m5`, `ses_create_proj`, `sess_proj`, `snapshots`, `test_live_project`, `test-runbook-proj-2026`, `wb-seed`, `ws_proj` (plus the workspace root entry itself)
- "+ Folder" button + path input + name input + Add button all visible

### In-container filesystem checks (`docker exec workbench …`)

| Path | Expected | Result |
|---|---|---|
| `/app/src/voice.js` | absent | absent ✓ |
| `/app/scripts/prime-test-session.js` | absent | absent ✓ |
| `/app/public/dev-dark.png` | present | present (122656 bytes) ✓ |
| `/app/public/dev-light.png` | present | present (174024 bytes) ✓ |
| `/app/public/logo-dark.png` | present | present (76961 bytes) ✓ |
| `/app/public/logo-light.png` | present | present (174370 bytes) ✓ |
| `/app/public/planlogo.png` | present | present (308191 bytes) ✓ |
| `/app/public/prod-dark.png` | present | present (114681 bytes) ✓ |
| `/app/public/prod-light.png` | present | present (169959 bytes) ✓ |
| `/app/public/workbench-preview.png` | present | present (176000 bytes) ✓ |
| `/app/tests/fixtures/stub-claude.sh` | present | present ✓ |
| `/app/tests/fixtures/test-data.js` | present | present ✓ |
| `/app/tests/fixtures/trigger-uncaught.js` | present | present ✓ |
| `grep -rEn "voice\|Voice" /app/src` | 0 hits | 0 hits ✓ |
| `grep -rEn "jquery" /app/src /app/public/index.html` | 0 hits | 0 hits ✓ |

### Per-issue checklist status

All 9 issue bodies (`#318`, `#319`, `#320`, `#321`, `#322`, `#323`, `#324`, `#325`, `#395`) have their workflow checklists ticked with concrete inline evidence per item. Items not applicable to a given issue are explicitly marked `[N/A]: <reason>` against `tests/workbench-test-plan-ui.md` §3.4b verifiable-surface taxonomy or the standards-derived layer requirements (no rubber-stamping).

Workbench tasks `#334`–`#341` and `#403` are status `done`. Phase 0 Gate task (workbench `#342`) is still `todo` until this gate completes.

---

## What this gate will review

Per gate checklist (#389):

1. **Work Summary** — this document.
2. **3-CLI test review** — review the test artifacts changed in Phase 0:
   - `tests/mock/routes.test.js` — added 8 program-domain methods to inline mock db (sufficient? does the empty/null default mask anything?)
   - `tests/mock/mcp-tools.test.js` — `KNOWN_DOMAINS` allow-list approach (does it actually prevent silent regressions when a tool with a NEW prefix is added? does the count derivation cover all the failure modes the prior hardcoded `44` masked?)
   - `tests/mock/safe-exec.test.js` — SAF-12 (#173) updated to assert 5 `tmuxExecSync` calls
   - `tests/mock/session-utils.test.js` — SES-22 (#142) project-create payload includes `name`
   - `tests/mock/server.test.js` — voice list entries removed (does removing them leave any other static-analysis gap?)
   - `eslint.config.js` — `tests/browser/**` globals block (is the list complete or are there other frontend functions still tripping `no-undef`?) + main globals block (does `AbortSignal` addition resolve the only remaining no-undef in `src/`?)
   - `tests/workbench-test-plan-ui.md` §3.3 — fixture reconciliation (is the deferred-to-F7 / dropped classification correct, or did we leave a real test gap?)
   - **Runbook coverage gap**: Phase 0 added zero new runbook entries. Reviewer should flag whether #319 (jQuery removal — UI surface: file tree picker still works) and #322 (PNG dockerignore fix — UI surface: logos render in browser) deserve their own runbook lines rather than piggy-backing on existing AP-01..04 / NF-15 / GATE-MKT-01 / SMOKE-01 entries.
3. **3-CLI code review** — `git diff main..phase-0-verify` (26 files, +99/−425). Independent reviews of the merged code change.
4. **Regression — mock** — already at 257 pass / 5 fail; the 5 are O3 #377 scope.
5. **Regression — live** — `npm run test:live` against M5 (gate runs this).
6. **Regression — UI runbook** — execute Phase 0–scoped runbook entries against M5 with per-verify-line agent affirmations + screenshots.
7. **CLI parity** — N/A for any of the 9 issues (none touch CLI plumbing); reviewer should confirm.
8. **Cleanup verification** — repo state.
9. **Runbook entry** — gate run logged.
10. **Sign-off** — present + ask permission.

---

## Out-of-scope-for-Phase-0 items (tracked elsewhere)

| Item | Tracked by | Phase |
|---|---|---|
| 5 task v1→v2 mock failures | O3 #377 (workbench task #398) | Phase 4 |
| 22 `no-unused-vars` lint errors | N1a #362 (workbench task #378) + N1b #373 (workbench task #394) | Phase 1 + Phase 4 |
| `ansi-auth-url.txt` + `chunked-auth-frames.bin` fixtures | F7 #363 (workbench task #375) | Phase 1 |
| Parsing error in `scripts/codemirror-entry.js` | pre-existing, no plan letter — flag if reviewer thinks it warrants a Q-series issue | — |

---

## Process / standards anchors

- REQ-001 (engineering requirements)
- STD-003 (test plan, including new §12.4–§12.6 verify-clause contract authored 2026-05-08)
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
- After all reviews land + dispositions complete + regression suite is green: present full evidence package to user; ask permission to merge the 9 PRs and close the 9 work issues + the gate issue.
