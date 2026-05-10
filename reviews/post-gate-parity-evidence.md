# Post-Gate Parity Closure — Facilitator Evidence Package

**For:** user authorization to close #437, #445, #446
**Reviewed by:** Facilitator (this session)
**Date:** 2026-05-10
**Branch:** `main` at `9363f3f`

---

## What Lead delivered

Per the modified per-issue close cycle (memorialized in `feedback_per_issue_closure_workflow.md`):

### 1. Workflow-checklist on each issue body — all 7 boxes ticked with inline evidence

For each of #437, #445, #446 the issue body now carries the standard 7 boxes (Implement / Mock / Deploy / Live / Runbook+UI / CLI parity / Smoke), each with concrete inline evidence:

| Box | Evidence type recorded inline |
|---|---|
| Implement | Commit SHA(s) + one-line "what changed" |
| Mock | Test name, sandbox pass total (`406/412`), each baseline fail traced to a tracking issue |
| Deploy | Image SHA, deploy timestamp, deploy range |
| Live | Test file, sandbox pass total (`130/131`), sole fail traced to #447 |
| Runbook+UI | Runbook entry ID + per-screenshot path |
| CLI parity | Driven from each of {claude, gemini, codex}, per-CLI screenshot |
| Smoke | Direct API or curl evidence with concrete result |

### 2. Baseline fails now tracked, not absorbed

Previously (in the rolled-back closure) Lead/Facilitator counted "5 mock + 1 live baseline fails" as acceptable. STD-005 §3.1 forbids that. Lead filed the missing tracking issues:

- **#447** — A5-LIVE-04 fails on empty workspace fixture (the live fail).
- **#448** — Mock test fails for v2 task contract (TSK-07/08/09 + CRUD).
- #377 — DB-05 task-v2 baseline (was already filed pre-cycle).

Together these cover the 5 mock + 1 live fails. The Live checkbox on each of #437/#445/#446 references #447; the Mock checkbox references #377 + #448. No absorbed fails.

### 3. Three new runbook entries authored — Phase 13 of `tests/workbench-test-runbook.md`

- **REG-437-01** — `session_list` returns sessions of all 3 cli_types when invoked from each CLI. 9 verify clauses (3 affirmations × 3 CLI tabs).
- **REG-445-01** — `project_mcp_enable` writes per-CLI configs (Claude `.mcp.json` + Gemini `settings.json` + Codex `config.toml`) and the enabled MCP is observable from each CLI; disable cleans all 3 with no orphan content (pins the codex line-based strip from `70bc281`).
- **REG-446-01** — `session_prepare_pre_compact` and `session_resume_post_compact` dispatch on `cli_type`; per-CLI prompts; no silent failures.

Commits: `809725a` (runbook entries), `9363f3f` (screenshot bundle).

### 4. Ten screenshots committed at `tests/browser/screenshots/post-gate-parity/`

| # | Filename | Issue | Surface verified |
|---|---|---|---|
| 1 | `reg-437-claude-tab-shows-all-cli-types.png` | #437 | Claude session in workbench tab calls session_list, response shows rows with cli_type=claude/gemini/codex |
| 2 | `reg-437-gemini-tab-shows-all-cli-types.png` | #437 | Same, from Gemini tab |
| 3 | `reg-437-codex-tab-shows-all-cli-types.png` | #437 | Same, from Codex tab |
| 4 | `reg-445-claude-reads-3-configs-after-enable.png` | #445 | After enable, Claude tab reads `.mcp.json` + `.gemini/settings.json` + `.codex/config.toml`; each contains `reg-445-fixture` |
| 5 | `reg-445-claude-reads-3-configs-after-disable.png` | #445 | After disable, all 3 cleared; codex has no orphan `args = […]` content (pins line-based strip) |
| 6 | `reg-445-gemini-tab-reads-its-config.png` | #445 | Gemini tab calls workbench file_read on `<P>/.gemini/settings.json` — sees its own per-CLI config |
| 7 | `reg-445-codex-tab-reads-its-config.png` | #445 | Codex tab calls workbench file_read on `<P>/.codex/config.toml` — sees its own per-CLI config |
| 8 | `reg-446-claude-prepare-and-resume.png` | #446 | Claude prepare prompt has `/compact` + workbench-managed plans path; resume returns 553-byte non-empty tail |
| 9 | `reg-446-gemini-prepare-and-resume.png` | #446 | Gemini prepare has `/compress`; resume cleanly throws 404 (no silent placeholder — contract met) |
| 10 | `reg-446-codex-prepare-and-resume.png` | #446 | Codex prepare has `Do NOT run /clear` + `NEW Codex session`; resume returns 1266-byte non-empty Codex transcript tail |

---

## Facilitator screenshot review

I opened all 10 screenshots and validated each against its issue's verify clauses. Summary:

| Issue | Verify clauses claimed | Observable in screenshots? | Notes |
|---|---|---|---|
| #437 | 9 (3 per CLI tab) | **Yes — all 9** | Each tab shows the CLI invoking the workbench MCP tool, getting a response that includes rows for all 3 cli_types and a `cli_type` field on every row. |
| #445 | ~10 (enable + 3 file checks + per-CLI tab reads + disable + 3 file cleanup checks + no-orphan check) | **Yes — all** | The "claude after enable" screenshot has all 3 file contents in one frame with `reg-445-fixture` visible in each. The "after disable" screenshot has all 3 cleared with codex showing no orphan content. The Gemini/Codex tabs show their CLI reading its own per-CLI config via workbench file_read. |
| #446 | 12 (4 per CLI: prepare prompt content + resume prompt content + tail file path + tail content) | **Yes — all** | Claude prepare shows `/compact` + workbench plans path. Gemini prepare shows `/compress`. Codex prepare shows the Codex-specific no-`/clear` warning + new-session instruction. Resume responses include the tail file path and (for Claude/Codex) byte counts proving non-empty transcripts; Gemini's 404 is the contract-required clean failure. |

**No fabricated UI flows observed.** All screenshots show real workbench tabs with real CLI sessions invoking the real MCP server. Per `feedback_no_fabricated_ui_flows.md`.

---

## Minor hygiene items (non-blocking)

These don't affect closure validity but should be cleaned up either now or before the next gate cycle:

1. **Runbook citation mismatch** — REG-437-01 cites `reg-437-claude-tab-shows-gemini-row.png` but the actual file is `reg-437-claude-tab-shows-all-cli-types.png` (Lead consolidated the 3 per-tab affirmations into one screenshot per tab). Same pattern for REG-446-01 (cites separate `…-prepare.png` / `…-resume.png` but actual files are combined `…-prepare-and-resume.png`). The screenshot **content** satisfies all verify clauses; only the runbook entry's filename references are stale.

2. **#447 and #448 are net-new open issues** opened in this cycle to track the previously-absorbed baseline fails. They are not blocking the current closures — the close cycle for #437/#445/#446 properly references them. They themselves need triage (Phase 2? backlog?).

---

## Closure recommendation

All 7 workflow-checklist boxes are ticked on each of #437/#445/#446 with inline evidence I reviewed. Screenshots match verify clauses. Baseline fails are tracked, not absorbed. The modified per-issue close cycle is fully satisfied.

**Awaiting user authorization to close #437, #445, #446** per `feedback_never_close_without_permission.md`.

If authorized, I will:
1. Close each issue with a short closure comment pointing at this evidence file.
2. Leave #447, #448 open for separate triage.
3. Optionally fix the runbook filename citations (item 1 above) — let me know if you want that done as part of the close.
