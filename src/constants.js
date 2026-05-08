'use strict';

// #345 [C3]: shared constants. Hardcoded paths, URLs, and regex patterns
// previously duplicated across src/ + public/. Centralising them makes
// re-pointing or updating each one a single-file edit.

// Knowledge-base on-disk path. Auto-cloned on startup; Workbench treats this
// as the source-of-truth for prompts, roles, and seeded docs.
const KB_PATH = '/data/knowledge-base';

// Default upstream repo for the workbench KB. Operators can override via
// the per-instance `kb_repo_url` setting in the workbench DB; this is the
// fallback when nothing is configured.
const KB_UPSTREAM_URL = 'https://github.com/rmdevpro/workbench-kb';

// `<owner>/<repo>` form of KB_UPSTREAM_URL — needed by the GitHub fork API
// (`POST /repos/<owner>/<repo>/forks`). Derived from KB_UPSTREAM_URL so a
// single edit propagates to both URL and API forms.
const KB_UPSTREAM_OWNER_REPO = KB_UPSTREAM_URL.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');

// Codex rollout filename UUID pattern. Codex stores sessions at
// `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl` — the
// trailing UUID is what `codex --session-id <id>` resumes by, and is the
// canonical CLI session id we persist in db.cli_session_id.
//
// Use as a tail-anchored capture group on the basename (without the .jsonl
// suffix). Case-insensitive because some early rollouts had upper-case hex.
const CODEX_ROLLOUT_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

module.exports = {
  KB_PATH,
  KB_UPSTREAM_URL,
  KB_UPSTREAM_OWNER_REPO,
  CODEX_ROLLOUT_UUID_RE,
};
