## Codex Review

### Summary

Phase 0 mostly matches its cleanup intent, and the source deletions themselves look coherent. I would not sign off the gate yet because the live/browser test artifacts still assert the old jQuery model. Fix those stale tests/plans first, then re-run the gate checks.

### Findings

#### Major: live regression gate will fail after jQuery deletion

`tests/live/startup.test.js:29` still asserts `/lib/jquery/jquery.min.js` returns `200`, but Phase 0 removes the dependency and the static route in `src/server.js`. The work summary says `npm run test:live` is part of this gate, so this is a blocker unless the test is updated to assert the new contract.

Recommendation: update `SRV-02` to verify only current static assets, such as `/lib/xterm/lib/xterm.js`, `/lib/codemirror/codemirror-bundle.js`, or another asset that is still intentionally served. If the intended contract is that jQuery is removed, this test should assert `404` for `/lib/jquery/jquery.min.js` or stop checking that path entirely.

#### Major: browser/file-tree tests still target the deleted jQuery FileTree API

`tests/browser/file-browser.spec.js:59` still POSTs `/api/jqueryfiletree` and asserts success. Phase 0's stated model is vanilla `createFileTree`, so this test preserves the old model Phase 0 is supposed to remove.

Recommendation: update the browser test to verify the current file-tree UI/API surface. Prefer a rendered UI assertion against `#file-browser-tree` / `createFileTree` behavior, or call the current backend browse/list endpoint if a gray-box check is still needed.

#### Moderate: test plans/docs still describe removed jQuery and prime-session behavior

Several plan references still describe removed behavior:

- `tests/workbench-test-plan-backend.md:316` still documents `scripts/prime-test-session.js`.
- `tests/workbench-test-plan-backend.md:503` still lists jQuery static serving.
- `tests/workbench-test-plan-ui.md:1754` still lists `POST /api/jqueryfiletree`.

This undercuts Phase 0's stated goal of stabilizing the model of the system.

Recommendation: either update these plan entries in Phase 0 or explicitly file them as follow-up model-reconciliation work with issue numbers. Because Phase 0 is specifically about cleanup hygiene and stale model removal, leaving these references untracked is a gate concern.

#### Minor: work summary metadata is stale

The summary says verify branch HEAD is `010ebf0`, but the branch reviewed is `phase-0-verify` at `afd5215`. This appears to be the summary-update commit rather than a product issue, but the gate artifact should name the actual reviewed commit.

Recommendation: update the header and verify artifact section to identify `afd5215` as the reviewed branch head, or explicitly state that `010ebf0` is the deployed product image and `afd5215` only updates documentation.

### Gate Recommendation

Do not sign off Phase 0 yet. The cleanup direction is correct, but the gate should not pass while live/browser tests and plans still assert deleted jQuery/FileTree behavior. Resolve those stale artifacts, then re-run the affected live/browser verification and update the work summary with the final reviewed commit.

---

## Codex Second Review

### Findings

#### Moderate: README still documents the removed jQuery FileTree model

`README.md:148` still says filesystem access is through `/api/browse`, `/api/file`, and the `jqueryfiletree connector`. That connector is now removed. This is an active architecture/behavior statement, not a historical note, so it should be updated to reference the vanilla file tree and `/api/browse`.

### Resolved From Prior Review

- The previous live-test blocker is fixed: `tests/live/startup.test.js:29` now checks xterm + codemirror and asserts jQuery returns `404`.
- The previous browser-test blocker is fixed: `tests/browser/file-browser.spec.js:56` now verifies `/api/browse?path=/` instead of `/api/jqueryfiletree`.
- The stale test-plan/runbook jQuery references were either removed or marked historical/REMOVED with current `/api/browse` behavior documented.
- The mock routes note requested by Claude was added at `tests/mock/routes.test.js:166`, and it gives future authors a clear override path.

### Gate View

I would sign off Phase 0 after the README line is corrected, or accept it as a small follow-up if the gate is limited strictly to test/code cleanup. The original blockers have been addressed. I did not rerun tests; this is a static review against the updated branch and work summary.
