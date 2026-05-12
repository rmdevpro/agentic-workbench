'use strict';

const { readdir, readFile } = require('fs/promises');
const { basename } = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { CODEX_ROLLOUT_UUID_RE } = require('./constants');
const sessionUtilsMod = require('./session-utils');
const { discoverGeminiSessions, discoverCodexSessions } = sessionUtilsMod;

// Phase 1 + Phase 2 role seeding. Runs CLI non-interactively in plan/exec mode
// to seed the role into the session, then launches interactive via tmux.
//
// The role file content is INLINED into the prompt rather than asking the CLI
// to read it from disk. Gemini's workspace sandbox refuses reads outside the
// project's cwd (the role lives in KB_PATH/roles/, well outside
// /data/workspace/<project>), and Codex has the same scoping. Inlining works
// for all three CLIs uniformly.
async function _seedRole(cliType, rolePath, projectPath, cliArgs, existingFiles, sessDir, tmpId, proj, db, tmux, logger, safe) {
  // #347 [C5]: requires hoisted to module top — execFile/promisify/path/fs
  // are all module-level imports. Use the top-level aliases here.
  const readdirFs = readdir;
  const readFileFs = readFile;
  const basenameFs = basename;

  // Read the role content up-front; bail to caller's catch if missing.
  const roleContent = await readFileFs(rolePath, 'utf-8');
  const rolePrompt =
    `You are being assigned a role for this session. The role definition is below — adopt it as your role and copy the content verbatim into your plan so it persists across the session.\n\n` +
    `=== ROLE: ${basenameFs(rolePath, '.md')} ===\n` +
    `${roleContent}\n` +
    `=== END ROLE ===`;

  // child_process.execFile silently ignores the `stdio` option (only spawn
  // honors it), so a previous attempt to set stdio:['ignore','pipe','pipe']
  // was a no-op and Codex would block forever on "Reading additional input
  // from stdin...". Send EOF on the child's stdin pipe immediately after
  // start so the child sees stdin close and proceeds.
  const seedExec = (cmd, args, cwd) => {
    const p = execFileAsync(cmd, args, { cwd });
    if (p.child && p.child.stdin) p.child.stdin.end();
    return p;
  };

  if (cliType === 'claude') {
    // Phase 1: non-interactive plan mode — seeds role into plan file
    await seedExec('claude', [
      '-p', '--permission-mode', 'plan',
      rolePrompt,
    ], projectPath);
    // Find the new JSONL created by Phase 1
    const afterFiles = await readdirFs(sessDir).catch(() => []);
    const newJSONL = afterFiles.find(f => f.endsWith('.jsonl') && !existingFiles.has(f));
    const phase1Id = newJSONL ? basenameFs(newJSONL, '.jsonl') : null;
    // Phase 2: resume interactively with bypass
    const resumeArgs = phase1Id
      ? ['--resume', phase1Id, '--dangerously-skip-permissions', ...cliArgs]
      : ['--dangerously-skip-permissions', ...cliArgs];
    await safe.tmuxCreateCLIAsync(tmux, projectPath, 'claude', resumeArgs, { workbenchSessionId: tmpId });
    if (phase1Id) {
      // Register the real session ID so the resolver maps it correctly
      db.upsertSession(phase1Id, proj.id, null, 'claude');
    }

  } else if (cliType === 'gemini') {
    // Snapshot existing chat files BEFORE Phase 1 so we can identify the
    // new one (Phase 1 creates exactly one chat file). Sort-by-timestamp
    // picked stale files when many old chats existed in unrelated projects.
    const beforeGemini = new Set(discoverGeminiSessions().map(s => s.filePath));
    // Phase 1: non-interactive plan mode
    await seedExec('gemini', [
      '--approval-mode', 'plan',
      '-p', rolePrompt,
    ], projectPath);
    // Phase 2: resume latest interactively (no yolo)
    await safe.tmuxCreateCLIAsync(tmux, projectPath, 'gemini', ['--resume', 'latest'], { workbenchSessionId: tmpId });
    // Find the new chat file produced by Phase 1 — diff against snapshot.
    try {
      const after = discoverGeminiSessions();
      const created = after.find(s => !beforeGemini.has(s.filePath));
      if (created?.sessionId) db.setCliSessionId(tmpId, created.sessionId);
    } catch (e) { logger.warn('Gemini cli_session_id capture failed', { module: 'routes', err: e.message }); }

  } else if (cliType === 'codex') {
    // Snapshot existing rollouts BEFORE Phase 1 — same reasoning as Gemini.
    const beforeCodex = new Set((discoverCodexSessions ? discoverCodexSessions() : []).map(s => s.filePath));
    // Single non-interactive step — role seeded as initial context.
    // --skip-git-repo-check: Codex refuses to run outside a git repo by
    // default, but workbench projects aren't required to be git repos.
    await seedExec('codex', [
      'exec', '--skip-git-repo-check', rolePrompt,
    ], projectPath);
    // Find the rollout file produced by Phase 1 — diff against snapshot.
    const after = discoverCodexSessions ? discoverCodexSessions() : [];
    const created = after.find(s => !beforeCodex.has(s.filePath));
    const rolloutId = created?.filePath
      ? (() => { const m = basenameFs(created.filePath, '.jsonl').match(CODEX_ROLLOUT_UUID_RE); return m ? m[1] : null; })()
      : null;
    const resumeArgs = rolloutId ? ['resume', rolloutId] : [];
    await safe.tmuxCreateCLIAsync(tmux, projectPath, 'codex', resumeArgs, { workbenchSessionId: tmpId });
    if (rolloutId) db.setCliSessionId(tmpId, rolloutId);
  }
}

module.exports = { _seedRole };
