'use strict';

// Mock-server tests for the flat MCP API. Hits the in-process Express app via
// supertest-style helpers (no docker, no live workbench). Live integration
// coverage lives in tests/live/mcp-tools.test.js.
//
// Tool count is derived from the handlers map in mcp-tools.js (the source of
// truth) so adding/removing a tool updates both the handler and TOOL_NAMES
// at once and the test follows. Hardcoded counts here would be a tripwire
// that surfaces as a "16 mock failures" red CI when tools land — see #325.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerMcpRoutes, handlers, TOOL_NAMES, _collectGhOutput } = require('../../src/mcp-tools.js');
const { withServer, req } = require('../helpers/with-server');
const { EventEmitter } = require('node:events');

const KNOWN_DOMAINS = ['file', 'session', 'project', 'task', 'log', 'gh'];

function startMcpApp() {
  const app = express();
  app.use(express.json());
  registerMcpRoutes(app);
  return app;
}

async function call(port, body) {
  const r = await req(port, 'POST', '/api/mcp/call', body);
  const json = await r.json().catch(() => ({}));
  return { status: r.status, body: json };
}

test('MCP catalogue: tools/list returns the full handler-exposed set', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'GET', '/api/mcp/tools');
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.tools.length, TOOL_NAMES.length);
    assert.deepEqual([...json.tools].sort(), [...TOOL_NAMES].sort());
    for (const n of json.tools) {
      const domain = n.split('_')[0];
      assert.ok(
        KNOWN_DOMAINS.includes(domain),
        `tool ${n} has unknown domain prefix "${domain}"; add to KNOWN_DOMAINS or rename`,
      );
    }
  });
});

test('MCP catalogue: handlers map and TOOL_NAMES are in sync', () => {
  assert.deepEqual([...TOOL_NAMES].sort(), Object.keys(handlers).sort());
  const grouped = TOOL_NAMES.reduce((acc, n) => {
    const d = n.split('_')[0];
    acc[d] = (acc[d] || 0) + 1;
    return acc;
  }, {});
  for (const d of Object.keys(grouped)) {
    assert.ok(
      KNOWN_DOMAINS.includes(d),
      `unknown domain prefix "${d}" with ${grouped[d]} tools`,
    );
  }
});

test('MCP unknown tool returns 404', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, { tool: 'nonexistent_tool', args: {} });
    assert.equal(r.status, 404);
  });
});

test('MCP missing required arg returns 400 (file_read needs path)', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, { tool: 'file_read', args: {} });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /path required/i);
  });
});

test('MCP path traversal blocked (file_read ../etc/passwd)', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, { tool: 'file_read', args: { path: '../../../etc/passwd' } });
    assert.equal(r.status, 403);
  });
});

test('MCP invalid task_id returns 400', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, { tool: 'task_get', args: { task_id: 'abc' } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /task_id/i);
  });
});

test('MCP invalid session_id format returns 400', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, { tool: 'session_info', args: { session_id: 'has spaces and !@#' } });
    assert.equal(r.status, 400);
  });
});

test('MCP session_send_key rejects non-whitelisted key', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, {
      tool: 'session_send_key',
      args: { session_id: 'a'.repeat(20), key: 'NotARealKey' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /invalid key/i);
  });
});

test('MCP session_wait rejects seconds <= 0', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, { tool: 'session_wait', args: { seconds: 0 } });
    assert.equal(r.status, 400);
  });
});

// #330 [A5]: file_find argv-safety + bounds.
test('MCP file_find rejects file_type with shell metachars', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, {
      tool: 'file_find',
      args: { pattern: 'workbench', file_type: 'js;rm -rf /' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /file_type/i);
  });
});

test('MCP file_find accepts plain file_type and returns matches array', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, {
      tool: 'file_find',
      args: { pattern: 'workbench', file_type: 'tsx' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.pattern, 'workbench');
    assert.ok(Array.isArray(r.body.result.matches), 'matches must be an array');
  });
});

test('MCP file_find clamps oversized context_lines without error', async () => {
  // ctx=999 would be valid for grep but the handler must clamp to 0..10 so an
  // adversarial ask doesn't blow up the response post-slice budget. Observable
  // effect: the call succeeds and returns the expected shape.
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, {
      tool: 'file_find',
      args: { pattern: 'workbench', context_lines: 999 },
    });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.result.matches));
  });
});

// #331 [A6]: gh_cmd argv-shape validation + chunked output cap.
test('MCP gh_cmd rejects string command', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, {
      tool: 'gh_cmd',
      args: { command: 'ls -la', repo: 'rmdevpro/agentic-workbench' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /command must be an array/i);
  });
});

test('MCP gh_cmd rejects non-string command element', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, {
      tool: 'gh_cmd',
      args: { command: ['log', {}], repo: 'rmdevpro/agentic-workbench' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /every command element must be a string/i);
  });
});

// Verify the streaming cap directly. Build a fake child-process EventEmitter
// that emits 500 KB of stdout, then assert the collector buffer is exactly
// 200_000 chars — the cap matters because gh's `pr list --json` against a
// busy repo regularly emits hundreds of KB and we must not let it grow
// unbounded.
test('_collectGhOutput caps stdout at 200 KB', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const promise = _collectGhOutput(child);
  // Emit 500 KB in three chunks.
  child.stdout.emit('data', Buffer.from('a'.repeat(150_000)));
  child.stdout.emit('data', Buffer.from('b'.repeat(150_000)));
  child.stdout.emit('data', Buffer.from('c'.repeat(200_000)));
  child.emit('close', 0);
  const { stdout } = await promise;
  assert.equal(stdout.length, 200_000);
  // The first 200 KB of input were 150 KB 'a' + 50 KB 'b'.
  assert.ok(stdout.startsWith('a'.repeat(10)));
  assert.ok(stdout.endsWith('b'.repeat(10)));
});

test('_collectGhOutput caps stderr at 200 KB', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const promise = _collectGhOutput(child);
  child.stderr.emit('data', Buffer.from('e'.repeat(300_000)));
  child.emit('close', 1);
  const { stderr } = await promise;
  assert.equal(stderr.length, 200_000);
});

// #388 [Q1]: task v2 task_add does not accept folder_path. Pre-v2 the API
// silently accepted any folder_path string, including ones not workspace-
// rooted; those tasks became invisible to the panel. v2's project_id /
// project_name requirement closes the symptom by construction. This test
// pins the contract so a future regression that re-adds folder_path support
// trips here.
test('MCP task_add rejects without project_id or project_name (no folder_path fallback)', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, {
      tool: 'task_add',
      args: { title: 'orphan', folder_path: '/phase-0/foo' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /project_id or project_name required/i);
  });
});

// #445: project_mcp_enable previously wrote only Claude's <project>/.mcp.json,
// so foo enabled in a project was never visible to Gemini/Codex. The fix
// writes per-project config for all 3 CLIs:
//   claude: <project>/.mcp.json           (existing)
//   gemini: <project>/.gemini/settings.json mcpServers
//   codex:  <project>/.codex/config.toml [mcp_servers.<name>]
// Mock test enables a fixture MCP and asserts each of the 3 files lands.
test('MCP project_mcp_enable writes per-project config for claude+gemini+codex (#445)', async () => {
  const db = require('../../src/db');
  const fs = require('fs');
  const os = require('os');
  const { join } = require('path');
  // #619: scratch dir under os.tmpdir(); never write to /data/workspace/.
  const projPath = fs.mkdtempSync(join(os.tmpdir(), 'wb-mock-445-'));
  const proj = db.ensureProject('mock_445_proj', projPath);

  // Register a fixture MCP server (db.registerMcp internally JSON.stringifies the
  // config, so we pass an object to avoid the double-stringify edge case).
  db.registerMcp('mock-445-fixture', 'stdio', { command: 'node', args: ['/tmp/fake-mcp.js'], env: { FOO: 'bar' } }, 'fixture');
  try {
    await withServer(startMcpApp(), async ({ port }) => {
      const r = await call(port, { tool: 'project_mcp_enable', args: { mcp_name: 'mock-445-fixture', project: 'mock_445_proj' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));

      // Claude: <project>/.mcp.json
      const claudeJson = JSON.parse(fs.readFileSync(join(projPath, '.mcp.json'), 'utf-8'));
      assert.ok(claudeJson.mcpServers['mock-445-fixture'], `Claude .mcp.json must include fixture; got ${JSON.stringify(claudeJson)}`);
      assert.equal(claudeJson.mcpServers['mock-445-fixture'].command, 'node');

      // Gemini: <project>/.gemini/settings.json
      const geminiJson = JSON.parse(fs.readFileSync(join(projPath, '.gemini', 'settings.json'), 'utf-8'));
      assert.ok(geminiJson.mcpServers['mock-445-fixture'], `Gemini settings.json must include fixture; got ${JSON.stringify(geminiJson)}`);

      // Codex: <project>/.codex/config.toml
      const codexToml = fs.readFileSync(join(projPath, '.codex', 'config.toml'), 'utf-8');
      assert.match(codexToml, /\[mcp_servers\.mock-445-fixture\]/, `Codex config.toml must declare [mcp_servers.mock-445-fixture]; got ${codexToml}`);
      assert.match(codexToml, /command = "node"/, 'Codex config.toml must record command');
      assert.match(codexToml, /args = \["\/tmp\/fake-mcp\.js"\]/, 'Codex config.toml must record args array');
      assert.match(codexToml, /\[mcp_servers\.mock-445-fixture\.env\]/, 'Codex env block must be written');

      // project_mcp_disable removes from all 3
      const r2 = await call(port, { tool: 'project_mcp_disable', args: { mcp_name: 'mock-445-fixture', project: 'mock_445_proj' } });
      assert.equal(r2.status, 200, JSON.stringify(r2.body));

      const claudeJson2 = JSON.parse(fs.readFileSync(join(projPath, '.mcp.json'), 'utf-8'));
      assert.ok(!claudeJson2.mcpServers['mock-445-fixture'], 'Claude .mcp.json must drop fixture after disable');
      const geminiJson2 = JSON.parse(fs.readFileSync(join(projPath, '.gemini', 'settings.json'), 'utf-8'));
      assert.ok(!geminiJson2.mcpServers['mock-445-fixture'], 'Gemini settings.json must drop fixture after disable');
      const codexToml2 = fs.readFileSync(join(projPath, '.codex', 'config.toml'), 'utf-8');
      assert.doesNotMatch(codexToml2, /\[mcp_servers\.mock-445-fixture\]/, 'Codex config.toml must drop fixture after disable');
    });
  } finally {
    try { db.unregisterMcp('mock-445-fixture'); } catch { /* ignore */ }
    try { db.deleteProject(proj.id); } catch { /* ignore */ }
    try { fs.rmSync(projPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// #445 follow-up: the original regex strip in _writeProjectMcpForAllCLIs
// used `[^\[]*` after the section header to consume the body, which
// terminated at the FIRST `[` character in the body. An MCP whose config
// has `args = ["/tmp/x.js"]` (inline TOML array starting with `[`) made
// the regex stop mid-block, leaving the rest of the body orphaned in the
// file. Repro on M5:7860 left literal `["/tmp/x.js"]` content after a
// disable. Line-based state machine fix; this test pins the round-trip.
test('MCP project_mcp_disable strips inline-array Codex blocks cleanly (#445 follow-up)', async () => {
  const db = require('../../src/db');
  const fs = require('fs');
  const os = require('os');
  const { join } = require('path');
  // #619: scratch dir under os.tmpdir(); never write to /data/workspace/.
  const projPath = fs.mkdtempSync(join(os.tmpdir(), 'wb-mock-445-fu-'));
  const proj = db.ensureProject('mock_445_followup', projPath);

  // Pre-seed a non-mcp_servers section so we can verify it's preserved
  // through the strip (real codex configs commonly have model_provider /
  // [projects."<path>"] / etc.). The [projects."<path>"] section embeds
  // the test's dynamic project path so the strip exercises a realistic
  // shape; the assertions below match the literal [projects." prefix only.
  fs.mkdirSync(join(projPath, '.codex'), { recursive: true });
  fs.writeFileSync(
    join(projPath, '.codex', 'config.toml'),
    `model = "gpt-5"\n\n[projects."${projPath}"]\ntrust_level = "trusted"\n`,
  );

  // Register an MCP whose config triggers the inline-array case.
  db.registerMcp('mock-445-fu', 'stdio', { command: 'node', args: ['/tmp/x.js', '/tmp/y.js'] }, 'inline-array fixture');

  try {
    await withServer(startMcpApp(), async ({ port }) => {
      // Enable: writes the [mcp_servers.mock-445-fu] block (with `args = [...]`)
      const enableR = await call(port, { tool: 'project_mcp_enable', args: { mcp_name: 'mock-445-fu', project: 'mock_445_followup' } });
      assert.equal(enableR.status, 200, JSON.stringify(enableR.body));
      const afterEnable = fs.readFileSync(join(projPath, '.codex', 'config.toml'), 'utf-8');
      assert.match(afterEnable, /\[mcp_servers\.mock-445-fu\]/, 'enable must add the block');
      assert.match(afterEnable, /args = \["\/tmp\/x\.js", "\/tmp\/y\.js"\]/, 'enable must record the inline array');
      assert.match(afterEnable, /\[projects\."/, 'pre-existing [projects."..."] section must survive enable');
      assert.match(afterEnable, /^model = "gpt-5"/m, 'pre-existing top-level keys must survive enable');

      // Disable: the buggy regex left `["/tmp/x.js", "/tmp/y.js"]` orphaned.
      const disableR = await call(port, { tool: 'project_mcp_disable', args: { mcp_name: 'mock-445-fu', project: 'mock_445_followup' } });
      assert.equal(disableR.status, 200, JSON.stringify(disableR.body));
      const afterDisable = fs.readFileSync(join(projPath, '.codex', 'config.toml'), 'utf-8');
      assert.doesNotMatch(afterDisable, /\[mcp_servers\.mock-445-fu\]/, 'disable must drop the block header');
      // Critical orphan check: NO standalone array literal must remain.
      assert.doesNotMatch(afterDisable, /^\s*\["\/tmp\/x\.js"/m, `disable must not orphan inline array; got:\n${afterDisable}`);
      assert.doesNotMatch(afterDisable, /^\s*args =/m, `disable must not orphan key=value lines; got:\n${afterDisable}`);
      // And pre-existing content must survive the round-trip.
      assert.match(afterDisable, /\[projects\."/, 'pre-existing [projects."..."] section must survive disable');
      assert.match(afterDisable, /^model = "gpt-5"/m, 'pre-existing top-level keys must survive disable');
    });
  } finally {
    try { db.unregisterMcp('mock-445-fu'); } catch { /* ignore */ }
    try { db.deleteProject(proj.id); } catch { /* ignore */ }
    try { fs.rmSync(projPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// #446: session_prepare_pre_compact dispatches per cli_type so non-Claude
// callers don't get the Claude-shaped prompt (which references /compact +
// ~/.claude/plans/, neither of which apply to Gemini or Codex). The mock
// test seeds 3 sessions directly and asserts each cli_type returns the
// CLI-appropriate prompt.
test('MCP session_prepare_pre_compact dispatches per cli_type (#446)', async () => {
  const db = require('../../src/db');
  const fs = require('fs');
  const os = require('os');
  const { join } = require('path');
  // #619: scratch dir under os.tmpdir(); never write to /data/workspace/.
  const projPath = fs.mkdtempSync(join(os.tmpdir(), 'wb-mock-446-'));
  const proj = db.ensureProject('mock_446_prepare', projPath);
  try {
    db.upsertSession('mock-446-claude-prep', proj.id, 'c', 'claude');
    db.upsertSession('mock-446-gemini-prep', proj.id, 'g', 'gemini');
    db.upsertSession('mock-446-codex-prep',  proj.id, 'x', 'codex');
    await withServer(startMcpApp(), async ({ port }) => {
      // Corrected per-CLI design (2026-05-11): all 3 CLIs have in-session
      // compaction. Only the compaction command name + plan-file path varies.
      // Plan-file paths are how the test distinguishes Claude/Codex (both
      // use /compact) from Gemini (uses /compress).
      const claudeR = await call(port, { tool: 'session_prepare_pre_compact', args: { session_id: 'mock-446-claude-prep' } });
      assert.equal(claudeR.status, 200, JSON.stringify(claudeR.body));
      assert.match(claudeR.body.result, /\/compact/, 'Claude prompt must reference /compact');
      assert.match(claudeR.body.result, /~\/\.claude\/plans\//, 'Claude prompt must reference ~/.claude/plans/');

      const geminiR = await call(port, { tool: 'session_prepare_pre_compact', args: { session_id: 'mock-446-gemini-prep' } });
      assert.equal(geminiR.status, 200, JSON.stringify(geminiR.body));
      assert.match(geminiR.body.result, /\/compress/, 'Gemini prompt must reference /compress (Gemini compaction command)');
      assert.match(geminiR.body.result, /~\/\.gemini\/plans\//, 'Gemini prompt must reference ~/.gemini/plans/');

      const codexR = await call(port, { tool: 'session_prepare_pre_compact', args: { session_id: 'mock-446-codex-prep' } });
      assert.equal(codexR.status, 200, JSON.stringify(codexR.body));
      assert.match(codexR.body.result, /\/compact/, 'Codex prompt must reference /compact (Codex compaction command — same name as Claude)');
      assert.match(codexR.body.result, /~\/\.codex\/plans\//, 'Codex prompt must reference ~/.codex/plans/ (the per-CLI plan path that differentiates Codex from Claude)');
    });
  } finally {
    try { db.deleteSession('mock-446-claude-prep'); } catch { /* ignore */ }
    try { db.deleteSession('mock-446-gemini-prep'); } catch { /* ignore */ }
    try { db.deleteSession('mock-446-codex-prep');  } catch { /* ignore */ }
    try { db.deleteProject(proj.id); } catch { /* ignore */ }
    try { fs.rmSync(projPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// #446: session_resume_post_compact must throw a clean 404 (not silently
// return "(could not read session file)") when the session row is missing.
// The pre-fix silent-fallback was the bug — callers got a useless resume
// prompt with no actual context tail.
test('MCP session_resume_post_compact 404s on missing session (#446 no-silent-failure)', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, {
      tool: 'session_resume_post_compact',
      args: { session_id: 'definitely-not-a-real-session-id', tail_lines: 5 },
    });
    assert.equal(r.status, 404, `expected 404; got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error || '', /session not found/i);
  });
});

// #252: session_resume_post_compact writes the requested tail to
// `/tmp/workbench-resume-<sid>.txt` and returns a prompt that references that
// path — instead of stuffing the full tail inline (which blew past the CLI's
// tool-result token cap on long sessions, the original #252 symptom). Commit
// `f5d3bb1` is the file-based fix; this test pins the file-write contract +
// the prompt-references-path shape directly, so a regression that reverts to
// inline tail fails here at the mock layer rather than only at live.
test('MCP session_resume_post_compact writes tail to /tmp file and returns prompt referencing path (#252)', async () => {
  const db = require('../../src/db');
  const fs = require('fs');
  const fsp = require('fs/promises');
  const os = require('os');
  const { join } = require('path');
  const safe = require('../../src/safe-exec.js');
  const sid = 'mock-252-claude-session';
  const projName = 'mock_252_proj';
  // #619: scratch dir under os.tmpdir(); never write to /data/workspace/.
  const projPath = fs.mkdtempSync(join(os.tmpdir(), 'wb-mock-252-'));
  const proj = db.ensureProject(projName, projPath);
  const sessDir = safe.findSessionsDir(projPath);
  fs.mkdirSync(sessDir, { recursive: true });
  const jsonlPath = join(sessDir, `${sid}.jsonl`);
  // Seed a JSONL fixture with 5 lines so tail_lines:3 returns the last 3
  // (the substring check below pins this ordering — line-3, line-4, line-5).
  const fixtureLines = [
    JSON.stringify({ type: 'user', message: { content: 'line-1' } }),
    JSON.stringify({ type: 'assistant', message: { content: 'line-2' } }),
    JSON.stringify({ type: 'user', message: { content: 'line-3' } }),
    JSON.stringify({ type: 'assistant', message: { content: 'line-4' } }),
    JSON.stringify({ type: 'user', message: { content: 'line-5' } }),
  ];
  fs.writeFileSync(jsonlPath, fixtureLines.join('\n') + '\n', 'utf-8');
  db.upsertSession(sid, proj.id, 'resume-tail-test', 'claude');
  const tmpResumeFile = `/tmp/workbench-resume-${sid}.txt`;
  try {
    await withServer(startMcpApp(), async ({ port }) => {
      const r = await call(port, {
        tool: 'session_resume_post_compact',
        args: { session_id: sid, tail_lines: 3 },
      });
      assert.equal(r.status, 200, `expected 200; got ${r.status}: ${JSON.stringify(r.body)}`);
      const prompt = typeof r.body.result === 'string' ? r.body.result : JSON.stringify(r.body.result);
      assert.ok(
        prompt.includes(tmpResumeFile),
        `returned prompt must reference the tail file path ${tmpResumeFile}; got: ${prompt.slice(0, 200)}…`,
      );
      // The tail file exists with the last 3 lines of the JSONL fixture.
      const tail = await fsp.readFile(tmpResumeFile, 'utf-8');
      assert.ok(tail.includes('line-5'), `tail must include last line; got: ${tail}`);
      assert.ok(tail.includes('line-4'), `tail must include penultimate line; got: ${tail}`);
      assert.ok(tail.includes('line-3'), `tail must include third-from-last line; got: ${tail}`);
      assert.ok(!tail.includes('line-2'), `tail must NOT include lines beyond tail_lines:3; got: ${tail}`);
      assert.ok(!tail.includes('line-1'), `tail must NOT include lines beyond tail_lines:3; got: ${tail}`);
      // The fix is "tail goes to file, prompt points at it" — pin the
      // negative: the response body MUST NOT contain the raw tail content
      // inline (that was the pre-fix shape causing the unreadable dump).
      assert.ok(
        !prompt.includes('line-5'),
        `pre-fix regression: tail content must NOT be inlined in the prompt; got: ${prompt.slice(0, 400)}…`,
      );
    });
  } finally {
    try { fs.unlinkSync(tmpResumeFile); } catch { /* ignore */ }
    try { db.deleteSession(sid); } catch { /* ignore */ }
    try { db.deleteProject(proj.id); } catch { /* ignore */ }
    try { fs.rmSync(projPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// #450: session_summarize previously threw "path argument must be string" when
// called without an explicit `project` arg (e.g. from a CLI tab calling
// session_summarize {session_id: <sid>}). Root cause: db.getProject(undefined)
// returned undefined, fallback hit join(WORKSPACE, undefined). Fix resolves
// project from the session row's project_id when arg is omitted.
test('MCP session_summarize resolves project from session row when arg missing (#450)', async () => {
  const db = require('../../src/db');
  const fs = require('fs');
  const os = require('os');
  const { join } = require('path');
  // #619: scratch dir under os.tmpdir(); never write to /data/workspace/.
  const projPath = fs.mkdtempSync(join(os.tmpdir(), 'wb-mock-450-'));
  const proj = db.ensureProject('mock_450_proj', projPath);
  try {
    // Seed a codex session — Codex/Gemini branches don't need projectPath but
    // the path resolution code at the top must not throw regardless of cli_type.
    db.upsertSession('mock-450-session', proj.id, 'summarize-test', 'codex');
    await withServer(startMcpApp(), async ({ port }) => {
      const r = await call(port, { tool: 'session_summarize', args: { session_id: 'mock-450-session' } });
      // No "path must be string" TypeError. Either 200 with summary (if transcript
      // exists) or 200 with empty result; never 500/path error.
      assert.notEqual(r.status, 500, `summarize must not 500; got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.status, 200, `summarize must return 200; got ${r.status}: ${JSON.stringify(r.body)}`);
    });
  } finally {
    try { db.deleteSession('mock-450-session'); } catch { /* ignore */ }
    try { db.deleteProject(proj.id); } catch { /* ignore */ }
    try { fs.rmSync(projPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// #268: session_export on a freshly-created Claude session previously threw
// `ToolError('session file not found: <path>', 404)` even when the session
// row was valid — the transcript file just hadn't been written yet because
// no messages had been sent. Now distinguishes the two cases: truly-invalid
// session_id still 404s; valid-row-but-no-transcript-yet returns
// `{format:'jsonl', path, content:'', session_id, note:'no transcript'}`.
test('MCP session_export returns empty-transcript shape for fresh Claude session (#268)', async () => {
  const db = require('../../src/db');
  const fs = require('fs');
  const os = require('os');
  const { join } = require('path');
  // #619: scratch dir under os.tmpdir(); never write to /data/workspace/.
  const projPath = fs.mkdtempSync(join(os.tmpdir(), 'wb-mock-268-'));
  const proj = db.ensureProject('mock_268_proj', projPath);
  try {
    // Seed a Claude session row but DO NOT create the JSONL transcript file.
    // This mirrors a freshly-created session before any messages have flowed.
    db.upsertSession('mock-268-fresh-claude', proj.id, 'fresh-claude', 'claude');
    await withServer(startMcpApp(), async ({ port }) => {
      const r = await call(port, {
        tool: 'session_export',
        args: { session_id: 'mock-268-fresh-claude' },
      });
      assert.equal(r.status, 200, `expected 200; got ${r.status}: ${JSON.stringify(r.body)}`);
      const result = r.body.result;
      assert.equal(result.format, 'jsonl', `format must be 'jsonl'; got ${result.format}`);
      assert.equal(result.content, '', `content must be empty string; got ${JSON.stringify(result.content)}`);
      assert.equal(result.session_id, 'mock-268-fresh-claude', `session_id must echo arg; got ${result.session_id}`);
      assert.equal(result.note, 'no transcript', `note must be 'no transcript'; got ${result.note}`);
      assert.ok(result.path && result.path.endsWith('.jsonl'), `path must point at the missing JSONL; got ${result.path}`);
    });
  } finally {
    try { db.deleteSession('mock-268-fresh-claude'); } catch { /* ignore */ }
    try { db.deleteProject(proj.id); } catch { /* ignore */ }
    try { fs.rmSync(projPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('MCP session_export 404s on truly-invalid session_id (#268 Case B preserved)', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, {
      tool: 'session_export',
      args: { session_id: 'definitely-not-a-real-268-session-id' },
    });
    assert.equal(r.status, 404, `expected 404; got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error || '', /session not found/i);
  });
});

// #198: session_config previously returned `{saved:true}` only. Callers that
// needed post-write metadata (id, name, state, cli_type, model, …) had to
// follow up with session_info — costly and racy under cache TTL. The fix
// invalidates the session_info cache then read-after-writes via
// getSessionInfo and returns the merged shape `{...info, saved:true}`.
test('MCP session_config returns full session metadata after write (#198)', async () => {
  const db = require('../../src/db');
  const fs = require('fs');
  const os = require('os');
  const { join } = require('path');
  // #619: scratch dir under os.tmpdir(); never write to /data/workspace/.
  const projPath = fs.mkdtempSync(join(os.tmpdir(), 'wb-mock-198-'));
  const proj = db.ensureProject('mock_198_proj', projPath);
  try {
    db.upsertSession('mock-198-session', proj.id, 'pre-rename', 'claude');
    await withServer(startMcpApp(), async ({ port }) => {
      const r = await call(port, {
        tool: 'session_config',
        args: { session_id: 'mock-198-session', name: 'post-rename', notes: 'engineer-test' },
      });
      assert.equal(r.status, 200, `expected 200; got ${r.status}: ${JSON.stringify(r.body)}`);
      const result = r.body.result;
      // saved:true preserved for backward compat
      assert.equal(result.saved, true, `saved:true must be preserved; got ${JSON.stringify(result)}`);
      // Full metadata returned
      assert.equal(result.id, 'mock-198-session', `id must echo session_id; got ${result.id}`);
      assert.equal(result.cli_type, 'claude', `cli_type must be 'claude'; got ${result.cli_type}`);
      // Read-after-write: the new name from this call must be reflected
      assert.equal(result.name, 'post-rename', `name must reflect the rename; got ${result.name}`);
      assert.equal(result.notes, 'engineer-test', `notes must reflect the write; got ${result.notes}`);
      // Cache was invalidated, so a follow-up read sees the same fresh state
      assert.ok(typeof result.state === 'string', `state must be present; got ${typeof result.state}`);
    });
  } finally {
    try { db.deleteSession('mock-198-session'); } catch { /* ignore */ }
    try { db.deleteProject(proj.id); } catch { /* ignore */ }
    try { fs.rmSync(projPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('MCP session_config 404s on missing session (#198 / read-after-write contract)', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await call(port, {
      tool: 'session_config',
      args: { session_id: 'definitely-not-a-real-198-session-id', name: 'noop' },
    });
    assert.equal(r.status, 404, `expected 404; got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error || '', /session not found/i);
  });
});

// #437: session_list previously walked <project>/.claude/sessions/*.jsonl which
// is Claude-only — gemini and codex sessions (rows in the sessions DB table
// with non-claude cli_type) were invisible to MCP clients. The fix queries
// db.getSessionsForProject so all 3 cli_types appear. Mock test seeds rows
// directly via db and asserts the response contains all 3.
test('MCP session_list returns rows for all 3 cli_types (#437)', async () => {
  const db = require('../../src/db');
  const fs = require('fs');
  const os = require('os');
  const { join } = require('path');
  // #619: scratch dir under os.tmpdir(); never write to /data/workspace/.
  const projPath = fs.mkdtempSync(join(os.tmpdir(), 'wb-mock-437-'));
  const proj = db.ensureProject('mock_437_proj', projPath);
  try {
    db.upsertSession('mock-437-claude-session', proj.id, 'claude-sess', 'claude');
    db.upsertSession('mock-437-gemini-session', proj.id, 'gemini-sess', 'gemini');
    db.upsertSession('mock-437-codex-session',  proj.id, 'codex-sess',  'codex');
    await withServer(startMcpApp(), async ({ port }) => {
      const r = await call(port, { tool: 'session_list', args: { project: 'mock_437_proj' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const types = new Set(r.body.result.sessions.map(s => s.cli_type));
      assert.ok(types.has('claude'), `claude session must be listed; got ${[...types]}`);
      assert.ok(types.has('gemini'), `gemini session must be listed; got ${[...types]}`);
      assert.ok(types.has('codex'),  `codex session must be listed; got ${[...types]}`);
      assert.equal(r.body.result.sessions.length, 3, `3 sessions expected; got ${r.body.result.sessions.length}`);
    });
  } finally {
    // Cleanup so re-runs don't accumulate.
    try { db.deleteSession('mock-437-claude-session'); } catch { /* ignore */ }
    try { db.deleteSession('mock-437-gemini-session'); } catch { /* ignore */ }
    try { db.deleteSession('mock-437-codex-session'); }  catch { /* ignore */ }
    try { db.deleteProject(proj.id); } catch { /* ignore */ }
    try { fs.rmSync(projPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
