'use strict';

// D1 #350: cookie `secure` flag set when x-forwarded-proto=https or NODE_ENV=production.

const test = require('node:test');
const assert = require('node:assert/strict');

function deriveSecure({ headers = {}, env = {} } = {}) {
  // Mirrors src/server.js:201
  return headers['x-forwarded-proto'] === 'https' || env.NODE_ENV === 'production';
}

test('D1-COOKIE-01: x-forwarded-proto=https → secure=true', () => {
  assert.equal(deriveSecure({ headers: { 'x-forwarded-proto': 'https' } }), true);
});

test('D1-COOKIE-02: NODE_ENV=production → secure=true', () => {
  assert.equal(deriveSecure({ env: { NODE_ENV: 'production' } }), true);
});

test('D1-COOKIE-03: plain HTTP local (no header, no production) → secure=false', () => {
  assert.equal(deriveSecure({}), false);
});

test('D1-COOKIE-04: x-forwarded-proto=http → secure=false', () => {
  assert.equal(deriveSecure({ headers: { 'x-forwarded-proto': 'http' } }), false);
});

test('D1-COOKIE-05: NODE_ENV=development with HTTPS forward → still secure=true', () => {
  assert.equal(deriveSecure({ headers: { 'x-forwarded-proto': 'https' }, env: { NODE_ENV: 'development' } }), true);
});

// Pin source — proves the live code uses this same condition
test('D1-COOKIE-SOURCE: src/server.js cookie-secure derivation matches implementation', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf-8');
  // Pre-fix: secure was hardcoded false. Post-fix: derived from request/env.
  assert.match(src, /x-forwarded-proto.*===.*'https'.*\|\|.*NODE_ENV.*===.*'production'/, 'cookie-secure derivation must check both conditions');
  assert.match(src, /secure:\s*isHttps/, 'res.cookie call must use derived secure flag');
});
