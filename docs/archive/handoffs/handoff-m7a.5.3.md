# M7A.5.3 Handoff — Watchdog Model Benchmark Harness

**Date:** 2026-04-04
**Status:** M7A.5.2 complete. Ready for M7A.5.3.

## What's Done (M7A.5.2)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| aggregateReviews() entry point | Complete | 4 |
| Jaccard similarity clustering (file/line + claim) | Complete | 4 |
| True single-linkage (cluster.some()) | Complete | 1 |
| Severity/confidence/agreement ranking | Complete | 1 |
| dissentConfidenceThreshold enforcement | Complete | 1 |
| budgetExceeded signaling | Complete | 2 |
| Disagreement detection (severity >1 rank) | Complete | 2 |
| WitnessPointer evidence links | Complete | 1 |
| Edge cases (empty, no_findings, single witness) | Complete | 5 |
| Utility tests (tokenize, jaccardSimilarity) | Complete | 7 |
| **Total** | **M7A.5.2 complete** | **24 new, 1733 total** |

## What to Do Next (M7A.5.3)

From `docs/steps/07a5-milestone7-review-aggregation.md`:

- Build an offline benchmark set from historical witness reviews + known accepted/rejected findings in `docs/changelog.md`
- Score candidate NanoGPT watchdog models on: dedupe accuracy, dissent preservation, severity ranking, faithfulness to raw witness claims, and output compactness
- Compare 3-5 watchdog candidates with a fixed prompt and fixed review bundle; do not brute-force every NanoGPT model
- Record the selected watchdog model and fallback model in docs/config
- Add a guardrail: watchdog output must quote or point to witness evidence, not invent new claims
- Exclude known sunset/deprecated model IDs from the default candidate set even if benchmark scores are strong

## Dependencies

- M7A.5.1 types: `src/review/witness-finding.ts` (WitnessFinding, WitnessReview, parseWitnessOutput, buildWitnessReview)
- M7A.5.2 aggregator: `src/review/aggregator.ts` (aggregateReviews, AggregatorConfig, AggregatedReport)
- NanoGPT provider: `src/providers/nanogpt-driver.ts` (for watchdog model invocation)
- Historical reviews: `/tmp/consult-*` files from prior consultations (or synthetic fixtures)

## File Locations

- Foundation types: `src/review/witness-finding.ts`
- Aggregator: `src/review/aggregator.ts`
- New benchmark harness: `src/review/benchmark.ts` (suggested)
- Benchmark fixtures: `test/review/fixtures/` (suggested)
- Tests: `test/review/benchmark.test.ts` (suggested)
- Model config output: `docs/config/watchdog-models.md` (suggested)
