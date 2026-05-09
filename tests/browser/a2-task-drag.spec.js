'use strict';

// A2 #327: Drag a task from project A bucket to project B bucket between
// rank 2 and rank 3; verify task lands at rank 3 in B (not appended to end).
// Pre-fix: server appended to end. Post-fix (atomic moveTask): rank 3 in B.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  process.exit(0);
}

const { resetBaseline, BASE_URL, dockerExec } = require('../helpers/reset-state');
const { startCoverage, stopCoverage, writeCoverageReport } = require('../helpers/browser-coverage');
const { queryJson } = require('../helpers/db-query');
const SS = require('path').join(__dirname, 'screenshots');

async function ensureProject(name, path) {
  dockerExec(`mkdir -p ${path}`);
  await fetch(`${BASE_URL}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, name }),
  }).catch(() => null);
  const rows = queryJson(`SELECT id, name FROM projects WHERE name = '${name}'`);
  if (!rows.length) throw new Error(`project ${name} not found in DB`);
  return rows[0];
}

async function addTask(projectId, title) {
  const r = await fetch(`${BASE_URL}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, title, status: 'todo' }),
  });
  return r.json();
}

describe('A2 task drag (browser)', () => {
  let browser, page;
  const errors = [];

  before(async () => {
    require('fs').mkdirSync(SS, { recursive: true });
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await writeCoverageReport('a2-task-drag');
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

  it('A2-UI-01: drag from project A to project B at rank 3 lands between b2 and b3 (not appended)', async () => {
    // Seed projects + tasks
    const projA = await ensureProject('a2_drag_a', '/data/workspace/a2_drag_a');
    const projB = await ensureProject('a2_drag_b', '/data/workspace/a2_drag_b');
    const b1 = await addTask(projB.id, 'A2-DRAG-b1');
    const b2 = await addTask(projB.id, 'A2-DRAG-b2');
    const b3 = await addTask(projB.id, 'A2-DRAG-b3');
    const b4 = await addTask(projB.id, 'A2-DRAG-b4');
    const moving = await addTask(projA.id, 'A2-DRAG-moving');

    // Open tasks panel
    await page.click('#panel-toggle');
    await page.click('[data-panel="tasks"]');
    await page.waitForSelector('.task-row', { timeout: 5000 });

    // Make sure both project nodes are expanded so all tasks are in the DOM
    await page.evaluate(() => {
      // Click any collapsed project headers to expand them
      document.querySelectorAll('.project-header.collapsed').forEach((el) => el.click());
    });
    await page.waitForFunction(
      ([movId, b3Id]) => {
        const a = document.querySelector(`.task-row[data-task-id="${movId}"]`);
        const b = document.querySelector(`.task-row[data-task-id="${b3Id}"]`);
        return a && b;
      },
      [moving.id, b3.id],
      { timeout: 5000 },
    );

    // Dispatch synthetic drag-and-drop. The UI's drop handler treats the
    // top 25% of a task row as "above" (insert at target.rank). Drop on b3
    // top-quarter → moving lands at rank 3, before b3.
    await page.evaluate(({ movId, b3Id }) => {
      const src = document.querySelector(`.task-row[data-task-id="${movId}"]`);
      const dst = document.querySelector(`.task-row[data-task-id="${b3Id}"]`);
      const dt = new DataTransfer();
      const rect = dst.getBoundingClientRect();
      const aboveY = rect.top + rect.height * 0.1;

      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      dt.setData('application/x-task-id', String(movId));

      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: aboveY }));
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: aboveY }));
    }, { movId: moving.id, b3Id: b3.id });

    // Wait for the tree to re-render and the moving task to appear under project B
    await page.waitForFunction(
      ([movId, projBId]) => {
        const row = document.querySelector(`.task-row[data-task-id="${movId}"]`);
        return row && Number(row.dataset.projectId) === projBId;
      },
      [moving.id, projB.id],
      { timeout: 5000 },
    );

    // Read the rendered order in project B's section
    const titles = await page.evaluate((projBId) => {
      const sections = document.querySelectorAll('.project-tasks');
      for (const sec of sections) {
        const rows = Array.from(sec.querySelectorAll('.task-row'));
        const projIds = new Set(rows.map((r) => Number(r.dataset.projectId)));
        if (projIds.has(projBId)) {
          return rows
            .filter((r) => Number(r.dataset.projectId) === projBId)
            .map((r) => r.querySelector('.title').textContent);
        }
      }
      return [];
    }, projB.id);

    assert.deepEqual(
      titles,
      ['A2-DRAG-b1', 'A2-DRAG-b2', 'A2-DRAG-moving', 'A2-DRAG-b3', 'A2-DRAG-b4'],
      `expected moved task at rank 3, got ${JSON.stringify(titles)}`,
    );

    // DB-level check (canonical) — bucket B order must be [b1, b2, moving, b3, b4]
    const bucket = queryJson(
      `SELECT title, rank FROM tasks WHERE project_id = ${projB.id} AND parent_task_id IS NULL ORDER BY rank ASC`,
    );
    assert.deepEqual(
      bucket.map((t) => t.title),
      ['A2-DRAG-b1', 'A2-DRAG-b2', 'A2-DRAG-moving', 'A2-DRAG-b3', 'A2-DRAG-b4'],
    );
    assert.deepEqual(bucket.map((t) => t.rank), [1, 2, 3, 4, 5]);

    await page.screenshot({ path: `${SS}/a2-drag--after-move.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });
});
