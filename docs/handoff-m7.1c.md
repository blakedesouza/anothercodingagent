# M7.1c Handoff — `message_agent` + `await_agent` + Lifecycle

**Date:** 2026-04-04
**Status:** M7.1b complete. Ready for M7.1c.

## What's Done (M7.1b)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `spawnAgentSpec` tool definition (external-effect, delegation timeout) | Complete | 2 |
| `DelegationTracker` (concurrent/depth/total limits, spawn indices) | Complete | 4 |
| `createSpawnAgentImpl` factory with DI | Complete | 6 |
| Tool set intersection (profile ∩ overrides, narrowing-only) | Complete | 2 |
| Structural preauth/authority narrowing (match equality) | Complete | 7 |
| Correct error codes (spawn_failed vs depth_exceeded) | Complete | 3 |
| spawnIndex tracking per parent | Complete | 1 |
| Unknown agent type error | Complete | 1 |
| Child session creation with lineage | Complete | 1 |
| **Total** | **M7.1b complete** | **27 new, 1853 total** |

## What to Do Next (M7.1c)

From `docs/steps/07b-milestone7-delegation.md`:

- `message_agent` tool: agent_id, message → ack/status
- `await_agent` tool: agent_id, timeout (0=poll) → result or progress snapshot
- Lifecycle phases: booting, thinking, tool, waiting
- Progress snapshot: status, phase, activeTool, lastEventAt, elapsedMs, summary
- Final result: structured output, token usage, tool call summary
- Children cannot use `ask_user`/`confirm_action` directly → return `approval_required`

## Dependencies

- M7.1b spawn_agent: `src/delegation/spawn-agent.ts` (DelegationTracker, TrackedAgent, SpawnCallerContext)
- M7.1a AgentRegistry: `src/delegation/agent-registry.ts`
- M7.1a types: `src/types/agent.ts` (AgentIdentity), `src/types/ids.ts` (AgentId)
- M1.5 Tool Runtime: `src/tools/tool-registry.ts` (ToolSpec, ToolImplementation, ToolContext)
- M1.7 Turn Engine: `src/core/turn-engine.ts` (for child agent execution)
- Existing ask_user: `src/tools/ask-user.ts` (context.isSubAgent check already exists)

## File Locations

- Spawn agent + tracker: `src/delegation/spawn-agent.ts`
- New message/await tools: `src/delegation/message-agent.ts`, `src/delegation/await-agent.ts` (suggested)
- Agent types: `src/types/agent.ts`
- Error taxonomy: `src/types/errors.ts` (DELEGATION_ERRORS.MESSAGE_FAILED already exists)
- ask_user sub-agent guard: `src/tools/ask-user.ts:51` (context.isSubAgent check)

## Key Design Notes

- `DelegationTracker.getAgent()` returns the tracked agent with identity, tools, and preauths — use this for `await_agent` result construction
- `DelegationTracker.markCompleted()` transitions agent status — wire to lifecycle phase transitions
- The `approval_required` yield outcome already exists in ToolOutput (conversation.ts:43)
- Error code `delegation.message_failed` already exists for invalid/terminated agent messaging
