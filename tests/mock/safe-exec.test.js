'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const childProcess = require('node:child_process');
const fsp = require('fs/promises');
const fixtures = require('../fixtures/test-data');
const { freshRequire } = require('../helpers/module');

const SAFE_PATH = path.join(__dirname, '..', '..', 'src', 'safe-exec.js');

function freshSafe(env = {}) {
  const prev = {
    WORKSPACE: process.env.WORKSPACE,
    CLAUDE_HOME: process.env.CLAUDE_HOME,
    HOME: process.env.HOME,
  };
  Object.assign(process.env, env);
  const safe = freshRequire(SAFE_PATH);
  return {
    safe,
    restore() {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

test('SAF-01: resolveProjectPath joins WORKSPACE correctly', () => {
  const { safe, restore } = freshSafe({ HOME: '/data' });
  try {
    // Default WORKSPACE = join(HOME, 'workspace') where HOME defaults to /data
    assert.equal(safe.resolveProjectPath('proj'), path.resolve('/data/workspace', 'proj'));
  } finally {
    restore();
  }
});

test('SAF-02: sanitizeTmuxName strips non-alphanumeric', () => {
  const { safe, restore } = freshSafe();
  try {
    assert.equal(safe.sanitizeTmuxName(fixtures.safeExec.tmuxDirtyName), 'a_b_c_d');
  } finally {
    restore();
  }
});

test('SAF-03: shellEscape prevents injection', () => {
  const { safe, restore } = freshSafe();
  try {
    const escaped = safe.shellEscape(fixtures.safeExec.maliciousShellInput);
    assert.equal(escaped, `''\\''; rm -rf /; '\\'''`);
  } finally {
    restore();
  }
});

test('SAF-04: claudeExecAsync propagates timeout error', async (t) => {
  t.mock.method(childProcess, 'execFile', (_c, _a, _o, cb) =>
    cb(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
  );
  const { safe, restore } = freshSafe();
  try {
    await assert.rejects(safe.claudeExecAsync(['--print'], { timeout: 1 }), /timeout/);
  } finally {
    restore();
  }
});

test('SAF-05: tmuxExecAsync rejects on error', async (t) => {
  t.mock.method(childProcess, 'execFile', (_c, _a, _o, cb) => cb(new Error('tmux failed')));
  const { safe, restore } = freshSafe();
  try {
    await assert.rejects(safe.tmuxExecAsync(['bad']), /tmux failed/);
  } finally {
    restore();
  }
});

test('SAF-06: findSessionsDir encodes project path correctly', () => {
  const { safe, restore } = freshSafe({ CLAUDE_HOME: '/tmp/ch' });
  try {
    assert.equal(
      safe.findSessionsDir('/my/project'),
      path.join('/tmp/ch', 'projects', '-my-project'),
    );
  } finally {
    restore();
  }
});

test('SAF-07: gitCloneAsync rejects invalid URL and accepts valid', async (t) => {
  t.mock.method(childProcess, 'execFile', (_c, _a, _o, cb) => cb(null, 'cloned', ''));
  const { safe, restore } = freshSafe();
  try {
    await assert.rejects(
      safe.gitCloneAsync(fixtures.safeExec.invalidGitUrl, '/tmp/out'),
      /Invalid git URL/,
    );
    assert.equal(await safe.gitCloneAsync(fixtures.safeExec.validGitUrl, '/tmp/out'), 'cloned');
  } finally {
    restore();
  }
});

test('SAF-08: tmuxKill ignores session-not-found and no-server-running', async (t) => {
  t.mock.method(childProcess, 'execFile', (_c, _a, _o, cb) => cb(new Error('session not found')));
  const { safe, restore } = freshSafe();
  try {
    await assert.doesNotReject(safe.tmuxKill('missing'));
  } finally {
    restore();
  }
});

test('SAF-09: tmuxSendKeysAsync writes temp file, load-buffer, paste-buffer, send-keys Enter, cleans up', async (t) => {
  const calls = [];
  t.mock.method(childProcess, 'execFile', (_c, args, _o, cb) => {
    calls.push(args);
    cb(null, '', '');
  });
  const { safe, restore } = freshSafe();
  try {
    await safe.tmuxSendKeysAsync('sess', fixtures.safeExec.sendText);
    assert.equal(calls.length, 3);
    assert.equal(calls[0][0], 'load-buffer');
    assert.equal(calls[1][0], 'paste-buffer');
    assert.ok(calls[1].includes('-t'));
    assert.equal(calls[2][0], 'send-keys');
    assert.ok(calls[2].includes('Enter'));
  } finally {
    restore();
  }
});

// #349 [C8]: SAF-10/SAF-11 deleted with grepSearchAsync/curlFetchAsync.

test('SAF-12: tmuxCreateBash calls tmuxExecSync for new-session, mouse, history-limit, allow-passthrough, terminal-features', (t) => {
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (_c, args, _o) => {
    calls.push(args.slice());
    return '';
  });
  const { safe, restore } = freshSafe();
  try {
    safe.tmuxCreateBash('my/session', '/some/cwd');
    // 5 calls: new-session, set-option mouse, set-option history-limit,
    // set-option allow-passthrough, set-option -as terminal-features
    // (last two added in #240 for OSC 8 hyperlink passthrough).
    assert.equal(calls.length, 5);
    assert.equal(calls[0][0], 'new-session');
    assert.ok(calls[0].includes('my_session'));
    assert.ok(calls[0][calls[0].length - 1].includes('exec bash'));
    assert.equal(calls[1][0], 'set-option');
    assert.ok(calls[1].includes('mouse'));
    assert.equal(calls[2][0], 'set-option');
    assert.ok(calls[2].includes('history-limit'));
    assert.equal(calls[3][0], 'set-option');
    assert.ok(calls[3].includes('allow-passthrough'));
    assert.equal(calls[4][0], 'set-option');
    assert.ok(calls[4].includes('terminal-features'));
  } finally {
    restore();
  }
});

// #342 [A17]: WORKBENCH_SESSION_ID env injection. The pure cmd-builder is
// the testable unit; the spawn-side test verifies it lands in the new-session
// command argv passed to tmux.
test('SAF-13: buildTmuxLaunchCmd includes WORKBENCH_SESSION_ID export when opts.workbenchSessionId is set', () => {
  const { safe, restore } = freshSafe();
  try {
    const cmd = safe.buildTmuxLaunchCmd('/some/cwd', 'claude', [], { workbenchSessionId: 'abc-123' });
    assert.match(cmd, /export WORKBENCH_SESSION_ID='abc-123'/);
  } finally {
    restore();
  }
});

test('SAF-14: buildTmuxLaunchCmd omits WORKBENCH_SESSION_ID when not provided', () => {
  const { safe, restore } = freshSafe();
  try {
    const cmd = safe.buildTmuxLaunchCmd('/some/cwd', 'claude', []);
    assert.ok(!cmd.includes('WORKBENCH_SESSION_ID'), `cmd should not contain the var: ${cmd}`);
  } finally {
    restore();
  }
});

test('SAF-15: buildTmuxLaunchCmd shell-escapes a session id with single quotes', () => {
  const { safe, restore } = freshSafe();
  try {
    // shellEscape wraps the value in single quotes and escapes embedded ones.
    const cmd = safe.buildTmuxLaunchCmd('/some/cwd', 'claude', [], { workbenchSessionId: "id'with'quotes" });
    // Must not produce an unbalanced or injectable shell string.
    assert.match(cmd, /WORKBENCH_SESSION_ID='id'\\''with'\\''quotes'/);
  } finally {
    restore();
  }
});

test('SAF-16: tmuxCreateCLI passes WORKBENCH_SESSION_ID through to tmux new-session command', (t) => {
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (_c, args, _o) => {
    calls.push(args.slice());
    return '';
  });
  const { safe, restore } = freshSafe();
  try {
    safe.tmuxCreateCLI('wb_test', '/some/cwd', 'claude', [], { workbenchSessionId: 'sess-xyz' });
    const newSessionCall = calls[0];
    assert.equal(newSessionCall[0], 'new-session');
    const cmd = newSessionCall[newSessionCall.length - 1];
    assert.match(cmd, /export WORKBENCH_SESSION_ID='sess-xyz'/);
  } finally {
    restore();
  }
});

test('SAF-13: tmuxKill logs debug on unexpected error', async (t) => {
  t.mock.method(childProcess, 'execFile', (_c, _a, _o, cb) => cb(new Error('permission denied')));
  const { safe, restore } = freshSafe();
  try {
    // unexpected error (not session-not-found / no-server-running / error-connecting-to)
    // must not throw — the error is swallowed after logging
    await assert.doesNotReject(safe.tmuxKill('mysession'));
  } finally {
    restore();
  }
});

test('SAF-14: tmuxSendKeysAsync logs debug on non-ENOENT cleanup error', async (t) => {
  t.mock.method(childProcess, 'execFile', (_c, args, _o, cb) => {
    cb(null, '', '');
  });
  // mock unlink BEFORE freshSafe so the fresh require destructures the mock
  const origUnlink = fsp.unlink;
  fsp.unlink = async () => {
    const err = new Error('EPERM: operation not permitted');
    err.code = 'EPERM';
    throw err;
  };
  const { safe, restore } = freshSafe();
  try {
    // should not throw — cleanup error is caught and logged
    await assert.doesNotReject(safe.tmuxSendKeysAsync('sess', fixtures.safeExec.sendText));
  } finally {
    fsp.unlink = origUnlink;
    restore();
  }
});

test('SAF-15: tmuxSendKeyAsync sends named key to tmux session', async (t) => {
  const calls = [];
  t.mock.method(childProcess, 'execFile', (_c, args, _o, cb) => {
    calls.push(args.slice());
    cb(null, '', '');
  });
  const { safe, restore } = freshSafe();
  try {
    await safe.tmuxSendKeyAsync('my/session', 'Escape');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'send-keys');
    assert.ok(calls[0].includes('-t'));
    assert.ok(calls[0].includes('my_session'));
    assert.ok(calls[0].includes('Escape'));
  } finally {
    restore();
  }
});

// #346 [C4]: tmuxNamePrefix is the documented inverse of tmuxNameFor's
// 12-char id window. ws-terminal's auto-respawn relies on this round-trip
// for db.getSessionByPrefix() lookups.
test('SAF-NP-01: tmuxNamePrefix returns the same window as the magic-number slice', () => {
  const { safe, restore } = freshSafe();
  try {
    const name = safe.tmuxNameFor('abc-123-some-long-session-id');
    assert.equal(safe.tmuxNamePrefix(name), name.slice(3, 15));
  } finally {
    restore();
  }
});

test('SAF-NP-02: tmuxNamePrefix recovers the truncated session id', () => {
  const { safe, restore } = freshSafe();
  try {
    const sessionId = 'session-1234567890-extra';
    const name = safe.tmuxNameFor(sessionId);
    // tmuxNameFor uses sessionId.substring(0, 12); sanitizeTmuxName keeps
    // alphanumerics, `_`, and `-`, so for an all-printable ASCII id the
    // prefix is just the first-12-chars window unchanged.
    assert.equal(safe.tmuxNamePrefix(name), sessionId.substring(0, 12));
  } finally {
    restore();
  }
});
