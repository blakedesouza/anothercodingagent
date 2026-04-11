# M7.15 Handoff — CLI Wiring + Integration Test

**Date:** 2026-04-04
**Status:** M7.14 complete. Ready for M7.15.

## What's Done (M7.14)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| MetricsAccumulator class | Complete | 8 |
| LatencyPercentiles (p50/p95/p99) | Complete | 2 |
| OTLP latency gauge metrics | Complete | 2 |
| TurnEngine wiring (latency, tools, errors) | Complete | — (integration) |
| Real collector in index.ts | Complete | — (integration) |
| Latency cap (10K) + token NaN guard | Complete | 1 |
| **Total** | **M7.14 complete** | **11 new, 2129 total** |

## What to Do Next (M7.15)

From `docs/steps/07c-milestone7-capabilities.md`:

Wire all M7 features into the CLI entry point and verify they work end-to-end.

- Wire error recovery (M7a): retry policies, health tracker, tool masking
- Wire delegation (M7b): agent registry, spawn/await/message tools registered
- Wire LSP integration (M7.3) into project awareness
- Wire browser/Playwright tools (M7.4) with sandbox constraints
- Wire web tools (M7.5): fetch, search
- Wire checkpointing (M7.6) into TurnEngine
- Wire CLI modes: executor mode (M7.11), one-shot mode (M7.12)
- Wire setup commands (M7.10b)
- Real delegation test: ask agent to spawn a sub-agent, verify communication
- Real browser test: ask agent to navigate to a page, verify Playwright executes
- Real checkpoint test: make changes, undo, verify rollback

**NOTE:** M7.15 is the FINAL substep of Milestone 7. After approval, the post-milestone review gate fires (high risk: arch + security + bug hunt, 4 witnesses each).

## Dependencies

- All M7 substeps (M7.7a-c, M7.13, M7.10, M7.8, M7A.5.1-5.4, M7.1a-c, M7.2, M7.3, M7.4, M7.5, M7.6, M7.10b, M7.11, M7.12, M7.14)
- CLI entry point: `src/index.ts`

## File Locations

- CLI entry point: `src/index.ts` (main wiring target)
- Error recovery: `src/core/turn-engine.ts`, `src/observability/capability-health.ts`
- Delegation: `src/delegation/`, `src/types/agent.ts`
- LSP: `src/lsp/`
- Browser: `src/browser/`
- Web tools: `src/tools/` (web_search, fetch_url, lookup_docs)
- Checkpointing: `src/checkpointing/checkpoint-manager.ts`
- Setup commands: `src/cli/setup.ts`
- Executor/one-shot: `src/cli/executor.ts`, `src/index.ts`
