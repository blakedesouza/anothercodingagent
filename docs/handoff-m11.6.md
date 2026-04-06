# M11.7 Handoff — Peer Agent Profiles

**Date:** 2026-04-05
**Status:** M11.6 complete. Ready for M11.7.

## What's Done (M11.6)

| Deliverable | Status | Tests |
|---|---|---|
| `buildInvokeSystemMessages()` in prompt-assembly.ts | Complete | 12 |
| `systemMessages` field on TurnEngineConfig | Complete | — |
| `sanitizePath()` for control char injection | Complete | 1 |
| Invoke handler wiring (buildProjectSnapshot + systemMessages) | Complete | — |
| Integration tests (TurnEngine replacement + fallback) | Complete | 3 |
| **Total** | **M11.6 complete** | **14 new (2290 total)** |

## What to Do Next (M11.7)

Expand agent profiles from restrictive tool blocklists to full peer-level toolkits. Safety from sandbox + deadline, not tool restrictions.

- [ ] **Coder profile:** expand to full tool set minus delegation tools
- [ ] **Witness profile:** expand to all non-mutating tools + research tools
- [ ] **Reviewer profile:** same as witness
- [ ] **Researcher profile:** add search_semantic, lsp_query, web tools
- [ ] Remove `WATCHDOG_DENIED_TOOLS` approach for coder/witness
- [ ] Update agent-registry.ts with new default tool sets
- [ ] Unit tests: verify expanded profiles, delegation tools still excluded

## Dependencies

- M11.6: Invoke prompt assembly (done — agents now get proper context)
- `src/delegation/agent-registry.ts` (existing — AgentRegistry with 4 built-in profiles)
- `src/review/report.ts` (existing — WATCHDOG_DENIED_TOOLS)

## File Locations

- Agent profiles: `src/delegation/agent-registry.ts`
- Watchdog denied tools: `src/review/report.ts`
- Tests: `test/delegation/agent-registry.test.ts`
