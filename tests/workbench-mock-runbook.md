# Workbench Mock Test Runbook

The Workbench-specific facts the Tester needs to run the mock suite. Process for running mock tests lives in `PROC-007 — Mock Test Process`; universal Tester rules in `roles/tester.md`. This file is project specifics only.

## Test framework

Node's built-in test runner (`node --test`), invoked via `npm test` (alias for `npm run test:coverage`).

## Where tests live

`tests/mock/*.test.js` — every file matching this glob is in scope.

## Invocation

Run inside the deployed container's filesystem so the suite sees the container's `node_modules` and source tree:

```bash
ssh ${WORKBENCH_HOST} 'docker exec -i ${WORKBENCH_CONTAINER} sh -c "cd /app && npm test"'
```

Do not run `npm test` from the host shell of a machine that's running a workbench deployment — the host's source tree may diverge from the container's, and the suite imports modules that touch persistent state.

## Coverage thresholds

Per `tests/workbench-test-plan-backend.md`:

- ≥85% line coverage
- ≥70% branch coverage

The test runner emits a coverage report when invoked via `npm test`. PASS requires both thresholds met.

## What counts as PASS

- Test runner exits 0
- Coverage thresholds met
- No skipped tests (`.skip` source markers count as skips and are FAIL — the Engineer must remove the skip or file a deferral before the run passes)

Any FAIL → apply `stage:2-mock-tester-fail`, return captured stdout/stderr/exit code to the PM verbatim.

## Project quirks

- The suite includes `tests/mock/require-hoist.test.js` which asserts module-load behavior; it must run with a clean Node module cache (each `npm test` invocation gives a fresh process, so this is automatic).
- Coverage reports land at `coverage/lcov-report/` inside the container; reference the path in the FAIL issue if coverage is below threshold.
