# M3.5 Handoff — Durable Task State

**Date:** 2026-03-30
**Status:** M3.4 complete. Ready for M3.5.

## What's Done (M3.4)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `buildCoverageMap` (coverage tracking) | Complete | 2 |
| `visibleHistory` (filtered history) | Complete | 3 |
| `computeCostCeiling` / `exceedsCostCeiling` | Complete | 3 |
| `deterministicFallback` (first/last + digests) | Complete | 3 |
| `summarizeChunk` (LLM + fallback paths) | Complete | 5 |
| `chunkForSummarization` (turn/token limits) | Complete | 2 |
| Nested summaries (re-summarize covers older) | Complete | 1 |
| Coverage map rebuild from JSONL | Complete | 1 |
| `parseSummarizationResponse` (JSON parsing) | Complete | (covered by LLM path test) |

**Total tests: 785 passing** (764 prior + 21 new).

**Consultation:** 4/4 witnesses, 1 round. 0 code changes. Cost ceiling spec interpretation resolved (response-only cost is pragmatic interpretation of internally contradictory spec requirement).

## What to Do Next (M3.5)

Implement durable task state — a structured object in `manifest.json` that captures session-level metadata (goal, constraints, facts, decisions, open loops) surviving conversation summarization.

### What to Build

- Structured object in `manifest.json`: goal, constraints, confirmedFacts, decisions, openLoops, blockers, filesOfInterest, revision, stale
- Deterministic updates from runtime facts (files modified, errors, approvals) at turn end
- Optional LLM patch call: receives current state + turn items → returns JSON patch
- LLM patch failure → deterministic updates still apply, `stale: true`
- LLM-visible rendering: compact (~80-150 tokens) in pinned sections

### Key Test Cases

- Initial state: all fields empty/null
- After turn with write_file → filesOfInterest updated
- After turn with tool error → openLoop added with status "open"
- After turn with denied approval → openLoop "blocked" + blockers updated
- After turn with user file path mentions → filesOfInterest updated
- After turn with user constraint → constraints updated (via LLM patch)
- LLM patch failure → stale=true, deterministic updates still present
- Rendering: state with goal + 2 open loops + 3 facts → output < 200 tokens
- Revision increments on each update

## Dependencies

- M3.4 summarizer (summarization prompt includes durable task state as context)
- M3.1 token estimation (rendering budget check)
- M1.4 Provider interface (LLM patch call)
- M1.3 SessionManager / manifest.json (persistence)

## File Locations

| File | Purpose |
|------|---------|
| `src/core/durable-task-state.ts` | New — DurableTaskState type, deterministic updates, LLM patch, rendering |
| `test/core/durable-task-state.test.ts` | New — durable task state tests |
| `src/core/session-manager.ts` | Integrate state persistence in manifest.json |
| `src/core/summarizer.ts` | Dependency — summarization prompt includes durable state |
| `docs/spec/07-context-window.md` | Block 7 spec |
