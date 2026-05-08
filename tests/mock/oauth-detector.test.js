'use strict';

// #339 [A14]: byte-by-byte fixture tests for the OAuth URL detector. The
// detector parses PTY output for each CLI's distinctive start-URL + end-
// marker pattern. Feeding fixtures one byte at a time exercises the buffer-
// concatenation path that previously lived inline in public/index.html.
//
// Known limitation (per issue acceptance): the detector relies on substring
// match against a hardcoded prompt string ("Paste", "Enter the authorization
// code", "code"). If a CLI updates its prompt text without us updating the
// pattern, detection silently regresses. These fixtures pin the expected
// prompt for each CLI; a regression would surface as a test failure here
// before it surfaces as "modal never appears" in production.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OAUTH_URL_PATTERNS,
  parseOAuthBuffer,
  createOAuthDetector,
} = require('../../public/js/oauth-detector.js');

// Synthetic fixtures: each one mimics the relevant slice of a CLI's /login
// transcript with ANSI noise + line wraps. Real fixture capture (Hymie
// runbook, real OAuth flow per CLI) is the live-test acceptance criterion.
const FIXTURES = {
  claude: 'Some prelude text\n\x1b[1mLogin to Claude\x1b[0m\nVisit:\nhttps://claude.com/cai/oauth/authorize?\n  client_id=workbench&redirect_uri=http://localhost\n\nPaste the code:\n',
  gemini: 'Welcome to Gemini\n\x1b[36mOpen this URL in your browser:\x1b[0m\n\nhttps://accounts.google.com/o/oauth2/auth?client_id=foo&\n  scope=email&access_type=offline\n\nEnter the authorization code from your browser: ',
  codex: 'Codex CLI sign-in\nGo to:\nhttps://auth0.openai.com/authorize?response_type=code\nThen paste the code: ',
};

test('OD-01: pattern table covers claude, gemini, codex CLIs', () => {
  const seen = new Set(OAUTH_URL_PATTERNS.map(p => p.cli));
  for (const cli of ['claude', 'gemini', 'codex']) {
    assert.ok(seen.has(cli), `pattern table must include ${cli}`);
  }
});

test('OD-02: parseOAuthBuffer extracts Claude URL with line wraps', () => {
  const result = parseOAuthBuffer(FIXTURES.claude);
  assert.equal(result?.cli, 'claude');
  assert.match(result.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  assert.ok(result.url.includes('client_id=workbench'), 'URL must include rejoined wrap fragments');
  assert.ok(!/\s/.test(result.url), 'whitespace must be stripped');
});

test('OD-03: parseOAuthBuffer extracts Gemini URL with line wraps', () => {
  const result = parseOAuthBuffer(FIXTURES.gemini);
  assert.equal(result?.cli, 'gemini');
  assert.match(result.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\//);
  assert.ok(result.url.includes('access_type=offline'));
});

test('OD-04: parseOAuthBuffer extracts Codex URL', () => {
  const result = parseOAuthBuffer(FIXTURES.codex);
  assert.equal(result?.cli, 'codex');
  assert.match(result.url, /^https:\/\/auth0\.openai\.com\//);
});

test('OD-05: parseOAuthBuffer returns null when end marker not yet present', () => {
  // URL appears but the user hasn't seen the prompt line yet.
  const partial = 'See: https://claude.com/cai/oauth/authorize?client_id=x\n';
  assert.equal(parseOAuthBuffer(partial), null);
});

test('OD-06: createOAuthDetector fires onAuthDetected exactly once per resolved URL (byte-by-byte feed)', () => {
  const events = [];
  const ptyBuffer = new Map();
  const detector = createOAuthDetector({
    ptyOutputBuffer: ptyBuffer,
    oauthDetection: { claude: true, gemini: false, codex: false },
    getCliType: () => 'claude',
    isModalVisible: () => false,
    onAuthDetected: (e) => events.push(e),
  });
  // Feed the Claude fixture one byte at a time.
  for (const ch of FIXTURES.claude) {
    detector.feed('tab-1', ch);
  }
  assert.equal(events.length, 1, `expected exactly 1 auth event, got ${events.length}`);
  assert.equal(events[0].cli, 'claude');
  assert.match(events[0].url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
});

test('OD-07: detector skips when oauthDetection[cliType] is false', () => {
  const events = [];
  const ptyBuffer = new Map();
  const detector = createOAuthDetector({
    ptyOutputBuffer: ptyBuffer,
    oauthDetection: { claude: false, gemini: false, codex: false }, // all off
    getCliType: () => 'claude',
    isModalVisible: () => false,
    onAuthDetected: (e) => events.push(e),
  });
  detector.feed('tab-1', FIXTURES.claude);
  assert.equal(events.length, 0, 'must not fire when CLI detection is disabled');
});

test('OD-08: detector skips when modal is already visible', () => {
  const events = [];
  const ptyBuffer = new Map();
  let modalOn = true;
  const detector = createOAuthDetector({
    ptyOutputBuffer: ptyBuffer,
    oauthDetection: { claude: true },
    getCliType: () => 'claude',
    isModalVisible: () => modalOn,
    onAuthDetected: (e) => events.push(e),
  });
  detector.feed('tab-1', FIXTURES.claude);
  assert.equal(events.length, 0);
  modalOn = false;
  // Reset the buffer (modal was dismissed). Subsequent feed should pick up.
  detector.feed('tab-1', FIXTURES.claude);
  assert.equal(events.length, 1);
});

test('OD-09: detector deletes per-tab buffer after firing', () => {
  const ptyBuffer = new Map();
  const detector = createOAuthDetector({
    ptyOutputBuffer: ptyBuffer,
    oauthDetection: { claude: true },
    getCliType: () => 'claude',
    isModalVisible: () => false,
    onAuthDetected: () => {},
  });
  detector.feed('tab-1', FIXTURES.claude);
  assert.equal(ptyBuffer.has('tab-1'), false, 'buffer must be cleared after fire');
});
