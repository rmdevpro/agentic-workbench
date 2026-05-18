# Workbench Integration Test Runbook

The Workbench-specific facts the Tester needs to run the integration suite. Process for running integration tests lives in `PROC-008 — Integration Test Process`; universal Tester rules in `roles/tester.md`. This file is project specifics only.

## Test framework

Node's built-in test runner (`node --test`), invoked via `npm run test:live`.

## Where tests live

`tests/live/*.test.js` — every file matching this glob is in scope.

## Prerequisite — target deployment

Integration tests require a running, reachable deployment. The PM dispatch provides:

- `${WORKBENCH_URL}` — base URL of the deployment under test
- `${WORKBENCH_CONTAINER}` — container name on the host
- `${WORKBENCH_HOST}` — `user@host` for `docker exec` setup

The deployment must be the stage-3 build (the image identified in the dispatch as `<service>:rN.M-<sha>`). Verify by checking the deployed image label matches the dispatch before running.

## Invocation

Run inside the deployed container's filesystem (the live tests reach back to localhost services):

```bash
ssh ${WORKBENCH_HOST} 'docker exec -i ${WORKBENCH_CONTAINER} sh -c "cd /app && npm run test:live"'
```

## What counts as PASS

- Test runner exits 0 (every live test green)
- Every test made the assertions specific to that test (no aggregate-result entries)
- The image identifier the Tester ran against matches the one the PM dispatch named

Any FAIL → apply `stage:4-integration-tester-fail`, return captured output verbatim.

## Project quirks

- The live suite exercises real MCP tool endpoints, real WebSocket connections, real `docker exec` paths, and the real qdrant instance backing the deployment. Test pollution risk is real — the suite is written to clean up its own fixtures but a crashed test may leave state behind. If the suite reports a clean run but the deployment is in a weird state afterward, file a FAIL with the observation.
- Some tests are gated behind environment variables (`SKIP_LIVE_OAUTH=1`, etc.); the test plan names which gates apply per scope. Tester does not set these gates — the PM dispatch instructs whether to include them.
