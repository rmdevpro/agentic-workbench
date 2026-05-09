'use strict';

// A13 #338: session-resolver converted from sync fs to fs/promises.
// Verify the SERVER's event loop stays responsive during concurrent
// session creation.
//
// Codex R2 finding (paired with G1.1-LIVE-01): the prior version of
// this test used monitorEventLoopDelay() inside the test-runner Node
// process; that histogram observes the test harness loop, NOT the
// workbench server's loop. The test could pass while the server still
// blocked. Replaced with the same server-observed concurrency strategy
// used in G1.1-LIVE-01: fire concurrent /api/state polls during the
// session-creation burst and assert the slowest poll isn't head-of-
// line-blocked by sync resolver work.

const test = require('node:test');
const assert = require('node:assert/strict');
const { post, createSession, get } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

test('A13-LIVE-01: /api/state polls stay responsive during 6-session (3 Claude + 3 Gemini) burst', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /data/workspace/a13_loop_proj');
  await post('/api/projects', { path: '/data/workspace/a13_loop_proj', name: 'a13_loop_proj' });

  // Baseline /api/state latency without burst.
  const baselineSamples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await get('/api/state');
    baselineSamples.push(Date.now() - t0);
  }
  baselineSamples.sort((a, b) => a - b);
  const baselineMedian = baselineSamples[Math.floor(baselineSamples.length / 2)];

  // Burst: 3 Claude + 3 Gemini sessions in parallel — exercises the
  // session-resolver's polling window. Pre-fix, the resolver did sync
  // readdirs of ~/.claude/projects/<dir> per spawn; concurrent burst
  // would block the loop. Post-fix the readdirs are async and the loop
  // stays responsive.
  const burstPromises = [];
  for (let i = 0; i < 3; i++) {
    burstPromises.push(createSession('a13_loop_proj', `a13-claude-${i}`));
  }
  for (let i = 0; i < 3; i++) {
    burstPromises.push(post('/api/sessions', { project: 'a13_loop_proj', name: `a13-gemini-${i}`, prompt: `a13-gemini-${i}`, cli: 'gemini' }));
  }

  // Concurrent /api/state polls during the burst.
  const pollLatencies = [];
  const pollPromises = [];
  for (let i = 0; i < 20; i++) {
    pollPromises.push((async () => {
      await new Promise(r => setTimeout(r, i * 75));  // 1.5s sampling window
      const t0 = Date.now();
      const r = await get('/api/state');
      pollLatencies.push({ status: r.status, elapsed: Date.now() - t0 });
    })());
  }

  await Promise.all([...burstPromises, ...pollPromises]);
  pollLatencies.sort((a, b) => a.elapsed - b.elapsed);

  for (const p of pollLatencies) assert.equal(p.status, 200, `poll failed with status ${p.status}`);

  const elapsedMs = pollLatencies.map(p => p.elapsed);
  const maxPollMs = elapsedMs[elapsedMs.length - 1];
  const medianPollMs = elapsedMs[Math.floor(elapsedMs.length / 2)];

  assert.ok(
    maxPollMs < 1500,
    `slowest /api/state poll must be <1500ms during 6-session burst. Got max=${maxPollMs}ms median=${medianPollMs}ms baseline-median=${baselineMedian}ms samples=${JSON.stringify(elapsedMs)}`,
  );
  assert.ok(
    maxPollMs < Math.max(medianPollMs * 3, baselineMedian * 3, 300),
    `slowest poll should not be >3× the median (head-of-line block from sync server-side IO). max=${maxPollMs}ms median=${medianPollMs}ms baseline-median=${baselineMedian}ms`,
  );
});
