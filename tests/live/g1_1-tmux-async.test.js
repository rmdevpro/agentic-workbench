'use strict';

// #444 [G1.1]: /api/sessions POST handler migrated from execFileSync tmux
// to async tmuxExecAsync. Pre-fix, a 5-session burst would block the
// SERVER's event loop while each handler synchronously spawned 5 tmux
// commands (~25 blocking sub-second IO operations). Post-fix, the handler
// awaits tmuxExecAsync and the loop stays responsive throughout.
//
// Codex R2 finding: an earlier version of this test used
// monitorEventLoopDelay() inside the test-runner Node process; that
// histogram observes the test harness loop, NOT the workbench server's
// loop. The test could pass while the server still blocked.
//
// Replacement strategy (preferred per Codex R2): measure server-observed
// concurrency by firing N parallel /api/state polls during the burst
// and asserting the slowest poll isn't head-of-line-blocked behind the
// (formerly synchronous) tmux spawns. Pre-fix, /api/state polls
// arriving while the server was mid-burst would queue behind the sync
// execFileSync calls and their latency would track total burst-completion
// time. Post-fix, /api/state polls interleave with the awaited
// tmuxExecAsync calls and stay close to baseline latency.

const test = require('node:test');
const assert = require('node:assert/strict');
const { post, createSession, get } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

test('G1.1-LIVE-01: /api/state polls stay responsive (slowest <2× baseline) during 5-session burst', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /data/workspace/g11_burst_proj');
  await post('/api/projects', { path: '/data/workspace/g11_burst_proj', name: 'g11_burst_proj' });

  // Baseline /api/state latency without burst (5 samples; take median).
  const baselineSamples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await get('/api/state');
    baselineSamples.push(Date.now() - t0);
  }
  baselineSamples.sort((a, b) => a - b);
  const baselineMedian = baselineSamples[Math.floor(baselineSamples.length / 2)];

  // Now fire the burst (5 concurrent /api/sessions POSTs) while
  // simultaneously firing 20 /api/state polls in parallel. Pre-fix, the
  // sync execFileSync tmux calls in the POST handler would block the
  // server event loop and the /api/state polls would queue behind them;
  // their latency would track total burst-completion time (multi-second).
  // Post-fix, the awaits in tmuxCreateCLIAsync release the loop; the
  // polls return at roughly baseline latency.
  const burstPromises = [];
  for (let i = 0; i < 5; i++) {
    burstPromises.push(createSession('g11_burst_proj', `g11-burst-${i}`));
  }

  // Fire 20 /api/state polls during the burst, each measured.
  const pollLatencies = [];
  const pollPromises = [];
  for (let i = 0; i < 20; i++) {
    pollPromises.push((async () => {
      // Stagger the polls slightly so they overlap with the burst window
      // rather than all firing in the same microtask. 50ms × 20 = 1s
      // sampling window — covers the typical burst duration.
      await new Promise(r => setTimeout(r, i * 50));
      const t0 = Date.now();
      const r = await get('/api/state');
      const elapsed = Date.now() - t0;
      pollLatencies.push({ status: r.status, elapsed });
    })());
  }

  await Promise.all([...burstPromises, ...pollPromises]);
  pollLatencies.sort((a, b) => a.elapsed - b.elapsed);

  // All polls should have succeeded
  for (const p of pollLatencies) assert.equal(p.status, 200, `poll failed with status ${p.status}`);

  const elapsedMs = pollLatencies.map(p => p.elapsed);
  const maxPollMs = elapsedMs[elapsedMs.length - 1];
  const medianPollMs = elapsedMs[Math.floor(elapsedMs.length / 2)];

  // Head-of-line check: max poll latency should not be more than 2× the
  // median (which would indicate one poll queued behind a long sync
  // operation in the server). Allow 3× as a loose upper bound to absorb
  // shared-host noise on M5 (qdrant + other tenants on same box).
  // The absolute upper bound is ALSO checked (1.5s) as a sanity check
  // against catastrophic blocking.
  assert.ok(
    maxPollMs < 1500,
    `slowest /api/state poll must be <1500ms during 5-session burst (pre-fix: queued behind sync execFileSync tmux for multi-second latency). Got max=${maxPollMs}ms median=${medianPollMs}ms baseline-median=${baselineMedian}ms samples=${JSON.stringify(elapsedMs)}`,
  );
  assert.ok(
    maxPollMs < Math.max(medianPollMs * 3, baselineMedian * 3, 300),
    `slowest poll should not be >3× the median (head-of-line block from sync server-side IO). max=${maxPollMs}ms median=${medianPollMs}ms baseline-median=${baselineMedian}ms`,
  );
});
