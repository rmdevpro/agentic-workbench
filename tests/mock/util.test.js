'use strict';

// #341 [A16]: escape helpers consolidated into public/js/util.js. Verify
// the canonical implementations correctly escape every special character
// for both body text and attribute contexts.

const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, escapeAttr } = require('../../public/js/util.js');

test('UTL-01: escapeHtml escapes <, &, >, "', () => {
  assert.equal(escapeHtml('<&>"'), '&lt;&amp;&gt;&quot;');
});

test('UTL-02: escapeHtml escapes single quote as &#39;', () => {
  assert.equal(escapeHtml("It's"), 'It&#39;s');
});

test('UTL-03: escapeHtml handles null/undefined to empty string', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('UTL-04: escapeHtml leaves safe strings untouched', () => {
  assert.equal(escapeHtml('Hello World 123'), 'Hello World 123');
});

test('UTL-05: escapeAttr escapes the quote character used in HTML attrs', () => {
  // The point of escapeAttr is to make a string safe inside `"..."`.
  const dangerous = 'foo" onclick="alert(1)';
  const safe = escapeAttr(dangerous);
  assert.ok(!safe.includes('"'), 'escaped output must not contain a literal "');
  assert.match(safe, /&quot;/);
});

test('UTL-06: escapeAttr escapes < and > (defense-in-depth)', () => {
  // Some browsers / parsers tolerate < inside attributes; escape anyway.
  assert.equal(escapeAttr('<>'), '&lt;&gt;');
});

test('UTL-07: escapeHtml of a complete XSS payload is inert', () => {
  const xss = '<script>alert("x")</script>';
  const safe = escapeHtml(xss);
  assert.ok(!safe.includes('<script>'));
  assert.ok(!safe.includes('</script>'));
  assert.match(safe, /&lt;script&gt;/);
});
