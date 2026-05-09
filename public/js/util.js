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

  const exports = { escapeHtml, escapeAttr };
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  else {
    global.escapeHtml = escapeHtml;
    global.escapeAttr = escapeAttr;
    global.WorkbenchUtil = exports;
  }
})(typeof window !== 'undefined' ? window : globalThis);
