# M7A.5.2 Handoff — Review Aggregator / Watchdog Agent

**Date:** 2026-04-04
**Status:** M7A.5.1 complete. Ready for M7A.5.2.

## What's Done (M7A.5.1)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| WitnessFinding shape (8 fields) | Complete | 7 |
| FindingSeverity/FindingConfidence enums | Complete | 2 |
| ParsedWitnessOutput discriminated union | Complete | 4 |
| parseWitnessOutput deterministic validator | Complete | 18 |
| no_findings with residualRisk | Complete | 4 |
| buildWitnessReview with raw preservation | Complete | 5 |
| null error message fix (consultation) | Complete | 1 |
| **Total** | **M7A.5.1 complete** | **36 new, 1709 total** |

## What to Do Next (M7A.5.2)

From `docs/steps/07a5-milestone7-review-aggregation.md`:

- Aggregate findings from N witnesses into a compact report Claude reads first
- Cluster duplicate findings by file/line + claim similarity
- Rank by severity, confidence, and witness agreement
- Preserve dissent: every unique minority finding above a confidence threshold must appear in the final report
- Include direct pointers to raw witness evidence for each aggregated item
- Never auto-resolve correctness; report consensus/disagreement and let Claude decide
- Prefer a different model family than the strongest witness to reduce correlated blind spots

## Dependencies

- M7A.5.1 types: `src/review/witness-finding.ts` (WitnessFinding, ParsedWitnessOutput, WitnessReview, parseWitnessOutput, buildWitnessReview)
- M7.7a error taxonomy: `src/types/errors.ts` (createAcaError, tool.validation)
- NanoGPT provider: `src/providers/nanogpt-driver.ts` (for watchdog model invocation)

## File Locations

- Foundation types: `src/review/witness-finding.ts`
- New aggregator: `src/review/aggregator.ts` (suggested)
- Tests: `test/review/aggregator.test.ts` (suggested)
