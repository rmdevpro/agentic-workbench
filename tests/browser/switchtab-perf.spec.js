'use strict';

// #343 [A18]: terminal-pane visibility model changed from display:none/block
// to visibility:hidden/visible. Panes now stay in layout so xterm.js measures
// dimensions immediately — no more 300ms refit fallback.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  process.exit(0);
}

const { resetBaseline } = require('../helpers/reset-state');
const { startCoverage, stopCoverage, writeCoverageReport } = require('../helpers/browser-coverage');
const SS = require('path').join(__dirname, 'screenshots');

describe('switchTab visibility (browser)', () => {
  let browser, page;
  const errors = [];

  before(async () => {
    require('fs').mkdirSync(SS, { recursive: true });
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await writeCoverageReport('switchtab-perf');
    if (browser) await browser.close();
  });
  beforeEach(async () => {
    errors.length = 0;
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await startCoverage(page);
    await resetBaseline(page);
  });
  afterEach(async () => { await stopCoverage(page); });

  it('SWT-01: terminal-pane CSS uses visibility, not display:none', async () => {
    // Inject a sample pane and verify the inactive style is visibility:hidden,
    // not display:none. This proves the layout-preserving model is in place
    // without requiring a real session.
    const result = await page.evaluate(() => {
      const pane = document.createElement('div');
      pane.className = 'terminal-pane';
      document.body.appendChild(pane);
      const inactive = getComputedStyle(pane);
      const inactiveDisplay = inactive.display;
      const inactiveVisibility = inactive.visibility;
      pane.classList.add('active');
      const active = getComputedStyle(pane);
      const activeDisplay = active.display;
      const activeVisibility = active.visibility;
      pane.remove();
      return { inactiveDisplay, inactiveVisibility, activeDisplay, activeVisibility };
    });
    // Inactive must NOT be display:none; both states must keep block-like layout.
    assert.notEqual(result.inactiveDisplay, 'none', `inactive .terminal-pane must not be display:none — got ${result.inactiveDisplay}`);
    assert.equal(result.inactiveVisibility, 'hidden', `inactive must be visibility:hidden — got ${result.inactiveVisibility}`);
    assert.equal(result.activeVisibility, 'visible', `active must be visibility:visible — got ${result.activeVisibility}`);
  });

  it('SWT-02: switchTab does not schedule a 300ms timeout fit fallback', async () => {
    // Source-grep: assert the legacy `setTimeout(..., 300)` post-fit hack is
    // no longer present in the page. This is structural — it pins the issue
    // acceptance criterion ("Remove the setTimeout(..., 300) line as proof
    // of fix") so a reverter trips this test.
    const html = await page.content();
    const switchTabBlock = html.match(/function switchTab\([\s\S]+?\n    \}/);
    assert.ok(switchTabBlock, 'switchTab function must be present in page source');
    assert.ok(!/setTimeout\([^,]+,\s*300\s*\)/.test(switchTabBlock[0]),
      `switchTab body must not contain setTimeout(..., 300): ${switchTabBlock[0]}`);
    assert.equal(errors.length, 0, errors.join(', '));
  });
});
