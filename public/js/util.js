'use strict';

// #341 [A16]: HTML / attribute escape helpers consolidated. Two prior
// implementations (escapeHtml in the error-log block, escAttr in the
// task-row builder) have been collapsed into one pair of typed helpers
// here. Loaded into the page via <script>; also requireable from Node
// tests via the UMD wrapper.
//
// escapeHtml(s)  → safe for use as text content (innerHTML body)
// escapeAttr(s)  → safe for use as a double-quoted HTML attribute value
//
// CSS-attribute escape (for [data-x="..."] selectors) is a separate
// concern and stays inline near its consumer; it uses CSS.escape.
(function (global) {

  const HTML_ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => HTML_ENTITIES[c]);
  }

  // Strict subset for attribute values inside double quotes. Same shape as
  // escapeHtml but exposed under a distinct name so call-sites read clearly:
  // `<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`.
  function escapeAttr(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => HTML_ENTITIES[c]);
  }

  // #564: short-window retry wrapper around fetch. The bare /api/state fetch
  // in loadState() previously errored out on a single TypeError ("Failed to
  // fetch" — transient network/process flake) and never recovered until the
  // next 10s poll, blowing past SMOKE-PROJ-01 assertion-03's bounded ≤5s
  // window for "new project appears in sidebar after Save."
  //
  // Retry semantics:
  //  - Retries ONLY on thrown errors (TypeError on network failure).
  //  - Does NOT retry HTTP 4xx/5xx — those are application-level, not
  //    transient, and silently retrying would mask real failures.
  //  - Defaults to 3 attempts (1 initial + 2 retries) with 500ms backoff —
  //    total worst-case 1.0s before final failure, well inside the 5s bound.
  //
  // Caller owns the response (status check, .json() etc.) — this helper is
  // purely about wrapping `fetch()` itself.
  async function fetchWithRetry(url, options = {}, { attempts = 3, backoffMs = 500 } = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fetch(url, options);
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1) {
          await new Promise(r => setTimeout(r, backoffMs));
        }
      }
    }
    throw lastErr;
  }

  const exports = { escapeHtml, escapeAttr, fetchWithRetry };
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  else {
    global.escapeHtml = escapeHtml;
    global.escapeAttr = escapeAttr;
    global.fetchWithRetry = fetchWithRetry;
    global.WorkbenchUtil = exports;
  }
})(typeof window !== 'undefined' ? window : globalThis);
