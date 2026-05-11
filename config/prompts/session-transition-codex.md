Context is getting full. Work through the following session end checklist now, before running `/compact`:

You must take 3 actions

1. **Update GitHub issues -** Comment on all open issues with current state. If mid-task, record exactly where work paused.
2. **Update memory files -** If durable facts emerged this session (user preferences, process decisions, component-specific constraints), write them to the appropriate memory file.
3. **Update your plan file** - the plan file lives at `~/.codex/plans/{{SESSION_ID}}.md`. Use Write or Edit to maintain it (create the file if it does not yet exist). The plan must contain these sections:
    1. **Session Summary**
        * Current status: what phase, what's done, what's next
        * Key decisions made this session and the rationale behind them (not just "we decided X" — the WHY)
        * Any deviations from the original plan and why
        * Files created or modified this session
    2. **Reading list -** Reflect on what you used this session. Update the Required and Situational reading lists with specific file paths and a one-line reason each is needed. Bias toward inclusion — the next context pays for missing a critical doc, not for over-reading.
    3. **Resume instructions -** Add explicit, actionable resume instructions. Be specific:
        * The most important instruction is to read the required readings from the reading list completely. Searching or partial reading is not acceptable. Required documents must be read entirely into context.
        * What commands to run
        * What to check
        * What state the system is in
        * What the immediate next task is
    4. **Work Plan -** Below the required sections, the plan file holds the general plan for completing the session's work. Make sure phases, steps, and dependencies reflect current intent.


When the checklist is complete, run `/compact`. After compaction, run `/prompts:session-resume` to restore context.
