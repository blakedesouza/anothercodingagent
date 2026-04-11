# M9 Post-Milestone Review Handoff

**Date:** 2026-04-05
**Status:** M9.3 complete. Ready for M9 post-milestone review.

## What's Done (Milestone 9)

| Substep | Deliverable | Tests |
|---------|-------------|-------|
| M9.1 | MCP server (`src/mcp/server.ts`), `aca serve` CLI, aca_run tool | 17 |
| M9.2 | `.claude/settings.json` MCP config, `/delegate` skill | 9 |
| M9.2b | Runtime bug fixes (invoke outcome, model config, token usage) | 3 |
| M9.3 | Parallel invocation tests, concurrency limit, `/orchestrate` skill | 6 |
| **Total** | **M9 complete** | **35 new, 2196 total** |

## Review Requirements

From `docs/steps/09-milestone9-bridge.md`:
```
<!-- risk: medium — MCP integration, subprocess management -->
```

Medium risk = Architecture review + Bug hunt (4 witnesses each). No security review.

### Architecture Review Focus
- MCP contract conformance (Block 1, Block 10)
- Subprocess lifecycle management
- Error boundary isolation
- `activeChildren` (module-level) vs `activeInvocations` (per-server) duality

### Bug Hunt Focus
- Process leaks (zombie subprocesses, timer leaks)
- Timeout edge cases (concurrent timeouts, SIGTERM→SIGKILL escalation)
- Concurrent invocation race conditions
- Concurrency limit bypass scenarios

## Key Files to Review

- `src/mcp/server.ts` — MCP server, subprocess management, concurrency limit
- `src/cli/executor.ts` — InvokeRequest/InvokeResponse types, contract versions
- `test/mcp/server.test.ts` — 32 tests (unit + integration + parallel)
- `~/.claude/skills/delegate/SKILL.md` — delegate skill
- `~/.claude/skills/orchestrate/SKILL.md` — orchestrate skill

## Review Checklist (from step file)

- [ ] Architecture review (4 witnesses): MCP contract, subprocess lifecycle, error handling
- [ ] Bug hunt (4 witnesses): process leaks, timeout edge cases, concurrent invocations
- [ ] Critical findings fixed and verified
- [ ] Review summary appended to changelog
