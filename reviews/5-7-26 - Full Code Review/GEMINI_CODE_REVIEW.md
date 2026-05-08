# Agentic Workbench: Exhaustive Granular Code Review

## Introduction and Methodology
This document represents a comprehensive, line-by-line architectural and implementation audit of the `agentic-workbench` repository. The goal is to provide a complete dissection of the system's technical debt, vulnerabilities, and failing test suites, accompanied by actionable refactoring strategies.

## Part 1: The Frontend Monolith (`public/index.html`)

### 1.1 Overview and Scale
At **5,909 lines**, the `public/index.html` file is the largest single point of technical debt in the application. It eschews modern frontend build processes (Webpack, Vite) and component frameworks (React, Vue) in favor of a massive, single-file Vanilla JavaScript implementation. This creates severe maintainability bottlenecks, global scope pollution, and DOM-thrashing performance issues.

### 1.2 Global Namespace Pollution
The application state is managed entirely through global, mutable variables declared at the top of the `<script>` block.

```javascript
// public/index.html (Lines 2400-2415)
let projectState = [];
let activeTabId = null;
let activeTabSideId = null;
const tabs = new Map();
let sidePanelOpen = false;
let sidePanelWidth = parseInt(localStorage.getItem('sidePanelWidth')) || 400;
let focusedPanel = 'primary';
let _fileBrowserTree = null;
let selectedUploadDir = null;
let authModalVisible = false;
let authTriggerTabId = null;
let ptyOutputBuffer = new Map();
```

**Deep Analysis:**
1.  **Unprotected Mutability:** Because variables like `activeTabId` and `focusedPanel` are `let` declarations in the global scope, any function can mutate them. The `switchTab()` function mutates `activeTabId`, while `moveTabToPanel()` mutates `tabPanelAssignments` and then calls `switchTab()`. This lack of unidirectional data flow means that tracking state changes requires tracing arbitrary event listeners across thousands of lines.
2.  **Memory Leaks in `tabs` Map:** The `tabs` Map holds references to heavy objects, including the `xterm.js` Terminal instances, WebSocket connections, and DOM element references (`paneEl`). If `closeTab()` fails to correctly dispose of all nested event listeners (e.g., `term.onResize`), the entire tab object will be retained in memory, causing a severe memory leak over long sessions.
3.  **Remediation:** Introduce a structured state container. Even without a framework, state should be encapsulated:
    ```javascript
    class WorkbenchState {
      constructor() {
        this.tabs = new Map();
        this.activeTab = { primary: null, side: null };
        this.listeners = [];
      }
      subscribe(fn) { this.listeners.push(fn); }
      setActiveTab(panel, id) {
        this.activeTab[panel] = id;
        this.listeners.forEach(l => l());
      }
    }
    const store = new WorkbenchState();
    ```

### 1.3 Optimistic UI Desynchronization
The application uses a polling mechanism (`loadState()`) to fetch data from `/api/state` every few seconds. However, it also attempts optimistic UI updates for user actions.

```javascript
// public/index.html (Lines 2540-2565) - archiveSession()
async function archiveSession(sessionId, archived) {
  let foundSession = null;
  for (const p of projectState) {
    const s = p.sessions?.find(s => s.id === sessionId);
    if (s) { foundSession = s; break; }
  }
  const before = foundSession ? { state: foundSession.state, archived: !!foundSession.archived } : null;
  const newState = archived ? 'archived' : 'active';
  
  if (foundSession) {
    foundSession.state = newState;
    foundSession.archived = !!archived;
  }
  _pendingSessionEdits.set(sessionId, { state: newState, archived: !!archived });
  renderSidebar(); // Optimistic render

  try {
    const res = await fetch(`/api/sessions/${sessionId}/archive`, { ... });
    if (!res.ok) throw new Error();
    setTimeout(() => _pendingSessionEdits.delete(sessionId), PENDING_LOCK_MS);
  } catch (err) {
    if (foundSession && before) {
      foundSession.state = before.state;
      foundSession.archived = before.archived;
    }
    _pendingSessionEdits.delete(sessionId);
    renderSidebar(); // Rollback render
  }
}
```

**Deep Analysis:**
1.  **The Polling Collision:** The core flaw is the collision between `loadState()` and `archiveSession()`. If `loadState()` completes a network request *after* `archiveSession()` has mutated `projectState` but *before* `archiveSession()` finishes its own network request, the old server state will overwrite the optimistic UI state.
2.  **The Brittle Lock:** The developer attempted to fix this by introducing `_pendingSessionEdits` and `PENDING_LOCK_MS`. The `renderSidebar()` function checks this map before rendering. However, relying on a hardcoded timeout (`PENDING_LOCK_MS`) to clear optimistic state is fundamentally flawed. If the server takes longer than the lock time to process the request, the UI will jitter back to the old state before jumping to the new state.
3.  **Remediation:** Replace polling with WebSockets for real-time state synchronization, or adopt a robust asynchronous state manager (like TanStack Query logic ported to vanilla JS) that handles query invalidation and optimistic mutation rollbacks automatically based on Promise resolution, not arbitrary timeouts.

### 1.4 DOM Layout Thrashing (`switchTab`)
Managing terminal visibility is complex because `xterm.js` uses a `<canvas>` element that cannot calculate its dimensions if its parent is `display: none`.

```javascript
// public/index.html (Lines 2100-2130) - switchTab()
if (tab.type === 'file') {
  if (tab.editor && tab.editor.focus) tab.editor.focus();
} else if (tab.fitAddon) {
  // Force an unconditional xterm redraw AFTER the browser has committed
  // the display:none->block transition...
  requestAnimationFrame(() => {
    const t = tabs.get(tabId);
    if (!t || !t.term || !t.term.rows) return;
    try { t.term.refresh(0, t.term.rows - 1); } catch { /* ignore */ }
    if (t.fitAddon) t.fitAddon.fit();
  });
  setTimeout(() => { const t = tabs.get(tabId); if (t?.fitAddon) t.fitAddon.fit(); }, 300);
  tab.term.focus();
}
```

**Deep Analysis:**
1.  **The `display: none` Trap:** When a user clicks a different tab, the code removes the `.active` CSS class from the current pane and adds it to the new pane. The `.active` class toggles `display: none` to `display: block`.
2.  **Forced Reflows and Layout Thrashing:** Because the browser must recalculate the CSS Object Model (CSSOM) and layout tree, `xterm.js` cannot immediately determine how many rows/cols fit in the container. The code uses `requestAnimationFrame` to wait for the next render tick, then calls `.fit()`. 
3.  **The 300ms Hack:** The code *also* sets an arbitrary 300ms `setTimeout` to call `.fit()` again. This proves that `requestAnimationFrame` alone was failing to catch the layout resolution on some clients. This double-fitting causes visible visual "jumping" when switching tabs.
4.  **Remediation:** Never use `display: none` for heavy canvas/WebGL components. Instead, use absolute positioning to move inactive tabs off-screen:
    ```css
    .terminal-pane {
      position: absolute;
      top: -9999px;
      visibility: hidden;
    }
    .terminal-pane.active {
      position: relative;
      top: 0;
      visibility: visible;
    }
    ```
    This preserves the layout bounding box, allowing `xterm.js` to measure itself instantly without `setTimeout` hacks.

### 1.5 Brittle OAuth Stream Extraction
The frontend attempts to detect Hugging Face, Claude, and Gemini authentication URLs by intercepting the raw terminal output stream.

```javascript
// public/index.html (Lines 4800-4820)
function checkForAuthIssue(tabId, data) {
  const buf = (ptyOutputBuffer.get(tabId) || '') + data;
  ptyOutputBuffer.set(tabId, buf.slice(-4000)); // keep last 4KB

  const fullBuf = ptyOutputBuffer.get(tabId);
  // Strip ANSI escapes for reliable text matching
  const cleanBuf = fullBuf.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x07]/g, '');

  for (const pattern of OAUTH_URL_PATTERNS) {
    const urlStart = cleanBuf.indexOf(pattern.start);
    if (urlStart === -1) continue;

    const pasteIdx = cleanBuf.indexOf(pattern.endMarker, urlStart + 50);
    if (pasteIdx === -1) continue; // URL not fully received yet

    const rawUrl = cleanBuf.substring(urlStart, pasteIdx);
    const cleanUrl = rawUrl
      .replace(/[\x00-\x1f]/g, '')
      .replace(/\s+/g, '')
      .replace(/[&?]+$/, '');

    showAuthModal(cleanUrl, tabId);
    ptyOutputBuffer.delete(tabId);
    return;
  }
}
```

**Deep Analysis:**
1.  **Main Thread Blocking:** Running a complex regular expression (`/\x1b\[[0-9;]*[a-zA-Z]/g`) on a 4KB string every time a WebSocket frame arrives runs synchronously on the main UI thread. During a fast `cat` command or large LLM output, this will cause significant frame drops and input lag.
2.  **String Matching Fragility:** The logic relies on exact substring matching of `endMarker` text (e.g., `"Paste"`, `"Enter the authorization code"`). If Anthropic or Google update their CLI to output "Please paste the code", the entire authentication flow for the Workbench fails silently.
3.  **Remediation:** The backend `ws-terminal.js` should perform this parsing using a lightweight state-machine parser in a Node.js worker thread, emitting a structured `{ type: "auth_required", url: "..." }` JSON message to the frontend, removing the regex burden from the browser.

### 1.6 Custom FileTree Component
The developer replaced a legacy `jqueryFileTree` with a custom vanilla JS implementation (`createFileTree()`).

**Deep Analysis:**
1.  The `diffChildren()` function is a manual implementation of a Virtual DOM reconciliation algorithm. It walks the DOM, compares `dataset.path` against a `freshEntries` list, and manually calls `rowEl.remove()` or `insertAfter.after(row)`.
2.  This requires tracking expanded state manually in `state.expandOrder`. 
3.  While it removes the jQuery dependency, it introduces 300 lines of highly complex, error-prone DOM manipulation logic. A modern UI library (like `lit-html` or a lightweight Preact wrapper) would reduce this to a simple reactive template.


---

## Part 2: The Routing Monolith (`src/routes.js`)

### 2.1 File Size and Scope
At **2,371 lines**, `routes.js` represents the single largest architectural bottleneck on the backend. It violates the Single Responsibility Principle (SRP) by serving as the HTTP router, the business logic controller, the database orchestrator, and the CLI process manager simultaneously. It registers over 45 distinct endpoints.

### 2.2 Deep Procedural Coupling (Session Creation)
The endpoint to start a new AI session (`POST /api/sessions`) is massively overloaded. It spans nearly 150 lines and contains deep implementation details about specific third-party CLI tools.

```javascript
// src/routes.js (Lines 1150-1200) - Session Creation Excerpt
app.post('/api/sessions', async (req, res) => {
  const { project, cli = 'claude', command, hidden } = req.body;
  
  // [50 lines of path resolution and project directory setup omitted]
  
  let tmuxCmd;
  if (cli === 'claude') {
    tmuxCmd = `claude -p "${projPath}"`;
    // Add custom command context
    if (command) {
      const escapedCmd = command.replace(/"/g, '\\"');
      tmuxCmd += ` -p "${escapedCmd}"`;
    }
    // [Seeding logic for CLAUDE.md]
  } else if (cli === 'gemini') {
    tmuxCmd = `gemini --workspace "${projPath}"`;
  } else if (cli === 'codex') {
    tmuxCmd = `codex --dir "${projPath}"`;
  } else if (cli === 'bash') {
    tmuxCmd = `bash`;
  }

  const tmuxName = `wb_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  // Event Loop Blocking Exec
  execSync(`tmux new-session -d -s ${tmuxName} -c "${projPath}" '${tmuxCmd}'`);
  
  const workbenchSessionId = uuidv4();
  db.addSession(workbenchSessionId, project, name, cli);
  // ...
});
```

**Deep Analysis:**
1.  **SRP Violation:** The HTTP router is tightly coupled to the exact argument flags required by `claude`, `gemini`, and `codex`. If Google releases a new version of the Gemini CLI that changes `--workspace` to `--dir`, the HTTP router file must be modified. 
2.  **Event Loop Blocking (`execSync`):** The use of `child_process.execSync` to spawn the `tmux` session is a critical performance flaw. While `tmux new-session` is usually instantaneous, if the host OS is under heavy I/O load, `execSync` will halt the entire Node.js event loop. During this stall, all other connected users will miss their WebSocket heartbeat pings and be disconnected.
3.  **Remediation:** 
    *   **Extraction:** Move the CLI flag logic into a `Strategy` pattern (e.g., `ClaudeCliStrategy`, `GeminiCliStrategy`).
    *   **Asynchronous Spawning:** Replace `execSync` with `util.promisify(child_process.exec)` to allow other requests to process while the OS spawns the tmux daemon.

### 2.3 Complete Lack of Schema Validation
The vast majority of `POST` and `PUT` endpoints read directly from `req.body` and pass the data directly to the database or processing layers.

```javascript
// src/routes.js - POST /api/tasks
app.post('/api/tasks', async (req, res) => {
  try {
    const { project_id, parent_task_id, title, description, status, github_issue } = req.body;
    
    // The only validation in the entire endpoint
    if (!title || title.length > TASK_TITLE_MAX_LEN) {
      return res.status(400).json({ error: 'Title is required and must be under ' + TASK_TITLE_MAX_LEN });
    }
    
    const id = db.addTask({
      project_id, parent_task_id, title, description, status, github_issue
    });
    res.json({ id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

**Deep Analysis:**
1.  **Structural Vulnerability:** There is no type checking. If a malicious or buggy client sends `project_id: { $gt: 1 }` (an object) instead of an integer, the backend passes this object directly into the SQLite driver. While `better-sqlite3` prevents SQL injection via parameterized queries, it will throw a raw database constraint error, which is then sent back to the client as a `500 Internal Server Error` (or `400` in the catch block).
2.  **Enum Violations:** The `status` field is not checked against an allowed list of enums (e.g., `open`, `in_progress`, `done`). An API client can insert garbage strings into the database, which will then break the frontend's hardcoded status colors.
3.  **Remediation:** Introduce `Zod` middleware for all endpoints.
    ```javascript
    const TaskSchema = z.object({
      project_id: z.number().int().positive(),
      parent_task_id: z.number().int().positive().nullable().optional(),
      title: z.string().min(1).max(500),
      status: z.enum(['open', 'in_progress', 'blocked', 'done']),
      github_issue: z.string().optional()
    });

    // In routes:
    app.post('/api/tasks', validate(TaskSchema), async (req, res) => { ... });
    ```

### 2.4 Unused Validation Constants
```javascript
// src/routes.js (Lines ~40-50)
const PROMPT_MAX_LEN = 50000;
const MESSAGE_CONTENT_MAX_LEN = 100000; // Unused variable
const SEARCH_QUERY_MAX_LEN = 200;
const TASK_TITLE_MAX_LEN = 500;
const TASK_DESC_MAX_LEN = 10000;
const TASK_FOLDER_MAX_LEN = 1000; // Unused variable
const NOTES_MAX_LEN = 100000;
```

**Deep Analysis:**
The linter identified `MESSAGE_CONTENT_MAX_LEN` and `TASK_FOLDER_MAX_LEN` as unused. This indicates that whatever validation logic was originally written to bound the size of message content or folder strings has been accidentally removed or bypassed during a refactor. This exposes the application to Denial of Service (DoS) attacks if a client sends a 1GB string as message content.

### 2.5 Security: Traversal and Authentication
*   **Strengths:** The `resolveWorkspacePath` helper correctly restricts file system operations to the workspace boundary. The `authMode` gate in `server.js` correctly intercepts routes.
*   **Design Choice (AD-001):** The `/api/file` and `/api/files/list` endpoints intentionally allow full read/write access to anything inside `/data/workspace`. While secure against external escape (e.g., `/etc/passwd`), users must understand that *any* agent or script executed within this workspace has total authority over all other projects in the workspace.

### 2.6 Refactoring Plan for `routes.js`
To restore maintainability, `routes.js` must be dismantled:
1.  **Create Domain Routers:** Split into `src/routes/api-projects.js`, `src/routes/api-sessions.js`, `src/routes/api-tasks.js`, `src/routes/api-files.js`, and `src/routes/api-settings.js`.
2.  **Extract Services:** Move the CLI seeding heuristics (`_matchFromList`, `_seedRole`) into `src/services/session-seeder.js`. Move the `tmux` spawning logic into `src/services/tmux-manager.js`.
3.  **Inject Dependencies:** Ensure the sub-routers receive `db`, `logger`, and `config` as arguments from `server.js` rather than `require()`-ing them directly, restoring the dependency injection container.

---

## Part 3: Database, State, & Background Jobs

### 3.1 Database Engine & Schema (`src/db.js`)
The application uses `better-sqlite3` configured in WAL (Write-Ahead Logging) mode. This is the optimal configuration for a Node.js web server, as it allows concurrent reads while writes are occurring, preventing database locks during heavy API traffic.

#### 3.1.1 The Task V2 System (Strengths)
The most sophisticated part of the database schema is the "Task V2" implementation, which supports nested subtasks and manual ordering.

```javascript
// src/db.js - densifyProjectTaskRanks()
function densifyProjectTaskRanks(projectId, parentTaskId) {
  const tasks = stmts.getTasksForDensify.all(projectId, parentTaskId || null);
  let rank = 1;
  const updates = [];
  for (const t of tasks) {
    if (t.rank !== rank) {
      updates.push({ id: t.id, rank });
    }
    rank++;
  }
  if (updates.length > 0) {
    const updateStmt = db.prepare('UPDATE tasks SET rank = ? WHERE id = ?');
    const tx = db.transaction((list) => {
      for (const u of list) updateStmt.run(u.rank, u.id);
    });
    tx(updates);
  }
}
```

**Deep Analysis:**
This is an excellent piece of defensive engineering. Because users can arbitrarily delete tasks or move them between projects via drag-and-drop, the numerical `rank` field can develop gaps (e.g., 1, 2, 5, 8). This `densify` function runs on boot and after major mutations to recalculate all ranks sequentially, ensuring predictable UI sorting and preventing edge cases where new tasks are inserted into gaps.

#### 3.1.2 The Critical State API Bug (`getAllPrograms`)
The mock test suite (`npm run test`) currently fails 16 tests. The most critical failure is:
`TypeError: db.getAllPrograms is not a function`

**Deep Analysis:**
1.  **The Reality:** The function `getAllPrograms(filter = 'active')` *is* correctly implemented and exported in `src/db.js`. The real application does not crash.
2.  **The Test Failure:** The failure occurs in `tests/mock/routes.test.js`. When running mock tests, the `routes` module is injected with a mock `db` object (likely defined in `tests/fixtures/test-data.js` or directly in the test file). A recent commit added the concept of "Programs" to the UI and updated the real `db.js`, but the developer forgot to update the mock database object. When the `GET /api/state` route is hit during the test, it calls `db.getAllPrograms()`, which is undefined on the mock, crashing the test suite.
3.  **Remediation:** Locate the `db` mock definition in the `tests/mock/` directory and add `getAllPrograms: () => []` to the stub object.

#### 3.1.3 The JSON-Stringified Settings Anti-Pattern
The database stores global settings as key-value pairs (TEXT, TEXT). 

```javascript
// src/db.js
getSetting(key, defaultVal = null) {
  const row = stmts.getSetting.get(key);
  if (!row) return defaultVal;
  return row.value;
}
```

**Deep Analysis:**
The application stores complex data structures like `git_accounts` and `webhooks` as stringified JSON arrays inside the `settings` table.
*   **Relational Bypass:** By stuffing JSON into a TEXT column, you cannot leverage SQLite's `WHERE` clauses to query specific git accounts. You must `SELECT` the massive JSON blob, `JSON.parse` it in Node, search it in memory, modify the array, `JSON.stringify` it, and `UPDATE` the row.
*   **Lost Update Anomaly:** If two API requests (e.g., `POST /api/webhooks` and `DELETE /api/webhooks/:id`) execute simultaneously, they will both read the same JSON array, mutate it independently, and write it back. Whichever request finishes last will blindly overwrite the first request's changes.
*   **Remediation:** Create dedicated SQL tables: `CREATE TABLE git_accounts (id INTEGER PRIMARY KEY, path TEXT, token TEXT, ...);`

---

### 3.2 Vector Search Sync (`src/qdrant-sync.js`)
This module watches the filesystem and synchronizes workspace files and session transcripts into a Qdrant vector database for semantic search.

#### 3.2.1 Incremental Syncing (Strengths)
```javascript
// src/qdrant-sync.js
// Only embed new lines of JSONL transcripts
const lines = content.split('\n');
const newLines = lines.slice(lastLineProcessed);
```
**Deep Analysis:**
Rather than re-embedding entire conversation transcripts every time a single word is generated, the sync engine tracks the last line processed. When a JSONL file grows, it only chunks and embeds the *delta*. This represents massive cost savings for LLM embedding APIs and significantly reduces CPU overhead.

#### 3.2.2 Event-Loop Blocking Memory Vulnerability
```javascript
// src/qdrant-sync.js
async function syncFileToCollection(filePath, collectionName) {
  const stat = fs.statSync(filePath);
  if (stat.size > 10 * 1024 * 1024) return; // Skip files > 10MB

  // FATAL FLAW HERE
  const content = fs.readFileSync(filePath, 'utf8');
  const chunks = chunkText(content, 1000);
  
  for (const chunk of chunks) {
    const vector = await getEmbedding(chunk);
    // ... batch upsert
  }
}
```

**Deep Analysis:**
1.  **Synchronous I/O:** `fs.readFileSync` blocks the Node.js event loop completely. If the file is 9.9MB, Node.js stops processing all HTTP requests and WebSocket frames until the disk read finishes.
2.  **Memory Spikes (OOM Risk):** Reading a 9MB file into memory produces a 9MB V8 string. The `chunkText` function then splits this string into thousands of smaller strings, creating a massive duplicate footprint in the V8 heap. This will trigger severe garbage collection pauses, causing the UI to stutter, and on memory-constrained systems, will cause an Out-Of-Memory (OOM) crash.
3.  **Remediation:** Refactor to use `fs.createReadStream` combined with the `readline` module or an asynchronous chunking generator to process the file piece-by-piece without loading it entirely into RAM.

---

### 3.3 Session Resolution (`src/session-resolver.js`)
This module maps internal Workbench IDs to CLI internal UUIDs.

**Deep Analysis (Polling Race Condition):**
Because CLI agents do not push their generated IDs back to the workbench on startup, the resolver relies on a `setInterval` that polls the `.claude/` or `.gemini/` directories every 2 seconds. It uses `fs.readdir` and sorts files by `mtime` to find the newest transcript.

If two users (or automated tests) spawn two Claude sessions within the same 2-second window in the same project, the resolver has no deterministic way to link the JSONL files to the correct UI tabs. The `mtime` sort is a best-effort heuristic that breaks under concurrency. The ideal solution is to inject an environment variable (`WORKBENCH_SESSION_ID`) into the CLI launch command and modify the CLI tools to echo this ID in their first log line.

---

## Part 4: MCP Integration & Test Suite Degradation

### 4.1 MCP Server Integration (`src/mcp-tools.js`)
The Model Context Protocol (MCP) server allows the AI agents running inside `tmux` to interact with the workbench itself (e.g., reading files, manipulating tasks, creating new sessions). It exposes over 44 tools.

#### 4.1.1 Security Sandboxing (Strengths)
```javascript
// src/mcp-tools.js
function resolveWorkspacePath(p) {
  const resolved = resolve(WORKSPACE, p || '.');
  if (!resolved.startsWith(WORKSPACE)) {
    throw new Error('Path resolves outside workspace boundaries');
  }
  return resolved;
}
```
**Deep Analysis:**
The use of `path.resolve` combined with a strict `.startsWith` check on the canonical workspace root is the correct pattern to prevent Directory Traversal attacks (e.g., `../../../etc/passwd`). Because this function is uniformly applied to all `file_*` tools, the agents are securely sandboxed to the project directory.

#### 4.1.2 Event Loop Starvation Vulnerability
```javascript
// src/mcp-tools.js - mcp_workbench_file_find implementation
const { execSync } = require('child_process');

function fileFindTool(args) {
  const pattern = args.pattern;
  // FATAL FLAW HERE
  const stdout = execSync(`grep -rn "${pattern}" .`, { cwd: WORKSPACE, encoding: 'utf8' });
  return parseGrepOutput(stdout);
}
```

**Deep Analysis:**
1.  **Denial of Service Vector:** The `mcp_workbench_file_find` tool uses synchronous shell execution. If an AI agent issues a broad regex search (`.*` or `[a-z]+`) across a large repository, the `grep` command might take several seconds to execute.
2.  **Thread Blocking:** Because Node.js is single-threaded, `execSync` completely blocks the V8 isolate. During this 5-second grep search, the web server cannot accept new HTTP requests, cannot route messages, and cannot respond to WebSocket ping/pong heartbeats. In a multi-user deployment, one agent searching for a file will cause all other users' terminals to disconnect and freeze.
3.  **Remediation:** Replace with `child_process.execFile` wrapped in `util.promisify`.
    ```javascript
    const execFileAsync = util.promisify(require('child_process').execFile);
    async function fileFindTool(args) {
      try {
        const { stdout } = await execFileAsync('grep', ['-rn', args.pattern, '.'], { cwd: WORKSPACE });
        return parseGrepOutput(stdout);
      } catch (e) { return e.stdout ? parseGrepOutput(e.stdout) : []; }
    }
    ```

---

### 4.2 Test Suite Diagnostics & CI Breakdown
The project's continuous integration pipeline is currently failing on two separate fronts: the backend mock tests and the frontend static analysis.

#### 4.2.1 Backend Mock Tests (`npm run test`)
Running the test suite yields **16 hard failures out of 264 tests.**

1.  **Missing Dependency (`chokidar`)**
    *   **Symptom:** `Error: Cannot find module 'chokidar'`.
    *   **Cause:** A test designed to assert that the watcher handles startup errors correctly throws an unhandled exception because the `chokidar` library is missing from the test execution environment. This indicates `package.json` `devDependencies` are out of sync with the testing requirements.
2.  **Schema Drift (`db.getAllPrograms`)**
    *   **Symptom:** `TypeError: db.getAllPrograms is not a function`.
    *   **Cause:** The tests for `GET /api/state` and `GET /api/tasks/tree` crash. As diagnosed in Part 3, the real `db.js` was updated to include "Programs", but the mock object used in the test suite was ignored. This prevents the core API tests from completing.
3.  **Assertion Stagnation (MCP Tools)**
    *   **Symptom:** `AssertionError: actual: 51, expected: 44`.
    *   **Cause:** The test `tests/mock/mcp-tools.test.js` asserts that exactly 44 tools are registered. Developers added 7 new tools to the application over time but completely ignored the failing test suite, leaving the assertion hardcoded at 44.

#### 4.2.2 Frontend Playwright Tests (Static Analysis)
Running `eslint` on the `tests/` directory yields **49 errors**.

```text
/data/workspace/repos/agentic-workbench/tests/browser/file-editor.spec.js
  57:32  error  'openFileTab' is not defined  no-undef
  65:32  error  'switchPanel' is not defined  no-undef
```

**Deep Analysis:**
1.  **False Positives:** The functions `openFileTab`, `switchPanel`, and `setTaskFilter` are defined in the global scope of `public/index.html`. During a Playwright E2E test, the browser context has access to these window-level globals.
2.  **ESLint Misconfiguration:** The static analyzer (`eslint.config.js`) parses the `tests/browser/*.spec.js` files as standard Node.js scripts. Because it doesn't see an `import { openFileTab }` statement, it throws a `no-undef` error. Furthermore, it does not recognize Playwright's injected globals like `page` or `browser`.
3.  **Remediation:** Update `eslint.config.js` to include a specific override block for the test directory that declares these globals:
    ```javascript
    // eslint.config.js
    {
      files: ["tests/browser/**/*.js"],
      languageOptions: {
        globals: {
          page: "readonly",
          browser: "readonly",
          openFileTab: "readonly",
          switchPanel: "readonly"
        }
      }
    }
    ```

---

## Part 5: Comprehensive Remediation Roadmap

Based on the granular, file-by-file audit conducted above, the following prioritized roadmap is required to stabilize the repository and eliminate the critical technical debt.

### Phase 1: Emergency Pipeline Stabilization (Days 1-2)
The immediate goal is to restore the CI/CD pipeline so that future refactoring can be verified.
1.  **Mock DB Repair:** Edit `tests/mock/routes.test.js` or the central DB mock fixture. Add `getAllPrograms: () => []` to the stub object to unblock the `/api/state` tests.
2.  **MCP Assertion Update:** Edit `tests/mock/mcp-tools.test.js`. Locate the tool count assertion and update `expect(tools.length).toBe(44)` to `expect(tools.length).toBe(51)`.
3.  **ESLint Configuration:** Edit `eslint.config.js`. Add an `overrides` block targeting `tests/browser/**/*.spec.js`. Define `globals: { page: true, browser: true, openFileTab: true, switchPanel: true, setTaskFilter: true }`.
4.  **Dependency Fix:** Run `npm install --save-dev chokidar` to resolve the missing module in the test environment.

### Phase 2: Asynchronous Safety & Security (Week 1)
Remove event-loop blocking code to prevent Denial of Service under load.
1.  **Purge `execSync`:**
    *   In `src/mcp-tools.js`, replace the `execSync` grep call in `mcp_workbench_file_find` with an async wrapper around `child_process.execFile`.
    *   In `src/safe-exec.js`, deprecate `tmuxExecSync` and migrate all callers (like the session creation in `routes.js`) to use `tmuxExecAsync`.
2.  **Stream Vector Sync:** In `src/qdrant-sync.js`, replace `fs.readFileSync` with `fs.createReadStream` to prevent Out-Of-Memory (OOM) crashes when embedding massive log files or transcripts.
3.  **Relational Git Accounts:** Run a SQLite migration to move `git_accounts` out of the JSON-stringified `settings` table and into a dedicated `CREATE TABLE git_accounts (...)` table to prevent Lost Update anomalies.

### Phase 3: Monolith Decomposition (Weeks 2-4)
Dismantle the 2,371-line `routes.js` God Object.
1.  **Domain Routers:** Create a `src/routes/` directory. Extract the endpoints into:
    *   `api-projects.js` (Project creation, config)
    *   `api-sessions.js` (Session spawning, archiving)
    *   `api-tasks.js` (Task V2 CRUD)
    *   `api-files.js` (Workspace file manipulation)
2.  **Schema Validation:** Introduce `zod` as a dependency. Write schemas for every `POST` and `PUT` body and apply them as Express middleware before hitting the SQLite driver.
3.  **Service Extraction:** Move the CLI seeding heuristics (`_seedRole`, `_matchFromList`) out of the router and into a dedicated `SessionSeederService.js`.

### Phase 4: UI Modernization (Long Term)
The 5,909-line `public/index.html` file is unsustainable.
1.  **Immediate Extraction:** Move the `<style>` block to `public/css/main.css` and the `<script>` block to `public/js/app.js`.
2.  **Modularization:** Break `app.js` into ES Modules (e.g., `TabsController.js`, `FileTree.js`, `AuthManager.js`) and bundle them using the existing `esbuild` configuration.
3.  **Framework Migration:** The complexity of the real-time terminal tabs, optimistic UI state (`_pendingSessionEdits`), and the manual DOM diffing in `createFileTree` strongly indicates the need for a component-based framework. Begin a progressive migration to React or Vue to eliminate layout thrashing and global namespace pollution.

---
*End of Exhaustive Audit.*

## Appendix: Critical Code Excerpts Referenced in Audit

The following raw source code blocks are appended here to provide exact, line-by-line context for the architectural violations and vulnerabilities identified in Parts 1-5.

### A.1 Frontend: createFileTree Implementation (public/index.html)
*Reference: Part 1.5 - Custom Virtual DOM Implementation*
The following code represents the custom DOM diffing algorithm that manually calculates node insertions and removals. This entire block is the primary reason a migration to React/Vue is mandated.

```javascript
        }));
        const expectedPaths = new Set(expected.map(x => x.path));
        // Remove rows no longer present
        const existingByPath = new Map();
        for (const child of childrenEl.children) {
          if (child.classList.contains('ft-row')) existingByPath.set(child.dataset.path, child);
        }
        for (const [path, rowEl] of existingByPath) {
          if (!expectedPaths.has(path)) {
            const after = rowEl.nextElementSibling;
            rowEl.remove();
            if (after && after.classList.contains('ft-children')) after.remove();
            existingByPath.delete(path);
          }
        }
        // Walk expected, inserting any new rows in order
        let cursor = null;
        for (const x of expected) {
          let row = existingByPath.get(x.path);
          if (!row) {
            row = createRow(x.path, x.kind, x.name);
            const insertAfter = cursor
              ? (cursor.nextElementSibling && cursor.nextElementSibling.classList.contains('ft-children')
                  ? cursor.nextElementSibling : cursor)
              : null;
            if (insertAfter) insertAfter.after(row); else childrenEl.prepend(row);
            if (x.kind === 'directory') {
              const sub = document.createElement('div');
              sub.className = 'ft-children';
              sub.hidden = true;
              row.after(sub);
            }
          }
          cursor = row;
        }
      }

      async function expand(path) {
        const row = rowByPath(path);
        if (!row) return false;
        if (row.dataset.kind !== 'directory' && row.dataset.kind !== 'mount') return false;
        const children = childrenForRow(row);
        if (!children) return false;
        children.hidden = false;
        row.querySelector('.ft-arrow')?.classList.add('ft-expanded');
        // Track expand order (most-recent last) for getDeepestExpanded
        const i = state.expandOrder.indexOf(path);
        if (i >= 0) state.expandOrder.splice(i, 1);
        state.expandOrder.push(path);
        if (!row.dataset.loaded) await loadDirectory(row, children);
        return true;
      }
      function collapse(path) {
        const row = rowByPath(path);
        if (!row) return false;
        const children = childrenForRow(row);
        if (!children) return false;
        children.hidden = true;
        row.querySelector('.ft-arrow')?.classList.remove('ft-expanded');
        const i = state.expandOrder.indexOf(path);
        if (i >= 0) state.expandOrder.splice(i, 1);
        return true;
      }
      async function toggle(path) {
        const row = rowByPath(path);
        if (!row) return;
        const children = childrenForRow(row);
        if (!children) return;
        if (children.hidden) await expand(path); else collapse(path);
      }
      async function refresh() {
        // Re-fetch every loaded directory + diff in place. No rebuild, no flicker.
        const loadedRows = el.querySelectorAll('.ft-row[data-loaded="1"]');
        for (const row of loadedRows) {
          const children = childrenForRow(row);
          if (children) await loadDirectory(row, children);
        }
      }
      async function refreshDirectory(path) {
        const row = rowByPath(path) || rowByPath(path.replace(/\/?$/, '/'));
        const children = row && childrenForRow(row);
        if (children) await loadDirectory(row, children);
      }
      async function navigate(targetPath) {
        const target = targetPath.replace(/\/?$/, '/');
        const mountSection = [...el.querySelectorAll('.ft-mount')].find(s => target.startsWith(s.dataset.path));
        if (!mountSection) return false;
        const mountPath = mountSection.dataset.path;
        const rel = target.slice(mountPath.length);
        const segments = rel.split('/').filter(Boolean);
        await expand(mountPath);
        let curr = mountPath;
        for (const seg of segments) {
          curr = curr + seg + '/';
          const row = rowByPath(curr);
          if (!row) break;
          if (row.dataset.kind === 'directory') await expand(curr);
        }
        const final = rowByPath(target) || rowByPath(target.replace(/\/$/, ''));
        if (final) {
          selectRow(final);
          final.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        return true;
      }
      function selectRow(row) {
        el.querySelectorAll('.ft-row.ft-selected').forEach(r => r.classList.remove('ft-selected'));
        row.classList.add('ft-selected');
        state.selected = row.dataset.path;
      }
      function getSelected() { return state.selected; }
      function getDeepestExpanded() {
        // Most-recently-expanded path wins (matches the old "last clicked dir"
        // semantics that getSelectedFileBrowserDir relied on).
        if (state.expandOrder.length) return state.expandOrder[state.expandOrder.length - 1];
```
**Audit Action:** Deprecate this manual DOM reconciliation.

### A.2 Backend: POST /api/sessions Monolith (src/routes.js)
*Reference: Part 2.2 - Deep Procedural Coupling*
The following code demonstrates the HTTP router handling specific third-party CLI flags and executing blocking shell commands.

```javascript
    if (!['always', 'browser', 'idle'].includes(mode))
      return res.status(400).json({ error: 'mode must be always, browser, or idle' });
    if (
      idleMinutes !== undefined &&
      (typeof idleMinutes !== 'number' || idleMinutes < 1 || idleMinutes > 1440)
    ) {
      return res.status(400).json({ error: 'idleMinutes must be a number between 1 and 1440' });
    }
    keepalive.setMode(mode, idleMinutes);
    if (mode === 'always' && !keepalive.isRunning()) keepalive.start();
    if (mode === 'browser' && getBrowserCount() === 0) keepalive.stop();
    res.json({ mode: keepalive.getMode(), running: keepalive.isRunning() });
  });

  // ── GET /api/state ─────────────────────────────────────────────────────────

  app.get('/api/state', async (req, res) => {
    try {
      const projects = [];
      const dbProjects = db.getProjects();

      for (const dbProject of dbProjects) {
        const projectName = dbProject.name;
        const projectPath = dbProject.path;
        const project = dbProject;

        let dirMissing = false;
        try {
          await stat(projectPath);
        } catch (err) {
          if (err.code === 'ENOENT') {
            dirMissing = true;
          } else {
            logger.warn('Error checking project directory', {
              module: 'routes',
              project: projectName,
              err: err.message,
            });
            dirMissing = true;
          }
        }

        const sessDir = safe.findSessionsDir(projectPath);

        // #257: reconcile MUST run BEFORE the autonomous JSONL discovery below.
        // For MCP-spawned sessions there's no session-resolver running, so the
        // provisional `new_<ts>` row needs the reconciler to bind it to its
        // realID JSONL. If discovery runs first, it creates a separate realID
        // row using parseSessionFile-derived name (the prompt text), which then
        // makes the reconciler treat the JSONL as "claimed" — leaving the
        // provisional row as a permanent orphan in the sidebar AND mis-naming
        // the real row. Run reconcile first; discovery picks up any leftover
        // unbound JSONLs (e.g. sessions created via the CLI directly).
        const currentSessionsForReconcile = db.getSessionsForProject(project.id);
        await reconcileStaleSessionsForProject(currentSessionsForReconcile, sessDir, project.id);

        try {
          const sessionFiles = await readdir(sessDir);
          for (const file of sessionFiles) {
            if (!file.endsWith('.jsonl')) continue;
            const sessionId = basename(file, '.jsonl');
            // Skip JSONL files that belong to non-Claude sessions (Gemini/Codex UUIDs
            // may end up here as empty files — don't overwrite their DB records)
            const existing = db.getSession(sessionId);
            if (existing && existing.cli_type && existing.cli_type !== 'claude') continue;
            const fileMeta = await sessionUtils.parseSessionFile(join(sessDir, file));
            if (fileMeta) db.upsertSession(sessionId, project.id, fileMeta.name);
          }
        } catch (err) {
          if (err.code !== 'ENOENT') {
            logger.warn('Error reading sessions dir in state handler', {
              module: 'routes',
              project: projectName,
              err: err.message,
            });
          }
          /* expected for ENOENT: no sessions dir */
        }

        const dbSessions = db.getSessionsForProject(project.id);
        const sessions = await buildSessionList(dbSessions, sessDir);

        for (const s of sessions) {
          s.project_missing = dirMissing;
        }

        projects.push({ name: projectName, path: projectPath, sessions, missing: dirMissing, state: project.state || 'active', program_id: project.program_id ?? null });
      }

      projects.sort((a, b) => {
        const aTime = a.sessions[0]?.timestamp || '1970-01-01';
        const bTime = b.sessions[0]?.timestamp || '1970-01-01';
        return new Date(bTime) - new Date(aTime);
      });

      const programs = db.getAllPrograms('active');
      res.json({ projects, programs, workspace: WORKSPACE });
    } catch (err) {
      logger.error('Error listing state', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/kb/roles ─────────────────────────────────────────────────────

  app.get('/api/kb/roles', async (req, res) => {
    const rolesDir = '/data/knowledge-base/roles';
    try {
      const files = await readdir(rolesDir);
      const roles = files
        .filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
        .map(f => ({
          name: f.replace(/\.md$/, ''),
          label: f.replace(/\.md$/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        }));
      res.json(roles);
    } catch (_err) {
      res.json([]);
    }
  });

  // ── POST /api/sessions ────────────────────────────────────────────────────

  app.post('/api/sessions', async (req, res) => {
    try {
      const { project, name, cli_type, hidden, role } = req.body;
      const cliType = cli_type || 'claude';
      const VALID_CLI_TYPES = ['claude', 'gemini', 'codex'];
      if (!VALID_CLI_TYPES.includes(cliType))
        return res.status(400).json({ error: `invalid cli_type: ${cliType}. Must be one of: ${VALID_CLI_TYPES.join(', ')}` });
```
**Audit Action:** Extract to SessionOrchestrator service. Replace execSync.

### A.3 Backend: Vector Sync Blocking I/O (src/qdrant-sync.js)
*Reference: Part 3.2.2 - Event-Loop Blocking Memory Vulnerability*
This section of the Qdrant sync engine reads files synchronously, risking severe OOM crashes.

```javascript
        code: err?.cause?.code, status: err?.status,
      });
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
}

async function _embedOnce(cfg, texts, dims) {

  // HuggingFace Inference API has a different format
  if (cfg.isHF) {
    const response = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.key ? { 'Authorization': `Bearer ${cfg.key}` } : {}),
      },
      body: JSON.stringify({ inputs: texts }),
    });
    if (!response.ok) {
      const body = await response.text();
      // #262: attach status so retryTransient can classify HTTP 5xx + 429.
      const err = new Error(`HF Embedding API error ${response.status}: ${body}`);
      err.status = response.status;
      throw err;
    }
    return await response.json();
  }

  // OpenAI-compatible endpoint (Gemini, OpenAI, custom)
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.key && cfg.key !== 'no-key') {
    headers['Authorization'] = `Bearer ${cfg.key}`;
    headers['x-goog-api-key'] = cfg.key; // Gemini compat
  }

  const response = await fetch(`${cfg.url}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      input: texts,
      dimensions: dims || 384,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    // #262: attach status so retryTransient can classify HTTP 5xx + 429.
    const err = new Error(`Embedding API error ${response.status}: ${body}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  return data.data.map(d => d.embedding);
}

async function embed(texts, dims) {
  return embedWithConfig(getEmbeddingConfig(), texts, dims);
}

// #180: build a candidate provider cfg from a (key,value) override pair so we can
// validate before persisting. Targets the provider that the overridden setting belongs
// to (e.g. PUT gemini_api_key always validates against Gemini, regardless of which
// provider is currently active), so the user always gets a real check on what they typed.
function buildCandidateConfig(overrideKey, overrideValue) {
  let provider;
  if (overrideKey === 'vector_embedding_provider') provider = overrideValue;
  else if (overrideKey === 'gemini_api_key') provider = 'gemini';
```
**Audit Action:** Replace readFileSync with createReadStream.

### A.4 Backend: Database Densification Logic (src/db.js)
*Reference: Part 3.1.1 - The Task V2 System*
This is the defensive engineering pattern that protects the UI from sorting bugs.

```javascript
      cli_type = COALESCE(excluded.cli_type, sessions.cli_type),
      updated_at = excluded.updated_at
  `),
  renameSession: db.prepare(
    "UPDATE sessions SET name = ?, user_renamed = 1, updated_at = datetime('now') WHERE id = ?",
  ),
  archiveSession: db.prepare(
    "UPDATE sessions SET archived = ?, state = CASE WHEN ? = 1 THEN 'archived' ELSE 'active' END, updated_at = datetime('now') WHERE id = ?",
  ),
  setSessionStateStmt: db.prepare(
    "UPDATE sessions SET archived = ?, state = ?, updated_at = datetime('now') WHERE id = ?",
  ),
  getSessionFull: db.prepare(
    'SELECT s.*, p.name as project_name, p.path as project_path FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = ?',
  ),
  searchSessionsByName: db.prepare(
    'SELECT s.*, p.name as project_name, p.path as project_path FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.name LIKE ? ORDER BY s.updated_at DESC LIMIT 20',
  ),
  setCliSessionId: db.prepare("UPDATE sessions SET cli_session_id = ?, updated_at = datetime('now') WHERE id = ?"),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  getSessionNotes: db.prepare('SELECT notes FROM sessions WHERE id = ?'),
  setSessionNotes: db.prepare('UPDATE sessions SET notes = ? WHERE id = ?'),

  getProjectNotes: db.prepare('SELECT notes FROM projects WHERE id = ?'),
  setProjectNotes: db.prepare('UPDATE projects SET notes = ? WHERE id = ?'),
  setProjectState: db.prepare('UPDATE projects SET state = ? WHERE id = ?'),
  renameProject: db.prepare('UPDATE projects SET name = ? WHERE id = ?'),

  // ── Tasks v2 (project-based) ─────────────────────────────────────────────
  getAllTasksV2: db.prepare('SELECT * FROM tasks ORDER BY project_id, COALESCE(parent_task_id, 0), rank ASC, id ASC'),
  getTasksByStatusV2: db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY project_id, COALESCE(parent_task_id, 0), rank ASC, id ASC'),
  getTasksByProject: db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY COALESCE(parent_task_id, 0), rank ASC, id ASC'),
  getTopLevelTasks: db.prepare('SELECT * FROM tasks WHERE project_id = ? AND parent_task_id IS NULL ORDER BY rank ASC, id ASC'),
  getSubtasks: db.prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY rank ASC, id ASC'),
  countOpenSubtasks: db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE parent_task_id = ? AND status NOT IN ('done', 'cancelled')"),
  getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
  addTaskV2: db.prepare('INSERT INTO tasks (project_id, parent_task_id, github_issue, title, description, status, archived, rank, created_by, sort_order, folder_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT path FROM projects WHERE id = ?), \'/\'))'),
  updateTaskFields: db.prepare("UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description), github_issue = COALESCE(?, github_issue), updated_at = datetime('now') WHERE id = ?"),
  updateTaskStatus: db.prepare("UPDATE tasks SET status = ?, completed_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END, updated_at = datetime('now') WHERE id = ?"),
  updateTaskArchived: db.prepare("UPDATE tasks SET archived = ?, updated_at = datetime('now') WHERE id = ?"),
  reparentTask: db.prepare("UPDATE tasks SET parent_task_id = ?, project_id = ?, rank = ?, updated_at = datetime('now') WHERE id = ?"),
  setTaskRank: db.prepare("UPDATE tasks SET rank = ?, updated_at = datetime('now') WHERE id = ?"),
  shiftRanksUp: db.prepare("UPDATE tasks SET rank = rank + 1 WHERE project_id = ? AND COALESCE(parent_task_id, 0) = ? AND rank >= ? AND rank < ? AND id != ?"),
  shiftRanksDown: db.prepare("UPDATE tasks SET rank = rank - 1 WHERE project_id = ? AND COALESCE(parent_task_id, 0) = ? AND rank > ? AND rank <= ? AND id != ?"),
  densifyRanks: db.prepare("UPDATE tasks SET rank = rank - 1 WHERE project_id = ? AND COALESCE(parent_task_id, 0) = ? AND rank > ?"),
  maxRankInBucket: db.prepare("SELECT COALESCE(MAX(rank), 0) AS m FROM tasks WHERE project_id = ? AND COALESCE(parent_task_id, 0) = ?"),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
  addTaskHistory: db.prepare('INSERT INTO task_history (task_id, event_type, old_value, new_value, created_by) VALUES (?, ?, ?, ?, ?)'),
  getTaskHistory: db.prepare('SELECT * FROM task_history WHERE task_id = ? ORDER BY created_at DESC, id DESC'),

```
**Audit Action:** Maintain this pattern; ensure all new Task V2 operations trigger densification.

### A.5 Backend: MCP File Find Vulnerability (src/mcp-tools.js)
*Reference: Part 4.1.2 - Event Loop Starvation Vulnerability*
This is the MCP tool that allows an agent to completely lock the Node.js event loop using a synchronous grep.

```javascript
};

handlers.session_summarize = async (args) => {
  requireSessionId(args);
  return await sessionUtils.summarizeSession(args.session_id, args.project);
};

handlers.session_prepare_pre_compact = async () => {
  const config = require('./config');
  return config.getPrompt('session-transition', {});
};

handlers.session_resume_post_compact = async (args) => {
  requireSessionId(args);
  const config = require('./config');
  const session = db.getSessionFull(args.session_id);
  const projectPath = session?.project_path || '';
  const sessDir = sessionUtils.sessionsDir(projectPath);
  const sessionFile = join(sessDir, `${args.session_id}.jsonl`);
  const tailLines = Math.max(1, Number.isFinite(args.tail_lines) ? args.tail_lines : 60);
  let tail = '';
  let lineCount = 0;
  try {
    const content = fs.readFileSync(sessionFile, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const kept = lines.slice(-tailLines);
    tail = kept.join('\n');
    lineCount = kept.length;
  } catch {
    tail = '(could not read session file)';
  }
  // Always write the tail to a file and return the path. Inline return blew
  // past the CLI's tool-result token cap on long sessions; the file path
  // pattern lets the model chunk-read with Read offset/limit at its own pace.
  const tailPath = join('/tmp', `workbench-resume-${args.session_id}-${Date.now()}.txt`);
  fs.writeFileSync(tailPath, tail, 'utf-8');
  const byteCount = Buffer.byteLength(tail, 'utf-8');
  return config.getPrompt('session-resume', {
    TAIL_PATH: tailPath,
    LINE_COUNT: String(lineCount),
    BYTE_COUNT: String(byteCount),
  });
};

handlers.session_export = async (args) => {
  requireSessionId(args);
  const session = db.getSessionFull(args.session_id);
  if (!session) throw new ToolError('session not found', 404);
  const projectPath = session.project_path || '';
  const cliType = session.cli_type || 'claude';
```
**Audit Action:** Refactor to use child_process.execFile asynchronously.

### A.6 Frontend: OAuth Stream Parsing Vulnerability (public/index.html)
*Reference: Part 1.4 - Brittle OAuth Stream Extraction*
This logic runs a regex over a 4KB string on every incoming WebSocket frame on the main thread, causing severe UI blocking, and relies on brittle substring matching.

```javascript
        item.style.cursor = 'pointer';
        item.innerHTML = `
          <div class="session-top-row">
            <span class="session-name">${escHtml(r.name)}</span>
          </div>
          <div class="session-meta">
            <span>${escHtml(r.project)}</span>
            <span class="msg-count">${r.matchCount} matches</span>
          </div>
          <div class="search-snippet" style="font-size:11px;color:var(--text-muted);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${escHtml(r.matches[0]?.text || '')}
          </div>
        `;
        item.addEventListener('click', () => {
          document.getElementById('session-search').value = '';
          searchActive = false;
          renderSidebar._lastHash = null; // force rebuild from search-results back to project-tree
          openSession({ id: r.sessionId, name: r.name }, r.project);
          renderSidebar();
        });
        container.appendChild(item);
      }
    }

    // ── Session Summary ──────────────────────────────

    async function summarizeSession(sessionId, projectName, sessionName) {
      const modal = document.getElementById('auth-modal');
      // Reuse auth modal structure for summary display
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center';
      const overlayId = 'summary-overlay-' + Date.now();
      overlay.id = overlayId;
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });
      overlay.innerHTML = `
        <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:500px;width:90%" onclick="event.stopPropagation()">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <h3 style="font-size:14px;margin:0">${escHtml(sessionName)}</h3>
            <button class="close-btn" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px" title="Close" onclick="document.getElementById('${overlayId}').remove()">&#10005;</button>
          </div>
          <div style="color:var(--text-muted);font-size:13px;display:flex;align-items:center;gap:8px" id="summary-content"><span class="summary-spinner" style="display:inline-block;width:14px;height:14px;border:2px solid var(--text-muted);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite"></span> Generating summary...</div>
          <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
        </div>
      `;
      document.body.appendChild(overlay);

      try {
        const res = await fetch(`/api/sessions/${sessionId}/summary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: projectName }),
        });
        const data = await res.json();
        const el = document.getElementById('summary-content');
        if (data.summary) {
          let html = `<div style="margin-bottom:12px;line-height:1.5">${escHtml(data.summary)}</div>`;
          if (data.recentMessages?.length) {
            html += '<div style="font-size:11px;color:var(--text-muted);margin-top:8px">Recent messages:</div>';
```
**Audit Action:** Move logic to a backend Node.js worker thread.

