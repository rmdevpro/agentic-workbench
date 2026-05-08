# Agentic Workbench Static Code Review

Date: 2026-05-08
Reviewer: Codex
Scope: Static source review of `/data/workspace/repos/agentic-workbench`

## Review Boundaries

This review is intentionally static. I did not modify application source, did not run tests, did not run lint, and did not execute the application. The user explicitly clarified that this should be a code review, not testing.

CodeRabbit was available as a plugin, but authentication did not complete in this environment, so this report is a manual review and should not be treated as CodeRabbit output.

Security is deliberately treated as the lowest-priority topic in this report. The main review focus is architecture, maintainability, standards alignment, correctness risks, test/document drift, and engineering quality.

## Executive Summary

The codebase is functional-looking but has significant engineering debt concentrated around module boundaries, stale documentation/tests, incomplete adherence to the repository's own standards, and high coupling between UI, routes, MCP tools, session management, and persistence.

The biggest issue is not a single bug. It is that several core files have become large, multi-domain control centers:

* `src/routes.js`: 2,370 lines
* `public/index.html`: 5,908 lines
* `src/qdrant-sync.js`: 1,311 lines
* `src/session-utils.js`: 1,062 lines
* `src/mcp-tools.js`: 948 lines
* `src/db.js`: 799 lines
* `src/watchers.js`: 707 lines

This size and responsibility concentration makes the system harder to review, harder to test, and more likely to regress when features change. The stale task tests and stale task plan references show this is already happening.

## Top Recommendations

1. Decompose `src/routes.js` into domain route modules before adding more route-level features.
2. Reconcile tests and test plans with the current task v2 model.
3. Correct the task drag/reorder ranking bug.
4. Remove or archive dead feature surfaces such as voice input.
5. Replace sync filesystem/process calls in async request/tool paths or formally document approved exceptions.
6. Make MCP tool schema and handler registration use a single source of truth.
7. Tighten session identity resolution so missing IDs fail visibly instead of binding to "latest" or "first unclaimed".
8. Split `public/index.html` into frontend modules and remove duplicated escaping/rendering helpers.

## Findings

### 1\. Backend Route Architecture Is Too Broad

Severity: Major

`src/routes.js:159` starts `registerCoreRoutes`, which registers a wide range of unrelated application behavior in one module. The same file contains session creation/reconciliation, auth handling, project settings, task APIs, file APIs, git/KB APIs, qdrant/vector settings, health-related behavior, and compaction/session resume helpers.

Examples:

* `src/routes.js:159` starts the central `registerCoreRoutes` function.
* `src/routes.js:282` contains stale session reconciliation.
* `src/routes.js:376` contains non-Claude session metadata matching.
* `src/routes.js:1570` begins task v2 route handling.
* `src/routes.js:2186` writes resume tail files.

Impact:

The file has too many reasons to change. A task API change, session resolution fix, settings feature, and vector-search change all collide in the same module. This increases review cost and regression risk.

Recommendation:

Split route registration into domain modules:

* `routes/sessions.js`
* `routes/projects.js`
* `routes/tasks.js`
* `routes/files.js`
* `routes/settings.js`
* `routes/git-kb.js`
* `routes/vector.js`
* `routes/health.js`

Then move business logic into service modules:

* `services/session-service.js`
* `services/task-service.js`
* `services/project-service.js`
* `services/settings-service.js`
* `services/vector-service.js`
* `services/git-service.js`

Routes should validate HTTP input and call services. They should not own cross-domain workflow logic.

Suggested extraction order:

1. Extract `routes/tasks.js` first because task v2 is already the clearest source of source/test/doc drift.
2. Extract `routes/sessions.js` next because session identity, stale reconciliation, resume, archive, config, and terminal lifecycle are currently coupled in the largest backend file.
3. Extract `routes/settings.js`, `routes/git-kb.js`, `routes/vector.js`, and `routes/files.js` after that because these are mostly separable feature areas.
4. Leave `registerCoreRoutes` as a thin composition layer only after the domain routes exist.

The target shape should be that `src/routes.js` either disappears or only wires domain route modules together. It should not remain the owner of task, session, settings, file, git, and vector behavior.

### 2\. Frontend Is a Monolith

Severity: Major

`public/index.html` is 5,908 lines and contains global state, rendering logic, terminal handling, file browser behavior, task tree behavior, settings screens, git account UI, qdrant controls, auth flow, error banners, and utility helpers.

Examples:

* `public/index.html:3009` starts the task panel v2 logic.
* `public/index.html:3674` opens file tabs.
* `public/index.html:4316` handles file browser drops.
* `public/index.html:5109` opens settings.
* `public/index.html:5418` renders git accounts.
* `public/index.html:5853` defines another escaping helper near the bottom of the file.

Impact:

The UI is hard to reason about because behavior is global and ordering-sensitive. It is easy to introduce duplicate helpers, stale selectors, accidental global coupling, or inconsistent escaping/rendering behavior.

Recommendation:

Split the frontend into ES modules while preserving the existing visual design:

* `public/js/api-client.js`
* `public/js/html-utils.js`
* `public/js/terminal-tabs.js`
* `public/js/task-panel.js`
* `public/js/file-tree.js`
* `public/js/settings.js`
* `public/js/git-accounts.js`
* `public/js/vector-settings.js`
* `public/js/error-log.js`

Use explicit initialization from a small entrypoint rather than relying on a single global script body.

### 3\. Dependency Injection Architecture Is Inconsistent

Severity: Major

The repository documentation describes factory-based dependency injection, but several modules directly import stateful singletons.

Examples:

* `src/mcp-tools.js:8-11` imports `safe-exec`, `session-utils`, `logger`, and `db` directly.
* `src/mcp-tools.js:65` dynamically requires `qdrant-sync`.
* `src/mcp-tools.js:309` dynamically requires `config`.
* `src/session-utils.js:5-8` imports `safe-exec`, `db`, `config`, and `logger` directly.
* `src/qdrant-sync.js:17-20` imports `logger`, `db`, `safe-exec`, and `config` directly.

Impact:

Direct singleton imports make modules harder to unit test, harder to isolate, and more likely to develop hidden startup ordering dependencies.

Recommendation:

Either update README to explicitly state which modules are intentional process singletons, or complete the factory pattern. Prefer completing the factory pattern for:

* `mcp-tools`
* `session-utils`
* `qdrant-sync`
* `webhooks`
* `watchers`

### 4\. README Compliance Claims Do Not Match the Code

Severity: Major

`README.md:154` claims "async I/O in all async paths", but async handlers still use sync filesystem and process calls.

Examples:

* `src/mcp-tools.js:103-180` uses `fs.readdirSync`, `fs.statSync`, `fs.readFileSync`, `fs.writeFileSync`, `fs.unlinkSync`, and `execSync` inside async MCP handlers.
* `src/mcp-tools.js:313-337` uses sync file reads/writes during session resume prompt generation.
* `src/mcp-tools.js:368-390` uses `execSync` grep in an async session search handler.
* `src/session-resolver.js:223-247` uses sync filesystem traversal in async session discovery.
* `src/session-utils.js:312-382` uses sync reads for Gemini/Codex transcript resolution.
* `src/session-utils.js:733-864` uses sync reads and sync traversal for Gemini/Codex session discovery.
* `src/qdrant-sync.js:66-71` reads Codex auth synchronously.
* `src/qdrant-sync.js:807-853` uses `existsSync` inside async scanning paths.

Impact:

The implementation does not meet the stated engineering standard. Sync I/O can block the event loop under MCP calls, session discovery, vector scans, or large file operations.

Recommendation:

Replace sync calls in request/tool paths with `fs/promises` and `execFile`/spawn-based helpers. If a sync call is intentionally kept for atomic startup or unavoidable native behavior, document it in a standards exception registry rather than leaving README with a blanket compliance claim.

### 5\. Task Reorder/Reparent Has a Correctness Bug

Severity: Major

The UI sends both `rank` and reparenting information for drag/drop reorder:

* `public/index.html:3174-3180`

The route applies rank before reparent:

* `src/routes.js:1718`
* `src/routes.js:1719-1723`

But `db.reparentTask` always appends to the destination bucket:

* `src/db.js:655-660`

That means the rank computed by the UI can be overwritten when a task is moved to a new parent/project.

Impact:

Drag/drop ordering can produce unexpected task positions. This is a user-facing correctness issue and can also make automated tests flaky once tests are updated for task v2.

Recommendation:

Make reparent and rerank atomic. Options:

* Add `db.moveTask(id, { parentTaskId, projectId, rank })`.
* In the route, reparent first, then call `setTaskRank` in the destination bucket.
* Ensure rank shifting/densification happens in one transaction.

### 6\. Session Identity Resolution Can Bind the Wrong Session

Severity: Major

Several code paths fall back to "latest" or "first unclaimed" session when an exact CLI session ID is missing.

Examples:

* `src/safe-exec.js:150-166` resumes Gemini with `--resume latest` if `cli_session_id` is absent or lookup fails.
* `src/session-utils.js:325-331` falls back to the most recent Gemini session.
* `src/session-utils.js:370-375` falls back to the most recent Codex session.
* `src/routes.js:395-400` takes the first unclaimed non-Claude disk session.

Impact:

In a multi-agent workbench, "latest" is not a safe identity boundary. A UI row can display or resume the wrong underlying CLI session, especially under concurrent Gemini/Codex usage.

Recommendation:

Fail closed when an exact CLI session ID cannot be resolved. Surface an explicit "session unresolved" state in the UI and require user action to rebind or start a new session.

### 7\. Task v2 Implementation and Tests Are Out of Sync

Severity: Major

The application has moved to project-based task v2:

* `src/routes.js:1570-1572`
* `src/routes.js:1654-1668`
* `src/db.js:506-510`

But many tests and plans still reference the older folder-path task model.

Examples:

* `tests/browser/task-tree.spec.js:62` expects `#add-task-input`.
* `tests/browser/task-tree.spec.js:71-84` expects `todo` filter behavior.
* `tests/mock/db.test.js:93-98` calls old positional `db.addTask('/workspace/proj', ...)`.
* `tests/live/routes-tasks.test.js:18-24` posts `{ folder_path, title }`.
* `tests/live/routes-tasks.test.js:34-49` expects a filesystem-folder task tree.
* `tests/browser/multi-cli-and-editors.spec.js:263-272` uses MCP `task_add` with `folder_path`.
* `tests/browser/multi-cli-and-editors.spec.js:496-526` still references `.task-node`, folder expansion, and `expandedTaskFolders`.
* `tests/workbench-test-plan-ui.md:401-407` documents old task selectors.
* `tests/workbench-test-plan-ui.md:818-830` describes filesystem task tree behavior.

Impact:

The project no longer has trustworthy test documentation for the task domain. Future changes can be reviewed against stale expectations, and failing tests may be dismissed as "old" without a clear replacement standard.

Recommendation:

Do a task-domain test plan reconciliation:

* Mark old folder-path task behavior as removed or legacy migration-only behavior.
* Rewrite task API tests around `project_id`, `parent_task_id`, status lifecycle, archive flag, and rank.
* Rewrite UI tests around current selectors: `.task-row`, project/program grouping, issue requirements, context menus, and drag/drop.
* Remove or quarantine tests that assert old `todo`/`folder_path` behavior.

### 8\. Dead Feature Surfaces Remain

Severity: Moderate

`src/server.js:25` says voice input was removed, but `src/voice.js` remains and tests still reference it.

Examples:

* `src/server.js:25`
* `src/voice.js:1-98`
* `tests/mock/voice.test.js`
* `tests/mock/server.test.js` references `voice.js`
* `tests/workbench-test-runbook.md:3721` notes voice removal.

Impact:

Dead feature surfaces create confusion during review and maintenance. They also cause test/document contradictions: is voice removed, hidden, or still supported as an endpoint?

Recommendation:

Delete `src/voice.js` and its tests if the feature is removed. If it is intentionally retained as a backend-only feature, update `server.js`, README, runbook, and settings UI docs to state that.

### 9\. Stale README Known Limitation

Severity: Moderate

`README.md:162` references `resolveCheckerSessionId`, but the current source does not appear to contain that function. The smart compaction/checker behavior appears to have changed or been removed.

Impact:

README no longer accurately describes operational limitations. This matters because README is listed as an anchor document for architecture and compliance.

Recommendation:

Update README known limitations to match current code. Remove stale checker references or replace them with current limitations around Gemini/Codex session identity resolution.

### 10\. MCP Tool Schema and Handler Registry Can Drift

Severity: Moderate

MCP tool schemas live in `src/mcp-server.js`, while implementations live in `src/mcp-tools.js`.

Examples:

* `src/mcp-server.js:67-280` defines the tool catalog.
* `src/mcp-tools.js:99` starts the handler registry.
* `src/mcp-tools.js:916-921` dispatches by handler name.

Impact:

There is no single source of truth for tool names, descriptions, schemas, and handler availability. Schema and implementation drift is likely as tools are added or renamed.

Recommendation:

Create one tool catalog module that exports:

* tool name
* description
* input schema
* handler
* optional capability/domain metadata

Use that catalog for both stdio MCP schema responses and HTTP dispatch.

### 11\. MCP Tool Handlers Mix API\, Filesystem\, Session\, Project\, Task\, and Settings Logic

Severity: Moderate

`src/mcp-tools.js` is effectively another route layer plus service layer. It mirrors many domains that also exist in HTTP routes.

Examples:

* File tools begin at `src/mcp-tools.js:101`.
* Session tools begin around `src/mcp-tools.js:303`.
* Project prompt/MCP config tools begin around `src/mcp-tools.js:500`.
* Task tools begin around `src/mcp-tools.js:584`.
* Dispatch begins at `src/mcp-tools.js:918`.

Impact:

HTTP routes and MCP tools can diverge in behavior. The task rank/reparent issue exists in both the HTTP path and MCP path:

* `src/routes.js:1718-1723`
* `src/mcp-tools.js:722-732`

Recommendation:

Move shared behavior into services and make both HTTP routes and MCP handlers call those services. MCP handlers should not implement parallel business logic.

### 12\. Qdrant Sync Module Is Too Broad

Severity: Moderate

`src/qdrant-sync.js` owns configuration, provider validation, embedding calls, retry logic, Qdrant collection management, point upserts/deletes/search, chunking, file scanning, session scanning, watchers, lifecycle, reindexing, and status reporting.

Examples:

* `src/qdrant-sync.js:40-64` settings parsing.
* `src/qdrant-sync.js:195-309` embedding behavior.
* `src/qdrant-sync.js:384-467` Qdrant HTTP operations.
* `src/qdrant-sync.js:807-847` directory scanning.
* `src/qdrant-sync.js:849-963` collection-specific scan functions.
* `src/qdrant-sync.js:1058-1184` lifecycle/restart/config reapply.
* `src/qdrant-sync.js:1218-1283` search/reindex/status.

Impact:

This module is difficult to test and reason about. Provider behavior, scanner behavior, and Qdrant behavior are tightly coupled.

Recommendation:

Split into:

* `vector/provider-config.js`
* `vector/embedding-providers.js`
* `vector/qdrant-client.js`
* `vector/chunkers.js`
* `vector/file-scanner.js`
* `vector/session-scanner.js`
* `vector/sync-service.js`

### 13\. Gemini Session Indexing Is Inconsistent

Severity: Moderate

`session-utils` supports Gemini `.json` and `.jsonl`:

* `src/session-utils.js:743-750`
* `src/session-utils.js:856-858`

But qdrant sync scans only `.json` for Gemini sessions:

* `src/qdrant-sync.js:927-930`

Also `parseGeminiSession` in qdrant expects JSON content:

* `src/qdrant-sync.js:588-614`

Impact:

Current Gemini sessions written as JSONL may appear in session discovery but not in vector sync, creating inconsistent feature behavior.

Recommendation:

Reuse the same Gemini parser/discovery logic between `session-utils` and vector sync, or extract shared Gemini/Codex transcript parsers.

### 14\. Frontend Escaping Helpers Are Duplicated and Semantically Inconsistent

Severity: Moderate

There are multiple escaping helpers with different names and behavior:

* `public/index.html:3019` defines `escAttr` for HTML attribute quotes.
* `public/index.html:3931-3934` defines another `escAttr`, but this one is effectively a CSS selector escape helper.
* `public/index.html:4583-4587` defines `escHtml` using a DOM element.
* `public/index.html:5853-5855` defines `escapeHtml` using manual replacement.

Impact:

This is a maintainability issue first and a security issue second. Reviewers cannot easily know which escape helper is correct for HTML text, HTML attributes, CSS selectors, URLs, or JS string contexts.

Recommendation:

Create a single `html-utils.js` or `dom-utils.js` with explicit helpers:

* `escapeHtmlText`
* `escapeHtmlAttr`
* `escapeCssSelector`
* `safeTextNode`
* `setDatasetValue`

Prefer DOM construction over string-based `innerHTML` where practical.

### 15\. Inline Event Handlers in Generated HTML Increase Coupling

Severity: Moderate

`renderGitAccounts` generates inline event handlers:

* `public/index.html:5439-5443`

Impact:

Inline handlers rely on global function names and make modularization harder. They also mix rendering and behavior in one string template.

Recommendation:

Render rows with DOM APIs or use event delegation on `#git-accounts-list` and `data-*` attributes.

### 16\. Runtime Tunables Are Not Fully Externalized

Severity: Moderate

Some tunables are still embedded in code despite the standards emphasis on externalized config.

Examples:

* `src/qdrant-sync.js:24-27` defines Qdrant URL, debounce, and chunk window/overlap constants.
* `src/routes.js:344` defines `NONCLAUD_CACHE_TTL`.
* `src/routes.js:382-387` hardcodes non-Claude session matching window.
* `src/mcp-tools.js:169` hardcodes grep timeout and max buffer.
* `src/qdrant-sync.js:58` hardcodes vector ignore defaults.

Impact:

Changing operational behavior requires code edits, and README compliance claims overstate the current config model.

Recommendation:

Move runtime tunables into `config/defaults.json` and keep environment variables only as deployment overrides.

### 17\. Logging Standards Drift

Severity: Moderate

Most active modules use the project logger, but `src/voice.js` uses `console.log` and `console.error`:

* `src/voice.js:39`
* `src/voice.js:57`
* `src/voice.js:62`
* `src/voice.js:68`
* `src/voice.js:86`
* `src/voice.js:93`

Impact:

If voice is dead, this is another sign it should be removed. If voice is live, it does not meet the structured logging standard.

Recommendation:

Remove voice or convert it to structured logger usage with module/op context.

### 18\. Safe\-Exec Contains Legacy Helper Surface

Severity: Minor to Moderate

`src/safe-exec.js` exports `grepSearchAsync` and `curlFetchAsync`:

* `src/safe-exec.js:345-383`
* `src/safe-exec.js:438-439`

The source search found tests and test plan references, but no current application call sites.

Impact:

This looks like legacy helper API retained mostly for tests. Keeping unused helpers expands review and maintenance surface.

Recommendation:

If unused by product code, either remove these helpers and their tests or move them to a test-only fixture/helper module.

### 19\. Task API Validation and Domain Rules Are Split Across Layers

Severity: Moderate

Task validation exists partly in routes and partly in db methods.

Examples:

* `src/routes.js:1655-1668` validates task create input and repo-backed issue requirement.
* `src/routes.js:1709-1723` applies task update operations.
* `src/db.js:574-590` validates status transitions.
* `src/db.js:596-605` validates archive rules.
* `src/db.js:634-653` validates reparenting.

Impact:

The domain model is split between transport and persistence. MCP paths can diverge from HTTP paths unless both duplicate the same checks.

Recommendation:

Create `task-service.js` as the authoritative domain boundary. Routes and MCP should call:

* `createTask`
* `updateTask`
* `moveTask`
* `archiveTask`
* `setTaskStatus`
* `buildTaskTree`

### 20\. Session Parsing and Discovery Should Be Shared Across Features

Severity: Moderate

Session parsing/discovery logic exists in multiple places:

* `src/session-utils.js`
* `src/session-resolver.js`
* `src/qdrant-sync.js`
* `src/routes.js` non-Claude metadata matching
* `src/safe-exec.js` resume argument construction

Impact:

Each feature can interpret CLI session state differently. The Gemini JSONL inconsistency is one concrete example.

Recommendation:

Create a small session identity/discovery subsystem:

* `sessions/claude-store.js`
* `sessions/gemini-store.js`
* `sessions/codex-store.js`
* `sessions/session-identity-service.js`

Make routes, summary, token usage, vector sync, and resume behavior use the same resolver.

## Standards Alignment Review

### REQ-001 Base Engineering

Observed gaps:

* Async I/O requirement is not met in all async paths.
* Functions/modules are not consistently small or focused.
* Some runtime constants remain in code.
* Structured logging is mostly used, but dead/legacy code still uses console.
* README compliance claims overstate current implementation.

### STD-004 Code Standard

Observed gaps:

* Some deliverables are not cohesive artifacts because behavior is spread across route/MCP/db/UI duplicates.
* Completeness is weakened by stale docs/tests for removed or migrated features.
* Clarity is reduced by monolithic files and duplicated frontend utilities.

### STD-005 Test Code Standard

Observed gaps:

* Tests do not consistently mirror the current test plan.
* Test plan does not consistently mirror the current product.
* Stale tests assert removed task behavior.
* Removed voice behavior remains ambiguous across source, tests, and runbook notes.

## Security Appendix: Low Priority

The user explicitly stated security is the last concern, so this section is intentionally brief.

Security-related items observed during static review:

* MCP filesystem path containment should be reviewed carefully, especially prefix checks in `resolveWorkspacePath`.
* Shell-based grep usage in MCP tools should be replaced with `execFile` or native search for both correctness and safety.
* Settings and git account flows should be reviewed for accidental secret exposure.
* Token use in command arguments should be avoided where possible.
* Cookie settings and local auth behavior should be reviewed separately against deployment expectations.

These are real concerns, but they are less urgent than the current architecture, standards, and drift issues if the immediate goal is codebase quality.

## Proposed Refactor Roadmap

### Phase 1: Stop Drift

* Update README known limitations.
* Mark removed features explicitly.
* Reconcile task test plans with task v2.
* Remove or quarantine stale task tests.
* Decide whether voice is removed or supported. - user note: **voice IS removed. this is dead code**

### Phase 2: Decompose `src/routes.js`

* Create `src/routes/` and move route registration by domain.
* Start with `tasks` because it has active correctness and documentation drift.
* Move session lifecycle routes into `sessions` without changing behavior.
* Move settings, git/KB, vector, file, and health route groups into separate modules.
* Keep the original HTTP API signatures stable while extracting to reduce regression risk.
* After extraction, `src/routes.js` should only compose modules and inject dependencies.

### Phase 3: Fix Correctness Hotspots

* Fix task reparent/rank behavior atomically.
* Remove "latest" session fallback for Gemini/Codex identity.
* Align Gemini JSON/JSONL parsing across session UI and vector sync.

### Phase 4: Create Service Boundaries

* Extract `task-service`.
* Extract `session-identity-service`.
* Extract `settings-service`.
* Extract `vector-sync` submodules.
* Make MCP and HTTP routes call shared services.

### Phase 5: Split the Frontend

* Extract common API client.
* Extract task panel module.
* Extract file browser/editor module.
* Extract settings/git/vector modules.
* Replace duplicated escaping helpers with one utility module.
* Move inline generated handlers to event delegation.

### Phase 6: Standards Cleanup

* Replace sync I/O in async paths.
* Add documented exceptions for sync operations that remain.
* Centralize runtime tunables in config.
* Make README compliance claims exact and auditable.

## Cross-Review Reconciliation Addendum

This addendum incorporates the materially useful findings from `review/CLAUDE_CODE_REVIEW.md` and `review/GEMINI_CODE_REVIEW.md`. It does not replace the report above; it corrects omissions and makes the corrective action plan more concrete.

### Additional High-Priority Findings

#### A1. `/api/state` Is the Hottest Backend Path and Needs Its Own Refactor

Severity: High

Claude's review traces `/api/state` as a performance hotspot. The frontend polls state every 10 seconds, while the backend performs project iteration, session directory reads, stale reconciliation, JSONL parsing, session metadata aggregation, and Gemini/Codex discovery.

Why this matters:

* This is daily user friction, not theoretical scale concern.
* The expensive work sits on a frequently polled endpoint.
* Gemini/Codex discovery is partly cached in `routes.js`, but deeper `session-utils` paths still perform their own sync discovery and token reads.

Recommendation:

* Split `/api/state` out with the session route extraction.
* Introduce a lightweight sidebar/session-list payload that skips heavy transcript/token work.
* Fetch heavy `getSessionInfo` data only for active sessions or explicit detail views.
* Push state changes over WebSocket where practical instead of polling all metadata every 10 seconds.
* Move Gemini/Codex discovery caches into `session-utils` or a shared `session-identity-service` so all consumers share one cache.

#### A2. Claude Session File Path Encoding Is Reimplemented Incorrectly

Severity: High

Claude's review identified a concrete bug in the session resume/export path: `routes.js` re-derives the Claude project hash instead of using the canonical encoder.

Observed issue:

* `routes.js` uses a broad non-alphanumeric replacement for project hash construction.
* `safe-exec.js` has the canonical `findSessionsDir(projectPath)` implementation.
* Paths containing `.`, `~`, `+`, spaces, or other non-slash/underscore characters can resolve to the wrong session directory.

Recommendation:

* Replace route-local project hash derivation with `safe.findSessionsDir(projectPath)`.
* Add this to the session route extraction checklist because it belongs in the future `routes/sessions.js` or `session-identity-service`.

#### A3. `POST /api/sessions` Needs a Dedicated Session Creation Service

Severity: High

Both Claude and Gemini call out that session creation is too procedural and too coupled to CLI-specific behavior.

Current responsibilities include:

* Input validation.
* Project resolution.
* Existing session-file enumeration.
* Temporary session ID creation.
* Settings and tmux limit checks.
* Model/default argument resolution.
* DB session creation.
* Role seeding.
* CLI launch.
* Delayed standby hints.
* Session ID resolution.
* Event firing.

Recommendation:

Extract a `session-creation-service` or equivalent with:

* `validateCreateSessionRequest(body)`.
* `prepareTemporarySessionId(cliType)`.
* `resolveSessionLaunchConfig(project, cliType, role)`.
* `launchSession({ cliType, projectPath, role, model, tmpId })`.
* `schedulePostLaunchHints(...)`.
* `beginSessionResolution(...)`.

The route handler should become a thin orchestration layer, ideally around 20-30 lines.

#### A4. Frontend Hardcodes the GitHub Organization in Issue Picker

Severity: High

Claude's review found the issue picker derives repository identity using a hardcoded `rmdevpro/` prefix.

Impact:

* Breaks for any user or project outside that org.
* Conflicts with the workbench goal of managing arbitrary workspace repositories.
* Creates confusing issue-picker failures even when git auth is otherwise configured.

Recommendation:

* Add a backend endpoint or service method that derives repo identity from `git remote get-url origin`.
* Reuse `git-auth.js` parsing instead of reconstructing owner/repo in the browser.
* Make the issue picker consume backend-provided repo identity.

#### A5. Database Migration Strategy Is Too Ad Hoc

Severity: High to Moderate

Claude's review calls out the repeated `try/catch ALTER TABLE` pattern in `db.js`.

Impact:

* No durable record of which migrations ran.
* Ordering and partial-failure behavior are hard to reason about.
* Startup schema changes become harder to review as the schema grows.

Recommendation:

* Add a `schema_migrations` table.
* Move migrations into a numbered list of `{ id, up }` records.
* Run migrations in order inside transactions where possible.
* Keep idempotent repair/densify operations separate from structural migrations.

#### A6. Git Accounts Stored as JSON Settings Are a Data Modeling Smell

Severity: Moderate

Gemini's review highlights the JSON-stringified settings pattern for structured data such as git accounts.

Impact:

* Lost-update risk when multiple operations modify the same JSON blob.
* Harder validation.
* No relational constraints.
* Harder querying and migration.

Recommendation:

* Move git accounts to a dedicated table.
* Keep settings for scalar configuration, not structured operational records.

#### A7. Frontend UI Standards Drift: `alert`, `confirm`, and `prompt`

Severity: Moderate

Claude's review identifies primary CRUD flows still using browser-native dialogs.

Impact:

* Inconsistent UX.
* Harder automated UI interaction.
* Conflicts with the existing modal-based interaction style.

Recommendation:

* Replace `window.prompt`, `alert`, and `confirm` in primary CRUD flows with existing modal/toast patterns.
* Include this in the frontend split so UI behavior is centralized rather than scattered through `index.html`.

#### A8. Config, README, Docker, and Test-Gate Drift Should Be Treated as Standards Debt

Severity: Moderate

Claude's review adds several standards-alignment items not emphasized enough in my original report:

* README references stale or missing deployment/config material.
* `defaults.json` does not cover all keys read by code.
* `package.json` coverage gates may not match the test-plan threshold.
* `eslint.config.js` ignores `public/**`, which is where the largest source file lives.
* `.dockerignore` excludes broad asset classes such as `*.png`, which can break local Docker image assets.
* CLI package versions in Docker are unpinned.

Recommendation:

* Treat standards artifacts as part of the codebase, not peripheral docs.
* Add a "standards reconciliation" task after route/session/task cleanup.
* Decide whether frontend linting is required; if not, document why the largest file is excluded.

### Revised Corrective Action Plan

The earlier roadmap was directionally right but too generic. Based on the other reviews, the action plan should be:

#### Phase 0: Decide and Freeze Review Scope

* Confirm voice is removed and delete `src/voice.js` plus voice tests/docs references.
* Decide whether tests should be reconciled now or after route extraction.
* Keep security issues tracked but do not let them drive the first cleanup pass.

#### Phase 1: Fix Concrete Correctness Bugs

* Fix task reparent/rank ordering.
* Fix Claude session directory resolution by using `safe.findSessionsDir(projectPath)`.
* Remove hardcoded `rmdevpro/` GitHub org behavior from the issue picker.
* Stop Gemini/Codex identity from silently binding to latest/first-unclaimed sessions.

#### Phase 2: Extract `routes.js` by Domain

* Create `src/routes/index.js` as the composition point.
* Extract `routes/tasks.js` first.
* Extract `routes/sessions.js` second, including `/api/state`, session create/resume/archive/config/token/summary routes.
* Extract `routes/projects.js`, `routes/files.js`, `routes/settings.js`, `routes/git-accounts.js`, `routes/kb.js`, and `routes/health.js`.
* Keep route behavior stable during extraction; do not combine behavior changes with file moves unless a bug fix is explicitly scoped.

#### Phase 3: Extract Session Services

* Create `session-creation-service`.
* Create `session-identity-service`.
* Split CLI-specific discovery/parsing into Claude, Gemini, and Codex modules.
* Move role seeding out of routes into a seeder/strategy module.
* Move shared discovery caches below routes so `/api/state`, summaries, token usage, and qdrant sync do not duplicate scans.

#### Phase 4: Normalize Task v2

* Make task move/reparent/rank atomic.
* Move task domain rules into `task-service`.
* Update task tests and test plans to project-based task v2.
* Remove stale folder-path task assertions except for explicit migration coverage.

#### Phase 5: Reduce Event-Loop Blocking

* Replace sync I/O in MCP file/session tools with async APIs.
* Convert Gemini/Codex discovery and token extraction to async or cached background indexing.
* Stream large qdrant-sync inputs instead of reading entire large files into memory.
* Document any intentionally sync tmux/startup operations as standards exceptions.

#### Phase 6: Split the Frontend

* Extract CSS from `public/index.html`.
* Extract JS into ES modules.
* Centralize state and pending mutation handling.
* Centralize HTML escaping and DOM construction helpers.
* Replace browser-native dialogs for primary CRUD.
* Move repo/issue identity discovery to backend APIs.

#### Phase 7: Standards and Documentation Reconciliation

* Update README architecture, config, and known limitations.
* Add a numbered DB migration runner.
* Move structured operational settings such as git accounts to relational tables.
* Align `defaults.json` with all runtime config keys.
* Decide and document frontend linting.
* Align package coverage gates with test-plan requirements.
* Review Docker ignore/version pinning behavior.

### Codex Reviewer Feedback on the Corrective Action Plan

My view is that the corrective action plan is directionally right, but the ordering should be stricter. The plan should not try to fix every category of debt in parallel. It should be sequenced around dependency order and blast radius.

The preferred order is:

1. Stabilize the model of the system first. Remove dead voice code, update README/test plans for what is currently true, and decide whether task v2 is the only supported task API. Without this, later refactors are measured against stale expectations.
2. Fix concrete correctness bugs before broad refactors. The task rank/reparent bug, Claude session path encoder bug, hardcoded GitHub org, and Gemini/Codex latest-session fallback are small enough to review and prove independently.
3. Decompose `routes.js` before making the service layer too ambitious. First split `routes.js` into domain routers while preserving behavior. This reduces review surface immediately and creates natural seams for later service extraction.
4. Extract session services after route decomposition. Session creation, session identity, role seeding, and CLI-specific discovery are spread across `routes.js`, `session-utils.js`, `session-resolver.js`, `safe-exec.js`, and `qdrant-sync.js`; this should become its own focused cleanup track.
5. Treat `/api/state` as its own project. It is both an architecture issue and a performance issue. Address it after session boundaries are clearer, not as a vague part of generic async cleanup.
6. Split the frontend later. `public/index.html` is a major maintainability problem, but backend/session/task correctness is higher leverage. Frontend modularization is safer once backend APIs and task/session semantics are stable.

The key adjustment is to move route decomposition before broad async cleanup, while keeping small correctness fixes before both. Async cleanup across the whole codebase is too wide to do as one pass; it should be done per extracted domain so each change remains reviewable.

## Final Assessment

The codebase appears to have evolved quickly and accumulated working behavior faster than its boundaries, tests, and documentation were updated. The primary risk is not security; it is maintainability and correctness under continued feature growth.

The next high-leverage move is to reconcile task v2 across source, tests, and docs, then extract shared services so HTTP routes, MCP tools, and UI behavior no longer evolve independently.
