# M7.1a Handoff — Agent Registry + Profiles

**Date:** 2026-04-04
**Status:** M7A.5.4 complete. Ready for M7.1a.

## What's Done (M7.8)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| 3 new patterns (env_assignment, connection_string, jwt_token) | Complete | 9 |
| allowPatterns false-positive recovery | Complete | 5 |
| Non-secret exclusions (SHA-256, UUID, hex) | Complete | 6 |
| Combined pipeline tests | Complete | 2 |
| ReDoS guard on allowPatterns | Complete | 2 |
| Connection string quote safety | Complete | 1 |
| **Total** | **M7.8 complete** | **25 new** |

## What to Do Next (After M7A.5.4)

From `docs/steps/07b-milestone7-delegation.md`:

- `AgentRegistry`: resolved once at session start, frozen for session
- 4 built-in profiles: general, researcher, coder, reviewer (with default tools, delegation permissions, system prompt overlay)
- Project-config profiles (from `.aca/config.json` in trusted workspaces)
- Agent identity type: `agt_<ulid>`, parentAgentId, rootAgentId, depth, spawnIndex, label
- Profile narrowing validation: overrides may only restrict, never widen

## Dependencies

- M2.5 Configuration System — `src/config/` (ResolvedConfig, trust boundaries)
- M1.5 Tool Runtime — `src/tools/tool-registry.ts` (ToolRegistry for per-profile tool lists)
- Block 2 spec — delegation contract, agent profiles

## File Locations

- Config: `src/config/schema.ts`, `src/config/loader.ts`
- Tool registry: `src/tools/tool-registry.ts`
- New files: `src/delegation/agent-registry.ts`, `src/types/agent.ts`
- Spec: `docs/spec/` (Block 2 delegation chunks)
