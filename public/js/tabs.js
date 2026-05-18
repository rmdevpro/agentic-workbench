import {
  tabs, activeTabId, activeTabSideId, tabPanelAssignments, tabOrders,
  _appendToOrder, _removeFromAllOrders, _persistTabOrders,
  setActiveTabId, setActiveTabSideId, setFocusedPanel, focusedPanel,
  sidePanelOpen, setSidePanelOpen, sidePanelWidth, tabDbg,
} from './state.js';

let _renderSidebarRef, _updateStatusBarRef, _connectTabRef;

export function initTabsDeps(deps) {
  _renderSidebarRef = deps.renderSidebar;
  _updateStatusBarRef = deps.updateStatusBar;
  _connectTabRef = deps.connectTab;
}

export function _activeIdForPanel(panel) {
  return panel === 'side' ? activeTabSideId : activeTabId;
}
export function _setActiveIdForPanel(panel, id) {
  if (panel === 'side') setActiveTabSideId(id);
  else setActiveTabId(id);
}
export function _panelOf(tabId) {
  const t = tabs.get(tabId);
  return t?.panel === 'side' ? 'side' : 'primary';
}
export function _hasTabsInPanel(panel) {
  for (const t of tabs.values()) if ((t.panel || 'primary') === panel) return true;
  return false;
}
export function _updateSidePanelVisibility() {
  const has = _hasTabsInPanel('side');
  const panel = document.getElementById('side-panel');
  const divider = document.getElementById('side-divider');
  if (has !== sidePanelOpen) {
    setSidePanelOpen(has);
    panel.classList.toggle('active', has);
    divider.classList.toggle('active', has);
    if (has) panel.style.width = sidePanelWidth + 'px';
  }
}

export function switchTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const panel = tab.panel || 'primary';
  const prevActive = _activeIdForPanel(panel);
  tabDbg('switchTab:enter', { fromTabId: prevActive, toTabId: tabId, panel, targetExists: true });
  _setActiveIdForPanel(panel, tabId);
  setFocusedPanel(panel);

  for (const [id, t] of tabs) {
    if ((t.panel || 'primary') !== panel) continue;
    if (!t.paneEl) {
      tabDbg('switchTab:missing-paneEl', { id });
      continue;
    }
    t.paneEl.classList.toggle('active', id === tabId);
  }

  if (tab.type === 'file') {
    if (tab.editor && tab.editor.focus) tab.editor.focus();
  } else if (tab.fitAddon) {
    requestAnimationFrame(() => {
      const t = tabs.get(tabId);
      if (!t || !t.term || !t.term.rows) return;
      try { t.term.refresh(0, t.term.rows - 1); } catch { /* ignore */ }
      if (t.fitAddon) t.fitAddon.fit();
    });
    tab.term.focus();
  }

  renderTabs();
  _renderSidebarRef && _renderSidebarRef();
  // #595: refresh status bar so its model/context/connection indicator reflect
  // the newly-active tab, not the prior tab's cached values. Pre-fix the
  // status bar only updated on pollTokenUsage ticks + ws.onopen — switchTab
  // itself left it stale on the previous tab's data.
  _updateStatusBarRef && _updateStatusBarRef(panel);
  tabDbg('switchTab:exit', { fromTabId: prevActive, toTabId: tabId, panel });
}

export async function closeTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const panel = tab.panel || 'primary';
  tabDbg('closeTab:enter', { tabId, panel });

  if (tab.type === 'file') {
    if (tab.dirty) {
      const ok = await window.showConfirmModal({
        title: 'Unsaved Changes', confirmLabel: 'Close', danger: true,
        message: `${tab.name} has unsaved changes. Close anyway?`,
      });
      if (!ok) return;
    }
    if (tab.editor && tab.editor.destroy) tab.editor.destroy();
  } else {
    if (tab.reconnectTimer) clearTimeout(tab.reconnectTimer);
    if (tab.heartbeat) clearInterval(tab.heartbeat);
    if (tab.dataDisposable) tab.dataDisposable.dispose();
    if (tab.resizeDisposable) tab.resizeDisposable.dispose();
    if (tab.ws) { tab.ws.onclose = null; tab.ws.close(); }
    tab.term.dispose();
  }
  tab.paneEl.remove();
  tabs.delete(tabId);
  _removeFromAllOrders(tabId);
  delete tabPanelAssignments[tabId];
  try { localStorage.setItem('tabPanelAssignments', JSON.stringify(tabPanelAssignments)); } catch {}

  const wasActiveInPanel = _activeIdForPanel(panel) === tabId;
  if (wasActiveInPanel) {
    const remaining = [...tabs.entries()].filter(([, t]) => (t.panel || 'primary') === panel);
    if (remaining.length > 0) {
      switchTab(remaining[remaining.length - 1][0]);
    } else {
      _setActiveIdForPanel(panel, null);
      showEmptyState(panel);
      _updateStatusBarRef && _updateStatusBarRef();
    }
  }
  _updateSidePanelVisibility();

  renderTabs();
  _renderSidebarRef && _renderSidebarRef();
}

export function showEmptyState(panel = 'primary') {
  if (panel === 'side') {
    document.querySelectorAll('#side-terminal-area .terminal-pane').forEach(p => p.classList.remove('active'));
    return;
  }
  const area = document.getElementById('terminal-area');
  area.querySelectorAll('.terminal-pane').forEach(p => p.classList.remove('active'));
  if (!document.getElementById('empty-state')) {
    const el = document.createElement('div');
    el.id = 'empty-state';
    el.innerHTML = '<div>Select a session or create a new one</div><div class="hint">Pick a project from the sidebar to get started</div>';
    area.appendChild(el);
  }
  document.getElementById('empty-state').style.display = '';
}

export function _makeTabEl(id, tab, isActive) {
  const el = document.createElement('div');
  el.className = 'tab' + (isActive ? ' active' : '') + (tab.dirty ? ' tab-dirty' : '');
  el.dataset.tabId = id;
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-tab-id', id);
    e.dataTransfer.effectAllowed = 'move';
    document.body.classList.add('tab-dragging');
    document.getElementById('side-edge-dropzone')?.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    document.body.classList.remove('tab-dragging');
    document.getElementById('side-edge-dropzone')?.classList.remove('dragging');
    document.querySelectorAll('.tab.drop-before, .tab.drop-after').forEach(t => t.classList.remove('drop-before', 'drop-after'));
  });
  const icon = (() => {
    if (tab.type === 'file') return '<span class="file-tab-icon">&#128196;</span>';
    const cli = tab.cli_type || 'claude';
    if (cli === 'bash') return '<span style="color:var(--success);font-weight:bold;font-size:12px">&gt;</span>';
    const c = { claude: '#e8a55d', gemini: '#4285f4', codex: '#10a37f' }[cli] || '#8b949e';
    if (cli === 'codex') return `<svg width="10" height="10" viewBox="0 0 10 10" style="vertical-align:middle"><rect x="0" y="0" width="10" height="10" rx="2.5" fill="${c}"/><circle cx="5" cy="5" r="2.5" fill="var(--bg-secondary)"/></svg>`;
    const icons = { claude: '✳', gemini: '◆' };
    return `<span style="font-size:13px;color:${c};line-height:1">${icons[cli] || '?'}</span>`;
  })();
  const saveBtn = tab.type === 'file'
    ? `<button class="tab-save" draggable="false" title="Save (Ctrl+S)" style="background:none;border:none;color:${tab.dirty ? 'var(--accent)' : 'var(--text-muted)'};cursor:pointer;font-size:12px;padding:2px 4px;border-radius:3px;margin-right:2px${tab.dirty ? ';font-weight:bold' : ''}">&#128190;</button>`
    : '';
  // #522: draggable="false" on inner buttons keeps the tab itself as the
  // unambiguous drag handle. Without it, some browsers' mousedown-on-button
  // path can swallow the drag-start gesture when the user grabs the tab
  // near a button — particularly visible on file tabs which carry an extra
  // save button between the name and the close button.
  el.innerHTML = `
    ${icon}
    <span class="tab-name">${window.escapeHtml(tab.name)}</span>
    ${saveBtn}
    <button class="tab-close" draggable="false" title="Close tab">&#10005;</button>
  `;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.tab-close') || e.target.closest('.tab-save')) return;
    switchTab(id);
  });
  if (tab.type === 'file') {
    el.querySelector('.tab-save').addEventListener('click', (e) => {
      e.stopPropagation();
      window._saveFileTabRef && window._saveFileTabRef(id);
    });
  }
  el.querySelector('.tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(id);
  });
  return el;
}

function _renderOneTabBar(panel) {
  const barId = panel === 'side' ? 'side-tab-bar' : 'tab-bar';
  const bar = document.getElementById(barId);
  if (!bar) return;
  bar.innerHTML = '';
  const activeId = _activeIdForPanel(panel);
  const inPanel = [...tabs.entries()].filter(([, t]) => (t.panel || 'primary') === panel);
  const order = tabOrders[panel] || [];
  inPanel.sort(([a], [b]) => {
    const ai = order.indexOf(a); const bi = order.indexOf(b);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  for (const [id, tab] of inPanel) {
    bar.appendChild(_makeTabEl(id, tab, id === activeId));
  }
}

export function renderTabs() {
  _renderOneTabBar('primary');
  _renderOneTabBar('side');
  _updateSidePanelVisibility();
}

export function moveTabToPanel(tabId, targetPanel) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const sourcePanel = tab.panel || 'primary';
  if (sourcePanel === targetPanel) return;

  const targetAreaId = targetPanel === 'side' ? 'side-terminal-area' : 'terminal-area';
  const area = document.getElementById(targetAreaId);
  if (tab.paneEl && area) {
    area.appendChild(tab.paneEl);
  }

  tab.panel = targetPanel;
  tabPanelAssignments[tabId] = targetPanel;
  try { localStorage.setItem('tabPanelAssignments', JSON.stringify(tabPanelAssignments)); } catch {}
  _removeFromAllOrders(tabId);
  _appendToOrder(targetPanel, tabId);

  if (_activeIdForPanel(sourcePanel) === tabId) {
    const remaining = [...tabs.entries()].filter(([id, t]) => id !== tabId && (t.panel || 'primary') === sourcePanel);
    _setActiveIdForPanel(sourcePanel, remaining.length ? remaining[remaining.length - 1][0] : null);
  }
  if (!_activeIdForPanel(targetPanel)) {
    _setActiveIdForPanel(targetPanel, tabId);
  }

  _updateSidePanelVisibility();

  const srcActive = _activeIdForPanel(sourcePanel);
  if (srcActive && (sourcePanel === 'primary' || sourcePanel === 'side')) {
    for (const [id, t] of tabs) {
      if ((t.panel || 'primary') !== sourcePanel) continue;
      if (t.paneEl) t.paneEl.classList.toggle('active', id === srcActive);
    }
  } else if (sourcePanel === 'primary') {
    showEmptyState('primary');
  }

  switchTab(tabId);

  setTimeout(() => {
    for (const t of tabs.values()) {
      if (t.fitAddon) try { t.fitAddon.fit(); } catch {}
    }
  }, 50);

  renderTabs();
  _updateStatusBarRef && _updateStatusBarRef();
}

export function _wireDropZones() {
  const wireBar = (barId, panel) => {
    const bar = document.getElementById(barId);
    if (!bar) return;
    bar.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-tab-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const overTab = e.target.closest('.tab');
      document.querySelectorAll(`#${barId} .tab.drop-before, #${barId} .tab.drop-after`).forEach(t => t.classList.remove('drop-before', 'drop-after'));
      if (overTab) {
        const r = overTab.getBoundingClientRect();
        const before = (e.clientX - r.left) < r.width / 2;
        overTab.classList.add(before ? 'drop-before' : 'drop-after');
        bar.classList.remove('drag-over');
      } else {
        bar.classList.add('drag-over');
      }
    });
    bar.addEventListener('dragleave', (e) => {
      if (!bar.contains(e.relatedTarget)) {
        bar.classList.remove('drag-over');
        bar.querySelectorAll('.tab.drop-before, .tab.drop-after').forEach(t => t.classList.remove('drop-before', 'drop-after'));
      }
    });
    bar.addEventListener('drop', (e) => {
      e.preventDefault();
      bar.classList.remove('drag-over');
      const overTab = e.target.closest('.tab');
      let targetTabId = null;
      let dropBefore = true;
      if (overTab) {
        const r = overTab.getBoundingClientRect();
        dropBefore = (e.clientX - r.left) < r.width / 2;
        targetTabId = overTab.dataset.tabId;
      }
      bar.querySelectorAll('.tab.drop-before, .tab.drop-after').forEach(t => t.classList.remove('drop-before', 'drop-after'));
      const id = e.dataTransfer.getData('application/x-tab-id');
      if (!id || !tabs.has(id)) return;
      const tab = tabs.get(id);
      const sourcePanel = tab.panel || 'primary';
      // #522: route array surgery through the pure helper in util.js so the
      // behavior is testable in isolation and the drop-on-empty-bar case
      // (no target tab — drop past the last tab) is handled uniformly across
      // all tab types instead of being a silent no-op as it was previously.
      const reorder = (typeof window !== 'undefined' && window.computeReorderedTabOrder)
        || ((cur, dragged, target, before) => {
          // Defensive inline fallback if util.js hasn't loaded.
          const without = (cur || []).filter(x => x !== dragged);
          if (!target || target === dragged) return [...without, dragged];
          const ti = without.indexOf(target);
          if (ti === -1) return [...without, dragged];
          const r = [...without];
          r.splice(before ? ti : ti + 1, 0, dragged);
          return r;
        });
      if (sourcePanel !== panel) {
        moveTabToPanel(id, panel);
        if (targetTabId && targetTabId !== id) {
          tabOrders[panel] = reorder(tabOrders[panel], id, targetTabId, dropBefore);
          _persistTabOrders();
          renderTabs();
        }
      } else {
        // Same-panel reorder. Even when targetTabId is null (drop on bar
        // background), append to end rather than silently dropping the
        // gesture on the floor.
        if (targetTabId === id) return;
        tabOrders[panel] = reorder(tabOrders[panel], id, targetTabId, dropBefore);
        _persistTabOrders();
        renderTabs();
      }
    });
  };
  wireBar('tab-bar', 'primary');
  wireBar('side-tab-bar', 'side');

  const edge = document.getElementById('side-edge-dropzone');
  if (edge) {
    edge.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-tab-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      edge.classList.add('drag-over');
    });
    edge.addEventListener('dragleave', () => edge.classList.remove('drag-over'));
    edge.addEventListener('drop', (e) => {
      e.preventDefault();
      edge.classList.remove('drag-over');
      const id = e.dataTransfer.getData('application/x-tab-id');
      if (!id || !tabs.has(id)) return;
      const tab = tabs.get(id);
      if ((tab.panel || 'primary') !== 'side') moveTabToPanel(id, 'side');
    });
  }
}

export function _refitAllTerminals() {
  for (const t of tabs.values()) {
    if (t.fitAddon) try { t.fitAddon.fit(); } catch {}
  }
}

export function initSideDivider() {
  const divider = document.getElementById('side-divider');
  const panel = document.getElementById('side-panel');
  if (!divider || !panel) return;
  let startX = 0; let startWidth = 0; let dragging = false;
  divider.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startWidth = panel.offsetWidth || sidePanelWidth;
    divider.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = startX - e.clientX;
    const max = Math.floor(window.innerWidth * 0.45);
    let w = startWidth + delta;
    if (w < 150) w = 150;
    if (w > max) w = max;
    const { setSidePanelWidth } = window._stateSetters || {};
    if (setSidePanelWidth) setSidePanelWidth(w);
    panel.style.width = w + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    try { localStorage.setItem('sidePanelWidth', String(sidePanelWidth)); } catch {}
    _refitAllTerminals();
  });
  try {
    const ro = new ResizeObserver(() => _refitAllTerminals());
    ro.observe(document.getElementById('terminal-area'));
    ro.observe(document.getElementById('side-terminal-area'));
  } catch {}
}
