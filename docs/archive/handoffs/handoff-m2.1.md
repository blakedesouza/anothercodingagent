# M2.1 Handoff — File System Tools

**Date:** 2026-03-30
**Status:** M1.10 complete. Milestone 1 COMPLETE. Ready for M2.1.

## What's Done (M1.10)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `test/integration/smoke.test.ts` — 4-test end-to-end suite | Complete | 4 |
| `test/fixtures/sample.txt` — text fixture for read_file tool call | Complete | — |
| Events wired via TurnEngine `'phase'` listener → JsonlEventSink | Complete | — |
| Manifest persistence verified via SessionManager.load round-trip | Complete | — |

**Total tests: 198 passing** (194 prior + 4 new).
**Milestone 1 is complete.** All 10 M1 substeps are checked off in `docs/steps/01-milestone1-agent-loop.md`.

**Consultation:** 4/4 witnesses. 1 rebuttal round (Q4 phase mapping). 3 consensus fixes applied.

## What to Do Next (M2.1)

Execute M2.1 from `docs/steps/02-milestone2-tools-perms.md`. This implements the remaining file system tools following the `read_file` pattern.

### Tools to Implement

- `write_file`: path, content, mode (create/overwrite) → bytes written, hash. Create parent directories if needed
- `edit_file`: path, edits (search/replace pairs or unified patch) → applied edits, rejects. Support `expectedHash` for conditional edits
- `delete_path`: path, recursive flag → deleted items count. Require recursive=true for directories
- `move_path`: source, destination → result, conflict flag
- `make_directory`: path → created or already existed. Create parents
- `stat_path`: path → exists, kind, size, mtime, permissions
- `find_paths`: root, pattern (glob), type filter, limit (default 50, max 200) → matching paths with metadata
- `search_text`: root, pattern (regex/exact), file globs, context lines, limit (default 50, max 200) → matches with file, line, snippet

### Tests Required (per tool)

See `docs/steps/02-milestone2-tools-perms.md` `### M2.1` for the full test matrix. Each tool has 4–6 test cases covering success path, error paths, and edge cases.

## Dependencies

- **ToolRegistry** from `src/tools/tool-registry.ts` (M1.5) — `register(spec, impl)` pattern
- **ToolRunner** from `src/tools/tool-runner.ts` (M1.5) — `execute(name, args, context)`
- **`read_file` pattern** from `src/tools/read-file.ts` (M1.6) — follow same `spec + impl` export structure
- **`ToolSpec`, `ToolImplementation`, `ToolContext`** from `src/tools/tool-registry.ts`

## File Locations

| New File | Purpose |
|----------|---------|
| `src/tools/write-file.ts` | write_file spec + implementation |
| `src/tools/edit-file.ts` | edit_file spec + implementation |
| `src/tools/delete-path.ts` | delete_path spec + implementation |
| `src/tools/move-path.ts` | move_path spec + implementation |
| `src/tools/make-directory.ts` | make_directory spec + implementation |
| `src/tools/stat-path.ts` | stat_path spec + implementation |
| `src/tools/find-paths.ts` | find_paths spec + implementation |
| `src/tools/search-text.ts` | search_text spec + implementation |
| `test/tools/write-file.test.ts` | Tests for write_file |
| `test/tools/edit-file.test.ts` | Tests for edit_file |
| ... (one test file per tool) | ... |

## Design Notes

- Follow the `readFileSpec` / `readFileImpl` export pattern from `src/tools/read-file.ts`
- `approvalClass` classification: `write_file`, `edit_file`, `delete_path`, `move_path`, `make_directory` → `'workspace-write'`; `stat_path`, `find_paths`, `search_text` → `'read-only'`
- All tools use `timeoutCategory: 'file'` (5 second timeout)
- `find_paths` and `search_text` have explicit `limit` caps (max 200) — enforce in implementation
- Workspace sandboxing is NOT yet implemented (that's M2.4) — tools operate on any path for now
