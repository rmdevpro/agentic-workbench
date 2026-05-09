'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const fixtures = require('../fixtures/test-data');
const { freshRequire } = require('../helpers/module');

async function setupEnv(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-su-'));
  const workspace = path.join(root, 'workspace');
  const claudeHome = path.join(root, 'claude');
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'config');
  const promptsDir = path.join(configDir, 'prompts');
  await fsp.mkdir(path.join(claudeHome, 'projects'), { recursive: true });
  await fsp.mkdir(workspace, { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(promptsDir, { recursive: true });
  await fsp.writeFile(
    path.join(configDir, 'defaults.json'),
    JSON.stringify(fixtures.validDefaultsJson, null, 2),
  );
  await fsp.writeFile(
    path.join(promptsDir, 'summarize-session.md'),
    fixtures.promptTemplates.summarizeSession,
  );

  const prev = {
    WORKSPACE: process.env.WORKSPACE,
    CLAUDE_HOME: process.env.CLAUDE_HOME,
    WORKBENCH_DATA: process.env.WORKBENCH_DATA,
    HOME: process.env.HOME,
  };
  process.env.WORKSPACE = workspace;
  process.env.CLAUDE_HOME = claudeHome;
  process.env.WORKBENCH_DATA = dataDir;
  // Pin HOME to the test root so discoverGemini/CodexSessions don't leak
  // into the host's real ~/.gemini/tmp or ~/.codex/sessions dirs and pollute
  // search/list results with sessions the test didn't create.
  process.env.HOME = root;
  const orig = { rfs: fs.readFileSync, rf: fs.readFile, wf: fs.watchFile };
  function rewrite(p) {
    const n = String(p).replace(/\\/g, '/');
    if (n.includes('/config/defaults.json')) return path.join(configDir, 'defaults.json');
    if (n.includes('/config/prompts/')) return path.join(promptsDir, path.basename(p));
    return p;
  }
  t.mock.method(fs, 'readFileSync', function (p, ...a) {
    return orig.rfs.call(this, rewrite(p), ...a);
  });
  t.mock.method(fs, 'readFile', function (p, ...a) {
    return orig.rf.call(this, rewrite(p), ...a);
  });
  t.mock.method(fs, 'watchFile', function (p, o, l) {
    return orig.wf.call(this, rewrite(p), o, l);
  });
  const db = freshRequire(path.join(__dirname, '../../src/db.js'));
  const safe = freshRequire(path.join(__dirname, '../../src/safe-exec.js'));
  freshRequire(path.join(__dirname, '../../src/config.js'));
  const su = freshRequire(path.join(__dirname, '../../src/session-utils.js'));
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  return { root, workspace, claudeHome, db, safe, su };
}

test('SU-01 / SES-15: parseSessionFile extracts name, timestamp, messageCount', async (t) => {
  const { su } = await setupEnv(t);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-sf-'));
  const file = path.join(dir, 'session.jsonl');
  await fsp.writeFile(file, fixtures.sessionUtilsValidLines.join('\n') + '\n');
  const parsed = await su.parseSessionFile(file);
  assert.equal(parsed.name, 'First user message');
  assert.equal(parsed.messageCount, 5);
  assert.ok(parsed.timestamp);
});

test('SU-02: cache hit avoids reparse when mtime/size unchanged', async (t) => {
  const { su } = await setupEnv(t);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-cache-'));
  const file = path.join(dir, 'cached.jsonl');
  await fsp.writeFile(file, fixtures.sessionUtilsValidLines.join('\n') + '\n');
  const first = await su.parseSessionFile(file);
  const second = await su.parseSessionFile(file);
  assert.deepEqual(first, second);
});

test('SU-03: summary entry overrides name', async (t) => {
  const { su } = await setupEnv(t);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-sum-'));
  const file = path.join(dir, 'summary.jsonl');
  await fsp.writeFile(file, fixtures.sessionUtilsSummaryOverrideLines.join('\n') + '\n');
  assert.equal((await su.parseSessionFile(file)).name, 'Human curated summary title');
});

test('SU-04: malformed JSONL lines tolerated', async (t) => {
  const { su } = await setupEnv(t);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-mal-'));
  const file = path.join(dir, 'bad.jsonl');
  await fsp.writeFile(file, fixtures.sessionUtilsMalformedLines.join('\n') + '\n');
  const parsed = await su.parseSessionFile(file);
  assert.equal(parsed.name, 'Good line');
  assert.equal(parsed.messageCount, 2);
});

test('SU-09 / SU-10: getTokenUsage uses last real assistant, ignores synthetic; max_tokens null per #286', async (t) => {
  const { db, safe, su } = await setupEnv(t);
  const p = db.ensureProject('proj', '/virtual/proj');
  const sd = safe.findSessionsDir(p.path);
  await fsp.mkdir(sd, { recursive: true });
  await fsp.writeFile(path.join(sd, 's1.jsonl'), fixtures.tokenUsageLines.join('\n') + '\n');
  const r = await su.getTokenUsage('s1', 'proj');
  assert.equal(r.input_tokens, 5500);
  assert.equal(r.model, 'claude-sonnet-4-6');
  // #286: Claude max_tokens is plan-effective; getTokenUsage no longer reports it.
  // getSessionInfo overrides with the live statusLine state file when present.
  assert.equal(r.max_tokens, null);
});

test('SU-11: getTokenUsage reports model from JSONL; max_tokens null (sourced from statusLine)', async (t) => {
  const { db, safe, su } = await setupEnv(t);
  const p = db.ensureProject('projop', '/virtual/projop');
  const sd = safe.findSessionsDir(p.path);
  await fsp.mkdir(sd, { recursive: true });
  const line = fixtures.makeJsonlLine(
    fixtures.makeAssistantEntry({ model: 'claude-opus-4-6', inputTokens: 1000 }),
  );
  await fsp.writeFile(path.join(sd, 'op1.jsonl'), line + '\n');
  const r = await su.getTokenUsage('op1', 'projop');
  assert.equal(r.model, 'claude-opus-4-6');
  // #286: per-model max_tokens (200K/1M) is no longer surfaced through
  // getTokenUsage — it lives in the statusLine state file consumed by
  // getSessionInfo. Asserting null here documents the contract.
  assert.equal(r.max_tokens, null);
});

// #411 [Q6]: getSessionInfo overlays plan-effective max_tokens + input_tokens
// from the live statusLine state file (~/.claude/statusline-state-<id>.json)
// onto the JSONL-parsed token usage. Cover both shapes of `current_usage`:
// numeric (early docs) and object (observed in practice).
test('SU-12: getSessionInfo statusLine overlay — numeric current_usage', async (t) => {
  const { db, safe, su } = await setupEnv(t);
  const p = db.ensureProject('proj-su12n', '/virtual/proj-su12n');
  const sd = safe.findSessionsDir(p.path);
  await fsp.mkdir(sd, { recursive: true });
  const sessId = 'su12-num';
  await fsp.writeFile(path.join(sd, `${sessId}.jsonl`),
    fixtures.makeJsonlLine(fixtures.makeAssistantEntry({ model: 'claude-sonnet-4-6', inputTokens: 1234 })) + '\n');
  db.upsertSession(sessId, p.id, 'su12 numeric', 'claude');

  // statusLine state file: numeric current_usage shape.
  const statePath = path.join(process.env.CLAUDE_HOME, `statusline-state-${sessId}.json`);
  await fsp.writeFile(statePath, JSON.stringify({
    context_window: { context_window_size: 200000, current_usage: 75000 },
    model: { id: 'claude-sonnet-4-6' },
  }));

  const info = await su.getSessionInfo(sessId);
  assert.equal(info.max_tokens, 200000, 'plan-effective max_tokens from statusLine');
  assert.equal(info.input_tokens, 75000, 'numeric current_usage applies as input_tokens');
});

test('SU-12: getSessionInfo statusLine overlay — object current_usage (in-practice shape)', async (t) => {
  const { db, safe, su } = await setupEnv(t);
  const p = db.ensureProject('proj-su12o', '/virtual/proj-su12o');
  const sd = safe.findSessionsDir(p.path);
  await fsp.mkdir(sd, { recursive: true });
  const sessId = 'su12-obj';
  await fsp.writeFile(path.join(sd, `${sessId}.jsonl`),
    fixtures.makeJsonlLine(fixtures.makeAssistantEntry({ model: 'claude-opus-4-7', inputTokens: 1000 })) + '\n');
  db.upsertSession(sessId, p.id, 'su12 object', 'claude');

  // statusLine state file: object current_usage with input + cache breakdown.
  const statePath = path.join(process.env.CLAUDE_HOME, `statusline-state-${sessId}.json`);
  await fsp.writeFile(statePath, JSON.stringify({
    context_window: {
      context_window_size: 1000000,
      current_usage: {
        input_tokens: 500,
        cache_creation_input_tokens: 1500,
        cache_read_input_tokens: 8000,
        output_tokens: 4242,
      },
    },
    model: { id: 'claude-opus-4-7' },
  }));

  const info = await su.getSessionInfo(sessId);
  assert.equal(info.max_tokens, 1000000, 'plan-effective max_tokens from statusLine');
  // sum of input + cache_creation + cache_read; output is excluded by design
  assert.equal(info.input_tokens, 10000, 'object current_usage sums to input + cache_creation + cache_read');
});

test('SU-08: summarizeSession falls back on Claude failure', async (t) => {
  const { db, safe, su } = await setupEnv(t);
  const p = db.ensureProject('proj', '/virtual/proj');
  const sd = safe.findSessionsDir(p.path);
  await fsp.mkdir(sd, { recursive: true });
  await fsp.writeFile(path.join(sd, 's1.jsonl'), fixtures.sessionUtilsValidLines.join('\n') + '\n');
  t.mock.method(childProcess, 'execFile', (_c, _a, _o, cb) => cb(new Error('claude failed')));
  const r = await su.summarizeSession('s1', 'proj');
  assert.match(r.summary, /Failed to generate summary/);
  assert.ok(Array.isArray(r.recentMessages));
});

test('SES-20 / SU missing JSONL: parseSessionFile returns null, getTokenUsage returns zero', async (t) => {
  const { su } = await setupEnv(t);
  assert.equal(await su.parseSessionFile('/does/not/exist.jsonl'), null);
  const usage = await su.getTokenUsage('miss', 'miss');
  assert.equal(usage.input_tokens, 0);
  assert.equal(usage.model, null);
  // #286: max_tokens null when no live statusLine source has reported.
  assert.equal(usage.max_tokens, null);
});

test('SU-12 / SES-19: getSessionSlug extracts slug from JSONL', async (t) => {
  const { db, safe, su } = await setupEnv(t);
  const p = db.ensureProject('slugproj', '/virtual/slugproj');
  const sd = safe.findSessionsDir(p.path);
  await fsp.mkdir(sd, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'hi' }, slug: 'my-session-slug' }),
  ];
  await fsp.writeFile(path.join(sd, 'slug1.jsonl'), lines.join('\n') + '\n');
  const slug = await su.getSessionSlug('slug1', p.path);
  assert.equal(slug, 'my-session-slug');
});

test('SU-12: getSessionSlug returns null when no slug entry', async (t) => {
  const { db, safe, su } = await setupEnv(t);
  const p = db.ensureProject('noslug', '/virtual/noslug');
  const sd = safe.findSessionsDir(p.path);
  await fsp.mkdir(sd, { recursive: true });
  await fsp.writeFile(
    path.join(sd, 'ns1.jsonl'),
    fixtures.sessionUtilsValidLines.join('\n') + '\n',
  );
  assert.equal(await su.getSessionSlug('ns1', p.path), null);
});

test('new_ session returns zero tokens', async (t) => {
  const { su } = await setupEnv(t);
  const r = await su.getTokenUsage('new_123', 'proj');
  assert.equal(r.input_tokens, 0);
});

// -- searchSessions tests --

test('SU-13: searchSessions finds matching messages in session files', async (t) => {
  const { db, safe, su } = await setupEnv(t);
  const p = db.ensureProject('searchproj', '/virtual/searchproj');
  const sd = safe.findSessionsDir(p.path);
  await fsp.mkdir(sd, { recursive: true });
  const lines = [
    JSON.stringify({
      type: 'user',
      message: { content: 'How do I deploy to production?' },
      timestamp: '2026-04-10T10:00:00Z',
    }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Run docker compose up' }] },
      timestamp: '2026-04-10T10:01:00Z',
    }),
  ];
  await fsp.writeFile(path.join(sd, 'search1.jsonl'), lines.join('\n') + '\n');
  const results = await su.searchSessions('deploy', null, 10);
  assert.ok(results.length > 0, 'Should find sessions matching "deploy"');
  assert.equal(results[0].session_id, 'search1');
  assert.equal(results[0].project, 'searchproj');
  assert.ok(results[0].match_count >= 1);
  assert.ok(results[0].snippets.length >= 1);
  assert.ok(results[0].snippets[0].toLowerCase().includes('deploy'));
});

test('SU-13: searchSessions returns empty for non-matching query', async (t) => {
  const { db, safe, su } = await setupEnv(t);
  const p = db.ensureProject('searchproj2', '/virtual/searchproj2');
  const sd = safe.findSessionsDir(p.path);
  await fsp.mkdir(sd, { recursive: true });
  await fsp.writeFile(
    path.join(sd, 'nomatch.jsonl'),
    JSON.stringify({ type: 'user', message: { content: 'hello world' } }) + '\n',
  );
  const results = await su.searchSessions('xyznonexistent', null, 10);
  assert.equal(results.length, 0);
});

test('SU-13: searchSessions filters by project when projectFilter given', async (t) => {
  const { db, safe, su } = await setupEnv(t);
  const p1 = db.ensureProject('alpha', '/virtual/alpha');
  const p2 = db.ensureProject('beta', '/virtual/beta');
  const sd1 = safe.findSessionsDir(p1.path);
  const sd2 = safe.findSessionsDir(p2.path);
  await fsp.mkdir(sd1, { recursive: true });
  await fsp.mkdir(sd2, { recursive: true });
  await fsp.writeFile(
    path.join(sd1, 'a1.jsonl'),
    JSON.stringify({ type: 'user', message: { content: 'deploy alpha' } }) + '\n',
  );
  await fsp.writeFile(
    path.join(sd2, 'b1.jsonl'),
    JSON.stringify({ type: 'user', message: { content: 'deploy beta' } }) + '\n',
  );
  const results = await su.searchSessions('deploy', 'alpha', 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].project, 'alpha');
});

test('SU-13: searchSessions tolerates malformed JSONL lines', async (t) => {
  const { db, safe, su } = await setupEnv(t);
  const p = db.ensureProject('malproj', '/virtual/malproj');
  const sd = safe.findSessionsDir(p.path);
  await fsp.mkdir(sd, { recursive: true });
  const lines = [
    'not valid json',
    JSON.stringify({ type: 'user', message: { content: 'searchable text' } }),
  ];
  await fsp.writeFile(path.join(sd, 'mal1.jsonl'), lines.join('\n') + '\n');
  const results = await su.searchSessions('searchable', null, 10);
  assert.equal(results.length, 1, 'Should still find match despite malformed lines');
});

test('SU-13: searchSessions handles missing sessions directory gracefully', async (t) => {
  const { db, su } = await setupEnv(t);
  db.ensureProject('nodir', '/virtual/nodir');
  // No sessions directory created
  const results = await su.searchSessions('test', null, 10);
  assert.ok(Array.isArray(results));
});

// -- getTokenUsage edge cases --

test('SU: getTokenUsage handles non-ENOENT file error gracefully', async (t) => {
  const { db, safe, su } = await setupEnv(t);
  const p = db.ensureProject('errproj', '/virtual/errproj');
  const sd = safe.findSessionsDir(p.path);
  await fsp.mkdir(sd, { recursive: true });
  // Create a directory where a file is expected — causes EISDIR
  await fsp.mkdir(path.join(sd, 'broken.jsonl'), { recursive: true });
  const r = await su.getTokenUsage('broken', 'errproj');
  assert.equal(r.input_tokens, 0, 'Should return zero tokens on non-ENOENT error');
});

// -- getSessionSlug edge cases --

test('SU: getSessionSlug returns null for missing file', async (t) => {
  const { su } = await setupEnv(t);
  const slug = await su.getSessionSlug('nonexistent', '/virtual/nowhere');
  assert.equal(slug, null);
});

// -- extractMessageText --

test('SU: extractMessageText handles non-user/assistant types', async (t) => {
  const { su } = await setupEnv(t);
  assert.equal(su.extractMessageText({ type: 'system', message: { content: 'sys' } }), '');
  assert.equal(su.extractMessageText({ type: 'user', message: { content: 'hello' } }), 'hello');
  assert.equal(
    su.extractMessageText({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'reply' }] },
    }),
    'reply',
  );
});
