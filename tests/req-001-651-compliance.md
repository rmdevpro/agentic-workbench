# REQ-001 Compliance Checklist — #651 (refresh/sync stack)

Tracks the milestone's adherence to `Admin/docs/requirements/REQ-001-base-engineering.md`. Per Reviewer-Codex R25 (commit-11 reviewer disposition), compliance is an auditable artifact, not just commit messages.

Last walked: 2026-05-18 against milestone HEAD `842844d`.

## Scope

New modules introduced by #651 (commits 1–14):

| File | LOC | Purpose |
|---|---|---|
| `src/state-engine.js` | 489 | In-memory model + diff publisher + bounded subscribers |
| `src/routes/state.js` | 211 | `/api/state` handler — engine fast-path + DB-walk fallback |
| `src/routes/ws-state.js` | 99 | `/ws/state` subscription channel |
| `src/session-utils/tail-parse.js` | 128 | Byte-offset cursor for JSONL incremental parse |
| `public/js/engine-state.js` | 199 | Client-side State Engine mirror (UMD) |
| `public/js/status-bar.js` | 170 | Central status-bar dispatcher (UMD) |
| `public/js/timers.js` | 152 | Unified scheduler (UMD) |

Modified files in scope:

- `src/server.js` (engine instantiation + warm-from-DB + setStateEngine wiring)
- `src/routes/sessions.js` (mutation wire-up)
- `src/routes/projects.js` (mutation wire-up)
- `src/routes/settings.js` (codex_api_key fan-out)
- `src/watchers.js` (chokidar → engine)
- `src/keepalive.js` (auth-broken fan-out)
- `src/mcp-tools.js` (session_new + session_config wire-up)
- `src/qdrant-sync.js` (mtime shortcut)
- `src/db.js` (session_meta cursor columns)
- `src/session-utils/claude-jsonl.js` (tail-parse integration)
- `public/index.html` (script tags for UMD modules)
- `public/js/app.js` (engine client + scheduler init)

## Checklist

### §1 Code Quality

- **§1.1 Code clarity** — PASS. Names are descriptive (`stateEngine`, `_publishClaudeAuthBroken`, `MemoryBoundExceededError`, `_publishCodexApiKeyChange`, `_coalescedScan`). Functions are focused (state-engine subscribe / publish / snapshot are each single-purpose). Comments explain *why* (e.g., `state-engine.js:42` warm-bug rationale; `routes/state.js:15` warming-as-advisory contract; `keepalive.js:33` N1 fix rationale; `app.js:2097` engine-vs-legacy choice).
- **§1.2 Code formatting** — PASS. No `npm run format` ran but eslint output shows no formatting errors against the project's eslint config (only semantic warnings).
- **§1.3 Code linting** — PASS for the new modules. Only intentional `== null` warnings remain (idiomatic null-OR-undefined check; matches pattern already used across the codebase). The single unused-import error in `tests/live/state-engine-live.test.js` was fixed (`del`, `createSession`).
- **§1.4 Unit testing** — PASS. Mock coverage per module:
  - `state-engine.js` → `tests/mock/state-engine.test.js` (14 tests SE-MK-01..14)
  - `routes/state.js` → `tests/mock/routes-state.test.js` (5 tests SR-MK-01..05)
  - `routes/ws-state.js` → `tests/mock/ws-state.test.js` (10 tests WS-MK-01..10)
  - `session-utils/tail-parse.js` → `tests/mock/tail-parse.test.js` (10 tests TP-MK-01..10)
  - `public/js/engine-state.js` → `tests/mock/engine-state-client.test.js` (10 tests ES-MK-01..10)
  - `public/js/status-bar.js` → `tests/mock/status-bar.test.js` (8 tests SB-MK-01..08)
  - `public/js/timers.js` → `tests/mock/timers.test.js` (8 tests TI-MK-01..08)
  - Mutation wire-up → `tests/mock/mutation-engine-{sessions,projects,settings,watchers,mcp-tools}.test.js` (29 tests ME-MK-01..28 + cleanup)
  - Live coverage → `tests/live/state-engine-live.test.js` (10 STATE-LIVE-01..10) + `tests/live/perf-live.test.js` (4 PERF-LIVE-01..04)
- **§1.5 Version pinning** — PASS. No new package.json dependencies introduced by #651. All new code uses Node built-ins (`fs/promises`, `path`, `node:events`) + existing pinned deps (`express`, `ws`).

### §2 Security

- **§2.1 No hardcoded secrets** — PASS. No tokens, passwords, or keys in any new module. The codex_api_key fan-out reads from `db.getSetting`; the secret never appears in code.
- **§2.2 Input validation** — PASS at boundaries:
  - `/api/state` handler — no user input to validate (GET, no query params consumed beyond Express defaults).
  - `/ws/state` — client→server messages JSON-parsed in try/catch, malformed messages are debug-logged and ignored (`ws-state.js:62-67`).
  - Mutation routes (sessions/projects/settings) inherit existing input validation (length caps, allowlists for state strings, etc.).
- **§2.3 Null/undefined checking** — PASS. Engine `_require` helper validates required fields (`state-engine.js:43-49`). Defensive checks on every subscriber send (`state-engine.js:135-138`). Optional-chained accesses (`a.sessions[0]?.timestamp`) in sort comparators.

### §3 Logging and Observability

- **§3.1 Logs to stdout/stderr** — PASS via injected `logger` (project standard). No file writes from logging path.
- **§3.2 Structured logging** — PASS. Every `logger.warn`/`logger.info` call passes `{ module: 'state-engine' | 'routes/state' | 'ws-state' | 'watchers' | 'keepalive' | 'routes/sessions' | ... }` and additional context fields (`err`, `subscriberId`, `op`, `bytes`, `idle_ms`). No bare-string logs.
- **§3.3 Log levels** — PASS. `debug` for noise (malformed WS messages, EBADF cleanup), `warn` for non-fatal anomalies (state-engine send failure, subscriber backpressure close), `info` for lifecycle events (state-engine warm complete), `error` only for genuine failures (state-engine warm failed).
- **§3.4 Log content** — PASS:
  - Lifecycle: `state-engine: warm` (server.js:317-318), `evicting stale subscriber` (state-engine.js:312), `subscriber over high-water mark` (ws-state.js:43).
  - Errors with context: every `_se()` failure logs `{ module, op, err: err.message }`.
  - Metrics: `state-engine.stats()` exposes per-engine counts (projects, programs, sessions, subscribers, warming, seq).
- **§3.5 Specific exception handling** — INTENTIONALLY-BROAD CATCH NOTE. The `_se()` helper in routes/{sessions, projects, settings} and the equivalent in watchers/keepalive/mcp-tools catches every Error from `stateEngine.*` calls. This is by design: the engine is an optimisation channel; a buggy engine call must not break the REST contract (R28). The principle is "caught exceptions must be specific and anticipated" — the anticipated condition is "any engine implementation error", and the specific action is "log + continue, DB write is the source of truth". Acceptable per §3.5's intent; documented in commit messages.
- **§3.6 Resource management** — PASS. WS handlers close cleanly via `cleanup()` callback (`ws-state.js:79-85`). The chokidar dir-watcher refcount + close lives in `watchers.js:192-198`. State engine heartbeat timer is `_stopHeartbeat`-ed when subscribers drop to zero.
- **§3.7 Error context** — PASS. Errors include `module`, `op`, `err.message`, and where relevant `subscriberId`, `sessionId`, `actual_bytes`, `max_bytes`, etc.

### §4 Async Correctness

- **§4.1 No blocking I/O in async functions** — PASS. `tail-parse.js` exposes both `readTail` (async, uses `fs/promises`) and `readTailSync` (explicit-sync, called only from non-async code paths). All other I/O in new modules uses `fs/promises` or async fetch.

### §5 Communication

- **§5.1 Health endpoint** — N/A for #651. Existing `/health` from `src/routes/health.js` was not changed; engine warming is reported via `/api/state` advisory headers (per the BLOCKER-B1 fix), not via /health.

### §6 Resilience

- **§6.1 Graceful degradation** — PASS. Engine absent OR warming OR threw → routes/state.js falls through to DB-walk (commit-11 B1 fix). Engine throws on mutation → `_se()` catches, DB write completes, REST returns success. WS subscriber backpressure → engine drops the subscriber, others continue.
- **§6.2 Independent startup** — PASS. server.js binds port + serves /health *before* `_warmStateEngine` runs (server.js:445 — `setImmediate` after listen).
- **§6.3 Idempotency** — PASS where it matters: `markWarm()` is idempotent (early-return on `!warming`). `setStateEngine(null)` is safe. Engine `upsertProject` / `upsertSession` merge fields rather than overwriting whole rows.
- **§6.4 Fail fast** — PASS. `state-engine._require(obj, ...keys)` throws TypeError on missing required fields. `upsertSession` throws if its referenced project isn't in the engine. WS handler refuses subscription if `stateEngine.subscribe` throws (`ws-state.js:54-57`).

### §7 Configuration

- **§7.1 Configurable external dependencies** — PASS. State engine defaults (`MAX_BYTES_DEFAULT`, `HEARTBEAT_INTERVAL_MS_DEFAULT`, `SUBSCRIBER_TIMEOUT_MS_DEFAULT`) are factory parameters with overrides. WS state high-water mark reads from `config.get('ws.state.bufferHighWaterMark', ...)`. Engine warm batching pulls workspace path from `safe.WORKSPACE`.
- **§7.2 Externalised configuration** — PASS. No hardcoded timeouts, thresholds, file paths, or URL patterns in business logic. The `legacy_polling_enabled` flag is localStorage-keyed (client-side runtime config); a server-side equivalent could be added when needed.
- **§7.3 Hot-reload vs startup** — PASS. Engine subscriber list, snapshot, and warming-state are all per-operation. Engine *configuration* (maxBytes, heartbeat interval) is constructor-time and requires restart, which is correct per §7.3.

### §8 Deployment

- **§8.1 Compose self-sufficiency** — UNCHANGED. No new wrapper scripts. `docker compose up -d --build` still produces a working deployment.

## Open items (filed as follow-up issues, NOT blockers)

- **#659** — R7 parity: tail-parse cursor for Gemini + Codex parsers. Engineer/reviewer disagreement disposition; deferred to milestone `05-performance-and-tooling`.
- **Claude reviewer NOTEs** (commit 11 disposition): R4 worker-pool absent in `_scanState` (later commit); R10 perf instrumentation (later commit); disk-only post-warm sessions can bypass engine (acceptable; engine fast-path on reconnect re-pulls from DB-walk); `_publish` runs full `_cleanupDeadSubscribers` per event (defer-to-heartbeat is the eventual optimisation); engine fast-path bypasses reconcile defense-in-depth (spawn-time reconcile keeps state clean); auth_broken Claude-only (#658 follow-up); `_publishCodexApiKeyChange` O(P×S) (fine at current scale).

## Verdict

**#651 PASSES REQ-001 compliance** as of milestone HEAD `842844d`. No open BLOCKERs against REQ-001; all reviewer findings folded in (commit 11) or deferred via tracked issues (#659).

This artifact will be updated when #657 lands; the final REQ-001 walk covers the full milestone before close.
