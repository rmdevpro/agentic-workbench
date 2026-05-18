'use strict';

// #651 commit 11b (F8): central status-bar dispatcher. Observes State
// Engine pushes + WS connection lifecycle + tab switches + per-tab token
// updates, and renders the bottom status bar coherently from a single
// place. Replaces the scattered DOM writes that used to happen across
// terminal.js, tabs.js, app.js, oauth-detector.js — those modules
// previously stomped on each other (#595, #596, etc.).
//
// CLI parity (R9): the same shape lights up for claude / gemini / codex.
// Auth-mode pill (R14): Codex tabs show OAuth | API key | stale.
// Stale-auth badge (R18): Codex tabs surface a warning when
// claude_auth_broken / codex auth fields go true.
//
// Per the engine-state mirror in public/js/engine-state.js, createStatusBar
// expects a subscribe() function (typically engineStateClient.subscribe)
// plus a getState() and an HTMLElement to render into. UMD wrapper at the
// bottom — loadable in the browser via <script> and requireable from Node
// tests via createStatusBar(deps).

(function (global) {

  function _tabAuthFields(state, tabId) {
    // Look up the session row inside the engine snapshot. tabId here is the
    // workbench session id; the engine stores sessions keyed by id inside
    // each project. We do a single-pass lookup; the engine itself maintains
    // a sessionId → projectPath index server-side but we don't mirror that
    // on the client (engine pushes diffs the client already applied).
    for (const p of state.projects || []) {
      for (const s of p.sessions || []) {
        if (s.id === tabId) return s;
      }
    }
    return null;
  }

  function _derivedAuthMode(sess) {
    if (!sess) return 'unknown';
    if (sess.cli_type === 'codex') {
      if (sess.codex_auth_broken) return 'stale';
      if (sess.codex_api_key_set === true) return 'api-key';
      if (sess.codex_api_key_set === false) return 'oauth';
      return 'unknown';
    }
    if (sess.cli_type === 'claude') {
      return sess.claude_auth_broken ? 'stale' : 'oauth';
    }
    if (sess.cli_type === 'gemini') {
      return sess.gemini_auth_broken ? 'stale' : 'oauth';
    }
    return 'unknown';
  }

  function createStatusBar({
    el,
    getState,
    subscribe,
    getActiveTabId = () => null,
    getWsState = () => 'unknown', // 'connecting' | 'open' | 'closing' | 'closed' | 'unknown'
    logger = { warn() {}, info() {}, debug() {} },
  } = {}) {
    if (!el || typeof el !== 'object') {
      throw new Error('status-bar: el required');
    }
    if (typeof getState !== 'function') {
      throw new Error('status-bar: getState() required');
    }
    if (typeof subscribe !== 'function') {
      throw new Error('status-bar: subscribe() required');
    }

    let lastRender = { activeTabId: null, authMode: null, wsState: null, tokens: null };

    function render() {
      const state = getState();
      const activeTabId = getActiveTabId();
      const sess = _tabAuthFields(state, activeTabId);
      const authMode = _derivedAuthMode(sess);
      const wsState = getWsState();
      const tokens = sess && typeof sess.input_tokens === 'number' ? sess.input_tokens : null;
      const maxTokens = sess && typeof sess.max_tokens === 'number' ? sess.max_tokens : null;
      const model = sess && sess.model ? sess.model : null;

      // Skip re-render if nothing observable changed (cheap dedupe so
      // every state:diff doesn't thrash the DOM).
      if (
        lastRender.activeTabId === activeTabId &&
        lastRender.authMode === authMode &&
        lastRender.wsState === wsState &&
        lastRender.tokens === tokens &&
        lastRender.model === model
      ) return;
      lastRender = { activeTabId, authMode, wsState, tokens, model };

      // Layout: [ws-pill] [auth-pill] [token-counter] [model-name]
      el.innerHTML = '';
      el.appendChild(_pill('ws-pill', `ws: ${wsState}`, _wsClass(wsState)));
      if (sess) {
        el.appendChild(_pill('auth-pill', authMode, _authClass(authMode)));
      }
      if (tokens != null) {
        const pct = maxTokens > 0 ? Math.round((tokens / maxTokens) * 100) : 0;
        const label = maxTokens
          ? `${tokens.toLocaleString()} / ${maxTokens.toLocaleString()} (${pct}%)`
          : tokens.toLocaleString();
        el.appendChild(_pill('token-counter', label, _tokenClass(pct)));
      }
      if (model) {
        el.appendChild(_pill('model-pill', model, ''));
      }
    }

    function _pill(cls, text, mod) {
      // Use the host document if available; fall back to no-op for tests
      // that pass a fake el.
      const doc = (typeof document !== 'undefined') ? document : null;
      if (!doc) {
        const fake = { className: `status-bar-pill ${cls} ${mod}`.trim(), textContent: text };
        return fake;
      }
      const span = doc.createElement('span');
      span.className = `status-bar-pill ${cls} ${mod}`.trim();
      span.textContent = text;
      return span;
    }

    function _wsClass(s) {
      if (s === 'open') return 'pill-ok';
      if (s === 'connecting' || s === 'closing') return 'pill-warn';
      if (s === 'closed') return 'pill-err';
      return '';
    }
    function _authClass(m) {
      if (m === 'oauth') return 'pill-ok';
      if (m === 'api-key') return 'pill-info';
      if (m === 'stale') return 'pill-err';
      return '';
    }
    function _tokenClass(pct) {
      if (pct >= 90) return 'pill-err';
      if (pct >= 75) return 'pill-warn';
      return 'pill-ok';
    }

    const unsubscribe = subscribe((event) => {
      // snapshot, diff, connected, disconnected — all warrant a re-render.
      if (event && (event.type === 'snapshot' || event.type === 'diff' ||
                    event.type === 'connected' || event.type === 'disconnected')) {
        try { render(); }
        catch (err) { logger.warn('status-bar render threw', { err: err.message }); }
      }
    });

    // Initial paint
    try { render(); } catch (err) { logger.warn('status-bar initial render threw', { err: err.message }); }

    return {
      render,
      destroy() {
        if (typeof unsubscribe === 'function') unsubscribe();
      },
      _lastRender: () => lastRender,
    };
  }

  const exports = { createStatusBar, _derivedAuthMode };
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  else global.StatusBar = exports;

})(typeof window !== 'undefined' ? window : globalThis);
