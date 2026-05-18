'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { post } = require('../helpers/http-client');
const { connectWs } = require('../helpers/ws-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

test('WS-01: nonexistent session sends error and closes', async () => {
  const c = await connectWs('/ws/wb_nonexistent_xyz');
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(c.msgs.some((m) => m.includes('No tmux session')));
  c.close();
});

test('WS-02/03: bidirectional terminal flow', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /data/workspace/ws_proj');
  await post('/api/projects', { path: '/data/workspace/ws_proj', name: 'ws_proj' });
  const r = await post('/api/terminals', { project: 'ws_proj' });
  assert.equal(r.status, 200, `Terminal creation failed: ${JSON.stringify(r.data)}`);
  // Wait for tmux session to initialize
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const c = await connectWs(`/ws/${r.data.tmux}`);
  // Wait for bash prompt to initialize before sending command
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (c.msgs.join('').includes('$') || c.msgs.join('').includes('workbench@')) break;
  }
  c.msgs.length = 0; // Clear prompt output
  c.send('echo test_ws_bidirectional\r');
  await new Promise((r) => setTimeout(r, 3000));
  const output = c.msgs.join('');
  assert.ok(
    output.includes('test_ws_bidirectional'),
    `Expected output to contain test string, got: ${output.substring(0, 200)}`,
  );
  c.close();
});

// #643: the #483 fix changes the WS connection lifecycle to issue
// `tmux resize-window` to the client's reported xterm dims BEFORE
// `tmuxCaptureScrollback` runs, so the captured bytes encode the layout at
// the client's actual width. Mock WS-13 pins the order (resize-call index
// strictly less than capture-call index). This live test pins the behavioral
// outcome at the live integration surface: WS connect with ?cols=X&rows=Y
// must result in the tmux pane being at those dims by the time the capture
// fires. Both the early resize and the subsequent PTY attach put the pane
// at the requested dims, so post-connect dims matching is a necessary
// condition for the fix; without resize-window, the captured-then-replayed
// scrollback would encode the pre-resize 200x50 layout (the original bug).
test('WS-04: WS connect with ?cols=X&rows=Y resizes tmux pane (#483 resize-before-capture)', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /data/workspace/ws_resize_proj');
  await post('/api/projects', { path: '/data/workspace/ws_resize_proj', name: 'ws_resize_proj' });
  const r = await post('/api/terminals', { project: 'ws_resize_proj' });
  assert.equal(r.status, 200, `Terminal creation failed: ${JSON.stringify(r.data)}`);
  const tmuxSess = r.data.tmux;

  // Wait for tmux session to register so display-message can query it.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Sanity-check the initial pane is at the new-session default 200x50
  // (per src/safe-exec.js tmuxCreateCLI / tmuxCreateCLIAsync). This anchors
  // the post-connect assertion below — without it, "post is 180x60" could
  // be a coincidence if the default ever changed.
  const dimsInit = dockerExec(
    `tmux display-message -t ${tmuxSess} -p '#{window_width}x#{window_height}'`,
  );
  assert.equal(
    dimsInit,
    '200x50',
    `pre-WS-connect tmux pane must be at 200x50 default; got '${dimsInit}'`,
  );

  // Connect WS with non-default cols/rows. Per #483: server's handleUpgrade
  // parses ?cols=X&rows=Y → initialDims; handleTerminalConnection issues
  // `tmux resize-window` BEFORE tmuxCaptureScrollback, then spawns the PTY
  // at the same dims. The first WS message after open is the captured
  // scrollback bytes.
  const c = await connectWs(`/ws/${tmuxSess}?cols=180&rows=60`);
  // Allow the resize → capture → PTY-attach sequence to finish before we
  // query tmux dims.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const dimsAfter = dockerExec(
    `tmux display-message -t ${tmuxSess} -p '#{window_width}x#{window_height}'`,
  );
  assert.equal(
    dimsAfter,
    '180x60',
    `post-WS-connect tmux pane must reflect ?cols=180&rows=60; got '${dimsAfter}'`,
  );

  // tmuxCaptureScrollback runs after the resize; its bytes are sent as a WS
  // message. The capture may be empty if the bash prompt hasn't rendered
  // yet, but the WS itself must be alive and accepting messages — the
  // ws.onmessage handler proves the bridge survived the resize step.
  assert.ok(c.ws.readyState === 1, `WS readyState must be OPEN(1) after connect; got ${c.ws.readyState}`);

  c.close();
});
