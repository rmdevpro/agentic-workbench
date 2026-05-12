# This Repository

This repository is the source code for the Agentic Workbench application — the system you are running inside. You are using the workbench to develop the workbench. The application is a Node.js server (`server.js`) decomposed into focused modules using factory-based dependency injection. The full architecture, module responsibilities, and configuration reference are in `README.md`.

# Deploy safety rule

Before any deploy, two checks must pass in order:

1. **Never deploy to yourself.** You are running inside a container. The target machine cannot be the one you are running on — it kills the current session.
2. **Read `logo_variant` on the target first.** `production` = stop, do not deploy. `development` or `default` = may proceed.

```
docker exec workbench sqlite3 /data/.workbench/workbench.db \
  "SELECT value FROM settings WHERE key = 'logo_variant'"
```

**Machine names are not environment designators.** M5, irina, hymie, HF — any of them can be production. The `logo_variant` value is the only authoritative signal.

# Operating Modes

You operate in one of two modes at any given moment. See [PROC-001 — Agent Operating Modes](/data/workspace/repos/Admin/docs/process/PROC-001-agent-operating-modes.md) for the canonical statement.

- **Conversational mode (default):** answer the user's message, wait for the next. Don't jump ahead. The user does the steering.
- **Autonomous mode:** drive a multi-step process to completion. Poll continuously, run iterations back-to-back without waiting for user prompts, report only meaningful events. User messages are redirection, not loop triggers.

**Inline foreground polling is the ONLY acceptable way to monitor a long-running job.** Two valid patterns — pick whichever fits the situation:
- `session_wait {session_id, seconds}` + `session_read_screen` — for workbench-managed CLI sessions.
- `start=$(date +%s); end=$((start + 60)); until [ $(date +%s) -ge $end ]; do sleep 2; done; <check>` — for anything else (deploys, file growth, external commands).

The `Monitor` tool and `run_in_background` are forbidden for progress checks.

# Testing rule (UI features)

**Every UI-facing test runs in a headless browser against the deployed UI. Always.** Playwright (or equivalent) on the deployed URL. Click the real buttons, drag the real elements, read the rendered DOM.

Forbidden as a substitute for a UI test:
- SSH'ing into the host and running `docker exec workbench …` to peek at files or send tmux keys.
- `curl /api/…` to inspect backend responses *in lieu of* observing what the UI renders.
- `tmux capture-pane` / `tmux send-keys` directly on the host instead of clicking through the UI.
- Reading state files / DB rows / logs on the host as a substitute for verifying what the user sees.

Those are diagnostic tools — useful while debugging — but they do not test the UI. Many bugs are pure-frontend (CSS, click handlers, polling, render hashing) and a green API call says nothing about whether the bug is actually fixed in the user's view. The headless browser is the only thing that exercises the same code path the user does, in the same DOM, against the same deployed bundle.

This applies to runbook entries too: if `Verify:` describes something the user sees, the steps must be browser-driven actions. Host-side commands are fine in `Setup:` (planting state, restarting containers) but not in `Verify:`.

# Anchor Documents

These documents define the standards and context this project must be reviewed and developed against. When a document is relevant to your current task, read it fully. Do not grep or search within documents — content cannot be understood out of context. A document that is partially read is a document misread.

## Engineering Standards

- `/data/workspace/repos/Admin/docs/requirements/REQ-001-base-engineering.md` — engineering requirements all code in this project must satisfy. Read before writing or reviewing any application code.
- `/data/workspace/repos/Admin/docs/standards/STD-003-test-plan-standard.md` — defines what a test plan must contain and how it must be maintained. Read before reviewing or updating the test plans.
- `/data/workspace/repos/Admin/docs/standards/STD-004-code-standard.md` — defines what a code deliverable must look like as an artifact. Read before writing or reviewing application code.
- `/data/workspace/repos/Admin/docs/standards/STD-005-test-code-standard.md` — defines what test code must look like. Read before writing or reviewing test code.
- `/data/workspace/repos/Admin/docs/standards/STD-007-readme-standard.md` — defines what the README must contain and how it must be maintained. Read before updating `README.md`.

## Process

- `/data/workspace/repos/Admin/docs/process/SDLC-1-version-creation.md` — open a new release `rN`, set up team + artifact paths. Read when starting a new project or just after release close.
- `/data/workspace/repos/Admin/docs/process/SDLC-2-release-planning.md` — populate the open `rN` Project with milestones + issues + release-specific scope matrix. Read at planning time.
- `/data/workspace/repos/Admin/docs/process/SDLC-3-milestone-execution.md` — 13-stage pipeline for one milestone (covers normal multi-issue milestones AND single-issue urgent patches via the patch path). Read whenever you're executing a milestone.
- `/data/workspace/repos/Admin/docs/process/SDLC-4-release-close.md` — full-regression release gate, prod deploy, close `rN` Project, open `rN+1`. Read at release close.
- `/data/workspace/repos/Admin/docs/process/PROC-001-agent-operating-modes.md` — conversational vs autonomous mode rules. Read at session start.
- `/data/workspace/repos/Admin/docs/process/PROC-002-test-execution-policy.md` — canonical policy for which tests run and when.
- `/data/workspace/repos/Admin/docs/process/PROC-003-test-scope-matrix.md` — global test scope matrix (consumed during SDLC-2 to produce the release-specific matrix).
- `/data/workspace/repos/Admin/docs/process/PROC-004-runbook-execution-guide.md` — procedure for orchestrating the UI test runbook. Used by SDLC-3 (UI test stages) and SDLC-4 (release-gate UI run).

## Deployment

- `/data/workspace/repos/Admin/docs/guides/workbench-deployment.md` — deployment architecture, the `/data` volume convention, dev/prod distinction, and add-on installation. Read before any deployment or infrastructure work.

## This Repository

- `README.md` — architecture, module structure, dependency graph, configuration reference, and compliance notes. Read before working on any part of the codebase.
- `tests/workbench-test-plan-backend.md` — backend test plan. Read before writing backend tests or reviewing backend changes.
- `tests/workbench-test-plan-ui.md` — UI test plan. Read before writing UI tests or reviewing UI changes.
- `tests/workbench-test-runbook.md` — master UI test runbook. Read before running UI tests.
- `tests/traceability-matrix.md` — test coverage traceability matrix. Read to understand current coverage status before adding or modifying tests.
