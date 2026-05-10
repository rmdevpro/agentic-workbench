You are resuming in a NEW Codex session. The verbatim last {{LINE_COUNT}} messages from the prior Codex session (which has been ended — Codex doesn't support in-session compaction) have been written to:

  {{TAIL_PATH}} ({{BYTE_COUNT}} bytes)

Each line is formatted `[role] message-text`. Read that file fully — in chunks via Read offset/limit if it exceeds the Read tool's per-call cap — until you have 100% of the content. Then:

1. Acknowledge the current state of work — what was being done, what decisions had been made
2. Check your plan file at `/data/.workbench/plans/<session-id>.md` and read any documents on the reading list
3. State the immediate next step
4. Ask the user if anything has changed or if there are new instructions before proceeding
