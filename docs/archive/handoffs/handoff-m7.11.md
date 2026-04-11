# M7.11 Handoff — Executor Mode (Block 10, Block 1)

**Date:** 2026-04-04
**Status:** M7.10b complete. Ready for M7.11.

## What's Done (M7.10b)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| runInit (atomic create, 0600/icacls) | Complete | 3 |
| runConfigure (@inquirer/prompts wizard) | Complete | — (interactive) |
| runTrust / runUntrust (atomic write) | Complete | 6 |
| Commander subcommand wiring | Complete | — |
| 6 consultation fixes (TOCTOU, crash safety, injection, errors) | Complete | — |
| **Total** | **M7.10b complete** | **9 new, 2068 total** |

## What to Do Next (M7.11)

From `docs/steps/07c-milestone7-capabilities.md`:

- `aca describe --json`: output capability descriptor, skip all startup phases
  - Descriptor fields: `contract_version`, `schema_version`, `name`, `description`, `input_schema`, `output_schema`, `constraints`
- `aca invoke --json`: read JSON from stdin, execute, write JSON to stdout
  - Request envelope: `contract_version`, `schema_version`, `task`, `input`, `context`, `constraints`, `authority`, `deadline`
  - Response envelope: `contract_version`, `schema_version`, `status`, `result`, `usage` (tokens, cost), `errors`
- Version compatibility check: contract_version + schema_version major must match
- Mismatch → `unsupported_version` error on stdout + non-zero exit
- No streaming (v1): buffer full result
- Ephemeral non-resumable sessions
- No stderr output (reserved for catastrophic failures)
- Exit codes: 0/1/5 (success/runtime/protocol)
- Authority propagation: `authority` field from request maps to child pre-auth rules

## Dependencies

- Block 1: Pluggable Delegation (universal capability contract shapes)
- Block 10: CLI Interface (commander framework, already wired)
- M7.1a-c: Agent Registry + Delegation (spawn_agent, message_agent, await_agent)
- M1.7: TurnEngine (executeTurn interface)

## File Locations

- CLI entry point: `src/index.ts` (add `describe` and `invoke` subcommands)
- Delegation types: `src/delegation/` (AgentRegistry, DelegationTracker)
- Turn engine: `src/core/turn-engine.ts`
- Suggested new: `src/cli/executor.ts` (describe + invoke handlers)
