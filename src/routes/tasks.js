'use strict';

const {
  fs,
  join,
  dirname,
  TASK_TITLE_MAX_LEN,
  TASK_DESC_MAX_LEN,
} = require('./_shared');

function register(app, {
  db,
  fireEvent,
}) {
  function _projectHasRepoPath(projectPath) {
    if (!projectPath) return false;
    let cur = projectPath;
    while (cur && cur !== '/' && cur.length > 1) {
      try { if (fs.existsSync(join(cur, '.git'))) return true; } catch { /* ignore */ }
      cur = dirname(cur);
    }
    return false;
  }

  // Build a tree shaped { programs: [ { id, name, projects: [ { id, name, path, has_repo, tasks: [ { ..., subtasks: [...] } ] } ] } ] }
  // Tasks within each project are top-level (parent_task_id IS NULL); subtasks
  // are nested recursively under their parent.
  function buildProjectTaskTree({ filter = 'open', showArchived = false } = {}) {
    const programs = db.getAllPrograms('all');
    const projects = db.getProjects();
    let tasks;
    if (filter === 'open') {
      // Open = any non-terminal status
      tasks = db.getAllTasks('all').filter(t => ['inactive', 'active', 'blocked'].includes(t.status));
    } else if (filter === 'archived-flag') {
      // Show only archived tasks (archived=1) — different from old 'archived' status
      tasks = db.getAllTasks('all').filter(t => !!t.archived);
    } else {
      tasks = filter === 'all' ? db.getAllTasks('all') : db.getAllTasks(filter);
    }
    // For archived-flag mode, don't filter out archived. Otherwise, hide them by default.
    if (filter !== 'archived-flag' && !showArchived) tasks = tasks.filter(t => !t.archived);
    const projTasks = new Map(); // project_id -> task array
    for (const t of tasks) {
      if (!projTasks.has(t.project_id)) projTasks.set(t.project_id, []);
      projTasks.get(t.project_id).push(t);
    }
    // For each project, build the subtask tree
    function nestSubtasks(taskArr) {
      const byParent = new Map();
      for (const t of taskArr) {
        const k = t.parent_task_id ?? 0;
        if (!byParent.has(k)) byParent.set(k, []);
        byParent.get(k).push(t);
      }
      function decorate(parentId) {
        const arr = (byParent.get(parentId) || []).sort((a, b) => (a.rank || 0) - (b.rank || 0));
        return arr.map(t => ({ ...t, subtasks: decorate(t.id) }));
      }
      return decorate(0);
    }
    const programMap = new Map();
    for (const p of programs) programMap.set(p.id, { id: p.id, name: p.name, status: p.status, projects: [] });
    const orphanProjects = []; // projects with program_id null
    for (const proj of projects) {
      const projNode = {
        id: proj.id,
        name: proj.name,
        path: proj.path,
        program_id: proj.program_id,
        has_repo: _projectHasRepoPath(proj.path),
        tasks: nestSubtasks(projTasks.get(proj.id) || []),
      };
      if (proj.program_id != null && programMap.has(proj.program_id)) {
        programMap.get(proj.program_id).projects.push(projNode);
      } else {
        orphanProjects.push(projNode);
      }
    }
    const programList = Array.from(programMap.values()).filter(pr => pr.projects.length > 0);
    if (orphanProjects.length) {
      programList.push({ id: null, name: 'Unassigned', status: 'active', projects: orphanProjects });
    }
    return { programs: programList };
  }

  app.get('/api/tasks/tree', (req, res) => {
    const filter = req.query.filter || 'open';
    const showArchived = req.query.show_archived === '1';
    res.json(buildProjectTaskTree({ filter, showArchived }));
  });

  app.post('/api/tasks', (req, res) => {
    const { project_id, project_name, parent_task_id, github_issue, title, description, status, created_by } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    if (title.length > TASK_TITLE_MAX_LEN) return res.status(400).json({ error: 'title too long' });
    if (description && description.length > TASK_DESC_MAX_LEN) return res.status(400).json({ error: 'description too long' });
    // R3-N2: accept project_name as a fallback when project_id is missing,
    // matching the MCP task_add tool's contract. Lets HTTP callers use the
    // simpler {project_name, title} shape without first resolving the id.
    let project = null;
    if (project_id != null) project = db.getProjectById(Number(project_id));
    if (!project && project_name) project = db.getProject(String(project_name));
    if (!project && parent_task_id != null) {
      const parent = db.getTask(Number(parent_task_id));
      if (parent) project = db.getProjectById(parent.project_id);
    }
    if (!project) return res.status(400).json({ error: 'project_id, project_name, or valid parent_task_id required' });
    const issue = github_issue ? String(github_issue).trim() : null;
    if (!issue && _projectHasRepoPath(project.path)) {
      return res.status(400).json({ error: `github_issue required for tasks in repo-backed project "${project.name}"` });
    }
    if (parent_task_id != null) {
      const parent = db.getTask(Number(parent_task_id));
      if (!parent) return res.status(404).json({ error: 'parent_task_id not found' });
      if (parent.project_id !== project.id) {
        return res.status(400).json({ error: 'parent_task_id must be in the same project' });
      }
    }
    try {
      const task = db.addTask({
        projectId: project.id,
        parentTaskId: parent_task_id == null ? null : Number(parent_task_id),
        githubIssue: issue,
        title,
        description: description || '',
        status: status || 'inactive',
        createdBy: created_by || 'human',
      });
      fireEvent('task_added', { task_id: task.id, project_id: project.id, title });
      res.json(task);
    } catch (e) {
      if (e.code === 'task_validation') return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  app.get('/api/tasks/:id', (req, res) => {
    const task = db.getTask(Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'task not found' });
    const history = db.getTaskHistory(task.id);
    const subtasks = db.getSubtasks(task.id);
    res.json({ ...task, history, subtasks });
  });

  app.put('/api/tasks/:id', (req, res) => {
    const id = Number(req.params.id);
    const task = db.getTask(id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const { title, description, github_issue, status, archived, rank, parent_task_id, project_id } = req.body || {};
    try {
      if (title !== undefined) {
        if (!title || title.length > TASK_TITLE_MAX_LEN) return res.status(400).json({ error: 'invalid title' });
      }
      if (description !== undefined && description.length > TASK_DESC_MAX_LEN) return res.status(400).json({ error: 'description too long' });
      if (title !== undefined || description !== undefined || github_issue !== undefined) {
        db.updateTaskFields(id, { title, description, github_issue });
      }
      if (status !== undefined) db.setTaskStatus(id, status);
      if (archived !== undefined) db.setTaskArchived(id, !!archived);
      // #327 [A2]: atomic moveTask replaces the buggy two-step
      // setTaskRank → reparentTask which appended to the new bucket
      // instead of inserting at the requested rank. moveTask handles
      // all combinations (rank-only, parent-only, both) in one transaction.
      if (rank !== undefined || parent_task_id !== undefined || project_id !== undefined) {
        db.moveTask(id, {
          parentTaskId: parent_task_id,
          projectId: project_id,
          rank,
        });
      }
      res.json(db.getTask(id));
    } catch (e) {
      if (e.code === 'task_validation') return res.status(400).json({ error: e.message });
      if (e.code === 'not_found') return res.status(404).json({ error: e.message });
      throw e;
    }
  });

  app.delete('/api/tasks/:id', (req, res) => {
    db.deleteTask(Number(req.params.id));
    res.json({ deleted: true });
  });

  // ── Task comments ────────────────────────────────────────────────────────

  app.post('/api/tasks/:id/comments', (req, res) => {
    const id = Number(req.params.id);
    const task = db.getTask(id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const { body, created_by } = req.body || {};
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body required' });
    if (body.length > TASK_DESC_MAX_LEN) return res.status(400).json({ error: 'body too long' });
    const comment = db.addTaskComment(id, String(body).trim(), created_by || 'human');
    fireEvent('task_comment_added', { task_id: id, comment_id: comment.id });
    res.json(comment);
  });
}

module.exports = { register };
