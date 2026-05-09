'use strict';

// #340 [A15]: verify primary CRUD flows now use the workbench input/confirm
// modals, not native window.prompt / window.confirm. The prior implementation
// silently broke in embed contexts that block native dialogs (and was
// untestable in Playwright without `page.on('dialog')` glue).

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

describe('CRUD modals (browser)', () => {
  let browser, page;
  const errors = [];
  const nativeDialogs = [];

  before(async () => {
    require('fs').mkdirSync(SS, { recursive: true });
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await writeCoverageReport('modals');
    if (browser) await browser.close();
  });
  beforeEach(async () => {
    errors.length = 0;
    nativeDialogs.length = 0;
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    // Capture any native dialog (alert/confirm/prompt) that fires; auto-dismiss
    // so the test doesn't block. The expectation is this list stays empty.
    page.on('dialog', async (d) => {
      nativeDialogs.push({ type: d.type(), message: d.message() });
      await d.dismiss();
    });
    await startCoverage(page);
    await resetBaseline(page);
  });
  afterEach(async () => { await stopCoverage(page); });

  it('MDL-01: showInputModal API is available on window', async () => {
    const present = await page.evaluate(() => {
      return typeof window.showInputModal === 'function'
        && typeof window.showConfirmModal === 'function';
    });
    assert.ok(present, 'showInputModal + showConfirmModal must be loaded');
  });

  it('MDL-02: showInputModal renders the workbench modal, not a native prompt', async () => {
    // Trigger via the public API directly (no need to navigate a deep flow
    // for this layer of test — the call sites exercising it are covered by
    // the runbook's UI test).
    const promise = page.evaluate(() => window.showInputModal({
      title: 'TEST INPUT', label: 'Type a value:', defaultValue: 'hello',
    }));
    await page.waitForSelector('#input-modal.visible', { timeout: 2000 });
    const titleText = await page.locator('#input-modal-title').textContent();
    assert.equal(titleText, 'TEST INPUT');
    const fieldVal = await page.locator('#input-modal-field').inputValue();
    assert.equal(fieldVal, 'hello');
    // Submit with the visible OK button.
    await page.locator('#input-modal-ok').click();
    const result = await promise;
    assert.equal(result, 'hello');
    assert.equal(nativeDialogs.length, 0, `expected no native dialogs, got: ${JSON.stringify(nativeDialogs)}`);
    await page.screenshot({ path: `${SS}/modals--input.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('MDL-03: showInputModal returns null when dismissed', async () => {
    const promise = page.evaluate(() => window.showInputModal({
      title: 'TEST DISMISS', defaultValue: 'unused',
    }));
    await page.waitForSelector('#input-modal.visible', { timeout: 2000 });
    await page.locator('#input-modal .modal-close').click();
    const result = await promise;
    assert.equal(result, null);
    assert.equal(nativeDialogs.length, 0);
  });

  it('MDL-04: showConfirmModal renders the workbench modal, not a native confirm', async () => {
    const promise = page.evaluate(() => window.showConfirmModal({
      title: 'TEST CONFIRM', message: 'Are you sure?', confirmLabel: 'Yes', danger: true,
    }));
    await page.waitForSelector('#confirm-modal.visible', { timeout: 2000 });
    const titleText = await page.locator('#confirm-modal-title').textContent();
    const msgText = await page.locator('#confirm-modal-message').textContent();
    assert.equal(titleText, 'TEST CONFIRM');
    assert.equal(msgText, 'Are you sure?');
    const okText = await page.locator('#confirm-modal-ok').textContent();
    assert.equal(okText, 'Yes');
    // Verify the danger class flagged.
    const isDanger = await page.locator('#confirm-modal').evaluate((el) => el.classList.contains('danger'));
    assert.ok(isDanger, 'danger flag must add the .danger class');
    await page.locator('#confirm-modal-ok').click();
    const result = await promise;
    assert.equal(result, true);
    assert.equal(nativeDialogs.length, 0);
    await page.screenshot({ path: `${SS}/modals--confirm.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('MDL-05: showConfirmModal returns false on cancel', async () => {
    const promise = page.evaluate(() => window.showConfirmModal({
      title: 'CANCEL TEST', message: 'Are you sure?',
    }));
    await page.waitForSelector('#confirm-modal.visible', { timeout: 2000 });
    // Cancel button is the secondary one in the footer.
    await page.locator('#confirm-modal .modal-btn-secondary').click();
    const result = await promise;
    assert.equal(result, false);
    assert.equal(nativeDialogs.length, 0);
  });
});
