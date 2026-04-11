# M7.13 Handoff — Capability Health Tracking

**Date:** 2026-04-03
**Status:** M7.7b complete. Ready for M7.13.

## What's Done (M7.7b)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| Per-turn consecutive counter (threshold 3) | Complete | 5 |
| Per-session cumulative limit (10) | Complete | 3 |
| JSON parse failure tracking | Complete | 1 |
| What counts/doesn't count classification | Complete | 4 |
| Non-confusion error chain break | Complete | 1 |
| Constants export | Complete | 1 |
| **Total** | **M7.7b complete** | **15 new, 1556 total** |

## What to Do Next (M7.13)

From `docs/steps/07a-milestone7-error-health.md`:

- `CapabilityHealthMap`: per-session, in-memory, keyed by capability identifier
- 4 states: unknown, available, degraded, unavailable
- State transitions: defined per the transition table in spec
- Asymmetric policies: local processes (restart once → unavailable) vs HTTP (cooldown + circuit breaker)
- Circuit breaker: 2 consecutive failures → unavailable with cooldown
- LLM visibility: only degraded/unavailable injected into context

## Dependencies

- M7.7a error codes — `src/types/errors.ts` (health transition types defined there)
- M7.7b confusion limits — `src/core/turn-engine.ts` (confusion counters, but not directly used by M7.13)
- Block 1 spec for health transition table — check `docs/spec/` for capability health definitions

## File Locations

- New file: `src/core/capability-health.ts` — CapabilityHealthMap class
- Spec: `docs/spec/01-pluggable-delegation.md` or whichever spec file defines health states
- Tests: `test/core/capability-health.test.ts`
