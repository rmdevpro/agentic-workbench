#!/usr/bin/env node
'use strict';

const http = require('http');
const readline = require('readline');
// #361 [L1]: catalog imported from shared module; the schemas live alongside
// the handlers conceptually now (mcp-tools.js exposes the same array).
const { TOOLS } = require('./mcp-catalog');

const PORT = process.env.PORT || 7860;
const BASE_URL = `http://localhost:${PORT}`;

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (parseErr) {
          if (parseErr instanceof SyntaxError) resolve({ raw: data });
          else reject(parseErr);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function executeTool(name, args) {
  const result = await apiCall('POST', '/api/mcp/call', { tool: name, args });
  if (result.error) throw new Error(result.error);
  return result.result;
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'workbench', version: '0.3.0' },
      });
      break;
    case 'notifications/initialized':
      break;
    case 'tools/list':
      sendResponse(id, { tools: TOOLS });
      break;
    case 'tools/call': {
      const { name, arguments: callArgs } = params;
      try {
        const result = await executeTool(name, callArgs || {});
        sendResponse(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        sendResponse(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }
      break;
    }
    default:
      if (id) sendError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    handleMessage(msg).catch((err) => {
      if (msg.id) sendError(msg.id, -32603, err.message);
    });
  } catch (parseErr) {
    if (parseErr instanceof SyntaxError) {
      /* expected: non-JSON lines on stdin */
    } else {
      process.stderr.write(`[workbench-mcp] Unexpected parse error: ${parseErr.message}\n`);
    }
  }
});

process.stderr.write(`[workbench-mcp] MCP server started (stdio) — ${TOOLS.length} tools\n`);
