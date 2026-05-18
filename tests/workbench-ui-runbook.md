# Workbench UI Test Runbook

## Status

The Workbench UI test catalog. Process for running these tests lives in `PROC-009 — UI Test Process` (orchestrator/executor, vocabulary, tool constraints, screenshots, polling, intervention). Universal Tester rules (PASS-or-FAIL only, no SKIP, return verbatim) live in `roles/tester.md`. This file is the test catalog only — no process here.

## Target binding

The runbook is environment-agnostic. The Tester binds these placeholders at run time from the PM dispatch:

* `${WORKBENCH_URL}` — base URL of the workbench under test
* `${WORKBENCH_CONTAINER}` — Docker container name on the host running the deployment under test
* `${WORKBENCH_HOST}` — `user@host` reachable via SSH for setup actions (container restart, fresh-`/data` reset)
* `${GATE_USER}` / `${GATE_PASS}` — gate credentials if the deployment is HF-gated; empty otherwise

Anywhere a test step says `${WORKBENCH_URL}/...` or names the container, substitute the run-time value. The runbook itself never names a specific port, hostname, or container name in the runnable steps.

## Project facts

* **Container user:** `workbench` (UID 1100)
* **Workspace path:** `/data/workspace`
* **MCP tools:** the workbench's flat MCP tool set (per `mcp-tools.js` registry)
* **Settings tabs:** General, Claude Code, Vector Search, System Prompts
* **CLI types:** Claude, Gemini, Codex (selected via the `+` dropdown on a project header)
* **Test plan:** `tests/workbench-test-plan-ui.md` — the full UI test plan (Tester does not read this at run time)
* **Tools used:** Playwright MCP (headless Chromium) for every section except Section 0, which uses Hymie remote-desktop for the OAuth bootstrap

## Canonical input selectors (apply across every runbook entry)

Whenever a step says "type into X" or "send the prompt," the runbook MUST cite the specific user-visible input element selector — the same DOM element a user's keystrokes reach. Internal APIs (`term.paste(...)`, `term.write(...)`, `browser_evaluate` that calls into a framework's state, WebSocket payload injection) are FORBIDDEN as input mechanisms. Per `feedback_no_fabricated_ui_flows.md`: calling underlying JS to deliver input and then claiming "I typed it" is a fabricated UI flow; the test must drive the real affordance.

The canonical selectors:

| Surface | Selector (within the active pane) | Playwright primitive | Submit affordance |
| ------- | --------------------------------- | -------------------- | ----------------- |
| Terminal pane (claude / gemini / codex CLI session) | `#pane-<tabId> .xterm-helper-textarea` — xterm.js's hidden input textarea that receives keystrokes for the canvas. A real `<textarea>` element; `browser_type` drives it directly. | `browser_type` (multi-character) or `browser_press_key` (single-key, named keys like Enter) on the focused element | Press Enter — the keystroke flows through xterm → PTY → tmux → CLI. There is no separate Send button. |
| File / doc tab (text editor) | `#pane-<tabId> .cm-editor [contenteditable="true"]` for CodeMirror; per-file selector for other editor types | `browser_type` after `browser_click` to focus | Editor-defined (Ctrl+S save shortcut, save button in the toolbar) |
| Sidebar search | `#session-search` | `browser_type` | None — filters reactively |
| Modal text inputs (project create, session config, etc.) | The modal's named input field — selector is per-modal (e.g. `#project-create-modal input[name="name"]`) | `browser_type` | The modal's Save / Submit button — click it |

For terminal panes specifically: the xterm canvas is the OUTPUT surface, not the input. `browser_type` against `#pane-<tabId>` (the canvas's parent div) OR against `#terminal-area` directly FAILS with `Element is not an <input>... and does not have a role allowing [aria-readonly]` — that's the wrong target. The xterm.js `xterm-helper-textarea` inside the pane is the input. The Tester verifies this by confirming `.xterm-helper-textarea` exists in the rendered DOM (a known xterm.js v5 structural element — see `public/lib/xterm/lib/xterm.js`) before typing.

## Tier-1 CLI assumption (applies to Section 1)

The three CLIs under test (claude, gemini, codex) are Tier-1 production tools. Their realistic failure modes are binary: either the CLI is alive and producing a coherent response to a simple prompt, or it is visibly broken — login screen, connection-refused banner, crash dialog, empty pane, response never arriving within the timing bound.

Gibberish responses to simple prompts (e.g., "sixty-three" returned for "what is 7 times 8") are not realistic failure modes the baseline smoke tests for. If a Tier-1 CLI returned gibberish to arithmetic, the issue would not be a Workbench-surface failure — it would be a model-level failure visible to every user of the CLI. The smoke's role is to verify the **surfaces** (session creation, prompt transmission, response render, tab state, status bar, WebSocket, file browser, settings) — not to evaluate the LLM's reasoning.

The chat content assertion therefore uses agent judgment from the screenshot: the response visibly answers the prompt. For "what is 7 times 8," that means a rendered response containing "56" (digits or written form). A login prompt, error banner, empty area, or hung indicator in place of a response is FAIL.

## Prerequisites

### Where to run

Tests run against a deployed container or HF Space — never against a host-machine clone of the repo. The host that holds this repo may itself be running a workbench deployment; its database, webhook config, qdrant, and tmux state belong to that running workbench, not to a test harness. Running `npm test`, `npm run test:coverage`, or any ad-hoc `node -e` that imports a project module from the host shell will collide with the live deployment.

**Allowed:**

* `ssh ${WORKBENCH_HOST} 'docker exec -i ${WORKBENCH_CONTAINER} sh -c "cd /app && npm test"'` — suite runs inside the deployed container's own filesystem and DB.
* Playwright MCP (driven from inside this Claude Code session) pointed at `${WORKBENCH_URL}`. The Playwright MCP runs Chromium against an HTTP target; it never imports server code.
* Hymie / Hymie2 remote desktops with real Firefox — used **only in Section 0** for the OAuth bootstrap. Not used in any other section.

**Not allowed from the host shell of a workbench-running machine:**

* `npm test` / `npm run test:coverage` / `npm run test:live` / `npm run test:browser`
* `node --test`, `c8`, `nyc`
* `node -e` snippets that `require('./db.js')`, `./mcp-tools.js`, `./session-utils.js`, etc.

### Standard prereqs (verify before starting)

1. **Workbench reachable:** `browser_navigate` to `${WORKBENCH_URL}` loads the page (gate page if a gate is configured, otherwise the workbench shell).
2. **Login (if gate present):** fill `${GATE_USER}` / `${GATE_PASS}`, click Sign In. Skip if no gate.
3. **Seed project present:** a project named `wb-seed` exists in the sidebar (visible in the project list). If not, create it via the Add Project flow before starting Section 1 — the SMOKE-CHAT-01 entry depends on it.
4. **Phase 0 decision:** Phase 0 (Fresh Container + CLI Authentication) runs only when the run requires a new container (release-gate fresh-`/data` assertions, or any milestone whose change set touches `entrypoint.sh` / `Dockerfile`), or when the run is testing authentication specifically. Otherwise baseline executes against the existing authenticated deployment and Section 1 assumes CLI auth is already seated. If auth is missing when Section 1 starts, that is a Phase 0 failure, not a baseline failure.

## Sections

The runbook is organized into sections by surface area. Section 0 is the environment-and-auth precondition; it runs first on any fresh container, fresh `/data` volume, or when auth has changed. Section 1 (Baseline UI Smoke) is mandatory for every code change in scope (baseline surface list). Sections 2+ run when the matrix puts their surface in scope (per the project test plan).

1. **Environment Setup** — fresh container + OAuth bootstrap. Runs on a fresh `/data` volume, an auth-touched change, or an explicit auth regression. **Section 0 is the only section that uses Hymie** (for the OAuth flow). Every other section runs headless.
2. **Baseline UI Smoke** — 8 SMOKE-\* entries. Mandatory floor for every code-change Gate C run.
    2+. **Feature-group sections** — section per UI surface area, per the per-section preamble.

***

## Section 0: Environment Setup (required for every fresh-`/data` run; required when auth changes)

Section 0 prepares a clean, authenticated test environment for the rest of the runbook. It has TWO steps that always run together: first a fresh container, then OAuth on top.

**Execution mode for Section 0 is headed (Hymie).** Hymie appears nowhere else in this runbook. Every other section runs headless.

### 0.A: Fresh container (also covers REG-FRESH-01)

A fresh container with an empty `/data` volume must come up cleanly. This is the "Fresh Install Works" regression — by virtue of 0.A succeeding, REG-FRESH-01 PASSes for the run.

**Steps:**

1. On `${WORKBENCH_HOST}`: `docker run --rm -d --name workbench-test-fresh -v <ephemeral-volume>:/data -p <free-port>:7860 <image>` (or use a docker-compose entry that creates the ephemeral volume each run).
2. Bind `${WORKBENCH_URL}` to that container's port for this run.
3. Wait up to 30s for `/health` to return `{status:'ok'}`.
4. `browser_navigate` to `${WORKBENCH_URL}` — verify the empty-state UI renders, sidebar shows zero (or default-seeded) projects.
5. `docker exec ${WORKBENCH_CONTAINER} ls /data/.workbench/workbench.db` — DB file exists (entrypoint.sh + db.js migrations ran).
6. `docker exec ${WORKBENCH_CONTAINER} ls /data/workspace` — workspace dir created.
7. `curl ${WORKBENCH_URL}/api/state` — returns `{projects: []}` or default seeded projects without errors.

**Expected:** Container starts within 30s. /health green. UI loads. DB + workspace seeded. No 500s in initial requests.

**Result:** ☐ PASS ☐ FAIL

If 0.A FAILs: STOP — file an issue, do not proceed. Nothing downstream is meaningful without a working container.

### 0.B: Claude Authentication (required for Section 1+)

Claude CLI tests in Section 1 (SMOKE-CHAT-01 and the per-CLI smokes) require valid Claude credentials in the just-spawned container.

**Option A: Hymie desktop automation (full OAuth flow)**
Use Hymie MCP to automate the browser-based OAuth flow. This tests the actual auth pipeline end-to-end. Requires Hymie MCP server connected.

**Option B: Inject credentials from an authenticated device (with user permission)**
Copy the credentials file from a machine that already has valid Claude auth into the container.

```bash
# From the authenticated machine, copy credentials to the workbench container:
# 1. Read the local credentials
cat ~/.claude/credentials.json

# 2. Inject into the container via the terminal
# Open a terminal session in Workbench, then:
echo '<paste credentials JSON>' > ~/.claude/credentials.json
```

Ask the orchestrator which option to use. If neither is available, fix the auth path before proceeding — Section 1 tests will FAIL without auth.

**Result:** ☐ PASS ☐ FAIL

### 0.C: OAUTH-MODAL-CLAUDE-01 — Claude `/login` triggers OAuth modal with extracted URL

**Cascade-from:** 0.A
**Closes gap for:** #339

**Setup:**

1. 0.A complete (fresh container, /health green, empty-state UI rendered).
2. Hymie (or Hymie2) remote desktop is reachable via MCP. **0.C requires Hymie** — the Claude CLI's `/login` flow opens an OAuth window via the host browser; headless Chromium cannot drive the system-level OAuth handoff. This is the one mandatory Hymie entry in Section 0 (along with 0.D). All other entries in this runbook are headless.
3. From Hymie, open the desktop's default browser to `${WORKBENCH_URL}`. Pass the gate page if applicable. The workbench shell renders (sidebar + main panel visible).
4. **Precondition affirmation (§12.11 explicit Setup):** click the `⚙ Settings` button at the bottom of the sidebar; in the General tab, locate the `OAuth detection` settings group; screenshot-affirm the `Claude` checkbox is in the checked state (✓ glyph visible in the box); press Escape to close Settings. The 0.C trigger only fires the modal if this toggle is ON; without this affirmation a silent toggle-OFF would mask a false negative.
5. In the sidebar, click the `+` icon on the `wb-seed` project header. The new-session dropdown opens.
6. Click the `Claude` row in the dropdown. The session-create overlay appears.
7. Type session name `oauth-bootstrap-claude` and click `Start Session`. Wait up to 30s for the Claude session tab to open in the tab bar and the Claude input area to render in the terminal pane (the input area's screen position is not asserted — see SMOKE-CHAT-01 step 5 claude note; confirm readiness by typing a single `x` character into the focused pane and observing it render inline as a glyph, then delete it).

**Steps:**

1. Click into the Claude terminal pane to focus it (real mouse via Hymie).
2. Type `/login` using the Hymie keyboard.
3. Press Enter.

**Verify:**

* ≤2s after step 3: the workbench OAuth modal (`Authenticate with Claude` heading visible at the top of an overlay covering the page) is rendered. → `0.C/assertion-01-modal-rendered.png`
* ≤2s after step 3: the modal's `Authenticate with Claude` link button is visible with a tooltip / hover-revealed URL starting with `https://claude.ai/oauth/authorize?` — confirm against the URL the Claude CLI emitted in the terminal pane (same screenshot frame). → `0.C/assertion-02-modal-url-matches.png`
* ≤2s after step 3: a `Paste authorization code here` input field is visible inside the modal, with a `Submit` button beside it. → `0.C/assertion-03-code-input-visible.png`

**Teardown:**

* Click the modal's `×` close affordance. Modal disappears ≤1s. The Claude session tab remains open. Authentication completion is not part of this entry; Claude credentials remain whatever they were after 0.B.

**Result:** ☐ PASS ☐ FAIL

### 0.D: OAUTH-MODAL-GEMINI-DETECTOR-01 — Gemini OAuth flow via the new oauth-detector module

**Cascade-from:** 0.A
**Closes gap for:** #363

**Setup:**

1. 0.A complete.
2. Hymie reachable via MCP. **0.D requires Hymie** — Gemini CLI's OAuth handoff cannot be driven by headless Chromium for the same reason as 0.C.
3. From Hymie, open the desktop browser to `${WORKBENCH_URL}`. Pass the gate. The workbench shell renders.
4. **Precondition affirmation (§12.11 explicit Setup):** click `⚙ Settings`; in the General tab → `OAuth detection` group, screenshot-affirm the `Gemini` checkbox is checked; press Escape to close. The 0.D trigger only fires the modal if this toggle is ON.
5. Click the `+` icon on the `wb-seed` project header. The new-session dropdown opens.
6. Click the `Gemini` row. Type session name `oauth-bootstrap-gemini` in the overlay and click `Start Session`. Wait up to 30s for the Gemini session tab to open and the `>` Gemini prompt to render at the bottom of the terminal pane.

**Steps:**

1. Click into the Gemini terminal pane to focus.
2. Type `/auth` using the Hymie keyboard (the Gemini equivalent of `/login`).
3. Press Enter. The Gemini CLI emits an authentication URL; under typical terminal widths this URL wraps across multiple visual lines — the new oauth-detector module must reassemble it.

**Verify:**

* ≤3s after step 3: the workbench OAuth modal renders as an overlay (heading visible, link button visible). → `0.D/assertion-01-modal-rendered.png`
* ≤3s after step 3: the modal's link button reveals (via hover tooltip / Hymie copy-link inspection on the modal) a URL beginning with `https://accounts.google.com/` — the multi-line CLI emission has been reassembled by the oauth-detector module into a single contiguous URL. → `0.D/assertion-02-url-reassembled.png`
* ≤5s after step 3: exactly one modal overlay is visible (no second modal stacked behind or in front of the first — confirm by the modal layer's z-index visual: one panel, one dimmed background). → `0.D/assertion-03-single-modal-no-duplicate.png`

**Teardown:**

* Click the modal's `×` close affordance. Modal disappears ≤1s. The Gemini session tab remains open. 0.D verifies modal trigger; authentication completion is out of scope.

**Result:** ☐ PASS ☐ FAIL

### 0.E: OAUTH-CHECKBOX-PERSIST-01 — OAuth-detection checkbox persists + raises no ReferenceError

**Cascade-from:** 0.B
**Closes gap for:** #457

**Setup:**

1. 0.B complete (Claude credentials seated; workbench shell renders).
2. **0.E does NOT require Hymie** — runs headless via Playwright MCP against `${WORKBENCH_URL}`. Included in Section 0 because the bug class is the OAuth-detection checkbox's `oauthDetection` binding, which lives in the same code area as 0.C/0.D's modal trigger.
3. Open the browser DevTools console (Playwright's `browser_console_messages` captures it). Clear the console buffer immediately before Steps so any captured message is attributable to this entry.
4. **Precondition affirmation (§12.11 explicit Setup):** click `⚙ Settings` → General tab → `OAuth detection` group; screenshot-affirm the `Claude` checkbox is in the checked state at baseline (this entry tests checked → unchecked → reload → still unchecked; if baseline were already unchecked the assertion-01 would be a no-op). Press Escape to close before Steps begin.

**Steps:**

1. Click the `⚙ Settings` button at the bottom of the sidebar.
2. The Settings modal opens. Click the `General` tab in the modal's tab strip (it is the active tab by default — clicking it is a no-op but ensures focus).
3. Locate the `OAuth detection` settings group within the General tab. Click the checkbox labeled `Claude` (it ships checked by default) to toggle it OFF.
4. Press the `Escape` key. The Settings modal dismisses.
5. Reload the page (F5 or Playwright `browser_navigate` to the same URL).
6. After the workbench shell re-renders, click `⚙ Settings` again. Click the `General` tab. Locate the `OAuth detection` group.

**Verify:**

* ≤500ms after step 3: the `Claude` OAuth-detection checkbox visibly shows the unchecked state on screen (the checkmark glyph is absent from the box). → `0.E/assertion-01-checkbox-unchecked.png`
* ≤2s after step 6: the `Claude` OAuth-detection checkbox is STILL visibly unchecked after the page reload (persistence across reload — the toggle handler successfully wrote the value, which means the binding did not throw). → `0.E/assertion-02-persisted-across-reload.png`
* ≤2s after step 3: supplementary diagnostic — the DevTools console (Playwright `browser_console_messages` capture) shows zero entries containing the substring `oauthDetection` AND zero `ReferenceError` entries produced by the toggle click. (Persistence in the primary check is the screen-affirmable proof that the handler did not throw; the console snapshot is corroborating evidence.) → `0.E/assertion-03-console-clean.png`

**Teardown:**

* Click the `Claude` OAuth-detection checkbox to restore the default checked state. Click outside the modal to dismiss. State returns to 0.B baseline.

**Result:** ☐ PASS ☐ FAIL

### 0.C.NEG: OAUTH-DETECT-CLAUDE-OFF-01 — Claude `/login` with Claude OAuth-detection OFF does NOT trigger modal (negative parity for 0.C)

**Cascade-from:** 0.B
**Closes gap for:** §12.11 axis-1 negative case for Claude OAuth-detection toggle (paired with 0.C positive)

**Setup:**

1. 0.B complete (Claude auth seated). Hymie reachable.
2. From Hymie, open the desktop browser to `${WORKBENCH_URL}`. Workbench shell renders.
3. **Toggle OFF (Setup):** click `⚙ Settings` → General → `OAuth detection` group; if the `Claude` checkbox is checked, click it to uncheck. Screenshot-affirm the `Claude` checkbox is now in the unchecked state (✓ glyph absent). Press Escape to close Settings.
4. In the sidebar, click `+` on `wb-seed` → click `Claude` row → name session `oauth-off-claude` → `Start Session`. Wait up to 30s for the Claude session tab and ready observable (per SMOKE-CHAT-01 step 5 claude form).

**Steps:**

1. Click into the Claude terminal pane (real Hymie mouse).
2. Type `/login` (Hymie keyboard).
3. Press Enter.

**Verify:**

* ≤2s after step 3: NO workbench OAuth modal overlay is rendered. The screen shows the Claude terminal pane unchanged from its state immediately before step 3 — no `Authenticate with Claude` heading, no link button, no overlay panel. → `0.C.NEG/assertion-01-no-modal.png`
* ≤5s after step 3: the Claude terminal pane shows the CLI's own response to `/login` (the Claude CLI's native handoff — whatever it normally does when the workbench-side detector is off, e.g., printing the auth URL to the terminal pane as plain text), with no overlay obscuring the pane. → `0.C.NEG/assertion-02-claude-native-handoff.png`
* ≤5s after step 3: supplementary diagnostic — the DevTools console (Playwright `browser_console_messages` capture) shows zero entries from the `oauth-detector` module's modal-trigger code path during the 5s window. → `0.C.NEG/assertion-03-no-detector-fired.png`

**Teardown:**

* Press Ctrl+C to dismiss the Claude `/login` prompt without authenticating. Restore the toggle to its baseline checked state: click `⚙ Settings` → General → check the `Claude` OAuth-detection checkbox → close Settings. Right-click the `oauth-off-claude` row → Remove session.

**Result:** ☐ PASS ☐ FAIL

### 0.D.NEG: OAUTH-DETECT-GEMINI-OFF-01 — Gemini `/auth` with Gemini OAuth-detection OFF does NOT trigger modal (negative parity for 0.D)

**Cascade-from:** 0.B
**Closes gap for:** §12.11 axis-1 negative case for Gemini OAuth-detection toggle (paired with 0.D positive)

**Setup:**

1. 0.B complete. Hymie reachable.
2. From Hymie, browser to `${WORKBENCH_URL}`. Workbench shell renders.
3. **Toggle OFF (Setup):** click `⚙ Settings` → General → `OAuth detection` group; click the `Gemini` checkbox to uncheck it. Screenshot-affirm the `Gemini` checkbox is unchecked. Press Escape to close Settings.
4. Click `+` on `wb-seed` → `Gemini` row → name `oauth-off-gemini` → `Start Session`. Wait up to 30s for the Gemini `>` prompt at the bottom of the pane.

**Steps:**

1. Click into the Gemini terminal pane.
2. Type `/auth`.
3. Press Enter.

**Verify:**

* ≤3s after step 3: NO workbench OAuth modal overlay is rendered; the screen shows the Gemini terminal pane unchanged. → `0.D.NEG/assertion-01-no-modal.png`
* ≤5s after step 3: the Gemini terminal pane shows the CLI's own auth handoff output (URL printed to the pane as plain text or whatever Gemini's native handoff is when the workbench detector is off). → `0.D.NEG/assertion-02-gemini-native-handoff.png`
* ≤5s after step 3: supplementary diagnostic — DevTools console shows zero `oauth-detector` modal-trigger entries. → `0.D.NEG/assertion-03-no-detector-fired.png`

**Teardown:**

* Dismiss the Gemini `/auth` prompt. Re-check the `Gemini` OAuth-detection checkbox in Settings to restore baseline. Right-click the `oauth-off-gemini` row → Remove session.

**Result:** ☐ PASS ☐ FAIL

### 0.E.GEMINI: OAUTH-CHECKBOX-PERSIST-GEMINI-01 — Gemini OAuth-detection checkbox persists + raises no ReferenceError (peer of 0.E)

**Cascade-from:** 0.B
**Closes gap for:** §12.11 axis-2 peer parity for OAuth-detection checkbox persistence (paired with 0.E Claude)

**Setup:**

1. 0.B complete. Headless Playwright session against `${WORKBENCH_URL}`.
2. Clear the DevTools console buffer.
3. **Precondition affirmation:** click `⚙ Settings` → General → `OAuth detection` group; screenshot-affirm the `Gemini` checkbox is at its baseline (the test toggles it; baseline must be observable). Press Escape to close Settings.

**Steps:**

1. Click `⚙ Settings`. Click the `General` tab.
2. Locate the `OAuth detection` settings group. Note the `Gemini` checkbox current state from Setup step 3.
3. Click the `Gemini` checkbox to flip its state.
4. Press Escape to dismiss Settings.
5. Reload the page (F5 or Playwright `browser_navigate` to the same URL).
6. Re-open `⚙ Settings` → General → locate the `OAuth detection` group → `Gemini` row.

**Verify:**

* ≤1s after step 3: the `Gemini` OAuth-detection checkbox visibly shows its flipped state (opposite of baseline). → `0.E.GEMINI/assertion-01-checkbox-flipped.png`
* ≤2s after step 6: the `Gemini` checkbox shows the same flipped state after reload (persistence). → `0.E.GEMINI/assertion-02-persisted.png`
* ≤2s after step 3: supplementary diagnostic — DevTools console shows zero `oauthDetection` ReferenceError entries from the toggle click. → `0.E.GEMINI/assertion-03-console-clean.png`

**Teardown:**

* Click the `Gemini` OAuth-detection checkbox to restore baseline. Close Settings.

**Result:** ☐ PASS ☐ FAIL

### 0.E.CODEX: OAUTH-CHECKBOX-PERSIST-CODEX-01 — Codex OAuth-detection checkbox persists + raises no ReferenceError (peer of 0.E)

**Cascade-from:** 0.B
**Closes gap for:** §12.11 axis-2 peer parity for OAuth-detection checkbox persistence (paired with 0.E Claude)

**Setup:**

1. 0.B complete. Headless Playwright session against `${WORKBENCH_URL}`.
2. Clear the DevTools console buffer.
3. **Precondition affirmation:** click `⚙ Settings` → General → `OAuth detection` group; screenshot-affirm the `Codex` checkbox is at its baseline. Press Escape to close Settings.

**Steps:**

1. Click `⚙ Settings`. Click `General`.
2. In the `OAuth detection` group, click the `Codex` checkbox to flip its state.
3. Press Escape.
4. Reload the page.
5. Re-open `⚙ Settings` → General → `OAuth detection` group.

**Verify:**

* ≤1s after step 2: the `Codex` OAuth-detection checkbox visibly shows its flipped state. → `0.E.CODEX/assertion-01-checkbox-flipped.png`
* ≤2s after step 5: the `Codex` checkbox shows the same flipped state after reload (persistence). → `0.E.CODEX/assertion-02-persisted.png`
* ≤2s after step 2: supplementary diagnostic — DevTools console shows zero `oauthDetection` ReferenceError entries from the toggle click. → `0.E.CODEX/assertion-03-console-clean.png`

**Teardown:**

* Click the `Codex` OAuth-detection checkbox to restore baseline. Close Settings.

**Result:** ☐ PASS ☐ FAIL

### 0.F: OAUTH-MODAL-CODEX-01 — DELETED — Codex has no in-session OAuth slash command

This entry has been removed. The Codex CLI has no `/login` or `/auth` in-session slash command; Codex authentication is process-spawn-time only. The premise of testing the workbench's oauth-detector against a Codex in-session OAuth trigger is structurally invalid — the feature does not exist on Codex.

The §12.11 axis-2 peer-parity claim for the OAuth-detector module reduces accordingly: 0.C (Claude) + 0.D (Gemini) cover the two CLIs that DO expose an in-session OAuth slash. Codex's process-spawn-time auth flow is exercised at container-bring-up by 0.A / 0.B-equivalent setup, not by a Section-2+ entry.

### 0.F.NEG: OAUTH-DETECT-CODEX-OFF-01 — DELETED — paired with 0.F; same reason

This entry has been removed. Codex has no in-session OAuth slash to suppress; the toggle's effect on Codex cannot be verified in-session because the feature itself does not exist in-session.

The §12.11 axis-1 negative-state coverage for Codex OAuth-detection toggle is N/A by feature absence — the toggle is a workbench-side setting that gates the workbench's terminal-pane URL detector; with no Codex in-session URL emission to detect, ON and OFF are indistinguishable on Codex sessions. The Codex OAuth-detection checkbox in Settings remains under test by 0.E.CODEX (which verifies the checkbox's persistence + click handler — those work regardless of whether the detector ever fires for Codex).

### Orchestrator-directed SKIP

When the orchestrator explicitly directs "skip Section 0 — re-use existing dev container with persistent auth," then 0.A and 0.B both record SKIP with that orchestrator reason verbatim, and REG-FRESH-01 also records SKIP with the same reason. This is the only way SKIP appears for any test in this runbook.

***

## Section 1: Baseline UI Smoke

Section 1 runs first in every Gate C invocation, regardless of which surfaces the change set touched. Failure of any SMOKE-\* entry stops the rest of Gate C immediately and files a blocker `reviewer-finding` per baseline surface list.

Entries run in execution order — later entries depend on state established by earlier ones (SMOKE-TABS-01 operates on the three tabs SMOKE-CHAT-01 opened; SMOKE-STATUS-01 reads the status bar for the tab SMOKE-TABS-01 left active). Running out of order produces false negatives.

| ID | Surface (baseline surface list) |
| --- | --------------------- |
| SMOKE-CHAT-01 | 1 — Three-CLI chat |
| SMOKE-MCP-01 | 2 — Session from MCP |
| SMOKE-PROJ-01 | 3 — Project create |
| SMOKE-TABS-01 | 4 — Tab management |
| SMOKE-STATUS-01 | 5 — Status bar renders |
| SMOKE-WS-01 | 6 — WebSocket connect + reconnect |
| SMOKE-FILES-01 | 7 — File browser |
| SMOKE-SETTINGS-01 | 8 — Settings modal |

The Tier-1 CLI assumption stated in the preamble applies throughout Section 1. Failure modes are binary: surface works, or surface is visibly broken.

***

### SMOKE-CHAT-01: Three-CLI one-shot chat

**Source:** baseline surface 1
**Priority:** Baseline (FAIL stops Gate C)

**Setup:** browser at `${WORKBENCH_URL}`, gate passed if applicable, sidebar shows the `wb-seed` project, no tabs open. Phase 0 has either run (fresh container + auth) or has been excluded as not necessary (existing deployment, auth seated).

**Steps:** for each `<cli>` in the sequence `[claude, gemini, codex]`, run the following block. Same flow per CLI — no per-CLI branches.

1. Click the `+` button on the `wb-seed` project header in the sidebar.
2. The CLI dropdown appears. Click the row corresponding to `<cli>` (the row labeled "Claude," "Gemini," or "Codex" — never a `Terminal` row).
3. The session-create overlay appears. Type session name `smoke-chat-<cli>` into the name field.
4. Click Start (or press Enter). The overlay closes; a new tab opens labeled with the session name.
5. Wait for the per-CLI ready observable to appear in the terminal pane. Capture screenshots at 2s intervals up to a 60s bound. The ready observable is concrete per CLI:
    * **claude:** a Claude input area is rendered in the terminal pane (an editable region distinct from any response output area; type a single test character `x` via `browser_type` on `#pane-<tabId> .xterm-helper-textarea` — per the Canonical input selectors section — within the 60s window and confirm the glyph renders inline in the input area on screenshot). The input area's screen position (top, bottom, or inline) is intentionally NOT asserted. The version-stable observable is "typed character appears in the rendered view".
    * **gemini:** the Gemini `>` prompt is visible at the start of a new line at the bottom of the pane, with the cursor positioned after it.
    * **codex:** the Codex input field is visible at the bottom of the pane (rectangular input box with cursor positioned inside it).
        Identify the first frame where the corresponding ready observable is rendered. Delete the test character via `browser_press_key {key:"Backspace"}` on the same `.xterm-helper-textarea` before proceeding.
6. With the new tab focused, type the prompt `what is 7 times 8` into the active pane's input. Per the Canonical input selectors section above, the input element is `#pane-<tabId> .xterm-helper-textarea` (the xterm.js hidden input textarea — a real `<textarea>` element). Drive with `browser_type` on that selector. The xterm canvas (the parent div) is the OUTPUT surface and is NOT typeable — `browser_type` against it returns `Element is not an <input>...` and is the wrong target. `browser_press_key` on the same `xterm-helper-textarea` is the per-key alternative when needed (e.g. named keys like Enter, Escape).
7. Press Enter on the same `.xterm-helper-textarea` (via `browser_press_key {key:"Enter"}` after the type completes — the keystroke flows xterm → PTY → tmux → CLI; there is no Send button).
8. Wait for the response to render in the pane. Capture screenshots at 2s intervals up to a 30s bound. Identify the first frame where a coherent response is visible in the response area of that tab's pane. A coherent response contains "56" (the digit pair) or "fifty-six" (written form), in the response output area below the prompt echo.
9. Wait up to a 5s bound for the input prompt indicator (same observable as step 5) to be ready for the next prompt after the response. For claude: the input area accepts a typed character inline (position not asserted — see step 5's claude note). For gemini and codex: the prompt indicator reappears at the bottom of the pane as previously described in step 5.

After all three CLIs complete the block, three tabs are open in the tab bar; subsequent SMOKE entries operate on this state.

**Verify (numbered assertions — each requires a screenshot affirmation):**

1. After Start click for claude, a tab labeled `smoke-chat-claude` is visible in the tab bar within 2s. → `SMOKE-CHAT-01/assertion-01-claude-tab-present.png`
2. The claude ready observable (input area is rendered in the pane such that the test character `x` typed in step 5 appeared inline as a glyph) is affirmed within 60s of Start. The input-area screen position is not asserted. → `SMOKE-CHAT-01/assertion-02-claude-ready.png`
3. A coherent response containing "56" is visible in the claude tab's response area within 30s of prompt Enter. → `SMOKE-CHAT-01/assertion-03-claude-response.png`
4. The claude ready observable (input area accepts a new test character inline) is affirmed within 5s of the response landing, indicating the CLI is ready for the next prompt. The input-area screen position is not asserted. → `SMOKE-CHAT-01/assertion-04-claude-ready-again.png`
5. After Start click for gemini, a tab labeled `smoke-chat-gemini` is visible in the tab bar within 2s. → `SMOKE-CHAT-01/assertion-05-gemini-tab-present.png`
6. The gemini ready observable (`>` prompt at start of new line with cursor after it) is visible within 60s of Start. → `SMOKE-CHAT-01/assertion-06-gemini-ready.png`
7. A coherent response containing "56" is visible in the gemini tab's response area within 30s of prompt Enter. → `SMOKE-CHAT-01/assertion-07-gemini-response.png`
8. The gemini ready observable reappears at the pane bottom within 5s of the response landing. → `SMOKE-CHAT-01/assertion-08-gemini-ready-again.png`
9. After Start click for codex, a tab labeled `smoke-chat-codex` is visible in the tab bar within 2s. → `SMOKE-CHAT-01/assertion-09-codex-tab-present.png`
10. The codex ready observable (input field at pane bottom with cursor in it) is visible within 60s of Start. → `SMOKE-CHAT-01/assertion-10-codex-ready.png`
11. A coherent response containing "56" is visible in the codex tab's response area within 30s of prompt Enter. → `SMOKE-CHAT-01/assertion-11-codex-response.png`
12. The codex ready observable reappears at the pane bottom within 5s of the response landing. → `SMOKE-CHAT-01/assertion-12-codex-ready-again.png`

**Failure mode:** any assertion failing stops Gate C immediately. Tester files a blocker reviewer-finding citing the assertion number; attaches the screenshot from the per-run subdir.

***

### SMOKE-MCP-01: Session create from MCP

**Source:** baseline surface 2
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

***

### SMOKE-PROJ-01: Project create

**Source:** baseline surface 3
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

***

### SMOKE-TABS-01: Tab management (open + switch + close)

**Source:** baseline surface 4
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

***

### SMOKE-STATUS-01: Status bar renders

**Source:** baseline surface 5
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

***

### SMOKE-WS-01: WebSocket connect + reconnect

**Source:** baseline surface 6
**Priority:** Baseline (FAIL stops Gate C)

**Setup:** the codex tab from SMOKE-STATUS-01 is active. The status bar's connection indicator is in the "connected" visual state. The Tester executor's Playwright MCP exposes `browser_evaluate` — used here as a setup trigger (not as a verify), per §12.7's setup vs verify distinction.

**Steps:**

1. Observe the status bar — connection indicator in "connected" visual state for the codex tab.
2. Disconnect trigger: `browser_evaluate(() => { const t = window.tabs.get(window.activeTabId); if (t?.ws) t.ws.close(); return 'closed'; })` — closes the active tab's WebSocket. This is a setup trigger, not a verify (per §12.7); the verify is the screenshot of the indicator's state after the trigger. If the Playwright MCP additionally exposes `context.setOffline(true)`, prefer that as it disconnects at the browser network layer rather than via the app's WS handle; either is acceptable for this entry's verify.
3. Wait, capturing screenshots at 1s intervals up to a 5s bound.
4. Reconnect trigger: if step 2 used `context.setOffline(true)`, invoke `context.setOffline(false)`; if step 2 closed the ws directly, the workbench's tab-reconnect logic should re-establish a new WS automatically (verify it happens within the 10s bound; if it doesn't, that's a workbench bug — FAIL).
5. Wait, capturing screenshots at 1s intervals up to a 10s bound.

**Verify (numbered assertions):**

1. At rest, with the codex tab active, the status bar shows the connection indicator in the "connected" visual state. *(Cascades from SMOKE-STATUS-01 assertion 3 / 4 — same render bound applies.)* → `SMOKE-WS-01/assertion-01-connected.png`
2. Within 5s of `setOffline(true)`, the status bar's connection indicator transitions to the "disconnected" visual state (per-product styling — red dot, "Disconnected" label, broken-link icon, banner, or similar). → `SMOKE-WS-01/assertion-02-disconnected.png`
3. Within 10s of `setOffline(false)`, the status bar's connection indicator returns to the "connected" visual state from assertion 1. → `SMOKE-WS-01/assertion-03-reconnected.png`

**Failure mode:** any assertion failing stops Gate C.

***

### SMOKE-FILES-01: File browser

**Source:** baseline surface 7
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

***

### SMOKE-SETTINGS-01: Settings modal

**Source:** baseline surface 8
**Priority:** Baseline (FAIL stops Gate C)

**Setup:** browser at `${WORKBENCH_URL}`; workbench shell rendered; the Settings affordance (gear icon, "Settings" menu entry, or product equivalent) is visible.

**Steps:**

1. Click the Settings affordance.
2. The settings modal appears.
3. Observe the tab strip at the top (or side) of the modal — it lists the configured settings tabs.
4. Click the Claude Code tab; observe the content area changes.
5. Click the Vector Search tab; observe the content area changes.
6. Click the Git tab; observe the content area changes.
7. Click the System Prompts tab; observe the content area changes.
8. Click the close affordance (× glyph) on the modal (or press Escape).
9. The modal closes.

**Verify (numbered assertions):**

1. Within 1s of clicking the Settings affordance, the settings modal is visible (modal overlay covering the rest of the shell, with a recognizable Settings heading). → `SMOKE-SETTINGS-01/assertion-01-modal-visible.png`
2. The settings modal's tab strip shows at least the labels "General," "Claude Code," "Vector Search," and "System Prompts" (the four tabs per the Meta section above), all visible simultaneously. *(Cascades from assertion 1.)* → `SMOKE-SETTINGS-01/assertion-02-tabs-visible.png`
3. Within 1s of clicking the Claude Code tab, the modal's content area shows Claude-Code-specific controls (model selector, thinking mode, keepalive — whatever the current Claude Code tab contents are), visibly different from the General tab's content area. → `SMOKE-SETTINGS-01/assertion-03-claude-tab-content.png`
4. Within 1s of clicking the Vector Search tab, the modal's content area shows Vector-Search-specific controls, visibly different from the Claude Code tab. → `SMOKE-SETTINGS-01/assertion-04-vector-tab-content.png`
5. Within 1s of clicking the Git tab (per `data-settings-tab="git"` registered in `public/index.html` and `git-accounts` route in `src/routes/`), the modal's content area shows Git Accounts controls (account list + add-account form with `github.com/yourname` placeholder and Personal access token field), visibly different from the Vector Search tab. (§12.11 axis-2 — Settings-tab peer parity, complementing the General/Claude Code/Vector Search assertions above.) → `SMOKE-SETTINGS-01/assertion-05-git-tab-content.png`
6. Within 1s of clicking the System Prompts tab, the modal's content area shows System-Prompts-specific controls (the per-CLI prompt-file buttons C / G / X for Claude / Gemini / Codex and the project template textarea), visibly different from the Git tab. (§12.11 axis-2 — completes the per-tab parity sweep across all 4 documented Settings tabs.) → `SMOKE-SETTINGS-01/assertion-06-prompts-tab-content.png`
7. Within 1s of clicking the modal's close affordance (or pressing Escape), the settings modal is no longer visible. → `SMOKE-SETTINGS-01/assertion-07-modal-dismissed.png`

**Failure mode:** any assertion failing stops Gate C.

***

## Section 2: UI Shell / Cold-Load / Settings

Establish the rendered-shell precondition for every later section. Verify F0 frontend monolith decomposition (#364) didn't break boot, E1/E2 perf wins (#371, #372) hold under a 300+ session workspace, the docker-build asset fix (#322) renders logos, the post-jQuery element-rename (#404) loads cleanly, and the Settings binding fix (#459) opens the modal without duplicate-export errors.

***

### 2.1: SHELL-LOAD-01 — Cold-load app shell + sidebar paint within 1s on 300+ sessions

**Cascade-from:** 0.A
**Closes gap for:** #364, #371, #372

**Setup:**

1. 0.A complete (fresh container, empty-state UI rendering).
2. Orchestrator seeds 300 sessions across 5 projects into the workbench DB before the first navigation. Seed via direct DB insert from the orchestrator's host shell (this is orchestration, allowed outside Verify): `ssh ${WORKBENCH_HOST} 'docker exec -i ${WORKBENCH_CONTAINER} node /app/scripts/seed-sessions.js 300 5'` or equivalent fixture seeder. Seeding leaves the workbench process untouched.
3. The browser is NOT yet pointed at `${WORKBENCH_URL}` — this entry's Step 1 is the first navigation, which is what the timing bound measures.

**Steps:**

1. Navigate to `${WORKBENCH_URL}` (Playwright `browser_navigate`). Pass the gate if applicable using the Section 0 credentials, then continue once the gate has transitioned.
2. Observe the workbench shell render. Capture screenshots at 100ms intervals up to a 1.5s bound.

**Verify:**

* ≤1s after step 1: the sidebar's project list is visibly populated (at least the 5 seeded project headers are rendered, each showing the project name and its session count). → `2.1/assertion-01-sidebar-painted.png`
* ≤1s after step 1: the tab bar is rendered at the top of the main panel (empty or with default tabs, but the bar itself is visible). → `2.1/assertion-02-tab-bar-painted.png`
* ≤1s after step 1: the right panel renders with the Files / Tasks tab strip and the file tree area visible. → `2.1/assertion-03-right-panel-painted.png`
* ≤2s after step 1: supplementary diagnostic — the DevTools console (Playwright `browser_console_messages` capture, viewed as the rendered DevTools strip) shows zero `Uncaught` / `TypeError` / `ReferenceError` entries from the boot path. The primary boot-correctness affirmations are assertions 01-03 (sidebar, tab-bar, right-panel all painted). → `2.1/assertion-04-console-clean.png`

**Teardown:**

* Leave the page on the workbench shell — downstream entries cascade-from 2.1 use the rendered state.

***

### 2.2: SHELL-LOGO-01 — Header logo + gate-page background images render against locally-built image

**Cascade-from:** cold (locally-built image, not standard registry image)
**Closes gap for:** #322

**Setup** (pre-run, outside the entry's verify path — orchestration, not a verify mechanism):

1. Orchestrator builds a docker image from the current repo head: `ssh ${WORKBENCH_HOST} 'cd /tmp/agentic-workbench && docker build -t workbench:r1-322-local .'`.
2. Orchestrator launches a container from that image and binds `${WORKBENCH_URL}` to its port: `docker run -d --name workbench-322-test -p <free-port>:7860 workbench:r1-322-local`. Wait up to 30s for `/health` to return 200.
3. If a gate passcode is intended for the local image, set it via container env (orchestrator decision); otherwise leave ungated.

**Steps:**

1. Navigate to `${WORKBENCH_URL}` (Playwright `browser_navigate`).
2. If a gate page is configured, observe the gate page. Otherwise observe the workbench shell directly.

**Verify:**

* ≤3s after step 1: the header logo `<img>` element in the sidebar renders the workbench logo glyph at the documented dimensions (48px tall). The browser's broken-image glyph or alt-text fallback ("Workbench" as text replacing the image) is NOT present — the actual image bitmap is visibly painted. → `2.2/assertion-01-header-logo-visible.png`
* ≤3s after step 2 (if gated): the gate page's background image visibly fills the gate panel area (a discernible bitmap pattern, not a flat default color). → `2.2/assertion-02-gate-bg-visible.png`
* ≤3s after step 1: supplementary diagnostic — zero `Failed to load resource` entries for `.png` paths under `/` appear in the DevTools network panel / console. The primary affirmations are assertions 01-02 (logo + gate-bg visibly rendered, which would be impossible if a 404 occurred — the broken-image glyph would replace the bitmap). → `2.2/assertion-03-no-png-404.png`

**Teardown:**

* Orchestrator stops + removes the `workbench-322-test` container. The standard deployment under test resumes from the next entry forward.

***

### 2.3: SHELL-FILETREE-ID-01 — File-tree picker renders with renamed (non-`jqft-`) selector

**Cascade-from:** 2.1
**Closes gap for:** #404

**Setup:**

1. 2.1 complete (workbench shell rendered).

**Steps:**

1. In the sidebar header, click the `+` button labeled "Add Program" (tooltip on hover).
2. Observe the program-create flow; for this entry's purpose, click `Cancel` and instead exercise the file-tree picker via the path-input field used in project creation. Click the `+ Project` affordance under one of the existing programs.
3. The project-create modal opens with a file-tree picker. Observe the file-tree panel area inside the modal.
4. Click on the `/data/workspace` row in the file tree to expand it. The tree expands to show children.
5. Click the expand chevron on one of the child directories.

**Verify:**

* ≤2s after step 3: the file-tree picker is visibly rendered inside the project-create modal — a tree panel showing the root path. → `2.3/assertion-01-filetree-rendered.png`
* ≤2s after step 4: at least one child entry of `/data/workspace` is visible as an indented row under the expanded root. → `2.3/assertion-02-root-expanded.png`
* ≤2s after step 5: the child directory expands and its grandchildren are visible as further-indented rows. → `2.3/assertion-03-child-expanded.png`

**Teardown:**

* Click `Cancel` on the project-create modal to dismiss without creating a project. State returns to 2.1 baseline.

***

### 2.4: SHELL-SETTINGS-OPEN-01 — Settings cog opens modal in <500ms with no duplicate-binding error

**Cascade-from:** 2.1
**Closes gap for:** #459

**Setup:**

1. 2.1 complete.
2. Clear the DevTools console buffer (Playwright `browser_console_messages` snapshot before Steps).

**Steps:**

1. Click the `⚙ Settings` button at the bottom of the sidebar.
2. Observe the Settings modal open.

**Verify:**

* ≤500ms after step 1: the Settings modal overlay is visibly rendered (modal panel against dimmed page background, with the `General` / `Claude Code` / `Git` / `Vector Search` / `System Prompts` tab strip visible at the top). → `2.4/assertion-01-settings-modal-open.png`
* ≤500ms after step 1: supplementary diagnostic — the DevTools console (rendered DevTools strip) shows zero entries warning about a duplicate `window.openSettings` assignment. The primary affirmations are assertion-01 (modal opened) + assertion-03 (General tab active) — both impossible to satisfy if the duplicate binding had broken the click handler. → `2.4/assertion-02-no-duplicate-binding-warning.png`
* ≤500ms after step 1: the `General` tab is the active tab in the modal's tab strip (visually distinct from inactive tabs). → `2.4/assertion-03-general-tab-active.png`

**Teardown:**

* Press `Escape` to dismiss the Settings modal. Modal disappears ≤500ms. State returns to 2.1 baseline.

***

## Section 3: Sidebar / State Polling

Verify the sidebar handles (a) optimistic-mutation in-flight without flicker (#369) and (b) non-Claude session activity timestamps advancing as messages land (#408).

***

### 3.1: SIDEBAR-OPTIMISTIC-ARCHIVE-01 — Archive toggle holds during in-flight PUT under throttling

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** #369

**Setup:**

1. SMOKE-CHAT-01 complete (smoke-chat-claude / smoke-chat-gemini / smoke-chat-codex sessions exist as sidebar rows under `wb-seed`).
2. **Baseline-glyph affirmation (§12.11 explicit Setup):** screenshot-affirm the `smoke-chat-claude` row's Archive affordance is in the unchecked (☐) state at start. If it is checked (☑), click once to restore the unchecked baseline before proceeding — otherwise assertion-01's "transitions to ☑" silently passes on a no-op.
3. Orchestrator configures Playwright to hold `PUT /api/sessions/*/archive` responses for 4 seconds: `await page.route('**/api/sessions/*/archive', async (route) => { await new Promise(r => setTimeout(r, 4000)); return route.continue(); });`. This is a network-layer throttle at the test harness, not in-page state manipulation.

**Steps:**

1. In the sidebar, locate the `smoke-chat-claude` session row under `wb-seed`. The row has an Archive affordance (☐ checkbox glyph).
2. Click the Archive (☐) glyph on `smoke-chat-claude`.
3. While the PUT is in-flight (4s throttle window), observe the sidebar row continuously. Capture screenshots at 500ms intervals through the 4s window.
4. After the 4s window completes and the PUT response lands, observe the row's final state.

**Verify:**

* ≤500ms after step 2: the `smoke-chat-claude` row's Archive glyph visibly transitions to the checked state (☑). The optimistic update is rendered immediately, before the PUT response returns. → `3.1/assertion-01-optimistic-archived.png`
* ≤4s after step 2 (frames sampled every 500ms across the throttle window — 8 frames at 500ms / 1s / 1.5s / 2s / 2.5s / 3s / 3.5s / 4s after step 2): the Archive glyph remains in the checked (☑) state in every sampled frame; no frame shows the glyph reverted to unchecked (☐). → `3.1/assertion-02-no-flicker-frames.png` (8-frame composite)
* ≤6s after step 2 (i.e. ≤2s after the throttled PUT response lands): the Archive glyph is still in the checked (☑) state and the row remains visible (or moved to the archived section if the sidebar's filter setting hides archived sessions — both outcomes are consistent with "archive persisted"). → `3.1/assertion-03-archived-persisted.png`

**Teardown:**

* Remove the Playwright network throttle. Click the Archive glyph on `smoke-chat-claude` again to un-archive (restore SMOKE-CHAT-01 baseline). State returned to SMOKE-CHAT-01 product.

***

### 3.2: SIDEBAR-NONCLAUDE-TIMESTAMPS-01 — Gemini + Codex sidebar timestamps advance with activity

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** #408

**Setup:**

1. SMOKE-CHAT-01 complete (smoke-chat-claude + smoke-chat-gemini + smoke-chat-codex rows visible in sidebar).
2. **Baseline-timestamp affirmation (§12.11 explicit Setup):** screenshot the sidebar showing each smoke-chat-\* row's current timestamp text. Read the visible value (e.g., "5m ago", "Just now"). Record the text per row in the run's manifest as the baseline against which "advanced" is measured in Verify. If any row shows an empty/missing timestamp, that is itself a precondition failure — the parser is not producing a value for the test to compare against.
3. Set the sidebar sort dropdown (`#session-sort` in the filter bar) to `Recent activity` if not already set; screenshot-affirm the dropdown shows "Recent activity" as the selected value.

**Steps:**

1. Click the `smoke-chat-gemini` tab in the tab bar (or click the row in the sidebar) to focus its terminal pane.
2. Type `please respond briefly with the word ack` via `browser_type` on `#pane-<gemini-tabId> .xterm-helper-textarea` (per the Canonical input selectors section) and press Enter via `browser_press_key {key:"Enter"}` on the same selector.
3. Wait for the Gemini response to land in the pane (response containing `ack` visible).
4. Click the `smoke-chat-codex` tab. Type the same prompt via `browser_type` on `#pane-<codex-tabId> .xterm-helper-textarea` and press Enter the same way.
5. Wait for the Codex response containing `ack`.
6. Click the `smoke-chat-claude` tab (or the row in the sidebar). Click into the Claude terminal pane. Type `please respond briefly with the word ack` and press Enter. Wait for the Claude response containing `ack` (§12.11 axis-2 Claude peer trigger).

**Verify:**

* ≤5s after step 3: the sidebar timestamp under `smoke-chat-gemini` has visibly advanced compared to the baseline screenshot taken in Setup step 2 (e.g., "just now" or "1s ago" instead of the stale value). → `3.2/assertion-01-gemini-timestamp-advanced.png`
* ≤5s after step 5: the sidebar timestamp under `smoke-chat-codex` has visibly advanced compared to the baseline. → `3.2/assertion-02-codex-timestamp-advanced.png`
* ≤5s after step 5 (with the sidebar sort dropdown set to "Recent activity"): the `smoke-chat-codex` row is now positioned ABOVE `smoke-chat-gemini` and above `smoke-chat-claude` in the sidebar (sort-by-activity order reflects the most-recent message landing on Codex). → `3.2/assertion-03-codex-sorted-to-top.png`
* ≤5s after step 6: the `smoke-chat-claude` row's sidebar timestamp has visibly advanced compared to the baseline screenshot taken in Setup step 2 — affirming the Claude-side parser produces an advancing timestamp value with the same parity as the Gemini + Codex assertions 01-02 (§12.11 axis-2 Claude peer). → `3.2/assertion-04-claude-timestamp-advanced.png`

**Teardown:**

* N/A — state used by no downstream entry; the smoke-chat-\* sessions remain operative.

***

### SIDEBAR-UNARCHIVE-01 — Un-archive (☑ → ☐) persists across sidebar refresh (negative parity for 3.1)

**Cascade-from:** 3.1
**Closes gap for:** §12.11 axis-1 — un-archive is the negative-of-archive state that 3.1's positive case implicitly relies on

**Setup:**

1. 3.1 complete with assertions PASSed. Remove 3.1's Playwright network throttle if it is still active.
2. **Baseline affirmation:** screenshot-affirm `smoke-chat-claude` row's Archive glyph is currently ☑ (the post-3.1 state — 3.1's Teardown step that "un-archives to restore baseline" is what this entry verifies; if 3.1's Teardown ran successfully the row is already ☐, in which case re-archive it via a single click + 1s wait before proceeding). Then take the baseline showing ☑.

**Steps:**

1. Click the `smoke-chat-claude` row's Archive (☑) glyph in the sidebar.
2. Wait for the un-archive PUT to land (typical: ≤1s on an un-throttled network).
3. Click the sidebar's `↻` refresh affordance.

**Verify:**

* ≤1s after step 1: the Archive glyph on `smoke-chat-claude` visibly transitions from ☑ to ☐ (optimistic update). → `SIDEBAR-UNARCHIVE-01/assertion-01-optimistic-unarchived.png`
* ≤2s after step 2: the Archive glyph remains ☐ after the PUT response lands; no flicker back to ☑. → `SIDEBAR-UNARCHIVE-01/assertion-02-unarchive-persists-post-put.png`
* ≤3s after step 3: after the sidebar refresh, the `smoke-chat-claude` row is still rendered with Archive glyph ☐, AND if the sidebar filter is set to default (not hiding archived), the row is in its non-archived position. → `SIDEBAR-UNARCHIVE-01/assertion-03-persists-post-refresh.png`

**Teardown:**

* N/A — state returned to 3.1 baseline (☐). smoke-chat-claude remains operative for downstream entries.

**Result:** ☐ PASS ☐ FAIL

### SIDEBAR-SHOWARCHIVED-OFF-01 — "Show archived" filter OFF hides archived rows (default)

**Cascade-from:** 3.1
**Closes gap for:** §12.11 axis-1 — show-archived filter OFF state (paired with SIDEBAR-SHOWARCHIVED-ON-01)

**Setup:**

1. 3.1 complete (an archived row exists: `smoke-chat-claude` is ☑). If SIDEBAR-UNARCHIVE-01 ran since 3.1, re-archive `smoke-chat-claude` first (click ☐ → wait ≤1s for ☑).
2. **Filter-state affirmation:** locate the sidebar's `#session-filter` dropdown in the filter bar; screenshot-affirm it is currently at its OFF / default value (typically "Active" / not "All" / not "Archived"). If the dropdown shows anything else, click it and select the default "Active" option.

**Steps:**

1. Observe the sidebar. The `smoke-chat-claude` row was archived in 3.1.
2. Take a screenshot of the sidebar's session list under `wb-seed`.

**Verify:**

* ≤2s after step 2: the `smoke-chat-claude` row is NOT visible in the sidebar's main session list under `wb-seed` (filter OFF hides archived sessions). → `SIDEBAR-SHOWARCHIVED-OFF-01/assertion-01-archived-hidden.png`
* ≤2s after step 2: the `smoke-chat-gemini` and `smoke-chat-codex` rows ARE still visible in the sidebar (non-archived sessions are not affected by the filter). → `SIDEBAR-SHOWARCHIVED-OFF-01/assertion-02-active-still-visible.png`

**Teardown:**

* N/A — state preserved for SIDEBAR-SHOWARCHIVED-ON-01.

**Result:** ☐ PASS ☐ FAIL

### SIDEBAR-SHOWARCHIVED-ON-01 — "Show archived" filter ON reveals archived rows

**Cascade-from:** SIDEBAR-SHOWARCHIVED-OFF-01
**Closes gap for:** §12.11 axis-1 — show-archived filter ON state (paired with SIDEBAR-SHOWARCHIVED-OFF-01)

**Setup:**

1. SIDEBAR-SHOWARCHIVED-OFF-01 complete (filter is OFF; `smoke-chat-claude` is archived; row is hidden).

**Steps:**

1. Click the sidebar filter dropdown (`#session-filter`).
2. Select the option that includes archived sessions (typically "All" or "Archived").
3. Observe the sidebar re-render.

**Verify:**

* ≤2s after step 2: the `smoke-chat-claude` row IS now visible in the sidebar under `wb-seed`, displayed with its Archive glyph in the ☑ state (the filter reveals it; the archived state is unchanged). → `SIDEBAR-SHOWARCHIVED-ON-01/assertion-01-archived-revealed.png`
* ≤2s after step 2: `smoke-chat-gemini` and `smoke-chat-codex` remain visible alongside it (filter does not affect non-archived rows). → `SIDEBAR-SHOWARCHIVED-ON-01/assertion-02-active-still-visible.png`

**Teardown:**

* Click `smoke-chat-claude`'s ☑ glyph to un-archive (restore baseline). Reset the filter dropdown to its default "Active" value. State returned to SMOKE-CHAT-01 baseline.

**Result:** ☐ PASS ☐ FAIL

### SIDEBAR-SORT-NAME-01 — Sidebar sort-by-Name orders rows alphabetically (parity for 3.2/4.3's sort-by-Recent-activity)

**Cascade-from:** 2.1
**Closes gap for:** §12.11 axis-1 — sort dropdown's Name value (peer of Recent activity which 3.2/4.3 use)

**Setup:**

1. 2.1 complete (workbench shell rendered). At least two session rows exist under any project so a sort order is observable — the SMOKE-CHAT-01 product (three smoke-chat-\* rows) is sufficient.
2. **Sort-dropdown affirmation:** screenshot-affirm the sidebar `#session-sort` dropdown's current value. If it is at "Recent activity" (the value used by 3.2/4.3), note for Teardown so the test can restore that state.

**Steps:**

1. Click the `#session-sort` dropdown in the sidebar filter bar.
2. Select the `Name` option.
3. Observe the sidebar re-render.

**Verify:**

* ≤2s after step 2: the session rows under `wb-seed` are visibly re-ordered to alphabetical order by session name. With smoke-chat-claude / smoke-chat-gemini / smoke-chat-codex existing, the visible order top-to-bottom is `smoke-chat-claude`, `smoke-chat-codex`, `smoke-chat-gemini` (alphabetical). → `SIDEBAR-SORT-NAME-01/assertion-01-alphabetical-order.png`
* ≤2s after step 2: the `#session-sort` dropdown's visible selected value is `Name` (confirms the dropdown's value is what drove the re-order). → `SIDEBAR-SORT-NAME-01/assertion-02-dropdown-shows-name.png`

**Teardown:**

* Click `#session-sort` → select the value noted from Setup (typically "Recent activity") to restore the downstream-entries baseline. State returned to 2.1 / SMOKE-CHAT-01 baseline.

**Result:** ☐ PASS ☐ FAIL

***

## Section 4: Sessions / Session Info / Lifecycle

Cover session creation under load (#334, #444), path-encoding round-trips on restart (#326), per-CLI parser correctness (#335), env-var injection (#342), and MCP summarize on Codex (#450). The lifecycle backbone every other section assumes works.

**Cascade base varies per entry** (documented upfront so the orchestrator does not re-derive at execution time): 4.1 from 0.B (Claude auth seated, fresh project allowed); 4.2 from 2.1 (rendered shell only); 4.3 / 4.4 / 4.6 from SMOKE-CHAT-01 (3-CLI sessions established); 4.5 from SMOKE-CHAT-01 (a session already polling is the race target).

***

### 4.1: SESS-PATH-ENCODING-01 — Project path with special chars round-trips through restart

**Cascade-from:** 0.B
**Closes gap for:** #326

**Setup:**

1. 0.B complete (Claude auth seated, shell rendered).
2. Orchestrator creates the deliberately-unusual workspace path: `ssh ${WORKBENCH_HOST} 'docker exec ${WORKBENCH_CONTAINER} mkdir -p /data/workspace/foo.bar/sub_dir+with-stuff'`.

**Steps:**

1. In the sidebar, click `+ Project` under a program (or use Add Program first if needed). The project-create modal opens.
2. Type project name `path-encode-test` in the name field.
3. Type `/data/workspace/foo.bar/sub_dir+with-stuff` into the path field (or use the file-tree picker to navigate to it).
4. Click `Save`. Wait ≤5s for the modal to dismiss and the new project row to appear in the sidebar.
5. Click the `+` icon on the new project's header → click `Claude` row → name the session `pathenc-claude-01` → click `Start Session`. Wait up to 30s for the Claude tab and ready observable.
6. Right-click the `pathenc-claude-01` session row in the sidebar (or use the row's context menu affordance). Click `Restart`.

**Verify:**

* ≤5s after step 4: the `path-encode-test` project row is visible in the sidebar with its name displayed. → `4.1/assertion-01-project-created.png`
* ≤30s after step 5: the `pathenc-claude-01` session tab is visible in the tab bar and the Claude input area is rendered in its terminal pane (typing a single `x` into the focused pane renders the glyph inline; the input-area screen position is not asserted per SMOKE-CHAT-01 step 5 claude note). → `4.1/assertion-02-session-created.png`
* ≤10s after step 6: the `pathenc-claude-01` row remains attached to the `path-encode-test` project in the sidebar (NOT a new orphan row, NOT a missing row). → `4.1/assertion-03-session-attached-after-restart.png`
* ≤10s after step 6: the Claude input area is rendered again in the restarted session's terminal pane (post-restart ready observable — same neutral form as assertion-02; screen position not asserted). → `4.1/assertion-04-claude-ready-after-restart.png`

**Teardown:**

* Right-click `pathenc-claude-01` row → Remove session. Right-click `path-encode-test` project row → Remove project. Orchestrator removes the test workspace directory: `docker exec ${WORKBENCH_CONTAINER} rm -rf /data/workspace/foo.bar`. State returns to 0.B baseline.

***

### 4.2: SESS-RAPID-CREATE-01 — 5 rapid Claude session clicks → 5 distinct rows, no tmpId collision

**Cascade-from:** 2.1
**Closes gap for:** #334

**Setup:**

1. 2.1 complete.
2. Note the current count of session rows under `wb-seed` in the sidebar (baseline screenshot).

**Steps:**

1. Click the `+` icon on the `wb-seed` project header → the new-session dropdown opens.
2. Click `Claude`. The session-create overlay appears.
3. Type session name `rapid-01` and click `Start Session`.
4. Immediately (without waiting for the new row to render) click the `+` icon on `wb-seed` again → `Claude` → name `rapid-02` → click `Start Session`.
5. Repeat for `rapid-03`, `rapid-04`, `rapid-05` — all five sessions must be requested within 1 wall-clock second of step 3's click.

**Verify:**

* ≤3s after step 5: five distinct rows labeled `rapid-01`, `rapid-02`, `rapid-03`, `rapid-04`, `rapid-05` are all visible in the sidebar under `wb-seed`. No row is missing. No two rows share the same label (other than the user-typed name which is intentionally unique). → `4.2/assertion-01-five-distinct-rows.png`
* ≤30s after step 5: each of the five session tabs is openable from the sidebar (clicking the row opens a tab labeled with the session name) and each tab's terminal pane renders the Claude input area (typing a single `x` into the focused pane renders the glyph inline; screen position not asserted). → `4.2/assertion-02-all-five-openable.png`

**Teardown:**

* Right-click each of `rapid-01..05` rows → Remove session. Sidebar returns to the 2.1 / SMOKE-CHAT-01 baseline session count.

***

### 4.3: SESS-GEMINI-PARSER-01 — Gemini session row shows activity timestamp from JSONL

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** #335

**Setup:**

1. SMOKE-CHAT-01 complete (smoke-chat-gemini exists; the SMOKE-CHAT-01 round-trip drove a "what is 7 times 8" prompt + response, so the Gemini session's `.jsonl` transcript file exists and has at least 2 message records).
2. **Precondition affirmation (§12.11 explicit Setup):** screenshot-affirm the `smoke-chat-gemini` row in the sidebar shows ANY timestamp value (not an empty cell, not a missing field). This is the baseline against which "advancing timestamp" is the verify clause. If the row shows an empty timestamp, that is itself a precondition failure — the parser is not producing any value to advance.
3. Note the sidebar's sort setting; for this entry, switch it to `Recent activity` if not already (click the `#session-sort` select in the sidebar filter bar). Screenshot-affirm the dropdown shows "Recent activity" as the selected value.

**Steps:**

1. Click the sidebar refresh affordance (the circular-arrow button next to `+ Add Program` in the sidebar header).
2. Observe the sidebar re-render. Find the `smoke-chat-gemini` row.

**Verify:**

* ≤5s after step 1: the `smoke-chat-gemini` row's timestamp shown below the row name reads a recent value (e.g., `just now`, `Ns ago`, `Nm ago`) — NOT a stale "session-start" timestamp or an empty value. → `4.3/assertion-01-gemini-timestamp-non-empty.png`
* ≤5s after step 1: the `smoke-chat-gemini` row sorts ABOVE or AT THE SAME LEVEL as any session with no recent activity (verifying that the parser produced an advancing timestamp the sort consumed). → `4.3/assertion-02-sort-consistent.png`

**Teardown:**

* N/A — state used by 3.2 and other entries.

***

### 4.4: SESS-ENV-INJECT-01 — `WORKBENCH_SESSION_ID` echoes the sidebar's session id

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** #342

**Setup:**

1. SMOKE-CHAT-01 complete (smoke-chat-claude session exists).

**Steps:**

1. Click the `smoke-chat-claude` row in the sidebar → tab focuses.
2. Hover the `smoke-chat-claude` row in the sidebar — a tooltip appears showing the workbench session id (e.g., a UUID).
3. Take a screenshot of the tooltip text (the visible session id string in the tooltip).
4. Click into the terminal pane of `smoke-chat-claude` to focus it.
5. Type `echo $WORKBENCH_SESSION_ID` and press Enter.

**Verify:**

* ≤2s after step 2: the sidebar row's tooltip is visible and contains a session-id-shaped string. → `4.4/assertion-01-sidebar-tooltip-id.png`
* ≤2s after step 5: the terminal pane renders a new line below the prompt with the value of `WORKBENCH_SESSION_ID` printed. → `4.4/assertion-02-terminal-echo.png`
* ≤2s after step 5: the session-id string visible in the terminal echo (assertion-02) is character-for-character identical to the session-id string captured from the sidebar tooltip (assertion-01). → `4.4/assertion-03-ids-match.png` (composite — show both screenshots side-by-side and assert by inspection)

**Teardown:**

* N/A — smoke-chat-claude state preserved.

***

### 4.5: SESS-TMUX-ASYNC-01 — New session creation does not freeze sidebar during in-flight loadState

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** #444

**Setup:**

1. SMOKE-CHAT-01 complete (three smoke-chat-\* sessions are already polling — that polling is the race target).
2. Observe the sidebar showing the three smoke-chat-\* rows under `wb-seed`. The status bar (bottom of the main panel) shows a connected indicator for the active session.

**Steps:**

1. Click the `+` icon on the `wb-seed` project header.
2. Click `Claude` in the dropdown. The session-create overlay appears.
3. Type session name `tmux-async-01` and click `Start Session`.
4. Immediately after clicking Start Session, mouse-hover over each of the three smoke-chat-\* rows in the sidebar to confirm the tooltip still renders responsively (each hover should produce a tooltip within 200ms — a frozen sidebar would delay or miss the hover).

**Verify:**

* ≤2s after step 3: the `tmux-async-01` row appears in the sidebar under `wb-seed`. → `4.5/assertion-01-new-row-appears.png`
* ≤200ms after each of the three hovers in step 4 (each hover initiated within the first 2s after step 3 — three discrete hover events, three discrete screenshot captures): the hovered row's tooltip is rendered in the captured frame; no frame shows a missing tooltip past the 200ms mark. → `4.5/assertion-02-tooltip-on-each-hover.png` (3-frame composite — one per hover)
* ≤30s after step 3: the `tmux-async-01` tab opens with the Claude input area rendered in its terminal pane (typing a single `x` into the focused pane renders the glyph inline; screen position not asserted). → `4.5/assertion-03-session-ready.png`

**Teardown:**

* Right-click `tmux-async-01` row → Remove session. Sidebar returns to SMOKE-CHAT-01 baseline.

***

### 4.6: SESS-CODEX-SUMMARIZE-01 — `session_summarize` MCP tool produces summary for Codex session

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** #450

**Setup:**

1. SMOKE-CHAT-01 complete (smoke-chat-codex exists with ≥2 messages of transcript; smoke-chat-claude is the calling session).
2. **Precondition affirmation (§12.11 explicit Setup):** screenshot-affirm the `smoke-chat-codex` tab is currently visible in the tab bar (the session is still open, not closed by an upstream entry's Teardown). Then screenshot-affirm the `smoke-chat-claude` tab is also visible (the calling session is reachable). If either tab is absent, the precondition is not met — re-spawn the missing session via the standard `+` → CLI flow before proceeding.
3. Note the workbench session id of `smoke-chat-codex` (hover its sidebar row, read the tooltip, copy the id).

**Steps:**

1. Click the `smoke-chat-claude` tab in the tab bar to focus its Claude terminal.
2. Type a natural prompt into the Claude pane: `Please call the workbench MCP tool session_summarize with session_id=<codex-id> and show me the result it returns.` (substitute the actual id from Setup step 3.)
3. Press Enter. The Claude CLI invokes the MCP tool.
4. Wait for the Claude pane to render the MCP tool's returned content.

**Verify:**

* ≤10s after step 3: the Claude pane visibly shows a tool-call invocation block for `mcp__workbench__session_summarize` with the session\_id argument matching the Codex session id from Setup. → `4.6/assertion-01-tool-call-rendered.png`
* ≤10s after step 3: the tool-result content rendered below the call shows a prose summary of the Codex session's transcript (paragraph(s) describing what happened in the Codex conversation) and DOES NOT contain the literal error string `Error: path argument must be string` (or any "must be of type string" message). → `4.6/assertion-02-summary-not-error.png`
* ≤15s after step 3: the Claude pane's response continues with Claude's natural-language confirmation that the summary was successful (e.g., a sentence repeating or paraphrasing the summary content). → `4.6/assertion-03-claude-confirms.png`

**Teardown:**

* N/A — smoke-chat-\* state preserved.

***

### 4.1.GEMINI: SESS-PATH-ENCODING-GEMINI-01 — Gemini session restart on unusual-path project (peer of 4.1 Claude)

**Cascade-from:** 0.B
**Closes gap for:** §12.11 axis-2 — Gemini peer of 4.1 path-encoding-restart

**Setup:**

1. 0.B complete (auth seated for Gemini equivalent — Gemini credentials provisioned by orchestrator).
2. Orchestrator pre-creates the workspace path: `ssh ${WORKBENCH_HOST} 'docker exec ${WORKBENCH_CONTAINER} mkdir -p /data/workspace/foo.bar/sub_dir+with-stuff'` (or re-use the directory from 4.1 if 4.1 ran in the same session — 4.1's Teardown removes it, so this entry's Setup must re-create).

**Steps:**

1. In the sidebar, click `+ Project` under a program. Type project name `path-encode-gemini-test`. Type path `/data/workspace/foo.bar/sub_dir+with-stuff`. Click Save.
2. Click `+` on the new project's header → click `Gemini` → name session `pathenc-gemini-01` → `Start Session`. Wait up to 30s for the Gemini tab and the Gemini `>` prompt at the bottom of the pane.
3. Right-click the `pathenc-gemini-01` row → `Restart`.

**Verify:**

* ≤5s after step 1: the `path-encode-gemini-test` project row is visible in the sidebar. → `4.1.GEMINI/assertion-01-project-created.png`
* ≤30s after step 2: the `pathenc-gemini-01` session tab is visible and the Gemini `>` prompt is rendered. → `4.1.GEMINI/assertion-02-session-created.png`
* ≤10s after step 3: the `pathenc-gemini-01` row remains attached to the `path-encode-gemini-test` project in the sidebar after restart. → `4.1.GEMINI/assertion-03-session-attached-after-restart.png`
* ≤10s after step 3: the Gemini `>` prompt is rendered again at the bottom of the restarted session's terminal pane. → `4.1.GEMINI/assertion-04-gemini-ready-after-restart.png`

**Teardown:**

* Right-click `pathenc-gemini-01` → Remove session. Right-click `path-encode-gemini-test` → Remove project. Orchestrator removes workspace dir if no other entry needs it.

**Result:** ☐ PASS ☐ FAIL

### 4.1.CODEX: SESS-PATH-ENCODING-CODEX-01 — Codex session restart on unusual-path project (peer of 4.1 Claude)

**Cascade-from:** 0.B
**Closes gap for:** §12.11 axis-2 — Codex peer of 4.1 path-encoding-restart

**Setup:**

1. 0.B complete. Codex credentials provisioned.
2. Orchestrator pre-creates workspace path (same as 4.1.GEMINI Setup step 2 — re-create if removed).

**Steps:**

1. `+ Project` → `path-encode-codex-test` at `/data/workspace/foo.bar/sub_dir+with-stuff` → Save.
2. `+` on the new project → `Codex` → `pathenc-codex-01` → Start Session. Wait up to 30s for the Codex tab and Codex input field at the bottom of the pane.
3. Right-click `pathenc-codex-01` → `Restart`.

**Verify:**

* ≤5s after step 1: project row visible. → `4.1.CODEX/assertion-01-project-created.png`
* ≤30s after step 2: Codex session tab visible with Codex input field rendered. → `4.1.CODEX/assertion-02-session-created.png`
* ≤10s after step 3: row stays attached to the project after restart. → `4.1.CODEX/assertion-03-session-attached-after-restart.png`
* ≤10s after step 3: Codex input field re-renders at the bottom of the pane post-restart. → `4.1.CODEX/assertion-04-codex-ready-after-restart.png`

**Teardown:**

* Right-click `pathenc-codex-01` → Remove. Right-click `path-encode-codex-test` → Remove. Orchestrator removes workspace dir.

**Result:** ☐ PASS ☐ FAIL

### 4.2.GEMINI: SESS-RAPID-CREATE-GEMINI-01 — 5 rapid Gemini session clicks → 5 distinct rows (peer of 4.2 Claude)

**Cascade-from:** 2.1
**Closes gap for:** §12.11 axis-2 — Gemini peer of 4.2 rapid-create / tmpId-collision

**Setup:**

1. 2.1 complete. Gemini credentials provisioned.
2. Note the current count of session rows under `wb-seed` in the sidebar (baseline screenshot).

**Steps:**

1. Click `+` on the `wb-seed` project header. Click `Gemini`. Type `rapid-gemini-01` and click `Start Session`.
2. Immediately (without waiting for the new row to render) click `+` on `wb-seed` again → `Gemini` → `rapid-gemini-02` → Start.
3. Repeat for `rapid-gemini-03`, `rapid-gemini-04`, `rapid-gemini-05` — all five requested within 1 wall-clock second of step 1's click.

**Verify:**

* ≤3s after step 3: five distinct rows labeled `rapid-gemini-01..05` visible under `wb-seed`. → `4.2.GEMINI/assertion-01-five-distinct-rows.png`
* ≤30s after step 3: each of the five tabs is openable from the sidebar and each renders the Gemini `>` prompt at the bottom of the pane. → `4.2.GEMINI/assertion-02-all-five-openable.png`

**Teardown:**

* Right-click each `rapid-gemini-01..05` row → Remove session. Sidebar returns to 2.1 / SMOKE-CHAT-01 baseline.

**Result:** ☐ PASS ☐ FAIL

### 4.2.CODEX: SESS-RAPID-CREATE-CODEX-01 — 5 rapid Codex session clicks → 5 distinct rows (peer of 4.2 Claude)

**Cascade-from:** 2.1
**Closes gap for:** §12.11 axis-2 — Codex peer of 4.2 rapid-create / tmpId-collision

**Setup:**

1. 2.1 complete. Codex credentials provisioned.

**Steps:**

1. `+` on `wb-seed` → `Codex` → `rapid-codex-01` → Start. Immediately repeat for `rapid-codex-02..05` within 1 wall-clock second.

**Verify:**

* ≤3s after step 1: five distinct `rapid-codex-01..05` rows visible under `wb-seed`. → `4.2.CODEX/assertion-01-five-distinct-rows.png`
* ≤30s after step 1: each of the five tabs renders the Codex input field at the bottom of the pane. → `4.2.CODEX/assertion-02-all-five-openable.png`

**Teardown:**

* Right-click each row → Remove session.

**Result:** ☐ PASS ☐ FAIL

### 4.3.CODEX: SESS-CODEX-PARSER-01 — Codex session row shows activity timestamp from JSONL (peer of 4.3 Gemini)

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** §12.11 axis-2 — Codex peer of 4.3 JSONL-parser timestamp

**Setup:**

1. SMOKE-CHAT-01 complete (smoke-chat-codex exists; the SMOKE-CHAT-01 arithmetic round-trip drove ≥2 message records into its Codex rollout JSONL).
2. **Precondition affirmation:** screenshot-affirm the `smoke-chat-codex` row in the sidebar shows ANY timestamp value (not empty); this is the baseline against which "advancing" would be measured. The parser must produce a non-empty value.
3. Set sidebar `#session-sort` to `Recent activity`.

**Steps:**

1. Click the sidebar's `↻` refresh affordance.
2. Observe the sidebar re-render. Find the `smoke-chat-codex` row.

**Verify:**

* ≤5s after step 1: the `smoke-chat-codex` row's timestamp shown below the row name reads a recent value (e.g., `just now`, `Ns ago`, `Nm ago`) — NOT a stale "session-start" timestamp or an empty value. → `4.3.CODEX/assertion-01-codex-timestamp-non-empty.png`
* ≤5s after step 1: the `smoke-chat-codex` row sorts ABOVE or AT THE SAME LEVEL as any session with no recent activity (verifying that the Codex parser produces an advancing timestamp the sort consumes). → `4.3.CODEX/assertion-02-sort-consistent.png`

**Teardown:**

* N/A — state preserved for 3.2 / other entries.

**Result:** ☐ PASS ☐ FAIL

### 4.6.CLAUDE: SESS-SUMMARIZE-CLAUDE-TARGET-01 — `session_summarize` MCP tool produces summary for Claude session (peer of 4.6 Codex)

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** §12.11 axis-2 — Claude target peer of 4.6 (Codex target)

**Setup:**

1. SMOKE-CHAT-01 complete (smoke-chat-claude exists with ≥2 messages of transcript).
2. **Precondition affirmation:** screenshot-affirm the `smoke-chat-claude` tab is visible in the tab bar.
3. Note the workbench session id of `smoke-chat-claude` (hover its sidebar row, read the tooltip, copy the id).
4. Setup creates a separate Claude session to call summarize from — so the target session is NOT the calling session. Click `+` on `wb-seed` → `Claude` → name `summarize-caller` → Start Session. Wait for ready.

**Steps:**

1. Click the `summarize-caller` tab to focus.
2. Type into the Claude pane: `Please call the workbench MCP tool session_summarize with session_id=<claude-target-id> and show me the result it returns.` (substitute the smoke-chat-claude id from Setup step 3.)
3. Press Enter. Wait for the response.

**Verify:**

* ≤10s after step 3: the `summarize-caller` pane shows a tool-call invocation block for `mcp__workbench__session_summarize` with the correct session\_id argument. → `4.6.CLAUDE/assertion-01-tool-call-rendered.png`
* ≤10s after step 3: the tool-result content is a prose summary of the smoke-chat-claude transcript; DOES NOT contain `Error:` or any error message indicating Claude transcript could not be read. → `4.6.CLAUDE/assertion-02-summary-not-error.png`
* ≤15s after step 3: the `summarize-caller` pane's response continues with Claude's natural-language confirmation. → `4.6.CLAUDE/assertion-03-claude-confirms.png`

**Teardown:**

* Right-click `summarize-caller` → Remove session. smoke-chat-claude preserved.

**Result:** ☐ PASS ☐ FAIL

### 4.6.GEMINI: SESS-SUMMARIZE-GEMINI-TARGET-01 — `session_summarize` MCP tool produces summary for Gemini session (peer of 4.6 Codex)

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** §12.11 axis-2 — Gemini target peer of 4.6 (Codex target)

**Setup:**

1. SMOKE-CHAT-01 complete (smoke-chat-gemini exists with ≥2 messages of transcript; smoke-chat-claude is the calling session).
2. **Precondition affirmation:** screenshot-affirm both smoke-chat-gemini and smoke-chat-claude tabs are visible in the tab bar.
3. Note the workbench session id of `smoke-chat-gemini`.

**Steps:**

1. Click `smoke-chat-claude` tab.
2. Type: `Please call the workbench MCP tool session_summarize with session_id=<gemini-target-id> and show me the result it returns.`
3. Press Enter.

**Verify:**

* ≤10s after step 3: Claude pane shows tool-call block for `mcp__workbench__session_summarize` with the Gemini session\_id argument. → `4.6.GEMINI/assertion-01-tool-call-rendered.png`
* ≤10s after step 3: tool-result is a prose summary of the Gemini transcript; no `Error:` content. → `4.6.GEMINI/assertion-02-summary-not-error.png`
* ≤15s after step 3: Claude confirms naturally. → `4.6.GEMINI/assertion-03-claude-confirms.png`

**Teardown:**

* N/A — smoke-chat-\* state preserved.

**Result:** ☐ PASS ☐ FAIL

***

## Section 5: Projects + Programs

Verify CRUD + cascade behavior for projects and programs at the sidebar level: rename conflict (#332) and project-remove cascade across tmux + JSONL + MCP unregister (#336).

***

### 5.1: PROJ-PROGRAM-RENAME-CONFLICT-01 — Program rename to existing name is rejected with visible conflict

**Cascade-from:** SMOKE-PROJ-01
**Closes gap for:** #332

**Setup:**

1. SMOKE-PROJ-01 complete (`smoke-proj-<timestamp>` project exists in the sidebar).
2. Setup creates two distinct programs (containers for projects) inside the sidebar via the Add Program affordance:
    * Click `+` (Add Program) in the sidebar header. The Add Program modal opens. Type `rename-prog-A` and click Save.
    * Click `+` again. Type `rename-prog-B` and click Save.
        Verify both program rows are visible in the sidebar before proceeding.

**Steps:**

1. Locate the `rename-prog-A` program row in the sidebar. Click the ✎ pencil affordance next to its name (or right-click → Rename).
2. The rename input field becomes editable (or a small inline modal opens depending on the implementation pattern).
3. Type `rename-prog-B` (the name already owned by the other program).
4. Press Enter or click Save.

**Verify:**

* ≤2s after step 4: a visible error indicator appears (toast, banner, or inline error message) naming a conflict — the message contains text like "already exists", "conflict", or "name in use". → `5.1/assertion-01-conflict-message-visible.png`
* ≤2s after step 4: the `rename-prog-A` program row STILL displays the name `rename-prog-A` (the rename did not commit). → `5.1/assertion-02-original-name-preserved.png`
* ≤2s after step 4: the `rename-prog-B` program row also remains, named `rename-prog-B` (no duplicate, no clobber). → `5.1/assertion-03-target-name-untouched.png`

**Teardown:**

* Press Escape or click outside to dismiss the error/rename input. Right-click each of `rename-prog-A` and `rename-prog-B` rows → Remove program. Sidebar returns to SMOKE-PROJ-01 baseline.

***

### 5.2: PROJ-REMOVE-CASCADE-01 — Project remove cascades sidebar + JSONL + MCP unregister

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** #336

**Setup:**

1. SMOKE-CHAT-01 complete. Precondition check (not under test in this entry): confirm the three `smoke-chat-claude` / `smoke-chat-gemini` / `smoke-chat-codex` rows are visible in the sidebar under `wb-seed` — this entry inherits SMOKE-CHAT-01's "three-CLI session-create primitive works" guarantee, then exercises that primitive on a sacrificial sister project (the smoke-chat-\* state itself is NOT mutated; the cascade-from is documenting the upstream primitive, not the upstream rows).
2. Setup creates a sacrificial sister project carrying its own three CLI sessions (so the cascade can be observed end-to-end without disturbing the smoke-chat-\* sessions):
    * Click `+ Project` under any program. Type `cascade-test-proj`. Set the path to `/data/workspace/cascade-test-proj` (orchestrator pre-creates this path if needed). Click Save.
    * On the new `cascade-test-proj` row, click `+` → `Claude` → name `cascade-claude-01` → Start Session. Wait for ready.
    * Repeat for Gemini (`cascade-gemini-01`) and Codex (`cascade-codex-01`).
    * Verify three session rows exist under `cascade-test-proj` in the sidebar.

**Steps:**

1. Right-click the `cascade-test-proj` project row in the sidebar → click `Remove` in the context menu. (Or use the ✎ pencil → Remove flow per the workbench modal pattern.)
2. A confirm modal appears asking to confirm removal. Click `Confirm`.
3. After the confirmation, observe the sidebar state.
4. Click the `Files` tab in the right panel. Navigate the file tree to `~/.claude/projects/` (or the equivalent path for the workspace's JSONL directory).
5. Observe whether the directory entry for the just-removed project exists.

**Verify:**

* ≤10s after step 2: the `cascade-test-proj` project row is no longer visible in the sidebar. → `5.2/assertion-01-project-row-gone.png`
* ≤10s after step 2: all three `cascade-claude-01` / `cascade-gemini-01` / `cascade-codex-01` session rows are no longer visible (they cascaded with their parent project). → `5.2/assertion-02-session-rows-gone.png`
* ≤10s after step 2: any tabs that were open for the removed sessions show a "session removed" state or are closed — no tab continues live for a deleted session. → `5.2/assertion-03-tabs-closed.png`
* ≤5s after step 4: the file tree visibly does NOT contain a directory entry for the just-removed project's JSONL store (the directory was deleted by the cascade). → `5.2/assertion-04-jsonl-dir-gone.png`

**Teardown:**

* Orchestrator removes `/data/workspace/cascade-test-proj` if it still exists. SMOKE-CHAT-01 baseline preserved on `wb-seed`.

***

### 5.2.PENCIL: PROJECT-CONFIG-STATE-VIA-PENCIL-01 — ✎ pencil opens Project Config and changes project state

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** §12.11 axis-2 — ✎ pencil affordance as a distinct entry point to project-level configuration. The pencil opens a Project Config modal containing a State dropdown (active / archived / hidden) and a Save button; this entry verifies the State-change flow the pencil enables.

**Setup:**

1. SMOKE-CHAT-01 complete.
2. Setup creates a sacrificial sister project (so the State change is observable without disturbing upstream state):
    * `+ Project` → `pencil-state-test` at `/data/workspace/pencil-state-test` (orchestrator pre-creates path if needed) → Save.
    * On `pencil-state-test`, `+` → `Claude` → name `pencil-claude-01` → Start Session. Wait for ready.
    * Verify the `pencil-state-test` project row and `pencil-claude-01` session row are visible in the sidebar.
3. **Baseline-state affirmation (§12.11 explicit Setup):** screenshot-affirm the `pencil-state-test` project row's current visual state is "active" (the default — no archived / hidden indicator). The test changes state to "archived" via the pencil affordance; baseline must be "active" for the transition to be observable.

**Steps:**

1. Locate the `pencil-state-test` project row in the sidebar. Hover the row to reveal the ✎ pencil affordance (if it is hidden until hover).
2. Click the ✎ pencil affordance on the `pencil-state-test` row.
3. The Project Config modal opens. Locate the `State` dropdown control.
4. Click the State dropdown. Select the `archived` option.
5. Click the modal's `Save` button.

**Verify:**

* ≤2s after step 2: the Project Config modal is visibly rendered as a workbench-styled overlay with at least a `State` dropdown control and a `Save` button visible. → `5.2.PENCIL/assertion-01-project-config-modal-rendered.png`
* ≤1s after step 4: the State dropdown's visible selected value is `archived` (the dropdown UI reflects the click). → `5.2.PENCIL/assertion-02-state-dropdown-set-to-archived.png`
* ≤3s after step 5: the modal dismisses AND the `pencil-state-test` project row in the sidebar visibly reflects the archived state (per-product styling — dimmed text, archived badge, moved to an archived section per the sidebar's filter, or removed from the default Active filter). → `5.2.PENCIL/assertion-03-row-shows-archived-state.png`

**Teardown:**

* Restore the project state: click the `pencil-state-test` row's ✎ pencil → Project Config modal → State dropdown → select `active` → Save. Then right-click the row → `Remove` → Confirm (right-click is the canonical Remove path; this entry no longer tests Remove). Orchestrator removes `/data/workspace/pencil-state-test`. State returns to SMOKE-CHAT-01 baseline.

**Result:** ☐ PASS ☐ FAIL

***

## Section 6: Tabs + Terminal

Verify tab switching does not thrash layout (#343) and the async session-resolver eliminates input-lag jank under concurrent session load (#338).

***

### 6.1: TABS-LAYOUT-NOTHRASH-01 — 10 rapid tab switches show no observable layout flash

**Cascade-from:** SMOKE-TABS-01
**Closes gap for:** #343

**Setup:**

1. SMOKE-TABS-01 complete (after that entry, 2 tabs remain in the tab bar: `smoke-chat-codex` and `smoke-chat-gemini`; the claude tab was closed in SMOKE-TABS-01).
2. Mark the current visual position of a stable reference element in the main panel (e.g., the status bar's connection indicator) by screenshot — this anchor is used to detect layout shift.

**Steps:**

1. Click the `smoke-chat-codex` tab. For each click, bracket the click with `performance.now()` markers via Playwright `browser_evaluate` (`const t0 = performance.now(); /* click */; await new Promise(r => requestAnimationFrame(() => r())); const t1 = performance.now();`) — records the click-to-next-paint duration. Wait ≤500ms after the click before the next click.
2. Click the `smoke-chat-gemini` tab. Same `performance.now()` bracketing. Capture a screenshot ≤500ms after the click.
3. Repeat the click-codex / click-gemini sequence 5 more times (10 total switches). For each click: bracket with `performance.now()` to record duration AND capture a screenshot at ≤500ms.

**Verify:**

* ≤50ms after each of the 10 clicks (sub-second duration measurement via `performance.now()` bracketing per STD-003 §12.8 — the observable being measured is duration, not rendered content): the click-to-next-paint delta is ≤50ms in every measurement (p100 ≤50ms across the 10-click sample). → `6.1/assertion-01-paint-duration-table.png` (10 timing values rendered in the manifest)
* ≤500ms after each of the 10 clicks (content affirmation at a wider screenshot-friendly bound per §12.8): the active terminal pane visibly shows the clicked CLI's prompt glyph in the captured frame (Codex input box on codex-tab clicks vs Gemini `>` prompt on gemini-tab clicks). → `6.1/assertion-02-pane-swap-{01..10}.png` (10 frames)
* ≤500ms after each of the 10 clicks: the status bar's reference element position (pixel coordinates compared against the Setup anchor screenshot from Setup step 2) has drifted ≤2px in any direction in the captured frame — no layout reflow per click. → `6.1/assertion-03-no-layout-shift-{01..10}.png` (10 frames vs anchor)
* ≤2s after step 3's final click: the scrollback content in the terminal pane is intact for whichever tab was last clicked (the last 5 lines of that tab's content from before the switching sequence are visible by scrolling). → `6.1/assertion-04-scrollback-intact.png`

**Teardown:**

* N/A — tab state preserved for downstream entries.

***

### 6.2: TERM-INPUT-LAG-01 — Keystrokes echo without jank under 6-session concurrent load

**Cascade-from:** 4.2
**Closes gap for:** #338

**Setup:**

1. 4.2 complete (5 rapid-create Claude sessions exist, but were torn down in 4.2's teardown). Setup recreates the concurrent-session load:
    * In `wb-seed`, create 3 Claude sessions (`load-claude-01..03`) via the `+` → `Claude` dropdown flow.
    * Create 3 Gemini sessions (`load-gemini-01..03`) via the `+` → `Gemini` dropdown flow.
    * Verify all 6 session tabs are open and each terminal's ready observable is visible.

**Steps:**

1. Click the `load-claude-01` tab to focus.
2. Use Playwright's `browser_evaluate` to capture `performance.now()` as `t0`.
3. Send 100 keystrokes via `browser_press_key` in rapid succession (e.g., 100 individual `a` keypresses), each followed by capturing `performance.now()` — record the timestamp at which the `a` glyph appears in the rendered terminal pane (verified by screenshot polling, not by reading `term.buffer`).
4. Compute the input-to-render latency for each keystroke: `frame_visible_time - keypress_time`.
5. Aggregate to p95 latency.

**Verify:**

* ≤200ms p95 latency across the 100-keystroke sample: the per-keystroke input-to-render latency, measured as the elapsed `performance.now()` delta between `browser_press_key` and the next captured frame showing the new glyph, is below 200ms at the 95th percentile. (§12.8 sub-second timing: the observable being measured is duration, not rendered content — `performance.now()` is the legitimate instrument per §12.8.) → `6.2/assertion-01-p95-input-lag.png` (chart / table of latencies)
* ≤2s after step 3 final keystroke: the terminal pane of `load-claude-01` visibly shows a run of 100 `a` glyphs as the most recent input. → `6.2/assertion-02-keystrokes-rendered.png`

**Teardown:**

* Right-click each of `load-claude-01..03` and `load-gemini-01..03` rows → Remove. Sidebar returns to 4.2 baseline.

***

## Section 7: Tasks Panel

Verify task drag/reparent atomicity (#327) and v2 contract validation rejects orphan folder\_path while accepting valid project bindings (#388).

***

### 7.1: TASK-DRAG-REPARENT-01 — Drag task between projects lands at correct rank

**Cascade-from:** SMOKE-PROJ-01
**Closes gap for:** #327

**Setup:**

1. SMOKE-PROJ-01 complete (`smoke-proj-<timestamp>` project exists; `wb-seed` is also present).
2. Seed tasks via the Tasks panel UI (not via direct DB / MCP — keeps the entry self-contained as a UI flow):
    * Click the `Tasks` tab in the right panel.
    * With `wb-seed` selected in the sidebar, click `+ Task` and add three tasks: `wb-task-A`, `wb-task-B`, `wb-task-C` (one at a time, naming each in the task-detail modal that opens, clicking Save).
    * Select `smoke-proj-<timestamp>` in the sidebar. Repeat: add `smoke-task-1`, `smoke-task-2`, `smoke-task-3`.

**Steps:**

1. Select `wb-seed` in the sidebar. Confirm `wb-task-A`, `wb-task-B`, `wb-task-C` are visible in the Tasks panel.
2. Click and hold the `wb-task-B` row. Drag it onto the `smoke-proj-<timestamp>` project row in the sidebar (cross-project drop target).
3. The drop should land `wb-task-B` between rank 2 (`smoke-task-2`) and rank 3 (`smoke-task-3`) in the destination project.
4. Release the mouse.
5. Select `smoke-proj-<timestamp>` in the sidebar to view its Tasks panel.

**Verify:**

* ≤3s after step 4: `wb-task-B` is no longer visible in the `wb-seed` Tasks panel (it left its source). → `7.1/assertion-01-task-left-source.png`
* ≤3s after step 5: the `smoke-proj-<timestamp>` Tasks panel shows `wb-task-B` positioned between `smoke-task-2` and `smoke-task-3` (i.e., the order is `smoke-task-1`, `smoke-task-2`, `wb-task-B`, `smoke-task-3`). → `7.1/assertion-02-task-at-rank.png`
* ≤5s after a sidebar refresh (click the refresh affordance): the position persists — `wb-task-B` is still between `smoke-task-2` and `smoke-task-3`. → `7.1/assertion-03-rank-persisted.png`

**Teardown:**

* Right-click each of the seeded tasks → Delete. Both projects' Tasks panels return to empty. State preserved for Section 9.

***

### 7.2: TASK-V2-CONTRACT-01 — task\_add rejects orphan, accepts valid project binding

**Cascade-from:** SMOKE-PROJ-01
**Closes gap for:** #388

**Setup:**

1. SMOKE-PROJ-01 complete (project exists).
2. Click the `Tasks` tab in the right panel. Click no project in the sidebar (or click to deselect — leave no active project, so a task add without explicit project binding is the failure case).

**Steps:**

1. With no active project selected, click `+ Task` in the Tasks panel header.
2. The task-detail modal opens with empty Title field. The Project select dropdown shows `(no project)` or is empty.
3. Type `orphan-task` in the Title field. Click `Save` without choosing a project.
4. Click on the `smoke-proj-<timestamp>` row in the sidebar to select it as the active project. Click `+ Task` again.
5. Type `bound-task` in the Title field. The Project dropdown now defaults to `smoke-proj-<timestamp>`. Click `Save`.

**Verify:**

* ≤3s after step 3: an error message is visibly rendered in the task-detail modal (or as a toast) indicating the project binding is required — message contains text like "project required", "must select project", or "cannot create without project". → `7.2/assertion-01-orphan-rejected.png`
* ≤3s after step 3: NO new task row appears in the Tasks panel — neither under any project nor as an orphan. → `7.2/assertion-02-no-orphan-row.png`
* ≤3s after step 5: the `bound-task` row is visible in the `smoke-proj-<timestamp>` Tasks panel. → `7.2/assertion-03-bound-task-appears.png`
* ≤3s after step 5: NO copy of `bound-task` appears under any other project. → `7.2/assertion-04-bound-task-correct-project.png`

**Teardown:**

* Right-click `bound-task` → Delete. Tasks panel returns to SMOKE-PROJ-01 baseline.

***

## Section 8: File Tree / File Browser

Verify post-jQuery-removal file tree renders cleanly with no `jquery is not defined` errors and the Add Project picker still expands directories.

***

### 8.1: FILES-NOJQUERY-01 — Cold-load + Add Project picker renders without jQuery references

**Cascade-from:** 2.1
**Closes gap for:** #319

**Setup:**

1. 2.1 complete (shell rendered).
2. Clear the DevTools console buffer.

**Steps:**

1. Reload the page (`F5` or Playwright `browser_navigate` to the same URL). Wait for the shell to re-render.
2. Click `+` (Add Program) in the sidebar header. Cancel the Add Program modal. Click `+ Project` under any existing program. The project-create modal opens with the file-tree picker.
3. Click `/data/workspace` in the file tree to expand it.

**Verify:**

* ≤3s after step 2: the file-tree picker is visibly rendered with at least the workspace root row visible. (Primary affirmation: jQuery's removal did not break the picker — the legacy code path required `$.tree(...)`; the new vanilla code path is what produces this render.) → `8.1/assertion-01-picker-rendered.png`
* ≤3s after step 3: at least one child directory of `/data/workspace` is visible as an indented row under the expanded root. → `8.1/assertion-02-child-visible.png`
* ≤3s after step 1: supplementary diagnostic — the DevTools console (rendered DevTools strip) shows zero entries containing the literal text `jquery is not defined`, `$ is not defined`, or `jQuery is not defined`. The picker rendering in assertion-01 is the primary screen-affirmable proof; the console snapshot is corroborating evidence. → `8.1/assertion-03-no-jquery-console-error.png`

**Teardown:**

* Click `Cancel` on the project-create modal. State returns to 2.1 baseline.

***

## Section 9: Issue Picker

Verify the issue picker honors GH Enterprise host / quoted-repo derivation (#328) and uses the configured org rather than hardcoded `rmdevpro/` (#329).

***

### 9.1: ISSUE-PICKER-GHE-01 — Picker lists issues from GH Enterprise host derived from project origin

**Cascade-from:** 7.1
**Closes gap for:** #328

**Setup:**

1. 7.1 complete (Tasks panel flow exercised).
2. Orchestrator pre-configures a project with a GHE-style origin (or a quoted-repo origin): `ssh ${WORKBENCH_HOST} 'docker exec ${WORKBENCH_CONTAINER} bash -lc "cd /data/workspace && git init ghe-test && cd ghe-test && git remote add origin https://github.enterprise.example.com/team-x/ghe-test.git"'`.
3. In the workbench UI, click `+ Project` under a program. Add the `ghe-test` project pointing at `/data/workspace/ghe-test`.
4. Open the Tasks panel for `ghe-test`. Click `+ Task` and add a task named `ghe-task-01`. Click Save.
5. **Project-selected affirmation (§12.11 explicit Setup):** click the `ghe-test` project row in the sidebar to ensure it is the currently-selected project (the Tasks panel scopes to the active project; without this affirmation a subsequent test step could open task-detail on a task from a different project). Screenshot-affirm `ghe-test` is the active project row (visual selection state distinct from other rows).

**Steps:**

1. With the `ghe-task-01` task visible in the Tasks panel, click the task row to open the task-detail modal.
2. Locate the `GitHub issue` field. Click the `Pick…` button next to it.
3. The issue-picker modal opens.

**Verify:**

* ≤5s after step 2: the issue-picker modal is visibly rendered with a header showing `Pick a GitHub issue` plus a path-like indicator naming the project's repo. The path-like indicator shows `github.enterprise.example.com/team-x/ghe-test` (NOT `github.com/...` and NOT `rmdevpro/...`). → `9.1/assertion-01-picker-shows-ghe-host.png`
* ≤5s after step 3 (waiting for the issue list to populate): the picker either shows a list of issues from that GHE host OR shows a credentials/auth-required error message that names the GHE host explicitly. Either outcome is acceptable — what is NOT acceptable is a GraphQL error toast or a 5xx error indicating the request was malformed. → `9.1/assertion-02-no-graphql-error.png`

**Teardown:**

* Close the issue-picker modal (× or Escape). Close the task-detail modal (Cancel). Right-click `ghe-test` project → Remove. Orchestrator removes `/data/workspace/ghe-test`. State returns to 7.1 baseline.

***

### 9.2: ISSUE-PICKER-CUSTOM-ORG-01 — Picker uses configured org, not hardcoded rmdevpro

**Cascade-from:** 7.1
**Closes gap for:** #329

**Setup:**

1. 7.1 complete.
2. Orchestrator clones a repo from a non-`rmdevpro` org into the workspace: `ssh ${WORKBENCH_HOST} 'docker exec ${WORKBENCH_CONTAINER} bash -lc "cd /data/workspace && git clone https://github.com/different-org/picker-test.git"'` (orchestrator picks any public test repo under a non-rmdevpro org — substitute the real URL).
3. Add the project to the workbench: `+ Project` → `picker-test` at `/data/workspace/picker-test` → Save.
4. Open the Tasks panel for `picker-test`. Add a task `org-task-01`. Save.

**Steps:**

1. Click `org-task-01` to open task-detail.
2. Click `Pick…` next to the GitHub issue field.
3. The issue-picker modal opens.

**Verify:**

* ≤3s after step 2: the issue-picker modal's header path-like indicator reads `github.com/different-org/picker-test` (or whatever the configured upstream org is). → `9.2/assertion-01-picker-shows-correct-org.png`
* ≤3s after step 2: the indicator does NOT read `github.com/rmdevpro/<...>`. → `9.2/assertion-02-not-rmdevpro.png`

**Teardown:**

* Close the issue-picker. Close task-detail. Remove the `picker-test` project. Orchestrator removes the cloned repo. State returns to 7.1 baseline.

***

## Section 10: KB / Qdrant / Search

Verify KB clone-on-cold-start completes (#368) and large-file ingestion does not OOM the qdrant-sync streaming path (#443).

***

### 10.1: KB-COLD-CLONE-01 — KB clone completes on cold container; roles dropdown populates

**Cascade-from:** cold (standard registry image, fresh /data)
**Closes gap for:** #368

**Setup:**

1. Orchestrator spins up a fresh container with an ephemeral `/data` volume and confirms `/data/knowledge-base` does NOT exist before workbench starts: `docker run -d --name workbench-kb-cold -v <ephemeral>:/data -p <port>:7860 <image>; sleep 5; docker exec workbench-kb-cold ls /data/knowledge-base` should error with `No such file or directory`.
2. Bind `${WORKBENCH_URL}` to this fresh container.

**Steps:**

1. Navigate to `${WORKBENCH_URL}`. Pass the gate if applicable.
2. Wait for the workbench shell to render.
3. Click `⚙ Settings` in the sidebar footer. Click the `General` tab.
4. Scroll to the `Knowledge Base` settings group within General. Observe the KB repo name + URL fields.
5. Wait for the KB status line (`#kb-status-line` in the General tab) to render a populated status.

**Verify:**

* ≤30s after step 1: a KB status indicator visible in the General settings tab transitions from a "checking" or empty state to a populated state showing a non-zero file count or a "ready"-style label. → `10.1/assertion-01-kb-status-ready.png`
* ≤30s after step 1: the KB repo URL field displays a populated URL (the configured upstream, e.g., `https://github.com/rmdevpro/workbench-kb`) — NOT empty, NOT an error placeholder. → `10.1/assertion-02-kb-url-populated.png`
* ≤30s after step 1: the role-files / KB-content area of the workbench shell (whichever surface consumes `/api/kb/status` to display role files — e.g., the Project's role-selector dropdown when starting a new session) shows a non-empty list. (Open a project's `+` → `Claude` flow; the role dropdown should list role files cloned from the KB.) → `10.1/assertion-03-role-dropdown-populated.png`

**Teardown:**

* Leave the kb-cold container running for 10.2 (downstream cascades from this entry). State preserved.

***

### 10.2: KB-LARGE-FILE-01 — 5MB markdown file ingests + searches without OOM

**Cascade-from:** 10.1
**Closes gap for:** #443

**Setup:**

1. 10.1 complete (KB cloned, container `workbench-kb-cold` running).
2. Orchestrator drops a 5MB markdown file into the KB working tree: `ssh ${WORKBENCH_HOST} 'docker exec workbench-kb-cold bash -lc "python3 -c \"print(\\\"## Section\\n\\\" * 100000)\" > /data/knowledge-base/large-test-doc.md"'`. The file contains a distinctive sentinel string `LARGEFILESENTINEL-7y3k` near the end.
3. The KB file watcher should pick up the new file and queue it for vector indexing. Wait up to 60s for the qdrant-sync streaming path to ingest the file. Orchestrator may check progress via `/api/kb/status` only as a diagnostic (Verify cannot probe this).

**Steps:**

1. In the workbench UI, locate the KB search surface (typically a search field exposed inside the KB area of Settings, or the `#session-search` field if scoped to KB content — substitute the project's actual search affordance).
2. Type `LARGEFILESENTINEL-7y3k` into the search field.
3. Press Enter or trigger the search action.

**Verify:**

* ≤5s after step 3: the search results area renders at least one result whose content snippet contains the sentinel string `LARGEFILESENTINEL-7y3k`. → `10.2/assertion-01-result-contains-sentinel.png`
* ≤5s after step 3: the workbench shell remains responsive — clicking another sidebar row responds within 1s (the container did not OOM and the page is not unresponsive). → `10.2/assertion-02-ui-responsive.png`
* ≤5s after step 3: no error toast / banner indicating "Qdrant unreachable", "Out of memory", or "Service unavailable" is visible. → `10.2/assertion-03-no-error-banner.png`

**Teardown:**

* Orchestrator removes the test file: `docker exec workbench-kb-cold rm /data/knowledge-base/large-test-doc.md`. Orchestrator stops + removes the `workbench-kb-cold` container.

***

## Section 11: Gate / Auth UI

Verify gate-page render consistency across boot-time loads (#337), sub-second login without Claude CLI fork (#333), rate-limit lockout (#351), and password-form structure on Settings + Git Accounts modals (#403).

**Two distinct fresh containers are required in this section.** 11.1 + 11.2 share one fresh container (`cold-fresh-container-A`) — 11.1's 10 boot-time loads do not touch the gate rate-limit bucket, so 11.2 can submit a correct login afterward. 11.3 spends the rate-limit bucket with 11 wrong-password attempts, so it runs on a separate fresh container (`cold-fresh-container-B`) provisioned by the orchestrator before the entry. Both labels are `cold`-class preconditions; the suffix distinguishes them.

***

### 11.1: GATE-RENDER-CONSISTENT-01 — Gate page renders consistently across 10 boot-time loads

**Cascade-from:** cold-fresh-container-A
**Closes gap for:** #337

**Setup:**

1. Orchestrator launches a fresh container with `GATE_PASSCODE=test-passcode-A` (env var) and `WORKBENCH_USER=tester` / `WORKBENCH_PASS=test-passcode-A`. Name it `workbench-gate-A`. Bind `${WORKBENCH_URL}` to it.
2. Capture a reference screenshot of the gate page on the first load to use as the comparison anchor.

**Steps:**

1. Navigate to `${WORKBENCH_URL}`. Capture screenshot at the moment the gate page renders.
2. Navigate away (e.g., `about:blank`). Then navigate back to `${WORKBENCH_URL}`. Capture screenshot.
3. Repeat step 2 eight more times (10 total loads).

**Verify:**

* ≤1s after each of the 10 navigations: the gate page renders with the username field + password field + Sign In button visible at the same screen position as the reference screenshot (pixel-position drift ≤4px). → `11.1/assertion-01-load-{01..10}.png` (10 frames)
* ≤1s after each of the 10 navigations: the gate-page background image / branding is identical across all 10 frames (no first-render visual jank where elements appear progressively after the first load only). → `11.1/assertion-02-background-stable.png` (composite diff)

**Teardown:**

* Leave `workbench-gate-A` running for 11.2 (which cascades from this entry). State preserved.

***

### 11.2: GATE-LOGIN-SPEED-01 — Correct password completes login ≤1s (no Claude CLI fork)

**Cascade-from:** 11.1
**Closes gap for:** #333

**Setup:**

1. 11.1 complete (`workbench-gate-A` container running, gate page reachable).
2. Navigate to `${WORKBENCH_URL}` to render the gate page if not already on it.
3. **Gate-page-current affirmation (§12.11 explicit Setup):** screenshot-affirm the current rendered view is the gate page — username field, password field, and Sign In button all visible — NOT the workbench shell (which would mean a prior 11.1 navigation already authenticated, in which case this entry's "shell loads from gate" timing assertion would be invalid). If the shell is rendered instead of the gate, log out first (click `⚙ Settings` → Logout, or use the explicit logout affordance) and reload the page so the gate is shown.

**Steps:**

1. Click into the username field. Type `tester`.
2. Click into the password field. Type `test-passcode-A`.
3. Click the `Sign In` button. Capture screenshots at 100ms intervals up to a 1.5s bound after the click.

**Verify:**

* ≤1s after step 3: the gate page is no longer visible — the workbench shell (sidebar + main panel) is rendered in its place. → `11.2/assertion-01-shell-loaded.png`
* ≤1s after step 3: the first captured frame showing the shell renders within the 1s bound — proving the login response path is sub-second, NOT the multi-second path the pre-fix Claude-CLI-fork would have produced. → `11.2/assertion-02-sub-second-transition.png`

**Teardown:**

* Click `⚙ Settings` → Logout (or use the explicit logout affordance). Orchestrator stops + removes `workbench-gate-A`.

***

### 11.3: GATE-RATE-LIMIT-01 — 11 wrong-password attempts trigger lockout with named limit

**Cascade-from:** cold-fresh-container-B
**Closes gap for:** #351

**Setup:**

1. Orchestrator launches a SEPARATE fresh container with `GATE_PASSCODE=test-passcode-B` / `WORKBENCH_USER=tester` / `WORKBENCH_PASS=test-passcode-B`. Name it `workbench-gate-B`. Bind `${WORKBENCH_URL}` to it. The rate-limit bucket is fresh.
2. Navigate to `${WORKBENCH_URL}` and confirm the gate page renders.

**Steps:**

1. Type `tester` in username. Type `wrong-password-attempt-01` in password. Click Sign In.
2. Wait for the error banner to render. Clear the password field. Type `wrong-password-attempt-02`. Click Sign In.
3. Repeat for attempts 03 through 10, each with a distinct wrong-password string, within a total wall-clock window of 5 seconds.
4. On the 11th attempt: type `wrong-password-attempt-11`. Click Sign In.
5. Wait 60 seconds (the rate-limit cooldown). After the wait, clear the password field and type the correct password `test-passcode-B`. Click Sign In.

**Verify:**

* ≤2s after step 4: a visibly rendered error banner names the rate-limit (text contains "rate limit", "too many attempts", or "try again in"). → `11.3/assertion-01-rate-limit-banner.png`
* ≤2s after step 4: the Sign In button's response latency is visibly \~500ms longer than the previous attempts' responses (the post-failure backoff delay is observable as a button-disabled or spinner state). → `11.3/assertion-02-backoff-delay.png`
* ≤2s after step 5 (after the 60s wait + correct password): the workbench shell renders, indicating the rate-limit bucket reset after cooldown. → `11.3/assertion-03-recovery-after-cooldown.png`

**Teardown:**

* Orchestrator stops + removes `workbench-gate-B`.

***

### 11.4: GATE-PASSWORD-FORM-01 — Password-input DOM warning is absent on Settings + Git Accounts modals

**Cascade-from:** 2.4
**Closes gap for:** #403

**Setup:**

1. 2.4 complete (Settings modal verified to open ≤500ms).
2. Clear the DevTools console buffer.
3. **Cleared-buffer affirmation (§12.11 explicit Setup):** capture a Playwright `browser_console_messages` snapshot immediately after clearing the buffer and screenshot-affirm the captured log shows zero entries (or only the system-level Playwright initialization line, no `[DOM]` warnings). This is the baseline against which the Verify "zero `[DOM] Password field` warnings" is measured.

**Steps:**

1. Click `⚙ Settings` in the sidebar.
2. The Settings modal opens. Click the `General` tab if not active. Click into the Gemini API Key input and type the character `x` (a single keystroke). Click into the Codex API Key input and type `x`. Click into the Hugging Face API Key input and type `x`.
3. Capture a screenshot of the General tab with the three fields visible (cursor in the last field; the typed characters render as masked glyphs).
4. Click the `Git` tab in the Settings modal's tab strip. Click into the `Personal access token` input and type the character `x`.
5. Capture a screenshot of the Git tab with the token field visible (typed character renders as masked glyph).
6. Keep both areas observed for a 5s window each — the supplementary console diagnostic spans these windows.

**Verify:**

* ≤1s after step 2: the General tab's AI Keys section renders three password input fields with placeholder text `Enter key...` for Gemini, Codex, and Hugging Face — each field is visibly a password input (characters render as dots / asterisks when typed). Test by typing a single character into each field and observing it renders as a masked glyph (not the literal character). → `11.4/assertion-01-general-password-fields-masked.png`
* ≤1s after step 4: the Git tab's Git Accounts section renders a `Personal access token` password input field — typing a character into it renders as a masked glyph. → `11.4/assertion-02-git-token-field-masked.png`
* ≤1s after step 2 + 5s observation: supplementary diagnostic — the DevTools console (Playwright `browser_console_messages` capture) shows zero `[DOM] Password field is not contained in a form` warning entries during the General tab observation window. → `11.4/assertion-03-general-console-clean.png`
* ≤1s after step 4 + 5s observation: supplementary diagnostic — same console check for the Git tab observation window. → `11.4/assertion-04-git-console-clean.png`

**Teardown:**

* Clear any test characters typed into the password fields. Press Escape to dismiss Settings. State returns to 2.4 baseline.

***

### 11.2.FOLLOWON: GATE-FOLLOWON-3CLI-01 — Post-gate-login 3-CLI session usage works

**Cascade-from:** 11.2
**Closes gap for:** §12.11 axis-2 — full user journey from gate-login through follow-on 3-CLI usage (Claude / Gemini / Codex)

**Setup:**

1. 11.2 complete (`workbench-gate-A` container running, gate authenticated, workbench shell rendered).
2. Confirm Claude / Gemini / Codex credentials are provisioned on this gate-A container (orchestrator decision — if the gate-A image was built with credentials seeded, no extra setup; if not, orchestrator provisions credentials via the standard injection path before Steps).

**Steps:**

1. In the workbench shell (post-gate-login), click `+ Project` under any program → name `gate-followon-test` at `/data/workspace/gate-followon-test` → Save.
2. Click `+` on `gate-followon-test` → `Claude` → name `gate-claude-01` → Start Session. Wait for ready observable.
3. Click `+` on `gate-followon-test` → `Gemini` → name `gate-gemini-01` → Start Session. Wait for ready observable.
4. Click `+` on `gate-followon-test` → `Codex` → name `gate-codex-01` → Start Session. Wait for ready observable.
5. Click the `gate-claude-01` tab. Type `please respond briefly with the word ack` in the Claude terminal and press Enter.
6. Click the `gate-gemini-01` tab. Type the same prompt in the Gemini terminal and press Enter.
7. Click the `gate-codex-01` tab. Type the same prompt in the Codex terminal and press Enter.

**Verify:**

* ≤30s after step 2: the Claude session tab is open and the Claude input area is rendered (per SMOKE-CHAT-01 step 5 claude form — typing a test character renders inline). → `11.2.FOLLOWON/assertion-01-claude-ready-post-gate.png`
* ≤30s after step 3: the Gemini session tab is open and the Gemini `>` prompt is rendered at the bottom of the pane. → `11.2.FOLLOWON/assertion-02-gemini-ready-post-gate.png`
* ≤30s after step 4: the Codex session tab is open and the Codex input field is rendered at the bottom of the pane. → `11.2.FOLLOWON/assertion-03-codex-ready-post-gate.png`
* ≤30s after step 5: the Claude terminal pane renders a coherent response containing `ack` (per SMOKE-CHAT-01-style content judgment) — confirms the gate's cookie / session context did not break Claude's flow post-login. → `11.2.FOLLOWON/assertion-04-claude-ack.png`
* ≤30s after step 6: the Gemini terminal pane renders a coherent response containing `ack`. → `11.2.FOLLOWON/assertion-05-gemini-ack.png`
* ≤30s after step 7: the Codex terminal pane renders a coherent response containing `ack`. → `11.2.FOLLOWON/assertion-06-codex-ack.png`

**Teardown:**

* Right-click each of `gate-claude-01`, `gate-gemini-01`, `gate-codex-01` → Remove session. Right-click `gate-followon-test` → Remove project. Orchestrator removes `/data/workspace/gate-followon-test`. State preserved for 11.2's container Teardown.

**Result:** ☐ PASS ☐ FAIL

***

## Section 12: MCP Tools (UI surface)

Verify the MCP tool catalog matches the registry (#361), project-MCP enable propagates to non-Claude sessions (#445), and `session_list` returns all three CLI types (#437). Every MCP-tool entry verifies through the **terminal pane the user is looking at** — the user types the MCP invocation (or asks the CLI to invoke it) and the screen renders the response. Stays inside §12.7's mouse / keyboard / monitor envelope.

***

### 12.1: MCP-CATALOG-LIST-01 — `tools/list` returns expected tool count from terminal

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** #361

**Setup:**

1. SMOKE-CHAT-01 complete (smoke-chat-claude is the calling session).

**Steps:**

1. Click the `smoke-chat-claude` tab to focus its terminal.
2. Type a natural prompt: `Please list all tools available from the workbench MCP server and tell me the total count.` Press Enter.
3. Wait for the Claude CLI to produce a response, which should include a tool list and count derived from the catalog.

**Verify:**

* ≤5s after step 2: the Claude pane renders a response listing workbench MCP tools by name (at minimum: `session_new`, `session_list`, `task_add`, `file_find` — substantive named tools, not an empty/error response). → `12.1/assertion-01-tool-list-rendered.png`
* ≤5s after step 2: the response includes an explicit count number (e.g., "23 tools" or similar) corresponding to the catalog size at the current image. → `12.1/assertion-02-count-stated.png`
* ≤5s after step 2: the response does NOT include the literal text `mcp-server.js` and `mcp-tools.js` count discrepancy (the catalog single-source-of-truth fix means the counts cannot drift). → `12.1/assertion-03-no-drift-mention.png`

**Teardown:**

* N/A — smoke-chat-claude state preserved.

***

### 12.2: MCP-PROJECT-ENABLE-PARITY-01 — Project MCP enable propagates to Gemini + Codex sessions

**Cascade-from:** SMOKE-PROJ-01
**Closes gap for:** #445

**Setup:**

1. SMOKE-PROJ-01 complete (`smoke-proj-<timestamp>` exists as project P).
2. Click `smoke-proj-<timestamp>` in the sidebar. Open its Project Settings (right-click → Settings, or the per-project ✎ pencil affordance).
3. **Clean-baseline affirmation (§12.11 explicit Setup):** locate the per-project MCP-servers section. Screenshot-affirm `test-mcp` is NOT already in the list (the list is empty, or contains only entries with different names). If `test-mcp` is present, remove it first so Step 1's "add test-mcp" is a true addition, not a no-op.
4. Click `+ Add MCP Server`. Set Name: `test-mcp` and Command: `echo test-mcp-running` (a no-op MCP that any registered CLI can see). Click Save.
5. Start two new sessions in P: a Gemini session named `parity-gemini` and a Codex session named `parity-codex` via the standard `+` → CLI dropdown flow.
6. Wait for both terminals to render their ready observables.

**Steps:**

1. Click the `parity-gemini` tab to focus its terminal.
2. Type `/mcp` and press Enter (Gemini's slash command to list MCP servers).
3. Wait for the response to render.
4. Click the `parity-codex` tab.
5. Type the Codex equivalent (`/mcp` or whatever the Codex MCP-list slash is at the current pinned version).
6. Press Enter. Wait for the response.

**Verify:**

* ≤10s after step 3: the Gemini terminal pane visibly shows `test-mcp` (or whatever name was set in Setup step 3) in its MCP-servers list output. → `12.2/assertion-01-gemini-sees-mcp.png`
* ≤10s after step 6: the Codex terminal pane visibly shows `test-mcp` in its MCP-servers list output. → `12.2/assertion-02-codex-sees-mcp.png`

**Teardown:**

* Right-click `parity-gemini` row → Remove session. Right-click `parity-codex` row → Remove session. Open Project Settings for `smoke-proj-<timestamp>` again; remove the `test-mcp` server. State returns to SMOKE-PROJ-01 baseline.

***

### 12.3: MCP-SESSION-LIST-VISIBILITY-01 — `session_list` returns Claude + Gemini + Codex sessions

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** #437

**Setup:**

1. SMOKE-CHAT-01 complete (smoke-chat-claude / smoke-chat-gemini / smoke-chat-codex all exist under `wb-seed`).

**Steps:**

1. Click the `smoke-chat-claude` tab to focus.
2. Type a natural prompt: `Please call the workbench MCP tool session_list with project=wb-seed and show me the cli_type of every session it returns.` Press Enter.
3. Wait for Claude to invoke the MCP tool and render the result.

**Verify:**

* ≤5s after step 2: the Claude pane shows a tool-call block for `mcp__workbench__session_list` with `project: "wb-seed"` argument visible. → `12.3/assertion-01-tool-call.png`
* ≤5s after step 2: the rendered tool result lists at least three sessions and the rendered cli\_type values include `claude`, `gemini`, AND `codex` — each appearing at least once (proving non-Claude sessions are no longer omitted). → `12.3/assertion-02-all-three-cli-types.png`
* ≤5s after step 2: the Claude response paraphrases the result accurately (e.g., "I found 3 sessions: smoke-chat-claude (claude), smoke-chat-gemini (gemini), smoke-chat-codex (codex)"). → `12.3/assertion-03-claude-paraphrase.png`

**Teardown:**

* N/A — smoke-chat-\* state preserved.

***

### 12.1.GEMINI: MCP-CATALOG-LIST-GEMINI-01 — Gemini caller invokes `tools/list` (peer of 12.1 Claude)

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** §12.11 axis-2 — Gemini caller peer of 12.1 (Claude caller)

**Setup:**

1. SMOKE-CHAT-01 complete (smoke-chat-gemini is the calling session).

**Steps:**

1. Click `smoke-chat-gemini` tab to focus.
2. Type the Gemini slash to list MCP tools: `/mcp` and press Enter.
3. Wait for the Gemini CLI to render the list.

**Verify:**

* ≤5s after step 2: the Gemini terminal pane visibly shows a list of MCP servers / tools, including the `workbench` server entry with its registered tool names (at minimum: `session_new`, `session_list`, `task_add`, `file_find` — substantive named tools). → `12.1.GEMINI/assertion-01-tool-list-rendered.png`
* ≤5s after step 2: the rendered list does NOT show an error like "MCP server unreachable" or "no tools registered" for the workbench server. → `12.1.GEMINI/assertion-02-no-mcp-error.png`

**Teardown:**

* N/A — smoke-chat-gemini state preserved.

**Result:** ☐ PASS ☐ FAIL

### 12.1.CODEX: MCP-CATALOG-LIST-CODEX-01 — Codex caller invokes `tools/list` (peer of 12.1 Claude)

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** §12.11 axis-2 — Codex caller peer of 12.1

**Setup:**

1. SMOKE-CHAT-01 complete (smoke-chat-codex is the calling session).

**Steps:**

1. Click `smoke-chat-codex` tab.
2. Type the Codex MCP-list slash command (`/mcp` per current Codex CLI, or the pinned-version equivalent) and press Enter.
3. Wait for the Codex CLI to render the list.

**Verify:**

* ≤5s after step 2: the Codex terminal pane shows a list of MCP servers / tools including the workbench server with its tool names rendered. → `12.1.CODEX/assertion-01-tool-list-rendered.png`
* ≤5s after step 2: no "MCP unreachable" / "no tools registered" error for the workbench server. → `12.1.CODEX/assertion-02-no-mcp-error.png`

**Teardown:**

* N/A — smoke-chat-codex preserved.

**Result:** ☐ PASS ☐ FAIL

### 12.2.CLAUDE: MCP-PROJECT-ENABLE-CLAUDE-01 — Claude session in project P sees enabled MCP (peer of 12.2 Gemini+Codex)

**Cascade-from:** SMOKE-PROJ-01
**Closes gap for:** §12.11 axis-2 — Claude peer of 12.2 (Gemini+Codex peers covered there)

**Setup:**

1. SMOKE-PROJ-01 complete (`smoke-proj-<timestamp>` exists as project P).
2. Click `smoke-proj-<timestamp>` in the sidebar.
3. **Clean-baseline affirmation:** open Project Settings → MCP-servers section → screenshot-affirm `test-mcp-claude` is NOT in the list.
4. Click `+ Add MCP Server`. Set Name: `test-mcp-claude` and Command: `echo test-mcp-claude-running`. Click Save.
5. Start a Claude session in P: `+` → `Claude` → name `parity-claude-mcp` → Start Session. Wait for ready observable.

**Steps:**

1. Click `parity-claude-mcp` tab.
2. Type a natural prompt: `Please list all MCP servers available to you in this project and tell me whether you see one named test-mcp-claude.` Press Enter.
3. Wait for Claude's response.

**Verify:**

* ≤10s after step 2: the Claude pane's response visibly lists `test-mcp-claude` among the project's MCP servers (proves Claude in the same project sees the project-enabled MCP). → `12.2.CLAUDE/assertion-01-claude-sees-mcp.png`
* ≤10s after step 2: Claude's response confirms it found the server (natural-language affirmation). → `12.2.CLAUDE/assertion-02-claude-confirms.png`

**Teardown:**

* Right-click `parity-claude-mcp` → Remove session. Open Project Settings → remove `test-mcp-claude`. State returns to SMOKE-PROJ-01 baseline.

**Result:** ☐ PASS ☐ FAIL

### 12.2.NEG: MCP-PROJECT-DISABLE-PARITY-01 — Project MCP disable removes server from all peer CLIs' lists (negative-of-enable)

**Cascade-from:** 12.2
**Closes gap for:** §12.11 axis-1 — disable state of the project-MCP toggle (paired with 12.2's enable positive)

**Setup:**

1. 12.2 complete with assertions PASSed. After 12.2's Teardown the `test-mcp` server is removed and the Gemini+Codex sessions are gone — for this entry, we re-establish the enabled state, then exercise disable.
2. Click `smoke-proj-<timestamp>` → open Project Settings.
3. Click `+ Add MCP Server` → Name `test-mcp-disable` / Command `echo running` → Save.
4. Start Gemini session in P: `parity-disable-gemini`. Start Codex session: `parity-disable-codex`. Wait for ready observables.
5. **Confirm enable propagated:** in each terminal, type `/mcp` Enter; screenshot-affirm both terminals see `test-mcp-disable` in their MCP list (precondition for the disable test).

**Steps:**

1. Open Project Settings for `smoke-proj-<timestamp>`.
2. Locate `test-mcp-disable` in the MCP-servers list. Click its `Remove` affordance (× or trash icon).
3. A confirm modal appears. Click `Confirm`.
4. Close Project Settings.
5. In `parity-disable-gemini` terminal, type `/mcp` Enter.
6. In `parity-disable-codex` terminal, type `/mcp` Enter.

**Verify:**

* ≤10s after step 5: the Gemini terminal's MCP list NO LONGER shows `test-mcp-disable` (the server was visible in Setup step 5; after Steps 1–4 disable, the next `/mcp` call returns a list without it). → `12.2.NEG/assertion-01-gemini-mcp-gone.png`
* ≤10s after step 6: the Codex terminal's MCP list also no longer shows `test-mcp-disable`. → `12.2.NEG/assertion-02-codex-mcp-gone.png`
* ≤2s after step 3: the Project Settings → MCP-servers list visibly no longer contains `test-mcp-disable` (the workbench-side disable is reflected in the UI). → `12.2.NEG/assertion-03-settings-list-removed.png`

**Teardown:**

* Right-click `parity-disable-gemini` → Remove session. Right-click `parity-disable-codex` → Remove session. State returns to SMOKE-PROJ-01 baseline.

**Result:** ☐ PASS ☐ FAIL

### 12.3.GEMINI: MCP-SESSION-LIST-FROM-GEMINI-01 — Gemini caller invokes `session_list` (peer of 12.3 Claude caller)

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** §12.11 axis-2 — Gemini caller peer of 12.3

**Setup:**

1. SMOKE-CHAT-01 complete (3 CLI sessions on `wb-seed`; smoke-chat-gemini is the calling session).

**Steps:**

1. Click `smoke-chat-gemini` tab.
2. Type a natural prompt: `Please call the workbench MCP tool session_list with project=wb-seed and show me the cli_type of every session it returns.` Press Enter.
3. Wait for Gemini to invoke the MCP tool and render the result.

**Verify:**

* ≤5s after step 2: the Gemini pane shows a tool-call invocation for `session_list` (Gemini's rendering style for MCP tool calls) with `project: "wb-seed"`. → `12.3.GEMINI/assertion-01-tool-call.png`
* ≤5s after step 2: the rendered result lists at least three sessions and the cli\_type values include `claude`, `gemini`, AND `codex`. → `12.3.GEMINI/assertion-02-all-three-cli-types.png`
* ≤5s after step 2: Gemini's natural-language summary accurately names the three sessions. → `12.3.GEMINI/assertion-03-gemini-paraphrase.png`

**Teardown:**

* N/A — smoke-chat-gemini preserved.

**Result:** ☐ PASS ☐ FAIL

### 12.3.CODEX: MCP-SESSION-LIST-FROM-CODEX-01 — Codex caller invokes `session_list` (peer of 12.3 Claude caller)

**Cascade-from:** SMOKE-CHAT-01
**Closes gap for:** §12.11 axis-2 — Codex caller peer of 12.3

**Setup:**

1. SMOKE-CHAT-01 complete (smoke-chat-codex is the calling session).

**Steps:**

1. Click `smoke-chat-codex` tab.
2. Type a natural prompt asking Codex to invoke `session_list project=wb-seed` and show cli\_type per session. Press Enter.
3. Wait for response.

**Verify:**

* ≤5s after step 2: the Codex pane shows a tool-call invocation for `session_list` with project=wb-seed. → `12.3.CODEX/assertion-01-tool-call.png`
* ≤5s after step 2: result lists ≥3 sessions with cli\_type values including `claude`, `gemini`, `codex`. → `12.3.CODEX/assertion-02-all-three-cli-types.png`
* ≤5s after step 2: Codex's natural-language summary names the sessions. → `12.3.CODEX/assertion-03-codex-paraphrase.png`

**Teardown:**

* N/A — smoke-chat-codex preserved.

**Result:** ☐ PASS ☐ FAIL

***

## Section 13: Modals + Dialogs Sweep

Verify the workbench modal pattern replaces every native browser dialog (#340) and that `escapeHtml` consolidation round-trips dangerous strings safely (#341).

***

### 13.1: MODAL-NATIVE-DIALOG-SWEEP-01 — Every CRUD that previously used native dialog now renders workbench modal

**Cascade-from:** 4.5 (sessions exist) + 5.1 (programs exist) + 7.1 (tasks exist)
**Closes gap for:** #340

**Setup:**

1. 4.5 complete (sessions available — uses `tmux-async-01` or one of the smoke-chat-\* rows under `wb-seed`); 5.1 complete (`rename-prog-A` and `rename-prog-B` programs available); 7.1 complete (the `bound-task` task created in 7.2's setup, or a freshly-added task in this entry's setup).
2. Orchestrator may optionally instrument a Playwright tripwire on `window.prompt` / `window.alert` / `window.confirm` invocations to surface a hard failure diagnostic during the run — the tripwire is a Setup-only diagnostic, not a verify mechanism. The verify is the screenshot of the rendered overlay vs. an OS-chrome native dialog (which is visually distinct).
3. Open the file `/data/workspace/wb-seed/README.md` in the editor by clicking it in the right-panel Files tree (or create such a file as part of orchestrator setup if it does not exist). The file opens as an editor tab in the main panel. This is the file Step 1 will Save-As.
4. Create a sacrificial program `sweep-target-prog` and a sacrificial session `sweep-target-sess` (under `wb-seed`) for Steps 2 / 3 / 6 to delete / rename without disturbing upstream state. Create a sacrificial task `sweep-target-task` for Step 5.

**Steps:**

1. **Save As.** With the README editor tab focused, click the explicit `Save As` affordance in the editor toolbar. The workbench input-modal-styled prompt for filename appears.
2. Click `Cancel` on the Save As modal. **Delete project.** Right-click the `sweep-target-prog` row in the sidebar → click `Remove` in the context menu. The workbench confirm-modal appears.
3. Click `Cancel` on the confirm modal. **Delete session.** Right-click the `sweep-target-sess` row → click `Remove`. The workbench confirm-modal appears.
4. Click `Cancel`. **Save settings.** Click `⚙ Settings` → General tab → change the font-size value from 14 to 15 by typing in the input. Click the explicit `Save` affordance (or the workbench's per-product save behavior — if save is implicit-on-change, this site verifies "no native dialog fires when value changes" instead; per the entry's pass condition, the workbench input-modal-or-toast renders OR the change persists silently with no native dialog).
5. Click `Cancel` / dismiss settings. **Save tasks.** Right-click `sweep-target-task` → `Edit`. The task-detail modal opens. Type a new title. Click the `Save` button. The workbench confirm/save-feedback appears (toast or modal — both are workbench-styled, neither is a native dialog).
6. Dismiss any save feedback. **Rename.** Click the `sweep-target-prog` row's ✎ pencil affordance → `Rename`. The workbench rename input appears as either an in-page modal-styled overlay OR an inline-edit field — both are workbench patterns and visually distinct from native dialogs. Type `sweep-target-prog-renamed` and press Escape (cancel the rename without committing).

**Verify:**

* ≤500ms after step 1's Save As click: the workbench-styled modal overlay is visibly rendered for the Save-As prompt (rounded-corner modal panel against dimmed page background, matching the SMOKE-PROJ-01 / SMOKE-SETTINGS-01 modal pattern). The captured frame shows zero OS-chrome native dialog (a browser-native `prompt` would carry OS chrome — title bar, browser-specific button styling — that is visually distinct from the in-page panel). → `13.1/assertion-01-save-as.png`
* ≤500ms after step 2's Remove click on the project: the workbench-styled confirm-modal overlay is visibly rendered. No OS-chrome native `confirm` dialog is visible. → `13.1/assertion-02-delete-project.png`
* ≤500ms after step 3's Remove click on the session: the workbench-styled confirm-modal overlay is visibly rendered. No OS-chrome native dialog is visible. → `13.1/assertion-03-delete-session.png`
* ≤500ms after step 4's Save click on settings: either the workbench-styled save feedback is visibly rendered (toast OR modal styled per the rest of the runbook), OR the settings value persists silently with the Settings modal still open and no native dialog. In neither case does an OS-chrome native dialog appear. → `13.1/assertion-04-save-settings.png`
* ≤500ms after step 5's Save click on task-detail: the workbench-styled save feedback is visibly rendered (toast or modal); no OS-chrome native dialog. → `13.1/assertion-05-save-tasks.png`
* ≤500ms after step 6's Rename activation: the workbench-styled rename UI is visibly rendered (modal overlay OR inline-edit input — both have workbench styling distinct from OS chrome). No OS-chrome native dialog appears. → `13.1/assertion-06-rename.png`
* ≤500ms after each of steps 1-6 (composite, six frames): the captured frame for that step contains NO OS-chrome native dialog (no browser title bar styled differently from the page, no OS-specific button widget, no dialog positioned outside the page viewport). → `13.1/assertion-07-no-os-chrome-dialogs.png` (composite)

**Teardown:**

* Dismiss any open workbench modals. Right-click `sweep-target-sess` → confirm Remove (commit the delete). Right-click `sweep-target-prog` → confirm Remove. Delete `sweep-target-task` via task-detail → Delete (commit). Discard the README editor tab without saving. State returns to upstream-cascade baselines.

***

### 13.2: MODAL-ESCAPEHTML-XSS-01 — Session named with HTML entities renders as escaped text

**Cascade-from:** 4.2
**Closes gap for:** #341

**Setup:**

1. 4.2 complete (session-create flow exercised).
2. **No-prior-payload affirmation (§12.11 explicit Setup):** screenshot-affirm the sidebar under `wb-seed` does NOT already contain a row whose display text matches the malicious payload `<bad>&"'name`. If such a row exists, remove it first (right-click → Remove session) so the "new row appears" assertion is a true addition.
3. Orchestrator may optionally instrument an `alert()` tripwire on the page as a hard-failure diagnostic during the run — Setup-only, not a verify mechanism. The verify is the screenshot: a browser-native `alert` dialog carries OS chrome (title bar, OK button widget) that is visually distinct from any in-page rendering and is screenshot-affirmable.

**Steps:**

1. Click `+` on `wb-seed` → `Claude`. The session-create overlay opens.
2. In the session-name field, type exactly: `<bad>&"'name` (six visible characters / escapes).
3. Click `Start Session`. Wait for the session row to appear in the sidebar.

**Verify:**

* ≤2s after step 3: a new session row is visible in the sidebar under `wb-seed`. The row's visible display text shows the literal characters `<bad>&"'name` rendered as glyphs (the `<` is a left-angle-bracket glyph, the `>` is a right-angle-bracket glyph, the `&` is an ampersand glyph, the `"` is a double-quote glyph, the `'` is a single-quote glyph). → `13.2/assertion-01-row-shows-literal.png`
* ≤2s after step 3: the sidebar's overall layout is intact — no DOM mangling that would have produced a hidden `<bad>` element, a missing `name` suffix, or a broken layout in the sidebar. → `13.2/assertion-02-layout-intact.png`
* ≤2s after step 3: no browser-native `alert` dialog (OS-chrome window with OK button) is visible anywhere on screen. Script execution from the payload would render as such a dialog; its absence is the screenshot-affirmable proof that the escape worked. → `13.2/assertion-03-no-os-chrome-alert.png`

**Teardown:**

* Right-click the malicious-named row → Remove session. Sidebar returns to 4.2 baseline.

**Result:** ☐ PASS ☐ FAIL

### 13.2.GEMINI: MODAL-ESCAPEHTML-GEMINI-01 — Gemini session-name XSS escape (peer of 13.2 Claude)

**Cascade-from:** 4.2.GEMINI
**Closes gap for:** §12.11 axis-2 — Gemini peer of 13.2 (Claude session-name XSS)

**Setup:**

1. 4.2.GEMINI complete (Gemini session-create flow exercised; baseline of multiple Gemini rows under `wb-seed`).
2. **No-prior-payload affirmation:** screenshot-affirm no existing Gemini-rowed session under `wb-seed` already has the name `<bad>&"'gemini`.
3. Orchestrator's optional `alert()` tripwire as in 13.2.

**Steps:**

1. Click `+` on `wb-seed` → `Gemini`. The session-create overlay opens.
2. Type session name `<bad>&"'gemini` exactly.
3. Click `Start Session`. Wait for the session row to appear.

**Verify:**

* ≤2s after step 3: a new Gemini session row appears in the sidebar with display text rendering the literal characters `<bad>&"'gemini` as glyphs. → `13.2.GEMINI/assertion-01-row-shows-literal.png`
* ≤2s after step 3: sidebar layout intact — no DOM mangling, no truncation. → `13.2.GEMINI/assertion-02-layout-intact.png`
* ≤2s after step 3: no browser-native `alert` OS-chrome dialog visible. → `13.2.GEMINI/assertion-03-no-os-chrome-alert.png`

**Teardown:**

* Right-click the malicious-named Gemini row → Remove session. Sidebar returns to 4.2.GEMINI baseline.

**Result:** ☐ PASS ☐ FAIL

### 13.2.CODEX: MODAL-ESCAPEHTML-CODEX-01 — Codex session-name XSS escape (peer of 13.2 Claude)

**Cascade-from:** 4.2.CODEX
**Closes gap for:** §12.11 axis-2 — Codex peer of 13.2

**Setup:**

1. 4.2.CODEX complete.
2. **No-prior-payload affirmation:** sidebar has no Codex row with name `<bad>&"'codex`.
3. Orchestrator's optional `alert()` tripwire.

**Steps:**

1. `+` on `wb-seed` → `Codex` → type `<bad>&"'codex` as the name → Start Session.

**Verify:**

* ≤2s after step 1: a new Codex row appears with display text rendering `<bad>&"'codex` as literal glyphs. → `13.2.CODEX/assertion-01-row-shows-literal.png`
* ≤2s after step 1: layout intact. → `13.2.CODEX/assertion-02-layout-intact.png`
* ≤2s after step 1: no OS-chrome alert dialog. → `13.2.CODEX/assertion-03-no-os-chrome-alert.png`

**Teardown:**

* Right-click the malicious-named Codex row → Remove session.

**Result:** ☐ PASS ☐ FAIL

***

## Section 14: Error / Banner UI

Verify the `showErrorBanner insertBefore` regression does not recur during the 60s polling cycle (#402).

***

### 14.1: ERROR-BANNER-NOTFOUND-01 — No `NotFoundError` in console during 2-minute polling cycle

**Cascade-from:** 2.1
**Closes gap for:** #402

**Setup:**

1. 2.1 complete (workbench shell rendered).
2. Take a baseline screenshot of the sidebar showing all currently-visible project + session rows. This is the reference for verifying the polling cycle did not corrupt the sidebar render.
3. Clear the DevTools console buffer at start of Steps.
4. **Cleared-buffer affirmation (§12.11 explicit Setup):** capture a Playwright `browser_console_messages` snapshot immediately after clearing the buffer; screenshot-affirm the captured log shows zero entries (or only system-level Playwright init lines, no application warnings or errors). This is the baseline against which the Verify "zero `NotFoundError` entries during the 120s window" is measured.

**Steps:**

1. At wall-clock time `t0`, take a screenshot of the workbench shell — the sidebar shows its current row inventory, the tab bar shows current tabs, the right panel renders.
2. Leave the workbench shell idle (no user interaction) for 120 seconds. The loadState polling cycle (every \~60s) fires at least twice during this window. The polling re-renders the sidebar and tab bar from server state.
3. At `t0+60s`, take a screenshot of the sidebar.
4. At `t0+120s`, take a screenshot of the sidebar.
5. At `t0+120s`, click any project row in the sidebar (the reference row from Setup step 2 is a good choice).
6. At `t0+120s`, capture a Playwright `browser_console_messages` snapshot — the buffer captures the entire 120s window.

**Verify:**

* ≤60s after step 1 (screenshot from step 3): the sidebar render is intact — all baseline rows from Setup step 2 are still visible at the same positions; no error banner, no "Lost connection" indicator, no missing rows. → `14.1/assertion-01-sidebar-intact-at-60s.png`
* ≤120s after step 1 (screenshot from step 4): the sidebar render is still intact — same row inventory as baseline, no error banner has appeared. → `14.1/assertion-02-sidebar-intact-at-120s.png`
* ≤1s after step 5: the clicked project row visibly responds (highlight, selection, or per-product active styling) — the shell is responsive after 120s of polling. → `14.1/assertion-03-shell-responsive.png`
* ≤120s after step 1 (console snapshot from step 6): supplementary diagnostic — the captured `browser_console_messages` log contains zero entries with the substring `NotFoundError`. (The primary screen-affirmable proof is the intact sidebar + responsive shell across assertions 01-03; a `NotFoundError` thrown during polling would have prevented re-rendering and shown as missing rows or a broken sidebar.) → `14.1/assertion-04-no-notfounderror.png`

**Teardown:**

* N/A — shell state preserved.

***

## Section 15: CLI Parity (Gemini / Codex slash + compaction)

Verify CLI-parity slash commands auto-install on fresh container (#451) and that `session_prepare_pre_compact` / `session_resume_post_compact` render CLI-appropriate prompts for non-Claude sessions (#446).

***

### 15.1: CLI-PARITY-SLASH-AUTOINSTALL-01 — `/session:transition` autocompletes in fresh Gemini + Codex sessions

**Cascade-from:** cold
**Closes gap for:** #451

**Setup:**

1. Orchestrator spins a fresh container from the current image with NO manual slash-command placement: `docker run -d --name workbench-parity -v <ephemeral>:/data -p <port>:7860 <image>`. Confirm `/data/.gemini/commands/session/` and `/data/.codex/skills/session-transition/` (or the current canonical Codex skill path) do NOT exist before workbench starts — proves auto-install is the only source.
2. Bind `${WORKBENCH_URL}` to this container. Pass the gate if applicable. Workbench shell renders.
3. Provision Gemini and Codex credentials (via 0.B-style injection — out of scope for this entry's verify; orchestrator setup only).
4. Start a Gemini session in `wb-seed` named `parity-slash-gemini` and a Codex session named `parity-slash-codex`. Wait for both ready observables.

**Steps:**

1. Click the `parity-slash-gemini` tab to focus. Click into the terminal pane.
2. Type the partial slash `/sessio` (do NOT press Enter; observe the autocomplete dropdown).
3. Capture the autocomplete dropdown content visible in the terminal pane.
4. Press Escape to dismiss the autocomplete. Click `parity-slash-codex` tab.
5. Type `/sessio` in the Codex pane. Capture the autocomplete dropdown content.

**Verify:**

* ≤2s after step 2: the Gemini terminal's autocomplete dropdown visibly lists `/session:transition` AND `/session:resume` as suggestions. → `15.1/assertion-01-gemini-autocomplete.png`
* ≤2s after step 5: the Codex terminal's autocomplete dropdown visibly lists `/session:transition` (and `/session:resume` if implemented) — the SAME slash form as Gemini, NOT the legacy `/prompts:session-transition`. → `15.1/assertion-02-codex-autocomplete.png`

**Teardown:**

* Leave the `workbench-parity` container running for 15.2 (which cascades from this entry). State preserved.

***

### 15.2: CLI-PARITY-COMPACT-PROMPT-01 — `/session:transition` renders CLI-appropriate prompt

**Cascade-from:** 15.1
**Closes gap for:** #446

**Setup:**

1. 15.1 complete (`workbench-parity` container running; `parity-slash-gemini` + `parity-slash-codex` sessions exist with auto-installed slash commands).

**Steps:**

1. Click the `parity-slash-gemini` tab.
2. Type `/session:transition` and press Enter.
3. Wait for the prompt to render in the Gemini terminal pane.
4. Click the `parity-slash-codex` tab.
5. Type `/session:transition` and press Enter.
6. Wait for the prompt to render in the Codex terminal pane.

**Verify:**

* ≤5s after step 2: the Gemini pane renders a transition prompt containing the literal text `/compress` (Gemini's compaction slash) AND does NOT contain the literal text `/compact` (which is Claude-only) AND does NOT contain a Claude `~/.claude/plans/` path reference. → `15.2/assertion-01-gemini-compress-prompt.png`
* ≤5s after step 5: the Codex pane renders a transition prompt that does NOT contain the literal text `/compact`, does NOT contain `/compress`, and does NOT reference `~/.claude/plans/` (Codex has no in-session compaction). The Codex prompt instead reflects Codex's session-transition flow without a compaction instruction. → `15.2/assertion-02-codex-no-compact-ref.png`

**Teardown:**

* Orchestrator stops + removes `workbench-parity`. State returns to pre-Section 15 baseline.

***

### 15.1.CLAUDE: CLI-PARITY-SLASH-AUTOINSTALL-CLAUDE-01 — `/session` skill autocompletes in fresh Claude session (peer of 15.1 Gemini+Codex)

**Cascade-from:** cold
**Closes gap for:** §12.11 axis-2 — Claude peer of 15.1 (Gemini+Codex peers covered there)

**Note on per-CLI slash form:** Claude Code exposes the session-management skill as a single `/session` slash with subcommand arguments (`transition`, `resume`), NOT as separate `/session:transition` / `/session:resume` entries like Gemini and Codex. Per-CLI autocomplete renderings differ: this entry asserts the Claude form (one dropdown row for `/session` with subcommand args reachable on Tab / arrow keys). The 15.1 (Gemini+Codex) entry asserts the colon-namespaced form on those CLIs.

**Setup:**

1. Orchestrator spins a fresh container from the current image with NO manual slash-command placement: `docker run -d --name workbench-parity-claude -v <ephemeral>:/data -p <port>:7860 <image>`. Confirm the Claude skill files do NOT exist at the canonical install path (e.g., `/data/.claude/skills/session/SKILL.md`) before workbench starts — proves auto-install is the only source.
2. Bind `${WORKBENCH_URL}` to this container. Pass the gate if applicable. Workbench shell renders.
3. Provision Claude credentials.
4. Start a Claude session in `wb-seed` named `parity-slash-claude` via `+` → `Claude` → name → Start. Wait for the Claude input-area ready observable (per SMOKE-CHAT-01 step 5 claude form).

**Steps:**

1. Click the `parity-slash-claude` tab. Click into the terminal pane.
2. Type the partial slash `/sessio` (do NOT press Enter; observe the autocomplete dropdown).
3. Capture the autocomplete dropdown content visible in the terminal pane.
4. Press the down-arrow / Tab to navigate the autocomplete and observe whether the `/session` row exposes its subcommand args (`transition`, `resume`) — either as a second-level dropdown when the row is highlighted, or as inline arg-hint text within the same row.
5. Capture a second screenshot showing the args surfaced for `/session`.

**Verify:**

* ≤2s after step 2: the Claude terminal's autocomplete dropdown visibly lists `/session` as a suggestion (auto-installed by the workbench at boot; without manual placement). → `15.1.CLAUDE/assertion-01-claude-session-autocomplete.png`
* ≤2s after step 4: the dropdown affordance (second-level menu or inline arg hint, per Claude Code's current rendering) makes the subcommand arguments `transition` AND `resume` discoverable from the `/session` row — they appear on screen as selectable / typeable arg values, not buried behind documentation. → `15.1.CLAUDE/assertion-02-claude-session-args-visible.png`

**Teardown:**

* Leave the `workbench-parity-claude` container running for 15.2.CLAUDE. State preserved.

**Result:** ☐ PASS ☐ FAIL

### 15.2.CLAUDE: CLI-PARITY-COMPACT-PROMPT-CLAUDE-01 — Claude `/session transition` renders Claude-appropriate prompt (peer of 15.2 Gemini+Codex)

**Cascade-from:** 15.1.CLAUDE
**Closes gap for:** §12.11 axis-2 — Claude peer of 15.2 (anchors the positive value that 15.2's negative assertions for Gemini/Codex reference: Gemini "does not contain `/compact`" is meaningful only if `/compact` IS the Claude value)

**Note on per-CLI invocation form:** Per 15.1.CLAUDE's note, Claude invokes the session-transition skill as `/session` + `transition` arg, not as `/session:transition`. The PROMPT CONTENT that lands in the pane is the same regardless of the invocation form; this entry verifies prompt content, not invocation syntax.

**Setup:**

1. 15.1.CLAUDE complete (`workbench-parity-claude` running; `parity-slash-claude` session exists with auto-installed `/session` skill).

**Steps:**

1. Click `parity-slash-claude` tab.
2. Invoke the Claude session-transition skill: type `/session` then space, then `transition`, then Enter. If the autocomplete from 15.1.CLAUDE step 4 surfaced a direct-invoke affordance for the `transition` arg, use that; otherwise type the arg explicitly.
3. Wait for the prompt to render in the Claude pane.

**Verify:**

* ≤5s after step 2: the Claude pane renders a transition prompt containing the literal text `/compact` (Claude's compaction slash) AND containing a reference to the Claude plans directory `~/.claude/plans/`. → `15.2.CLAUDE/assertion-01-claude-compact-prompt.png`
* ≤5s after step 2: the prompt does NOT contain `/compress` (which is Gemini's slash) — the per-CLI prompt template correctly differs. → `15.2.CLAUDE/assertion-02-no-gemini-slash.png`

**Teardown:**

* Orchestrator stops + removes `workbench-parity-claude`. State returns to pre-Section 15 baseline.

**Result:** ☐ PASS ☐ FAIL

***

## Section 16: Bug-fix feature entries (`F-*`)

Feature-specific bug-fix entries. Each closes a gap for a specific code bug that has a distinguishable UI surface beyond what the Section 1 baseline-smoke entries exercise. Issues whose code change is backend-only or docs/config-only do not have a dedicated entry here; their UI coverage is the Section 1 + Section 2 baseline that the per-issue grid row 5 cites.

### 16.1: F-TERM-SCROLLBACK-WIDTH-01 — Terminal scrollback renders at the client's column width after WS reconnect

**Cascade-from:** SMOKE-CHAT-01 (a chat session exists with rendered scrollback)
**Closes gap for:** #483 (scrollback corruption — progressive indent + reshuffle on reconnect). Also covers #252 (`session_resume_post_compact` writes tail-to-file; the resume-after-disconnect path tail-renders into this same xterm scrollback surface).

**Setup:**

1. Browser at `${WORKBENCH_URL}`, gate passed if applicable, sidebar visible. SMOKE-CHAT-01 already PASSED, so a `smoke-chat-claude` session tab exists with a multi-screen response rendered in its terminal pane.
2. Click the `smoke-chat-claude` tab to make it active.
3. Resize the browser window to a non-default width — drag the window's right edge so the terminal pane is rendered at approximately 100 cols (visible character columns in the pane; the agent affirms by counting the pane's visible monospace columns at a frame). Capture a baseline screenshot of the active pane showing a known anchor line (e.g. the prompt `what is 7 times 8`) and the response below it, fully visible without horizontal scrollbar.
4. In the same pane, send a prompt that produces enough wrapped output to fill scrollback: via `browser_type` on `#pane-<tabId> .xterm-helper-textarea` (per the Canonical input selectors section), type `list every two-letter combination from aa to zz, one per line`; press Enter via `browser_press_key {key:"Enter"}` on the same selector; wait up to 60s for the response to complete (capture a frame showing the last line near `zz`).

**Steps:**

1. Force a WS disconnect: `browser_evaluate(() => { const t = window.tabs.get(window.activeTabId); if (t?.ws) t.ws.close(); return 'closed'; })` — closes the active tab's WebSocket (setup trigger, not a verify; the verify is screenshot-based on the indicator state). If `context.setOffline(true)` is exposed by the Tester's Playwright MCP, prefer it (network-layer disconnect); the verify is the same either way. Hold for 2s.
2. Re-connect: if step 1 used `context.setOffline(true)`, invoke `setOffline(false)`; if it closed the ws directly, the workbench's tab-reconnect logic should auto-reattach. The terminal pane reconnects (status indicator moves from disconnected → connected within 5s).
3. After reconnect, scroll the terminal pane up using the mouse wheel (or keyboard `Shift+PageUp`) until the original anchor line `what is 7 times 8` is visible at the top of the viewport.
4. Capture a screenshot of the scrolled-up viewport.

**Verify (numbered assertions):**

1. Within 1s of `context.setOffline(true)`, the tab's connection indicator moves to a disconnected visual state (status dot turns red / disconnected glyph appears). *(Cascades from SMOKE-CHAT-01 — a tab exists and was connected.)* → `16.1/assertion-01-disconnect-indicator.png`
2. Within 5s of `context.setOffline(false)`, the tab's connection indicator returns to the connected visual state (status dot turns green / connected glyph). → `16.1/assertion-02-reconnect-indicator.png`
3. After scroll-up to the anchor line, the rendered anchor line is the original prompt `what is 7 times 8` followed by the original response containing `56`, with line breaks at the SAME column positions as the baseline screenshot in Setup step 3 — no progressive-indent drift, no reshuffle, no missing chunks. The agent reads both screenshots and affirms positional equality of the indentation pattern at the anchor + the line immediately following it. *(Static content read after reconnect bound is satisfied by assertion 2.)* → `16.1/assertion-03-scrollback-positional-equality.png`
4. The scrollback contains no garbage characters at the right edge that aren't in the baseline (no `^[[` sequences leaking through, no doubled-up cursor-position residues). Static content read against the same screenshot as assertion 3. → `16.1/assertion-04-no-garbage-right-edge.png`

**Teardown:** none — the tab and its scrollback are left as-is for subsequent entries.

**Result:** ☐ PASS ☐ FAIL

### 16.2: F-TAB-DRAG-REORDER-01 — Drag-reorder works identically for CLI session tabs and file (doc) tabs

**Cascade-from:** SMOKE-CHAT-01 (CLI tabs exist) + SMOKE-FILES-01 (file browser usable)
**Closes gap for:** #522 (doc-tab reorder reported not to work). Tests both CLI and file tabs explicitly per §12.11 axis-2 peer parity (same drop-handler code path; two surfaces).

**Setup:**

1. Browser at `${WORKBENCH_URL}`, sidebar visible. The three `smoke-chat-{claude,gemini,codex}` tabs from SMOKE-CHAT-01 are open in the primary tab bar.
2. Open the Files panel (per SMOKE-FILES-01); expand the workspace root to `/data/workspace/wb-seed`; click a small text file (e.g. `README.md` if present, or any `.md` in that project) to open it as a file tab. The file tab opens; per `openFileTab` it defaults to the side panel — drag it into the primary tab bar (drag the file tab from the side bar into the primary bar) so all four tabs are co-located. Open a second file tab the same way (any second `.md`) and drop it into the primary bar.
3. Confirm the primary tab bar now shows 5 tabs in this initial order: `smoke-chat-claude`, `smoke-chat-gemini`, `smoke-chat-codex`, `<file-1>`, `<file-2>`. Capture a baseline screenshot.

**Steps:**

1. Drag the `<file-2>` tab onto the `smoke-chat-claude` tab — release with the drop indicator showing on the LEFT half of `smoke-chat-claude` (drop-before). Capture a screenshot immediately after release.
2. Drag the `smoke-chat-codex` tab onto the `<file-1>` tab — release with the drop indicator on the RIGHT half (drop-after). Capture a screenshot immediately after release.
3. Reload the page (browser refresh). Wait for the sidebar + tab bar to re-render.

**Verify (numbered assertions):**

1. Baseline tab order is `smoke-chat-claude`, `smoke-chat-gemini`, `smoke-chat-codex`, `<file-1>`, `<file-2>`. → `16.2/assertion-01-baseline-order.png`
2. Within 1s of step 1's drop, the tab bar shows `<file-2>` immediately to the LEFT of `smoke-chat-claude` — i.e. the new order is `<file-2>, smoke-chat-claude, smoke-chat-gemini, smoke-chat-codex, <file-1>`. → `16.2/assertion-02-file-tab-reordered-before-cli.png`
3. Within 1s of step 2's drop, the tab bar shows `smoke-chat-codex` immediately to the RIGHT of `<file-1>` — i.e. the new order is `<file-2>, smoke-chat-claude, smoke-chat-gemini, <file-1>, smoke-chat-codex`. This assertion confirms CLI session tabs also reorder cleanly (peer-parity with the file-tab case in assertion 2). → `16.2/assertion-03-cli-tab-reordered-after-file.png`
4. Within 5s of page reload, the persisted order from assertion 3 is restored. → `16.2/assertion-04-order-persisted-after-reload.png`

**Teardown:** close the two file tabs (`×` on each). The three CLI tabs remain.

**Result:** ☐ PASS ☐ FAIL

### 16.3: F-SIDEBAR-LOADSTATE-RETRY-01 — Sidebar hydrates after Add Project within 5s despite a transient `loadState` fetch failure

**Cascade-from:** SMOKE-PROJ-01 (assertion-03 covers the 5s bound on the happy path; this entry adds the fetch-failure variant per §12.11 axis-1)
**Closes gap for:** #564.

**Setup:**

1. Browser at `${WORKBENCH_URL}`, sidebar visible. SMOKE-PROJ-01 has PASSED on the happy path.
2. Register a one-shot fetch-intercept via `browser_evaluate` (setup trigger, not a verify, per §12.7's setup vs verify distinction): `browser_evaluate(() => { const _orig = window.fetch; let _armed = true; window.fetch = function(...a) { if (_armed && typeof a[0] === 'string' && a[0].includes('/api/state')) { _armed = false; window.fetch = _orig; return Promise.reject(new TypeError('Failed to fetch')); } return _orig.apply(this, a); }; return 'armed'; })` — wraps `window.fetch` so the NEXT `/api/state` call rejects with `TypeError`; subsequent calls go through the original fetch (the wrapper self-restores after firing). Confirm the return value is `'armed'`. If `context.route(...)` becomes available in a future Playwright MCP version, prefer it (intercepts at the network layer rather than monkey-patching JS). Both are setup triggers — the verify is the screenshot of the sidebar after Save.
3. No project named `retry-proj-<timestamp>` exists.

**Steps:**

1. Click the per-program `+` affordance on the `wb-seed` parent program (per finding #591: the deployed UI has per-program `+` for Add Project, not a top-of-sidebar affordance).
2. Project-create modal appears.
3. Type `retry-proj-<timestamp>` into the name field and `/data/workspace/retry-proj-<timestamp>` into the path field.
4. Click Save. The modal dismisses; under the hood `loadState()` fires; the one-shot intercept causes the first `/api/state` fetch to fail with `TypeError`; the new `fetchWithRetry` helper (#564) retries within 500-1000ms and the second attempt succeeds.
5. Capture screenshots at 1s intervals for 6s total, starting from the Save click.

**Verify (numbered assertions):**

1. Within 1s of clicking `+ Project`, the project-create modal renders with a heading naming the create action. *(Cascades from SMOKE-PROJ-01 assertion-01.)* → `16.3/assertion-01-modal-visible.png`
2. Within 2s of clicking Save, the project-create modal is no longer visible. *(Cascades from SMOKE-PROJ-01 assertion-02.)* → `16.3/assertion-02-modal-dismissed.png`
3. Within 5s of clicking Save (the SMOKE-PROJ-01 assertion-03 bound — preserved across the transient fetch failure), a project entry labeled `retry-proj-<timestamp>` is visible in the sidebar. The screenshot poll captures a frame at every 1s tick; the first frame where the new project row is visible passes this verify line. → `16.3/assertion-03-project-in-sidebar-after-retry.png`
4. The browser console contains exactly one `Failed to load state: TypeError: Failed to fetch` entry between the Save click and the project row appearing (corroborating the retry fired and the helper recovered — diagnostic-only per §12.7; the verify primary is assertion 3). Capture the DevTools console panel showing the single entry. → `16.3/assertion-04-single-typeerror-in-console.png`

**Teardown:** delete the project via the sidebar's ✎ pencil → Remove (per existing PROJECT-CONFIG-STATE-VIA-PENCIL-01 pattern) to keep state clean for downstream entries.

**Result:** ☐ PASS ☐ FAIL

### 16.4: F-MCP-SESSION-CONFIG-METADATA-01 — `session_config` rename reflects in the sidebar within 2s; per-CLI parity

**Cascade-from:** SMOKE-CHAT-01 (three CLI sessions exist) + SMOKE-MCP-01 (MCP-via-executor pattern)
**Closes gap for:** #198 (session\_config returns full metadata after write — the sidebar is the consumer surface).

**Setup:**

1. Browser at `${WORKBENCH_URL}`, sidebar visible. The three `smoke-chat-{claude,gemini,codex}` tabs from SMOKE-CHAT-01 are open; their session rows are visible in the sidebar under `wb-seed`.
2. For each `<cli>` in `[claude, gemini, codex]` in turn, perform Steps + Verify in sequence (three iterations of the same flow — explicit per-CLI peer parity per §12.11 axis-2).

**Steps (per CLI iteration):**

1. Resolve the session id from the sidebar's rendered row for that cli (via `browser_snapshot` + DOM read of the row's `data-session-id` attribute — read for use in the next step's URL, NOT used as a verify mechanism). Record as `<sid>`.
2. Trigger the rename via the workbench's REST endpoint (setup-trigger, not verify, per §12.7): `browser_evaluate(({ sid, name, notes }) => fetch('/api/sessions/' + sid + '/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, notes }) }).then(r => r.json()), { sid: '<sid>', name: 'renamed-<cli>-<timestamp>', notes: 'stage-5-test' })`. The endpoint at `src/routes/sessions.js:708` accepts `{name, state, notes}` and returns `{saved: true}` (the REST endpoint returns the bare-shape; the metadata-merged shape from #198 is exposed via the MCP layer, asserted by mock + live MCP tests, not by this entry). The REST trigger is what a user's rename click would actually invoke server-side.
3. Capture screenshots of the sidebar at 1s intervals for 3s total starting from the REST trigger.

**Verify (numbered assertions, two per CLI = 6 total — the third per-CLI assertion from the original v1 of this entry was on MCP response shape; that is verified by #198's mock + live MCP tests in commit `c78bf16` and is not re-asserted here at the UI surface):**

For each `<cli>`:

* **N (per cli):** Within 2s of the REST trigger returning, the sidebar row under `wb-seed` that previously read `smoke-chat-<cli>` now reads `renamed-<cli>-<timestamp>`. Screenshot polling per §12.8. → `16.4/assertion-<N>-<cli>-sidebar-renamed.png`
* **N+1 (per cli):** The renamed session row remains under the `wb-seed` project (not moved, not duplicated, not vanished) — only the displayed name changed. Static content read against the same frame as N. → `16.4/assertion-<N+1>-<cli>-row-stable.png`

**Teardown:** for each CLI, rename the session back to `smoke-chat-<cli>` via a second REST `PUT /api/sessions/<sid>/config` to leave state clean for downstream entries.

**Result:** ☐ PASS ☐ FAIL

### 16.5: F-SIDEBAR-DIFF-RENDER-01 — Sidebar reconciles in-place; typing stays responsive under realistic project/session counts

**Cascade-from:** SMOKE-CHAT-01 (multiple CLI session rows exist) + SMOKE-PROJ-01 (multiple projects in the sidebar).
**Closes gap for:** #585 (sidebar `renderSidebar()` previously rebuilt the full container `innerHTML` on every state diff — main-thread stall vector for #484 typing pauses; the fix uses a keyed reconciler so unchanged nodes survive across diffs).

**Setup:**

1. Browser at `${WORKBENCH_URL}`, sidebar visible. At least 2 projects with ≥3 sessions each must be expanded.
2. Capture a baseline screenshot of the sidebar showing all expanded sessions. Note the visible session-row labels under each expanded project header.
3. Click into one of the visible session rows' name text (or any other focusable input in the sidebar — the project search box if available) so the row's name area is focused. The focus state is the responsiveness probe for assertion 3.

**Steps:**

1. Trigger a sidebar re-render: `browser_evaluate(() => { window._loadStateRef && window._loadStateRef(); return 'reloaded'; })` (setup-trigger only — fires the WS-push-driven loadState path). Begin screenshot polling on the sidebar at 100ms intervals starting at the trigger.
2. Continue polling through t+1500ms; capture every frame for the no-blank-frame assertion.
3. After polling completes, capture a final screenshot of the sidebar at t+1500ms.

**Verify (numbered assertions):**

1. Every frame in the 100ms-interval poll between t+0 and t+1500ms shows the sidebar continuously populated — every project header in the baseline is visible in every frame, and every session row in the baseline is visible in every frame. No frame shows a blank/skeleton/placeholder state, no frame shows fewer rows than the baseline. → `16.5/assertion-01-no-blank-frame-during-rerender.png` (composite of poll frames)
2. The post-render screenshot at t+1500ms shows: every previously-expanded project group still expanded; every previously-visible session row rendered at the same vertical position as the baseline (the agent reads both screenshots and affirms positional equality of the project headers and the first three session rows under each). → `16.5/assertion-02-positional-equality-post-render.png`
3. Within 100ms of the re-render trigger, a keystroke typed into the focused sidebar input (a single test character via `browser_press_key`) renders inline as a glyph in the focused field on the next frame — the main thread did not block the keystroke from being painted (responsiveness affirmation; the focus state established in Setup step 3 is what makes the keystroke routable). → `16.5/assertion-03-keystroke-rendered-during-rerender.png`

**Teardown:** clear focus from the sidebar input (click elsewhere). No persistent state changes.

**Result:** ☐ PASS ☐ FAIL

### 16.6: F-LOADSTATE-SCHEDULE-WS-RESET-01 — WS-pushed loadState resets the baseline 10s timer; no redundant fetch fires

**Cascade-from:** 16.3 (loadState retry under transient failure) + SMOKE-CHAT-01 (a live WS session emitting token\_update is present).
**Closes gap for:** #587 (the prior `setInterval(loadState, REFRESH_MS)` fired regardless of whether a WS-triggered loadState had just run — and `window._loadStateRef` was referenced by terminal.js WS handlers but never assigned, so server-pushed updates silently no-op'd).

**Setup:**

1. Browser at `${WORKBENCH_URL}`, sidebar visible. SMOKE-CHAT-01 PASSED so at least one CLI session is open with a live WS connection.
2. Arm a /api/state request counter via `browser_evaluate(() => { const _orig = window.fetch; let _calls = 0; window.fetch = function(...a) { if (typeof a[0] === 'string' && a[0].includes('/api/state')) { _calls++; } return _orig.apply(this, a); }; window.__I587_RESET = () => { _calls = 0; }; window.__I587_COUNT = () => _calls; return 'armed'; })`. Confirm return value is `'armed'` (setup-trigger only — the verify is the count assertions below).

**Steps:**

1. Reset the counter and immediately invoke a WS-triggered loadState (mimics the server `token_update` push): `browser_evaluate(() => { window.__I587_RESET(); window._loadStateRef && window._loadStateRef(); return window.__I587_COUNT(); })`. Hold for 9.5s (just shy of the 10s baseline `REFRESH_MS`).
2. Read the count: `browser_evaluate(() => window.__I587_COUNT())`. Capture the value.
3. Continue holding for another 2s (totaling 11.5s since the WS-triggered loadState). The baseline self-reschedule should NOT have fired yet (the WS push reset the baseline timer's 10s clock).
4. Read the count again. Capture the value.

**Verify (numbered assertions):**

1. Immediately after the WS-triggered loadState in step 1, the /api/state call count is exactly 1 (the WS-trigger itself). → `16.6/assertion-01-ws-trigger-fires-one-fetch.png` (devtools network panel + the counter read).
2. At t+9.5s after the WS trigger, the count is still exactly 1 — the baseline self-reschedule's 10s clock was reset by the WS push, so no second fetch has fired yet. → `16.6/assertion-02-no-redundant-fetch-at-9.5s.png`.
3. At t+11.5s after the WS trigger (i.e. \~1.5s past where a non-reset baseline would have fired), the count is exactly 1 OR 2 depending on whether the now-rescheduled baseline has tick'd — the assertion is the absence of a third fetch (no double-firing), not the absence of any baseline fetch. → `16.6/assertion-03-no-double-fire.png`.

**Teardown:** restore native fetch: `browser_evaluate(() => { /* the helper's wrapper persists for the test; reload to clear */ })` — instruct the agent to reload the page so subsequent entries start with a clean fetch.

**Result:** ☐ PASS ☐ FAIL

### 16.7: F-PICKER-AUTOEXPAND-01 — Add Project to a program auto-expands that program; new project visible without manual toggle

**Cascade-from:** SMOKE-PROJ-01 (project create modal renders + dismisses).
**Closes gap for:** #592 (pre-fix the new project landed in a collapsed program-children container and was invisible until the user manually clicked the program header to expand).

**Setup:**

1. Browser at `${WORKBENCH_URL}`, sidebar visible. At least one program (e.g. `wb-seed`) exists.
2. Collapse the `wb-seed` program by clicking its program header so its `.program-children` is hidden. Capture a screenshot showing the program in the collapsed state. *(Setup precondition: the failure mode #592 fixes is invisible if the program is already expanded; we collapse first so the auto-expand step has something to do.)*
3. No project named `autoexpand-proj-<timestamp>` exists.

**Steps:**

1. Click the per-program `+` affordance on the `wb-seed` program header. Project-create modal appears.
2. Type `autoexpand-proj-<timestamp>` into name + `/data/workspace/autoexpand-proj-<timestamp>` into path. Click Save.
3. Capture a screenshot at t+1s.

**Verify (numbered assertions):**

1. Within 1s of clicking the program's `+` affordance, the project-create modal renders. → `16.7/assertion-01-modal-visible.png`
2. Within 2s of clicking Save, the `wb-seed` program is auto-expanded (its `.program-children` is visible — the `.collapsed` class is no longer on the program header) AND a project row labeled `autoexpand-proj-<timestamp>` is visible inside it. Single screenshot covers both. → `16.7/assertion-02-program-expanded-with-new-project.png`

**Teardown:** delete the project via the sidebar's ✎ pencil → Remove.

**Result:** ☐ PASS ☐ FAIL

### 16.8: F-SWITCHTAB-STATUSBAR-01 — Status bar refreshes synchronously on tab switch

**Cascade-from:** SMOKE-CHAT-01 (three CLI session tabs co-located on the primary tab bar).
**Closes gap for:** #595 (pre-fix `switchTab` left the bottom status bar showing the prior tab's model / context / connection state; `_updateStatusBarRef` was only called from `pollTokenUsage`, `ws.onopen`, and the WS push handlers).

**Setup:**

1. Browser at `${WORKBENCH_URL}`. SMOKE-CHAT-01 PASSED so three CLI tabs are open: `smoke-chat-claude`, `smoke-chat-gemini`, `smoke-chat-codex`.
2. Read the status bar's model field while `smoke-chat-claude` is active. Capture a screenshot of the status bar — the model field should show the Claude model (e.g. `claude-sonnet-4-6`).

**Steps:**

1. Click the `smoke-chat-gemini` tab to make it active.
2. Capture a screenshot of the status bar immediately after the tab switch animation completes (≤1s).
3. Click the `smoke-chat-codex` tab.
4. Capture a screenshot at t+1s.

**Verify (numbered assertions):**

1. Within 1s of clicking the `smoke-chat-gemini` tab, the status bar's model field shows the Gemini model identifier (not the previous Claude model). → `16.8/assertion-01-statusbar-gemini-on-switch.png`
2. Within 1s of clicking the `smoke-chat-codex` tab, the status bar's model field shows the Codex model identifier (not the prior Gemini model). → `16.8/assertion-02-statusbar-codex-on-switch.png`

**Teardown:** switch back to `smoke-chat-claude` to leave state clean.

**Result:** ☐ PASS ☐ FAIL

### 16.9: F-WS-LIFECYCLE-STATUSBAR-01 — Status bar reflects WS disconnect/error immediately, symmetric with connect

**Cascade-from:** SMOKE-CHAT-01 + 16.1's WS-disconnect setup pattern.
**Closes gap for:** #596 (pre-fix `ws.onclose` and `ws.onerror` did not invoke `_updateStatusBarRef`, leaving the bar stuck on `connected` until the next loadState tick).

**Setup:**

1. Browser at `${WORKBENCH_URL}`, the `smoke-chat-claude` tab active with a live WS connection. Capture a baseline screenshot of the status bar showing the connection indicator in the `connected` visual state.

**Steps:**

1. Force a WS close: `browser_evaluate(() => { const t = window.tabs.get(window.activeTabId); if (t?.ws) t.ws.close(); return 'closed'; })` (setup-trigger; the verify is the screenshot of the indicator).
2. Capture a screenshot within 1s.
3. After the workbench's auto-reconnect (or after a manual re-attach if the test fixture exposes one), capture another screenshot showing the indicator restored.

**Verify (numbered assertions):**

1. Within 1s of the WS close, the status bar's connection indicator transitions to a `disconnected` visual state (e.g. red dot, disconnect glyph) — symmetric with the connect indicator that was visible at baseline. → `16.9/assertion-01-statusbar-disconnect-on-close.png`
2. Within 5s of the auto-reconnect, the indicator returns to the `connected` visual state. → `16.9/assertion-02-statusbar-reconnect.png`
3. Optional (when reproducible): trigger `ws.onerror` directly via a forced bad frame; status bar shows the same disconnect visual state. → `16.9/assertion-03-statusbar-disconnect-on-error.png`

**Teardown:** none — the tab is left in its reconnected state.

**Result:** ☐ PASS ☐ FAIL

### 16.10: F-TAB-RESTORE-RELOAD-01 — Previously-open CLI session tabs reopen on page reload via persisted tabOrders

**Cascade-from:** SMOKE-CHAT-01 (three CLI tabs persisted to localStorage by `_persistTabOrders`).
**Closes gap for:** #597 (pre-fix `app.js` init never read persisted `tabOrders` back; a page reload dropped every open CLI session tab even though the persisted ordering was on disk in localStorage).

**Setup:**

1. Browser at `${WORKBENCH_URL}`, three `smoke-chat-{claude,gemini,codex}` tabs open. Capture a baseline screenshot of the tab bar showing all three tab tongues in their current order. Note the tab labels and their left-to-right order from the screenshot.
2. Setup-only diagnostic (not a verify mechanism): `browser_evaluate(() => JSON.parse(localStorage.getItem('tabOrders') || '{}'))` — confirms `_persistTabOrders` has written the persisted state. The verify itself is the rendered tab bar after the reload.

**Steps:**

1. Reload the page: `browser_navigate('about:blank')` followed by `browser_navigate('${WORKBENCH_URL}/')` (preserves localStorage across the navigation; setup-trigger only).
2. Wait up to 5s for `loadState()` to populate and `restoreOpenTabsFromOrder()` to reopen the persisted tabs.
3. Capture a screenshot of the tab bar after the reload.
4. Click each restored tab in turn (left to right). For each click, capture a screenshot ≤1s later showing the active-tab indicator on the clicked tab and the corresponding terminal pane attached below.

**Verify (numbered assertions):**

1. Within 5s of the reload completing (step 1), the primary tab bar shows all three `smoke-chat-{claude,gemini,codex}` tab tongues in the same left-to-right order as the baseline screenshot from Setup step 1 — every label from the baseline is present in the post-reload screenshot at the same position. → `16.10/assertion-01-tabs-restored-after-reload.png`
2. Within 1s of clicking each restored tab in step 4, the clicked tab carries the active-tab visual state (highlight / border / per-product active styling) and its terminal pane is rendered below — confirming each persisted entry restored a working session, not an empty placeholder. → `16.10/assertion-02-restored-tab-clickable-and-attached.png` (one composite frame covering all three clicks)

**Teardown:** none — restored tabs are the expected end state.

**Result:** ☐ PASS ☐ FAIL

## Section 17: State Engine + refresh/sync stack (#651)

### 17.1: F-STATE-ENGINE-WS-SUBSCRIBE — Status bar shows `ws: open` after page load; engine snapshot drives sidebar render

**Cascade-from:** SMOKE-LOGIN-01 (page loaded)
**Closes gap for:** #651 — replacement of the 10s /api/state poll with the /ws/state subscription channel.

**Setup:**

1. Browser at `${WORKBENCH_URL}`, gate passed if applicable. Ensure `localStorage.getItem('legacy_polling_enabled')` returns null or '0' (the engine path is the default).
2. At least one project with one CLI session of each `{claude, gemini, codex}` exists in the sidebar from baseline.

**Steps:**

1. Reload the page: `browser_navigate('${WORKBENCH_URL}/')`. Wait up to 5s for the initial render.
2. Capture a screenshot of the bottom status bar AND the sidebar.

**Verify (numbered assertions):**

1. Within 5s of reload, the status bar's leftmost pill reads `ws: open` (rendered as a pill with the open/connected visual treatment per the product's pill styling) — confirming the `/ws/state` WebSocket subscription succeeded. → `17.1/assertion-01-ws-pill-open.png`
2. The sidebar shows the baseline projects and at least one session row for each of claude/gemini/codex — confirming the engine snapshot populated `projectState` and the sidebar rendered from it. → `17.1/assertion-02-sidebar-populated.png`

**Teardown:** none.

**Result:** ☐ PASS ☐ FAIL

### 17.2: F-STATE-ENGINE-CONNECTION-PILL — Status bar reflects WS state transitions (R6/§6.6)

**Cascade-from:** 17.1
**Closes gap for:** #651 — central status-bar dispatcher replaces scattered DOM writes.

**Setup:**

1. State as left by 17.1: page loaded, status bar shows `ws: open`.

**Steps:**

1. Drop the engine WS connection: `browser_evaluate(() => { try { window._engineClient && window._engineClient.disconnect && window._engineClient.disconnect(); return 'ok'; } catch (e) { return e.message; } })` — setup trigger; not a verify.
2. Capture a screenshot of the status bar within 2s.
3. Reload the page to restore the engine subscription (`browser_navigate('${WORKBENCH_URL}/')`).
4. Capture a screenshot of the status bar within 5s of the reload completing.

**Verify (numbered assertions):**

1. Within 2s of step 1, the status bar's ws-pill text changes from `ws: open` to `ws: closed` (rendered with the closed/error visual treatment) — confirming the central dispatcher observed the disconnect. → `17.2/assertion-01-ws-pill-closed.png`
2. Within 5s of step 3, the status bar's ws-pill returns to `ws: open` — confirming the engine client reconnects on reload and the dispatcher re-renders. → `17.2/assertion-02-ws-pill-reopened.png`

**Teardown:** none.

**Result:** ☐ PASS ☐ FAIL

### 17.3: F-STATE-ENGINE-AUTH-MODE-PILL — Codex tab shows auth-mode pill (R14) — `oauth` | `api-key` | `stale`

**Cascade-from:** SMOKE-CHAT-01 codex variant (a codex session exists and is selected)
**Closes gap for:** #651 R14 — auth-mode pill driven by engine state.

**Setup:**

1. Browser at `${WORKBENCH_URL}`, page loaded, codex tab selected as active.
2. Settings → Codex section: confirm `codex_api_key` is set to a non-empty value AND saved (baseline known by 1.0 chat smoke).

**Steps:**

1. Capture a screenshot of the status bar showing the codex tab active.

**Verify (numbered assertions):**

1. The status bar contains an auth-mode pill (class includes `auth-pill`) reading `api-key` (or `oauth` if the test container is OAuth-only) — confirming the central dispatcher derived auth mode from the engine snapshot for the active codex session. → `17.3/assertion-01-codex-auth-pill.png`

**Teardown:** none.

**Result:** ☐ PASS ☐ FAIL

### 17.4: F-STATE-ENGINE-NO-POLLING — `/api/state` hit count stays at 0 after initial load (R1 / R6)

**Cascade-from:** 17.1
**Closes gap for:** #651 — the 10s /api/state polling loop is removed.

**Setup:**

1. State as left by 17.1.

**Steps:**

1. Start a network capture: `browser_network_requests` baseline before the next 30 seconds elapse — note the timestamp.
2. Wait 30 seconds with the page idle (no clicks).
3. Re-call `browser_network_requests` and capture only requests issued in the 30s window.

**Verify (numbered assertions):**

1. In the 30s window, the count of `GET /api/state` requests is 0 — confirming the periodic poll is gone and the engine WS is the steady-state channel. (Reload-triggered initial fetch is excluded by capturing AFTER reload completes.) → recorded by `browser_network_requests` JSON in the runbook log.

**Teardown:** none.

**Result:** ☐ PASS ☐ FAIL

### 17.5: F-STATE-ENGINE-RECONNECT — WS close + reconnect re-delivers state:snapshot; sidebar stays consistent

**Cascade-from:** 17.1
**Closes gap for:** #651 — engine subscription survives transient WS drops without losing state.

**Setup:**

1. State as left by 17.1.

**Steps:**

1. Force a WS close: `browser_evaluate(() => { try { window._engineClient && window._engineClient.disconnect && window._engineClient.disconnect(); return 'ok'; } catch (e) { return e.message; } })`.
2. Wait 3s.
3. Reload the page to trigger a fresh engine client + subscription.
4. Capture a screenshot of the sidebar.

**Verify (numbered assertions):**

1. Within 5s of step 3, the sidebar shows the same project + session set it did before step 1 — confirming the fresh subscription re-delivered a state:snapshot and the engine model was repopulated. → `17.5/assertion-01-sidebar-after-reconnect.png`
2. Within 5s of step 3, the status bar's ws-pill reads `ws: open`. → `17.5/assertion-02-ws-pill-reopened.png`

**Teardown:** none.

**Result:** ☐ PASS ☐ FAIL

### 17.6: F-STATE-ENGINE-TOKEN-FRESHNESS — Token counter updates within 5s of CLI write (R5 / R7)

**Cascade-from:** SMOKE-CHAT-01 (an active claude session exists)
**Closes gap for:** #651 — chokidar JSONL change → engine.updateSession → status bar token counter.

**Setup:**

1. Browser at `${WORKBENCH_URL}`, claude session tab open and active.

**Steps:**

1. Capture a baseline screenshot showing the current `[N tokens]` value on the status bar's token-counter pill.
2. Send a short prompt to the active claude session that produces a known response (e.g. `say "ok"` via `browser_type` on the canonical input selector). Press Enter.
3. Wait up to 10s for the response to complete.
4. Capture a screenshot of the status bar's token-counter pill.

**Verify (numbered assertions):**

1. Within 10s of step 2 completing, the token-counter pill value is strictly greater than the baseline from step 1 — confirming the chokidar event published a session:update diff with new `input_tokens` and the status bar re-rendered. → `17.6/assertion-01-token-counter-increased.png`

**Teardown:** none.

**Result:** ☐ PASS ☐ FAIL

### 17.7: F-STATE-ENGINE-QDRANT-MTIME — Re-sync of unchanged file short-circuits (CLI-agnostic)

**Cascade-from:** baseline workbench with vector embeddings enabled and at least one synced collection
**Closes gap for:** #651 commit 4 — `syncFileToCollection` mtime shortcut.

**Setup:**

1. A document file in `${WORKSPACE}` has already been synced to qdrant in a prior run (baseline state).

**Steps:**

1. Trigger a sync that includes the unchanged file (Settings → Re-index, or wait for the next scheduled sync window).
2. Observe the workbench-server log (or `/api/qdrant/stats` if exposed) for the sync result.

**Verify (numbered assertions):**

1. The sync result for the unchanged file shows the mtime-shortcut path was taken — the file's chunk count delta is 0, AND the sync log line for that file does NOT include a "rechunked" or "re-embedded" marker. The agent reads the sync result panel / log and affirms both conditions. → `17.7/assertion-01-mtime-shortcut.png`

**Teardown:** none.

**Result:** ☐ PASS ☐ FAIL

### 17.8: F-STATE-ENGINE-WARMING-FALLBACK — `/api/state` returns 200 with `X-State-Engine-Warming` advisory header

**Cascade-from:** none — this exercises the warming-fallback BLOCKER fix from commit 11.
**Closes gap for:** #651 reviewer BLOCKER B1 (commit 11 `414b095`).

**Setup:**

1. A workbench instance has just been restarted (container restart or `docker compose restart workbench`). The engine warm-from-DB pass is in flight (typically < 30s for ≤ 100 sessions).

**Steps:**

1. Within 5s of the restart completing (server bound port, /health returns 200), open the browser DevTools Network panel.
2. Reload `${WORKBENCH_URL}/`.
3. Click the `/api/state` row in the Network panel.

**Verify (numbered assertions):**

1. The `/api/state` response status is `200` (NOT `503`) — confirming the warming branch falls through to the DB-walk instead of hard-returning 503. → `17.8/assertion-01-api-state-200-during-warm.png`
2. The response header `X-State-Engine-Warming` reads `1` while the warm pass is in flight (header is absent once `markWarm()` fires) — confirming the warming hint is surfaced as advisory metadata, not as a failed request. → `17.8/assertion-02-warming-header.png`

**Teardown:** none.

**Result:** ☐ PASS ☐ FAIL

### 17.9: F-STATE-ENGINE-IDLE-BUDGET — Hidden tab does not fire periodic tasks (R10)

**Cascade-from:** 17.1
**Closes gap for:** #651 R10 — `Timers` scheduler skips fires when document.visibilityState === 'hidden'.

**Setup:**

1. State as left by 17.1 (page loaded, status bar shows `ws: open`).

**Steps:**

1. Capture a baseline `window._timers.stats()` snapshot: `browser_evaluate(() => window._timers && window._timers.stats())`. Note the `totalFires` per task.
2. Open a new browser tab and switch to it so the workbench tab becomes hidden (`document.visibilityState === 'hidden'`).
3. Wait 90 seconds.
4. Return to the workbench tab and re-capture `window._timers.stats()`.

**Verify (numbered assertions):**

1. Between step 1 and step 4 (≈ 90 seconds of hidden-tab time), each task's `totalFires` increased by at most 1 (the visible-tab fire before/after the hidden window) — confirming the scheduler skipped its hidden-window ticks. Without the skip, `checkAuth` and `checkErrors` (60s interval each) would have fired at least once during the window. → recorded by the two `_timers.stats()` JSON snapshots.

**Teardown:** none.

**Result:** ☐ PASS ☐ FAIL

### 17.10: F-STATE-ENGINE-MEMORY-BOUND — Oversized snapshot path closes ws with `state:error` frame (R34)

**Cascade-from:** none — synthetic; requires a workbench with `MAX_BYTES_DEFAULT` lowered or a session set large enough to exceed 5 MB serialized.
**Closes gap for:** #651 reviewer BLOCKER B4 (commit 11) — WS maxBytes parity with HTTP 507.

**Setup:**

1. A workbench instance configured with `state.maxBytes` ≤ the size of its current snapshot (developer can verify by reading `/api/state` body byte size and lowering the bound below it via env or config).

**Steps:**

1. Open `${WORKBENCH_URL}/` with DevTools open, Network panel filtered to `ws`.
2. Inspect the `/ws/state` frames.

**Verify (numbered assertions):**

1. The first WS frame received is `{type: "state:error", error: "memory_bound_exceeded", actual_bytes: <N>, max_bytes: <M>}` with `N > M` — confirming the engine refuses to push an oversized snapshot. → `17.10/assertion-01-state-error-frame.png`
2. Within 1s of the error frame, the WS connection closes — confirming the engine drops the subscriber rather than retrying indefinitely. → `17.10/assertion-02-ws-closed-after-error.png`

**Teardown:** restore the original `state.maxBytes` configuration.

**Result:** ☐ PASS ☐ FAIL
