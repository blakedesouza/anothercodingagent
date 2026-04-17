# Debug UI Auto-Start Plan

## Goal

Start the ACA local debug UI automatically for normal user-facing ACA runs, reuse an existing debug UI instead of starting duplicates, open the dashboard in Brave, and let the dashboard shut itself down from the browser.

## Constraints

- Do not start the debug UI for internal `aca invoke` subprocesses or other automation-only paths that would spam browser tabs.
- Keep the debug UI singleton on the default local host/port unless the server is explicitly configured otherwise.
- Reuse an already-running debug UI when healthy.
- Keep startup resilient if Brave is unavailable or the UI cannot start.

## Implementation Outline

1. Add a small debug UI manager in `src/` that:
   - reads/writes a metadata file under `ACA_HOME`
   - checks whether an existing UI is healthy
   - starts the server in detached mode only when needed
   - opens the dashboard URL in Brave on Windows/WSL
2. Teach the debug UI server to:
   - publish its runtime metadata on successful bind
   - remove stale metadata on shutdown
   - expose a local authenticated shutdown endpoint
3. Integrate the manager into normal ACA CLI startup:
   - run once per top-level user-facing CLI session
   - skip `invoke` and other machine-facing subprocess paths
4. Add targeted tests for:
   - metadata parsing / reuse decisions
   - browser command selection
   - shutdown endpoint behavior if feasible

## Validation

- Typecheck
- Build
- Targeted Vitest coverage for the new manager logic
- Manual smoke test of:
  - first ACA launch auto-starting the UI
  - second ACA launch reusing the same UI
  - dashboard shutdown button terminating the server
