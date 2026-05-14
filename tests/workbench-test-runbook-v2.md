# Workbench UI Test Runbook (v2 — working draft)

## Status

This file is the v2 rewrite of the Workbench UI Test Runbook, authored on milestone #7 (UI runbook refactor). It lives at `tests/workbench-test-runbook-v2.md` for the duration of milestone #7. At project close it swaps places with `tests/workbench-test-runbook.md`. Until then, the legacy `workbench-test-runbook.md` remains the operating runbook and serves as a reference comparator for review.

Section 1 (Baseline UI Smoke) is authored in this commit (step 3a.1 of milestone #7). Sections 2+ (feature groups) are added in subsequent step 3a.N iterations per the milestone plan.

## Target binding

The runbook is environment-agnostic. The orchestrator binds these placeholders at run time:

- `${WORKBENCH_URL}` — base URL of the workbench under test (e.g. `https://aristotle9-agentic-workbench-test.hf.space`)
- `${WORKBENCH_CONTAINER}` — Docker container name on the host running the deployment under test
- `${WORKBENCH_HOST}` — `user@host` reachable via SSH for setup actions (container restart, fresh-`/data` reset)
- `${GATE_USER}` / `${GATE_PASS}` — gate credentials if the deployment is HF-gated; empty otherwise

Anywhere a test step says `${WORKBENCH_URL}/...` or names the container, substitute the run-time value. The runbook itself never names a specific port, hostname, or container name in the runnable steps.

## Meta

- **Target:** `${WORKBENCH_URL}` (per-run binding above)
- **Login:** `${GATE_USER}` / `${GATE_PASS}` if the deployment is gated; otherwise direct
- **Tool:** Playwright MCP (synthetic mouse + keyboard + screenshot in a headless Chromium); Hymie remote-desktop only for native-OS dialogs the browser cannot drive
- **Container user:** `workbench` (UID 1000)
- **Workspace path:** `/data/workspace`
- **MCP tools:** the workbench's flat MCP tool set (per `mcp-tools.js` registry)
- **Settings tabs:** General, Claude Code, Vector Search, System Prompts
- **CLI types:** Claude, Gemini, Codex (selected via the `+` dropdown on a project header)
- **Test plan:** `tests/workbench-test-plan-ui.md`
- **Scope authority:** [PROC-003](../../../workspace/repos/Admin/docs/process/PROC-003-test-scope-matrix.md) (which entries run for which change type)
- **Execution policy:** [PROC-002](../../../workspace/repos/Admin/docs/process/PROC-002-test-execution-policy.md) (no SKIP; baseline runs for every code change)
- **Execution procedure:** [PROC-004](../../../workspace/repos/Admin/docs/process/PROC-004-runbook-execution-guide.md) (orchestrator + executor pattern; per-run subdir + manifest)
- **Verify-clause contract:** [STD-003 §12.5](../../../workspace/repos/Admin/docs/standards/STD-003-test-plan-standard.md) (positive-affirmation observables) + §12.6 (agent affirmation + screenshot) + §12.7 (virtual mouse / keyboard / monitor only) + §12.8 (timing-bounded clauses) + §12.9 (performance bias default)

## How to use this runbook

**The only PASS is a positive, complete affirmation of success. Anything else is a FAIL.**

A result of "unknown," "empty," "0," "null," "not found," "expected behavior," "will populate later," or any non-positive outcome is a FAIL. There are no partial passes. There is no "works but shows wrong data." There is no "expected on first load." If the user would see something broken, blank, missing, or wrong, it is a FAIL.

**SKIP is not a valid result.** Per PROC-002, every in-scope test runs and is recorded as PASS or FAIL with a filed issue on FAIL. Entries excluded by the test scope matrix for the current change type do not appear in the executor briefing at all — they are out of scope, not skipped at runtime. Neither the executor nor the orchestrator has authority to skip an in-scope entry.

Every entry in this runbook is runnable on the standard Workbench executor (Playwright MCP for UI; SSH + `docker exec` for setup state on the deployed container; Hymie remote desktop when the bug needs a real OS-level mouse/keyboard/screen). If a test appears unrunnable: investigate why, file an issue, mark FAIL. "I don't have the tool" is wrong — you do.

Aggregate results that bundle multiple tests into a single PASS line are forbidden. "Exercised-elsewhere" footnotes that mark untested entries as PASS are forbidden. One test ID, one explicit result, one set of assertions specific to that entry (PROC-004 Principle 6).

Execution order:

1. Run Section 1 (Baseline UI Smoke) first. All eight SMOKE-* entries must PASS before any feature-group section runs. Any FAIL stops Gate C immediately.
2. Run the in-scope feature-group sections per the executor briefing (matrix-derived).
3. For each entry: drive the steps via virtual mouse/keyboard; capture a screenshot per numbered assertion; record an explicit positive affirmation referencing the screenshot in the results file.
4. On any FAIL: file a GitHub issue per the Issue Filing Protocol below; continue to the next entry unless the failure blocks downstream entries.

## Tooling constraints (STD-003 §12.7 — §12.9)

Verify mechanisms are virtual mouse, virtual keyboard, and virtual monitor (screenshot) only. A UI test replicates the user experience. The user has three I/O channels with the machine; the test uses the same three.

**Allowed for verification:**
- Synthetic clicks: `browser_click` against rendered elements.
- Synthetic keystrokes: `browser_type`, `browser_press_key`.
- Screenshots: `browser_take_screenshot`. The agent reads the rendered image and affirms the observable in plain text against it.
- Screenshot polling: capture repeatedly between a triggering action and a time bound; identify the first frame on which the affirmation holds; record elapsed time.

**Forbidden as verify mechanisms:**
- Internal application state reads. `term.buffer.active.getLine(...)`, `tabs.get(activeTabId).ws.readyState`, `document.querySelector(...).textContent` extraction, framework-state introspection, or any `browser_evaluate` that reads the model rather than the rendered view.
- Backend probes. `curl /api/...`, `fetch(...)`, `gh api`, direct HTTP requests that bypass the click-driven path the user would take.
- Host-side state. File reads, DB queries, log scrapes, `tmux capture-pane`, `docker exec` peeks at container state.

These forbidden mechanisms remain useful as **diagnostic** tools during debugging — they help the agent understand why something looks broken. They are not verify mechanisms. A verify clause passes only when the agent affirms the rendered view against a screenshot.

**Setup and trigger actions** are not verify mechanisms. The runbook may legitimately use `docker exec` to reset state before an entry, an MCP `session_new` call to create a session whose render is then verified, or a Playwright `context.setOffline(true)` to simulate a disconnect. The verify itself, in every case, is screenshot-based observation of the resulting rendered state.

**Timing bounds (§12.8).** Verify clauses for action → response observables carry a time budget:
- **Bounds ≥1s** (sidebar update, status bar refresh, modal open, file render, response landing): screenshot polling. Capture frames between the trigger and the bound; the first frame meeting the affirmation passes; the verify line FAILs if the bound is exceeded.
- **Sub-second bounds** (animation smoothness, paint timing): `performance.now()` / `PerformanceObserver` via `browser_evaluate`. The observable being measured is duration, not rendered content. §12.7's prohibition on internal-state reads applies to content verification, not to duration measurement.

**Performance bias default (§12.9).** Most verify clauses describe a state that emerged in response to a user action; those clauses carry a timing bound. Exceptions:
- **Static content reads.** Identity/configuration/text visible at rest, after a prior bounded clause has established the surface is rendered.
- **Cascading assertions on the same render.** When a prior bounded clause established the surface is rendered within bound N, subsequent assertions on that same render cite the upstream bound rather than restating it.
- **Explicit no-time-dimension justification.** Visual layout correctness independent of when the layout rendered, for example. Justify inline in the entry.

## Tier-1 CLI assumption (applies to Section 1)

The three CLIs under test (claude, gemini, codex) are Tier-1 production tools. Their realistic failure modes are binary: either the CLI is alive and producing a coherent response to a simple prompt, or it is visibly broken — login screen, connection-refused banner, crash dialog, empty pane, response never arriving within the timing bound.

Gibberish responses to simple prompts (e.g., "sixty-three" returned for "what is 7 times 8") are not realistic failure modes the baseline smoke tests for. If a Tier-1 CLI returned gibberish to arithmetic, the issue would not be a Workbench-surface failure — it would be a model-level failure visible to every user of the CLI. The smoke's role is to verify the **surfaces** (session creation, prompt transmission, response render, tab state, status bar, WebSocket, file browser, settings) — not to evaluate the LLM's reasoning.

The chat content assertion therefore uses agent judgment from the screenshot: the response visibly answers the prompt. For "what is 7 times 8," that means a rendered response containing "56" (digits or written form). A login prompt, error banner, empty area, or hung indicator in place of a response is FAIL.

## Prerequisites

### Where to run

Tests run against a deployed container or HF Space — never against a host-machine clone of the repo. The host that holds this repo may be a prod or dev workbench host (M5, irina); its database, webhook config, qdrant, and tmux state belong to the running workbench, not to a test harness. Running `npm test`, `npm run test:coverage`, or any ad-hoc `node -e` that imports a project module from the host shell will collide with the live deployment.

**Allowed:**
- `ssh ${WORKBENCH_HOST} 'docker exec -i ${WORKBENCH_CONTAINER} sh -c "cd /app && npm test"'` — suite runs inside the deployed container's own filesystem and DB.
- Playwright MCP (driven from inside this Claude Code session) pointed at `${WORKBENCH_URL}`. The Playwright MCP runs Chromium against an HTTP target; it never imports server code.
- Hymie / Hymie2 remote desktops with real Firefox, for headed checks against `${WORKBENCH_URL}` when the bug needs OS-level rendering or input handling that headless cannot replicate.

**Not allowed from the host shell of a workbench-running machine:**
- `npm test` / `npm run test:coverage` / `npm run test:live` / `npm run test:browser`
- `node --test`, `c8`, `nyc`
- `node -e` snippets that `require('./db.js')`, `./mcp-tools.js`, `./session-utils.js`, etc.

### Standard prereqs (verify before starting)

1. **Workbench reachable:** `browser_navigate` to `${WORKBENCH_URL}` loads the page (gate page if a gate is configured, otherwise the workbench shell).
2. **Login (if gate present):** fill `${GATE_USER}` / `${GATE_PASS}`, click Sign In. Skip if no gate.
3. **Seed project present:** a project named `wb-seed` exists in the sidebar (visible in the project list). If not, create it via the Add Project flow before starting Section 1 — the SMOKE-CHAT-01 entry depends on it.
4. **Phase 0 decision:** Phase 0 (Fresh Container + CLI Authentication) runs only when the run requires a new container (release-gate fresh-`/data` assertions, or any milestone whose change set touches `entrypoint.sh` / `Dockerfile`), or when the run is testing authentication specifically. Otherwise baseline executes against the existing authenticated deployment and Section 1 assumes CLI auth is already seated. If auth is missing when Section 1 starts, that is a Phase 0 failure, not a baseline failure.

## Issue filing protocol

On any FAIL:

1. **Capture.** The screenshot for the failing assertion is already captured (taken at the moment of verification). It lives in the per-run subdir at the assertion's defined path.
2. **Collect.** Note the entry ID, the assertion number, the expected observable, the observed observable (described in plain text against the screenshot), any visible console errors (visible in DevTools strip if the executor has it open), and the relevant browser network state if relevant.
3. **File.** Create a GitHub issue with the failing entry's ID, the milestone the run belongs to, and the screenshot attached:

   ```bash
   gh issue create \
     --repo rmdevpro/agentic-workbench \
     --title "[UI test] <ENTRY-ID>#<assertion-n>: <brief failure description>" \
     --label "type=bug,reviewer-finding,source=ui-test,severity=blocker" \
     --milestone "<milestone-name>" \
     --body "$(cat <<'EOF'
   **Entry:** <ENTRY-ID>
   **Assertion:** #<assertion-n>: <text of the failed verify line>
   **Expected:** <the observable the assertion required>
   **Observed:** <plain-text description of what the screenshot actually shows>
   **Screenshot:** <relative path inside the per-run subdir>
   **Run ID:** <run-id>
   **Manifest:** <path to per-run manifest.json>
   EOF
   )"
   ```

A Section 1 (Baseline UI Smoke) FAIL is severity=blocker by default and stops the rest of the run. Feature-group FAILs continue to the next entry unless the failure cascades (e.g., a missing tab from a failed session create poisons downstream tab assertions; those are noted as cascading FAILs in the results file but each gets its own issue).

Results, manifests, and screenshots for a run land under `/mnt/storage/dev_artifacts/agentic-workbench/<milestone-slug>/runbook-runs/<run-id>/` per PROC-004's manifest schema. The `<run-id>` is `<ISO-timestamp>_<short-commit-sha>`. Screenshots referenced by entry assertions below are relative paths within that per-run subdir.

## Sections

The runbook is organized into sections by surface area. Section 1 (Baseline UI Smoke) is mandatory for every code change in scope (PROC-003 §2). Sections 2+ run when the matrix puts their surface in scope (PROC-003 §4, §5).

1. **Baseline UI Smoke** — 8 SMOKE-* entries. Mandatory floor for every code-change Gate C run.
2. **Core sessions and projects** — session CRUD, sidebar, project management. *(Pending — added in step 3a.2.)*
3. **Features** — file browser, tasks, plan files. *(Pending.)*
4. **CLI and terminal** — terminal I/O, multi-CLI behavior, tmux lifecycle. *(Pending.)*
5. **Settings and Vector Search** — Settings modal tabs, Qdrant flows. *(Pending.)*
6. **Multi-CLI and MCP** — multi-CLI session interleave, MCP server management. *(Pending.)*
7. **Comprehensive feature verification** — broad end-to-end flows. *(Pending.)*
8. **Regression coverage** — REG-* entries permanent from prior fix landings. *(Pending — carry-forward from legacy runbook in step 3a.N.)*

Numbering and section boundaries finalize as each step lands. Section 1 is stable from this commit forward.

---

## Section 1: Baseline UI Smoke

Section 1 runs first in every Gate C invocation, regardless of which surfaces the change set touched. Failure of any SMOKE-* entry stops the rest of Gate C immediately and files a blocker `reviewer-finding` per PROC-003 §2.

Entries run in execution order — later entries depend on state established by earlier ones (SMOKE-TABS-01 operates on the three tabs SMOKE-CHAT-01 opened; SMOKE-STATUS-01 reads the status bar for the tab SMOKE-TABS-01 left active). Running out of order produces false negatives.

| ID | Surface (PROC-003 §2) |
|---|---|
| SMOKE-CHAT-01 | 1 — Three-CLI chat |
| SMOKE-MCP-01 | 2 — Session from MCP |
| SMOKE-PROJ-01 | 3 — Project create |
| SMOKE-TABS-01 | 4 — Tab management |
| SMOKE-STATUS-01 | 5 — Status bar renders |
| SMOKE-WS-01 | 6 — WebSocket connect + reconnect |
| SMOKE-FILES-01 | 7 — File browser |
| SMOKE-SETTINGS-01 | 8 — Settings modal |

The Tier-1 CLI assumption stated in the preamble applies throughout Section 1. Failure modes are binary: surface works, or surface is visibly broken.

---

### SMOKE-CHAT-01: Three-CLI one-shot chat

**Source:** PROC-003 §2 — Surface 1
**Priority:** Baseline (FAIL stops Gate C)

**Setup:** browser at `${WORKBENCH_URL}`, gate passed if applicable, sidebar shows the `wb-seed` project, no tabs open. Phase 0 has either run (fresh container + auth) or has been excluded as not necessary (existing deployment, auth seated).

**Steps:** for each `<cli>` in the sequence `[claude, gemini, codex]`, run the following block. Same flow per CLI — no per-CLI branches.

1. Click the `+` button on the `wb-seed` project header in the sidebar.
2. The CLI dropdown appears. Click the row corresponding to `<cli>` (the row labeled "Claude," "Gemini," or "Codex" — never a `Terminal` row).
3. The session-create overlay appears. Type session name `smoke-chat-<cli>` into the name field.
4. Click Start (or press Enter). The overlay closes; a new tab opens labeled with the session name.
5. Wait for the per-CLI ready observable to appear in the terminal pane. Capture screenshots at 2s intervals up to a 60s bound. The ready observable is concrete per CLI:
   - **claude:** the Claude input box is visible at the bottom of the pane (boxed input area with cursor blinking, prompt-line glyph).
   - **gemini:** the Gemini `>` prompt is visible at the start of a new line at the bottom of the pane, with the cursor positioned after it.
   - **codex:** the Codex input field is visible at the bottom of the pane (rectangular input box with cursor positioned inside it).
   Identify the first frame where the corresponding ready observable is rendered.
6. With the new tab focused, type the prompt `what is 7 times 8` into the terminal (use the terminal's input-handling — the same keystroke path a user would use; do not send to the WebSocket directly via internal JS).
7. Press Enter.
8. Wait for the response to render in the pane. Capture screenshots at 2s intervals up to a 30s bound. Identify the first frame where a coherent response is visible in the response area of that tab's pane. A coherent response contains "56" (the digit pair) or "fifty-six" (written form), in the response output area below the prompt echo.
9. Wait up to a 5s bound for the input prompt indicator (same observable as step 5) to reappear at the bottom of the pane after the response, indicating the CLI is ready for the next prompt.

After all three CLIs complete the block, three tabs are open in the tab bar; subsequent SMOKE entries operate on this state.

**Verify (numbered assertions — each requires a screenshot affirmation):**

1. After Start click for claude, a tab labeled `smoke-chat-claude` is visible in the tab bar within 2s. → `SMOKE-CHAT-01/assertion-01-claude-tab-present.png`
2. The claude ready observable (boxed input box at pane bottom) is visible within 60s of Start. → `SMOKE-CHAT-01/assertion-02-claude-ready.png`
3. A coherent response containing "56" is visible in the claude tab's response area within 30s of prompt Enter. → `SMOKE-CHAT-01/assertion-03-claude-response.png`
4. The claude ready observable reappears at the pane bottom within 5s of the response landing. → `SMOKE-CHAT-01/assertion-04-claude-ready-again.png`
5. After Start click for gemini, a tab labeled `smoke-chat-gemini` is visible in the tab bar within 2s. → `SMOKE-CHAT-01/assertion-05-gemini-tab-present.png`
6. The gemini ready observable (`>` prompt at start of new line with cursor after it) is visible within 60s of Start. → `SMOKE-CHAT-01/assertion-06-gemini-ready.png`
7. A coherent response containing "56" is visible in the gemini tab's response area within 30s of prompt Enter. → `SMOKE-CHAT-01/assertion-07-gemini-response.png`
8. The gemini ready observable reappears at the pane bottom within 5s of the response landing. → `SMOKE-CHAT-01/assertion-08-gemini-ready-again.png`
9. After Start click for codex, a tab labeled `smoke-chat-codex` is visible in the tab bar within 2s. → `SMOKE-CHAT-01/assertion-09-codex-tab-present.png`
10. The codex ready observable (input field at pane bottom with cursor in it) is visible within 60s of Start. → `SMOKE-CHAT-01/assertion-10-codex-ready.png`
11. A coherent response containing "56" is visible in the codex tab's response area within 30s of prompt Enter. → `SMOKE-CHAT-01/assertion-11-codex-response.png`
12. The codex ready observable reappears at the pane bottom within 5s of the response landing. → `SMOKE-CHAT-01/assertion-12-codex-ready-again.png`

**Failure mode:** any assertion failing stops Gate C immediately. Tester files a blocker reviewer-finding citing the assertion number; attaches the screenshot from the per-run subdir.

---

### SMOKE-MCP-01: Session create from MCP

**Source:** PROC-003 §2 — Surface 2
**Priority:** Baseline (FAIL stops Gate C)

**Setup:** browser at `${WORKBENCH_URL}` with sidebar visible; the three `smoke-chat-*` tabs from SMOKE-CHAT-01 are open; the executor's MCP toolset has `mcp__workbench__session_new` available.

**Steps:**

1. From the executor (not the browser), invoke `mcp__workbench__session_new` with `{project: "wb-seed", cli: "claude", prompt: "echo smoke-mcp ready"}` (or the project's equivalent CLI; choose claude for determinism here).
2. The MCP call returns; record the returned `session_id`. This is a trigger action, not a verify mechanism.
3. Return focus to the browser. Capture screenshots at 1s intervals up to a 5s bound on the sidebar.
4. Click the new session row in the sidebar. The session opens as a new tab in the tab bar.

**Verify (numbered assertions):**

1. Within 5s of the MCP `session_new` call returning, a session row labeled with the name the MCP call set (or, if the call did not set a name, a row labeled with the returned `session_id`) appears under the `wb-seed` project in the sidebar. → `SMOKE-MCP-01/assertion-01-sidebar-renders-session.png`
2. Within 2s of clicking the new session row, a new tab labeled with the same session name opens in the tab bar and is the active tab. → `SMOKE-MCP-01/assertion-02-tab-opens.png`

**Failure mode:** any assertion failing stops Gate C. Tester files a blocker reviewer-finding citing the assertion number.

---

### SMOKE-PROJ-01: Project create

**Source:** PROC-003 §2 — Surface 3
**Priority:** Baseline (FAIL stops Gate C)

**Setup:** browser at `${WORKBENCH_URL}` with sidebar visible. No project named `smoke-proj-<timestamp>` exists. The Tester uses a timestamp suffix to guarantee uniqueness across reruns: `smoke-proj-YYYYMMDD-HHMMSS`.

**Steps:**

1. Click the Add Project affordance (the `+ Project` button or equivalent at the top of the sidebar).
2. The project-create modal appears.
3. Type `smoke-proj-<timestamp>` into the name field.
4. Type `/data/workspace/smoke-proj-<timestamp>` into the path field.
5. Click Save.
6. The modal closes; the sidebar refreshes.
7. Click the new project's row in the sidebar to select it.

**Verify (numbered assertions):**

1. Within 1s of clicking Add Project, the project-create modal is visible with a heading naming the create action ("Create Project," "Add Project," or equivalent). → `SMOKE-PROJ-01/assertion-01-modal-visible.png`
2. Within 2s of clicking Save, the project-create modal is no longer visible. → `SMOKE-PROJ-01/assertion-02-modal-dismissed.png`
3. Within 5s of clicking Save, a project entry labeled `smoke-proj-<timestamp>` is visible in the sidebar. → `SMOKE-PROJ-01/assertion-03-project-in-sidebar.png`
4. Within 1s of clicking the new project's row, the project row shows a selected/active visual state (highlight, background tint, or per-product selection styling), distinct from unselected sibling project rows. → `SMOKE-PROJ-01/assertion-04-project-selected.png`

**Failure mode:** any assertion failing stops Gate C.

---

### SMOKE-TABS-01: Tab management (open + switch + close)

**Source:** PROC-003 §2 — Surface 4
**Priority:** Baseline (FAIL stops Gate C)

**Setup:** the three `smoke-chat-{claude,gemini,codex}` tabs from SMOKE-CHAT-01 are open in the tab bar. The codex tab is the most recently created and is the active tab.

**Steps:**

1. Observe the tab bar — three tabs visible; the codex tab visually marked as active (border, background tint, indicator dot, or per-product active styling).
2. Click the claude tab in the tab bar.
3. Observe — claude tab visually marked as active; codex tab no longer active.
4. Click the gemini tab in the tab bar.
5. Observe — gemini tab active.
6. Click the close affordance (the `×` glyph on the tab) on the claude tab.
7. Observe — claude tab no longer in the tab bar; codex and gemini tabs remain.

**Verify (numbered assertions):**

1. With three `smoke-chat-*` tabs open after SMOKE-CHAT-01, the tab bar shows exactly the three labeled `smoke-chat-claude`, `smoke-chat-gemini`, `smoke-chat-codex`, with `smoke-chat-codex` in the active visual state. *(Cascades from SMOKE-CHAT-01's per-tab Start bounds — no separate time bound.)* → `SMOKE-TABS-01/assertion-01-three-tabs-codex-active.png`
2. Within 1s of clicking the claude tab, the claude tab shows the active visual state and the codex tab no longer does. → `SMOKE-TABS-01/assertion-02-claude-active-after-switch.png`
3. Within 1s of clicking the gemini tab, the gemini tab shows the active visual state. → `SMOKE-TABS-01/assertion-03-gemini-active-after-switch.png`
4. Within 2s of clicking the claude tab's close affordance, the claude tab is no longer present in the tab bar; codex and gemini tabs remain. → `SMOKE-TABS-01/assertion-04-claude-tab-closed.png`

**Failure mode:** any assertion failing stops Gate C.

---

### SMOKE-STATUS-01: Status bar renders

**Source:** PROC-003 §2 — Surface 5
**Priority:** Baseline (FAIL stops Gate C)

**Setup:** after SMOKE-TABS-01, two tabs remain (codex, gemini). The gemini tab is active (most recently clicked). The status bar is visible at the bottom (or wherever the product positions it) of the workbench shell.

**Steps:**

1. With the gemini tab active, observe the status bar.
2. Click the codex tab.
3. Observe the status bar after the active tab change.

**Verify (numbered assertions):**

1. With the gemini tab active, the status bar shows a non-empty model name string (e.g. `gemini-2.5-pro`, `gemini-1.5-flash`, or whatever the gemini CLI reports) within 2s of the gemini tab becoming active. → `SMOKE-STATUS-01/assertion-01-gemini-model-name.png`
2. With the gemini tab active, the status bar shows a context usage indicator — a numeric value followed by `%` (e.g. `12%`, `0%`) — within 2s of the gemini tab becoming active. *(Cascades from assertion 1 — same render.)* → `SMOKE-STATUS-01/assertion-02-gemini-context-pct.png`
3. With the gemini tab active, the status bar shows a connection indicator in a visually-distinct "connected" state (per-product styling — a green dot, a "Connected" label, an unbroken-link icon, etc.) within 2s. *(Cascades from assertion 1 — same render.)* → `SMOKE-STATUS-01/assertion-03-gemini-connection-indicator.png`
4. Within 2s of clicking the codex tab, the status bar's model name string updates to reflect the codex session's model (visibly different from the gemini model name in assertion 1). → `SMOKE-STATUS-01/assertion-04-codex-model-name.png`

**Failure mode:** any assertion failing stops Gate C.

---

### SMOKE-WS-01: WebSocket connect + reconnect

**Source:** PROC-003 §2 — Surface 6
**Priority:** Baseline (FAIL stops Gate C)

**Setup:** the codex tab from SMOKE-STATUS-01 is active. The status bar's connection indicator is in the "connected" visual state. The Playwright session supports `browser_context.setOffline(true)` (or `cdp.send('Network.emulateNetworkConditions', ...)`) for the network disruption — this simulates a real disconnect at the browser network layer, not in-app state manipulation.

**Steps:**

1. Observe the status bar — connection indicator in "connected" visual state for the codex tab.
2. Invoke Playwright `context.setOffline(true)` (or equivalent network-layer disconnect).
3. Wait, capturing screenshots at 1s intervals up to a 5s bound.
4. Invoke Playwright `context.setOffline(false)` to restore the network.
5. Wait, capturing screenshots at 1s intervals up to a 10s bound.

**Verify (numbered assertions):**

1. At rest, with the codex tab active, the status bar shows the connection indicator in the "connected" visual state. *(Cascades from SMOKE-STATUS-01 assertion 3 / 4 — same render bound applies.)* → `SMOKE-WS-01/assertion-01-connected.png`
2. Within 5s of `setOffline(true)`, the status bar's connection indicator transitions to the "disconnected" visual state (per-product styling — red dot, "Disconnected" label, broken-link icon, banner, or similar). → `SMOKE-WS-01/assertion-02-disconnected.png`
3. Within 10s of `setOffline(false)`, the status bar's connection indicator returns to the "connected" visual state from assertion 1. → `SMOKE-WS-01/assertion-03-reconnected.png`

**Failure mode:** any assertion failing stops Gate C.

---

### SMOKE-FILES-01: File browser

**Source:** PROC-003 §2 — Surface 7
**Priority:** Baseline (FAIL stops Gate C)

**Setup:** browser at `${WORKBENCH_URL}`; the workbench shell renders; the Files panel is either visible by default or accessible via a panel toggle / Files affordance in the sidebar.

**Steps:**

1. If the Files panel is not already visible, click the Files affordance to open it.
2. Observe the file tree panel.
3. If the workspace root entry is not auto-expanded, click it to expand.
4. Observe the children of the workspace root.

**Verify (numbered assertions):**

1. Within 2s of clicking the Files affordance (or, if auto-visible, within 2s of page load), the file tree panel is visible. → `SMOKE-FILES-01/assertion-01-files-panel-visible.png`
2. The workspace root entry is visible at the top of the file tree (labeled with the workspace path or its trailing path component). *(Cascades from assertion 1.)* → `SMOKE-FILES-01/assertion-02-workspace-root-visible.png`
3. Within 2s of expanding the workspace root (or, if auto-expanded, immediately observable), at least one child entry — file or directory — is visible under the workspace root in the tree. → `SMOKE-FILES-01/assertion-03-at-least-one-child.png`

**Failure mode:** any assertion failing stops Gate C.

---

### SMOKE-SETTINGS-01: Settings modal

**Source:** PROC-003 §2 — Surface 8
**Priority:** Baseline (FAIL stops Gate C)

**Setup:** browser at `${WORKBENCH_URL}`; workbench shell rendered; the Settings affordance (gear icon, "Settings" menu entry, or product equivalent) is visible.

**Steps:**

1. Click the Settings affordance.
2. The settings modal appears.
3. Observe the tab strip at the top (or side) of the modal — it lists the configured settings tabs.
4. Click the Claude Code tab; observe the content area changes.
5. Click the Vector Search tab; observe the content area changes.
6. Click the close affordance (× glyph) on the modal (or press Escape).
7. The modal closes.

**Verify (numbered assertions):**

1. Within 1s of clicking the Settings affordance, the settings modal is visible (modal overlay covering the rest of the shell, with a recognizable Settings heading). → `SMOKE-SETTINGS-01/assertion-01-modal-visible.png`
2. The settings modal's tab strip shows at least the labels "General," "Claude Code," "Vector Search," and "System Prompts" (the four tabs per the Meta section above), all visible simultaneously. *(Cascades from assertion 1.)* → `SMOKE-SETTINGS-01/assertion-02-tabs-visible.png`
3. Within 1s of clicking the Claude Code tab, the modal's content area shows Claude-Code-specific controls (model selector, thinking mode, keepalive — whatever the current Claude Code tab contents are), visibly different from the General tab's content area. → `SMOKE-SETTINGS-01/assertion-03-claude-tab-content.png`
4. Within 1s of clicking the Vector Search tab, the modal's content area shows Vector-Search-specific controls, visibly different from the Claude Code tab. → `SMOKE-SETTINGS-01/assertion-04-vector-tab-content.png`
5. Within 1s of clicking the modal's close affordance (or pressing Escape), the settings modal is no longer visible. → `SMOKE-SETTINGS-01/assertion-05-modal-dismissed.png`

**Failure mode:** any assertion failing stops Gate C.

---

## Sections 2+: Feature groups (pending)

The feature-group sections — Core (sessions/projects), Features (file browser, tasks), CLI & Terminal, Settings & Vector Search, Multi-CLI & MCP, Comprehensive feature verification, and Regression coverage — are authored in subsequent step 3a.N iterations per milestone #7's plan.

Each section will be re-authored against STD-003 §12.7–§12.9: every verify clause replaced with screenshot-affirmable text against the rendered DOM; every internal-state read (`term.buffer.active`, `tabs.get(...).ws.readyState`, `document.querySelector(...).textContent`-driven verification) removed; every action → response assertion bounded per §12.8 / §12.9.

The legacy `tests/workbench-test-runbook.md` remains the operating runbook for any Gate C run between now and the project close. When this file's feature-group sections are complete, the swap to `tests/workbench-test-runbook.md` happens at project close per milestone #7's plan.

---

**Authored:** step 3a.1 of milestone #7 (UI runbook refactor), 2026-05-14.
**Source proposal:** `/mnt/storage/dev_artifacts/workbench/r1/plan/baseline-ui-smoke-proposal.md`.
**Round-1 findings folded:** #495–#514 against review-request #498. Specific defects addressed in this rewrite: `term.buffer.active` removed (§12.7); "Tester recognizes" wording replaced with concrete per-CLI ready observables (#504); chat content assertion strengthened to require coherent reply containing "56" per agent screenshot judgment (#501); numbered assertions cite-able by cell-6 grids; timing bounds applied per §12.8–§12.9; per-run subdir path aligned with PROC-004 `runbook-runs/` convention (#500).
