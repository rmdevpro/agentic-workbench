'use strict';

// #361 [L1]: MCP tool catalog — single source of truth for the 51 flat tools
// exposed under server `workbench`. Both src/mcp-tools.js (handlers) and
// src/mcp-server.js (stdio MCP shim) consume this. Adding a new tool means
// editing exactly two places: handler in mcp-tools.js and entry in this
// catalog. The CATALOG_NAMES export lets tests assert shape parity.

// ── Schema fragments ──────────────────────────────────────────────────────────
// Common parameter definitions reused across multiple tool schemas.

const P = {
  session_id: { type: 'string', description: 'Workbench session ID (the UUID-prefixed id from session_list).' },
  project: { type: 'string', description: 'Project name as listed by project_list.' },
  cli: { type: 'string', enum: ['claude', 'gemini', 'codex'], description: 'CLI type.' },
  cli_or_csv: { type: 'string', description: 'CLI filter — single name or comma-separated list (claude,gemini,codex). Default: all three.' },
  pattern: { type: 'string', description: 'Regex pattern to match.' },
  query: { type: 'string', description: 'Search query (semantic, ≥ 2 chars).' },
  limit: { type: 'number', description: 'Max results (default 10).' },
  task_id: { type: 'number', description: 'Task ID (numeric).' },
  folder_path: { type: 'string', description: 'Folder path under workspace root, e.g. /src/auth or / for root.' },
};

const T = (name, description, properties, required = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required },
});

// ── Tool catalog (45 flat tools under server `workbench`) ─────────────────────

const TOOLS = [
  // file_*
  T('file_list', 'List entries in a workspace directory.', {
    path: { type: 'string', description: 'Workspace-relative directory path. Default: workspace root.' },
  }),
  T('file_read', 'Read a workspace file as UTF-8 text.', {
    path: { type: 'string', description: 'Workspace-relative file path.' },
  }, ['path']),
  T('file_create', 'Create a new workspace file. Fails if it already exists (use file_update to overwrite).', {
    path: { type: 'string' }, content: { type: 'string' },
  }, ['path', 'content']),
  T('file_update', 'Overwrite an existing workspace file. Fails if it does not exist (use file_create first).', {
    path: { type: 'string' }, content: { type: 'string' },
  }, ['path', 'content']),
  T('file_delete', 'Delete a workspace file.', {
    path: { type: 'string' },
  }, ['path']),
  T('file_find', 'Recursive regex search across workspace files (replaces the old file_grep). Returns up to 200 matching lines.', {
    pattern: P.pattern,
    file_type: { type: 'string', description: 'Restrict to files with this extension (e.g. js, py, md).' },
    context_lines: { type: 'number', description: 'Lines of context around each match (default 2).' },
  }, ['pattern']),
  T('file_search_documents', 'Semantic search across documentation files (markdown / text). Requires a vector embedding provider configured in Settings.', {
    query: P.query, limit: P.limit,
  }, ['query']),
  T('file_search_code', 'Semantic search across source code files. Requires a vector embedding provider configured in Settings.', {
    query: P.query, limit: P.limit,
  }, ['query']),

  // session_* — lifecycle
  T('session_new', 'Create a new CLI session in a project. Defaults to hidden so MCP-spawned sub-sessions do not clutter the sidebar.', {
    project: P.project,
    cli: { type: 'string', enum: ['claude', 'gemini', 'codex', 'bash'], description: 'CLI to launch (default claude). Use bash for utility shell sessions.' },
    name: { type: 'string', description: 'Session name shown in the sidebar. Required.' },
    hidden: { type: 'boolean', description: 'Whether to hide from sidebar (default true). Set false for visible sessions.' },
  }, ['project', 'name']),
  T('session_connect', 'Look up a session and ensure its tmux pane is running. Returns the tmux name. Pass session_id (preferred) or query (fuzzy name match).', {
    session_id: P.session_id,
    query: { type: 'string', description: 'Fuzzy name match against the sidebar session list (best match wins).' },
  }),
  T('session_restart', 'Kill the session’s tmux pane and respawn the CLI with --resume. JSONL must still exist on disk.', {
    session_id: P.session_id,
  }, ['session_id']),
  T('session_kill', 'Kill the session’s tmux pane without respawning. Use when you are done driving the session.', {
    session_id: P.session_id,
  }, ['session_id']),
  T('session_list', 'List sessions in a project, sorted newest first.', {
    project: P.project,
  }, ['project']),
  T('session_config', 'Update session metadata (name / state / notes).', {
    session_id: P.session_id,
    name: { type: 'string' },
    state: { type: 'string', enum: ['active', 'archived', 'hidden'] },
    notes: { type: 'string' },
  }, ['session_id']),
  T('session_summarize', 'Return a structured summary of a session (recent transcript + token counts).', {
    session_id: P.session_id, project: P.project,
  }, ['session_id']),
  T('session_prepare_pre_compact', 'Return the pre-compact checklist prompt — call before /compact in a long session.', {}),
  T('session_resume_post_compact', 'Return the resume prompt for after a /compact. Writes the last N JSONL lines verbatim to a temp file under /tmp and returns a prompt that points at that path; the model reads the file with Read offset/limit. No truncation — tail_lines is honored exactly.', {
    session_id: P.session_id,
    tail_lines: { type: 'number', description: 'Lines of session tail to write to the temp file (default 60). Honored exactly — no size cap. The model reads the file in chunks via Read offset/limit.' },
  }, ['session_id']),
  T('session_export', 'Export a session — raw JSONL for Claude, structured summary for Gemini/Codex.', {
    session_id: P.session_id, project: P.project,
  }, ['session_id']),
  T('session_info', 'Unified session info: model, tokens, message count, timestamp, cli_type, active (tmux alive).', {
    session_id: P.session_id,
  }, ['session_id']),

  // session_* — search
  T('session_find', 'Regex search across session JSONLs (replaces session_grep). Filter by CLI with the cli arg.', {
    pattern: P.pattern, cli: P.cli_or_csv,
  }, ['pattern']),
  T('session_search', 'Semantic search across session content. Filter by CLI with the cli arg. Requires a vector embedding provider.', {
    query: P.query, cli: P.cli_or_csv, limit: P.limit,
  }, ['query']),

  // session_* — tmux interaction
  T('session_send_text', 'Paste text into a session via tmux load-buffer + paste-buffer (no Enter). Use this for prompts and long input — handles special characters safely. Follow with session_send_key {key:"Enter"} to submit. SIZE LIMIT: 32 KiB (32768 chars). For larger input, write to a file and reference it (e.g. "Read /tmp/briefing.md") instead.', {
    session_id: P.session_id, text: { type: 'string', maxLength: 32768, description: 'Text to paste. No trailing Enter is appended. Hard cap 32768 chars — for larger input, write to a file and reference it.' },
  }, ['session_id', 'text']),
  T('session_send_keys', 'Send raw text via tmux send-keys. Short commands only — special characters get shell-interpreted. For prompts, prefer session_send_text.', {
    session_id: P.session_id, text: { type: 'string' },
  }, ['session_id', 'text']),
  T('session_send_key', 'Send a single named key (Enter, Escape, Tab, Up, etc.) or single ASCII char. Used to submit input or dismiss menus.', {
    session_id: P.session_id, key: { type: 'string', description: 'Key name (Enter, Escape, Tab, Up, Down, F1..F12, etc.) or a single printable ASCII character.' },
  }, ['session_id', 'key']),
  T('session_read_screen', 'Capture the visible tmux pane content (capture-pane). Useful for checking startup prompts, verifying submission, watching for "Thinking…".', {
    session_id: P.session_id, lines: { type: 'number', description: 'Lines of scrollback to include (default 200, max 1000).' },
  }, ['session_id']),
  T('session_read_output', 'Read structured session content (parsed transcript with token counts). Higher-fidelity than session_read_screen — not limited to visible pane.', {
    session_id: P.session_id, project: P.project,
  }, ['session_id']),
  T('session_wait', 'Pause for N seconds (≤ 60). Use between session_send_text and session_read_screen so the CLI has time to respond.', {
    seconds: { type: 'number', description: 'Seconds to wait (positive, ≤ 60).' },
  }, ['seconds']),

  // project_*
  T('project_find', 'List all projects, optionally filtered by case-insensitive regex over name + notes (replaces project_list and project_grep).', {
    pattern: { type: 'string', description: 'Optional regex; if absent, returns every project.' },
  }),
  T('project_get', 'Get a single project by name.', { project: P.project }, ['project']),
  T('project_update', 'Update project metadata (name / notes / state).', {
    project: P.project,
    name: { type: 'string', description: 'New project name.' },
    notes: { type: 'string' },
    state: { type: 'string', enum: ['active', 'archived', 'hidden'] },
  }, ['project']),
  T('project_sys_prompt_get', 'Read a CLI’s system-prompt file from the project (CLAUDE.md / GEMINI.md / AGENTS.md).', {
    project: P.project, cli: P.cli,
  }, ['project', 'cli']),
  T('project_sys_prompt_update', 'Write a CLI’s system-prompt file in the project (CLAUDE.md / GEMINI.md / AGENTS.md).', {
    project: P.project, cli: P.cli, content: { type: 'string' },
  }, ['project', 'cli', 'content']),
  T('project_mcp_list', 'List MCP servers registered in the workbench (available to enable per project).', {}),
  T('project_mcp_register', 'Register an MCP server in the workbench so it can be enabled per project.', {
    mcp_name: { type: 'string', description: 'Server name as written into .mcp.json.' },
    mcp_config: { type: 'object', description: 'Server config (command/args for stdio, url for http).' },
    mcp_transport: { type: 'string', enum: ['stdio', 'http', 'sse'] },
    mcp_description: { type: 'string' },
  }, ['mcp_name', 'mcp_config']),
  T('project_mcp_unregister', 'Unregister a workbench-level MCP server.', {
    mcp_name: { type: 'string' },
  }, ['mcp_name']),
  T('project_mcp_enable', 'Enable an MCP server for a project. Updates that project’s .mcp.json. If session_id is provided, restarts that session so the new server is picked up.', {
    project: P.project, mcp_name: { type: 'string' }, session_id: P.session_id,
  }, ['project', 'mcp_name']),
  T('project_mcp_disable', 'Disable an MCP server for a project. Updates .mcp.json. If session_id is provided, restarts that session.', {
    project: P.project, mcp_name: { type: 'string' }, session_id: P.session_id,
  }, ['project', 'mcp_name']),
  T('project_mcp_list_enabled', 'List MCP servers enabled for a project.', {
    project: P.project,
  }, ['project']),

  // task_* (v2 — project-based, subtasks, status lifecycle, rank, github_issue)
  T('task_find', 'Find tasks. Filter by project_id, parent_task_id, status (inactive/active/blocked/done/cancelled/all/open), pattern (regex). Replaces task_list and task_grep.', {
    project_id: { type: 'number', description: 'Filter to one project.' },
    parent_task_id: { type: 'number', description: 'Filter to subtasks of one parent (or null for top-level).' },
    filter: { type: 'string', enum: ['all', 'inactive', 'active', 'blocked', 'done', 'cancelled', 'open'], description: "Status filter (default 'inactive'). 'open' bundles inactive + active + blocked." },
    pattern: { type: 'string', description: 'Optional case-insensitive regex over title + description.' },
  }),
  T('task_get', 'Get a single task by ID.', { task_id: P.task_id }, ['task_id']),
  T('task_add', 'Create a new task. Tasks belong to a project (and optionally a parent task). Repo-backed projects require github_issue; non-repo projects make it optional.', {
    title: { type: 'string', description: 'Task title (≤ 500 chars).' },
    description: { type: 'string' },
    project_id: { type: 'number', description: 'Workbench project id (or omit and use parent_task_id to inherit).' },
    project_name: { type: 'string', description: 'Alternative to project_id — looks up by name.' },
    parent_task_id: { type: 'number', description: 'Make this task a subtask of the given task.' },
    github_issue: { type: 'string', description: "Fully-qualified, e.g. 'rmdevpro/agentic-workbench#317'. Required for tasks in repo-backed projects." },
    status: { type: 'string', enum: ['inactive', 'active', 'blocked', 'done', 'cancelled'], description: "Default 'inactive'." },
  }, ['title']),
  T('task_move', 'Re-parent a task and/or move it across projects. parent_task_id null = top-level.', {
    task_id: P.task_id,
    parent_task_id: { type: ['number', 'null'], description: 'New parent task id, or null to make it top-level.' },
    project_id: { type: 'number', description: 'New project id (cascades to all descendants).' },
  }, ['task_id']),
  T('task_update', 'Update task fields. Status transitions and archive flag have server-side validation (e.g. cannot mark done with open subtasks; cannot archive non-terminal status).', {
    task_id: P.task_id,
    title: { type: 'string' },
    description: { type: 'string' },
    github_issue: { type: 'string', description: "Linked issue, fully qualified (or empty string to clear)." },
    status: { type: 'string', enum: ['inactive', 'active', 'blocked', 'done', 'cancelled'] },
    archived: { type: 'boolean', description: "Visibility flag. Only allowed when status is 'done' or 'cancelled'." },
    rank: { type: 'number', description: '1-based dense rank within the sibling group; setting shifts neighbors.' },
    parent_task_id: { type: ['number', 'null'] },
    project_id: { type: 'number' },
  }, ['task_id']),
  T('task_delete', 'Delete a task (and its subtree via cascade).', { task_id: P.task_id }, ['task_id']),
  T('task_comment_add', 'Add a comment to a task. Comments are recorded in task_history with event_type=comment and shown alongside change events.', {
    task_id: P.task_id,
    body: { type: 'string', description: 'Comment text (markdown).' },
    created_by: { type: 'string', description: 'Author tag for filtering. Defaults to "agent" for MCP-authored comments.' },
  }, ['task_id', 'body']),

  // gh_* (#317 path-keyed credential model + gh shell-out)
  T('gh_account_list', 'List configured GitHub accounts (path + flags + has_token). Tokens are NEVER returned.', {}),
  T('gh_account_add', "Add a GitHub account row keyed by path (e.g. 'github.com/yourname'). Token is stored in DB and never echoed back.", {
    path: { type: 'string', description: "Path key — host + '/' + account name (e.g. 'github.com/rmdevpro')." },
    token: { type: 'string', description: 'Personal access token — stored only in workbench DB.' },
    isKB: { type: 'boolean', description: 'If true, this is the KB account (used for Knowledge Base sync). At most one row may have this set.' },
    default: { type: 'boolean', description: 'If true, this is the default account for context-less ops. At most one row may have this set.' },
    name: { type: 'string', description: 'Optional display label.' },
  }, ['path', 'token']),
  T('gh_account_update', 'Update an existing account row. Pass only the fields to change.', {
    id: { type: 'string', description: 'Account id (from gh_account_list).' },
    token: { type: 'string', description: 'New token (omit to keep existing).' },
    isKB: { type: 'boolean' },
    default: { type: 'boolean' },
    name: { type: 'string' },
    path: { type: 'string', description: 'New path (cannot collide with another row).' },
  }, ['id']),
  T('gh_account_remove', 'Remove an account row by id.', {
    id: { type: 'string', description: 'Account id (from gh_account_list).' },
  }, ['id']),
  T('gh_cmd', "Run a `gh` (or `git` when use_git=true) command authenticated against the path-keyed account. Token is injected via GH_TOKEN env (or http.extraheader for git). Caller passes repo='owner/name' to scope the lookup; the host defaults to github.com. Distinct errors for missing path (404) vs auth rejected (401).", {
    command: { type: 'array', items: { type: 'string' }, description: "Argv to pass to gh/git, e.g. ['issue','list','-R','owner/name'] or ['log','--oneline','-n','5']." },
    repo: { type: 'string', description: "owner/name — used to derive the host/account path for token lookup. Either repo or path is required." },
    path: { type: 'string', description: "Direct lookup path, e.g. 'github.com/rmdevpro'. Use when repo isn't applicable." },
    host: { type: 'string', description: "Host for path construction (default 'github.com')." },
    use_git: { type: 'boolean', description: 'If true, run `git` instead of `gh` (auth via http.extraheader).' },
  }, ['command']),

  // log_*
  T('log_find', 'Query the workbench audit-log table. Optional filters: level (DEBUG/INFO/WARN/ERROR), module (e.g. qdrant-sync), since (1h / 30m / 24h / iso8601), pattern (regex over message + context), limit (default 200, max 5000). Returns rows newest-first.', {
    level: { type: 'string', enum: ['DEBUG', 'INFO', 'WARN', 'ERROR'] },
    module: { type: 'string', description: 'Source module name, e.g. qdrant-sync, ws-terminal.' },
    since: { type: 'string', description: 'Lower bound. Relative (1h / 30m / 24h) or ISO 8601 timestamp.' },
    pattern: { type: 'string', description: 'Optional case-insensitive regex over message + context.' },
    limit: { type: 'number', description: 'Max rows (default 200, hard cap 5000).' },
  }),
];

const CATALOG_NAMES = TOOLS.map(t => t.name);

module.exports = { TOOLS, CATALOG_NAMES, P, T };
