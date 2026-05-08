'use strict';

// #317: single-source GitHub/git credential model.
//
// Storage: settings table key 'git_accounts' holds a JSON array. Each entry:
//   { id, path, token, isKB, default, name? }
//
// 'path' is the unique key — it's the URL prefix that identifies the GitHub
// (or other host) account, e.g. 'github.com/rmdevpro' or 'huggingface.co/aristotle9'.
// One row per path. No duplicates.
//
// Bootstrap migration (runs idempotently in resolveAccounts): legacy entries
// with the old shape { name, host, username, token, isKB } are rewritten to
// { id, path: host + '/' + username, token, isKB, default: false, name }.

function _readRaw(db) {
  try { return JSON.parse(db.getSetting('git_accounts', '[]') || '[]'); }
  catch { return []; }
}

function _writeRaw(db, arr) {
  db.setSetting('git_accounts', JSON.stringify(arr));
}

// Returns the canonical (post-migration) accounts array. Migrates the stored
// JSON in place if any legacy entries are present. Idempotent.
function resolveAccounts(db) {
  const raw = _readRaw(db);
  let mutated = false;
  const out = raw.map((a) => {
    if (a && typeof a === 'object' && typeof a.path === 'string') return a;
    if (a && a.host && a.username) {
      mutated = true;
      return {
        id: a.id || _genId(),
        path: `${a.host}/${a.username}`,
        token: a.token || '',
        isKB: !!a.isKB,
        default: false,
        name: a.name || a.username || a.host,
      };
    }
    return null;
  }).filter(Boolean);
  if (mutated) _writeRaw(db, out);
  return out;
}

function _genId() {
  // Cheap unique-id; not cryptographically random but fine for row keys.
  return 'gat_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Strip any embedded credentials from a URL and parse out the host + first
// path segment. Examples:
//   https://github.com/rmdevpro/agentic-workbench.git → 'github.com/rmdevpro'
//   https://x:tok@github.com/rmdevpro/agentic-workbench → 'github.com/rmdevpro'
//   git@github.com:rmdevpro/agentic-workbench.git → 'github.com/rmdevpro'
//   ssh://git@github.com/rmdevpro/agentic-workbench → 'github.com/rmdevpro'
function pathFromUrl(url) {
  if (!url) return null;
  const parts = repoPartsFromUrl(url);
  return parts ? `${parts.host}/${parts.owner}` : null;
}

// #329 [A4]: full {host, owner, name} parse from a git remote URL. Used by
// /api/projects/:name/git-remote to give the frontend issue-picker the right
// 3-part repo identifier (host/owner/name), no hardcoded org assumption.
//
// Examples:
//   https://github.com/rmdevpro/agentic-workbench.git → {host:'github.com', owner:'rmdevpro', name:'agentic-workbench'}
//   https://x:tok@enterprise.example.com/team/repo    → {host:'enterprise.example.com', owner:'team', name:'repo'}
//   git@github.com:rmdevpro/agentic-workbench.git     → {host:'github.com', owner:'rmdevpro', name:'agentic-workbench'}
//   ssh://git@github.com/rmdevpro/agentic-workbench   → {host:'github.com', owner:'rmdevpro', name:'agentic-workbench'}
function repoPartsFromUrl(url) {
  if (!url) return null;
  let u = String(url).trim();
  // SCP-style ssh: git@host:owner/repo
  const scp = /^[^@]+@([^:]+):([^/]+)\/(.+)$/.exec(u);
  if (scp) return { host: scp[1], owner: scp[2], name: scp[3].replace(/\.git$/, '') };
  // Strip protocol + any embedded creds
  u = u.replace(/^[a-z]+:\/\//i, '');
  u = u.replace(/^[^@/]+:[^@/]+@/, '');  // user:pass@
  u = u.replace(/^[^@/]+@/, '');         // user@
  const m = /^([^/]+)\/([^/]+)\/(.+)$/.exec(u);
  if (!m) return null;
  return { host: m[1], owner: m[2], name: m[3].replace(/\.git$/, '') };
}

// Find an account by exact path match. Returns null if no row exists.
function accountForPath(db, path) {
  if (!path) return null;
  const accounts = resolveAccounts(db);
  return accounts.find(a => a.path === path) || null;
}

// Find the KB-flagged account, or null.
function kbAccount(db) {
  return resolveAccounts(db).find(a => a.isKB) || null;
}

// Find the default-flagged account, or null. Only used for ops with no repo
// context (e.g., "list my repos"); per-repo ops resolve via accountForPath.
function defaultAccount(db) {
  return resolveAccounts(db).find(a => a.default) || null;
}

// Build the args needed to inject Authorization header into a single git call.
// Usage: spawn('git', [...gitAuthArgs(token), 'push', 'origin', 'main'])
function gitAuthArgs(token) {
  if (!token) return [];
  return ['-c', `http.extraheader=AUTHORIZATION: Bearer ${token}`];
}

// Wrap a simple-git instance so every raw call automatically includes the
// extraheader for the given token. Other simple-git methods are passed through;
// for them, the extraheader can be injected via env or per-call raw().
//
// Easier pattern in callers: prefer `g.raw([...gitAuthArgs(token), 'subcmd', ...])`
// or use this wrapper's pushWith / pullWith / rawWith helpers.
function withGit(g, token) {
  const auth = gitAuthArgs(token);
  return {
    raw: (args, ...rest) => g.raw([...auth, ...args], ...rest),
    pushWith: (remote, branch) => g.raw([...auth, 'push', remote, branch]),
    fetchWith: (remote) => g.raw([...auth, 'fetch', remote]),
    pullWith: (remote, branch) => g.raw([...auth, 'pull', remote, branch]),
    cloneWith: (url, target) => g.raw([...auth, 'clone', url, target]),
    underlying: g,
  };
}

// CRUD helpers for the settings-stored array. Throw on invariant violations
// (duplicate path, etc.) so callers can surface clean errors.
function addAccount(db, { path, token, isKB = false, isDefault = false, name = null }) {
  if (!path) throw new Error('path required');
  if (!token) throw new Error('token required');
  const accounts = resolveAccounts(db);
  if (accounts.some(a => a.path === path)) {
    const e = new Error(`account already exists for path '${path}'`);
    e.code = 'duplicate_path';
    throw e;
  }
  const next = accounts.map(a => ({
    ...a,
    isKB: isKB ? false : a.isKB,
    default: isDefault ? false : a.default,
  }));
  next.push({
    id: _genId(),
    path,
    token,
    isKB: !!isKB,
    default: !!isDefault,
    name: name || path,
  });
  _writeRaw(db, next);
  return next[next.length - 1];
}

function updateAccount(db, id, { token, isKB, isDefault, name, path } = {}) {
  const accounts = resolveAccounts(db);
  const target = accounts.find(a => a.id === id);
  if (!target) {
    const e = new Error(`account not found: ${id}`); e.code = 'not_found'; throw e;
  }
  if (path !== undefined && path !== target.path) {
    if (accounts.some(a => a.path === path && a.id !== id)) {
      const e = new Error(`another account already uses path '${path}'`);
      e.code = 'duplicate_path';
      throw e;
    }
    target.path = path;
  }
  if (token !== undefined) target.token = token;
  if (name !== undefined) target.name = name;
  if (isKB !== undefined) {
    if (isKB) for (const a of accounts) if (a.id !== id) a.isKB = false;
    target.isKB = !!isKB;
  }
  if (isDefault !== undefined) {
    if (isDefault) for (const a of accounts) if (a.id !== id) a.default = false;
    target.default = !!isDefault;
  }
  _writeRaw(db, accounts);
  return target;
}

function removeAccount(db, id) {
  const accounts = resolveAccounts(db);
  const idx = accounts.findIndex(a => a.id === id);
  if (idx === -1) {
    const e = new Error(`account not found: ${id}`); e.code = 'not_found'; throw e;
  }
  const removed = accounts.splice(idx, 1)[0];
  _writeRaw(db, accounts);
  return removed;
}

// Public-safe view of an account: includes presence-of-token but not the
// token itself. Used by gh_account_list etc.
function publicView(account) {
  if (!account) return null;
  const { id, path, isKB, default: isDefault, name } = account;
  return { id, path, isKB: !!isKB, default: !!isDefault, name: name || path, has_token: !!account.token };
}

module.exports = {
  resolveAccounts,
  accountForPath,
  kbAccount,
  defaultAccount,
  pathFromUrl,
  repoPartsFromUrl,
  gitAuthArgs,
  withGit,
  addAccount,
  updateAccount,
  removeAccount,
  publicView,
};
