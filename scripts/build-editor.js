#!/usr/bin/env node
'use strict';
// #354 [D5]: call the pinned local esbuild binary directly. Was `npx esbuild`
// which fetches at build time and tied us to network availability + the
// latest esbuild release behaviour.
const { execFileSync } = require('child_process');
const { join } = require('path');

const root = join(__dirname, '..');
const esbuildBin = join(root, 'node_modules', '.bin', 'esbuild');
execFileSync(
  esbuildBin,
  [
    'scripts/codemirror-entry.js',
    '--bundle',
    '--format=iife',
    '--global-name=CM',
    '--outfile=public/lib/codemirror/codemirror-bundle.js',
    '--minify',
  ],
  { cwd: root, stdio: 'inherit' },
);
console.log('CodeMirror bundle built.');
