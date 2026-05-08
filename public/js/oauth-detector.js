'use strict';

// #339 [A14]: OAuth URL detector extracted from public/index.html so the
// per-CLI start/end-marker patterns are testable against fixture transcripts
// without booting the browser. Loaded into the page via <script> tag and
// also requireable from Node tests via the UMD wrapper at the bottom.
//
// Known limitation: detection is substring-based on the cleaned PTY output
// buffer. A CLI that updates its prompt ("Paste your code here:" → "Enter
// the code:") without us updating the endMarker pattern in this table will
// silently regress to "URL never extracted, modal never appears". Fixture
// tests below pin each pattern to a captured transcript so the regression
// is loud.
(function (global) {

  const OAUTH_URL_PATTERNS = [
    { start: 'https://claude.com/cai/oauth/authorize?', endMarker: 'Paste', cli: 'claude' },
    { start: 'https://accounts.google.com/o/oauth2/', endMarker: 'Enter the authorization code', cli: 'gemini' },
    { start: 'https://auth0.openai.com/', endMarker: 'code', cli: 'codex' },
  ];
  const AUTH_ERROR_PATTERN = /OAuth token has expired|authentication_error|Not logged in/;

  // Strip ANSI CSI escapes + BELs from a PTY chunk so substring matches see
  // the same stable text the user reads.
  function cleanAnsi(s) {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x07]/g, '');
  }

  // Pure: scan a PTY-output buffer for an OAuth URL and return the cleaned
  // URL + matched CLI, or null if no URL is yet visible. Testable with
  // synthetic fixtures.
  function parseOAuthBuffer(buf) {
    const cleanBuf = cleanAnsi(buf);
    for (const pattern of OAUTH_URL_PATTERNS) {
      const urlStart = cleanBuf.indexOf(pattern.start);
      if (urlStart === -1) continue;
      const pasteIdx = cleanBuf.indexOf(pattern.endMarker, urlStart + 50);
      if (pasteIdx === -1) continue; // URL not fully received yet
      const rawUrl = cleanBuf.substring(urlStart, pasteIdx);
      // eslint-disable-next-line no-control-regex
      const cleanUrl = rawUrl
        .replace(/[\x00-\x1f]/g, '')
        .replace(/\s+/g, '')
        .replace(/[&?]+$/, '');
      return { url: cleanUrl, cli: pattern.cli };
    }
    return null;
  }

  // Stateful detector: feeds PTY data per tab, fires `onAuthDetected({tabId,
  // url, cli})` exactly once per resolved URL (modal lock is up to the
  // caller — `reset(tabId)` clears the per-tab buffer).
  function createOAuthDetector({
    ptyOutputBuffer,
    oauthDetection,
    getCliType,
    isModalVisible,
    onAuthDetected,
    bufferLimit = 4000,
  } = {}) {
    if (!ptyOutputBuffer || typeof ptyOutputBuffer.get !== 'function') {
      throw new Error('createOAuthDetector requires a ptyOutputBuffer with Map-like get/set/delete');
    }
    function feed(tabId, data) {
      if (typeof isModalVisible === 'function' && isModalVisible()) return;
      const cliType = (typeof getCliType === 'function' ? getCliType(tabId) : null) || 'claude';
      if (oauthDetection && !oauthDetection[cliType]) return;
      const buf = (ptyOutputBuffer.get(tabId) || '') + data;
      ptyOutputBuffer.set(tabId, buf.slice(-bufferLimit));
      const found = parseOAuthBuffer(ptyOutputBuffer.get(tabId));
      if (!found) return;
      ptyOutputBuffer.delete(tabId);
      if (typeof onAuthDetected === 'function') onAuthDetected({ tabId, url: found.url, cli: found.cli });
    }
    function reset(tabId) {
      if (tabId === undefined) ptyOutputBuffer.clear?.();
      else ptyOutputBuffer.delete(tabId);
    }
    return { feed, reset };
  }

  const exports = { OAUTH_URL_PATTERNS, AUTH_ERROR_PATTERN, cleanAnsi, parseOAuthBuffer, createOAuthDetector };
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  else global.OAuthDetector = exports;
})(typeof window !== 'undefined' ? window : globalThis);
