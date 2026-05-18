'use strict';

// SB-MK-01..08: #651 commit 11b (F8) — central status-bar dispatcher.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStatusBar, _derivedAuthMode } = require('../../public/js/status-bar.js');

function makeFakeEl() {
  const el = { children: [] };
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set(_v) { el.children.length = 0; },
  });
  el.appendChild = function (child) { el.children.push(child); };
  return el;
}

function fakeSubscribe() {
  const subs = [];
  return {
    subscribe(fn) { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; },
    fire(event) { for (const fn of subs) fn(event); },
    count: () => subs.length,
  };
}

// ── SB-MK-01: derived auth-mode mapping ───────────────────────────────────────

test('SB-MK-01: derived auth mode — codex api-key, oauth, stale', () => {
  assert.equal(_derivedAuthMode({ cli_type: 'codex', codex_api_key_set: true }), 'api-key');
  assert.equal(_derivedAuthMode({ cli_type: 'codex', codex_api_key_set: false }), 'oauth');
  assert.equal(_derivedAuthMode({ cli_type: 'codex', codex_api_key_set: false, codex_auth_broken: true }), 'stale');
  assert.equal(_derivedAuthMode({ cli_type: 'codex' }), 'unknown');
});

test('SB-MK-02: derived auth mode — claude oauth + stale fallback', () => {
  assert.equal(_derivedAuthMode({ cli_type: 'claude' }), 'oauth');
  assert.equal(_derivedAuthMode({ cli_type: 'claude', claude_auth_broken: true }), 'stale');
});

// ── SB-MK-03: initial render fires after construct ────────────────────────────

test('SB-MK-03: createStatusBar paints once on construct', () => {
  const el = makeFakeEl();
  const sub = fakeSubscribe();
  const state = {
    projects: [{ path: '/p', sessions: [{ id: 's1', cli_type: 'claude' }] }],
  };
  createStatusBar({
    el, getState: () => state, subscribe: sub.subscribe,
    getActiveTabId: () => 's1', getWsState: () => 'open',
  });
  assert.ok(el.children.length >= 1, 'at least one pill rendered on construct');
});

// ── SB-MK-04: ws state change → re-render ─────────────────────────────────────

test('SB-MK-04: snapshot event triggers re-render', () => {
  const el = makeFakeEl();
  const sub = fakeSubscribe();
  let wsState = 'connecting';
  const state = { projects: [{ path: '/p', sessions: [{ id: 's1', cli_type: 'claude' }] }] };
  createStatusBar({
    el, getState: () => state, subscribe: sub.subscribe,
    getActiveTabId: () => 's1', getWsState: () => wsState,
  });
  const initialFirstPill = el.children[0].textContent;
  // Change ws state then fire a snapshot event
  wsState = 'open';
  sub.fire({ type: 'snapshot' });
  assert.notEqual(el.children[0].textContent, initialFirstPill, 'ws pill re-rendered');
});

// ── SB-MK-05: redundant event does NOT re-render (dedupe) ─────────────────────

test('SB-MK-05: identical state triggers no DOM change (dedupe)', () => {
  const el = makeFakeEl();
  const sub = fakeSubscribe();
  const state = { projects: [{ path: '/p', sessions: [{ id: 's1', cli_type: 'claude' }] }] };
  const sb = createStatusBar({
    el, getState: () => state, subscribe: sub.subscribe,
    getActiveTabId: () => 's1', getWsState: () => 'open',
  });
  const r1 = JSON.stringify(sb._lastRender());
  sub.fire({ type: 'diff', diff: { kind: 'project:update' } });
  const r2 = JSON.stringify(sb._lastRender());
  assert.equal(r1, r2, 'no observable change → lastRender unchanged');
});

// ── SB-MK-06: token counter shows percentage when max_tokens is set ───────────

test('SB-MK-06: token counter renders with input/max + percentage', () => {
  const el = makeFakeEl();
  const sub = fakeSubscribe();
  const state = {
    projects: [{
      path: '/p',
      sessions: [{ id: 's1', cli_type: 'claude', input_tokens: 50_000, max_tokens: 200_000, model: 'sonnet' }],
    }],
  };
  createStatusBar({
    el, getState: () => state, subscribe: sub.subscribe,
    getActiveTabId: () => 's1', getWsState: () => 'open',
  });
  const tokenPill = el.children.find((p) => p.className.includes('token-counter'));
  assert.ok(tokenPill, 'token-counter pill exists');
  assert.match(tokenPill.textContent, /50,?000 \/ 200,?000 \(25%\)/);
});

// ── SB-MK-07: stale auth surfaces error class on auth pill ────────────────────

test('SB-MK-07: codex_auth_broken=true → auth pill class includes pill-err', () => {
  const el = makeFakeEl();
  const sub = fakeSubscribe();
  const state = {
    projects: [{ path: '/p', sessions: [{ id: 's1', cli_type: 'codex', codex_auth_broken: true }] }],
  };
  createStatusBar({
    el, getState: () => state, subscribe: sub.subscribe,
    getActiveTabId: () => 's1', getWsState: () => 'open',
  });
  const authPill = el.children.find((p) => p.className.includes('auth-pill'));
  assert.ok(authPill);
  assert.match(authPill.className, /pill-err/);
  assert.equal(authPill.textContent, 'stale');
});

// ── SB-MK-08: destroy() unsubscribes ───────────────────────────────────────────

test('SB-MK-08: destroy unsubscribes; no further re-renders', () => {
  const el = makeFakeEl();
  const sub = fakeSubscribe();
  const state = { projects: [{ path: '/p', sessions: [{ id: 's1', cli_type: 'claude' }] }] };
  const sb = createStatusBar({
    el, getState: () => state, subscribe: sub.subscribe,
    getActiveTabId: () => 's1', getWsState: () => 'open',
  });
  assert.equal(sub.count(), 1, 'one subscriber registered');
  sb.destroy();
  assert.equal(sub.count(), 0, 'subscriber dropped after destroy');
});
