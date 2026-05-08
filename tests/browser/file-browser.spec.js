'use strict';

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

describe('file browser (browser)', () => {
  let browser, page;
  const errors = [];

  before(async () => {
    require('fs').mkdirSync(SS, { recursive: true });
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await writeCoverageReport('file-browser');
    if (browser) await browser.close();
  });
  beforeEach(async () => {
    errors.length = 0;
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await startCoverage(page);
    await resetBaseline(page);
  });
  afterEach(async () => {
    await stopCoverage(page);
  });

  it('BRW-09: file browser panel loads and displays file tree entries', async () => {
    // Open the right panel first (it starts closed), then ensure files tab is active
    await page.click('#panel-toggle');
    // Files tab is already active by default; click it to be explicit
    await page.click('[data-panel="files"]');
    assert.ok(
      await page.locator('#panel-files').isVisible(),
      'Files panel section must be visible after panel opens',
    );
    assert.ok(
      await page.locator('#file-browser-tree').isVisible(),
      'File tree container must be visible',
    );
    // Gray-box: verify the file tree API is responsive and returns content.
    // Per #319 (jQuery removal), the endpoint is now GET /api/browse?path=...
    // returning JSON ({path, parent, entries: [{name, type}]}). The vanilla
    // createFileTree consumes this shape.
    const apiResponse = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/browse?path=/');
        const data = await r.json();
        return {
          ok: r.ok,
          status: r.status,
          entryCount: Array.isArray(data.entries) ? data.entries.length : 0,
          path: data.path,
        };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
    assert.ok(apiResponse.ok, 'File tree API /api/browse must respond successfully');
    assert.ok(
      apiResponse.entryCount > 0,
      `File tree API must return non-empty entries array (got ${apiResponse.entryCount})`,
    );
    assert.equal(apiResponse.path, '/', 'API echoes the requested path back');
    await page.screenshot({ path: `${SS}/files--panel.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });
});
