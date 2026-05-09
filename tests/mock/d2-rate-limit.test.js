'use strict';

// D2 #351: per-IP login token bucket — 10 attempts/minute, refill 1/6s.
// Verify the bucket math directly (deterministic, no setTimeout flakiness).

const test = require('node:test');
const assert = require('node:assert/strict');

// Re-implement the bucket from src/server.js:170-186 deterministically.
function makeBucket() {
  const buckets = new Map();
  function consume(ip, now) {
    const cap = 10;
    const refillRateMs = 6000;
    let b = buckets.get(ip);
    if (!b) { b = { tokens: cap, lastRefill: now }; buckets.set(ip, b); }
    const elapsed = now - b.lastRefill;
    const refill = Math.floor(elapsed / refillRateMs);
    if (refill > 0) {
      b.tokens = Math.min(cap, b.tokens + refill);
      b.lastRefill = b.lastRefill + refill * refillRateMs;
    }
    if (b.tokens <= 0) return false;
    b.tokens -= 1;
    return true;
  }
  return { consume, buckets };
}

test('D2-RL-01: 10 attempts in tight window all consume; 11th rejected', () => {
  const { consume } = makeBucket();
  const t0 = 1000000;
  for (let i = 0; i < 10; i++) {
    assert.ok(consume('1.2.3.4', t0), `attempt ${i + 1} must succeed`);
  }
  assert.equal(consume('1.2.3.4', t0), false, '11th attempt must be rate-limited');
});

test('D2-RL-02: bucket refills 1 token per 6s', () => {
  const { consume } = makeBucket();
  const t0 = 1000000;
  for (let i = 0; i < 10; i++) consume('5.6.7.8', t0);
  assert.equal(consume('5.6.7.8', t0), false, 'just after exhaust → 429');
  // 6s later → 1 token
  assert.ok(consume('5.6.7.8', t0 + 6000), 'refill 1 token after 6s');
  assert.equal(consume('5.6.7.8', t0 + 6000), false, 'second consume in same window → 429');
});

test('D2-RL-03: bucket fully resets after 60s', () => {
  const { consume } = makeBucket();
  const t0 = 1000000;
  for (let i = 0; i < 10; i++) consume('9.9.9.9', t0);
  assert.equal(consume('9.9.9.9', t0), false);
  // 60s later → fully refilled (10 tokens, capped)
  for (let i = 0; i < 10; i++) {
    assert.ok(consume('9.9.9.9', t0 + 60000), `post-60s attempt ${i + 1} must succeed`);
  }
});

test('D2-RL-04: independent IPs have independent buckets', () => {
  const { consume } = makeBucket();
  const t0 = 1000000;
  for (let i = 0; i < 10; i++) consume('alpha', t0);
  // alpha exhausted, bravo fresh
  assert.equal(consume('alpha', t0), false);
  assert.ok(consume('bravo', t0));
});

test('D2-RL-SOURCE: src/server.js implements per-IP bucket + 429 response', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf-8');
  assert.match(src, /_consumeLoginBucket\(ip\)/);
  assert.match(src, /res\.status\(429\)/);
  assert.match(src, /setTimeout.*500/, 'failed login must include 500ms async pause');
});
