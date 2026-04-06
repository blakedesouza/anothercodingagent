# M7.7b Handoff — Confusion Limits

**Date:** 2026-04-03
**Status:** M7.7a complete. Ready for M7.7b.

## What's Done (M7.7a)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| 22 error codes (4 categories) | Complete | 77 |
| AcaError factory + serialization (depth guard) | Complete | included |
| LLM retry policies (8 codes) | Complete | 42 |
| Per-call retry runner (executeWithLlmRetry) | Complete | included |
| Health transition types | Complete | included |
| Mode-dependent error formatting | Complete | 8 |
| Depth guard test | Complete | 1 |
| **Total** | **M7.7a complete** | **128 new, 1541 total** |

## What to Do Next (M7.7b)

From `docs/steps/07a-milestone7-error-health.md`:

- Per-turn confusion counter: consecutive invalid tool calls
- Threshold 1-2: synthetic ToolResultItem with validation error, model gets another step
- Threshold 3: turn yields with outcome `tool_error` and error code `llm.confused`
- Per-session cumulative limit: 10 total confusion events
- At 10 cumulative: inject persistent system message nudging simpler tool use

## Dependencies

- `llm.confused` error code — defined in M7.7a (`src/types/errors.ts`)
- `tool.validation` error code — defined in M7.7a
- TurnEngine phase 9 (ValidateToolCalls) — already validates tool calls in `src/core/turn-engine.ts`
- ToolResultItem type — `src/types/conversation.ts`

## File Locations

- Turn engine (confusion logic): `src/core/turn-engine.ts` — add confusion counter to step loop
- Error codes: `src/types/errors.ts` — `LLM_ERRORS.CONFUSED`, `TOOL_ERRORS.VALIDATION`
- Tests: `test/core/turn-engine.test.ts` or new `test/core/confusion-limits.test.ts`
