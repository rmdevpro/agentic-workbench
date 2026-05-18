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

// #585: keyed reconciler — reuses existing children whose `data-rk` matches a
// desired key, calling updateNode in-place; creates only new keys; removes only
// disappeared keys; reorders only when the existing order doesn't match the
// desired order. Replaces the previous renderSidebar full-innerHTML rebuild
// path so unchanged session/project/program nodes survive across state diffs
// and the main thread stays responsive (root cause of #484 typing stalls).
function _reconcileKeyed(parent, items, getKey, createNode, updateNode) {
  const existing = new Map();
  for (const child of Array.from(parent.children)) {
    const k = child.dataset.rk;
    if (k != null) existing.set(k, child);
  }
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = String(getKey(item));
    seen.add(key);
    let node = existing.get(key);
    if (!node) {
      node = createNode(item);
      node.dataset.rk = key;
    }
    updateNode(node, item);
    result.push(node);
  }
  for (const [k, n] of existing) if (!seen.has(k)) n.remove();
  let needsReorder = parent.children.length !== result.length;
  if (!needsReorder) {
    for (let i = 0; i < result.length; i++) {
      if (parent.children[i] !== result[i]) { needsReorder = true; break; }
    }
  }
  if (needsReorder) for (const n of result) parent.appendChild(n);
  return result;
}

// Build a session-item once; subsequent renders mutate it via _updateSessionItem.
// Event handlers attach once and read current state via item._project / item._session.
function _createSessionItem() {
  const item = document.createElement('div');
  item.className = 'session-item';
  item.innerHTML = `
    <div class="session-top-row">
      <span class="session-name"></span>
      <span class="session-actions">
        <button class="session-action-btn summary" title="Summarize">&#9432;</button>
        <button class="session-action-btn restart" title="Restart tmux">&#8635;</button>
        <button class="session-action-btn rename" title="Config">&#9998;</button>
        <button class="session-action-btn archive" title="Archive">&#9744;</button>
        <button class="session-action-btn unarchive" title="Unarchive">&#8634;</button>
      </span>
    </div>
    <div class="session-meta">
      <span class="cli-icon"></span>
      <span class="time-ago"></span>
      <span class="msg-count"></span>
      <span class="model-label" style="font-size:9px;color:var(--text-muted);margin-left:2px"></span>
    </div>
  `;
  item.addEventListener('click', (e) => {
    if (e.target.closest('.session-action-btn')) return;
    const project = item._project, session = item._session;
    if (!project || !session) return;
    if (session.project_missing) {
      _showErrorModal({ title: 'Project missing', message: 'Project directory not found — it may have been moved or deleted.' });
      return;
    }
    setLastClickedProjectPath(project.path);
    _openSession(session, project.name);
  });
  item.querySelector('.rename').addEventListener('click', (e) => {
    e.stopPropagation();
    const s = item._session;
    if (s) _renameSession(s.id, s.name);
  });
  item.querySelector('.restart').addEventListener('click', async (e) => {
    e.stopPropagation();
    const s = item._session;
    if (!s) return;
    const cliLabel = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex' }[s.cli_type] || 'CLI';
    const ok = await _showConfirmModal({
      title: 'Restart Session', confirmLabel: 'Restart',
      message: `Restart the tmux session? The ${cliLabel} session will be preserved.`,
    });
    if (!ok) return;
    try {
      await fetch(`/api/sessions/${s.id}/restart`, { method: 'POST' });
      _loadState();
    } catch (err) { _showErrorModal({ title: 'Restart failed', message: err.message }); }
  });
  item.querySelector('.archive').addEventListener('click', (e) => {
    e.stopPropagation();
    const s = item._session;
    if (s) _archiveSession(s.id, true);
  });
  item.querySelector('.unarchive').addEventListener('click', (e) => {
    e.stopPropagation();
    const s = item._session;
    if (s) _archiveSession(s.id, false);
  });
  item.querySelector('.summary').addEventListener('click', (e) => {
    e.stopPropagation();
    const p = item._project, s = item._session;
    if (p && s) _summarizeSession(s.id, p.name, s.name);
  });
  return item;
}

function _updateSessionItem(item, { project, session }) {
  item._project = project;
  item._session = session;

  const cls = item.classList;
  cls.toggle('archived', !!session.archived);
  cls.toggle('hidden', session.state === 'hidden');
  cls.toggle('missing', !!session.project_missing);
  cls.toggle('open', tabs.has(session.id));
  cls.toggle('active', activeTabId === session.id);

  const nameEl = item.querySelector('.session-name');
  if (nameEl.textContent !== (session.name || '')) nameEl.textContent = session.name || '';

  for (const sel of ['.summary', '.restart', '.rename', '.archive', '.unarchive']) {
    const b = item.querySelector(sel);
    if (b && b.dataset.id !== session.id) b.dataset.id = session.id;
  }
  const summaryBtn = item.querySelector('.summary');
  if (summaryBtn.dataset.project !== project.name) summaryBtn.dataset.project = project.name;
  item.querySelector('.archive').style.display = session.archived ? 'none' : '';
  item.querySelector('.unarchive').style.display = session.archived ? '' : 'none';

  const cli = session.cli_type || 'claude';
  const color = session.active
    ? ({ claude: '#e8a55d', gemini: '#4285f4', codex: '#10a37f' }[cli] || '#8b949e')
    : '#484f58';
  const cliEl = item.querySelector('.cli-icon');
  // Compose a signature for the icon so we only touch innerHTML when it
  // actually changes (cli/color flips matter; everything else is stable).
  const cliSig = `${cli}|${color}`;
  if (cliEl._sig !== cliSig) {
    cliEl._sig = cliSig;
    if (cli === 'codex') {
      cliEl.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" title="codex" style="vertical-align:middle"><rect x="0" y="0" width="10" height="10" rx="2.5" fill="${color}"/><circle cx="5" cy="5" r="2.5" fill="var(--bg-primary)"/></svg>`;
    } else {
      const icons = { claude: '✳', gemini: '◆' };
      cliEl.innerHTML = `<span style="font-size:13px;color:${color};line-height:1" title="${cli}">${icons[cli] || '?'}</span>`;
    }
  }
  const timeText = session.active ? 'just now' : timeAgo(session.timestamp);
  const timeEl = item.querySelector('.time-ago');
  if (timeEl.textContent !== timeText) timeEl.textContent = timeText;
  const mc = session.messageCount != null ? String(session.messageCount) : '';
  const mcEl = item.querySelector('.msg-count');
  if (mcEl.textContent !== mc) mcEl.textContent = mc;
  const mdl = session.model || '';
  const mdlEl = item.querySelector('.model-label');
  if (mdlEl.textContent !== mdl) mdlEl.textContent = mdl;
}

function _renderNewSessionMenu(menu) {
  const gemiOK = window._cliCreds?.gemini !== false;
  const codexOK = window._cliCreds?.openai !== false;
  // Cheap signature so we don't rewrite the dropdown HTML when creds are stable.
  const sig = `${gemiOK ? 1 : 0}|${codexOK ? 1 : 0}`;
  if (menu._sig === sig) return;
  menu._sig = sig;
  menu.innerHTML = `
    <div class="context-menu-item" data-cli="claude" style="padding:4px 12px;font-size:12px;cursor:pointer;color:var(--text-primary)"><span style="color:#e8a55d;font-weight:bold">C</span> Claude</div>
    <div class="context-menu-item" data-cli="gemini" style="padding:4px 12px;font-size:12px;cursor:pointer;color:${gemiOK ? 'var(--text-primary)' : 'var(--text-muted)'}">${gemiOK ? '<span style="color:#4285f4;font-weight:bold">G</span> Gemini' : '<span style="color:var(--text-muted)">G</span> Gemini (no API key)'}</div>
    <div class="context-menu-item" data-cli="codex" style="padding:4px 12px;font-size:12px;cursor:pointer;color:${codexOK ? 'var(--text-primary)' : 'var(--text-muted)'}">${codexOK ? '<span style="color:#10a37f;font-weight:bold">X</span> Codex' : '<span style="color:var(--text-muted)">X</span> Codex (no API key)'}</div>
    <div class="context-menu-divider" style="border-top:1px solid var(--border);margin:4px 0"></div>
    <div class="context-menu-item" data-cli="terminal" style="padding:4px 12px;font-size:12px;cursor:pointer;color:var(--text-primary)">&#9002; Terminal</div>
  `;
}

function _createProjectGroup() {
  const group = document.createElement('div');
  group.className = 'project-group';

  const header = document.createElement('div');
  header.className = 'project-header';
  header.innerHTML = `
    <span class="arrow">&#9660;</span>
    <span class="proj-name"></span>
    <span class="count"></span>
    <button class="term-btn proj-config-btn" title="Project config" style="font-size:12px">&#9998;</button>
    <span class="new-session-wrap" style="position:relative">
      <button class="term-btn new-btn" title="New session">+</button>
      <div class="new-session-menu" style="display:none;position:absolute;top:100%;right:0;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:4px 0;z-index:100;min-width:120px;box-shadow:0 4px 12px rgba(0,0,0,0.3)"></div>
    </span>
  `;
  header.draggable = true;

  const sessionList = document.createElement('div');
  sessionList.className = 'session-list';

  group.appendChild(header);
  group.appendChild(sessionList);
  group._header = header;
  group._sessionList = sessionList;

  header.querySelector('.proj-config-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const p = group._project;
    if (p) _openProjectConfig(p.name);
  });
  const newBtn = header.querySelector('.new-btn');
  const newMenu = header.querySelector('.new-session-menu');
  newBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _renderNewSessionMenu(newMenu);
    const isVisible = newMenu.style.display !== 'none';
    document.querySelectorAll('.new-session-menu').forEach(m => m.style.display = 'none');
    newMenu.style.display = isVisible ? 'none' : 'block';
  });
  newMenu.addEventListener('click', (e) => {
    const target = e.target.closest('.context-menu-item');
    if (!target) return;
    e.stopPropagation();
    newMenu.style.display = 'none';
    const cli = target.dataset.cli;
    const p = group._project;
    if (!p) return;
    if (cli === 'gemini' && !window._cliCreds?.gemini) {
      _showErrorModal({ title: 'Credential missing', message: 'Gemini API key not configured. Go to Settings to add it.' });
      return;
    }
    if (cli === 'codex' && !window._cliCreds?.openai) {
      _showErrorModal({ title: 'Credential missing', message: 'OpenAI API key not configured. Go to Settings to add it.' });
      return;
    }
    if (cli === 'terminal') _openTerminal(p.name);
    else _createSession(p.name, cli);
  });
  newMenu.addEventListener('mouseover', (e) => {
    const t = e.target.closest('.context-menu-item');
    if (t) t.style.background = 'var(--bg-hover)';
  });
  newMenu.addEventListener('mouseout', (e) => {
    const t = e.target.closest('.context-menu-item');
    if (t) t.style.background = '';
  });
  header.addEventListener('click', () => {
    const p = group._project;
    if (!p) return;
    if (expandedProjects.has(p.name)) expandedProjects.delete(p.name);
    else expandedProjects.add(p.name);
    localStorage.setItem('expandedProjects', JSON.stringify([...expandedProjects]));
    const exp = expandedProjects.has(p.name);
    header.classList.toggle('collapsed', !exp);
    sessionList.classList.toggle('collapsed', !exp);
    setLastClickedProjectPath(p.path);
  });
  header.addEventListener('dragstart', (e) => {
    const p = group._project;
    if (!p) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-project-name', p.name);
  });

  return group;
}

function _updateProjectGroup(group, project) {
  group._project = project;
  const header = group._header;
  const sessionList = group._sessionList;
  const isExpanded = expandedProjects.has(project.name);

  header.classList.toggle('missing', !!project.missing);
  header.classList.toggle('collapsed', !isExpanded);
  sessionList.classList.toggle('collapsed', !isExpanded);

  const nameEl = header.querySelector('.proj-name');
  if (nameEl.textContent !== project.name) nameEl.textContent = project.name;

  const filtered = project.sessions.filter((s) => {
    const state = s.state || (s.archived ? 'archived' : 'active');
    if (sessionFilter === 'active') return state === 'active';
    if (sessionFilter === 'archived') return state === 'archived';
    if (sessionFilter === 'all') return state !== 'hidden';
    if (sessionFilter === 'hidden') return state === 'hidden';
    return true;
  });

  const countEl = header.querySelector('.count');
  const countText = String(filtered.length);
  if (countEl.textContent !== countText) countEl.textContent = countText;

  if (sessionSortBy === 'name') filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  else if (sessionSortBy === 'messages') filtered.sort((a, b) => b.messageCount - a.messageCount);

  _reconcileKeyed(
    sessionList,
    filtered.map((session) => ({ project, session })),
    (it) => it.session.id,
    () => _createSessionItem(),
    _updateSessionItem,
  );
}

function _createProgramSection() {
  const wrap = document.createElement('div');
  wrap.className = 'program-group';
  const header = document.createElement('div');
  header.className = 'program-header';
  header.innerHTML = `
    <span class="arrow">&#9660;</span>
    <span class="program-name"></span>
    <button class="term-btn prog-config-btn" title="Program config" style="font-size:12px;display:none">&#9998;</button>
    <button class="term-btn add-project-btn" title="Add project to this program" style="font-size:13px;display:none">+</button>
  `;
  const children = document.createElement('div');
  children.className = 'program-children';
  wrap.appendChild(header);
  wrap.appendChild(children);
  wrap._header = header;
  wrap._children = children;

  header.addEventListener('click', (e) => {
    if (e.target.closest('.term-btn')) return;
    const program = wrap._program;
    if (!program) return;
    const programKey = program.virtual ? '__unassigned__' : String(program.id);
    if (expandedPrograms.has(programKey)) expandedPrograms.delete(programKey);
    else expandedPrograms.add(programKey);
    localStorage.setItem('expandedPrograms', JSON.stringify([...expandedPrograms]));
    header.classList.toggle('collapsed', !expandedPrograms.has(programKey));
  });
  header.querySelector('.prog-config-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const program = wrap._program;
    if (program && !program.virtual) _openProgramConfig(program.id);
  });
  header.querySelector('.add-project-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const program = wrap._program;
    if (program && !program.virtual) _addProject(program.id);
  });
  header.addEventListener('dragover', (e) => {
    const projName = e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('application/x-project-name');
    if (projName) { e.preventDefault(); header.classList.add('drag-over'); }
  });
  header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
  header.addEventListener('drop', (e) => {
    e.preventDefault();
    header.classList.remove('drag-over');
    const program = wrap._program;
    if (!program) return;
    const projName = e.dataTransfer.getData('application/x-project-name');
    if (!projName) return;
    _assignProjectToProgram(projName, program.virtual ? null : program.id);
  });

  return wrap;
}

function _updateProgramSection(wrap, { program, projects }) {
  wrap._program = program;
  const isVirtual = program.virtual === true;
  const programKey = isVirtual ? '__unassigned__' : String(program.id);
  const isExpanded = expandedPrograms.has(programKey);
  const header = wrap._header;

  header.classList.toggle('virtual', isVirtual);
  header.classList.toggle('archived', program.status === 'archived');
  header.classList.toggle('collapsed', !isExpanded);
  const dsProg = isVirtual ? '' : String(program.id);
  if (header.dataset.programId !== dsProg) header.dataset.programId = dsProg;

  const nameEl = header.querySelector('.program-name');
  if (nameEl.textContent !== program.name) nameEl.textContent = program.name;
  header.querySelector('.prog-config-btn').style.display = isVirtual ? 'none' : '';
  header.querySelector('.add-project-btn').style.display = isVirtual ? 'none' : '';

  _reconcileKeyed(
    wrap._children,
    projects,
    (p) => `proj-${p.name}`,
    () => _createProjectGroup(),
    _updateProjectGroup,
  );
}

export function renderSidebar() {
  if (window._searchActive) return;
  const stateHash = JSON.stringify(projectState.map(p => ({
    n: p.name, m: p.missing, st: p.state, pg: p.program_id,
    s: p.sessions.map(s => ({ id: s.id, name: s.name, active: s.active, state: s.state, cli: s.cli_type, mc: s.messageCount, ts: s.active ? 'active' : (window.timeAgo ? window.timeAgo(s.timestamp) : s.timestamp) }))
  }))) + JSON.stringify(programState.map(p => ({ id: p.id, n: p.name, st: p.status }))) + sessionFilter + sessionSortBy + activeTabId + [...tabs.keys()].join(',') + [...expandedPrograms].join(',');
  const container = document.getElementById('project-list');
  if (stateHash === renderSidebar._lastHash && container.childElementCount > 0) return;

  const projectsByProgram = { __unassigned__: [] };
  for (const p of projectState) {
    const projState = p.state || 'active';
    if (sessionFilter === 'active' && projState !== 'active') continue;
    if (sessionFilter === 'archived' && projState !== 'archived') {
      const hasArchivedSessions = p.sessions.some((s) => (s.state || (s.archived ? 'archived' : 'active')) === 'archived');
      if (!hasArchivedSessions) continue;
    }
    if (sessionFilter === 'all' && projState === 'hidden') continue;
    if (sessionFilter === 'hidden' && projState !== 'hidden') {
      const hasHiddenSessions = p.sessions.some((s) => (s.state || 'active') === 'hidden');
      if (!hasHiddenSessions) continue;
    }
    const key = p.program_id == null ? '__unassigned__' : String(p.program_id);
    (projectsByProgram[key] = projectsByProgram[key] || []).push(p);
  }

  const desired = [];
  for (const program of programState) {
    const projects = projectsByProgram[String(program.id)] || [];
    desired.push({ key: `prog-${program.id}`, program, projects });
  }
  if (projectsByProgram.__unassigned__.length > 0) {
    desired.push({
      key: 'prog-__unassigned__',
      program: { id: null, name: 'Unassigned', virtual: true },
      projects: projectsByProgram.__unassigned__,
    });
  }

  _reconcileKeyed(
    container,
    desired,
    (d) => d.key,
    () => _createProgramSection(),
    _updateProgramSection,
  );

  renderSidebar._lastHash = stateHash;
}

export async function loadState() {
  try {
    try {
      const credRes = await fetch('/api/cli-credentials');
      window._cliCreds = await credRes.json();
    } catch { window._cliCreds = { gemini: false, openai: false }; }

    // #564: short-window retry on transient network failure. The bare
    // single-attempt fetch used to error out on a TypeError ("Failed to
    // fetch") and never recover until the next 10s poll, blowing past
    // SMOKE-PROJ-01 assertion-03's bounded ≤5s window for new-project-
    // appears-in-sidebar-after-Save. Retries only on thrown errors
    // (network flake); HTTP 4xx/5xx are not retried (would mask app
    // failures). 3 attempts × 500ms backoff = worst-case 1.0s extra.
    // Falls back to the bare fetch if util.js hasn't loaded (defensive;
    // util.js is loaded before app.js in index.html).
    const _fetch = (typeof window !== 'undefined' && window.fetchWithRetry) || fetch;
    const res = await _fetch('/api/state');
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
