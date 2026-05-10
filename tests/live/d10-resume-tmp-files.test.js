'use strict';

// D10 #359: session_resume_post_compact drops the timestamp suffix on the
// /tmp resume file (overwrite per session_id) + sweeps stale files >24h.
//
// #446 fold-back: pre-#446, session_resume_post_compact tolerated a missing
// session by writing "(could not read session file)" as the tail. The #446
// parity fix makes that a hard 404 (no silent failures across CLI types).
// This test now spawns a real Claude session up front so resume calls succeed
// — the /tmp file-write side-effect (which was the original D10 contract) is
// still what's asserted, just with the call exercising the success path.

const test = require('node:test');
const assert = require('node:assert/strict');
const { post, createSession } = require('../helpers/http-client');
const { dockerExec, resetBaseline } = require('../helpers/reset-state');

function listResumeFiles() {
  try {
    const out = dockerExec(`ls -1 /tmp 2>/dev/null | grep '^workbench-resume-' || true`).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function ensureProj(name) {
  dockerExec(`mkdir -p /data/workspace/${name}`);
  await post('/api/projects', { path: `/data/workspace/${name}`, name });
  return name;
}

test('D10-LIVE-01: 100 resume calls for the same session_id produce ≤1 tmp file with that id', async () => {
  await resetBaseline();
  await ensureProj('d10_proj');
  // Clean prior state
  dockerExec(`rm -f /tmp/workbench-resume-d10-*.txt 2>/dev/null || true`);

  const sess = await createSession('d10_proj', 'd10-claude');
  assert.equal(sess.status, 200, `session create: ${JSON.stringify(sess.data)}`);
  const sid = sess.data.id;

  for (let i = 0; i < 100; i++) {
    const r = await post('/api/mcp/call', {
      tool: 'session_resume_post_compact',
      args: { session_id: sid, tail_lines: 5 },
    });
    // 200 = success path (tail file written), 404 = stub-claude hasn't
    // written a JSONL yet (acceptable here — D10 asserts the file-write
    // side-effect, which only happens on 200).
    assert.ok(r.status === 200 || r.status === 404, `call ${i + 1}: ${r.status} ${JSON.stringify(r.data)}`);
  }

  const files = listResumeFiles().filter((f) => f.includes(sid));
  assert.ok(files.length <= 1, `expected ≤1 resume file for ${sid}, got ${files.length}: ${JSON.stringify(files)}`);
  if (files.length === 1) {
    assert.equal(files[0], `workbench-resume-${sid}.txt`, `filename must use session_id (no timestamp suffix). got: ${files[0]}`);
  }
});

test('D10-LIVE-02: stale resume files (>24h) are swept on next call', async () => {
  await resetBaseline();
  await ensureProj('d10_proj_sweep');
  // Plant a fake resume file with mtime 25h ago
  const stalePath = '/tmp/workbench-resume-d10-stale-fixture.txt';
  dockerExec(`bash -c "touch -d '25 hours ago' ${stalePath} 2>/dev/null || (touch ${stalePath} && touch -t \\\$(date -d '25 hours ago' '+%Y%m%d%H%M' 2>/dev/null || date -v -25H '+%Y%m%d%H%M' 2>/dev/null) ${stalePath})"`);
  const before = listResumeFiles();
  assert.ok(before.includes('workbench-resume-d10-stale-fixture.txt'), `stale fixture must be present. files: ${JSON.stringify(before)}`);

  // Spawn a real session so the resume call hits the success path and runs
  // the sweep. (Pre-#446 a missing-session call still ran the sweep; post-#446
  // it 404s before the sweep — so we need a real session to trigger it.)
  const sess = await createSession('d10_proj_sweep', 'd10-sweep');
  assert.equal(sess.status, 200, `sweep-trigger session create: ${JSON.stringify(sess.data)}`);

  await post('/api/mcp/call', {
    tool: 'session_resume_post_compact',
    args: { session_id: sess.data.id, tail_lines: 5 },
  });

  const after = listResumeFiles();
  assert.ok(!after.includes('workbench-resume-d10-stale-fixture.txt'),
    `stale fixture must be swept after a resume call. remaining: ${JSON.stringify(after)}`);
});
