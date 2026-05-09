'use strict';

// #337 [A12]: minimal HTML served when public/gate.html is missing or corrupt
// at boot. Keep this tight — operators don't need to ship a separate fallback
// asset, and the gate page is rendered before any other UI is reachable.
const GATE_PAGE_FALLBACK = '<!doctype html><html><head><meta charset="utf-8"><title>Workbench</title></head><body><h1>Workbench Gate</h1><p>Authentication required. Reload after configuring access.</p></body></html>';

// Pure loader: takes a readFileSync (so tests can inject a throwing or
// passing variant), returns the raw gate-page template (with the
// `// __GATE_MODE_INJECT__` placeholder un-substituted). The auth mode is
// resolved per-request via renderGatePage() because authMode is detected
// asynchronously after this loader runs at boot — caching the rendered
// HTML with a stale mode would serve the wrong UI on password/template
// deployments. (Codex Phase 1 gate review High finding.)
function loadGatePageTemplate({ readFileSync, gatePath, fallback = GATE_PAGE_FALLBACK, onError } = {}) {
  try {
    return readFileSync(gatePath, 'utf-8');
  } catch (err) {
    if (typeof onError === 'function') onError(err);
    return fallback;
  }
}

// Per-request render — single string-replace; cheap. Falls back to the raw
// template when the placeholder isn't present (e.g., the FALLBACK string
// has no injection point).
function renderGatePage(template, mode) {
  return template.replace(
    '// __GATE_MODE_INJECT__',
    `const __GATE_MODE__ = '${mode}';`,
  );
}

// Back-compat shim: the previous API took {mode} at boot. Existing callers
// can keep using this if they accept the boot-mode behaviour, but the
// canonical flow is loadGatePageTemplate + renderGatePage.
function loadGatePageHtml({ readFileSync, gatePath, mode, fallback = GATE_PAGE_FALLBACK, onError } = {}) {
  const tpl = loadGatePageTemplate({ readFileSync, gatePath, fallback, onError });
  return renderGatePage(tpl, mode);
}

module.exports = { loadGatePageTemplate, renderGatePage, loadGatePageHtml, GATE_PAGE_FALLBACK };
