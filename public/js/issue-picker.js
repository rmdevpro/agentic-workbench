import { editingTaskId, _addTaskCtx, _taskTreeData, _findProjectById } from './tasks.js';

let _issuePickerCtx = null;
let _issuePickerCache = [];

export async function openIssuePicker() {
  let repo = null;
  try {
    let projectId = null;
    if (editingTaskId) {
      for (const program of (_taskTreeData.programs || [])) {
        for (const proj of (program.projects || [])) {
          const flat = []; const walk = (arr) => { for (const t of arr) { flat.push(t); if (t.subtasks) walk(t.subtasks); } };
          walk(proj.tasks || []);
          if (flat.find(t => t.id === editingTaskId)) projectId = proj.id;
        }
      }
    } else if (_addTaskCtx) projectId = _addTaskCtx.projectId;
    if (projectId == null) {
      window.showErrorModal({ title: 'Picker unavailable', message: 'No project context to scope the picker. Open the task from inside a project.' });
      return;
    }
    const proj = _findProjectById(projectId);
    if (!proj || !proj.has_repo) {
      window.showErrorModal({ title: 'Picker unavailable', message: 'Project has no enclosing git repo. Issue picker requires a repo-backed project.' });
      return;
    }
    const remRes = await fetch(`/api/projects/${encodeURIComponent(proj.name)}/git-remote`);
    if (!remRes.ok) {
      const err = await remRes.json().catch(() => ({}));
      window.showErrorModal({
        title: 'Could not derive repo',
        message: err.error === 'no_git_remote'
          ? 'Project has no git remote configured (no `origin` set). Set one with `git remote add origin <url>` and retry.'
          : `Could not derive repo from project: ${err.error || `HTTP ${remRes.status}`}`,
      });
      return;
    }
    const remData = await remRes.json();
    repo = remData.repo;
  } catch (err) { window.showErrorModal({ title: 'Picker setup error', message: err.message }); return; }
  _issuePickerCtx = { repo };
  _issuePickerCache = [];
  document.getElementById('issue-picker-repo').textContent = repo;
  document.getElementById('issue-picker-search').value = '';
  document.getElementById('issue-picker-state').value = 'open';
  document.getElementById('issue-picker-error').style.display = 'none';
  document.getElementById('issue-picker-list').innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:12px">Loading…</div>';
  document.getElementById('issue-picker-modal').style.display = 'flex';
  await _fetchIssuesForPicker();
}

export function closeIssuePicker() {
  document.getElementById('issue-picker-modal').style.display = 'none';
  _issuePickerCtx = null;
  _issuePickerCache = [];
}

async function _fetchIssuesForPicker() {
  if (!_issuePickerCtx) return;
  const state = document.getElementById('issue-picker-state').value;
  const url = `/api/issues?repo=${encodeURIComponent(_issuePickerCtx.repo)}&state=${state}`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      const errEl = document.getElementById('issue-picker-error');
      errEl.style.display = 'block';
      errEl.textContent = (e.error || `HTTP ${r.status}`) + (e.path ? ` — add the account in Settings → Git` : '');
      document.getElementById('issue-picker-list').innerHTML = '';
      return;
    }
    const data = await r.json();
    _issuePickerCache = data.items || [];
    _renderIssuePickerList();
  } catch (err) {
    document.getElementById('issue-picker-error').style.display = 'block';
    document.getElementById('issue-picker-error').textContent = err.message;
  }
}

function _renderIssuePickerList() {
  const q = document.getElementById('issue-picker-search').value.trim().toLowerCase();
  const filtered = q ? _issuePickerCache.filter(i => i.title.toLowerCase().includes(q)) : _issuePickerCache;
  const list = document.getElementById('issue-picker-list');
  if (!filtered.length) {
    list.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:12px">No matching issues.</div>';
    return;
  }
  list.innerHTML = filtered.map(i => `
    <div class="issue-picker-row" data-num="${i.number}" style="display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--border);cursor:pointer;font-size:12px">
      <span style="width:8px;height:8px;border-radius:50%;background:${i.state === 'OPEN' ? '#3fb950' : '#8957e5'};flex:none"></span>
      <span style="font-family:'SF Mono',Menlo,monospace;color:var(--text-muted);flex:none;min-width:48px">#${i.number}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escapeHtml(i.title)}</span>
      <span style="display:flex;gap:3px;flex:none">${(i.labels||[]).map(l => `<span style="font-size:10px;padding:1px 5px;border-radius:8px;background:#${l.color}80;color:#000">${window.escapeHtml(l.name)}</span>`).join('')}</span>
    </div>
  `).join('');
  list.querySelectorAll('.issue-picker-row').forEach(row => {
    row.addEventListener('click', () => {
      const num = row.dataset.num;
      const repo = _issuePickerCtx.repo;
      document.getElementById('task-detail-github-issue').value = `${repo}#${num}`;
      closeIssuePicker();
    });
    row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-tertiary)');
    row.addEventListener('mouseleave', () => row.style.background = '');
  });
}

export function initIssuePickerListeners() {
  const m = document.getElementById('issue-picker-modal');
  if (!m) return;
  m.addEventListener('click', (e) => { if (e.target.id === 'issue-picker-modal') closeIssuePicker(); });
  document.getElementById('issue-picker-search')?.addEventListener('input', _renderIssuePickerList);
  document.getElementById('issue-picker-state')?.addEventListener('change', _fetchIssuesForPicker);
}
