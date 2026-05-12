// ── State ────────────────────────────────────────
export const tabs = new Map();
window.tabs = tabs; // expose for test instrumentation
export let activeTabId = null;          // primary panel's active tab (kept as the original name for legacy callers)
export let activeTabSideId = null;      // side panel's active tab
export let focusedPanel = 'primary';    // 'primary' | 'side' — last panel the user clicked into
export let sidePanelOpen = false;       // mirrors whether any tab has panel:'side'
export let sidePanelWidth = parseInt(localStorage.getItem('sidePanelWidth') || '480', 10);
// Per-session panel assignment + per-panel order persisted across reloads (#251)
export const tabPanelAssignments = (() => {
  try { return JSON.parse(localStorage.getItem('tabPanelAssignments') || '{}'); }
  catch { return {}; }
})();
export const tabOrders = (() => {
  try {
    const o = JSON.parse(localStorage.getItem('tabOrders') || '{}');
    return { primary: Array.isArray(o.primary) ? o.primary : [], side: Array.isArray(o.side) ? o.side : [] };
  } catch { return { primary: [], side: [] }; }
})();
export function _persistTabOrders() {
  try { localStorage.setItem('tabOrders', JSON.stringify(tabOrders)); } catch {}
}
export function _appendToOrder(panel, tabId) {
  tabOrders[panel] = tabOrders[panel].filter(id => id !== tabId);
  tabOrders[panel].push(tabId);
  _persistTabOrders();
}
export function _removeFromAllOrders(tabId) {
  tabOrders.primary = tabOrders.primary.filter(id => id !== tabId);
  tabOrders.side = tabOrders.side.filter(id => id !== tabId);
  _persistTabOrders();
}
export let projectState = [];
export let programState = [];
export const expandedPrograms = new Set(JSON.parse(localStorage.getItem('expandedPrograms') || '["__unassigned__"]'));
export let sessionFilter = 'active';
export let sessionSortBy = 'date';
export const expandedProjects = new Set(JSON.parse(localStorage.getItem('expandedProjects') || '[]'));
export let _lastClickedProjectPath = null;
export const HEARTBEAT_MS = 30000;
export const REFRESH_MS = 10000;
export const MAX_RECONNECT_DELAY = 30000;
export let _settingsCache = {};
export function db_getSetting(key) { return _settingsCache[key] || null; }

// Setters for mutable state (needed because ES module bindings are read-only from importers)
export function setActiveTabId(id) { activeTabId = id; }
export function setActiveTabSideId(id) { activeTabSideId = id; }
export function setFocusedPanel(p) { focusedPanel = p; }
export function setSidePanelOpen(v) { sidePanelOpen = v; }
export function setSidePanelWidth(v) { sidePanelWidth = v; }
export function setProjectState(v) { projectState = v; }
export function setProgramState(v) { programState = v; }
export function setSessionFilter(v) { sessionFilter = v; }
export function setSessionSortBy(v) { sessionSortBy = v; }
export function setLastClickedProjectPath(v) { _lastClickedProjectPath = v; }
export function setSettingsCache(v) { _settingsCache = v; }

// ── Tab-switch debug instrumentation (issue #161) ──────────────────
// Gated on: localStorage.DEBUG_TAB_SWITCHING === '1'  OR  URL ?debug=tabs
// Off by default so normal use stays quiet. Turn on in the browser console
// with: localStorage.DEBUG_TAB_SWITCHING='1'  then reload.
window.DEBUG_TAB_SWITCHING = (
  localStorage.getItem('DEBUG_TAB_SWITCHING') === '1' ||
  new URLSearchParams(location.search).get('debug') === 'tabs'
);
export function tabDbg(event, extra) {
  if (!window.DEBUG_TAB_SWITCHING) return;
  const snapshot = {
    activeTabId,
    tabCount: tabs.size,
    tabs: [...tabs.entries()].map(([id, t]) => {
      const pe = t.paneEl;
      return {
        id,
        type: t.type,
        cli: t.cli_type || null,
        paneElId: pe?.id || null,
        paneActive: pe?.classList.contains('active') || false,
        paneIsConnected: pe ? pe.isConnected : false,
        paneComputedDisplay: pe && pe.isConnected ? getComputedStyle(pe).display : '<detached>',
        paneInlineDisplay: pe?.style?.display || '',
        paneParent: pe?.parentElement?.id || null,
        tmux: t.tmux || null,
        wsState: t.ws ? ['CONNECTING','OPEN','CLOSING','CLOSED'][t.ws.readyState] : 'NONE',
        status: t.status || null,
      };
    }),
    panesInDom: [...document.querySelectorAll('#terminal-area .terminal-pane')].map(p => ({
      id: p.id,
      active: p.classList.contains('active'),
      computedDisplay: getComputedStyle(p).display,
    })),
    orphanPanes: [...document.querySelectorAll('#terminal-area .terminal-pane')]
      .filter(p => ![...tabs.values()].some(t => t.paneEl === p))
      .map(p => p.id),
    // Orphan xterm/canvas elements — a canvas that's not inside any
    // known paneEl is a zombie renderer from a closed tab that still
    // ticks (cursorBlink etc.), surfacing as "dots" or ghost content
    // over other UI panels.
    orphanCanvases: [...document.querySelectorAll('.xterm, canvas')]
      .filter(c => !c.closest('.terminal-pane'))
      .map(c => ({
        tag: c.tagName, cls: c.className,
        parentId: c.parentElement?.id || c.parentElement?.className || '?',
        rect: c.getBoundingClientRect && c.getBoundingClientRect().width > 0
          ? `${Math.round(c.getBoundingClientRect().width)}x${Math.round(c.getBoundingClientRect().height)}`
          : 'zero',
      })),
  };
  // eslint-disable-next-line no-console
  console.log('[tab-dbg]', event, extra || {}, snapshot);
}

export function setFilter(filter) {
  sessionFilter = filter;
  // renderSidebar is imported by app.js which wires this call
  window._renderSidebarRef && window._renderSidebarRef();
}

export const TERM_THEME = {
  background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff',
  selectionBackground: '#264f78',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d353', white: '#e6edf3',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
  brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
  brightCyan: '#56d364', brightWhite: '#f0f6fc',
};
