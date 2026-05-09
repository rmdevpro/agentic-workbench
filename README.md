---
title: Agentic Workbench
emoji: 🔧
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
fullWidth: true
---

# Agentic Workbench

Web-based CLI workbench for AI coding agents. Manage Claude Code sessions, projects, and tasks from your browser.

## Quick Start

1. Click **Duplicate this Space** to create your own copy
2. Make your Space **private**
3. Add your `ANTHROPIC_API_KEY` as a Space Secret
4. Your instance is ready

## Security

Workbench auto-detects whether it's running on a public or private HF Space:

- **Public Space** — all access is blocked with a landing page. No credentials can be entered or stored.
- **Private Space** — full access. Optionally set `WORKBENCH_USER` and `WORKBENCH_PASS` as Space Secrets to add password protection.
- **Self-hosted** (docker-compose) — full access, no auth gate.

## Persistent Storage

Workbench stores all data (database, sessions, workspace) under `/data`. To persist data across Space rebuilds, enable persistent storage in your Space settings. Without it, all data is lost on every rebuild.

## Notes

- Free Spaces sleep after ~15 min of inactivity — tmux sessions will be lost on wake
- No Docker-in-Docker support (container build features are disabled)

---

## Architecture & Internals

The monolithic `server.js` is decomposed into focused modules using factory-based dependency injection:

| Module                | Responsibility                                                                   |
| --------------------- | -------------------------------------------------------------------------------- |
| `server.js`           | Wiring layer: constructs modules, injects deps, starts server                    |
| `routes.js`           | HTTP boundary: all 40+ route handlers with input validation                      |
| `watchers.js`         | Filesystem monitoring: JSONL watchers, settings sync, MCP registration           |
| `tmux-lifecycle.js`   | tmux session creation, cleanup, limit enforcement                                |
| `ws-terminal.js`      | WebSocket ↔ PTY terminal bridge with backpressure handling                       |
| `session-resolver.js` | Async temp→real session ID resolution                                            |
| `shared-state.js`     | Shared runtime state (WebSocket client map, browser count)                       |
| `db.js`               | SQLite-backed persistent storage with WAL mode                                   |
| `config.js`           | Externalized configuration with in-memory cache and hot-reload via file watchers |
| `logger.js`           | Structured JSON logging (stdout/stderr)                                          |
| `keepalive.js`        | OAuth token refresh with configurable timing (fully async)                       |

Supporting modules: `mcp-server.js`, `mcp-tools.js`, `webhooks.js`, `safe-exec.js`, `session-utils.js`, `qdrant-sync.js`.

### Dependency Graph

Factory-constructed modules receive all cross-module dependencies via injection through `server.js`. Foundational leaf modules (`db`, `logger`, `safe-exec`, `config`) are imported directly by modules that need them:

```
logger.js, shared-state.js          (leaf — no deps)
config.js                           (leaf — reads config files, caches in memory, hot-reloads via watchers)
db.js                               (leaf — SQLite)
safe-exec.js                        (leaf — child process wrappers, async tmux operations)
session-utils.js                    (imports: safe, db, config, logger)
keepalive.js                        (factory — deps: safe, config, logger; fully async token reads)
tmux-lifecycle.js                   (factory — deps: safe, logger)
session-resolver.js                 (factory — deps: tmux fns, db, safe, config, logger)
watchers.js                         (factory — deps: shared-state, db, safe, config, session-utils, logger)
ws-terminal.js                      (factory — deps: shared-state, safe, keepalive, config, logger)
                                    (receives tmux fns and watcher fns via injection)
routes.js                           (deps: db, safe, config, session-utils, keepalive, logger)
                                    (receives tmux, resolver fns via injection)
server.js                           (wiring — constructs all, injects deps, calls config.init(), starts server)
```

### Local docker-compose

For self-hosted operation:

```bash
docker compose up -d
```

Then open `http://localhost:7860`. See the **Hugging Face Spaces** section in `config/docs/sdlc/guides/workbench-deployment.md` for HF deployment.

## Configuration

All tunables are externalized in `.env` (see `.env.example` for complete list) and `config/defaults.json`:

- **Server**: `PORT`, `WORKSPACE`, `CLAUDE_HOME`, `WORKBENCH_DATA`
- **Resources**: `MAX_TMUX_SESSIONS`, `TMUX_CLEANUP_MINUTES`
- **Logging**: `LOG_LEVEL` (DEBUG, INFO, WARN, ERROR)
- **Keepalive**: `KEEPALIVE_MODE`, `KEEPALIVE_IDLE_MINUTES`, timing thresholds via config, `keepalive.queryTimeoutMs`, prompts externalized to `config/prompts/keepalive-*.md`
- **API**: File size limits, bridge timeouts (`bridge.cleanupSentMs`, `bridge.cleanupUnsentMs`), login timeouts
- **WebSocket**: Buffer watermarks, `ws.pingIntervalMs`
- **Claude**: `claude.defaultTimeoutMs` (default 120000) — used across all Claude CLI invocations
- **Session**: `session.summaryModel`, `session.summaryMaxTranscriptChars`, `session.summaryMaxMessageChars`, `session.promptInjectionDelayMs`
- **Validation**: Max lengths for project names (255), session names (255), prompts (50000), messages (100000), search queries (200), task text (1000), notes (100000)

### Config Hot-Reload

`config.js` loads `defaults.json` synchronously at startup (fail-fast on corrupt JSON per ERQ-001 §6.4) and caches in memory. A `fs.watchFile` listener asynchronously updates the cache on file changes. Prompt templates are similarly cached and watched. `config.get()` and `config.getPrompt()` never perform blocking I/O during request processing.

### Logo Variant (dev/prod safety affordance)

Six logos ship in `public/`, each in a `-light.png` (for light themes) and `-dark.png` (for dark themes) pair: canonical `logo-light.png`/`logo-dark.png`, plus warning variants `dev-light.png`/`dev-dark.png` (green, "Dev") and `prod-light.png`/`prod-dark.png` (red, "Prod"). Which pair renders is driven by the DB-backed `logo_variant` setting (values: `default`, `development`, `production`) and resolved inside `applyTheme()` in `public/index.html`. There is intentionally no UI — swap it per deployment via `PUT /api/settings` or by editing the settings row directly.

## Input Validation

All API endpoints validate inputs:

- Project names: max 255 characters
- Session names: max 255 characters
- Prompt text: max 50,000 characters
- Message content: max 100,000 characters
- Task text: max 1,000 characters
- Notes: max 100,000 characters
- OpenAI compat prompt: max 100KB
- Model parameter: validated against `/^[a-zA-Z0-9._:-]+$/`
- Session IDs: validated against `/^[a-zA-Z0-9_-]{1,64}$/` (plus `new_*` and `t_*` prefixes)
- Session state: validated against `['active', 'archived', 'hidden']`
- Search queries: max 200 characters
- Keepalive idle minutes: 1–1440
- MCP tool inputs: task_id numeric validation, session_id format validation, content length limits

## MCP Server Registration

On startup, `watchers.js` registers a Workbench MCP server in Claude's `settings.json`. Registration checks both presence and correctness of the `args` path — if the server has moved, the registration is updated. The MCP server (`mcp-server.js`) runs as a standalone subprocess spawned by Claude, providing tools via JSON-RPC over stdio.

## Health Endpoint

`GET /health` returns 200 when healthy, 503 when degraded, with per-dependency status:

```json
{ "status": "ok", "dependencies": { "db": "healthy", "workspace": "healthy", "auth": "healthy" } }
```

Auth status is informational only — it does not affect the overall healthy/degraded determination. Only `db` and `workspace` affect the HTTP status code.

## Filesystem Access

Workbench is a single-user, Docker-containerized IDE. Per AD-001, it intentionally provides full filesystem access to the user through two backend endpoints — `GET /api/browse` (directory listing) and `GET /api/file` (file content) — consumed by the vanilla `createFileTree` frontend (in `public/index.html`). No path containment checks are applied to these endpoints to support external file mounts (NFS, bind mounts) that may reside outside the workspace directory.

Plan file operations (`workbench_read_plan`, `workbench_update_plan`) do enforce path containment within `WORKBENCH_DATA/plans` using symlink-aware async validation, as these are internal data structures.

## Compliance

- **ERQ-001**: Structured JSON logging, async I/O in all async paths (keepalive fully async, quorum fully async, tmux send operations async via `tmuxSendKeysAsync`/`tmuxSendKeyAsync`, git clone async, config reads from in-memory cache), specific exception handling with context, health endpoint with dependency status, graceful degradation, externalized config (including keepalive timing/prompts, Claude timeouts, summary model, bridge cleanup timeouts, WS ping interval), pipeline verbose mode with progress logging, fail-fast on corrupt defaults.json, idempotent session resolution and MCP registration, input validation with length limits, format checks, and enum validation.
- **WPR-104**: Complete runnable artifact with no stubs. All functionality fully implemented.
- **Security**: Input length limits, model parameter sanitization, state enum validation, settings key validation, no hardcoded credentials. Full filesystem access per AD-001 design intent.

## Upgrading CLI versions (#353 [D4])

CLI versions in the Dockerfile are pinned for reproducible builds:

- `@anthropic-ai/claude-code@2.1.137`
- `@google/gemini-cli@0.41.2`
- `@openai/codex@0.130.0`

To upgrade one:

1. Edit the version in `Dockerfile` next to the `npm install -g` line.
2. Build a tagged image and deploy to **M5/dev** via `RUN-001-deployment.md` — never directly to prod.
3. Smoke the OAuth flow for the bumped CLI:
   - Open a new session in M5 with that CLI.
   - Run `/login` (Claude) or the equivalent.
   - Confirm the OAuth modal still triggers with the URL extracted (per `OAUTH-DETECTOR-A14-01` in the runbook). For Gemini/Codex follow the same OAuth flow per their respective `/login` invocation.
4. Run the full mock + live suites against M5; assert zero new regressions vs. the prior pin.
5. Only after M5 dev validation, build a prod image with the new pin and deploy to HF / production.

Rollback: revert the Dockerfile commit and rebuild — the prior pinned version is the only versioned source of truth (no global "latest" tag is used at any point).

## Known Limitations

- `node-pty.spawn()` is synchronous by design (native C++ addon). This is standard across all Node.js terminal emulators including VS Code. Documented with ERQ-001 §4.1 TODO. PTY spawn is injectable via `spawnPty` parameter for testability.
- `tmuxCreateClaude` and `tmuxCreateBash` use synchronous tmux commands internally for atomic session setup (new-session + set-option). These are sub-millisecond operations.
- `resolveCheckerSessionId` uses a mtime-based heuristic that may select the wrong JSONL under concurrent Claude processes. Impact is limited to checker session continuity loss (it restarts cleanly).

See `Issue_Log.md` for full compliance audit trail.
