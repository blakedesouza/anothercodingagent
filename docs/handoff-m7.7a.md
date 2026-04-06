# M7.7a Handoff — Error Taxonomy + LLM Retry Policies

**Date:** 2026-04-03
**Status:** M6 complete (including post-milestone review). Ready for M7.7a.

## What's Done (M6 Review)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| Architecture review (4 witnesses) | Complete | — |
| Bug hunt (4 witnesses) | Complete | — |
| 3 P1 fixes (dispose, concurrency, symlinks) | Applied | 3 |
| 4 P2 fixes (buffer validation, failures, zombie, dispose race) | Applied | 4 |
| **Total** | **M6 fully complete** | **1413 passing** |

## What to Do Next (M7.7a)

From `docs/steps/07a-milestone7-error-health.md`:

- Full 22 error codes across 4 categories (tool, llm, delegation, system)
- `AcaError` shape construction and serialization for all codes
- LLM retry policies: rate limit 5, server 3, timeout 2, malformed 2, context 1+compress, auth/filter 0
- Per-call retry state (not global)
- Health state updates after retry exhaustion
- Mode-dependent error formatting (interactive, one-shot, executor)

**Must be first in M7.** Error codes are referenced by retry logic, health tracking, tool masking, and delegation error chains.

## Dependencies

- `AcaError` class exists in `src/types/errors.ts` (from M1.3) — extends with full 22-code taxonomy
- Provider drivers (`src/providers/`) — retry logic wraps stream calls
- TurnEngine (`src/core/turn-engine.ts`) — health state updates after retry exhaustion

## File Locations

- Error types: `src/types/errors.ts`
- Retry logic: new file `src/core/retry-policy.ts` (or similar)
- Provider health: likely extends `src/providers/` interfaces
- Tests: `test/core/retry-policy.test.ts`, `test/types/errors.test.ts`
