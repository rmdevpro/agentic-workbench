'use strict';

// D10 #359: session_resume_post_compact drops the timestamp suffix on the
// /tmp resume file (overwrite per session_id) + sweeps stale files >24h.

const test = require('node:test');
const assert = require('node:assert/strict');
const { post } = require('../helpers/http-client');
const { dockerExec } = require('../helpers/reset-state');

function listResumeFiles() {
  try {
    const out = dockerExec(`ls -1 /tmp 2>/dev/null | grep '^workbench-resume-' || true`).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

test('D10-LIVE-01: 100 resume calls for the same session_id produce ≤1 tmp file with that id', async () => {
  // Clean prior state
  dockerExec(`rm -f /tmp/workbench-resume-d10-*.txt 2>/dev/null || true`);
  const sid = `d10-test-${Date.now()}`;

  // Fire 100 calls. session_resume_post_compact tolerates a session that
  // doesn't exist (returns a tail-not-found message) so we don't need a real
  // running session here — the file-write side-effect is what we assert.
  for (let i = 0; i < 100; i++) {
    const r = await post('/api/mcp/call', {
      tool: 'session_resume_post_compact',
      args: { session_id: sid, tail_lines: 5 },
    });
    assert.ok(r.status === 200 || r.status === 404, `call ${i + 1}: ${r.status} ${JSON.stringify(r.data)}`);
  }

  const files = listResumeFiles().filter((f) => f.includes(sid));
  assert.equal(files.length, 1, `expected exactly 1 resume file for ${sid}, got ${files.length}: ${JSON.stringify(files)}`);
  assert.equal(files[0], `workbench-resume-${sid}.txt`, `filename must use session_id (no timestamp suffix). got: ${files[0]}`);
});

test('D10-LIVE-02: stale resume files (>24h) are swept on next call', async () => {
  // Plant a fake resume file with mtime 25h ago
  const stalePath = '/tmp/workbench-resume-d10-stale-fixture.txt';
  dockerExec(`bash -c "touch -d '25 hours ago' ${stalePath} 2>/dev/null || (touch ${stalePath} && touch -t \\\$(date -d '25 hours ago' '+%Y%m%d%H%M' 2>/dev/null || date -v -25H '+%Y%m%d%H%M' 2>/dev/null) ${stalePath})"`);
  // Verify the plant succeeded
  const before = listResumeFiles();
  assert.ok(before.includes('workbench-resume-d10-stale-fixture.txt'), `stale fixture must be present. files: ${JSON.stringify(before)}`);

  // Trigger a resume call to force the sweep
  await post('/api/mcp/call', {
    tool: 'session_resume_post_compact',
    args: { session_id: 'd10-sweep-trigger', tail_lines: 5 },
  });

  const after = listResumeFiles();
  assert.ok(!after.includes('workbench-resume-d10-stale-fixture.txt'),
    `stale fixture must be swept after a resume call. remaining: ${JSON.stringify(after)}`);
});
