# This Repository

This repository is the source code for the Agentic Workbench application — the system you are running inside. You are using the workbench to develop the workbench. The full architecture, module responsibilities, and configuration reference are in `README.md`.

# Current Project + Milestone

* **Project:** r1
* **Milestone:** `01-stabilization`

# Canonical Team Sessions

The roles for this project are bound to the following workbench sessions. Dispatch only to these IDs. Do not spawn new sessions for these roles.

| Role | Session ID |
|---|---|
| Project Manager | `85d37034-f149-4770-8e5f-a0092ce05bf8` |
| Engineer | `baa4c5da-9389-4f7a-9a5f-512407345f58` |
| Tester | `d876819c-56db-4ac7-9699-b3e89400b2dc` |
| Designer | `0cda55ab-9d82-4ab6-aec8-02bdaaff034e` |
| Tech Writer | `4ea1ced0-5127-47df-89e7-b77f1f929b65` |
| Reviewer-Claude | `f97d3af7-a5b8-4ca1-bb52-29be0624855a` |
| Reviewer-Codex | `8d21b99e-6407-46fb-bcf7-7f42376c61d0` |
| Reviewer-Gemini | `94dbc1f0-02c8-4c7b-9804-c35d0fe6535d` |

# Anchor Documents

These are the project-specific files. **`README.md` must be read on every session.** The runbooks and test plans must be read fully when relevant to your current task. Do not grep or search within documents — content cannot be understood out of context.

Cross-project standards, requirements, SDLCs, PROCs, and role files are NOT listed here — they are referenced from the role files (`Admin/roles/*.md`) and from the process docs themselves. Load those when your role file or current task directs you to.

## Project files

* `README.md` — architecture, module structure, dependency graph, configuration reference, and compliance notes. **Read on every session.**
* `tests/workbench-test-plan-backend.md` — backend test plan (mock + integration scope). Not in the Tester's run-time reading list (the runbooks are); read at plan time.
* `tests/workbench-test-plan-ui.md` — UI test plan. Not in the Tester's run-time reading list; read at plan time.
* `tests/workbench-mock-runbook.md` — mock test runbook (framework, invocation, project quirks). Read when running stage-2 mock tests.
* `tests/workbench-integration-runbook.md` — integration test runbook. Read when running stage-4 integration tests.
* `tests/workbench-ui-runbook.md` — UI test catalog. Read when running stage-5 UI tests or the stage-7 pre-merge UI pass.
* `/data/workspace/repos/Admin/docs/guides/workbench-deployment.md` — deployment specifics for this repo: safety rules, architecture, `/data` volume, dev/prod indicator, add-on installation. Read before deploying or working on container/infrastructure code.
* `/data/workspace/repos/Admin/docs/runbooks/RUN-001-deployment.md` — step-by-step deploy procedure (build → push → pull → up). Read before any deploy.
