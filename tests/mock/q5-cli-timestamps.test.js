'use strict';

// Q5 #408: parseGeminiChatFile + parseCodexRolloutFile fall back to file mtime
// when no message-level timestamp moves the activity forward.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { parseGeminiChatFile, parseCodexRolloutFile } = require('../../src/session-utils.js');

async function planted(content, ext = '.jsonl') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'q5-'));
  const file = path.join(dir, `session${ext}`);
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

test('Q5-PARSE-01: Gemini JSONL with multiple messages — timestamp advances past session-start', async () => {
  const startTime = '2026-05-09T01:00:00.000Z';
  const lastMsgTime = '2026-05-09T01:30:00.000Z';
  const header = JSON.stringify({ sessionId: 'gem-1', startTime, lastUpdated: startTime, kind: 'gemini' });
  const msg1 = JSON.stringify({ type: 'user', content: 'first prompt', timestamp: lastMsgTime });
  const msg2 = JSON.stringify({ type: 'gemini', content: 'reply', timestamp: lastMsgTime, model: 'gemini-2' });
  const file = await planted([header, msg1, msg2].join('\n'));
  const meta = parseGeminiChatFile(file);
  assert.ok(meta, 'parser must return metadata');
  // message-level timestamp must beat the header startTime (proves it advances)
  assert.ok(new Date(meta.timestamp) >= new Date(lastMsgTime), `timestamp must advance to message-level. got: ${meta.timestamp}`);
  assert.equal(meta.messageCount, 2);
  assert.equal(meta.model, 'gemini-2');
});

test('Q5-PARSE-02: Gemini JSONL with no message timestamps — falls back to file mtime', async () => {
  const startTime = '2026-05-09T01:00:00.000Z';
  const header = JSON.stringify({ sessionId: 'gem-2', startTime, lastUpdated: startTime, kind: 'gemini' });
  // Single user message with NO timestamp field
  const msg = JSON.stringify({ type: 'user', content: 'hello' });
  const file = await planted([header, msg].join('\n'));
  // Bump file mtime to simulate recent append
  const futureMs = Date.now() + 10000;
  fs.utimesSync(file, futureMs / 1000, futureMs / 1000);

  const meta = parseGeminiChatFile(file);
  assert.ok(meta);
  // mtime fallback → timestamp must be later than header startTime
  assert.ok(
    new Date(meta.timestamp) > new Date(startTime),
    `mtime fallback must advance timestamp past startTime. got: ${meta.timestamp} vs startTime ${startTime}`,
  );
});

test('Q5-PARSE-03: Codex rollout — header timestamp + later mtime → mtime wins (activity sort)', async () => {
  const sessionStart = '2026-05-09T01:00:00.000Z';
  const headerLine = JSON.stringify({ type: 'session_meta', timestamp: sessionStart, payload: { sessionId: 'cdx-1' } });
  // response_items don't carry timestamp by default
  const r1 = JSON.stringify({ type: 'response_item', payload: { role: 'user', content: 'q' } });
  const r2 = JSON.stringify({ type: 'response_item', payload: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } });
  const file = await planted([headerLine, r1, r2].join('\n'));
  // Bump mtime to "now"
  const futureMs = Date.now() + 5000;
  fs.utimesSync(file, futureMs / 1000, futureMs / 1000);

  const meta = parseCodexRolloutFile(file);
  assert.ok(meta);
  assert.ok(
    new Date(meta.timestamp) > new Date(sessionStart),
    `mtime fallback must advance Codex timestamp past sessionStart. got: ${meta.timestamp}`,
  );
  assert.equal(meta.messageCount, 2);
});

test('Q5-PARSE-04: Codex rollout — entry-level timestamp newer than mtime is kept', async () => {
  const headerLine = JSON.stringify({ type: 'session_meta', timestamp: '2026-05-09T01:00:00.000Z', payload: {} });
  // entry with explicit later timestamp
  const r1 = JSON.stringify({ type: 'response_item', timestamp: '2026-05-09T03:00:00.000Z', payload: { role: 'user', content: 'q' } });
  const file = await planted([headerLine, r1].join('\n'));
  // Set mtime BEFORE the entry-level timestamp (1 hour ago)
  const oldSec = Date.now() / 1000 - 3600;
  fs.utimesSync(file, oldSec, oldSec);

  const meta = parseCodexRolloutFile(file);
  assert.ok(meta);
  // Either entry-level (winning case) or mtime — both must be > session-start
  assert.ok(
    new Date(meta.timestamp) > new Date('2026-05-09T01:00:00.000Z'),
    `timestamp must advance past session_start. got: ${meta.timestamp}`,
  );
});
