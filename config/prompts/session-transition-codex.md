Context is getting full. Codex CLI does NOT have an in-session compaction command — `/clear` ends the session entirely (per the workbench's saved knowledge that Codex's `/clear` kills the session, unlike Claude's or Gemini's). The workbench-supported transition for Codex is therefore: **save state, exit this session, start a new Codex session, and restore context via `/session resume`.**

Work through the following session end checklist now, before exiting:

**1. Update the plan file**
Update your plan file at `/data/.workbench/plans/{{SESSION_ID}}.md` (workbench-managed, CLI-agnostic — same path works for Claude, Gemini, and Codex; create the directory if it doesn't exist). Include:
- Current status: what phase, what's done, what's next
- Key decisions made this session and the rationale behind them (not just "we decided X" — the WHY)
- Any deviations from the original plan and why
- Files created or modified this session

**2. Update the reading list**
Reflect on what you used this session. Update the Required and Situational reading lists in the plan file with specific file paths and a one-line reason each is needed. Bias toward inclusion — the next context pays for missing a critical doc, not for over-reading.

**3. Write resume instructions**
Add explicit, actionable resume instructions to the plan file. Be specific:
- What commands to run
- What to check
- What state the system is in
- What the immediate next task is

**4. Update GitHub issues**
Comment on all open issues with current state. If mid-task, record exactly where work paused.

**5. Update memory files**
If durable facts emerged this session (user preferences, process decisions, component-specific constraints), write them to the appropriate memory file.

When the checklist is complete, exit this Codex session, then start a NEW Codex session in this workbench project and run `/session resume` (with this session's id, `{{SESSION_ID}}`) to restore context. Do NOT run `/clear` — it terminates the session without preserving anything.
