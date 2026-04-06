# M1.6 Handoff — `read_file` Tool

**Date:** 2026-03-30
**Status:** M1.5 complete. Ready for M1.6 implementation.

## What's Done (M1.5)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `ToolRegistry` (register, lookup, list) | Complete | 4 tests |
| `ToolSpec` type (name, description, inputSchema, approvalClass, idempotent, timeoutCategory) | Complete | Covered above |
| `ToolRunner.execute()` pipeline (lookup → validate → timeout → call → validate output → cap) | Complete | 8 tests |
| Input validation via ajv (cached validators) | Complete | Covered above |
| Per-category timeouts with AbortController | Complete | Covered above |
| 64 KiB output cap enforcement | Complete | Covered above |
| `mutationState: 'indeterminate'` on timeout for mutation tools | Complete | 1 test |
| Auto-retry with exponential backoff + jitter (idempotent only) | Complete | 3 tests |
| `ToolTimeoutError` custom error class | Complete | Covered above |

**Total tests: 112 passing** (95 prior + 17 new).

**Consultation:** 4 witnesses reviewed M1.5 (all responded, immediate consensus). 6 fixes applied:
1. AbortController moved inside retry loop (was shared — broken retries)
2. mutationState: 'indeterminate' for non-read-only tools on timeout
3. Added jitter to exponential backoff
4. Cached ajv validators per tool
5. ToolTimeoutError replaces magic string sentinel
6. Added 'indeterminate' to MutationState type

## What to Do Next (M1.6)

Execute M1.6 from `docs/steps/01-milestone1-agent-loop.md`.

### M1.6 — `read_file` Tool

The first tool. Validates the full tool pipeline end-to-end.

- [ ] Input schema: `path` (required), `line_start` (optional, 1-indexed), `line_end` (optional, inclusive)
- [ ] Read file contents, return with encoding, line count, byte count
- [ ] Line range support: `line_start`/`line_end` return only that range with metadata for continuation (`nextStartLine`, `totalLines`, `totalBytes`)
- [ ] Truncation at 64 KiB or 2,000 lines (whichever first), set `truncated: true` with metadata
- [ ] Binary detection: null-byte check on first 1 KiB + extension heuristics → return metadata only (`isBinary`, size, MIME type)
- [ ] File not found → `tool.not_found` error
- [ ] Approval class: `read-only` (auto-approved)

### Tests Required

- Read small text file → correct content, encoding, line count, byte count
- Read with line_start/line_end → correct range, nextStartLine
- Read file > 2,000 lines → truncated at 2,000 lines
- Read file > 64 KiB → truncated at 64 KiB
- Whichever-first truncation (line limit vs byte limit)
- Binary detection (null-byte and extension heuristics)
- Nonexistent file → `tool.not_found` error
- Empty file, single-line, line_start > total lines

## Dependencies

- `ToolRegistry` + `ToolRunner` from `src/tools/` (M1.5)
- `ToolOutput` type from `src/types/conversation.ts`
- `ToolSpec` / `ToolImplementation` types from `src/tools/tool-registry.ts`

## File Locations

| New File | Purpose |
|----------|---------|
| `src/tools/read-file.ts` | `read_file` tool implementation + spec |
| `test/tools/read-file.test.ts` | All M1.6 tests |
