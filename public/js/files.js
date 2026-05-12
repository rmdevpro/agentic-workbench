import { tabs, tabPanelAssignments, db_getSetting, _appendToOrder, _lastClickedProjectPath } from './state.js';
import { switchTab, renderTabs, _activeIdForPanel } from './tabs.js';
import { createFileTree } from './file-tree.js';

let _openFileTabRef_self; // self-reference for recursion in save-as

export function getEditorType(path) {
  const ext = path.split('.').pop().toLowerCase();
  const codeExts = ['js','ts','jsx','tsx','py','rb','go','rs','java','c','cpp','h','sh','bash','zsh','sql','dockerfile'];
  const dataExts = ['json','yaml','yml','toml','xml'];
  const webExts = ['css','scss','html','htm'];
  const mdExts = ['md','markdown','mdx'];
  const textExts = ['txt','log','env','cfg','conf','ini','csv','tsv','gitignore','dockerignore','editorconfig','eslintrc','prettierrc'];
  const imageExts = ['png','jpg','jpeg','gif','svg','webp','ico','bmp'];
  const pdfExts = ['pdf'];
  if (mdExts.includes(ext)) return 'markdown';
  if (imageExts.includes(ext)) return 'image';
  if (pdfExts.includes(ext)) return 'pdf';
  if (codeExts.includes(ext)) return 'code';
  if (dataExts.includes(ext)) return 'data';
  if (webExts.includes(ext)) return 'web';
  if (textExts.includes(ext)) return 'text';
  const name = path.split('/').pop();
  if (['Makefile','Dockerfile','Vagrantfile','Gemfile','Rakefile','LICENSE','README','CLAUDE','GEMINI','AGENTS','CHANGELOG'].some(n => name.startsWith(n))) return 'text';
  return 'browser';
}

export function getCMLanguage(path) {
  const ext = path.split('.').pop().toLowerCase();
  if (['js','jsx','ts','tsx'].includes(ext)) return CM.javascript();
  if (ext === 'py') return CM.python();
  if (ext === 'json') return CM.json();
  if (['yaml','yml'].includes(ext)) return CM.yaml();
  if (ext === 'css' || ext === 'scss') return CM.css();
  if (ext === 'html' || ext === 'htm') return CM.html();
  if (ext === 'md' || ext === 'markdown') return CM.markdown();
  return [];
}

export async function openFileTab(filePath) {
  for (const [id, tab] of tabs) {
    if (tab.type === 'file' && tab.filePath === filePath) {
      switchTab(id);
      return;
    }
  }

  const editorType = getEditorType(filePath);
  if (editorType === 'browser') {
    window.open('/api/file-raw?path=' + encodeURIComponent(filePath), '_blank');
    return;
  }
  const tabId = 'file-' + Date.now();
  const fileName = filePath.split('/').pop();
  const targetPanel = tabPanelAssignments[tabId] === 'primary' ? 'primary' : 'side';
  const targetAreaId = targetPanel === 'side' ? 'side-terminal-area' : 'terminal-area';

  const paneEl = document.createElement('div');
  paneEl.className = 'terminal-pane';
  paneEl.id = `pane-${tabId}`;
  document.getElementById(paneEl.id)?.remove();
  document.getElementById(targetAreaId).appendChild(paneEl);

  document.querySelectorAll('#terminal-area > div:not(.terminal-pane):not(.status-bar)').forEach(el => el.style.display = 'none');

  const tab = {
    id: tabId, type: 'file', name: fileName, filePath,
    editorType, paneEl, dirty: false, editor: null,
    status: 'connected',
    panel: tabPanelAssignments[tabId] === 'primary' ? 'primary' : 'side',
  };
  tabs.set(tabId, tab);
  _appendToOrder(tab.panel, tabId);

  try {
    if (editorType === 'image') {
      const rawUrl = `/api/file-raw?path=${encodeURIComponent(filePath)}`;
      const wrapper = document.createElement('div');
      wrapper.className = 'image-viewer';
      const imgEl = document.createElement('img');
      imgEl.addEventListener('error', async () => {
        let detail = 'image failed to load';
        try {
          const r = await fetch(rawUrl);
          if (!r.ok) detail = `HTTP ${r.status} — ${(await r.text()).slice(0, 200)}`;
          else detail = `Browser declined to render the response (Content-Type: ${r.headers.get('content-type')}, ${r.headers.get('content-length')} bytes). The file may be a corrupt or unsupported image format.`;
        } catch (fetchErr) { detail = `network error: ${fetchErr.message}`; }
        paneEl.innerHTML = `<div style="padding:24px;color:var(--danger);font-size:13px;line-height:1.6">
          <div style="margin-bottom:8px;font-weight:bold">Couldn't display image</div>
          <div style="margin-bottom:8px">${window.escapeHtml(detail)}</div>
          <div><a href="${rawUrl}" target="_blank" rel="noopener" style="color:var(--accent)">Open raw bytes in a new browser tab</a></div>
          <div style="margin-top:8px;color:var(--text-muted);font-size:11px">Path: ${window.escapeHtml(filePath)}</div>
        </div>`;
      });
      imgEl.src = rawUrl;
      wrapper.appendChild(imgEl);
      paneEl.appendChild(wrapper);
    } else if (editorType === 'pdf') {
      paneEl.innerHTML = `<iframe class="pdf-viewer" src="/api/file-raw?path=${encodeURIComponent(filePath)}"></iframe>`;
    } else {
      const toolbar = document.createElement('div');
      toolbar.className = 'editor-toolbar';
      toolbar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 8px;background:var(--bg-secondary);border-bottom:1px solid var(--border);flex-shrink:0';
      toolbar.innerHTML = `
        <span style="font-size:12px;color:var(--text-muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${window.escapeHtml(filePath)}">${window.escapeHtml(filePath)}</span>
        <button class="editor-save-btn" style="padding:4px 12px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;opacity:0.5" disabled>Save</button>
        <button class="editor-saveas-btn" style="padding:4px 12px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:12px">Save As...</button>
      `;
      paneEl.appendChild(toolbar);

      const saveBtn = toolbar.querySelector('.editor-save-btn');
      const saveAsBtn = toolbar.querySelector('.editor-saveas-btn');

      saveBtn.addEventListener('click', () => saveFileTab(tabId));

      saveAsBtn.addEventListener('click', async () => {
        const newPath = await window.showInputModal({
          title: 'Save As',
          label: 'New file path:',
          defaultValue: tab.filePath,
          placeholder: '/data/workspace/...',
        });
        if (!newPath || !newPath.trim()) return;
        const cleanPath = newPath.trim();
        if (cleanPath.includes('..') || !cleanPath.startsWith('/data/workspace')) {
          window.showErrorModal({ title: 'Invalid path', message: 'Save As path must be within /data/workspace' });
          return;
        }
        let content;
        if (tab.editorType === 'markdown' && tab.editor && tab.editor.getMarkdown) {
          content = tab.editor.getMarkdown();
        } else if (tab.editor && tab.editor.state) {
          content = tab.editor.state.doc.toString();
        } else return;
        try {
          await fetch('/api/file?path=' + encodeURIComponent(cleanPath), {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain' },
            body: content,
          });
          tab.filePath = cleanPath;
          tab.name = cleanPath.split('/').pop();
          tab.dirty = false;
          toolbar.querySelector('span').textContent = cleanPath;
          toolbar.querySelector('span').title = cleanPath;
          renderTabs();
        } catch (err) {
          await window.showErrorModal({ title: 'Save As failed', message: err.message });
        }
      });

      const updateSaveBtn = () => {
        saveBtn.disabled = !tab.dirty;
        saveBtn.style.opacity = tab.dirty ? '1' : '0.5';
      };
      tab._updateSaveBtn = updateSaveBtn;

      if (editorType === 'markdown' && typeof toastui !== 'undefined') {
        const res = await fetch('/api/file?path=' + encodeURIComponent(filePath));
        const content = await res.text();
        const editorDiv = document.createElement('div');
        editorDiv.className = 'file-editor-pane';
        paneEl.appendChild(editorDiv);
        const editor = new toastui.Editor({
          el: editorDiv,
          initialEditType: 'wysiwyg',
          previewStyle: 'vertical',
          height: '100%',
          initialValue: content,
          theme: 'dark',
        });
        tab.editor = editor;
        editor.on('change', () => {
          if (!tab.dirty) { tab.dirty = true; renderTabs(); if (tab._updateSaveBtn) tab._updateSaveBtn(); }
        });
        editorDiv.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveFileTab(tabId);
          }
        });
      } else {
        const res = await fetch('/api/file?path=' + encodeURIComponent(filePath));
        const content = await res.text();
        const editorDiv = document.createElement('div');
        editorDiv.className = 'file-editor-pane';
        paneEl.appendChild(editorDiv);
        const lang = getCMLanguage(filePath);
        const extensions = [
          CM.basicSetup,
          CM.oneDark,
          CM.keymap.of([{ key: 'Mod-s', run: () => { saveFileTab(tabId); return true; } }]),
          CM.EditorView.updateListener.of(update => {
            if (update.docChanged && !tab.dirty) { tab.dirty = true; renderTabs(); if (tab._updateSaveBtn) tab._updateSaveBtn(); }
          }),
        ];
        if (lang) extensions.push(lang);
        const state = CM.EditorState.create({ doc: content, extensions });
        const editor = new CM.EditorView({ state, parent: editorDiv });
        tab.editor = editor;
      }
    }
  } catch (err) {
    paneEl.innerHTML = `<div style="padding:24px;color:var(--danger)">Error loading file: ${window.escapeHtml(err.message)}</div>`;
  }

  switchTab(tabId);
  renderTabs();
}

export async function saveFileTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab || tab.type !== 'file') return;
  let content;
  if (tab.editorType === 'markdown' && tab.editor && tab.editor.getMarkdown) {
    content = tab.editor.getMarkdown();
  } else if (tab.editor && tab.editor.state) {
    content = tab.editor.state.doc.toString();
  } else {
    return;
  }
  try {
    await fetch('/api/file?path=' + encodeURIComponent(tab.filePath), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: content,
    });
    tab.dirty = false;
    renderTabs();
    if (tab._updateSaveBtn) tab._updateSaveBtn();
    const pane = document.getElementById(`pane-${tabId}`);
    const saveBtn = pane?.querySelector('.editor-save-btn');
    if (saveBtn) {
      const origText = saveBtn.textContent;
      saveBtn.textContent = 'Saved';
      saveBtn.style.background = '#238636';
      setTimeout(() => { saveBtn.textContent = origText; saveBtn.style.background = ''; }, 1500);
    }
  } catch (err) {
    await window.showErrorModal({ title: 'Save failed', message: err.message });
  }
}

// ── File-browser singleton ───────────────────────────────────────────────
export let _fileBrowserTree = null;
export let selectedUploadDir = null;

export function removeContextMenu() {
  document.querySelectorAll('.context-menu').forEach(m => m.remove());
}

export function _fileBrowserContextMenu(path, isDir, e) {
  removeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = e.pageX + 'px';
  menu.style.top = e.pageY + 'px';
  if (isDir) {
    menu.innerHTML = `
      <div class="context-menu-item" data-action="new-file">New File</div>
      <div class="context-menu-item" data-action="new-folder">New Folder</div>
      <div class="context-menu-item" data-action="upload">Upload</div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-action="copy-path">Copy Path</div>
      <div class="context-menu-item" data-action="rename">Rename</div>
      <div class="context-menu-item" data-action="delete" style="color:var(--danger)">Delete</div>
    `;
  } else {
    menu.innerHTML = `
      <div class="context-menu-item" data-action="open">Open</div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-action="copy-path">Copy Path</div>
      <div class="context-menu-item" data-action="rename">Rename</div>
      <div class="context-menu-item" data-action="delete" style="color:var(--danger)">Delete</div>
    `;
  }
  menu.addEventListener('click', async (ev) => {
    const action = ev.target.dataset.action;
    if (!action) return;
    removeContextMenu();
    if (action === 'open') {
      openFileTab(path);
    } else if (action === 'copy-path') {
      const cleanPath = path.replace(/\/$/, '');
      try {
        await navigator.clipboard.writeText(cleanPath);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = cleanPath;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch { /* nothing more we can do */ }
        ta.remove();
      }
    } else if (action === 'new-file') {
      const name = await window.showInputModal({
        title: 'New File', label: 'File name:',
        defaultValue: 'new-file.md', placeholder: 'untitled.md',
      });
      if (!name) return;
      const newPath = path.replace(/\/?$/, '/') + name;
      await fetch('/api/file-new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: newPath }) });
      await _fileBrowserTree?.refreshDirectory(path);
      openFileTab(newPath);
    } else if (action === 'new-folder') {
      const name = await window.showInputModal({
        title: 'New Folder', label: 'Folder name:', placeholder: 'docs',
      });
      if (!name) return;
      await fetch('/api/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path.replace(/\/?$/, '/') + name }) });
      await _fileBrowserTree?.refreshDirectory(path);
    } else if (action === 'upload') {
      selectedUploadDir = path;
      document.getElementById('file-upload-input').click();
    } else if (action === 'rename') {
      const oldName = path.split('/').filter(Boolean).pop();
      const newName = await window.showInputModal({
        title: 'Rename', label: 'New name:', defaultValue: oldName,
      });
      if (!newName || newName === oldName) return;
      const parentDir = path.replace(/[^/]+\/?$/, '');
      await fetch('/api/rename', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPath: path.replace(/\/$/, ''), newPath: parentDir + newName + (isDir ? '/' : '') }) });
      await _fileBrowserTree?.refreshDirectory(parentDir || '/');
    } else if (action === 'delete') {
      const name = path.split('/').filter(Boolean).pop();
      const ok = await window.showConfirmModal({
        title: 'Delete', danger: true, confirmLabel: 'Delete',
        message: `Delete "${name}"${isDir ? ' and all its contents' : ''}? This cannot be undone.`,
      });
      if (!ok) return;
      await fetch('/api/file?path=' + encodeURIComponent(path.replace(/\/$/, '')), { method: 'DELETE' });
      const parentDir = path.replace(/[^/]+\/?$/, '');
      await _fileBrowserTree?.refreshDirectory(parentDir || '/');
    }
  });
  document.body.appendChild(menu);
}

async function _fileBrowserDrop(sourcePath, destPath) {
  await fetch('/api/move', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: sourcePath.replace(/\/$/, ''), destination: destPath.replace(/\/$/, '') }),
  });
  const srcParent = sourcePath.replace(/[^/]+\/?$/, '') || '/';
  await _fileBrowserTree?.refreshDirectory(srcParent);
  await _fileBrowserTree?.refreshDirectory(destPath);
}

export async function loadFiles() {
  if (_fileBrowserTree) return;
  const treeEl = document.getElementById('file-browser-tree');
  let mounts = [];
  try {
    const res = await fetch('/api/mounts');
    mounts = await res.json();
  } catch {}
  if (!mounts.length) mounts = [{ path: '/' }];
  _fileBrowserTree = createFileTree({
    el: treeEl,
    mounts,
    autoExpandFirstMount: true,
    draggable: true,
    onFileOpen: (p) => openFileTab(p),
    onContextMenu: _fileBrowserContextMenu,
    onDrop: _fileBrowserDrop,
  });
}

export async function refreshFileTree() {
  if (!_fileBrowserTree) { await loadFiles(); return; }
  await _fileBrowserTree.refresh();
}

export function autoNavigateFileTree() {
  const projPath = window._getActiveProjectPath && window._getActiveProjectPath();
  if (!projPath || !_fileBrowserTree) return;
  _fileBrowserTree.navigate(projPath);
}

export async function refreshFileBrowserDir(dirPath) {
  if (!_fileBrowserTree) return;
  await _fileBrowserTree.refreshDirectory(dirPath);
}

export function getSelectedFileBrowserDir() {
  if (!_fileBrowserTree) return null;
  const sel = _fileBrowserTree.getSelected();
  if (sel && !sel.endsWith('/')) {
    return sel.replace(/[^/]+$/, '');
  }
  return sel || _fileBrowserTree.getDeepestExpanded();
}

export async function fileBrowserNewFolder() {
  const targetDir = getSelectedFileBrowserDir();
  if (!targetDir) { window.showErrorModal({ title: 'No directory selected', message: 'Expand a directory in the file browser first' }); return; }
  const name = await window.showInputModal({
    title: 'New Folder', label: 'Folder name:', placeholder: 'docs',
  });
  if (!name) return;
  try {
    const res = await fetch('/api/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: targetDir.replace(/\/$/, '') + '/' + name }),
    });
    const data = await res.json();
    if (data.error) { window.showErrorModal({ title: 'Create folder failed', message: data.error }); return; }
    await _fileBrowserTree?.refreshDirectory(targetDir);
  } catch (err) { window.showErrorModal({ title: 'Create folder failed', message: err.message }); }
}

export async function fileBrowserUpload(files) {
  const targetDir = selectedUploadDir || getSelectedFileBrowserDir();
  selectedUploadDir = null;
  if (!targetDir) { window.showErrorModal({ title: 'No directory selected', message: 'Expand a directory in the file browser first' }); return; }
  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Upload-Dir': targetDir,
          'X-Upload-Filename': file.name,
        },
        body: buf,
      });
    } catch (err) { window.showErrorModal({ title: 'Upload failed', message: err.message }); }
  }
  document.getElementById('file-upload-input').value = '';
  await _fileBrowserTree?.refreshDirectory(targetDir);
}
