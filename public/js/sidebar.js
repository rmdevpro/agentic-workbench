import {
  tabs, activeTabId, projectState, setProjectState, programState, setProgramState,
  sessionFilter, sessionSortBy, expandedPrograms, expandedProjects,
  setLastClickedProjectPath, tabPanelAssignments,
} from './state.js';

// Forward-declared references set by app.js after all modules load
// to break circular dependencies.
let _renderTabs, _renderSidebar, _switchTab, _loadState, _openSession, _createSession,
    _openTerminal, _showErrorModal, _showConfirmModal, _archiveSession, _renameSession,
    _openProjectConfig, _addProject, _addProgram, _openProgramConfig,
    _summarizeSession, _assignProjectToProgram;

export function initSidebarDeps(deps) {
  _renderTabs = deps.renderTabs;
  _renderSidebar = deps.renderSidebar;
  _switchTab = deps.switchTab;
  _loadState = deps.loadState;
  _openSession = deps.openSession;
  _createSession = deps.createSession;
  _openTerminal = deps.openTerminal;
  _showErrorModal = deps.showErrorModal;
  _showConfirmModal = deps.showConfirmModal;
  _archiveSession = deps.archiveSession;
  _renameSession = deps.renameSession;
  _openProjectConfig = deps.openProjectConfig;
  _addProject = deps.addProject;
  _addProgram = deps.addProgram;
  _openProgramConfig = deps.openProgramConfig;
  _summarizeSession = deps.summarizeSession;
  _assignProjectToProgram = deps.assignProjectToProgram;
}

// #371 [E1]: client-side TTL cache for /api/sessions/:id/info results.
const _sessionInfoClientCache = new Map(); // sid → { fetchedAt, info }
const _SESSION_INFO_CLIENT_TTL_MS = 30000;
let _hydrateInFlight = new Set();

export async function _hydrateVisibleSessionInfo() {
  const now = Date.now();
  const fetches = [];
  for (const p of projectState || []) {
    for (const s of (p.sessions || [])) {
      const cached = _sessionInfoClientCache.get(s.id);
      if (cached && (now - cached.fetchedAt) < _SESSION_INFO_CLIENT_TTL_MS) continue;
      if (_hydrateInFlight.has(s.id)) continue;
      if (s.id.startsWith('new_')) continue;
      _hydrateInFlight.add(s.id);
      fetches.push(
        fetch(`/api/sessions/${encodeURIComponent(s.id)}/info`)
          .then(r => r.ok ? r.json() : null)
          .then(info => {
            _hydrateInFlight.delete(s.id);
            if (!info) return;
            _sessionInfoClientCache.set(s.id, { fetchedAt: Date.now(), info });
            for (const proj of projectState || []) {
              const row = (proj.sessions || []).find(x => x.id === s.id);
              if (row) {
                row.messageCount = info.message_count;
                row.model = info.model;
                row.tmux = info.tmux;
                row.active = info.active;
                // Active sessions haven't finished writing their current
                // turn to JSONL yet — their session_meta timestamp is the
                // last *completed* turn. Stamp now so the sidebar shows
                // "just now" while the agent is running.
                if (info.active) row.timestamp = new Date().toISOString();
                break;
              }
            }
          })
          .catch(() => { _hydrateInFlight.delete(s.id); })
      );
    }
  }
  if (fetches.length === 0) return;
  await Promise.allSettled(fetches);
  // Don't destroy an open CLI-picker dropdown by re-rendering the sidebar
  // while the user (or Playwright) has it open. The re-render resets all
  // inline styles to display:none. We skip here; the next loadState() cycle
  // (10s later) will pick up any state changes.
  if (document.querySelector('.new-session-menu[style*="block"]')) return;
  renderSidebar._lastHash = '';
  renderSidebar();
}

export function renderSidebar() {
  if (window._searchActive) return;
  const stateHash = JSON.stringify(projectState.map(p => ({
    n: p.name, m: p.missing, st: p.state, pg: p.program_id,
    s: p.sessions.map(s => ({ id: s.id, name: s.name, active: s.active, state: s.state, cli: s.cli_type, mc: s.messageCount, ts: s.active ? 'active' : (window.timeAgo ? window.timeAgo(s.timestamp) : s.timestamp) }))
  }))) + JSON.stringify(programState.map(p => ({ id: p.id, n: p.name, st: p.status }))) + sessionFilter + sessionSortBy + activeTabId + [...tabs.keys()].join(',') + [...expandedPrograms].join(',');
  const container = document.getElementById('project-list');
  if (stateHash === renderSidebar._lastHash && container.childElementCount > 0) return;
  container.innerHTML = '';

  const projectsByProgram = { __unassigned__: [] };
  for (const p of projectState) {
    const key = p.program_id == null ? '__unassigned__' : String(p.program_id);
    (projectsByProgram[key] = projectsByProgram[key] || []).push(p);
  }

  const renderOneProjectGroup = (project, parent) => {
    const projState = project.state || 'active';
    if (sessionFilter === 'active' && projState !== 'active') return;
    if (sessionFilter === 'archived' && projState !== 'archived') {
      const hasArchivedSessions = project.sessions.some(s => (s.state || (s.archived ? 'archived' : 'active')) === 'archived');
      if (!hasArchivedSessions) return;
    }
    if (sessionFilter === 'all' && projState === 'hidden') return;
    if (sessionFilter === 'hidden' && projState !== 'hidden') {
      const hasHiddenSessions = project.sessions.some(s => (s.state || 'active') === 'hidden');
      if (!hasHiddenSessions) return;
    }

    const group = document.createElement('div');
    group.className = 'project-group';

    const header = document.createElement('div');
    const isExpanded = expandedProjects.has(project.name);
    header.className = 'project-header' + (project.missing ? ' missing' : '') + (isExpanded ? '' : ' collapsed');
    const filteredCount = project.sessions.filter(s => {
      const state = s.state || (s.archived ? 'archived' : 'active');
      if (sessionFilter === 'active') return state === 'active';
      if (sessionFilter === 'archived') return state === 'archived';
      if (sessionFilter === 'all') return state !== 'hidden';
      if (sessionFilter === 'hidden') return state === 'hidden';
      return true;
    }).length;
    header.innerHTML = `
      <span class="arrow">&#9660;</span>
      <span>${escHtml(project.name)}</span>
      <span class="count">${filteredCount}</span>
      <button class="term-btn proj-config-btn" title="Project config" style="font-size:12px">&#9998;</button>
      <span class="new-session-wrap" style="position:relative">
        <button class="term-btn new-btn" title="New session">+</button>
        <div class="new-session-menu" style="display:none;position:absolute;top:100%;right:0;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:4px 0;z-index:100;min-width:120px;box-shadow:0 4px 12px rgba(0,0,0,0.3)">
          <div class="context-menu-item" data-cli="claude" style="padding:4px 12px;font-size:12px;cursor:pointer;color:var(--text-primary)"><span style="color:#e8a55d;font-weight:bold">C</span> Claude</div>
          <div class="context-menu-item" data-cli="gemini" style="padding:4px 12px;font-size:12px;cursor:pointer;color:${window._cliCreds?.gemini === false ? 'var(--text-muted)' : 'var(--text-primary)'}">${window._cliCreds?.gemini === false ? '<span style="color:var(--text-muted)">G</span> Gemini (no API key)' : '<span style="color:#4285f4;font-weight:bold">G</span> Gemini'}</div>
          <div class="context-menu-item" data-cli="codex" style="padding:4px 12px;font-size:12px;cursor:pointer;color:${window._cliCreds?.openai === false ? 'var(--text-muted)' : 'var(--text-primary)'}">${window._cliCreds?.openai === false ? '<span style="color:var(--text-muted)">X</span> Codex (no API key)' : '<span style="color:#10a37f;font-weight:bold">X</span> Codex'}</div>
          <div class="context-menu-divider" style="border-top:1px solid var(--border);margin:4px 0"></div>
          <div class="context-menu-item" data-cli="terminal" style="padding:4px 12px;font-size:12px;cursor:pointer;color:var(--text-primary)">&#9002; Terminal</div>
        </div>
      </span>
    `;
    header.querySelector('.proj-config-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      _openProjectConfig(project.name);
    });
    const newBtn = header.querySelector('.new-btn');
    const newMenu = header.querySelector('.new-session-menu');
    newBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = newMenu.style.display !== 'none';
      document.querySelectorAll('.new-session-menu').forEach(m => m.style.display = 'none');
      newMenu.style.display = isVisible ? 'none' : 'block';
    });
    newMenu.querySelectorAll('.context-menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        newMenu.style.display = 'none';
        const cli = item.dataset.cli;
        if (cli === 'gemini' && !window._cliCreds?.gemini) {
          _showErrorModal({ title: 'Credential missing', message: 'Gemini API key not configured. Go to Settings to add it.' });
          return;
        }
        if (cli === 'codex' && !window._cliCreds?.openai) {
          _showErrorModal({ title: 'Credential missing', message: 'OpenAI API key not configured. Go to Settings to add it.' });
          return;
        }
        if (cli === 'terminal') {
          _openTerminal(project.name);
        } else {
          _createSession(project.name, cli);
        }
      });
      item.addEventListener('mouseenter', () => item.style.background = 'var(--bg-hover)');
      item.addEventListener('mouseleave', () => item.style.background = '');
    });
    header.addEventListener('click', () => {
      if (expandedProjects.has(project.name)) {
        expandedProjects.delete(project.name);
      } else {
        expandedProjects.add(project.name);
      }
      localStorage.setItem('expandedProjects', JSON.stringify([...expandedProjects]));
      header.classList.toggle('collapsed');
      sessionList.classList.toggle('collapsed');
      setLastClickedProjectPath(project.path);
    });
    header.draggable = true;
    header.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-project-name', project.name);
    });
    group.appendChild(header);

    const sessionList = document.createElement('div');
    sessionList.className = 'session-list' + (isExpanded ? '' : ' collapsed');

    const filtered = project.sessions.filter(s => {
      const state = s.state || (s.archived ? 'archived' : 'active');
      if (sessionFilter === 'active') return state === 'active';
      if (sessionFilter === 'archived') return state === 'archived';
      if (sessionFilter === 'all') return state !== 'hidden';
      if (sessionFilter === 'hidden') return state === 'hidden';
      return true;
    });

    if (sessionSortBy === 'name') filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    else if (sessionSortBy === 'messages') filtered.sort((a, b) => b.messageCount - a.messageCount);

    for (const session of filtered) {
      const item = document.createElement('div');
      item.className = 'session-item';
      if (session.archived) item.classList.add('archived');
      if (session.state === 'hidden') item.classList.add('hidden');
      if (session.project_missing) item.classList.add('missing');
      const tabId = session.id;
      if (tabs.has(tabId)) item.classList.add('open');
      if (activeTabId === tabId) item.classList.add('active');

      const archiveBtn = session.archived
        ? `<button class="session-action-btn unarchive" title="Unarchive" data-id="${escHtml(session.id)}">&#8634;</button>`
        : `<button class="session-action-btn archive" title="Archive" data-id="${escHtml(session.id)}">&#9744;</button>`;
      const summaryBtn = `<button class="session-action-btn summary" title="Summarize" data-id="${escHtml(session.id)}" data-project="${escHtml(project.name)}">&#9432;</button>`;

      item.innerHTML = `
        <div class="session-top-row">
          <span class="session-name">${escHtml(session.name)}</span>
          <span class="session-actions">
            ${summaryBtn}
            <button class="session-action-btn restart" title="Restart tmux" data-id="${escHtml(session.id)}">&#8635;</button>
            <button class="session-action-btn rename" title="Config" data-id="${escHtml(session.id)}">&#9998;</button>
            ${archiveBtn}
          </span>
        </div>
        <div class="session-meta">
          ${(() => {
            const cli = session.cli_type || 'claude';
            const color = session.active ? ({ claude: '#e8a55d', gemini: '#4285f4', codex: '#10a37f' }[cli] || '#8b949e') : '#484f58';
            const icons = { claude: '✳', gemini: '◆' };
            if (cli === 'codex') {
              return `<svg width="10" height="10" viewBox="0 0 10 10" title="codex" style="vertical-align:middle"><rect x="0" y="0" width="10" height="10" rx="2.5" fill="${color}"/><circle cx="5" cy="5" r="2.5" fill="var(--bg-primary)"/></svg>`;
            }
            return `<span style="font-size:13px;color:${color};line-height:1" title="${cli}">${icons[cli] || '?'}</span>`;
          })()}
          <span>${session.active ? 'just now' : timeAgo(session.timestamp)}</span>
          <span class="msg-count">${session.messageCount != null ? session.messageCount : ''}</span>
          <span style="font-size:9px;color:var(--text-muted);margin-left:2px">${escHtml(session.model || '')}</span>
        </div>
      `;
      item.addEventListener('click', (e) => {
        if (e.target.closest('.session-action-btn')) return;
        if (session.project_missing) {
          _showErrorModal({ title: 'Project missing', message: 'Project directory not found — it may have been moved or deleted.' });
          return;
        }
        setLastClickedProjectPath(project.path);
        _openSession(session, project.name);
      });
      item.querySelector('.rename').addEventListener('click', (e) => {
        e.stopPropagation();
        _renameSession(session.id, session.name);
      });
      item.querySelector('.restart').addEventListener('click', async (e) => {
        e.stopPropagation();
        const cliLabel = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex' }[session.cli_type] || 'CLI';
        const ok = await _showConfirmModal({
          title: 'Restart Session', confirmLabel: 'Restart',
          message: `Restart the tmux session? The ${cliLabel} session will be preserved.`,
        });
        if (!ok) return;
        try {
          await fetch(`/api/sessions/${session.id}/restart`, { method: 'POST' });
          _loadState();
        } catch (err) { _showErrorModal({ title: 'Restart failed', message: err.message }); }
      });
      const archEl = item.querySelector('.archive, .unarchive');
      if (archEl) {
        archEl.addEventListener('click', (e) => {
          e.stopPropagation();
          _archiveSession(session.id, !session.archived);
        });
      }
      item.querySelector('.summary').addEventListener('click', (e) => {
        e.stopPropagation();
        _summarizeSession(session.id, project.name, session.name);
      });
      sessionList.appendChild(item);
    }

    group.appendChild(sessionList);
    parent.appendChild(group);
  };

  const renderProgramSection = (program, projects, parent) => {
    const isVirtual = program.virtual === true;
    const programKey = isVirtual ? '__unassigned__' : String(program.id);
    const isExpanded = expandedPrograms.has(programKey);
    const wrap = document.createElement('div');
    wrap.className = 'program-group';
    const header = document.createElement('div');
    header.className = 'program-header'
      + (isVirtual ? ' virtual' : '')
      + (program.status === 'archived' ? ' archived' : '')
      + (isExpanded ? '' : ' collapsed');
    header.dataset.programId = isVirtual ? '' : String(program.id);
    const editBtn = isVirtual ? '' : `<button class="term-btn prog-config-btn" title="Program config" style="font-size:12px">&#9998;</button>`;
    const plusBtn = isVirtual ? '' : `<button class="term-btn add-project-btn" title="Add project to this program" style="font-size:13px">+</button>`;
    header.innerHTML = `
      <span class="arrow">&#9660;</span>
      <span class="program-name">${escHtml(program.name)}</span>
      ${editBtn}
      ${plusBtn}
    `;
    const children = document.createElement('div');
    children.className = 'program-children';

    header.addEventListener('click', (e) => {
      if (e.target.closest('.term-btn')) return;
      if (expandedPrograms.has(programKey)) expandedPrograms.delete(programKey);
      else expandedPrograms.add(programKey);
      localStorage.setItem('expandedPrograms', JSON.stringify([...expandedPrograms]));
      header.classList.toggle('collapsed');
    });

    if (!isVirtual) {
      const cfgBtn = header.querySelector('.prog-config-btn');
      if (cfgBtn) cfgBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _openProgramConfig(program.id);
      });
      const addBtn = header.querySelector('.add-project-btn');
      if (addBtn) addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _addProject(program.id);
      });
      header.addEventListener('dragover', (e) => {
        const projName = e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('application/x-project-name');
        if (projName) { e.preventDefault(); header.classList.add('drag-over'); }
      });
      header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
      header.addEventListener('drop', (e) => {
        e.preventDefault();
        header.classList.remove('drag-over');
        const projName = e.dataTransfer.getData('application/x-project-name');
        if (!projName) return;
        _assignProjectToProgram(projName, program.id);
      });
    } else {
      header.addEventListener('dragover', (e) => {
        const projName = e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('application/x-project-name');
        if (projName) { e.preventDefault(); header.classList.add('drag-over'); }
      });
      header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
      header.addEventListener('drop', (e) => {
        e.preventDefault();
        header.classList.remove('drag-over');
        const projName = e.dataTransfer.getData('application/x-project-name');
        if (!projName) return;
        _assignProjectToProgram(projName, null);
      });
    }

    wrap.appendChild(header);
    wrap.appendChild(children);
    parent.appendChild(wrap);

    for (const p of projects) renderOneProjectGroup(p, children);
  };

  for (const program of programState) {
    const projects = projectsByProgram[String(program.id)] || [];
    renderProgramSection(program, projects, container);
  }
  if (projectsByProgram.__unassigned__.length > 0) {
    renderProgramSection({ id: null, name: 'Unassigned', virtual: true }, projectsByProgram.__unassigned__, container);
  }

  renderSidebar._lastHash = stateHash;
}

export async function loadState() {
  try {
    try {
      const credRes = await fetch('/api/cli-credentials');
      window._cliCreds = await credRes.json();
    } catch { window._cliCreds = { gemini: false, openai: false }; }

    const res = await fetch('/api/state');
    const data = await res.json();
    if (Array.isArray(data.projects)) {
      for (const p of data.projects) {
        if (window._pendingProgramAssignments && window._pendingProgramAssignments.has(p.name)) {
          p.program_id = window._pendingProgramAssignments.get(p.name);
        }
        if (window._pendingProjectEdits && window._pendingProjectEdits.has(p.name)) {
          const edit = window._pendingProjectEdits.get(p.name);
          if (edit.name != null) p.name = edit.name;
          if (edit.state != null) p.state = edit.state;
          if (edit.notes != null) p.notes = edit.notes;
        }
        if (Array.isArray(p.sessions)) {
          for (const s of p.sessions) {
            if (window._pendingSessionEdits && window._pendingSessionEdits.has(s.id)) {
              const edit = window._pendingSessionEdits.get(s.id);
              if (edit.name != null) s.name = edit.name;
              if (edit.state != null) s.state = edit.state;
              if (edit.notes != null) s.notes = edit.notes;
              if (edit.archived != null) s.archived = !!edit.archived;
            }
            // Restore hydrated 'active' status if still within cache TTL.
            // /api/state returns minimal session data (no active/tmux/model);
            // those come from hydration. Without this, each loadState() wipes
            // active=true back to undefined and the 'just now' display vanishes.
            const _ch = _sessionInfoClientCache.get(s.id);
            if (_ch && (Date.now() - _ch.fetchedAt) < _SESSION_INFO_CLIENT_TTL_MS && _ch.info?.active) {
              s.active = true;
            }
          }
        }
      }
    }
    setProjectState(data.projects);
    setProgramState(data.programs || []);
    if (data.workspace) window._workspace = data.workspace;

    for (const [tabId, tab] of tabs) {
      if (!tabId.startsWith('new_')) continue;
      let found = false;
      for (const p of projectState) {
        if (p.sessions.some(s => s.id === tabId)) { found = true; break; }
      }
      if (!found) {
        for (const p of projectState) {
          if (p.name !== tab.project) continue;
          const realSession = p.sessions.find(s => !s.id.startsWith('new_') && s.active && !tabs.has(s.id));
          if (realSession) {
            tabs.delete(tabId);
            tab.id = realSession.id;
            tabs.set(realSession.id, tab);
            if (activeTabId === tabId) {
              const { setActiveTabId } = await import('./state.js');
              setActiveTabId(realSession.id);
            }
            if (window._authTriggerTabId === tabId) window._authTriggerTabId = realSession.id;
            const tabEl = document.querySelector(`[data-tab-id="${tabId}"]`);
            if (tabEl) tabEl.dataset.tabId = realSession.id;
            const pane = document.getElementById(`pane-${tabId}`);
            if (pane) {
              document.getElementById(`pane-${realSession.id}`)?.remove();
              pane.id = `pane-${realSession.id}`;
            }
            console.log(`[session-resolve] Tab migrated: ${tabId} → ${realSession.id}`);
            document.dispatchEvent(new CustomEvent('session-ready', { detail: { id: realSession.id, project: tab.project } }));
            _renderTabs && _renderTabs();
            window._pollTokenUsage && window._pollTokenUsage();
            break;
          }
        }
      }
    }

    // Skip DOM rebuild while a CLI-picker dropdown is open; re-render will
    // happen naturally on the next loadState() cycle (10s).
    if (!document.querySelector('.new-session-menu[style*="block"]')) {
      renderSidebar();
      _hydrateVisibleSessionInfo();
    }
  } catch (err) {
    console.error('Failed to load state:', err);
  }
}

function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - new Date(timestamp)) / 1000);
  if (seconds < 0 || seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function escHtml(str) {
  return window.escapeHtml(str);
}
