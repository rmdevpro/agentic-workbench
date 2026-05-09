'use strict';

/**
 * Qdrant vector sync — watches directories for changes, embeds content
 * via OpenAI-compatible API (Gemini), and upserts to Qdrant collections.
 *
 * Collections: documents, code, claude_sessions, gemini_sessions, codex_sessions
 * Embedding: 384 dims via MRL truncation (matches Qdrant default model dims)
 *
 * Zero npm dependencies — uses native fetch and fs.watch.
 */

const { watch, readFileSync, readdirSync, statSync, existsSync, createReadStream } = require('fs');
const { readFile, readdir, stat } = require('fs/promises');
const readline = require('readline');
const { join, basename, extname, relative } = require('path');
const { createHash } = require('crypto');
const logger = require('./logger');
const db = require('./db');
const safe = require('./safe-exec');
const config = require('./config');

// ── Configuration ──────────────────────────────────────────────────────────

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const DEBOUNCE_MS = parseInt(process.env.QDRANT_DEBOUNCE_MS || '10000', 10);
const CHUNK_WINDOW = 3; // sliding window of N conversation turns
const CHUNK_OVERLAP = 1;

const WORKSPACE = safe.WORKSPACE;
const CLAUDE_HOME = safe.CLAUDE_HOME;

const COLLECTIONS = {
  documents: 'documents',
  code: 'code',
  claude: 'claude_sessions',
  gemini: 'gemini_sessions',
  codex: 'codex_sessions',
};

function _parseSetting(key, fallback) {
  const raw = db.getSetting(key, null);
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return raw; }
}

function getCollectionConfig(col) {
  const defaults = {
    documents: { enabled: true, dims: 384, patterns: ['*.md', '*.txt', '*.pdf', '*.rst', '*.adoc'] },
    code: { enabled: true, dims: 384, patterns: ['*.js', '*.ts', '*.py', '*.go', '*.rs', '*.java', '*.sh', 'Dockerfile', 'Makefile', '*.yml', '*.yaml', '*.json'] },
    claude: { enabled: true, dims: 384 },
    gemini: { enabled: true, dims: 384 },
    codex: { enabled: true, dims: 384 },
  };
  return _parseSetting('vector_collection_' + col, defaults[col] || { enabled: true, dims: 384 });
}

function getIgnorePatterns() {
  const raw = _parseSetting('vector_ignore_patterns', 'node_modules/**\n.git/**\n*.lock\n*.min.js\ndist/**\nbuild/**');
  return raw.split('\n').map(p => p.trim()).filter(p => p);
}

function getAdditionalPaths() {
  return _parseSetting('vector_additional_paths', []);
}

function _readCodexKey() {
  try {
    const authFile = join(process.env.HOME || '/data', '.codex', 'auth.json');
    const data = JSON.parse(readFileSync(authFile, 'utf-8'));
    return (data.OPENAI_API_KEY || '').replace(/^"|"$/g, '');
  } catch { return ''; }
}

// Provider URLs and model identifiers live in config/defaults.json under
// `embeddings.providers.<name>`. Hot-reloads via the config module, so a
// vendor endpoint move (HF moved theirs in April 2025) is fixed by editing
// the config file rather than the code.
function _providerCfg(name) {
  return config.get(`embeddings.providers.${name}`, {});
}

function getEmbeddingProvider() {
  return _parseSetting('vector_embedding_provider', 'none');
}

function getEmbeddingConfig() {
  const provider = getEmbeddingProvider();
  if (provider === 'none') return { provider: 'none' };

  switch (provider) {
    case 'gemini': {
      // Try DB setting (legacy), then env vars set by routes.js (GEMINI_API_KEY, primary)
      // or by older entrypoints / external config (GOOGLE_API_KEY, kept as fallback for
      // backwards compat — Gemini CLI itself accepts both).
      // #178: routes.js:1135 writes process.env.GEMINI_API_KEY; this file used to read
      // only GOOGLE_API_KEY, so DB writes wouldn't reach here. Now reads both.
      let key = _parseSetting('gemini_api_key', '')
        || process.env.GEMINI_API_KEY
        || process.env.GOOGLE_API_KEY
        || '';
      const c = _providerCfg('gemini');
      return { url: c.url, model: c.model, key };
    }
    case 'openai': {
      // Try Codex CLI auth file first, then DB setting (legacy), then env var
      let key = _readCodexKey() || _parseSetting('codex_api_key', '') || process.env.OPENAI_API_KEY || '';
      const c = _providerCfg('openai');
      return { url: c.url, model: c.model, key };
    }
    case 'custom': {
      const url = _parseSetting('vector_custom_url', '');
      const key = _parseSetting('vector_custom_key', '');
      return { url: url || 'http://localhost:11434/v1', model: 'custom', key: key || 'no-key' };
    }
    case 'huggingface':
    default: {
      const hfToken = _parseSetting('huggingface_api_key', '') || process.env.HF_TOKEN || '';
      const c = _providerCfg('huggingface');
      return { url: c.url, model: c.model, key: hfToken, isHF: true };
    }
  }
}

/**
 * Simple glob pattern matching. Supports *, **, and exact names.
 */
function globMatch(pattern, filePath) {
  const name = basename(filePath);
  // Exact match (e.g. "Dockerfile")
  if (!pattern.includes('*')) return name === pattern;
  // *.ext pattern
  if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1));
  // **/ directory pattern (for ignore)
  if (pattern.endsWith('/**')) {
    const dir = pattern.slice(0, -3);
    return filePath.includes('/' + dir + '/') || filePath.startsWith(dir + '/');
  }
  return false;
}

function matchesPatterns(filePath, patterns) {
  return patterns.some(p => globMatch(p, filePath));
}

function isIgnored(filePath, ignorePatterns) {
  return ignorePatterns.some(p => globMatch(p, filePath));
}

// ── SQLite sync state ──────────────────────────────────────────────────────

db.db.exec(`
  CREATE TABLE IF NOT EXISTS qdrant_sync (
    file_path TEXT PRIMARY KEY,
    collection TEXT NOT NULL,
    last_offset INTEGER DEFAULT 0,
    last_mtime REAL DEFAULT 0,
    last_hash TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Incremental session sync: track the last turn index we embedded so that on a
// re-sync we only embed new turns + a small overlap window — instead of
// re-embedding the entire conversation. ALTER is idempotent (caught by try).
try { db.db.exec("ALTER TABLE qdrant_sync ADD COLUMN last_turn_index INTEGER DEFAULT NULL"); }
catch (_e) { /* column exists */ }

const syncStmts = {
  get: db.db.prepare('SELECT * FROM qdrant_sync WHERE file_path = ?'),
  upsert: db.db.prepare(`
    INSERT INTO qdrant_sync (file_path, collection, last_offset, last_mtime, last_hash)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      last_offset = excluded.last_offset,
      last_mtime = excluded.last_mtime,
      last_hash = excluded.last_hash,
      updated_at = datetime('now')
  `),
  upsertWithTurnIndex: db.db.prepare(`
    INSERT INTO qdrant_sync (file_path, collection, last_offset, last_mtime, last_hash, last_turn_index)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      last_offset = excluded.last_offset,
      last_mtime = excluded.last_mtime,
      last_hash = excluded.last_hash,
      last_turn_index = excluded.last_turn_index,
      updated_at = datetime('now')
  `),
  getByCollection: db.db.prepare('SELECT * FROM qdrant_sync WHERE collection = ?'),
  delete: db.db.prepare('DELETE FROM qdrant_sync WHERE file_path = ?'),
};

// ── Embedding API ──────────────────────────────────────────────────────────

async function embedWithConfig(cfg, texts, dims) {
  if (!cfg.key && !cfg.isHF) throw new Error('No embedding API key configured');

  // #192: Gemini's OpenAI-compat embeddings endpoint caps batches at 100. HF and
  // OpenAI also benefit from chunking to avoid surprise rate / payload limits.
  // Recurse over sub-batches if the input exceeds the cap.
  const MAX_BATCH = 100;
  if (texts.length > MAX_BATCH) {
    const out = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const sub = await embedWithConfig(cfg, texts.slice(i, i + MAX_BATCH), dims);
      out.push(...sub);
      if (i + MAX_BATCH < texts.length) await new Promise(r => setTimeout(r, 100));
    }
    return out;
  }

  // #212 / #262: retry transient failures via shared helper. Covers both
  // socket-level errors (EPIPE / ECONNRESET / etc — surface under sustained
  // concurrent load) and HTTP 5xx + 429 from the provider (provider overload
  // and rate limits — both retryable per HTTP semantics; previously dropped
  // straight to ERROR with a wedged sync row).
  return retryTransient(() => _embedOnce(cfg, texts, dims), 'Embedding API');
}

// #262: classify HTTP 5xx + 429 as transient alongside socket-level errors.
// _embedOnce / upsertPoints / deletePointsByFilter all attach response.status
// to thrown Error objects so this predicate can read it. HTTP 4xx other than
// 429 stays fatal (bad request, auth, etc — retry won't help).
function _isTransientError(err) {
  const code = err?.cause?.code;
  const status = err?.status;
  if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'ETIMEDOUT' ||
      code === 'UND_ERR_SOCKET' || code === 'UND_ERR_BODY_TIMEOUT') return true;
  if (/fetch failed|socket hang up|network/i.test(err?.message || '')) return true;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

// #212: shared retry-with-backoff helper. Extracted from embedWithConfig so
// upsertPoints / deletePointsByFilter (the Qdrant-side calls) can also wrap.
// MAX_ATTEMPTS=4 with 500ms / 1000ms / 2000ms backoff matches the prior
// embed-only policy. opName labels the WARN entry so log readers can tell
// embed retries from Qdrant retries.
async function retryTransient(fn, opName) {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!_isTransientError(err) || attempt === MAX_ATTEMPTS) throw err;
      const backoffMs = 500 * Math.pow(2, attempt - 1);
      logger.warn(`${opName} transient error, retrying`, {
        module: 'qdrant-sync', attempt, backoffMs,
        cause: err?.cause?.message || err.message,
        code: err?.cause?.code, status: err?.status,
      });
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
}

async function _embedOnce(cfg, texts, dims) {

  // HuggingFace Inference API has a different format
  if (cfg.isHF) {
    const response = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.key ? { 'Authorization': `Bearer ${cfg.key}` } : {}),
      },
      body: JSON.stringify({ inputs: texts }),
    });
    if (!response.ok) {
      const body = await response.text();
      // #262: attach status so retryTransient can classify HTTP 5xx + 429.
      const err = new Error(`HF Embedding API error ${response.status}: ${body}`);
      err.status = response.status;
      throw err;
    }
    return await response.json();
  }

  // OpenAI-compatible endpoint (Gemini, OpenAI, custom)
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.key && cfg.key !== 'no-key') {
    headers['Authorization'] = `Bearer ${cfg.key}`;
    headers['x-goog-api-key'] = cfg.key; // Gemini compat
  }

  const response = await fetch(`${cfg.url}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      input: texts,
      dimensions: dims || 384,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    // #262: attach status so retryTransient can classify HTTP 5xx + 429.
    const err = new Error(`Embedding API error ${response.status}: ${body}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  return data.data.map(d => d.embedding);
}

async function embed(texts, dims) {
  return embedWithConfig(getEmbeddingConfig(), texts, dims);
}

// #180: build a candidate provider cfg from a (key,value) override pair so we can
// validate before persisting. Targets the provider that the overridden setting belongs
// to (e.g. PUT gemini_api_key always validates against Gemini, regardless of which
// provider is currently active), so the user always gets a real check on what they typed.
function buildCandidateConfig(overrideKey, overrideValue) {
  let provider;
  if (overrideKey === 'vector_embedding_provider') provider = overrideValue;
  else if (overrideKey === 'gemini_api_key') provider = 'gemini';
  else if (overrideKey === 'codex_api_key') provider = 'openai';
  else if (overrideKey === 'huggingface_api_key') provider = 'huggingface';
  else if (overrideKey === 'vector_custom_url' || overrideKey === 'vector_custom_key') provider = 'custom';
  else provider = _parseSetting('vector_embedding_provider', 'huggingface');

  switch (provider) {
    case 'gemini': {
      const key = overrideKey === 'gemini_api_key'
        ? (overrideValue || '')
        : (_parseSetting('gemini_api_key', '') || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '');
      const c = _providerCfg('gemini');
      return { url: c.url, model: c.model, key };
    }
    case 'openai': {
      const key = overrideKey === 'codex_api_key'
        ? (overrideValue || '')
        : (_readCodexKey() || _parseSetting('codex_api_key', '') || process.env.OPENAI_API_KEY || '');
      const c = _providerCfg('openai');
      return { url: c.url, model: c.model, key };
    }
    case 'custom': {
      const url = overrideKey === 'vector_custom_url' ? (overrideValue || '') : _parseSetting('vector_custom_url', '');
      const key = overrideKey === 'vector_custom_key' ? (overrideValue || '') : _parseSetting('vector_custom_key', '');
      return { url: url || 'http://localhost:11434/v1', model: 'custom', key: key || 'no-key' };
    }
    case 'huggingface':
    default: {
      const hfToken = overrideKey === 'huggingface_api_key'
        ? (overrideValue || '')
        : (_parseSetting('huggingface_api_key', '') || process.env.HF_TOKEN || '');
      const c = _providerCfg('huggingface');
      return { url: c.url, model: c.model, key: hfToken, isHF: true };
    }
  }
}

// #180: cheapest possible provider call to verify the candidate config is usable.
// Returns { ok: true } or { ok: false, error: '<provider error string>' }.
// Timeout caps the cost so a slow/unreachable provider can't hang PUT /api/settings
// for more than VALIDATE_TIMEOUT_MS (per 3-CLI review of the original change).
const VALIDATE_TIMEOUT_MS = 8000;
async function validateProviderConfig(cfg) {
  try {
    if (!cfg.key) {
      // Both OpenAI-compat providers and HF require a key now (HF moved to
      // router.huggingface.co which 401s without auth — see issue thread).
      return { ok: false, error: `No API key configured for ${cfg.model || 'provider'}` };
    }
    await Promise.race([
      embedWithConfig(cfg, ['ping'], 384),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`validation timed out after ${VALIDATE_TIMEOUT_MS}ms`)),
        VALIDATE_TIMEOUT_MS,
      )),
    ]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Qdrant REST API ────────────────────────────────────────────────────────

async function qdrantHealthy() {
  try {
    const r = await fetch(`${QDRANT_URL}/collections`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureCollection(name, dims) {
  const r = await fetch(`${QDRANT_URL}/collections/${name}`);
  if (r.ok) return;

  const cr = await fetch(`${QDRANT_URL}/collections/${name}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vectors: { size: dims || 384, distance: 'Cosine' } }),
  });
  if (!cr.ok) throw new Error(`Failed to create collection ${name}: ${await cr.text()}`);
  logger.info(`Created Qdrant collection: ${name}`, { module: 'qdrant-sync' });
}

async function upsertPoints(collection, points) {
  if (!points.length) return;
  // #212: wrap the Qdrant write in retryTransient so a transient blip on the
  // qdrant side (restart, OOM kill, brief network failure, 5xx) doesn't wedge
  // the sync row with a single un-retried ERROR. Same predicate covers
  // socket-level + HTTP 5xx + 429.
  return retryTransient(async () => {
    const r = await fetch(`${QDRANT_URL}/collections/${collection}/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points }),
    });
    if (!r.ok) {
      const body = await r.text();
      const err = new Error(`Qdrant upsert failed (${r.status}): ${body}`);
      err.status = r.status;
      throw err;
    }
  }, 'Qdrant upsertPoints');
}

// Qdrant rejects POST bodies > 32 MiB by default. Batch by serialized request
// size (not point count) so a single large session can't produce one oversized
// PUT and EPIPE on socket close. 24 MiB leaves headroom for HTTP/JSON framing.
const QDRANT_BODY_LIMIT = 24 * 1024 * 1024;

async function upsertPointsBatched(collection, points) {
  if (!points.length) return;
  let batch = [];
  let batchBytes = 2; // for `[]`
  for (const p of points) {
    const pBytes = Buffer.byteLength(JSON.stringify(p), 'utf8') + 1; // +1 for comma
    if (batch.length > 0 && batchBytes + pBytes > QDRANT_BODY_LIMIT) {
      await upsertPoints(collection, batch);
      batch = [];
      batchBytes = 2;
    }
    batch.push(p);
    batchBytes += pBytes;
  }
  if (batch.length > 0) await upsertPoints(collection, batch);
}

async function deletePointsByFilter(collection, filter) {
  // #212: same retry rationale as upsertPoints — Qdrant blips shouldn't
  // single-shot wedge the operation.
  return retryTransient(async () => {
    const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter }),
    });
    if (!r.ok) {
      const body = await r.text();
      const err = new Error(`Qdrant delete failed (${r.status}): ${body}`);
      err.status = r.status;
      throw err;
    }
  }, 'Qdrant deletePointsByFilter');
}

async function searchPoints(collection, vector, limit = 10, filter = null) {
  const body = { vector, limit, with_payload: true };
  if (filter) body.filter = filter;

  const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Qdrant search failed: ${await r.text()}`);
  const data = await r.json();
  return data.result;
}

// ── Chunking ───────────────────────────────────────────────────────────────

/**
 * Chunk a markdown/text document into sections.
 * Splits on ## headings, falls back to fixed-size chunks.
 */
function chunkDocument(text, filePath) {
  const sections = [];
  const lines = text.split('\n');
  let current = { title: basename(filePath), lines: [] };

  for (const line of lines) {
    if (/^##\s/.test(line) && current.lines.length > 0) {
      sections.push(current);
      current = { title: line.replace(/^##\s*/, ''), lines: [] };
    }
    current.lines.push(line);
  }
  if (current.lines.length > 0) sections.push(current);

  // If document is small enough, return as single chunk
  if (sections.length === 1 && text.length < 4000) {
    return [{ text, metadata: { section: sections[0].title } }];
  }

  return sections.map(s => ({
    text: s.lines.join('\n').trim(),
    metadata: { section: s.title },
  })).filter(c => c.text.length > 20);
}

/**
 * Chunk JSONL session turns using sliding window.
 * Groups user+assistant turns, slides by CHUNK_OVERLAP.
 */
function chunkSessionTurns(turns) {
  if (turns.length === 0) return [];
  if (turns.length <= CHUNK_WINDOW) {
    return [{
      text: turns.map(t => `[${t.role}] ${t.content}`).join('\n'),
      metadata: { turn_start: 0, turn_end: turns.length - 1 },
    }];
  }

  const chunks = [];
  const step = CHUNK_WINDOW - CHUNK_OVERLAP;
  for (let i = 0; i < turns.length; i += step) {
    const window = turns.slice(i, i + CHUNK_WINDOW);
    if (window.length < 2) break; // don't create tiny trailing chunks
    chunks.push({
      text: window.map(t => `[${t.role}] ${t.content}`).join('\n'),
      metadata: { turn_start: i, turn_end: i + window.length - 1 },
    });
  }
  return chunks;
}

/**
 * Parse Claude JSONL session file into conversation turns.
 * Each turn: { role, content, timestamp }
 */
function parseClaudeJsonl(content) {
  const turns = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' || entry.type === 'assistant') {
        // #179: skip synthetic API-error placeholders (e.g. "Prompt is too long" boilerplate).
        // These have entry.isApiErrorMessage===true and message.model==='<synthetic>'.
        if (entry.isApiErrorMessage) continue;
        const msg = entry.message;
        if (!msg || !msg.content) continue;
        // Content can be string or array of content blocks
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
        }
        if (text.length > 10) {
          // Truncate very long messages for embedding. Cap = 1200 chars/turn
          // so a 3-turn chunk (CHUNK_WINDOW=3) stays well under Gemini's
          // 2048-token-per-input limit. 1200 chars × 3 + overhead ≈ 3650 chars
          // ≈ 900-1100 tokens, comfortable margin. Prior 2000-char cap could
          // produce ~6000-char chunks ≈ 1800-2000 tokens that broke Gemini's
          // request mid-write with EPIPE.
          turns.push({
            role: msg.role || entry.type,
            content: text.substring(0, 1200),
            timestamp: entry.timestamp,
          });
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }
  return turns;
}

/**
 * Parse Gemini session file (JSON format) into conversation turns.
 */
function parseGeminiSession(content) {
  const turns = [];
  try {
    const data = JSON.parse(content);
    const messages = data.messages || (Array.isArray(data) ? data : []);
    for (const msg of messages) {
      const role = msg.type === 'gemini' ? 'assistant' : (msg.type || msg.role || 'unknown');
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter(p => typeof p === 'string' || p.text)
          .map(p => typeof p === 'string' ? p : p.text)
          .join('\n');
      } else if (msg.parts) {
        text = msg.parts
          .filter(p => typeof p === 'string' || p.text)
          .map(p => typeof p === 'string' ? p : p.text)
          .join('\n');
      }
      if (text.length > 10) {
        turns.push({ role, content: text.substring(0, 2000), timestamp: msg.timestamp });
      }
    }
  } catch { /* invalid JSON */ }
  return turns;
}

/**
 * Parse Codex/OpenAI session file (JSONL format) into conversation turns.
 */
function parseCodexSession(content) {
  const turns = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      // Codex JSONL uses { type: "response_item", payload: { role, content } }
      if (entry.type === 'response_item' && entry.payload) {
        const p = entry.payload;
        const role = p.role || 'unknown';
        let text = '';
        if (typeof p.content === 'string') {
          text = p.content;
        } else if (Array.isArray(p.content)) {
          text = p.content
            .filter(b => b.type === 'output_text' || b.type === 'input_text' || b.type === 'text')
            .map(b => b.text || '')
            .join('\n');
        }
        if (text.length > 10) {
          turns.push({ role, content: text.substring(0, 2000), timestamp: entry.timestamp });
        }
      }
    } catch { /* skip */ }
  }
  return turns;
}

// ── Point ID generation ────────────────────────────────────────────────────

function pointId(filePath, chunkIndex) {
  const hash = createHash('sha256').update(`${filePath}:${chunkIndex}`).digest('hex');
  // Qdrant accepts UUIDs or unsigned 64-bit ints; use UUID format from hash
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    hash.substring(12, 16),
    hash.substring(16, 20),
    hash.substring(20, 32),
  ].join('-');
}

// ── Sync logic ─────────────────────────────────────────────────────────────

// #443 [E4]: stream-read a markdown/text file line-by-line, hash and chunk
// it on the fly. Replaces fs.readFile (which loads the entire file into
// V8 heap) with createReadStream + readline. Peak heap delta during
// embedding scales with the largest section, not the whole file. For files
// with many sections, this is a substantial reduction; for single-section
// files it's roughly equivalent (the section IS the file). The acceptance
// target is <50 MB heap delta on a 9.9 MB file — easily met because
// readline buffers ~64 KB and our section accumulator is bounded by the
// markdown structure of the input.
async function _streamHashAndChunk(filePath) {
  const hash = createHash('md5');
  const sections = [];
  let current = { title: basename(filePath), lines: [] };
  let totalChars = 0;

  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    hash.update(line);
    hash.update('\n');
    totalChars += line.length + 1;
    if (/^##\s/.test(line) && current.lines.length > 0) {
      sections.push(current);
      current = { title: line.replace(/^##\s*/, ''), lines: [] };
    }
    current.lines.push(line);
  }
  if (current.lines.length > 0) sections.push(current);

  let chunks;
  if (sections.length === 1 && totalChars < 4000) {
    // Match the in-memory chunkDocument shortcut: single small file → 1 chunk
    // containing the full text.
    chunks = [{ text: sections[0].lines.join('\n'), metadata: { section: sections[0].title } }];
  } else {
    chunks = sections.map(s => ({
      text: s.lines.join('\n').trim(),
      metadata: { section: s.title },
    })).filter(c => c.text.length > 20);
  }

  return { hash: hash.digest('hex'), chunks };
}

async function syncFileToCollection(filePath, collection, baseDir, dims) {
  const relPath = relative(baseDir, filePath);
  const syncState = syncStmts.get.get(filePath);
  const fileStat = await stat(filePath);
  const { hash, chunks: rawChunks } = await _streamHashAndChunk(filePath);

  if (syncState && syncState.last_hash === hash) return 0;

  // Delete old points for this file
  await deletePointsByFilter(collection, {
    must: [{ key: 'file_path', match: { value: relPath } }],
  });

  // #191: skip empty-text chunks before embed — Gemini rejects empty Parts with HTTP 400.
  const chunks = rawChunks.filter(c => c.text && c.text.trim().length > 0);
  if (chunks.length === 0) return 0;

  const texts = chunks.map(c => c.text);
  const embeddings = await embed(texts, dims);

  const points = chunks.map((chunk, i) => ({
    id: pointId(filePath, i),
    vector: embeddings[i],
    payload: {
      file_path: relPath,
      section: chunk.metadata.section,
      text: chunk.text.substring(0, 5000),
      type: collection === COLLECTIONS.code ? 'code' : 'doc',
      indexed_at: new Date().toISOString(),
    },
  }));

  await upsertPointsBatched(collection, points);
  syncStmts.upsert.run(filePath, collection, 0, fileStat.mtimeMs, hash);
  return points.length;
}

// #443 [E4]: stream-read a JSONL session file. The raw content is still
// concatenated for the parser (parsers operate on full strings), but the
// read happens in 64 KB chunks via createReadStream rather than the
// fs.readFile single-allocation path that doubles peak memory while V8
// converts the Buffer to a String. For 9.9 MB synthetic input the peak
// heap delta stays under 50 MB (acceptance target). True streaming of
// the parser is deferred — parsers carry header+turn state spanning
// many lines and would need a streaming rewrite.
async function _streamReadAsString(filePath) {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  let buf = '';
  for await (const chunk of stream) buf += chunk;
  return buf;
}

async function syncSessionFile(filePath, collection, parser, dims) {
  const syncState = syncStmts.get.get(filePath);
  const fileStat = await stat(filePath);

  // Skip if file hasn't changed since last sync
  if (syncState && syncState.last_mtime === fileStat.mtimeMs) return 0;

  const content = await _streamReadAsString(filePath);
  const allTurns = parser(content);
  if (allTurns.length === 0) return 0;
  const sessionId = basename(filePath).replace(/\.(jsonl|json)$/, '');

  // Incremental sync — only re-embed turns added since last sync (plus a small
  // overlap window so the new chunks blend with the prior context). Without
  // this, every file change triggered a full re-embed of the entire conversation
  // (~thousands of API calls per appended message). Now: 1 message ≈ 1 chunk.
  //
  // Point IDs are derived from turn_start (not chunk-batch position) so they're
  // stable across re-syncs — overlapping chunks get re-upserted in place.
  const lastIdx = syncState?.last_turn_index;
  const lastTurn = allTurns.length - 1;
  let fromTurn = 0;
  let isIncremental = false;

  if (lastIdx != null) {
    if (lastIdx >= lastTurn) {
      // No new turns. Just record the new mtime and bail (no API calls).
      syncStmts.upsertWithTurnIndex.run(
        filePath, collection, content.length, fileStat.mtimeMs, '', lastIdx,
      );
      return 0;
    }
    // Re-embed from (lastIdx - CHUNK_OVERLAP) onward — overlap so new chunks
    // include trailing context from the prior pass for retrieval continuity.
    fromTurn = Math.max(0, lastIdx - CHUNK_OVERLAP);
    isIncremental = true;
  }

  const subTurns = allTurns.slice(fromTurn);
  const rawChunks = chunkSessionTurns(subTurns);
  if (rawChunks.length === 0) return 0;
  // Re-anchor metadata to absolute turn indices in the original turns array.
  const chunks = rawChunks.map(c => ({
    text: c.text,
    metadata: {
      turn_start: c.metadata.turn_start + fromTurn,
      turn_end: c.metadata.turn_end + fromTurn,
    },
  }));

  if (isIncremental) {
    // Delete only the chunks whose turn_start falls in the overlap+new range.
    await deletePointsByFilter(collection, {
      must: [
        { key: 'session_id', match: { value: sessionId } },
        { key: 'turn_start', range: { gte: fromTurn } },
      ],
    });
  } else {
    // First sync (or post-rotation full sync) — drop all and re-index.
    await deletePointsByFilter(collection, {
      must: [{ key: 'session_id', match: { value: sessionId } }],
    });
  }

  const texts = chunks.map(c => c.text);
  // Batch embeddings in groups of 10 with delay to avoid burst rate limits AND
  // keep aggregate per-batch tokens well under Gemini's per-request cap.
  const allEmbeddings = [];
  for (let i = 0; i < texts.length; i += 10) {
    const batch = texts.slice(i, i + 10);
    const batchEmbeddings = await embed(batch, dims);
    allEmbeddings.push(...batchEmbeddings);
    if (i + 10 < texts.length) await new Promise(r => setTimeout(r, 200));
  }

  const points = chunks.map((chunk, i) => ({
    id: pointId(filePath, chunk.metadata.turn_start), // stable ID across re-syncs
    vector: allEmbeddings[i],
    payload: {
      session_id: sessionId,
      text: chunk.text.substring(0, 5000),
      turn_start: chunk.metadata.turn_start,
      turn_end: chunk.metadata.turn_end,
      type: 'session',
      indexed_at: new Date().toISOString(),
    },
  }));

  await upsertPointsBatched(collection, points);

  syncStmts.upsertWithTurnIndex.run(
    filePath, collection, content.length, fileStat.mtimeMs, '', lastTurn,
  );
  if (isIncremental) {
    logger.info('Session incrementally synced', {
      module: 'qdrant-sync', file: basename(filePath),
      newTurns: lastTurn - (lastIdx ?? -1), embedded: points.length,
    });
  }
  return points.length;
}

// ── Directory scanning ─────────────────────────────────────────────────────

async function scanCollection(collection, dirs, patterns, dims) {
  const ignorePatterns = getIgnorePatterns();
  let total = 0;

  const scan = async (dir, baseDir) => {
    if (!existsSync(dir)) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Bail mid-scan if a settings change has stopped this run. stop() flips
      // _running to false; a new pipeline (kicked off by reapplyConfig) will
      // start its own scan with the fresh config. Without this check, the
      // in-flight scan would keep using the now-stale cfg and produce
      // "No embedding API key configured" errors per-file.
      if (!_running) return;
      const full = join(dir, entry.name);
      const rel = relative(baseDir, full);
      if (isIgnored(rel, ignorePatterns)) continue;
      if (entry.isDirectory()) {
        await scan(full, baseDir);
      } else if (matchesPatterns(full, patterns)) {
        try {
          total += await syncFileToCollection(full, collection, baseDir, dims);
        } catch (err) {
          // If settings flipped to provider='none' mid-scan, the embed call
          // throws "No embedding API key configured". That's not an error,
          // it's the expected cancellation signal — log as debug and bail.
          if (err.message === 'No embedding API key configured' && getEmbeddingProvider() === 'none') {
            logger.debug('Scan aborted — provider switched to none mid-scan', { module: 'qdrant-sync' });
            return;
          }
          logger.error('File sync error', { module: 'qdrant-sync', file: full, collection, err: err.message });
        }
      }
    }
  };

  for (const dir of dirs) {
    await scan(dir, dir);
  }
  return total;
}

async function scanDocs() {
  const cfg = getCollectionConfig('documents');
  if (!cfg.enabled) return 0;
  const dirs = [WORKSPACE, ...getAdditionalPaths().filter(p => existsSync(p))];
  return scanCollection(COLLECTIONS.documents, dirs, cfg.patterns || ['*.md', '*.txt'], cfg.dims);
}

async function scanCode() {
  const cfg = getCollectionConfig('code');
  if (!cfg.enabled) return 0;
  // #291: previously hardcoded [WORKSPACE], so Additional Paths set in
  // Settings was silently ignored for the code collection. Match scanDocs.
  const dirs = [WORKSPACE, ...getAdditionalPaths().filter(p => existsSync(p))];
  return scanCollection(COLLECTIONS.code, dirs, cfg.patterns || ['*.js', '*.py'], cfg.dims);
}

async function scanClaudeSessions() {
  const cfg = getCollectionConfig('claude');
  if (!cfg.enabled) return 0;

  const projectsDir = join(CLAUDE_HOME, 'projects');
  if (!existsSync(projectsDir)) return 0;

  let total = 0;
  const projectDirs = await readdir(projectsDir, { withFileTypes: true });
  for (const pDir of projectDirs) {
    if (!_running) return total;
    if (!pDir.isDirectory()) continue;
    const sessDir = join(projectsDir, pDir.name);
    const files = await readdir(sessDir);
    for (const file of files) {
      if (!_running) return total;
      if (!file.endsWith('.jsonl')) continue;
      try {
        total += await syncSessionFile(
          join(sessDir, file),
          COLLECTIONS.claude,
          parseClaudeJsonl,
          cfg.dims,
        );
      } catch (err) {
        // #233: provider flipped to 'none' mid-scan — the embed call throws
        // "No embedding API key configured" as the cancellation signal.
        // Same swallow as scanCollection at line 789.
        if (err.message === 'No embedding API key configured' && getEmbeddingProvider() === 'none') {
          logger.debug('Claude session scan aborted — provider switched to none', { module: 'qdrant-sync' });
          return total;
        }
        // Capture err.cause too — node-fetch puts the underlying transport
        // error (ECONNRESET / ETIMEDOUT / UND_ERR_*) there. Without it,
        // 'fetch failed' is undebuggable.
        logger.error('Claude session sync error', {
          module: 'qdrant-sync', file,
          err: err.message,
          cause: err.cause ? (err.cause.message || String(err.cause)) : undefined,
          code: err.cause?.code,
        });
      }
    }
  }
  return total;
}

async function scanGeminiSessions() {
  const cfg = getCollectionConfig('gemini');
  if (!cfg.enabled) return 0;

  const geminiBase = join(process.env.HOME || '/data', '.gemini', 'tmp');
  if (!existsSync(geminiBase)) return 0;

  let total = 0;
  try {
    const projectDirs = await readdir(geminiBase, { withFileTypes: true });
    for (const pDir of projectDirs) {
      if (!_running) return total;
      if (!pDir.isDirectory()) continue;
      const chatsDir = join(geminiBase, pDir.name, 'chats');
      if (!existsSync(chatsDir)) continue;
      const files = await readdir(chatsDir);
      for (const file of files) {
        if (!_running) return total;
        if (!file.endsWith('.json')) continue;
        try {
          total += await syncSessionFile(
            join(chatsDir, file),
            COLLECTIONS.gemini,
            parseGeminiSession,
            cfg.dims,
          );
        } catch (err) {
          if (err.message === 'No embedding API key configured' && getEmbeddingProvider() === 'none') {
            logger.debug('Gemini session scan aborted — provider switched to none', { module: 'qdrant-sync' });
            return total;
          }
          logger.error('Gemini session sync error', { module: 'qdrant-sync', file, err: err.message });
        }
      }
    }
  } catch { /* no gemini sessions */ }
  return total;
}

async function scanCodexSessions() {
  const cfg = getCollectionConfig('codex');
  if (!cfg.enabled) return 0;

  const codexBase = join(process.env.CODEX_HOME || join(process.env.HOME || '/data', '.codex'), 'sessions');
  if (!existsSync(codexBase)) return 0;

  let total = 0;
  const walkDir = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!_running) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(full);
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          total += await syncSessionFile(full, COLLECTIONS.codex, parseCodexSession, cfg.dims);
        } catch (err) {
          if (err.message === 'No embedding API key configured' && getEmbeddingProvider() === 'none') {
            logger.debug('Codex session scan aborted — provider switched to none', { module: 'qdrant-sync' });
            return;
          }
          logger.error('Codex session sync error', { module: 'qdrant-sync', file: full, err: err.message });
        }
      }
    }
  };
  await walkDir(codexBase);
  return total;
}

// ── File watchers ──────────────────────────────────────────────────────────

const _watchers = [];
let _debounceTimer = null;
let _pendingSyncs = new Set();

function scheduleSync(syncFn) {
  _pendingSyncs.add(syncFn);
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(async () => {
    const fns = [..._pendingSyncs];
    _pendingSyncs.clear();
    for (const fn of fns) {
      try {
        const count = await fn();
        if (count > 0) {
          logger.info(`Qdrant sync: ${count} points indexed`, { module: 'qdrant-sync' });
        }
      } catch (err) {
        logger.error('Qdrant sync error', { module: 'qdrant-sync', err: err.message });
      }
    }
  }, DEBOUNCE_MS);
}

function watchDir(dir, syncFn) {
  if (!existsSync(dir)) return;
  try {
    const watcher = watch(dir, { recursive: true }, () => scheduleSync(syncFn));
    watcher.on('error', (err) => {
      if (err.code === 'ENOENT') return; // subdirectory deleted — expected
      logger.error(`Watcher error on ${dir}`, { module: 'qdrant-sync', err: err.message });
    });
    _watchers.push(watcher);
    logger.info(`Watching ${dir} for Qdrant sync`, { module: 'qdrant-sync' });
  } catch (err) {
    logger.error(`Failed to watch ${dir}`, { module: 'qdrant-sync', err: err.message });
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

let _running = false;
let _starting = false;
let _bgRetryTimer = null;

// #176: cold-start race — node may start before qdrant has bound :6333
// (~200ms gap, sometimes longer). Retry with backoff before giving up; if
// still unreachable, schedule a periodic background re-attempt so qdrant
// coming up later (or recovering after a crash) lights up sync without
// requiring a server restart.
async function _waitForQdrant({ inlineRetries = 5, inlineDelayMs = 1000 } = {}) {
  for (let i = 0; i < inlineRetries; i++) {
    if (await qdrantHealthy()) return true;
    await new Promise(r => setTimeout(r, inlineDelayMs * (i + 1)));
  }
  return false;
}

function _scheduleBackgroundRetry() {
  if (_bgRetryTimer) return;
  const intervalMs = 60_000;
  _bgRetryTimer = setInterval(async () => {
    if (_running) { clearInterval(_bgRetryTimer); _bgRetryTimer = null; return; }
    if (await qdrantHealthy()) {
      logger.info('Qdrant reachable again — starting vector sync', { module: 'qdrant-sync' });
      clearInterval(_bgRetryTimer);
      _bgRetryTimer = null;
      // Don't await — let start() run on its own and return early on next health check.
      start().catch(err => logger.error('Background qdrant start failed', { module: 'qdrant-sync', err: err.message }));
    }
  }, intervalMs);
  if (_bgRetryTimer.unref) _bgRetryTimer.unref();
}

async function start() {
  // Guard against concurrent invocations (initial start vs background retry,
  // or two background retry firings overlapping on a slow qdrantHealthy()).
  if (_running || _starting) return;
  _starting = true;
  try {
    // Embedding provider explicitly disabled — skip without warning.
    if (getEmbeddingProvider() === 'none') {
      logger.info('Vector sync disabled (vector_embedding_provider = "none")', { module: 'qdrant-sync' });
      _starting = false;
      return;
    }

    // Check if Qdrant is reachable (with bounded inline retry for cold-start race)
    if (!(await _waitForQdrant())) {
      logger.warn('Qdrant not available after inline retries — scheduling background re-attempt', { module: 'qdrant-sync' });
      _scheduleBackgroundRetry();
      return;
    }

    // Probe the embedding provider once before scanning — a dead provider
    // (e.g. default HuggingFace inference endpoint, missing API key,
    // expired key) would otherwise fire a per-file ERROR every cycle of
    // every deploy. Single WARN here, then bail; settings change triggers
    // a restart() from the PUT /api/settings handler.
    const probeResult = await validateProviderConfig(getEmbeddingConfig());
    if (!probeResult.ok) {
      logger.warn('Embedding provider unavailable — vector sync disabled until configured', {
        module: 'qdrant-sync',
        provider: getEmbeddingConfig().model,
        reason: probeResult.error?.substring(0, 200),
      });
      _starting = false;
      return;
    }

    _running = true;
    logger.info('Qdrant sync starting', { module: 'qdrant-sync', url: QDRANT_URL });

    // Ensure collections exist with per-collection dims
    for (const [key, name] of Object.entries(COLLECTIONS)) {
      const cfg = getCollectionConfig(key);
      if (cfg.enabled) await ensureCollection(name, cfg.dims);
    }

    // Initial full scan
    try {
      const docCount = await scanDocs();
      const codeCount = await scanCode();
      const claudeCount = await scanClaudeSessions();
      const geminiCount = await scanGeminiSessions();
      const codexCount = await scanCodexSessions();
      logger.info('Qdrant initial sync complete', {
        module: 'qdrant-sync',
        documents: docCount,
        code: codeCount,
        claude: claudeCount,
        gemini: geminiCount,
        codex: codexCount,
      });
    } catch (err) {
      logger.error('Qdrant initial sync error', { module: 'qdrant-sync', err: err.message });
    }

    // Set up file watchers — both documents and code watch the workspace
    watchDir(WORKSPACE, scanDocs);
    watchDir(WORKSPACE, scanCode);
    watchDir(join(CLAUDE_HOME, 'projects'), scanClaudeSessions);

    const geminiBase = join(process.env.HOME || '/data', '.gemini');
    watchDir(geminiBase, scanGeminiSessions);

    const codexBase = process.env.CODEX_HOME || join(process.env.HOME || '/data', '.codex');
    watchDir(codexBase, scanCodexSessions);

    // Watch additional paths
    for (const p of getAdditionalPaths()) {
      watchDir(p, scanDocs);
    }
  } finally {
    _starting = false;
  }
}

function stop() {
  for (const w of _watchers) {
    try { w.close(); } catch { /* ignore */ }
  }
  _watchers.length = 0;
  if (_debounceTimer) clearTimeout(_debounceTimer);
  if (_bgRetryTimer) { clearInterval(_bgRetryTimer); _bgRetryTimer = null; }
  _running = false;
  _starting = false;
}

// Stop + start. Used when settings change (provider/key updates) so a fresh
// configuration takes effect without a server restart.
async function restart() {
  return reapplyConfig({ dropCollections: false });
}

// Drop every Qdrant collection this module manages. Used when the embedding
// provider changes — old vectors are incompatible with the new model's dims,
// so the collections must be recreated from scratch.
async function dropAllCollections() {
  for (const name of Object.values(COLLECTIONS)) {
    try {
      await fetch(`${QDRANT_URL}/collections/${name}`, { method: 'DELETE' });
    } catch (err) {
      logger.debug('drop collection failed (may not exist)', { module: 'qdrant-sync', collection: name, err: err.message });
    }
  }
}

// Single coordinated entry point for any settings-driven restart. Internally
// serialized so rapid consecutive calls (e.g., key save followed quickly by
// provider switch) don't run overlapping stop/start/scan sequences and race
// on the shared collections.
//
// Coalescing: while one apply is running, additional calls are folded into
// a single trailing apply that runs after the current one finishes. The
// trailing apply uses dropCollections=true if ANY of the deferred calls
// requested it (the strictest reset wins).
let _applyInFlight = null;
let _applyPending = null; // null | { dropCollections: bool }

async function reapplyConfig({ dropCollections = false } = {}) {
  if (_applyInFlight) {
    if (_applyPending) {
      _applyPending.dropCollections = _applyPending.dropCollections || dropCollections;
    } else {
      _applyPending = { dropCollections };
    }
    return _applyInFlight.then(async () => {
      if (_applyPending) {
        const next = _applyPending;
        _applyPending = null;
        return reapplyConfig(next);
      }
    });
  }
  _applyInFlight = (async () => {
    try {
      if (dropCollections) {
        try {
          await dropAllCollections();
          db.db.prepare('DELETE FROM qdrant_sync').run();
        } catch (err) {
          logger.warn('Failed to drop collections / clear sync state', { module: 'qdrant-sync', err: err.message });
        }
      }
      stop();
      await start();
    } finally {
      _applyInFlight = null;
    }
  })();
  return _applyInFlight;
}

async function search(query, collections = null, limit = 10) {
  if (getEmbeddingProvider() === 'none') {
    const err = new Error('Vector search is disabled. Configure an embedding provider in Settings → Vector Search to enable semantic search.');
    err.code = 'EMBEDDINGS_DISABLED';
    throw err;
  }
  if (!(await qdrantHealthy())) throw new Error('Qdrant not available');

  // Search specified collections (default: all enabled)
  const targetCollections = collections || Object.values(COLLECTIONS);
  const results = [];

  for (const col of targetCollections) {
    // Find the config key for this collection name
    const cfgKey = Object.entries(COLLECTIONS).find(([, v]) => v === col)?.[0] || col;
    const cfg = getCollectionConfig(cfgKey);

    // Embed query at this collection's dimensions
    const [queryVector] = await embed([query], cfg.dims);

    try {
      const hits = await searchPoints(col, queryVector, limit);
      for (const hit of hits) {
        results.push({
          collection: col,
          score: hit.score,
          ...hit.payload,
        });
      }
    } catch (err) {
      logger.error(`Search error in ${col}`, { module: 'qdrant-sync', err: err.message });
    }
  }

  // Sort by score descending, take top N
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function reindexCollection(colKey) {
  const colName = COLLECTIONS[colKey] || colKey;
  const cfg = getCollectionConfig(colKey);

  // Delete and recreate collection with current dims
  try {
    await fetch(`${QDRANT_URL}/collections/${colName}`, { method: 'DELETE' });
  } catch { /* may not exist */ }
  await ensureCollection(colName, cfg.dims);

  // Clear sync state for this collection
  const rows = syncStmts.getByCollection.all(colName);
  for (const row of rows) syncStmts.delete.run(row.file_path);

  // Re-scan
  let count = 0;
  switch (colKey) {
    case 'documents': count = await scanDocs(); break;
    case 'code': count = await scanCode(); break;
    case 'claude': count = await scanClaudeSessions(); break;
    case 'gemini': count = await scanGeminiSessions(); break;
    case 'codex': count = await scanCodexSessions(); break;
  }
  logger.info(`Reindexed ${colKey}: ${count} points`, { module: 'qdrant-sync' });
  return count;
}

async function status() {
  const healthy = await qdrantHealthy();
  if (!healthy) return { available: false };

  const collections = {};
  for (const [key, name] of Object.entries(COLLECTIONS)) {
    try {
      const r = await fetch(`${QDRANT_URL}/collections/${name}`);
      if (r.ok) {
        const data = await r.json();
        collections[key] = {
          points: data.result?.points_count || 0,
          status: data.result?.status || 'unknown',
        };
      }
    } catch { /* skip */ }
  }

  return { available: true, running: _running, url: QDRANT_URL, collections };
}

module.exports = {
  start, stop, restart, reapplyConfig, search, status, embed,
  qdrantHealthy, reindexCollection, dropAllCollections,
  buildCandidateConfig, validateProviderConfig, getEmbeddingProvider,
  // #212: exported so the retry behavior can be exercised by fault-injection
  // tests without setting up a full reindex pipeline.
  upsertPoints, deletePointsByFilter, retryTransient,
  // #443 [E4]: exported so the streaming heap-budget test can exercise
  // the actual production helper rather than a test-local reimplementation
  // (Codex R2 finding — STD-005 §4 real-code-import rule).
  _streamHashAndChunk, _streamReadAsString,
};
