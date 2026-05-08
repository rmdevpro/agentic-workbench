# Agentic Workbench — Code Review

**Reviewer:** Claude Sonnet 4.6
**Date:** 2026-05-08
**Scope:** Full codebase — 20 backend modules (~10,539 lines), 1 frontend monolith (5,908 lines), 4 scripts, infra (Dockerfile/compose/entrypoint), config, and the relationship between code and the test plan + README.
**Method:** Each source file read in full into context. Specific line citations throughout.
**Standards applied:** REQ-001 (engineering), STD-004 (code), STD-005 (test code), STD-007 (README), PROC-001 (debugging), PROC-004 (test execution).

This is a structural review of the codebase as a deliverable, not a per-bug audit. Every issue cites file and line. Severity legend at the bottom of this section, priority list at the end.

---

## Section 0 — Executive Summary

### Trust model

The Workbench is a **single-user containerized IDE**. Per AD-001 and the README, the gate (HF auth or password mode or "no gate" for self-hosted compose) is the only meaningful trust boundary. Past the gate, the user has full filesystem access, sudo inside the container, terminal access via tmux, and arbitrary CLI invocation. **There is no in-application privilege boundary between authenticated user inputs and the system.** This review treats the gate as the trust line; bugs in handlers reachable past the gate are evaluated as correctness/quality issues, not exploits, because the user can already do everything those handlers do via more direct paths.

### Most important findings

The Workbench is well-engineered in places — the auto-respawn machinery in `ws-terminal.js`, the auth-broken state machine in `keepalive.js`, the path-keyed credential model in `git-auth.js`, the coalesced-trailing-apply pattern in `qdrant-sync.js`, the atomic temp→real session handoff in `session-resolver.js` — and structurally undermaintained in others. The two largest files (`routes.js` 2,370 lines, `public/index.html` 5,908 lines) have grown past their refactor budget and are now actively painful to modify safely.

In priority order:

1. **Path-encoding mismatch — `routes.js:2165`.** `/api/sessions/:id/session` builds a sessions-dir path with a different encoder than `safe.findSessionsDir`. Project paths containing `.`, `~`, `+`, ` `, etc. produce mismatched paths; the endpoint silently returns nonexistent files. Pure correctness bug. High.
2. **Sync FS in async paths — `session-utils.js` and `session-resolver.js`.** Not isolated misuse, but the dominant pattern across both files for Gemini/Codex session reads. Every `/api/state` poll and every status-bar refresh blocks the event loop. High.
3. **`routes.js` is a 2,370-line god file.** 72 route handlers spanning 12+ domains plus inline helpers, caches, and the `_seedRole` orchestrator. Genuinely hard to maintain. High.
4. **`session-utils.js` (1,062 lines) bypasses the project's factory-DI pattern** — directly imports `db`, `safe`, `config`, `logger`. Same for `mcp-tools.js` and `qdrant-sync.js`. High (architecture).
5. **README diverges substantially from reality** — broken deployment-guide path, two undocumented modules, three documented config keys that don't exist, several undocumented config keys that do, references to deleted MCP tools (`workbench_read_plan`/`update_plan`), 40+ vs. 72 route count claim. High (documentation).
6. **Coverage gate diverges from coverage requirement.** Test plan and project memory say mock ≥85%; `package.json` configures c8 at 80% lines / 70% branches. 15-point branch gap. High.
7. **`public/index.html` is a 5,908-line single-file frontend** with ~4,800 lines of inline JavaScript in one global scope, two `escapeHtml` implementations, several `prompt()`/`alert()`/`confirm()` calls in violation of the project's own UI modal pattern. Medium.

Code-quality issues that look like security findings at first glance but aren't, given the trust model: `file_find` arg interpolation in `mcp-tools.js:166`, GraphQL query string concat in `routes.js:709-713`. Both are real bugs (Medium / correctness — see Section 8) but not exploits — the only caller is the trusted user themselves, who can already do worse via the terminal tab.

The Dockerfile, docker-compose, entrypoint, and HF-Space-shaped README frontmatter are clean. The DI factory wiring in `server.js` is clean. The DB schema migrations work but have no version tracking and are growing fragile.

### Severity Legend

- **Critical** — security issue or data loss path. Fix today.
- **High** — incorrect behavior under normal use, or REQ-001 violation in the request path.
- **Medium** — degraded behavior, fragile pattern, or maintainability burden affecting daily work.
- **Low** — polish, dead code, naming, redundant patterns.
- **Trivial** — typos, single dead variables.

---

## Section 1 — Infrastructure & Deployment

### 1.1 `Dockerfile` (78 lines)

**What it does.** Single-stage `node:22-trixie-slim` base. Installs git, curl, python3, make, g++, tmux, ssh, jq, ffmpeg, sqlite3, etc. Pulls in GitHub CLI from packages.github.com, Docker CLI 27.5.1 + compose v2.32.4 (binary downloads), Qdrant 1.17.1 (musl tarball). Installs three CLIs globally (`@anthropic-ai/claude-code`, `@google/gemini-cli`, `@openai/codex`). Renames the existing `node` user (UID 1000) to `workbench`, gives passwordless sudo, hands `/data` ownership. Runs `npm ci --omit=dev`. Two backwards-compat symlinks at `/app/mcp-server.js` and `/app/server.js` pointing into `src/`.

**Findings.**

- **L28 (medium): `npm install -g @anthropic-ai/claude-code @google/gemini-cli @openai/codex` pins nothing.** Every image rebuild pulls whatever the CLIs publish that day. The CLIs are the central abstraction the workbench depends on; an unanticipated breaking change in any of them silently lands on the next deploy. Pin to specific versions, e.g. `claude-code@0.3.x`. REQ-001 §1.5 (version pinning) explicitly applies.
- **L24 (medium): Qdrant binary URL is hardcoded to `x86_64-unknown-linux-musl`.** ARM hosts will fail at build time. Fine if all targets are x86_64 (current state), but worth a `$(uname -m)` interpolation matching the Docker pattern at L16. Document the constraint either way.
- **L43 (low, documentation): `echo 'workbench ALL=(ALL) NOPASSWD: ALL'`** grants the runtime user full root via sudo. Consistent with the single-user trust model (AD-001) and noted in the comment at L33-34 (Playwright chromium runtime libs). Worth one line in the README's Security section: "the runtime user is root-equivalent inside the container." Not an issue, just an undocumented characteristic of the deployment.
- **L16-21 (low): Docker CLI + compose-plugin install is doing two `curl | tar` operations as raw root.** Not strictly "verify checksum" per REQ-001 §2 spirit — but compose v2.32.4 is fixed, and the GitHub release URLs are HTTPS. Acceptable.
- **L58-59 (low): symlinks for backwards-compat MCP registrations** — `/app/mcp-server.js` and `/app/server.js`. Comment at L54-57 explains the migration: existing `~/.claude/.claude.json` files reference old paths. This is the kind of thing that should have a deprecation timeline; otherwise the symlinks live forever.
- **L67-71 (low): `ENV` block sets `HOME=/data`, `WORKBENCH_DATA=/data/.workbench`, `WORKSPACE=/data/workspace`, `CLAUDE_CONFIG_DIR=/data/.claude`, `PORT=7860`** — these are read by `safe-exec.js:20-22`. The Dockerfile names match what the code expects. Consistent.

**Things done well.** Single stage, deterministic apt list, GitHub CLI installed via official keyring (not curl|sh), uses `tini` as PID 1 (correct for signal handling), sudoers entry is `0440` (correct mode), workspace user reuses UID 1000 (matches volume-host conventions documented in workbench-deployment.md).

### 1.2 `docker-compose.yml` (14 lines)

Intentionally minimal. No volumes — the comment explains that per Admin/INF-003 each host supplies `/data` backing via `docker-compose.override.yml`. This matches REQ-001 §8.2. The shipped file is portable (`docker compose up --build` works locally; data is ephemeral).

No findings. Clean and consistent with the deployment model.

### 1.3 `entrypoint.sh` (106 lines)

**What it does.** Creates `/data/workspace`, `/data/.workbench`, `/data/.claude/projects` (idempotent). Seeds `/data/.claude/CLAUDE.md`, `/data/.gemini/GEMINI.md`, `/data/.codex/AGENTS.md` from `/app/config/*.md` if missing. Initializes `~/.claude/settings.json` with `skipDangerousModePermissionPrompt: true`. Runs `claude mcp add-json --scope user workbench` to register the workbench MCP server globally. Copies `config/skills/*` into `~/.claude/skills/`. Sets `hasCompletedOnboarding`, `theme: dark`, `bypassPermissionsModeAccepted`, `autoUpdates: false`, `lastOnboardingVersion` in `~/.claude/.claude.json` via inline node one-liner. Adds `/data/.local/bin` to PATH and `/data/.local/node_modules` etc. to NODE_PATH for persistent user installs. Starts Qdrant in background. `exec "$@"` for the actual server.

**Findings.**

- **L98-101 (medium): Qdrant launches in background with `&` and no health check.** If Qdrant is slow to bind :6333 (cold-start container, slow disk), the Node server starts and `qdrant-sync.js _waitForQdrant` (L1034-1040) handles the cold-start race. So this is OK as designed, but the entrypoint never logs whether Qdrant exited unexpectedly. A subsequent `docker logs` won't show Qdrant failures. Either add a watchdog or pipe Qdrant stderr through a labeled prefix.
- **L52-55 (low): Inline JSON `{"skipDangerousModePermissionPrompt":true}`** — duplicated in `watchers.js:671` (`ensureSettings`). The two paths converge on the same content but the source-of-truth is split.
- **L70-86 (low): Inline node one-liner for `.claude.json` onboarding flags.** Reasonable since the entrypoint is bash and JSON edits in bash are awkward, but it's a 16-line node script embedded as a string. Promoting it to `scripts/seed-onboarding.js` would make it lintable and testable.
- **L7-10 (trivial): `CLAUDE`, `WORK`, `WB_DATA` shell vars** are set but used inconsistently. `mkdir -p` uses them; `claude mcp add-json` later uses literal `/app/src/mcp-server.js` and `/data/.claude` is reconstructed. Minor.

**Things done well.** Idempotent throughout (`-s` not `-f` at L18, bug fix #197 documented inline). Comment at L22-33 explains the per-CLI seed paths and why the earlier "all into $CLAUDE/" was wrong (#294). The `claude mcp add-json … || true` swallow at L58 is appropriate (the in-app `registerMcpServer` retries it).

### 1.4 `.dockerignore` (12 lines)

Excludes `.git`, `node_modules`, `docs`, `test-results`, `docker-compose*.yml`, `LICENSE`, all `*.png` (with comment that `config/` prompts are needed), `README.md`, `CLAUDE_PENANCE.txt`, compaction markdown.

**Findings.**

- **L7 (high): `*.png` is excluded.** This means `public/dev-dark.png`, `public/dev-light.png`, `public/logo-dark.png`, `public/logo-light.png`, `public/prod-dark.png`, `public/prod-light.png`, `public/planlogo.png`, `public/workbench-preview.png`, `public/favicon.ico` — none of these reach the image. The README architecture section describes the dev/prod logo affordance and the gate page references `/workbench-preview.png` as its background. **If a fresh build of this Dockerfile was done today, the gate page would render with a broken background image and no logo.** Either (a) override with `!public/*.png` further down in `.dockerignore`, or (b) check whether HF deploys go through `git archive` which bypasses `.dockerignore` (per `workbench-deployment.md` they do — `git archive HEAD | tar -x -C /tmp/hf-deploy` — so HF Spaces work, but `docker compose up --build` locally would not).
- **L8 (medium): `*.txt` is excluded** — but the test fixture at `tests/fixtures/ansi-auth-url.txt` is referenced in the test plan. Live tests inside the container would fail to find it.
- **L4 (low): `test-results` is excluded** — fine, but no such directory exists in the repo. Vestigial.
- **L11-12 (low): `CLAUDE_PENANCE.txt`, `compaction-*.md`, `smart-compaction-*.md`** — exclusions for files that no longer exist (compaction was removed per the test plan revision 7.0).

### 1.5 `package.json`

**Findings.**

- **L9 (high): `c8 --lines 80 --branches 70`.** The backend test plan and project memory both stipulate ≥85% mock coverage. The branch threshold is 15 points below the stated requirement. Line threshold is also 5 points below. This is a gate failure under STD-003 §2.6.
- **L8 (medium): `"test": "node --test tests/mock/*.test.js"`** — does not invoke c8. Only `test:coverage` runs through coverage. CI/local `npm test` does not block on coverage at all. Either rename so the default gate enforces coverage, or document that mock-only is the dev-loop and `test:coverage` is the gate.
- **L10 (medium): `"test:live": "MAX_TMUX_SESSIONS=50 node --test --test-concurrency=1 tests/live/*.test.js"`** — `concurrency=1` because tmux is global state. This means live tests serialize on every machine. Acceptable but slow; future tests should design around tmux session-name uniqueness so concurrency can be raised.
- **L21 (low): `"jquery": "4.0.0"`** — jQuery 4 is current as of 2025 but jQuery is only used as a peer-dependency for `jqueryfiletree` (L22). The frontend has already replaced jqueryFileTree with a vanilla-JS tree (`public/index.html:3897`+ `createFileTree`). The dependency on jQuery is now zero-feature. Both could be removed.
- **L22 (low): `"jqueryfiletree": "2.1.4"`** — comment in `routes.js:22-25` notes the upstream connector was replaced. Same as above.
- **L24 (low): `"simple-git": "3.27.0"`** — kb-watcher uses this. Saved memory notes a `.fetch('remote')` no-op quirk in this exact version (#271 fix). Worth tracking the upstream resolution.

### 1.6 `eslint.config.js` (99 lines)

Flat config (ESLint 9). Two scope blocks: project root (Node globals) and `tests/browser/**` + `tests/helpers/**` (browser globals). Rules are minimal: `no-unused-vars` with `^_` ignore pattern, `no-undef`, `no-const-assign`, `no-dupe-args`, `no-dupe-keys`, `no-duplicate-case`, `no-unreachable`, `use-isnan`, `valid-typeof`, `no-redeclare`.

**Findings.**

- **(medium): No `no-unsafe-optional-chaining`, no `no-promise-executor-return`, no `require-atomic-updates`, no `no-unused-expressions`.** The test plan §1.2 ENG-07 lists `no-unsafe-optional-chaining` as one of the two-part null-check gates ("Automated — ESLint `no-unsafe-optional-chaining` and `no-unused-expressions` rules enabled"). The rule is not enabled. The test plan and config diverge.
- **(medium): No `eqeqeq`, no `prefer-const`, no `no-var`** — basic hygiene rules absent. The codebase uses `===` consistently in practice but nothing enforces it.
- **(low): No formatter enforcement.** Prettier is in devDependencies (L32) but never invoked from `package.json scripts`. The test plan §1.2 ENG-01 says "Run project formatter (ESLint/Prettier) → Zero formatting errors" but there's no `prettier --check` script.
- **(low): `public/**` is in `ignores` (L97).** That means the inline 4,800-line frontend script block is unlinted. Linting it would catch a meaningful share of the bugs the test plan enumerates (broken try/catch, missing await, etc.).

### 1.7 `config/defaults.json` (50 lines)

```
session.{nudgeThresholdPercent, resumeTailLines, nameMaxLength, promptInjectionDelayMs, promptMaxLength}
polling.tokenUsageIntervalMs
keepalive.{refreshPercentLow, refreshPercentHigh, fallbackIntervalMin}
tmux.{maxSessions, idleWithTabDays, idleWithoutTabDays, scanIntervalSeconds, windowWidth, windowHeight}
debug.tabSwitching
kb.{debounceMs, pullIntervalMs, commitAuthorName, commitAuthorEmail}
embeddings.providers.{huggingface, gemini, openai}.{url, model}
```

**Findings.**

- **(high): `keepalive.refreshThreshold` referenced at `keepalive.js:11` is never set in this file.** Default 0.85 always wins. Also `keepalive.checkRangeLow`/`checkRangeHigh` (L12-13) read keys that don't exist; the file has `refreshPercentLow`/`refreshPercentHigh` instead. The keepalive code reads keys that nobody writes. Either rename in keepalive.js to match defaults.json or add the keys defaults.json says are missing.
- **(high): `keepalive.queryTimeoutMs` (referenced in README L99 and read at `keepalive.js:98`)** is also not in defaults.json. Default 30000 always wins.
- **(high): `keepalive.fallbackIntervalMs` (read at `keepalive.js:14-16`)** is not in defaults.json. Code-side default `30 * 60 * 1000` always wins. defaults.json has `keepalive.fallbackIntervalMin` (a different key) — looks like a documented-but-not-wired rename.
- **(high): `keepalive.authBrokenThreshold` and `keepalive.credsWatchIntervalMs`** (`keepalive.js:20, 24`) — same story. Not in defaults.json.
- **(high): `claude.defaultTimeoutMs`** referenced in `session-utils.js:465` and README L102 is not in defaults.json. Default 120000 always wins.
- **(high): `session.summaryModel`, `session.summaryMaxTranscriptChars`, `session.summaryMaxMessageChars`** referenced in `session-utils.js:464, 408-409` and README L103 are not in defaults.json. Three more orphaned configs.
- **(high): `ws.bufferHighWaterMark`, `ws.bufferLowWaterMark`, `ws.pingIntervalMs`, `ws.scrollbackReplayLines`** referenced in `ws-terminal.js:25-27, 126` are not in defaults.json. Four more.
- **(high): `resolver.maxAttempts`, `resolver.sleepMs`** referenced in `session-resolver.js:17-18` are not in defaults.json.
- **(high): `compaction.verbose`** referenced indirectly (test plan ENG-11) — not in defaults.json. Compaction was removed but the test gate still references it.

In aggregate: the `defaults.json` file describes a fraction of what the code reads. Every `config.get(key, fallback)` call in the codebase has a fallback, so the missing keys aren't crashes — but the externalization promised by REQ-001 §7.2 is implicit, with the code-side default winning by default. Either move every config-read to defaults.json or document explicitly which keys are intentional code-side defaults.

---

## Section 2 — Backend modules (per-file)

### 2.1 `src/server.js` (435 lines) — wiring layer

**What it does.** Constructs every module, injects deps, sets up the auth gate, registers routes, runs the startup sequence, handles WebSocket upgrades.

**Module construction (L53-96):** clean factory composition. `createKeepalive`, `createTmuxLifecycle`, `createSessionResolver`, `createWatchers`, `createKbWatcher`, `createWsTerminal` all take explicit dependency objects. The order is correct (leaf modules first). This is the strongest part of the file.

**Findings.**

- **L29 (low): `parseInt(process.env.PORT, 10) || 3000`.** PORT is set to 7860 in the Dockerfile (L71) and in compose. The 3000 fallback is a leftover from before the HF Space convention. Fine but stale.
- **L36-49 (good): `uncaughtException` and `unhandledRejection` handlers** with structured logging and process exit on uncaught. Stack truncated to 500 chars (L40) — reasonable for production, debatable for development. Worth a env-flag for full traces.
- **L113-114 (low): `GATE_USER`/`GATE_PASS` snapshotted at module load.** If the container is restarted, fine; but if Space Secrets change at runtime (HF supports this without restart), the gate continues using the old values. Move into `detectAuthMode` or read fresh per request.
- **L116-135 (medium): `detectAuthMode` polling on a 5-minute interval (L262).** Fine for HF. But: the function uses `try { fetch } catch { authMode = 'template' }` (L130-132). If the HF API is briefly down, the workbench transitions to template mode (locks out everyone). This is documented as "fail safe: assume public" — but for a `password` mode Space (which is gated even when HF API is down), this would be a denial-of-service. Better: cache the previous determination on transient failure, fail open only if there's no prior known state.
- **L143-149 (medium): `serveGatePage` uses `fs.readFileSync`** in the request path. Cache at module load instead. Same issue surfaced earlier.
- **L150-181 (good): auth middleware structure is correct.** Health endpoints are bypassed; gate assets are bypassed; password mode checks the cookie; default falls through to gate page. Clean.
- **L154-162 (medium): `app.post('/api/gate/login')` has no rate limiting.** The cookie-issuing endpoint accepts unlimited password attempts. For a single-user container this is acceptable; if anyone deploys this behind public traffic without password rotation, this is brute-forceable. Add a simple per-IP token bucket or a fixed-delay on failure (`await sleep(500)` before responding 401).
- **L156: `crypto.randomBytes(32)`** — good. 256-bit session tokens.
- **L158: cookie has `httpOnly`, `sameSite: 'lax'`, but no `secure` flag.** OK on HF (forced HTTPS); not OK on self-hosted HTTP. Set `secure: process.env.NODE_ENV !== 'development'` or detect the original protocol via `X-Forwarded-Proto`.
- **L223-226 (good): WebSocket upgrade gate.** Template mode destroys the socket, password mode validates the cookie, then matches `/ws/(.+)` and hands off. Tight.
- **L255-434 (high, structural): the entire startup sequence lives inside `(async () => {})()`** with the bulk inside the `server.listen(...)` callback. The callback runs:
  - 11 fire-and-forget `.catch()` chains for post-startup registrations (L302-363).
  - Inline API-key seeding from DB into `process.env` (L284-300).
  - Inline KB clone via `fsStat(KB_PATH).catch(async () => { … git clone … })` (L379-395).
  - Inline KB sync poller setup (L398-424) — 27-line closure with its own `_kbSyncTimer` state.
  - This is a reasonable sequence at first sight, but it's three responsibilities tangled into one place (registrations, env hydration, KB lifecycle). The KB clone and sync poller belong inside `kb-watcher.js`. The env hydration belongs near `watchers` (it parallels what registerCodexProvider/registerCodexAuth do).
- **L283-300 (high): API-key load from DB into `process.env` is wrapped in try/catch but each individual JSON.parse has its own empty `catch {}`** (L288, L292, L296). If any of these is corrupt JSON, the raw stringified value lands in env. A subsequent `tmuxCreateCLI` exports `OPENAI_API_KEY="\"sk-..\""` (with literal quotes) and the CLI rejects it. Worth a single `safeJsonParse(value, raw)` helper plus an explicit warn log on corruption.
- **L380 (medium): KB clone URL default is hardcoded** as `'"https://github.com/rmdevpro/workbench-kb"'` — a JSON-encoded string that's then JSON.parsed. Same value appears in `routes.js:611, 1779`, `kb-watcher.js:26`, frontend `index.html:745`. At minimum this should be a single constant.
- **L390 (low): `git remote add upstream … .catch(() => {})`** — silent swallow. The comment says "Always set up upstream pointing at the public KB" — but if `add` fails because upstream already exists, that's expected; if it fails for any other reason (no permission, disk full), it's silently ignored. A `code === 'ALREADY_EXISTS'`-style discriminator would be more correct.
- **L401-403 (medium): `parseInt(JSON.parse(rawInterval), 10)` for `kb_sync_interval_minutes`** with `try/catch { minutes = 5 }`. Three layers of fallback (no setting → default '5'; corrupt JSON → 5; non-positive → 5). The `JSON.parse` of a numeric string is identity — except the user might literally set `5` (parses fine) or `"5"` (parses to "5", then parseInt is fine) or `"five"` (parses fine, then parseInt → NaN → 5). Robust but a sign of unclear data shape: `kb_sync_interval_minutes` is sometimes a number, sometimes a JSON-stringified number. Pick one.
- **L262: `setInterval(detectAuthMode, 5*60*1000).unref()`** — `unref` correctly applied. Good.
- **L416-417 (good): `git fetch origin` and `git merge --ff-only` use `gitAuth.gitAuthArgs` for the fetch.** Auth via extraheader, never embedded in the URL. Correct.

**Things done well.** The module wiring is exemplary. Every dependency is named, no hidden imports for cross-module communication, the dependency graph in the README at L65-79 actually matches what the code does.

### 2.2 `src/db.js` (799 lines) — SQLite wrapper

**What it does.** Opens better-sqlite3 with WAL + foreign keys, runs idempotent ALTER migrations, defines the schema with `CREATE TABLE IF NOT EXISTS`, runs a data-migration IIFE for `tasks` v2, defines ~60 prepared statements, exports a flat function API.

**Findings.**

- **L14-97 (high, structural): 20+ try/catch ALTER blocks at the top.** Migration-by-exception. This works but:
  - No version tracking. Cannot tell which migration ran when.
  - Order-dependent. The `programs` ALTER at L87 references a table created later in the `db.exec(CREATE TABLE IF NOT EXISTS ...)` block (L100); on a fresh DB, the ALTER fails silently because the table doesn't exist, then the CREATE runs and creates it correctly with the FK already inline. Fragile.
  - The migrations cannot be tested in isolation. If the next migration depends on a specific column type or default, you have no way to assert the prior state.
  - Adding a new migration is "another try/catch ALTER" forever.
  - **Fix:** introduce a `schema_migrations` table and a numbered array `[{ id: 1, up(db) {...} }, …]`. ~30 lines. Deferred indefinitely, this becomes harder.
- **L236-269 (medium): `migrateTasksToProjectBased` IIFE runs every boot.** The backfill at L238-254 is correctly gated on `needsBackfill > 0`, but the rank-densify pass at L259-269 runs unconditionally:
  ```js
  const buckets = db.prepare("SELECT DISTINCT project_id, COALESCE(parent_task_id, 0) AS pti FROM tasks WHERE project_id IS NOT NULL").all();
  for (const b of buckets) {
    const rows = getBucket.all(b.project_id, b.pti);
    let r = 1;
    for (const row of rows) {
      if (row.rank !== r) setRank.run(r, row.id);
      r++;
    }
  }
  ```
  Iterates every task in every bucket on every startup. If task ranks are already dense, `if (row.rank !== r)` never fires, so no UPDATEs land — but the SELECTs still run. With a small task table this is irrelevant; with thousands of tasks it's a measurable startup penalty. Gate behind `needsBackfill > 0` or a `rank_dense_at` settings flag.
- **L257 (low): `try { db.prepare(...).run() } catch (_e) { /* tasks table not yet created */ }`.** The CREATE TABLE block above runs first, so this catch is never hit on a fresh DB. The catch comment is misleading.
- **L666 (medium): `reparentTask` creates a fresh prepared statement inside the transaction:**
  ```js
  const setProj = db.prepare("UPDATE tasks SET project_id = ?, updated_at = datetime('now') WHERE id = ?");
  for (const d of desc) setProj.run(newProjectId, d);
  ```
  Bypasses the `stmts.*` cache, allocates a new prepared statement each call. Move into `stmts` at module scope.
- **L640-641 (low): `module.exports.collectDescendants(id)`** self-reference. Unusual pattern — `collectDescendants` exists in the same module. Either name the function locally and call it directly, or call via `this`/closure. The exports-self-reference makes refactoring fragile.
- **L789-791 (low): `queryLogs` interpolates `lim` into the SQL string** with `LIMIT ${lim}`. The clamp at L790 (1..5000) prevents injection, but better practice is `db.prepare(... LIMIT ?).all(...params, lim)`. The current pattern works because `lim` is computed from `parseInt`, but it's a smell — every dynamic LIMIT in SQLite is a candidate for the bind-param path.
- **L726-732 (medium): `getSetting(key, defaultValue=null)` returns the raw stored value** — but most callers immediately `JSON.parse` the result with their own try/catch. The function name suggests "get me the value"; the actual contract is "get me the raw JSON-stringified value." Either return parsed values uniformly (with a type-aware fallback) or rename to `getSettingRaw`. The current shape causes consumers to repeat the same parse-with-fallback dance everywhere — server.js:288, 292, 296; routes.js:611, 1300, 1878, 2024; qdrant-sync.js:42; webhooks.js:11.
- **L733-748 (good): `getAllSettings` does centralize the parse logic** — but with a different fallback (`row.value` raw on SyntaxError). The two patterns coexist.
- **L573-595 (good): `setTaskStatus` validates the status enum, validates the "no open subtasks" precondition, throws typed errors with `e.code`.** Clean.
- **L596-607 (good): `setTaskArchived` validates that status is terminal before archiving.** Clean domain logic.
- **L634-676 (good): `reparentTask` validates cycles via `collectDescendants`, validates parent exists, validates project_id consistency, transactionally moves + densifies + cascades.** This is the most carefully-written piece of the file.

**Things done well.** Prepared statements throughout. Transactions for multi-step writes (`reparentTask`, `setTaskRank`, `deleteTask`). Domain validation in the right place (DB layer for invariants, route layer for shape). Clear separation between schema setup and runtime API.

### 2.3 `src/routes.js` (2,370 lines, 72 routes) — HTTP layer

**Structural verdict.** This is the file that most needs refactoring. It contains:

- **Local helpers (L186-457):** `_lockedAppend`, `checkAuthStatus`, `_trustDirLock`, `trustDir`, `reconcileStaleSessionsForProject`, plus several closures.
- **In-closure caches (L340-372, L689-690):** `_geminiSessionsCache`, `_codexSessionsCache`, `_claimedGemini`, `_claimedCodex`, `_resetClaims`, `_issuesCache`.
- **Constants (L27-37):** `SESSION_ID_PATTERN`, `PROJECT_NAME_MAX_LEN`, `SESSION_NAME_MAX_LEN`, `PROMPT_MAX_LEN`, `MESSAGE_CONTENT_MAX_LEN`, `SEARCH_QUERY_MAX_LEN`, `TASK_TITLE_MAX_LEN`, `TASK_DESC_MAX_LEN`, `TASK_FOLDER_MAX_LEN`, `NOTES_MAX_LEN`, `VALID_STATES`. Some are duplicated or partially shadowed in `mcp-tools.js`.
- **`_seedRole` (L71-157):** 87-line top-level helper with inline `require()` calls for six modules. Hardcoded for three CLIs; nearly-identical branches differ only in CLI binary, snapshot helper, and id-extraction regex.
- **`buildSessionList` (L459-493):** Aggregates DB sessions + file metadata + tmux active state. The `_getNonClaudeMetadata` pre-pass (L464-469) runs the ordering heuristic before `getSessionInfo` is called per-session.
- **`buildProjectTaskTree` (L1589-1646):** Group → Project → Tasks tree builder.
- **72 route handlers** spanning sessions, projects, programs, files, KB, git accounts, auth, tasks, settings, logs, qdrant, claude-md, mcp-servers, search, summary, tokens, terminals, send_text/key, mkdir, upload.

**Findings.**

- **(high, architecture): split this file by domain.** Proposal:
  - `routes/sessions.js` — `/api/sessions*`, `/api/terminals`, `/api/state`, `/api/search`, `/api/sessions/:id/{summary,tokens,session,restart,send_text,send_key,resume,name,config,archive}` (~700 LOC).
  - `routes/projects.js` — `/api/projects*`, `/api/programs*`, `/api/projects/:name/{config,program,claude-md,remove}` (~250 LOC).
  - `routes/files.js` — `/api/browse`, `/api/file*`, `/api/file-raw`, `/api/file-new`, `/api/rename`, `/api/move`, `/api/files/list`, `/api/mkdir`, `/api/upload` (~250 LOC).
  - `routes/kb.js` — `/api/kb/*`, KB account lookup helpers (~200 LOC + the existing kb-watcher reference).
  - `routes/tasks.js` — `/api/tasks*`, `/api/tasks/:id/comments`, `buildProjectTaskTree`, `_projectHasRepoPath` (~250 LOC).
  - `routes/git-accounts.js` — `/api/git-accounts*`, `/api/issues` (~150 LOC).
  - `routes/settings.js` — `/api/settings`, `/api/cli-credentials`, `/api/mcp-servers`, `/api/qdrant/*` (~250 LOC).
  - `routes/auth.js` — `/api/auth/*`, `/api/keepalive/*`, `/api/logs*` (~150 LOC).
  - `routes/health.js` — `/health`, `/api/health` (~30 LOC).
  - `routes/index.js` — composes them via `registerCoreRoutes(app, deps)` calling each domain's factory.
  Each domain registers via the same `registerRoutes(app, deps)` factory pattern. `routes.js` becomes a one-page composition.
- **L71-157 (high): `_seedRole` belongs elsewhere.** It re-`require()`s `child_process`, `util`, `fs/promises`, `path`, `safe-exec`, `session-utils` inside its body (L72-76, L111, L121, L139, L154). 157 lines, three nearly-identical branches. Move to `src/session-seeder.js` with a per-CLI strategy:
  ```js
  const seeders = {
    claude: { phase1: claudePhase1, resume: claudeResume },
    gemini: { phase1: geminiPhase1, resume: geminiResume },
    codex:  { phase1: codexPhase1, resume: codexResume },
  };
  ```
  Tests can then exercise each branch in isolation.
- **L709-713 (medium, correctness): GraphQL query string concatenation.**
  ```js
  const query = `query { repository(owner: "${owner}", name: "${name}") {
    issues(states: ${stateFilter}, ...) { ... }
  } }`;
  ```
  `owner` and `name` come from `req.query.repo` after the regex `/^([^/]+)\/([^/]+)$/`. The regex permits `"`. A repo name containing `"` produces malformed GraphQL and the call fails with a confusing error. Not an exploit — the user is sending the query with their own token to their own GitHub account; they could send the same malicious query directly to GitHub. But it's a real bug for any legitimate repo name with unusual characters. Fix uses GraphQL variables:
  ```js
  const query = `query($o:String!, $n:String!) { repository(owner:$o, name:$n) { issues(states: ${stateFilter}, ...) { ... } } }`;
  body: JSON.stringify({ query, variables: { o: owner, n: name } })
  ```
  `stateFilter` is locally constructed from a whitelist (L708) so that part is fine.
- **L715 (medium): `'https://api.github.com/graphql'` is hardcoded.** GitHub Enterprise instances use different API hosts. The credential model in `git-auth.js` already keys by path (`github.com/owner` or `enterprise.example.com/owner`); the API host should derive from the same path. Today, an account configured for an enterprise host would store the token but every request to /api/issues would hit api.github.com and fail.
- **L425, L450 (medium): `catch { /* race ok */ }`.** Two empty catches in `_getNonClaudeMetadata`. The comment explains intent — `setCliSessionId` is racing the resolver — but a debug log would still help diagnose churn ("setCliSessionId raced; another writer set it first"). Race conditions are exactly the bugs that show up under concurrency.
- **L376-403 (medium): `_matchFromList` order-based fallback is silent.** Strategy is (1) match by `cli_session_id`, (2) match by creation timestamp ±60s, (3) take the first unclaimed disk session. Strategy 3 silently associates the workbench session with whatever disk session happens to be first. With a CLI session created externally (user runs `gemini` from a terminal directly), this misassigns. `logger.warn('Order-based fallback used', { sessionId, cliType })` would make this diagnosable.
- **L795-820 (low, AD-001 design): `/api/browse` with no path containment.** Intentional per AD-001. Single-user trust model. Symlink-following at L805-812 reaches anywhere the runtime user can read; that's the design. No issue.
- **L1003-1013 (low): `/api/projects/:name/remove` does `db.deleteProject` and returns** — but doesn't kill any running tmux sessions for the project, doesn't clean up session JSONLs, doesn't unregister project-scoped MCP. Cascading the cleanup explicitly would prevent orphan resources.
- **L1043-1066 (medium): `/api/programs/:id` PUT with `name` validates against `getProgramByName(clean)`** but doesn't use a transaction. A concurrent rename to the same name would race — both PUTs would see no duplicate and one would land violating the unique constraint, returning 500 instead of 409. Wrap the check + update in a transaction.
- **L1101-1110 (medium): `/api/auth/login` runs `claude --print 'test'` with a 10s timeout** to test auth. This actually issues a real Claude API call ("test") on every login attempt. Burns tokens and produces a synthetic interaction in the user's history. A lighter check (read-only verification of `~/.claude/.credentials.json`) is what `checkAuthStatus` already does.
- **L1135-1222 (high, performance): `/api/state` is the hottest endpoint** and does:
  1. `db.getProjects()` — sync, fast.
  2. For each project: `await stat(projectPath)` — async, fast.
  3. `await reconcileStaleSessionsForProject(...)` — reads sessions dir, may rename tmux sessions.
  4. `await readdir(sessDir)` — async, fast.
  5. For each `.jsonl` file: `await sessionUtils.parseSessionFile(...)` — async (with cache).
  6. `await buildSessionList(dbSessions, sessDir)` — runs disambiguation pre-pass (calls `_getNonClaudeMetadata` per session, which calls `_getGeminiSessions`/`_getCodexSessions`, which sync-walk Gemini/Codex disk if cache is cold).
  Steps 5 and 6 cumulatively re-read disk for each session in each project on every poll. The frontend polls /api/state every 10s (`REFRESH_MS` at index.html L1153). With N projects and M sessions, this is N+M+G+C disk operations per 10s where G and C are total Gemini and Codex session files in `~/.gemini/tmp` and `~/.codex/sessions`. Memory note "M5 /api/state is 5-7s" confirms this in production. The `_sessionInfoCache` (TTL 2s, session-utils.js:901) helps but isn't enough — the keying by `${sessionId}:${includeTokens}` doubles the entries (sidebar wants no-tokens, status bar wants tokens).
- **L1244-1368 (high): `/api/sessions` POST is doing too much in one handler.** It validates input (L1247-1259), resolves project (L1261-1269), enumerates existing JSONL files (L1271-1283), generates a temp ID (L1287-1289), runs `ensureSettings` and `enforceTmuxLimit` (L1292-1293), parses default model from settings (L1297-1308), upserts session (L1311-1318), invokes `_seedRole` if role is set (L1321-1330) or launches plain (L1331-1333), schedules a delayed `tmuxSendKeysAsync` "standby hint" (L1346-1358), starts `resolveSessionId` (L1361), fires webhook event (L1362). The function is 124 lines, stateful, mixes I/O and side-effect ordering, and has a non-trivial timing dependency (`promptDelayMs`). A natural decomposition:
  - `validateCreateSessionRequest(body)` → throws or returns clean params.
  - `prepareSessionTmpId(cliType)` → returns `tmpId`.
  - `launchSessionTmux({ cliType, role, projectPath, … })` → returns `tmux`.
  - `scheduleSessionPostStart({ cliType, tmux, sessionName })` → fires the standby hint.
  - The handler is ~20 lines composing them.
- **L1284-1289 (low): `tmpId` generation differs per CLI.** Claude gets `new_${Date.now()}` (the resolver looks for these); non-Claude get `crypto.randomUUID()`. The Claude format includes a millisecond timestamp; under rapid creation, two identical timestamps collide. Fix: append a short random suffix even for Claude (the MCP-tool path already does this — `mcp-tools.js:213`).
- **L1346-1358 (medium): the standby-hint setTimeout is fire-and-forget.** If the timer fires after the user closes the tab and the session goes into idle cleanup, the hint lands in a dead session. Also there's no try/catch around the `setTimeout` callback's promise; if `tmuxSendKeysAsync` rejects, the only path is the `.catch` at L1356 which logs but does not surface. Acceptable but worth a comment.
- **L1402-1444 (good): `/api/sessions/:sessionId/resume`** correctly uses `safe.buildResumeArgs` (the canonical resume-args builder), refuses to spawn if the JSONL is missing, returns 410 with the expected path. Tight.
- **L1474-1495 (low): rename appends a JSONL summary entry on best-effort.** Fine, but `appendFile` racing the JSONL writer (Claude, when active) could interleave bytes mid-line. The lock at L186-204 is for plan files only, not session JSONL. Real conflict here would be rare but possible.
- **L1574-1584 (medium): `_projectHasRepoPath`** uses sync `fs.existsSync` walking up the directory tree, called from the synchronous `buildProjectTaskTree`. Reasonable as a single-pass check, but inside an HTTP handler that fires on every task-tree refresh. Cache the result per project (it's stable: a project either is or isn't inside a repo).
- **L1758-1781 (low): `GET /api/settings` constructs the defaults object inline** (L1760-1779). 22 hardcoded settings that don't appear in `defaults.json`. This is the actual source of truth for per-key defaults — but it's invisible to anyone reading `defaults.json` to understand configurability. Consider moving into a `default_settings.json` and merging.
- **L1817-1820 (good): `VALIDATED_KEYS`** — synchronous validation of provider/key changes before persisting. Good pattern.
- **L1820-1832 (medium): the validation inside the PUT handler awaits `qdrant.validateProviderConfig` with an 8-second timeout** (qdrant-sync.js:361) — meaning the user's "save" click can hang up to 8 seconds before getting a response. UX-wise: optimistic save with async re-validation, surfacing failure via toast.
- **L1869-1875 (medium): `keepalive_mode` change** calls `keepalive.setMode(value, parseInt(idleMins, 10))` where `idleMins` is the raw string from DB. The value should be JSON.parsed (it's stored as JSON-encoded). If the user previously saved `30`, `db.getSetting` returns `'30'` (the raw string), `parseInt('30')` works. If they saved `"30"` (string), `db.getSetting` returns `'"30"'`, `parseInt('"30"')` returns NaN. Same parse-with-fallback issue.
- **L1907-1935 (low): `/api/cli-credentials`** detects credentials by checking env vars + DB settings + filesystem. Three sources, three parallel checks. The result is a boolean per CLI. This logic is duplicated in the frontend at index.html:1421-1428. Move to a shared helper in `safe-exec.js` or `session-utils.js`.
- **L2058-2091 (medium): `/api/mcp-servers` GET/PUT** writes directly to `~/.claude/settings.json`. Concurrent edits race the file. `watchers.js:202` (`registerMcpServer`) reads the same file on startup. There's no file lock between routes.js and watchers.js.
- **L2165 (high): `projectHash` encoder mismatch.**
  ```js
  const projectHash = (project ? safe.resolveProjectPath(project) : '').replace(/[^a-zA-Z0-9]/g, '-');
  const sessionFile = join(CLAUDE_HOME, 'projects', projectHash, `${sessionId}.jsonl`);
  ```
  The canonical encoder is `safe-exec.js:391`: `projectPath.replace(/[\/_]/g, '-')`. For path `/data/workspace/foo.bar`:
  - `findSessionsDir` → `-data-workspace-foo.bar`
  - `routes.js:2165` → `-data-workspace-foo-bar`
  Any project name containing `.`, `~`, `+`, ` `, etc. produces a path that doesn't match the file Claude actually writes. The endpoint silently returns nonexistent paths. **Fix:** call `safe.findSessionsDir(projectPath)` instead of re-deriving.
- **L2298-2309 (low, documentation): `/api/upload` accepts up to 50 MB raw body** with no path containment (per AD-001). Fine for the trust model. Worth documenting the 50 MB limit in the README alongside the other file-size limits.
- **L2331-2360 (good): `/health` correctly distinguishes db/workspace (block 503) from auth (informational only).** Matches the README claim at L143. Solid.

### 2.4 `src/session-utils.js` (1,062 lines)

**Structural verdict.** Too large; mixes six responsibilities. Should split.

**Findings.**

- **L4-8 (high, architecture): top-level direct imports of `db`, `safe`, `config`, `logger`** — bypasses the factory-DI pattern used by every other non-leaf module. Cannot be tested with mocks without `require` cache patching.
- **L26-39 (high): `_readClaudeStatusLineState` uses `fs.readFileSync` synchronously** inside a function called from async `getSessionInfo`. The require-inline-fs (`const fs = require('fs')`) at L29 also inlines. Should be `fs.promises.readFile` and async.
- **L160-191 (high): `_searchGeminiSessions` is sync-everything.** Calls `discoverGeminiSessions()` (sync), opens `fs = require('fs')` (L164), `fs.readFileSync` (L165), `JSON.parse` per file. Called from async `searchSessions` (L304). The whole search is sync I/O.
- **L194-228 (high): `_searchCodexSessions` same pattern.** Sync `readFileSync`, sync `JSON.parse`, called from async path. Codex JSONL files can be large (rollouts accumulate); reading them sync blocks the event loop.
- **L231-310 (mixed): `searchSessions` uses async I/O for Claude (`readdir`+`readFile`) but delegates to sync helpers for Gemini and Codex.** Inconsistent.
- **L312-351 (high): `_readGeminiTranscript` uses `fs.readFileSync`** at L337, same in `_readCodexTranscript` at L381. The fall-back-to-most-recent logic at L325-332 is also a reliability concern: if `cli_session_id` matching fails, it picks "most recent" which may be a different conversation entirely.
- **L502-621 (high): `_getGeminiTokenUsage` and `_getCodexTokenUsage` use sync `readFileSync`** at L515 and L579. These are called from `getSessionInfo` (L957, L975), which is called from `/api/sessions/:id/tokens` (routes.js:2148) and from `/api/state` building (routes.js:1201) and from the WebSocket-driven token broadcast (watchers.js:42). All async paths. All sync reads.
- **L733-840 (medium): `parseGeminiChatFile` and `parseCodexRolloutFile` use sync `readFileSync`** at L736 and L794. Acceptable when called from a CLI script, problematic when called from `discoverGeminiSessions`/`discoverCodexSessions` (L861, L885) which are themselves called from async paths.
- **L845-867 (high): `discoverGeminiSessions`** sync-walks `~/.gemini/tmp/<projectHash>/chats/*.{json,jsonl}` using `fs.readdirSync` + `fs.existsSync` + per-file sync read. With many projects, this scales as O(projects × chats). Called from multiple paths.
- **L872-893 (high): `discoverCodexSessions`** sync-recursively walks `~/.codex/sessions/YYYY/MM/DD/*.jsonl` with `fs.readdirSync` (L880). On a daily-rollover schema, this grows monotonically; one workbench user with months of Codex usage has hundreds of files.
- **L900-902 (medium): `_sessionInfoCache` keyed by `${sessionId}:${includeTokens}`** doubles the cache entries. Sidebar (no tokens) and status bar (with tokens) cause two separate disk-read paths even though the no-tokens projection is a strict subset of the with-tokens result. Better: cache the full info, return projections to callers.
- **L912-1045 (mixed): `getSessionInfo`** is the unified per-session metadata aggregator. The Claude branch uses async `parseSessionFile` (good); the Gemini/Codex branches use sync `discoverGeminiSessions`/`discoverCodexSessions` and sync `_getGeminiTokenUsage`/`_getCodexTokenUsage` (bad). The merge of live-statusline data at L985-1012 is well-thought-out (`current_usage` can be number or object; the code handles both, with a fallback to `total_input_tokens`).
- **L987-1011 (good): `_readClaudeStatusLineState` integration** correctly prefers the CLI's plan-effective `context_window_size` over the JSONL's stale snapshot. Matches the design described in the comment block (#286).
- **L66-96 (medium): `parseSessionFile` JSONL parsing** swallows JSON.parse SyntaxErrors silently with a debug log only on non-SyntaxError parse failures. Fine for active session writes (the last line may be truncated mid-write), but with hundreds of lines per session it's worth tracking malformed-line counts to catch bugs in JSONL emission.
- **L130-158 (good): `extractMessageText`, `_extractGeminiMessageText`, `_extractCodexMessageText`** correctly handle the per-CLI content shapes (string, array of blocks, object with type+text). Clean.
- **L897-902 (medium): cache invalidation is via `invalidateSessionInfoCache(sessionId)` called from rename/config endpoints.** Good. But the cache TTL of 2s plus the lack of cache-key sharing between callers means cache hit rate is lower than the design intends.
- **L460-475 (good): the `summarizeSession` LLM call timeout uses `claude.defaultTimeoutMs` from config** (with code-side fallback 120000). Recovery on failure (L476-490) returns the raw recent messages plus the error in `summary` — graceful degradation.

**Recommended split:**
- `session-utils/claude-jsonl.js` — `parseSessionFile`, `getTokenUsage(claude)`, `getSessionSlug`.
- `session-utils/gemini.js` — `discoverGeminiSessions`, `_searchGeminiSessions`, `_readGeminiTranscript`, `_getGeminiTokenUsage`, `parseGeminiChatFile`.
- `session-utils/codex.js` — same shape as gemini.js.
- `session-utils/info.js` — `getSessionInfo`, `_sessionInfoCache`, `invalidateSessionInfoCache`.
- `session-utils/search.js` — `searchSessions`, `summarizeSession`.
- `session-utils/index.js` — factory exporting the union with `db`, `safe`, `config`, `logger` injected.

### 2.5 `src/session-resolver.js` (337 lines)

**What it does.** Two responsibilities: (1) resolve a Claude `new_*` temp ID to its real UUID by polling for the JSONL to appear (`resolveSessionId`), and (2) discover Gemini/Codex internal session IDs by polling the per-CLI session files (`discoverCliSessionId`).

**Findings.**

- **L36-99 (good): `resolveSessionId` polling loop** with bounded attempts, sleep between, atomic transaction for the temp→real swap (L54-62). Clean.
- **L51-53 (good): "wrap insert(real) + metadata copies + delete(temp) in a single transaction so /api/state can never observe both rows simultaneously".** This was the fix for the duplicate-session bug; the comment explains the rationale.
- **L123-203 (good): `resolveStaleNewSessions`** runs on startup to clean up orphaned `new_*` rows from prior crashes. Same atomic-handoff pattern.
- **L209-329 (high): `discoverCliSessionId`** uses sync `readdirSync`, `existsSync`, `readFileSync` throughout (L223, L228, L239, L246, L256, L268, L289). Inside an async polling loop. 60-second polling × N CLI processes = sustained sync-IO churn.
- **L296-302 (medium): inline UUID extraction regex.** Same regex appears at:
  - `routes.js:441-443` (in `_matchFromList`)
  - `routes.js:1505` (codex resume path matching)
  - `watchers.js:88-89` (codex session file resolution)
  - `session-utils.js:962-964` (`getSessionInfo` codex branch)
  - `session-utils.js:560-562` (`_getCodexTokenUsage`)
  - `session-utils.js:365-367` (`_readCodexTranscript`)
  Six copies. Move into `safe-exec.js` as `extractCodexUuid(filename)`.
- **L20-30 (good): `pendingResolutions` Map** dedups concurrent calls for the same `tmpId`. Clean.
- **L17-18 (medium): `resolver.maxAttempts` and `resolver.sleepMs` config keys** read with defaults but not in `defaults.json`. The fallback (30 attempts × 2s) always wins.
- **L123-152 (medium): when `sessionsDir` doesn't exist (ENOENT), every stale `new_*` is cleaned up.** Correct for a never-used project. But a transient ENOENT during a chmod or remount would also wipe legitimate temp sessions. Distinguish "directory definitely doesn't exist" vs "couldn't read directory due to transient error."

### 2.6 `src/safe-exec.js` (441 lines)

**What it does.** Wraps tmux + execFile + process spawning. Defines `WORKSPACE`, `CLAUDE_HOME`, `HOME` constants. Core helpers: `tmuxNameFor`, `shellEscape`, `tmuxExecSync` (internal), `tmuxExecAsync`, `tmuxExists`, `tmuxKill`, `buildResumeArgs`, `tmuxCreateCLI`, `tmuxSendKeysAsync`, `tmuxSendTextAsync`, `tmuxSendKeyAsync`, `gitCloneAsync`, `grepSearchAsync`, `curlFetchAsync`, `findSessionsDir`, `sanitizeErrorForClient`.

**Findings.**

- **L11-18 (good): `execFileAsync` wrapper.** Manual promisify because `util.promisify` in Node 22 returns `{ stdout, stderr }` but the call sites here vary on which they want.
- **L20-22 (good): three env-derived constants with clear defaults.** Matches Dockerfile envs.
- **L35-39 (good): `tmuxNameFor`** — canonical. Single source of truth, consumed by every other module.
- **L41-43 (good): `shellEscape`** — single-quote wrapping with the standard `'\''` escape pattern. Correct.
- **L50-58 (intentional): `tmuxExecSync`** — used internally only for atomic multi-command setup (L215-227). The comment at L46-49 documents this. Acceptable as an intentional sync island.
- **L66-76 (good): `tmuxCaptureScrollback`** captures full pane history with `-e` (preserve ANSI escapes), `-J` (join wrapped lines), `-S -<lines>` (scrollback bound). The empty-string fallback on capture failure (L73) is reasonable for a non-fatal feature.
- **L113-120 (good): `tmuxExists`** uses async exec + treats any error as nonexistence. Comment at L117 explains.
- **L128-178 (good): `buildResumeArgs`** — single source of truth for resume args across explicit-resume routes and auto-respawn (ws-terminal). The Claude branch verifies the JSONL exists (L144) before allowing resume; if missing, returns `{ args: null, missing: true }`. The Gemini branch shells out to `gemini --list-sessions` and parses the index by id (L157-164). The Codex branch uses `cli_session_id` directly (L169-175).
- **L153-156 (medium): the Gemini --list-sessions parse uses inline `require('child_process')`/`require('util')`/`promisify(execFile)`.** Already imported at the top of the file (L3, L11). Use the existing `execFileAsync`.
- **L180-228 (medium): `tmuxCreateCLI` is sync-only** because tmux session creation must atomically run new-session + set-option + set-option + set-option + set-option (L215-227). Documented. The function shells in env vars (L186, L192-193, L197, L201, L205-206) by interpolating into a bash command. `shellEscape` is applied to `HOME`, `CLAUDE_HOME`, the cwd, and each CLI arg — but not to `binary` (L208). `binary` is hardcoded to one of `'claude'/'gemini'/'codex'/'bash'` from a switch, so it's safe — but if a future CLI adds a quoted name with spaces, the assumption breaks. Worth a comment.
- **L268-294 (good): `tmuxSendKeysAsync`** writes text to a tmpfile, loads into tmux buffer, pastes, sends Enter. The temp file is cleaned in a try/finally (L282-292). Correct. Same pattern in `tmuxSendTextAsync` (L302-323).
- **L334-343 (good): `gitCloneAsync`** validates URL shape (`http(s)://` or `git@`) before invoking git. 120s timeout. No extraheader injection — matches the model where projects clone via `npm`/`git` without auth (the KB clone in `kb-watcher.js` is the only KB-token path and uses `gitAuth.gitAuthArgs` correctly).
- **L345-364 (good): `grepSearchAsync`** uses execFile (not shell), bounded buffer + timeout. Falls back to "No matches found" on any error including non-zero exit.
- **L385-393 (good): `findSessionsDir`** with the explicit comment at L386-390 explaining the `[\/_]` regex (Claude encodes both / and _ to -). This is the fix that the routes.js:2165 code never picked up.
- **L405-411 (good): `sanitizeErrorForClient`** with documented regex order (L398-403) — `user:pass@` first, then bare `user@`, then query-string secrets. The `g` + `i` + `m` flags are appropriate. Multi-line errors get redaction across lines.
- **L31-39 (good): `tmuxNameFor` MD5 hashes the full session id and takes 12 chars + 4-char hash** — keeps tmux names within tmux's pane-id length limit, with deterministic disambiguation.

**Things done well.** This module is clean. The sync-vs-async split is principled and documented. The shell-escape discipline is consistent. Single source of truth for tmux naming and session resume args.

### 2.7 `src/keepalive.js` (313 lines)

**What it does.** Periodically queries Claude with a short prompt to refresh OAuth tokens. Tracks token expiry, schedules next refresh at 65-85% of remaining lifetime. Has a sophisticated auth-broken state machine that suppresses log spam after N consecutive 401s and watches the credentials file for changes to resume.

**Findings.**

- **L11 (medium): `_REFRESH_THRESHOLD = config.get('keepalive.refreshThreshold', 0.85)`** — assigned but never used. Dead variable. Probably intended for the `scheduleFromRemaining` fraction calculation, but L203 uses `CHECK_RANGE_LOW + Math.random() * (CHECK_RANGE_HIGH - CHECK_RANGE_LOW)` instead.
- **L11-24 (medium): five config keys read with code-side defaults, none in `defaults.json`.** `keepalive.refreshThreshold`, `keepalive.checkRangeLow`, `keepalive.checkRangeHigh`, `keepalive.fallbackIntervalMs`, `keepalive.authBrokenThreshold`, `keepalive.credsWatchIntervalMs`, `keepalive.queryTimeoutMs`. Same theme.
- **L42-46 (good): `isAuthBrokenError`** — broad regex covering `\b401\b`, `invalid authentication`, `invalid_api_key`, `please run /login`. Reasonable coverage of the actual error strings the CLI emits.
- **L53-72 (good): `startCredsWatch`** — polls the credentials file mtime every 60s; on change, clears auth-broken state and resumes scheduling. The comment at L21-23 explains why: bind-mounted volumes don't fire reliable inotify events.
- **L74-89 (medium): `getTokenExpiryAsync` swallows non-ENOENT/non-SyntaxError as ERROR but returns 0.** A returned 0 means "schedule a refresh now", which then fails because the credentials are bad. Consider distinguishing "couldn't read" (return null, defer) from "no credentials" (return 0, force refresh).
- **L97-148 (good): `claudeQuery` with auth-broken handling.** First successful query after auth-broken clears the suppression (L106-111). Below threshold, individual failures are still logged at ERROR (L132-136). After threshold, single WARN with the credentials mtime, then start the watch loop. This is sophisticated and well-tested code.
- **L150-178 (medium): `doRefresh` alternates between question-style and fact-style prompts** (turn 'a' vs 'b'). The prompt content comes from `config.getPrompt('keepalive-question'/'keepalive-fact')`. Workable but the alternation logic is buried inside the function. Consider externalizing the prompt rotation as a list.
- **L180-211 (good): `scheduleFromRemaining`** — random fraction within [65%, 85%] of remaining time, with `Math.max(60000, ...)` floor. Correctly stops scheduling when in auth-broken state (L185).
- **L262-309 (good): `getStatus`, `setMode`, `onBrowserConnect`, `onBrowserDisconnect`** — public API for the keepalive lifecycle. Browser-connect-aware mode (L287) starts the keepalive when the first browser connects; idle mode (L297-307) starts an idle timer when all browsers disconnect.
- **L160-167 (low): `if (q) { const a = await claudeQuery(q); if (a) logger.info(...) }`** — only logs success when both prompts succeed. If the first succeeds and the second fails, no log of the partial. Acceptable but worth knowing.

**Things done well.** This is some of the most thoughtful code in the repo. The auth-broken state machine, the file-watch resume, the fraction-based scheduling, the browser-aware lifecycle modes — all carefully implemented with clear rationale comments.

### 2.8 `src/tmux-lifecycle.js` (186 lines)

**What it does.** Periodic scan of tmux sessions, idle-timeout enforcement (different timeouts for sessions with vs. without active browser tabs), session-limit enforcement (kill oldest first), tracking active tabs.

**Findings.**

- **L19-22 (good): all knobs from config, no hardcoded defaults.** Reads `tmux.idleWithTabDays`, `tmux.idleWithoutTabDays`, `tmux.scanIntervalSeconds`, `tmux.maxSessions`. All four are in `defaults.json`. Compliant.
- **L96-99 (medium): the second pass `for (const s of sessions) { if (await safe.tmuxExists(s.name)) remaining.push(s); }`** runs `tmuxExists` (an exec) for every session in the list. With N sessions, that's N tmux invocations per scan. The previous loop already killed idle sessions; the second pass exists to confirm survivors before applying the session-limit cap. This is N extra exec calls per scan; for N=10 (the default cap) it's negligible, for N=50 (the test:live env value) it's measurable.
- **L102-113 (good): session-limit kill-oldest-first** — sorts by `lastActivity` ascending and shifts off the front. Correct.
- **L113-122 (good): catches "no server running" and treats as not-an-error.** Correct.
- **L144-159 (good): `startPeriodicScan`** with `unref()` on the interval (so it doesn't keep the process alive). Logs the configured thresholds at start. Good observability.
- **L13 (medium): `_onSessionKilled` callback registration via `setOnSessionKilled`** — but `setOnSessionKilled` (L168) is exposed but never called. Dead capability. Worth wiring or removing.

### 2.9 `src/ws-terminal.js` (304 lines)

**What it does.** Bridges WebSocket connections to tmux PTY processes. Auto-respawns dead tmux sessions when a tab tries to reconnect. Handles backpressure (high-water-mark pause/resume), heartbeat ping, scrollback replay on reconnect, control-frame parsing (resize, ping).

**Findings.**

- **L30-33 (good): `dbgTab` debug log gated on `config.get('debug.tabSwitching', false)`.** Cheap when off.
- **L35-110 (good): auto-respawn machinery.** In-flight Map keyed by `tmuxSession` (L38, L107) dedups concurrent reconnects. Prefix-collision check (L63-69) validates the prefix-derived session is the one that would derive this tmux name. Recheck-before-spawn (L73). Refuses to respawn if the JSONL is missing on disk (L80-85). 10x100ms readiness loop (L90-97). All carefully thought out.
- **L57 (medium): `tmuxSession.slice(3, 15)` extracts a 12-char prefix** — assumes `tmuxNameFor` produces `wb_<id12>_<hash>`. Magic numbers tying ws-terminal to safe-exec implicitly. `safe.tmuxNameFor` controls the format; if it changes, this breaks silently. Either expose `safe.tmuxNamePrefix(name)` or use a named regex.
- **L141-158 (medium): PTY spawn at L143 is in a try/catch.** On error, ws.close + return. Good. But: subsequent operations (incrementBrowserCount L160, listener attachment L172-271) run outside the try. If listener attachment throws (`onData`, `onExit`, `on('message')`, `on('pong')`, `on('close')`, `on('error')`), the PTY process is allocated but unreferenced. `ptyProcess.kill()` doesn't run.
- **L179-198 (good): backpressure handling.** When `ws.bufferedAmount > highWater`, pause the PTY and start an interval that resumes when the buffer drains below `lowWater`. Standard pattern, correctly cleared on close (L276).
- **L208-255 (good): control-frame parsing at L210-244** correctly distinguishes between JSON control frames (resize, ping) and falling-through-to-PTY-stdin. The resize-validation guard (L218-223) was the fix for #162 (invalid resize frames being typed into the CLI).
- **L257-271 (good): WebSocket-level ping/pong heartbeat** with `isAlive` flag, terminate after a missed pong.
- **L273-300 (good): close handler clears intervals, decrements browser count, kills PTY, removes from sessionWsClients map only if we're still the current entry.** The `stillMapped` check (L285) is correct — under rapid reconnect, the new ws may have already replaced ours in the map; if so, don't remove.
- **L283-289: WebSocket `close` and `error` handlers both call `ptyProcess.kill()`** — but if `error` fires before `close`, the kill runs twice. PTY's kill is idempotent so this is fine, but worth noting.

**Things done well.** This is one of the best-engineered modules. The prefix-collision check, the in-flight dedup, the missing-JSONL refusal, the recheck-before-spawn — every race condition has a documented mitigation.

### 2.10 `src/watchers.js` (707 lines)

**What it does.** Eight responsibilities lumped into one module:
1. JSONL file watchers for live token updates (`startJsonlWatcher`, `stopJsonlWatcher`, `_attachJsonlWatcher`, `_resolveAndWatchNonClaude`).
2. Settings file watcher for Claude (`startSettingsWatcher`).
3. Settings file watchers for Gemini and Codex (`startGeminiSettingsWatcher`, `startCodexSettingsWatcher`).
4. Context-usage nudge dispatcher (`checkContextUsage`).
5. Workbench MCP server registration in Claude/Gemini/Codex configs (`registerMcpServer`, `registerGeminiMcp`, `registerCodexMcp`).
6. Codex provider config seeding (`registerCodexProvider`, `registerCodexAuth`).
7. Project-trust seeding for Claude/Gemini/Codex (`trustProjectDirs`, `trustGeminiProjectDirs`, `trustCodexProjectDirs`).
8. Claude statusLine collector registration (`registerClaudeStatusLine`).
9. Initial settings file creation (`ensureSettings`).

That's nine if you count the last one. Eight responsibilities, one factory.

**Findings.**

- **(medium, structural): split this module.** A natural decomposition:
  - `watchers/jsonl.js` — `_attachJsonlWatcher`, `_resolveAndWatchNonClaude`, `startJsonlWatcher`, `stopJsonlWatcher`, `checkContextUsage`.
  - `watchers/settings.js` — `startSettingsWatcher`, `startGeminiSettingsWatcher`, `startCodexSettingsWatcher`.
  - `cli-config/claude.js` — `registerMcpServer`, `registerClaudeStatusLine`, `trustProjectDirs`, `ensureSettings`.
  - `cli-config/gemini.js` — `registerGeminiMcp`, `trustGeminiProjectDirs`.
  - `cli-config/codex.js` — `registerCodexMcp`, `registerCodexProvider`, `registerCodexAuth`, `trustCodexProjectDirs`.
- **L24-67 (good): `_attachJsonlWatcher`** uses `fs.watchFile` polling at 2s with debounce (500ms). The polling vs. inotify choice is documented elsewhere as a workaround for bind-mount unreliability.
- **L76-108 (medium): `_resolveAndWatchNonClaude` polls every 3s for up to 60s** waiting for `cli_session_id` to populate. 20 attempts × 3s = 60s. Reasonable cap. Each attempt does a sync `discoverGeminiSessions`/`discoverCodexSessions` call — sync I/O inside an async polling callback.
- **L184-196 (good): `checkContextUsage`** with a `Set` to track sent nudges (per session, single fire). Threshold from config. Sends via `safe.tmuxSendKeysAsync` only if tmux still exists.
- **L198-245 (medium): `registerMcpServer`** reads settings.json, seeds the workbench MCP entry. Comment at L207-208 ("settings.json is corrupt — cannot register MCP server without overwriting user config") is correct policy: refuse on SyntaxError. But "cannot register" doesn't surface to the caller — `routes.js:302-307` fire-and-forgets this. The user has no signal that their corrupt settings.json is preventing MCP registration. Worth surfacing through health endpoint or a UI banner.
- **L247-296 (good): `registerGeminiMcp`** seeds Gemini's settings.json with the workbench MCP entry AND seeds `security.auth.selectedType: 'gemini-api-key'` if `GEMINI_API_KEY` is set (L278-285). The comment at L274-277 explains why: without this, the CLI opens the auth-method menu even though the env var is set. Sophisticated diagnosis of an upstream CLI quirk.
- **L305-346 (good): `registerCodexProvider`** seeds Codex's `config.toml` with a custom `[model_providers.openai-api]` block that uses `env_key = "OPENAI_API_KEY"` and `requires_openai_auth = false`. The comment at L298-303 explains why: the default `openai` provider doesn't honor env-var auth. The TOML rewrite (L327-337) handles the top-level-keys-before-sections rule. Carefully done.
- **L361-419 (good): `registerCodexAuth`** seeds `~/.codex/auth.json` via `codex login --with-api-key` over stdin. Comment at L348-360 explains the rationale (#309) — without this, codex hits a 25 MB/sec write storm via TRACE-logging + inotify. Uses `spawn` (not `execFile`) per the saved-memory note about execFile dropping stdio. The promise wrapping (L388-418) handles spawn errors, child errors, stdin write errors, and finally always ends stdin.
- **L443-492 (good): `trustGeminiProjectDirs`** writes per-project `TRUST_FOLDER` entries. Per-exact-path (not recursive) per Gemini's behavior. Idempotent (`if (cfg[p] !== 'TRUST_FOLDER')`).
- **L536-573 (good): `trustCodexProjectDirs`** writes per-project `[projects."<path>"]` blocks. Escapes the path for TOML basic-string (L554) — `\` → `\\` and `"` → `\"`. Important for paths containing those chars.
- **L500-512, L516-527 (medium): Gemini and Codex settings watchers fire `cli_settings_changed` broadcasts** without payload. The frontend at index.html:2576-2580 consumes these and triggers a `loadState`. Coupling the WebSocket message format across modules is fine but the message type isn't documented anywhere. Add to a `protocol.md` or as a typed const.
- **L629-659 (good): `registerClaudeStatusLine`** registers `node /app/scripts/statusline-collector.js` as the statusLine command. The path is computed via `__dirname` at L645 — relative to `src/`, it's `../scripts/statusline-collector.js`. Correct.
- **L661-688 (medium): `ensureSettings`** writes `{"skipDangerousModePermissionPrompt":true}` if the file doesn't exist. The same content is written by `entrypoint.sh:53`. Two writers, one file. The entrypoint runs first, so usually the file is there by the time `ensureSettings` runs. But if the entrypoint failed or was manually edited to remove the line, `ensureSettings` re-creates with only the one key — possibly clobbering valid settings. Should it be additive (read, merge, write) instead of conditional?

### 2.11 `src/qdrant-sync.js` (1,311 lines)

**What it does.** Watches workspace + per-CLI session directories for changes, parses content into chunks, embeds via the configured provider (HuggingFace / Gemini / OpenAI / custom), upserts to Qdrant. Supports per-collection enable + dimension config. Has cold-start retry, transient-error retry with backoff, settings-change reapply with coalescing, incremental session sync.

**Findings.**

- **L24-25 (medium): `QDRANT_URL` from env, `DEBOUNCE_MS` from env via `parseInt`** — these aren't externalized to `defaults.json`. The QDRANT_URL has a localhost default which is correct for the in-container Qdrant. But the debounce is fixed.
- **L26-27 (low): `CHUNK_WINDOW = 3` and `CHUNK_OVERLAP = 1`** are hardcoded. If embedding quality testing reveals these need tuning per-provider, they should be config keys.
- **L40-44 (good): `_parseSetting(key, fallback)` is a centralized parse-with-fallback** for settings reads. Same shape as the parse pattern in routes.js but consolidated. (Worth extracting to db.js as a shared helper.)
- **L66-72 (medium): `_readCodexKey` uses sync `readFileSync`.** Called from `getEmbeddingConfig` (L106) which is called from every embed operation (L309-311 → `embedWithConfig`). On every embedding call, this reads `~/.codex/auth.json` synchronously. With the qdrant scan running on a 10s debounce and N session files per scan, this hits disk N times per cycle.
- **L195-256 (good): `embedWithConfig` and `retryTransient`** with classification of socket-level errors + HTTP 5xx + 429 as transient. Retry-with-backoff (500ms, 1000ms, 2000ms). 4 max attempts. Carefully reasoned (#212, #262 comments).
- **L260-307 (good): `_embedOnce` with per-provider request shape.** HF uses `inputs`, OpenAI-compat uses `model`+`input`+`dimensions`. The Gemini auth via both `Authorization: Bearer` and `x-goog-api-key` (L283-284) is the OpenAI-compat dual-header approach.
- **L317-355 (good): `buildCandidateConfig`** for synchronous validation before persist. Reads override pair, derives provider, returns a config that uses the override value where applicable. Clean.
- **L361-380 (good): `validateProviderConfig`** with 8s race timeout. The Promise.race pattern is correct. Returns `{ ok, error }`.
- **L484-535 (good): chunk strategies.** Documents are split on `## ` headings; sessions use sliding window of 3 turns with overlap 1. Reasonable.
- **L542-583 (good): `parseClaudeJsonl`** correctly handles content as string OR array of blocks; filters synthetic API errors (`isApiErrorMessage`); truncates per-message to 1200 chars (#262 comment explains the Gemini token cap).
- **L588-646 (good): `parseGeminiSession` and `parseCodexSession`** with per-CLI shape handling. Codex `response_item` payload role + content blocks; Gemini `messages` or top-level array.
- **L702-803 (good): `syncSessionFile` incremental sync.** Uses `last_turn_index` per file to embed only new turns plus an overlap window. Comment at L714-720 explains: without this, every JSONL append triggered a full re-embed of the entire conversation. Significant efficiency improvement.
- **L807-846 (good): `scanCollection`** has a mid-scan abort check (`if (!_running) return;`) at L820 that allows graceful cancellation when settings flip to `provider: none`. The fall-through error handling at L833 distinguishes the cancellation signal from real failures.
- **L808-810, L811: `existsSync` in `scan()` callback** — sync I/O inside async iteration. Could use `fs.promises.access`.
- **L1008-1021 (good): `watchDir` uses `fs.watch` recursive.** Logs ENOENT-on-error (which fires on subdirectory deletion) as expected. Other errors at ERROR.
- **L1058-1140 (good): `start` has `_running`/`_starting` guards** preventing concurrent starts. Cold-start retry via `_waitForQdrant`. Background re-attempt via `_scheduleBackgroundRetry` (L1042-1056) for the case where Qdrant comes up later. Provider validation at startup with single WARN on failure. Initial scan + watchers wired.
- **L1184-1216 (good): `reapplyConfig`** with serialized-trailing-apply pattern. While one apply is running, additional calls fold into a single trailing apply. The strictest reset wins (`dropCollections = a.drop || b.drop`). Carefully reasoned for the rapid-key-save-then-provider-switch case.
- **L1218-1253 (good): `search` with provider-disabled error** carrying `err.code = 'EMBEDDINGS_DISABLED'` so callers can surface "configure a provider in settings" rather than a generic 500.
- **L1283-1302 (good): `status` summarizes per-collection point counts via Qdrant's REST API.** Used by the UI for the vector search settings page.

**Things done well.** This is the most complex module and one of the best-engineered. The retry classification, the cold-start race handling, the trailing-apply coalescing, the incremental session sync, the mid-scan cancellation — every concurrency hazard has a thought-out mitigation.

### 2.12 `src/mcp-tools.js` (948 lines)

**What it does.** Implements 45 MCP tool handlers across `file_*`, `session_*`, `project_*`, `task_*`, `gh_*`, `log_*` domains. `dispatch` central dispatcher. `registerMcpRoutes` exposes via HTTP for the MCP-server-as-bridge architecture.

**Findings.**

- **L8-11 (high, architecture): direct imports of `safe`, `sessionUtils`, `logger`, `db`** — same DI bypass as session-utils.js. Consistent issue.
- **L34-39 (good): `require_(args, ...keys)` validation helper.** Throws `ToolError` with status 400.
- **L41-50 (good): `validateSessionId` allows `new_*` and `t_*` prefixes plus the standard ID pattern.**
- **L58-62 (good): `resolveWorkspacePath`** — joins under WORKSPACE, refuses if the resolved path escapes via `..`. Standard path-traversal block. Note the use of `resolve` (which normalizes `..`) followed by `startsWith(WORKSPACE)` check. Correct.
- **L106-115 (high): `file_list` uses `fs.readdirSync` + `fs.statSync` per entry.** Sync I/O in async handler. With many files in a directory, blocks.
- **L121, L131-133, L141, L149 (high): `file_read`, `file_create`, `file_update`, `file_delete` all use sync FS.** Each is small, but they're called from MCP — meaning agent traffic. An agent that lists 1000 files in a directory then reads 50 of them blocks the event loop for the duration.
- **L157-180 (medium, code quality): `file_find` arg interpolation.**
  ```js
  const grepArgs = ['-rn', '--color=never', `-C${ctx}`, '-m', '50'];
  if (args.file_type) grepArgs.push(`--include=*.${args.file_type}`);
  grepArgs.push('--', safe.shellEscape(args.pattern), safe.shellEscape(WORKSPACE));
  const out = execSync(`grep ${grepArgs.join(' ')}`, { … });
  ```
  - `args.file_type` is interpolated raw at L165 into a `/bin/sh -c` invocation. `args.context_lines` (L159) similarly at L164.
  - Not a security issue under the trust model (the only caller is the user's own Claude/Gemini/Codex session; they can already run arbitrary shell via the terminal tab). But it's a real bug: a `file_type` containing spaces, semicolons, or quotes produces unexpected behavior — silent failure, partial command execution, or noisy errors. The whole `execSync(string)` path should be `execFile('grep', argv)`.
  - **Fix:** validate `file_type` matches `/^[a-zA-Z0-9_+-]+$/`, coerce `context_lines` to `Number(args.context_lines) || 2`, switch from `execSync(string)` to `execFileSync('grep', argv)`. Eliminates the surprise behavior and incidentally closes the interpolation path.
- **L168 (medium): `maxBuffer: 16 * 1024 * 1024`** — 16 MB buffer for grep output. The post-slice to 200 lines (L171) keeps response size sane, but a pattern that matches everything still has to fully buffer before slicing. `execFile` with `signal` + `stdout` chunked reading would be better but is more code.
- **L196-222 (good): `session_new`** correctly distinguishes Claude (`new_${ts}_${rand}`) from non-Claude (`crypto.randomUUID()`). Default to `hidden:true` per the comment at L218-219. Validates `cli` against the enum.
- **L259-293 (good): `session_list`** uses async readdir/parseSessionFile. Fine.
- **L319-343 (medium): `session_resume_post_compact`** uses `fs.readFileSync` (L324) and `fs.writeFileSync` (L336). Same sync I/O issue. Writes the tail to a tmp file under `/tmp` with a per-call timestamp; no cleanup. Long-running workbenches accumulate `/tmp/workbench-resume-*.txt` forever.
- **L368-395 (good): `session_find`** uses `execSync('grep …')` with `shellEscape` applied to pattern and dir. The `args.cli` split-and-switch falls into a default-empty-searchDirs branch on unknown values. Still worth migrating to `execFileSync(grep, argv)` for consistency with the `file_find` fix above, but this one is fine as-is.
- **L405-420, 414-420, 423-433 (good): `session_send_text`, `session_send_keys`, `session_send_key`** all check tmux-exists before sending. The key-validation at L427-429 whitelists named keys + single ASCII chars.
- **L455-460 (medium): `session_wait`** caps at 60 seconds. But the validation at L457 checks `!Number.isFinite(seconds) || seconds <= 0` — except `Math.max(0, Math.min(Number(args.seconds) || 0, 60))` at L456 returns 0 when invalid, then `<= 0` is true, then throws. Awkward but works. Cleaner:
  ```js
  const s = Number(args.seconds);
  if (!Number.isFinite(s) || s <= 0 || s > 60) throw new ToolError('seconds must be 0–60');
  ```
- **L504, L516 (medium): `project_sys_prompt_get` and `_update`** use sync `readFileSync`/`writeFileSync`. Same sync I/O.
- **L538-545 (medium): `_writeProjectMcpJson`** uses sync `writeFileSync`. Called when an MCP server is enabled or disabled per project. Sync write of the project's `.mcp.json`.
- **L547-554 (medium): `_restartCallingSession`** kills + restarts the session that called the MCP enable/disable. Useful but: if the MCP call originated from a session, the call itself is in-flight when this runs. The dispatch result may or may not reach the caller before the kill. Worth a comment.
- **L825-875 (low, code quality): `gh_cmd`** spawns gh or git with the path-keyed token. The `command` arg is passed directly to `spawn` without validating `Array.isArray(command)` or string-typing of elements (L827, L849, L853). `spawn(bin, ['hello', { foo: 1 }])` throws at runtime with a confusing error. Add `if (!Array.isArray(cmd) || cmd.some(x => typeof x !== 'string')) throw new ToolError('command must be array of strings')` for a clean 400 instead.
- **L860-862 (medium): stdout/stderr buffering** — strings concatenated without size limits. A `git log` with millions of lines could OOM the handler. The truncation at L867 (`stdout.slice(0, 200000)`) only fires after full buffering. Add chunk-level truncation.
- **L924-946 (good): `registerMcpRoutes`** — single `/api/mcp/tools` GET (returns tool names) and `/api/mcp/call` POST (dispatches). Status codes derived from error type (L935-939). Reasonable.

### 2.13 `src/mcp-server.js` (337 lines)

**What it does.** stdio-based MCP server. Reads JSON-RPC messages from stdin, dispatches `initialize`, `tools/list`, `tools/call`. Tool catalog of 45 entries (the same set as `mcp-tools.js`). Each tool call hits `POST /api/mcp/call` on `localhost:7860`.

**Findings.**

- **L7-8 (good): port from env, base URL constructed.** Fine.
- **L18-44 (good): `apiCall` uses native `http.request` (no fetch dependency).** Reasonable for a stdio script that should boot fast.
- **L34-37 (good): JSON parse-error fallback to `{ raw: data }`** so the caller can still inspect the wire response.
- **L46-280 (medium, structural): the entire tool catalog is hardcoded as a 200+ line array** of `T(name, desc, props, required)` calls. This duplicates the catalog from `mcp-tools.js` (which has the actual handlers). If a new tool is added in `mcp-tools.js`, `mcp-server.js` must be updated. The two sources can diverge.
  - **Fix:** export the schema array from `mcp-tools.js` and import it here. Single source of truth.
- **L67 (low): "(45 flat tools under server `workbench`)"** comment but the count below appears to be 47 (count by `T(`). Or 45. Worth verifying with `grep -c '^  T('`.
- **L296-313 (good): `tools/call` dispatch** wraps the result as `content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]` per the MCP spec.
- **L321-334 (good): line-buffered stdin via `readline`** with parse-error tolerance. `process.stderr.write` for unexpected errors so stdout stays clean for the JSON-RPC channel.
- **L300 (medium): `case 'notifications/initialized': break;`** — explicit no-op for the initialized notification. Fine.
- **L9-15 (good): `sendResponse`/`sendError`** — proper JSON-RPC framing.

**Recommended:** export `TOOLS` from `mcp-tools.js`, import here. Eliminates drift.

### 2.14 `src/config.js` (141 lines)

**What it does.** Loads `defaults.json` synchronously at module load (fail-fast on corrupt JSON per ERQ-001 §6.4). Hot-reloads via `fs.watchFile` on the file. Lazy-loads prompt templates from `config/prompts/*.md` with the same hot-reload pattern. Provides `get(path, fallback)` and `getPrompt(name, vars)`.

**Findings.**

- **L20-43 (good): `loadDefaultsSync`** with explicit fail-fast on SyntaxError. Writes a structured JSON error line to stderr and `process.exit(1)`. Matches REQ-001 §6.4.
- **L49-77 (medium): `init` is async** but `loadDefaultsSync` is also called at module-load time (L139). So `init` is effectively redundant for the initial load — but it's needed to register the watcher. Documenting the two-phase load (sync at require-time, async watcher setup later) would help.
- **L100-114 (medium): `getPrompt` reads the prompt file synchronously** on first cache miss via `require('fs').readFileSync` (L101). Acceptable since it's lazy-once-per-template, but the description in REQ-001 §3.2 (no blocking I/O in async paths) suggests it shouldn't be sync at all. A pre-warm at startup that reads all known prompts asynchronously would eliminate the sync island.
- **L117-126 (low): missing prompt template returns empty string + WARN.** Reasonable.
- **L83-91 (good): `get(path, fallback)`** dot-path traversal with type-guarded fallback. Clean.

### 2.15 `src/logger.js` (111 lines)

**What it does.** Structured JSON logger to stdout/stderr. Persists every log line to the SQLite logs table for the audit-log surfacing (#181). Hourly retention sweep.

**Findings.**

- **L18-41 (good): lazy db reference.** Avoids a require cycle (db.js doesn't currently import logger, but if it does later, this defends).
- **L43-66 (medium): `_persist` runs on every log line** including DEBUG. With qdrant-sync retry chatter, settings hot-reload, and tab-debug logging, this is one INSERT per log entry. Under load (sustained DEBUG logging from a pipeline), the SQLite write cost is non-trivial. Consider:
  - Batch (queue + periodic flush every N lines or T ms).
  - Filter (only persist INFO+).
  - Async write (the SQLite call is sync, but a worker-thread sink would not block the request thread).
- **L52-65 (good): "warn once per process" pattern** for db unavailable. Stops persistence-failure spam.
- **L68-80 (good): `emit`** writes the JSON line then persists. The level-filter (L69) gates both streams and the persistence. Good.
- **L84-95 (good): hourly cleanup interval** with `unref()`. The retention modifier comes from env `LOG_RETENTION` with default `-7 days`.
- **L92 (low): cleanup `try/catch { /* ignore */ }`** — silent. A persistent cleanup failure (e.g., locked DB) wouldn't surface. Worth a debug log.

### 2.16 `src/webhooks.js` (105 lines)

**What it does.** Stores webhook URLs in DB settings, fires HTTP POSTs on events. Three modes: `event_only` (just IDs), `full_content` (full data). Routes for CRUD.

**Findings.**

- **L21-34 (medium): `fireEvent` is fire-and-forget** with no retry, no dead-letter. A flapping webhook produces one 5-second-timeout error per event with no rate limiting.
- **L45-70 (medium): `sendWebhook`** uses native `http.request` / `https.request` (good — no third-party). Sets `Content-Length` correctly. 5s timeout. Errors logged but not stored.
- **L77-83 (medium): `PUT /api/webhooks`** replaces the entire array. No structural validation of each entry (each should have `url`, optionally `events`/`mode`). A bad payload (non-array webhooks) returns 400 (L80), but `[{ malformed: true }]` is accepted and stored.
- **L94-102 (low): `DELETE /api/webhooks/:index`** uses array index for identity. If two clients race delete-by-index, they may delete different webhooks than intended. Use a stable id per webhook.

### 2.17 `src/git-auth.js` (205 lines)

**What it does.** Path-keyed credential model. Settings table key `git_accounts` holds a JSON array of `{ id, path, token, isKB, default, name }`. Resolves accounts by path (e.g., `github.com/owner`), returns tokens via `gitAuthArgs` for git's `http.extraheader`. Public CRUD with token presence flag (token never returned).

**Findings.**

- **(good, overall): clean module.** Single responsibility, no surprises.
- **L27-47 (good): `resolveAccounts` with idempotent legacy migration.** If any entry has the old `{ host, username }` shape, rewrite to `{ path: host + '/' + username }`. Comment at L25-26 explains.
- **L49-52 (low): `_genId()` uses `Math.random() + Date.now().toString(36)`.** Not crypto-random but stated as "fine for row keys." Acceptable. Worth a comment that this isn't a security boundary.
- **L60-73 (good): `pathFromUrl`** correctly strips embedded user:pass and ssh-scp shapes. Returns `host/owner` form.
- **L95-98 (good): `gitAuthArgs`** returns the `-c http.extraheader=…` args. Token bound for one git invocation only. No URL-side embedding.
- **L106-116 (good): `withGit` wrapper for simple-git** — consistent prefix injection. Used by kb-watcher.
- **L118-144 (good): `addAccount`** with duplicate-path detection + `isKB`/`default` mutual exclusion (L129-132 unsets the flag on others when adding a new isKB/default).
- **L185-191 (good): `publicView` strips token, returns `has_token` boolean.** Used by `gh_account_list` and `/api/git-accounts`.

**Things done well.** This module is the cleanest in the repo.

### 2.18 `src/kb-watcher.js` (310 lines)

**What it does.** Watches `/data/knowledge-base` for changes via chokidar, debounce-commits + pushes to the user's fork. Periodic ff-merge from upstream. Status snapshot exposed via `getStatus`/`refreshStatus`.

**Findings.**

- **L19 (medium): hard `require('chokidar')` and `require('simple-git')`** — these are the only two modules in `src/` that pull in third-party file-watching/git libraries. Both are listed in `package.json:19, 24`. The rest of the codebase uses `fs.watchFile` and `child_process`. Mixing watch mechanisms is a code smell — pick one.
- **L25-26 (medium): `KB_PATH = '/data/knowledge-base'` and `KB_UPSTREAM_URL = 'https://github.com/rmdevpro/workbench-kb'`** are hardcoded. Same constants appear in server.js, routes.js, and the frontend.
- **L33-36 (good): `_kbAuthArgs` looks up the KB account fresh each call.** Token rotation works without restart.
- **L44-47 (medium): `busy` is a single mutex flag** for both commit-and-push and pull. If a pull is running and the watcher fires, the commit is delayed. If a commit is running and the periodic pull fires, the pull is dropped (returns immediately at L199). The pull would be retried at the next interval, but if commits keep firing every 8s and pulls every 5min, a busy commit chain could starve the pull. Worst case: the user's local diverges from upstream because the pull never gets a window.
- **L77-87 (good): `_ensureGitIdentity`** sets `user.name`, `user.email`, `push.default = current` locally per-clone. Correct.
- **L89-132 (good): `_refreshAheadBehind`** issues four `git rev-list --count` calls in parallel via Promise.all (L105-108, L118-121). Good.
- **L100 (good): origin URL sanitization (`.replace(/:\/\/[^@]+@/, '://')`)** strips embedded creds before exposing to UI. Backstop in case any code accidentally embedded auth.
- **L142-188 (good): `_commitAndPush`** stages everything (`git add -A`), commits, pushes via extraheader. Comment at L150-151 explains the `add -A` choice (chokidar can miss rapid sequences).
- **L198-250 (good): `_periodicPull`** uses `g.raw(['fetch', 'upstream'])` per the saved-memory note about simple-git's `.fetch('remote')` no-op quirk. Correct workaround. Falls back to leaving `lastError` populated on non-ff merge with explanation.
- **L252-276 (good): `start`** with chokidar `awaitWriteFinish` (L264) — debounces during atomic writes (editors that swap-rename).
- **L286-306 (good): `pushNow` flushes pending changes immediately** — used by the manual /api/kb/push route. With no pending changes, still pushes (the user may have committed locally). Reasonable.

### 2.19 `src/voice.js` (98 lines)

**What it does.** Deepgram speech-to-text WebSocket bridge.

**Findings.**

- **(critical, dead code): not imported anywhere.** Confirmed: `grep -r "require.*voice" src/` — zero hits. `server.js:25` says "Voice input (Deepgram) removed — feature disabled". The file should be deleted.
- **L39, L57, L62, L68, L86, L93 (high): six `console.log`/`console.error` calls** — non-compliant with REQ-001 §3.2 (structured JSON logging). Moot if the file is deleted.
- **The eslint config doesn't ignore this file**, but it has no usages so eslint warnings on it don't affect anyone. ESLint rules at `eslint.config.js` allow `console` (L10) so even those would pass.

### 2.20 `src/shared-state.js` (19 lines)

Trivial. Module-level `Map<string, WebSocket>` for session→WebSocket mapping. Counter for browser count with increment/decrement.

**Finding:** `decrementBrowserCount` (L15) clamps at 0 (`if (_browserCount > 0)`). Defensive against double-decrement.

No issues. Clean leaf module.

---

## Section 3 — Frontend (`public/index.html`, 5,908 lines)

The frontend is a single HTML file with three blocks:

- **Markup + inline CSS (L1-1109):** body structure, ~1,100 lines of inline styles, all modal markup (settings, auth, task-detail, issue-picker), the sidebar/main/right-panel layout.
- **Imported library bundles (L1110-1111, L1028):** xterm.js, xterm-fit, xterm-web-links, jquery, codemirror-bundle, toastui-editor.
- **Inline JavaScript (L1112-5906):** ~4,800 lines of feature code — sidebar, tabs, sessions, file editor, file tree, panels, settings, KB, errors, auth modal, task tree, issue picker.

### 3.1 Structural verdict

This file is too large to review line-by-line in this document, but the structural issues are clear:

- **No module boundaries.** All ~100 top-level functions share one global scope. `loadState` (L1231) calls `renderSidebar` (L1325) which calls `renderProgramSection` (L1555) which calls `renderOneProjectGroup` (L1349) — none of which are reusable elsewhere because the closure over `projectState`, `programState`, `expandedPrograms`, etc. is implicit.
- **No build step.** `package.json` has Prettier and ESLint in devDependencies but no `frontend:build` or `frontend:lint` script. The eslint config explicitly ignores `public/**` (eslint.config.js:97).
- **Extreme inline-handler density.** Nearly every interactive element uses `onclick="…"`/`onchange="…"` attributes that reference top-level functions. This is workable but couples markup to function names; a rename of `loadState` requires updating ~10 inline-handler strings. Most of the modal builders use template strings with inline handlers instead of building elements + attaching listeners.

### 3.2 Specific findings

- **L1147-1156 (good): localStorage-backed UI state** — `expandedPrograms`, `expandedProjects`, `tabPanelAssignments`, `tabOrders`, `sidePanelWidth`, `DEBUG_TAB_SWITCHING`. All wrapped in try/catch on parse. Persistent across reloads.
- **L1166-1212 (good): `tabDbg`** debug-only tab-switching instrumentation. Gated on localStorage flag or `?debug=tabs` URL param. Snapshots include orphan-pane detection and orphan-canvas detection (zombie xterm renderers, comment at L1196-1199 documents the bug pattern).
- **L1241-1322 (medium): `loadState`** has a 7-second pending-edits lock pattern (L1671-1674, L1675-1716) for optimistic UI mutations. This is sophisticated handling for slow `/api/state` polls (memory note: M5 is 5-7s) but adds significant complexity. The three pending-edit Maps (`_pendingProgramAssignments`, `_pendingProjectEdits`, `_pendingSessionEdits`) and the `PENDING_LOCK_MS = 7000` are workable but make state reasoning hard. Would benefit from a single "pending mutations" abstraction.
- **L1276-1315 (good): temp-tab → real-session migration on `loadState`** — a `new_*` tab whose temp ID disappears from state has its tab id swapped to the real session ID. The `auth modal authTriggerTabId` is also kept in sync (L1296). The pane element id is renamed (L1303-1305) with a guard against a stale element at the new id (L1304). Carefully done — this was clearly a debugged race.
- **L1325-1645 (medium): `renderSidebar` is 320 lines** with nested helpers `renderOneProjectGroup`, `renderProgramSection`, plus inline event handlers. The state-hash diffing at L1332-1337 prevents redundant re-renders but means the logic of "what changes invalidate the sidebar" is encoded in a string concat. Adding a new field to a project means updating the hash. Easy to forget.
- **L1387-1402 (medium): the new-session dropdown** is built via template literal interpolation. The CLI choices and credential checks are hardcoded inline. Adding a fourth CLI requires editing this and several other locations (`createSession`, `_seedRole`, `tmuxCreateCLI`, etc.).
- **L1488 (medium): `data-id="${escHtml(session.id)}"`** in attribute context. `escHtml` escapes `&<>"'` (L4583) — sufficient for attribute escaping. But there's also `escAttr` at L3019 (`String(s).replace(/"/g, '&quot;')`) which is narrower. Two escape helpers used inconsistently.
- **L1515-1521, L1530, L3277, L3796 (medium): `confirm()`/`alert()`/`prompt()` for primary CRUD** violates the project's stated UI modal pattern (memory: "✎ pencil + center-popup modal for create/edit. Never right-click context menus or bare prompt() for primary CRUD").
- **L1949-1966 (medium): `createTab`** correctly removes any pre-existing element at the new pane id (L1967) — fix for issue #161 (orphan panes). Multiple comments explain race fixes.
- **L1985-1999 (good): xterm `linkHandler`** with `allowNonHttpProtocols: true` to handle `file://` clicks via the file viewer. Comment at L1982-1984 explains.
- **L2003-2007 (good): mouse-tracking sequence blockers** — registers no-op CSI handlers for modes 1000/1002/1003/1006/1015 so xterm doesn't echo them out for the user to copy. Sophisticated handling of CLI-emitted DCS that would otherwise corrupt the visible buffer.
- **L2021-2045 (good): bare-path link provider** for `/data/workspace/...` paths — opens the file viewer via `openFileTab`. Strips trailing punctuation. Custom decorator (pointer cursor + underline).
- **L2280-2340 (medium): `moveTabToPanel` reparents the pane element to the target panel.** This is the side-panel feature implementation. Several edge cases are handled (active-tab pointer rebalancing, side-panel auto-show/hide, refit terminals). Complex but appears correct.
- **L2487-2640 (good): `connectTab` WebSocket handler** with reconnect machinery, dead-tmux detection, automatic resume up to 3 attempts, control-frame parsing. The "JSON dimensions guard" comment at L2510-2517 documents the bug fix for null dimensions being typed into the CLI.
- **L2576-2580 (good): `cli_settings_changed` consumer** — debounced `loadState` instead of falling through to `tab.term.write` (which would dump JSON into the visible terminal). Documented as #310 fix.
- **L3209-3291 (medium): `_showTaskContextMenu` is a right-click context menu** for tasks. The ux-modal-pattern memory note discourages context menus for primary CRUD; this one builds Add/Edit/Status-change/Archive/Delete actions in a right-click. Some are duplicated by the task-detail modal's controls. Possibly intentional for power users but inconsistent.
- **L3299-3345 (high): `openIssuePicker` derives the GitHub repo as `rmdevpro/${lastTwo[lastTwo.length - 1]}`** (L3334). Hardcoded org name. Comment at L3335 acknowledges "for the agentic-workbench self-reference" — but for any other project, this returns 404 from GitHub. Per saved memory the project is intended to be deployable to other users; this breaks the moment a user clones any other repo into their workspace.
  - **Fix:** add `GET /api/projects/:name/git-remote` that runs `git remote get-url origin` in the project, parse owner/name via `git-auth.js pathFromUrl`, return.
- **L3700-3702 (good): pane-element guard** in `openFileTab` matching the `createTab` pattern.
- **L3770-3798 (high): `Save As` uses `window.prompt`** in violation of the modal pattern. The path-validation at L3772-3775 (`!cleanPath.startsWith('/data/workspace')`) is a UX-only check (the backend enforces nothing here, AD-001 says full filesystem access). So a user can paste an arbitrary path; the alert at L3774 fires. Use a proper modal with a path picker.
- **L4583, L5853 (medium): two `escapeHtml` implementations.** `escHtml` and `escapeHtml`. Both implement `String(s ?? '').replace(/[&<>"']/g, …)`. Pick one and delete the other.
- **L4498-4573 (medium): `submitAuthCode`** sends the OAuth code to the workbench backend. The terminal session is detected via tab id; on success, the modal dismisses. The associated saved memory ("OAuth modal Submit successfully sets up Workbench-side auth but does NOT advance the running CLI session — close and recreate the Claude session") acknowledges this is a known incomplete fix (#184). Persists.
- **L5762-5777 (medium): `showAuthBanner`** uses `innerHTML = '<svg…><span>...</span>'`. The `reason` arg is interpolated raw (L5773 doesn't use it; only static text). Safe in current usage.
- **L5816-5846 (good): `showErrorBanner`** uses `escapeHtml` correctly. Click handler dismiss state suppresses re-show until a newer error fires (L5841-5845). Sophisticated UX.
- **L5896-5905 (good): init sequence** — `loadState`, `loadFiles`, `setInterval(loadState, REFRESH_MS)`, `checkAuth`, `checkErrors`. Polling-based. Workable for the polling cadence (10s).

### 3.3 Frontend recommendations

- Split into ESM modules served as separate files (or a small build step). Suggested layout:
  - `app/state.js` — projectState, programState, tabs Map, expanded* sets, pending-edits Maps.
  - `app/sidebar.js` — `loadState`, `renderSidebar`, project/program/session row builders.
  - `app/tabs.js` — `createTab`, `switchTab`, `closeTab`, `_makeTabEl`, `renderTabs`, `_wireDropZones`.
  - `app/terminal.js` — xterm setup, link handler, `connectTab`, WebSocket lifecycle.
  - `app/files.js` — file editor tabs, FileTree, `openFileTab`, `saveFileTab`.
  - `app/tasks.js` — task tree, task detail modal, issue picker.
  - `app/settings.js` — settings modal, KB, vector, git accounts.
  - `app/auth.js` — auth modal, OAuth flow.
  - `app/util.js` — escHtml, escAttr, timeAgo, db_getSetting.
- Consolidate the two escape helpers.
- Replace `window.prompt`/`alert`/`confirm` for primary CRUD with the existing modal pattern.
- Move all inline `onclick` to `addEventListener` so the handlers are bound at element-creation time (and survive renames).

### 3.4 `public/gate.html` (256 lines)

Cleanly self-contained. Two modes (template / password) toggled via injected `__GATE_MODE__` constant (L216). Template mode shows duplicate-Space CTA; password mode shows login form.

**Findings.**

- **L227-247 (good): `doLogin` POSTs JSON, on `res.ok` reloads the page.** On failure shows `Invalid username or password` regardless of the actual error.
- **L188 (low): `<a href="https://huggingface.co/spaces/aristotle9/agentic-workbench?duplicate=true">`** — hardcoded Space ID. If the upstream Space is renamed, this breaks.
- **L173 (low): `<img src="/planlogo.png">`** — depends on `/planlogo.png` being shipped. Per the `.dockerignore` review above, this is excluded by the `*.png` rule. HF deploys via `git archive` so it works there; local docker builds fail.

---

## Section 4 — Scripts

### 4.1 `scripts/build-editor.js` (12 lines)

Calls `npx esbuild` to bundle `scripts/codemirror-entry.js` → `public/lib/codemirror/codemirror-bundle.js`. Trivial.

**Finding:** invoking via `npx` means esbuild is fetched on every run. Add `esbuild` to devDependencies and call directly. Also: there's no `prepare` script in package.json that runs this on install, so the bundle must be built manually and committed (which it is, per `public/lib/codemirror/codemirror-bundle.js`). Workable but fragile.

### 4.2 `scripts/codemirror-entry.js` (12 lines)

Re-exports CodeMirror modules for the iife bundle. Fine.

### 4.3 `scripts/statusline-collector.js` (66 lines)

Reads JSON from stdin (Claude statusLine pipe), persists to `/data/.claude/statusline-state-<sessionId>.json` via atomic temp+rename, writes a status-line string back to stdout for Claude to render.

**Findings.**

- **L26-29 (good): JSON parse-error fallback writes "Workbench" to stdout** so the status line stays populated even if the payload is malformed.
- **L43-50 (good): atomic write via tmp + rename.** Workbench reader can't observe a partial file. Correct.
- **L41 (low): `writeFileSync` with `JSON.stringify(state, null, 2)`** — pretty-printed for human inspection but adds bytes per file. Across many sessions this isn't huge but the reader doesn't care about pretty-printing. Compact form is fine.

### 4.4 `scripts/prime-test-session.js` (196 lines)

Stress-test helper. Reads conversation from a JSONL, creates a Workbench session via `/api/sessions`, generates a synthetic JSONL with the conversation history, prints docker cp / scp commands to inject into the container.

**Findings.**

- **L107 (high): the request body to `/api/sessions` includes `prompt: 'Compaction stress test session'`** — but the API at routes.js:1244 expects `name` (validated as required at L1256). The script will get a 400 unless prompt happens to also be acceptable. Looking at the route: only `project, name, cli_type, hidden, role` are extracted; `prompt` is silently ignored. So the call fails because `name` is missing.
- **L127 (low): `require('crypto')` inline.** Hoist.
- **L183-188 (low): the printed instructions reference `docker exec -u hopper`** — but the user is `workbench` per the Dockerfile rename (L35). Stale instructions.
- **L120 (low): "Resolved session ID: ..." path** assumes the session is named "Compaction stress" — but the session name is the prompt arg which the route ignores. The session is named whatever validation defaulted to (probably an error). The script appears stale; needs an update for the v7.0 schema (memory note in test plan: smart compaction was removed entirely).

This script may already be dead. Verify by running it; if it doesn't work end-to-end, delete or fix.

---

## Section 5 — Tests (inventory)

The test layout matches the plan (mock / live / browser). 19 mock test files, 17 live test files, 14 browser .spec files, 8 helpers, 3 fixtures.

I haven't audited the test code itself in this review (would require reading another ~5,000+ lines). Some structural observations:

- **`tests/runbook-results-2026-05-03-baseline.md` is 106 KB**, runbook itself is 312 KB — consistent with the plan's size and the runbook standard.
- **`tests/traceability-matrix.md` (22 KB)** — cross-references runbook IDs to test plan IDs. Already documented in this review's earlier notes (33 runbook scenarios with no plan backing, 5 plan categories with no runbook execution).
- **`tests/executor-briefing-2026-05-03-baseline.md`** — runbook-execution briefing per PROC-003.
- **`tests/fixtures/` has only 3 files** (`stub-claude.sh`, `test-data.js`, `trigger-uncaught.js`). The test plan §3.3 lists 8 fixtures including `ansi-auth-url.txt`, `chunked-auth-frames.bin`, file tree, primed JSONL, settings.json, tasks.json, messages.json. Most are missing. Either the plan is aspirational (fixtures generated inline by tests) or the fixtures are missing.
- **`coverage-results-2026-04-28-mcp-rework.txt` (2.3 KB)** is committed. Either prefer not to commit transient coverage outputs (move to `.gitignore`), or commit them under a clearly-dated `coverage/` directory.

---

## Section 6 — Documentation issues (consolidated)

### 6.1 `README.md`

- **L48 ("all 40+ route handlers"):** actual count is 72.
- **L46-58 + L59 (architecture table + supporting modules):** omits `kb-watcher.js`, `git-auth.js`, `voice.js`. The latter is dead code; the first two are active. Without them, the architecture summary is materially incomplete.
- **L90 ("config/docs/sdlc/guides/workbench-deployment.md"):** path does not exist. Real path is `/data/workspace/repos/Admin/docs/guides/workbench-deployment.md`.
- **L97-103 (Configuration section):** documents `TMUX_CLEANUP_MINUTES` (doesn't exist), `bridge.cleanupSentMs`/`bridge.cleanupUnsentMs` (don't exist), `keepalive.queryTimeoutMs` (read by code but not in defaults.json), `claude.defaultTimeoutMs` (read by code but not in defaults.json), `session.summaryModel`/`summaryMaxTranscriptChars`/`summaryMaxMessageChars` (read by code but not in defaults.json), `ws.pingIntervalMs` (read by code but not in defaults.json). Conversely, `embeddings.providers.*`, `kb.*`, `polling.tokenUsageIntervalMs`, `debug.tabSwitching`, `session.nudgeThresholdPercent`/`resumeTailLines`/`promptInjectionDelayMs`/`promptMaxLength`, `tmux.idleWithTabDays`/`idleWithoutTabDays`/`scanIntervalSeconds`/`windowWidth`/`windowHeight` are in defaults.json but not in the README.
- **L150-151 (Filesystem Access):** documents `workbench_read_plan`/`workbench_update_plan` MCP tools — these were deleted (test plan revision 7.0 lists them removed, mcp-tools.js doesn't define them).
- **L152-156 (Compliance):** lists ERQ-001 features (which don't exist as a doc — REQ-001 is the engineering requirements). Mentions `WPR-104` which is also not a real doc — WPR-103 is the test plan standard, WPR-104 doesn't appear in the Admin standards.

### 6.2 `Issue_Log.md` referenced but not present

README.md L164: "See `Issue_Log.md` for full compliance audit trail." File does not exist in the repo.

### 6.3 README HF-Space frontmatter

L1-9 has the HF Space metadata (sdk: docker, app_port: 7860, etc.). Per the deployment guide, this is correct (one README serves both GitHub readers and HF). No issue.

### 6.4 CLAUDE.md (project)

Already read into context at session start. References the Admin repo for standards. No issues.

### 6.5 config/CLAUDE.md / config/GEMINI.md / config/AGENTS.md

Per-CLI system prompts seeded into ~/.claude/, ~/.gemini/, ~/.codex/ at container start. They're shipped in the image (per `.dockerignore` excluding `*.md` would block them, but the comment at `.dockerignore:9` says "Keep config/ prompts (*.md files inside config are needed)" — the rule is `*.md` at the root level, so `config/*.md` is preserved). Verify that's actually how docker resolves the `.dockerignore` glob: per Docker docs, patterns are matched relative to the build context root, so `*.md` matches only top-level. `config/CLAUDE.md` is preserved. Subtle but correct.

---

## Section 7 — Cross-cutting issues

### 7.1 Sync I/O in async paths (REQ-001 §4.1)

Consolidated list. Each entry is a real call site reachable from an async handler:

| File | Line(s) | Function | Reachable from |
|---|---|---|---|
| `server.js` | 144 | `serveGatePage` (`fs.readFileSync`) | every gated request |
| `session-utils.js` | 31 | `_readClaudeStatusLineState` | `getSessionInfo` (async) |
| `session-utils.js` | 165 | `_searchGeminiSessions` | `searchSessions` (async) |
| `session-utils.js` | 199 | `_searchCodexSessions` | `searchSessions` (async) |
| `session-utils.js` | 337 | `_readGeminiTranscript` | `summarizeSession` (async) |
| `session-utils.js` | 381 | `_readCodexTranscript` | `summarizeSession` (async) |
| `session-utils.js` | 515 | `_getGeminiTokenUsage` | `getSessionInfo` (async) |
| `session-utils.js` | 579 | `_getCodexTokenUsage` | `getSessionInfo` (async) |
| `session-utils.js` | 736 | `parseGeminiChatFile` | called from `discoverGeminiSessions` |
| `session-utils.js` | 794 | `parseCodexRolloutFile` | called from `discoverCodexSessions` |
| `session-utils.js` | 851 | `discoverGeminiSessions` | full sync walk over `~/.gemini/tmp/*/chats/*` |
| `session-utils.js` | 880 | `discoverCodexSessions` | full sync walk over `~/.codex/sessions/YYYY/MM/DD/*.jsonl` |
| `session-resolver.js` | 223–246 | `discoverCliSessionId` snapshot | inside async polling loop |
| `session-resolver.js` | 255–305 | per-poll re-scan | same |
| `mcp-tools.js` | 106 | `file_list` | async handler |
| `mcp-tools.js` | 121 | `file_read` | async handler |
| `mcp-tools.js` | 131-133 | `file_create` | async handler |
| `mcp-tools.js` | 141 | `file_update` | async handler |
| `mcp-tools.js` | 149 | `file_delete` | async handler |
| `mcp-tools.js` | 168 | `file_find` (`execSync`) | async handler (also has shell injection) |
| `mcp-tools.js` | 324, 336 | `session_resume_post_compact` | async handler |
| `mcp-tools.js` | 354 | `session_export` | async handler |
| `mcp-tools.js` | 381–385 | `session_find` (`execSync`) | async handler (no shell injection — escaped) |
| `mcp-tools.js` | 504 | `project_sys_prompt_get` | async handler |
| `mcp-tools.js` | 516 | `project_sys_prompt_update` | async handler |
| `mcp-tools.js` | 544 | `_writeProjectMcpJson` | called from project_mcp_enable/disable |
| `qdrant-sync.js` | 69 | `_readCodexKey` | called from `getEmbeddingConfig` (every embed call) |
| `qdrant-sync.js` | 812 | `existsSync` in scan | mid-async iteration |
| `routes.js` | 1576-1580 | `_projectHasRepoPath` | called from `buildProjectTaskTree` (HTTP handler) |
| `routes.js` | 2186 | `require('fs').writeFileSync` | `/api/sessions/:id/session` resume mode |

Most can be replaced 1:1 with `fs/promises` equivalents. The full set is non-trivial work but mechanical.

### 7.2 Module-import inconsistency (factory DI)

Three modules bypass the factory-DI pattern by direct top-level imports:

- `session-utils.js:4-8` — imports `safe`, `db`, `config`, `logger`.
- `mcp-tools.js:8-11` — same.
- `qdrant-sync.js:17-20` — same.

The other 17 backend modules use either factory-style construction (`createX({deps})`) or are pure leaves (`safe-exec`, `logger`, `db`, `config`, `shared-state`, `git-auth`). The three offenders are exactly the modules that handle the most state (session metadata, MCP tools, vector sync).

### 7.3 Hardcoded constants duplicated across modules

| Constant | Locations |
|---|---|
| `KB_PATH = '/data/knowledge-base'` | server.js:377; routes.js:503, 547, 1227, 1988, 2003; kb-watcher.js:25 |
| `KB_UPSTREAM` GitHub URL | server.js:390; routes.js:548; kb-watcher.js:26; frontend index.html:745 |
| Codex rollout UUID regex | routes.js:441-443, 1505; session-resolver.js:296-302; session-utils.js:365-367, 560-562, 962-964; watchers.js:88-89 |
| Session ID validation regex | routes.js:27; mcp-tools.js:17 |
| Tmux name format slice indices | ws-terminal.js:57; safe-exec.js:35-39 |
| `*-CLAUDE.md`/`*-GEMINI.md`/`*-AGENTS.md` per-CLI map | routes.js inline; mcp-tools.js:97 (`SYS_PROMPT_FILES`); entrypoint.sh; voice.js (none) |

Each duplication is a future drift point.

### 7.4 Inline `require()` inside function bodies

Beyond what's already cited:

- `routes.js`:
  - L72-76 (`_seedRole` body): six modules.
  - L121, L139, L154 (per-CLI branches): re-requires session-utils and safe-exec.
  - L411 (KB sync poller): `require('./git-auth')`.
  - L553 (KB helpers): `require('./git-auth')`.
  - L872 (file-new): `require('fs/promises').access`.
  - L885, L909 (rename/move): `require('fs/promises').rename`.
  - L897 (delete): `require('fs/promises').rm`.
  - L927 (files/list): `require('fs/promises')` whole module.
  - L1289 (sessions POST): `require('crypto').randomUUID`.
  - L1576-1577 (`_projectHasRepoPath`): `require('fs')` and `require('path')`.
  - L1825, L1896, L1962, L1974 (qdrant routes): `require('./qdrant-sync')`.
  - L1908-1909, L2186 (cli-credentials, sessions/:id/session): `require('fs/promises')` and `require('fs')`.
- `mcp-tools.js`:
  - L65 (`_semanticSearch`): `require('./qdrant-sync')`.
  - L309, L315 (`session_prepare_pre_compact`, `session_resume_post_compact`): `require('./config')`.
  - L604-605 (`_projectHasRepo`): `require('fs')` and `require('path')`.
  - L1289 mirror.
- `safe-exec.js`:
  - L36, L154-156: inline crypto, child_process, util.

Node caches modules so this isn't a runtime issue. But:
- It hides dependencies from a static grep of "what does this module need."
- It makes the import surface inconsistent (some imports at top, others scattered).
- It's an indicator that the file grew without consolidation.

### 7.5 Two separate caching strategies for non-Claude session metadata

Independent caches without coordination:

- `routes.js:340-360` `_geminiSessionsCache` / `_codexSessionsCache` — 10s TTL, holds the `discoverGeminiSessions()` / `discoverCodexSessions()` result lists.
- `routes.js:363-374` `_claimedGemini` / `_claimedCodex` — Sets that track which disk sessions have been "claimed" for the current ordering pass; reset on a 10s window.
- `session-utils.js:900-902` `_sessionInfoCache` — 2s TTL, keyed by `${sessionId}:${includeTokens}`, holds the unified `getSessionInfo` result.
- `routes.js:689-690` `_issuesCache` — 60s TTL, GitHub issues per repo+state.

Three of these (the routes.js ones) are tied to the request that initiated the cache fill. The session-utils one is module-level. None talks to the others. The `_readGeminiTranscript`/`_getGeminiTokenUsage`/etc. helpers inside session-utils.js call `discoverGeminiSessions` directly without consulting `_getGeminiSessions` (the cached version), so the routes.js cache only serves the routes.js `_getNonClaudeMetadata` path.

A unified per-CLI session-discovery cache at session-utils level would let everyone benefit.

---

## Section 8 — Trust model & "security-shaped" findings

### 8.1 Trust model

The Workbench is a single-user containerized IDE. Per AD-001, the design intent is:

- **Gate is the only trust boundary.** HF Space gate (template or password mode) or self-hosted compose with no gate at all (per README L29).
- **Past the gate, the user IS the threat model — and is trusted.** They have terminal access via tmux, full filesystem read/write via `/api/browse` and `/api/file*`, sudo inside the container (Dockerfile L43), arbitrary CLI invocation, and the ability to run `file_create` with executable content.
- **No in-application privilege boundary.** There's nothing to escalate to. Code reachable past the gate runs at the user's effective privilege.

This means several issues that look like security bugs at first glance are not exploits. The user can already do worse via more direct paths. The framing in this section is therefore: bugs in handlers reachable past the gate are **code quality / correctness** issues. They make the code less robust, surface confusing errors, and are worth fixing — but they're not vectors for unauthorized access or privilege escalation.

What survives as a real security concern:
- **Token redaction in client-facing error paths** (so client-side logs / browser DOM can't capture credentials). Already handled by `safe.sanitizeErrorForClient`.
- **Tokens never embedded in remote URLs** (so they don't leak via git remote/origin output). Already handled by `gitAuthArgs` + `http.extraheader`.
- **Cookie security flags appropriate to deployment.** HF Spaces are HTTPS-forced; self-hosted compose explicitly has no gate per README. Either way, no real concern.

### 8.2 Code quality issues that look security-shaped

These are reclassified from "security" to "code quality." Each is a real bug, just not an exploit.

**`mcp-tools.js:166` — `file_find` arg interpolation (medium / code quality).**
`args.file_type` and `args.context_lines` interpolated into a `/bin/sh -c` command. Reachable only by the user's own MCP-connected CLI session, which can already run shell via the terminal tab. Real bug: a `file_type` of `js;extra-stuff` produces unexpected behavior. Fix: switch to `execFileSync('grep', argv)`, validate `file_type` against `/^[a-zA-Z0-9_+-]+$/`, coerce `context_lines` to a bounded integer.

**`routes.js:709-713` — `/api/issues` GraphQL string concat (medium / correctness).**
`owner` and `name` interpolated into the GraphQL query. Regex permits `"`. Reachable only by the gate-authenticated user, sending the query with their own token to their own GitHub account. Real bug: a repo name containing `"` produces malformed GraphQL and the call fails with a confusing 502. Fix: GraphQL variables.

**`mcp-tools.js:825-875` — `gh_cmd` doesn't validate `command` is `Array<string>` (low / code quality).**
`spawn` rejects non-arrays at runtime with a confusing error. Add an explicit check up front for a clean 400.

### 8.3 Things that aren't issues at all under this trust model

For the record (so they don't re-surface as "concerns" later):

- **`/api/gate/login` has no rate limiting.** Self-hosted compose has no gate; HF gates above this; the gate's own `WORKBENCH_USER`/`WORKBENCH_PASS` are static long-lived secrets the user controls. Brute force isn't part of the threat model.
- **Session cookie missing `secure` flag (`server.js:158`).** HF is HTTPS-forced; self-hosted is local LAN. No man-in-the-middle path matters here.
- **Passwordless sudo inside the container (`Dockerfile:43`).** The runtime user is the trusted user. Worth one line in the README for transparency, not a finding.
- **`/api/browse`, `/api/file`, `/api/file-raw` have no path containment.** Documented and intentional per AD-001.
- **`/api/upload` accepts up to 50 MB with no path containment.** Same.
- **`/api/file` size cap (1 MB read) but `/api/file-raw` has none.** The comment at routes.js:856-861 explicitly justifies the difference; res.sendFile streams from disk without buffering.
- **MCP `file_create`/`file_update`/`file_delete` operate within `WORKSPACE` (`mcp-tools.js:58-62`).** The path-traversal check exists but is technically unnecessary under this trust model — though it's harmless and arguably a good belt-and-suspenders. Keep.

### 8.4 Hardening that's actually engineering, not security-against-attackers

These are good practices for diagnosability and operational hygiene, kept in the codebase:

- `safe.sanitizeErrorForClient` redacts URL-embedded credentials before returning errors. Useful so a Slack-shared error message doesn't accidentally leak a token.
- `gitAuthArgs` keeps tokens out of remote URLs across all KB and GitHub paths. Useful so `git remote -v` output doesn't leak.
- `gh_account_list` returns `has_token: bool` but never the token itself. Useful so the agent (or a screenshot) doesn't echo it.
- Session-id and project-name validation regex applied before DB lookups. Useful for catching client bugs early; not a security necessity since the DB has its own constraints.
- WebSocket upgrade is gated identically to HTTP (server.js:225-238). Correct and consistent.

These are the actual security-relevant things in the codebase. They're all fine.

---

## Section 9 — Performance / scaling

The biggest user-visible cost is `/api/state`. Per the trace through the code:

1. Frontend polls every 10s (`REFRESH_MS = 10000`).
2. Server iterates every project, runs reconciliation (which reads sessions dir), enumerates JSONL files, calls `parseSessionFile` on each (cached).
3. For each session, runs `getSessionInfo` (which calls `parseSessionFile`/Gemini-discover/Codex-discover depending on CLI).
4. The Gemini/Codex paths sync-walk the entire respective home directories.

For a workbench user with 5 projects × 10 sessions each, plus 30 Gemini/Codex sessions accumulated over time, each /api/state poll does:
- 5 `stat` calls
- 5 `readdir` calls
- ~50 `parseSessionFile` calls (cached after first)
- ~50 `getSessionInfo` calls (2s cache per (sessionId, includeTokens) pair)
- For ~20 non-Claude sessions: full sync walk of `~/.gemini/tmp/*` and `~/.codex/sessions/*` per call to `_getGeminiTokenUsage`/`_getCodexTokenUsage`. The 10s `_geminiSessionsCache` in routes helps for the disambiguation pre-pass, but the deeper helpers in session-utils don't use it.

**Recommendations:**

1. Push the Gemini/Codex discovery cache down into session-utils so all consumers share it.
2. Make discovery async (`fs.promises.readdir`).
3. Fold `_sessionInfoCache` into a single keyed cache with projection helpers (cache the with-tokens payload, return the no-tokens projection to sidebar callers).
4. Add a lightweight "session-list" endpoint that returns just `{ id, name, timestamp, cli_type, archived }` for the sidebar — skip the per-session disk reads — and have the status bar fetch the heavy `getSessionInfo` only for the active session.
5. Move `/api/state` from poll to push: WebSocket-broadcast `state_changed` events from watchers + KB watcher + tmux-lifecycle. Initial load via fetch, subsequent updates via push.

The `/api/state` time is the user's daily friction. Worth real optimization.

---

## Section 10 — Architectural recommendations (consolidated)

### 10.1 Decompose `routes.js`

Split into 9 domain files under `src/routes/`. Each exports a `register(app, deps)` factory. `routes.js` becomes a 30-line composition.

### 10.2 Convert `session-utils.js`, `mcp-tools.js`, `qdrant-sync.js` to factory-DI

Bring them in line with the rest of the codebase. Eliminates implicit module-load coupling and unblocks unit testing with mocks.

### 10.3 Decompose `session-utils.js` by CLI

Per-CLI files (`claude-jsonl.js`, `gemini.js`, `codex.js`) plus a `info.js` for the unified aggregator. Each CLI file owns its discovery, parsing, transcript reading, and token extraction.

### 10.4 Add a numbered DB migration runner

Replace the 20+ try/catch ALTER pattern with a `schema_migrations` table + array of `{ id, up }`. ~30 lines of code. Fixes future migration ordering and gives ops a way to know what's run.

### 10.5 Externalize all read config keys to `defaults.json`

Either every `config.get(key, fallback)` call has a corresponding entry in `defaults.json`, or the fallback is documented as intentional. Today it's a coin flip.

### 10.6 Move startup KB clone + sync poller out of `server.js`

Into `kb-watcher.js`. The startup sequence in server.js should be one-line bootstraps, not inline closures with their own state.

### 10.7 Single source of truth for the MCP tool catalog

Export `TOOLS` from `mcp-tools.js`, import in `mcp-server.js`. Eliminates drift.

### 10.8 Delete dead code

- `src/voice.js` (98 lines) — unused, uses non-compliant logging.
- jQuery + jqueryfiletree dependencies — frontend already replaced.
- `scripts/prime-test-session.js` — stale (uses removed `prompt` arg, references `hopper` user).
- README's `Issue_Log.md` reference.

### 10.9 Add a frontend build step or split `public/index.html`

5,908 lines is past the point where the inline-everything pattern helps. Either:
- Split into ESM modules served as separate static files (no build step needed), with `<script type="module" src="…">` tags.
- Or add a tiny esbuild step (already used for codemirror) that bundles into one or a few output files.

### 10.10 Treat the README as a living document

Per STD-007: every change that affects modules, config, deployment, or compliance updates the README in the same commit. Today the README documents an architecture from ~3 revisions ago. Bring it up to date in one pass and then enforce.

### 10.11 Match the `package.json` test gate to the test plan threshold

Either raise c8 thresholds to 85/85 to match the plan, or update the plan to match the gate. Today they diverge.

---

## Section 11 — Prioritized issue list

Reframed under the actual trust model. There is no "Critical" tier — the gate is the only trust boundary, and every other handler is reachable only by the trusted user. The "High" tier is now correctness, performance, and architecture.

### High (correctness / performance / architecture)

| # | File:Line | Issue |
|---|---|---|
| 1 | `routes.js:2165` | Path-encoding mismatch breaks `/api/sessions/:id/session` for projects with `.`/`~`/`+`/space etc. Use `safe.findSessionsDir(projectPath)`. |
| 2 | `session-utils.js` (multiple) | Sync FS in async paths throughout Gemini/Codex search/discovery/token paths — search, transcripts, token usage, full directory walks. The `/api/state` poll path. |
| 3 | `session-resolver.js:209-329` | `discoverCliSessionId` polling loop uses sync FS. |
| 4 | `mcp-tools.js` (multiple) | `file_list/read/create/update/delete` use sync FS. |
| 5 | `routes.js` (2,370 lines) | God file; needs domain split into `routes/sessions.js`, `routes/projects.js`, etc. |
| 6 | `public/index.html:3334` | Frontend hardcodes `rmdevpro/` GitHub org in issue picker. Breaks for any user who clones a different repo. |
| 7 | `README.md:90` | Deployment guide path `config/docs/sdlc/guides/workbench-deployment.md` does not exist. Real path is in the Admin repo. |
| 8 | `README.md:97-103` | Configuration section lists keys that don't exist (`TMUX_CLEANUP_MINUTES`, `bridge.cleanup*`); omits ~10 keys that do. |
| 9 | `README.md:46-58` | Architecture table omits `kb-watcher.js`, `git-auth.js`; lists `voice.js` indirectly under "supporting modules" — should be removed. |
| 10 | `README.md:150-151` | References removed MCP tools (`workbench_read_plan`/`update_plan`). |
| 11 | `package.json:9` | c8 thresholds 80/70 below stated mock ≥85% per test plan + memory. 15-point branch gap. |
| 12 | `defaults.json` | 12+ config keys read by code (`keepalive.*`, `claude.defaultTimeoutMs`, `session.summary*`, `ws.*`, `resolver.*`) are not externalized — code-side fallbacks always win. |
| 13 | `eslint.config.js` | Test plan ENG-07 mandates `no-unsafe-optional-chaining`; not enabled. |
| 14 | `Dockerfile:28` | CLI versions unpinned (`@anthropic-ai/claude-code @google/gemini-cli @openai/codex` without version tags). REQ-001 §1.5 violation. |
| 15 | `.dockerignore:7` | `*.png` excludes all `public/*.png`. HF deploys via `git archive` so HF works; local `docker compose up --build` ships an image with no logos and a broken gate background. |
| 16 | `.dockerignore:8` | `*.txt` excludes `tests/fixtures/ansi-auth-url.txt`. |

### Medium (architecture / code quality / drift)

| # | File:Line | Issue |
|---|---|---|
| 17 | `mcp-tools.js:166` | `file_find` arg interpolation. Real bug for `file_type` with spaces/punctuation. Switch to `execFileSync('grep', argv)`. |
| 18 | `routes.js:709-713` | `/api/issues` GraphQL query string concat. Real bug for repo names with `"`. Use GraphQL variables. |
| 19 | `routes.js:715` | Hardcoded `https://api.github.com/graphql` — won't work with GitHub Enterprise. |
| 20 | `src/voice.js` | Dead code (98 lines), uses console.log/console.error. Delete. |
| 21 | `routes.js:71-157` | `_seedRole` belongs in dedicated module; inline `require()` calls for six modules. |
| 22 | `session-utils.js:4-8` | Bypasses factory-DI pattern. |
| 23 | `mcp-tools.js:8-11` | Same. |
| 24 | `qdrant-sync.js:17-20` | Same. |
| 25 | `db.js:14-97` | 20+ try/catch ALTER migrations, no version tracking. Replace with numbered migration runner. |
| 26 | `db.js:259-269` | `migrateTasksToProjectBased` densify pass runs every boot. |
| 27 | `db.js:666` | `reparentTask` creates fresh prepared statement inside transaction. Bypasses cache. |
| 28 | `routes.js:425, 450` | Silent `catch { /* race ok */ }` blocks — log at debug. |
| 29 | `routes.js:376-403` | Order-based session matching fallback is silent — log a warn. |
| 30 | `keepalive.js:11` | `_REFRESH_THRESHOLD` dead variable. |
| 31 | `keepalive.js` (multiple) | 7 config keys read but absent from defaults.json. |
| 32 | `mcp-server.js:67-280` | Tool catalog hardcoded; should import schema array from mcp-tools.js. |
| 33 | `ws-terminal.js:57` | Magic-number prefix slice ties to safe-exec format. Expose `safe.tmuxNamePrefix(name)`. |
| 34 | `routes.js:1244-1368` | `/api/sessions` POST handler is 124 lines doing 8 things. |
| 35 | `routes.js:1574-1584` | `_projectHasRepoPath` sync filesystem walk per task-tree refresh. |
| 36 | `routes.js:1837-1900` | Settings PUT handler mixes provider validation + env update + Codex provider seed + qdrant reapply inline. |
| 37 | `webhooks.js:21-34` | Fire-and-forget webhook dispatch, no retry, no rate-limit. |
| 38 | `kb-watcher.js:44-47` | Single `busy` mutex for both commit and pull; pull starvation risk under sustained commits. |
| 39 | `logger.js:43-66` | Per-line SQLite INSERT, no batching. |
| 40 | `entrypoint.sh:98-101` | Qdrant background launch with no health monitoring. |
| 41 | `public/index.html:1325-1645` | `renderSidebar` 320 lines with state-hash diffing. |
| 42 | `public/index.html:3770` | Save As uses `window.prompt` — violates UI modal pattern (saved-memory feedback). |
| 43 | `public/index.html:1530, 3277, 4392 (etc.)` | `confirm()`/`alert()` for primary CRUD. |
| 44 | `public/index.html:4583, 5853` | Two `escapeHtml` implementations. |
| 45 | `public/index.html` (whole) | 5,908-line single-file frontend; no module boundaries; eslint ignores it. |
| 46 | Cross-cutting | `KB_PATH = '/data/knowledge-base'` hardcoded in 3+ places + frontend. |
| 47 | Cross-cutting | Codex UUID regex duplicated in 6 files. |
| 48 | `scripts/prime-test-session.js` | Stale (wrong API field `prompt`, references `hopper` user). Likely dead. |

### Low (polish / hygiene)

| # | File:Line | Issue |
|---|---|---|
| 49 | `Dockerfile:24` | Qdrant binary URL hardcoded to x86_64 — document or make `$(uname -m)`. |
| 50 | `Dockerfile:43` | Passwordless sudo not documented in README. One-line transparency. |
| 51 | `package.json:21-22` | jQuery + jqueryfiletree dependencies are unused (frontend already replaced). |
| 52 | `eslint.config.js:97` | `public/**` ignored by ESLint. |
| 53 | `tmux-lifecycle.js:96-99` | Per-session `tmuxExists` second pass adds N exec calls per scan. |
| 54 | `mcp-tools.js:319-343` | `session_resume_post_compact` writes to `/tmp` with no cleanup. |
| 55 | `mcp-tools.js:825-875` | `gh_cmd` doesn't validate `command` is `Array<string>`. |
| 56 | `tests/fixtures/` | 5 of 8 documented fixtures missing. |
| 57 | `tests/coverage-results-*.txt` | Transient artifact committed to repo. |
| 58 | `tests/runbook-results-*.md` | 100KB+ runbook results committed; consider `.gitignore`. |
| 59 | `routes.js` (multiple) | Inline `require()` in handler bodies. |
| 60 | `routes.js:1003-1013` | `/api/projects/:name/remove` doesn't cascade tmux/MCP cleanup. |
| 61 | `routes.js:1043-1066` | `/api/programs/:id` PUT name uniqueness without transaction. |
| 62 | `routes.js:1101-1110` | `/api/auth/login` burns Claude tokens running a real `--print test` query. |
| 63 | `routes.js:1284-1289` | Claude `tmpId = new_${Date.now()}` collision risk under rapid creation. |
| 64 | `entrypoint.sh:52-55` | Settings.json initial content duplicates `watchers.js:671`. |
| 65 | `Dockerfile:58-59` | Backwards-compat symlinks need a deprecation timeline. |
| 66 | `safe-exec.js:153-156` | `buildResumeArgs` Gemini branch re-requires already-imported modules. |
| 67 | `tmux-lifecycle.js:13-168` | `_onSessionKilled`/`setOnSessionKilled` exposed but never wired. |
| 68 | `public/index.html` (whole) | Inline `onclick` handlers couple markup to function names — refactors break silently. |

### Trivial

| # | File:Line | Issue |
|---|---|---|
| 69 | `public/gate.html:188` | Hardcoded duplicate-Space ID. |
| 70 | `server.js:29` | PORT default 3000 stale; production is 7860. |
| 71 | `db.js:257` | Misleading catch comment ("tasks table not yet created"). |

---

## Section 12 — What's done well

For balance:

- **Factory-DI wiring in `server.js`** is clean and the dependency graph in the README at L65-79 actually matches what the code does (for the modules it lists).
- **`safe-exec.js` is the cleanest non-leaf module.** Sync/async split is principled and documented. `tmuxNameFor` is the canonical naming function, used everywhere. `sanitizeErrorForClient` regex order is documented with the constraints.
- **`keepalive.js` auth-broken state machine** (L42-72, L97-148) is sophisticated and well-tested code.
- **`ws-terminal.js` auto-respawn machinery** (L35-110) — every race condition has a documented mitigation (in-flight dedup, prefix-collision check, recheck-before-spawn, missing-JSONL refusal, readiness loop).
- **`session-resolver.js` atomic temp→real handoff** (L51-62) uses a transaction so `/api/state` can't observe both rows simultaneously.
- **`qdrant-sync.js`** has multiple textbook patterns: cold-start retry, transient-error classification + backoff, serialized-trailing-apply for settings reapply, mid-scan cancellation via `_running` flag.
- **`git-auth.js`** is the cleanest module overall. Single responsibility, no surprises, `gitAuthArgs` keeps tokens out of remote URLs everywhere.
- **`watchers.js registerCodexProvider/registerCodexAuth`** carefully reverse-engineers Codex CLI quirks (env-key auth, TOML rewriting, pre-seeded auth.json to prevent the 25 MB/sec write storm) with comments that explain why each step exists.
- **`logger.js` retention sweep** correctly aligns the SQLite TEXT timestamp comparison format with the inserted format (db.js comment at L391-395 explains the bug that motivated the alignment).
- **The `/health` endpoint** (`routes.js:2331-2360`) correctly distinguishes block-503 dependencies (db, workspace) from informational ones (auth). Matches the README claim.
- **The `safe.tmuxCaptureScrollback` + WebSocket replay pattern** for tab reconnects (#241) preserves the user's scrollback across server restarts. Genuine engineering.
- **The frontend's xterm CSI handler registration** (L2003-2007) blocks mouse-tracking sequences from CLIs so native browser selection works. Sophisticated handling of an upstream quirk.
- **The frontend's optimistic-mutation lock pattern** (L1671-1716) handles slow `/api/state` polls correctly even though it adds complexity.
- **Atomic write in `statusline-collector.js` (L43-50)** prevents partial-file reads.

---

## Closing

The codebase has the unmistakable shape of a project that was prototyped fast, then incrementally hardened — every comment block (`#147`, `#156`, `#161`, `#181`, `#212`, `#241`, `#286`, `#287`, `#310`, `#317`) cites the issue that motivated the surrounding code. That's healthy. The hardening is real and visible.

What's missing is the next refactor pass: the two largest files (`routes.js`, `public/index.html`) and the three DI-bypassing modules (`session-utils.js`, `mcp-tools.js`, `qdrant-sync.js`) accumulated more than they should have. The schema migrations are growing fragile. The README has drifted out of sync. The path-encoding bug at `routes.js:2165` is real today and silently misroutes session-file lookups for any project name with a `.` or `~` in it.

Start with the High tier in Section 11 — it's correctness and architecture work, and it's where daily friction lives. The Medium tier is the next-pass cleanup. The trust model in Section 8.1 is the answer to anything that looks security-shaped: the gate is the boundary, the user past it is trusted, and code inside that boundary is judged on robustness and clarity, not on adversary models.

— end of review
