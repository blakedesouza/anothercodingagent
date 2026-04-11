# M11.8 Handoff — CLI Wiring + Integration Test

**Date:** 2026-04-05
**Status:** M11.7 complete. Ready for M11.8.

## What's Done (M11.7)

| Deliverable | Status | Tests |
|---|---|---|
| Coder profile: dynamic resolution from ToolRegistry (all minus delegation+user-facing) | Done | 3 tests |
| Witness profile: expanded to 10 non-mutating tools | Done | 3 tests |
| Reviewer profile: expanded to match witness | Done | 2 tests |
| Researcher profile: expanded with search_semantic, lsp_query, web tools | Done | 2 tests |
| WATCHDOG_DENIED_TOOLS removed (allow-list philosophy) | Done | 3 tests |
| Delegation tools excluded from all non-general profiles | Done | 1 test |
| Researcher prompt updated (P1 consensus fix) | Done | - |

## What to Do Next (M11.8)

- `index.ts` startup: create appropriate `ModelCatalog` instance based on configured provider (NanoGPT -> `NanoGptCatalog`, OpenRouter -> `OpenRouterCatalog`, else -> `StaticCatalog`). Pass to driver
- Log discovered model limits at verbose level on startup (model name, context, max output)
- Integration test: mock NanoGPT API returning model details -> verify driver reports correct limits -> verify invoke handler uses them
- Smoke test: real `aca invoke` with a task that requires >4K output tokens completes successfully
- Verify: the `StaticCatalog` fallback works when API is unreachable (airplane mode test)
- Verify: invoke prompt assembly includes workspace context (from M11.6)
- Verify: peer agent profiles grant full tool access (from M11.7)

## Dependencies

- M11.1: ModelCatalog types and implementations (NanoGptCatalog, OpenRouterCatalog, StaticCatalog)
- M11.2: NanoGptDriver accepts optional ModelCatalog
- M11.5: witness-models.ts, StaticCatalog fallback wired into invoke handler
- M11.6: buildInvokeSystemMessages, systemMessages on TurnEngineConfig
- M11.7: Expanded agent profiles (coder dynamic, witness/reviewer 10 tools)

## File Locations

- `src/index.ts` — Main CLI entry point, needs catalog wiring
- `src/providers/model-catalog.ts` — Catalog implementations
- `src/providers/nanogpt-driver.ts` — Driver that accepts catalog
- `src/config/witness-models.ts` — Witness model configs
- `src/delegation/agent-registry.ts` — Expanded profiles to verify
- `test/integration/model-catalog.test.ts` — New integration test file

## Notes

- M11.8 is the **final substep** of Milestone 11. Post-milestone review (medium risk: arch + bug hunt) triggers after approval.
- The `<!-- final-substep: M11.8 -->` marker is in the step file's review section.
