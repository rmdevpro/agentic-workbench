'use strict';

const BASE_URL = process.env.TEST_URL || 'http://localhost:7867';

async function api(method, path, body = null, headers = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE_URL}${path}`, opts);
  let data;
  const text = await r.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, data, headers: r.headers };
}

async function get(path) {
  return api('GET', path);
}
async function post(path, body = {}) {
  return api('POST', path, body);
}
async function put(path, body = {}) {
  return api('PUT', path, body);
}
async function del(path) {
  return api('DELETE', path);
}

/**
 * Create a session with retry logic. The stub Claude CLI in the test container
 * can cause 500 due to tmux session name collisions (truncated timestamps).
 * This helper retries up to 3 times with a delay to get a unique tmux name.
 * Returns { status, data } where data.id is guaranteed on success.
 */
async function createSession(project, prompt = 'test session') {
  // POST /api/sessions requires `name` (returns 400 without it). The legacy
  // signature passed `prompt` only; pass it as both so existing callers that
  // expect their string in `prompt` still work, plus name is now satisfied.
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await post('/api/sessions', { project, name: prompt, prompt });
    if (r.data && r.data.id) return r;
    // 500 with no ID means tmux name collision — wait and retry
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  }
  // Final attempt failed — return whatever we got
  return post('/api/sessions', { project, name: prompt, prompt });
}

module.exports = { api, get, post, put, del, createSession, BASE_URL };
