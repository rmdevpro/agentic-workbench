# Phase 0 Gate Review — Claude

**Reviewer:** Claude Sonnet 4.6
**Date:** 2026-05-08
**Branch:** `phase-0-verify` @ `010ebf0` (deploy point) → `afd5215` (HEAD with doc update)
**Method:** Independent review — read the work summary, diffed `main..010ebf0` per file, grepped the working tree for residual references, cross-checked the Work Summary's claims against the actual repo state. No leading from prior CLI output. This review produces findings, severity, and disposition recommendations per the work summary's "Asks of the reviewers" section.

The review is split per the gate request: **§A test review** and **§B code review** are independent passes. **§C disposition** consolidates findings with severity and a fold/defer/accept recommendation per PROC-002 §Step 5.

---

## §A — Test Review

Files reviewed:
- `tests/mock/routes.test.js` (mock db program methods, SES-22 fix)
- `tests/mock/mcp-tools.test.js` (MCP catalog rewrite, KNOWN_DOMAINS allow-list)
- `tests/mock/safe-exec.test.js` (SAF-12 5-call shape)
- `tests/mock/session-utils.test.js` (SU-09/10/11 max_tokens contract)
- `tests/mock/server.test.js` (voice list-entries removed)
- `eslint.config.js` (test globals, AbortSignal, codemirror module override)
- `tests/workbench-test-plan-ui.md` §3.3 (fixture reconciliation)
- `tests/live/context-stress.test.js` (CST: prime-test-session existence test removed)

### A.1 `tests/mock/routes.test.js` (#325)

**Verdict:** Adequate for the immediate goal (unblock /api/state and /api/programs* in the mock harness). Minimum-viable, with appropriate hedging.

The 8 added methods (`getAllPrograms`, `getProgram`, `getProgramByName`, `addProgram`, `updateProgram`, `deleteProgram`, `countProjectsInProgram`, `setProjectProgram`) are a clean superset of what the routes actually call (verified by grepping `routes.js` for `db.getAllPrograms` etc.). The empty-default + null-default pattern is honest: the comment in the diff explicitly says "Empty + null defaults keep the mock isolated from program-specific assertions."

**Caveat for future awareness, not a Phase 0 finding:** If a future test asserts on program state (e.g., "session list groups by program"), the mock returns empty and the assertion fails confusingly. The current shape is correct *for now*; future test authors should add program-aware overrides via the existing `makeApp(overrides)` pattern. Worth a one-line comment in the mock pointing that out, but this isn't gate-blocking.

The SES-22 fix (`name: 'create me'` added so the request reaches the project-existence 410 check instead of 400 short-circuiting on missing name) is correct and well-documented inline.

### A.2 `tests/mock/mcp-tools.test.js` (#325)

**Verdict:** This is the strongest test-side change in Phase 0. It implements the L1 direction (single source of truth for the MCP tool catalog) ahead of schedule.

The rewrite from hardcoded `assert.equal(json.tools.length, 44)` → `assert.equal(json.tools.length, TOOL_NAMES.length)` plus a deep-equal sort comparison is the right pattern. The `KNOWN_DOMAINS = ['file', 'session', 'project', 'task', 'log', 'gh']` allow-list correctly surfaces a *new* domain prefix as a test failure, forcing deliberate review.

**Coverage gap (acceptable):** the test does not surface adding a *new tool with a known prefix* (e.g., a hypothetical `file_unsafe_exec` would pass). That coverage lives in the per-tool assertions elsewhere in the test plan (file_*, session_*, etc.). This is consistent with the corrective action plan's L1 design intent. No action.

The handlers/TOOL_NAMES sync assertion (`assert.deepEqual([...TOOL_NAMES].sort(), Object.keys(handlers).sort())`) is the right shape — it would surface a tool that has a handler but no name (or vice versa) which would be the actual drift mode we care about.

### A.3 `tests/mock/safe-exec.test.js` (#325)

**Verdict:** Test drift remediation. Correct.

SAF-12 was asserting 3 `tmuxExecSync` calls when the actual implementation was making 5 (per #240, OSC 8 hyperlink passthrough added two more `set-option` calls). The test was failing not because the code was wrong but because the test was out of date. The new assertion shape (5 calls, each verified for the right `set-option` argument) is what the test plan's SAF-12 should always have asserted.

### A.4 `tests/mock/session-utils.test.js` (#325)

**Verdict:** Substantive test contract change. Correct, well-documented.

SU-09/10/11 + SES-20 previously asserted `max_tokens === 200000` (Sonnet) and `max_tokens === 1000000` (Opus). The current `getTokenUsage` implementation returns `max_tokens: null` for Claude — the comment chain in `session-utils.js:680-695` explains why: per #286, the plan-effective max comes from the live statusLine state file, which `getSessionInfo` overlays on top of `getTokenUsage`'s output. The unit test for `getTokenUsage` should assert null; testing the merged output is `getSessionInfo`'s scope.

The diff's inline comments make this contract explicit, which I prefer to silently flipping the assertion. Test naming is also updated (e.g., "SU-11: opus model returns 1M max_tokens" → "SU-11: getTokenUsage reports model from JSONL; max_tokens null (sourced from statusLine)") to match the actual scope. Good hygiene.

**Coverage observation (not a blocker):** there is no current SU-* test that exercises the `_readClaudeStatusLineState` overlay path. The test plan's #286 coverage may need a new test case for "getSessionInfo returns plan-effective max_tokens from statusLine state file" — but that's a scope question for the test plan, not Phase 0.

### A.5 `tests/mock/server.test.js` (#318)

**Verdict:** Clean. Three list entries removed (ENG-20 import list, ENG-09 catch-block file list, ENG-12 async file list). Voice was correctly part of all three lists and is now correctly absent.

### A.6 `eslint.config.js` (#324, Q1, Q2)

**Verdict:** Three independently good changes.

- N4 #324: 8 frontend functions added to the `tests/browser/**` globals block + `MouseEvent` for spec files that use it. Verified the 40 baseline `no-undef` errors against the work summary's claim — gone.
- Q1 #395: `AbortSignal: 'readonly'` added to the main globals block. Direct fix for a node:24 environment surfacing the missing global.
- Q2 #397: New override block for `scripts/codemirror-entry.js` with `sourceType: 'module'`. Correct: the file uses `export { … }` ES-module syntax that fails to parse under the default `commonjs`. The override is appropriately narrow (just the one file).

### A.7 `tests/workbench-test-plan-ui.md` §3.3 (#323)

**Verdict:** Clean reconciliation. Matches my prior review's §10.5 finding ("5 of 8 documented fixtures missing").

The diff:
- Marks `ansi-auth-url.txt` and `chunked-auth-frames.bin` as `(deferred — captured by F7 #363)` instead of pretending they exist.
- Removes the four documented-but-nonexistent fixtures (`workbench_primer.py`, `settings.json`, `tasks.json`, `messages.json`).
- Adds the two fixtures that actually exist (`test-data.js`, `trigger-uncaught.js`).

This is honest. The deferral pointer to F7 #363 is appropriate because the OAuth fixtures genuinely require an OAuth-detector extraction to capture, which Phase 0 doesn't do.

### A.8 `tests/live/context-stress.test.js` (#320)

**Verdict:** Clean meta-test removal. The deleted test asserted that `scripts/prime-test-session.js` existed; that script was deleted in B3. The unused `fs` and `path` imports are also cleaned up.

### A.9 Test review summary

8 files changed, all coherent with their stated scope. The only observation that looks like a gap rather than a deferral is **the unit-test coverage for the `_readClaudeStatusLineState` overlay path** (mentioned in §A.4). Out of scope for Phase 0 per the gate's own framing.

No test-review blockers.

---

## §B — Code Review

Files reviewed:
- `src/voice.js` (deleted, B1)
- `src/server.js` (jquery static routes removed, voice tombstone comment removed, B1+B2)
- `src/routes.js` (jquery historical comment cleanup; ENG-12 sync→async fold-in at L2186)
- `public/index.html` (jquery script tag, dead CSS rule, comment cleanup, B2)
- `package.json` + `package-lock.json` (jquery + jqueryfiletree dropped, B2)
- `public/spike/issues-panel.html` + `public/spike/issues.json` (deleted, Q4)
- `scripts/prime-test-session.js` (deleted, B3)
- `.dockerignore` (stale exclusions removed B4; PNG/TXT overrides added C1)
- `.gitignore` (transient artifact patterns added, C7)
- `tests/results-archive/*` (7 files moved via git mv, C7)

### B.1 voice deletion (#318)

**Verdict:** Complete in `src/`. Confirmed by `grep -rn "voice\|Voice" /app/src` returning zero hits per the work summary, which I re-verified at HEAD against the working tree.

**Tail finding (B-F1):** `tests/workbench-test-runbook.md:3722` still contains "**Issue:** Deepgram voice feature removed". This appears to be a removal-tombstone comment documenting the historical state — likely intentional. Worth confirming it's intentional in the gate.

### B.2 jQuery deletion (#319)

**Verdict:** Complete in `src/`, `public/index.html`, `package.json`, `package-lock.json`. The lockfile drop is correct (both packages removed from the integrity-checked dep graph). The two static-asset routes are gone. The frontend `<script>` tag and the dead `UL.jqueryFileTree` CSS rule are gone.

Verified at runtime: per the work summary, `GET /lib/jquery/jquery.min.js` returns 404 (was 200), and `typeof window.jQuery === 'undefined'` and `document.querySelectorAll('script[src*="jquery"]').length === 0` in the page evaluate. Independent grep at HEAD shows no jquery references in `src/` or `public/index.html`.

**Tail finding (B-F2):** Stale jQuery references survive in test plans and the runbook:

| File:Line | Reference | Impact |
|---|---|---|
| `tests/workbench-test-plan-ui.md:1754` | `POST /api/jqueryfiletree` listed as a route | Route does not exist in `routes.js`; any test exercising it gets 404 |
| `tests/workbench-test-plan-ui.md:1779` | "Corrected to POST for `/api/jqueryfiletree`" historical change note | Stale historical reference |
| `tests/workbench-test-plan-backend.md:503` | "Static file serving (public/, xterm, jquery)" in SRV-02 | jquery is no longer served; SRV-02 input list is wrong |
| `tests/workbench-test-plan-backend.md:1232` | `GET /lib/jquery/jquery.min.js` listed as SRV-02 input | Returns 404 today; if SRV-02 asserts 200, it fails |
| `tests/workbench-test-plan-backend.md:1672` | `POST /api/jqueryFileTree` in FS-04 | Route does not exist; FS-04 fails |
| `tests/workbench-test-plan-backend.md:3186` | "Fixed to `/lib/jquery/jquery.min.js`" historical change note | Stale historical reference |
| `tests/workbench-test-runbook.md:4235` | `tree.querySelector('UL.jqueryFileTree')` in a verify step | Selector returns null; check silently fails or errors |

This is **stronger than a "missing runbook entries" gap** (which the work summary already flags in §"What this gate will review" item #2). It's **stale entries that now reference dead code/routes**. The runbook L4235 selector and the backend test plan's FS-04 / SRV-02 inputs will fail or silently miss when executed.

The work summary's gate question #2 is "deserve their own runbook lines rather than piggy-backing on existing AP-01..04 / NF-15 / GATE-MKT-01 / SMOKE-01 entries." My answer: that's the secondary question. The primary question is *removing the stale references that reference dead code*. New runbook entries are an addition; stale references are a correctness bug.

**Recommend:** before merging Phase 0, sweep these out (~10 lines edited across 3 files). Either (a) fold into PR #319 as a follow-up commit, or (b) file a new docs-cleanup issue and track as Phase-0 follow-on.

### B.3 prime-test-session deletion (#320)

**Verdict:** Clean. Script + meta-test gone. No surviving references in `src/`, `scripts/`, or `public/`.

### B.4 .dockerignore (#321 + #322)

**Verdict:** Clean. Stale `CLAUDE_PENANCE.txt`, `compaction-*.md`, `smart-compaction-*.md` removed. `!public/*.png` and `!tests/fixtures/*.txt` overrides added.

The work summary correctly notes that HF deploys via `git archive HEAD | tar` which bypasses `.dockerignore`, so HF was unaffected; the fix is only material for local `docker compose up --build`. Verified: HTTP probes against M5 show all PNGs return 200. The test plan `§3.3 ansi-auth-url.txt` deferral is consistent (the override is in effect, the file just doesn't exist yet).

### B.5 test artifact archive + .gitignore (#323)

**Verdict:** Clean. Seven transient test result files moved via `git mv` to `tests/results-archive/` (history preserved), and three .gitignore patterns added so future runs don't accidentally commit. The test plan §3.3 reconciliation is reviewed in §A.7.

### B.6 public/spike/ deletion (#399 / Q4)

**Verdict:** Clean. 6,667 lines of dead HTML + JSON deleted. Verified zero consumers via independent grep (no `src/` or `public/index.html` reference to `public/spike/` or `issues-panel.html`).

### B.7 ENG-12 sync→async fold-in (`src/routes.js:2186`, in #325)

**Verdict:** Real production-side correctness fix. The previous `require('fs').writeFileSync(tailPath, tail, 'utf-8')` was sync I/O inside an async HTTP handler — REQ-001 §4.1 violation surfaced in the original CLAUDE_CODE_REVIEW.md §7.1 sync-FS-in-async-paths table.

The fix uses the already-imported `writeFile` from `fs/promises` (the file imports it at L7). Changes one line: `await writeFile(tailPath, tail, 'utf-8')`. Correct.

**Process observation (B-F3):** This is a production code change folded into a test-fix PR (#325). Strict reading of PROC-001 §3 ("every bug requires 3-CLI RCA before any fix") would require a per-action 3-CLI consult. Defense: the original CLAUDE_CODE_REVIEW.md was a 3-CLI input (the corrective action plan cites CLAUDE/CODEX/GEMINI reviews) so the 3-CLI consultation already happened at the planning level.

I lean **acceptable** for Phase 0's hygiene scope, but mark this as a process question for the gate: should fold-ins of correctness fixes from upstream multi-CLI reviews be allowed without per-action consult, or should each fold-in get its own consult? My read of PROC-001 leans toward the latter being strict but unnecessary in this case; gate to confirm.

### B.8 server.js + routes.js comment cleanups

**Verdict:** Cosmetic and consistent. The voice tombstone comment in `server.js` (`// Voice input (Deepgram) removed — feature disabled`) is removed because the file is gone — appropriate (no point referencing a tombstone for an empty fact). The `routes.js` jqueryFileTree historical comment is cleaned up to reflect the current state.

### B.9 Code review summary

All 13 substantive code changes are coherent with their stated scope. The single tail finding (B-F2) is the stale jQuery references in test plans and runbook — material because they reference dead code/routes that, if executed, will fail or silently miss. B-F1 (voice runbook tombstone) and B-F3 (ENG-12 fold-in process question) are observations for the gate to disposition.

No code-review blockers in `src/` or `public/`.

---

## §C — Findings, Severity, and Disposition

Per the gate's "Asks of the reviewers" section: ≥2-CLI consensus = fold back into the per-issue branch + re-run affected verify steps; single-CLI flags noted, folded only if obviously a real bug.

I'll mark each finding with my disposition recommendation. The gate orchestrator decides whether to act on single-CLI flags or wait for the other two CLIs' independent reviews.

### Recommend fold back into per-issue branches

**B-F2: Stale jQuery references in test plans + runbook (extend #319 or new doc-cleanup PR).**
- **Files:** `tests/workbench-test-plan-ui.md:1754, 1779`; `tests/workbench-test-plan-backend.md:503, 1232, 1672, 3186`; `tests/workbench-test-runbook.md:4235`.
- **Why fold back:** These reference dead routes (`/api/jqueryfiletree`, `/api/jqueryFileTree`), a no-longer-served static asset (`/lib/jquery/jquery.min.js`), and a DOM element (`UL.jqueryFileTree`) that the vanilla file tree no longer renders. SRV-02 and FS-04 will fail or silently miss when executed. The runbook L4235 selector returns null on the current DOM.
- **Disposition:** **Fold into PR #319 as a follow-up commit, OR file a new docs-cleanup issue (Q7) blocked-on-Phase-0**. ~10 line edits across 3 files. Acceptance: `grep -rn "jquery" tests/` returns zero hits except deliberately-historical change notes (which can stay if dated).
- **Severity:** Medium. Documents the same issue as the Work Summary's gate question #2 but reframed as "stale references" not "missing additions" — the existing references are wrong, not just incomplete.
- **Confidence:** High. Independent grep at HEAD verifies the references exist and the routes/elements/assets they reference are gone.

**Work Summary doc accuracy: diff stat in §"Diff vs main".**
- **File:** `reviews/5-8-26 - Phase 0 Gate Review/work-summary.md` line 9.
- **Why fold back:** Says "33 files changed, +106 / −7102". Actual at deploy point `010ebf0`: 34 files / +4991 / -7092. The discrepancy is the `reviews/` commit (Q6 #401) which contributes ~4,886 insertions across 7 files. Also the file count is 34 not 33. The "−7102" is close to the actual −7092.
- **Disposition:** **One-line edit to the Work Summary** (the doc is already at HEAD `afd5215` which is post-deploy, so this is purely a doc accuracy fix). Recommend: "34 files changed, +4991 / −7092 (the −6667 line block is the dead public/spike/issues.json deletion; +4886 is the reviews/ audit-trail commit per Q6 #401)."
- **Severity:** Low. Minor accounting; doesn't affect the gate decision.
- **Confidence:** High. Verified via `git diff --stat`.

### Single-CLI observations to disposition at the gate

**B-F1: Voice runbook tombstone (`tests/workbench-test-runbook.md:3722`).**
- **What:** "**Issue:** Deepgram voice feature removed" — looks like a removal-history tombstone, not a stale reference.
- **Disposition:** **Likely accept as intentional historical note.** Confirm at the gate with the orchestrator. If the runbook policy is "no tombstones for removed features," remove it (1-line edit). If the policy is "tombstones documenting historical removals are useful for the runbook reader's context," keep it.
- **Severity:** Trivial. No correctness impact either way.

**B-F3: ENG-12 sync→async fold-in process question.**
- **What:** A production-side correctness fix in `src/routes.js:2186` was folded into a test-fix PR (#325) without per-action 3-CLI consult per PROC-001 §3.
- **Disposition:** **Accept with documentation.** The corrective action plan cites CLAUDE/CODEX/GEMINI reviews at the planning level, which satisfies the "3-CLI consultation" intent at the strategy layer even if not the per-fix layer. Recommend adding a one-line note to PROC-001 §"When to skip 3-CLI diagnosis" or to the Phase-0-or-later corrective action plan: "Production-side fixes folded into test-stabilisation PRs that derive from a 3-CLI multi-source review (e.g., the corrective action plan) do not require an additional per-action 3-CLI consult." Otherwise the next phase will repeatedly hit this question.
- **Severity:** Process question, not a correctness issue. The fix itself is correct.
- **Confidence:** Medium — depends on the strict-vs-pragmatic reading of PROC-001.

### Acknowledgements (no action)

- **A.1 mock program-method stubs:** Minimum-viable, with appropriate inline hedging. Future test authors must add program-aware overrides if asserting on program state.
- **A.2 MCP catalog rewrite:** Implements the L1 SSoT direction ahead of schedule. Right shape.
- **A.4 max_tokens contract change:** Honest test-contract update that documents the #286 statusLine override architecture. Test names updated to match new scope.
- **A.7 fixture reconciliation:** Honest deferral to F7 #363 with an explicit pointer.
- **#322 (C1) split acceptance:** Split into ".dockerignore override is in effect" (✓ verified) and "fixture is captured" (deferred to F7 #363). Reasonable response to the originally-overscoped acceptance criterion in the corrective action plan.

### Out of scope (per work summary's own framing)

- 5 task v1→v2 mock failures — O3 #377, Phase 4. ✓
- 21 `no-unused-vars` lint errors — N1a #362 + N1b #373, Phase 1+4. ✓
- F7 #363 OAuth fixture capture — Phase 1. ✓
- Three Q-series Phase-1 deferrals (#402, #403, #404). ✓ Per the work summary's own punt audit.

---

## §D — Gate-decision recommendation

**Phase 0 gate: PASS WITH FOLLOW-UP.**

Conditions:
1. **Fold B-F2 (stale jQuery references in test plans + runbook)** — either into PR #319 with a re-verify pass, or file as a new Q7 issue and track explicitly. My recommendation is "extend #319" since these are textual remnants of the same deletion. ~10 minute fix. Re-verify: `grep -rn "jquery\|jqueryfiletree\|jqueryFileTree" tests/` returns zero hits except deliberately-dated historical change notes.
2. **Correct the diff-stat line in the Work Summary** — one-line edit. No re-verify needed (doc-only).
3. **Disposition B-F1 and B-F3** at the gate. Accept-as-documented is fine for both, in my read.

The 14-issue work as merged to `phase-0-verify@010ebf0` is otherwise gate-ready. The mock test 257/5 status is correct (the 5 are O3 #377 by plan). The deployed-image evidence is consistent with the source diffs (HTTP probes, in-page evaluate, in-container filesystem checks). The lint baseline reduction (63 → 21) is real and consistent with the Phase 0 scope (the 21 remaining are N1 scope by plan).

The largest **structural** observation across the test + code review is B-F2 — the deletion physical work landed cleanly but the documentation-side cleanup in the test plans + runbook was missed. This is fixable in the same gate cycle and shouldn't block; it should land before the gate closes.

---

## §E — Items I'd ask the other two CLIs to specifically check

(Per "Independent, no leading" — this is *after* my own conclusions are above. The gate orchestrator may choose whether to share these prompts.)

1. **Mock fixture's program-method coverage:** is `getAllPrograms: () => []` paired with `setProjectProgram: () => {}` *sufficient* given the routes.js code paths that read `project.program_id`? My grep didn't find a route that round-trips through `setProjectProgram` and reads back via `getAllPrograms` in a single test, but a more rigorous walk might find one.

2. **`.gitignore` patterns C7:** the pattern `tests/runbook-results-*.md` will hit any future runbook results file. But would also accidentally hit a file like `tests/runbook-results-template.md` if one existed. Confirm there's no template-style file the team intended to commit.

3. **B-F2 backend test plan SRV-02 + FS-04:** I claim these will fail when executed. The other CLIs should independently verify by running `gh issue list` or `git grep` for the test IDs and confirming they reference dead routes.

4. **The diff-stat discrepancy:** independent verification that the actual `git diff --stat main..010ebf0` is 34/+4991/-7092 (mine) and not 33/+106/-7102 (work summary's claim). Easy to verify; surfaces whether reviewing CLIs are reading the same tree.

5. **PROC-001 §3 strict vs. pragmatic reading on B-F3:** is the corrective action plan a sufficient 3-CLI input for the ENG-12 production-side fold-in?

— end of Round 1 Claude review

---

## §F — Round 2: Fold-back verification

**Reviewer:** Claude Sonnet 4.6
**Date:** 2026-05-08
**Scope:** Verify the developer's response to the 3-CLI gate review findings (Claude's, Codex's, Gemini's). Read all three reviews, re-read the work summary at current state, walked the actual fold-back commits.

**Verify branch state:** `phase-0-verify` HEAD = `77aa7e6` (doc-only). Last source-changing commit = `97edeaa` (per work summary). Deployed image still pinned to `:97edeaa`.

### F.1 Cross-review consensus map

What each Round 1 reviewer flagged and how the consensus collapsed:

| Finding | Claude (R1) | Codex (R1) | Gemini (R1) | Consensus | Action |
|---|---|---|---|---|---|
| Stale jQuery refs in test plans + runbook + active tests | B-F2 (medium, "fold") | Major + Moderate ("blocker") | (silent) | **2-CLI consensus → fold** | Q7 #409 |
| Diff-stat / HEAD ref accuracy in work summary | "Low / fold" | Minor ("fold") | (silent) | **2-CLI consensus → fold** | Doc commits |
| Mock fixture program-method coverage | A.1 (single, future-author hint) | (silent) | (silent — explicit pass) | Single-CLI → accept | Q8 #412 |
| `_readClaudeStatusLineState` test coverage | A.4 (single, Phase 1 deferral) | (silent) | (silent) | Single-CLI → defer | #411 |
| Voice runbook tombstone | B-F1 (single, accept-historical) | (silent) | (silent) | Single-CLI → accept | Documented |
| ENG-12 sync→async fold-in process question | B-F3 (single, process q) | (silent) | (silent) | Single-CLI → document | Documented |
| Smoke framing ("manual smoke by user" misframing) | (silent) | (silent) | (silent) | User-flagged → fold | Q9 #413 |
| Phase-1 deferred items (#402/#403/#404) | (silent) | (silent) | (silent) | Developer self-disclosed | Filed |

The consensus collapse is healthy: every consensus item folded back; every single-CLI item either folded if obvious (A.1) or accepted with reasoning (B-F1/B-F3).

### F.2 Verification of each fold-back

#### F.2.1 Q7 #409 (commit `37eab54`) — Stale jQuery + prime-test-session sweep

**Claim:** Folded the consensus B-F2 + Codex Major+Moderate findings. 5 files changed.

**Verified directly against the diff:**

- `tests/live/startup.test.js` SRV-02 (Codex Major #1):
  - Was: `assert.equal((await fetch('/lib/jquery/jquery.min.js')).status, 200);` — would fail on next live run.
  - Now: asserts `xterm` and `codemirror-bundle.js` serve 200, AND asserts `/lib/jquery/jquery.min.js` returns 404 as a regression check for #319.
  - **Resolved.** The new shape is stronger than the old: it both verifies the active assets serve and locks in the deletion as a regression invariant.

- `tests/browser/file-browser.spec.js` (Codex Major #2):
  - Was: `fetch('/api/jqueryfiletree', { method: 'POST', body: 'dir=/' })` with HTML-content-length assertions.
  - Now: `fetch('/api/browse?path=/')` with JSON shape assertions (`apiResponse.entryCount > 0`, `apiResponse.path === '/'`).
  - **Resolved.** The replacement is a correct port to the current API. The earlier HTML-content-length check was also a weaker assertion than entry-count + echoed-path; the new test is meaningfully better.

- `tests/workbench-test-plan-backend.md` (Codex Moderate, my B-F2):
  - §3.3 prime-test-session row: REMOVED-marked with #320 pointer + replacement explanation.
  - §3.7 prime-test-session self-test: entire section REMOVED-marked.
  - UTIL-01/02 capability rows: REMOVED-marked.
  - SRV-02 §4.1 inputs updated to current routes; §5 SRV-02 inputs updated; jquery 404 regression check documented.
  - WAT-13 REMOVED-marked with explanation that context-stress.test.js now exercises the property indirectly.
  - FS-04 reframed from `POST /api/jqueryFileTree` to `GET /api/browse?path=...` with explicit JSON shape.
  - Helper-table prime-test-session entry REMOVED-marked.
  - Claude MIN-02 + Gemini historical disposition entries updated with current state.
  - **Resolved.** More extensive than I asked for in B-F2 — UTIL-01/02 + WAT-13 + §3.7 weren't on my list but were on Codex's; folding them all together was correct.

- `tests/workbench-test-plan-ui.md` (my B-F2):
  - L1754 `POST /api/jqueryfiletree` REMOVED-marked.
  - L1755 reframed `GET /api/browse` as the active replacement (now linked to FIL-01, AP-02 instead of just AP-02).
  - R-08 historical note updated.
  - **Resolved.**

- `tests/workbench-test-runbook.md` (my B-F2):
  - L4235 `UL.jqueryFileTree` selector → replaced with `.ft-children`/`.ft-row` synthetic injection that matches the vanilla DOM the current `createFileTree` renders.
  - **Resolved.** The synthetic-LI overflow recipe now produces DOM the verify code can actually find.

#### F.2.2 Q8 #412 (commit `a15a58d`) — Mock fixture future-author note

**Claim:** Adds an inline note next to the program-method block in `tests/mock/routes.test.js` per my A.1 finding.

**Verified directly against the diff:**

```js
// NOTE for future test authors: if you write a test that asserts on
// program state (e.g., "session list groups by program X", "project P
// appears under program Q"), pass program-aware overrides via the
// existing `makeApp(overrides)` mechanism — supplying e.g.
//   getAllPrograms: () => [{id: 1, name: 'engineering'}],
//   setProjectProgram: spy(),
// Don't rely on the empty defaults; they are deliberately program-blind.
```

**Resolved.** The note is precisely the shape I recommended in §A.1: explains the deliberate program-blindness, provides a concrete example for future authors, and references the existing `makeApp(overrides)` mechanism rather than inventing a new pattern.

#### F.2.3 Q9 #413 (commit `9841c5b`) — Smoke framing fix

**Claim:** Corrects "Manual smoke: hands-on by user" framing in 4 phase-gate sections of `REMEDIATION_EXECUTION_SUMMARY.md`.

**Verified directly against the diff:** All 4 instances replaced with "End-to-end smoke (agent-driven)" framing that puts the agent in the smoke loop with Playwright + Bash against M5, with per-step affirmations + screenshots backing each verify line. Each section now also includes the explicit assertion "The user does not run smoke tests; the agent does."

**Note:** This wasn't a Round 1 reviewer finding — the user surfaced it during the review cycle. Healthy that it was handled with the same Q-series treatment (issue file + commit + disposition note) rather than as a silent edit.

**Resolved.** Framing is now consistent with the trust model the user enforces (saved memory `feedback_user_does_not_test.md` per the work summary §"Punt audit").

#### F.2.4 B-F1 disposition (voice runbook tombstone)

**Claim:** Accepted as intentional. The line at `tests/workbench-test-runbook.md:3722` is the `REG-VOICE-01` regression test header, not a stale forward reference.

**Verified:** I re-read the runbook context. The tombstone is the header of a regression test that explicitly verifies "voice was removed and its UI surface (mic button) is gone." Removing the tombstone would orphan the regression test. **Disposition correct — accept as intentional.**

#### F.2.5 B-F3 disposition (ENG-12 sync→async fold-in process question)

**Claim:** Accepted with documentation. The fix derives from CLAUDE_CODE_REVIEW.md §7.1 (a 3-CLI input by definition), so the strategy-layer 3-CLI consultation already happened.

**Reasoning verified:** The corrective action plan explicitly cites all three reviews as inputs. PROC-001 §3 says "every bug requires a 3-CLI RCA before any fix." The defensible reading is that "3-CLI consultation" can land at the strategy layer (the corrective action plan) rather than per-fix when the fix is sourced from a multi-CLI input that already underwent independent analysis.

**Disposition correct — accept with documentation.** The work summary explicitly captures this in the disposition table so future phases don't keep re-flagging the question. Worth noting that this interpretation is now precedent and should be added to PROC-001's §"When to skip 3-CLI diagnosis" section in a future doc-cleanup pass — the work summary doesn't ask for this but it would prevent rediscovery.

#### F.2.6 A.4 disposition (statusLine overlay test coverage)

**Claim:** Filed for Phase 1 as #411 (Q6 in Phase 1's series).

**Verified:** `gh issue view 411` returns:
- Title: `[Q6] mock test: SU-12 getSessionInfo statusLine overlay coverage`
- State: OPEN
- Body: detailed problem statement, references the exact code path (`session-utils.js:986-998`), references #286 contract change, references the gap left by #325's SU-09/10/11 max_tokens null-assert update.

**Disposition correct — Phase 1 deferral with a concrete actionable issue.** Issue body is more thorough than my original §A.4 finding (which was a coverage observation) — author lifted my reasoning and added the file/line citation to operationalize it. Good shape for Phase 1 pickup.

#### F.2.7 §E1 + §E2 (asks of other CLIs)

**Claim:** Both confirmed by developer's own audit:
- §E1 (mock fixture sufficiency): walked routes that consume program methods (state line 1205, 1214, 1588; programs line 1020, 1027) and confirmed empty/null defaults work.
- §E2 (gitignore wildcard template-file safety): `find tests/ -name "*-template*"` returns zero hits.

**Verified §E1 by spot-check:** routes.js:1207 `program_id: project.program_id ?? null` — graceful nullish-coalesce; the empty default does not crash. routes.js:1216 `db.getAllPrograms('active')` — returns empty array, the iteration is empty, no error. **Confirmed.**

**Verified §E2:** running `find tests/ -name "*-template*"` from the repo root returns zero hits. The wildcard is safe.

**Both responses are well-reasoned and traceable.** The developer didn't just say "yes" — they walked the code paths and showed their work.

### F.3 Surviving references (sub-threshold)

After Q7 #409 + Q8 #412 + Q9 #413, three jquery/prime-test-session references survive in the working tree. Each is acceptable-as-is:

1. **`tests/workbench-test-plan-ui.md:594`** — "Note: Functions from server-side files (`mcp-server.js`, `server.js`, `scripts/prime-test-session.js`) are excluded from this inventory."
   - This is historical context for the FN-55/FN-56 removal documented at L1855. The script doesn't exist anymore but the note explaining the historical exclusion category still has documentary value.
   - **Could be tightened** to "(scripts/prime-test-session.js — deleted in #320, historical context)" but this is below the threshold for a Phase 0 fold-back. Trivial polish for whatever next test-plan revision touches §6.

2. **`tests/workbench-test-plan-ui.md:1855`** — Phase 6b reviewer-disposition note describing how `main()` was identified as living in `prime-test-session.js`.
   - Accurate at the time it was written; serves as the audit trail for the FN inventory correction. Historical record.
   - **Acceptable as-is.**

3. **`tests/helpers/browser-coverage.js:52, 56`** — coverage filter that excludes URLs containing `jquery` (alongside `xterm` and `addon`).
   - Dead filter rule (jquery is gone). Harmless because there are no longer any jquery URLs to filter.
   - **Could be removed** as part of a future test-helpers cleanup, but doesn't actively cause incorrect behavior. Below the threshold.

None of these would have changed my Round 1 disposition. They're fair to defer.

### F.4 Work Summary self-modifications

The work summary itself underwent an anti-staleness refactor across 9 doc-only commits (`d5cef11`, `c43454f`, `8359780`, `3dd5d2d`, `081bbcf`, `48640ea`, `45467dc`, `5f0c560`, `77aa7e6`). The pattern is consistent:

- HEAD SHA pins → replaced with "run `git rev-parse --short phase-0-verify`"
- Diff-stat pins → replaced with "run `git diff --shortstat main..phase-0-verify`"
- File-count pin → updated to ≥-style ("≥ 7 files; 10 today")
- Self-referential commit-chain hash → replaced with `git log main..phase-0-verify --oneline` reference

This is the right shape for a living gate doc that gets updated post-merge. My Round 1 nit on the diff-stat inaccuracy spawned a thoughtful general-case fix rather than a one-line patch; the work summary is now self-maintaining.

### F.5 Items the developer disclosed that the reviewers missed

The work summary discloses three Phase-1-deferred items that were surfaced during developer's own UI verification, NOT by any of the three reviewers:

- **#402**: showErrorBanner `insertBefore NotFoundError` every 60s (real production bug).
- **#403**: Password fields not in form (Chrome DOM warnings from Settings modal API key fields).
- **#404**: `#jqft-tree` element ID rename (vestigial jQuery prefix that survives the deletion).

The disclosure is worth calling out: the developer's UI verification at the deployed site found bugs that none of the three reviewers' static analyses surfaced. The reviews were diff-focused; the deployed-state checks caught runtime symptoms. This is healthy gate hygiene — neither static nor dynamic verification would catch all of these alone.

**No criticism here** — the reviewers (myself included) reviewed what they were asked to review (the diff). Surfacing the dynamic-verification finds in the work summary's "Items the reviewers did NOT find" section is exactly the right move for audit-trail honesty per memory `feedback_no_punted_followups.md`.

### F.6 Final Round-2 disposition

**PASS.**

All consensus findings are folded comprehensively. All single-CLI findings are dispositioned correctly (folded if applicable, accepted-with-documentation otherwise, or filed for Phase 1 with concrete issues). The two Codex-flagged active test failures (live SRV-02 and browser file-browser) are actively fixed in the test code, not just deferred. The work summary's self-staleness was addressed by a pattern fix rather than a one-shot patch.

Phase 0 is ready to merge. The 13 PRs (12 cleanup + Q7) close 17 work issues + the gate issue (#389). The 3 Phase-1-deferred items (#402/#403/#404) plus the 1 Phase-1 coverage issue (#411) are filed.

Recommend the user grants permission to merge.

— end of Round 2 Claude review
