<!-- Source: new milestone inserted between 07a and 07b to reduce Claude context burn from witness reviews -->
# ACA Implementation Steps — Milestone 7, Part A.5: Witness Review Aggregation

Compress multi-witness review output before it reaches Claude. This is a 2-stage watchdog chain with narrow roles:

1. A deterministic schema watchdog validates/normalizes witness JSON and stores raw review text.
2. A model watchdog acts as a PM/triage layer: dedupe, rank, and preserve dissent, but never make final judgment.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure

---

## Milestone 7A.5: Review Aggregator + Watchdog Benchmark

### M7A.5.1 — Structured Witness Finding Schema

- [x] Define a machine-readable witness finding shape: `findingId`, `severity`, `claim`, `evidence`, `file`, `line`, `confidence`, `recommendedAction`
- [x] Require one finding per distinct issue; no prose-only freeform review as the primary artifact
- [x] Allow explicit `no_findings` output with a short residual-risk note
- [x] Preserve raw witness output alongside parsed findings for audit/debug
- [x] Schema watchdog is deterministic TypeScript validation first; model-based JSON repair is optional fallback, not the primary parser

**Tests:**
- Valid witness finding JSON parses and round-trips without losing fields
- Invalid severity/confidence/file-line payload rejected with a typed validation error
- `no_findings` response accepted and rendered distinctly from "watchdog failed"
- Raw witness text is retained even when structured parsing succeeds

### M7A.5.2 — Review Aggregator / Watchdog Agent

- [x] Aggregate findings from N witnesses into a compact report Claude reads first
- [x] Cluster duplicate findings by file/line + claim similarity
- [x] Rank by severity, confidence, and witness agreement
- [x] Preserve dissent: every unique minority finding above a confidence threshold must appear in the final report
- [x] Include direct pointers to raw witness evidence for each aggregated item
- [x] Never auto-resolve correctness; report consensus/disagreement and let Claude decide
- [x] Prefer a different model family than the strongest witness to reduce correlated blind spots; same-family reuse is allowed only if benchmarked and documented

**Tests:**
- 4 witnesses report same bug with slightly different wording → one deduped cluster with all witness IDs attached
- 1 minority high-confidence finding + 3 witnesses miss it → minority finding still appears
- Aggregator output stays under a configurable token/character budget while preserving all P0/P1 items
- Raw evidence links/pointers are present for every aggregated finding
- Aggregator report includes a "disagreements" section when witnesses conflict
- Empty input or all `no_findings` → concise "no findings" report, not hallucinated issues

### M7A.5.3 — Watchdog Model Benchmark Harness

- [x] Build an offline benchmark set from historical witness reviews + known accepted/rejected findings in `docs/changelog.md`
- [x] Score candidate NanoGPT watchdog models on: dedupe accuracy, dissent preservation, severity ranking, faithfulness to raw witness claims, and output compactness
- [x] Compare 3-5 watchdog candidates with a fixed prompt and fixed review bundle; do not brute-force every NanoGPT model
- [x] Record the selected watchdog model and fallback model in docs/config
- [x] Add a guardrail: watchdog output must quote or point to witness evidence, not invent new claims
- [x] Exclude known sunset/deprecated model IDs from the default candidate set even if benchmark scores are strong

**Tests:**
- Benchmark harness runs deterministically on a fixture bundle and emits per-model scores
- Synthetic duplicate bundle → high dedupe score for the expected winner
- Synthetic minority-finding bundle → model is penalized if it drops the dissenting issue
- Synthetic adversarial bundle → model is penalized if it invents claims absent from witness inputs
- Benchmark output includes a reproducible winner table and stores prompt/version metadata

### M7A.5.4 — Claude-Facing Review Report Contract

- [x] Define the exact condensed report format Claude consumes: summary counts, top findings, dissent, open questions, raw-evidence pointers
- [x] Add a retrieval path from each aggregated finding to the original witness review and source file lines
- [x] Make the report suitable for one-shot reading: Claude should not need all raw reviews unless drilling into a contested finding
- [x] Keep the watchdog role narrow: aggregation only, not code editing, not approval decisions

**Tests:**
- Report renders a stable section order: summary → P0/P1 findings → dissent → lower-severity findings → raw-review pointers
- Every finding in the report maps back to at least one witness finding ID and one source location
- A large 4-witness review bundle compresses to a much smaller Claude-facing report without losing any P0/P1 findings
- Watchdog agent profile cannot call mutation tools or delegation tools

---
