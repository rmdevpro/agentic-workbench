// ── FileTree component ──────────────────────────────────────────────────
// Vanilla-JS file tree.
// Used by both #file-browser-tree (right panel) and #picker-tree (project picker).
//
// opts:
//   el                    — container element
//   mounts                — [{path}, …] from /api/mounts
//   foldersOnly           — when true, render only directories (project picker)
//   autoExpandFirstMount  — expand the first mount on init
//   draggable             — wire dragstart / dragover / drop
//   onFileOpen(path)      — dblclick on a file
//   onSelect(path, isDir) — single click on any row
//   onContextMenu(path, isDir, e) — right-click
//   onDrop(source, dest)  — drop a row onto a directory row
//
// Returns: { refresh, refreshDirectory, navigate, expand, collapse,
//            getSelected, getDeepestExpanded }
export function createFileTree(opts) {
  const {
    el,
    mounts = [],
    foldersOnly = false,
    autoExpandFirstMount = false,
    draggable = false,
    onFileOpen = () => {},
    onSelect = () => {},
    onContextMenu = null,
    onDrop = null,
  } = opts;

  const state = {
    expandOrder: [],   // paths in order of most-recent expand (for getDeepestExpanded fallback)
    selected: null,
  };

  function escAttr(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/(["\\])/g, '\\$1');
  }
  function nameFromPath(p) {
    return p.replace(/\/$/, '').split('/').filter(Boolean).pop() || p;
  }
  function pickIcon(kind, name) {
    if (kind === 'directory' || kind === 'mount') return { glyph: '📁', cls: 'ft-icon-dir' };
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (['png','jpg','jpeg','gif','svg','webp','ico','bmp'].includes(ext)) return { glyph: '🖼', cls: 'ft-icon-image' };
    if (['md','mdx','markdown'].includes(ext)) return { glyph: '📝', cls: 'ft-icon-md' };
    if (['pdf'].includes(ext)) return { glyph: '📕', cls: 'ft-icon-pdf' };
    if (['json','yaml','yml','toml','xml'].includes(ext)) return { glyph: '🧾', cls: 'ft-icon-data' };
    if (['zip','tar','tgz','gz','bz2','xz','7z','rar'].includes(ext)) return { glyph: '📦', cls: 'ft-icon-archive' };
    if (['js','ts','tsx','jsx','py','go','rs','java','c','cpp','h','hpp','sh','bash','zsh','rb','php','sql','dockerfile'].includes(ext)) return { glyph: '⟨⟩', cls: 'ft-icon-code' };
    if (['css','scss','less','html','htm'].includes(ext)) return { glyph: '🎨', cls: 'ft-icon-web' };
    if (['log','txt','env','cfg','conf','ini','csv','tsv'].includes(ext)) return { glyph: '📄', cls: 'ft-icon-text' };
    return { glyph: '📄', cls: 'ft-icon-file' };
  }
  function rowByPath(path) {
    return el.querySelector(`.ft-row[data-path="${escAttr(path)}"]`);
  }
  function childrenForRow(row) {
    const next = row.nextElementSibling;
    return next && next.classList.contains('ft-children') ? next : null;
  }
  function createRow(path, kind, displayName) {
    const row = document.createElement('div');
    row.className = `ft-row ft-${kind === 'mount' ? 'mount-header' : kind === 'directory' ? 'dir' : 'file'}`;
    row.dataset.path = path;
    row.dataset.kind = kind;
    const arrow = document.createElement('span');
    arrow.className = 'ft-arrow' + (kind === 'file' ? ' ft-spacer' : '');
    arrow.textContent = kind === 'file' ? '' : '▶';
    row.appendChild(arrow);
    const icon = pickIcon(kind, displayName || nameFromPath(path));
    const iconEl = document.createElement('span');
    iconEl.className = `ft-icon ${icon.cls}`;
    iconEl.textContent = icon.glyph;
    row.appendChild(iconEl);
    const name = document.createElement('span');
    name.className = 'ft-name';
    name.textContent = displayName || nameFromPath(path);
    row.appendChild(name);
    if (draggable) row.draggable = true;
    return row;
  }
  function renderMounts() {
    el.innerHTML = '';
    el.classList.add('ft-tree');
    for (const mount of mounts) {
      const path = mount.path.replace(/\/?$/, '/');
      const section = document.createElement('div');
      section.className = 'ft-mount';
      section.dataset.path = path;
      const displayName = mount.label || mount.path;
      const row = createRow(path, 'mount', displayName);
      const children = document.createElement('div');
      children.className = 'ft-children';
      children.hidden = true;
      section.appendChild(row);
      section.appendChild(children);
      el.appendChild(section);
    }
    if (autoExpandFirstMount && mounts.length) {
      expand(mounts[0].path.replace(/\/?$/, '/'));
    }
  }

  async function loadDirectory(row, childrenEl) {
    row.classList.add('ft-loading');
    try {
      const dirPath = row.dataset.path;
      const res = await fetch('/api/files/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirPath }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        childrenEl.innerHTML = `<div class="ft-error">${window.escapeHtml(err.error || res.statusText)}</div>`;
        row.dataset.loaded = '1';
        return;
      }
      const data = await res.json();
      let entries = (data.entries || []);
      if (foldersOnly) entries = entries.filter(e => e.kind === 'directory');
      diffChildren(childrenEl, entries, dirPath);
      row.dataset.loaded = '1';
    } finally {
      row.classList.remove('ft-loading');
    }
  }

  function diffChildren(childrenEl, freshEntries, parentPath) {
    const expected = freshEntries.map(e => ({
      path: parentPath + e.name + (e.kind === 'directory' ? '/' : ''),
      name: e.name,
      kind: e.kind,
    }));
    const expectedPaths = new Set(expected.map(x => x.path));
    const existingByPath = new Map();
    for (const child of childrenEl.children) {
      if (child.classList.contains('ft-row')) existingByPath.set(child.dataset.path, child);
    }
    for (const [path, rowEl] of existingByPath) {
      if (!expectedPaths.has(path)) {
        const after = rowEl.nextElementSibling;
        rowEl.remove();
        if (after && after.classList.contains('ft-children')) after.remove();
        existingByPath.delete(path);
      }
    }
    let cursor = null;
    for (const x of expected) {
      let row = existingByPath.get(x.path);
      if (!row) {
        row = createRow(x.path, x.kind, x.name);
        const insertAfter = cursor
          ? (cursor.nextElementSibling && cursor.nextElementSibling.classList.contains('ft-children')
              ? cursor.nextElementSibling : cursor)
          : null;
        if (insertAfter) insertAfter.after(row); else childrenEl.prepend(row);
        if (x.kind === 'directory') {
          const sub = document.createElement('div');
          sub.className = 'ft-children';
          sub.hidden = true;
          row.after(sub);
        }
      }
      cursor = row;
    }
  }

  async function expand(path) {
    const row = rowByPath(path);
    if (!row) return false;
    if (row.dataset.kind !== 'directory' && row.dataset.kind !== 'mount') return false;
    const children = childrenForRow(row);
    if (!children) return false;
    children.hidden = false;
    row.querySelector('.ft-arrow')?.classList.add('ft-expanded');
    const i = state.expandOrder.indexOf(path);
    if (i >= 0) state.expandOrder.splice(i, 1);
    state.expandOrder.push(path);
    if (!row.dataset.loaded) await loadDirectory(row, children);
    return true;
  }
  function collapse(path) {
    const row = rowByPath(path);
    if (!row) return false;
    const children = childrenForRow(row);
    if (!children) return false;
    children.hidden = true;
    row.querySelector('.ft-arrow')?.classList.remove('ft-expanded');
    const i = state.expandOrder.indexOf(path);
    if (i >= 0) state.expandOrder.splice(i, 1);
    return true;
  }
  async function toggle(path) {
    const row = rowByPath(path);
    if (!row) return;
    const children = childrenForRow(row);
    if (!children) return;
    if (children.hidden) await expand(path); else collapse(path);
  }
  async function refresh() {
    const loadedRows = el.querySelectorAll('.ft-row[data-loaded="1"]');
    for (const row of loadedRows) {
      const children = childrenForRow(row);
      if (children) await loadDirectory(row, children);
    }
  }
  async function refreshDirectory(path) {
    const row = rowByPath(path) || rowByPath(path.replace(/\/?$/, '/'));
    const children = row && childrenForRow(row);
    if (children) await loadDirectory(row, children);
  }
  async function navigate(targetPath) {
    const target = targetPath.replace(/\/?$/, '/');
    const mountSection = [...el.querySelectorAll('.ft-mount')].find(s => target.startsWith(s.dataset.path));
    if (!mountSection) return false;
    const mountPath = mountSection.dataset.path;
    const rel = target.slice(mountPath.length);
    const segments = rel.split('/').filter(Boolean);
    await expand(mountPath);
    let curr = mountPath;
    for (const seg of segments) {
      curr = curr + seg + '/';
      const row = rowByPath(curr);
      if (!row) break;
      if (row.dataset.kind === 'directory') await expand(curr);
    }
    const final = rowByPath(target) || rowByPath(target.replace(/\/$/, ''));
    if (final) {
      selectRow(final);
      final.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    return true;
  }
  function selectRow(row) {
    el.querySelectorAll('.ft-row.ft-selected').forEach(r => r.classList.remove('ft-selected'));
    row.classList.add('ft-selected');
    state.selected = row.dataset.path;
  }
  function getSelected() { return state.selected; }
  function getDeepestExpanded() {
    if (state.expandOrder.length) return state.expandOrder[state.expandOrder.length - 1];
    if (mounts.length) return mounts[0].path.replace(/\/?$/, '/');
    return null;
  }

  el.addEventListener('click', async (e) => {
    const row = e.target.closest('.ft-row');
    if (!row || !el.contains(row)) return;
    const kind = row.dataset.kind;
    const path = row.dataset.path;
    if (kind === 'directory' || kind === 'mount') {
      await toggle(path);
    } else {
      selectRow(row);
    }
    onSelect(path, kind === 'directory' || kind === 'mount');
  });
  el.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.ft-row');
    if (!row || !el.contains(row)) return;
    if (row.dataset.kind === 'file') onFileOpen(row.dataset.path);
  });
  if (onContextMenu) {
    el.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.ft-row');
      if (!row || !el.contains(row)) return;
      e.preventDefault();
      e.stopPropagation();
      const isDir = row.dataset.kind === 'directory' || row.dataset.kind === 'mount';
      onContextMenu(row.dataset.path, isDir, e);
    });
  }
  if (draggable) {
    el.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.ft-row');
      if (!row || !el.contains(row)) return;
      e.dataTransfer.setData('text/plain', row.dataset.path);
      e.dataTransfer.effectAllowed = 'copyMove';
    });
  }
  if (onDrop) {
    el.addEventListener('dragover', (e) => {
      const row = e.target.closest('.ft-row');
      if (!row || !el.contains(row)) return;
      if (row.dataset.kind !== 'directory' && row.dataset.kind !== 'mount') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.querySelectorAll('.ft-row.ft-drop-target').forEach(r => r.classList.remove('ft-drop-target'));
      row.classList.add('ft-drop-target');
    });
    el.addEventListener('dragleave', (e) => {
      const row = e.target.closest('.ft-row');
      if (row) row.classList.remove('ft-drop-target');
    });
    el.addEventListener('drop', async (e) => {
      const row = e.target.closest('.ft-row');
      if (!row || !el.contains(row)) return;
      e.preventDefault();
      row.classList.remove('ft-drop-target');
      if (row.dataset.kind !== 'directory' && row.dataset.kind !== 'mount') return;
      const sourcePath = e.dataTransfer.getData('text/plain');
      const destPath = row.dataset.path;
      if (!sourcePath || !destPath || sourcePath === destPath) return;
      await onDrop(sourcePath, destPath);
    });
  }

  renderMounts();
  return { refresh, refreshDirectory, navigate, expand, collapse, getSelected, getDeepestExpanded };
}
