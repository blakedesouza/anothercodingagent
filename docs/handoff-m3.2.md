# M3.2 Handoff — Context Assembly Algorithm

**Date:** 2026-03-30
**Status:** M3.1 complete. Ready for M3.2.

## What's Done (M3.1)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `estimateTextTokens` (byte heuristic, bytesPerToken guard) | Complete | 11 |
| `estimateRequestTokens` (structural overheads, type-specific switch) | Complete | 7 |
| `CalibrationState` EMA (create, update, NaN/Infinity guards) | Complete | 9 |
| `computeSafeInputBudget` (guard formula, edge cases) | Complete | 5 |
| `estimate_tokens` tool (text/file/model, fitsInContext) | Complete | 15 |

**Total tests: 692 passing** (645 prior + 47 new).

**Consultation:** 4/4 witnesses, 3 fixes applied (double-counting, bytesPerToken guard, calibration NaN guard).

## What to Do Next (M3.2)

Implement Context Assembly Algorithm (Block 7).

### What to Build

- 7-step algorithm: compute budget → build pinned → estimate → determine tier → apply actions → pack newest-first → verify fit
- Tier detection: < 60% = full, ≥ 60% < 80% = medium, ≥ 80% < 90% = aggressive, ≥ 90% = emergency
- Turn-boundary packing: whole turns or none (except current turn always included)
- Single-item budget guard: any item > 25% of remaining budget → downgrade to truncated/digest

### Key Test Cases

- Small conversation (< 60%) → tier=full, all verbatim
- Conversation at 70% → tier=medium
- Conversation at 85% → tier=aggressive
- Conversation at 95% → tier=emergency
- Turn boundary: 3 turns, budget fits 2.5 → include 2 full turns
- Pinned sections present at all tiers, instruction summary dropped only in emergency
- Boundary tests: exactly 60% → medium, exactly 80% → aggressive, exactly 90% → emergency
- Single large tool result (>25% budget) → downgraded to digest
- Escalation: too large → bump tier and retry

## Dependencies

- M3.1 `estimateTextTokens`, `estimateRequestTokens`, `computeSafeInputBudget`, `CalibrationState`
- M3.0b `assemblePrompt` (the structure being assembled)
- M1.9 Event system (`context.assembled` event)

## File Locations

| File | Purpose |
|------|---------|
| `src/core/context-assembly.ts` | 7-step algorithm, tier detection, packing |
| `test/core/context-assembly.test.ts` | All context assembly tests |
| `src/core/token-estimator.ts` | Token estimation (dependency) |
| `src/core/prompt-assembly.ts` | Prompt structure (dependency) |
| `docs/spec/07-context-window.md` | Block 7 spec |
