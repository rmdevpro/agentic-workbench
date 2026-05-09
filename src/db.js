'use strict';

const Database = require('better-sqlite3');
const { join } = require('path');
const { mkdirSync } = require('fs');

const DATA_DIR = process.env.WORKBENCH_DATA || join(process.env.HOME || '/data', '.workbench');
mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(join(DATA_DIR, 'workbench.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema Migrations (idempotent) ─────────────────────────────────────────
try {
  db.exec("ALTER TABLE projects ADD COLUMN notes TEXT DEFAULT ''");
} catch (_e) {
  /* column exists */
}
try {
  db.exec("ALTER TABLE projects ADD COLUMN state TEXT DEFAULT 'active'");
} catch (_e) {
  /* column exists */
}
try {
  db.exec("ALTER TABLE sessions ADD COLUMN notes TEXT DEFAULT ''");
} catch (_e) {
  /* column exists */
}
try {
  db.exec("ALTER TABLE sessions ADD COLUMN state TEXT DEFAULT 'active'");
} catch (_e) {
  /* column exists */
}
try {
  db.exec('ALTER TABLE sessions ADD COLUMN model_override TEXT');
} catch (_e) {
  /* column exists */
}
try {
  db.exec('ALTER TABLE sessions ADD COLUMN user_renamed INTEGER DEFAULT 0');
} catch (_e) {
  /* column exists */
}
try {
  db.exec(
    "UPDATE sessions SET state = 'archived' WHERE archived = 1 AND (state IS NULL OR state = 'active')",
  );
} catch (_e) {
  /* already migrated */
}
try {
  db.exec("ALTER TABLE sessions ADD COLUMN cli_type TEXT DEFAULT 'claude'");
} catch (_e) {
  /* column exists */
}
try {
  db.exec("ALTER TABLE session_meta ADD COLUMN model TEXT DEFAULT ''");
} catch (_e) {
  /* column exists */
}
try {
  db.exec("ALTER TABLE sessions ADD COLUMN cli_session_id TEXT DEFAULT NULL");
} catch (_e) {
  /* column exists */
}
try {
  db.exec("ALTER TABLE tasks ADD COLUMN folder_path TEXT NOT NULL DEFAULT '/'");
} catch (_e) {
  /* column exists or table doesn't exist yet */
}
try {
  db.exec('ALTER TABLE tasks ADD COLUMN sort_order INTEGER DEFAULT 0');
} catch (_e) {
  /* column exists or table doesn't exist yet */
}
try {
  db.exec("ALTER TABLE tasks ADD COLUMN created_by TEXT DEFAULT 'human'");
} catch (_e) {
  /* column exists or table doesn't exist yet */
}
try {
  db.exec("ALTER TABLE task_history ADD COLUMN created_by TEXT DEFAULT 'human'");
} catch (_e) {
  /* column exists or table doesn't exist yet */
}
try {
  db.exec('ALTER TABLE projects ADD COLUMN program_id INTEGER DEFAULT NULL REFERENCES programs(id) ON DELETE SET NULL');
} catch (_e) {
  /* column exists or programs table not yet created — schema below adds both
     in the right order on a fresh DB, and the ALTER is a no-op idempotently */
}
// #303 task system v2: project-based tasks, subtasks, status lifecycle, rank.
try { db.exec('ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE'); } catch (_e) { /* column exists */ }
try { db.exec('ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE'); } catch (_e) { /* column exists */ }
try { db.exec('ALTER TABLE tasks ADD COLUMN github_issue TEXT'); } catch (_e) { /* column exists */ }
try { db.exec('ALTER TABLE tasks ADD COLUMN archived INTEGER DEFAULT 0'); } catch (_e) { /* column exists */ }
try { db.exec('ALTER TABLE tasks ADD COLUMN rank INTEGER DEFAULT 1'); } catch (_e) { /* column exists */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    archived_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_programs_status ON programs(status);

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL UNIQUE,
    notes TEXT DEFAULT '',
    state TEXT DEFAULT 'active',
    program_id INTEGER DEFAULT NULL REFERENCES programs(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_projects_program ON projects(program_id);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT,
    archived INTEGER DEFAULT 0,
    state TEXT DEFAULT 'active',
    model_override TEXT,
    cli_type TEXT DEFAULT 'claude',
    cli_session_id TEXT DEFAULT NULL,
    user_renamed INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_meta (
    session_id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    file_mtime REAL NOT NULL,
    file_size INTEGER NOT NULL,
    name TEXT,
    timestamp TEXT,
    message_count INTEGER DEFAULT 0,
    model TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_path TEXT NOT NULL DEFAULT '/',
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    github_issue TEXT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'inactive',
    archived INTEGER DEFAULT 0,
    rank INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_by TEXT DEFAULT 'human',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

  CREATE TABLE IF NOT EXISTS task_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    created_by TEXT DEFAULT 'human',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history(task_id);

  CREATE TABLE IF NOT EXISTS task_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    archived_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_task_folders_status ON task_folders(status);

  CREATE TABLE IF NOT EXISTS mcp_registry (
    name TEXT PRIMARY KEY,
    transport TEXT NOT NULL DEFAULT 'stdio',
    config TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mcp_project_enabled (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    mcp_name TEXT NOT NULL REFERENCES mcp_registry(name) ON DELETE CASCADE,
    PRIMARY KEY (project_id, mcp_name)
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,
    module TEXT,
    message TEXT NOT NULL,
    context TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_logs_ts        ON logs(ts);
  CREATE INDEX IF NOT EXISTS idx_logs_level_ts  ON logs(level, ts);
  CREATE INDEX IF NOT EXISTS idx_logs_module_ts ON logs(module, ts);
`);

// #303 task system v2 data migration:
//   1. Backfill project_id, github_issue, archived for any tasks still on the
//      pre-v2 schema (project_id IS NULL).
//   2. Densify rank within every (project_id, parent_task_id) bucket on every
//      startup — keeps rank dense even if a previous migration left gaps from
//      sort_order seed values, deletes, or partial migrations.
(function migrateTasksToProjectBased() {
  const needsBackfill = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE project_id IS NULL").get().c;
  if (needsBackfill > 0) {
    const projects = db.prepare('SELECT id, path FROM projects ORDER BY length(path) DESC').all();
    const tasks = db.prepare('SELECT id, folder_path, title, status FROM tasks WHERE project_id IS NULL').all();
    const setProjectId = db.prepare('UPDATE tasks SET project_id = ? WHERE id = ?');
    const setIssue = db.prepare('UPDATE tasks SET github_issue = ? WHERE id = ?');
    const setArchivedDone = db.prepare("UPDATE tasks SET archived = 1, status = 'done' WHERE id = ?");
    for (const t of tasks) {
      let pid = null;
      for (const p of projects) {
        if (t.folder_path === p.path || t.folder_path.startsWith(p.path + '/')) { pid = p.id; break; }
      }
      if (pid != null) setProjectId.run(pid, t.id);
      if (t.status === 'archived') setArchivedDone.run(t.id);
      const m = /^Issue\s+#(\d+):/i.exec(t.title || '');
      if (m) setIssue.run(`rmdevpro/agentic-workbench#${m[1]}`, t.id);
    }
  }
  // #315: rename legacy 'todo' status to 'inactive' (idempotent — only runs
  // when rows still hold the old value).
  // #348 [C6]: try/catch is for the brief window during a fresh-DB bootstrap
  // when this migration runs before the tasks table exists. The catch is NOT
  // for "tasks table not yet created" in steady state — by that point the
  // schema CREATE block has already run.
  try { db.prepare("UPDATE tasks SET status = 'inactive' WHERE status = 'todo'").run(); } catch (_e) { /* fresh-DB bootstrap before tasks CREATE */ }
  // Densify rank within every bucket on every boot.
  const setRank = db.prepare('UPDATE tasks SET rank = ? WHERE id = ?');
  const buckets = db.prepare("SELECT DISTINCT project_id, COALESCE(parent_task_id, 0) AS pti FROM tasks WHERE project_id IS NOT NULL").all();
  const getBucket = db.prepare(`SELECT id, rank, sort_order FROM tasks WHERE project_id = ? AND COALESCE(parent_task_id, 0) = ? ORDER BY rank ASC, sort_order ASC, id ASC`);
  for (const b of buckets) {
    const rows = getBucket.all(b.project_id, b.pti);
    let r = 1;
    for (const row of rows) {
      if (row.rank !== r) setRank.run(r, row.id);
      r++;
    }
  }
})();

// ── Prepared Statements ────────────────────────────────────────────────────
const stmts = {
  getProjects: db.prepare('SELECT * FROM projects ORDER BY name'),
  getProject: db.prepare('SELECT * FROM projects WHERE name = ?'),
  getProjectById: db.prepare('SELECT * FROM projects WHERE id = ?'),
  insertProject: db.prepare('INSERT OR IGNORE INTO projects (name, path) VALUES (?, ?)'),
  setProjectProgram: db.prepare("UPDATE projects SET program_id = ? WHERE id = ?"),

  getAllPrograms: db.prepare('SELECT * FROM programs ORDER BY name'),
  getProgramsByStatus: db.prepare('SELECT * FROM programs WHERE status = ? ORDER BY name'),
  getProgram: db.prepare('SELECT * FROM programs WHERE id = ?'),
  getProgramByName: db.prepare('SELECT * FROM programs WHERE name = ?'),
  addProgram: db.prepare("INSERT INTO programs (name, description) VALUES (?, ?)"),
  renameProgram: db.prepare("UPDATE programs SET name = ?, updated_at = datetime('now') WHERE id = ?"),
  setProgramDescription: db.prepare("UPDATE programs SET description = ?, updated_at = datetime('now') WHERE id = ?"),
  setProgramStatus: db.prepare("UPDATE programs SET status = ?, archived_at = CASE WHEN ? = 'archived' THEN datetime('now') ELSE NULL END, updated_at = datetime('now') WHERE id = ?"),
  deleteProgram: db.prepare('DELETE FROM programs WHERE id = ?'),
  countProjectsInProgram: db.prepare('SELECT COUNT(*) as c FROM projects WHERE program_id = ?'),

  getSessions: db.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC'),
  getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  getSessionByPrefix: db.prepare(
    'SELECT s.*, p.name as project_name, p.path as project_path FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id LIKE ? LIMIT 1',
  ),
  upsertSession: db.prepare(`
    INSERT INTO sessions (id, project_id, name, cli_type, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(sessions.name, excluded.name),
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
  // #327 [A2]: open a slot at targetRank in destination bucket for an incoming
  // cross-bucket task. No `id != ?` constraint — the moving task isn't in the
  // destination bucket yet.
  shiftRanksUpAtAndAbove: db.prepare("UPDATE tasks SET rank = rank + 1 WHERE project_id = ? AND COALESCE(parent_task_id, 0) = ? AND rank >= ?"),
  maxRankInBucket: db.prepare("SELECT COALESCE(MAX(rank), 0) AS m FROM tasks WHERE project_id = ? AND COALESCE(parent_task_id, 0) = ?"),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
  addTaskHistory: db.prepare('INSERT INTO task_history (task_id, event_type, old_value, new_value, created_by) VALUES (?, ?, ?, ?, ?)'),
  getTaskHistory: db.prepare('SELECT * FROM task_history WHERE task_id = ? ORDER BY created_at DESC, id DESC'),

  getAllTaskFolders: db.prepare('SELECT * FROM task_folders ORDER BY path ASC'),
  getTaskFoldersByStatus: db.prepare('SELECT * FROM task_folders WHERE status = ? ORDER BY path ASC'),
  getTaskFolder: db.prepare('SELECT * FROM task_folders WHERE id = ?'),
  getTaskFolderByPath: db.prepare('SELECT * FROM task_folders WHERE path = ?'),
  addTaskFolder: db.prepare('INSERT INTO task_folders (path, name, description) VALUES (?, ?, ?)'),
  updateTaskFolder: db.prepare("UPDATE task_folders SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?"),
  setTaskFolderStatus: db.prepare("UPDATE task_folders SET status = ?, archived_at = CASE WHEN ? = 'archived' THEN datetime('now') ELSE NULL END, updated_at = datetime('now') WHERE id = ?"),
  deleteTaskFolder: db.prepare('DELETE FROM task_folders WHERE id = ?'),
  reparentTasks: db.prepare("UPDATE tasks SET folder_path = ?, updated_at = datetime('now') WHERE folder_path = ?"),
  reparentTasksUnderPrefix: db.prepare(
    "UPDATE tasks SET folder_path = ? || substr(folder_path, length(?) + 1), updated_at = datetime('now') WHERE folder_path = ? OR folder_path LIKE ? || '/%'"
  ),
  reparentFoldersUnderPrefix: db.prepare(
    "UPDATE task_folders SET path = ? || substr(path, length(?) + 1), updated_at = datetime('now') WHERE path LIKE ? || '/%'"
  ),

  getSessionMeta: db.prepare('SELECT * FROM session_meta WHERE session_id = ?'),
  getSessionMetaByPath: db.prepare('SELECT * FROM session_meta WHERE file_path = ?'),
  upsertSessionMeta: db.prepare(`
    INSERT INTO session_meta (session_id, file_path, file_mtime, file_size, name, timestamp, message_count, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      file_mtime = excluded.file_mtime,
      file_size = excluded.file_size,
      name = excluded.name,
      timestamp = excluded.timestamp,
      message_count = excluded.message_count,
      model = excluded.model
  `),
  deleteSessionMeta: db.prepare('DELETE FROM session_meta WHERE session_id = ?'),

  // MCP registry
  getMcpServers: db.prepare('SELECT * FROM mcp_registry ORDER BY name'),
  getMcpServer: db.prepare('SELECT * FROM mcp_registry WHERE name = ?'),
  registerMcp: db.prepare('INSERT OR REPLACE INTO mcp_registry (name, transport, config, description) VALUES (?, ?, ?, ?)'),
  unregisterMcp: db.prepare('DELETE FROM mcp_registry WHERE name = ?'),
  enableMcpForProject: db.prepare('INSERT OR IGNORE INTO mcp_project_enabled (project_id, mcp_name) VALUES (?, ?)'),
  disableMcpForProject: db.prepare('DELETE FROM mcp_project_enabled WHERE project_id = ? AND mcp_name = ?'),
  getEnabledMcpForProject: db.prepare('SELECT m.* FROM mcp_registry m JOIN mcp_project_enabled e ON m.name = e.mcp_name WHERE e.project_id = ?'),

  // #181: log surfacing.
  // ts is stored as JS ISO8601 with millis ('2026-04-26T12:34:56.789Z'). The retention
  // sweep MUST compare in the same format — `datetime('now', ?)` returns SQLite's
  // 'YYYY-MM-DD HH:MM:SS' which is lexicographically NOT comparable to the ISO form.
  // Use strftime to emit matching format on both sides.
  insertLog: db.prepare('INSERT INTO logs (ts, level, module, message, context) VALUES (?, ?, ?, ?, ?)'),
  errorCountSince: db.prepare("SELECT COUNT(*) AS n FROM logs WHERE level = 'ERROR' AND ts >= ?"),
  topErrorSince: db.prepare("SELECT module, message, ts FROM logs WHERE level = 'ERROR' AND ts >= ? ORDER BY ts DESC LIMIT 1"),
  cleanupOldLogs: db.prepare("DELETE FROM logs WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)"),
};

module.exports = {
  db,
  DATA_DIR,

  getProjects() {
    return stmts.getProjects.all();
  },
  getProject(name) {
    return stmts.getProject.get(name);
  },
  getProjectById(id) {
    return stmts.getProjectById.get(id);
  },
  ensureProject(name, path) {
    stmts.insertProject.run(name, path);
    return stmts.getProject.get(name);
  },
  deleteProject(id) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  },
  setProjectProgram(projectId, programId) {
    stmts.setProjectProgram.run(programId == null ? null : Number(programId), projectId);
    return stmts.getProjectById.get(projectId);
  },

  getAllPrograms(filter) {
    if (!filter || filter === 'all') return stmts.getAllPrograms.all();
    return stmts.getProgramsByStatus.all(filter);
  },
  getProgram(id) {
    return stmts.getProgram.get(id);
  },
  getProgramByName(name) {
    return stmts.getProgramByName.get(name);
  },
  addProgram(name, description = '') {
    const info = stmts.addProgram.run(name, description);
    return stmts.getProgram.get(info.lastInsertRowid);
  },
  updateProgram(id, fields) {
    if (fields.name !== undefined) stmts.renameProgram.run(fields.name, id);
    if (fields.description !== undefined) stmts.setProgramDescription.run(fields.description, id);
    if (fields.status !== undefined) stmts.setProgramStatus.run(fields.status, fields.status, id);
    return stmts.getProgram.get(id);
  },
  // #332 [A7]: atomic rename — check name uniqueness and apply the UPDATE in
  // one transaction so two concurrent PUTs targeting the same new name can't
  // both pass the duplicate check and then both succeed. Throws { code:
  // 'duplicate_name' } when another program already owns the target name.
  renameProgramSafe(id, newName) {
    const run = db.transaction(() => {
      const dup = stmts.getProgramByName.get(newName);
      if (dup && dup.id !== id) {
        const e = new Error(`program with name '${newName}' already exists`);
        e.code = 'duplicate_name';
        throw e;
      }
      stmts.renameProgram.run(newName, id);
    });
    run();
    return stmts.getProgram.get(id);
  },
  deleteProgram(id) {
    // Projects' program_id is automatically set to NULL via ON DELETE SET NULL.
    stmts.deleteProgram.run(id);
  },
  countProjectsInProgram(programId) {
    return stmts.countProjectsInProgram.get(programId).c;
  },

  getSessionsForProject(projectId) {
    return stmts.getSessions.all(projectId);
  },
  getSession(id) {
    return stmts.getSession.get(id);
  },
  getSessionByPrefix(prefix) {
    return stmts.getSessionByPrefix.get(prefix + '%');
  },
  upsertSession(id, projectId, name, cliType) {
    // If no cliType provided, check existing session to preserve its type
    const existing = stmts.getSession.get(id);
    const resolvedType = cliType || existing?.cli_type || 'claude';
    stmts.upsertSession.run(id, projectId, name, resolvedType);
    return stmts.getSession.get(id);
  },
  renameSession(id, name) {
    stmts.renameSession.run(name, id);
  },
  archiveSession(id, archived) {
    const arch = archived ? 1 : 0;
    stmts.archiveSession.run(arch, arch, id);
  },
  setCliSessionId(id, cliSessionId) {
    stmts.setCliSessionId.run(cliSessionId, id);
  },
  deleteSession(id) {
    stmts.deleteSession.run(id);
  },

  getProjectNotes(projectId) {
    const row = stmts.getProjectNotes.get(projectId);
    return row?.notes || '';
  },
  setProjectNotes(projectId, notes) {
    stmts.setProjectNotes.run(notes, projectId);
  },
  setProjectState(projectId, state) {
    stmts.setProjectState.run(state, projectId);
  },
  renameProject(projectId, name) {
    stmts.renameProject.run(name, projectId);
  },
  getSessionNotes(sessionId) {
    const row = stmts.getSessionNotes.get(sessionId);
    return row?.notes || '';
  },
  setSessionNotes(sessionId, notes) {
    stmts.setSessionNotes.run(notes, sessionId);
  },

  // ── Tasks v2 (project-based, subtasks, status lifecycle, rank) ──────────
  // Status enum: 'inactive' | 'active' | 'blocked' | 'done' | 'cancelled'
  // archived: 0|1 — separate visibility flag
  // rank: 1-based dense priority within (project_id, parent_task_id) bucket

  getAllTasks(filter) {
    if (!filter || filter === 'all') return stmts.getAllTasksV2.all();
    return stmts.getTasksByStatusV2.all(filter);
  },
  getTasksByProject(projectId) {
    return stmts.getTasksByProject.all(projectId);
  },
  getTopLevelTasks(projectId) {
    return stmts.getTopLevelTasks.all(projectId);
  },
  getSubtasks(parentTaskId) {
    return stmts.getSubtasks.all(parentTaskId);
  },
  countOpenSubtasks(parentTaskId) {
    return stmts.countOpenSubtasks.get(parentTaskId).c;
  },
  getTask(id) {
    return stmts.getTask.get(id);
  },
  // Returns the ID set of every descendant of taskId (used for cycle prevention
  // when re-parenting). Includes taskId itself.
  collectDescendants(taskId) {
    const set = new Set([taskId]);
    const queue = [taskId];
    while (queue.length) {
      const cur = queue.shift();
      for (const child of stmts.getSubtasks.all(cur)) {
        if (!set.has(child.id)) { set.add(child.id); queue.push(child.id); }
      }
    }
    return set;
  },
  addTask({ projectId, parentTaskId = null, githubIssue = null, title, description = '', status = 'inactive', createdBy = 'human' }) {
    if (status === 'archived') status = 'done'; // legacy mapping
    const archived = 0;
    const bucketParent = parentTaskId ?? 0;
    const max = stmts.maxRankInBucket.get(projectId, bucketParent).m;
    const rank = max + 1;
    const info = stmts.addTaskV2.run(
      projectId, parentTaskId, githubIssue, title, description, status, archived, rank, createdBy, rank, projectId,
    );
    const id = info.lastInsertRowid;
    stmts.addTaskHistory.run(id, 'created', null, title, createdBy);
    return stmts.getTask.get(id);
  },
  updateTaskFields(id, { title, description, github_issue }) {
    const old = stmts.getTask.get(id);
    if (!old) return null;
    stmts.updateTaskFields.run(
      title === undefined ? null : title,
      description === undefined ? null : description,
      github_issue === undefined ? null : github_issue,
      id,
    );
    if (title !== undefined && title !== old.title) {
      stmts.addTaskHistory.run(id, 'renamed', old.title, title, 'human');
    }
    return stmts.getTask.get(id);
  },
  // Status transition with validations:
  //  - 'archived' is no longer a status; use setTaskArchived for that
  //  - moving to 'done' requires no open (non-cancelled, non-done) subtasks
  // Throws an Error subclass with .code='task_validation' on rule violations.
  setTaskStatus(id, status) {
    const old = stmts.getTask.get(id);
    if (!old) { const e = new Error('task not found'); e.code = 'not_found'; throw e; }
    const valid = ['inactive', 'active', 'blocked', 'done', 'cancelled'];
    if (!valid.includes(status)) {
      const e = new Error(`invalid status: ${status}. Must be one of ${valid.join(', ')}`);
      e.code = 'task_validation';
      throw e;
    }
    if (status === 'done') {
      const open = stmts.countOpenSubtasks.get(id).c;
      if (open > 0) {
        const e = new Error(`cannot mark task done: ${open} open subtask${open > 1 ? 's' : ''} remain`);
        e.code = 'task_validation';
        throw e;
      }
    }
    stmts.updateTaskStatus.run(status, status, id);
    const event = status === 'done' ? 'completed' : 'status_changed';
    stmts.addTaskHistory.run(id, event, old.status, status, 'human');
    return stmts.getTask.get(id);
  },
  setTaskArchived(id, archived) {
    const old = stmts.getTask.get(id);
    if (!old) { const e = new Error('task not found'); e.code = 'not_found'; throw e; }
    if (archived && !['done', 'cancelled'].includes(old.status)) {
      const e = new Error(`cannot archive: status must be 'done' or 'cancelled' (current: ${old.status})`);
      e.code = 'task_validation';
      throw e;
    }
    stmts.updateTaskArchived.run(archived ? 1 : 0, id);
    stmts.addTaskHistory.run(id, archived ? 'archived' : 'unarchived', String(old.archived || 0), String(archived ? 1 : 0), 'human');
    return stmts.getTask.get(id);
  },
  // Set rank to newRank (1-based) within the task's current sibling bucket.
  // Shifts other siblings up/down to fit.
  setTaskRank(id, newRank) {
    const t = stmts.getTask.get(id);
    if (!t) return null;
    const bucketParent = t.parent_task_id ?? 0;
    const max = stmts.maxRankInBucket.get(t.project_id, bucketParent).m;
    const target = Math.max(1, Math.min(Number(newRank) || 1, max));
    if (target === t.rank) return t;
    const run = db.transaction(() => {
      if (target < t.rank) {
        stmts.shiftRanksUp.run(t.project_id, bucketParent, target, t.rank, id);
      } else {
        stmts.shiftRanksDown.run(t.project_id, bucketParent, t.rank, target, id);
      }
      stmts.setTaskRank.run(target, id);
    });
    run();
    stmts.addTaskHistory.run(id, 'reranked', String(t.rank), String(target), 'human');
    return stmts.getTask.get(id);
  },
  // Re-parent a task. Setting parentTaskId=null promotes to top-level within
  // newProjectId (or current project if newProjectId omitted). Rank in the new
  // bucket = (max + 1) — appended. Cascades project_id down the entire subtree
  // when crossing projects. Cycle-checks: rejects if parentTaskId is the task
  // itself or any of its descendants.
  reparentTask(id, { parentTaskId = null, projectId = null }) {
    const t = stmts.getTask.get(id);
    if (!t) { const e = new Error('task not found'); e.code = 'not_found'; throw e; }
    const newProjectId = projectId == null ? t.project_id : Number(projectId);
    const newParent = parentTaskId == null ? null : Number(parentTaskId);
    if (newParent != null) {
      const desc = module.exports.collectDescendants(id);
      if (desc.has(newParent)) {
        const e = new Error('cannot reparent: target would create a cycle');
        e.code = 'task_validation';
        throw e;
      }
      const parentRow = stmts.getTask.get(newParent);
      if (!parentRow) { const e = new Error('parent task not found'); e.code = 'task_validation'; throw e; }
      if (parentRow.project_id !== newProjectId) {
        // Force project to match parent's
        const e = new Error('cannot reparent across projects without project_id matching the new parent');
        e.code = 'task_validation';
        throw e;
      }
    }
    const bucketParent = newParent ?? 0;
    const max = stmts.maxRankInBucket.get(newProjectId, bucketParent).m;
    const newRank = max + 1;
    const run = db.transaction(() => {
      // Move the task itself
      stmts.reparentTask.run(newParent, newProjectId, newRank, id);
      // Densify the old bucket
      stmts.densifyRanks.run(t.project_id, t.parent_task_id ?? 0, t.rank);
      // Cascade project_id to all descendants if it changed
      if (t.project_id !== newProjectId) {
        const desc = Array.from(module.exports.collectDescendants(id)).filter((d) => d !== id);
        const setProj = db.prepare("UPDATE tasks SET project_id = ?, updated_at = datetime('now') WHERE id = ?");
        for (const d of desc) setProj.run(newProjectId, d);
      }
    });
    run();
    stmts.addTaskHistory.run(id, 'reparented',
      JSON.stringify({ project_id: t.project_id, parent: t.parent_task_id }),
      JSON.stringify({ project_id: newProjectId, parent: newParent }),
      'human');
    return stmts.getTask.get(id);
  },
  // #327 [A2]: atomic reparent + rank assignment. Replaces the buggy two-step
  // call pattern (db.setTaskRank → db.reparentTask) which was non-atomic and
  // produced wrong ranks: setTaskRank shifted the OLD bucket then reparentTask
  // overrode rank to (max+1) in the NEW bucket — appended instead of inserted.
  //
  // moveTask handles all sub-cases in a single transaction:
  //   - same-bucket rerank (rank only) — densify within bucket
  //   - cross-bucket move with target rank — densify old + shift new at target + reparent
  //   - reparent without explicit rank — appends to new bucket
  //
  // Returns the updated task row.
  moveTask(id, { parentTaskId = undefined, projectId = undefined, rank = undefined } = {}) {
    const t = stmts.getTask.get(id);
    if (!t) { const e = new Error('task not found'); e.code = 'not_found'; throw e; }

    const newProjectId = projectId == null ? t.project_id : Number(projectId);
    const newParent = parentTaskId == null ? null : Number(parentTaskId);
    const oldBucketParent = t.parent_task_id ?? 0;
    const newBucketParent = newParent ?? 0;
    const sameBucket = (t.project_id === newProjectId && oldBucketParent === newBucketParent);

    // Validate cycle + parent existence + project match
    if (newParent != null) {
      const desc = module.exports.collectDescendants(id);
      if (desc.has(newParent)) {
        const e = new Error('cannot reparent: target would create a cycle');
        e.code = 'task_validation'; throw e;
      }
      const parentRow = stmts.getTask.get(newParent);
      if (!parentRow) { const e = new Error('parent task not found'); e.code = 'task_validation'; throw e; }
      if (parentRow.project_id !== newProjectId) {
        const e = new Error('cannot reparent across projects without project_id matching the new parent');
        e.code = 'task_validation'; throw e;
      }
    }

    // Determine target rank.
    // Same-bucket cap = current max (task already counted in the max).
    // Cross-bucket cap = current max + 1 (incoming task adds a slot).
    const newBucketMax = stmts.maxRankInBucket.get(newProjectId, newBucketParent).m;
    let targetRank;
    if (rank == null) {
      targetRank = sameBucket ? t.rank : newBucketMax + 1;
    } else {
      const cap = sameBucket ? Math.max(1, newBucketMax) : (newBucketMax + 1);
      targetRank = Math.max(1, Math.min(Number(rank), cap));
    }

    // No-op fast path
    if (sameBucket && targetRank === t.rank) return t;

    const run = db.transaction(() => {
      if (sameBucket) {
        // Same bucket — just rerank
        if (targetRank < t.rank) {
          stmts.shiftRanksUp.run(t.project_id, oldBucketParent, targetRank, t.rank, id);
        } else {
          stmts.shiftRanksDown.run(t.project_id, oldBucketParent, t.rank, targetRank, id);
        }
        stmts.setTaskRank.run(targetRank, id);
      } else {
        // Cross-bucket move
        // 1. Densify old bucket — close the gap left by departing task
        stmts.densifyRanks.run(t.project_id, oldBucketParent, t.rank);
        // 2. Shift new bucket up at and above targetRank — open a slot
        stmts.shiftRanksUpAtAndAbove.run(newProjectId, newBucketParent, targetRank);
        // 3. Reparent + set new rank (single UPDATE for the moving task)
        stmts.reparentTask.run(newParent, newProjectId, targetRank, id);
        // 4. Cascade project_id to descendants if cross-project
        if (t.project_id !== newProjectId) {
          const descIds = Array.from(module.exports.collectDescendants(id)).filter((d) => d !== id);
          const setProj = db.prepare("UPDATE tasks SET project_id = ?, updated_at = datetime('now') WHERE id = ?");
          for (const d of descIds) setProj.run(newProjectId, d);
        }
      }
    });
    run();

    if (sameBucket) {
      stmts.addTaskHistory.run(id, 'reranked', String(t.rank), String(targetRank), 'human');
    } else {
      stmts.addTaskHistory.run(id, 'moved',
        JSON.stringify({ project_id: t.project_id, parent: t.parent_task_id, rank: t.rank }),
        JSON.stringify({ project_id: newProjectId, parent: newParent, rank: targetRank }),
        'human');
    }
    return stmts.getTask.get(id);
  },
  deleteTask(id) {
    const t = stmts.getTask.get(id);
    if (!t) return;
    const run = db.transaction(() => {
      stmts.deleteTask.run(id);
      stmts.densifyRanks.run(t.project_id, t.parent_task_id ?? 0, t.rank);
    });
    run();
  },
  getTaskHistory(taskId) {
    return stmts.getTaskHistory.all(taskId);
  },
  addTaskComment(taskId, body, createdBy = 'human') {
    const info = stmts.addTaskHistory.run(taskId, 'comment', null, body, createdBy);
    return { id: info.lastInsertRowid, task_id: taskId, event_type: 'comment', new_value: body, created_by: createdBy };
  },

  getSessionFull(id) {
    return stmts.getSessionFull.get(id);
  },
  searchSessionsByName(query) {
    return stmts.searchSessionsByName.all(`%${query}%`);
  },
  setSessionState(id, state) {
    const archived = state === 'archived' ? 1 : 0;
    stmts.setSessionStateStmt.run(archived, state, id);
  },

  getSessionMeta(sessionId) {
    return stmts.getSessionMeta.get(sessionId);
  },
  getSessionMetaByPath(filePath) {
    return stmts.getSessionMetaByPath.get(filePath);
  },
  upsertSessionMeta(sessionId, filePath, mtime, size, name, timestamp, messageCount, model) {
    stmts.upsertSessionMeta.run(sessionId, filePath, mtime, size, name, timestamp, messageCount, model || '');
  },
  deleteSessionMeta(sessionId) {
    stmts.deleteSessionMeta.run(sessionId);
  },
  cleanStaleMeta(validSessionIds) {
    const all = db.prepare('SELECT session_id FROM session_meta').all();
    for (const row of all) {
      if (!validSessionIds.has(row.session_id)) {
        stmts.deleteSessionMeta.run(row.session_id);
      }
    }
  },

  getSetting(key, defaultValue = null) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  },
  setSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  },
  getAllSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch (err) {
        if (err instanceof SyntaxError) {
          settings[row.key] = row.value;
        } else {
          throw err;
        }
      }
    }
    return settings;
  },

  // MCP registry
  getMcpServers() {
    return stmts.getMcpServers.all();
  },
  getMcpServer(name) {
    return stmts.getMcpServer.get(name);
  },
  registerMcp(name, transport, config, description = '') {
    stmts.registerMcp.run(name, transport, JSON.stringify(config), description);
  },
  unregisterMcp(name) {
    stmts.unregisterMcp.run(name);
  },
  enableMcpForProject(projectId, mcpName) {
    stmts.enableMcpForProject.run(projectId, mcpName);
  },
  disableMcpForProject(projectId, mcpName) {
    stmts.disableMcpForProject.run(projectId, mcpName);
  },

  // #181: log surfacing
  insertLog(ts, level, mod, message, context) {
    stmts.insertLog.run(ts, level, mod, message, context);
  },
  errorCountSince(sinceTs) {
    return stmts.errorCountSince.get(sinceTs).n;
  },
  topErrorSince(sinceTs) {
    return stmts.topErrorSince.get(sinceTs) || null;
  },
  queryLogs({ level, module: mod, since, limit }) {
    const where = [];
    const params = [];
    if (level) { where.push('level = ?'); params.push(level); }
    if (mod) { where.push('module = ?'); params.push(mod); }
    if (since) { where.push('ts >= ?'); params.push(since); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // Clamp to [1, 5000]. Negative limits would otherwise reach SQLite where
    // LIMIT -1 means "no limit" — would let a caller dump the whole table.
    const parsed = parseInt(limit, 10);
    const lim = Math.max(1, Math.min(Number.isFinite(parsed) ? parsed : 200, 5000));
    return db.prepare(`SELECT id, ts, level, module, message, context FROM logs ${whereSql} ORDER BY ts DESC LIMIT ${lim}`).all(...params);
  },
  cleanupOldLogs(modifier = '-7 days') {
    return stmts.cleanupOldLogs.run(modifier).changes;
  },
  getEnabledMcpForProject(projectId) {
    return stmts.getEnabledMcpForProject.all(projectId);
  },
};
