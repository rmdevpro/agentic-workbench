# This Repository

This repository is the source code for the Agentic Workbench application — the system you are running inside. You are using the workbench to develop the workbench. The application is a Node.js server (`server.js`) decomposed into focused modules using factory-based dependency injection. The full architecture, module responsibilities, and configuration reference are in `README.md`.

# Operating Modes

You operate in one of two modes at any given moment. See [PROC-001 — Agent Operating Modes](/data/workspace/repos/Admin/docs/process/PROC-001-agent-operating-modes.md) for the canonical statement.

- **Conversational mode (default):** answer the user's message, wait for the next. Don't jump ahead. The user does the steering.
- **Autonomous mode:** drive a multi-step process to completion. Poll continuously, run iterations back-to-back without waiting for user prompts, report only meaningful events. User messages are redirection, not loop triggers.

**Inline foreground polling is the ONLY acceptable way to monitor a long-running job.** Two valid patterns — pick whichever fits the situation:
- `session_wait {session_id, seconds}` + `session_read_screen` — for workbench-managed CLI sessions.
- `start=$(date +%s); end=$((start + 60)); until [ $(date +%s) -ge $end ]; do sleep 2; done; <check>` — for anything else (deploys, file growth, external commands).

The `Monitor` tool and `run_in_background` are forbidden for progress checks.

# Anchor Documents

These documents define the standards and context this project must be reviewed and developed against. **`README.md` (under §This Repository) must be read on every session.** Other documents must be read fully when relevant to your current task. Do not grep or search within documents — content cannot be understood out of context. A document that is partially read is a document misread.

## This Repository

- `README.md` — architecture, module structure, dependency graph, configuration reference, and compliance notes. **Read on every session.**
- `tests/workbench-test-plan-backend.md` — backend test plan. Read before writing backend tests or reviewing backend changes.
- `tests/workbench-test-plan-ui.md` — UI test plan. Read before writing UI tests or reviewing UI changes.
- `tests/workbench-test-runbook.md` — master UI test runbook. Read before running UI tests.
- `tests/traceability-matrix.md` — test coverage traceability matrix. Read to understand current coverage status before adding or modifying tests.
- `/data/workspace/repos/Admin/docs/guides/workbench-deployment.md` — deployment specifics for this repo: safety rules, architecture, `/data` volume, dev/prod indicator, add-on installation. Read before deploying or working on container/infrastructure code.

## Engineering Standards

- `/data/workspace/repos/Admin/docs/requirements/REQ-001-base-engineering.md` — engineering requirements all code in this project must satisfy. Read before writing or reviewing any application code.
- `/data/workspace/repos/Admin/docs/standards/STD-003-test-plan-standard.md` — defines what a test plan must contain and how it must be maintained. Read before reviewing or updating the test plans.
- `/data/workspace/repos/Admin/docs/standards/STD-004-code-standard.md` — defines what a code deliverable must look like as an artifact. Read before writing or reviewing application code.
- `/data/workspace/repos/Admin/docs/standards/STD-005-test-code-standard.md` — defines what test code must look like. Read before writing or reviewing test code.
- `/data/workspace/repos/Admin/docs/standards/STD-007-readme-standard.md` — defines what the README must contain and how it must be maintained. Read before updating `README.md`.

## Process

- `/data/workspace/repos/Admin/docs/process/SDLC-1-version-creation.md` — open a new release `rN`, set up team + artifact paths. Read when starting a new project or just after release close.
- `/data/workspace/repos/Admin/docs/process/SDLC-2-release-planning.md` — populate the open `rN` Project with milestones + issues + release-specific scope matrix. Read at planning time.
- `/data/workspace/repos/Admin/docs/process/SDLC-3-milestone-execution.md` — 13-stage pipeline for executing one milestone. Read whenever you're executing a milestone.
- `/data/workspace/repos/Admin/docs/process/SDLC-4-release-close.md` — full-regression release gate, prod deploy, close `rN` Project, open `rN+1`. Read at release close.
- `/data/workspace/repos/Admin/docs/process/PROC-001-agent-operating-modes.md` — conversational vs autonomous mode rules. Read at session start.
- `/data/workspace/repos/Admin/docs/process/PROC-002-test-execution-policy.md` — canonical policy for which tests run and when (includes the UI-headless-browser rule in Principle 8). Read before authoring or running tests.
- `/data/workspace/repos/Admin/docs/process/PROC-003-test-scope-matrix.md` — global test scope matrix (consumed during SDLC-2 to produce the release-specific matrix).
- `/data/workspace/repos/Admin/docs/process/PROC-004-runbook-execution-guide.md` — procedure for orchestrating the UI test runbook. Used by SDLC-3 (UI test stages) and SDLC-4 (release-gate UI run).
- `/data/workspace/repos/Admin/docs/process/PROC-005-review.md` — unified review procedure (code and docs) via 3-CLI quorum: round structure, review-request issue contract, PM dispatch contract, findings contract, per-round and per-milestone Definitions of Done, Stage 12 PR variant, content variations for code vs doc reviews.
- `/data/workspace/repos/Admin/docs/runbooks/RUN-001-deployment.md` — step-by-step deploy procedure (build → push → pull → up). Read before any deploy.
