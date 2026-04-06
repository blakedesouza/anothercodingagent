# M7A.5.4 Handoff — Claude-Facing Review Report Contract

**Date:** 2026-04-04
**Status:** M7A.5.3 complete. Ready for M7A.5.4.

## What's Done (M7A.5.3)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| BenchmarkFixture/Score/Result types | Complete | — |
| WatchdogReport/Finding schema | Complete | 6 |
| ModelRunner injectable interface | Complete | — |
| 5-dimension scoring (dedupe, dissent, severity, faithfulness, compactness) | Complete | 15 |
| buildWatchdogPrompt template | Complete | 2 |
| parseWatchdogOutput with enum validation | Complete | 8 |
| Evidence guardrail (referenced-witness substring) | Complete | 4 |
| DEPRECATED_MODELS + DEFAULT_CANDIDATES | Complete | 2 |
| runBenchmark (candidates × fixtures → winner table) | Complete | 8 |
| **Total** | **M7A.5.3 complete** | **38 new, 1771 total** |

## What to Do Next (M7A.5.4)

From `docs/steps/07a5-milestone7-review-aggregation.md`:

- Define the exact condensed report format Claude consumes: summary counts, top findings, dissent, open questions, raw-evidence pointers
- Add a retrieval path from each aggregated finding to the original witness review and source file lines
- Make the report suitable for one-shot reading: Claude should not need all raw reviews unless drilling into a contested finding
- Keep the watchdog role narrow: aggregation only, not code editing, not approval decisions

## Dependencies

- M7A.5.1 types: `src/review/witness-finding.ts` (WitnessFinding, WitnessReview, parseWitnessOutput)
- M7A.5.2 aggregator: `src/review/aggregator.ts` (aggregateReviews, AggregatedReport, FindingCluster)
- M7A.5.3 benchmark: `src/review/benchmark.ts` (WatchdogReport, WatchdogFinding, parseWatchdogOutput)

## File Locations

- Foundation types: `src/review/witness-finding.ts`
- Aggregator: `src/review/aggregator.ts`
- Benchmark harness: `src/review/benchmark.ts`
- New report contract: `src/review/report.ts` (suggested)
- Tests: `test/review/report.test.ts` (suggested)
