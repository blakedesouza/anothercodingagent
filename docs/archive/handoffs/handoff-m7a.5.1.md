# M7A.5.1 Handoff — Structured Witness Finding Schema

**Date:** 2026-04-03
**Status:** M7.8 complete. M7A.5 inserted before M7B. Ready for M7A.5.1.

## Why This Milestone Exists

Raw multi-witness reviews are likely to become a new Claude-context bottleneck once witnesses gain tool access. M7A.5 adds a watchdog/aggregator layer so Claude reads a compact triage report first, then drills into raw witness output only for contested or high-risk findings.

## What's Done (M7.8)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| 3 new patterns (env_assignment, connection_string, jwt_token) | Complete | 9 |
| allowPatterns false-positive recovery | Complete | 5 |
| Non-secret exclusions (SHA-256, UUID, hex) | Complete | 6 |
| Combined pipeline tests | Complete | 2 |
| ReDoS guard on allowPatterns | Complete | 2 |
| Connection string quote safety | Complete | 1 |
| **Total** | **M7.8 complete** | **25 new, 1673 total** |

## What to Do Next (M7A.5.1)

From `docs/steps/07a5-milestone7-review-aggregation.md`:

- Define a machine-readable witness finding shape: `findingId`, `severity`, `claim`, `evidence`, `file`, `line`, `confidence`, `recommendedAction`
- Require one finding per distinct issue; no prose-only freeform review as the primary artifact
- Allow explicit `no_findings` output with a short residual-risk note
- Preserve raw witness output alongside parsed findings for audit/debug

## Suggested Implementation Order

1. Add witness-review types under `src/types/` and validation helpers under `src/core/` or `src/observability/`.
2. Add a parser/normalizer that accepts structured witness JSON plus raw-text fallback storage.
3. Add tests for valid findings, invalid payload rejection, explicit `no_findings`, and raw-text retention.
4. Update the M7A.5 step checkboxes only after tests pass.

## What Comes After

- `M7A.5.2`: aggregator/watchdog clustering and ranking
- `M7A.5.3`: benchmark harness to compare NanoGPT watchdog model candidates
- `M7A.5.4`: Claude-facing condensed report contract
- Then `M7.1a` in `docs/steps/07b-milestone7-delegation.md`

## Dependencies

- Existing M7A error taxonomy for typed validation failures: `src/types/errors.ts`
- Existing docs review history for benchmark fixtures: `docs/changelog.md`
- Existing milestone workflow: `WORKFLOW.md`

## File Locations

- New step file: `docs/steps/07a5-milestone7-review-aggregation.md`
- Existing next-delegation handoff to resume after M7A.5: `docs/handoff-m7.1a.md`
