import {
  tabs, HEARTBEAT_MS, MAX_RECONNECT_DELAY, tabDbg,
  _settingsCache, db_getSetting,
} from './state.js';
import { _activeIdForPanel, _panelOf, renderTabs } from './tabs.js';

let _renderSidebarRef, _updateStatusBarRef, _openFileTabRef;

export function initTerminalDeps(deps) {
  _renderSidebarRef = deps.renderSidebar;
  _updateStatusBarRef = deps.updateStatusBar;
  _openFileTabRef = deps.openFileTab;
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

// Theme data is defined in settings.js and registered here via window
export function getThemes() { return window._THEMES || { dark: { css: null, term: TERM_THEME } }; }

export function connectTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  tab.status = 'connecting';
  renderTabs();
  tabDbg('connectTab:opening', { tabId, tmux: tab.tmux });

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/${tab.tmux}`);
  ws.binaryType = 'arraybuffer';
  tab.ws = ws;

  ws.onopen = () => {
    tabDbg('ws:open', { tabId, tmux: tab.tmux });
    tab.status = 'connected';
    tab.reconnectDelay = 1000;
    tab._resumeAttempts = 0;
    renderTabs();
    _updateStatusBarRef && _updateStatusBarRef();

    tab.fitAddon.fit();
    const dims = tab.fitAddon.proposeDimensions();
    if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows) && dims.cols > 0 && dims.rows > 0) {
      ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
    }
    setTimeout(() => {
      if (tabs.has(tabId)) {
        tab.fitAddon.fit();
        const d = tab.fitAddon.proposeDimensions();
        if (d && Number.isFinite(d.cols) && Number.isFinite(d.rows) && d.cols > 0 && d.rows > 0 && tab.ws?.readyState === WebSocket.OPEN) {
          tab.ws.send(JSON.stringify({ type: 'resize', cols: d.cols, rows: d.rows }));
        }
      }
    }, 500);

    if (tab.dataDisposable) tab.dataDisposable.dispose();
    tab.dataDisposable = tab.term.onData((data) => {
      if (tab.ws && tab.ws.readyState === WebSocket.OPEN) tab.ws.send(data);
    });

    if (tab.resizeDisposable) tab.resizeDisposable.dispose();
    tab.resizeDisposable = tab.term.onResize(({ cols, rows }) => {
      if (tab.ws && tab.ws.readyState === WebSocket.OPEN && Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
        tab.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    if (tab.heartbeat) clearInterval(tab.heartbeat);
    tab.heartbeat = setInterval(() => {
      if (tab.ws && tab.ws.readyState === WebSocket.OPEN) {
        tab.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, HEARTBEAT_MS);
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      if (event.data.startsWith('{')) {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong') return;
          if (msg.type === 'token_update') {
            tab._statusData = msg.data;
            const panel = _panelOf(tabId);
            if (tabId === _activeIdForPanel(panel)) _updateStatusBarRef && _updateStatusBarRef(panel);
            clearTimeout(window._tokenRefreshTimer);
            window._tokenRefreshTimer = setTimeout(() => window._loadStateRef && window._loadStateRef(), 2000);
            return;
          }
          if (msg.type === 'settings_update') {
            tab._settingsData = msg;
            const panel = _panelOf(tabId);
            if (tabId === _activeIdForPanel(panel)) _updateStatusBarRef && _updateStatusBarRef(panel);
            return;
          }
          if (msg.type === 'cli_settings_changed') {
            clearTimeout(window._cliSettingsRefreshTimer);
            window._cliSettingsRefreshTimer = setTimeout(() => window._loadStateRef && window._loadStateRef(), 1000);
            return;
          }
          if (msg.type === 'error') {
            tab.term.write(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m\r\n`);
            if (msg.message && msg.message.includes('No tmux session')) {
              tab._resumeAttempts = (tab._resumeAttempts || 0) + 1;
              if (tab._resumeAttempts > 3) {
                tab.noReconnect = true;
                tab.term.write(`\r\n\x1b[31mSession could not be resumed after 3 attempts.\x1b[0m\r\n`);
                tab.term.write(`\r\n\x1b[90mClick the session in the sidebar to retry.\x1b[0m\r\n`);
                return;
              }
              tab.term.write(`\r\n\x1b[33mSession disconnected. Attempting to resume (${tab._resumeAttempts}/3)...\x1b[0m\r\n`);
              tab.noReconnect = true;
              fetch(`/api/sessions/${tabId}/resume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project: tab.project }),
              }).then(r => r.json()).then(data => {
                if (data.error) {
                  tab.term.write(`\r\n\x1b[31mResume failed: ${data.error}\x1b[0m\r\n`);
                  tab.term.write(`\r\n\x1b[90mClick the session in the sidebar to retry.\x1b[0m\r\n`);
                } else {
                  tab.term.write(`\r\n\x1b[32mSession resumed. Reconnecting...\x1b[0m\r\n`);
                  tab.tmux = data.tmux;
                  tab.noReconnect = false;
                  setTimeout(() => connectTab(tabId), 2000);
                }
              }).catch(() => {
                tab.term.write(`\r\n\x1b[90mClick the session in the sidebar to retry.\x1b[0m\r\n`);
              });
            }
            return;
          }
        } catch {}
      }
      window.checkForAuthIssue && window.checkForAuthIssue(tab.id, event.data);
      tab.term.write(event.data);
    } else {
      tab.term.write(new Uint8Array(event.data));
    }
  };

  ws.onclose = (ev) => {
    tabDbg('ws:close', { tabId, tmux: tab.tmux, code: ev.code, reason: ev.reason, wasClean: ev.wasClean, noReconnect: !!tab.noReconnect });
    tab.status = 'disconnected';
    if (tab.heartbeat) { clearInterval(tab.heartbeat); tab.heartbeat = null; }
    renderTabs();

    if (tabs.has(tabId) && !tab.noReconnect) {
      tab.reconnectTimer = setTimeout(() => {
        if (tabs.has(tabId)) connectTab(tabId);
      }, tab.reconnectDelay);
      tab.reconnectDelay = Math.min(tab.reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }
  };

  ws.onerror = (ev) => { tabDbg('ws:error', { tabId, tmux: tab.tmux }); tab.status = 'disconnected'; renderTabs(); };
}

export function createTerminalTab(tabId, tmuxSession, name, project, cliType, targetPanel, targetAreaId) {
  const THEMES = getThemes();
  const savedFontSize = parseInt(db_getSetting('font_size')) || 14;
  const savedFontFamily = db_getSetting('font_family') || "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Menlo, Monaco, monospace";
  const savedTheme = db_getSetting('theme');
  const paneEl = document.createElement('div');
  paneEl.className = 'terminal-pane';
  paneEl.id = `pane-${tabId}`;
  document.getElementById(paneEl.id)?.remove();
  document.getElementById(targetAreaId).appendChild(paneEl);

  const term = new Terminal({
    cursorBlink: true, fontSize: savedFontSize,
    fontFamily: savedFontFamily,
    theme: (THEMES[savedTheme] || THEMES.dark).term,
    allowProposedApi: true,
    scrollback: 10000,
    fastScrollSensitivity: 5,
    scrollSensitivity: 3,
    linkHandler: {
      allowNonHttpProtocols: true,
      activate(event, uri) {
        let path = null;
        if (uri.startsWith('file://')) {
          try { path = decodeURIComponent(new URL(uri).pathname); } catch {}
        } else if (uri.startsWith('/')) {
          path = uri;
        }
        if (path && path.startsWith('/')) {
          _openFileTabRef && _openFileTabRef(path);
        } else {
          window.open(uri, '_blank', 'noopener,noreferrer');
        }
      },
    },
  });
  const mouseModes = [1000, 1002, 1003, 1006, 1015];
  for (const mode of mouseModes) {
    term.parser.registerCsiHandler({ prefix: '?', params: [mode], final: 'h' }, () => true);
    term.parser.registerCsiHandler({ prefix: '?', params: [mode], final: 'l' }, () => true);
  }

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((event, uri) => {
    window.open(uri, '_blank', 'noopener,noreferrer');
  }));
  term.open(paneEl);

  // #574: fit on initial mount. term.open uses a default 80x24 grid; without
  // an early fit() the pane can stay at sub-actual column counts (observed:
  // 1-column-wide on cold-side-car fresh-data deploys until a window resize
  // event fires). Fit immediately if paneEl has a non-zero clientWidth, and
  // again on the next rAF to catch layouts that finished after term.open
  // returned. connectTab's ws.onopen will re-fit once more when the WebSocket
  // hands back actual cols/rows from the server.
  const _safeInitialFit = () => {
    try {
      if (paneEl && paneEl.clientWidth > 0 && paneEl.clientHeight > 0) {
        fitAddon.fit();
      }
    } catch {
      /* ignore — fitAddon may not have dims yet */
    }
  };
  _safeInitialFit();
  requestAnimationFrame(_safeInitialFit);

  term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const line = term.buffer.active.getLine(lineNumber - 1);
      if (!line) return callback(undefined);
      const text = line.translateToString(true);
      const links = [];
      const re = /\/data\/workspace\/[^\s"'`<>()\[\]]+/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        let pathText = m[0].replace(/[.,;:!?)]+$/, '');
        const startCol = m.index + 1;
        links.push({
          range: {
            start: { x: startCol, y: lineNumber },
            end: { x: startCol + pathText.length - 1, y: lineNumber },
          },
          text: pathText,
          decorations: { pointerCursor: true, underline: true },
          activate(event, t) { _openFileTabRef && _openFileTabRef(t); },
        });
      }
      callback(links.length ? links : undefined);
    },
  });

  return { term, fitAddon, paneEl };
}
