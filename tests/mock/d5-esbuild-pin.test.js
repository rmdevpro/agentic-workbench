'use strict';

// D5 #354: esbuild moved from on-demand npx to devDependency.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8'));
const buildScript = fs.readFileSync(path.join(REPO, 'scripts', 'build-editor.js'), 'utf-8');

test('D5-EB-01: package.json devDependencies includes pinned esbuild', () => {
  const dev = pkg.devDependencies || {};
  assert.ok(dev.esbuild, `package.json devDependencies must list esbuild. got keys: ${Object.keys(dev).join(', ')}`);
  assert.ok(/^\d+\.\d+\.\d+$/.test(dev.esbuild), `esbuild version must be pinned (e.g., "0.24.0"), not a range. got: ${dev.esbuild}`);
});

test('D5-EB-02: scripts/build-editor.js uses local binary, NOT npx', () => {
  // Strip line + block comments before checking for actual npx invocations.
  const codeOnly = buildScript
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\bnpx\b/.test(codeOnly), `build-editor.js code must not invoke npx`);
  assert.match(buildScript, /node_modules.*\.bin.*esbuild/, 'must call node_modules/.bin/esbuild directly');
});

test('D5-EB-03: codemirror-bundle.js is checked into the repo (no rebuild required at runtime)', () => {
  const bundle = path.join(REPO, 'public', 'lib', 'codemirror', 'codemirror-bundle.js');
  const stat = fs.statSync(bundle);
  assert.ok(stat.size > 100000, `codemirror-bundle.js must be a real bundle, not a stub. size: ${stat.size}`);
});
