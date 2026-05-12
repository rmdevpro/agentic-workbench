// ── Task Tree ────────────────────────────────────────
export let taskFilter = 'open';
export let editingTaskId = null;
export let _addTaskCtx = null;
export let _taskDetailHistoryFilter = 'all';
export let _taskDetailHistory = [];

export let _taskTreeData = { programs: [] };
export const expandedTaskProjects = new Set();
export const collapsedTasks = new Set();

export const STATUS_GLYPH = {
  inactive: '⏸', active: '⏵', blocked: '⏹', done: '✓', cancelled: '✗',
};

function escHtml(str) { return window.escapeHtml(str); }
const escAttr = (s) => window.escapeAttr(s);

export function setTaskFilter(filter) {
  taskFilter = filter;
  document.querySelectorAll('.task-filter').forEach(b => b.classList.toggle('active', b.dataset.taskFilter === filter));
  loadTaskTree();
}

export function _parseGithubIssue(qualified) {
  if (!qualified) return null;
  const m = /^([^/]+\/[^#]+)#(\d+)$/.exec(qualified);
  if (!m) return null;
  return {
    repo: m[1], num: m[2], label: '#' + m[2],
    url: 'https://github.com/' + m[1] + '/issues/' + m[2],
  };
}

export function _flattenTasksOf(project, out) {
  function walk(arr) {
    for (const t of arr) { out.push(t); if (t.subtasks) walk(t.subtasks); }
  }
  walk(project.tasks || []);
}

export async function loadTaskTree() {
  try {
    const res = await fetch('/api/tasks/tree?filter=' + encodeURIComponent(taskFilter));
    const data = await res.json();
    _taskTreeData = data;
    _renderTaskTree();
  } catch (err) {
    console.error('loadTaskTree error', err);
  }
}

export function _renderTaskTree() {
  const container = document.getElementById('task-tree');
  container.innerHTML = '';
  const programs = (_taskTreeData.programs || []);
  for (const program of programs) {
    const phdr = document.createElement('div');
    phdr.className = 'program-header';
    phdr.textContent = program.name;
    container.appendChild(phdr);
    for (const project of (program.projects || [])) {
      const projDiv = document.createElement('div');
      const flat = [];
      _flattenTasksOf(project, flat);
      const collapsed = !expandedTaskProjects.has(project.id);
      const row = document.createElement('div');
      row.className = 'project-row' + (collapsed ? ' collapsed' : '');
      row.dataset.projectId = project.id;
      row.innerHTML = '<span class="arrow">&#9656;</span>'
        + '<span class="name">' + escHtml(project.name) + '</span>'
        + (project.has_repo ? '' : ' <span style="font-size:9px;color:var(--text-muted)">(no repo)</span>')
        + (flat.length ? '<span class="count">' + flat.length + '</span>' : '');
      row.addEventListener('click', () => {
        if (expandedTaskProjects.has(project.id)) expandedTaskProjects.delete(project.id);
        else expandedTaskProjects.add(project.id);
        row.classList.toggle('collapsed');
        tasksDiv.classList.toggle('collapsed-by-project');
        _renderTaskTree();
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        _showTaskContextMenu(e, { project, task: null });
      });
      row.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drag-over-as-child'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over-as-child'));
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        row.classList.remove('drag-over-as-child');
        const dragId = e.dataTransfer.getData('application/x-task-id');
        if (!dragId) return;
        await fetch('/api/tasks/' + dragId, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: project.id, parent_task_id: null }),
        });
        loadTaskTree();
      });
      projDiv.appendChild(row);
      const tasksDiv = document.createElement('div');
      tasksDiv.className = 'project-tasks' + (collapsed ? ' collapsed-by-project' : '');
      tasksDiv.style.display = collapsed ? 'none' : '';
      for (const t of (project.tasks || [])) {
        _appendTaskRow(tasksDiv, t, 0, project);
      }
      projDiv.appendChild(tasksDiv);
      container.appendChild(projDiv);
    }
  }
}

export function _appendTaskRow(container, task, depth, project) {
  const hasSubs = (task.subtasks || []).length > 0;
  const collapsed = collapsedTasks.has(task.id);
  const issue = _parseGithubIssue(task.github_issue);
  const row = document.createElement('div');
  row.className = 'task-row ' + task.status + (task.archived ? ' archived' : '') + (hasSubs ? ' has-subtasks' : '') + (collapsed ? ' collapsed-subtasks' : '');
  row.style.setProperty('--depth', String(depth));
  row.dataset.taskId = task.id;
  row.dataset.projectId = project.id;
  row.draggable = true;
  const caret = hasSubs ? '<span class="caret">&#9656;</span>' : '<span class="caret"></span>';
  const indicator = '<span class="indicator ' + task.status + '" title="' + task.status + '">' + (STATUS_GLYPH[task.status] || '?') + '</span>';
  const issueHtml = issue ? '<span class="issue-num" data-url="' + escAttr(issue.url) + '">' + issue.label + '</span>' : '';
  const titleHtml = '<span class="title">' + escHtml(task.title) + '</span>';
  row.innerHTML = caret + indicator + issueHtml + titleHtml;
  row.querySelector('.caret').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!hasSubs) return;
    if (collapsedTasks.has(task.id)) collapsedTasks.delete(task.id);
    else collapsedTasks.add(task.id);
    _renderTaskTree();
  });
  const issueEl = row.querySelector('.issue-num');
  if (issueEl) {
    issueEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = issueEl.dataset.url;
      if (url) window.open(url, '_blank');
    });
  }
  row.addEventListener('dblclick', () => openTaskDetail(task.id));
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    _showTaskContextMenu(e, { project, task });
  });
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-task-id', String(task.id));
    e.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragover', (e) => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    const rect = row.getBoundingClientRect();
    const yOff = e.clientY - rect.top;
    row.classList.remove('drag-over-above', 'drag-over-below', 'drag-over-as-child');
    if (yOff < rect.height * 0.25) row.classList.add('drag-over-above');
    else if (yOff > rect.height * 0.75) row.classList.add('drag-over-below');
    else row.classList.add('drag-over-as-child');
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('drag-over-above', 'drag-over-below', 'drag-over-as-child');
  });
  row.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    const above = row.classList.contains('drag-over-above');
    const below = row.classList.contains('drag-over-below');
    row.classList.remove('drag-over-above', 'drag-over-below', 'drag-over-as-child');
    const dragId = e.dataTransfer.getData('application/x-task-id');
    if (!dragId || dragId === String(task.id)) return;
    let payload;
    if (above || below) {
      payload = {
        parent_task_id: task.parent_task_id || null,
        project_id: task.project_id,
        rank: above ? task.rank : (task.rank + 1),
      };
    } else {
      payload = {
        parent_task_id: task.id,
        project_id: task.project_id,
      };
    }
    const r = await fetch('/api/tasks/' + dragId, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      await window.showErrorModal({ title: 'Move failed', message: err.error || r.statusText });
    }
    loadTaskTree();
  });
  container.appendChild(row);
  if (hasSubs && !collapsed) {
    const childWrap = document.createElement('div');
    childWrap.className = 'subtask-children';
    for (const sub of task.subtasks) {
      _appendTaskRow(childWrap, sub, depth + 1, project);
    }
    container.appendChild(childWrap);
  }
}

export function _showTaskContextMenu(e, ctx) {
  const { project, task } = ctx;
  document.querySelectorAll('.context-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.cssText = 'position:fixed;top:' + e.clientY + 'px;left:' + e.clientX + 'px;z-index:2000;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:4px 0;min-width:160px;box-shadow:0 4px 12px rgba(0,0,0,0.3)';

  let html = '';
  if (task) {
    html += '<div class="context-menu-item" data-action="edit">Edit…</div>';
    html += '<div class="context-menu-item" data-action="add-subtask">Add subtask…</div>';
    html += '<div class="context-menu-divider"></div>';
    for (const s of ['inactive', 'active', 'blocked', 'done', 'cancelled']) {
      if (s === task.status) continue;
      html += '<div class="context-menu-item" data-action="status-' + s + '">' +
        (STATUS_GLYPH[s] || '?') + ' ' + s.charAt(0).toUpperCase() + s.slice(1) +
        '</div>';
    }
    html += '<div class="context-menu-divider"></div>';
    if (['done', 'cancelled'].includes(task.status)) {
      html += '<div class="context-menu-item" data-action="' + (task.archived ? 'unarchive' : 'archive') + '">' + (task.archived ? 'Unarchive' : 'Archive') + '</div>';
    }
    html += '<div class="context-menu-item" data-action="delete" style="color:var(--danger)">Delete</div>';
  } else {
    html += '<div class="context-menu-item" data-action="add-task">Add task…</div>';
  }
  menu.innerHTML = html;

  menu.querySelectorAll('.context-menu-item').forEach(item => {
    item.style.padding = '4px 12px';
    item.style.cursor = 'pointer';
    item.style.fontSize = '12px';
    item.addEventListener('mouseenter', () => { item.style.background = 'var(--bg-hover)'; });
    item.addEventListener('mouseleave', () => { item.style.background = ''; });
    item.addEventListener('click', async () => {
      menu.remove();
      const action = item.dataset.action;
      if (action === 'edit') {
        openTaskDetail(task.id);
      } else if (action === 'add-task') {
        _openAddTaskModal({ projectId: project.id, parentTaskId: null, projectName: project.name, hasRepo: project.has_repo });
      } else if (action === 'add-subtask') {
        const proj = _findProjectById(task.project_id);
        _openAddTaskModal({ projectId: task.project_id, parentTaskId: task.id, projectName: proj?.name || '', hasRepo: proj?.has_repo });
      } else if (action && action.startsWith('status-')) {
        const newStatus = action.replace('status-', '');
        const r = await fetch('/api/tasks/' + task.id, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          await window.showErrorModal({ title: 'Status change failed', message: err.error || 'Failed to change status' });
        }
        loadTaskTree();
      } else if (action === 'archive' || action === 'unarchive') {
        const r = await fetch('/api/tasks/' + task.id, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived: action === 'archive' }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          window.showErrorModal({ title: 'Archive failed', message: err.error || 'Failed to toggle archive' });
        }
        loadTaskTree();
      } else if (action === 'delete') {
        const ok = await window.showConfirmModal({
          title: 'Delete Task', danger: true, confirmLabel: 'Delete',
          message: 'Delete task: ' + task.title + '?',
        });
        if (!ok) return;
        await fetch('/api/tasks/' + task.id, { method: 'DELETE' });
        loadTaskTree();
      }
    });
  });

  document.body.appendChild(menu);
  setTimeout(() => {
    document.addEventListener('click', function dismiss() {
      menu.remove();
      document.removeEventListener('click', dismiss);
    }, { once: true });
  }, 0);
}

export function _findProjectById(pid) {
  for (const program of (_taskTreeData.programs || [])) {
    for (const proj of (program.projects || [])) {
      if (proj.id === pid) return proj;
    }
  }
  return null;
}

export function _openAddTaskModal({ projectId, parentTaskId, projectName, hasRepo }) {
  editingTaskId = null;
  _addTaskCtx = { projectId, parentTaskId, hasRepo };
  const m = document.getElementById('task-detail-modal');
  document.getElementById('task-detail-title').value = '';
  document.getElementById('task-detail-description').value = '';
  document.getElementById('task-detail-status').value = 'inactive';
  document.getElementById('task-detail-github-issue').value = '';
  document.getElementById('task-detail-archived').checked = false;
  document.getElementById('task-detail-archived').disabled = true;
  const histEl = document.getElementById('task-detail-history');
  histEl.innerHTML = '<div style="font-size:11px;color:var(--text-muted)">No history yet — task not yet created.</div>';
  document.getElementById('task-detail-error').style.display = 'none';
  document.getElementById('task-detail-error').textContent = '';
  m.dataset.mode = 'create';
  m.dataset.contextLabel = (parentTaskId ? 'Subtask in ' : 'Task in ') + projectName;
  m.classList.add('visible');
  setTimeout(() => document.getElementById('task-detail-title').focus(), 50);
}

export function _renderTaskHistory() {
  const histEl = document.getElementById('task-detail-history');
  const filtered = _taskDetailHistory.filter(h => {
    if (_taskDetailHistoryFilter === 'all') return true;
    if (_taskDetailHistoryFilter === 'comments') return h.event_type === 'comment';
    return h.event_type !== 'comment';
  });
  if (!filtered.length) {
    histEl.innerHTML = `<div style="font-size:11px;color:var(--text-muted);padding:6px 0">No entries.</div>`;
    return;
  }
  histEl.innerHTML = filtered.map(h => {
    if (h.event_type === 'comment') {
      return `<div class="hist-item"><strong>💬 ${escHtml(h.created_by || 'human')}</strong> ${escHtml(h.new_value || '')}<br><span style="font-size:10px;color:var(--text-muted)">${h.created_at}</span></div>`;
    }
    return `<div class="hist-item"><strong>${escHtml(h.event_type)}</strong> ${h.old_value ? escHtml(h.old_value) + ' → ' : ''}${h.new_value ? escHtml(h.new_value) : ''}<br><span style="font-size:10px;color:var(--text-muted)">${h.created_at}</span></div>`;
  }).join('');
}

export async function openTaskDetail(taskId) {
  try {
    const res = await fetch(`/api/tasks/${taskId}`);
    const task = await res.json();
    editingTaskId = taskId;
    _addTaskCtx = null;
    const m = document.getElementById('task-detail-modal');
    m.dataset.mode = 'edit';
    document.getElementById('task-detail-title').value = task.title || '';
    document.getElementById('task-detail-description').value = task.description || '';
    document.getElementById('task-detail-status').value = task.status || 'inactive';
    document.getElementById('task-detail-github-issue').value = task.github_issue || '';
    const archEl = document.getElementById('task-detail-archived');
    archEl.checked = !!task.archived;
    archEl.disabled = false;
    document.getElementById('task-detail-error').style.display = 'none';
    document.getElementById('task-detail-error').textContent = '';
    _taskDetailHistory = task.history || [];
    _taskDetailHistoryFilter = 'all';
    document.querySelectorAll('#task-detail-history-filter .hist-filter').forEach(b => {
      const isActive = b.dataset.filter === 'all';
      b.classList.toggle('active', isActive);
      b.style.background = isActive ? 'var(--accent)' : 'var(--bg-tertiary)';
      b.style.color = isActive ? '#0d1117' : 'var(--text-primary)';
      b.style.border = isActive ? 'none' : '1px solid var(--border)';
    });
    _renderTaskHistory();
    document.getElementById('task-detail-comment-input').value = '';
    m.classList.add('visible');
  } catch (err) { console.error('openTaskDetail', err); }
}

export function _showTaskDetailError(msg) {
  const el = document.getElementById('task-detail-error');
  el.textContent = msg;
  el.style.display = 'block';
}

export async function saveTaskDetail() {
  const title = document.getElementById('task-detail-title').value.trim();
  const description = document.getElementById('task-detail-description').value;
  const status = document.getElementById('task-detail-status').value;
  const githubIssue = document.getElementById('task-detail-github-issue').value.trim();
  const archived = document.getElementById('task-detail-archived').checked;
  if (!title) { _showTaskDetailError('Title required'); return; }
  const m = document.getElementById('task-detail-modal');
  const mode = m.dataset.mode || 'edit';
  if (mode === 'create' && _addTaskCtx) {
    const body = {
      project_id: _addTaskCtx.projectId,
      parent_task_id: _addTaskCtx.parentTaskId,
      title, description, status,
      github_issue: githubIssue || null,
    };
    const r = await fetch('/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      _showTaskDetailError(err.error || ('HTTP ' + r.status));
      return;
    }
    closeTaskDetail();
    loadTaskTree();
    return;
  }
  if (!editingTaskId) return;
  const body = {
    title, description, status,
    github_issue: githubIssue || null,
    archived,
  };
  const r = await fetch('/api/tasks/' + editingTaskId, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    _showTaskDetailError(err.error || ('HTTP ' + r.status));
    return;
  }
  closeTaskDetail();
  loadTaskTree();
}

export function closeTaskDetail() {
  editingTaskId = null;
  _addTaskCtx = null;
  const m = document.getElementById('task-detail-modal');
  m.classList.remove('visible');
  delete m.dataset.mode;
}

export async function _addTaskComment() {
  if (!editingTaskId) return;
  const input = document.getElementById('task-detail-comment-input');
  const body = input.value.trim();
  if (!body) return;
  const btn = document.getElementById('task-detail-comment-add');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/tasks/${editingTaskId}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, created_by: 'human' }),
    });
    if (!res.ok) throw new Error(await res.text());
    const refreshed = await fetch(`/api/tasks/${editingTaskId}`).then(r => r.json());
    _taskDetailHistory = refreshed.history || [];
    _renderTaskHistory();
    input.value = '';
  } catch (err) {
    console.error('Failed to add comment', err);
  } finally {
    btn.disabled = false;
  }
}

export function autoNavigateTaskTree() {
  const projPath = window._getActiveProjectPath && window._getActiveProjectPath();
  if (!projPath) return;
  expandedTaskProjects.clear();
  for (const program of (_taskTreeData.programs || [])) {
    for (const proj of (program.projects || [])) {
      if (proj.path === projPath) {
        expandedTaskProjects.add(proj.id);
        break;
      }
    }
  }
  _renderTaskTree();
}

export function initTaskEventListeners() {
  document.getElementById('task-detail-modal').addEventListener('click', (e) => {
    if (e.target.id === 'task-detail-modal') closeTaskDetail();
  });

  document.querySelectorAll('#task-detail-history-filter .hist-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      _taskDetailHistoryFilter = btn.dataset.filter;
      document.querySelectorAll('#task-detail-history-filter .hist-filter').forEach(b => {
        const isActive = b.dataset.filter === _taskDetailHistoryFilter;
        b.classList.toggle('active', isActive);
        b.style.background = isActive ? 'var(--accent)' : 'var(--bg-tertiary)';
        b.style.color = isActive ? '#0d1117' : 'var(--text-primary)';
        b.style.border = isActive ? 'none' : '1px solid var(--border)';
      });
      _renderTaskHistory();
    });
  });

  document.getElementById('task-detail-comment-add').addEventListener('click', _addTaskComment);
  document.getElementById('task-detail-comment-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _addTaskComment(); }
  });
}
