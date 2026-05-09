'use strict';

// #361 [L1]: catalog/handler shape parity. The MCP catalog (used by
// mcp-server.js for tools/list) must list exactly the tools that
// mcp-tools.js exposes as handlers. Any drift means a tool is either
// invisible to MCP clients (handler-without-schema) or unreachable
// (schema-without-handler).

const test = require('node:test');
const assert = require('node:assert/strict');
const { TOOLS, CATALOG_NAMES } = require('../../src/mcp-catalog.js');
const { TOOL_NAMES, handlers } = require('../../src/mcp-tools.js');

test('CATALOG-01: every TOOLS entry has a name + inputSchema', () => {
  for (const t of TOOLS) {
    assert.ok(typeof t.name === 'string' && t.name.length > 0, `tool entry missing name: ${JSON.stringify(t)}`);
    assert.ok(t.inputSchema && t.inputSchema.type === 'object', `tool ${t.name} missing inputSchema`);
  }
});

test('CATALOG-02: catalog and handler-map are name-equal', () => {
  const catalogSet = new Set(CATALOG_NAMES);
  const handlerSet = new Set(TOOL_NAMES);
  const catalogMissing = [...handlerSet].filter(n => !catalogSet.has(n));
  const handlerMissing = [...catalogSet].filter(n => !handlerSet.has(n));
  assert.deepEqual(
    { catalogMissing, handlerMissing },
    { catalogMissing: [], handlerMissing: [] },
    `catalog/handler drift — schema-without-handler: ${handlerMissing.join(', ')}; handler-without-schema: ${catalogMissing.join(', ')}`,
  );
});

test('CATALOG-03: every catalog name has a callable handler', () => {
  for (const name of CATALOG_NAMES) {
    assert.equal(typeof handlers[name], 'function', `handler missing for ${name}`);
  }
});
