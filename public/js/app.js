// ── ESM Entrypoint ─────────────────────────────────────────────────────────
// F0 (#364): Replaces the inline <script> in public/index.html. Residual
// code pending extraction: F12 (settings.js), F13 (auth.js), F14 (error-
// banner.js), F3 (api-client.js).

import {
  tabs, activeTabId, tabPanelAssignments,
  projectState, programState, expandedPrograms,
  _settingsCache, setSettingsCache, db_getSetting,
  REFRESH_MS, TERM_THEME, setFilter,
  _lastClickedProjectPath, sessionSortBy, setSessionSortBy,
} from './state.js';

import {
  initSidebarDeps, renderSidebar, loadState,
} from './sidebar.js';

import {
  initTabsDeps, switchTab, closeTab, renderTabs, moveTabToPanel,
  _activeIdForPanel, _panelOf, showEmptyState, initSideDivider,
  _wireDropZones, _updateSidePanelVisibility,
} from './tabs.js';

import {
  initTerminalDeps, connectTab, createTerminalTab,
} from './terminal.js';

import { createFileTree } from './file-tree.js';

import {
  loadFiles, openFileTab, _fileBrowserTree, refreshFileTree,
  autoNavigateFileTree, fileBrowserUpload,
} from './files.js';

import {
  loadTaskTree, autoNavigateTaskTree, openTaskDetail, closeTaskDetail,
  saveTaskDetail, setTaskFilter, initTaskEventListeners,
} from './tasks.js';

import {
  openIssuePicker, closeIssuePicker, initIssuePickerListeners,
} from './issue-picker.js';

// ── Pending-mutation maps ────────────────────────────────────────────────────
// #287/#369: optimistic sidebar mutations while PUT is in flight.
const _pendingProgramAssignments = new Map(); // projName → expected program_id
const _pendingProjectEdits = new Map();       // projName → { name?, state?, notes? }
const _pendingSessionEdits = new Map();       // sessionId → { name?, state?, notes?, archived? }
window._pendingProgramAssignments = _pendingProgramAssignments;
window._pendingProjectEdits = _pendingProjectEdits;
window._pendingSessionEdits = _pendingSessionEdits;

// ── Theme constants (F12: pending extraction to settings.js) ────────────────
const LIGHT_THEME = {
  background: '#ffffff', foreground: '#1e1e1e', cursor: '#0066cc',
  selectionBackground: '#add6ff',
  black: '#000000', red: '#cd3131', green: '#008000', yellow: '#795e26',
  blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#3a3a3a',
  brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14',
  brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc',
  brightCyan: '#0598bc', brightWhite: '#1e1e1e',
};
const LIGHT_CSS = {
  '--bg-primary': '#f5f5f5', '--bg-secondary': '#ffffff', '--bg-tertiary': '#e8e8e8',
  '--bg-hover': '#ebebeb', '--text-primary': '#1e1e1e', '--text-secondary': '#555555',
  '--text-muted': '#999999', '--border': '#d1d1d1', '--accent': '#0066cc',
};
const WORKBENCH_DARK_THEME = {
  background: '#081220', foreground: '#e0eeff', cursor: '#5cb0ff',
  selectionBackground: '#1e3a5f',
  black: '#081220', red: '#ff7080', green: '#60d888', yellow: '#f0c850',
  blue: '#5cb0ff', magenta: '#b090e0', cyan: '#58d0e0', white: '#e0eeff',
  brightBlack: '#2a4a6e', brightRed: '#ff98a8', brightGreen: '#80f0a0',
  brightYellow: '#ffe070', brightBlue: '#80c8ff', brightMagenta: '#c8b0f0',
  brightCyan: '#78e8f0', brightWhite: '#ffffff',
};
const WORKBENCH_DARK_CSS = {
  '--bg-primary': '#081220', '--bg-secondary': '#0c1a30', '--bg-tertiary': '#122240',
  '--bg-hover': '#182c50', '--text-primary': '#f0f6ff', '--text-secondary': '#c0d8f0',
  '--text-muted': '#e0ecff', '--border': '#1a3458', '--accent': '#e0ecff',
  '--accent-hover': '#f0f6ff', '--success': '#60d888', '--warning': '#f0c850', '--danger': '#ff7080',
};
const WORKBENCH_LIGHT_THEME = {
  background: '#e8f0f8', foreground: '#0e2a4e', cursor: '#1a4a80',
  selectionBackground: '#b0cce8',
  black: '#0e2a4e', red: '#b01030', green: '#186830', yellow: '#6a5010',
  blue: '#1a4a80', magenta: '#6a2098', cyan: '#106068', white: '#3a6090',
  brightBlack: '#3a6090', brightRed: '#d02040', brightGreen: '#208840',
  brightYellow: '#887020', brightBlue: '#2868a8', brightMagenta: '#8838b8',
  brightCyan: '#188088', brightWhite: '#0e2a4e',
};
const WORKBENCH_LIGHT_CSS = {
  '--bg-primary': '#e8f0f8', '--bg-secondary': '#f0f4fa', '--bg-tertiary': '#d8e4f0',
  '--bg-hover': '#d0dcea', '--text-primary': '#0e2a4e', '--text-secondary': '#2a5080',
  '--text-muted': '#5a88b0', '--border': '#b8cce0', '--accent': '#1a5a9e',
  '--accent-hover': '#2070b8', '--success': '#208840', '--warning': '#887020', '--danger': '#d02040',
};
const THEMES = {
  dark: { css: null, term: TERM_THEME },
  light: { css: LIGHT_CSS, term: LIGHT_THEME },
  'workbench-dark': { css: WORKBENCH_DARK_CSS, term: WORKBENCH_DARK_THEME },
  'workbench-light': { css: WORKBENCH_LIGHT_CSS, term: WORKBENCH_LIGHT_THEME },
};
// Expose for terminal.js getThemes() lookup
window._THEMES = THEMES;

// ── Local helpers ─────────────────────────────────────────────────────────
function escHtml(str) { return window.escapeHtml(str); }

function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - new Date(timestamp)) / 1000);
  if (seconds < 0 || seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ── createTab wrapper (maps old 5-arg signature → createTerminalTab) ────────
function createTab(tabId, tmuxSession, name, project, cliType) {
  const targetPanel = tabPanelAssignments[tabId] === 'side' ? 'side' : 'primary';
  const targetAreaId = targetPanel === 'side' ? 'side-terminal-area' : 'terminal-area';
  if (targetPanel === 'primary') {
    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.remove();
  }
  return createTerminalTab(tabId, tmuxSession, name, project, cliType, targetPanel, targetAreaId);
}

// ── _getActiveProjectPath (used by files.js and tasks.js via window.*) ──────
function _getActiveProjectPath() {
  if (activeTabId && tabs.has(activeTabId)) {
    const project = tabs.get(activeTabId).project;
    if (project) {
      const projData = projectState.find(p => p.name === project);
      if (projData?.path) return projData.path;
    }
  }
  return _lastClickedProjectPath || null;
}
window._getActiveProjectPath = _getActiveProjectPath;

// ── Program modal shell ──────────────────────────────────────────────────────
function _programModalShell(overlayId, title, bodyHtml) {
  const overlay = document.createElement('div');
  overlay.id = overlayId;
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:24px;width:420px" onclick="event.stopPropagation()">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3 style="font-size:14px;margin:0">${escHtml(title)}</h3>
        <button style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px" title="Close" onclick="document.getElementById('${overlayId}').remove()">&#10005;</button>
      </div>
      ${bodyHtml}
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

// ── Optimistic pending-assignment helper ─────────────────────────────────────
async function _assignProjectToProgram(projName, newProgramId) {
  const proj = projectState.find(p => p.name === projName);
  if (!proj) return;
  const oldProgramId = proj.program_id ?? null;
  if ((oldProgramId ?? null) === (newProgramId ?? null)) return;
  proj.program_id = newProgramId;
  _pendingProgramAssignments.set(projName, newProgramId);
  renderSidebar();
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projName)}/program`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ program_id: newProgramId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const stillProj = projectState.find(p => p.name === projName);
    if (stillProj && (stillProj.program_id ?? null) !== (newProgramId ?? null)) {
      stillProj.program_id = newProgramId;
      renderSidebar();
    }
    if (_pendingProgramAssignments.get(projName) === newProgramId) {
      _pendingProgramAssignments.delete(projName);
    }
  } catch (err) {
    const stillProj = projectState.find(p => p.name === projName);
    if (stillProj) { stillProj.program_id = oldProgramId; renderSidebar(); }
    _pendingProgramAssignments.delete(projName);
    console.error('_assignProjectToProgram failed:', err);
  }
}

// ── Program management ──────────────────────────────────────────────────────
async function addProgram() {
  const overlayId = 'prog-new-' + Date.now();
  const body = `
    <div style="margin-bottom:12px">
      <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Name</label>
      <input id="prog-new-name" type="text" placeholder="Program name" style="width:100%;padding:6px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:13px;outline:none;box-sizing:border-box" autofocus>
    </div>
    <div style="margin-bottom:16px">
      <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Description <span style="color:var(--text-muted)">(optional)</span></label>
      <textarea id="prog-new-desc" placeholder="What this program contains" style="width:100%;min-height:80px;padding:6px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:12px;font-family:inherit;resize:vertical;outline:none;box-sizing:border-box"></textarea>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button id="prog-new-cancel" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:13px">Cancel</button>
      <button id="prog-new-save" style="padding:6px 16px;background:var(--accent);color:#0d1117;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600">Create</button>
    </div>
  `;
  _programModalShell(overlayId, 'New Program', body);
  setTimeout(() => document.getElementById('prog-new-name')?.focus(), 50);
  document.getElementById('prog-new-cancel').addEventListener('click', () => document.getElementById(overlayId).remove());
  document.getElementById('prog-new-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('prog-new-save').click(); }
  });
  document.getElementById('prog-new-save').addEventListener('click', async () => {
    const name = document.getElementById('prog-new-name').value.trim();
    const description = document.getElementById('prog-new-desc').value;
    if (!name) { document.getElementById('prog-new-name').focus(); return; }
    const r = await fetch('/api/programs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      await window.showErrorModal({ title: 'Create program failed', message: err.error || r.statusText });
      return;
    }
    const program = await r.json();
    expandedPrograms.add(String(program.id));
    localStorage.setItem('expandedPrograms', JSON.stringify([...expandedPrograms]));
    document.getElementById(overlayId).remove();
    await loadState();
  });
}

async function openProgramConfig(programId) {
  const program = await fetch(`/api/programs/${programId}/project-count`).then(r => r.ok ? r.json() : null);
  if (!program) { window.showErrorModal({ title: 'Not found', message: 'Program not found' }); return; }
  const p = program.program;
  const overlayId = 'prog-cfg-' + Date.now();
  const body = `
    <div style="margin-bottom:12px">
      <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Name</label>
      <input id="prog-cfg-name" type="text" value="${escHtml(p.name)}" style="width:100%;padding:6px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:13px;outline:none;box-sizing:border-box">
    </div>
    <div style="margin-bottom:12px">
      <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Description</label>
      <textarea id="prog-cfg-desc" style="width:100%;min-height:80px;padding:6px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:12px;font-family:inherit;resize:vertical;outline:none;box-sizing:border-box">${escHtml(p.description || '')}</textarea>
    </div>
    <div style="margin-bottom:12px">
      <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">State</label>
      <select id="prog-cfg-status" style="width:100%;padding:6px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:13px">
        <option value="active" ${p.status === 'active' ? 'selected' : ''}>Active</option>
        <option value="archived" ${p.status === 'archived' ? 'selected' : ''}>Archived</option>
      </select>
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:16px">${program.total} project${program.total === 1 ? '' : 's'} assigned · ${program.counts.active} active · ${program.counts.archived} archived</div>
    <div style="display:flex;gap:8px;justify-content:space-between;align-items:center">
      <button id="prog-cfg-delete" style="padding:6px 12px;background:transparent;color:var(--danger);border:1px solid var(--danger);border-radius:4px;cursor:pointer;font-size:13px">Delete…</button>
      <div style="display:flex;gap:8px">
        <button id="prog-cfg-cancel" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:13px">Cancel</button>
        <button id="prog-cfg-save" style="padding:6px 16px;background:var(--accent);color:#0d1117;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600">Save</button>
      </div>
    </div>
  `;
  _programModalShell(overlayId, 'Program Config', body);
  document.getElementById('prog-cfg-cancel').addEventListener('click', () => document.getElementById(overlayId).remove());
  document.getElementById('prog-cfg-save').addEventListener('click', async () => {
    const name = document.getElementById('prog-cfg-name').value.trim();
    if (!name) { document.getElementById('prog-cfg-name').focus(); return; }
    const description = document.getElementById('prog-cfg-desc').value;
    const status = document.getElementById('prog-cfg-status').value;
    const r = await fetch(`/api/programs/${p.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, status }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      await window.showErrorModal({ title: 'Save failed', message: err.error || r.statusText });
      return;
    }
    document.getElementById(overlayId).remove();
    await loadState();
  });
  document.getElementById('prog-cfg-delete').addEventListener('click', async () => {
    const c = program.counts;
    const msg = program.total === 0
      ? `Delete program "${p.name}"?`
      : `Delete program "${p.name}"?\n\nProjects exist: ${c.active} active, ${c.archived} archived (${program.total} total).\nThey will be moved to "Unassigned".`;
    const ok = await window.showConfirmModal({
      title: 'Delete Program', danger: true, confirmLabel: 'Delete', message: msg,
    });
    if (!ok) return;
    await fetch(`/api/programs/${p.id}`, { method: 'DELETE' });
    document.getElementById(overlayId).remove();
    await loadState();
  });
}

// ── Session management ────────────────────────────────────────────────────────
function openSession(session, projectName) {
  const tabId = session.id;
  if (tabs.has(tabId)) { switchTab(tabId); return; }
  fetch(`/api/sessions/${session.id}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: projectName }),
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) { window.showErrorModal({ title: 'Open session failed', message: data.error }); return; }
    createTab(tabId, data.tmux, session.name, projectName, session.cli_type);
  })
  .catch(err => console.error('Failed to open session:', err));
}

async function createSession(projectName, cliType = 'claude') {
  if (document.querySelector('[id^="new-session-overlay-"]')) return;
  let roles = [];
  try { roles = await fetch('/api/kb/roles').then(r => r.json()); } catch (_e) {}
  const overlay = document.createElement('div');
  const overlayId = 'new-session-overlay-' + Date.now();
  overlay.id = overlayId;
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  const rolePickerHtml = roles.length ? `
    <div style="margin-bottom:16px">
      <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Role <span style="color:var(--text-muted);font-size:11px">(optional)</span></label>
      <select id="new-session-role" style="width:100%;padding:8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:13px;font-family:inherit;outline:none;box-sizing:border-box">
        <option value="">— No role —</option>
        ${roles.map(r => `<option value="${r.name}">${r.label}</option>`).join('')}
      </select>
    </div>` : '';
  overlay.innerHTML = `
    <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:24px;width:480px" onclick="event.stopPropagation()">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3 style="font-size:14px;margin:0">New Session</h3>
        <button style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px" title="Close" onclick="document.getElementById('${overlayId}').remove()">&#10005;</button>
      </div>
      <div style="margin-bottom:16px">
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Session name</label>
        <input id="new-session-name" type="text" maxlength="60" style="width:100%;padding:8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:13px;font-family:inherit;outline:none;box-sizing:border-box" placeholder="Short description of this session" autofocus>
      </div>
      ${rolePickerHtml}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button onclick="document.getElementById('${overlayId}').remove()" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--text-secondary);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:13px">Cancel</button>
        <button id="new-session-submit" style="padding:6px 16px;background:var(--btn-primary);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px">Start Session</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('new-session-name')?.focus(), 50);
  document.getElementById('new-session-submit').addEventListener('click', async () => {
    const name = document.getElementById('new-session-name').value.trim();
    if (!name) { document.getElementById('new-session-name').focus(); return; }
    const role = document.getElementById('new-session-role')?.value || '';
    const btn = document.getElementById('new-session-submit');
    btn.textContent = role ? 'Seeding role…' : 'Creating...';
    btn.disabled = true;
    try {
      const body = { project: projectName, name, cli_type: cliType };
      if (role) body.role = role;
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) { window.showErrorModal({ title: 'Start session failed', message: data.error }); btn.textContent = 'Start Session'; btn.disabled = false; return; }
      overlay.remove();
      createTab(data.id, data.tmux, data.name, projectName, cliType);
      await loadState();
      const poll = setInterval(() => loadState(), 3000);
      setTimeout(() => clearInterval(poll), 30000);
    } catch (err) {
      console.error('Failed to create session:', err);
      btn.textContent = 'Start Session';
      btn.disabled = false;
    }
  });
  document.getElementById('new-session-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('new-session-submit').click();
  });
}

async function openTerminal(projectName) {
  try {
    const res = await fetch('/api/terminals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectName }),
    });
    const data = await res.json();
    if (data.error) { window.showErrorModal({ title: 'Open terminal failed', message: data.error }); return; }
    createTab(data.id, data.tmux, data.name, projectName, 'bash');
  } catch (err) {
    console.error('Failed to create terminal:', err);
  }
}

// ── Session config / rename ──────────────────────────────────────────────────
async function renameSession(sessionId, currentName) {
  const overlay = document.createElement('div');
  const overlayId = 'config-overlay-' + Date.now();
  overlay.id = overlayId;
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  let config = { name: currentName, state: 'active', notes: '' };
  try {
    const res = await fetch(`/api/sessions/${sessionId}/config`);
    config = await res.json();
  } catch {}
  overlay.innerHTML = `
    <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:24px;width:400px" onclick="event.stopPropagation()">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3 style="font-size:14px;margin:0">Session Config</h3>
        <button style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px" title="Close" onclick="document.getElementById('${overlayId}').remove()">&#10005;</button>
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Name</label>
        <div style="position:relative">
          <input id="cfg-name" type="text" value="${escHtml(config.name || '')}" style="width:100%;padding:6px 28px 6px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:13px;outline:none;box-sizing:border-box">
          <button onclick="document.getElementById('cfg-name').value='';document.getElementById('cfg-name').focus()" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:2px 4px" title="Clear">&#10005;</button>
        </div>
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">State</label>
        <select id="cfg-state" style="width:100%;padding:6px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:13px">
          <option value="active" ${config.state === 'active' ? 'selected' : ''}>Active</option>
          <option value="archived" ${config.state === 'archived' ? 'selected' : ''}>Archived</option>
          <option value="hidden" ${config.state === 'hidden' ? 'selected' : ''}>Hidden</option>
        </select>
      </div>
      <div style="margin-bottom:16px">
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Session Notes</label>
        <div style="position:relative">
          <textarea id="cfg-notes" style="width:100%;min-height:80px;padding:6px 28px 6px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:12px;font-family:inherit;resize:vertical;outline:none;box-sizing:border-box" placeholder="Private notes for this session...">${escHtml(config.notes || '')}</textarea>
          <button onclick="document.getElementById('cfg-notes').value='';document.getElementById('cfg-notes').focus()" style="position:absolute;right:4px;top:6px;background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:2px 4px" title="Clear">&#10005;</button>
        </div>
      </div>
      <button onclick="saveSessionConfig('${sessionId}', '${overlayId}')" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px">Save</button>
    </div>
  `;
  document.body.appendChild(overlay);
}

async function saveSessionConfig(sessionId, overlayId) {
  const config = {
    name: document.getElementById('cfg-name').value.trim(),
    state: document.getElementById('cfg-state').value,
    notes: document.getElementById('cfg-notes').value,
  };
  let foundSession = null;
  for (const p of projectState) {
    const s = p.sessions?.find(s => s.id === sessionId);
    if (s) { foundSession = s; break; }
  }
  const before = foundSession ? { name: foundSession.name, state: foundSession.state, notes: foundSession.notes } : null;
  if (foundSession) {
    if (config.name) foundSession.name = config.name;
    foundSession.state = config.state;
    foundSession.notes = config.notes;
    foundSession.archived = config.state === 'archived';
  }
  _pendingSessionEdits.set(sessionId, { name: config.name, state: config.state, notes: config.notes, archived: config.state === 'archived' });
  const tab = tabs.get(sessionId);
  if (tab && config.name) tab.name = config.name;
  renderSidebar._lastHash = '';
  renderSidebar();
  renderTabs();
  document.getElementById(overlayId).remove();
  try {
    const res = await fetch(`/api/sessions/${sessionId}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cur = _pendingSessionEdits.get(sessionId);
    if (cur && cur.name === config.name && cur.state === config.state) _pendingSessionEdits.delete(sessionId);
  } catch (err) {
    if (foundSession && before) {
      foundSession.name = before.name; foundSession.state = before.state;
      foundSession.notes = before.notes; foundSession.archived = before.state === 'archived';
    }
    _pendingSessionEdits.delete(sessionId);
    renderSidebar._lastHash = '';
    renderSidebar();
    console.error('saveSessionConfig failed:', err);
  }
}

async function archiveSession(sessionId, archived) {
  let foundSession = null;
  for (const p of projectState) {
    const s = p.sessions?.find(s => s.id === sessionId);
    if (s) { foundSession = s; break; }
  }
  const before = foundSession ? { state: foundSession.state, archived: !!foundSession.archived } : null;
  const newState = archived ? 'archived' : 'active';
  if (foundSession) { foundSession.state = newState; foundSession.archived = !!archived; }
  _pendingSessionEdits.set(sessionId, { state: newState, archived: !!archived });
  renderSidebar._lastHash = '';
  renderSidebar();
  try {
    const res = await fetch(`/api/sessions/${sessionId}/archive`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _pendingSessionEdits.delete(sessionId);
  } catch (err) {
    if (foundSession && before) { foundSession.state = before.state; foundSession.archived = before.archived; }
    _pendingSessionEdits.delete(sessionId);
    renderSidebar._lastHash = '';
    renderSidebar();
    console.error('Failed to archive:', err);
  }
}

// ── Project config ───────────────────────────────────────────────────────────
async function openProjectConfig(projectName) {
  const overlayId = 'proj-config-' + Date.now();
  const overlay = document.createElement('div');
  overlay.id = overlayId;
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  let config = { name: projectName, state: 'active', notes: '' };
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectName)}/config`);
    config = await res.json();
  } catch {}
  overlay.innerHTML = `
    <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:24px;width:400px" onclick="event.stopPropagation()">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3 style="font-size:14px;margin:0">Project Config</h3>
        <button style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px" title="Close" onclick="document.getElementById('${overlayId}').remove()">&#10005;</button>
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Name</label>
        <input id="proj-cfg-name" type="text" value="${escHtml(config.name || '')}" style="width:100%;padding:6px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:13px;outline:none;box-sizing:border-box">
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Directory</label>
        <input type="text" value="${escHtml(config.path || '')}" readonly style="width:100%;padding:6px 8px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:4px;color:var(--text-muted);font-size:12px;font-family:monospace;outline:none;box-sizing:border-box;cursor:default">
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">State</label>
        <select id="proj-cfg-state" style="width:100%;padding:6px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:13px">
          <option value="active" ${config.state === 'active' ? 'selected' : ''}>Active</option>
          <option value="archived" ${config.state === 'archived' ? 'selected' : ''}>Archived</option>
          <option value="hidden" ${config.state === 'hidden' ? 'selected' : ''}>Hidden</option>
        </select>
      </div>
      <div style="margin-bottom:16px">
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Project Notes</label>
        <textarea id="proj-cfg-notes" style="width:100%;min-height:80px;padding:6px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:12px;font-family:inherit;resize:vertical;outline:none;box-sizing:border-box" placeholder="Notes about this project...">${escHtml(config.notes || '')}</textarea>
      </div>
      <div style="margin-bottom:16px">
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Project System Prompts</label>
        <div style="display:flex;gap:6px">
          <button onclick="document.getElementById('${overlayId}').remove();openProjectPrompt('${escHtml(config.path || '')}','CLAUDE.md')" style="padding:4px 12px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:12px"><span style="color:#e8a55d;font-weight:bold">C</span> Claude</button>
          <button onclick="document.getElementById('${overlayId}').remove();openProjectPrompt('${escHtml(config.path || '')}','GEMINI.md')" style="padding:4px 12px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:12px"><span style="color:#4285f4;font-weight:bold">G</span> Gemini</button>
          <button onclick="document.getElementById('${overlayId}').remove();openProjectPrompt('${escHtml(config.path || '')}','AGENTS.md')" style="padding:4px 12px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:12px"><span style="color:#10a37f;font-weight:bold">X</span> Codex</button>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="saveProjectConfig('${escHtml(projectName)}', '${overlayId}')" style="padding:6px 16px;background:var(--accent);color:#0d1117;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

async function openProjectPrompt(projectPath, filename) {
  const filePath = projectPath.replace(/\/?$/, '/') + filename;
  try {
    const check = await fetch('/api/file?path=' + encodeURIComponent(filePath));
    if (!check.ok) {
      const globalPath = '/data/.claude/' + filename;
      const tmpl = await fetch('/api/file?path=' + encodeURIComponent(globalPath));
      const content = tmpl.ok ? await tmpl.text() : '# ' + filename + '\n\nProject-specific instructions for this CLI.\n';
      await fetch('/api/file?path=' + encodeURIComponent(filePath), {
        method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: content,
      });
    }
  } catch {}
  openFileTab(filePath);
}

async function saveProjectConfig(projectName, overlayId) {
  const config = {
    name: document.getElementById('proj-cfg-name').value.trim(),
    state: document.getElementById('proj-cfg-state').value,
    notes: document.getElementById('proj-cfg-notes').value,
  };
  const proj = projectState.find(p => p.name === projectName);
  const before = proj ? { name: proj.name, state: proj.state, notes: proj.notes } : null;
  if (proj) {
    if (config.name) proj.name = config.name;
    proj.state = config.state;
    proj.notes = config.notes;
  }
  _pendingProjectEdits.set(projectName, { name: config.name, state: config.state, notes: config.notes });
  if (config.name && config.name !== projectName) {
    _pendingProjectEdits.set(config.name, { name: config.name, state: config.state, notes: config.notes });
  }
  renderSidebar._lastHash = '';
  renderSidebar();
  document.getElementById(overlayId).remove();
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectName)}/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _pendingProjectEdits.delete(projectName);
    if (config.name && config.name !== projectName) _pendingProjectEdits.delete(config.name);
  } catch (err) {
    if (proj && before) { proj.name = before.name; proj.state = before.state; proj.notes = before.notes; }
    _pendingProjectEdits.delete(projectName);
    if (config.name && config.name !== projectName) _pendingProjectEdits.delete(config.name);
    renderSidebar._lastHash = '';
    renderSidebar();
    console.error('saveProjectConfig failed:', err);
  }
}

// ── Session summary ───────────────────────────────────────────────────────────
async function summarizeSession(sessionId, projectName, sessionName) {
  const overlayId = 'summary-overlay-' + Date.now();
  const overlay = document.createElement('div');
  overlay.id = overlayId;
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
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
        for (const m of data.recentMessages) {
          const label = m.role === 'user' ? 'Human' : 'Claude';
          html += `<div style="font-size:11px;padding:4px 0;border-bottom:1px solid var(--border)"><strong>${label}:</strong> ${escHtml(m.text.substring(0, 150))}${m.text.length > 150 ? '...' : ''}</div>`;
        }
      }
      el.innerHTML = html;
    } else {
      el.textContent = data.error || 'Failed to generate summary';
    }
  } catch (err) {
    document.getElementById('summary-content').textContent = 'Error: ' + err.message;
  }
}

// ── Right panel ───────────────────────────────────────────────────────────────
let panelOpen = false;
let activePanel = 'files';
let currentPanelProject = null;

function togglePanel() {
  panelOpen = !panelOpen;
  document.getElementById('right-panel').classList.toggle('open', panelOpen);
  if (panelOpen) loadPanelData();
  setTimeout(() => {
    if (activeTabId && tabs.has(activeTabId)) {
      const t = tabs.get(activeTabId);
      if (t?.fitAddon) t.fitAddon.fit();
    }
  }, 250);
}

function switchPanel(panel) {
  activePanel = panel;
  document.querySelectorAll('.panel-tab').forEach(b => b.classList.toggle('active', b.dataset.panel === panel));
  document.getElementById('panel-tasks').style.display = panel === 'tasks' ? '' : 'none';
  document.getElementById('panel-files').style.display = panel === 'files' ? '' : 'none';
  document.getElementById('panel-home-files').style.display = panel === 'files' ? '' : 'none';
  document.getElementById('panel-refresh-files').style.display = panel === 'files' ? '' : 'none';
  document.getElementById('panel-home-tasks').style.display = panel === 'tasks' ? '' : 'none';
  document.getElementById('panel-refresh-tasks').style.display = panel === 'tasks' ? '' : 'none';
  loadPanelData();
}

function getCurrentProject() {
  if (!activeTabId || !tabs.has(activeTabId)) return null;
  return tabs.get(activeTabId).project;
}

async function loadPanelData() {
  if (activePanel === 'files') {
    const POLL_ON_FOCUS_DEBOUNCE_MS = 1000;
    if (!_fileBrowserTree) {
      loadFiles();
    } else if (!loadPanelData._lastFileRefresh || Date.now() - loadPanelData._lastFileRefresh > POLL_ON_FOCUS_DEBOUNCE_MS) {
      loadPanelData._lastFileRefresh = Date.now();
      refreshFileTree();
    }
    return;
  }
  if (activePanel === 'tasks') { loadTaskTree(); return; }
  const project = getCurrentProject();
  if (!project) return;
  currentPanelProject = project;
}

// ── Auth modal (F13: pending extraction to auth.js) ───────────────────────────
let authModalVisible = false;
let authTriggerTabId = null;
const ptyOutputBuffer = new Map();
window.ptyOutputBuffer = ptyOutputBuffer;

const OAUTH_URL_PATTERNS = window.OAuthDetector.OAUTH_URL_PATTERNS;
const AUTH_ERROR_PATTERN = window.OAuthDetector.AUTH_ERROR_PATTERN;
let oauthDetection = { claude: true, gemini: false, codex: false };

const _oauthDetector = window.OAuthDetector.createOAuthDetector({
  ptyOutputBuffer,
  oauthDetection,
  getCliType: (tabId) => tabs.get(tabId)?.cli_type || 'claude',
  isModalVisible: () => authModalVisible,
  onAuthDetected: ({ tabId, url }) => showAuthModal(url, tabId),
});

function checkForAuthIssue(tabId, data) { _oauthDetector.feed(tabId, data); }

function showAuthModal(url, tabId) {
  authModalVisible = true;
  authTriggerTabId = tabId;
  window._authTriggerTabId = tabId;
  // eslint-disable-next-line no-control-regex
  let cleanUrl = url.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x07\x1b\x00-\x1f]/g, '');
  cleanUrl = cleanUrl.replace(/[&?]+$/, '');
  document.getElementById('auth-link').href = cleanUrl;
  document.getElementById('auth-code-input').value = '';
  const errEl = document.getElementById('auth-error');
  if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
  document.getElementById('auth-modal').classList.add('visible');
  document.getElementById('auth-code-input').focus();
}

function dismissAuthModal() {
  document.getElementById('auth-modal').classList.remove('visible');
  authModalVisible = false;
  authTriggerTabId = null;
  window._authTriggerTabId = null;
}

async function submitAuthCode() {
  const code = document.getElementById('auth-code-input').value.trim();
  if (!code) return;
  const submitBtn = document.getElementById('auth-code-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Authenticating...';
  const sessionId = (authTriggerTabId && tabs.has(authTriggerTabId))
    ? tabs.get(authTriggerTabId).id : null;
  try {
    if (!sessionId) throw new Error('No session attached to this auth modal');
    let r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send_text`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: code }),
    });
    if (!r.ok) throw new Error(`send_text failed (HTTP ${r.status})`);
    r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send_key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'Enter' }),
    });
    if (!r.ok) throw new Error(`send_key failed (HTTP ${r.status})`);
  } catch (err) {
    submitBtn.textContent = 'Retry';
    submitBtn.disabled = false;
    const errEl = document.getElementById('auth-error');
    if (errEl) { errEl.textContent = `Submit failed: ${err.message}`; errEl.style.display = 'block'; }
    return;
  }
  setTimeout(() => {
    document.getElementById('auth-modal').classList.remove('visible');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit';
    authModalVisible = false;
    authTriggerTabId = null;
  }, 1500);
}

document.getElementById('auth-code-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitAuthCode();
});
document.getElementById('auth-modal').addEventListener('click', (e) => {
  if (e.target.id === 'auth-modal') dismissAuthModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.getElementById('settings-modal').classList.contains('visible')) {
      closeSettings();
    } else if (authModalVisible) {
      dismissAuthModal();
    }
  }
});

// ── File drag-and-drop onto terminal ─────────────────────────────────────────
function _wireFileDropOnTerminalArea(area, panel) {
  area.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/plain')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    area.classList.add('drag-over');
  });
  area.addEventListener('dragleave', (e) => {
    if (!area.contains(e.relatedTarget)) area.classList.remove('drag-over');
  });
  area.addEventListener('drop', (e) => {
    if (!e.dataTransfer.types.includes('text/plain')) return;
    e.preventDefault();
    area.classList.remove('drag-over');
    const path = e.dataTransfer.getData('text/plain').trim();
    if (!path) return;
    const tabId = _activeIdForPanel(panel);
    if (tabId && tabs.has(tabId)) {
      const tab = tabs.get(tabId);
      if (tab.ws && tab.ws.readyState === WebSocket.OPEN) tab.ws.send(path);
      if (tab.term) tab.term.focus();
    }
  });
}
_wireFileDropOnTerminalArea(document.getElementById('terminal-area'), 'primary');
_wireFileDropOnTerminalArea(document.getElementById('side-terminal-area'), 'side');

const _resizeObserver = new ResizeObserver(() => {
  if (activeTabId && tabs.has(activeTabId)) {
    const t = tabs.get(activeTabId);
    if (t?.fitAddon) t.fitAddon.fit();
  }
});
_resizeObserver.observe(document.getElementById('terminal-area'));

// ── Status bar ────────────────────────────────────────────────────────────────
function updateStatusBar(panel) {
  if (!panel) { updateStatusBar('primary'); updateStatusBar('side'); return; }
  const barId = panel === 'side' ? 'side-status-bar' : 'status-bar';
  const bar = document.getElementById(barId);
  if (!bar) return;
  const activeId = _activeIdForPanel(panel);
  const tab = activeId ? tabs.get(activeId) : null;
  if (!tab || tab.type === 'file') { bar.classList.remove('active'); return; }
  bar.classList.add('active');
  const cliType = tab.cli_type || 'claude';
  const statusData = tab._statusData || {};
  let model = statusData.model || 'unknown';
  if (model === 'unknown') {
    const sessData = projectState.flatMap(p => p.sessions).find(s => s.id === tab.id);
    if (sessData?.model) model = sessData.model;
  }
  if (model === 'unknown' && (tab.id.startsWith('new_') || tab.id.startsWith('t_'))) {
    model = cliType === 'gemini' ? 'gemini' : cliType === 'codex' ? 'gpt' : 'sonnet';
  }
  const inputTokens = statusData.input_tokens || 0;
  const maxTokens = (typeof statusData.max_tokens === 'number' && statusData.max_tokens > 0) ? statusData.max_tokens : null;
  const pct = maxTokens ? Math.min(100, (inputTokens / maxTokens) * 100) : null;
  const modelShort = model.includes('opus') ? 'Opus' :
    model.includes('sonnet') ? 'Sonnet' :
    model.includes('haiku') ? 'Haiku' :
    model.includes('gemini') ? model.replace('gemini-', '').substring(0, 15) :
    model.includes('gpt') ? model.substring(0, 10) :
    model.substring(0, 15);
  const fillClass = pct == null ? 'context-fill-green' :
    pct < 60 ? 'context-fill-green' : pct < 85 ? 'context-fill-amber' : 'context-fill-red';
  const tokenStr = inputTokens > 1000 ? `${Math.round(inputTokens / 1000)}k` : inputTokens;
  const maxStr = maxTokens == null ? '?' : (maxTokens > 1000 ? `${Math.round(maxTokens / 1000)}k` : maxTokens);
  const pctStr = pct == null ? '?' : `${pct.toFixed(0)}%`;
  const fillWidth = pct == null ? 0 : pct;
  const thinkingLevel = cliType === 'claude' ? (db_getSetting('thinking_level') || 'none') : 'none';
  bar.innerHTML = `
    <span class="status-item"><span class="label">Model:</span> <span class="value">${escHtml(modelShort)}</span></span>
    ${thinkingLevel !== 'none' ? `<span class="status-item"><span class="label">Thinking:</span> <span class="value">${escHtml(thinkingLevel)}</span></span>` : ''}
    <span class="status-item">
      <span class="label">Context:</span>
      <span class="value">${tokenStr} / ${maxStr}</span>
      <span class="context-bar"><span class="fill ${fillClass}" style="width:${fillWidth}%"></span></span>
      <span class="value">${pctStr}</span>
    </span>
    <span class="status-item" style="margin-left:auto">
      <span class="value">${tab.status}</span>
    </span>
  `;
}

async function pollTokenUsage(panel) {
  if (!panel) { await pollTokenUsage('primary'); await pollTokenUsage('side'); return; }
  const activeId = _activeIdForPanel(panel);
  if (!activeId || !tabs.has(activeId)) return;
  const tab = tabs.get(activeId);
  if (tab.type === 'file') return;
  if (!tab.project) return;
  if (tab.id.startsWith('new_') || tab.id.startsWith('t_')) { updateStatusBar(panel); return; }
  try {
    const res = await fetch(`/api/sessions/${tab.id}/tokens?project=${encodeURIComponent(tab.project)}`);
    const data = await res.json();
    tab._statusData = data;
    updateStatusBar(panel);
  } catch {}
}

async function saveProjectTemplate() {
  await saveSetting('default_project_claude_md', document.getElementById('setting-project-template').value);
}

// ── Session search ────────────────────────────────────────────────────────────
let searchActive = false;
let searchTimer = null;
let _searchVersion = 0;

document.getElementById('session-search').addEventListener('input', (e) => {
  if (searchTimer) clearTimeout(searchTimer);
  _searchVersion++;
  const q = e.target.value.trim();
  if (q.length < 2) {
    searchActive = false;
    window._searchActive = false;
    renderSidebar._lastHash = null;
    renderSidebar();
    return;
  }
  searchActive = true;
  window._searchActive = true;
  const myVersion = _searchVersion;
  searchTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (myVersion !== _searchVersion) return;
      renderSearchResults(data.results);
    } catch {
      if (myVersion !== _searchVersion) return;
    }
  }, 300);
});

function renderSearchResults(results) {
  const container = document.getElementById('project-list');
  container.innerHTML = '';
  if (results.length === 0) {
    container.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:12px">No matches found</div>';
    return;
  }
  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'session-item';
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
      window._searchActive = false;
      renderSidebar._lastHash = null;
      openSession({ id: r.sessionId, name: r.name }, r.project);
      renderSidebar();
    });
    container.appendChild(item);
  }
}

// ── Appearance (F12: pending extraction to settings.js) ───────────────────────
function applyTheme(theme) {
  const root = document.documentElement;
  const config = THEMES[theme] || THEMES.dark;
  const allKeys = new Set([
    ...Object.keys(LIGHT_CSS),
    ...Object.keys(WORKBENCH_DARK_CSS),
    ...Object.keys(WORKBENCH_LIGHT_CSS),
  ]);
  allKeys.forEach(k => root.style.removeProperty(k));
  if (config.css) Object.entries(config.css).forEach(([k, v]) => root.style.setProperty(k, v));
  for (const [, tab] of tabs) {
    if (tab.term) tab.term.options.theme = config.term;
  }
  const isDark = theme === 'dark' || theme === 'workbench-dark';
  const variant = db_getSetting('logo_variant') || 'default';
  const prefix = variant === 'development' ? 'dev' : variant === 'production' ? 'prod' : 'logo';
  document.querySelectorAll('.logo-dark').forEach(el => {
    el.src = `/${prefix}-dark.png`;
    el.style.display = isDark ? 'block' : 'none';
  });
  document.querySelectorAll('.logo-light').forEach(el => {
    el.src = `/${prefix}-light.png`;
    el.style.display = isDark ? 'none' : 'block';
  });
}

function applyFontSize(size) {
  for (const [, tab] of tabs) {
    if (tab.type === 'file') continue;
    if (tab.term) tab.term.options.fontSize = size;
    if (tab.fitAddon) tab.fitAddon.fit();
  }
}

function applyFontFamily(family) {
  for (const [, tab] of tabs) {
    if (tab.type === 'file') continue;
    if (tab.term) tab.term.options.fontFamily = family;
    if (tab.fitAddon) tab.fitAddon.fit();
  }
}

async function loadAppearanceSettings() {
  try {
    const res = await fetch('/api/settings');
    const s = await res.json();
    setSettingsCache(s);
    applyTheme(s.theme || 'workbench-dark');
    if (s.font_size) applyFontSize(s.font_size);
    if (s.font_family) applyFontFamily(s.font_family);
  } catch {}
}

// ── Add project ───────────────────────────────────────────────────────────────
async function addProject(programId) {
  window._pendingProgramId = programId == null ? null : Number(programId);
  const overlayId = 'dir-picker-' + Date.now();
  const overlay = document.createElement('div');
  overlay.id = overlayId;
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:24px;width:550px;max-height:80vh;display:flex;flex-direction:column" onclick="event.stopPropagation()">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="font-size:14px;margin:0">Add Project</h3>
        <button style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px" title="Close" onclick="document.getElementById('${overlayId}').remove()">&#10005;</button>
      </div>
      <div id="picker-tree" style="overflow-y:auto;min-height:300px;max-height:50vh;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;padding:4px"></div>
      <div style="display:flex;gap:8px;margin-top:12px;align-items:center">
        <input id="picker-path" type="text" readonly placeholder="Click a folder above" style="flex:1;padding:6px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:12px;font-family:monospace">
        <input id="picker-name" type="text" placeholder="Name" style="width:120px;padding:6px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:12px">
        <button style="padding:6px 12px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);cursor:pointer;font-size:12px" onclick="pickerNewFolder()">+ Folder</button>
        <button style="padding:6px 16px;background:var(--btn-primary);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px" onclick="pickerSelect('${overlayId}')">Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  let mounts = [];
  try {
    const res = await fetch('/api/mounts');
    mounts = await res.json();
  } catch {}
  if (mounts.length === 0) mounts = [{ path: window._workspace || '/data/workspace' }];
  const treeEl = document.getElementById('picker-tree');
  treeEl.innerHTML = '';
  function selectPath(path) {
    document.getElementById('picker-path').value = path;
    document.getElementById('picker-name').value = path.replace(/\/$/, '').split('/').filter(Boolean).pop();
  }
  window._pickerTree = createFileTree({
    el: treeEl,
    mounts,
    foldersOnly: true,
    autoExpandFirstMount: true,
    onSelect: (path, isDir) => { if (isDir) selectPath(path); },
  });
}

async function pickerSelect(overlayId) {
  const path = document.getElementById('picker-path').value.trim();
  const name = document.getElementById('picker-name').value.trim() || path.split('/').filter(Boolean).pop();
  if (!path || path === '/') { window.showErrorModal({ title: 'No directory selected', message: 'Select a directory first' }); return; }
  try {
    const res = await fetch('/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, name }),
    });
    const data = await res.json();
    if (data.error) { window.showErrorModal({ title: 'Add project failed', message: data.error }); return; }
    if (window._pendingProgramId != null) {
      await fetch(`/api/projects/${encodeURIComponent(data.name)}/program`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ program_id: window._pendingProgramId }),
      }).catch(() => {});
    }
    window._pendingProgramId = null;
    document.getElementById(overlayId).remove();
    loadState();
  } catch (err) { window.showErrorModal({ title: 'Add project failed', message: err.message }); }
}

async function pickerNewFolder() {
  const parentPath = document.getElementById('picker-path').value.trim() || (window._workspace || '/data/workspace');
  const name = await window.showInputModal({ title: 'New Folder', label: 'Folder name:', placeholder: 'docs' });
  if (!name) return;
  const parentNormalized = parentPath.replace(/\/?$/, '/');
  const newPath = parentNormalized + name;
  try {
    const res = await fetch('/api/mkdir', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newPath }),
    });
    const data = await res.json();
    if (data.error) { window.showErrorModal({ title: 'Create folder failed', message: data.error }); return; }
    await window._pickerTree?.refreshDirectory(parentNormalized);
    document.getElementById('picker-path').value = newPath + '/';
    document.getElementById('picker-name').value = name;
  } catch (err) { window.showErrorModal({ title: 'Create folder failed', message: err.message }); }
}

// ── Settings (F12: pending extraction to settings.js) ────────────────────────
function switchSettingsTab(tab) {
  document.querySelectorAll('[data-settings-tab]').forEach(b => b.classList.toggle('active', b.dataset.settingsTab === tab));
  const showGeneral = tab === 'general';
  document.getElementById('settings-general').style.display = showGeneral ? '' : 'none';
  const tail = document.getElementById('settings-general-rest');
  if (tail) tail.style.display = showGeneral ? '' : 'none';
  document.getElementById('settings-git').style.display = tab === 'git' ? '' : 'none';
  document.getElementById('settings-claude').style.display = tab === 'claude' ? '' : 'none';
  document.getElementById('settings-vector').style.display = tab === 'vector' ? '' : 'none';
  document.getElementById('settings-prompts').style.display = tab === 'prompts' ? '' : 'none';
  if (tab === 'vector') loadVectorSettings();
  if (tab === 'git') refreshGitAccounts();
}

async function openSettings() {
  document.getElementById('settings-modal').classList.add('visible');
  try {
    const res = await fetch('/api/settings');
    const s = await res.json();
    let modelVal = s.default_model || 'sonnet';
    if (modelVal.startsWith('claude-opus-')) modelVal = 'opus';
    else if (modelVal.startsWith('claude-sonnet-')) modelVal = 'sonnet';
    else if (modelVal.startsWith('claude-haiku-')) modelVal = 'haiku';
    document.getElementById('setting-model').value = modelVal;
    document.getElementById('setting-thinking').value = s.thinking_level || 'none';
    document.getElementById('setting-keepalive-mode').value = s.keepalive_mode || 'always';
    document.getElementById('setting-idle-minutes').value = s.keepalive_idle_minutes || 30;
    if (s.oauth_detection && typeof s.oauth_detection === 'object') {
      oauthDetection.claude = s.oauth_detection.claude !== undefined ? !!s.oauth_detection.claude : true;
      oauthDetection.gemini = !!s.oauth_detection.gemini;
      oauthDetection.codex = !!s.oauth_detection.codex;
    }
    const oauthClaudeEl = document.getElementById('setting-oauth-claude');
    const oauthGeminiEl = document.getElementById('setting-oauth-gemini');
    const oauthCodexEl = document.getElementById('setting-oauth-codex');
    if (oauthClaudeEl) oauthClaudeEl.checked = oauthDetection.claude;
    if (oauthGeminiEl) oauthGeminiEl.checked = oauthDetection.gemini;
    if (oauthCodexEl) oauthCodexEl.checked = oauthDetection.codex;
    document.getElementById('setting-project-template').value = s.default_project_claude_md || '';
    if (s.theme) document.getElementById('setting-theme').value = s.theme;
    if (s.font_size) document.getElementById('setting-font-size').value = s.font_size;
    if (s.font_family) document.getElementById('setting-font-family').value = s.font_family;
    if (s.gemini_api_key) document.getElementById('setting-gemini-key').value = s.gemini_api_key;
    if (s.codex_api_key) document.getElementById('setting-codex-key').value = s.codex_api_key;
    if (s.huggingface_api_key) document.getElementById('setting-huggingface-key').value = s.huggingface_api_key;
    document.getElementById('setting-kb-repo-name').value = s.kb_repo_name || 'blueprint_workbench_kb';
    document.getElementById('setting-kb-sync-interval').value = s.kb_sync_interval_minutes || 5;
    refreshGitAccounts();
    loadKbStatus();
  } catch {}
  loadMcpServers();
}

async function loadVectorSettings() {
  try {
    const [settingsRes, statusRes] = await Promise.all([fetch('/api/settings'), fetch('/api/qdrant/status')]);
    const s = await settingsRes.json();
    const st = await statusRes.json();
    const statusEl = document.getElementById('vector-qdrant-status');
    if (st.available) {
      statusEl.innerHTML = '<span style="color:#3fb950">&#9679;</span> Connected';
      statusEl.style.color = 'var(--text-primary)';
    } else {
      statusEl.innerHTML = '<span style="color:#f85149">&#9679;</span> Not available';
      statusEl.style.color = 'var(--text-muted)';
    }
    const provider = s.vector_embedding_provider || 'none';
    const providerEl = document.getElementById('setting-vector-provider');
    providerEl.value = provider;
    try {
      const credRes = await fetch('/api/cli-credentials');
      const creds = await credRes.json();
      const cred = { gemini: creds.gemini, openai: creds.openai, huggingface: creds.huggingface };
      const labels = {
        gemini: ['Gemini', 'Gemini (no key — set in Settings → API Keys)'],
        openai: ['OpenAI', 'OpenAI (no key — set in Settings → API Keys)'],
        huggingface: ['Hugging Face', 'Hugging Face (no key — set in Settings → API Keys)'],
      };
      for (const [name, [okLabel, missLabel]] of Object.entries(labels)) {
        const opt = providerEl.querySelector(`option[value="${name}"]`);
        if (!opt) continue;
        const have = !!cred[name];
        opt.disabled = !have;
        opt.textContent = have ? okLabel : missLabel;
      }
    } catch {}
    document.getElementById('vector-custom-fields').style.display = provider === 'custom' ? '' : 'none';
    if (s.vector_custom_url) document.getElementById('setting-vector-custom-url').value = s.vector_custom_url;
    if (s.vector_custom_key) document.getElementById('setting-vector-custom-key').value = s.vector_custom_key;
    const colNames = ['documents', 'code', 'claude', 'gemini', 'codex'];
    for (const col of colNames) {
      const cfg = s['vector_collection_' + col] || {};
      const enabledEl = document.getElementById('vector-col-' + col + '-enabled');
      const dimsEl = document.getElementById('vector-col-' + col + '-dims');
      const patternsEl = document.getElementById('vector-col-' + col + '-patterns');
      const countEl = document.getElementById('vector-col-' + col + '-count');
      if (enabledEl) enabledEl.checked = cfg.enabled !== false;
      if (dimsEl) dimsEl.value = cfg.dims || 384;
      if (patternsEl && cfg.patterns) patternsEl.value = cfg.patterns.join('\n');
      if (countEl && st.collections) {
        const colSt = st.collections[col];
        countEl.textContent = colSt ? `(${colSt.points} points)` : '';
      }
    }
    if (s.vector_ignore_patterns) document.getElementById('setting-vector-ignore').value = s.vector_ignore_patterns;
    const paths = s.vector_additional_paths || [];
    renderVectorPaths(paths);
  } catch (err) { console.error('Failed to load vector settings:', err); }
}

function onVectorProviderChange(provider) {
  const sel = document.getElementById('setting-vector-provider');
  saveSetting('vector_embedding_provider', provider, sel);
  document.getElementById('vector-custom-fields').style.display = provider === 'custom' ? '' : 'none';
}

function saveCollectionConfig(col) {
  const enabled = document.getElementById('vector-col-' + col + '-enabled')?.checked ?? true;
  const dims = parseInt(document.getElementById('vector-col-' + col + '-dims')?.value) || 384;
  const patternsEl = document.getElementById('vector-col-' + col + '-patterns');
  const cfg = { enabled, dims };
  if (patternsEl) cfg.patterns = patternsEl.value.split('\n').map(p => p.trim()).filter(p => p);
  saveSetting('vector_collection_' + col, cfg);
}

async function reindexCollection(col) {
  const btn = event.target;
  btn.textContent = 'Indexing...';
  btn.disabled = true;
  try {
    await fetch('/api/qdrant/reindex', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection: col }),
    });
    setTimeout(async () => { await loadVectorSettings(); btn.textContent = 'Re-index'; btn.disabled = false; }, 3000);
  } catch { btn.textContent = 'Re-index'; btn.disabled = false; }
}

function renderVectorPaths(paths) {
  const container = document.getElementById('vector-additional-paths');
  container.innerHTML = paths.map((p, i) =>
    `<div style="display:flex;gap:4px;margin-bottom:4px;align-items:center">
      <span style="flex:1;font-size:12px;font-family:monospace;color:var(--text-primary);padding:4px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px">${p}</span>
      <button onclick="removeVectorPath(${i})" style="padding:2px 8px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:4px;color:var(--text-muted);cursor:pointer;font-size:11px">x</button>
    </div>`
  ).join('');
}

async function addVectorPath() {
  const input = document.getElementById('vector-new-path');
  const path = input.value.trim();
  if (!path) return;
  const ws = window._workspace || '/data/workspace';
  if (path === ws || path.startsWith(ws + '/')) {
    showSettingsError(`Paths under ${ws} are already scanned. Additional Paths is for paths outside the workspace.`);
    return;
  }
  const res = await fetch('/api/settings');
  const s = await res.json();
  const paths = s.vector_additional_paths || [];
  if (!paths.includes(path)) {
    paths.push(path);
    if (!await saveSetting('vector_additional_paths', paths)) return;
  }
  input.value = '';
  renderVectorPaths(paths);
}

async function removeVectorPath(idx) {
  const res = await fetch('/api/settings');
  const s = await res.json();
  const paths = s.vector_additional_paths || [];
  paths.splice(idx, 1);
  await saveSetting('vector_additional_paths', paths);
  renderVectorPaths(paths);
}

// ── KB / Git account helpers ─────────────────────────────────────────────────
const KB_REPO_DEFAULT = 'https://github.com/rmdevpro/workbench-kb';

function kbRepoName() {
  return (document.getElementById('setting-kb-repo-name')?.value.trim()) || 'blueprint_workbench_kb';
}

function kbUrlForAccount(account) {
  if (!account || !account.path) return KB_REPO_DEFAULT;
  return `https://${account.path}/${kbRepoName()}`;
}

function renderKbRepoUrl(accounts) {
  const kb = (accounts || []).find(a => a.isKB);
  const url = kb ? kbUrlForAccount(kb) : KB_REPO_DEFAULT;
  document.getElementById('setting-kb-repo-url').textContent = url;
}

async function refreshKbRepoUrl() {
  const r = await fetch('/api/git-accounts');
  const data = await r.json();
  const accounts = data.accounts || [];
  const kb = accounts.find(a => a.isKB);
  const url = kb ? kbUrlForAccount(kb) : KB_REPO_DEFAULT;
  await saveSetting('kb_repo_url', url);
  renderKbRepoUrl(accounts);
}

async function loadKbStatus() {
  try {
    const res = await fetch('/api/kb/status');
    const s = await res.json();
    const line = document.getElementById('kb-status-line');
    const forkBtn = document.getElementById('kb-fork-btn');
    const syncBtn = document.getElementById('kb-sync-btn');
    if (!s.initialized) { line.textContent = 'Not initialized'; if (syncBtn) syncBtn.disabled = true; return; }
    if (syncBtn) syncBtn.disabled = false;
    const parts = [];
    if (s.ahead) parts.push(`↑${s.ahead}`);
    if (s.behind) parts.push(`↓${s.behind}`);
    if (s.lastSync) parts.push(`synced ${new Date(s.lastSync).toLocaleString()}`);
    if (s.originUrl) parts.push(s.originUrl);
    line.textContent = parts.join(' · ') || 'Up to date';
    if (forkBtn) forkBtn.disabled = !getKbAccountFromCache();
  } catch (_e) {}
}

function getKbAccountFromCache() {
  const accounts = _settingsCache.git_accounts || [];
  return accounts.find(a => a.isKB) || null;
}

async function kbFork() {
  const btn = document.getElementById('kb-fork-btn');
  btn.disabled = true; btn.textContent = 'Forking…';
  try {
    const res = await fetch('/api/kb/fork', { method: 'POST' });
    const d = await res.json();
    if (!res.ok) { btn.textContent = d.error || 'Failed'; btn.disabled = false; return; }
    btn.textContent = 'Forked ✓';
    document.getElementById('setting-kb-repo-url').textContent = d.forkUrl;
    await loadKbStatus();
  } catch (e) { btn.textContent = 'Failed'; btn.disabled = false; }
}

async function kbSyncUpstream() {
  const btn = document.getElementById('kb-sync-btn');
  const line = document.getElementById('kb-status-line');
  btn.disabled = true; btn.textContent = 'Syncing…';
  try {
    const res = await fetch('/api/kb/sync-upstream', { method: 'POST' });
    const d = await res.json();
    if (!res.ok) { line.textContent = d.error || 'Sync failed'; btn.disabled = false; btn.textContent = 'Sync from upstream'; return; }
    btn.textContent = 'Sync from upstream';
    await loadKbStatus();
  } catch (e) { btn.textContent = 'Sync from upstream'; line.textContent = 'Sync failed'; btn.disabled = false; }
}

async function refreshGitAccounts() {
  try {
    const r = await fetch('/api/git-accounts');
    const data = await r.json();
    renderGitAccounts(data.accounts || []);
  } catch (_e) { renderGitAccounts([]); }
}

function renderGitAccounts(accounts) {
  renderKbRepoUrl(accounts);
  const el = document.getElementById('git-accounts-list');
  if (!accounts.length) {
    el.innerHTML = '<p style="font-size:11px;color:var(--text-muted);margin:4px 0">No git accounts configured.</p>';
    return;
  }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr style="color:var(--text-muted);text-align:left">
      <th style="padding:3px 6px">Path</th>
      <th style="padding:3px 6px">Name</th>
      <th style="padding:3px 6px">Token</th>
      <th style="padding:3px 6px;text-align:center">KB</th>
      <th style="padding:3px 6px;text-align:center">Default</th>
      <th style="padding:3px 6px"></th>
    </tr></thead>
    <tbody>${accounts.map(a => `
      <tr data-acct-id="${a.id}" style="border-top:1px solid var(--border)">
        <td style="padding:4px 6px;font-family:monospace">${escHtml(a.path)}</td>
        <td style="padding:4px 6px">${escHtml(a.name || '')}</td>
        <td style="padding:4px 6px;font-family:monospace;color:var(--text-muted)">${a.has_token ? '••••••••' : '<em>missing</em>'}</td>
        <td style="padding:4px 6px;text-align:center"><input type="radio" name="kb-account" ${a.isKB ? 'checked' : ''} onchange="setGitAccountFlag('${a.id}', 'isKB', true)"></td>
        <td style="padding:4px 6px;text-align:center"><input type="radio" name="default-account" ${a.default ? 'checked' : ''} onchange="setGitAccountFlag('${a.id}', 'default', true)"></td>
        <td style="padding:4px 6px;display:flex;gap:4px;justify-content:flex-end">
          <button onclick="editGitAccount('${a.id}')" title="Edit" style="padding:2px 8px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);cursor:pointer;font-size:11px">✎</button>
          <button onclick="deleteGitAccount('${a.id}')" title="Delete" style="padding:2px 8px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:4px;color:var(--text-muted);cursor:pointer;font-size:11px">✕</button>
        </td>
      </tr>`).join('')}
    </tbody></table>`;
}

async function editGitAccount(id) {
  const r = await fetch('/api/git-accounts');
  const { accounts } = await r.json();
  const acc = accounts.find(a => a.id === id);
  if (!acc) return;
  const newPath = await window.showInputModal({ title: 'Edit Git Account', label: 'Path (host/account):', defaultValue: acc.path });
  if (newPath == null) return;
  const newName = await window.showInputModal({ title: 'Edit Git Account', label: 'Display name (optional):', defaultValue: acc.name || '' });
  if (newName == null) return;
  const newToken = await window.showInputModal({ title: 'Edit Git Account', label: 'New token (leave blank to keep existing):', placeholder: 'ghp_...' });
  if (newToken == null) return;
  const body = { path: newPath.trim(), name: newName.trim() };
  if (newToken.trim()) body.token = newToken.trim();
  const res = await fetch('/api/git-accounts/' + id, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    await window.showErrorModal({ title: 'Edit failed', message: e.error || res.statusText });
  }
  refreshGitAccounts();
}

async function setGitAccountFlag(id, flag, value) {
  const body = {};
  body[flag === 'isKB' ? 'isKB' : 'default'] = !!value;
  const res = await fetch('/api/git-accounts/' + id, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    window.showErrorModal({ title: 'Update failed', message: e.error || res.statusText });
  }
  refreshGitAccounts();
}

async function addGitAccount() {
  try {
    const path = document.getElementById('git-account-path').value.trim();
    const token = document.getElementById('git-account-token').value.trim();
    if (!path || !token) return;
    const probe = await fetch('/api/git-accounts').then(r => r.json()).catch(() => ({ accounts: [] }));
    const existing = probe.accounts || [];
    const body = { path, token };
    if (!existing.some(a => a.isKB)) body.isKB = true;
    if (!existing.some(a => a.default)) body.default = true;
    const res = await fetch('/api/git-accounts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      await window.showErrorModal({ title: 'Add account failed', message: e.error || res.statusText });
      return;
    }
    document.getElementById('git-account-path').value = '';
    document.getElementById('git-account-token').value = '';
    refreshGitAccounts();
  } catch (err) {
    console.error('addGitAccount failed:', err);
    window.showErrorModal({ title: 'Add account failed', message: err.message });
  }
}

async function deleteGitAccount(id) {
  const res = await fetch('/api/git-accounts/' + id, { method: 'DELETE' });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    window.showErrorModal({ title: 'Delete failed', message: e.error || res.statusText });
  }
  refreshGitAccounts();
}

async function setKbAccount(id) { return setGitAccountFlag(id, 'isKB', true); }

function closeSettings() { document.getElementById('settings-modal').classList.remove('visible'); }

const _settingsSaveVersion = {};

async function saveSetting(key, value, inputEl = null) {
  const previousValue = _settingsCache[key];
  _settingsCache[key] = value;
  const myVersion = (_settingsSaveVersion[key] || 0) + 1;
  _settingsSaveVersion[key] = myVersion;
  const rollback = (errMsg) => {
    if (_settingsSaveVersion[key] !== myVersion) return;
    _settingsCache[key] = previousValue;
    if (inputEl && 'value' in inputEl) inputEl.value = previousValue == null ? '' : String(previousValue);
    showSettingsError(errMsg);
  };
  let res;
  try {
    res = await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
  } catch (err) { rollback(`Save failed: ${err.message}`); return false; }
  if (!res.ok) {
    let errMsg = `Save failed (HTTP ${res.status})`;
    try { const data = await res.json(); if (data && data.error) errMsg = data.error; } catch {}
    rollback(errMsg);
    return false;
  }
  if (_settingsSaveVersion[key] === myVersion) { hideSettingsError(); flashSettingsSaved(); }
  return true;
}

let _settingsSavedHideTimer = null;
function flashSettingsSaved() {
  let pill = document.getElementById('settings-saved-indicator');
  if (!pill) {
    const modal = document.querySelector('#settings-modal .modal-content');
    if (!modal) return;
    pill = document.createElement('div');
    pill.id = 'settings-saved-indicator';
    pill.textContent = '✓ Saved';
    pill.style.cssText = 'position:absolute;top:14px;right:48px;background:var(--bg-tertiary);border:1px solid var(--success,#2ea043);color:var(--success,#2ea043);padding:2px 10px;border-radius:999px;font-size:12px;opacity:0;transition:opacity 0.15s ease;pointer-events:none;';
    modal.appendChild(pill);
  }
  pill.style.opacity = '1';
  if (_settingsSavedHideTimer) clearTimeout(_settingsSavedHideTimer);
  _settingsSavedHideTimer = setTimeout(() => { pill.style.opacity = '0'; }, 1500);
}

function showSettingsError(msg) {
  const modalRoot = document.getElementById('settings-modal');
  if (!modalRoot || !modalRoot.classList.contains('visible')) {
    window.showErrorModal({ title: 'Settings error', message: String(msg) });
    return;
  }
  let banner = document.getElementById('settings-error-banner');
  if (!banner) {
    const modal = document.querySelector('#settings-modal .modal-content');
    if (!modal) { window.showErrorModal({ title: 'Settings error', message: String(msg) }); return; }
    banner = document.createElement('div');
    banner.id = 'settings-error-banner';
    banner.style.cssText = 'background:var(--bg-tertiary);border:1px solid var(--error,#d32f2f);color:var(--error,#d32f2f);padding:8px 12px;margin:8px 0;border-radius:4px;font-size:13px;display:flex;align-items:center;justify-content:space-between;gap:8px;';
    const msgWrap = document.createElement('span');
    const icon = document.createElement('span');
    icon.style.cssText = 'font-size:14px;margin-right:4px';
    icon.textContent = '⚠';
    const msgEl = document.createElement('span');
    msgEl.id = 'settings-error-banner-msg';
    msgWrap.appendChild(icon);
    msgWrap.appendChild(msgEl);
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;color:var(--error,#d32f2f);cursor:pointer;font-size:16px;padding:0 4px';
    closeBtn.textContent = '×';
    closeBtn.onclick = hideSettingsError;
    banner.appendChild(msgWrap);
    banner.appendChild(closeBtn);
    modal.insertBefore(banner, modal.firstElementChild?.nextElementSibling || null);
  }
  const msgEl = document.getElementById('settings-error-banner-msg');
  if (msgEl) msgEl.textContent = String(msg).slice(0, 600);
}

function hideSettingsError() {
  const banner = document.getElementById('settings-error-banner');
  if (banner) banner.remove();
}

async function loadMcpServers() {
  try {
    const res = await fetch('/api/mcp-servers');
    const data = await res.json();
    const container = document.getElementById('mcp-server-list');
    const servers = data.servers || {};
    const names = Object.keys(servers);
    if (names.length === 0) {
      container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:4px 0">No MCP servers configured</div>';
      return;
    }
    container.innerHTML = names.map(name => {
      const s = servers[name];
      const type = s.command ? 'stdio' : s.url ? 'sse' : 'unknown';
      const detail = s.command ? s.command + ' ' + (s.args || []).join(' ') : s.url || '';
      return `<div class="mcp-server-item">
        <span class="name">${escHtml(name)}</span>
        <span class="type">${type}</span>
        <button class="remove" onclick="removeMcpServer('${escHtml(name)}')" title="Remove">&#10005;</button>
      </div>`;
    }).join('');
  } catch {}
}

async function addMcpServer() {
  const name = document.getElementById('mcp-name').value.trim();
  const command = document.getElementById('mcp-command').value.trim();
  if (!name || !command) return;
  const parts = command.split(/\s+/);
  const res = await fetch('/api/mcp-servers');
  const data = await res.json();
  const servers = data.servers || {};
  servers[name] = { command: parts[0], args: parts.slice(1) };
  await fetch('/api/mcp-servers', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ servers }),
  });
  document.getElementById('mcp-name').value = '';
  document.getElementById('mcp-command').value = '';
  loadMcpServers();
}

async function removeMcpServer(name) {
  const res = await fetch('/api/mcp-servers');
  const data = await res.json();
  const servers = data.servers || {};
  delete servers[name];
  await fetch('/api/mcp-servers', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ servers }),
  });
  loadMcpServers();
}

// ── Auth banner + check (F13: pending extraction to auth.js) ─────────────────
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/status');
    const status = await res.json();
    if (!status.valid) showAuthBanner(status.reason);
    else hideAuthBanner();
  } catch (err) { console.error('Auth check failed:', err); }
}

function showAuthBanner(reason) {
  let banner = document.getElementById('auth-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'auth-banner';
    banner.style.cssText = 'background:var(--bg-tertiary);border-bottom:2px solid var(--warning);padding:10px 16px;font-size:13px;color:var(--warning);display:flex;align-items:center;gap:8px;';
    (() => {
      const main = document.getElementById('main');
      const primaryPanel = document.getElementById('primary-panel');
      if (main && primaryPanel) main.insertBefore(banner, primaryPanel);
      else if (main) main.prepend(banner);
    })();
  }
  banner.innerHTML = `
    <span style="font-size:16px">&#9888;</span>
    <span>Not authenticated — open any session and run <code style="background:var(--bg-primary);padding:2px 6px;border-radius:3px;font-size:12px">/login</code> to authenticate all sessions</span>
  `;
}

function hideAuthBanner() {
  const banner = document.getElementById('auth-banner');
  if (banner) banner.remove();
}

// ── Error banner (F14: pending extraction to error-banner.js) ─────────────────
let _errorBannerDismissedThrough = null;

async function checkErrors() {
  try {
    const res = await fetch('/api/logs/summary?since=1h');
    const summary = await res.json();
    if (summary.errorCount > 0) {
      if (_errorBannerDismissedThrough && summary.topError &&
          summary.topError.ts <= _errorBannerDismissedThrough) {
        hideErrorBanner();
        return;
      }
      showErrorBanner(summary.errorCount, summary.topError);
    } else {
      hideErrorBanner();
      _errorBannerDismissedThrough = null;
    }
  } catch (err) { console.error('Error summary check failed:', err); }
}

function showErrorBanner(count, topError) {
  let banner = document.getElementById('error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'error-banner';
    banner.style.cssText = 'background:var(--bg-tertiary);border-bottom:2px solid var(--error,#d32f2f);padding:10px 16px;font-size:13px;color:var(--error,#d32f2f);display:flex;align-items:center;gap:8px;';
    (() => {
      const main = document.getElementById('main');
      const primaryPanel = document.getElementById('primary-panel');
      if (main && primaryPanel) main.insertBefore(banner, primaryPanel);
      else if (main) main.prepend(banner);
    })();
  }
  const top = topError ? ` — top: <strong>${window.escapeHtml(topError.module || 'unknown')}</strong> ${window.escapeHtml(topError.message).slice(0, 120)}` : '';
  const lastErrTs = topError ? window.escapeHtml(topError.ts) : '';
  banner.innerHTML = `
    <span style="font-size:16px;cursor:pointer" title="Click for details">&#9888;</span>
    <span style="cursor:pointer;flex:1" title="Click for details">${count} error(s) in the last hour${top} <em style="margin-left:8px;opacity:0.7">[click for details]</em></span>
    <button id="error-banner-dismiss" data-last-ts="${lastErrTs}" title="Dismiss until a newer error fires" style="background:none;border:none;color:var(--error,#d32f2f);cursor:pointer;font-size:18px;padding:0 4px;line-height:1">&times;</button>
  `;
  const detailsClick = (e) => { if (e.target.id === 'error-banner-dismiss') return; openErrorLogModal(); };
  banner.querySelectorAll('span').forEach(s => s.onclick = detailsClick);
  const dismiss = banner.querySelector('#error-banner-dismiss');
  dismiss.onclick = (e) => {
    e.stopPropagation();
    _errorBannerDismissedThrough = dismiss.dataset.lastTs || new Date().toISOString();
    hideErrorBanner();
  };
}

function hideErrorBanner() {
  const banner = document.getElementById('error-banner');
  if (banner) banner.remove();
}

async function openErrorLogModal() {
  let modal = document.getElementById('error-log-modal');
  if (modal) { modal.remove(); return; }
  const res = await fetch('/api/logs?level=ERROR&since=1h&limit=50');
  const data = await res.json();
  modal = document.createElement('div');
  modal.id = 'error-log-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  const rowsHtml = (data.rows || []).map(r => `
    <tr>
      <td style="padding:4px 8px;color:var(--text-secondary);white-space:nowrap;font-family:monospace;font-size:11px">${window.escapeHtml(r.ts)}</td>
      <td style="padding:4px 8px;font-family:monospace;font-size:11px">${window.escapeHtml(r.module || '—')}</td>
      <td style="padding:4px 8px;font-size:12px">${window.escapeHtml(r.message)}</td>
    </tr>
  `).join('');
  modal.innerHTML = `
    <div style="background:var(--bg-primary);color:var(--text-primary);width:90%;max-width:1100px;max-height:80vh;overflow:auto;border-radius:8px;padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <strong>Recent errors (last 1h, max 50)</strong>
        <button onclick="document.getElementById('error-log-modal').remove()" style="background:none;border:1px solid var(--border);color:var(--text-primary);padding:4px 12px;border-radius:4px;cursor:pointer">Close</button>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="border-bottom:1px solid var(--border)">
          <th style="text-align:left;padding:4px 8px">Time</th>
          <th style="text-align:left;padding:4px 8px">Module</th>
          <th style="text-align:left;padding:4px 8px">Message</th>
        </tr></thead>
        <tbody>${rowsHtml || '<tr><td colspan="3" style="padding:16px;text-align:center;opacity:0.7">No errors in the last hour</td></tr>'}</tbody>
      </table>
    </div>
  `;
  document.body.appendChild(modal);
}

// ── Dependency wiring ─────────────────────────────────────────────────────────
initSidebarDeps({
  renderTabs,
  renderSidebar,
  switchTab,
  loadState,
  openSession,
  createSession,
  openTerminal,
  showErrorModal: (...a) => window.showErrorModal(...a),
  showConfirmModal: (...a) => window.showConfirmModal(...a),
  archiveSession,
  renameSession,
  openProjectConfig,
  addProject,
  addProgram,
  openProgramConfig,
  summarizeSession,
  assignProjectToProgram: _assignProjectToProgram,
});

initTabsDeps({
  renderSidebar,
  updateStatusBar,
  connectTab,
});

initTerminalDeps({
  renderSidebar,
  updateStatusBar,
  openFileTab,
});

// Expose cross-module references
window.checkForAuthIssue = checkForAuthIssue;
window._pollTokenUsage = pollTokenUsage;

// Expose renderSidebar reference for state.js setFilter
window._renderSidebarRef = renderSidebar;

// ── Global window exports for HTML inline handlers ────────────────────────────
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.switchSettingsTab = switchSettingsTab;
window.saveSetting = saveSetting;
window.saveProjectTemplate = saveProjectTemplate;
window.loadVectorSettings = loadVectorSettings;
window.onVectorProviderChange = onVectorProviderChange;
window.saveCollectionConfig = saveCollectionConfig;
window.reindexCollection = reindexCollection;
window.addVectorPath = addVectorPath;
window.removeVectorPath = removeVectorPath;
window.kbFork = kbFork;
window.kbSyncUpstream = kbSyncUpstream;
window.refreshKbRepoUrl = refreshKbRepoUrl;
window.addGitAccount = addGitAccount;
window.editGitAccount = editGitAccount;
window.deleteGitAccount = deleteGitAccount;
window.setGitAccountFlag = setGitAccountFlag;
window.addMcpServer = addMcpServer;
window.removeMcpServer = removeMcpServer;
window.pickerNewFolder = pickerNewFolder;
window.pickerSelect = pickerSelect;
window.submitAuthCode = submitAuthCode;
window.dismissAuthModal = dismissAuthModal;
window.togglePanel = togglePanel;
window.switchPanel = switchPanel;
window.saveSessionConfig = saveSessionConfig;
window.openProjectPrompt = openProjectPrompt;
window.saveProjectConfig = saveProjectConfig;
window.addProgram = addProgram;
window.setFilter = setFilter;
window.setTaskFilter = setTaskFilter;
window.loadTaskTree = loadTaskTree;
window.openTaskDetail = openTaskDetail;
window.closeTaskDetail = closeTaskDetail;
window.saveTaskDetail = saveTaskDetail;
window.autoNavigateTaskTree = autoNavigateTaskTree;
window.openIssuePicker = openIssuePicker;
window.closeIssuePicker = closeIssuePicker;
window.closeTab = closeTab;
window.moveTabToPanel = moveTabToPanel;
window.switchTab = switchTab;
window.autoNavigateFileTree = autoNavigateFileTree;
window.addProject = addProject;
window.applyTheme = applyTheme;
window.applyFontSize = applyFontSize;
window.applyFontFamily = applyFontFamily;
window.loadState = loadState;
window.renderSidebar = renderSidebar;
window.refreshFileTree = refreshFileTree;
window.fileBrowserUpload = fileBrowserUpload;
window.openFileTab = openFileTab;
window.oauthDetection = oauthDetection;
// sessionSortBy: HTML handlers do plain assignment (sessionSortBy = value), so
// define a setter that routes through state.js's setSessionSortBy.
Object.defineProperty(window, 'sessionSortBy', {
  get: () => sessionSortBy,
  set: setSessionSortBy,
  configurable: true,
});

// ── Init ──────────────────────────────────────────────────────────────────────
initSideDivider();
_wireDropZones();
initTaskEventListeners();
initIssuePickerListeners();

loadState();
loadFiles();
setInterval(loadState, REFRESH_MS);
setTimeout(checkAuth, 1000);
setInterval(checkAuth, 60000);
setTimeout(checkErrors, 2000);
setInterval(checkErrors, 60000);
loadAppearanceSettings();
