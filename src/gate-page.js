'use strict';

// #337 [A12]: minimal HTML served when public/gate.html is missing or corrupt
// at boot. Keep this tight — operators don't need to ship a separate fallback
// asset, and the gate page is rendered before any other UI is reachable.
const GATE_PAGE_FALLBACK = '<!doctype html><html><head><meta charset="utf-8"><title>Workbench</title></head><body><h1>Workbench Gate</h1><p>Authentication required. Reload after configuring access.</p></body></html>';

// Pure loader: takes a readFileSync (so tests can inject a throwing or
// passing variant), produces the gate-page HTML with the auth-mode constant
// inlined. On read failure, returns the fallback and invokes onError.
function loadGatePageHtml({ readFileSync, gatePath, mode, fallback = GATE_PAGE_FALLBACK, onError } = {}) {
  try {
    const raw = readFileSync(gatePath, 'utf-8');
    return raw.replace(
      '// __GATE_MODE_INJECT__',
      `const __GATE_MODE__ = '${mode}';`,
    );
  } catch (err) {
    if (typeof onError === 'function') onError(err);
    return fallback;
  }
}

module.exports = { loadGatePageHtml, GATE_PAGE_FALLBACK };
