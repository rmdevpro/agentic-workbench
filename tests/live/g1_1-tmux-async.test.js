'use strict';

// #444 [G1.1]: /api/sessions POST handler migrated from execFileSync tmux
// to async tmuxExecAsync. Pre-fix, a 5-session burst would block the event
// loop while each handler synchronously spawned 5 tmux commands (~25
// blocking sub-second IO operations interleaved). Post-fix, the handler
// awaits tmuxExecAsync and the loop stays responsive throughout.

const test = require('node:test');
const assert = require('node:assert/strict');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { post, createSession } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

test('G1.1-LIVE-01: event-loop p95 lag stays <80ms during 5-session burst (no sync tmux blocking)', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /data/workspace/g11_burst_proj');
  await post('/api/projects', { path: '/data/workspace/g11_burst_proj', name: 'g11_burst_proj' });

  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();

  // Fire 5 Claude session creates concurrently. Pre-fix this serializes
  // 25 execFileSync tmux calls on the event loop; post-fix all 25 are
  // execFile-with-callback so the loop continues running scheduled work.
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(createSession('g11_burst_proj', `g11-burst-${i}`));
  }

  // Hold the loop responsive for 4s while the burst lands and tmux spawns
  // run. Sampling continues throughout — so any sync-blocking spike during
  // the spawn window lands in the histogram.
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    await new Promise((r) => setTimeout(r, 50));
  }

  await Promise.all(promises);
  histogram.disable();

  const p95Ms = histogram.percentile(95) / 1e6;
  assert.ok(
    p95Ms < 80,
    `event-loop p95 lag must stay <80ms during 5-session burst (got ${p95Ms.toFixed(2)}ms). Pre-fix, sync execFileSync tmux calls blocked the loop and pushed this past 200ms.`,
  );
});
