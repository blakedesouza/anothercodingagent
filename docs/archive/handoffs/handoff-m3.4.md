# M3.4 Handoff — Summarization

**Date:** 2026-03-30
**Status:** M3.3 complete. Ready for M3.4.

## What's Done (M3.3)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `getVerbatimTurnLimit` (4 tiers) | Complete | 4 |
| `renderProjectForTier` (4 detail levels) | Complete | 4 |
| `buildToolDefsForTier` (full/short-form/signatures) | Complete | 4 |
| `getTierContextFlags` (section inclusion flags) | Complete | 4 |
| `EMERGENCY_WARNING_MESSAGE` constant | Complete | 1 |
| `pack()` turn limit enforcement | Complete | 2 |

**Total tests: 764 passing** (745 prior + 19 new).

**Consultation:** 4/4 witnesses, 2 rounds. 0 code changes, 1 comment added (schema stripping depth limitation).

## What to Do Next (M3.4)

Implement LLM-based summarization of oldest completed-turn prefix (Block 7).

### What to Build

- LLM-based summarization of oldest completed-turn prefix
- Structured prompt: request JSON output with `summaryText`, `pinnedFacts`, `durableStatePatch`
- Chunk-based: up to 12 turns or 20K tokens per chunk
- 40% cost ceiling: if summarization would cost > 40% of tokens saved → use deterministic fallback
- Deterministic fallback: first/last items of range, tool call digest, discard filler
- `SummaryItem` creation: new sequence number, `coversSeq` range, appended to log
- Coverage map: `Map<itemSeq, summarySeq>` for visibility tracking
- `visibleHistory()`: returns items skipping covered originals, including summaries

### Key Test Cases

- Summarize 5 turns → SummaryItem created with correct coversSeq range
- visibleHistory() after summarization → original items hidden, summary visible
- 40% cost check: 5 turns totaling 100 tokens → summarization must cost < 40 tokens
- Cost ceiling exceeded → deterministic fallback used (no LLM call)
- Deterministic fallback: preserves first item, last item, tool call digests
- Nested summaries: re-summarize existing summary → newer covers older
- visibleHistory() with nested summaries → only newest visible
- Coverage map rebuild from JSONL on session load

## Dependencies

- M3.3 tier actions (this module — determines when summarization is needed)
- M3.2 `assembleContext`, `estimateItemTokens` (token counting)
- M3.1 token estimation (cost ceiling check)
- M1.2 ConversationWriter (appending SummaryItem to JSONL)
- M1.4 Provider interface (making the summarization LLM call)

## File Locations

| File | Purpose |
|------|---------|
| `src/core/context-assembly.ts` | Integrate summarization into assembly flow |
| `src/core/summarizer.ts` | New — summarization logic, fallback, coverage map |
| `test/core/summarizer.test.ts` | New — summarization tests |
| `src/core/conversation-log.ts` | SummaryItem writing (dependency) |
| `docs/spec/07-context-window.md` | Block 7 spec |
