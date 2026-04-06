# M7.7c Handoff — Degraded Capability Handling + Tool Masking

**Date:** 2026-04-03
**Status:** M7.13 complete. Ready for M7.7c.

## What's Done (M7.13)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| CapabilityHealthMap class (4 states, 2 kinds) | Complete | 14 |
| Local process lifecycle (one restart, session-terminal) | Complete | 5 |
| HTTP cooldown + circuit breaker (2 consecutive) | Complete | 7 |
| Cooldown timing (5s-60s exponential) | Complete | 5 |
| LLM context rendering (retry ~/cooldown/this session) | Complete | 7 |
| computeCooldown with n<1 guard | Complete | 2 |
| sessionTerminal guard on reportSuccess | Complete | 5 |
| **Total** | **M7.13 complete** | **45 new, 1601 total** |

## What to Do Next (M7.7c)

From `docs/steps/07a-milestone7-error-health.md`:

- `available`: normal operation, tool in definitions, no health line
- `degraded`: tool stays in definitions, health context injected
- `unavailable`: tool REMOVED from definitions sent to LLM
- If model references masked tool: `tool.validation` with alternatives message
- Delegation error chains: nested `cause` for root-cause traversal across depth

## Dependencies

- M7.13 health states — `src/core/capability-health.ts` (CapabilityHealthMap, HealthState, renderHealthContext)
- M7.7a error codes — `src/types/errors.ts` (TOOL_ERRORS.VALIDATION for masked tool response)
- Tool definitions — `src/core/prompt-assembly.ts` (buildToolDefinitions, where masking would be applied)
- Turn engine — `src/core/turn-engine.ts` (where health context injection and masked-tool detection would occur)

## File Locations

- Health map: `src/core/capability-health.ts`
- Error types: `src/types/errors.ts`
- Prompt assembly: `src/core/prompt-assembly.ts` (tool definitions filtering)
- Turn engine: `src/core/turn-engine.ts` (health context injection)
- Tests: `test/core/capability-health.test.ts` (extend), possibly new test file for tool masking integration
