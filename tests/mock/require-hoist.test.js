'use strict';

// #347 [C5]: AST-verified require() hoist for src/routes.js, src/mcp-tools.js,
// src/safe-exec.js. The corrective action plan calls for moving all in-
// function require() calls to module top so a future ESLint hard-error tier
// can flag any new ones. Grep can't tell `let r = require(...)` from a
// var-declaration, so we use acorn to walk the AST and check that every
// `CallExpression(callee=Identifier 'require')` has a Program-level
// VariableDeclaration ancestor (or is itself in a Program-level expression).
//
// Exception: lazy requires breaking circular imports. None currently
// identified — if one is needed in the future, add it to ALLOWED_LAZY below.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// acorn is a devDependency. Production containers run `npm ci --omit=dev`
// and don't ship it; skip the structural check there.
let acorn;
try { acorn = require('acorn'); }
catch { /* devDep missing — skip */ }
if (!acorn) {
  test('HOIST: skipped (acorn devDep not installed)', { skip: true }, () => {});
  return;
}

const FILES = [
  path.join(__dirname, '..', '..', 'src', 'routes.js'),
  path.join(__dirname, '..', '..', 'src', 'mcp-tools.js'),
  path.join(__dirname, '..', '..', 'src', 'safe-exec.js'),
];

// path → set of source-line numbers where lazy require() is allowed.
// Empty for now; populate if a circular-import workaround needs an
// in-function require.
const ALLOWED_LAZY = new Map();

function walkRequires(node, parents = []) {
  const out = [];
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const c of node) out.push(...walkRequires(c, parents));
    return out;
  }
  if (
    node.type === 'CallExpression' &&
    node.callee && node.callee.type === 'Identifier' && node.callee.name === 'require'
  ) {
    out.push({ node, parents: parents.slice() });
  }
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
    const v = node[k];
    if (v && typeof v === 'object') {
      out.push(...walkRequires(v, parents.concat(node)));
    }
  }
  return out;
}

function topLevelAncestor(parents) {
  // parents are in walk order [Program, ..., immediate-parent-of-CallExpression].
  // A "top-level" require lives directly inside a Program-level VariableDeclaration
  // or ExpressionStatement (the latter for `require('side-effect')` imports).
  for (let i = 0; i < parents.length - 1; i += 1) {
    const p = parents[i];
    const child = parents[i + 1];
    if (p.type === 'Program') {
      // child is the top-level statement containing this require.
      // Allowed shapes at the top: VariableDeclaration, ExpressionStatement.
      return child.type;
    }
  }
  return null;
}

for (const filePath of FILES) {
  const fileName = path.basename(filePath);
  test(`HOIST-${fileName}: every require() lives at Program level`, () => {
    const src = fs.readFileSync(filePath, 'utf-8');
    const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
    const requires = walkRequires(ast);
    assert.ok(requires.length > 0, `expected ${fileName} to import something`);

    const allowed = ALLOWED_LAZY.get(filePath) || new Set();
    const violations = [];
    for (const { node, parents } of requires) {
      const topType = topLevelAncestor(parents);
      const inTop = topType === 'VariableDeclaration' || topType === 'ExpressionStatement';
      const line = node.loc && node.loc.start ? node.loc.start.line : '?';
      if (!inTop && !allowed.has(line)) {
        violations.push(`${fileName}:${line} — require() inside ${topType || 'non-Program scope'}`);
      }
    }
    assert.equal(violations.length, 0, `inline require() calls found:\n${violations.join('\n')}`);
  });
}
