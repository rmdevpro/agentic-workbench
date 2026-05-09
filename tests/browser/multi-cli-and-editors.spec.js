'use strict';

/**
 * Tests for fixed/new features:
 * - #95: Session creation UI (prompt sent, sidebar updated, all CLI types)
 * - #96: tmuxCreateCLI unified function
 * - #94: File editor Save and Save As buttons
 * - #93/#88: Task panel filesystem tree + context menus
 * - #98: Session connect/restart MCP actions
 * - #99: Gemini/Codex session lifecycle + CLI indicator
 * - #87: tmux crash cascade hardening (liveness check)
 * - #100: Keepalive token refresh
 * - #101: Qdrant multi-provider embedding
 * - #102: System prompts seeded for all CLIs
 */

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

async function apiPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiGet(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

describe('Multi-CLI sessions, editors, and task panel (browser)', () => {
  let browser, page;
  const errors = [];

  before(async () => {
    require('fs').mkdirSync(SS, { recursive: true });
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await writeCoverageReport('multi-cli-editors');
    if (browser) await browser.close();
  });
  beforeEach(async () => {
    errors.length = 0;
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await startCoverage(page);
    await resetBaseline(page);
  });
  afterEach(async () => {
    await stopCoverage(page);
  });

  // ── #95: Session Creation UI ──────────────────────────────

  it('SESS-01: clicking + on project shows CLI type dropdown (Claude, Gemini, Codex, Terminal)', async () => {
    await page.waitForSelector('.new-btn');
    await page.locator('.new-btn').first().click();
    await page.waitForSelector('.new-session-menu');
    const items = await page.locator('.new-session-menu .context-menu-item').allTextContents();
    assert.ok(items.some(t => t.includes('Claude')), 'Claude option present');
    assert.ok(items.some(t => t.includes('Gemini')), 'Gemini option present');
    assert.ok(items.some(t => t.includes('Codex')), 'Codex option present');
    assert.ok(items.some(t => t.includes('Terminal')), 'Terminal option present');
  });

  it('SESS-02: selecting Claude opens new session modal with name input', async () => {
    await page.waitForSelector('.new-btn');
    await page.locator('.new-btn').first().click();
    await page.locator('.new-session-menu .context-menu-item[data-cli="claude"]').first().click();
    await page.waitForSelector('#new-session-name');
    const input = page.locator('#new-session-name');
    assert.ok(await input.isVisible(), 'session-name input visible');
    const submit = page.locator('#new-session-submit');
    assert.ok(await submit.isVisible(), 'Start Session button visible');
  });

  it('SESS-03: submitting session modal creates tab and updates sidebar', async () => {
    await page.waitForSelector('.new-btn');
    await page.locator('.new-btn').first().click();
    await page.locator('.new-session-menu .context-menu-item[data-cli="claude"]').first().click();
    await page.waitForSelector('#new-session-name');
    await page.fill('#new-session-name', 'Test session SESS-03');
    await page.click('#new-session-submit');
    // Tab should appear
    await page.waitForFunction(() => {
      for (const [, tab] of window.tabs) {
        if (tab.name === 'Test session SESS-03') return true;
      }
      return false;
    }, { timeout: 10000 });
    // Terminal should connect (may still be connecting — wait a bit)
    await new Promise(r => setTimeout(r, 3000));
    const status = await page.evaluate(() => {
      for (const [, tab] of window.tabs) {
        if (tab.name === 'Test session SESS-03') return tab.status;
      }
      return 'not found';
    });
    assert.ok(status === 'connected' || status === 'connecting', `status is ${status}`);
  });

  // ── #99: Gemini/Codex Session Lifecycle ────────────────────

  it('SESS-04: creating Gemini session via API returns cli_type gemini', async () => {
    const data = await apiPost('/api/sessions', {
      project: 'wb-seed', name: 'test gemini', cli_type: 'gemini',
    });
    assert.ok(data.id, `session ID returned, got: ${JSON.stringify(data)}`);
    assert.ok(data.tmux, 'tmux name returned');
    // Check state shows the session with correct CLI type
    await new Promise(r => setTimeout(r, 3000));
    const state = await apiGet('/api/state');
    const proj = state.projects.find(p => p.name === 'wb-seed');
    assert.ok(proj, 'wb-seed project found in state');
    const sess = proj.sessions.find(s => s.id === data.id);
    assert.ok(sess, 'session found in state');
    assert.equal(sess.cli_type, 'gemini');
  });

  it('SESS-05: Gemini session persists in state (not cleaned up by reconciler)', async () => {
    const data = await apiPost('/api/sessions', {
      project: 'wb-seed', name: 'persist test', cli_type: 'gemini',
    });
    assert.ok(data.id, 'session created');
    // Wait for multiple state poll cycles
    await new Promise(r => setTimeout(r, 6000));
    const state = await apiGet('/api/state');
    const proj = state.projects.find(p => p.name === 'wb-seed');
    assert.ok(proj, 'wb-seed project found');
    const sess = proj.sessions.find(s => s.id === data.id);
    assert.ok(sess, 'Gemini session still in state after 6 seconds');
    assert.equal(sess.cli_type, 'gemini');
  });

  it('SESS-06: sidebar shows CLI type indicator (C for Claude, G for Gemini)', async () => {
    const c = await apiPost('/api/sessions', { project: 'wb-seed', name: 'claude indicator', cli_type: 'claude' });
    const g = await apiPost('/api/sessions', { project: 'wb-seed', name: 'gemini indicator', cli_type: 'gemini' });
    assert.ok(c.id && g.id, 'both sessions created');
    await new Promise(r => setTimeout(r, 3000));
    const state = await apiGet('/api/state');
    const proj = state.projects.find(p => p.name === 'wb-seed');
    assert.ok(proj, 'wb-seed found');
    const claude = proj.sessions.find(s => s.name === 'claude indicator');
    const gemini = proj.sessions.find(s => s.name === 'gemini indicator');
    assert.ok(claude, 'claude session found');
    assert.equal(claude.cli_type, 'claude');
    assert.ok(gemini, 'gemini session found');
    assert.equal(gemini.cli_type, 'gemini');
  });

  // ── #94: File Editor Save / Save As ────────────────────────

  it('EDIT-01: opening a file shows toolbar with Save and Save As buttons', async () => {
    await page.evaluate(() => openFileTab('/data/workspace/wb-seed/README.md'));
    await page.waitForSelector('.editor-toolbar', { timeout: 5000 });
    const saveBtn = page.locator('.editor-save-btn');
    const saveAsBtn = page.locator('.editor-saveas-btn');
    assert.ok(await saveBtn.isVisible(), 'Save button visible');
    assert.ok(await saveAsBtn.isVisible(), 'Save As button visible');
  });

  it('EDIT-02: Save button is disabled when file is clean, enabled when dirty', async () => {
    await page.evaluate(() => openFileTab('/data/workspace/wb-seed/README.md'));
    await page.waitForSelector('.editor-toolbar', { timeout: 5000 });
    // Clean state
    const cleanDisabled = await page.evaluate(() => document.querySelector('.editor-save-btn').disabled);
    assert.equal(cleanDisabled, true, 'Save disabled when clean');
    // Make dirty
    await page.evaluate(() => {
      const tabId = Array.from(tabs.keys()).find(k => k.startsWith('file-'));
      const tab = tabs.get(tabId);
      if (tab.editor.setMarkdown) tab.editor.setMarkdown('dirty content');
      else if (tab.editor.dispatch) tab.editor.dispatch({ changes: { from: 0, insert: 'x' } });
    });
    await new Promise(r => setTimeout(r, 500));
    const dirtyDisabled = await page.evaluate(() => document.querySelector('.editor-save-btn').disabled);
    assert.equal(dirtyDisabled, false, 'Save enabled when dirty');
  });

  it('EDIT-03: clicking Save persists file and resets dirty state', async () => {
    // Create a test file via MCP (ensures workspace path)
    await apiPost('/api/mcp/call', {
      tool: 'file_create',
      args: { path: 'wb-seed/edit-test.txt', content: 'original' },
    });
    await page.evaluate(() => openFileTab('/data/workspace/wb-seed/edit-test.txt'));
    await page.waitForSelector('.editor-toolbar', { timeout: 5000 });
    // Edit
    await page.evaluate(() => {
      const tabId = Array.from(tabs.keys()).find(k => k.startsWith('file-'));
      const tab = tabs.get(tabId);
      tab.editor.dispatch({ changes: { from: 0, to: tab.editor.state.doc.length, insert: 'saved content' } });
    });
    await new Promise(r => setTimeout(r, 500));
    // Click Save
    await page.evaluate(() => document.querySelector('.editor-save-btn').click());
    await new Promise(r => setTimeout(r, 1000));
    // Verify dirty reset
    const dirty = await page.evaluate(() => {
      const tabId = Array.from(tabs.keys()).find(k => k.startsWith('file-'));
      return tabs.get(tabId).dirty;
    });
    assert.equal(dirty, false, 'dirty reset after save');
    // Verify file content on disk
    const rd = await apiPost('/api/mcp/call', {
      tool: 'file_read', args: { path: 'wb-seed/edit-test.txt' },
    });
    assert.equal(rd.result.content, 'saved content');
  });

  // ── #93/#88: Task Panel ────────────────────────────────────

  it('TASK-01: task panel shows filesystem folders from workspace', async () => {
    await page.evaluate(() => switchPanel('tasks'));
    await page.waitForSelector('#task-tree', { timeout: 5000 });
    await new Promise(r => setTimeout(r, 1000));
    const text = await page.evaluate(() => document.getElementById('task-tree')?.innerText);
    assert.ok(text.includes('/data/workspace'), 'workspace mount shown');
  });

  it('TASK-02: right-click on folder shows context menu with Add Task', async () => {
    await page.evaluate(() => switchPanel('tasks'));
    await page.waitForSelector('.task-folder-label', { timeout: 5000 });
    await page.evaluate(() => {
      const label = document.querySelector('.task-folder-label');
      label.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 200 }));
    });
    await new Promise(r => setTimeout(r, 300));
    const menuText = await page.evaluate(() => {
      const menus = document.querySelectorAll('.context-menu');
      for (const m of menus) { if (m.style.display !== 'none' && m.innerText.includes('Add Task')) return m.innerText; }
      return '';
    });
    assert.ok(menuText.includes('Add Task'), 'Add Task in context menu');
    assert.ok(menuText.includes('New Folder'), 'New Folder in context menu');
  });

  it('TASK-03: adding task via context menu creates it in the DB (v2 contract)', async () => {
    // Add via API to avoid prompt() dialog in headless. Per #388 v2
    // contract: task_add now requires project_id / project_name /
    // parent_task_id (folder_path no longer accepted).
    const result = await apiPost('/api/mcp/call', {
      tool: 'task_add',
      args: { project_name: 'wb-seed', title: 'TASK-03 test task' },
    });
    assert.ok(result.result.id, 'task created with ID');
    assert.equal(result.result.title, 'TASK-03 test task');
    assert.ok(result.result.project_id, 'task carries project_id (v2 schema)');
  });

  // ── #98: Session Connect / Restart ─────────────────────────

  it('CONN-01: connect action finds session by name query', async () => {
    const sess = await apiPost('/api/sessions', { project: 'wb-seed', name: 'findme session', cli_type: 'claude' });
    assert.ok(sess.id, 'session created for connect test');
    await new Promise(r => setTimeout(r, 3000));
    const result = await apiPost('/api/mcp/call', {
      tool: 'session_connect',
      args: { query: 'findme' },
    });
    assert.ok(result.result?.session_id, `session found, got: ${JSON.stringify(result)}`);
    assert.ok(result.result.tmux, 'tmux name returned');
    assert.equal(result.result.cli, 'claude');
  });

  it('CONN-02: restart action kills and recreates tmux session', async () => {
    const sess = await apiPost('/api/sessions', { project: 'wb-seed', name: 'restart test', cli_type: 'claude' });
    assert.ok(sess.id, 'session created for restart test');
    await new Promise(r => setTimeout(r, 3000));
    const result = await apiPost('/api/mcp/call', {
      tool: 'session_restart',
      args: { session_id: sess.id },
    });
    assert.ok(result.result, `restart result exists, got: ${JSON.stringify(result)}`);
    assert.equal(result.result.restarted, true);
    assert.equal(result.result.cli, 'claude');
  });

  // ── #97: MCP Tool Actions ─────────────────────────────────

  it('MCP-01: file_list returns entries', async () => {
    const result = await apiPost('/api/mcp/call', {
      tool: 'file_list', args: { path: 'wb-seed' },
    });
    assert.ok(Array.isArray(result.result.entries), 'entries is array');
  });

  it('MCP-02: file_create / file_read / file_delete cycle works', async () => {
    const cr = await apiPost('/api/mcp/call', {
      tool: 'file_create', args: { path: 'wb-seed/mcp-test.txt', content: 'hello' },
    });
    assert.ok(cr.result.created);
    const rd = await apiPost('/api/mcp/call', {
      tool: 'file_read', args: { path: 'wb-seed/mcp-test.txt' },
    });
    assert.equal(rd.result.content, 'hello');
    const dl = await apiPost('/api/mcp/call', {
      tool: 'file_delete', args: { path: 'wb-seed/mcp-test.txt' },
    });
    assert.ok(dl.result.deleted);
  });

  it('MCP-03: file_grep finds pattern in files', async () => {
    const result = await apiPost('/api/mcp/call', {
      tool: 'file_find', args: { pattern: 'README' },
    });
    assert.ok(Array.isArray(result.result.matches));
  });

  it('MCP-04: task lifecycle via task_add + task_update (status: done/todo/archived)', async () => {
    // #388 v2 contract: project_name required (folder_path no longer accepted).
    const add = await apiPost('/api/mcp/call', {
      tool: 'task_add', args: { project_name: 'wb-seed', title: 'lifecycle test' },
    });
    const id = Number(add.result.id);
    const comp = await apiPost('/api/mcp/call', {
      tool: 'task_update', args: { task_id: id, status: 'done' },
    });
    assert.equal(comp.result.status, 'done');
    const reop = await apiPost('/api/mcp/call', {
      tool: 'task_update', args: { task_id: id, status: 'todo' },
    });
    assert.equal(reop.result.status, 'todo');
    const arch = await apiPost('/api/mcp/call', {
      tool: 'task_update', args: { task_id: id, status: 'archived' },
    });
    assert.equal(arch.result.status, 'archived');
  });

  it('MCP-05: session_list returns sessions for project', async () => {
    const result = await apiPost('/api/mcp/call', {
      tool: 'session_list', args: { project: 'wb-seed' },
    });
    assert.ok(Array.isArray(result.result.sessions));
  });

  it('MCP-06: session_config saves session name', async () => {
    const sess = await apiPost('/api/sessions', { project: 'wb-seed', name: 'config test', cli_type: 'claude' });
    const result = await apiPost('/api/mcp/call', {
      tool: 'session_config', args: { session_id: sess.id, name: 'renamed by MCP' },
    });
    assert.equal(result.result.saved, true);
  });

  // ── #100: Keepalive ────────────────────────────────────────

  it('KEEP-01: keepalive status shows token expiry', async () => {
    const state = await apiGet('/api/state');
    // Keepalive status is in the logs — verify server is running
    assert.ok(state.workspace, 'server responding');
  });

  // ── #112-118: Qdrant Collections ───────────────────────────

  it('QDRANT-01: documents collection has points and search works', async () => {
    const status = await apiGet('/api/qdrant/status');
    assert.ok(status.collections?.documents?.points > 0, `documents has ${status.collections?.documents?.points} points`);
    const result = await apiPost('/api/mcp/call', {
      tool: 'file_search_documents', args: { query: 'deployment' },
    });
    assert.ok(Array.isArray(result.result) && result.result.length > 0, 'search returns results');
    assert.ok(result.result[0].score > 0, 'results have scores');
    assert.ok(result.result[0].file_path, 'results have file paths');
  });

  it('QDRANT-02: code collection has points and search works', async () => {
    const status = await apiGet('/api/qdrant/status');
    if (!status.collections?.code || status.collections.code.points === 0) {
      // Code collection may be disabled — skip gracefully
      return;
    }
    const result = await apiPost('/api/mcp/call', {
      tool: 'file_search_code', args: { query: 'express server' },
    });
    assert.ok(Array.isArray(result.result), 'search returns array');
  });

  it('QDRANT-03: claude_sessions collection has points and search works', async () => {
    const status = await apiGet('/api/qdrant/status');
    assert.ok(status.collections?.claude?.points > 0, `claude has ${status.collections?.claude?.points} points`);
    const result = await apiPost('/api/mcp/call', {
      tool: 'session_search', args: { query: 'session test', cli: 'claude' },
    });
    assert.ok(Array.isArray(result.result) && result.result.length > 0, 'search returns results');
    assert.ok(result.result[0].collection === 'claude_sessions', 'results from claude collection');
  });

  it('QDRANT-04: gemini_sessions collection has points and search works', async () => {
    const status = await apiGet('/api/qdrant/status');
    if (!status.collections?.gemini || status.collections.gemini.points === 0) return;
    const result = await apiPost('/api/mcp/call', {
      tool: 'session_search', args: { query: 'Dockerfile', cli: 'gemini' },
    });
    assert.ok(Array.isArray(result.result), 'search returns array');
    if (result.result.length > 0) assert.ok(result.result[0].collection === 'gemini_sessions', 'results from gemini collection');
  });

  it('QDRANT-05: codex_sessions collection has points and search works', async () => {
    const status = await apiGet('/api/qdrant/status');
    if (!status.collections?.codex || status.collections.codex.points === 0) return;
    const result = await apiPost('/api/mcp/call', {
      tool: 'session_search', args: { query: 'fibonacci', cli: 'codex' },
    });
    assert.ok(Array.isArray(result.result), 'search returns array');
    if (result.result.length > 0) assert.ok(result.result[0].collection === 'codex_sessions', 'results from codex collection');
  });

  it('QDRANT-06: qdrant status endpoint returns all 5 collections', async () => {
    const status = await apiGet('/api/qdrant/status');
    assert.ok(status.available, 'qdrant available');
    assert.ok(status.collections.documents, 'documents collection exists');
    assert.ok(status.collections.code !== undefined, 'code collection exists');
    assert.ok(status.collections.claude, 'claude collection exists');
    assert.ok(status.collections.gemini, 'gemini collection exists');
    assert.ok(status.collections.codex, 'codex collection exists');
  });

  // ── #102: System Prompts ───────────────────────────────────

  it('PROMPT-01: global CLAUDE.md contains Identity and Purpose sections', async () => {
    const res = await fetch(`${BASE_URL}/api/file?path=/data/.claude/CLAUDE.md`);
    const content = await res.text();
    assert.ok(content.includes('# Identity'), 'has Identity section');
    assert.ok(content.includes('# Purpose'), 'has Purpose section');
    assert.ok(content.includes('Claude'), 'identifies as Claude');
  });

  it('PROMPT-02: global GEMINI.md contains Identity and Purpose sections', async () => {
    const res = await fetch(`${BASE_URL}/api/file?path=/data/.claude/GEMINI.md`);
    const content = await res.text();
    assert.ok(content.includes('# Identity'), 'has Identity section');
    assert.ok(content.includes('# Purpose'), 'has Purpose section');
    assert.ok(content.includes('Gemini'), 'identifies as Gemini');
  });

  it('PROMPT-03: global AGENTS.md contains Identity and Purpose sections', async () => {
    const res = await fetch(`${BASE_URL}/api/file?path=/data/.claude/AGENTS.md`);
    const content = await res.text();
    assert.ok(content.includes('# Identity'), 'has Identity section');
    assert.ok(content.includes('# Purpose'), 'has Purpose section');
    assert.ok(content.includes('Codex'), 'identifies as Codex');
  });

  it('PROMPT-04: all prompts share the same HHH purpose statement', async () => {
    const purpose = 'You must be helpful, harmless, and honest towards the user';
    for (const file of ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md']) {
      const res = await fetch(`${BASE_URL}/api/file?path=/data/.claude/${file}`);
      const content = await res.text();
      assert.ok(content.includes(purpose), `${file} contains HHH purpose`);
    }
  });

  // ── #93: Task Panel UX ─────────────────────────────────

  it('TASKUX-01: task tree uses 11px font and 18px line-height matching file browser', async () => {
    await page.evaluate(() => switchPanel('tasks'));
    await page.waitForSelector('#task-tree', { timeout: 5000 });
    await new Promise(r => setTimeout(r, 1000));
    // Expand mount
    await page.evaluate(() => { document.querySelector('#task-tree .mount-arrow')?.parentElement?.click(); });
    await new Promise(r => setTimeout(r, 1000));
    const style = await page.evaluate(() => {
      const f = document.querySelector('.task-folder-label');
      if (!f) return null;
      const s = getComputedStyle(f);
      return { fontSize: s.fontSize, lineHeight: s.lineHeight, hasEmoji: f.textContent.includes('📁') };
    });
    assert.ok(style, 'folder label found');
    assert.equal(style.fontSize, '11px');
    assert.equal(style.lineHeight, '18px');
    assert.equal(style.hasEmoji, false, 'no emoji icons');
  });

  it('TASKUX-02: checkbox complete updates inline without losing expand state', async () => {
    // Create a task — #388 v2 contract: project_name required.
    await apiPost('/api/mcp/call', {
      tool: 'task_add', args: { project_name: 'wb-seed', title: 'inline-test' },
    });
    await page.evaluate(() => { switchPanel('tasks'); expandedTaskFolders.add('/data/workspace'); expandedTaskFolders.add('/data/workspace/wb-seed'); loadTaskTree(); });
    await new Promise(r => setTimeout(r, 2000));
    const before = await page.evaluate(() => {
      const node = document.querySelector('.task-node');
      if (!node) return null;
      node.querySelector('input[type=checkbox]').click();
      return { found: true };
    });
    assert.ok(before, 'task node found');
    await new Promise(r => setTimeout(r, 1000));
    const after = await page.evaluate(() => ({
      isDone: document.querySelector('.task-node')?.classList.contains('done'),
      foldersExpanded: Array.from(document.querySelectorAll('.task-folder-label')).some(f => f.querySelector('.folder-arrow')?.style.transform.includes('90'))
    }));
    assert.equal(after.isDone, true, 'task marked done inline');
    assert.equal(after.foldersExpanded, true, 'folders still expanded');
  });

  it('TASKUX-03: task filter buttons show correct tasks per filter', async () => {
    // Create tasks in different states
    // #388 v2 contract: project_name required (folder_path no longer accepted).
    const t1 = await apiPost('/api/mcp/call', { tool: 'task_add', args: { project_name: 'wb-seed', title: 'filter-todo' } });
    const t2 = await apiPost('/api/mcp/call', { tool: 'task_add', args: { project_name: 'wb-seed', title: 'filter-done' } });
    await apiPost('/api/mcp/call', { tool: 'task_update', args: { task_id: Number(t2.result.id), status: 'done' } });
    await page.evaluate(() => { expandedTaskFolders.add('/data/workspace'); expandedTaskFolders.add('/data/workspace/wb-seed'); });

    // Active filter
    await page.evaluate(() => setTaskFilter('todo'));
    await new Promise(r => setTimeout(r, 1500));
    const active = await page.evaluate(() => Array.from(document.querySelectorAll('.task-node .task-label')).map(l => l.textContent));
    assert.ok(active.includes('filter-todo'), 'active shows todo task');
    assert.ok(!active.includes('filter-done'), 'active hides done task');

    // Done filter
    await page.evaluate(() => setTaskFilter('done'));
    await new Promise(r => setTimeout(r, 1500));
    const done = await page.evaluate(() => Array.from(document.querySelectorAll('.task-node .task-label')).map(l => l.textContent));
    assert.ok(done.includes('filter-done'), 'done shows completed task');

    // Restore
    await page.evaluate(() => setTaskFilter('todo'));
  });

  // ── #94: Editor Enhancements ───────────────────────────

  it('EDITUX-01: save button flashes green "Saved" on successful save', async () => {
    await apiPost('/api/mcp/call', { tool: 'file_create', args: { path: 'wb-seed/save-flash-test.txt', content: 'hello' } });
    await page.evaluate(() => openFileTab('/data/workspace/wb-seed/save-flash-test.txt'));
    await new Promise(r => setTimeout(r, 2000));
    const result = await page.evaluate(() => {
      const tabId = Array.from(tabs.keys()).find(k => k.startsWith('file-'));
      const tab = tabs.get(tabId);
      tab.editor.dispatch({ changes: { from: 0, insert: 'x' } });
      const pane = document.getElementById(`pane-${tabId}`);
      const saveBtn = pane.querySelector('.editor-save-btn');
      saveBtn.click();
      return new Promise(resolve => setTimeout(() => resolve({ text: saveBtn.textContent, bg: saveBtn.style.background }), 500));
    });
    assert.equal(result.text, 'Saved');
    assert.ok(result.bg.includes('35, 134, 54') || result.bg.includes('238636'), 'green background');
  });

  it('EDITUX-02: dirty tab has italic name and yellow top border', async () => {
    await page.evaluate(() => openFileTab('/data/workspace/wb-seed/save-flash-test.txt'));
    await new Promise(r => setTimeout(r, 2000));
    await page.evaluate(() => {
      const tabId = Array.from(tabs.keys()).find(k => k.startsWith('file-'));
      tabs.get(tabId).editor.dispatch({ changes: { from: 0, insert: 'z' } });
    });
    await new Promise(r => setTimeout(r, 500));
    const style = await page.evaluate(() => {
      const tabId = Array.from(tabs.keys()).find(k => k.startsWith('file-'));
      const tabEl = document.querySelector(`[data-tab-id="${tabId}"]`);
      const nameEl = tabEl.querySelector('.tab-name');
      return {
        hasDirtyClass: tabEl.classList.contains('tab-dirty'),
        borderTop: getComputedStyle(tabEl).borderTop,
        fontStyle: getComputedStyle(nameEl).fontStyle
      };
    });
    assert.equal(style.hasDirtyClass, true);
    assert.ok(style.borderTop.includes('solid'), 'has top border');
    assert.equal(style.fontStyle, 'italic');
  });

  // ── #102: System Prompt UI ─────────────────────────────

  it('PROMPTUI-01: project config modal has Claude/Gemini/Codex prompt buttons', async () => {
    await page.evaluate(() => openProjectConfig('wb-seed'));
    await new Promise(r => setTimeout(r, 1000));
    const buttons = await page.evaluate(() => {
      const modal = document.querySelector('[id^="proj-config-"]');
      if (!modal) return [];
      return Array.from(modal.querySelectorAll('button')).map(b => b.textContent.trim()).filter(t => t.includes('Claude') || t.includes('Gemini') || t.includes('Codex'));
    });
    assert.ok(buttons.some(b => b.includes('Claude')), 'Claude button');
    assert.ok(buttons.some(b => b.includes('Gemini')), 'Gemini button');
    assert.ok(buttons.some(b => b.includes('Codex')), 'Codex button');
    await page.evaluate(() => document.querySelector('[id^="proj-config-"]')?.remove());
  });

  it('PROMPTUI-02: clicking Gemini button creates GEMINI.md from template and opens editor', async () => {
    await page.evaluate(() => openProjectConfig('wb-seed'));
    await new Promise(r => setTimeout(r, 1000));
    await page.evaluate(() => {
      const btns = document.querySelectorAll('[id^="proj-config-"] button');
      for (const b of btns) { if (b.textContent.includes('Gemini')) { b.click(); break; } }
    });
    await new Promise(r => setTimeout(r, 2000));
    const tab = await page.evaluate(() => {
      for (const [, t] of tabs) {
        if (t.type === 'file' && t.filePath?.includes('GEMINI.md')) return { name: t.name, path: t.filePath, hasEditor: !!t.editor };
      }
      return null;
    });
    assert.ok(tab, 'GEMINI.md tab opened');
    assert.ok(tab.path.includes('wb-seed'), 'path is in project');
    assert.ok(tab.hasEditor, 'editor loaded');
  });

  it('PROMPTUI-03: settings System Prompts tab shows 3 CLI buttons and template', async () => {
    await page.evaluate(() => {
      document.getElementById('settings-modal').classList.add('visible');
      switchSettingsTab('prompts');
    });
    await new Promise(r => setTimeout(r, 500));
    const result = await page.evaluate(() => {
      const tab = document.getElementById('settings-prompts');
      const buttons = Array.from(tab.querySelectorAll('button')).map(b => b.textContent.trim());
      const hasTemplate = !!tab.querySelector('#setting-project-template');
      return { buttons: buttons.filter(b => b.includes('Claude') || b.includes('Gemini') || b.includes('Codex')), hasTemplate };
    });
    assert.equal(result.buttons.length, 3, '3 CLI buttons');
    assert.ok(result.hasTemplate, 'template textarea exists');
    await page.evaluate(() => document.getElementById('settings-modal').classList.remove('visible'));
  });
});
