'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const createKeepalive = require('../../src/keepalive.js');

async function makeEnv({
  credentials,
  configValues = {},
  prompts = {},
  claudeResponses = [],
} = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-ka-'));
  const claudeHome = path.join(root, 'claude');
  const workspace = path.join(root, 'workspace');
  await fsp.mkdir(claudeHome, { recursive: true });
  await fsp.mkdir(workspace, { recursive: true });
  if (credentials !== undefined) {
    await fsp.writeFile(
      path.join(claudeHome, '.credentials.json'),
      typeof credentials === 'string' ? credentials : JSON.stringify(credentials),
    );
  }
  const claudeCalls = [];
  const safe = {
    WORKSPACE: workspace,
    CLAUDE_HOME: claudeHome,
    // #588: createKeepalive reads `safe.HOME` to compute the Gemini OAuth
    // creds path (`<HOME>/.gemini/oauth_creds.json`). Without this the
    // factory throws `path argument must be of type string` at module load.
    HOME: root,
    claudeExecAsync: async (args) => {
      claudeCalls.push(args);
      if (claudeResponses.length) {
        const n = claudeResponses.shift();
        if (n instanceof Error) throw n;
        return n;
      }
      return 'default response';
    },
  };
  const config = { get: (k, fb) => configValues[k] ?? fb, getPrompt: (n) => prompts[n] ?? '' };
  const logs = [];
  const logger = {
    info: (m) => logs.push({ level: 'info', msg: m }),
    warn: (m) => logs.push({ level: 'warn', msg: m }),
    error: (m) => logs.push({ level: 'error', msg: m }),
  };
  return { keepalive: createKeepalive({ safe, config, logger }), logs, claudeHome, claudeCalls };
}

test('KA-01 / KA-10: parses future token expiry and formats status', async () => {
  const env = await makeEnv({
    credentials: {
      claudeAiOauth: {
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: Date.now() + 10 * 60 * 1000,
      },
    },
  });
  const s = await env.keepalive.getStatus();
  assert.ok(s.token_expires_in_minutes >= 9);
  assert.ok('running' in s);
  assert.ok('mode' in s);
  assert.ok('token_expires_at' in s);
});

test('KA-02: missing credentials returns zero expiry', async () => {
  const env = await makeEnv({});
  const s = await env.keepalive.getStatus();
  assert.equal(s.token_expires_in_minutes, 0);
});

test('KA-03: malformed credentials logs warning and returns zero', async () => {
  const env = await makeEnv({ credentials: '{"bad": }' });
  const s = await env.keepalive.getStatus();
  assert.equal(s.token_expires_in_minutes, 0);
  assert.ok(env.logs.some((l) => l.level === 'warn' && /invalid JSON/.test(l.msg)));
});

test('KA-07: start/stop changes running state', async () => {
  const env = await makeEnv({ credentials: { claudeAiOauth: { expiresAt: Date.now() + 60000 } } });
  assert.equal(env.keepalive.isRunning(), false);
  env.keepalive.start();
  assert.equal(env.keepalive.isRunning(), true);
  env.keepalive.stop();
  assert.equal(env.keepalive.isRunning(), false);
});

test('KA-08: browser mode starts on connect, stops on disconnect(0)', async () => {
  const env = await makeEnv({ credentials: { claudeAiOauth: { expiresAt: Date.now() + 60000 } } });
  env.keepalive.setMode('browser');
  assert.equal(env.keepalive.isRunning(), false);
  env.keepalive.onBrowserConnect();
  assert.equal(env.keepalive.isRunning(), true);
  env.keepalive.onBrowserDisconnect(0);
  assert.equal(env.keepalive.isRunning(), false);
});

test('KA-09: idle mode stops after timeout when no browsers', async () => {
  const env = await makeEnv({
    credentials: { claudeAiOauth: { expiresAt: Date.now() + 60000 } },
  });
  env.keepalive.setMode('idle', 0.001);
  env.keepalive.onBrowserConnect();
  assert.equal(env.keepalive.isRunning(), true);
  env.keepalive.onBrowserDisconnect(0);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(env.keepalive.isRunning(), false);
});

test('setMode updates mode', async () => {
  const env = await makeEnv({});
  env.keepalive.setMode('always');
  assert.equal(env.keepalive.getMode(), 'always');
  env.keepalive.setMode('browser');
  assert.equal(env.keepalive.getMode(), 'browser');
});

test('KA: claudeQuery failure returns null and logs error', async () => {
  const env = await makeEnv({
    credentials: { claudeAiOauth: { expiresAt: Date.now() - 10000 } },
    claudeResponses: [new Error('timeout')],
  });
  // Start with expired token triggers immediate doRefresh → claudeQuery throws
  env.keepalive.start();
  await new Promise((r) => setTimeout(r, 150));
  env.keepalive.stop();
  assert.ok(
    env.logs.some((l) => l.level === 'error' && /query failed/i.test(l.msg)),
    'Should log error when claude query throws',
  );
});

test('KA: start with expired token triggers immediate refresh', async () => {
  const env = await makeEnv({
    credentials: { claudeAiOauth: { expiresAt: Date.now() - 10000 } },
    claudeResponses: ['question?', 'answer!'],
  });
  env.keepalive.start();
  await new Promise((r) => setTimeout(r, 100));
  env.keepalive.stop();
  assert.ok(env.claudeCalls.length >= 1, 'Should have attempted claude queries');
  assert.ok(env.logs.some((l) => /expired|refreshing|refreshed/i.test(l.msg)));
});

test('KA: double start is idempotent', async () => {
  const env = await makeEnv({ credentials: { claudeAiOauth: { expiresAt: Date.now() + 60000 } } });
  env.keepalive.start();
  env.keepalive.start();
  assert.equal(env.keepalive.isRunning(), true);
  env.keepalive.stop();
});

test('KA: double stop is idempotent', async () => {
  const env = await makeEnv({});
  env.keepalive.stop();
  env.keepalive.stop();
  assert.equal(env.keepalive.isRunning(), false);
});

test('KA: idle mode reconnect cancels idle timer', async () => {
  const env = await makeEnv({
    credentials: { claudeAiOauth: { expiresAt: Date.now() + 60000 } },
  });
  env.keepalive.setMode('idle', 0.001);
  env.keepalive.onBrowserConnect();
  env.keepalive.onBrowserDisconnect(0);
  // Reconnect before idle timeout fires
  env.keepalive.onBrowserConnect();
  await new Promise((r) => setTimeout(r, 200));
  // Should still be running because reconnect cancelled the timer
  assert.equal(env.keepalive.isRunning(), true);
  env.keepalive.stop();
});
