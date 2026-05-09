'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  process.exit(0);
}

const { resetBaseline, BASE_URL } = require('../helpers/reset-state');
const { startCoverage, stopCoverage, writeCoverageReport } = require('../helpers/browser-coverage');
const SS = require('path').join(__dirname, 'screenshots');

// R3-N2 (Codex MAJOR): per #388 v2 contract task_add no longer accepts
// folder_path. /api/tasks POST now accepts project_name as a fallback
// (matches MCP task_add). All tasks created here are scoped to wb-seed
// (the test fixture project planted by resetBaseline).
//
// The folderPath argument is kept for call-site compatibility — it's
// IGNORED now (no folder concept in the v2 task tree). Tests that
// previously asserted folder-tree shape (UI-TSK-10/11/13/14) will see
// all tasks scoped to wb-seed; folder/.task-folder UI elements may not
// render the same way they did pre-v2 — those are known to fall under
// the O3 #377 task-v2 baseline.
async function createTask(_folderPath, title) {
  return fetch(`${BASE_URL}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_name: 'wb-seed', title }),
  }).then(r => r.json());
}

async function completeTask(id) {
  return fetch(`${BASE_URL}/api/tasks/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done' }),
  });
}

describe('task tree (browser)', () => {
  let browser, page;
  const errors = [];

  before(async () => {
    require('fs').mkdirSync(SS, { recursive: true });
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await writeCoverageReport('task-tree');
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
  afterEach(async () => {
    await stopCoverage(page);
  });

  it('UI-TSK-01: tasks tab is visible and contains task tree', async () => {
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');
    assert.ok(await page.locator('#panel-tasks').isVisible(), 'Tasks panel must be visible');
    assert.ok(await page.locator('#task-tree').isVisible(), 'Task tree must be visible');
    assert.ok(await page.locator('#add-task-input').isVisible(), 'Add task input must be visible');
    await page.screenshot({ path: `${SS}/task-tree--empty.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-02: filter buttons toggle active state', async () => {
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');

    // Default is Active (todo)
    assert.ok(
      await page.locator('[data-task-filter="todo"]').evaluate(el => el.classList.contains('active')),
      'Todo filter must be active by default',
    );

    // Click All
    await page.click('[data-task-filter="all"]');
    assert.ok(
      await page.locator('[data-task-filter="all"]').evaluate(el => el.classList.contains('active')),
      'All filter must be active after click',
    );
    assert.ok(
      !(await page.locator('[data-task-filter="todo"]').evaluate(el => el.classList.contains('active'))),
      'Todo filter must not be active',
    );

    // Click Done
    await page.click('[data-task-filter="done"]');
    assert.ok(
      await page.locator('[data-task-filter="done"]').evaluate(el => el.classList.contains('active')),
      'Done filter must be active',
    );

    // Click Archive
    await page.click('[data-task-filter="archived"]');
    assert.ok(
      await page.locator('[data-task-filter="archived"]').evaluate(el => el.classList.contains('active')),
      'Archive filter must be active',
    );

    await page.screenshot({ path: `${SS}/task-tree--filters.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-03: add task via input field', async () => {
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');

    const input = page.locator('#add-task-input');
    await input.fill('My new task');
    await input.press('Enter');

    // Wait for task to appear
    await page.waitForSelector('.task-node', { timeout: 3000 });
    const taskLabel = await page.locator('.task-node .task-label').first().textContent();
    assert.equal(taskLabel, 'My new task');

    await page.screenshot({ path: `${SS}/task-tree--add-task.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-04: checkbox marks task as done', async () => {
    await createTask('/', 'Check me');
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');
    await page.waitForSelector('.task-node', { timeout: 3000 });

    // Click checkbox
    await page.locator('.task-node input[type="checkbox"]').first().click();

    // Task should disappear from Active filter (default)
    await page.waitForFunction(() => document.querySelectorAll('.task-node').length === 0, { timeout: 3000 });

    // Switch to All filter — task should be there with .done class
    await page.click('[data-task-filter="all"]');
    await page.waitForSelector('.task-node.done', { timeout: 3000 });

    await page.screenshot({ path: `${SS}/task-tree--checkbox-done.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-05: uncheck done task reopens it', async () => {
    const t = await createTask('/', 'Uncheck me');
    await completeTask(t.id);
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');

    // Switch to Done filter
    await page.click('[data-task-filter="done"]');
    await page.waitForSelector('.task-node.done', { timeout: 3000 });

    // Uncheck
    await page.locator('.task-node input[type="checkbox"]').first().click();

    // Should disappear from Done filter
    await page.waitForFunction(() => document.querySelectorAll('.task-node').length === 0, { timeout: 3000 });

    // Switch to Active — should be there
    await page.click('[data-task-filter="todo"]');
    await page.waitForSelector('.task-node', { timeout: 3000 });
    const label = await page.locator('.task-node .task-label').first().textContent();
    assert.equal(label, 'Uncheck me');

    await page.screenshot({ path: `${SS}/task-tree--uncheck.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-06: delete task via delete button', async () => {
    await createTask('/', 'Delete me');
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');
    await page.waitForSelector('.task-node', { timeout: 3000 });

    // Hover to reveal delete button, then click
    await page.locator('.task-node').first().hover();
    await page.locator('.task-node .task-delete').first().click();

    // Task should be gone
    await page.waitForFunction(() => document.querySelectorAll('.task-node').length === 0, { timeout: 3000 });

    await page.screenshot({ path: `${SS}/task-tree--delete.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-07: double-click opens task detail modal', async () => {
    await createTask('/', 'Detail test');
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');
    await page.waitForSelector('.task-node', { timeout: 3000 });

    await page.locator('.task-node').first().dblclick();
    await page.waitForSelector('#task-detail-modal.visible', { timeout: 3000 });

    const title = await page.locator('#task-detail-title').inputValue();
    assert.equal(title, 'Detail test');

    // History should show created event
    const historyText = await page.locator('#task-detail-history').textContent();
    assert.ok(historyText.includes('created'), 'History must show created event');

    await page.screenshot({ path: `${SS}/task-tree--detail-modal.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-08: edit task title in modal and save', async () => {
    await createTask('/', 'Old name');
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');
    await page.waitForSelector('.task-node', { timeout: 3000 });

    await page.locator('.task-node').first().dblclick();
    await page.waitForSelector('#task-detail-modal.visible', { timeout: 3000 });

    await page.locator('#task-detail-title').fill('New name');
    await page.locator('#task-detail-modal button:has-text("Save")').click();

    // Modal should close
    await page.waitForFunction(
      () => !document.querySelector('#task-detail-modal')?.classList.contains('visible'),
      { timeout: 3000 },
    );

    // Tree should show new name
    const label = await page.locator('.task-node .task-label').first().textContent();
    assert.equal(label, 'New name');

    await page.screenshot({ path: `${SS}/task-tree--edit-save.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-09: close modal via Cancel and overlay click', async () => {
    await createTask('/', 'Cancel test');
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');
    await page.waitForSelector('.task-node', { timeout: 3000 });

    // Open and cancel
    await page.locator('.task-node').first().dblclick();
    await page.waitForSelector('#task-detail-modal.visible', { timeout: 3000 });
    await page.locator('#task-detail-modal button:has-text("Cancel")').click();
    await page.waitForFunction(
      () => !document.querySelector('#task-detail-modal')?.classList.contains('visible'),
      { timeout: 3000 },
    );

    // Open and click overlay
    await page.locator('.task-node').first().dblclick();
    await page.waitForSelector('#task-detail-modal.visible', { timeout: 3000 });
    await page.locator('#task-detail-modal').click({ position: { x: 10, y: 10 } });
    await page.waitForFunction(
      () => !document.querySelector('#task-detail-modal')?.classList.contains('visible'),
      { timeout: 3000 },
    );

    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-10: tasks in different folders render as separate folder nodes', async () => {
    await createTask('/alpha', 'Task in alpha');
    await createTask('/beta', 'Task in beta');
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');
    await page.waitForSelector('.task-folder', { timeout: 3000 });

    const folderCount = await page.locator('.task-folder').count();
    assert.equal(folderCount, 2, 'Must have 2 folder nodes');

    await page.screenshot({ path: `${SS}/task-tree--folders.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-11: folder expand/collapse toggles children visibility', async () => {
    await createTask('/folder', 'Nested task');
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');
    await page.waitForSelector('.task-folder', { timeout: 3000 });

    // Folder should start expanded (not collapsed)
    const folder = page.locator('.task-folder').first();
    const isCollapsed = await folder.evaluate(el => el.classList.contains('collapsed'));

    // Click to toggle
    await page.locator('.task-folder-label').first().click();
    const afterClick = await folder.evaluate(el => el.classList.contains('collapsed'));
    assert.notEqual(isCollapsed, afterClick, 'Collapsed state must toggle on click');

    // Click again to toggle back
    await page.locator('.task-folder-label').first().click();
    const afterSecondClick = await folder.evaluate(el => el.classList.contains('collapsed'));
    assert.equal(isCollapsed, afterSecondClick, 'Must toggle back on second click');

    await page.screenshot({ path: `${SS}/task-tree--collapse.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-12: task index numbers shown correctly', async () => {
    await createTask('/proj', 'First');
    await createTask('/proj', 'Second');
    await createTask('/proj', 'Third');
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');
    await page.waitForSelector('.task-node', { timeout: 3000 });

    const indices = await page.locator('.task-index').allTextContents();
    assert.deepEqual(indices, ['1', '2', '3'], 'Indices must be 1, 2, 3');

    await page.screenshot({ path: `${SS}/task-tree--indices.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-13: folder shows task count badge', async () => {
    await createTask('/counted', 'A');
    await createTask('/counted', 'B');
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');
    await page.waitForSelector('.folder-count', { timeout: 3000 });

    const count = await page.locator('.folder-count').first().textContent();
    assert.equal(count, '2', 'Folder count must show 2');

    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-14: clicking folder selects it for add-task input', async () => {
    await createTask('/target', 'Existing');
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');
    await page.waitForSelector('.task-folder', { timeout: 3000 });

    // Click folder to select
    await page.locator('.task-folder-label').first().click();
    assert.ok(
      await page.locator('.task-folder.selected').count() > 0,
      'Clicked folder must have .selected class',
    );

    // Add task — should go to selected folder
    const input = page.locator('#add-task-input');
    await input.fill('New in target');
    await input.press('Enter');
    await page.waitForFunction(
      () => document.querySelectorAll('.task-node').length === 2,
      { timeout: 3000 },
    );

    await page.screenshot({ path: `${SS}/task-tree--selected-folder.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-15: auto-nav checkbox exists and toggles', async () => {
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');

    const checkbox = page.locator('#task-auto-nav');
    assert.ok(await checkbox.isVisible(), 'Auto-nav checkbox must be visible');

    await checkbox.click();
    assert.ok(await checkbox.isChecked(), 'Must be checked after click');

    await checkbox.click();
    assert.ok(!(await checkbox.isChecked()), 'Must be unchecked after second click');

    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-16: filter hides/shows tasks by status', async () => {
    const t = await createTask('/', 'Filter test');
    await completeTask(t.id);
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');

    // Active filter — completed task should not show
    await page.waitForTimeout(500);
    const activeCount = await page.locator('.task-node').count();
    assert.equal(activeCount, 0, 'Done task must not show in Active filter');

    // Done filter — should show
    await page.click('[data-task-filter="done"]');
    await page.waitForSelector('.task-node.done', { timeout: 3000 });
    assert.equal(await page.locator('.task-node').count(), 1, 'Done task must show in Done filter');

    await page.screenshot({ path: `${SS}/task-tree--filter-done.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-17: empty state renders without errors', async () => {
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');

    // No tasks — tree should render empty
    await page.waitForTimeout(500);
    const nodeCount = await page.locator('.task-node').count();
    assert.equal(nodeCount, 0, 'No task nodes in empty state');
    const folderCount = await page.locator('.task-folder').count();
    assert.equal(folderCount, 0, 'No folder nodes in empty state');

    await page.screenshot({ path: `${SS}/task-tree--empty-state.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-TSK-18: task nodes are draggable', async () => {
    await createTask('/', 'Draggable task');
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');
    await page.waitForSelector('.task-node', { timeout: 3000 });

    const draggable = await page.locator('.task-node').first().getAttribute('draggable');
    assert.equal(draggable, 'true', 'Task node must have draggable=true');

    assert.equal(errors.length, 0, errors.join(', '));
  });
});
