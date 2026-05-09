'use strict';

// D3 #352: qdrant stderr prefixed + one-shot health check writes marker on failure.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ENTRYPOINT = fs.readFileSync(path.join(__dirname, '..', '..', 'entrypoint.sh'), 'utf-8');

test('D3-Q-01: entrypoint pipes qdrant stdio through qdrant: prefix', () => {
  assert.match(ENTRYPOINT, /sed -u 's\/\^\/qdrant: \/'/, 'qdrant logs must be sed-prefixed');
});

test('D3-Q-02: entrypoint hits localhost:6333/health after grace window', () => {
  assert.match(ENTRYPOINT, /curl -sf http:\/\/localhost:6333\/health/, 'health probe must hit /health');
});

test('D3-Q-03: entrypoint writes .qdrant-health marker on failure', () => {
  assert.match(ENTRYPOINT, /qdrant.*unhealthy.*qdrant-health|qdrant-health.*unhealthy/, 'failure marker must be written');
  assert.match(ENTRYPOINT, /WB_DATA/, 'marker path must use WB_DATA');
});

test('D3-Q-04: qdrant runs in background; workbench start is not blocked', () => {
  // qdrant launches with `&` so the script proceeds to start workbench
  // independently. Probe runs in a subshell so it doesn't gate startup.
  assert.match(ENTRYPOINT, /qdrant --disable-telemetry.*&/);
});
