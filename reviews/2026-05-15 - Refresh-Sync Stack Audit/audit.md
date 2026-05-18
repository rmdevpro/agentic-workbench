# Refresh / Sync Stack Audit — #485

**Date:** 2026-05-15
**Branch:** `milestone/01-stabilization`
**Author (engineer):** dispatched on Phase B-2 per PM reviewer Q2 quorum
**Status:** Research deliverable. Findings filed as separate `code-task` issues, listed below.

---

## Purpose

The Workbench's refresh / sync mechanisms were each added in response to a specific problem and never reviewed as a system. This audit answers the 8 questions in #485 and files concrete follow-ups for each defect that warrants its own issue. The audit is a snapshot at the milestone `01-stabilization` HEAD on 2026-05-15.

## Methodology

Static code reading of the refresh/sync surfaces; no runtime profiling. The reading covered:

- **Server-side sources:** `src/watchers.js`, `src/kb-watcher.js`, `src/qdrant-sync.js`, `src/keepalive.js`, `src/ws-terminal.js`
- **Client-side sources:** `public/js/app.js` (timers + error/auth banners + token poll), `public/js/sidebar.js` (`loadState`), `public/js/tabs.js`, `public/js/file-tree.js`, `public/js/tasks.js`, `public/js/issue-picker.js`, `public/js/terminal.js`
- **Cross-reference:** `tests/mock/` for what's pinned, `tests/live/` for what's exercised end-to-end

Where the audit references "the bug," it is #483 (scrollback corruption) — the bug that motivated #485 alongside #484 (typing pauses).

---

## Findings inventory

| ID    | Severity | Summary                                                                                 | Filed as                       |
|-------|----------|-----------------------------------------------------------------------------------------|--------------------------------|
| F-1   | High     | Sidebar `renderSidebar()` rebuilds full DOM under each loadState diff — main-thread jank | #585 (`source=engineer`)        |
| F-2   | Medium   | Per-session `fs.watchFile(..., {interval: 2000})` scales linearly with session count    | #586 (`source=engineer`)        |
| F-3   | Medium   | Client 10s `loadState` poll does not pause/reset on WS state-changing events            | #587 (`source=engineer`)        |
| F-4   | Low      | Two parallel credentials watchers in `keepalive.js` (`_credsWatchTimer`, `_geminiCredsWatchTimer`) | #588 (`source=engineer`)        |
| F-5   | Low      | No documented ordering contract on WS reconnect (partially codified by #483)            | #589 (`source=engineer`)        |
| F-6   | Info     | Render-hash short-circuit in `renderSidebar` is a good pattern — adopt elsewhere        | Documentation finding (no issue)|

#483 (scrollback race vs xterm cols) is the original motivating bug and was resolved in this same dispatch — this audit confirms the fix shape addresses Q7 (reconnect ordering) in addition to Q2.

---

## Q1: Does `/api/state` polling block the main thread on the response handler?

**Yes — when the state diff is non-trivial.**

`public/js/sidebar.js` `loadState()` (line 384) does the following synchronously on each successful response:

1. Walk `data.projects` and apply pending edits + hydration cache lookups (~O(projects × sessions)).
2. `setProjectState(data.projects)` + `setProgramState(data.programs)` — refs swap, cheap.
3. Tab-resolution loop for `new_*` tab IDs (O(open tabs × projects × sessions per project)).
4. `renderSidebar()` — when `stateHash` differs, rebuilds the sidebar's container `innerHTML` with the new project/program/session tree (the file has 18 references to `renderSidebar` / `innerHTML`-style DOM ops on the sidebar surface).
5. `_hydrateVisibleSessionInfo()` — schedules per-visible-session `/api/sessions/:id/info` fetches.

The render-hash short-circuit at line 94 (`if (stateHash === renderSidebar._lastHash && container.childElementCount > 0) return;`) is a good optimization — when nothing changed, the rebuild is skipped. When the hash DOES differ (a real state change), the synchronous full-rebuild can stall user typing. #484 is the user-visible symptom of this stall.

**Finding F-1 (HIGH):** the full-rebuild on diff is the wrong primitive at the scale of dozens of sessions + multiple programs. Replace with diff-based DOM updates (add / remove / reorder children, mutate text content in-place). Filed as a new issue.

## Q2: Does scrollback replay run before xterm.js has reported its current `cols`?

**Yes — pre-fix. Resolved this milestone in #483.**

Pre-fix flow: server captured the tmux pane at its last-known cols (which could differ from the client's xterm), sent the bytes, then spawned the PTY at a hardcoded `cols: 120, rows: 40` — and the client only sent its real dims AFTER `ws.onopen` fitted the terminal. The captured bytes therefore encoded visual layout for one cols width while xterm rendered them at another → progressive indent + reshuffle.

Fix (#483 commit `2857322`): client now appends `?cols=X&rows=Y` to the WS URL using `fitAddon.proposeDimensions()` before `new WebSocket(...)`; server parses those into `initialDims`; `handleTerminalConnection` issues `tmux resize-window -t <session> -x cols -y rows` BEFORE `tmuxCaptureScrollback`, then spawns the PTY at the matching dims (no longer hardcoded). Resize failure is non-fatal. Missing dims fall back to historical 120x40.

No follow-up filed for Q2 (the resolution is in this milestone).

## Q3: Are watcher signals debounced and de-duplicated?

**Partially.**

- **`kb-watcher.js`**: chokidar fires events; coalesced via a single `debounceMs` (default 8000ms, line 46). Good. The `_periodicPull` (line 334) and `_syncFromOrigin` (line 345) timers add separate axes but they don't compose with the chokidar debounce.
- **`qdrant-sync.js`**: `_debounceTimer` at line 1005 coalesces re-index requests. Good.
- **`watchers.js`**: uses `fs.watchFile(..., { interval: 2000 })` per-session for Claude JSONL transcripts (line 33) and per-settings file (line 152, 5000ms). NO debouncing inside the watch callback — every poll-tick that detects an mtime change triggers the side-effect. For JSONL files that flush every few seconds during an active CLI session, this is fine; but for many simultaneous sessions the wakeup count adds up.

**Finding F-2 (MEDIUM):** consolidate the per-session JSONL `fs.watchFile` polls into a single chokidar watcher on the parent directory. Re-use the kb-watcher's debounce shape. Filed as a new issue.

## Q4: Are server-pushed updates duplicated by client polling?

**Yes — and the polling is not paused after a push.**

- Server pushes:
  - `token_update` (WS message, `public/js/terminal.js:90`) → client triggers `_loadStateRef()` via a 2s timeout (line 95). So WS push → loadState. Good.
  - `settings_update` (WS message, line 98) → updates `tab._settingsData`, no loadState trigger.
- Client polls:
  - `loadState()` every 10s unconditionally (`setInterval(loadState, REFRESH_MS)` at `app.js:2013`).

When a `token_update` WS message arrives, loadState fires within ~2s. The 10s baseline poll continues independently — so the next baseline tick may fire ~8s later, doing redundant work. There is no mechanism to reset the 10s timer after a WS-triggered loadState.

**Finding F-3 (MEDIUM):** when a WS message triggers loadState, reset the 10s baseline timer so the next tick is ~10s later, not whenever the original setInterval was due. Filed as a new issue.

## Q5: Are there synchronous DOM passes that could be async, virtualized, or diffed?

**Yes — primarily the sidebar rebuild.**

Concrete instances:
- `renderSidebar` in `public/js/sidebar.js` is the biggest one (see Q1 / F-1).
- `renderTabs` in `public/js/tabs.js` calls `_renderOneTabBar` for primary + side panels, each doing `bar.innerHTML = ''; for (...) bar.appendChild(...)`. With 5-10 tabs per panel the cost is negligible; at 30+ tabs the rebuild starts to show.

`renderSidebar` is the dominant culprit. `renderTabs` is not currently a bottleneck but would benefit from the same diff treatment if tab counts grow.

Subsumed under F-1.

## Q6: Are polling intervals tuned together or each picked independently?

**Independently. Concrete values found:**

| Source                                         | Interval        | Configurable? |
|------------------------------------------------|-----------------|---------------|
| Client `loadState`                              | 10 000 ms      | `REFRESH_MS` const, hardcoded |
| Client `checkAuth`                              | 60 000 ms      | hardcoded |
| Client `checkErrors`                            | 60 000 ms      | hardcoded |
| Client `pollTokenUsage` (post-session-create)   | 3 000 ms × 30s | hardcoded |
| Server `watchers.js` JSONL `fs.watchFile`        | 2 000 ms (per session) | hardcoded |
| Server `watchers.js` settings `fs.watchFile`     | 5 000 ms      | hardcoded |
| Server `kb-watcher` chokidar debounce           | 8 000 ms      | `kb.debounceMs` |
| Server `kb-watcher` periodic pull               | `pullIntervalMs` | configurable |
| Server `keepalive` claude creds poll            | (varies)       | configurable |
| Server `keepalive` gemini creds poll            | (varies)       | configurable |
| Server `qdrant-sync` background retry           | (interval)     | configurable |

No central policy or coordination. Cumulative wakeups are not tracked. This is a code-smell rather than a defect — but the un-tuned client baseline of 10s/60s/60s feels picked-by-feel, not by measurement.

No standalone issue filed — F-3 already covers the dominant client-side concern (paused-on-WS-push); the rest is acceptable for now.

## Q7: What's the ordering contract on reconnect?

**Now partially codified by #483.**

Pre-#483 the ordering was: capture → spawn-PTY-at-120x40 → client-resize. Implicit, undocumented, racy.

Post-#483 it is: client-passes-dims-in-URL → server-resize-tmux → capture → spawn-PTY-at-dims. The ordering is now load-bearing for correctness, but there is no comment at the file header documenting the full lifecycle.

**Finding F-5 (LOW):** add a comment block at the top of `src/ws-terminal.js` documenting the WS connection lifecycle from upgrade through resize/capture/spawn so the contract is visible at the top of the file instead of having to be reverse-engineered from the function body. Filed as a new issue.

## Q8: Are any of these paths effectively dead code or vestigial?

**Likely yes, but the audit was not deep enough to be certain.**

Plausible candidates worth a follow-up read (NOT confirmed dead):

- `src/watchers.js` `fs.watchFile` settings polling at 5s (line 152) — possibly redundant with `_settingsCache` invalidation paths in client code, but the data-flow wasn't traced end-to-end.
- `pollTokenUsage` post-create burst (`setInterval(... 3000); setTimeout(... 30000)`) — was likely added to surface initial tokens quickly; once `token_update` WS messages started flowing reliably (#370-#372 era), the burst may be obsolete.

No issue filed — these are speculative.

---

## Documentation finding F-6 (info only, no issue)

The render-hash short-circuit at `public/js/sidebar.js:94` (`if (stateHash === renderSidebar._lastHash && container.childElementCount > 0) return;`) is a good pattern: cheap hash compute, exit-early when nothing changed. The same pattern would help in any other "rebuild on every poll" surface. Worth highlighting in a future engineering doc / `README.md` "patterns" section once Tech Writer engages.

---

## Filed follow-up issues

Five `code-task` issues filed against milestone `01-stabilization` with `source=engineer` label, filed immediately before this audit was committed:

- F-1 → #585 (HIGH) — `renderSidebar` full-rebuild → diff-based DOM updates
- F-2 → #586 (MEDIUM) — consolidate per-session `fs.watchFile` into one chokidar watcher
- F-3 → #587 (MEDIUM) — reset 10 s baseline poll on WS-triggered loadState
- F-4 → #588 (LOW) — consolidate two credentials watchers in `keepalive.js`
- F-5 → #589 (LOW) — document WS reconnect lifecycle ordering at top of `src/ws-terminal.js`

F-6 (render-hash short-circuit pattern) is a documentation finding — picked up by Tech Writer if/when a "patterns" section lands in the README or a new ENG-* engineering doc.

## Cross-references

- `#483` — terminal scrollback corruption (motivating bug, fixed this milestone)
- `#484` — typing pauses / cursor stalls (subsumed by F-1)
- `#564` — sidebar auto-refresh recovery (Phase B-2, fixed this milestone — adjacent to but not the same as the F-3 polling concern)
- This audit lives at `reviews/2026-05-15 - Refresh-Sync Stack Audit/audit.md` per the dispatch instruction.
