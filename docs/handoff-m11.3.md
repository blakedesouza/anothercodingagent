# M11.3 Handoff — Remove Artificial Ceilings

**Date:** 2026-04-05
**Status:** M11.2 complete. Ready for M11.3.

## What's Done (M11.2)

| Deliverable | Status | Tests |
|---|---|---|
| `NanoGptDriverOptions.catalog` DI | Complete | 2 |
| `capabilities()` catalog+registry merge | Complete | 6 |
| `buildRequestBody` maxOutputTokens override | Complete | 3 |
| Pricing merge (P1 consensus fix) | Complete | 2 |
| **Total** | **M11.2 complete** | **13 new** |

## What to Do Next (M11.3)

From `docs/steps/11-milestone11-model-utilization.md`:

- [ ] **Invoke step limit:** currently 30 → remove for invoke mode (set to `Infinity`). The MCP deadline is the safety net, not a step counter. Interactive mode keeps its limit (25) since that's about UX, not cost
- [ ] **MCP deadline default:** 5 minutes → 15 minutes in `src/mcp/server.ts`. A coding agent doing read→write→test→iterate needs room
- [ ] **Default maxOutputTokens:** 4,096 → 16,384 in `CONFIG_DEFAULTS`. This is the offline fallback when catalog is unavailable
- [ ] **Default apiTimeout (idle):** 30s → 120s. Per-stream idle timeout, not hard deadline
- [ ] Unit tests: invoke mode runs >30 steps without `max_steps` outcome, deadline enforcement still works at 15 min, config defaults are correct

**Note:** Some of these changes were partially applied during M10.2 debugging (idle timeout in 3 drivers, apiTimeout, maxOutputTokens, step limit set to 50). This substep formalizes them to their correct final values and adds tests. There are 4 pre-existing test failures related to these partial changes that M11.3 should fix.

## Dependencies

- M11.2: Catalog integration (done — driver uses real limits when available)
- Pre-existing partial changes in `src/config/schema.ts`, `src/core/turn-engine.ts`

## File Locations

- Turn engine: `src/core/turn-engine.ts` (step limit)
- MCP server: `src/mcp/server.ts` (deadline default)
- Config schema: `src/config/schema.ts` (maxOutputTokens, apiTimeout defaults)
- Config tests: `test/config/config.test.ts` (4 pre-existing failures to fix)
- Turn engine tests: `test/core/turn-engine.test.ts` (1 pre-existing failure to fix)
- One-shot tests: `test/cli/one-shot.test.ts` (1 pre-existing failure to fix)
