# M7.1b Handoff — `spawn_agent` Tool + Child Sessions

**Date:** 2026-04-04
**Status:** M7.1a complete. Ready for M7.1b.

## What's Done (M7.1a)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| AgentId type (`agt_<ulid>`) in ids.ts | Complete | — |
| AgentIdentity interface (id, parent, root, depth, spawnIndex, label) | Complete | — |
| AgentProfile interface (name, systemPrompt, defaultTools, canDelegate) | Complete | — |
| AgentRegistry.resolve() with deep-frozen profiles | Complete | 5 |
| 4 built-in profiles (general, researcher, coder, reviewer) | Complete | 5 |
| Project-config profiles with validation + shadow warnings | Complete | 5 |
| Narrowing validation (validateToolNarrowing) | Complete | 4 |
| Delegation permission checks (canDelegate) | Complete | 5 |
| Profile lookup (getProfile, listProfiles, getProfileNames) | Complete | 3 |
| **Total** | **M7.1a complete** | **25 new, 1826 total** |

## What to Do Next (M7.1b)

From `docs/steps/07b-milestone7-delegation.md`:

- `spawn_agent` tool: agent_type, task, context, allowed_tools (narrowing only), authority (narrowing only), label
- Child session creation: separate `ses_<ulid>` with parentSessionId, rootSessionId lineage
- Tool set intersection: profile defaults ∩ caller overrides
- Limits enforcement at spawn time: 4 concurrent, depth 2, 20 total per session
- On limit violation: typed `limit_exceeded` error with current/allowed values
- Pre-authorization transport: parent can pass subtree pre-auth patterns at spawn time
- Inherited pre-auths are narrowing-only

## Dependencies

- M7.1a AgentRegistry: `src/delegation/agent-registry.ts` (AgentRegistry, AgentProfile, NarrowingResult)
- M7.1a types: `src/types/agent.ts` (AgentIdentity, AgentProfile), `src/types/ids.ts` (AgentId)
- M1.3 Session Manager: `src/core/session-manager.ts` (for child session creation)
- M2.5 Config: `src/config/schema.ts` (ResolvedConfig.limits — maxConcurrentAgents, maxDelegationDepth, maxTotalAgents)
- M1.5 Tool Runtime: `src/tools/tool-registry.ts` (ToolRegistry, ToolSpec)

## File Locations

- Agent registry: `src/delegation/agent-registry.ts`
- Agent types: `src/types/agent.ts`
- New spawn tool: `src/delegation/spawn-agent.ts` (suggested)
- Session manager: `src/core/session-manager.ts`
- Config limits: `src/config/schema.ts` (limits section already has maxConcurrentAgents=4, maxDelegationDepth=2, maxTotalAgents=20)
