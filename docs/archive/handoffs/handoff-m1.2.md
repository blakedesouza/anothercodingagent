# M1.2 Handoff — JSONL Conversation Log

**Date:** 2026-03-30
**Status:** M1.1 complete. Ready for M1.2 implementation.

## What's Done (M1.1)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| ULID generation via `ulid` package | Complete | 4 tests (prefixes, format, uniqueness, time-sort) |
| `AcaError` type (code, message, retryable, details?, cause?) | Complete | 3 tests |
| `SequenceGenerator` class (monotonic, resumable) | Complete | 5 tests |
| `ToolOutput.error` string → AcaError | Complete | 1 test |
| `ToolOutput.bytesOmitted` added | Complete | 2 tests |
| `ToolOutput.blobRef?` moved from ToolResultItem | Complete | Type-checked |
| `StepRecord.stepNumber` added | Complete | Type-checked |
| `ToolResultItem.delegation?` field added | Complete | 2 tests |
| `DelegationRecord.parentEventId` → EventId | Complete | Type-checked |
| `Session.configSnapshot` added | Complete | Type-checked |
| `EventId` type + `evt_` prefix | Complete | Covered by prefix test |
| ConversationItem union narrowing tests | Complete | 2 tests |
| Serialization round-trip tests | Complete | 4 tests |
| Session factory updated for all changes | Complete | 11 existing tests pass |

**Total tests: 51 passing** (27 Phase 0 + 24 M1.1)

**Consultation:** 4 external witnesses reviewed M1.1 (MiniMax, Kimi confirmed; Qwen, Llama added post-review). 4 fixes applied (blobRef, delegation, parentEventId, configSnapshot).

## What to Do Next (M1.2)

Execute M1.2 from `docs/steps/01-milestone1-agent-loop.md`.

### M1.2 — JSONL Conversation Log (Block 5)

- [ ] `ConversationWriter`: append typed records (turn, step, item) as single JSON lines to `conversation.jsonl`
- [ ] `ConversationReader`: read JSONL file, parse each line, yield typed records
- [ ] Record type discriminator: `recordType` field added at serialization boundary (maps from `kind` for items, adds `"turn"`/`"step"` for Turn/Step records)
- [ ] Crash-safe writes: each line is a complete JSON object, partial last line is detectable and discardable
- [ ] Line validation on read: skip malformed lines with warning

### Key Design Decision (from consultation)

**`kind` stays in-memory, `recordType` is serialization-only.** The JSONL writer maps:
- `MessageItem.kind: 'message'` → `recordType: 'message'`
- `ToolResultItem.kind: 'tool_result'` → `recordType: 'tool_result'`
- `SummaryItem.kind: 'summary'` → `recordType: 'summary'`
- `TurnRecord` (no kind) → `recordType: 'turn'`
- `StepRecord` (no kind) → `recordType: 'step'`

On read, the reader maps `recordType` back to `kind` for ConversationItems.

### Tests Required

- Write 10 records → read back → all 10 match
- Simulate crash: write partial line (truncated JSON) → reader skips it, returns all complete records
- Empty file → reader returns empty array
- Large record (near 64 KiB) writes and reads correctly
- Concurrent append safety: verify `O_APPEND` semantics
- `recordType` discriminator correctly identifies each variant

### File Locations

| New File | Purpose |
|----------|---------|
| `src/core/conversation-writer.ts` | Append records to JSONL |
| `src/core/conversation-reader.ts` | Parse JSONL back to typed records |
| `test/core/conversation-log.test.ts` | All M1.2 tests |

### Dependencies

- All M1.1 types are available in `src/types/`
- `SequenceGenerator` for seq number assignment
- `generateId` for record IDs

## Architecture Notes

- **No streaming reads in M1.2.** Reader loads entire file. Streaming comes later if needed.
- **`O_APPEND` for crash safety.** Each write is a single `appendFileSync` call with a complete JSON line + `\n`.
- **No schema versioning yet.** M1.2 records are v1 implicitly. Version field comes in M3+.

## Session Rules

- Small batches (1-2 substeps then checkpoint)
- Test-first: write tests before/alongside implementation
- Update plan.md after each substep
- Update changelog.md after meaningful work
- Consult external AI after completing M1.2
