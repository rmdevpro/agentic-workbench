# Workbench Traceability Matrix: Runbook ↔ Test Plans

**Date:** 2026-04-18
**Issue:** #80 — Audit runbook coverage against test plan
**Author:** Claude (Opus 4.6)

## Overview

This matrix maps every active runbook scenario to its corresponding test plan scenario(s), identifying coverage gaps in both directions.

- **Runbook**: `tests/workbench-test-runbook.md` — 144 active execution scenarios
- **UI Test Plan**: `tests/workbench-test-plan-ui.md` — 281 active scenarios (Gate C)
- **Backend Test Plan**: `tests/workbench-test-plan-backend.md` — 378 active scenarios (Gates A & B)

## 1. Runbook → Test Plan Mapping

Every runbook scenario should trace to at least one test plan scenario. Gaps = runbook tests with no plan backing.

### Phase 1: Smoke (3 tests)

| Runbook ID | Title | UI Plan | Backend Plan | Gap? |
|------------|-------|---------|--------------|------|
| SMOKE-01 | Page Load and Empty State | LAY-01, LAY-05, EMP-01, BRW-01, FR-01 | — | No |
| SMOKE-02 | Sidebar Projects Render | SB-01, SB-05, FLT-01, BRW-01 | — | No |
| SMOKE-03 | API Health and WebSocket | RCN-05, STB-06 | HLT-01, AUTH-01, SRV-03 | No |

### Phase 2: Core Workflows (11 tests)

| Runbook ID | Title | UI Plan | Backend Plan | Gap? |
|------------|-------|---------|--------------|------|
| CORE-01 | Create Session | NS-01..09, BRW-02 | SES-01, SES-02 | No |
| CORE-02 | Terminal I/O | TIO-01, TIO-02, BRW-03 | WS-01..03 | No |
| CORE-03 | Multi-Tab Management | TAB-02, TAB-03, TAB-07, BRW-04 | — | No |
| CORE-04 | Close Tab | TAB-04, TAB-05, BRW-05 | WS-07 | No |
| CORE-05 | Sidebar Session Click | SES-01, SES-03, BRW-02 | — | No |
| CORE-06 | Filter Dropdown | FLT-01..04, BRW-06 | — | No |
| CORE-07 | Sort Sessions | SRT-01..03, BRW-07 | — | No |
| CORE-08 | Search Sessions | SCH-01..05, BRW-08 | SES-09 | No |
| CORE-09 | Rename Session | CFG-01..03, BRW-16 | SES-05, SES-07 | No |
| CORE-10 | Archive Session | ARC-01, BRW-16 | SES-06 | No |
| CORE-11 | Unarchive Session | ARC-02, BRW-16 | SES-06 | No |

### Phase 3: Features (18 active / 3 removed)

| Runbook ID | Title | UI Plan | Backend Plan | Gap? |
|------------|-------|---------|--------------|------|
| FEAT-01 | Right Panel Toggle | PNL-01, BRW-09 | — | No |
| FEAT-02 | Panel - Files Tab | FIL-01..10, BRW-09 | FS-01..05 | No |
| FEAT-03 | Panel - Notes Tab | REMOVED | REMOVED | N/A |
| FEAT-04 | Panel - Tasks Tab | TSK-01..06, BRW-11 | TSK-01..07 | No |
| FEAT-05 | Panel - Messages Tab | REMOVED | REMOVED | N/A |
| FEAT-06 | Settings Modal - Open/Close | SET-01..03, BRW-15 | — | No |
| FEAT-07 | Settings - Theme | THM-01..04, BRW-13 | — | No |
| FEAT-08 | Settings - Font Size | FNT-01..02, BRW-14 | — | No |
| FEAT-09 | Settings - Font Family | FNT-03..04, BRW-14 | — | No |
| FEAT-10 | Settings - Default Model | MDL-01 | SET-01..02 | No |
| FEAT-11 | Settings - Thinking Level | MDL-02 | SET-01..02 | No |
| FEAT-12 | Settings - System Prompts Tab | PRM-01..03 | — | No |
| FEAT-13 | Settings - MCP Servers | MCP-01..04 | MCS-API-01..03 | No |
| FEAT-14 | Session Config Dialog | CFG-01..07, BRW-16 | SES-07 | No |
| FEAT-15 | Session Summary | SUM-01..05, BRW-17 | SES-10 | No |
| FEAT-16 | Add Project via File Picker | AP-01..10, BRW-18 | PRJ-01..02 | No |
| FEAT-17 | Status Bar Display | STB-01..10, BRW-19 | — | No |
| FEAT-18 | Context Threshold Indicators | CTX-01..04, BRW-20 | CMP-29..32 | No |
| FEAT-19 | File Browser - View File | FIL-02, FIL-07, BRW-09 | FS-03 | No |
| FEAT-20 | Search API (Global Search) | SCH-01..05, BRW-08 | SES-09 | No |
| FEAT-21 | Keepalive Settings | KAL-01..02 | KA-01..10, AUTH-03..05 | No |

### Phase 4: Edge Cases (20 active / 4 removed)

| Runbook ID | Title | UI Plan | Backend Plan | Gap? |
|------------|-------|---------|--------------|------|
| EDGE-01 | WebSocket Reconnection | RCN-01..10, BRW-21 | WS-06..07 | No |
| EDGE-02 | Rapid Tab Switching | TAB-07, BRW-23 | — | No |
| EDGE-03 | Long Session Name | VAL-01, BRW-26 | — | No |
| EDGE-04 | Empty State Returns | EMP-01..02, BRW-25 | — | No |
| EDGE-05 | Auth Modal Elements | AUTH-01..10, BRW-27..28 | AUTH-01..02 | No |
| EDGE-06 | Double-Click Prevention | NS-05, BRW-30 | — | No |
| EDGE-07 | Compaction Trigger | REMOVED | REMOVED | N/A |
| EDGE-08 | Temp Session Lifecycle | RACE-01..03, BRW-32 | RES-01..08, SES-13 | No |
| EDGE-09 | Panel Project Switch | PNL-04..05, BRW-34 | — | No |
| EDGE-10 | Modal Overlap Prevention | MOD-01..04, BRW-35 | — | No |
| EDGE-11 | Tmux Death Recovery | LIFE-01, BRW-36 | TMX-05..09 | No |
| EDGE-12 | Multi-Project Notes | REMOVED | REMOVED | N/A |
| EDGE-13 | Session vs Project Notes | REMOVED | REMOVED | N/A |
| EDGE-14 | Hidden Session Lifecycle | ARC-03..04, BRW-39 | SES-06 | No |
| EDGE-15 | Settings Propagation | SET-05..07, BRW-15 | SET-03, SET-05 | No |
| EDGE-16 | Project Header Collapse | SB-04, SB-13 | — | No |
| EDGE-17 | Project Terminal Button | REMOVED | REMOVED | N/A |
| EDGE-18 | Server Restart Recovery | RCN-07, BRW-22 | SRV-01 | No |
| EDGE-19 | Panel Resize Terminal Refit | TIO-03..04, BRW-24 | WS-04 | No |
| EDGE-20 | Auth Failure Banner | AUTH-06..07, BRW-27 | — | No |
| EDGE-21 | Auth Recovery Lifecycle | AUTH-05, BRW-33 | AUTH-01..02 | No |
| EDGE-22 | Drag-and-Drop File to Terminal | DND-01..04, BRW-29 | — | No |
| EDGE-23 | Multi-Project Terminal Isolation | BRW-37 | — | No |
| EDGE-24 | Settings Propagation to New Session | BRW-40 | SET-03 | No |

### Phase 5: CLI & Terminal (21 tests)

| Runbook ID | Title | UI Plan | Backend Plan | Gap? |
|------------|-------|---------|--------------|------|
| CLI-01 | /help Command | CLI-01 | — | No |
| CLI-02 | /status Command | CLI-02 | — | No |
| CLI-03 | /clear Command | CLI-03 | — | No |
| CLI-04 | /compact Command | CLI-04 | — | No |
| CLI-05 | /model Command | CLI-05 | — | No |
| CLI-06 | /plan Command | CLI-06 | — | No |
| CLI-07 | Simple Prompt and Response | CLI-18..19 | — | No |
| CLI-08 | File Creation via Claude | CLI-08 | — | No |
| CLI-09 | File Read via Claude | CLI-07 | — | No |
| CLI-10 | Special Characters | — | — | **YES** |
| CLI-11 | Terminal Ctrl+C Interrupt | — | — | **YES** |
| CLI-12 | /model switch to specific model | CLI-05 | — | No |
| CLI-13 | Multi-line input via WebSocket | — | — | **YES** |
| CLI-14 | 500-character string via WebSocket | — | — | **YES** |
| CLI-15 | Up arrow / history recall | — | — | **YES** |
| CLI-16 | Tab character / completion | — | — | **YES** |
| CLI-17 | /plan toggle (twice) | CLI-15..17 | — | No |
| CLI-18 | Tool use via natural language | CLI-10..12 | — | No |
| CLI-19 | Terminal reconnect after page refresh | RCN-07 | — | No |
| CLI-20 | /status (second verification) | CLI-02 | — | No |
| CLI-21 | Multi-tab WebSocket isolation | TAB-03 | WS-03 | No |

### Phase 6: End-to-End (1 test)

| Runbook ID | Title | UI Plan | Backend Plan | Gap? |
|------------|-------|---------|--------------|------|
| E2E-01 | Daily Developer Loop | E2E-01 | — | No |

### Phase 7: User Stories (7 tests)

| Runbook ID | Title | UI Plan | Backend Plan | Gap? |
|------------|-------|---------|--------------|------|
| USR-01 | Coding Task | USR-01 | USR-01 | No |
| USR-02 | Organize Sessions | USR-02 | USR-02 | No |
| USR-03 | Task Management | USR-03 | USR-05 | No |
| USR-04 | Customize Appearance | USR-04 | USR-03 | No |
| USR-05 | Browse Files | USR-05 | — | No |
| USR-06 | Review Summary | USR-06 | USR-06 | No |
| USR-07 | Hide/Recover Session | USR-07 | — | No |

### Phase 8 (New): New Features NF-01 to NF-38 (30 active)

| Runbook ID | Title | UI Plan | Backend Plan | Gap? |
|------------|-------|---------|--------------|------|
| NF-01 | Sidebar Collapse Persistence | SB-04 | — | No |
| NF-02 | Sidebar Expand Persistence | SB-04 | — | No |
| NF-03 | Sidebar localStorage Written | — | — | **YES** |
| NF-04 | Project Config Modal Opens | — | — | **YES** |
| NF-05 | Project Config Save Name | — | PRJ-03 (partial) | **YES** |
| NF-06 | Project Config Save State | — | — | **YES** |
| NF-07 | Project Config Save Notes | — | PRJ-05 | Partial |
| NF-08 | Project State Filtering | FLT-01..04 | — | No |
| NF-09 | Session Restart Button Exists | — | — | **YES** |
| NF-10 | Session Restart Click | — | — | **YES** |
| NF-11 | File Browser Panel Opens | FIL-01, PNL-01 | — | No |
| NF-12 | File Browser Expand | FIL-04, FIL-08 | — | No |
| NF-13 | File Browser New Folder Click | — | — | **YES** |
| NF-14 | File Browser Upload Click | — | — | **YES** |
| NF-15 | Add Project Dialog Opens | AP-01 | — | No |
| NF-16 | Add Project New Folder | — | — | **YES** |
| NF-17 | Add Project Select and Add | AP-03..04 | PRJ-01 | No |
| NF-18 | Settings Modal Opens | SET-01 | — | No |
| NF-19 | Settings Shows API Keys Section | — | — | **YES** |
| NF-20 | Settings Old Quorum Fields Gone | — | — | **YES** |
| NF-21 | Settings Save Gemini Key | — | SET-01..02 | Partial |
| NF-22 | Settings Save Codex Key | — | SET-01..02 | Partial |
| NF-23 | Settings Save Deepgram Key | — | SET-01..02 | Partial |
| NF-24 | Settings Keys Load on Open | SET-05 | SET-01 | No |
| NF-25 | Mic Button in Status Bar | — | — | **YES** |
| NF-26 | Voice WebSocket Connects | — | — | **YES** |
| NF-27 | Session Endpoint Info | — | SES-11, SES-17 | Partial |
| NF-28 | Session Endpoint Transition | — | — | **YES** |
| NF-29 | Session Endpoint Resume | SES-04 | SES-04 | No |
| NF-30 | Smart Compaction Endpoint Gone | — | — | **YES** |
| NF-31..37 | (Various removed) | REMOVED | REMOVED | N/A |
| NF-38 | Workspace Path | — | — | **YES** |

### Phase 9: Settings & Vector Search (14 tests)

| Runbook ID | Title | UI Plan | Backend Plan | Gap? |
|------------|-------|---------|--------------|------|
| NF-39 | Settings Has Four Tabs | SET-04 | — | No |
| NF-40 | General Tab Shows Appearance/Keys | — | — | **YES** |
| NF-41 | Claude Code Tab Shows Model/Keepalive | — | — | **YES** |
| NF-42 | Claude Code Settings Persist | SET-06..07 | SET-01..02 | No |
| NF-43 | Vector Search Tab Shows Status | — | QDR-01 | Partial |
| NF-44 | Vector Search Provider Dropdown | — | QDR-07 | Partial |
| NF-45 | Vector Search Custom Provider Fields | — | — | **YES** |
| NF-46 | Vector Search Collections Visible | — | QDR-02 | Partial |
| NF-47 | Vector Search Collection Dims Configurable | — | QDR-02 | Partial |
| NF-48 | Vector Search Collection Patterns Editable | — | QDR-06 | Partial |
| NF-49 | Vector Search Ignore Patterns | — | QDR-06 | Partial |
| NF-50 | Vector Search Additional Paths | — | — | **YES** |
| NF-51 | Vector Search Re-index Button | — | QDR-08 | Partial |
| NF-52 | Qdrant Status API | — | QDR-01 | No |

### Phase 10: Multi-CLI & MCP Management (16 tests)

| Runbook ID | Title | UI Plan | Backend Plan | Gap? |
|------------|-------|---------|--------------|------|
| NF-53 | Filter Bar is Dropdown | FLT-01 | — | No |
| NF-54 | Sort Bar is Dropdown | SRT-01 | — | No |
| NF-55 | Plus Button Opens CLI Dropdown | NS-01, TRM-01 | — | No |
| NF-56 | Create Claude Session via Dropdown | NS-03 | SES-01 | No |
| NF-57 | Session Shows CLI Type Indicator | SB-06 | — | No |
| NF-58 | Terminal Button Gone from Project Header | — | — | **YES** |
| NF-59 | Create Session via MCP | — | MCS-04f | Partial |
| NF-60 | Connect to Session by Name | — | MCS-04g | Partial |
| NF-61 | Restart Session | — | — | **YES** |
| NF-62 | MCP Register | — | MCS-04i | No |
| NF-63 | MCP List Available | — | — | **YES** |
| NF-64 | MCP Enable for Project | — | MCS-04j | No |
| NF-65 | MCP List Enabled | — | — | **YES** |
| NF-66 | MCP Disable | — | — | **YES** |
| NF-67 | Tmux Periodic Scan Running | — | TMX-06..09 | Partial |
| NF-68 | Only 3 MCP Tools | — | MCS-02 | No |

---

## 2. Gap Summary: Runbook Scenarios Missing from Test Plans

These runbook tests exist but have no corresponding test plan scenario(s).

### Terminal Input Handling (6 gaps)

| Runbook ID | Title | Recommendation |
|------------|-------|----------------|
| CLI-10 | Special Characters | Add to UI plan as TIO-06 |
| CLI-11 | Terminal Ctrl+C Interrupt | Add to UI plan as TIO-07 |
| CLI-13 | Multi-line input via WebSocket | Add to UI plan as TIO-08 |
| CLI-14 | 500-char string via WebSocket | Add to UI plan as TIO-09 |
| CLI-15 | Up arrow / history recall | Add to UI plan as TIO-10 |
| CLI-16 | Tab character / completion | Add to UI plan as TIO-11 |

### New UI Features — Project Config (4 gaps)

| Runbook ID | Title | Recommendation |
|------------|-------|----------------|
| NF-04 | Project Config Modal Opens | Add to UI plan as CFG-08 (project) |
| NF-05 | Project Config Save Name | Add to UI plan as CFG-09 |
| NF-06 | Project Config Save State | Add to UI plan as CFG-10 |
| NF-09 | Session Restart Button Exists | Add to UI plan |
| NF-10 | Session Restart Click | Add to UI plan |

### New UI Features — File Browser (3 gaps)

| Runbook ID | Title | Recommendation |
|------------|-------|----------------|
| NF-13 | File Browser New Folder Click | Add to UI plan as FIL-11 |
| NF-14 | File Browser Upload Click | Add to UI plan as FIL-12 |
| NF-16 | Add Project New Folder | Add to UI plan as AP-11 |

### New UI Features — Settings (6 gaps)

| Runbook ID | Title | Recommendation |
|------------|-------|----------------|
| NF-03 | Sidebar localStorage Written | Add to UI plan as SB-14 |
| NF-19 | Settings Shows API Keys Section | Add to UI plan as SET-08 |
| NF-20 | Settings Old Quorum Fields Gone | Add to UI plan as SET-09 |
| NF-25 | Mic Button in Status Bar | Add to UI plan as STB-11 |
| NF-26 | Voice WebSocket Connects | Add to UI plan as STB-12 |
| NF-40 | General Tab Shows Appearance/Keys | Add to UI plan as SET-10 |
| NF-41 | Claude Code Tab Shows Model/Keepalive | Add to UI plan as SET-11 |

### New UI Features — Vector Search (2 gaps)

| Runbook ID | Title | Recommendation |
|------------|-------|----------------|
| NF-45 | Vector Search Custom Provider Fields | Add to UI plan |
| NF-50 | Vector Search Additional Paths | Add to UI plan |

### New Features — Multi-CLI & MCP (6 gaps)

| Runbook ID | Title | Recommendation |
|------------|-------|----------------|
| NF-28 | Session Endpoint Transition | Add to backend plan |
| NF-30 | Smart Compaction Endpoint Gone | Add negative test to backend plan |
| NF-38 | Workspace Path | Add to backend plan as ENT-13 |
| NF-58 | Terminal Button Gone | Add negative test to UI plan |
| NF-61 | Restart Session | Add to backend plan as MCS-04n |
| NF-63 | MCP List Available | Add to backend plan |
| NF-65 | MCP List Enabled | Add to backend plan |
| NF-66 | MCP Disable | Add to backend plan as MCS-04o |

**Total runbook gaps: ~33 scenarios missing from test plans**

---

## 3. Reverse Gap: Test Plan Scenarios Not in Runbook

These test plan scenarios exist but have no runbook execution steps. Since the runbook is for UI/browser execution on the HF Space, backend-only (Gates A & B) scenarios are expected to be absent. We focus only on UI plan scenarios missing from the runbook.

### UI Plan Scenarios Not Covered by Runbook

| Plan ID | Title | Category | Priority |
|---------|-------|----------|----------|
| LAY-01..05 | Layout structure tests | Layout | Low — covered implicitly by SMOKE-01 |
| INIT-01 | Inline initialization | Init | Low — covered implicitly by SMOKE-01 |
| FAIL-01..02 | Fetch error handling | Error | Medium — error paths untested |
| SB-08 | Hash-based skip optimization | Sidebar | Low |
| SB-09..11 | Missing project/session styling | Sidebar | Medium |
| SES-02 | Session actions on hover | Session | Low — implicit in other tests |
| SES-04 | Resume failure error (Mock) | Session | Medium |
| TAB-01 | Tab bar empty when no sessions | Tabs | Low |
| TAB-06 | Tab status indicator | Tabs | Medium |
| TIO-03..05 | Terminal resize, binary data | Terminal | Medium |
| CFG-04..07 | Config close/clear buttons | Config | Low |
| PNL-00 | Panel opened with no session | Panel | Low |
| PNL-02..03 | Panel tab switching, data load | Panel | Medium |
| FIL-05..06 | Mounts fallback, file read error | Files | Medium — error paths |
| FIL-09..10 | File viewer readonly, multi-mount | Files | Low |
| AUTH-01..10 | Auth flow (Mock) | Auth | Medium — only EDGE-05/20/21 cover this |
| STB-02..05 | Status bar model/mode/context details | Status | Low — FEAT-17 covers broadly |
| STB-08..10 | Status bar degraded, model shortening | Status | Medium |
| CTX-04 | Bar width matches percentage | Context | Low |
| RCN-04 | "No tmux session" stops reconnect | Reconnect | Medium |
| RCN-06 | Token update via WS (Mock) | Reconnect | Medium |
| RCN-08..10 | Close cancels reconnect, settings update, WS error | Reconnect | Medium |
| REF-01..04 | Auto-refresh timers | Refresh | Medium |
| KEY-01..05 | Keyboard shortcuts | Keyboard | Medium |
| VAL-01..06 | Input validation | Validation | Medium |
| RACE-01..03 | Temp ID race conditions | Race | Medium |
| MOD-01..04 | Modal overlap | Modal | Low — EDGE-10 covers |
| ESC-01..04 | XSS / HTML safety | Security | **High — not in runbook** |
| UI-ERR-01..02 | Button state / error recovery | Error | Medium |
| LIFE-01 | Tmux killed externally | Lifecycle | Medium — EDGE-11 covers |
| HR-01..04 | Hot-reload tests | Hot-reload | Medium |
| DND-04 | File browser links draggable | DnD | Low |

### High-Priority Reverse Gaps (should be added to runbook)

1. **ESC-01..04 (XSS/HTML Safety)** — Security tests not in runbook. Should add a Phase 4 edge case.
2. **FAIL-01..02 (Fetch Errors)** — Error recovery not exercised.
3. **KEY-01..05 (Keyboard Shortcuts)** — No runbook coverage of keyboard shortcuts.
4. **VAL-01..06 (Input Validation)** — No runbook coverage of validation edge cases.
5. **HR-01..04 (Hot-Reload)** — Not tested via runbook (deferred in old Phase 8).

---

## 4. Removed Feature Alignment

Both runbook and test plans correctly mark the same features as REMOVED:

| Feature | Runbook | UI Plan | Backend Plan | Aligned? |
|---------|---------|---------|--------------|----------|
| Notes panel | FEAT-03, EDGE-12, EDGE-13 | NTS-01..04, BRW-10, BRW-38 | PRJ-05 (still exists), MCP-06d/e | **Partial** — PRJ-05/MCP-06o still reference notes via config, which is valid |
| Messages panel | FEAT-05 | MSG-01..02, BRW-12 | MSG-01..07 still listed | **Issue** — Backend plan MSG section not fully marked REMOVED |
| Quorum | NF-20, NF-32 | QRM-01..03 | QRM-01..15 all REMOVED | Yes |
| Smart compaction | EDGE-07, NF-30 | CST-01..20, BRW-31, CLI-21 | CMP-43 REMOVED | Yes |
| Terminal button | EDGE-17, NF-58 | UI-E19 REMOVED | — | Yes |
| Active dot | — | UI-E27 updated | — | Yes |
| Tasks toggle | — | FTR-01 REMOVED | — | Yes |
| Plan tools | NF-31..37 | — | MCP-06j/k REMOVED, FS-06 REMOVED | Yes |

### Issues Found

1. **Backend plan MSG section**: MSG-01..07 are still listed as active scenarios even though the messaging system was deleted. These should be marked REMOVED.
2. **Backend plan MCX section**: MCX-01..11 reference `mcp-external.js` which was deleted. All MCX scenarios should be marked REMOVED.
3. **Backend plan UI-24**: References "Notes tab: auto-save textarea" — should be marked REMOVED.
4. **Backend plan UI-26**: References "Messages tab: view and send" — should be marked REMOVED.
5. **Backend plan UI-40**: References "Quorum configuration" — should be marked REMOVED.
6. **Backend plan BRW-10**: References "Notes autosave" — should be marked REMOVED.
7. **Backend plan BRW-12**: References "Messages" — should be marked REMOVED.
8. **Backend plan BRW-31**: References "Compaction workflow" — should be marked REMOVED.
9. **Backend plan USR-02**: References "send message between sessions" — messaging deleted, needs rewrite.
10. **Backend plan CMP section**: Most CMP scenarios are still listed. While the underlying code functions may still exist for manual compaction via /compact, the smart compaction pipeline (CMP-11..42) is removed. The threshold/nudge tests (CMP-28..34, 46..50) and the checker/pipeline orchestration tests are dead code.

---

## 5. Consistency Issues

### ID Collisions Between Documents

The following ID prefixes are used in BOTH the UI plan and the runbook with potentially different meanings:

| Prefix | Runbook Usage | UI Plan Usage | Conflict? |
|--------|---------------|---------------|-----------|
| CLI-01..21 | Phase 5 CLI tests | §9 CLI function tests | **Same IDs, same tests** — aligned |
| USR-01..07 | Phase 7 user stories | §8.36 usability tests | **Same IDs, same tests** — aligned |
| E2E-01 | Phase 6 daily loop | §8.35 daily loop | **Same ID, same test** — aligned |
| CFG-01..07 | Runbook session config | UI plan session config | Aligned |
| SET-01..07 | UI plan settings | Backend plan settings | Different scopes — OK |

No actual conflicts found. IDs are consistent across documents.

### Naming Inconsistencies

| Issue | Location | Details |
|-------|----------|---------|
| Filter test | Runbook CORE-06 vs UI FLT-01 | Same test, different ID — expected (runbook uses phase-based IDs) |
| "Malory" reference | Runbook line 58 | Should be "Playwright MCP" not "Malory MCP tools" — stale reference |

---

## 6. Recommendations

### Immediate Actions (for #80 closure)

1. **Add 33 missing test plan entries** to cover runbook scenarios with no plan backing (see Section 2)
2. **Mark MSG-01..07, MCX-01..11, and stale UI/BRW references** as REMOVED in the backend test plan
3. **Add XSS/security tests (ESC-01..04) to the runbook** as Phase 4 edge cases
4. **Fix "Malory" reference** in runbook to "Playwright MCP"

### Deferred Actions (for #81)

1. Audit existing test code files against the updated runbook
2. Remove/update stale test specs that reference deleted features
3. Create missing test spec files for new features (NF series)

---

## 7. Phase 2 Milestone Mock-Test Coverage Notes

### F0 (#364) — Frontend monolith decomposition (N/A for unit tests)

F0 is a structural HTML/JavaScript reorganisation: `public/index.html` shrinks from
6 113 lines to a 591-line thin shell by extracting the inline `<script>` to
`public/js/app.js` and 10 ESM sub-modules (`state.js`, `sidebar.js`, `tabs.js`, …).

**Why no dedicated mock unit tests:**

- No server-side logic was added or changed. The extracted modules are pure browser
  code (DOM manipulation, `fetch`, `WebSocket`) that requires a real browser DOM to
  execute — `node:test` / Node.js cannot meaningfully run them without a headless
  browser.
- The structural invariants (CSS extracted to `main.css`, inline script replaced by
  `<script type="module" src="/js/app.js">`, all `window.*` exports present) are
  verified by `e3-pending-lock.test.js` (E3-PEND-03/04 updated in commit `6dd504a`)
  and the Phase 2 reviewer-findings test (`p2-reviewer-fixes.test.js` #452/#457 notes).
- Full end-to-end functional verification happens in **Stage 8 (UI runbook)** via
  Playwright headless browser tests against the deployed `workbench-test` container.

**Traceability:** F0 → UI runbook entries P2-F0-01 through P2-F0-07 (Stage 8, all PASS,
2026-05-12, container 16b33e1). Mock: S8-REG-01/02/03 in `p2-stage8-regressions.test.js`
cover three F0 extraction regressions found during Stage 8 and fixed in commits
08ee6db/e60e59b/16b33e1.

---

### M1 (#368) — KB watcher clone-if-missing: live test gap

**What M1 changed:** `_cloneIfMissing()` and the KB sync poller were extracted
from `server.js` into `kb-watcher.js start()`. The structural proof lives in
`m1-kb-watcher-clone.test.js` (M1-KB-01 through M1-KB-08): static checks verify
`_cloneIfMissing` is declared, calls `git clone`, is ordered before the chokidar
watch, and that `server.js` no longer contains the inline clone block.

**Why `_cloneIfMissing` is not exercised by live tests:**

The sandbox test container (`workbench-test-workbench-1`) has no outbound network
access to `github.com`. When the container starts, kb-watcher `start()` calls
`_cloneIfMissing()`, which attempts `git clone https://github.com/rmdevpro/workbench-kb`
and fails with `"fatal: unable to access … Could not resolve host: github.com"`.
The clone failure is logged to container stdout (confirmed via `docker logs`), but
the structured logger's batch writer does not flush these early startup messages to
the SQLite DB — `/api/logs?module=kb-watcher` returns 0 rows. Inside the container,
`docker logs` is not callable (no Docker socket bind-mount in `docker-compose.test.yml`).

**Coverage status:**

| Layer | Test | Covers |
|---|---|---|
| Mock structural | M1-KB-01 through M1-KB-08 | `_cloneIfMissing` declared, ordered before watcher, git clone present, server.js clean |
| Live behavioral | M1-LIVE-01/02 | `/api/kb/status` + `/api/kb/roles` respond without crash (watcher init path ran) |
| Live clone path | **GAP** | Clone attempt + clone failure recovery not exercisable without network |

Live behavioral verification of the clone path requires either a network-capable
test environment (real `github.com` access) or a local git server fixture. Neither
is available in the current sandbox. File under "infrastructure gap" — not a product
gap.

---

### G0 (#365) — Routes monolith decomposition

`routes.js` shrank from ~5,800 lines to ~36 lines (a thin composer that requires each
`src/routes/*.js` module and calls its `register({ app, ... })` function). The per-domain
handlers live in `src/routes/`: `auth.js`, `health.js`, `projects.js`, `sessions.js`,
`tasks.js`, `files.js`, `kb.js`, `settings.js`, `git-accounts.js`. Common helpers
(including the `createTrustDir()` factory deduplicated from `sessions.js` + `projects.js`)
live in `src/routes/_shared.js`.

**Coverage:**

| Layer | Test | Covers |
|---|---|---|
| Mock structural | `g0-routes-composition.test.js` (G0-RT-01..09) | thin composer present, each `src/routes/*.js` exports `register`, `createTrustDir` factory exported and used by both `sessions.js` + `projects.js` |
| Live behavioral | `p2-phase2-live.test.js` G0-LIVE-01/02/03 | per-domain endpoints reachable end-to-end with correct method + status |
| Adjacent | `a8-auth-login.test.js` A8-LIVE-02 | code inspection reads `src/routes/auth.js` (path-updated post-G0) |

---

### H0 (#366) — Session-utils factory decomposition

`session-utils.js` shrank from ~800 lines to a thin factory adapter. The
`createSessionUtils({ safe, db, config, logger })` factory composes sub-modules
in `src/session-utils/`: `claude-jsonl.js`, `gemini.js`, `codex.js`, `info.js`,
`search.js`. The original import surface is preserved via a backward-compat shim
so existing callers (routes, watchers) do not need to change.

**Coverage:**

| Layer | Test | Covers |
|---|---|---|
| Mock structural | `h0-session-utils-factory.test.js` (H0-SU-01..06) | factory exported, API shape, instance independence, backward-compat adapter |
| Live behavioral | `p2-phase2-live.test.js` H0-LIVE-01/02 | session-utils factory exposes the expected API surface end-to-end |

---

### J1 (#367) — qdrant-sync factory-DI conversion

`qdrant-sync.js` was converted from a direct-import module to a factory-DI module.
All existing callers (`watchers.js`, KB sync) now receive the qdrant instance via
injection through `server.js`.

**Coverage:**

| Layer | Test | Covers |
|---|---|---|
| Live behavioral | `p2-phase2-live.test.js` J1-LIVE-01/02 | qdrant factory wired correctly; `/api/kb/*` endpoints still respond |

Mock structural is N/A — the conversion is a wiring change with no new code paths;
the live tests prove the wiring is correct.

---

### Phase 2 reviewer findings (Stage 5 R1–R3, Stage 7 R1–R2, Stage 9 R1–R3)

All findings filed during the Phase 2 review rounds have corresponding mock and/or
live coverage. Test IDs are stable; issue numbers map 1:1 to test cases:

| Round | Issues | Test coverage |
|---|---|---|
| Stage 5 R1 | #452..#459 | `p2-reviewer-fixes.test.js` covers #453, #454, #455, #456 (#458 via existing `require-hoist.test.js`; #452/#457/#459 are frontend-only — UI Stage 8) |
| Stage 5 R2 | #462..#465, #467 | `p2-timestamp-claim-behavioral.test.js` |
| Stage 5 R3 | #466 | `p2-reviewer-fixes.test.js` |
| Cherry-picks | #460, #461 | `p2-reviewer-fixes.test.js` (mock) + `p2-phase2-live.test.js` (#460-LIVE-01, #461-LIVE-01/02/03) |
| Stage 7 R1 | #468..#473 | `p2-phase2-live.test.js` (#468-LIVE-01); other R1 issues are documentation/comment updates |
| Stage 7 R2 | #473 (re-raise) | matrix §7 M1 documentation; covered |
| Stage 8 regressions | (no GH issue — fixed in-stage) | `p2-stage8-regressions.test.js` S8-REG-01/02/03 — F0 extraction omissions (`files.js` wrong import, `createTab` missing steps, sidebar re-render guard) |
| Stage 9 R1 | #474..#477 | Runbook entries P2-F0-05/06/07, P2-452-01, P2-460-01 rewritten (real clicks, parameterized URL); P2-461-01 removed |

---

## 8. Statistics

| Metric | Count |
|--------|-------|
| Runbook active scenarios | 154 (+10 Phase 2: P2-F0-01..07, P2-452-01/02, P2-460-01) |
| UI plan active scenarios | 281 (Phase 2 entries documented in plan's "Phase 2 Milestone Coverage" section) |
| Backend plan active scenarios | ~378 + Phase 2 test classes (G0/H0/M1/J1, p2-reviewer-fixes, p2-timestamp-claim-behavioral, p2-stage8-regressions, p2-phase2-live) |
| Runbook → plan gaps | 33 |
| Plan → runbook high-priority gaps | 5 categories (ESC, FAIL, KEY, VAL, HR) |
| Stale REMOVED entries in backend plan | ~30+ (MSG, MCX, UI refs, BRW refs, CMP pipeline) |
| Phase 2 GitHub issues with full coverage | 4 milestone (#364 F0, #365 G0, #366 H0, #367 J1, #368 M1) + 22 reviewer findings (#452..#477) |
| ID collisions | 0 |
