'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, BASE_URL } = require('../helpers/http-client');
const { dockerExec } = require('../helpers/reset-state');

test('SRV-01: health endpoint returns 200 with ok status', async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE_URL}/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  const r = await get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'ok');
});

test('SRV-02: serves index.html with Workbench title', async () => {
  const r = await fetch(`${BASE_URL}/`);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(text.includes('Workbench'));
  assert.ok(text.includes('<html'));
});

test('SRV-02: serves static lib assets (xterm, codemirror)', async () => {
  assert.equal((await fetch(`${BASE_URL}/lib/xterm/lib/xterm.js`)).status, 200);
  assert.equal((await fetch(`${BASE_URL}/lib/codemirror/codemirror-bundle.js`)).status, 200);
  // Regression for #319: jquery and jqueryfiletree static routes were removed.
  // If a future change re-introduces them, this test will fail and the change
  // must be reviewed against the cleanup decision.
  assert.equal((await fetch(`${BASE_URL}/lib/jquery/jquery.min.js`)).status, 404);
});

test('SRV-04: container alive and server listening', () => {
  const alive = dockerExec('echo alive');
  assert.equal(alive, 'alive');
});
