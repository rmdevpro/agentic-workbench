#!/bin/bash
# Stub Codex CLI for sandbox testing (#640)
#
# The workbench-test sandbox has `dns: 127.0.0.1` so the real codex binary
# hangs trying to reach the OpenAI API. _seedRole's Phase 1 call
# (`codex exec --skip-git-repo-check <prompt>`) blocks past the 60s
# AbortController bound in tests/live/issue-275-codex-role-seed.test.js,
# masking the #275 regression contract.
#
# This stub replicates just enough of `codex exec` and `codex resume <id>`
# for _seedRole + the subsequent tmux session to complete inside the sandbox:
#  - `codex exec --skip-git-repo-check <prompt>` writes a minimal rollout
#    JSONL at the path discoverCodexSessions() walks ($HOME/.codex/sessions/
#    YYYY/MM/DD/rollout-<uuid>.jsonl) and exits 0.
#  - `codex resume <id>` keeps the process alive so the tmux session attached
#    by Phase 2 stays up (parity with stub-claude.sh's sleep-infinity tail).
set -e

MODE=""
ROLLOUT_ID=""
PROMPT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    exec) MODE="exec"; shift ;;
    resume) MODE="resume"; ROLLOUT_ID="$2"; shift 2 ;;
    --skip-git-repo-check) shift ;;
    --version) echo "0.130.0-stub"; exit 0 ;;
    --help) echo "stub codex cli"; exit 0 ;;
    *) PROMPT="$1"; shift ;;
  esac
done

if [ "$MODE" = "exec" ]; then
  CODEX_HOME="${HOME:-/data}/.codex/sessions"
  DATE_DIR=$(date -u +%Y/%m/%d)
  SESS_DIR="$CODEX_HOME/$DATE_DIR"
  mkdir -p "$SESS_DIR" 2>/dev/null || true
  ROLLOUT_UUID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "stub-$(date +%s)")"
  ROLLOUT_FILE="$SESS_DIR/rollout-$ROLLOUT_UUID.jsonl"
  TS="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  # Minimal valid rollout payload: one user message + one assistant message.
  # parseCodexRolloutFile (src/session-utils/codex.js:32) keys off
  # entry.type='response_item' + payload.role for messageCount and name.
  {
    printf '{"type":"response_item","payload":{"role":"user","content":%s},"timestamp":"%s"}\n' \
      "$(printf '%s' "${PROMPT:-stub seed}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"stub seed"')" \
      "$TS"
    printf '{"type":"response_item","payload":{"role":"assistant","content":"Stub Codex response"},"timestamp":"%s"}\n' "$TS"
  } > "$ROLLOUT_FILE"
  exit 0
fi

if [ "$MODE" = "resume" ]; then
  exec sleep infinity
fi

# Bare invocation or unknown verb — keep alive so the tmux pane doesn't die.
exec sleep infinity
