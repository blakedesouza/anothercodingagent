# M11.6 Handoff — Invoke Prompt Assembly

**Date:** 2026-04-05
**Status:** M11.5 complete. Ready for M11.6.

## What's Done (M11.5)

| Deliverable | Status | Tests |
|---|---|---|
| `src/config/witness-models.ts` — canonical witness configs | Complete | 14 |
| `consult_ring.py` max_tokens → actual API ceilings | Complete | — |
| NanoGptCatalog wired into invoke handler | Complete | 5 |
| `aca witnesses --json` CLI command | Complete | — |
| Deep freeze on all WITNESS_MODELS elements | Complete | 1 |
| StaticCatalog fallback in invoke handler | Complete | — |
| **Total** | **M11.5 complete** | **19 new** |

## What to Do Next (M11.6)

The invoke handler gives delegated agents `"You are a helpful coding assistant."` — no project context, workspace info, or tool guidance. A rich prompt assembly system exists (`src/core/prompt-assembly.ts`, 328 lines) but is never used in invoke mode.

- [ ] Wire `assemblePrompt()` (or lightweight variant) into invoke handler's TurnEngine config
- [ ] Invoke system prompt should include: identity/role, workspace root, available tools, project type from `detectStack()`, key file locations
- [ ] Keep concise (<2K tokens) — no conversation history, no durable task state
- [ ] Test: invoke handler sends system prompt with workspace root and tool list
- [ ] Test: delegated agent with real context completes faster than bare prompt

## Dependencies

- M11.5: Invoke handler now has catalog wired (done)
- `src/core/prompt-assembly.ts` (existing, 328 lines, 4-layer structure)
- `src/core/project-awareness.ts` (existing — detectRoot, detectStack, buildProjectSnapshot)

## File Locations

- Invoke handler: `src/index.ts` (line ~870, the `invoke` command action)
- Prompt assembly: `src/core/prompt-assembly.ts`
- Project awareness: `src/core/project-awareness.ts`
- Tests: `test/cli/executor.test.ts` (extend), `test/integration/invoke-prompt.test.ts` (new)
