'use strict';

// #445: project_mcp_enable previously wrote only Claude's <project>/.mcp.json,
// leaving Gemini and Codex sessions in the same project unable to see the
// enabled MCP. The fix writes per-project config for all 3 CLIs. Live test
// drives enable + disable through the API and asserts the expected files
// land + drop in the project workspace.

const test = require('node:test');
const assert = require('node:assert/strict');
const { post } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

async function ensureProj(name) {
  dockerExec(`mkdir -p /data/workspace/${name}`);
  await post('/api/projects', { path: `/data/workspace/${name}`, name });
  return name;
}

async function ensureFixtureMcp() {
  // Idempotent register via the MCP route. The route handles JSON-string vs
  // object coercion correctly.
  await post('/api/mcp/call', {
    tool: 'project_mcp_register',
    args: {
      mcp_name: 'live-445-fixture',
      mcp_transport: 'stdio',
      mcp_config: { command: 'node', args: ['/tmp/fake-mcp.js'], env: { FOO: 'bar' } },
      mcp_description: '#445 live fixture',
    },
  });
}

async function cleanupFixtureMcp() {
  await post('/api/mcp/call', { tool: 'project_mcp_unregister', args: { mcp_name: 'live-445-fixture' } });
}

function readInContainer(path) {
  return dockerExec(`cat ${path} 2>/dev/null || echo ''`);
}

test('#445 project_mcp_enable writes per-project config for claude+gemini+codex', async () => {
  await resetBaseline();
  const proj = await ensureProj('issue445_proj');
  const projPath = `/data/workspace/${proj}`;
  await ensureFixtureMcp();

  try {
    const enableR = await post('/api/mcp/call', {
      tool: 'project_mcp_enable',
      args: { mcp_name: 'live-445-fixture', project: proj },
    });
    assert.equal(enableR.status, 200, `enable: ${JSON.stringify(enableR.data)}`);

    // Claude: <project>/.mcp.json
    const claudeRaw = readInContainer(`${projPath}/.mcp.json`);
    assert.ok(claudeRaw.length > 0, `Claude .mcp.json must exist at ${projPath}/.mcp.json`);
    const claudeJson = JSON.parse(claudeRaw);
    assert.ok(claudeJson.mcpServers['live-445-fixture'], `Claude .mcp.json must include fixture; got ${claudeRaw}`);

    // Gemini: <project>/.gemini/settings.json
    const geminiRaw = readInContainer(`${projPath}/.gemini/settings.json`);
    assert.ok(geminiRaw.length > 0, `Gemini settings.json must exist at ${projPath}/.gemini/settings.json`);
    const geminiJson = JSON.parse(geminiRaw);
    assert.ok(geminiJson.mcpServers['live-445-fixture'], `Gemini settings.json must include fixture; got ${geminiRaw}`);

    // Codex: <project>/.codex/config.toml
    const codexRaw = readInContainer(`${projPath}/.codex/config.toml`);
    assert.ok(codexRaw.length > 0, `Codex config.toml must exist at ${projPath}/.codex/config.toml`);
    assert.match(codexRaw, /\[mcp_servers\.live-445-fixture\]/, `Codex config.toml must declare [mcp_servers.live-445-fixture]; got ${codexRaw}`);
    assert.match(codexRaw, /command = "node"/, 'Codex config.toml must record command');

    // Disable removes from all 3
    const disableR = await post('/api/mcp/call', {
      tool: 'project_mcp_disable',
      args: { mcp_name: 'live-445-fixture', project: proj },
    });
    assert.equal(disableR.status, 200, `disable: ${JSON.stringify(disableR.data)}`);

    const claudeJson2 = JSON.parse(readInContainer(`${projPath}/.mcp.json`));
    assert.ok(!claudeJson2.mcpServers['live-445-fixture'], 'Claude .mcp.json must drop fixture after disable');
    const geminiJson2 = JSON.parse(readInContainer(`${projPath}/.gemini/settings.json`));
    assert.ok(!geminiJson2.mcpServers['live-445-fixture'], 'Gemini settings.json must drop fixture after disable');
    const codexRaw2 = readInContainer(`${projPath}/.codex/config.toml`);
    assert.doesNotMatch(codexRaw2, /\[mcp_servers\.live-445-fixture\]/, 'Codex config.toml must drop fixture after disable');
  } finally {
    await cleanupFixtureMcp();
  }
});
